// The on-demand live rehearsal runner (card workflow-rehearsal, and the review that followed it): the CLI never
// spawns claude without --spend and a --card (proven with a fake claude and a marker file), the per-stage
// estimate table, the pure stream assertions on captured stream-json shapes (research §2), real fixture setup
// (the suite's own setup commands run, so node_modules exists on a fresh checkout), the hand scenario's build
// assertion against /core-next's real commit order, error handling around a claude binary that cannot run, the
// per-stage spend cap, and recording that always goes through the board.mjs CLI. Never spawns the real claude
// binary; every fixture and temp directory this file creates is removed in afterAll.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ESTIMATES,
  SCENARIOS,
  CLI,
  BOARD_MJS,
  RESULTS_FILE,
  ROOT,
  estimateLines,
  scenarioTotal,
  capFor,
  parseArgs,
  pluginsLoaded,
  slashCommandPresent,
  unresolvedAgentNames,
  sessionCost,
  readReport,
  syntheticReport,
  assertImplemented,
  agentNamesFromReport,
  assertTwoParents,
  assertFlowGateHeld,
  prepareFixture,
  runStage,
  runSessionStage,
  runActStage,
  SCENARIO_STAGES,
  assertHandBuilt,
  recordHandOutcome,
  recordRunOutcome,
  rehearsalNote,
  extractGateLine,
  archiveEvidence,
  cleanEnv,
  dirtyOutsideDoug,
} from "../lib/rehearse.mjs";
import { newBoard, addCard, saveBoard, runEntry, BOARD_RELPATH } from "../lib/board.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "scripts", "rehearse.mjs");
const TEST_PREFIX = "doug-rehearse-test-"; // distinct from a real run's "doug-rehearse-<scenario>-" (review #7)

// Every temp directory this file creates is removed here, whether the test that made it passed or not.
const tempDirs = [];
function trackedTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// A fake `claude` executable: writes a marker file (if given) and/or its argv (if given), then prints the given
// stream-json lines and exits 0. No extension and a shebang, like packages/doug-codex/tests/helpers.ts's fake
// codex, so `spawnSync(bin, ...)` runs it directly.
function makeFakeClaude(streamText = "", { marker = null, argvFile = null } = {}) {
  const dir = trackedTempDir("fake-claude-");
  const bin = join(dir, "claude");
  const lines = String(streamText)
    .split("\n")
    .filter(Boolean)
    .map((l) => `process.stdout.write(${JSON.stringify(l)} + "\\n");`)
    .join("\n");
  const script = [
    "#!/usr/bin/env node",
    marker ? `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");` : "",
    argvFile ? `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));` : "",
    lines,
    "process.exit(0);",
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

function cannedStream({ plugins = ["doug-flow"], commands = ["doug-flow:core-next"], cost = 0.01 } = {}) {
  const init = { type: "system", subtype: "init", plugins: plugins.map((name) => ({ name, path: "/x", source: `${name}@inline` })), slash_commands: commands };
  const result = { type: "result", total_cost_usd: cost, num_turns: 1 };
  return `${JSON.stringify(init)}\n${JSON.stringify(result)}\n`;
}

// Every spawn this file makes uses the library's own cleanEnv, so the file is green whether or not a leaked
// CLAUDE_PROJECT_DIR/GIT_* is set in this process's environment (card workflow-rehearsal-review, round 2).
function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
}
function spawnScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: cleanEnv() });
}

// The uncommitted move /doug-next's own step 1 does before it ever reaches the planner (task
// rehearse-uncommitted-move: the move stays uncommitted working state, landing only in the card's landing
// commit), used by the flow gate tests below to build the exact fixture state a correct run leaves.
function moveUncommitted(dir) {
  const board = JSON.parse(readFileSync(join(dir, BOARD_RELPATH), "utf8"));
  board.cards.find((c) => c.id === "fix-hours").column = "flow";
  writeFileSync(join(dir, BOARD_RELPATH), JSON.stringify(board, null, 2));
}

