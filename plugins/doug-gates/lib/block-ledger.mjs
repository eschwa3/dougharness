// The block ledger (card stop-gate-block-ledger): one JSON line per Stop/SubagentStop block or stand-down,
// appended to .doug/.state/blocks.jsonl, so a later report (hand-report-schema) can read what the gate did
// without relying on the lead's own memory of it. `classifyFinalBlock` only LABELS a block for that report -
// it never decides whether the gate itself blocks or lets a stop through; that call is stop-gate.mjs's alone,
// made before classification ever runs. `appendBlockLine` never throws (a hook reader must never throw,
// CLAUDE.md gotchas): a failed write just skips the line, leaving the gate's own decision unchanged.
// The race class has a known limit: a check command that leaves unignored untracked output behind makes every block read 'race', and a content change to an already-dirty file is not seen.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { changedFiles } from "./baseline.mjs";
import { scanText } from "./secret-rules.mjs";

export const BLOCKS_RELPATH = ".doug/.state/blocks.jsonl";

// A leading "./" is not part of a path token's identity (same normalisation stop-gate.mjs's own claim
// matching uses).
function stripLeadingDotSlash(f) {
  return typeof f === "string" && f.startsWith("./") ? f.slice(2) : f;
}

const TEST_FILE_RE = /\.(?:test|spec)\.[A-Za-z]+$/;

