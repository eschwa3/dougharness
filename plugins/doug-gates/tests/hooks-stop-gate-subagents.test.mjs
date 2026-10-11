import { describe, it, expect } from "vitest";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { makeProject, runHookScript } from "./helpers.mjs";
// card stop-gate-skips-orphan-subagent-stops: the state file the test seeds directly is written/read through
// loadState/saveState (the module's own default shape), never a guessed JSON literal.
import { loadState, saveState } from "../lib/state.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { computeTree, readRecord as readTreeRecord, removeRecord as removeTreeRecord, writeRecord as writeTreeRecord } from "../lib/verified-tree.mjs";

// card stop-gate-read-only-subagent-skip: the other half of the 2026-09-16 process storm — a researcher (or
// other read-only-by-policy agent) that edited nothing still ran the full verification suite at its own
// SubagentStop, then obeyed the resulting block by rerunning the suite itself. A SubagentStop whose agent made
// no change (per the run trace, or per its agent_type when the trace cannot vouch for it) skips step 3's
// commands and step 3b's evidence check; steps 1, 1 (committed), 1b, and 2 still run, since they are about the
// tree, not the agent, and a skip never takes or waits on gate.lock either.
describe("card stop-gate-read-only-subagent-skip", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);

  function makeRunsConfig(extra = {}) {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
  }

  // A committed-base project with one file this session itself edited (edit-loop records it) — the same
  // "case 2" shape stop-gate-process-storm's own tests build on, so onlyIfEdited's anyChange is true and the
  // gate reaches the read-only-agent check this card adds, rather than exiting before it on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const traceFilePath = (dir, sessionId = "test-session") => join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);

  // Writes trace lines directly (not through the trace hook), each filled out to the full traceLine shape
  // (lib/trace.mjs) so the reader under test never sees a line shaped differently from a real one.
  function writeTrace(dir, lines, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const full = lines.map((l) => ({
      t: new Date().toISOString(),
      event: null,
      session: sessionId,
      agent: null,
      agentType: null,
      tool: null,
      toolUseId: null,
      detail: null,
      ok: null,
      tokens: null,
      context: null,
      reason: null,
      ...l,
    }));
    writeFileSync(file, full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function tracedLines(dir, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  const start = (agent, agentType) => ({ event: "SubagentStart", agent, agentType });
  const pre = (agent, agentType, tool) => ({ event: "PreToolUse", agent, agentType, tool });
  const post = (agent, agentType, tool, ok = true) => ({ event: "PostToolUse", agent, agentType, tool, ok });

  it("T1 a researcher with only Read/WebFetch lines skips: allow, no commands run, a no-agent-changes trace line, state.verified untouched", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      pre("ag1", "researcher", "WebFetch"),
      post("ag1", "researcher", "WebFetch", true),
    ]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir), "a no-change agent must not run the verification commands").toBe(0);
    const lines = tracedLines(dir);
    expect(lines.some((l) => l.event === "SubagentStop" && l.reason === "no-agent-changes"), "the skip must append a trace line with reason no-agent-changes").toBe(true);
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.verified == null, "a skipped run verifies nothing, so it must not record state.verified").toBe(true);
  });

  it("T2 the same researcher with one PreToolUse Bash line added runs the commands: Bash can change files", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      pre("ag1", "researcher", "Bash"),
    ]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("M-T1 the same researcher with one PreToolUse Monitor line added runs the commands: Monitor runs a shell command too", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      pre("ag1", "researcher", "Monitor"),
    ]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("M-T2 a researcher with only a PostToolUse Monitor line with ok: false runs the commands: Monitor counts whatever ok", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), post("ag1", "researcher", "Monitor", false)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T3 a coder with a successful PostToolUse Edit runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), pre("ag1", "coder", "Edit"), post("ag1", "coder", "Edit", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T4 a type-only match (reviewer) with a successful PostToolUse Edit still runs the commands: the trace wins over the type", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "reviewer"), pre("ag1", "reviewer", "Edit"), post("ag1", "reviewer", "Edit", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "reviewer" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T5 a coder with only Read lines skips: the trace rule decides, independent of type", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), pre("ag1", "coder", "Read"), post("ag1", "coder", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir)).toBe(0);
  });

  it("T6 with no trace file at all, a read-only type (Explore) skips and a non-read-only type (coder) runs", () => {
    const explore = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explore" }, { dir: explore });
    expect(r1.json).toBeNull();
    expect(runsCount(explore)).toBe(0);

    const coder = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir: coder });
    expect(runsCount(coder)).toBe(1);
  });

  it("T7 a trace file with no SubagentStart for this agent id cannot vouch for it: a non-read-only type still runs, even with only Read lines", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // Only another agent's SubagentStart is on file; as far as the trace can show, ag1 itself never started.
    writeTrace(dir, [start("other", "coder"), pre("ag1", "coder", "Read"), post("ag1", "coder", "Read", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T8 a failed Write (ok: false) is not a change and skips; the same Write with ok: null counts as a change and runs", () => {
    const skipDir = makeEditedProject(makeRunsConfig());
    writeTrace(skipDir, [start("ag1", "coder"), pre("ag1", "coder", "Write"), post("ag1", "coder", "Write", false)]);
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir: skipDir });
    expect(r1.json).toBeNull();
    expect(runsCount(skipDir)).toBe(0);

    const runDir = makeEditedProject(makeRunsConfig());
    writeTrace(runDir, [start("ag1", "coder"), pre("ag1", "coder", "Write"), post("ag1", "coder", "Write", null)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir: runDir });
    expect(runsCount(runDir)).toBe(1);
  });

  it("T9 the protected-path scan still runs on a skip: a researcher with only Read lines still gets blocked, with no commands run", () => {
    const dir = makeProject({ config: makeRunsConfig(), git: true });
    writeFileSync(join(dir, ".env"), "SECRET=1"); // dirty, protected, and never touched by the Edit tool
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified: .env");
    expect(runsCount(dir), "the scans still run on a skip, but the verification commands themselves must not").toBe(0);
  });

  it("T10 another agent's Edit line does not count against this agent: ag1 (Read only) skips even though ag2 edited", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      start("ag2", "coder"),
      pre("ag2", "coder", "Edit"),
      post("ag2", "coder", "Edit", true),
    ]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir)).toBe(0);
  });

  it("T11 a skip never takes or waits on gate.lock: a live lock (this test process's own pid) is left byte-identical, and the gate allows well under the wait it would cost a regression", () => {
    // timeoutMs is set high (15000) so a regression that waits on the lock blows well past the
    // bound below (8000ms); spawnSync blocks the event loop, so vitest's own testTimeout cannot
    // interrupt the hook run — the elapsed bound is what would actually catch the regression,
    // instead of racing a tight bound against load-induced hook startup jitter (observed 1229ms
    // startup alone under load).
    const dir = makeEditedProject(makeRunsConfig({ stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 15000, requireEvidence: false } }));
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const lockPath = join(dir, ".doug/.state/gate.lock");
    const lockContent = JSON.stringify({ pid: process.pid, session: "someone-else", at: Date.now() });
    writeFileSync(lockPath, lockContent);
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    const elapsed = Date.now() - started;
    expect(r.json).toBeNull();
    expect(elapsed, "a skip must never wait on gate.lock, live or not").toBeLessThan(8000);
    expect(runsCount(dir)).toBe(0);
    expect(existsSync(lockPath), "a skip must never touch a lock it does not own").toBe(true);
    expect(readFileSync(lockPath, "utf8"), "a skip must never rewrite or take over a lock it does not own").toBe(lockContent);
  });

  it("T12 the skip is SubagentStop-only: a main Stop with the same no-change trace still runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // ag1 has stopped (a hook stop line plus the gate's own allowed line, card
    // stop-gate-defers-while-subagent-in-flight) so this main Stop is not deferred on that account; the point
    // under test is that the no-change skip itself never applies outside a SubagentStop.
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      { event: "SubagentStop", agent: "ag1", agentType: "researcher" },
      { event: "SubagentStop", agent: "ag1", agentType: "researcher", decision: "allow", reason: "no-agent-changes" },
    ]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T13 the evidence check (3b) is skipped too: requireEvidence on, with no recorded test command, still allows on a skip", () => {
    const dir = makeEditedProject(
      makeRunsConfig({ stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: true } }),
    );
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir)).toBe(0);
  });

  // R2: agentMadeNoChanges' catch returns false (run the gate), not true (skip it). readTrace (lib/trace.mjs:140)
  // calls readFileSync(file, "utf8") outside any try/catch of its own, and readFileSync throws EISDIR when
  // `file` names a directory; that propagates up through stop-gate.mjs:347 into the try at 342, caught by the
  // catch at 360. Proven directly: `node -e "require('fs').readFileSync('.', 'utf8')"` throws
  // "EISDIR: illegal operation on a directory, read". So a directory in place of the trace file is a real,
  // reachable way to make the reader's try body throw, and T14 is not vacuous against R2.
  it("T14 a trace path that exists as a directory: a coder's SubagentStop still runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    mkdirSync(traceFilePath(dir), { recursive: true });
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(
      runsCount(dir),
      "a directory at the trace path must make readTrace throw, be caught, and fall through to running the gate (false), never skip it (true)",
    ).toBe(1);
  });

  it("T15 a researcher skip with a dirty protected path still blocks and increments state.agentBlocks[ag1]", () => {
    const seededDir = makeProject({ config: makeRunsConfig(), git: true });
    writeFileSync(join(seededDir, ".env"), "SECRET=1");
    writeTrace(seededDir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    saveState(seededDir, "test-session", { ...loadState(seededDir, "test-session"), agentBlocks: { ag1: 1 } });
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir: seededDir });
    expect(r1.json.decision).toBe("block");
    expect(runsCount(seededDir), "the skip must still keep the verification commands from running").toBe(0);
    const seededState = loadState(seededDir, "test-session");
    expect(seededState.agentBlocks.ag1, "a seeded prior count (1) must go up by one, to 2, not stay unset").toBe(2);

    const freshDir = makeProject({ config: makeRunsConfig(), git: true });
    writeFileSync(join(freshDir, ".env"), "SECRET=1");
    writeTrace(freshDir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir: freshDir });
    expect(r2.json.decision).toBe("block");
    const freshState = loadState(freshDir, "test-session");
    expect(freshState.agentBlocks.ag1, "with no prior count, a block on a skip must still record 1").toBe(1);
  });

  it("T16 a green researcher skip resets a previously seeded state.agentBlocks count to 0", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    saveState(dir, "test-session", { ...loadState(dir, "test-session"), agentBlocks: { ag1: 2 } });
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    const state = loadState(dir, "test-session");
    expect(state.agentBlocks.ag1, "a green skip must reset a previously seeded agentBlocks count to 0").toBe(0);
  });

  it("T17 a green researcher skip records state.lastGate.skipped as no-agent-changes", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    const state = loadState(dir, "test-session");
    expect(state.lastGate && state.lastGate.skipped, "a green skip must record lastGate.skipped as no-agent-changes").toBe("no-agent-changes");
  });

  it("T18 trace.enabled false with a no-change trace file on disk: a coder still runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    writeTrace(dir, [start("ag1", "coder"), pre("ag1", "coder", "Read"), post("ag1", "coder", "Read", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(
      runsCount(dir),
      "trace.enabled false must be honoured over a trace file's presence on disk; falling to the type fallback (coder is not read-only) must run the commands",
    ).toBe(1);
  });
});