// What a run that (incorrectly) commits the board move leaves behind, used to prove assertFlowGateHeld fails it.
function moveAndCommit(dir) {
  moveUncommitted(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Board: fix-hours moved to In flow");
}

// A draft plan shaped like the one the real planner wrote in the first live flow rehearsal (fixture
// doug-rehearse-flow-A6oITj): valid against plan.mjs validate, one task owning the two files fix-hours touches.
function draftPlan(overrides = {}) {
  return {
    version: 1,
    title: "Fix hours in parseDuration",
    goal: "parseDuration returns the right number of milliseconds for hour inputs",
    status: "draft",
    baseBranch: "main",
    card: "fix-hours",
    acceptance: [{ text: "parseDuration(\"2h\") returns 7_200_000", command: "pnpm exec vitest run tests/duration.test.ts" }],
    verify: ["pnpm typecheck", "pnpm test"],
    tasks: [
      {
        id: "fix-hours-factor",
        title: "Use 3_600_000 for the h unit in parseDuration",
        spec: "Size S. Change the h case of parseDuration to multiply by 3_600_000 and add a covering test.",
        files: ["src/duration.ts", "tests/duration.test.ts"],
        verify: "pnpm exec vitest run tests/duration.test.ts",
        dependsOn: [],
        size: "S",
        gate: "auto",
      },
    ],
    ...overrides,
  };
}

describe("rehearse.mjs CLI never spawns claude without --spend and a --card", () => {
  function run(args, env) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  }
  function withMarker() {
    const marker = join(trackedTempDir("rehearse-marker-"), "spawned");
    return { marker, claudeBin: makeFakeClaude("", { marker }) };
  }

  it("no arguments: prints the estimate table (a USD figure per scenario) and exits non-zero, spawning nothing", () => {
    const { marker, claudeBin } = withMarker();
    const r = run([], { DOUG_REHEARSE_CLAUDE: claudeBin });
    expect(r.status).toBe(2);
    for (const s of SCENARIOS) expect(r.stdout).toContain(`$${scenarioTotal(s).toFixed(2)}`);
    expect(existsSync(marker)).toBe(false);
  });

  it("a scenario without --spend: prints that scenario's per-stage estimate and 'add --spend', exits non-zero, spawns nothing", () => {
    const { marker, claudeBin } = withMarker();
    const r = run(["hand"], { DOUG_REHEARSE_CLAUDE: claudeBin });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`$${scenarioTotal("hand").toFixed(2)}`);
    for (const stage of Object.keys(ESTIMATES.hand.stages)) expect(r.stdout).toContain(stage);
    expect(r.stdout.toLowerCase()).toContain("add --spend");
    expect(existsSync(marker)).toBe(false);
  });

  it("--spend without --card: exits non-zero naming --card, spawns nothing", () => {
    const { marker, claudeBin } = withMarker();
    const r = run(["hand", "--spend"], { DOUG_REHEARSE_CLAUDE: claudeBin });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--card");
    expect(existsSync(marker)).toBe(false);
  });

  it("an unknown scenario is refused before anything is spawned", () => {
    const { marker, claudeBin } = withMarker();
    const r = run(["bogus", "--spend", "--card", "x"], { DOUG_REHEARSE_CLAUDE: claudeBin });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown scenario");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("ESTIMATES and estimateLines are per stage (review #6)", () => {
  it("ESTIMATES carries a usd figure per stage and a source per scenario; a stage's cap is 3x its own figure", () => {
    for (const s of SCENARIOS) {
      expect(typeof ESTIMATES[s].source).toBe("string");
      expect(ESTIMATES[s].source.length).toBeGreaterThan(10);
      for (const [stage, usd] of Object.entries(ESTIMATES[s].stages)) {
        expect(typeof usd).toBe("number");
        expect(capFor(s, stage)).toBeCloseTo(usd * 3, 5);
      }
    }
    // Every stage a scenario actually runs has an estimate, and vice versa.
    for (const s of SCENARIOS) {
      const sessionStageNames = SCENARIO_STAGES[s].filter((st) => st.kind === "session").map((st) => st.name);
      expect(Object.keys(ESTIMATES[s].stages).sort()).toEqual(sessionStageNames.sort());
    }
  });
  it("estimateLines(): no scenario renders one total per scenario plus the all total; a named scenario renders its stage breakdown", () => {
    const lines = estimateLines();
    expect(lines.length).toBe(SCENARIOS.length + 1);
    for (const s of SCENARIOS) expect(lines.some((l) => l.includes(s) && l.includes(`$${scenarioTotal(s).toFixed(2)}`))).toBe(true);
    expect(lines[lines.length - 1]).toContain(`$${SCENARIOS.reduce((a, s) => a + scenarioTotal(s), 0).toFixed(2)}`);

    const flowLines = estimateLines("flow");
    expect(flowLines[0]).toContain(`$${scenarioTotal("flow").toFixed(2)} total`);
    for (const stage of Object.keys(ESTIMATES.flow.stages)) expect(flowLines.some((l) => l.includes(stage))).toBe(true);
  });
});

describe("parseArgs", () => {
  it("reads the scenario, --card, --spend, and a trailing dir positionally", () => {
    expect(parseArgs([])).toEqual({ scenario: null, dir: null, spend: false, card: null });
    expect(parseArgs(["flow", "--card", "x", "--spend", "/tmp/repo"])).toEqual({ scenario: "flow", dir: "/tmp/repo", spend: true, card: "x" });
    expect(parseArgs(["all", "--spend"])).toEqual({ scenario: "all", dir: null, spend: true, card: null });
  });
});

describe("stream assertions read the exact stream-json shapes (research §2)", () => {
  it("pluginsLoaded and slashCommandPresent read the init event", () => {
    const stream = cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next", "doug-flow:core-next"] });
    expect(pluginsLoaded(stream, ["doug-flow"])).toBe(true);
    expect(pluginsLoaded(stream, ["doug-flow", "other-plugin"])).toBe(false);
    expect(slashCommandPresent(stream, "doug-flow:doug-next")).toBe(true);
    expect(slashCommandPresent(stream, "doug-flow:nope")).toBe(false);
    expect(pluginsLoaded("", ["doug-flow"])).toBe(false);
  });
  it("unresolvedAgentNames reads every 'Agent type ... not found' tool_result and nothing else", () => {
    const stream = [
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Agent type 'doug-flow:ghost' not found. Available agents: lead, worker" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: false, content: "ok" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Agent type 'nope-2' not found." }] } }),
    ].join("\n");
    expect(unresolvedAgentNames(stream)).toEqual(["doug-flow:ghost", "nope-2"]);
    expect(unresolvedAgentNames(cannedStream())).toEqual([]);
  });
  it("sessionCost reads total_cost_usd from the result line, null when absent", () => {
    expect(sessionCost(cannedStream({ cost: 1.23 }))).toBe(1.23);
    expect(sessionCost("")).toBeNull();
    expect(sessionCost(JSON.stringify({ type: "result" }))).toBeNull();
  });
});

describe("assertImplemented (review #12)", () => {
  function reportDir(report) {
    const dir = trackedTempDir("rehearse-report-");
    mkdirSync(join(dir, dirname(RESULTS_FILE)), { recursive: true });
    writeFileSync(join(dir, RESULTS_FILE), JSON.stringify(report));
    return dir;
  }
  const okTask = { id: "a", verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" } };

  it("passes on a plain report with no workers when workers are not required", () => {
    const dir = reportDir({ ok: true, levels: [{ tasks: [okTask] }] });
    const result = assertImplemented(dir, cannedStream(), { plugins: ["doug-flow"] });
    expect(result.ok, result.message).toBe(true);
  });
  it("fails a swarm check when no task carries workers", () => {
    const dir = reportDir({ ok: true, levels: [{ tasks: [okTask] }] });
    const result = assertImplemented(dir, cannedStream(), { plugins: ["doug-flow"], requireWorkers: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("workers");
  });
  it("passes a swarm check when a task carries a non-empty workers array", () => {
    const dir = reportDir({ ok: true, levels: [{ tasks: [{ ...okTask, workers: [{ id: "brief-a" }] }] }] });
    const result = assertImplemented(dir, cannedStream(), { plugins: ["doug-flow"], requireWorkers: true });
    expect(result.ok, result.message).toBe(true);
  });
  it("fails when a task is not verified or not reviewed, or the report is not ok", () => {
    expect(assertImplemented(reportDir({ ok: true, levels: [{ tasks: [{ ...okTask, verified: false }] }] }), cannedStream(), { plugins: ["doug-flow"] }).ok).toBe(false);
    expect(assertImplemented(reportDir({ ok: false, levels: [] }), cannedStream(), { plugins: ["doug-flow"] }).ok).toBe(false);
  });
  it("with an empty stream and no report, fails on the missing plugin first (checked before the report), naming it exactly (review 2 finding 18)", () => {
    const dir = trackedTempDir("rehearse-noreport-");
    const result = assertImplemented(dir, "", { plugins: ["doug-flow"] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("the init event's plugins did not name doug-flow");
  });
});

describe("agentNamesFromReport collects every attempt's stages, not just the last, plus worker ids (review #13)", () => {
  it("unions attempts[].stages and workers[].id across tasks", () => {
    const report = {
      levels: [
        {
          tasks: [
            {
              id: "a",
              attempts: [{ stages: ["lead", "worker-1", "worker-2"] }, { stages: ["level-adversary"] }],
              workers: [{ id: "brief-a" }, { id: "brief-b" }],
              stages: ["level-adversary"], // the last pass only; must not be the sole source
            },
          ],
        },
      ],
    };
    const names = agentNamesFromReport(report);
    for (const n of ["lead", "worker-1", "worker-2", "level-adversary", "brief-a", "brief-b"]) expect(names).toContain(n);
  });
  it("is empty for a report with no tasks", () => {
    expect(agentNamesFromReport({ levels: [] })).toEqual([]);
  });
});

describe("rehearsalNote (review #10, #12, #13)", () => {
  it("a stage's own message reaches the recorded note", () => {
    const note = rehearsalNote({ scenario: "flow", outcome: "passed", stages: [{ name: "approve", wallClock: "1 min", message: "approved; the plan also owns src/other.ts (noted, not blocking)" }] });
    expect(note).toContain("approve (1 min) — approved; the plan also owns src/other.ts (noted, not blocking)");
  });
  it("the swarm form names the plugin and the resolved agents", () => {
    const note = rehearsalNote({ scenario: "swarm", outcome: "passed", stages: [{ name: "implement", wallClock: "6 min" }], cost: 3.9, agentNames: ["lead", "worker-1", "worker-2", "lead-merge"] });
    expect(note).toContain("Rehearsal swarm on the ts-basic fixture: passed; stages implement (6 min)");
    expect(note).toContain("plugin loading and agent-name resolution asserted in the runtime (plugins: doug-flow; agents resolved: lead, worker-1, worker-2, lead-merge)");
  });
  it("the hand form carries cost, not agent names", () => {
    const note = rehearsalNote({ scenario: "hand", outcome: "passed", stages: [{ name: "gate", wallClock: "1 min" }], cost: 4.1 });
    expect(note.startsWith("Rehearsal hand")).toBe(true);
    expect(note).toContain("cost $4.10");
    expect(note).not.toContain("agents resolved");
  });
});

describe("syntheticReport renders as a stopped run through runEntry, and never invents task rows (review #4)", () => {
  it("ok:false, stoppedAtLevel 0, no levels", () => {
    const report = syntheticReport("flow", "gate", "the init event's plugins did not name doug-flow");
    expect(report.ok).toBe(false);
    expect(report.levels).toEqual([]);
    expect(report.rehearsal).toEqual({ stage: "gate", message: "the init event's plugins did not name doug-flow" });
    const md = runEntry({ card: { id: "fix-hours", title: "Fix hours" }, report });
    expect(md).toContain("| Outcome | stopped at level 0 |");
    expect(md).not.toMatch(/\| 0 \| \w+ \|/); // no task row was invented
    // runEntry renders integrationBranch unconditionally inside backticks with no "missing branch" form, so a
    // nullish value would literally read "integration branch `null`" in the real docs/live-runs.md (review 2 #19).
    expect(md).not.toContain("`null`");
    expect(md).toContain("integration branch `none (no report)`");
  });
});

describe("dirtyOutsideDoug ignores .doug/ the way lib/land.mjs's own tracked-files filter does (review 2, blocker #16)", () => {
  it("an untracked .doug/plan.json and a modified, already-tracked .doug/board.json still read clean; an untracked file outside .doug/ does not", () => {
    const dir = trackedTempDir("rehearse-dirty-doug-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ v: 1 }));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");

    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ status: "draft" })); // untracked
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ v: 2 })); // modified, tracked
    expect(dirtyOutsideDoug(dir)).toEqual([]);

    writeFileSync(join(dir, "stray.txt"), "oops"); // untracked, outside .doug/
    const dirty = dirtyOutsideDoug(dir);
    expect(dirty.length).toBe(1);
    expect(dirty[0]).toContain("stray.txt");
  });
});

