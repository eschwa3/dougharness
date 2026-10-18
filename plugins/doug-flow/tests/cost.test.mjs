import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICES, PRICES_DATED, normalizeModel, parseLabel, priceUsage, transcriptUsage, findRunDir, costRun, runWall, wallForRun, PASS_WALL_SHARE, STAGE_WALL_SHARE, renderCost, codexUsageFromReport, priceCodexUsage, CODEX_PRICES, CODEX_PRICES_DATED, CODEX_DEFAULT_MODEL } from "../lib/cost.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "cost.mjs");
// Trimmed copies of the two 2026-09-06 standard-agents runs: every assistant line reduced to its message id, model,
// and usage; the journal to agent ids and task ids; the run file to its agent labels. The numbers are the real ones.
const fixture = join(here, "fixtures", "claude");
const project = "/Users/dev/projects/dougharness";

const run = (args, cwd = here) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

describe("pricing", () => {
  it("normalizes dated and [1m] model ids to the price table's keys", () => {
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(normalizeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModel(undefined)).toBe("");
    for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"]) expect(PRICES[id]).toBeDefined();
    expect(PRICES_DATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("prices input, output, cache reads, and 5-minute and 1-hour cache writes per million tokens", () => {
    const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    expect(priceUsage(usage, "claude-opus-5")).toBe(5);
    expect(priceUsage({ ...usage, input: 0, output: 1_000_000 }, "claude-opus-5")).toBe(25);
    expect(priceUsage({ ...usage, input: 0, cacheRead: 1_000_000 }, "claude-opus-5")).toBe(0.5);
    // 1,000,000 written: 400,000 on the 1-hour TTL at 2x, the rest on the 5-minute TTL at 1.25x.
    expect(priceUsage({ ...usage, input: 0, cacheWrite: 1_000_000, cacheWrite1h: 400_000 }, "claude-sonnet-5")).toBeCloseTo(0.6 * 2.5 + 0.4 * 4, 10);
    expect(priceUsage(usage, "claude-haiku-4-5-20251001")).toBe(1);
    expect(priceUsage(usage, "claude-future-9")).toBeNull();
  });
  it("parses the workflow's stage:task[:pass] labels", () => {
    expect(parseLabel("implement:agents-generator")).toEqual({ stage: "implement", task: "agents-generator", pass: null });
    expect(parseLabel("fix:agents-generator:2")).toEqual({ stage: "fix", task: "agents-generator", pass: 2 });
    expect(parseLabel("integrate:level-0")).toEqual({ stage: "integrate", task: "level-0", pass: null });
    expect(parseLabel("")).toEqual({ stage: null, task: null, pass: null });
    // A swarm's workers: the trailing number is the worker, and the agent groups under its task.
    expect(parseLabel("worker:agents-generator:2")).toEqual({ stage: "worker", task: "agents-generator", pass: null, worker: 2 });
    expect(parseLabel("lead-merge:agents-generator")).toEqual({ stage: "lead-merge", task: "agents-generator", pass: null });
  });
});

// Card cost-opus-5-5-price: board-native (f086968) found claude-opus-5-5 unpriced in every verify/review/check
// agent across six runs; the price table needs the model's list price (research: platform.claude.com pricing,
// fetched 2026-09-23, input 4 output 20 cacheRead 0.2 cacheWrite5m 5 cacheWrite1h 8 per million tokens).
describe("card cost-opus-5-5-price", () => {
  it("C1: priceUsage prices claude-opus-5-5 at $4/$20/$0.2/$5/$8 per million tokens (input, output, cache read, 5m write, 1h write)", () => {
    const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    expect(priceUsage(usage, "claude-opus-5-5")).toBe(4);
    expect(priceUsage({ ...usage, input: 0, output: 1_000_000 }, "claude-opus-5-5")).toBe(20);
    expect(priceUsage({ ...usage, input: 0, cacheRead: 1_000_000 }, "claude-opus-5-5")).toBe(0.2);
    expect(priceUsage({ ...usage, input: 0, cacheWrite: 1_000_000, cacheWrite1h: 0 }, "claude-opus-5-5")).toBe(5);
    expect(priceUsage({ ...usage, input: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }, "claude-opus-5-5")).toBe(8);
  });

  it("C2: a claude-opus-5-5 transcript is priced end to end, with no \"not in the price table\" note and a non-null usd", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-claude-"));
    const dir = join(claudeDir, "projects", "-tmp-proj", "sess-1", "subagents", "workflows", "wf_opus55-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), [
      JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
      JSON.stringify({ type: "result", key: "k1", agentId: "a1", result: { taskId: "t1" } }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "doug-flow:verifier" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5[1m]", usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n");
    const r = costRun({ runId: "wf_opus55-001", claudeDir, projectDir: "/tmp/proj" });
    expect(r.notes.some((n) => /not in the price table/.test(n)), `notes: ${JSON.stringify(r.notes)}`).toBe(false);
    expect(r.agents[0].model).toBe("claude-opus-5-5[1m]");
    expect(r.agents[0].usd).not.toBeNull();
    expect(r.agents[0].usd).toBeCloseTo((1000 * 4 + 2000 * 20) / 1e6, 10);
  });
});

describe("transcriptUsage", () => {
  it("counts each API message once, taking the largest value per field across its content-block lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-cost-"));
    const file = join(dir, "agent-a1.jsonl");
    const line = (id, output, extra = {}) => JSON.stringify({ type: "assistant", message: { id, model: "claude-haiku-4-5-20251001", usage: { input_tokens: 8, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, ...extra } } });
    writeFileSync(file, [
      line("msg_1", 3), line("msg_1", 3), line("msg_1", 887),
      line("msg_2", 10, { cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "x" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_3", model: "claude-haiku-4-5-20251001" } }),
      "not json",
    ].join("\n") + "\n");
    const t = transcriptUsage(file);
    expect(t.messages).toBe(2);
    expect(t.model).toBe("claude-haiku-4-5-20251001");
    expect(t.usage).toEqual({ input: 16, output: 897, cacheRead: 200, cacheWrite: 100, cacheWrite1h: 30 });
  });
});

describe("costRun on the two standard-agents runs", () => {
  it("wf_7092b963-6a5: 8 agents, per task, per stage, and the run total", () => {
    const r = costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project });
    expect(r.session).toBe("d6f89e32-16df-45f2-b3d0-9415009bc856");
    expect(r.project).toBe("-Users-dev-projects-dougharness");
    expect(r.agents.length).toBe(8);
    expect(r.agents[0]).toMatchObject({ label: "reuse:agents-generator", stage: "reuse", task: "agents-generator", pass: null, model: "claude-haiku-4-5-20251001", messages: 5, transcript: true });
    expect(r.agents[4]).toMatchObject({ label: "fix:agents-generator:2", stage: "fix", pass: 2, model: "claude-sonnet-5" });
    expect(r.total.usage).toEqual({ input: 180, output: 26359, cacheRead: 1219887, cacheWrite: 243183, cacheWrite1h: 0 });
    expect(r.total.usd).toBeCloseTo(1.845665, 5);
    expect(r.total.unpriced).toBe(0);
    expect(r.tasks).toEqual([expect.objectContaining({ name: "agents-generator", agents: 8 })]);
    expect(r.stages.map((s) => [s.name, s.agents])).toEqual([["reuse", 1], ["verify", 1], ["review", 1], ["adversary", 2], ["fix", 2], ["check", 1]]);
    expect(r.stages.find((s) => s.name === "check").usd).toBeCloseTo(0.549177, 5);
    expect(r.notes).toEqual(["2 adversary agents relayed codex-review; Codex's own tokens are not in local transcripts and are not priced"]);
    expect(r.startedAt).toBe("2026-09-06T13:40:31.678Z");
    expect(r.durationMs).toBe(1070891);
  });
  it("wf_f70da515-2af: 11 agents and $3.60", () => {
    const r = costRun({ runId: "wf_f70da515-2af", claudeDir: fixture, projectDir: project });
    expect(r.agents.length).toBe(11);
    expect(r.total.usage).toEqual({ input: 292, output: 53589, cacheRead: 3271334, cacheWrite: 370533, cacheWrite1h: 0 });
    expect(r.total.usd).toBeCloseTo(3.602705, 5);
    expect(r.stages.map((s) => s.name)).toEqual(["implement", "verify", "review", "adversary", "fix", "check"]);
    expect(r.stages.find((s) => s.name === "verify")).toMatchObject({ agents: 2 });
    expect(r.stages.find((s) => s.name === "verify").usd).toBeCloseTo(1.164913, 5);
  });
  it("finds the run under another project's slug when the current project has none", () => {
    expect(findRunDir({ runId: "wf_f70da515-2af", claudeDir: fixture, projectDir: "/somewhere/else" })).toMatchObject({ session: "d6f89e32-16df-45f2-b3d0-9415009bc856" });
    expect(findRunDir({ runId: "wf_nope", claudeDir: fixture, projectDir: project })).toBeNull();
    expect(() => costRun({ runId: "wf_nope", claudeDir: fixture, projectDir: project })).toThrow("no journal for run wf_nope");
    expect(() => costRun({ claudeDir: fixture })).toThrow("run id is required");
  });
  it("renders the agent, task, and stage tables and the total line", () => {
    const text = renderCost(costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project }));
    expect(text).toContain("Run wf_7092b963-6a5: 8 agents in session d6f89e32-16df-45f2-b3d0-9415009bc856, 2026-09-06T13:40:31.678Z, 18 min.");
    expect(text).toContain("| a82d340bfaf1bf171 | reuse | agents-generator |  | claude-haiku-4-5 | 42 | 176 | 106,839 | 28,045 | $0.05 |");
    expect(text).toContain("| ad2262af4c2ef00c4 | fix | agents-generator | 2 | claude-sonnet-5 | 10 | 3,882 | 175,980 | 51,851 | $0.20 |");
    expect(text).toContain("| Per task | Agents |");
    expect(text).toContain("| agents-generator | 8 | 180 | 26,359 | 1,219,887 | 243,183 | $1.85 |");
    expect(text).toContain("| Per stage | Agents |");
    expect(text).toContain("| check | 1 | 26 | 9,075 | 232,420 | 32,954 | $0.55 |");
    expect(text).toContain(`Run total: 180 input, 26,359 output, 1,219,887 cache read, 243,183 cache write tokens; $1.85 at list prices dated ${PRICES_DATED}.`);
    expect(text).toContain("Note: 2 adversary agents relayed codex-review");
  });
});