// card stop-gate-skips-orphan-subagent-stops: Claude Code fires SubagentStop for agents that never had a
// SubagentStart in this session's trace, carry no agent_type, and have no readable agent_transcript_path
// (research note docs/research/gate-output-names-failures.md Q1). Today such an orphan gets subagent.type
// "subagent" (stop-gate.mjs:599) and agentMadeNoChanges falls back to READ_ONLY_AGENT_TYPES, which does not
// include "subagent", so the orphan runs the full verification suite. No implementation exists yet; O1, O4's
// absent-transcript half, and O5/O6's negative stderr checks are expected to be red until the coder adds the
// orphan check (isOrphanSubagentStop) ahead of the partial-claim block, the tree scans, the deferral logic,
// gate.lock, skipVerification, and runVerification.
describe("card stop-gate-skips-orphan-subagent-stops", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);

  function makeRunsConfig(extra = {}) {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
  }

  // Same "case 2" shape as the read-only-subagent-skip block above: a committed base plus one file this
  // session itself edited, so onlyIfEdited's anyChange is true and the gate reaches the orphan check instead
  // of exiting before it on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const traceFilePath = (dir, sessionId = "test-session") => join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);

  function writeTrace(dir, lines, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const full = lines.map((l) => ({
      t: new Date().toISOString(),
      event: null,
      session: sessionId,
      agent: null,
      agentType: null,
      tool: null,
      toolUseId: null,
      detail: null,
      ok: null,
      tokens: null,
      context: null,
      reason: null,
      ...l,
    }));
    writeFileSync(file, full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function tracedLines(dir, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  const start = (agent, agentType) => ({ event: "SubagentStart", agent, agentType });
  const pre = (agent, agentType, tool) => ({ event: "PreToolUse", agent, agentType, tool });
  const post = (agent, agentType, tool, ok = true) => ({ event: "PostToolUse", agent, agentType, tool, ok });

  // The real agent in flight every test's fixture shares (brief: "start('ag1','coder') plus an Edit pre/post
  // for ag1, so the real agent is in flight and ag1 is not 'no changes'").
  const realAgentTrace = () => [start("ag1", "coder"), pre("ag1", "coder", "Edit"), post("ag1", "coder", "Edit", true)];

  // Seeds the session state file through loadState/saveState (never a guessed JSON literal), with
  // deferrals: 3 so O1 can pin that an orphan skip never persists R6's in-memory deferrals reset.
  function seedState(dir, sessionId = "test-session") {
    saveState(dir, sessionId, { ...loadState(dir, sessionId), deferrals: 3 });
  }

  const ORPHAN_SENTENCE = /orphan/i;

  it("O1 the orphan shape skips: allow, no commands, stderr names the id, state and blocks.jsonl untouched, one decision-tagged trace line", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, realAgentTrace());
    seedState(dir);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir });
    expect(r.json, "orphan skip: a plain allow, no systemMessage or block").toBeNull();
    expect(runsCount(dir), "orphan skip: the verification commands must not run").toBe(0);
    expect(r.stderr, "orphan skip: one stderr line must name the orphan id").toContain("orphan-1");
    expect(existsSync(join(dir, ".doug/.state/gate.lock")), "orphan skip: must never take gate.lock").toBe(false);
    const state = loadState(dir, "test-session");
    expect(state.verified == null, "orphan skip: must not touch state.verified").toBe(true);
    expect(state.deferrals, "orphan skip: must not saveState (R6's in-memory deferrals reset stays unpersisted)").toBe(3);
    expect(state.agentBlocks && state.agentBlocks["orphan-1"], "orphan skip: must not record an agentBlocks entry").toBeUndefined();
    const blocksPath = join(dir, ".doug/.state/blocks.jsonl");
    expect(
      !existsSync(blocksPath) || !readFileSync(blocksPath, "utf8").includes("orphan-1"),
      "orphan skip: must write no blocks.jsonl line (never calls logBlock)",
    ).toBe(true);
    const lines = tracedLines(dir);
    const line = lines.find((l) => l.event === "SubagentStop" && l.agent === "orphan-1");
    expect(line, "orphan skip: must still append a decision-tagged SubagentStop trace line (D1)").toBeTruthy();
    expect(line.decision, "orphan skip: the trace line's decision must be allow").toBe("allow");
    expect(line.reason, "orphan skip: the trace line's reason must be orphan-subagent-stop").toBe("orphan-subagent-stop");
  });

  it("O2 an agent with a start line does not skip: the trace vouches for it even with no agent_type", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, realAgentTrace());
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1" }, { dir });
    expect(runsCount(dir), "condition 1 (no SubagentStart line): an agent with a start line must run as today").toBe(1);
    expect(ORPHAN_SENTENCE.test(r.stderr), "condition 1: an agent with a start line must not get the orphan stderr line").toBe(false);
  });

  it("O3 an orphan with an agent_type does not skip", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, realAgentTrace());
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_type: "coder" }, { dir });
    expect(runsCount(dir), "condition 2 (no agent_type): an orphan-shaped id with an agent_type must run as today").toBe(1);
  });

  it("O3b an empty-string agent_type and a null agent_type both count as absent, so the orphan still skips", () => {
    const emptyDir = makeEditedProject(makeRunsConfig());
    writeTrace(emptyDir, realAgentTrace());
    const r1 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_type: "" },
      { dir: emptyDir },
    );
    expect(
      runsCount(emptyDir),
      "condition 2 (agent_type absent): an empty-string agent_type counts as absent, so the orphan skips (verification commands must not run)",
    ).toBe(0);
    expect(r1.stderr, "condition 2 (agent_type ''): the skip still names the orphan id").toContain("orphan-1");

    const nullDir = makeEditedProject(makeRunsConfig());
    writeTrace(nullDir, realAgentTrace());
    const r2 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_type: null },
      { dir: nullDir },
    );
    expect(
      runsCount(nullDir),
      "condition 2 (agent_type absent): a null agent_type counts as absent, so the orphan skips (verification commands must not run)",
    ).toBe(0);
    expect(r2.stderr, "condition 2 (agent_type null): the skip still names the orphan id").toContain("orphan-1");
  });

  it("O4 an orphan with a readable agent_transcript_path does not skip; the same id with an unreadable path still skips", () => {
    const readableDir = makeEditedProject(makeRunsConfig());
    writeTrace(readableDir, realAgentTrace());
    const transcriptPath = join(readableDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { usage: {} } }) + "\n");
    const r1 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_transcript_path: transcriptPath },
      { dir: readableDir },
    );
    expect(runsCount(readableDir), "condition 3 (readable transcript): a readable agent_transcript_path must run as today").toBe(1);

    const unreadableDir = makeEditedProject(makeRunsConfig());
    writeTrace(unreadableDir, realAgentTrace());
    const r2 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_transcript_path: join(unreadableDir, "nope.jsonl") },
      { dir: unreadableDir },
    );
    expect(runsCount(unreadableDir), "condition 3 (converse): an absent agent_transcript_path still skips").toBe(0);
    expect(r2.stderr, "condition 3 (converse): the skip still names the id").toContain("orphan-1");
  });

  it("O5 trace disabled, and trace enabled with no trace file at all, both run as today", () => {
    const disabledDir = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir: disabledDir });
    expect(runsCount(disabledDir), "trace-enabled precondition: trace.enabled false must fail closed onto today's behaviour").toBe(1);
    expect(ORPHAN_SENTENCE.test(r1.stderr), "trace.enabled false: must not get the orphan stderr line").toBe(false);

    const noFileDir = makeEditedProject(makeRunsConfig());
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir: noFileDir });
    expect(runsCount(noFileDir), "trace-enabled precondition: a missing trace file must fail closed onto today's behaviour").toBe(1);
    expect(ORPHAN_SENTENCE.test(r2.stderr), "missing trace file: must not get the orphan stderr line").toBe(false);
  });

  it("O6 the lead's main Stop is unchanged: the orphan check is SubagentStop-only", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [...realAgentTrace(), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "subagent-only guard: a main Stop must run the verification commands as today").toBe(1);
    expect(ORPHAN_SENTENCE.test(r.stderr), "subagent-only guard: a main Stop must never get the orphan stderr line").toBe(false);
  });

  it("O7 a throw inside the orphan check fails closed onto today's behaviour, never open", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // No writeTrace call: instead the session trace path itself is a directory, so reading it (readFileSync)
    // throws (EISDIR) inside isOrphanSubagentStop's try, which must be caught and read as "not an orphan".
    mkdirSync(traceFilePath(dir), { recursive: true });
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir });
    expect(
      r.status,
      "a throw inside the orphan check fails closed onto today's behaviour, never open: the hook still exits 0",
    ).toBe(0);
    expect(
      runsCount(dir),
      "a throw inside the orphan check fails closed onto today's behaviour, never open: the gate still runs as today (the verification commands still run)",
    ).toBe(1);
    expect(
      r.stderr,
      "a throw inside the orphan check fails closed onto today's behaviour, never open: no orphan stderr line is written",
    ).not.toContain("orphan agent");
  });
});

