// Test-count ratchet (card test-count-ratchet): pure logic for parsing a vitest summary, comparing it with a
// baseline, and matching a waiver. The Stop gate calls it; nothing here touches the filesystem or throws.
//
// Known limits, stated on purpose:
//   - Counts cannot see delete-one-add-one: a session that removes a test and adds an unrelated one keeps
//     every number level and passes.
//   - The verified-unchanged skip runs no test command, so there is no output to count there; no count check
//     happens on it. (The pre-commit credit path is counted from the totals the hook records in last-run.json.)
//   - A runner that prints one summary per package (`pnpm -r`) reads as conflicting summaries and blocks.
//   - Runners other than vitest print no `Tests` summary in this shape: no summary is parsed, no check runs.

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "");
}

const SEGMENT_RE = /^(\d+) (failed|passed|skipped|todo)$/;
const TESTS_LINE_RE = /^\s*Tests\s+(.+?)\s*$/;
const TOTAL_RE = /^(.*) \((\d+)\)$/;

// One line's value part ("1 failed | 2 passed | 3 skipped (6)") -> { total, skipped, todo } or null.
function parseSummaryValue(value) {
  const m = TOTAL_RE.exec(value);
  if (!m) return null;
  const counts = { skipped: 0, todo: 0 };
  for (const seg of m[1].split(" | ")) {
    const s = SEGMENT_RE.exec(seg.trim());
    if (!s) return null;
    if (s[2] === "skipped" || s[2] === "todo") counts[s[2]] = Number(s[1]);
  }
  return { total: Number(m[2]), skipped: counts.skipped, todo: counts.todo };
}

// Every `Tests` summary line is collected (never "the last one": a test can print a byte-identical line).
// -> { status: "ok", totals } | { status: "none" } | { status: "conflict", summaries }
export function parseTotals(output) {
  try {
    if (typeof output !== "string") return { status: "none" };
    const summaries = [];
    for (const line of stripAnsi(output).split(/\r?\n/)) {
      const m = TESTS_LINE_RE.exec(line);
      if (!m) continue;
      const parsed = parseSummaryValue(m[1]);
      if (parsed) summaries.push(parsed);
    }
    if (summaries.length === 0) return { status: "none" };
    const first = summaries[0];
    const same = (s) => s.total === first.total && s.skipped === first.skipped && s.todo === first.todo;
    if (summaries.every(same)) return { status: "ok", totals: { ...first } };
    return { status: "conflict", summaries };
  } catch {
    return { status: "none" };
  }
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

// A baseline entry usable for comparison, or null.
export function validTotals(t) {
  if (!t || typeof t !== "object") return null;
  if (!isCount(t.total) || !isCount(t.skipped) || !isCount(t.todo)) return null;
  return { total: t.total, skipped: t.skipped, todo: t.todo };
}

// Total dropped, or skipped/todo rose. A rise in total or a drop in skipped/todo is never a problem.
export function compareTotals(baseline, now) {
  const out = [];
  if (now.total < baseline.total) out.push({ kind: "total", baseline: baseline.total, now: now.total });
  if (now.skipped > baseline.skipped) out.push({ kind: "skipped", baseline: baseline.skipped, now: now.skipped });
  if (now.todo > baseline.todo) out.push({ kind: "todo", baseline: baseline.todo, now: now.todo });
  return out;
}

export function deltaTotals(baseline, now) {
  return { total: now.total - baseline.total, skipped: now.skipped - baseline.skipped, todo: now.todo - baseline.todo };
}

const WAIVER_RE = /^test-count-waiver: total=([+-]?\d+) skipped=([+-]?\d+) todo=([+-]?\d+);(.*)$/;

// One line -> { total, skipped, todo, reason } or null. The reason must be non-empty after trimming.
export function parseWaiver(line) {
  if (typeof line !== "string") return null;
  const m = WAIVER_RE.exec(line.trim());
  if (!m) return null;
  const reason = m[4].trim();
  if (!reason) return null;
  return { total: Number(m[1]) + 0, skipped: Number(m[2]) + 0, todo: Number(m[3]) + 0, reason };
}

// sources: strings, each possibly several lines. Covers only when all three deltas equal the actual ones.
export function waiverCovers(sources, delta) {
  try {
    if (!Array.isArray(sources)) return false;
    for (const src of sources) {
      if (typeof src !== "string") continue;
      for (const line of src.split(/\r?\n/)) {
        const w = parseWaiver(line);
        if (w && w.total === delta.total && w.skipped === delta.skipped && w.todo === delta.todo) return true;
      }
    }
  } catch {
    // a broken source never covers
  }
  return false;
}
