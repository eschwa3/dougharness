import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICES, PRICES_DATED, normalizeModel, parseLabel, priceUsage, transcriptUsage, findRunDir, costRun, renderCost, codexUsageFromReport, priceCodexUsage, CODEX_PRICES, CODEX_PRICES_DATED, CODEX_DEFAULT_MODEL } from "../lib/cost.mjs";

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
    writeFileSync(join(projectDir, ".doug", ".state", "last-report.json"), JSON.stringify(sampleReport()));
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
    writeFileSync(join(projectDir, ".doug", ".state", "last-report.json"), JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: sampleReport() }));
    const defaultRun = run(["wf_7092b963-6a5", projectDir, "--claude-dir", fixture, "--json"]);
    expect(defaultRun.status, defaultRun.stderr).toBe(0);
    expect(JSON.parse(defaultRun.stdout).codex, "M4: with no --report flag, a wrapped default last-report.json must also be unwrapped").toMatchObject({ reviews: 2 });
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
