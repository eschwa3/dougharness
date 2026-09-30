// Per-session state for hooks, stored under <project>/.doug/.state/<session_id>.json.
// Written atomically (tmp + rename). Never shared between sessions.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR_RELPATH = ".doug/.state";

function safeId(id) {
  return String(id || "no-session")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
}

export function statePath(dir, sessionId) {
  return join(dir, STATE_DIR_RELPATH, safeId(sessionId) + ".json");
}

export function loadState(dir, sessionId) {
  const file = statePath(dir, sessionId);
  if (!existsSync(file)) return emptyState();
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return emptyState();
  }
}

export function saveState(dir, sessionId, state) {
  const file = statePath(dir, sessionId);
  mkdirSync(join(dir, STATE_DIR_RELPATH), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

export function emptyState() {
  return {
    edits: {}, // relpath -> [timestamps]
    editedFiles: [], // relpaths edited this session (deduped)
    turns: 0,
    stopBlocks: 0,
    // Consecutive deferred main Stops (card stop-gate-deferral-cap): reset to 0 by a SubagentStop of this
    // session, or by a main Stop that reaches the deferral check point and does not defer (stop-gate.mjs).
    // Absent from an old state file reads as 0 via the emptyState spread below.
    deferrals: 0,
    agentBlocks: {}, // agent_id -> blocks of that subagent's SubagentStop, capped like stopBlocks but apart from it
    // agent_id -> { context: { pct, tokens, window, model, at, maxPct, notifiedAt } }: a worker's measured context
    // (card worker-context-handoff, lib/agent-context.mjs), read from its own transcript by scripts/trace.mjs on
    // PostToolUse and checked by scripts/stop-gate.mjs's SubagentStop gate before accepting a partial claim.
    // Absent from an old state file loads as {} (the spread of emptyState() above supplies it).
    agents: {},
    lastGate: null, // { ok, at, results }
    commands: [], // Bash commands the guard let through this session, newest last, clipped; the stop gate reads them as verification evidence
    baseline: null, // relpath -> content identity, captured on SessionStart or (fallback) the stop gate's first run this session; null until captured
    baselineSource: null, // "session-start" | "stop" | null (not yet captured) — where state.baseline came from
    // git HEAD sha recorded in the same write as `baseline` (card stop-scan-committed-changes), or null when
    // there was no git repo or no HEAD yet at capture time. Never overwritten once non-null. Lets a later Stop
    // scan `git diff --name-only <this>..HEAD` (baseline.mjs's committedSince) for paths the session committed
    // instead of leaving dirty, which a working-tree-only scan can never see. Absent from an old state file
    // predating this key loads as null via the emptyState spread above, which degrades to today's behavior.
    baselineHead: null,
    // True once `baseline` can be trusted to hold identities for every current proposalPaths file on disk
    // (card stop-scan-committed-changes): both capture sites set this in the same write as `baseline`, since
    // they always perform that walk. Absent from a state file whose baseline was captured before this key
    // existed loads as false via the emptyState spread above: a pre-existing, untouched proposalPaths file
    // (e.g. an old ADR) that was never walked into that baseline would otherwise read as "new" the first time
    // a later stop-gate.mjs walks the filesystem and compares against it. Rather than sitting out the
    // walk-based check for the rest of such a session, stop-gate.mjs's one-time repair (Minor 4) backfills
    // the missing identities into `baseline` on the very first Stop that finds this false, sets it true right
    // there, and only that one Stop still skips the walk-based check (it just backfilled from whatever the
    // tree looks like now, not from true session start) - the walk is live again from the next Stop on.
    baselineWalked: false,
    // Recorded by a green gate (card stop-gate-process-storm): { head, tree, at } where `head` is headAt(dir)
    // and `tree` is captureBaseline(dir, [...changed, ...walkProposalPathFiles(dir, cfg.proposalPaths)]) — the
    // fingerprint of the tree the commands were about to run against, taken BEFORE they ran, not after. A
    // command that itself changes a file this fingerprint covers (e.g. a formatter) is therefore never matched
    // by a later Stop/SubagentStop's sameTree comparison even though that same gate just passed — deliberate:
    // `tree` promises "this is what was verified", and a command's own edit was never actually verified against.
    // When it does match, the later Stop/SubagentStop skips re-running the verification commands entirely
    // instead of every concurrent SubagentStop starting its own full suite (the 2026-09-16 process storm). A
    // red gate never sets this; absent from an old state file loads as null via the emptyState spread above,
    // which degrades to today's behavior (always verify).
    verified: null,
    // The standing tests_red_by_design claim (card stop-gate-block-ledger, d183db5's honoured-claim path):
    // { files, at, agent } — `files` is the coverage's claimed file list, `at` an ISO timestamp, `agent` the
    // subagent's id (not its type). Written only in stop-gate.mjs's honoured-claim branch, alongside (never
    // instead of) the existing state.lastGate.redByDesign write; state.lastGate itself is replaced wholesale
    // on every later gate run (line ~942), so that record alone would not stand for a later block to read.
    // This key does: the block-ledger classifier reads redByDesignClaim.files to label a later block
    // 'expected-red' when it covers it. No expiry and no say in whether a stop is let through — that stays
    // the Decide card stop-gate-honours-tester-claim's to add. Absent from an old state file loads as null
    // via the emptyState spread above.
    redByDesignClaim: null,
    // Test totals per verification command, { [command]: { total, skipped, todo } } (card test-count-ratchet):
    // copied from the last-green record (.doug/.state/test-totals.json) by session-start-baseline.mjs in the same
    // write as `baseline`, never overwritten once non-null. The Stop gate compares against this, never against
    // the file, so a session cannot lower its own bar by going green. null = no baseline, no count check.
    testTotals: null,
    // context (card context-window-handoff): { pct, at, notifiedAt? } — absent until the status line first
    // records a reading (statusline.mjs), so not a default key here. pct and at are written by the status line
    // on every rounded-pct change; notifiedAt is written by the Stop gate (stop-gate.mjs) when it notices, and
    // is preserved across later pct updates so repeat logic tracks growth since the last notice, not since the
    // last render. Cleared by reanchor.mjs on PostCompact.
  };
}

export const MAX_COMMANDS = 100;

// Remember an allowed Bash command (clipped to 200 characters, the last MAX_COMMANDS kept).
export function recordCommand(dir, sessionId, command) {
  if (typeof command !== "string" || !command.trim()) return;
  const state = loadState(dir, sessionId);
  const commands = Array.isArray(state.commands) ? state.commands : [];
  commands.push(command.replace(/\s+/g, " ").trim().slice(0, 200));
  state.commands = commands.slice(-MAX_COMMANDS);
  saveState(dir, sessionId, state);
}
