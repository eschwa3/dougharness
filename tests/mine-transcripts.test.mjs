// Card usage-path-transcript-mining: fixture test for scripts/mine-transcripts.mjs. Every input is a temp tree shaped like
// ~/.claude/projects/<slug>; nothing reads the real ~/.claude and nothing spawns a model.
//
// Contract the script must meet (the tester's reading of the card):
//   mineTranscripts({ projectsDir, boardPath, top }) -> {
//     wallBySeat:     { <seat>: { n, totalMs, medianMs } }            seat = label stage (coder, reviewer, fix ...)
//     wallBySeatSize: { <seat>: { <S|M|L|?>: { n, totalMs, medianMs } } }  size from board cards[].size, "?" when unknown
//     reruns: { resumed: [{ runId, label, agentIds }],              a label started twice in one journal
//               fixPasses: [{ label, seat, round }],                label round/pass > 1
//               failed: [{ runId, label, agentId }] }               journal `failed` lines
//     nullAgents: [{ runId, label, agentId }]                       started, no result/failed, run-file state not "progress"
//     inFlight:   [{ runId, label, agentId }]                       started, no result, run-file state "progress"
//     unused:     [{ runId, label, agentId, why }]                  why "superseded" (earlier agent of a repeated label)
//                                                                   or "string-result" (result is a plain string)
//     slowest:    [{ runId, label, agentId, ms }]                   top N by wall ms, descending
//   }
//   Wall ms: run-file workflowProgress (type workflow_agent) durationMs; agents with `cached` set are replays and add nothing;
//   an agent without durationMs (or a run with no readable run file) falls back to first-to-last "timestamp" in
//   subagents/workflows/<runId>/agent-<agentId>.jsonl.
//   CLI: node scripts/mine-transcripts.mjs --projects <dir> --board <board.json> [--top <n>] [--json]
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "mine-transcripts.mjs");

let tmp, projects, boardPath, home;
let mod;

