// The gate.lock helpers shared by the Stop gate (scripts/stop-gate.mjs) and verify.mjs (card
// verify-takes-gate-lock). Moved verbatim from stop-gate.mjs; the Stop gate's behaviour is unchanged.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";

// Single-runner lock (card stop-gate-process-storm, goal 3): only one gate runs the verification commands
// at a time per project, so concurrent SubagentStops share one suite instead of each starting its own (the
// 2026-09-16 process storm). gate.lock holds `{ pid, session, at }` while a gate's commands run. Card
// gate-lock-shared (ADR 0015): it lives at `<git common dir>/doug/gate.lock`, a path every worktree of the
// repo shares, so gates in parallel worktrees queue instead of running full suites concurrently. It falls
// back to the per-checkout `.doug/.state/gate.lock` when git is unavailable, `dir` is not in a repo, or the
// common dir is not writable; resolution never throws.
const GATE_LOCK_RELPATH = ".doug/.state/gate.lock";
// Memoized per dir for the life of the process (a fallback result too): one gate run must see one path,
// or a poll that fell back under load would read no lock and take over a live holder's shared lock.
const lockPathMemo = new Map();
export function gateLockPath(dir) {
  if (lockPathMemo.has(dir)) return lockPathMemo.get(dir);
  const p = resolveGateLockPath(dir);
  lockPathMemo.set(dir, p);
  return p;
}
function resolveGateLockPath(dir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (out) {
      const common = resolve(dir, out);
      const lockDir = join(common, "doug");
      accessSync(common, constants.W_OK);
      if (existsSync(lockDir)) accessSync(lockDir, constants.W_OK);
      return join(lockDir, "gate.lock");
    }
  } catch {
    // fall through to the per-checkout path
  }
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
export function writeGateLock(dir, sessionId, pid = process.pid) {
  const p = gateLockPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ pid, session: sessionId, at: Date.now() }), { flag: "wx" });
}

// Overwrites gate.lock with this gate's own pid/session, whether it was stale (a dead pid) or its holder
// simply never let go inside the wait bound — either way, never lets a lock the gate cannot even write hang
// it (best-effort; a failure here just leaves lockOwned false to the caller, which never releases a lock it
// does not hold).
export function takeOverGateLock(dir, sessionId) {
  try {
    const p = gateLockPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid: process.pid, session: sessionId, at: Date.now() }));
  } catch {
    // best-effort takeover only
  }
}