// Every path a tsc error line names (card stop-gate-tsc-red-claim): a path token immediately followed by
// `(<line>,<col>): error TS<digits>` anywhere on the line, so a `pnpm -r` prefix does not hide it. Same
// normalisation as failingTestFilesFrom (leading "./", then `dir + "/"`). Never throws: reads as none.
export function tscErrorPaths(output, dir) {
  try {
    const paths = new Set();
    const MARK = "): error TS";
    const isDigit = (c) => c >= "0" && c <= "9";
    const isStop = (c) => /[\s"'`()]/.test(c);
    for (const line of String(output || "").split("\n")) {
      // Cheap pre-filter, and no backtracking regex: every step below is a linear walk from a marker.
      let at = line.indexOf(MARK);
      while (at !== -1) {
        const after = at + MARK.length;
        let i = at - 1;
        const colEnd = i;
        while (i >= 0 && isDigit(line[i])) i--;
        let ok = i < colEnd && line[i] === "," ;
        if (ok) {
          i--;
          const lineEnd = i;
          while (i >= 0 && isDigit(line[i])) i--;
          ok = i < lineEnd && line[i] === "(";
        }
        if (ok && isDigit(line[after] || "")) {
          const pathEnd = i;
          let j = pathEnd;
          while (j > 0 && !isStop(line[j - 1])) j--;
          if (j < pathEnd) {
            let f = stripLeadingDotSlash(line.slice(j, pathEnd));
            if (typeof dir === "string" && dir && f.startsWith(dir + "/")) f = f.slice(dir.length + 1);
            paths.add(f);
          }
        }
        at = line.indexOf(MARK, at + 1);
      }
    }
    return [...paths];
  } catch {
    return [];
  }
}

// The tsc error paths in `output` that are not test files; one of these means the failure is not red by design.
export function nonTestTscPathsFrom(output, dir) {
  try {
    return tscErrorPaths(output, dir).filter((f) => !TEST_FILE_RE.test(f));
  } catch {
    return [];
  }
}

// Test files a failed verification command's output names: every path token ending in ".test.<ext>" or
// ".spec.<ext>" (ext = letters) on a line containing "FAIL" or "failed", deduplicated, normalised to a
// repository-relative path when absolute under `dir`. Moved here from stop-gate.mjs (card
// stop-gate-block-ledger) so the classifier below and stop-gate.mjs's own tests_red_by_design coverage check
// share one implementation instead of two that could drift. Never throws: a parse failure reads as no files
// named.
export function failingTestFilesFrom(output, dir) {
  try {
    const files = new Set();
    const tokenRe = /[^\s"'`]+\.(?:test|spec)\.[A-Za-z]+/g;
    for (const p of tscErrorPaths(output, dir)) if (TEST_FILE_RE.test(p)) files.add(p);
    for (const line of String(output || "").split("\n")) {
      if (!line.includes("FAIL") && !line.includes("failed")) continue;
      for (const m of line.matchAll(tokenRe)) {
        let f = m[0];
        f = f.replace(/^[([<"'`]+/, "");
        f = stripLeadingDotSlash(f);
        if (typeof dir === "string" && dir && f.startsWith(dir + "/")) f = f.slice(dir.length + 1);
        files.add(f);
      }
    }
    return [...files];
  } catch {
    return [];
  }
}

// The final verification block's class (brief Rules, first match wins):
// 1. 'expected-red' — the only problems are failed commands (no pre-verification problem, no evidence
//    problem, no budget-dropped command: the same precondition stop-gate.mjs's own honoured-claim path
//    uses), EVERY failed command's output names at least one test file (review pass 2, item 1 MAJOR: the
//    same per-command precondition redByDesignCoverage in stop-gate.mjs already enforces for honouring a
//    claim — a second, unrelated command that names no test file at all must not be waved through just
//    because the one command the claim does cover is also failing), and every named file across all of
//    them is in the standing tests_red_by_design claim (`redByDesignClaimFiles`).
// 2. 'load-timeout' — at least one command timed out or was dropped for budget, and no failed command's
//    captured output names a failing test file.
// 3. 'race' — the working tree (`changedFiles(dir)`, as a set) differs now from `changedAtStart`. Either
//    side being unknown (null: no git, or git unavailable) is never a race. Skipped entirely once
//    `budgetDeadline` (the gate's own hook-timeout deadline, gateBudget() in stop-gate.mjs) has already
//    passed (review pass 2, item 4): a second `git status` here is exactly the kind of extra work that
//    could push a slow gate past the platform's own hook timeout, discarding its block message (F1) — a
//    deadline already blown is not worth spending on a label, so this falls through to 'real' instead.
// 4. 'real' — otherwise.
//
// Never throws (review pass 2, item 2 MAJOR): this call sits between the gate's decision to block and the
// blockStop call that carries it out (stop-gate.mjs), so an unguarded throw here would fail the *whole gate*
// open — the one outcome every hook reader must never risk (CLAUDE.md gotchas). Any failure classifies as
// 'real', the least specific label, rather than ever propagating.
export function classifyFinalBlock({ countProblems, totalProblems, preVerificationProblems, evidenceProblemAdded, commandFailures, postCommandProblems, results, redByDesignClaimFiles, changedAtStart, dir, budgetDeadline }) {
  try {
    const failures = Array.isArray(commandFailures) ? commandFailures : [];
    const namedByCommand = failures.map((cf) => failingTestFilesFrom(cf.output, dir));
    const allNamed = [...new Set(namedByCommand.flat())];

    const nonTestTsc = failures.some((cf) => nonTestTscPathsFrom(cf.output, dir).length > 0);

    const onlyFailedCommands =
      preVerificationProblems === 0 &&
      !evidenceProblemAdded &&
      failures.length > 0 &&
      postCommandProblems - preVerificationProblems === failures.length;
    const everyCommandNamedAFile = failures.length > 0 && namedByCommand.every((files) => files.length > 0);
    if (onlyFailedCommands && !nonTestTsc && everyCommandNamedAFile && Array.isArray(redByDesignClaimFiles) && redByDesignClaimFiles.length > 0) {
      const claimSet = new Set(redByDesignClaimFiles);
      if (allNamed.every((f) => claimSet.has(f))) return "expected-red";
    }

    // card block-ledger-failing-output: the test-count ratchet is the block's only problem.
    const timedOutOrDropped = (Array.isArray(results) ? results : []).some((r) => r.timedOut || r.skipped === "budget");
    if (timedOutOrDropped && allNamed.length === 0) return "load-timeout";

    if (typeof countProblems === "number" && countProblems > 0 && totalProblems === countProblems) return "test-count";

    if (Array.isArray(changedAtStart) && !(typeof budgetDeadline === "number" && Date.now() >= budgetDeadline)) {
      const changedNow = changedFiles(dir);
      if (Array.isArray(changedNow)) {
        const before = new Set(changedAtStart);
        const after = new Set(changedNow);
        const same = before.size === after.size && [...before].every((f) => after.has(f));
        if (!same) return "race";
      }
    }

    return "real";
  } catch {
    return "real";
  }
}

// card block-ledger-failing-output: the last 40 lines of a command's output, secret-scanned (a hit records
// "[redacted: <rule>]", a scanner throw "[redacted: scan-error]"; skipped when secrets.enabled === false),
// then capped at 4096 UTF-8 bytes keeping the end, never splitting a character. Never throws.
export function redactText(text, secrets) {
  try {
    if (!(secrets && secrets.enabled === false)) {
      const hit = scanText(text, secrets || {});
      if (hit) return "[redacted: " + hit.rule + "]";
    }
    return text;
  } catch {
    return "[redacted: scan-error]";
  }
}

export function outputTail(output, secrets) {
  try {
    let tail = String(output ?? "").trimEnd().split("\n").slice(-40).join("\n");
    tail = redactText(tail, secrets);
    const buf = Buffer.from(tail, "utf8");
    if (buf.length > 4096) {
      let start = buf.length - 4096;
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
      tail = buf.subarray(start).toString("utf8");
    }
    return tail;
  } catch {
    return "";
  }
}

// Appends one line to .doug/.state/blocks.jsonl: { hook, at, agent, reason, class, session }, plus the keys of
// `record` ({ failures, cwd, tree }, card block-ledger-failing-output) when it is a plain object. `reason` is
// reduced to its own first line here (message.split("\n")[0]) whatever the caller passes, so a multi-line
// block message never leaks past its headline into the ledger. Call synchronously, right before each
// blockStop/systemMessage in stop-gate.mjs — those each call process.exit(0) themselves, so anything queued
// after them never runs. Never throws: an unwritable .doug/.state, or a blocks.jsonl path that is itself a
// directory, just skips the line silently; the gate's own decision is unaffected either way.
export function appendBlockLine(dir, { hook, agent, reason, class: cls, session, record }) {
  try {
    const plain = record && typeof record === "object" && !Array.isArray(record) ? record : {};
    const line =
      JSON.stringify({
        hook,
        at: new Date().toISOString(),
        agent: agent ?? null,
        reason: String(reason).split("\n")[0],
        class: cls,
        session: session ?? null,
        ...plain,
      }) + "\n";
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    appendFileSync(join(dir, BLOCKS_RELPATH), line);
  } catch {
    // a ledger write must never turn a block into a pass (a hook reader must never throw)
  }
}