describe("assertTwoParents (review #11)", () => {
  it("passes on a real --no-ff merge and fails on a single-commit repo", () => {
    const dir = trackedTempDir("rehearse-merge-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "1");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const single = assertTwoParents(dir);
    expect(single.ok).toBe(false);

    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "b.txt"), "2");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feature");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "--no-ff", "-q", "-m", "merge feature", "feature");
    const merged = assertTwoParents(dir);
    expect(merged.ok, merged.message).toBe(true);
  });
});

describe("assertFlowGateHeld: the flow gate stage now includes the planner (item rehearsal-first-live-findings #1)", () => {
  function baseRepo(prefix) {
    const dir = trackedTempDir(prefix);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, BOARD_RELPATH), JSON.stringify(addCard({ ...newBoard(), components: ["flow"] }, { id: "fix-hours", title: "Fix hours", goal: "g", component: "flow", size: "S", column: "ready" }), null, 2));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    return dir;
  }
  const goodStream = cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] });

  it("fails naming plan.mjs validate on an invalid plan, not only JSON.parse (review #8)", () => {
    const dir = baseRepo("rehearse-flowgate-invalid-");
    moveUncommitted(dir);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ status: "draft" }));
    const result = assertFlowGateHeld(dir, goodStream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("plan.mjs validate failed");
  });

  it("fails when the card is still Ready: a run that never moved it must not read as a held gate", () => {
    const dir = baseRepo("rehearse-flowgate-ready-");
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(draftPlan()));
    const result = assertFlowGateHeld(dir, goodStream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not have fix-hours in flow");
  });

  it("fails when the plan is already approved: the planner must never approve on its own", () => {
    const dir = baseRepo("rehearse-flowgate-approved-");
    moveUncommitted(dir);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(draftPlan({ status: "approved" })));
    const result = assertFlowGateHeld(dir, goodStream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already approved");
  });

  it("passes when the move is uncommitted and a draft plan exists and validates", () => {
    const dir = baseRepo("rehearse-flowgate-ok-");
    moveUncommitted(dir);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(draftPlan()));
    const result = assertFlowGateHeld(dir, goodStream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" });
    expect(result.ok, result.message).toBe(true);
  });

  it("fails when the move is committed instead of left as working state: /doug-next leaves the move uncommitted", () => {
    const dir = baseRepo("rehearse-flowgate-committed-move-");
    moveAndCommit(dir);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(draftPlan()));
    const result = assertFlowGateHeld(dir, goodStream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("moved to In flow");
    expect(result.message).toContain("leaves the move uncommitted");
  });

  it("fails when an integration branch already exists: the session proceeded past the gate", () => {
    const dir = baseRepo("rehearse-flowgate-branch-");
    moveUncommitted(dir);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(draftPlan()));
    git(dir, "branch", "doug/fix-hours-factor");
    const result = assertFlowGateHeld(dir, goodStream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("integration branch already exists");
  });
});

describe("runStage and runSessionStage error handling (review #5)", () => {
  it("a nonexistent claude binary surfaces as 'claude could not run', not a stream-shape failure", () => {
    const dir = trackedTempDir("rehearse-enoent-");
    const bogus = join(dir, "no-such-claude-binary");
    const r = runStage({ dir, prompt: "hi", maxTurns: 1, stage: "x", claudeBin: bogus });
    expect(r.status).toBeNull();
    expect(r.error).toBeTruthy();
    expect(r.stdout).toBe("");

    const stage = SCENARIO_STAGES.hand[0];
    const result = runSessionStage(stage, { dir, card: { id: "fix-hours" }, claudeBin: bogus });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("claude could not run");
    expect(result.message).not.toContain("plugins did not name");
  });
  it("an assertion that throws is turned into a failed result, not a crash", () => {
    const dir = trackedTempDir("rehearse-throws-");
    const throwingStage = { name: "boom", maxTurns: 1, prompt: () => "ok", assert: () => { throw new Error("kaboom"); } };
    const bin = makeFakeClaude(cannedStream());
    const result = runSessionStage(throwingStage, { dir, card: {}, claudeBin: bin });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("kaboom");
  });
  it("the cap passed to claude is 3x the stage's own estimate, not the scenario total", () => {
    const dir = trackedTempDir("rehearse-cap-");
    const argvFile = join(dir, "argv.json");
    const bin = makeFakeClaude(cannedStream(), { argvFile });
    const cap = capFor("hand", "gate");
    expect(cap).toBeCloseTo(0.75, 5);
    runStage({ dir, prompt: "/core-next fix-hours", maxTurns: 12, stage: "gate", capUsd: cap, claudeBin: bin });
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    const i = argv.indexOf("--max-budget-usd");
    expect(i).toBeGreaterThan(-1);
    expect(Number(argv[i + 1])).toBeCloseTo(cap, 5);
  });
  it("every session disallows the Artifact tool (item rehearsal-first-live-findings #5): a gate or build session must never publish from a rehearsal", () => {
    const dir = trackedTempDir("rehearse-artifact-lockout-");
    const argvFile = join(dir, "argv.json");
    const bin = makeFakeClaude(cannedStream(), { argvFile });
    runStage({ dir, prompt: "/core-next fix-hours", maxTurns: 12, stage: "gate", claudeBin: bin });
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    const i = argv.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("Artifact");
  });
});