// Card gate-load-timeouts: exclusive acquisition for a waiter that saw the lock released, dead or stale. The
// old path overwrote it, so two waiters leaving the wait loop together both ran their suites (ledger blocks 425
// and 426). Creates with wx; a stale lock is removed only while the content judged stale is still in place, and
// EEXIST reports "busy" so the caller keeps waiting. Returns "acquired", "busy" or "unwritable" (the lock cannot
// be written at all: run unlocked). Never throws.
export function acquireGateLock(dir, sessionId, hookTimeoutMs, pid = process.pid) {
  try {
    const p = gateLockPath(dir);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeGateLock(dir, sessionId, pid);
        return "acquired";
      } catch (err) {
        if (!err || err.code !== "EEXIST") return "unwritable";
      }
      let raw;
      try {
        raw = readFileSync(p, "utf8");
      } catch {
        continue; // released between the create and the read: try the create again
      }
      let lock = null;
      try {
        const o = JSON.parse(raw);
        lock = o && typeof o === "object" && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
      } catch {
        lock = null;
      }
      if (lock && pidIsLive(lock.pid) && !lockStaleByAge(lock, hookTimeoutMs)) return "busy";
      try {
        if (readFileSync(p, "utf8") !== raw) return "busy"; // someone else replaced it meanwhile
        unlinkSync(p);
      } catch {
        // already gone, or not removable: the next create decides
      }
    }
    return "busy";
  } catch {
    return "unwritable";
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

// Card gate-load-timeouts: CLI for .githooks/pre-commit, so a commit's suites queue on the same gate.lock as the
// Stop gate and verify.mjs (ledger blocks 422, 432, 435 had a lock-free pre-commit suite next to a gate's).
// `node gate-lock.mjs run -- <command> [args...]`, run from the repo top level: waits on a live lock up to
// stopGate.timeoutMs (default 300000), then runs anyway; a stale lock is taken at once; a lock that cannot be
// written runs unlocked. Leading NAME=VALUE arguments set the command's env; one remaining argument runs via `sh -c`.
// Holds the lock while the command runs, releases it, exits with the command's status.
function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) {
  const args = process.argv.slice(2);
  const dir = process.cwd();
  const sub = args[0];
  if (sub === "acquire" || sub === "release") {
    // Card gate-lock-takeover-exclusive: one lock for a whole shell hook, held under the hook shell's own pid
    // (`--pid $$`, alive for the whole hook). `acquire` waits like `run` and exits 0 whether it owns the lock,
    // gave up waiting, or the lock is unwritable (the hook then runs unlocked); a non-zero exit is a runner
    // failure. `release` removes the lock only when it names that pid, and never fails.
    const pidArg = args.indexOf("--pid") === -1 ? NaN : Number(args[args.indexOf("--pid") + 1]);
    if (!Number.isInteger(pidArg) || pidArg <= 0) {
      process.stderr.write(`usage: gate-lock.mjs ${sub} --pid <pid>\n`);
      process.exit(2);
    }
    if (sub === "release") {
      try {
        const lock = readGateLock(dir);
        if (lock && lock.pid === pidArg) unlinkSync(gateLockPath(dir));
      } catch {
        // never fail a release
      }
      process.exit(0);
    }
    let waitMs = 300000;
    let hookTimeoutMs = 600000;
    try {
      const cfg = loadConfig(dir);
      waitMs = normalizedTimeoutMs(cfg) ?? waitMs;
      hookTimeoutMs = resolveHookTimeoutSec(cfg) * 1000;
    } catch {
      // defaults
    }
    const deadline = Date.now() + waitMs;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      const r = acquireGateLock(dir, "pre-commit", hookTimeoutMs, pidArg);
      if (r !== "busy") break;
      if (Date.now() >= deadline) {
        process.stderr.write(`[doug] pre-commit: gate.lock still held after ${waitMs} ms; running anyway.\n`);
        break;
      }
      Atomics.wait(nap, 0, 0, 200);
    }
    process.exit(0);
  }
  const sep = args.indexOf("--");
  const cmd = sep === -1 ? [] : args.slice(sep + 1);
  if (args[0] !== "run" || cmd.length === 0) {
    process.stderr.write("usage: gate-lock.mjs run -- <command> [args...]\n");
    process.exit(2);
  }
  let owned = false;
  const release = () => {
    try {
      if (!owned) return;
      owned = false;
      const lock = readGateLock(dir);
      if (lock && lock.pid === process.pid) unlinkSync(gateLockPath(dir));
    } catch {
      // never throw from a release
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(128));
  try {
    let waitMs = 300000;
    let hookTimeoutMs = 600000;
    try {
      const cfg = loadConfig(dir);
      waitMs = normalizedTimeoutMs(cfg) ?? waitMs;
      hookTimeoutMs = resolveHookTimeoutSec(cfg) * 1000;
    } catch {
      // defaults
    }
    const deadline = Date.now() + waitMs;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      const r = acquireGateLock(dir, "pre-commit", hookTimeoutMs);
      if (r === "acquired") {
        owned = true;
        break;
      }
      if (r === "unwritable") break;
      if (Date.now() >= deadline) {
        process.stderr.write(`[doug] pre-commit: gate.lock still held after ${waitMs} ms; running ${cmd[0]} anyway.\n`);
        break;
      }
      Atomics.wait(nap, 0, 0, 200);
    }
  } catch {
    // run unlocked rather than block a commit on a lock fault
  }
  // Card gate-lock-run-shell-forms: leading NAME=VALUE arguments go into the child's environment, a single
  // remaining argument runs through `sh -c` (a quoted compound command), and several arguments spawn as argv
  // unchanged. A command that cannot be spawned says so on stderr and exits 127 instead of a silent 1.
  const env = { ...process.env };
  let argv = cmd;
  while (argv.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    const eq = argv[0].indexOf("=");
    env[argv[0].slice(0, eq)] = argv[0].slice(eq + 1);
    argv = argv.slice(1);
  }
  const res =
    argv.length === 1
      ? spawnSync("sh", ["-c", argv[0]], { stdio: "inherit", env })
      : spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
  release();
  if (res.error) {
    process.stderr.write(`[doug] gate-lock run: cannot run ${argv[0]}: ${res.error.message}\n`);
    process.exit(127);
  }
  process.exit(res.status === null ? 1 : res.status);
}