describe("agents the transcripts cannot price", () => {
  // A run without a run file (no labels): stage from the meta file, task from the journal; a missing transcript and
  // an unknown model are reported and left out of the total, never estimated.
  function synthetic() {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-claude-"));
    const dir = join(claudeDir, "projects", "-tmp-proj", "sess-1", "subagents", "workflows", "wf_synth-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), [
      JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
      JSON.stringify({ type: "result", key: "k1", agentId: "a1", result: { taskId: "t1", passed: true } }),
      JSON.stringify({ type: "started", key: "k2", agentId: "a2" }),
      JSON.stringify({ type: "result", key: "k2", agentId: "a2", result: { taskId: "t1" } }),
      JSON.stringify({ type: "started", key: "k3", agentId: "a3" }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "doug-flow:verifier", model: "opus" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n");
    writeFileSync(join(dir, "agent-a2.meta.json"), JSON.stringify({ agentType: "doug-flow:reviewer" }));
    writeFileSync(join(dir, "agent-a2.jsonl"), JSON.stringify({ type: "assistant", message: { id: "m2", model: "claude-future-9", usage: { input_tokens: 5, output_tokens: 5 } } }) + "\n");
    return { claudeDir, projectDir: "/tmp/proj" };
  }
  it("falls back to the meta file and the journal, and reports what is unpriced", () => {
    const r = costRun({ runId: "wf_synth-001", ...synthetic() });
    expect(r.startedAt).toBeNull();
    expect(r.agents.map((a) => [a.agentId, a.stage, a.task, a.label, a.transcript, a.usd])).toEqual([
      ["a1", "verifier", "t1", null, true, 1000 * 5e-6 + 2000 * 25e-6],
      ["a2", "reviewer", "t1", null, true, null],
      ["a3", null, null, null, false, null],
    ]);
    expect(r.total).toMatchObject({ agents: 3, unpriced: 2, usage: { input: 1005, output: 2005 } });
    expect(r.total.usd).toBeCloseTo(0.055, 10);
    expect(r.notes).toEqual([
      "a2 (reviewer): model claude-future-9 is not in the price table; not priced",
      "a3 (null): no transcript file; not priced",
    ]);
    const text = renderCost(r);
    expect(text).toContain("| a3 | ? | ? |  | ? | 0 | 0 | 0 | 0 | unpriced |");
    expect(text).toContain("| t1 | 2 | 1,005 | 2,005 | 0 | 0 | $0.06 (1 unpriced) |");
    expect(text).toContain("$0.06 for 1 of 3 agents (2 unpriced) at list prices dated");
    expect(text).toContain("Note: a3 (null): no transcript file; not priced.");
  });
});

describe("cost.mjs CLI", () => {
  it("prints the text report, or JSON with --json, and exits 1 on an unknown run and 2 on usage", () => {
    const text = run(["wf_7092b963-6a5", project, "--claude-dir", fixture]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("Run total: 180 input, 26,359 output, 1,219,887 cache read, 243,183 cache write tokens; $1.85");
    const json = run(["wf_f70da515-2af", project, "--claude-dir", fixture, "--json"]);
    expect(json.status, json.stderr).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.agents.length).toBe(11);
    expect(parsed.total.usd).toBeCloseTo(3.602705, 5);
    const missing = run(["wf_nope", project, "--claude-dir", fixture]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no journal for run wf_nope");
    expect(run([]).status).toBe(2);
  });
});

// card adversary-usage-in-report (decision 0007 follow-up): the adversary relay's usage and durationMs, copied into
// the report per task and per level, priced from a dated Codex row and printed as a separate line, never mixed into
// the Claude total (Codex's own tokens are not in local transcripts, so costRun cannot see them without a report).
describe("card adversary-usage-in-report", () => {
  // levels[].tasks[].adversary and levels[].levelAdversary carry usage ({inputTokens, outputTokens}) and durationMs,
  // copied from ReviewResult (or null). t2 has no usage at all (a fallback review, or one that printed none).
  // t3 (round 2, R3/minor 5): usage present but string-typed, as a hand-edited or pre-this-card report might carry;
  // must not be priced as a number, but still counts as unpriced (it ran and is not a fallback).
  // t4 (round 2, R3/minor 6): a fallback seat with usage: null never touched codex-review at all, so it is neither
  // a priced review nor counted as unpriced (unlike t2, a codex-review relay that printed none).
  const sampleReport = () => ({
    levels: [
      {
        tasks: [
          { id: "t1", adversary: { ran: true, usage: { inputTokens: 670279, outputTokens: 5649 }, durationMs: 338000 } },
          { id: "t2", adversary: { ran: true, usage: null, durationMs: null } },
          { id: "t3", adversary: { ran: true, usage: { inputTokens: "670279", outputTokens: "5649" }, durationMs: null } },
          { id: "t4", adversary: { ran: true, fallback: { model: "opus" }, usage: null } },
        ],
        levelAdversary: { ran: true, usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 1000 },
      },
    ],
  });

  it("U1: codexUsageFromReport walks every level's task adversaries and levelAdversary, summing usage and counting the unpriced", () => {
    const u = codexUsageFromReport(sampleReport());
    expect(u, "U1: reviews must count t1's task adversary and the levelAdversary (2), not t2/t3/t4").toMatchObject({ reviews: 2 });
    expect(u.input, "U1: input must be the sum of the priced entries' inputTokens (670,279 + 100)").toBe(670379);
    expect(u.output, "U1: output must be the sum of the priced entries' outputTokens (5,649 + 50)").toBe(5699);
    expect(u.durationMs, "U1: durationMs must be the sum of the priced entries' durationMs (338,000 + 1,000)").toBe(339000);
    expect(u.unpriced, "R3: t2 (usage null) and t3 (string-typed usage, not a number) both count as unpriced; t4 (fallback) counts as neither, so unpriced is 2, not 3 or 1").toBe(2);
    expect(codexUsageFromReport({ levels: [] }).reviews, "U1: a report with no adversary usage anywhere must report reviews: 0").toBe(0);
    expect(codexUsageFromReport({ levels: [{ tasks: [{ id: "t1", adversary: { ran: true, usage: null } }] }] }).reviews, "U1: a null-usage entry alone must not be counted as a review").toBe(0);
  });

  it("R2: costRun leaves codex null and keeps the relay note when the report's adversaries carry no usage at all (round 2 major 2)", () => {
    const reportWithoutUsage = { levels: [{ tasks: [{ id: "t1", adversary: { ran: true, usage: null } }], levelAdversary: { ran: true, usage: null } }] };
    const r = costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project, report: reportWithoutUsage });
    expect(r.codex, "R2: codexUsageFromReport().reviews is 0 here, so the guard must be `reviews > 0`, not `reviews >= 0`; codex must stay null").toBeNull();
    expect(r.notes, "R2: with nothing priced, the relay note must not be dropped").toEqual(["2 adversary agents relayed codex-review; Codex's own tokens are not in local transcripts and are not priced"]);
  });

  it("U2: priceCodexUsage prices the 2026-09-14 review at the dated Codex row, to the cent", () => {
    const usd = priceCodexUsage({ input: 670279, output: 5649 });
    expect(usd, "U2: (670,279 * input rate + 5,649 * output rate) / 1e6 at CODEX_DEFAULT_MODEL's row").toBeCloseTo(2.79, 2);
    expect(priceCodexUsage({ input: 1000, output: 1000 }, "no-such-model"), "U2: a model absent from CODEX_PRICES must price null, never be estimated").toBeNull();
    expect(CODEX_PRICES[CODEX_DEFAULT_MODEL], "U2: CODEX_PRICES must carry the row for CODEX_DEFAULT_MODEL").toBeDefined();
    expect(CODEX_PRICES_DATED, "U2: CODEX_PRICES_DATED must be the researched fetch date the printed line names").toBe("2026-09-19");
  });

  it("U3: costRun prices a report's Codex usage as result.codex, without touching the Claude total or keeping the relay note", () => {
    const withReport = costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project, report: sampleReport() });
    expect(withReport.codex, "U3: result.codex must be set from the report's adversary usage (unpriced: 2 now that sampleReport carries t3/t4, round 2 R3)").toMatchObject({ reviews: 2, input: 670379, output: 5699, durationMs: 339000, unpriced: 2 });
    expect(withReport.total.usd, "U3: the Claude run total must be unchanged by a report's Codex usage").toBeCloseTo(1.845665, 5);
    expect(withReport.notes, "U3: the relay note is dropped once result.codex carries the real numbers").toEqual([]);

    const withoutReport = costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project });
    expect(withoutReport.codex, "U3: with no report option, result.codex must be null").toBeNull();
    expect(withoutReport.notes, "U3: with no report option, the existing relay note must be unchanged (pins the note at line 81)").toEqual(["2 adversary agents relayed codex-review; Codex's own tokens are not in local transcripts and are not priced"]);
  });

  it("U4: renderCost prints a Codex line after Run total that is explicitly not part of it, and omits it when there is no report", () => {
    const withReport = costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project, report: sampleReport() });
    const text = renderCost(withReport);
    const totalIdx = text.indexOf("Run total:");
    const codexIdx = text.indexOf("Codex:");
    expect(codexIdx, "U4: a Codex: line must exist and follow the Run total: line").toBeGreaterThan(totalIdx);
    expect(text, "U4: the Codex line must say the tokens are not included in the run total").toMatch(/Codex:[^\n]*not included in the run total/);

    const withoutReport = costRun({ runId: "wf_7092b963-6a5", claudeDir: fixture, projectDir: project });
    expect(renderCost(withoutReport), "U4: no report means no Codex line at all").not.toMatch(/^Codex:/m);
  });

  it("U5: scripts/cost.mjs --report <path> prices Codex usage, and so does the default .doug/.state/last-report.json when no flag is given", () => {
    const reportDir = mkdtempSync(join(tmpdir(), "doug-cost-report-"));
    const reportFile = join(reportDir, "report.json");
    writeFileSync(reportFile, JSON.stringify(sampleReport()));

    const json = run(["wf_7092b963-6a5", project, "--claude-dir", fixture, "--report", reportFile, "--json"]);
    expect(json.status, json.stderr).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.codex, "U5: --report <path> must reach costRun and appear in --json output").toMatchObject({ reviews: 2, input: 670379, output: 5699 });

    const text = run(["wf_7092b963-6a5", project, "--claude-dir", fixture, "--report", reportFile]);
    expect(text.stdout, "U5: the text report must also carry the Codex line when --report is given").toContain("Codex:");

    // No --report flag: <projectDir>/.doug/.state/last-report.json is read when it exists.
    const projectDir = mkdtempSync(join(tmpdir(), "doug-cost-proj-"));
    mkdirSync(join(projectDir, ".doug", ".state"), { recursive: true });
    writeFileSync(join(projectDir, ".doug", ".state", "last-report.json"), JSON.stringify({ ...sampleReport(), runId: "wf_7092b963-6a5" }));
    const defaultRun = run(["wf_7092b963-6a5", projectDir, "--claude-dir", fixture, "--json"]);
    expect(defaultRun.status, defaultRun.stderr).toBe(0);
    expect(JSON.parse(defaultRun.stdout).codex, "U5: with no --report flag, the default last-report.json path must still be read when it exists").toMatchObject({ reviews: 2 });
  });

  // Card report-save-wrapper, M4: the same sample report saved as the Workflow tool's own output shape ({
  // summary, agentCount, logs, result: <report> }) instead of bare must still resolve the same Codex usage
  // (cost.mjs imports unwrapReport from lib/plan.mjs and applies it to what it parsed, for both --report and the
  // default last-report.json path).
  it("M4: cost.mjs resolves the same report whether --report (and the default last-report.json) is saved wrapped or bare", () => {
    const wrappedReportDir = mkdtempSync(join(tmpdir(), "doug-cost-wrapped-"));
    const wrappedReportFile = join(wrappedReportDir, "wrapped-report.json");
    writeFileSync(wrappedReportFile, JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: sampleReport() }));

    const json = run(["wf_7092b963-6a5", project, "--claude-dir", fixture, "--report", wrappedReportFile, "--json"]);
    expect(json.status, json.stderr).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.codex, "M4: --report <path> to a wrapped report must still reach costRun and appear in --json output").toMatchObject({ reviews: 2, input: 670379, output: 5699 });

    // No --report flag: the default <projectDir>/.doug/.state/last-report.json, wrapped, must also unwrap.
    const projectDir = mkdtempSync(join(tmpdir(), "doug-cost-wrapped-proj-"));
    mkdirSync(join(projectDir, ".doug", ".state"), { recursive: true });
    writeFileSync(join(projectDir, ".doug", ".state", "last-report.json"), JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: { ...sampleReport(), runId: "wf_7092b963-6a5" } }));
    const defaultRun = run(["wf_7092b963-6a5", projectDir, "--claude-dir", fixture, "--json"]);
    expect(defaultRun.status, defaultRun.stderr).toBe(0);
    expect(JSON.parse(defaultRun.stdout).codex, "M4: with no --report flag, a wrapped default last-report.json must also be unwrapped").toMatchObject({ reviews: 2 });
  });

  // Card cost-run-codex-line-mismatch: the Codex line attaches only to the run the report belongs to.
  describe("card cost-run-codex-line-mismatch", () => {
    const RUN = "wf_7092b963-6a5";
    const OTHER = "wf_a19ecd25-e45";
    const relay = "2 adversary agents relayed codex-review; Codex's own tokens are not in local transcripts and are not priced";
    const viaDefault = (report) => {
      const projectDir = mkdtempSync(join(tmpdir(), "doug-cost-rid-proj-"));
      mkdirSync(join(projectDir, ".doug", ".state"), { recursive: true });
      writeFileSync(join(projectDir, ".doug", ".state", "last-report.json"), JSON.stringify(report));
      return [run([RUN, projectDir, "--claude-dir", fixture, "--json"]), run([RUN, projectDir, "--claude-dir", fixture])];
    };
    const viaNamed = (report) => {
      const f = join(mkdtempSync(join(tmpdir(), "doug-cost-rid-named-")), "report.json");
      writeFileSync(f, JSON.stringify(report));
      return [run([RUN, project, "--claude-dir", fixture, "--report", f, "--json"]), run([RUN, project, "--claude-dir", fixture, "--report", f])];
    };
    const expectNone = (pair, why) => {
      const [j, t] = pair;
      expect(j.status, j.stderr).toBe(0);
      const parsed = JSON.parse(j.stdout);
      expect(parsed.codex, why).toBeNull();
      expect(parsed.notes, why + " (relay note stays)").toContain(relay);
      expect(t.stdout, why).not.toMatch(/^Codex:/m);
    };
    const expectAttached = (pair, why) => {
      const [j, t] = pair;
      expect(j.status, j.stderr).toBe(0);
      expect(JSON.parse(j.stdout).codex, why).toMatchObject({ reviews: 2 });
      expect(t.stdout, why).toMatch(/^Codex:/m);
    };

    it("C1: a default last-report.json whose runId differs from the run asked for prints no Codex line", () => {
      expectNone(viaDefault({ ...sampleReport(), runId: OTHER }), "C1: a default report of another run must not be attached");
    });
    it("C2: a default last-report.json whose runId matches prints the Codex line", () => {
      expectAttached(viaDefault({ ...sampleReport(), runId: RUN }), "C2: a matching default report must be attached");
    });
    it("C3: a default last-report.json with no runId prints no Codex line", () => {
      expectNone(viaDefault(sampleReport()), "C3: a default report with no runId is not provably this run's");
    });
    it("C4: a named --report whose runId differs prints no Codex line", () => {
      expectNone(viaNamed({ ...sampleReport(), runId: OTHER }), "C4: a named report of another run must not be attached");
    });
    it("C5: a named --report with no runId prints the Codex line", () => {
      expectAttached(viaNamed(sampleReport()), "C5: the caller names the file, so a report without runId is attached");
    });
    it("C6: a named --report whose runId matches prints the Codex line", () => {
      expectAttached(viaNamed({ ...sampleReport(), runId: RUN }), "C6: a matching named report must be attached");
    });
  });

  it("R6: a truncated default last-report.json is ignored (exit 0, codex: null), but an explicit --report to the same bad file still exits 1 (round 2 fragility)", () => {
    const badDir = mkdtempSync(join(tmpdir(), "doug-cost-badreport-"));
    mkdirSync(join(badDir, ".doug", ".state"), { recursive: true });
    const badFile = join(badDir, ".doug", ".state", "last-report.json");
    writeFileSync(badFile, '{"levels": [truncated');

    const defaultBad = run(["wf_7092b963-6a5", badDir, "--claude-dir", fixture, "--json"]);
    expect(defaultBad.status, `R6: a broken default report must not fail the run at all (stderr: ${defaultBad.stderr})`).toBe(0);
    expect(JSON.parse(defaultBad.stdout).codex, "R6: an unreadable default report must be ignored, not surfaced as codex data").toBeNull();

    const explicitBad = run(["wf_7092b963-6a5", project, "--claude-dir", fixture, "--report", badFile, "--json"]);
    expect(explicitBad.status, "R6: an explicit --report pointing at bad JSON is a real usage error and must still exit 1").toBe(1);
  });
});