describe("archiveEvidence (item rehearsal-first-live-findings #2): a passed run's evidence survives the fixture's removal", () => {
  it("copies the fixture's stream logs and last report into the real repository under .doug/.state/rehearsal/<scenario>-<timestamp>/", () => {
    const fixtureDir = trackedTempDir("rehearse-evidence-fixture-");
    mkdirSync(join(fixtureDir, ".doug/.state/rehearsal"), { recursive: true });
    writeFileSync(join(fixtureDir, ".doug/.state/rehearsal/gate.jsonl"), '{"type":"result"}\n');
    writeFileSync(join(fixtureDir, RESULTS_FILE), JSON.stringify({ ok: true }));
    const realDir = trackedTempDir("rehearse-evidence-real-");

    const dest = archiveEvidence({ fixtureDir, dir: realDir, scenario: "flow", now: new Date("2026-09-09T12:00:00.000Z") });

    expect(dest).toBe(join(realDir, ".doug/.state/rehearsal/flow-2026-09-09T12-00-00-000Z"));
    expect(readFileSync(join(dest, "gate.jsonl"), "utf8")).toBe('{"type":"result"}\n');
    expect(JSON.parse(readFileSync(join(dest, "last-report.json"), "utf8"))).toEqual({ ok: true });
  });
  it("does not throw when the fixture carries no report (a scenario that never reached the workflow)", () => {
    const fixtureDir = trackedTempDir("rehearse-evidence-noreport-");
    mkdirSync(join(fixtureDir, ".doug/.state/rehearsal"), { recursive: true });
    writeFileSync(join(fixtureDir, ".doug/.state/rehearsal/gate.jsonl"), "{}\n");
    const realDir = trackedTempDir("rehearse-evidence-noreport-real-");
    const dest = archiveEvidence({ fixtureDir, dir: realDir, scenario: "hand", now: new Date("2026-09-09T12:00:00.000Z") });
    expect(existsSync(join(dest, "gate.jsonl"))).toBe(true);
    expect(existsSync(join(dest, "last-report.json"))).toBe(false);
  });
});

describe("prepareFixture's setup spawn uses commandEnv (card land-force-color-enables-color)", () => {
  it("source pin: the setup loop passes commandEnv(cleanEnv()) as env, and lib/rehearse.mjs contains no FORCE_COLOR", () => {
    const source = readFileSync(join(here, "..", "lib", "rehearse.mjs"), "utf8");
    expect(source).toContain("env: commandEnv(cleanEnv())");
    expect(source).not.toContain("FORCE_COLOR");
  });
});

describe("prepareFixture builds a real fixture (no claude)", () => {
  it.skipIf(!existsSync(CLI))(
    "hand: runs the suite's setup (node_modules exists), a git repo with one commit (baseline), a board with fix-hours ready on the hand track, and doug init's settings.json; swarm: an approved plan with swarm true",
    () => {
      const hand = prepareFixture({ scenario: "hand", tempPrefix: TEST_PREFIX });
      tempDirs.push(hand.dir);
      expect(existsSync(join(hand.dir, ".git"))).toBe(true);
      expect(existsSync(join(hand.dir, "node_modules"))).toBe(true); // suite.setup ran (review #2)
      const log = git(hand.dir, "log", "--oneline").split("\n").filter(Boolean);
      expect(log.length).toBe(1);
      expect(hand.baseline).toBe(git(hand.dir, "rev-parse", "HEAD"));
      expect(existsSync(join(hand.dir, ".claude/settings.json"))).toBe(true);
      // .claude/worktrees/ is gitignored so a workflow run's worktrees never show up dirty (review 2 #17).
      expect(readFileSync(join(hand.dir, ".gitignore"), "utf8")).toContain(".claude/worktrees/");
      const board = JSON.parse(readFileSync(join(hand.dir, ".doug/board.json"), "utf8"));
      const card = board.cards.find((c) => c.id === "fix-hours");
      expect(card.column).toBe("ready");
      expect(card.track).toBe("hand");
      expect(hand.card.id).toBe("fix-hours");
      expect(existsSync(join(hand.dir, ".doug/plan.json"))).toBe(false);

      const swarm = prepareFixture({ scenario: "swarm", tempPrefix: TEST_PREFIX });
      tempDirs.push(swarm.dir);
      const plan = JSON.parse(readFileSync(join(swarm.dir, ".doug/plan.json"), "utf8"));
      expect(plan.status).toBe("approved");
      expect(plan.swarm).toBe(true);
      expect(plan.card).toBe("fix-hours");
      const swarmBoard = JSON.parse(readFileSync(join(swarm.dir, ".doug/board.json"), "utf8"));
      expect(swarmBoard.cards.find((c) => c.id === "fix-hours").track).toBeUndefined();

      const flow = prepareFixture({ scenario: "flow", tempPrefix: TEST_PREFIX });
      tempDirs.push(flow.dir);
      expect(existsSync(join(flow.dir, ".doug/plan.json"))).toBe(false);
      const flowBoard = JSON.parse(readFileSync(join(flow.dir, ".doug/board.json"), "utf8"));
      expect(flowBoard.cards.find((c) => c.id === "fix-hours").track).toBeUndefined();
    },
  );

  it("refuses an unknown scenario", () => {
    expect(() => prepareFixture({ scenario: "bogus" })).toThrow(/unknown scenario/);
  });
});

describe("a prepared fixture's Models table is the one doug init generates, unedited (card rehearse-worker-row-noop)", () => {
  // The generator lives in packages/doug-cli (TypeScript); importing its build output is the practical form —
  // the CLI itself is only usable here once built (see the `it.skipIf(!existsSync(CLI))` tests above), so a
  // fixture-building test already requires `pnpm build` to have run, and this reads the same build's output
  // rather than a copy of the table's literals.
  const generatorPath = join(ROOT, "packages/doug-cli/dist/generate/claude-md.js");
  it.skipIf(!existsSync(CLI) || !existsSync(generatorPath))(
    "hand, flow, and swarm fixtures' CLAUDE.md contains every row of doug init's generated Models table unchanged, including exactly one worker row (sonnet/medium) and the plan row (opus/high)",
    async () => {
      const { MODELS_SECTION } = await import(pathToFileURL(generatorPath).href);
      const generatedRows = MODELS_SECTION.filter((l) => l.startsWith("| ") && !l.startsWith("| Work"));
      expect(generatedRows).toContain("| worker    | sonnet  | medium  |");
      expect(generatedRows).toContain("| plan      | opus    | high    |");
      expect(generatedRows.length).toBeGreaterThan(0);

      for (const scenario of ["hand", "flow", "swarm"]) {
        const { dir } = prepareFixture({ scenario, tempPrefix: TEST_PREFIX });
        tempDirs.push(dir);
        const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
        for (const row of generatedRows) expect(claudeMd).toContain(row);
        expect(claudeMd.split("\n").filter((l) => /^\|\s*worker\s*\|/.test(l)).length).toBe(1);
      }
    },
  );
});

