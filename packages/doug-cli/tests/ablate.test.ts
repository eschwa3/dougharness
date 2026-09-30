import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Proves newestResult sorts the name listing before stat'ing, so that files with equal mtimes (plausible for a
// run's outputs) break ties by name rather than by whatever order readdirSync returns (this filesystem returns
// sorted order already, so a fixture-only test would pass either way). Rigs an unsorted, equal-mtime listing for
// one sentinel directory; the pre-existing real-fs `writingRunner` test below is untouched since it uses a
// different, non-sentinel path. The rigged order is deliberately neither ascending nor descending (b, c, a) so
// that removing the fix's sort-then-reverse cannot coincidentally reproduce the correct answer from raw order
// alone — with only two names, "b, a" IS already the descending order, so that would have proven nothing.
const SENTINEL = "__unsorted_ablate__";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith(SENTINEL)) return true;
      return (actual.existsSync as (...a: unknown[]) => boolean)(...args);
    },
    readdirSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith(SENTINEL)) return ["b.json", "c.json", "a.json"];
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
    statSync: (...args: unknown[]) => {
      if (String(args[0]).includes(SENTINEL)) return { mtimeMs: 1000 } as ReturnType<typeof import("node:fs").statSync>;
      return (actual.statSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { runAblate, summarizeEval, renderAblation, newestResult, memoryVerdict, spreadOf, type EvalFile, type ConditionSummary } from "../src/ablate.js";

const here = dirname(fileURLToPath(import.meta.url));
// The two results already in evals/out on 2026-09-03 (that directory is gitignored, so these are copies):
// one fix-hours session each under the full condition, $0.513 and $0.402.
const first = join(here, "fixtures/evals/2026-09-03T23-53-32-762Z.json");
const second = join(here, "fixtures/evals/2026-09-03T23-55-11-910Z.json");
const load = (f: string): EvalFile => JSON.parse(readFileSync(f, "utf8"));

async function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runAblate(argv, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr };
}

describe("summarizeEval", () => {
  it("sums the two saved fix-hours results into one full-condition row", () => {
    const a = summarizeEval([
      { source: first, data: load(first) },
      { source: second, data: load(second) },
    ]);
    expect(a.suite).toBe("ts-basic");
    expect(a.sessions).toBe(2);
    expect(a.tasks).toEqual(["fix-hours"]);
    expect(a.unpriced).toBe(0);
    expect(a.conditions).toEqual([
      expect.objectContaining({ condition: "full", sessions: 2, successes: 1, successRate: 0.5, verified: 2, inScope: 1, priced: 2, meanTurns: 12.5 }),
    ]);
    expect(a.conditions[0].meanCostUsd).toBeCloseTo((0.5132789999999999 + 0.40162725) / 2, 10);
    expect(a.byTask).toEqual([{ task: "fix-hours", condition: "full", sessions: 2, successes: 1, meanCostUsd: a.conditions[0].meanCostUsd, meanHidden: null, meanDefects: null }]);
  });
  it("orders baseline, gates, full, keeps other conditions after them, and leaves unpriced sessions out of the mean", () => {
    const data: EvalFile = {
      suite: "s",
      results: [
        { task: "t1", condition: "full", costUsd: 1, turns: 4, verified: true, inScope: true, success: true },
        { task: "t1", condition: "baseline", costUsd: 0.5, turns: 2, verified: true, inScope: false, success: false },
        { task: "t2", condition: "baseline", costUsd: null, turns: null, verified: false, inScope: true, success: false },
        { task: "t2", condition: "nohooks", costUsd: 2, turns: 6, verified: true, inScope: true, success: true },
        { task: "t1", condition: "gates", costUsd: 0.75, turns: 3, verified: true, inScope: true, success: true },
      ],
    };
    const a = summarizeEval([{ source: "x.json", data }]);
    expect(a.conditions.map((c) => c.condition)).toEqual(["baseline", "gates", "full", "nohooks"]);
    const baseline = a.conditions[0];
    expect(baseline).toMatchObject({ sessions: 2, successes: 0, successRate: 0, verified: 1, inScope: 1, priced: 1, meanCostUsd: 0.5, meanTurns: 2, totalCostUsd: 0.5 });
    expect(a.unpriced).toBe(1);
    expect(a.tasks).toEqual(["t1", "t2"]);
    expect(a.byTask.map((t) => `${t.task}/${t.condition}`)).toEqual(["t1/baseline", "t1/gates", "t1/full", "t2/baseline", "t2/nohooks"]);
    expect(a.byTask.find((t) => t.task === "t2" && t.condition === "baseline")?.meanCostUsd).toBeNull();
    const text = renderAblation(a);
    expect(text).toContain("Ablation of suite s: 5 sessions from x.json; 2 tasks (t1, t2).");
    expect(text).toContain("| baseline | 2 | 0/2 (0%) | 1/2 | 1/2 | $0.500 (1 priced) | 2.0 |");
    expect(text).toContain("| full | 1 | 1/1 (100%) | 1/1 | 1/1 | $1.000 | 4.0 |");
    // gates, full, and nohooks each ran one session against baseline's two (card eval-accuracy part 3): every
    // comparison reads as a single-run sentence, never a fabricated delta.
    expect(text).toContain("Against baseline, gates: single run (n=1 vs n=2), not reported as a difference.");
    expect(text).toContain("Against baseline, full: single run (n=1 vs n=2), not reported as a difference.");
    expect(text).toContain("Against baseline, nohooks: single run (n=1 vs n=2), not reported as a difference.");
    expect(text).toContain("| Task | Condition | Sessions | Success | Mean cost |");
    expect(text).toContain("| t2 | baseline | 1 | 0/1 | no cost |");
    expect(text).toContain("Note: 1 session has no cost (the runner could not read claude -p's JSON); means are over the priced sessions only.");
  });
  it("orders the orchestration arms after the install conditions and compares each against pipeline on success, scope, cost, and wall clock", () => {
    // card swarm-tiering-eval: the four measures decision 0001 names, per arm, against the fixed pipeline.
    // swarm-crew (card eval-accuracy) joins the other arms: swarm on plus a crew of two reviewers and two
    // adversaries, ordered after crew and compared against pipeline the same way. Every arm and pipeline get a
    // second, identical run (card eval-accuracy part 3): both sides then have two sessions, so the comparison
    // prints a delta instead of the "single run, not reported as a difference" sentence.
    const row = (condition: string, costUsd: number, durationMs: number, inScope: boolean, success: boolean) => [
      { task: "schedule-feature", condition, run: 1, costUsd, turns: 4, durationMs, verified: true, inScope, success },
      { task: "schedule-feature", condition, run: 2, costUsd, turns: 4, durationMs, verified: true, inScope, success },
    ];
    const data: EvalFile = {
      suite: "ts-basic",
      results: [
        ...row("crew", 6, 900000, true, true),
        ...row("swarm-cheap", 3, 600000, false, false),
        ...row("pipeline", 4, 720000, true, true),
        ...row("swarm", 5, 480000, true, true),
        ...row("swarm-crew", 7, 960000, true, true),
        { task: "schedule-feature", condition: "full", costUsd: 1, turns: 9, verified: false, inScope: true, success: false },
      ],
    };
    const a = summarizeEval([{ source: "arms.json", data }]);
    expect(a.conditions.map((c) => c.condition)).toEqual(["full", "pipeline", "swarm", "swarm-cheap", "crew", "swarm-crew"]);
    expect(a.conditions.find((c) => c.condition === "pipeline")).toMatchObject({ meanDurationMs: 720000, scopeViolations: 0 });
    expect(a.conditions.find((c) => c.condition === "swarm-cheap")).toMatchObject({ meanDurationMs: 600000, scopeViolations: 2 });
    expect(a.conditions.find((c) => c.condition === "full")).toMatchObject({ meanDurationMs: null });
    const text = renderAblation(a);
    expect(text).toContain("| Condition | Sessions | Success | Verified | In scope | Mean cost | Mean turns | Mean wall |");
    expect(text).toContain("| pipeline | 2 | 2/2 (100%) | 2/2 | 2/2 | $4.000 ($4.000–$4.000) | 4.0 | 12.0 min (12.0–12.0) |");
    expect(text).toContain("| full | 1 | 0/1 (0%) | 0/1 | 1/1 | $1.000 | 9.0 | - |");
    expect(text).toContain("Against pipeline, swarm: +0 points success, +0 scope violations, +$1.000 mean cost, -4.0 min wall.");
    expect(text).toContain("Against pipeline, swarm-cheap: -100 points success, +2 scope violations, -$1.000 mean cost, -2.0 min wall.");
    expect(text).toContain("Against pipeline, crew: +0 points success, +0 scope violations, +$2.000 mean cost, +3.0 min wall.");
    expect(text).toContain("Against pipeline, swarm-crew: +0 points success, +0 scope violations, +$3.000 mean cost, +4.0 min wall.");
    expect(text).not.toContain("Against baseline");
  });
  it("renders an empty result without a suite", () => {
    const text = renderAblation(summarizeEval([{ source: "e.json", data: { results: [] } }]));
    expect(text).toContain("Ablation of results: 0 sessions from e.json; 0 tasks.");
    expect(text).not.toContain("Against baseline");
  });

  it("orders memory after crew, compares it against pipeline on a fifth measure (mean turns), and adds a Wired column only when a result carries memoryWired", () => {
    // card memory-measure: memory is the pipeline arm plus recall on, so it is measured against pipeline like
    // the other arms, plus mean turns and the wiring tripwire's own column and shipping verdict. Duplicated to
    // two identical runs each (card eval-accuracy part 3), so the comparison prints a delta rather than the
    // single-run sentence.
    const data: EvalFile = {
      suite: "ts-basic",
      results: [
        { task: "fix-hours-planned", condition: "pipeline", run: 1, costUsd: 4, turns: 10, durationMs: 600000, verified: true, inScope: true, success: true },
        { task: "fix-hours-planned", condition: "pipeline", run: 2, costUsd: 4, turns: 10, durationMs: 600000, verified: true, inScope: true, success: true },
        { task: "fix-hours-planned", condition: "memory", run: 1, costUsd: 4, turns: 8, durationMs: 540000, verified: true, inScope: true, success: true, memoryWired: true },
        { task: "fix-hours-planned", condition: "memory", run: 2, costUsd: 4, turns: 8, durationMs: 540000, verified: true, inScope: true, success: true, memoryWired: true },
      ],
    };
    const a = summarizeEval([{ source: "mem.json", data }]);
    expect(a.conditions.map((c) => c.condition)).toEqual(["pipeline", "memory"]);
    expect(a.conditions.find((c) => c.condition === "pipeline")?.memoryWired).toBeNull();
    expect(a.conditions.find((c) => c.condition === "memory")?.memoryWired).toBe(2);
    const text = renderAblation(a);
    expect(text).toContain("| Condition | Sessions | Success | Verified | In scope | Mean cost | Mean turns | Mean wall | Wired |");
    expect(text).toContain("| pipeline | 2 | 2/2 (100%) | 2/2 | 2/2 | $4.000 ($4.000–$4.000) | 10.0 | 10.0 min (10.0–10.0) | - |");
    expect(text).toContain("| memory | 2 | 2/2 (100%) | 2/2 | 2/2 | $4.000 ($4.000–$4.000) | 8.0 | 9.0 min (9.0–9.0) | 2/2 |");
    expect(text).toContain("Against pipeline, memory: +0 points success, +0 scope violations, +$0.000 mean cost, -2.0 mean turns, -1.0 min wall.");
    expect(text).toContain("memory: ships on by default");
  });

  it("prints a single-run sentence for the memory comparison, and no verdict line, when either side ran only one session", () => {
    const data: EvalFile = {
      suite: "ts-basic",
      results: [
        { task: "fix-hours-planned", condition: "pipeline", costUsd: 4, turns: 10, durationMs: 600000, verified: true, inScope: true, success: true },
        { task: "fix-hours-planned", condition: "memory", costUsd: 4, turns: 8, durationMs: 540000, verified: true, inScope: true, success: true, memoryWired: true },
      ],
    };
    const text = renderAblation(summarizeEval([{ source: "mem.json", data }]));
    expect(text).toContain("Against pipeline, memory: single run (n=1 vs n=1), not reported as a difference.");
    expect(text).not.toContain("points success");
    expect(text).not.toContain("ships on by default");
    expect(text).not.toContain("ships off by default");
  });

  it("leaves the Wired column and the memory comparison out when no result carries it", () => {
    const data: EvalFile = { suite: "s", results: [{ task: "t", condition: "pipeline", costUsd: 1, turns: 5, verified: true, inScope: true, success: true }] };
    const text = renderAblation(summarizeEval([{ source: "x.json", data }]));
    expect(text).toContain("| Condition | Sessions | Success | Verified | In scope | Mean cost | Mean turns | Mean wall |");
    expect(text).not.toContain("Wired");
    expect(text).not.toContain("Against pipeline, memory");
  });
});

describe("memoryVerdict", () => {
  const cond = (overrides: Partial<ConditionSummary>): ConditionSummary => ({
    condition: "x",
    sessions: 1,
    successes: 1,
    successRate: 1,
    verified: 1,
    inScope: 1,
    priced: 1,
    totalCostUsd: 1,
    meanCostUsd: 1,
    meanTurns: 5,
    meanDurationMs: 60000,
    scopeViolations: 0,
    memoryWired: null,
    spread: { success: null, hidden: null, defects: null, scopeViolations: null, cost: null, wall: null },
    judged: null,
    ...overrides,
  });

  it("ships on by default when at least one of the five measures improved and none worsened", () => {
    const pipeline = cond({ successRate: 0.5, scopeViolations: 1, meanCostUsd: 5, meanTurns: 10, meanDurationMs: 600000 });
    const memory = cond({ successRate: 0.5, scopeViolations: 1, meanCostUsd: 4, meanTurns: 10, meanDurationMs: 600000 }); // only cost improved
    expect(memoryVerdict(memory, pipeline)).toBe("memory: ships on by default");
  });

  it("ships off by default and names what worsened, even when something else improved", () => {
    const pipeline = cond({ successRate: 0.5, scopeViolations: 1, meanCostUsd: 5, meanTurns: 10, meanDurationMs: 600000 });
    const memory = cond({ successRate: 0.5, scopeViolations: 1, meanCostUsd: 4, meanTurns: 12, meanDurationMs: 600000 }); // cost improved, turns worsened
    expect(memoryVerdict(memory, pipeline)).toBe("memory: ships off by default (turns worsened)");
  });

  it("ships off by default naming nothing improved when every comparable measure tied", () => {
    const pipeline = cond({ successRate: 0.5, scopeViolations: 1, meanCostUsd: 5, meanTurns: 10, meanDurationMs: 600000 });
    const memory = cond({ successRate: 0.5, scopeViolations: 1, meanCostUsd: 5, meanTurns: 10, meanDurationMs: 600000 });
    expect(memoryVerdict(memory, pipeline)).toBe("memory: ships off by default (nothing improved)");
  });
});

describe("spreadOf", () => {
  it("returns null for an empty list", () => {
    expect(spreadOf([])).toBeNull();
  });

  it("returns mean = min = max, n = 1 for a single value", () => {
    expect(spreadOf([4])).toEqual({ mean: 4, min: 4, max: 4, n: 1 });
  });

  it("computes mean, min, and max over several values", () => {
    expect(spreadOf([1, 5, 3])).toEqual({ mean: 3, min: 1, max: 5, n: 3 });
  });
});

describe("the single-run rule (card eval-accuracy part 3)", () => {
  const rows = (condition: string, n: number, costUsd: number, success: boolean) =>
    Array.from({ length: n }, (_, i) => ({ task: "t", condition, run: i + 1, costUsd, turns: 5, verified: true, inScope: true, success }));

  it("prints the single-run sentence and no delta when one side ran only one session (1 vs 3)", () => {
    const data: EvalFile = { suite: "s", results: [...rows("baseline", 1, 1, false), ...rows("full", 3, 2, true)] };
    const text = renderAblation(summarizeEval([{ source: "x.json", data }]));
    expect(text).toContain("Against baseline, full: single run (n=3 vs n=1), not reported as a difference.");
    expect(text).not.toContain("points success");
  });

  it("prints the delta when both sides ran two or more sessions (2 vs 2)", () => {
    const data: EvalFile = { suite: "s", results: [...rows("baseline", 2, 1, false), ...rows("full", 2, 2, true)] };
    const text = renderAblation(summarizeEval([{ source: "x.json", data }]));
    expect(text).toContain("Against baseline, full: +100 points success, +$1.000 mean cost.");
    expect(text).not.toContain("single run");
  });
});

describe("hidden pass rate and defects (card eval-accuracy)", () => {
  const fixture = join(here, "fixtures/evals/hidden-defects.json");

  it("adds Hidden and Defects columns and spread cells, leaves an inconclusive judge out of the defects mean, and notes the judged count", () => {
    const a = summarizeEval([{ source: fixture, data: load(fixture) }]);
    const pipeline = a.conditions.find((c) => c.condition === "pipeline");
    const crew = a.conditions.find((c) => c.condition === "crew");
    const swarm = a.conditions.find((c) => c.condition === "swarm");
    expect(pipeline?.spread.hidden).toEqual({ mean: 0.75, min: 0.5, max: 1, n: 3 });
    // The third pipeline run's judge came back inconclusive (worktree-modified): its defects (total 0) must not
    // enter the mean, so only the two judged runs (2 and 1) count, and `judged` reports 2 of 3 sessions.
    expect(pipeline?.spread.defects).toEqual({ mean: 1.5, min: 1, max: 2, n: 2 });
    expect(pipeline?.judged).toBe(2);
    expect(crew?.judged).toBe(3);
    expect(swarm?.spread.hidden).toBeNull();
    expect(swarm?.spread.defects).toBeNull();
    expect(swarm?.judged).toBeNull();

    const text = renderAblation(a);
    expect(text).toContain("| Condition | Sessions | Success | Verified | In scope | Mean cost | Mean turns | Mean wall | Hidden | Defects |");
    expect(text).toContain("| pipeline | 3 | 2/3 (67%) | 3/3 | 3/3 | $5.000 ($4.000–$6.000) | 12.0 | 11.0 min (10.0–12.0) | 75% (50%–100%) | 1.5 (1–2) (2 judged) |");
    expect(text).toContain("| crew | 3 | 2/3 (67%) | 3/3 | 2/3 | $8.000 ($7.000–$9.000) | 9.0 | 10.0 min (9.0–11.0) | 88% (75%–100%) | 0.7 (0–1) |");
    expect(text).toContain("| swarm | 2 | 2/2 (100%) | 2/2 | 2/2 | $3.500 ($3.000–$4.000) | 5.5 | 5.5 min (5.0–6.0) | - | - |");
  });

  it("appends hidden pass rate and defects deltas to an Against pipeline arm line, and omits them when the other side has no spread", () => {
    const a = summarizeEval([{ source: fixture, data: load(fixture) }]);
    const text = renderAblation(a);
    expect(text).toContain("Against pipeline, crew: +0 points success, +1 scope violations, +$3.000 mean cost, -1.0 min wall, +13 points hidden pass rate, -0.8 defects.");
    // swarm carries neither hidden nor defects: the fragments are omitted, not fabricated as 0.
    expect(text).toContain("Against pipeline, swarm: +33 points success, +0 scope violations, -$1.500 mean cost, -5.5 min wall.");
  });

  it("omits the hidden and defects deltas when a side's OWN spread for that measure drew on fewer than two sessions, even though the condition itself ran two or more", () => {
    // pipeline has two sessions overall, but only run 1 carries a hidden set and only run 1's judge was
    // conclusive (run 2's errored): neither hidden nor defects clears the two-sample bar on pipeline's side,
    // even though crew (the other side) has a full two-sample spread for both. The four original measures
    // still compare normally, since those are not gated on hidden/defects at all.
    const data: EvalFile = {
      suite: "s",
      results: [
        {
          task: "t",
          condition: "pipeline",
          run: 1,
          costUsd: 4,
          turns: 10,
          durationMs: 600000,
          verified: true,
          inScope: true,
          success: true,
          hidden: { total: 8, passed: 6, rate: 0.75 },
          defects: { judge: "claude", verdict: "pass", blocker: 0, major: 1, minor: 1, total: 2, error: null },
        },
        {
          task: "t",
          condition: "pipeline",
          run: 2,
          costUsd: 6,
          turns: 14,
          durationMs: 720000,
          verified: true,
          inScope: true,
          success: false,
          defects: { judge: "claude", verdict: "inconclusive", blocker: 0, major: 0, minor: 0, total: 0, error: "worktree-modified" },
        },
        {
          task: "t",
          condition: "crew",
          run: 1,
          costUsd: 5,
          turns: 8,
          durationMs: 540000,
          verified: true,
          inScope: true,
          success: true,
          hidden: { total: 8, passed: 8, rate: 1.0 },
          defects: { judge: "claude", verdict: "pass", blocker: 0, major: 0, minor: 0, total: 0, error: null },
        },
        {
          task: "t",
          condition: "crew",
          run: 2,
          costUsd: 7,
          turns: 10,
          durationMs: 660000,
          verified: true,
          inScope: true,
          success: true,
          hidden: { total: 8, passed: 6, rate: 0.75 },
          defects: { judge: "claude", verdict: "pass", blocker: 0, major: 1, minor: 0, total: 2, error: null },
        },
      ],
    };
    const a = summarizeEval([{ source: "x.json", data }]);
    const pipeline = a.conditions.find((c) => c.condition === "pipeline");
    expect(pipeline?.sessions).toBe(2);
    expect(pipeline?.spread.hidden).toEqual({ mean: 0.75, min: 0.75, max: 0.75, n: 1 });
    expect(pipeline?.spread.defects).toEqual({ mean: 2, min: 2, max: 2, n: 1 });
    const text = renderAblation(a);
    expect(text).toContain("Against pipeline, crew: +50 points success, +0 scope violations, +$1.000 mean cost, -1.0 min wall.");
    expect(text).not.toContain("hidden pass rate");
  });

  it("shows the Defects column, with \"- (0 judged)\", when every judge came back inconclusive (the field is present but nothing was judged)", () => {
    const data: EvalFile = {
      suite: "s",
      results: [
        { task: "t", condition: "pipeline", run: 1, costUsd: 1, turns: 5, verified: true, inScope: true, success: true, defects: { judge: "claude", verdict: "inconclusive", blocker: 0, major: 0, minor: 0, total: 0, error: "worktree-modified" } },
        { task: "t", condition: "pipeline", run: 2, costUsd: 1, turns: 5, verified: true, inScope: true, success: true, defects: { judge: "claude", verdict: "inconclusive", blocker: 0, major: 0, minor: 0, total: 0, error: "claude spawn failed: boom" } },
      ],
    };
    const a = summarizeEval([{ source: "x.json", data }]);
    const pipeline = a.conditions.find((c) => c.condition === "pipeline");
    expect(pipeline?.spread.defects).toBeNull();
    expect(pipeline?.judged).toBe(0);
    const text = renderAblation(a);
    expect(text).toContain("| Condition | Sessions | Success | Verified | In scope | Mean cost | Mean turns | Mean wall | Defects |");
    expect(text).toContain("| pipeline | 2 | 2/2 (100%) | 2/2 | 2/2 | $1.000 ($1.000–$1.000) | 5.0 | - | - (0 judged) |");
  });

  it("appends \"(<k> of <n>)\" to the Hidden cell when fewer sessions carried a hidden set than the condition ran", () => {
    const data: EvalFile = {
      suite: "s",
      results: [
        { task: "t", condition: "pipeline", run: 1, costUsd: 1, turns: 5, verified: true, inScope: true, success: true, hidden: { total: 4, passed: 2, rate: 0.5 } },
        { task: "t", condition: "pipeline", run: 2, costUsd: 1, turns: 5, verified: true, inScope: true, success: true, hidden: { total: 4, passed: 4, rate: 1.0 } },
        { task: "t", condition: "pipeline", run: 3, costUsd: 1, turns: 5, verified: true, inScope: true, success: true },
      ],
    };
    const text = renderAblation(summarizeEval([{ source: "x.json", data }]));
    expect(text).toContain("| Condition | Sessions | Success | Verified | In scope | Mean cost | Mean turns | Mean wall | Hidden |");
    expect(text).toContain("| pipeline | 3 | 3/3 (100%) | 3/3 | 3/3 | $1.000 ($1.000–$1.000) | 5.0 | - | 75% (50%–100%) (2 of 3) |");
  });

  it("carries judged beside the spread in JSON, untouched by --json", () => {
    const a = summarizeEval([{ source: fixture, data: load(fixture) }]);
    const parsed = JSON.parse(JSON.stringify(a));
    expect(parsed.conditions.find((c: ConditionSummary) => c.condition === "pipeline").judged).toBe(2);
    expect(parsed.conditions.find((c: ConditionSummary) => c.condition === "pipeline").spread.defects).toEqual({ mean: 1.5, min: 1, max: 2, n: 2 });
  });

  it("gains Hidden and Defects mean columns in the per-task table under the same visibility rule", () => {
    const data: EvalFile = {
      suite: "s",
      results: [
        { task: "task-a", condition: "pipeline", costUsd: 1, turns: 5, verified: true, inScope: true, success: true, hidden: { total: 4, passed: 3, rate: 0.75 }, defects: { judge: "claude", verdict: "pass", blocker: 0, major: 0, minor: 1, total: 1, error: null } },
        { task: "task-b", condition: "pipeline", costUsd: 1, turns: 5, verified: true, inScope: true, success: true },
      ],
    };
    const text = renderAblation(summarizeEval([{ source: "tasks.json", data }]));
    expect(text).toContain("| Task | Condition | Sessions | Success | Mean cost | Hidden | Defects |");
    expect(text).toContain("| task-a | pipeline | 1 | 1/1 | $1.000 | 75% | 1.0 |");
    expect(text).toContain("| task-b | pipeline | 1 | 1/1 | $1.000 | - | - |");
  });
});

describe("newestResult", () => {
  it("breaks an equal-mtime tie by name, not by readdirSync's raw order, favoring the lexicographically later (newer, for ISO-timestamp names) one", () => {
    const dir = `/anything/${SENTINEL}`;
    expect(newestResult(dir, 0)).toBe(join(dir, "c.json"));
  });
});

describe("doug ablate --from", () => {
  it("summarizes the saved results, as text or JSON, and spends nothing", async () => {
    const text = await run(["--from", first, "--from", second]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(`Ablation of suite ts-basic: 2 sessions from ${first}, ${second}; 1 task (fix-hours).`);
    expect(text.stdout).toContain("| full | 2 | 1/2 (50%) | 2/2 | 1/2 | $0.457 ($0.402–$0.513) | 12.5 |");
    expect(text.stdout).not.toContain("Against baseline");
    const json = await run(["--from", second, "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.conditions[0]).toMatchObject({ condition: "full", successes: 1, meanCostUsd: 0.40162725 });
  });
  it("exits 1 on a missing or malformed file and 0 with usage on --help", async () => {
    const missing = await run(["--from", join(here, "fixtures/evals/nope.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read");
    const dir = mkdtempSync(join(tmpdir(), "doug-ablate-"));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ suite: "x" }));
    const bad = await run(["--from", join(dir, "bad.json")]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("not an eval result: no results array");
    const empty = await run(["--from"]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("--from needs a file");
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("doug ablate --from");
  });
});

describe("doug ablate running evals/run.mjs", () => {
  // A fake runner records the arguments it got and writes a result file the way the real one does.
  function repo(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "doug-ablate-repo-"));
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(join(dir, "evals", "run.mjs"), script);
    return dir;
  }
  const writingRunner = `
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--dry-run")) { console.log("Dry run. Nothing executed."); process.exit(0); }
mkdirSync("evals/out", { recursive: true });
const results = [];
for (const c of ["baseline", "full"]) results.push({ task: "fix-hours", condition: c, run: 1, costUsd: c === "full" ? 0.4 : 0.3, turns: 5, verified: c === "full", inScope: true, success: c === "full" });
writeFileSync("evals/out/2026-09-06T00-00-00-000Z.json", JSON.stringify({ suite: "ts-basic", options: { args }, results }));
console.log("ran " + args.join(" "));
`;
  it("passes the task-set options through, then summarizes the result the runner wrote", async () => {
    const dir = repo(writingRunner);
    const r = await run([
      dir,
      "--tasks",
      "fix-hours",
      "--conditions",
      "baseline,full",
      "--runs",
      "1",
      "--max-turns",
      "20",
      "--suite",
      "ts-basic",
      "--max-budget-usd",
      "7",
      "--judge",
      "off",
      "--judge-model",
      "haiku",
    ]);
    expect(r.code, r.stderr).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, "evals/out", readdirSync(join(dir, "evals/out"))[0]), "utf8"));
    expect(written.options.args).toEqual([
      "--tasks",
      "fix-hours",
      "--conditions",
      "baseline,full",
      "--runs",
      "1",
      "--max-turns",
      "20",
      "--suite",
      "ts-basic",
      "--max-budget-usd",
      "7",
      "--judge",
      "off",
      "--judge-model",
      "haiku",
    ]);
    expect(r.stdout).toContain("| baseline | 1 | 0/1 (0%) | 0/1 | 1/1 | $0.300 | 5.0 |");
    expect(r.stdout).toContain("| full | 1 | 1/1 (100%) | 1/1 | 1/1 | $0.400 | 5.0 |");
    // Both sides ran one session (card eval-accuracy part 3): the delta line is never printed for a single run.
    expect(r.stdout).toContain("Against baseline, full: single run (n=1 vs n=1), not reported as a difference.");
  });
  it("only prints the runner's plan on --dry-run, and reports a runner that failed or wrote nothing", async () => {
    const dry = await run([repo(writingRunner), "--dry-run", "--tasks", "fix-hours"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).not.toContain("Ablation of");
    const failing = await run([repo("process.exit(3)")]);
    expect(failing.code).toBe(3);
    expect(failing.stderr).toContain("evals/run.mjs exited with status 3; nothing summarized");
    const silent = await run([repo("console.log('nothing written')")]);
    expect(silent.code).toBe(1);
    expect(silent.stderr).toContain("wrote no result under");
    const none = await run([mkdtempSync(join(tmpdir(), "doug-ablate-empty-"))]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no eval runner at");
    expect(none.stderr).toContain("--from <evals/out/file.json>");
  });
});

describe("the ts-basic task set", () => {
  const suite = JSON.parse(readFileSync(join(here, "../../../evals/tasks/ts-basic.json"), "utf8"));
  const task = suite.tasks.find((t: { id: string }) => t.id === "schedule-feature");

  // Dependency levels the way plan.mjs levelize computes them: a task's level is one past its deepest dependency.
  function levels(tasks: Array<{ id: string; dependsOn?: string[] }>): string[][] {
    const level = new Map<string, number>();
    const depth = (id: string): number => {
      if (level.has(id)) return level.get(id) as number;
      const t = tasks.find((x) => x.id === id) as { dependsOn?: string[] };
      const d = (t.dependsOn || []).reduce((m, dep) => Math.max(m, depth(dep) + 1), 0);
      level.set(id, d);
      return d;
    };
    const out: string[][] = [];
    for (const t of tasks) (out[depth(t.id)] ||= []).push(t.id);
    return out;
  }

  it("carries a multi-file feature whose plan spans two levels, so orchestration is measured on more than one file (card eval-multifile-task)", () => {
    expect(task, "schedule-feature task").toBeDefined();
    for (const h of task.heldOut) expect(existsSync(join(here, "../../../evals/heldout", h.from)), h.from).toBe(true);
    const planFiles = task.plan.tasks.flatMap((t: { files: string[] }) => t.files).sort();
    expect(planFiles).toEqual([...task.allowedFiles].sort());
    expect(new Set(planFiles).size).toBe(planFiles.length);
    expect(levels(task.plan.tasks)).toEqual([["format-duration", "title-case"], ["schedule"]]);
    expect(planFiles.filter((f: string) => f.startsWith("src/")).length).toBeGreaterThanOrEqual(3);
    for (const name of ["formatDuration", "titleCase", "describeSchedule", "src/schedule.ts"]) expect(task.prompt).toContain(name);
    expect(task.mustPass).toEqual(["pnpm test", "pnpm typecheck"]);
    expect(task.mustNotChange).toContain("pnpm-lock.yaml");
  });
});