// A batch's cost split per card (card parallel-cards): each card's tasks' agents summed for that card, the agents of
// the shared integration stages (integrate, the level adversary) listed once, nothing estimated.
import { costByCard } from "../lib/cost.mjs";

describe("costByCard", () => {
  const agent = (label, usd) => ({ ...parseLabel(label), label, usd, agentId: label });
  const result = { agents: [agent("implement:a1", 0.3), agent("verify:a1", 0.6), agent("implement:b1", 0.2), agent("fix:b1:2", null), agent("integrate:level-0", 0.1), agent("adversary:level-0", 0.05), agent("implement:zz", 0.9)] };
  const plan = { cards: ["alpha", "beta"], tasks: [{ id: "a1", card: "alpha" }, { id: "b1", card: "beta" }] };
  it("sums each card's task agents, the shared integration agents once, and names the rest", () => {
    const r = costByCard(result, plan);
    expect(r.cards).toEqual([
      { card: "alpha", agents: 2, usd: expect.closeTo(0.9, 10), unpriced: 0, tasks: ["a1"] },
      { card: "beta", agents: 2, usd: 0.2, unpriced: 1, tasks: ["b1"] },
    ]);
    expect(r.shared).toEqual({ agents: 2, usd: expect.closeTo(0.15, 10), unpriced: 0, labels: ["integrate:level-0", "adversary:level-0"] });
    expect(r.other).toEqual({ agents: 1, usd: 0.9, unpriced: 0, labels: ["implement:zz"] });
    expect(() => costByCard(result, { tasks: [] })).toThrow("the plan has no cards");
  });
  it("cost.mjs --by-card prints the per-card table from the project's plan", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-claude-"));
    const dir = join(claudeDir, "projects", "-tmp-batch", "sess-1", "subagents", "workflows", "wf_batch-001");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(claudeDir, "projects", "-tmp-batch", "sess-1", "workflows"), { recursive: true });
    const labels = ["implement:a1", "implement:b1", "integrate:level-0"];
    writeFileSync(join(dir, "journal.jsonl"), labels.map((l, i) => JSON.stringify({ type: "started", key: `k${i}`, agentId: `a${i}` })).join("\n") + "\n");
    writeFileSync(join(claudeDir, "projects", "-tmp-batch", "sess-1", "workflows", "wf_batch-001.json"), JSON.stringify({ runId: "wf_batch-001", workflowProgress: labels.map((label, i) => ({ type: "workflow_agent", label, agentId: `a${i}` })) }));
    for (const [i, out] of [[0, 1_000_000], [1, 2_000_000], [2, 400_000]]) writeFileSync(join(dir, `agent-a${i}.jsonl`), JSON.stringify({ type: "assistant", message: { id: `m${i}`, model: "claude-sonnet-5", usage: { input_tokens: 0, output_tokens: out } } }) + "\n");
    const projectDir = mkdtempSync(join(tmpdir(), "doug-cost-proj-"));
    mkdirSync(join(projectDir, ".doug"), { recursive: true });
    writeFileSync(join(projectDir, ".doug/plan.json"), JSON.stringify({ cards: ["alpha", "beta"], tasks: [{ id: "a1", card: "alpha" }, { id: "b1", card: "beta" }] }));
    const r = spawnSync(process.execPath, [script, "wf_batch-001", projectDir, "--claude-dir", claudeDir, "--by-card"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("| Per card | Agents | USD |");
    expect(r.stdout).toContain("| alpha | 1 | $10.00 |");
    expect(r.stdout).toContain("| beta | 1 | $20.00 |");
    expect(r.stdout).toContain("| shared integration agents (integrate:level-0) | 1 | $4.00 |");
    expect(r.stdout).toContain("Run total:");
    const json = spawnSync(process.execPath, [script, "wf_batch-001", projectDir, "--claude-dir", claudeDir, "--by-card", "--json"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(JSON.parse(json.stdout).byCard.cards.map((c) => [c.card, c.usd])).toEqual([["alpha", 10], ["beta", 20]]);
    writeFileSync(join(projectDir, ".doug/plan.json"), JSON.stringify({ tasks: [{ id: "a1" }] }));
    const noCards = spawnSync(process.execPath, [script, "wf_batch-001", projectDir, "--claude-dir", claudeDir, "--by-card"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(noCards.status).toBe(1);
    expect(noCards.stderr).toContain("the plan has no cards");
  });
});

// Card autopilot part B: `cost.mjs --session <id|latest>` prices one Claude Code session: its top-level transcript
// plus every *.jsonl under <id>/subagents/ recursively (plain agents and workflows/wf_*/ agents).
describe("session cost (card autopilot)", () => {
  const msg = (id, usage) => JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5", usage } }) + "\n";
  const slug = "-tmp-sessproj";
  const sessProject = "/tmp/sessproj";
  const build = () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-sess-"));
    const proj = join(claudeDir, "projects", slug);
    const wf = join(proj, "sess-new", "subagents", "workflows", "wf_x");
    mkdirSync(wf, { recursive: true });
    mkdirSync(join(proj, "sess-old", "subagents"), { recursive: true });
    // sess-new: $5 lead (1M input) + $2.50 plain subagent (100k output) + $5 workflow agent (200k output) = $12.50
    writeFileSync(join(proj, "sess-new.jsonl"), msg("m1", { input_tokens: 1_000_000, output_tokens: 0 }));
    writeFileSync(join(proj, "sess-new", "subagents", "agent-a.jsonl"), msg("m2", { input_tokens: 0, output_tokens: 100_000 }));
    writeFileSync(join(wf, "agent-b.jsonl"), msg("m3", { input_tokens: 0, output_tokens: 200_000 }));
    writeFileSync(join(wf, "journal.jsonl"), JSON.stringify({ type: "started", key: "k", agentId: "b" }) + "\n");
    // sess-old: $50 lead (10M input) + $25 subagent (1M output) = $75
    writeFileSync(join(proj, "sess-old.jsonl"), msg("m4", { input_tokens: 10_000_000, output_tokens: 0 }));
    writeFileSync(join(proj, "sess-old", "subagents", "agent-c.jsonl"), msg("m5", { input_tokens: 0, output_tokens: 1_000_000 }));
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-02-01T00:00:00Z");
    utimesSync(join(proj, "sess-old.jsonl"), old, old);
    utimesSync(join(proj, "sess-new.jsonl"), recent, recent);
    return claudeDir;
  };

  it("--session <id> --json totals the top-level transcript, plain subagents, and workflow subagents recursively", () => {
    const claudeDir = build();
    const r = run(["--session", "sess-new", sessProject, "--claude-dir", claudeDir, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).total.usd).toBeCloseTo(12.5, 6);
  });
  it("--session latest picks the most recently modified top-level transcript, not the oldest", () => {
    const claudeDir = build();
    const r = run(["--session", "latest", sessProject, "--claude-dir", claudeDir, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).total.usd).toBeCloseTo(12.5, 6);
    // the older session by id is its own total
    const old = run(["--session", "sess-old", sessProject, "--claude-dir", claudeDir, "--json"]);
    expect(JSON.parse(old.stdout).total.usd).toBeCloseTo(75, 6);
  });
  it("the text output has a session total line with the dollar figure", () => {
    const claudeDir = build();
    const r = run(["--session", "latest", sessProject, "--claude-dir", claudeDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/session total[^\n]*\$12\.50/i);
  });
  it("exits 1 when the session has no transcript, and when the project has none for latest", () => {
    const claudeDir = build();
    expect(run(["--session", "sess-new", sessProject, "--claude-dir", claudeDir, "--json"]).status).toBe(0);
    const none = run(["--session", "sess-nope", sessProject, "--claude-dir", claudeDir]);
    expect(none.status).toBe(1);
    const noProject = run(["--session", "latest", "/tmp/other-proj", "--claude-dir", claudeDir]);
    expect(noProject.status).toBe(1);
  });
  it("the <run-id> form is unchanged next to --session", () => {
    const r = run(["wf_7092b963-6a5", project, "--claude-dir", fixture]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Run total:");
  });
});

// Card autopilot fix pass 2: the machine's subagent transcripts carry model "claude-sonnet-5-5"; unpriced, it made
// `cost.mjs --session` report an unpriced transcript (an autopilot stop). List price 2/10/0.1/2.5/4 per million
// (platform.claude.com pricing; cacheRead corrected from 0.2 to 0.1 by card cost-price-haiku-5-5, fetched 2026-10-10).
describe("claude-sonnet-5-5 price (card autopilot)", () => {
  it("priceUsage prices claude-sonnet-5-5 at $2/$10/$0.1/$2.5/$4 per million tokens", () => {
    const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    expect(priceUsage(usage, "claude-sonnet-5-5")).toBe(2);
    expect(priceUsage({ ...usage, input: 0, output: 1_000_000 }, "claude-sonnet-5-5")).toBe(10);
    expect(priceUsage({ ...usage, input: 0, cacheRead: 1_000_000 }, "claude-sonnet-5-5")).toBeCloseTo(0.1, 10);
    expect(priceUsage({ ...usage, input: 0, cacheWrite: 1_000_000 }, "claude-sonnet-5-5")).toBe(2.5);
    expect(priceUsage({ ...usage, input: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }, "claude-sonnet-5-5")).toBe(4);
    expect(PRICES["claude-sonnet-5-5"]).toBeDefined();
  });
  it("a session whose transcripts run on claude-sonnet-5-5 is priced, with nothing unpriced", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-s55-"));
    const proj = join(claudeDir, "projects", "-tmp-s55proj");
    mkdirSync(join(proj, "sess-1", "subagents"), { recursive: true });
    const line = (id, usage) => JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5-5", usage } }) + "\n";
    writeFileSync(join(proj, "sess-1.jsonl"), line("m1", { input_tokens: 1_000_000, output_tokens: 0 }));
    writeFileSync(join(proj, "sess-1", "subagents", "agent-a.jsonl"), line("m2", { input_tokens: 0, output_tokens: 100_000 }));
    const r = run(["--session", "sess-1", "/tmp/s55proj", "--claude-dir", claudeDir, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.total.unpriced).toBe(0);
    expect(parsed.total.usd).toBeCloseTo(3, 6);
    expect(r.stdout).not.toMatch(/not in the price table/);
    const text = run(["--session", "sess-1", "/tmp/s55proj", "--claude-dir", claudeDir]);
    expect(text.stdout).not.toMatch(/unpriced/);
  });
});

// Card flow-wall-budget: the runtime's run file (workflowProgress[]) holds every agent's start and duration, so the
// wall a task, a pass and a stage took is measured after the run from it; detection only, nothing is killed.
describe("card flow-wall-budget", () => {
  const MIN = 60_000;
  const T0 = 1_791_000_000_000;
  // Agents as [label, startMin, endMin]; a null end drops durationMs.
  const runOf = (agents, durationMs = 60 * MIN) => ({
    runId: "wf_x",
    durationMs,
    workflowProgress: agents.map(([label, from, to]) => ({ type: "workflow_agent", label, startedAt: T0 + from * MIN, ...(to === null ? {} : { durationMs: (to - from) * MIN }) })),
  });
  const kinds = (r, kind) => r.flags.filter((f) => f.kind === kind);

  it("the shares are exported: a pass is 0.75 and a stage 0.25 of the wall budget", () => {
    expect(PASS_WALL_SHARE).toBe(0.75);
    expect(STAGE_WALL_SHARE).toBe(0.25);
  });

  it("W1: a task whose passes run in sequence is flagged over the budget by its first-start to last-end span, with each pass's span", () => {
    const r = runWall(runOf([["implement:t", 0, 10], ["verify:t", 10, 19], ["review:t", 10, 14], ["adversary:t", 19, 28], ["fix:t:2", 28, 37], ["check:t:2", 37, 45]]), { wallMinutes: 40 });
    expect(r.measured).toBe(true);
    expect(r.flags).toEqual([{ kind: "task", label: "t", ms: 45 * MIN, limitMs: 40 * MIN }]);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0].task).toBe("t");
    expect(r.tasks[0].ms).toBe(45 * MIN);
    expect(r.tasks[0].passes).toEqual([{ pass: 1, ms: 28 * MIN }, { pass: 2, ms: 17 * MIN }]);
  });

  it("W2: agents running alongside count once (a span, never a sum): no task flag at 35 min, a pass flag over 30, and a stage flag for each long agent", () => {
    const r = runWall(runOf([["implement:u", 0, 5], ["verify:u", 5, 35], ["review:u", 5, 35]]), { wallMinutes: 40 });
    expect(kinds(r, "task")).toEqual([]);
    expect(r.tasks[0].ms).toBe(35 * MIN);
    const pass = kinds(r, "pass");
    expect(pass).toHaveLength(1);
    expect(pass[0]).toMatchObject({ label: "u", ms: 35 * MIN, limitMs: 30 * MIN });
    expect(kinds(r, "stage").map((f) => f.label).sort()).toEqual(["review:u", "verify:u"]);
    expect(kinds(r, "stage")[0]).toMatchObject({ ms: 30 * MIN, limitMs: 10 * MIN });
  });

  it("W3: a :retry suffix and a swarm worker's trailing number do not start a new task or pass", () => {
    const r = runWall(runOf([["worker:t:3", 0, 2], ["verify:t:retry", 2, 4], ["fix:t:2:retry", 4, 6]]), { wallMinutes: 40 });
    expect(r.tasks.map((t) => t.task)).toEqual(["t"]);
    expect(r.tasks[0].passes).toEqual([{ pass: 1, ms: 4 * MIN }, { pass: 2, ms: 2 * MIN }]);
    expect(r.tasks[0].ms).toBe(6 * MIN);
  });

  it("W4: no run file is not measured, with a reason; an agent with no duration leaves its task unverified and unflagged for task and pass", () => {
    const none = runWall(null, { wallMinutes: 40 });
    expect(none.measured).toBe(false);
    expect(typeof none.reason).toBe("string");
    expect(none.reason).not.toBe("");
    const r = runWall(runOf([["implement:t", 0, 30], ["verify:t", 30, null], ["review:t", 30, 60]]), { wallMinutes: 40 });
    expect(r.unverified).toEqual(["t"]);
    expect(r.flags.filter((f) => f.label === "t")).toEqual([]);
  });

  it("W5: a level's integrate agent gets only a stage flag, and no task entry", () => {
    const r = runWall(runOf([["integrate:level-0", 0, 12]]), { wallMinutes: 40 });
    expect(r.flags).toEqual([{ kind: "stage", label: "integrate:level-0", ms: 12 * MIN, limitMs: 10 * MIN }]);
    expect(r.tasks.map((t) => t.task)).not.toContain("level-0");
  });

  it("W6: the real wf_f923de23-f38 run (trimmed): doctor-feature-checks at 36 min is not flagged, its 606640 ms implement stage is; a run with no agent times is not measured", () => {
    const claudeDir = fixture;
    const r = wallForRun({ runId: "wf_f923de23-f38", claudeDir, projectDir: project, wallMinutes: 40 });
    expect(r.measured).toBe(true);
    const doctor = r.tasks.find((t) => t.task === "doctor-feature-checks");
    expect(Math.round(doctor.ms / MIN)).toBe(36);
    expect(r.flags).toEqual([{ kind: "stage", label: "implement:doctor-feature-checks", ms: 606640, limitMs: 10 * MIN }]);
    const old = wallForRun({ runId: "wf_7092b963-6a5", claudeDir, projectDir: project, wallMinutes: 40 });
    expect(old.measured).toBe(false);
    expect(old.reason).toBe("no agent times");
  });

  it("wallForRun never throws: an unknown run id is not measured", () => {
    const r = wallForRun({ runId: "wf_nope", claudeDir: fixture, projectDir: project, wallMinutes: 40 });
    expect(r.measured).toBe(false);
    expect(typeof r.reason).toBe("string");
  });
});

// Card cost-price-haiku-5-5: claude-haiku-5-5 (the current haiku alias) was not in PRICES, so cost.mjs --session reported
// an unpriced transcript. Haiku 5.5 is priced per request by prompt length (platform.claude.com pricing, fetched
// 2026-10-10): a request whose prompt (input + cacheRead + cacheWrite) is over 100,000 tokens pays the high tier on every
// category; exactly 100,000 pays the low tier. USD per MTok:
//   low  (<= 100k): input 0.10, output 0.50, cacheRead 0.01, cacheWrite5m 0.125, cacheWrite1h 0.20
//   high (>  100k): input 0.50, output 2.50, cacheRead 0.05, cacheWrite5m 0.625, cacheWrite1h 1
// Every case goes through costSession (cost.mjs --session --json) or costRun, the real callers, so the tests do not pin
// how the coder shapes the tiered row or what transcriptUsage names its per-transcript USD.
describe("card cost-price-haiku-5-5", () => {
  const H = "claude-haiku-5-5";
  // One assistant line per message: [id, model, {input, output, cacheRead, cacheWrite, cacheWrite1h}].
  const lineOf = (id, model, u = {}) => JSON.stringify({
    type: "assistant",
    message: {
      id, model,
      usage: {
        input_tokens: u.input || 0, output_tokens: u.output || 0,
        cache_read_input_tokens: u.cacheRead || 0, cache_creation_input_tokens: u.cacheWrite || 0,
        ...(u.cacheWrite1h ? { cache_creation: { ephemeral_5m_input_tokens: (u.cacheWrite || 0) - u.cacheWrite1h, ephemeral_1h_input_tokens: u.cacheWrite1h } } : {}),
      },
    },
  }) + "\n";
  // A one-transcript session; returns the parsed `cost.mjs --session --json` result.
  const sessionOf = (messages) => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-h55-"));
    const proj = join(claudeDir, "projects", "-tmp-h55proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "sess-1.jsonl"), messages.map(([id, model, u]) => lineOf(id, model, u)).join(""));
    const r = run(["--session", "sess-1", "/tmp/h55proj", "--claude-dir", claudeDir, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it("H1 (M1): a claude-haiku-5-5 transcript is priced at the low tier, with nothing unpriced", () => {
    // 50,000 input + 20,000 cache read + 10,000 cache write (4,000 on 1h, 6,000 on 5m) = 80,000 prompt, low tier.
    // (50000*0.10 + 10000*0.50 + 20000*0.01 + 6000*0.125 + 4000*0.20) / 1e6 = (5000+5000+200+750+800)/1e6 = 0.01175
    const parsed = sessionOf([["m1", H, { input: 50_000, output: 10_000, cacheRead: 20_000, cacheWrite: 10_000, cacheWrite1h: 4_000 }]]);
    expect(parsed.total.unpriced, JSON.stringify(parsed.notes)).toBe(0);
    expect(parsed.total.usd).toBeCloseTo(0.01175, 10);
    expect(Object.keys(PRICES)).toContain(H);
  });

  it("H2 (M2): a dated-suffix and a [1m] variant of claude-haiku-5-5 price the same, through normalizeModel", () => {
    expect(normalizeModel("claude-haiku-5-5-20260101")).toBe(H);
    expect(normalizeModel("claude-haiku-5-5[1m]")).toBe(H);
    // Same 80,000-token usage as H1: 0.01175.
    const u = { input: 50_000, output: 10_000, cacheRead: 20_000, cacheWrite: 10_000, cacheWrite1h: 4_000 };
    const dated = sessionOf([["m1", "claude-haiku-5-5-20260101", u]]);
    expect(dated.total.unpriced, JSON.stringify(dated.notes)).toBe(0);
    expect(dated.total.usd).toBeCloseTo(0.01175, 10);
  });

  it("H3 (M3): a request whose prompt is over 100,000 tokens pays the high tier on input and output", () => {
    // 150,000 input, 10,000 output: (150000*0.50 + 10000*2.50) / 1e6 = (75000+25000)/1e6 = 0.1 (the low tier would give 0.02)
    expect(sessionOf([["m1", H, { input: 150_000, output: 10_000 }]]).total.usd).toBeCloseTo(0.1, 10);
  });

  it("H4 (M4): prompt length counts cache reads and cache writes, not input alone", () => {
    // 60,000 input + 50,000 cache read = 110,000 prompt, high tier; input alone (60,000) would be low.
    // (60000*0.50 + 50000*0.05 + 1000*2.50) / 1e6 = (30000+2500+2500)/1e6 = 0.035 (low tier: 0.007)
    expect(sessionOf([["m1", H, { input: 60_000, output: 1_000, cacheRead: 50_000 }]]).total.usd).toBeCloseTo(0.035, 10);
    // 10,000 input + 95,000 cache write (5m) = 105,000 prompt, high tier; cache reads absent, so a prompt length that
    // dropped cacheWrite would stay low.
    // (10000*0.50 + 95000*0.625) / 1e6 = (5000+59375)/1e6 = 0.064375
    expect(sessionOf([["m1", H, { input: 10_000, cacheWrite: 95_000 }]]).total.usd).toBeCloseTo(0.064375, 10);
    // The 1h share is a cache write too: 10,000 input + 95,000 write of which 95,000 on 1h = 105,000 prompt.
    // (10000*0.50 + 95000*1) / 1e6 = 0.1
    expect(sessionOf([["m1", H, { input: 10_000, cacheWrite: 95_000, cacheWrite1h: 95_000 }]]).total.usd).toBeCloseTo(0.1, 10);
  });

  it("H5 (M5): exactly 100,000 prompt tokens pays the low tier; 100,001 pays the high tier", () => {
    // 100,000 input, 1,000 output: (100000*0.10 + 1000*0.50) / 1e6 = (10000+500)/1e6 = 0.0105
    expect(sessionOf([["m1", H, { input: 100_000, output: 1_000 }]]).total.usd).toBeCloseTo(0.0105, 10);
    // 100,001 input, 1,000 output: (100001*0.50 + 1000*2.50) / 1e6 = (50000.5+2500)/1e6 = 0.0525005
    expect(sessionOf([["m1", H, { input: 100_001, output: 1_000 }]]).total.usd).toBeCloseTo(0.0525005, 10);
    // The boundary counts the cache too: 40,000 input + 30,000 read + 30,000 write = exactly 100,000, low tier.
    // (40000*0.10 + 30000*0.01 + 30000*0.125) / 1e6 = (4000+300+3750)/1e6 = 0.00805
    expect(sessionOf([["m1", H, { input: 40_000, cacheRead: 30_000, cacheWrite: 30_000 }]]).total.usd).toBeCloseTo(0.00805, 10);
  });

  it("H6 (M6): each message in a transcript is priced on its own tier, not the transcript's summed usage", () => {
    // Two 60,000-input messages: each is low (60000*0.10/1e6 = 0.006), total 0.012; their sum (120,000) would be high (0.06).
    expect(sessionOf([["m1", H, { input: 60_000 }], ["m2", H, { input: 60_000 }]]).total.usd).toBeCloseTo(0.012, 10);
    // One large, one small: 150,000*0.50 = 75000 and 10,000*0.10 = 1000, total 76000/1e6 = 0.076 (summed 160,000 high: 0.08).
    expect(sessionOf([["m1", H, { input: 150_000 }], ["m2", H, { input: 10_000 }]]).total.usd).toBeCloseTo(0.076, 10);
  });

  it("H7: a transcript with a message on a model outside the table is unpriced as a whole, never partly estimated", () => {
    const parsed = sessionOf([["m1", H, { input: 1_000 }], ["m2", H, { input: 1_000 }], ["m3", "claude-future-9", { input: 1_000 }]]);
    expect(parsed.total.unpriced).toBe(1);
    expect(parsed.total.usd).toBe(0);
    expect(parsed.notes.join("\n")).toMatch(/not in the price table/);
  });

  it("H8 (M7): claude-sonnet-5-5 prices cache reads at $0.1 per million", () => {
    const usage = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0 };
    expect(priceUsage(usage, "claude-sonnet-5-5")).toBeCloseTo(0.1, 10);
    // End to end: 1,000,000 cache read at 0.1 = 0.1
    expect(sessionOf([["m1", "claude-sonnet-5-5", { cacheRead: 1_000_000 }]]).total.usd).toBeCloseTo(0.1, 10);
  });

  it("H9: every current model alias resolves to a PRICES row (opus, sonnet, haiku, and fable)", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) expect(PRICES[id], id).toBeDefined();
    expect(PRICES_DATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICES_DATED >= "2026-10-10", `PRICES_DATED ${PRICES_DATED} must be updated to the fetch date`).toBe(true);
  });

  it("H10 (M8): costRun prices each message of an agent transcript on its own tier", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-claude-"));
    const dir = join(claudeDir, "projects", "-tmp-proj", "sess-1", "subagents", "workflows", "wf_h55-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), [
      JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
      JSON.stringify({ type: "result", key: "k1", agentId: "a1", result: { taskId: "t1" } }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "doug-flow:researcher" }));
    // Two 60,000-input messages: 0.012 priced per message, 0.06 if the summed 120,000 were priced.
    writeFileSync(join(dir, "agent-a1.jsonl"), lineOf("m1", H, { input: 60_000 }) + lineOf("m2", H, { input: 60_000 }));
    const r = costRun({ runId: "wf_h55-001", claudeDir, projectDir: "/tmp/proj" });
    expect(r.notes.some((n) => /not in the price table/.test(n)), `notes: ${JSON.stringify(r.notes)}`).toBe(false);
    expect(r.agents[0].usd).toBeCloseTo(0.012, 10);
    expect(r.total.usd).toBeCloseTo(0.012, 10);
    // A message on an unknown model makes the agent unpriced and keeps the note.
    writeFileSync(join(dir, "agent-a1.jsonl"), lineOf("m1", H, { input: 1_000 }) + lineOf("m2", "claude-future-9", { input: 1_000 }) + lineOf("m3", H, { input: 1_000 }));
    const u = costRun({ runId: "wf_h55-001", claudeDir, projectDir: "/tmp/proj" });
    expect(u.agents[0].usd).toBeNull();
    expect(u.notes.some((n) => /not in the price table/.test(n))).toBe(true);
  });

  // Fix pass 1 (reviewer R1): Claude Code writes "<synthetic>" messages with every usage field 0; they cost $0 on any
  // model and must not make a transcript unpriced.
  const runOf1 = (body) => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-claude-"));
    const dir = join(claudeDir, "projects", "-tmp-proj", "sess-1", "subagents", "workflows", "wf_fix-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), [
      JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
      JSON.stringify({ type: "result", key: "k1", agentId: "a1", result: { taskId: "t1" } }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "doug-flow:researcher" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), body);
    return costRun({ runId: "wf_fix-001", claudeDir, projectDir: "/tmp/proj" });
  };

  it("F1 (a): a zero-usage <synthetic> message costs $0 and leaves the transcript priced, through --session and costRun", () => {
    // Two 60,000-input haiku-5-5 messages, each low tier: 2 * 60000 * 0.10 / 1e6 = 0.012; the zero-usage message adds 0.
    const msgs = [["m1", H, { input: 60_000 }], ["m2", "<synthetic>", {}], ["m3", H, { input: 60_000 }]];
    const parsed = sessionOf(msgs);
    expect(parsed.total.unpriced, JSON.stringify(parsed.notes)).toBe(0);
    expect(parsed.total.usd).toBeCloseTo(0.012, 10);
    const r = runOf1(msgs.map(([id, model, u]) => lineOf(id, model, u)).join(""));
    expect(r.notes.some((n) => /not in the price table/.test(n)), `notes: ${JSON.stringify(r.notes)}`).toBe(false);
    expect(r.agents[0].usd).toBeCloseTo(0.012, 10);
    // Same on opus-5-5 ($4/$20): 1,000 input + 2,000 output = (4000 + 40000) / 1e6 = 0.044.
    const opus = sessionOf([["m1", "claude-opus-5-5", { input: 1_000, output: 2_000 }], ["m2", "<synthetic>", {}]]);
    expect(opus.total.unpriced, JSON.stringify(opus.notes)).toBe(0);
    expect(opus.total.usd).toBeCloseTo(0.044, 10);
  });

  it("F2 (b): a <synthetic> message with non-zero usage still makes the transcript unpriced, with the note", () => {
    const msgs = [["m1", H, { input: 60_000 }], ["m2", "<synthetic>", { output: 10 }], ["m3", H, { input: 60_000 }]];
    const parsed = sessionOf(msgs);
    expect(parsed.total.unpriced).toBe(1);
    expect(parsed.notes.join("\n")).toMatch(/not in the price table/);
    const r = runOf1(msgs.map(([id, model, u]) => lineOf(id, model, u)).join(""));
    expect(r.agents[0].usd).toBeNull();
    expect(r.notes.some((n) => /not in the price table/.test(n))).toBe(true);
  });

  it("F3 (c): a non-zero message with no model of its own is priced on the transcript's majority model", () => {
    // Two haiku-5-5 messages and one with no model, 60,000 input each; the model-less one takes the majority (haiku-5-5)
    // low tier: 3 * 60000 * 0.10 / 1e6 = 0.018.
    const msgs = [["m1", H, { input: 60_000 }], ["m2", undefined, { input: 60_000 }], ["m3", H, { input: 60_000 }]];
    const parsed = sessionOf(msgs);
    expect(parsed.total.unpriced, JSON.stringify(parsed.notes)).toBe(0);
    expect(parsed.total.usd).toBeCloseTo(0.018, 10);
    const r = runOf1(msgs.map(([id, model, u]) => lineOf(id, model, u)).join(""));
    expect(r.agents[0].usd).toBeCloseTo(0.018, 10);
  });
});