describe("rehearse.mjs source no longer defines withWorkerRow (card rehearse-worker-row-noop)", () => {
  it("source pin: the file contains no withWorkerRow (the fixture-time helper this card removes)", () => {
    const source = readFileSync(join(here, "..", "lib", "rehearse.mjs"), "utf8");
    expect(source).not.toContain("withWorkerRow");
  });
});

describe("one dry pass of the hand scenario's gate stage", () => {
  it.skipIf(!existsSync(CLI))("a fake claude naming doug-flow and doug-flow:core-next passes the gate stage's assertions; one lacking doug-flow fails naming it, and does nothing to the fixture", () => {
    const { dir, card } = prepareFixture({ scenario: "hand", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    const gate = SCENARIO_STAGES.hand[0];
    expect(gate.name).toBe("gate");

    const goodBin = makeFakeClaude(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:core-next"] }));
    const good = runSessionStage(gate, { dir, card, claudeBin: goodBin });
    expect(good.ok, good.message).toBe(true);
    expect(existsSync(good.streamPath)).toBe(true);

    const badBin = makeFakeClaude(cannedStream({ plugins: ["some-other-plugin"], commands: ["doug-flow:core-next"] }));
    const bad = runSessionStage(gate, { dir, card, claudeBin: badBin });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("doug-flow");

    // The fake did nothing: the fixture is exactly as prepareFixture left it.
    const log = git(dir, "log", "--oneline").split("\n").filter(Boolean);
    expect(log.length).toBe(1);
    const board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
    expect(board.cards.find((c) => c.id === "fix-hours").column).toBe("ready");
  });
});

// A fake `claude` for the flow gate stage that actually does the work a correct /doug-next run does before its
// approval gate (item rehearsal-first-live-findings #1): move the card (uncommitted, task rehearse-uncommitted-move)
// and write a plan.json, so the dry pass below exercises assertFlowGateHeld against a real fixture rather than a
// stream shape alone. `moveCard: false` leaves the card Ready (a run that never reached the move); `commitMove:
// true` commits the move instead of leaving it uncommitted (a run that landed the move itself, which the flow gate
// must now reject); `planStatus: "approved"` writes an already-approved plan (a run that skipped the human gate) —
// all three must fail the stage.
function makeFlowGateFake({ moveCard = true, commitMove = false, planStatus = "draft" } = {}) {
  const dir = trackedTempDir("fake-claude-flowgate-");
  const bin = join(dir, "claude");
  const plan = JSON.stringify(draftPlan({ status: planStatus }), null, 2) + "\n";
  const script = [
    "#!/usr/bin/env node",
    "const { execFileSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    moveCard ? `execFileSync(process.execPath, [${JSON.stringify(BOARD_MJS)}, "move", "fix-hours", "flow"]);` : "",
    moveCard && commitMove ? "execFileSync('git', ['add', '-A']);" : "",
    moveCard && commitMove ? `execFileSync('git', ['commit', '-q', '-m', 'Board: fix-hours moved to In flow']);` : "",
    `fs.writeFileSync('.doug/plan.json', ${JSON.stringify(plan)});`,
    `process.stdout.write(${JSON.stringify(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }))});`,
    "process.exit(0);",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

describe("one dry pass of the flow scenario's gate stage (item rehearsal-first-live-findings #1)", () => {
  it.skipIf(!existsSync(CLI))(
    "a fake claude that moves the card (uncommitted) and writes a draft plan passes; one that leaves the card Ready fails, one that commits the move fails, and one that approves the plan fails too",
    () => {
      const gate = SCENARIO_STAGES.flow[0];
      expect(gate.name).toBe("gate");

      const okDir = prepareFixture({ scenario: "flow", tempPrefix: TEST_PREFIX }).dir;
      tempDirs.push(okDir);
      const ok = runSessionStage(gate, { dir: okDir, card: { id: "fix-hours" }, claudeBin: makeFlowGateFake() });
      expect(ok.ok, ok.message).toBe(true);

      const readyDir = prepareFixture({ scenario: "flow", tempPrefix: TEST_PREFIX }).dir;
      tempDirs.push(readyDir);
      const stillReady = runSessionStage(gate, { dir: readyDir, card: { id: "fix-hours" }, claudeBin: makeFlowGateFake({ moveCard: false }) });
      expect(stillReady.ok).toBe(false);
      expect(stillReady.message).toContain("does not have fix-hours in flow");

      const committedDir = prepareFixture({ scenario: "flow", tempPrefix: TEST_PREFIX }).dir;
      tempDirs.push(committedDir);
      const committed = runSessionStage(gate, { dir: committedDir, card: { id: "fix-hours" }, claudeBin: makeFlowGateFake({ commitMove: true }) });
      expect(committed.ok).toBe(false);
      expect(committed.message).toContain("leaves the move uncommitted");

      const approvedDir = prepareFixture({ scenario: "flow", tempPrefix: TEST_PREFIX }).dir;
      tempDirs.push(approvedDir);
      const approved = runSessionStage(gate, { dir: approvedDir, card: { id: "fix-hours" }, claudeBin: makeFlowGateFake({ planStatus: "approved" }) });
      expect(approved.ok).toBe(false);
      expect(approved.message).toContain("already approved");
    },
  );
});

// The bug parseDuration ships with (hours computed as minutes) and its one-line fix, plus a test for it, used
// below to simulate what /core-next's coder does (both owned files, one commit) so the held-out test can pass.
function fixDurationBug(dir) {
  const srcPath = join(dir, "src/duration.ts");
  writeFileSync(srcPath, readFileSync(srcPath, "utf8").replace('return n * 60_000; // bug: should be 3_600_000', "return n * 3_600_000;"));
  const testPath = join(dir, "tests/duration.test.ts");
  writeFileSync(testPath, readFileSync(testPath, "utf8").replace('  it("rejects garbage"', '  it("parses hours", () => {\n    expect(parseDuration("2h")).toBe(7_200_000);\n  });\n  it("rejects garbage"'));
}

// A fake `claude` that carries the whole hand scenario through the real CLI (scripts/rehearse.mjs) to a "passed"
// outcome: the gate-stage prompt is a no-op (the existing hand gate dry pass above already proves that shape
// passes), and the build-stage prompt (told apart by "I answered Start", the sentence the runner's build prompt
// always carries) fixes the parseDuration bug and lands the fixture's own hand-track record and board move,
// mirroring fixDurationBug and the board.mjs calls assertHandBuilt's own test above makes by hand.
function makeHandScenarioFake() {
  const dir = trackedTempDir("fake-claude-handscenario-");
  const bin = join(dir, "claude");
  const script = [
    "#!/usr/bin/env node",
    "const { execFileSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';",
    "if (prompt.includes('I answered Start')) {",
    `  fs.writeFileSync('src/duration.ts', fs.readFileSync('src/duration.ts', 'utf8').replace(${JSON.stringify("return n * 60_000; // bug: should be 3_600_000")}, ${JSON.stringify("return n * 3_600_000;")}));`,
    `  fs.writeFileSync('tests/duration.test.ts', fs.readFileSync('tests/duration.test.ts', 'utf8').replace(${JSON.stringify('  it("rejects garbage"')}, ${JSON.stringify('  it("parses hours", () => {\n    expect(parseDuration("2h")).toBe(7_200_000);\n  });\n  it("rejects garbage"')}));`,
    "  execFileSync('git', ['add', '-A']);",
    "  execFileSync('git', ['commit', '-q', '-m', 'fix: hours multiplier']);",
    "  const codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
    `  execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(BOARD_MJS)}, 'record', 'fix-hours', '--hand', '--commit', codeCommit, '--gate', 'typecheck 0; unit 1 passed']);`,
    `  execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(BOARD_MJS)}, 'move', 'fix-hours', 'done', '--source', 'commit ' + codeCommit]);`,
    "  execFileSync('git', ['add', '-A']);",
    "  execFileSync('git', ['commit', '-q', '-m', 'Board: fix-hours done as ' + codeCommit.slice(0, 7)]);",
    "}",
    `process.stdout.write(${JSON.stringify(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:core-next"] }))});`,
    "process.exit(0);",
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

describe("scripts/rehearse.mjs: an evidence-archive failure does not abort the run (reviewer follow-up on item #2)", () => {
  it.skipIf(!existsSync(CLI))(
    "an unwritable .doug/.state in the target repository: the CLI still records the outcome and keeps the fixture instead of removing it",
    () => {
      // The target repository the outcome records under (never the internal ts-basic fixture prepareFixture makes).
      const targetDir = trackedTempDir("rehearse-archivefail-target-");
      let board = { ...newBoard(), components: ["flow"] };
      board = addCard(board, { id: "fix-hours", title: "Fix hours", goal: "g", component: "flow", size: "S", track: "hand", column: "ready" });
      saveBoard(targetDir, board);
      // Pre-create .doug/.state read-only so archiveEvidence's mkdirSync of the "rehearsal/<scenario>-<ts>" dest
      // beneath it throws EACCES, standing in for the unwritable-.doug/.state case the coordinator named.
      mkdirSync(join(targetDir, ".doug/.state"), { recursive: true });
      chmodSync(join(targetDir, ".doug/.state"), 0o555);

      const r = spawnSync(process.execPath, [cli, "hand", "--spend", "--card", "fix-hours", targetDir], {
        encoding: "utf8",
        env: { ...process.env, DOUG_REHEARSE_CLAUDE: makeHandScenarioFake() },
      });
      chmodSync(join(targetDir, ".doug/.state"), 0o755); // restore before any assertion can throw and skip cleanup

      expect(r.status, r.stderr || r.stdout).toBe(0);
      expect(r.stdout).toContain("hand: passed");
      expect(r.stdout).toContain("evidence not archived:");
      expect(r.stdout).toContain("fixture:");
      expect(r.stdout).toContain("(kept for inspection)");
      expect(r.stdout).not.toContain("recording failed");

      // The outcome still landed in the target repository.
      const text = readFileSync(join(targetDir, "docs/live-runs.md"), "utf8");
      expect(text).toContain("Rehearsal hand for card `fix-hours` on the ts-basic fixture");

      // The internal ts-basic fixture (named on the "fixture:" line) still exists on disk: it was kept, not removed.
      const fixtureMatch = r.stdout.match(/fixture: (\S+) \(kept for inspection\)/);
      expect(fixtureMatch).not.toBeNull();
      tempDirs.push(fixtureMatch[1]); // let afterAll clean it up; the script left it behind on purpose
      expect(existsSync(fixtureMatch[1])).toBe(true);
    },
  );
});

describe("assertHandBuilt against /core-next's real commit order (review #1, blocker)", () => {
  it.skipIf(!existsSync(CLI))(
    "passes when the code commit precedes the board's own 'done' commit (as /core-next step 4.3 leaves it), and fails when the board's source names a different sha",
    () => {
      const { dir, baseline } = prepareFixture({ scenario: "hand", tempPrefix: TEST_PREFIX });
      tempDirs.push(dir);

      fixDurationBug(dir);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fix: hours multiplier");
      const codeCommit = git(dir, "rev-parse", "HEAD");
      expect(codeCommit).not.toBe(baseline);

      // Exactly /core-next step 4: record the hand landing (writes docs/live-runs.md), move the card to done
      // with the code commit as its source, then commit both as one "board" commit — AFTER the code commit.
      const record = spawnScript(BOARD_MJS, ["record", "fix-hours", "--hand", "--commit", codeCommit, "--gate", "typecheck 0; unit 3 passed", dir]);
      expect(record.status, record.stderr).toBe(0);
      const move = spawnScript(BOARD_MJS, ["move", "fix-hours", "done", "--source", `commit ${codeCommit}`, dir]);
      expect(move.status, move.stderr).toBe(0);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", `Board: fix-hours done as ${codeCommit.slice(0, 7)}`);
      const boardCommit = git(dir, "rev-parse", "HEAD");
      expect(boardCommit).not.toBe(codeCommit); // HEAD is the board commit, not the code commit (the bug this fixes)

      const result = assertHandBuilt({ dir, baseline });
      expect(result.ok, result.message).toBe(true);
      expect(result.commit).toBe(codeCommit);
      // The held-out test file was removed again, and the tree is clean.
      expect(existsSync(join(dir, "tests/heldout-fix-hours.test.ts"))).toBe(false);
      expect(git(dir, "status", "--porcelain")).toBe("");
    },
  );

  it.skipIf(!existsSync(CLI))("fails when the board's source names a commit that never touched both owned files", () => {
    const { dir, baseline } = prepareFixture({ scenario: "hand", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);

    fixDurationBug(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fix: hours multiplier");
    const codeCommit = git(dir, "rev-parse", "HEAD");

    const bogus = "0".repeat(40);
    const move = spawnScript(BOARD_MJS, ["move", "fix-hours", "done", "--source", `commit ${bogus}`, dir]);
    expect(move.status, move.stderr).toBe(0);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Board: fix-hours done as 0000000");

    const result = assertHandBuilt({ dir, baseline });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not name the code commit");
    expect(result.message).toContain(codeCommit);
  });
});

describe("extractGateLine", () => {
  it("reads the fixture's own last hand-track Gate line, and null when there is none", () => {
    const dir = trackedTempDir("rehearse-gate-");
    expect(extractGateLine(dir)).toBeNull();
    const runsDir = join(dir, "docs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "live-runs.md"), "| Gate | not recorded |\n");
    expect(extractGateLine(dir)).toBeNull();
    writeFileSync(join(runsDir, "live-runs.md"), "| Gate | typecheck 0; unit 12 passed |\n");
    expect(extractGateLine(dir)).toBe("typecheck 0; unit 12 passed");
  });
});

describe("recording always goes through the board.mjs CLI (review #3)", () => {
  function tempRepoWithCard(id = "fix-hours") {
    const dir = trackedTempDir("rehearse-record-");
    let board = { ...newBoard(), components: ["flow"] };
    board = addCard(board, { id, title: "Fix hours", goal: "fix it", component: "flow", size: "S", track: "hand", column: "ready" });
    saveBoard(dir, board);
    return dir;
  }

  it("pins the scrub: a leaked CLAUDE_PROJECT_DIR pointing at a board without the card does not redirect the record (deleting cleanEnv() from runBoardCli fails this test)", () => {
    const target = tempRepoWithCard();
    const decoy = trackedTempDir("rehearse-decoy-");
    saveBoard(decoy, { ...newBoard(), components: ["flow"] }); // a board with no "fix-hours" card
    const original = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = decoy;
    try {
      recordHandOutcome(target, "fix-hours", { commit: null, wallClock: "1 min", gate: "not observed", note: "Rehearsal hand on the ts-basic fixture: passed; stages gate (1 min)" });
    } finally {
      if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = original;
    }
    expect(existsSync(join(target, "docs/live-runs.md"))).toBe(true);
    expect(existsSync(join(decoy, "docs/live-runs.md"))).toBe(false);
  });

  it("recordHandOutcome spawns board.mjs record --hand: the entry lands in a TEMP repository's docs/live-runs.md (never the real checkout), and the note begins with 'Rehearsal hand'", () => {
    const tempRepo = tempRepoWithCard();
    const note = rehearsalNote({ scenario: "hand", outcome: "passed", stages: [{ name: "gate", wallClock: "1 min" }], cost: 0.01 });
    expect(note.startsWith("Rehearsal hand")).toBe(true);
    recordHandOutcome(tempRepo, "fix-hours", { commit: null, wallClock: "1 min", gate: "not observed", note });
    const text = readFileSync(join(tempRepo, "docs/live-runs.md"), "utf8");
    expect(text).toContain("`fix-hours`");
    const noteLine = text.split("\n").find((l) => l.startsWith("Rehearsal"));
    expect(noteLine.startsWith("Rehearsal hand")).toBe(true);
  });

  it("recordRunOutcome spawns board.mjs record <id> <report>: the entry lands in docs/live-runs.md with the note and the measures", () => {
    const tempRepo = tempRepoWithCard();
    const reportFile = join(tempRepo, "report.json");
    writeFileSync(reportFile, JSON.stringify({ ok: true, plan: "Fix hours", integrationBranch: "doug/fix-hours", levels: [{ index: 0, tasks: [{ id: "fix-hours", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false } }], integration: { ok: true } }] }));
    const note = rehearsalNote({ scenario: "flow", outcome: "passed", stages: [{ name: "gate", wallClock: "1 min" }, { name: "implement", wallClock: "5 min" }] });
    recordRunOutcome(tempRepo, "fix-hours", { reportFile, wallClock: "6 min", cost: 3.2, mergeCommit: "abc1234", note });
    const text = readFileSync(join(tempRepo, "docs/live-runs.md"), "utf8");
    expect(text).toContain("| Cost | $3.20 |");
    expect(text).toContain("| Landed as | `abc1234` |");
    expect(text.split("\n").find((l) => l.startsWith("Rehearsal")).startsWith("Rehearsal flow")).toBe(true);
  });

  it("throws (never swallows) when board.mjs record fails, e.g. an unknown card", () => {
    const tempRepo = tempRepoWithCard();
    expect(() => recordHandOutcome(tempRepo, "no-such-card", { note: "x" })).toThrow();
  });

  it("passes --rehearsal <scenario> through: the entry reads as a rehearsal, not a landing of the card (item rehearsal-first-live-findings #3)", () => {
    const tempRepo = tempRepoWithCard();
    recordHandOutcome(tempRepo, "fix-hours", { commit: "47fe70cca7eb3444ae8a382ee14018f3950bfe1c", wallClock: "3 min", gate: "unit 5 passed", rehearsal: "hand" });
    const handText = readFileSync(join(tempRepo, "docs/live-runs.md"), "utf8");
    expect(handText).toContain("Rehearsal hand for card `fix-hours` on the ts-basic fixture");
    expect(handText).not.toContain("Built by hand through /core-next");
    expect(handText).toContain("| Commit | `47fe70c` |");

    const tempRepo2 = tempRepoWithCard();
    const reportFile = join(tempRepo2, "report.json");
    writeFileSync(reportFile, JSON.stringify({ ok: false, stoppedAtLevel: 0, plan: "P", integrationBranch: "none", levels: [] }));
    recordRunOutcome(tempRepo2, "fix-hours", { reportFile, wallClock: "1 min", mergeCommit: "47fe70cca7eb3444ae8a382ee14018f3950bfe1c", rehearsal: "flow" });
    const runText = readFileSync(join(tempRepo2, "docs/live-runs.md"), "utf8");
    expect(runText).toContain("Rehearsal flow for card `fix-hours` on the ts-basic fixture");
    expect(runText).not.toContain("Ran through /doug-next");
    expect(runText).toContain("| Landed as | `47fe70c` |");
  });
});

describe("board.mjs record --note (review #3, the CLI-level path board.test.mjs's unit test does not cover)", () => {
  it("board.mjs record <id> <report> --note renders the note through the real CLI", () => {
    const dir = trackedTempDir("rehearse-board-note-cli-");
    let board = { ...newBoard(), components: ["flow"] };
    board = addCard(board, { id: "c1", title: "C1", goal: "g", component: "flow", size: "S", column: "ready" });
    saveBoard(dir, board);
    const reportFile = join(dir, "report.json");
    writeFileSync(reportFile, JSON.stringify({ ok: true, plan: "P", integrationBranch: "doug/x", levels: [{ index: 0, tasks: [{ id: "c1", implemented: true, verified: true, reviewed: true, adversary: null }], integration: { ok: true } }] }));
    const r = spawnScript(BOARD_MJS, ["record", "c1", reportFile, dir, "--note", "a note from the CLI"]);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(text).toContain("a note from the CLI");
  });
});

describe("readReport", () => {
  it("returns ok:false with a reason when the report is missing or unreadable", () => {
    const dir = trackedTempDir("rehearse-readreport-");
    expect(readReport(dir).ok).toBe(false);
    expect(readReport(dir).reason).toContain("no report");
  });

  // Card report-save-wrapper, M5: a report saved as the Workflow tool's own output shape ({ summary, agentCount,
  // logs, result: <report> }) must resolve the same as one saved bare (readReport imports unwrapReport from
  // lib/plan.mjs and applies it to what it parsed).
  it("M5: returns ok:true for a report saved wrapped in the Workflow tool's output shape", () => {
    const dir = trackedTempDir("rehearse-readreport-wrapped-");
    mkdirSync(join(dir, dirname(RESULTS_FILE)), { recursive: true });
    writeFileSync(join(dir, RESULTS_FILE), JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: { ok: true, levels: [] } }));
    expect(readReport(dir)).toEqual({ ok: true, reason: null, report: { ok: true, levels: [] } });
  });
});

describe("harness-fix names this test file, which exists (card workflow-rehearsal)", () => {
  it("the skill's table and rule 8 both reference rehearse.mjs and rehearse.test.mjs", () => {
    const root = join(here, "..");
    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    expect(fix).toContain("plugins/doug-flow/tests/rehearse.test.mjs");
    expect(fix).toContain("rehearse.mjs <flow|swarm|hand> --card <id> --spend");
    expect(existsSync(join(root, "tests/rehearse.test.mjs"))).toBe(true);
  });
});

// ---- card rehearsals-refresh-and-rerun: T1-T5 (brief .doug/.state/briefs/rehearsals-refresh-and-rerun.md) ------

describe("T1 (R1): requireWorkers reads a task's swarm record before falling back to the old message", () => {
  function reportDir(report) {
    const dir = trackedTempDir("rehearse-swarmreport-");
    mkdirSync(join(dir, dirname(RESULTS_FILE)), { recursive: true });
    writeFileSync(join(dir, RESULTS_FILE), JSON.stringify(report));
    return dir;
  }
  const okTask = { id: "fix-hours-factor", verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" } };

  it("a task with swarm.applies:false and no workers fails naming the task, the reason, and rehearsal-swarm-splittable; a report with workers still passes; a report with neither keeps the old message", () => {
    const gated = assertImplemented(
      reportDir({ ok: true, levels: [{ tasks: [{ ...okTask, swarm: { applies: false, reason: "one source file and its tests" } }] }] }),
      cannedStream(),
      { plugins: ["doug-flow"], requireWorkers: true },
    );
    expect(gated.ok).toBe(false);
    expect(gated.message).toContain("fix-hours-factor");
    expect(gated.message).toContain("one source file and its tests");
    expect(gated.message).toContain("rehearsal-swarm-splittable");

    const withWorkers = assertImplemented(
      reportDir({ ok: true, levels: [{ tasks: [{ ...okTask, workers: [{ id: "brief-a" }], swarm: { applies: false, reason: "one source file and its tests" } }] }] }),
      cannedStream(),
      { plugins: ["doug-flow"], requireWorkers: true },
    );
    expect(withWorkers.ok, withWorkers.message).toBe(true);

    const neither = assertImplemented(reportDir({ ok: true, levels: [{ tasks: [okTask] }] }), cannedStream(), { plugins: ["doug-flow"], requireWorkers: true });
    expect(neither.ok).toBe(false);
    expect(neither.message).toBe("no task in the report carried workers: the swarm did not run");
  });

  it("round 2: a later task carries the gated swarm record, not the first — the message must name that later task (narrowing the scan to tasks[0] must fail this)", () => {
    const firstTask = { id: "fix-hours-factor", verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" } }; // no swarm record at all
    const laterTask = { id: "fix-hours-message", verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" }, swarm: { applies: false, reason: "one source file and its tests" } };
    const result = assertImplemented(reportDir({ ok: true, levels: [{ tasks: [firstTask, laterTask] }] }), cannedStream(), { plugins: ["doug-flow"], requireWorkers: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fix-hours-message");
    expect(result.message).not.toContain("fix-hours-factor");
    expect(result.message).toContain("one source file and its tests");
    expect(result.message).toContain("rehearsal-swarm-splittable");
  });
});

describe("T2 (R2): the prepared fixture's card carries a class (hand, flow, and swarm fixtures)", () => {
  it.skipIf(!existsSync(CLI))("prepareFixture gives fix-hours class \"code\" on every scenario", () => {
    for (const scenario of SCENARIOS) {
      const { dir } = prepareFixture({ scenario, tempPrefix: TEST_PREFIX });
      tempDirs.push(dir);
      const board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
      const card = board.cards.find((c) => c.id === "fix-hours");
      expect(card.class, `${scenario} fixture card`).toBe("code");
    }
  });
});

describe("T3 (R2): the hand start-gate act stamps the fixture's condition, never this repository's", () => {
  it.skipIf(!existsSync(CLI))(
    "leaves .doug/.state/reports/fix-hours/condition.json in the fixture and returns ok; a leaked CLAUDE_PROJECT_DIR must not redirect the write (deleting cleanEnv() from act() fails this: idiom at rehearse.test.mjs:806-816)",
    () => {
      const { dir } = prepareFixture({ scenario: "hand", tempPrefix: TEST_PREFIX });
      tempDirs.push(dir);
      const startGate = SCENARIO_STAGES.hand[1];
      expect(startGate.name).toBe("start-gate");
      const realConditionPath = join(ROOT, ".doug/.state/reports/fix-hours/condition.json");
      expect(existsSync(realConditionPath)).toBe(false); // sanity: fix-hours is only ever a fixture card, never a real one

      // A leaked CLAUDE_PROJECT_DIR (as a real Claude Code session running the rehearsal skill would carry) points
      // at a decoy, never this repository: dirFrom (scripts/memory.mjs, scripts/board.mjs) prefers it over the
      // positional dir act() passes, so only act()'s own cleanEnv() scrub keeps the fixture the actual target.
      const decoy = trackedTempDir("rehearse-startgate-decoy-");
      const original = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = decoy;
      let result;
      try {
        result = runActStage(startGate, { dir, card: { id: "fix-hours" } });
      } finally {
        if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = original;
      }

      expect(result.ok, result.message).toBe(true);
      expect(existsSync(join(dir, ".doug/.state/reports/fix-hours/condition.json"))).toBe(true);
      expect(existsSync(join(decoy, ".doug/.state/reports/fix-hours/condition.json"))).toBe(false);
      expect(existsSync(realConditionPath)).toBe(false);
    },
  );
});

describe("T3 fails closed (R2): a condition-open failure must stop the start-gate act, not be swallowed", () => {
  it.skipIf(!existsSync(CLI))(
    "a fixture whose card class was removed before the act runs: result not ok, message carries memory.mjs's stderr, and no condition.json is written",
    () => {
      const { dir } = prepareFixture({ scenario: "hand", tempPrefix: TEST_PREFIX });
      tempDirs.push(dir);
      const boardFile = join(dir, ".doug/board.json");
      const board = JSON.parse(readFileSync(boardFile, "utf8"));
      delete board.cards.find((c) => c.id === "fix-hours").class;
      writeFileSync(boardFile, JSON.stringify(board, null, 2) + "\n");

      const startGate = SCENARIO_STAGES.hand[1];
      const result = runActStage(startGate, { dir, card: { id: "fix-hours" } });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("condition open failed");
      expect(result.message).toContain("no class");
      expect(existsSync(join(dir, ".doug/.state/reports/fix-hours/condition.json"))).toBe(false);
    },
  );
});

describe("T4 (R3): the hand build prompt stops before step 5 (follow-up cards), not step 6", () => {
  it("SCENARIO_STAGES.hand's build prompt contains 'stop before step 5' and keeps 'I answered Start' and the doug-board sentence, and no longer says 'stop at step 6'", () => {
    const build = SCENARIO_STAGES.hand[2];
    expect(build.name).toBe("build");
    const prompt = build.prompt({ card: { id: "fix-hours" } });
    expect(prompt).toContain("stop before step 5");
    expect(prompt).toContain("I answered Start");
    expect(prompt).toContain("Do not invoke the doug-board skill at any step: this checkout publishes nothing.");
    expect(prompt).not.toContain("stop at step 6");
  });
});

describe("T5 (R4): ESTIMATES sources cite a measured rehearsal from docs/live-runs.md", () => {
  it("every ESTIMATES[*].source names a 2026-09- date and a $ figure; the hand source no longer says no hand landing records a cost", () => {
    for (const s of SCENARIOS) {
      const source = ESTIMATES[s].source;
      expect(source, `${s} source`).toMatch(/2026-09-\d{2}/);
      expect(source, `${s} source`).toMatch(/\$\d/);
    }
    expect(ESTIMATES.hand.source).not.toContain("no hand landing records a cost");
  });
});

// Card report-save-wrapper, MP: the flow and swarm "implement" stage prompts must say the saved file is the
// `result` object of the Workflow tool's output, not just "the report it returned".
describe("card report-save-wrapper: the implement-stage prompts name the result object", () => {
  it("SCENARIO_STAGES.flow's implement prompt says to write the `result` object of the Workflow tool's output", () => {
    const implement = SCENARIO_STAGES.flow.find((s) => s.name === "implement");
    expect(implement.prompt()).toContain("the `result` object of the Workflow");
  });

  it("SCENARIO_STAGES.swarm's implement prompt says to write the `result` object of the Workflow tool's output", () => {
    const implement = SCENARIO_STAGES.swarm.find((s) => s.name === "implement");
    expect(implement.prompt()).toContain("the `result` object of the Workflow");
  });
});
