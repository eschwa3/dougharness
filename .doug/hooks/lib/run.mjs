import { spawnSync } from "node:child_process";

// card gates-runner-no-color: NO_COLOR, not FORCE_COLOR — vitest's colour library (picocolors/tinyrainbow)
// treats any FORCE_COLOR key as colour on, even "0", which broke the stop gate's captured output and the
// block ledger's failing-file parse (same fact as land.mjs's commandEnv, card land-force-color-enables-color).
export function commandEnv(base = process.env) {
  const env = { ...base, CI: base.CI ?? "1", NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

// Runs a shell command in the project dir with a timeout. Never throws.
export function runCommand(command, { cwd, timeoutMs = 300000, env = process.env } = {}) {
  const started = Date.now();
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: commandEnv(env),
    // 2026-09-16 process storm (card stop-gate-process-storm): detached makes the spawned shell the leader
    // of its own process group, so a timeout can kill that whole group below, not just the direct child.
    detached: true,
  });
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  // spawnSync's own `timeout` (ETIMEDOUT) and `maxBuffer` (ENOBUFS) both signal only the direct child (the
  // shell); anything that child spawned (e.g. a background test worker) is left running under pid 1 — four
  // concurrent SubagentStops each doing this orphaned ten vitest workers apiece and downed the watchdog three
  // times on 2026-09-16. Killed on ANY res.error with a pid (not just ETIMEDOUT; reviewer-found gap), since a
  // maxBuffer overflow leaves the same orphaned-descendants shape as a timeout does. With `detached: true`
  // above, res.pid is the process-group leader, so signalling the negative pid reaches every descendant still
  // in that group. `timedOut` itself still reports only the ETIMEDOUT case, unchanged.
  if (res.error && res.pid) {
    try {
      process.kill(-res.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  }
  return {
    command,
    ok: !timedOut && res.status === 0,
    status: res.status,
    timedOut: !!timedOut,
    durationMs: Date.now() - started,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.error ? String(res.error.message) : ""),
  };
}

// Keeps the last N lines of output so a block reason stays readable.
export function tail(text, lines = 30) {
  const arr = String(text).trimEnd().split("\n");
  return arr.slice(-lines).join("\n");
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI_RE, "");

// card gate-output-names-failures: `tail` alone buries a real vitest failure under dozens of passing lines,
// leaving no failing test name in a block reason (brief F1/F2). Leads with the failure-naming lines (`FAIL`,
// `×`, `✗`; a `×` line's `→` message right after it) and the final `Test Files`/`Tests` totals, in output
// order and each kept once, then fills the rest of `maxLines` with the plain tail of whatever wasn't already
// shown - skipping any OTHER totals-shaped line too (review H10: a `pnpm -r --stream` run prints one
// `Test Files`/`Tests` pair per package, so without this the tail filler pulls the earlier, per-package
// pairs back in and the totals show up more than once). No vitest-shaped lines at all -> identical to
// `tail(text, maxLines)`. When the failure-naming lines alone would overflow `maxLines`, keeps the first
// `maxLines - 3` of them plus the two totals lines plus one `… <n> more failing tests not shown` line (40
// total at the default cap) rather than growing past the cap. ANSI escapes are stripped from every kept
// line. `maxLines < 4` (too small to fit totals plus the overflow line at all) falls back to a plain tail
// (review m2). Never throws.
export function failureSummary(output, maxLines = 40) {
  let raw;
  try {
    raw = String(output ?? "").trimEnd();
  } catch {
    // review m1: `output`'s own toString threw; there is nothing safe left to summarise or tail.
    return "";
  }
  if (raw === "") return "";
  if (maxLines < 4) return tail(raw, maxLines);
  try {
    const rawLines = raw.split("\n");
    const cleanLines = rawLines.map(stripAnsi);
    const used = new Set();
    const headIdx = [];
    for (let i = 0; i < cleanLines.length; i++) {
      if (used.has(i)) continue;
      if (!/^\s*(FAIL|×|✗)\s/.test(cleanLines[i])) continue;
      headIdx.push(i);
      used.add(i);
      // a `×` line's `→` message belongs with it, kept whole right after.
      if (/^\s*×\s/.test(cleanLines[i]) && i + 1 < cleanLines.length && !used.has(i + 1) && /^\s*→/.test(cleanLines[i + 1])) {
        headIdx.push(i + 1);
        used.add(i + 1);
      }
    }
    if (headIdx.length === 0) return tail(raw, maxLines);

    // review MAJOR M-A: a `pnpm -r` run prints one `Test Files`/`Tests` pair per package, so scanning for
    // every line matching the pattern (as before) could add thousands of totals lines and blow the cap wide
    // open. Only the LAST `Test Files` line and the LAST `Tests` line are the overall run's own totals; kept
    // (at most one of each, at most 2 lines total) instead, which also keeps the head budget non-negative
    // for any input size.
    let lastTestFilesIdx = -1;
    let lastTestsIdx = -1;
    for (let i = 0; i < cleanLines.length; i++) {
      if (used.has(i)) continue;
      if (/^\s*Test Files\s/.test(cleanLines[i])) lastTestFilesIdx = i;
      else if (/^\s*Tests\s/.test(cleanLines[i])) lastTestsIdx = i;
    }
    const totalsIdx = [lastTestFilesIdx, lastTestsIdx].filter((i) => i !== -1).sort((a, b) => a - b);
    for (const i of totalsIdx) used.add(i);

    const headLines = headIdx.map((i) => cleanLines[i]);
    const totalsLines = totalsIdx.map((i) => cleanLines[i]);

    if (headLines.length + totalsLines.length > maxLines) {
      const keepHeadCount = Math.max(0, maxLines - totalsLines.length - 1);
      const kept = headLines.slice(0, keepHeadCount);
      const dropped = headLines.slice(keepHeadCount);
      const droppedNamed = dropped.filter((l) => /^\s*(FAIL|×|✗)\s/.test(l)).length;
      return [...kept, ...totalsLines, `… ${droppedNamed} more failing tests not shown`].join("\n");
    }

    const resultLines = [...headLines, ...totalsLines];
    const remaining = maxLines - resultLines.length;
    if (remaining > 0) {
      // review H10: an earlier per-package Test Files/Tests pair is not in `used` (only the LAST pair is
      // kept as the real totals above), but it must still be skipped here, or the tail filler pulls it back
      // in and the totals end up shown more than once.
      const filler = [];
      for (let i = cleanLines.length - 1; i >= 0 && filler.length < remaining; i--) {
        if (used.has(i)) continue;
        if (/^\s*(Test Files|Tests)\s/.test(cleanLines[i])) continue;
        filler.push(cleanLines[i]);
      }
      filler.reverse();
      resultLines.push(...filler);
    }
    return resultLines.join("\n");
  } catch {
    // review m1: `raw` is already a plain, safely-coerced string, so this fallback cannot itself throw.
    return tail(raw, maxLines);
  }
}