const jl = (rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const put = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const agent = (label, agentId, state, durationMs, extra = {}) => ({
  type: "workflow_agent", label, agentId, state, startedAt: 1793000000000, ...(durationMs == null ? {} : { durationMs }), ...extra,
});
const ts = (sec) => new Date(Date.UTC(2026, 9, 20, 10, 0, sec)).toISOString();

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "doug-mine-")));
  projects = join(tmp, "projects", "-fixture-slug");
  home = join(tmp, "home");
  boardPath = join(tmp, "board.json");
  put(boardPath, JSON.stringify({ cards: [{ id: "cardA", size: "S" }, { id: "cardB", size: "M" }] }));

  // Run A: full run file. Journal order matters for the repeated lead label.
  const sa = join(projects, "sess1");
  const jA = join(sa, "subagents", "workflows", "wf_runA");
  put(join(jA, "journal.jsonl"), jl([
    { type: "launched" },
    { type: "started", key: "k1", agentId: "aC1", label: "coder:cardA:1", phase: "Coder" },
    { type: "result", key: "k1", agentId: "aC1", result: { seat: "coder" } },
    { type: "started", key: "k2", agentId: "aC2", label: "coder:cardB:1", phase: "Coder" },
    { type: "result", key: "k2", agentId: "aC2", result: { seat: "coder" } },
    { type: "started", key: "k3", agentId: "aR1", label: "reviewer:cardA:1", phase: "Reviewer" },
    { type: "result", key: "k3", agentId: "aR1", result: { seat: "reviewer" } },
    { type: "started", key: "k4", agentId: "aR2", label: "reviewer:cardA:2", phase: "Reviewer" },
    "{this is not json",
    { type: "result", key: "k4", agentId: "aR2", result: { seat: "reviewer" } },
    { type: "started", key: "k5", agentId: "aT1", label: "tester:cardA:1", phase: "Tester" },
    { type: "result", key: "k5", agentId: "aT1", result: { seat: "tester" } },
    { type: "started", key: "k6", agentId: "aG1", label: "gate:cardA:1", phase: "Gate" },
    { type: "result", key: "k6", agentId: "aG1", result: { seat: "gate" } },
    { type: "started", key: "k7", agentId: "aL1", label: "lead:cardA:1", phase: "Lead" },
    { type: "failed", key: "k7", agentId: "aL1" },
    { type: "started", key: "k8", agentId: "aL2", label: "lead:cardA:1", phase: "Lead" },
    { type: "result", key: "k8", agentId: "aL2", result: { seat: "lead" } },
    { type: "started", key: "k9", agentId: "aV1", label: "verify:cardA:1", phase: "Verify" },
    { type: "result", key: "k9", agentId: "aV1", result: "missing node_modules in the worktree" },
    { type: "started", key: "k9p", agentId: "aP1", label: "probe-a", phase: "Probe" },
    { type: "result", key: "k9p", agentId: "aP1", result: "a schema-less probe returns a string by design" },
    { type: "started", key: "k10", agentId: "aN1", label: "research:cardB:1", phase: "Research" },
    { type: "started", key: "k11", agentId: "aI1", label: "implement:cardB:1", phase: "Implement" },
    { type: "started", key: "k12", agentId: "aF1", label: "fix:cardB:2", phase: "Fix" },
    { type: "result", key: "k12", agentId: "aF1", result: { seat: "fix" } },
  ]));
  put(join(jA, "agent-aG1.jsonl"), jl([
    { type: "user", timestamp: ts(0) }, { type: "assistant", timestamp: ts(60) }, { type: "assistant", timestamp: ts(180) },
  ]));
  put(join(sa, "workflows", "wf_runA.json"), JSON.stringify({
    runId: "wf_runA", status: "completed",
    workflowProgress: [
      { type: "phase", title: "x" },
      agent("coder:cardA:1", "aC1", "done", 600000),
      agent("coder:cardB:1", "aC2", "done", 1200000),
      agent("reviewer:cardA:1", "aR1", "done", 120000),
      agent("reviewer:cardA:2", "aR2", "done", 60000),
      agent("tester:cardA:1", "aT1", "done", 999999, { cached: true }),
      agent("gate:cardA:1", "aG1", "done", null),
      agent("lead:cardA:1", "aL1", "error", null, { error: "boom" }),
      agent("lead:cardA:1", "aL2", "done", 100000),
      agent("verify:cardA:1", "aV1", "done", 5000),
      agent("research:cardB:1", "aN1", "error", null, { error: "agent type not found" }),
      agent("implement:cardB:1", "aI1", "progress", null),
      agent("fix:cardB:2", "aF1", "done", 30000),
    ],
  }));

  // Run B: the run file is corrupt, so wall time comes from the agent transcript alone.
  const sb = join(projects, "sess2");
  const jB = join(sb, "subagents", "workflows", "wf_runB");
  put(join(jB, "journal.jsonl"), jl([
    { type: "started", key: "b1", agentId: "bS1", label: "setup:cardB:1", phase: "Setup" },
    { type: "result", key: "b1", agentId: "bS1", result: { seat: "setup" } },
  ]));
  put(join(jB, "agent-bS1.jsonl"), jl([{ type: "user", timestamp: ts(0) }, { type: "assistant", timestamp: ts(30) }]));
  put(join(sb, "workflows", "wf_runB.json"), "{not json");

  // Run C: no run file yet (a live run), so its unfinished agent is in flight.
  const sc = join(projects, "sess3");
  put(join(sc, "subagents", "workflows", "wf_runC", "journal.jsonl"), jl([
    { type: "started", key: "c1", agentId: "cL1", label: "lead:cardC:1", phase: "Lead" },
  ]));

  // A decoy ~/.claude/projects for the CLI test: reading HOME instead of --projects would surface "decoy".
  const dj = join(home, ".claude", "projects", "-decoy", "sd", "subagents", "workflows", "wf_decoy");
  put(join(dj, "journal.jsonl"), jl([{ type: "started", key: "d", agentId: "dd", label: "decoyseat:decoycard:1", phase: "D" }, { type: "result", key: "d", agentId: "dd", result: {} }]));
  put(join(home, ".claude", "projects", "-decoy", "sd", "workflows", "wf_decoy.json"), JSON.stringify({ runId: "wf_decoy", workflowProgress: [agent("decoyseat:decoycard:1", "dd", "done", 99999999)] }));

  mod = await import(pathToFileURL(SCRIPT).href);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const mine = (opts = {}) => mod.mineTranscripts({ projectsDir: projects, boardPath, top: 3, ...opts });