// Card usd-budget-size-class: `cost.mjs --session <id> --since <iso> [--until <iso>]` prices only the assistant
// messages whose timestamp falls in the window, over the lead transcript and every subagent transcript under it.
// This is how a hand landing's cost is measured, from the card's condition openedAt to the landing.
describe("session cost window (card usd-budget-size-class)", () => {
  const msg = (id, ts, usage) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-5", usage } }) + "\n";
  const sessProject = "/tmp/winproj";
  const build = () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "doug-cost-win-"));
    const proj = join(claudeDir, "projects", "-tmp-winproj");
    const wf = join(proj, "sess-w", "subagents", "workflows", "wf_w");
    mkdirSync(wf, { recursive: true });
    // lead: three $5 messages (1M input each) at 10:00, 11:00, 12:00
    writeFileSync(join(proj, "sess-w.jsonl"),
      msg("l1", "2026-10-11T10:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 }) +
      msg("l2", "2026-10-11T11:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 }) +
      msg("l3", "2026-10-11T12:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 }));
    // plain subagent: two $2.50 messages (100k output) at 10:30 and 11:30
    writeFileSync(join(proj, "sess-w", "subagents", "agent-a.jsonl"),
      msg("a1", "2026-10-11T10:30:00.000Z", { input_tokens: 0, output_tokens: 100_000 }) +
      msg("a2", "2026-10-11T11:30:00.000Z", { input_tokens: 0, output_tokens: 100_000 }));
    // workflow subagent: one $5 message (200k output) at 11:15
    writeFileSync(join(wf, "agent-b.jsonl"), msg("b1", "2026-10-11T11:15:00.000Z", { input_tokens: 0, output_tokens: 200_000 }));
    writeFileSync(join(wf, "journal.jsonl"), JSON.stringify({ type: "started", key: "k", agentId: "b" }) + "\n");
    return claudeDir;
  };
  const usd = (args) => {
    const r = run(["--session", "sess-w", sessProject, "--claude-dir", build(), "--json", ...args]);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).total.usd;
  };

  it("W1: no window prices every message ($25 = 15 lead + 5 plain subagent + 5 workflow agent)", () => {
    expect(usd([])).toBeCloseTo(25, 6);
  });
  it("W2: --since and --until keep only messages inside the window, across the lead, plain subagent and workflow agent transcripts", () => {
    // 10:45 to 11:45: lead 11:00 ($5) + subagent 11:30 ($2.50) + workflow 11:15 ($5)
    expect(usd(["--since", "2026-10-11T10:45:00Z", "--until", "2026-10-11T11:45:00Z"])).toBeCloseTo(12.5, 6);
  });
  it("W3: --since alone excludes earlier messages and keeps everything after", () => {
    // after 11:20: lead 12:00 ($5) + subagent 11:30 ($2.50); the workflow message at 11:15 is out
    expect(usd(["--since", "2026-10-11T11:20:00Z"])).toBeCloseTo(7.5, 6);
  });
  it("W4: --until alone excludes later messages", () => {
    // before 10:45: lead 10:00 ($5) + subagent 10:30 ($2.50)
    expect(usd(["--until", "2026-10-11T10:45:00Z"])).toBeCloseTo(7.5, 6);
  });
  it("W5: a window holding no message prices $0 and still exits 0", () => {
    expect(usd(["--since", "2027-01-01T00:00:00Z"])).toBe(0);
  });
  it("W6: the text output's session total line carries the windowed figure", () => {
    const r = run(["--session", "sess-w", sessProject, "--claude-dir", build(), "--since", "2026-10-11T11:20:00Z"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/session total[^\n]*\$7\.50/i);
  });
  it("W7: a bad ISO date in --since or --until exits non-zero with a usage message and prints no total", () => {
    for (const flag of ["--since", "--until"]) {
      const r = run(["--session", "sess-w", sessProject, "--claude-dir", build(), flag, "not-a-date"]);
      expect(r.status, flag).not.toBe(0);
      expect(r.stderr, flag).toMatch(/usage/i);
      expect(r.stderr, flag).toContain(flag);
      expect(r.stdout, flag).toBe("");
    }
  });
  it("W8: --since with an empty value exits non-zero with the usage message", () => {
    const r = run(["--session", "sess-w", sessProject, "--claude-dir", build(), "--since"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/i);
  });
  it("W9: the window is inclusive at both ends (a message exactly at --since or --until is priced)", () => {
    // lead 11:00 ($5) exactly on both bounds
    expect(usd(["--since", "2026-10-11T11:00:00.000Z", "--until", "2026-10-11T11:00:00.000Z"])).toBeCloseTo(5, 6);
  });
  it("W10: a line with no timestamp is kept when a window is set (conservative for a budget)", () => {
    const claudeDir = build();
    const f = join(claudeDir, "projects", "-tmp-winproj", "sess-w.jsonl");
    appendFileSync(f, JSON.stringify({ type: "assistant", message: { id: "nots", model: "claude-opus-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + "\n");
    const r = run(["--session", "sess-w", sessProject, "--claude-dir", claudeDir, "--json", "--since", "2026-10-11T11:20:00Z"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).total.usd).toBeCloseTo(12.5, 6);
  });
  it("W11: the transcript count counts only transcripts with messages in the window, and the text says so", () => {
    const claudeDir = build();
    const r = run(["--session", "sess-w", sessProject, "--claude-dir", claudeDir, "--json", "--since", "2026-10-11T11:50:00Z"]);
    expect(JSON.parse(r.stdout).files).toBe(1);
    const t = run(["--session", "sess-w", sessProject, "--claude-dir", claudeDir, "--since", "2026-10-11T11:50:00Z"]);
    expect(t.stdout).toMatch(/1 transcript in window/);
    const all = run(["--session", "sess-w", sessProject, "--claude-dir", claudeDir]);
    expect(all.stdout).toMatch(/Session sess-w: 4 transcripts\./);
  });
});