// card stop-gate-defers-while-subagent-in-flight: the Stop hook fires whenever the lead's turn ends, including
// when it ends only to wait for a background tester, coder, or reviewer. Today the main Stop treats that as a
// claim of done and runs the full verification suite against a tree a subagent may be mid-edit. This card makes
// a main Stop (never a SubagentStop) with a subagent of this session in flight skip the commands and the
// evidence check, allow with one systemMessage naming the agents in flight, write no blocks.jsonl line, and
// never touch state.stopBlocks/state.verified — deferring to the first Stop after the last SubagentStop. No
// implementation exists yet (subagentInFlight, stop-gate.mjs:216-232, is read only by contextNotice); every
// test below is expected to be red until the coder adds the deferral and the decision-tagged SubagentStop trace
// lines (D1) it depends on for rule B.
describe("card stop-gate-defers-while-subagent-in-flight", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);

  function makeRunsConfig(extra = {}) {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
  }

  // Same "case 2" shape stop-gate-read-only-subagent-skip's own makeEditedProject builds on: a committed base
  // plus one file this session itself edited, so onlyIfEdited's anyChange is true and a main Stop reaches the
  // deferral check this card adds, rather than exiting before it on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const traceFilePath = (dir, sessionId = "test-session") => join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);

  function writeTrace(dir, lines, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const full = lines.map((l) => ({
      t: new Date().toISOString(),
      event: null,
      session: sessionId,
      agent: null,
      agentType: null,
      tool: null,
      toolUseId: null,
      detail: null,
      ok: null,
      tokens: null,
      context: null,
      reason: null,
      ...l,
    }));
    writeFileSync(file, full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function tracedLines(dir, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  const start = (agent, agentType) => ({ event: "SubagentStart", agent, agentType });
  // The trace hook's own SubagentStop line (trace.mjs), which carries no `decision` field (F2 in the brief) —
  // only the gate itself, once this card lands, tags one with "allow" or "block" (D1).
  const hookStop = (agent, agentType) => ({ event: "SubagentStop", agent, agentType });

  const LEDGER_RELPATH = ".doug/.state/blocks.jsonl";
  const readLedger = (dir) => {
    const file = join(dir, LEDGER_RELPATH);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const sessionStateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));

  it("G1 a Stop with one in-flight agent (SubagentStart only) allows without running commands, naming the agent and deferring, with no block recorded", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder")]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("coder:ag1");
    expect(r.json.systemMessage.toLowerCase()).toContain("deferred");
    expect(r.json.systemMessage, "card stop-gate-defer-read-only-quiet: the message says what is pending, not an alarm").not.toContain("Do not treat this work as done");
    expect(runsCount(dir), "the verification commands must not run while the agent is in flight").toBe(0);
    expect(readLedger(dir), "a deferral must write no blocks.jsonl line").toEqual([]);
    const state = sessionStateOf(dir);
    expect(state.stopBlocks, "a deferral must never count toward maxBlocks").toBe(0);
    expect(state.verified == null, "a deferral verifies nothing, so it must not record state.verified").toBe(true);
  });

  it("G2 a Stop after that agent's allowed SubagentStop runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "the agent has an allowed SubagentStop, so it is gone and the full gate runs").toBe(1);
  });

  it("G2b rule A in isolation: only gate-written lines (no decision-less hook line at all — a project whose trace hook is not wired to SubagentStop), a decision: allow among them still ends the flight", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // No decision-less line here at all, so rule B alone (0 decision-less > 1 block => false) would read this
    // agent as still in flight; only rule A (the decision: "allow" line) can end it.
    writeTrace(dir, [
      start("ag1", "coder"),
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "block" },
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" },
    ]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "rule A alone must read this agent as gone").toBe(1);
  });

  it("G3 a Stop after only a BLOCKED SubagentStop still defers: a blocked agent is still working", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "block" }]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("coder:ag1");
    expect(runsCount(dir)).toBe(0);
    expect(readLedger(dir)).toEqual([]);
    const state = sessionStateOf(dir);
    expect(state.stopBlocks).toBe(0);
    expect(state.verified == null).toBe(true);
  });

  it("G4 rule B: more stop events than blocks means a stop the gate did not block — the agent is gone even with no matching allow line", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // Two stop events for ag1 (the trace hook's own line, undecorated, per stop) but only one decision:"block"
    // line among them: 2 no-decision lines > 1 block line, so rule B reads the agent as stopped (a fail-open or
    // an unwired gate on the second attempt), not still in flight.
    writeTrace(dir, [
      start("ag1", "coder"),
      hookStop("ag1", "coder"),
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "block" },
      hookStop("ag1", "coder"),
    ]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "rule B must read the agent as gone here").toBe(1);
  });

  it("G5 fail closed: a disabled trace, a directory at the trace path, and a garbage trace file all run the gate as today", () => {
    const disabled = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    writeTrace(disabled, [start("ag1", "coder")]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: disabled });
    expect(runsCount(disabled), "trace.enabled: false must never defer").toBe(1);

    const dirBlocked = makeEditedProject(makeRunsConfig());
    mkdirSync(traceFilePath(dirBlocked), { recursive: true }); // a directory where the trace file should be
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dirBlocked });
    expect(runsCount(dirBlocked), "an unreadable trace file must fail closed onto the full gate").toBe(1);

    const garbage = makeEditedProject(makeRunsConfig());
    mkdirSync(dirname(traceFilePath(garbage)), { recursive: true });
    writeFileSync(traceFilePath(garbage), "not json at all\n{{{\n");
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: garbage });
    expect(runsCount(garbage), "a garbage trace file must fail closed onto the full gate").toBe(1);
  });

  it("G6 not counted: three deferred Stops in a row never touch state.stopBlocks or blocks.jsonl, so the first real block after the agent stops still reads (1/3)", () => {
    const dir = makeEditedProject(makeRunsConfig({ commands: { "test:unit": "exit 1" } }));
    writeTrace(dir, [start("ag1", "coder")]);
    for (let i = 0; i < 3; i++) {
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json?.decision, `deferred Stop #${i + 1} must not itself be a block`).toBeUndefined();
    }
    expect(readLedger(dir), "none of the three deferrals may write a ledger line").toEqual([]);
    expect(sessionStateOf(dir).stopBlocks, "none of the three deferrals may count toward maxBlocks").toBe(0);

    writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("(1/3)");
    expect(readLedger(dir)).toHaveLength(1);
  });

  it("G7 end to end through the real hooks: the gate's own SubagentStop trace lines carry decision block then allow, and a main Stop defers in between", () => {
    const dir = makeEditedProject(
      makeRunsConfig({
        commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x'); process.exit(1)"` },
      }),
    );
    runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "tester" }, { dir });
    // A change line for ag1 so the read-only-subagent-skip card (stop-gate-read-only-subagent-skip) does not
    // itself skip verification here — this card's deferral is what is under test, not that one.
    runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "tester", tool_name: "Edit", tool_response: {} }, { dir });

    const blocked = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" }, { dir });
    expect(blocked.json.decision).toBe("block");
    expect(runsCount(dir)).toBe(1);
    runHookScript("trace", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" }, { dir }); // the hook's own undecorated line

    const deferred = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(deferred.json.decision, "one blocked stop event balanced by one undecorated stop event is still in flight (rule B)").toBeUndefined();
    expect(runsCount(dir), "a deferred main Stop must not run the commands").toBe(1);

    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify(makeRunsConfig()), // the command now passes
    );
    const allowed = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" }, { dir });
    expect(allowed.json).toBeNull();
    expect(runsCount(dir)).toBe(2);

    // The allowed SubagentStop's own green run just recorded state.verified for this exact tree (card
    // stop-gate-process-storm, case 2); appending to the file the session already edited defeats that
    // pre-existing verified-unchanged skip, so the final Stop below exercises this card's own point — the
    // first Stop after the agent stops runs the full gate — rather than a different skip landing first.
    appendFileSync(join(dir, "src/a.ts"), "\nmore edits this session");
    const runsBeforeFinal = runsCount(dir);
    const finalStop = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(
      finalStop.json === null || !(finalStop.json.systemMessage || "").includes("Verification deferred"),
      "the agent's SubagentStop was allowed, so it is gone and this Stop must not defer",
    ).toBe(true);
    expect(runsCount(dir), "the main Stop now runs the commands").toBe(runsBeforeFinal + 1);

    const gateLines = tracedLines(dir).filter((l) => l.event === "SubagentStop" && l.agent === "ag1" && "decision" in l);
    expect(gateLines.map((l) => l.decision)).toEqual(["block", "allow"]);
  });

  it("G8 the three existing reason-carrying SubagentStop trace lines (verified-unchanged, no-agent-changes, tests_red_by_design) still carry their reasons, now alongside decision: allow", () => {
    // no-agent-changes (card stop-gate-read-only-subagent-skip, T1): a researcher with only Read lines.
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), { event: "PreToolUse", agent: "ag1", agentType: "researcher", tool: "Read" }, { event: "PostToolUse", agent: "ag1", agentType: "researcher", tool: "Read", ok: true }]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    const noAgentChanges = tracedLines(dir).find((l) => l.event === "SubagentStop" && l.reason === "no-agent-changes");
    expect(noAgentChanges, "the no-agent-changes trace line must still be written").toBeTruthy();
    expect(noAgentChanges.decision, "it is an allow path, so it must now also carry decision: allow").toBe("allow");

    // verified-unchanged (card stop-gate-process-storm, case 2): a second SubagentStop against an
    // already-verified tree.
    const dir2 = makeEditedProject(makeRunsConfig());
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dir2 }); // records state.verified on the main Stop
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "coder" }, { dir: dir2 });
    expect(r2.json).toBeNull();
    const verifiedUnchanged = tracedLines(dir2).find((l) => l.event === "SubagentStop" && l.reason === "verified-unchanged");
    expect(verifiedUnchanged, "the verified-unchanged trace line must still be written").toBeTruthy();
    expect(verifiedUnchanged.decision).toBe("allow");

    // tests_red_by_design (card subagent-stop-gate-tester-red): a tester's claim covering the one failing file.
    const dir3 = makeEditedProject(makeRunsConfig({ commands: { "test:unit": "echo ' FAIL  src/a.test.mjs > it'; exit 1" } }));
    writeFileSync(join(dir3, "src/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "src/a.test.mjs" } }, { dir: dir3 });
    const claimInput = {
      hook_event_name: "SubagentStop",
      agent_id: "ag3",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${JSON.stringify({ tests_red_by_design: ["src/a.test.mjs"] })}`,
    };
    const r3 = runHookScript("stop-gate", claimInput, { dir: dir3 });
    expect(r3.json.decision).toBeUndefined();
    const redByDesign = tracedLines(dir3).find((l) => l.event === "SubagentStop" && l.reason === "tests_red_by_design");
    expect(redByDesign, "the tests_red_by_design trace line must still be written").toBeTruthy();
    expect(redByDesign.decision).toBe("allow");
  });

  it("G9 (review major 2) a tree problem found while an agent is in flight still blocks: the deferral never swallows a real protected-path hit", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeFileSync(join(dir, ".env"), "SECRET=1"); // dirty, protected (baseConfig.protectedPaths), never touched by the Edit tool
    writeTrace(dir, [start("ag1", "coder")]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified");
    expect(readLedger(dir), "a real block, not a deferral, so it is logged exactly once").toHaveLength(1);
  });

  it("G10 (review minor 3) a later SubagentStart for the same id restarts the clock: an earlier allowed SubagentStop before it does not count", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "coder"),
      hookStop("ag1", "coder"),
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" },
      start("ag1", "coder"), // ag1 started again; the allow above predates this start and must not count for it
    ]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("Verification deferred");
    expect(runsCount(dir)).toBe(0);
  });

  // card test-count-ratchet, review B1: the count check's "did not run" note must not be a decision-less
  // SubagentStop line, or subagentsInFlight (rule B: more undecided stop lines than blocked ones) reads a
  // blocked agent as gone and the lead's Stop stops deferring. The single-command deferral tests above never
  // had a green command beside the failing one, so none reached the note.
  describe("count-check note does not end an agent's flight (card test-count-ratchet, review B1)", () => {
    const twoCommands = (greenCommand) =>
      makeRunsConfig({
        commands: { typecheck: greenCommand, "test:unit": "exit 1" },
        stopGate: { commands: ["typecheck", "test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      });

    function blockedThenLeadStop(greenCommand) {
      const dir = makeEditedProject(twoCommands(greenCommand));
      runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "coder" }, { dir });
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", tool_name: "Edit", tool_response: {} }, { dir });
      const sub = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
      expect(sub.json && sub.json.decision, "fixture check: the failing test:unit blocks the subagent").toBe("block");
      const undecidedAfterGate = tracedLines(dir).filter((l) => l.event === "SubagentStop" && l.agent === "ag1" && l.decision == null);
      runHookScript("trace", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir }); // the trace hook's own undecorated line
      const lead = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      return { dir, undecidedAfterGate, lead };
    }

    it("B1 a green command with no summary beside a red one: the lead's Stop still defers", () => {
      const { lead } = blockedThenLeadStop("exit 0");
      expect(lead.json.decision, "the blocked coder is still working, so the lead's Stop must defer, not block").toBeUndefined();
      expect(lead.json.systemMessage).toContain("Verification deferred");
      expect(lead.json.systemMessage).toContain("coder:ag1");
    });

    it("B1 mechanism: the blocked SubagentStop leaves no SubagentStop line lacking a decision for that agent", () => {
      const { undecidedAfterGate } = blockedThenLeadStop("exit 0");
      expect(undecidedAfterGate, "only the trace hook writes decision-less SubagentStop lines").toEqual([]);
    });

    it("B1 sibling (no baseline): a green command that prints a summary but has no baseline still leaves the flight standing", () => {
      const { lead, undecidedAfterGate } = blockedThenLeadStop("printf ' Tests  5 passed (5)\\n'");
      expect(undecidedAfterGate).toEqual([]);
      expect(lead.json.decision).toBeUndefined();
      expect(lead.json.systemMessage).toContain("Verification deferred");
      expect(lead.json.systemMessage).toContain("coder:ag1");
    });
  });

  // card stop-gate-defer-read-only-quiet: a repeat deferral (same in-flight set, same tree) emits no
  // systemMessage, so a deferred Stop is judged by the message when there is one (it must say "deferred") and
  // by the runsCount/state assertions around the call otherwise. `first` demands the message: the first
  // deferred Stop of a run is never silent.
  function expectDeferral(r, first, label) {
    const m = r.json?.systemMessage;
    if (first) expect(m, label).toBeDefined();
    if (m !== undefined) expect(m.toLowerCase(), label).toContain("deferred");
  }

  describe("card stop-gate-deferral-cap", () => {
    // Same shape as makeRunsConfig(extra) above, but replacing the whole stopGate object (extra spreads over
    // top-level config keys, not merging inside stopGate) so a test can add maxDeferrals while keeping the
    // other stopGate settings makeRunsConfig's default already carries.
    function withMaxDeferrals(maxDeferrals, extra = {}, stopGateExtra = {}) {
      return makeRunsConfig({
        stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false, maxDeferrals, ...stopGateExtra },
        ...extra,
      });
    }

    it("H1 default cap (no stopGate.maxDeferrals set): the 10th consecutive deferred Stop runs the full gate", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder")]);
      for (let i = 1; i <= 9; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json?.decision, `Stop #${i} (below the default cap of 10) must not itself be a block`).toBeUndefined();
        expectDeferral(r, i === 1, `Stop #${i} (below the default cap of 10) must still defer`);
        expect(runsCount(dir), `Stop #${i} must not run the commands yet`).toBe(0);
      }
      const r10 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 10th consecutive deferred Stop must hit the default cap (10) and run the commands").toBe(1);
      expect(r10.json.systemMessage, "the cap message must say the cap was reached").toContain("Deferral cap reached");
      expect(r10.json.systemMessage, "the cap message must name the default cap (10)").toContain("10");
      expect(r10.json.systemMessage, "the cap message must name the agent still in flight (agentLabel form)").toContain("coder:ag1");
      expect(sessionStateOf(dir).deferrals, "the counter must reset to 0 once the cap makes the gate run").toBe(0);
    });

    it("H2 a configured stopGate.maxDeferrals (3) runs the commands on the 3rd consecutive deferred Stop, not the default 10th", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      for (let i = 1; i <= 2; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expectDeferral(r, i === 1, `Stop #${i} (below maxDeferrals 3) must still defer`);
        expect(runsCount(dir), `Stop #${i} must not run the commands yet`).toBe(0);
      }
      const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd consecutive deferred Stop must hit maxDeferrals 3 and run the commands").toBe(1);
      expect(r3.json.systemMessage, "the cap message must say the cap was reached").toContain("Deferral cap reached");
    });

    it("H3 a SubagentStop of this session resets the counter, so the cap counts again from 1 afterwards", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // ag1 stays in flight (the trace is untouched); only a SubagentStop event of this session runs, for a
      // different agent (ag2), and it alone must reset the counter (rule R6).
      runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "researcher" }, { dir });
      expect(sessionStateOf(dir).deferrals, "a SubagentStop of this session must reset the counter to 0 right away").toBe(0);

      const runsBefore = runsCount(dir);
      for (let i = 1; i <= 2; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expectDeferral(r, false, `Stop #${i} after the reset must still defer: ag1 never stopped, and the count restarted from 0`);
      }
      expect(runsCount(dir), "the two main Stops after the reset must not run the commands (count restarted, not carried over as 2+2)").toBe(runsBefore);
      const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd main Stop after the reset must hit maxDeferrals 3 (counting from the reset) and run").toBe(runsBefore + 1);
    });

    it("H4 a Stop that runs the gate itself (no agent in flight) also resets the counter", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // ag1 gets an allowed SubagentStop, so the next Stop finds nobody in flight and runs the ordinary gate.
      writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "ag1 is gone, so this Stop must run the full gate rather than defer").toBe(1);
      expect(sessionStateOf(dir).deferrals, "a Stop that runs the gate itself must reset the counter to 0").toBe(0);

      // Defeat the pre-existing verified-unchanged skip (card stop-gate-process-storm) the same way test G7
      // does, so the Stops below actually reach the deferral check point instead of shortcutting on a tree
      // that still matches the fingerprint the Stop above just recorded.
      appendFileSync(join(dir, "src/a.ts"), "\nmore edits this session");
      writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }, start("ag3", "coder")]);
      for (let i = 1; i <= 2; i++) {
        const rr = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expectDeferral(rr, false, `Stop #${i} after ag3 starts must defer from a fresh count of 0, not carry the old counter over`);
      }
      expect(runsCount(dir), "still only 1 run: the two Stops after ag3 starts must not run the commands").toBe(1);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd Stop after ag3 starts hits maxDeferrals 3 (counted fresh) and runs (runsCount 2)").toBe(2);
    });

    it.each([0, "ten", -1])("H5 a garbage stopGate.maxDeferrals (%j) behaves as the default cap (10)", (garbage) => {
      const dir = makeEditedProject(withMaxDeferrals(garbage));
      writeTrace(dir, [start("ag1", "coder")]);
      for (let i = 1; i <= 9; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expectDeferral(r, i === 1, `garbage maxDeferrals ${JSON.stringify(garbage)}: Stop #${i} must still defer as though the cap were the default 10`);
      }
      expect(runsCount(dir), `garbage maxDeferrals ${JSON.stringify(garbage)}: none of the first 9 Stops may run the commands`).toBe(0);
      const r10 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), `garbage maxDeferrals ${JSON.stringify(garbage)}: Stop 10 must fall back to the default cap and run the commands`).toBe(1);
      expect(r10.json.systemMessage, `garbage maxDeferrals ${JSON.stringify(garbage)}: the cap message must name the default cap (10)`).toContain("10");
    });

    it("H6 the cap running the gate can still fail: a real block at the cap counts toward maxBlocks like any other block", () => {
      const dir = makeEditedProject(withMaxDeferrals(2, { commands: { "test:unit": "exit 1" } }));
      writeTrace(dir, [start("ag1", "coder")]);
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r1.json.decision, "Stop 1 (below maxDeferrals 2) must defer, not block").toBeUndefined();
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json.decision, "Stop 2 hits the cap, runs the failing command, and must block for real").toBe("block");
      expect(r2.json.reason, "the block reason must carry the cap sentence").toContain("Deferral cap reached");
      expect(r2.json.reason, "the block reason must still carry the ordinary (n/max) block count, unaffected by the cap").toContain("(1/3)");
      expect(readLedger(dir), "a real block at the cap must be logged exactly once, like any other block").toHaveLength(1);
    });

    it("H7 an old state file with no deferrals key reads it as 0, never throws, and counts up again from there", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // Stop 1: state.deferrals is now 1

      const statePath = join(dir, ".doug/.state/test-session.json");
      const state = sessionStateOf(dir);
      expect(state.deferrals, "sanity: Stop 1 must have counted to 1 before the old file is simulated").toBe(1);
      delete state.deferrals;
      writeFileSync(statePath, JSON.stringify(state)); // simulate a state file saved before this card existed

      for (let i = 2; i <= 3; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.status, `Stop #${i} must exit 0 even though state.deferrals was missing on disk`).toBe(0);
        expect(r.stdout.trim() === "" || r.json !== null, `Stop #${i}'s stdout must be empty (a silent repeat deferral) or parse as JSON`).toBe(true);
        expectDeferral(r, false, `Stop #${i}: a missing deferrals key must read as 0, restarting the count rather than throwing or mis-counting`);
      }
      const r4 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r4.status, "Stop 4 must exit 0").toBe(0);
      expect(runsCount(dir), "counting from the repaired 0, the 4th Stop (3 consecutive deferrals since the missing key) hits maxDeferrals 3 and runs").toBe(1);
    });

    it("H8 a real tree problem found while at (or under) the cap still resets the counter (R5), and never carries the cap sentence", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // A real protected-path hit while ag1 is still in flight (same fixture as test G9 above).
      writeFileSync(join(dir, ".env"), "SECRET=1"); // dirty, protected (baseConfig.protectedPaths), never touched by the Edit tool
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision, "a real protected-path problem must block for real, not defer").toBe("block");
      expect(r.json.reason, "the block reason must name the real problem").toContain("Protected files were modified");
      expect(r.json.reason, "a real tree-problem block is not the cap running the gate, so it must never carry the cap sentence").not.toContain("Deferral cap reached");
      expect(sessionStateOf(dir).deferrals, "a real tree problem found while an agent is in flight must still reset the counter (R5), same as any other Stop that does not defer").toBe(0);
    });

    it("H9 a lock-contention reload keeps the counter reset on a main Stop (R6 must not be conditioned on `subagent`)", () => {
      const dir = makeEditedProject(withMaxDeferrals(3, {}, { timeoutMs: 1200 }));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // A live lock held by another session (a real pid — this test's own — so pidIsLive is true, and a fresh
      // `at` so it is not stale by age): the 3rd Stop hits the cap, cannot take gate.lock, and waits out
      // stopGate.timeoutMs (1200ms here) before reloading state from disk and taking the lock over itself.
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/gate.lock"), JSON.stringify({ pid: process.pid, session: "other-session", at: Date.now() }));

      const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd consecutive deferred Stop hits the cap, waits out the contended lock, and still runs the commands").toBe(1);
      expect(r3.json.systemMessage, "the cap message must say the cap was reached").toContain("Deferral cap reached");
      expect(
        sessionStateOf(dir).deferrals,
        "the reset applied when the cap was hit (R5) must survive the lock-wait reload of state from disk, on a main Stop exactly as on a SubagentStop (R6)",
      ).toBe(0);

      // Defeat the pre-existing verified-unchanged skip (card stop-gate-process-storm), same technique as
      // test H4 above, so this next Stop actually reaches the deferral check instead of shortcutting.
      appendFileSync(join(dir, "src/a.ts"), "\nmore edits this session");
      const r4 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "ag1 is still in flight, so this 4th Stop must defer rather than run again").toBe(1);
      expect(r4.json.systemMessage.toLowerCase(), "with the counter correctly reset by the cap Stop, this next Stop must defer from a fresh count of 1, not immediately hit the cap again").toContain("deferred");
    });
  });

  // card stop-gate-defer-read-only-quiet: a read-only agent in flight protects nothing, a repeat deferral is
  // silent, and the message says what is pending rather than raising an alarm. A writing type (tester, coder,
  // implementer, general-purpose, doug-flow:implementer, doug-flow:lead, claude) always counts; a READ_ONLY type
  // never does; any other type counts only once its trace shows a change.
  describe("card stop-gate-defer-read-only-quiet", () => {
    const msgOf = (r) => r.json?.systemMessage;
    const toolLines = (agent, type, tool, ok = true) => [
      { event: "PreToolUse", agent, agentType: type, tool },
      { event: "PostToolUse", agent, agentType: type, tool, ok },
    ];
    const stopOnce = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const notDeferred = (r) => expect(String(msgOf(r) ?? "").toLowerCase()).not.toContain("deferred");

    it("R1 read-only only: one in-flight architect runs the ordinary path, no deferral message, deferrals 0", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "architect")]);
      const r = stopOnce(dir);
      expect(runsCount(dir), "a read-only agent in flight must not defer: the gate runs").toBe(1);
      notDeferred(r);
      expect(sessionStateOf(dir).deferrals).toBe(0);
    });

    it("R2 an other-type agent with no change in its trace runs the gate; with an Edit it defers", () => {
      const quiet = makeEditedProject(makeRunsConfig());
      writeTrace(quiet, [start("ag1", "statusline-setup"), ...toolLines("ag1", "statusline-setup", "Read")]);
      const rq = stopOnce(quiet);
      expect(runsCount(quiet), "no change in the trace so far: the agent does not count").toBe(1);
      notDeferred(rq);

      const busy = makeEditedProject(makeRunsConfig());
      writeTrace(busy, [start("ag1", "statusline-setup"), ...toolLines("ag1", "statusline-setup", "Edit")]);
      const rb = stopOnce(busy);
      expect(runsCount(busy), "a successful Edit in its trace: the agent counts").toBe(0);
      expect(msgOf(rb)).toContain("statusline-setup:ag1");
    });

    it("R3 a writing type with no change yet still defers (conservative reading)", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder"), ...toolLines("ag1", "coder", "Read")]);
      const r = stopOnce(dir);
      expect(runsCount(dir)).toBe(0);
      expect(msgOf(r)).toContain("coder:ag1");
      expect(sessionStateOf(dir).deferrals).toBe(1);
    });

    it("R4 mixed: architect plus coder defers and names only the coder", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "architect"), start("ag2", "coder")]);
      const r = stopOnce(dir);
      expect(runsCount(dir)).toBe(0);
      expect(msgOf(r)).toContain("coder:ag2");
      expect(msgOf(r)).not.toContain("architect:ag1");
    });

    it("S1 a repeat deferral (same set, same tree) emits no systemMessage but still counts", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder")]);
      const first = stopOnce(dir);
      expect(msgOf(first)).toContain("coder:ag1");
      const second = stopOnce(dir);
      expect(msgOf(second), "the identical repeat deferral must be silent").toBeUndefined();
      expect(second.json?.decision).toBeUndefined();
      expect(runsCount(dir)).toBe(0);
      expect(sessionStateOf(dir).deferrals, "a silent deferral still counts toward maxDeferrals").toBe(2);
    });

    it("S2a the message is emitted again when the in-flight set changes", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder")]);
      stopOnce(dir);
      writeTrace(dir, [start("ag1", "coder"), start("ag2", "coder")]);
      const r = stopOnce(dir);
      expect(msgOf(r), "a second writer started: not a repeat").toContain("coder:ag2");
    });

    it("S2b the message is emitted again when the tree changes between the Stops", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder")]);
      stopOnce(dir);
      appendFileSync(join(dir, "src/a.ts"), "\nedited between the Stops");
      const r = stopOnce(dir);
      expect(msgOf(r), "the tree changed: not a repeat").toContain("coder:ag1");
    });

    it("S3 the cap still fires after silent deferrals: maxDeferrals 3 defers, stays silent, then runs with the cap note", () => {
      const dir = makeEditedProject(
        makeRunsConfig({ stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false, maxDeferrals: 3 } }),
      );
      writeTrace(dir, [start("ag1", "coder")]);
      expect(msgOf(stopOnce(dir))).toContain("coder:ag1");
      expect(msgOf(stopOnce(dir)), "Stop 2 is a silent repeat").toBeUndefined();
      expect(runsCount(dir)).toBe(0);
      const r3 = stopOnce(dir);
      expect(runsCount(dir), "Stop 3 hits the cap and runs the commands").toBe(1);
      expect(msgOf(r3)).toContain("Deferral cap reached");
      expect(sessionStateOf(dir).deferrals).toBe(0);
    });

    it("R5 a read-only type never counts, even when its trace shows Bash calls (the type wins over the trace)", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "reviewer"), ...toolLines("ag1", "reviewer", "Bash")]);
      const r = stopOnce(dir);
      expect(runsCount(dir), "a reviewer is read-only by tool policy: the gate runs despite its Bash lines").toBe(1);
      notDeferred(r);
    });

    it("R6 an other-type agent whose trace shows a Bash call (no Edit) counts and defers", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "statusline-setup"), ...toolLines("ag1", "statusline-setup", "Bash")]);
      const r = stopOnce(dir);
      expect(runsCount(dir)).toBe(0);
      expect(msgOf(r)).toContain("statusline-setup:ag1");
    });

    // The first deferral of a streak always speaks: every reset of state.deferrals also forgets the last
    // deferral, so an identical set and tree after a reset is not mistaken for a repeat.
    describe("the first deferral after a reset speaks", () => {
      const failingRuns = (extraStopGate = {}) =>
        makeRunsConfig({
          commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x'); process.exit(1)"` },
          stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 5, timeoutMs: 10000, requireEvidence: false, ...extraStopGate },
        });

      it("RS1 after a SubagentStop of this session", () => {
        const dir = makeEditedProject(makeRunsConfig());
        writeTrace(dir, [start("ag1", "coder")]);
        expect(msgOf(stopOnce(dir))).toContain("coder:ag1");
        expect(msgOf(stopOnce(dir)), "sanity: the repeat is silent").toBeUndefined();
        runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "researcher" }, { dir });
        expect(msgOf(stopOnce(dir)), "same set, same tree, but a reset happened: the first deferral speaks").toContain("coder:ag1");
      });

      it("RS2 after a Stop with no counting agent ran the gate", () => {
        const dir = makeEditedProject(failingRuns());
        writeTrace(dir, [start("ag1", "coder")]);
        expect(msgOf(stopOnce(dir))).toContain("coder:ag1");
        writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
        stopOnce(dir); // no agent in flight: runs the (failing) gate, so no verified record can skip the next Stop
        expect(runsCount(dir), "sanity: the gate ran").toBe(1);
        writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }, start("ag1", "coder")]);
        const r = stopOnce(dir);
        expect(runsCount(dir), "sanity: this Stop deferred").toBe(1);
        expect(msgOf(r), "same set, same tree, but the gate ran in between: the first deferral speaks").toContain("coder:ag1");
      });

      it("RS3 after the cap made the gate run", () => {
        const dir = makeEditedProject(failingRuns({ maxDeferrals: 2 }));
        writeTrace(dir, [start("ag1", "coder")]);
        expect(msgOf(stopOnce(dir))).toContain("coder:ag1");
        const cap = stopOnce(dir);
        expect(runsCount(dir), "sanity: Stop 2 hit the cap and ran the gate").toBe(1);
        expect(JSON.stringify(cap.json)).toContain("Deferral cap reached");
        const r = stopOnce(dir);
        expect(runsCount(dir), "sanity: Stop 3 deferred again").toBe(1);
        expect(msgOf(r), "same set, same tree, but the cap reset the streak: the first deferral speaks").toContain("coder:ag1");
      });
    });

    it("W1 the message names the waiting agents and says what is pending, not that work is unfinished", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder"), start("ag2", "tester")]);
      const m = msgOf(stopOnce(dir));
      expect(m).toContain("coder:ag1");
      expect(m).toContain("tester:ag2");
      expect(m.toLowerCase()).toContain("deferred");
      expect(m).not.toContain("Do not treat this work as done");
    });
  });
});