describe("mine-transcripts", () => {
  it("M1 groups wall time by seat (label stage), not by card", () => {
    const r = mine();
    expect(r.wallBySeat.coder).toMatchObject({ n: 2, totalMs: 1800000, medianMs: 900000 });
    expect(r.wallBySeat.reviewer).toMatchObject({ n: 2, totalMs: 180000 });
    expect(Object.keys(r.wallBySeat)).not.toContain("cardA");
  });

  it("M2 splits seat wall time by card size from the board, ? when the card is unknown", () => {
    const r = mine();
    expect(r.wallBySeatSize.coder.S).toMatchObject({ n: 1, totalMs: 600000 });
    expect(r.wallBySeatSize.coder.M).toMatchObject({ n: 1, totalMs: 1200000 });
    expect(r.wallBySeatSize.reviewer.S.totalMs).toBe(180000);
    const unknown = mine({ boardPath: join(tmp, "no-such-board.json") });
    expect(unknown.wallBySeatSize.coder["?"].n).toBe(2);
  });

  it("M3 takes wall time from the run file durationMs and ignores cached replays", () => {
    const r = mine();
    expect(r.wallBySeat.tester).toBeUndefined();
    expect(r.slowest.map((s) => s.label)).not.toContain("tester:cardA:1");
  });

  it("M4 falls back to agent transcript timestamps for an untimed agent and for a corrupt run file", () => {
    const r = mine();
    expect(r.wallBySeat.gate).toMatchObject({ n: 1, totalMs: 180000 });
    expect(r.wallBySeat.setup).toMatchObject({ n: 1, totalMs: 30000 });
  });

  it("M5 lists a label started twice in one journal as a resumed re-run", () => {
    const r = mine();
    const hit = r.reruns.resumed.filter((x) => x.label === "lead:cardA:1");
    expect(hit).toHaveLength(1);
    expect(hit[0].runId).toBe("wf_runA");
    expect([...hit[0].agentIds].sort()).toEqual(["aL1", "aL2"]);
    expect(r.reruns.resumed.map((x) => x.label)).not.toContain("coder:cardA:1");
  });

  it("M6 lists agents with round or pass above 1 as fix passes, in either label family", () => {
    const labels = mine().reruns.fixPasses.map((x) => x.label).sort();
    expect(labels).toEqual(["fix:cardB:2", "reviewer:cardA:2"]);
    const rv = mine().reruns.fixPasses.find((x) => x.label === "reviewer:cardA:2");
    expect(rv).toMatchObject({ seat: "reviewer", round: 2 });
  });

  it("M7 lists journal failed lines as failed agents", () => {
    expect(mine().reruns.failed).toEqual([{ runId: "wf_runA", label: "lead:cardA:1", agentId: "aL1" }]);
  });

  it("M8 counts a started agent with no result as null, but one still in progress as in flight", () => {
    const r = mine();
    // implement:cardB:1 is in state "progress" but its run completed, so it is null, not in flight.
    expect(r.nullAgents.map((x) => x.label).sort()).toEqual(["implement:cardB:1", "research:cardB:1"]);
    expect(r.inFlight.map((x) => x.label)).toEqual(["lead:cardC:1"]);
  });

  it("M9 lists a superseded earlier agent and a plain-string seat result as unused, but not a schema-less probe string", () => {
    const u = mine().unused.map((x) => `${x.label}|${x.agentId}|${x.why}`).sort();
    expect(u).toEqual(["lead:cardA:1|aL1|superseded", "verify:cardA:1|aV1|string-result"]);
  });

  it("M10 lists the slowest steps descending and honours top", () => {
    const r = mine({ top: 2 });
    expect(r.slowest.map((s) => [s.label, s.ms])).toEqual([["coder:cardB:1", 1200000], ["coder:cardA:1", 600000]]);
    expect(mine({ top: 1 }).slowest).toHaveLength(1);
  });

  it("M11 skips a malformed journal line and a corrupt run file without throwing", () => {
    expect(() => mine()).not.toThrow();
    const r = mine();
    expect(r.wallBySeat.reviewer.n).toBe(2);
  });

  it("M12 the CLI reads only --projects, prints JSON with --json, and honours --top", () => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: "", CLAUDE_CODE_SESSION_ID: "" };
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--projects", projects, "--board", boardPath, ...args], { encoding: "utf8", env });
    const j = run("--json", "--top", "1");
    expect(j.status).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.slowest).toHaveLength(1);
    expect(out.slowest[0].label).toBe("coder:cardB:1");
    expect(out.wallBySeat.coder.n).toBe(2);
    expect(j.stdout).not.toContain("decoy");
    const h = run();
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("coder");
    expect(h.stdout).not.toContain("decoy");
  });
});
