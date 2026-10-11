// The gate.lock helpers shared by the Stop gate (scripts/stop-gate.mjs) and verify.mjs (card
// verify-takes-gate-lock). Moved verbatim from stop-gate.mjs; the Stop gate's behaviour is unchanged.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Single-runner lock (card stop-gate-process-storm, goal 3): only one gate runs the verification commands
// at a time per project, so concurrent SubagentStops share one suite instead of each starting its own (the
// 2026-09-16 process storm). `.doug/.state/gate.lock` holds `{ pid, session, at }` while a gate's commands
// run.
const GATE_LOCK_RELPATH = ".doug/.state/gate.lock";
export function gateLockPath(dir) {
  return join(dir, GATE_LOCK_RELPATH);
}

// Reads gate.lock, tolerating garbage (a hook reader must never throw): a missing file, unreadable file, or
// content that fails to parse or carries no numeric pid all read as null — the same as "no lock", which the
// caller treats exactly like a stale one.
export function readGateLock(dir) {
  try {
    const o = JSON.parse(readFileSync(gateLockPath(dir), "utf8"));
    // A pid only counts when it is a positive integer (reviewer-found gap): 0 means "this process's own
    // group" and -1 broadcasts to every process the caller may signal, so process.kill(pid, 0) does not
    // throw for either and a liveness check that hands them straight to it reads a garbage lock as live.
    return o && typeof o === "object" && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
  } catch {
    return null;
  }
}

export function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is owned by another user (permission denied, not "no such process") —
    // that holder is still alive, just not signallable by us. Every other error (ESRCH: no such process, or
    // anything else) reads as dead.
    return err && err.code === "EPERM";
  }
}

// Creates gate.lock exclusively (throws EEXIST when one is already there, or any other fs error). The
// caller decides what a failure means.
export function writeGateLock(dir, sessionId) {
  mkdirSync(join(dir, ".doug/.state"), { recursive: true });
  writeFileSync(gateLockPath(dir), JSON.stringify({ pid: process.pid, session: sessionId, at: Date.now() }), { flag: "wx" });
}

// Overwrites gate.lock with this gate's own pid/session, whether it was stale (a dead pid) or its holder
// simply never let go inside the wait bound — either way, never lets a lock the gate cannot even write hang
// it (best-effort; a failure here just leaves lockOwned false to the caller, which never releases a lock it
// does not hold).
export function takeOverGateLock(dir, sessionId) {
  try {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(gateLockPath(dir), JSON.stringify({ pid: process.pid, session: sessionId, at: Date.now() }));
  } catch {
    // best-effort takeover only
  }
}

// Card stop-gate-budget-under-hook-timeout: cfg.stopGate.hookTimeoutSec must equal the platform's own
// Stop/SubagentStop hook `timeout` (hooks.json/settings.json), but a hook reader never throws (F6), so a
// missing, non-number, or non-positive value reads as the platform's own default, 600.
export function resolveHookTimeoutSec(cfg) {
  const sec = cfg && cfg.stopGate && cfg.stopGate.hookTimeoutSec;
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec : 600;
}

// A lock whose numeric `at` is older than the hook-timeout budget is stale regardless of a live pid: no
// legitimate holder can still be running that long, since the platform itself would have killed its hook
// by then (F1). A missing or non-numeric `at` changes nothing here; the pid liveness check still decides.
export function lockStaleByAge(lock, hookTimeoutMs) {
  return !!lock && typeof lock.at === "number" && Number.isFinite(lock.at) && Date.now() - lock.at > hookTimeoutMs;
}

// Card stop-gate-timeout-normalise (moved here by card verify-lock-wait-bound so verify.mjs shares it):
// cfg.stopGate.timeoutMs normalised once, shared by the per-command timeout and the wait bound, so the two
// never disagree on what a garbage or fractional value means. A finite number above 0 floors to an integer,
// clamped up to at least 1ms (0.5 must not floor to 0 — spawnSync reads a timeout of 0 as none at all,
// letting a command run past the budget unclamped; 2.5 must not reach spawnSync un-floored — it throws
// ERR_OUT_OF_RANGE there, and a hook reader must never throw, F6). Anything else (non-number, NaN, Infinity,
// 0, negative, null) is "unset" (null), read by each call site as its own default.
export function normalizedTimeoutMs(cfg) {
  const t = cfg.stopGate.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.max(1, Math.floor(t)) : null;
}

// How long a gate waits on a live gate.lock: the per-command timeout times the command count, the longest a
// holder legitimately runs.
export function lockWaitBoundMs(perCommandMs, commandCount) {
  return perCommandMs * Math.max(1, commandCount);
}