// card worktree-agent-gate: a worktree-isolated subagent (its Edit/Write paths in the run trace sit under
// <projectDir>/.claude/worktrees/<wt>/) is fingerprinted, verified, and credited in its worktree, not in the main
// checkout: commands run with the worktree as cwd, credit reads the worktree's own records, and a later worktree
// commit is re-verified instead of allowed as verified-unchanged. State, trace and the lock stay in the main
// checkout. Detection never depends on input.cwd (the core cases pass the main checkout, as the live run did).
describe("card worktree-agent-gate", () => {
  const agentType = "doug-flow:implementer";
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  // The marker command appends its cwd to a file outside both trees, so a test can tell whether the commands
  // ran and in which directory. `failIfFlag` also exits 1 where fail.flag exists in the cwd.
  function makeCfg(marker, failIfFlag = false, extra = {}) {
    const exit = failIfFlag ? ";process.exit(require('fs').existsSync('fail.flag')?1:0)" : "";
    return {
      ...baseConfig,
      commands: { test: `${process.execPath} -e "require('fs').appendFileSync('${marker}', process.cwd()+'\\n')${exit}"` },
      ...extra,
    };
  }

  function makeFixture({ failIfFlag = false, cfgExtra = {} } = {}) {
    const markerDir = mkdtempSync(join(tmpdir(), "doug-wt-marker-"));
    const marker = join(markerDir, "marker.log");
    const cfg = makeCfg(marker, failIfFlag, cfgExtra);
    const dir = makeProject({ config: cfg, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const wt = join(dir, ".claude/worktrees/wt1");
    git(dir, "worktree", "add", "-q", wt, "-b", "wt1-branch");
    return { dir, wt, marker, cfg };
  }

  const wtCommit = (wt, file, content, message) => {
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), content);
    git(wt, "add", file); // never -A: the worktree's .doug/.state is untracked state
    git(wt, "commit", "-q", "-m", message);
  };

  const traceFile = (dir) => join(dir, ".doug/.state/trace/test-session.jsonl");
  function appendTrace(dir, lines) {
    mkdirSync(dirname(traceFile(dir)), { recursive: true });
    const full = lines.map((l) => ({ t: new Date().toISOString(), event: null, session: "test-session", agent: null, agentType: null, tool: null, toolUseId: null, detail: null, ok: null, tokens: null, context: null, reason: null, ...l }));
    appendFileSync(traceFile(dir), full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  // One agent's life: start, a Write of an absolute path, a Bash (the commit). The edit-loop hook is run too, as
  // the live PostToolUse did, so state.editedFiles is non-empty and onlyIfEdited cannot exit early.
  function agentEdits(dir, agent, absFile) {
    appendTrace(dir, [
      { event: "SubagentStart", agent, agentType },
      { event: "PostToolUse", agent, agentType, tool: "Write", ok: true, detail: absFile },
      { event: "PostToolUse", agent, agentType, tool: "Bash", ok: true, detail: "git add src/a.ts && git commit -m work" },
    ]);
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: absFile }, agent_id: agent }, { dir });
  }
  const subagentStop = (dir, agent, extra = {}) =>
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: agent, agent_type: agentType, ...extra }, { dir });

  const cwdsRun = (marker) => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : []);
  const real = (p) => realpathSync(p);
  const treeOf = (d) => git(d, "rev-parse", "HEAD^{tree}");
  const seedPreCommit = (wt, cfg) => {
    mkdirSync(join(wt, ".doug/.state/pre-commit"), { recursive: true });
    writeFileSync(
      join(wt, ".doug/.state/pre-commit/last-run.json"),
      JSON.stringify({ version: 1, tree: treeOf(wt), ok: true, at: new Date().toISOString(), commands: [{ name: "test", command: cfg.commands.test, exit: 0, durationMs: 5 }] }),
    );
  };

  it("W1 a worktree agent that committed, with a passing pre-commit record in its worktree, stops without any command run", () => {
    const { dir, wt, marker, cfg } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    seedPreCommit(wt, cfg);
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker), "the worktree's own passing record must be credited: no command may run anywhere").toEqual([]);
  });

  it("W1b the same, credited from a verified-tree record of the worktree's tree", () => {
    const { dir, wt, marker, cfg } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    const tree = computeTree(wt);
    expect(tree).toBeTruthy();
    expect(
      writeTreeRecord(wt, {
        version: 1,
        tree,
        node: process.version,
        at: new Date().toISOString(),
        by: "pre-commit",
        commands: [{ name: "test", command: cfg.commands.test, exit: 0, durationMs: 5 }],
        totals: {},
      }),
    ).toBe(true);
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker), "the worktree's verified-tree record must be credited: no command may run anywhere").toEqual([]);
  });

  it("W2 with no record in the worktree the commands run, with the worktree as cwd", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real), "the command must run once, in the worktree, not the main checkout").toEqual([real(wt)]);
  });

  it("W3 a second agent that commits new code in the worktree is re-verified there, never allowed as verified-unchanged", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    expect(subagentStop(dir, "agA").json).toBeNull();
    expect(cwdsRun(marker).map(real)).toEqual([real(wt)]); // A was verified in the worktree
    // B commits new code in the same worktree; the main tree does not move.
    wtCommit(wt, "src/b.ts", "agent B work", "B");
    expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
    agentEdits(dir, "agB", join(wt, "src/b.ts"));
    const r = subagentStop(dir, "agB");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    const ran = cwdsRun(marker).map(real);
    expect(ran, "B's new worktree commit must run the commands again, in the worktree").toEqual([real(wt), real(wt)]);
    const stopLines = readFileSync(traceFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === "SubagentStop" && l.agent === "agB");
    expect(stopLines.some((l) => l.reason === "verified-unchanged"), "B's stop must not be traced as verified-unchanged").toBe(false);
  });

  it("W4 a command that fails in the worktree blocks the worktree agent's stop", () => {
    const { dir, wt } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "fail.flag", "1", "A"); // only the worktree carries fail.flag
    agentEdits(dir, "agA", join(wt, "fail.flag"));
    const r = subagentStop(dir, "agA");
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
  });

  it("W5 an agent whose edits are in the main checkout runs the commands with the main checkout as cwd", () => {
    const { dir, wt, marker } = makeFixture();
    expect(existsSync(wt)).toBe(true); // a worktree exists but this agent never touched it
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    agentEdits(dir, "agA", join(dir, "src/a.ts"));
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real)).toEqual([real(dir)]);
  });

  it("W5b a main Stop is unchanged: commands run with the main checkout as cwd even when a worktree agent is in the trace", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    appendTrace(dir, [{ event: "SubagentStop", agent: "agA", agentType, decision: "allow" }]);
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(cwdsRun(marker).map(real)).toEqual([real(dir)]);
  });

  it("W6 a trace path naming a removed worktree falls back to the main checkout without throwing", () => {
    const { dir, marker } = makeFixture();
    const gone = join(dir, ".claude/worktrees/gone");
    git(dir, "worktree", "add", "-q", gone, "-b", "gone-branch");
    git(dir, "worktree", "remove", "--force", gone);
    expect(existsSync(gone)).toBe(false);
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    agentEdits(dir, "agA", join(gone, "src/a.ts"));
    const r = subagentStop(dir, "agA");
    expect(r.status).toBe(0);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real), "a removed worktree is today's behaviour: the main checkout").toEqual([real(dir)]);
  });

  it("W7 detection does not need input.cwd to be the main checkout: input.cwd is the worktree, CLAUDE_PROJECT_DIR the main checkout", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    const r = subagentStop(dir, "agA", { cwd: wt });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real)).toEqual([real(wt)]);
  });

  it("W8 the no-test-paths skip is judged in the worktree: main-only docs/ edits never skip a worktree agent's src commit", () => {
    const { dir, wt, marker } = makeFixture({ cfgExtra: { preCommit: { noTestPaths: ["docs/"] } } });
    // The main Stop goes green first: state.verified is the main checkout's fingerprint.
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(cwdsRun(marker).map(real)).toEqual([real(dir)]);
    // Main then changes only a noTestPaths file; a worktree agent commits real code.
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/x.md"), "notes");
    wtCommit(wt, "src/b.ts", "agent B work", "B");
    agentEdits(dir, "agB", join(wt, "src/b.ts"));
    const r = subagentStop(dir, "agB");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real), "the worktree's src commit must be verified in the worktree, not skipped as no-test-paths").toEqual([real(dir), real(wt)]);
  });

  // card worktree-gate-unpinned-clauses: one isolating case per clause the worktree-agent-gate reviewer's own
  // mutations (M7, M8, M9, M11, M13, M14) left unpinned. Each case is shaped so that exactly its clause changes
  // the outcome.
  const stateOf = (dir) => join(dir, ".doug/.state/test-session.json");
  const recordFor = (tree, cfg) => ({
    version: 1,
    tree,
    node: process.version,
    at: new Date().toISOString(),
    by: "pre-commit",
    commands: [{ name: "test", command: cfg.commands.test, exit: 0, durationMs: 5 }],
    totals: {},
  });

  it("W9 (M14) input.cwd alone names the worktree: no trace path names any tree", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    // The only Edit-type trace line names a path outside the project and every worktree, so a trace path adds no tree.
    appendTrace(dir, [
      { event: "SubagentStart", agent: "agA", agentType },
      { event: "PostToolUse", agent: "agA", agentType, tool: "Write", ok: true, detail: join(tmpdir(), "elsewhere/x.ts") },
      { event: "PostToolUse", agent: "agA", agentType, tool: "Bash", ok: true, detail: "git add src/a.ts && git commit -m work" },
    ]);
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: join(wt, "src/a.ts") }, agent_id: "agA" }, { dir });
    const r = subagentStop(dir, "agA", { cwd: wt });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real), "input.cwd inside the worktree must make the worktree the verification target").toEqual([real(wt)]);
  });

  it("W10 (M8) a failed Write in a worktree adds no tree: only the main checkout is verified", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/b.ts", "committed in the worktree", "B"); // so a verified wt would run the command
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    appendTrace(dir, [
      { event: "SubagentStart", agent: "agA", agentType },
      { event: "PostToolUse", agent: "agA", agentType, tool: "Write", ok: false, detail: join(wt, "src/b.ts") },
      { event: "PostToolUse", agent: "agA", agentType, tool: "Write", ok: true, detail: join(dir, "src/a.ts") },
    ]);
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: join(dir, "src/a.ts") }, agent_id: "agA" }, { dir });
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real), "a Write that failed (ok:false) must not name its worktree").toEqual([real(dir)]);
  });

  it("W11 (M9) another agent's worktree Write adds no tree to this agent's stop", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/b.ts", "committed in the worktree", "B"); // so a verified wt would run the command
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    appendTrace(dir, [
      { event: "SubagentStart", agent: "agB", agentType },
      { event: "PostToolUse", agent: "agB", agentType, tool: "Write", ok: true, detail: join(wt, "src/b.ts") },
    ]);
    agentEdits(dir, "agA", join(dir, "src/a.ts"));
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real), "agent B's worktree must not be verified at agent A's stop").toEqual([real(dir)]);
  });

  it("W12 (M11) a green run in the worktree records its verified tree in the worktree, not in the main checkout", () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    expect(readTreeRecord(wt)).toBeNull();
    expect(readTreeRecord(dir)).toBeNull();
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real)).toEqual([real(wt)]);
    const rec = readTreeRecord(wt);
    expect(rec && rec.tree, "the worktree must carry the record of the tree it was verified at").toBe(computeTree(wt));
    expect(readTreeRecord(dir), "the main checkout must carry no record of a tree it never ran").toBeNull();
  });

  it("W13 (M13) a red run in the worktree removes the worktree's stale record and leaves the main checkout's alone", () => {
    const { dir, wt, cfg } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "fail.flag", "1", "A"); // only the worktree fails
    const stale = recordFor(computeTree(dir), cfg); // a valid record of some other tree, so nothing is credited
    expect(writeTreeRecord(wt, stale)).toBe(true);
    expect(writeTreeRecord(dir, stale)).toBe(true);
    agentEdits(dir, "agA", join(wt, "fail.flag"));
    const r = subagentStop(dir, "agA");
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(readTreeRecord(wt), "the red run must remove the record in the tree it verified").toBeNull();
    expect(readTreeRecord(dir), "the main checkout's record must survive a red run in the worktree").not.toBeNull();
  });

  it("W14 (M7) after waiting out a live gate.lock, the reloaded verified tree is compared with the worktree's fingerprint", async () => {
    const { dir, wt, marker } = makeFixture();
    wtCommit(wt, "src/a.ts", "agent A work", "A");
    // A real green stop in the worktree records state.verified for it.
    agentEdits(dir, "agA", join(wt, "src/a.ts"));
    expect(subagentStop(dir, "agA").json).toBeNull();
    expect(cwdsRun(marker).map(real)).toEqual([real(wt)]);
    const savedState = readFileSync(stateOf(dir), "utf8");
    expect(JSON.parse(savedState).verified, "the first stop must have recorded the worktree's verified tree").toBeTruthy();
    // Agent B stops in the same worktree with no verified tree on disk and a live holder on gate.lock; the holder
    // restores the verified state and releases the lock partway through, as a concurrent gate's green run would.
    writeFileSync(stateOf(dir), JSON.stringify({ ...JSON.parse(savedState), verified: undefined }));
    removeTreeRecord(wt); // nothing for credit to use: only the post-wait comparison can skip the commands
    const lockPath = join(dir, ".doug/.state/gate.lock");
    const holderScript = join(dir, ".doug/.state/holder-w14.mjs");
    writeFileSync(
      holderScript,
      [
        'import { writeFileSync, unlinkSync } from "node:fs";',
        "setTimeout(() => {",
        `  writeFileSync(${JSON.stringify(stateOf(dir))}, ${JSON.stringify(savedState)});`,
        `  try { unlinkSync(${JSON.stringify(lockPath)}); } catch {}`,
        "}, 1200);",
      ].join("\n"),
    );
    const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
    writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
    try {
      agentEdits(dir, "agB", join(wt, "src/a.ts"));
      const started = Date.now();
      const r = subagentStop(dir, "agB");
      expect(Date.now() - started, "a live lock must actually be waited for").toBeGreaterThanOrEqual(900);
      expect(r.json, JSON.stringify(r.json)).toBeNull();
      expect(cwdsRun(marker).map(real), "the reloaded verified tree matches the worktree's fingerprint: no command may run again").toEqual([real(wt)]);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  // card worktree-gate-mixed-tree-agent: an agent whose successful Edit/Write paths span the main checkout and a
  // worktree (or two worktrees) is verified in every tree it touched, and any red blocks.
  function agentEditsMany(dir, agent, absFiles) {
    appendTrace(dir, [
      { event: "SubagentStart", agent, agentType },
      ...absFiles.map((f) => ({ event: "PostToolUse", agent, agentType, tool: "Write", ok: true, detail: f })),
      { event: "PostToolUse", agent, agentType, tool: "Bash", ok: true, detail: "git add src/a.ts && git commit -m work" },
    ]);
    for (const f of absFiles) runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: f }, agent_id: agent }, { dir });
  }
  const addWt2 = (dir) => {
    const wt2 = join(dir, ".claude/worktrees/wt2");
    git(dir, "worktree", "add", "-q", wt2, "-b", "wt2-branch");
    return wt2;
  };
  const blocked = (r) => r.json && r.json.decision;

  it("X1 (P4 shape) a worktree write then a failing main-checkout write blocks, and both trees ran", () => {
    const { dir, wt, marker } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "src/bad.ts"), "bad");
    writeFileSync(join(dir, "fail.flag"), "1"); // only the main checkout fails
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, "src/bad.ts")]);
    const r = subagentStop(dir, "agA");
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    const ran = cwdsRun(marker).map(real);
    expect(ran).toContain(real(wt));
    expect(ran).toContain(real(dir));
  });

  it("X2 main first, then a worktree that fails: blocks (any tree, not first or last)", () => {
    const { dir, wt, marker } = makeFixture({ failIfFlag: true });
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    wtCommit(wt, "fail.flag", "1", "B"); // only the worktree fails
    agentEditsMany(dir, "agA", [join(dir, "src/a.ts"), join(wt, "fail.flag")]);
    const r = subagentStop(dir, "agA");
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    const ran = cwdsRun(marker).map(real);
    expect(ran).toContain(real(wt));
    expect(ran).toContain(real(dir));
  });

  it("X3 two worktrees, the second failing: blocks, and both ran", () => {
    const { dir, wt, marker } = makeFixture({ failIfFlag: true });
    const wt2 = addWt2(dir);
    wtCommit(wt, "src/b.ts", "one", "B");
    wtCommit(wt2, "fail.flag", "1", "C");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(wt2, "fail.flag")]);
    const r = subagentStop(dir, "agA");
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    const ran = cwdsRun(marker).map(real);
    expect(ran).toContain(real(wt));
    expect(ran).toContain(real(wt2));
  });

  it("X4 mixed trees, all green: allowed, each touched tree ran exactly once, an untouched worktree did not", () => {
    const { dir, wt, marker } = makeFixture();
    const wt2 = addWt2(dir); // never touched
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, "src/a.ts")]);
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    const ran = cwdsRun(marker).map(real).sort();
    expect(ran).toEqual([real(dir), real(wt)].sort());
    expect(ran).not.toContain(real(wt2));
  });

  it("X5 input.cwd inside a worktree plus a failing main-checkout write: both trees verified, blocks", () => {
    const { dir, wt, marker } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "src/bad.ts"), "bad");
    writeFileSync(join(dir, "fail.flag"), "1");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, "src/bad.ts")]);
    const r = subagentStop(dir, "agA", { cwd: wt });
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    const ran = cwdsRun(marker).map(real);
    expect(ran).toContain(real(wt));
    expect(ran).toContain(real(dir));
  });

  it("X6 a trace path outside the main checkout and every worktree adds no tree and never throws", () => {
    const { dir, marker } = makeFixture();
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    const outside = join(mkdtempSync(join(tmpdir(), "doug-wt-outside-")), "x.ts");
    agentEditsMany(dir, "agA", [outside, join(dir, "src/a.ts")]);
    const r = subagentStop(dir, "agA");
    expect(r.status).toBe(0);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(cwdsRun(marker).map(real)).toEqual([real(dir)]);
  });

  // card mixed-tree-ignore-state-writes: untracked state under <dir>/.doug/.state is never project code, so a
  // main-checkout write there adds no tree; any other main-checkout path still adds the main tree.
  const mainWriteCase = (mainPath) => {
    const { dir, wt, marker } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "fail.flag"), "1"); // only the main checkout fails
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), mainPath(dir)]);
    const r = subagentStop(dir, "agA", { cwd: wt });
    return { r, ran: cwdsRun(marker).map(real), dir, wt };
  };

  it("X7 a worktree agent whose only main-checkout write is .doug/.state/scratch/x runs the worktree only", () => {
    const { r, ran, dir, wt } = mainWriteCase((d) => join(d, ".doug/.state/scratch/x"));
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ran).toEqual([real(wt)]);
    expect(ran).not.toContain(real(dir));
  });

  it("X8 the same agent plus a main-checkout src write runs the main tree too and blocks when main fails", () => {
    const { dir, wt, marker } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "fail.flag"), "1");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, ".doug/.state/scratch/x"), join(dir, "src/x.ts")]);
    const r = subagentStop(dir, "agA", { cwd: wt });
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    const ran = cwdsRun(marker).map(real);
    expect(ran).toContain(real(wt));
    expect(ran).toContain(real(dir));
  });

  for (const [id, label, mainPath] of [
    ["X9a", ".doug/anchor.md is not under .doug/.state", (d) => join(d, ".doug/anchor.md")],
    ["X9b", ".doug/plan.json is not under .doug/.state", (d) => join(d, ".doug/plan.json")],
    ["X10a", ".doug/.state-x/y is a sibling, not a segment match", (d) => join(d, ".doug/.state-x/y")],
    ["X10b", ".doug/.stateful is a sibling, not a segment match", (d) => join(d, ".doug/.stateful")],
    ["X11", ".doug/.state/../../src/x.ts resolves out of .doug/.state", (d) => `${d}/.doug/.state/../../src/x.ts`],
  ]) {
    it(`${id} ${label}: still adds the main tree, which blocks when it fails`, () => {
      const { r, ran, dir, wt } = mainWriteCase(mainPath);
      expect(blocked(r), JSON.stringify(r.json)).toBe("block");
      expect(ran).toContain(real(wt));
      expect(ran).toContain(real(dir));
    });
  }

  // card worktree-gate-mixed-tree-agent, fix pass (review round 1: B1, J1, J2, J3, m2).
  const decisionLines = (dir, agent) =>
    readFileSync(traceFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.event === "SubagentStop" && l.agent === agent && l.decision != null);

  it("B1 the commands a gate runs never see DOUG_STOP_GATE_TREE, in any tree of a mixed-tree stop", () => {
    const markerDir = mkdtempSync(join(tmpdir(), "doug-wt-marker-"));
    const marker = join(markerDir, "env.log");
    const cmd = `${process.execPath} -e "require('fs').appendFileSync('${marker}', process.cwd()+'|'+(process.env.DOUG_STOP_GATE_TREE||'')+'\\n')"`;
    const { dir, wt } = makeFixture({ cfgExtra: { commands: { test: cmd } } });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, "src/a.ts")]);
    const r = subagentStop(dir, "agA");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    const lines = existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [];
    expect(lines.map((l) => real(l.split("|")[0])).sort()).toEqual([real(dir), real(wt)].sort());
    for (const l of lines) expect(l.split("|")[1], `the command must not see the variable: ${l}`).toBe("");
  });

  describe("J1 a DOUG_STOP_GATE_TREE that is not a tree of this project is ignored", () => {
    const failingMainEdit = (dir) => {
      writeFileSync(join(dir, "src/a.ts"), "edited in main");
      writeFileSync(join(dir, "fail.flag"), "1");
    };
    it("an empty directory elsewhere", () => {
      const { dir } = makeFixture({ failIfFlag: true });
      failingMainEdit(dir);
      agentEdits(dir, "agA", join(dir, "src/a.ts"));
      const elsewhere = mkdtempSync(join(tmpdir(), "doug-wt-elsewhere-"));
      const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agA", agent_type: agentType }, { dir, env: { DOUG_STOP_GATE_TREE: elsewhere } });
      expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    });
    it("an existing directory under the project that is not a worktree", () => {
      const { dir } = makeFixture({ failIfFlag: true });
      failingMainEdit(dir);
      agentEdits(dir, "agA", join(dir, "src/a.ts"));
      const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agA", agent_type: agentType }, { dir, env: { DOUG_STOP_GATE_TREE: join(dir, "src") } });
      expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    });
    it("a directory nested below a worktree rather than directly under .claude/worktrees", () => {
      const { dir, wt } = makeFixture({ failIfFlag: true });
      failingMainEdit(dir);
      agentEdits(dir, "agA", join(dir, "src/a.ts"));
      const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agA", agent_type: agentType }, { dir, env: { DOUG_STOP_GATE_TREE: join(wt, "src") } });
      expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    });
    it("a main Stop ignores it even for a real worktree", () => {
      const { dir, wt } = makeFixture({ failIfFlag: true });
      failingMainEdit(dir);
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir, env: { DOUG_STOP_GATE_TREE: wt } });
      expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    });
  });

  it("J2 a command past the budget blocks the mixed-tree stop within the budget and leaves no live process", () => {
    const markerDir = mkdtempSync(join(tmpdir(), "doug-wt-marker-"));
    const pidFile = join(markerDir, "pids.log");
    const cmd = `${process.execPath} -e "require('fs').appendFileSync('${pidFile}', process.pid+'\\n');setTimeout(()=>process.exit(1),30000)"`;
    const { dir, wt } = makeFixture({
      cfgExtra: { commands: { test: cmd }, stopGate: { ...baseConfig.stopGate, hookTimeoutSec: 6 } },
    });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, "src/a.ts")]);
    const t0 = Date.now();
    const r = subagentStop(dir, "agA");
    const took = Date.now() - t0;
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    expect(took, "the stop must end within the 6 s budget plus a margin").toBeLessThan(12000);
    const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
    for (let i = 0; i < 20 && pids.some((p) => { try { process.kill(p, 0); return true; } catch { return false; } }); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    for (const p of pids) expect(() => process.kill(p, 0), `command process ${p} must not outlive the stop`).toThrow();
  }, 30000);

  it("J3 one mixed-tree stop writes exactly one decision line, and the lead's main Stop still defers after a block", () => {
    const { dir, wt } = makeFixture({ failIfFlag: true });
    wtCommit(wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(dir, "src/bad.ts"), "bad");
    writeFileSync(join(dir, "fail.flag"), "1");
    agentEditsMany(dir, "agA", [join(wt, "src/b.ts"), join(dir, "src/bad.ts")]);
    const r = subagentStop(dir, "agA");
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    const lines = decisionLines(dir, "agA");
    expect(lines.map((l) => l.decision), "exactly one combined decision").toEqual(["block"]);
    const lead = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(lead.json && lead.json.decision, JSON.stringify(lead.json)).toBeUndefined();
    expect(lead.json.systemMessage).toContain("Verification deferred");
    expect(lead.json.systemMessage).toContain("agA");
  });

  it("m2 a mixed-tree block names the failing tree", () => {
    const a = makeFixture({ failIfFlag: true });
    wtCommit(a.wt, "src/b.ts", "agent work", "B");
    writeFileSync(join(a.dir, "src/bad.ts"), "bad");
    writeFileSync(join(a.dir, "fail.flag"), "1");
    agentEditsMany(a.dir, "agA", [join(a.wt, "src/b.ts"), join(a.dir, "src/bad.ts")]);
    const ra = subagentStop(a.dir, "agA");
    expect(blocked(ra)).toBe("block");
    expect(ra.json.reason).toContain("Verification failed in the main checkout");

    const b = makeFixture({ failIfFlag: true });
    writeFileSync(join(b.dir, "src/a.ts"), "edited in main");
    wtCommit(b.wt, "fail.flag", "1", "B");
    agentEditsMany(b.dir, "agA", [join(b.dir, "src/a.ts"), join(b.wt, "fail.flag")]);
    const rb = subagentStop(b.dir, "agA");
    expect(blocked(rb)).toBe("block");
    expect(rb.json.reason).toContain("Verification failed in .claude/worktrees/wt1");
  });

  it("J2b a gate child killed mid-command gives no verdict: the stop blocks and names the tree", () => {
    const cmd = "if [ -f kill.flag ]; then kill -9 $PPID; fi; exit 0";
    const { dir, wt } = makeFixture({ cfgExtra: { commands: { test: cmd } } });
    wtCommit(wt, "kill.flag", "1", "B"); // only the worktree kills its gate child
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    agentEditsMany(dir, "agA", [join(wt, "kill.flag"), join(dir, "src/a.ts")]);
    const r = subagentStop(dir, "agA");
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("Verification failed in .claude/worktrees/wt1");
    expect(r.json.reason).toContain("no verdict");
  }, 30000);

  it("JD the parent's deadline reaches the child: a slow second tree blocks within the budget, leaving no live process", () => {
    const markerDir = mkdtempSync(join(tmpdir(), "doug-wt-marker-"));
    const pidFile = join(markerDir, "pids.log");
    const cmd =
      `if [ -f slow.flag ]; then sleep 2; exit 0; fi; ` +
      `if [ -f hang.flag ]; then echo $$ >> ${pidFile}; sleep 36.75; exit 1; fi; exit 0`;
    const { dir, wt } = makeFixture({
      cfgExtra: { commands: { test: cmd }, stopGate: { ...baseConfig.stopGate, hookTimeoutSec: 6 } },
    });
    wtCommit(wt, "slow.flag", "1", "B"); // tree 1: 2 s, green
    writeFileSync(join(dir, "src/a.ts"), "edited in main");
    writeFileSync(join(dir, "hang.flag"), "1"); // tree 2 (main): runs past the budget
    agentEditsMany(dir, "agA", [join(wt, "slow.flag"), join(dir, "src/a.ts")]);
    const t0 = Date.now();
    const r = subagentStop(dir, "agA");
    const took = Date.now() - t0;
    expect(blocked(r), JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason, "the child itself must time the command out on the inherited budget").toContain("timed out after");
    expect(r.json.reason, "a parent-side kill (no verdict) means the child was not given the parent's deadline").not.toContain("no verdict");
    expect(took).toBeLessThan(15000);
    const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
    expect(pids.length, "the hanging command must have started").toBeGreaterThan(0);
    for (let i = 0; i < 20 && pids.some((p) => { try { process.kill(p, 0); return true; } catch { return false; } }); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    for (const p of pids) expect(() => process.kill(p, 0), `command process ${p} must not outlive the stop`).toThrow();
  }, 30000);
});
