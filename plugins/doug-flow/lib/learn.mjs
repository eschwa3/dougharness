// Deterministic proposals from the outcomes/lessons store and the run trace (card learn-signals). Log-then-
// propose, never auto-apply: collectSignals counts what already happened (the outcomes table, lesson counters,
// permission denials and skill invocations from the run trace), proposeChanges renders each candidate change as
// a unified diff against its target file's current content, writeProposals stores them under
// .doug/.state/learn/, and applyProposal is the only function that ever touches a tracked file - and only for a
// proposal file the caller names, refusing a target under protectedPaths. No LLM call, no network: every
// function here is pure given its inputs (an open memory store, a trace directory, file contents and a skill
// list the caller already read).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative, resolve, sep, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { listOutcomes, listLessons, jaccard, reflectTokens, REFLECT_DUPLICATE_JACCARD } from "./memory.mjs";

// --- collectSignals ----------------------------------------------------------------------------------------

// card op-learn-gate-shape: a hand row's gate text is free-form per project ("typecheck 0; unit 639 passed" for
// Doug itself, "pytest 0" or "ruff 0; pytest 2" for a pytest project, "npm test 1" for an npm one, ...), so
// reading it as a failure unless it starts with Doug's own literal "typecheck 0" misclassified every other
// project's green gate as a failure. readGate reads each top-level ";"/","-separated clause instead: a
// ";" or "," inside a clause's own parenthesised note (e.g. "pytest 0 (41 passed, 2 skipped)") never splits
// that clause, since the note is free text and may itself carry commas. Within a clause: a `<n> passed`
// count is neutral, a clause naming a fail/error word is a failure, and a clause ending in an exit code (an
// optional parenthesised note allowed) is a pass or a failure by that code - independent of Doug's own shape.
const PASSED_COUNT_RE = /^.*\S\s+\d+\s+passed$/i;
const FAIL_WORD_RE = /\b(fail|fails|failed|failure|failures|error|errors)\b/i;
const EXIT_CLAUSE_RE = /^(.*\S)\s+(\d+)(\s*\([^)]*\))?$/;

// Splits on a top-level ";" or "," only - one inside parentheses (depth tracked, not just "the last paren")
// stays part of its clause, so a parenthesised note's own comma (a pass/skip breakdown) never fractures the
// clause it belongs to.
function splitGateClauses(gate) {
  const clauses = [];
  let depth = 0;
  let current = "";
  for (const ch of gate) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === ";" || ch === ",") && depth === 0) {
      clauses.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  clauses.push(current);
  return clauses.map((c) => c.trim()).filter((c) => c.length > 0);
}

// Pure: reads one hand-track gate string into "pass" or "fail" (see the rules in the comment above). Exported
// for both isGateFailure below and run-report/doug-hand's own use of the same reading.
export function readGate(gate) {
  if (typeof gate !== "string" || !gate.trim()) return "fail";
  const clauses = splitGateClauses(gate);
  let hasFailingClause = false;
  let hasPassingExitClause = false;
  for (const clause of clauses) {
    if (PASSED_COUNT_RE.test(clause)) continue; // a) a pass count - neutral
    if (FAIL_WORD_RE.test(clause)) {
      hasFailingClause = true; // b) a fail/error word - failing, checked before c)
      continue;
    }
    const m = EXIT_CLAUSE_RE.exec(clause);
    if (m) {
      if (Number(m[2]) !== 0) hasFailingClause = true; // c) a non-zero exit clause - failing
      else hasPassingExitClause = true; // c) a zero exit clause - passing
      continue;
    }
    // d) anything else - neutral
  }
  return !hasFailingClause && hasPassingExitClause ? "pass" : "fail";
}

// A hand row's own gate text is the only record of pass/fail on that track (no independent verifier runs on
// it); a flow row's `verified` column is that record on the flow track. See memory.mjs's OUTCOMES_COLUMNS_SQL
// comment for why the two tracks are never averaged together.
function isGateFailure(row) {
  if (row.track === "flow") return row.verified === 0;
  if (row.track === "hand") return readGate(row.gate) === "fail";
  return false;
}

// Union-find clustering of live lessons by near-duplicate text (memory.mjs's own REFLECT_DUPLICATE_JACCARD
// threshold and jaccard function - the same "near-duplicate" memory-reflect already uses to bump a lesson
// instead of appending one). A cluster of >=2 is "repeated" by text; a lesson on its own with helpful >= 3 is
// "repeated" by use. Both paths only ever report a count of >= 2, so a caller can treat `count >= 2` as one
// uniform test.
function groupRepeatedLessons(live) {
  const n = live.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const tokens = live.map((l) => reflectTokens(l.text));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccard(tokens[i], tokens[j]) >= REFLECT_DUPLICATE_JACCARD) union(i, j);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  }
  const repeated = [];
  for (const idxs of clusters.values()) {
    if (idxs.length >= 2) {
      const members = idxs.map((i) => live[i]).sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")) || a.id.localeCompare(b.id));
      repeated.push({ text: members[0].text, ids: members.map((l) => l.id).sort(), kind: members[0].kind, count: members.length });
    } else {
      const l = live[idxs[0]];
      if (l.helpful >= 3) repeated.push({ text: l.text, ids: [l.id], kind: l.kind, count: l.helpful });
    }
  }
  repeated.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  return repeated;
}

function listTraceFiles(traceDir) {
  if (!existsSync(traceDir)) return [];
  return readdirSync(traceDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

// Every well-formed line of a trace file, in order; a torn line (a crashed hook mid-write) is skipped, never
// fatal - mirrors plugins/doug-gates/lib/trace.mjs's readTrace, duplicated locally rather than imported across
// the plugin boundary (no workspace dependency exists between doug-flow and doug-gates; memory.mjs's own
// globToRegExp/scopeMatchesFiles follow the same local-duplication precedent for doug-gates/lib/glob.mjs).
function readTraceFileLines(file) {
  const out = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && o.event) out.push(o);
    } catch {
      // a torn line from a crashed hook is skipped, never fatal
    }
  }
  return out;
}

// `denials` is the actual denial signal: an explicit PermissionDenied trace line, grouped by (tool, detail).
// `unmatched` is a separate, weaker signal - a PreToolUse line whose toolUseId never gets a matching
// PostToolUse in the same file. Review MINOR 1: on this repo's 36 real trace files that gap heuristic alone
// produced 246 "denials" that were Artifact, StructuredOutput, and ordinary successful grep/ls/cat calls, not
// denials - an unmatched PreToolUse can be a hook timeout, an interrupted call, a session end, or simply a
// tool whose PostToolUse never fires. It is reported for a human reader (`learn.mjs signals`) and never drives
// a proposal - `demote` reads `denials` only. Agent/AskUserQuestion/Skill calls are excluded from `unmatched`
// (they route through their own gates, not a plain allow/deny), and so is the very last line of a file (that
// call may simply still be in flight when the trace stopped).
//
// Review MAJOR 1: a denied call fires both a PreToolUse line (with no matching PostToolUse - denied calls
// never run) and a PermissionDenied line, both carrying the same toolUseId. Counting the PreToolUse side as an
// `unmatched` gap too double-counted the same denial - a single denied Bash call read as 2, tripping `demote`
// on its own. So a toolUseId the file also carries a PermissionDenied line for is excluded from `unmatched`:
// it was already counted once, in `denials`.
const EXCLUDED_GAP_TOOLS = new Set(["Agent", "AskUserQuestion", "Skill"]);

function bumpGroup(map, tool, detail, reason) {
  const key = `${tool || ""} ${detail || ""}`;
  const cur = map.get(key) || { tool: tool || null, detail: detail || null, reason: null, count: 0 };
  cur.count += 1;
  if (!cur.reason && reason) cur.reason = reason;
  map.set(key, cur);
}

function sortGroups(groups) {
  return groups.sort((a, b) => b.count - a.count || String(a.tool).localeCompare(String(b.tool)));
}

function collectTraceSignals(traceDir) {
  const files = listTraceFiles(traceDir);
  const denialGroups = new Map();
  const unmatchedGroups = new Map();
  const skillCounts = new Map();
  const instructionsLoaded = new Map();

  for (const name of files) {
    const lines = readTraceFileLines(join(traceDir, name));
    const postedToolUseIds = new Set(lines.filter((l) => l.event === "PostToolUse" && l.toolUseId).map((l) => l.toolUseId));
    const deniedToolUseIds = new Set(lines.filter((l) => l.event === "PermissionDenied" && l.toolUseId).map((l) => l.toolUseId));
    lines.forEach((l, idx) => {
      if (l.event === "PermissionDenied") {
        bumpGroup(denialGroups, l.tool, l.detail, l.reason || null);
        return;
      }
      if (l.event === "PreToolUse") {
        if (l.tool === "Skill" && l.detail) skillCounts.set(l.detail, (skillCounts.get(l.detail) || 0) + 1);
        const isLastLine = idx === lines.length - 1;
        const alreadyDenied = l.toolUseId && deniedToolUseIds.has(l.toolUseId);
        if (!isLastLine && l.toolUseId && !alreadyDenied && !postedToolUseIds.has(l.toolUseId) && !EXCLUDED_GAP_TOOLS.has(l.tool)) {
          bumpGroup(unmatchedGroups, l.tool, l.detail, null);
        }
        return;
      }
      if (l.event === "InstructionsLoaded") {
        const key = l.detail || "(unknown)";
        const cur = instructionsLoaded.get(key) || { file: key, count: 0, reasons: new Set() };
        cur.count += 1;
        if (l.reason) cur.reasons.add(l.reason);
        instructionsLoaded.set(key, cur);
      }
    });
  }

  return {
    files,
    denials: sortGroups([...denialGroups.values()]),
    unmatched: sortGroups([...unmatchedGroups.values()]).map(({ tool, detail, count }) => ({ tool, detail, count })),
    skills: [...skillCounts.entries()].map(([skill, count]) => ({ skill, count })).sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill)),
    instructionsLoaded: [...instructionsLoaded.values()]
      .map((v) => ({ file: v.file, count: v.count, reasons: [...v.reasons].sort() }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
  };
}

// Signals for `learn.mjs propose` (card learn-signals): everything counted from the store (`m`, already open -
// openMemory(dir)) and the run trace (`traceDir`, default <dir>/.doug/.state/trace). `now` is accepted for a
// stable, injectable clock but nothing here currently reads it - kept for parity with collectSignals' sibling
// writeProposals, whose directory name is timestamped.
export function collectSignals(m, { dir, traceDir, now = new Date() } = {}) {
  void now;
  const rows = listOutcomes(m, {});
  const gateFailures = rows.filter(isGateFailure).length;
  const blocksByClass = { real: 0, marginal: 0, false: 0 };
  for (const r of rows) for (const b of r.blocks || []) if (Object.prototype.hasOwnProperty.call(blocksByClass, b.class)) blocksByClass[b.class] += 1;
  let fixSum = 0;
  let fixMax = 0;
  let usdSum = 0;
  let usdN = 0;
  const byCard = {};
  for (const r of rows) {
    if (typeof r.fix_passes === "number") {
      fixSum += r.fix_passes;
      fixMax = Math.max(fixMax, r.fix_passes);
    }
    if (typeof r.usd === "number") {
      usdSum += r.usd;
      usdN += 1;
    }
    if (r.card) {
      const c = byCard[r.card] || (byCard[r.card] = { rows: 0, gateFailures: 0, usd: 0 });
      c.rows += 1;
      if (isGateFailure(r)) c.gateFailures += 1;
      if (typeof r.usd === "number") c.usd += r.usd;
    }
  }

  const allLessons = listLessons(m, { includeSuperseded: true });
  const live = allLessons.filter((l) => !l.superseded_by);

  const td = traceDir || join(dir, ".doug/.state/trace");
  const trace = collectTraceSignals(td);

  return {
    outcomes: { rows, gateFailures, blocksByClass, fixPasses: { sum: fixSum, max: fixMax }, usd: { sum: usdSum, n: usdN }, byCard },
    lessons: {
      total: allLessons.length,
      live: live.length,
      helpful: live.filter((l) => l.helpful > 0).length,
      harmful: live.filter((l) => l.harmful > 0).length,
      stale: live.filter((l) => l.stale).length,
      repeated: groupRepeatedLessons(live),
    },
    trace,
  };
}

// --- proposeChanges -----------------------------------------------------------------------------------------

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// wc -l semantics: the count of newline-terminated lines, not split("\n").length (which counts one extra empty
// element for a file ending in "\n"). CLAUDE.md's own header says "Keep it under 60 lines" against this count.
export function countLines(text) {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function findSection(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// Inserts `bulletLine` as the last `- ` item of the named "## Heading" section; null when the heading is
// missing (nothing to insert under).
export function insertBulletUnderHeading(text, heading, bulletLine) {
  const lines = text.split("\n");
  const sec = findSection(lines, heading);
  if (!sec) return null;
  let insertAt = sec.start + 1;
  for (let i = sec.start + 1; i < sec.end; i++) if (lines[i].startsWith("- ")) insertAt = i + 1;
  lines.splice(insertAt, 0, bulletLine);
  return lines.join("\n");
}

export function removeExactLine(text, line) {
  const lines = text.split("\n");
  const idx = lines.indexOf(line);
  if (idx === -1) return null;
  lines.splice(idx, 1);
  return lines.join("\n");
}

// A rule line's key phrase: its backticked tokens, plus its first 4 significant words (stopwords and words
// shorter than 3 letters dropped). Documented heuristic, not a semantic match - see docs/learn.md for its
// limits (a rule paraphrased with none of these tokens is missed; a coincidental word overlap is a false
// negative on delete, which only ever makes delete too cautious, never too eager).
const KEY_PHRASE_STOPWORDS = new Set(["do", "not", "the", "a", "an", "to", "is", "and", "or", "of", "in", "on", "for", "this", "that", "never", "always", "its", "own"]);

function keyPhraseTokens(line) {
  const backticks = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].toLowerCase());
  const words = line
    .replace(/`[^`]*`/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !KEY_PHRASE_STOPWORDS.has(w));
  return [...new Set([...backticks, ...words.slice(0, 4)])];
}

function textReferencesTokens(text, tokens) {
  const t = normalize(text);
  return tokens.some((tok) => tok && t.includes(tok));
}

// --- a tiny unified-diff renderer for one file's old/new text (no dependency added: git apply reads plain
// unified diffs with "a/"/"b/" headers, which is all applyProposal needs to spend). LCS-based, single-file,
// standard 3-line-context hunks - adequate for the small, mostly single-line edits this module ever proposes
// (one CLAUDE.md bullet, one JSON key). null when old and new are identical (nothing to propose).
function computeLineOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j] });
    j++;
  }
  return ops;
}

// split("\n") on a trailing-newline-terminated string yields one phantom empty trailing element that names no
// real line; both files here always end in "\n" (every writer in this module ends its output that way), so it
// is dropped from both sides before diffing rather than counted as a spurious matching context line at EOF.
function fileLines(text) {
  const parts = text.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function unifiedDiff(relPath, oldText, newText, context = 3) {
  if (oldText === newText) return null;
  const ops = computeLineOps(fileLines(oldText), fileLines(newText));
  let oldLine = 1;
  let newLine = 1;
  const numbered = ops.map((op) => {
    const rec = { op, oldLine, newLine };
    if (op.type === "equal") {
      oldLine++;
      newLine++;
    } else if (op.type === "del") oldLine++;
    else newLine++;
    return rec;
  });
  const ranges = [];
  let i = 0;
  while (i < numbered.length) {
    if (numbered[i].op.type === "equal") {
      i++;
      continue;
    }
    let end = i;
    while (end < numbered.length && numbered[end].op.type !== "equal") end++;
    ranges.push({ start: Math.max(0, i - context), end: Math.min(numbered.length, end + context) });
    i = end;
  }
  const merged = [];
  for (const r of ranges) {
    if (merged.length && r.start <= merged[merged.length - 1].end) merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    else merged.push({ ...r });
  }
  const hunks = merged.map((r) => {
    const slice = numbered.slice(r.start, r.end);
    const oldStart = slice[0].oldLine;
    const newStart = slice[0].newLine;
    const oldCount = slice.filter((s) => s.op.type !== "add").length;
    const newCount = slice.filter((s) => s.op.type !== "del").length;
    const body = slice.map((s) => (s.op.type === "equal" ? " " : s.op.type === "del" ? "-" : "+") + s.op.line).join("\n");
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
  });
  return `--- a/${relPath}\n+++ b/${relPath}\n${hunks.join("\n")}\n`;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const out = { ...obj };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...(cur[keys[i]] || {}) };
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return out;
}

// The small table `demote` matches a repeated Bash denial against: a regex over the denied command, the exact
// phrase that rule takes in CLAUDE.md (so a demote proposal only ever fires against a rule that is really
// there), and the .doug/config.json key that would make the rule mechanical instead of prose. The three
// entries are the three examples the card names; a new rule joins this table by hand, same shape.
const DEMOTE_RULES = [
  { id: "branch-delete", label: "the branch -D rule", claudePhrase: "git branch -D", detailRe: /git\s+branch\s+-D\b/, configKey: "bash.denyDestructive" },
  { id: "raw-pnpm-test", label: "the pnpm test rule", claudePhrase: "never pnpm test", detailRe: /^pnpm\s+test(?!:unit)\b/, configKey: "bash.denyRawTest" },
  { id: "no-trailers", label: "the trailer rule", claudePhrase: "Co-Authored-By", detailRe: /Co-Authored-By|Claude-Session/, configKey: "commit.denyTrailers" },
];

// Review MINOR 7: a `tighten` target is the real path readOwnSkills() (scripts/learn.mjs) read the skill's
// description from (`skill.file`), not a hardcoded `skills/<name>/SKILL.md` - a caller may
// point `learn.mjs` at a checkout laid out differently, or at a skill outside this repository entirely. Made
// relative to `dir` when the file is really inside it (the common case: readable, and matches how every other
// proposal's `target` reads), else reported absolute rather than a misleading relative path. Falls back to the
// plugin-relative `skills/<name>/SKILL.md` shape only for a caller (or an older test fixture) that supplies no `file` at all.
function tightenTarget(dir, skill) {
  if (!skill.file) return `skills/${skill.name}/SKILL.md`;
  const resolved = resolve(skill.file);
  if (dir) {
    const base = resolve(dir);
    if (resolved === base || resolved.startsWith(`${base}${sep}`)) return relative(base, resolved).split(sep).join("/");
  }
  return resolved;
}

// Renders each candidate change as `{ id, kind, target, reason, evidence, diff }`. `claudeMd` and `config` are
// the current text/parsed-object the caller already read (CLAUDE.md, .doug/config.json); `skills` is an array
// of `{ name, description, file }` for every skill the caller wants considered for `tighten` (normally every
// plugins/doug-flow/skills/*/SKILL.md, `file` the real path it was read from). Pure: with no signals the
// result is `[]`, never an error.
export function proposeChanges(signals, { dir, claudeMd, config, skills = [] } = {}) {
  const proposals = [];
  let n = 0;
  const nextId = () => String(++n).padStart(2, "0");

  // promote: a repeated feedback/pitfall lesson not already in CLAUDE.md.
  for (const r of signals.lessons.repeated) {
    if (r.kind !== "feedback" && r.kind !== "pitfall") continue;
    if (normalize(claudeMd).includes(normalize(r.text))) continue;
    const heading = r.kind === "feedback" ? "## Working agreement" : "## Gotchas";
    const bulletLine = `- ${r.text}`;
    const evidence = { count: r.count, ids: r.ids, kind: r.kind };
    const reason = `lesson repeated ${r.count}× (ids: ${r.ids.join(", ")}); promoting to CLAUDE.md's ${heading.replace("## ", "")}`;
    const updated = insertBulletUnderHeading(claudeMd, heading, bulletLine);
    if (updated === null) {
      proposals.push({ id: nextId(), kind: "promote", target: "CLAUDE.md", reason: `${reason}, but CLAUDE.md has no "${heading}" section`, evidence, diff: null });
      continue;
    }
    if (countLines(updated) >= 60) {
      proposals.push({ id: nextId(), kind: "promote", target: "CLAUDE.md", reason: `${reason}, but CLAUDE.md is at its 60-line limit (would be ${countLines(updated)})`, evidence, diff: null });
      continue;
    }
    proposals.push({ id: nextId(), kind: "promote", target: "CLAUDE.md", reason, evidence, diff: unifiedDiff("CLAUDE.md", claudeMd, updated) });
  }

  // demote: a repeated Bash denial matching a known prose rule, not already backed by its config key.
  for (const group of signals.trace.denials) {
    if (group.tool !== "Bash" || group.count < 2) continue;
    for (const rule of DEMOTE_RULES) {
      if (!rule.detailRe.test(group.detail || "")) continue;
      if (!claudeMd.includes(rule.claudePhrase)) continue;
      if (getPath(config, rule.configKey) === true) continue;
      const updatedConfig = setPath(config, rule.configKey, true);
      const oldText = `${JSON.stringify(config, null, 2)}\n`;
      const newText = `${JSON.stringify(updatedConfig, null, 2)}\n`;
      proposals.push({
        id: nextId(),
        kind: "demote",
        target: ".doug/config.json",
        reason: `Bash was denied ${group.count}× matching ${rule.label} ("${group.detail}"); .doug/config.json is a protected path, apply this by hand`,
        evidence: { count: group.count, detail: group.detail, configKey: rule.configKey },
        diff: unifiedDiff(".doug/config.json", oldText, newText),
      });
      break;
    }
  }

  // delete: a CLAUDE.md rule line referenced by no denial, no repeated lesson, and no block description, with
  // enough signal density to trust the absence (>=10 outcome rows, >=5 trace files).
  if (signals.outcomes.rows.length >= 10 && signals.trace.files.length >= 5) {
    const blockDescriptions = signals.outcomes.rows.flatMap((r) => (r.blocks || []).map((b) => b.description || ""));
    const lines = claudeMd.split("\n");
    for (const heading of ["## Working agreement", "## Gotchas"]) {
      const sec = findSection(lines, heading);
      if (!sec) continue;
      for (let i = sec.start + 1; i < sec.end; i++) {
        const line = lines[i];
        if (!line.startsWith("- ")) continue;
        const tokens = keyPhraseTokens(line);
        if (!tokens.length) continue;
        const referenced =
          signals.trace.denials.some((d) => textReferencesTokens(d.detail, tokens)) ||
          signals.lessons.repeated.some((r) => textReferencesTokens(r.text, tokens)) ||
          blockDescriptions.some((d) => textReferencesTokens(d, tokens));
        if (referenced) continue;
        const updated = removeExactLine(claudeMd, line);
        proposals.push({
          id: nextId(),
          kind: "delete",
          target: "CLAUDE.md",
          reason: `no denial, repeated lesson, or block description across ${signals.outcomes.rows.length} outcome rows and ${signals.trace.files.length} trace files mentions "${tokens.join(", ")}"`,
          evidence: { outcomeRows: signals.outcomes.rows.length, traceFiles: signals.trace.files.length, keyPhrase: tokens },
          diff: updated === null ? null : unifiedDiff("CLAUDE.md", claudeMd, updated),
        });
      }
    }
  }

  // tighten: a skill never invoked while another was invoked often, with a long description.
  const busiest = signals.trace.skills.reduce((max, s) => (s.count > (max ? max.count : 0) ? s : max), null);
  if (busiest && busiest.count >= 5) {
    for (const skill of skills) {
      if (!skill.description || skill.description.length <= 400) continue;
      if (skill.name === busiest.skill) continue;
      const own = signals.trace.skills.find((s) => s.skill === skill.name);
      if (own && own.count > 0) continue;
      proposals.push({
        id: nextId(),
        kind: "tighten",
        target: tightenTarget(dir, skill),
        reason: `"${skill.name}" was invoked 0 times across the trace while "${busiest.skill}" was invoked ${busiest.count} times; its description is ${skill.description.length} characters`,
        evidence: { skill: skill.name, invokedCount: 0, busiest: { skill: busiest.skill, count: busiest.count }, descriptionLength: skill.description.length },
        diff: null,
      });
    }
  }

  return proposals;
}

// --- writeProposals / applyProposal --------------------------------------------------------------------------

export const LEARN_STATE_RELPATH = ".doug/.state/learn";

// Review MINOR 5: second resolution let two runs inside the same second collide and overwrite each other's
// proposals. Millisecond resolution (still no ":" or "." - safe as a bare directory name), and - belt and
// braces, since two runs can still land in the same millisecond - writeProposals appends "-2", "-3", ... to
// the first name that doesn't already exist on disk.
function tsFolderName(now) {
  const iso = now.toISOString(); // 2026-09-11T19:05:07.123Z
  return `${iso.slice(0, 10)}T${iso.slice(11, 23).replace(/[:.]/g, "")}`;
}

function freeFolder(dir, base) {
  let folder = join(dir, LEARN_STATE_RELPATH, base);
  let n = 1;
  while (existsSync(folder)) {
    n += 1;
    folder = join(dir, LEARN_STATE_RELPATH, `${base}-${n}`);
  }
  return folder;
}

// Writes proposals.json (every proposal, including diff:null ones) and one NN-<kind>.diff per proposal that
// carries a diff, under .doug/.state/learn/<timestamp>/ - never a tracked file. Returns the paths written.
export function writeProposals(proposals, { dir, now = new Date() } = {}) {
  const folder = freeFolder(dir, tsFolderName(now));
  mkdirSync(folder, { recursive: true });
  const proposalsPath = join(folder, "proposals.json");
  writeFileSync(proposalsPath, `${JSON.stringify(proposals, null, 2)}\n`);
  const diffPaths = [];
  for (const p of proposals) {
    if (!p.diff) continue;
    const diffPath = join(folder, `${p.id}-${p.kind}.diff`);
    writeFileSync(diffPath, p.diff);
    diffPaths.push(diffPath);
  }
  return { dir: folder, proposalsPath, diffPaths };
}

function readConfigProtectedPaths(dir) {
  try {
    const config = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
    return Array.isArray(config.protectedPaths) ? config.protectedPaths : [];
  } catch {
    return [];
  }
}

// The same "**"/"*" matching memory.mjs's own local scope matcher and plugins/doug-gates/lib/glob.mjs use,
// duplicated locally rather than imported (see readTraceFileLines' comment above).
function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function isProtectedPath(relPath, protectedPaths) {
  const p = String(relPath || "").replace(/\\/g, "/");
  return protectedPaths.some((pattern) => {
    const g = String(pattern).replace(/\\/g, "/");
    if (globToRegExp(g).test(p)) return true;
    if (!g.includes("*") && (p === g || p.startsWith(`${g}/`))) return true;
    return false;
  });
}

// Review MINOR 2: reading only the first "+++ b/" header let a hand-built (or hand-edited) two-file diff carry
// a second, unrefused target past the protectedPaths check - a second file section wrote straight into the
// protected .doug/config.json. Every "+++ b/" AND "--- a/" header is parsed now (the union of both sides' file
// names - normally identical per section, since this module never renames a file), so a multi-file diff is
// caught by its target count alone before any single target is even looked at.
function parseDiffTargets(diffText) {
  const targets = new Set();
  for (const m of diffText.matchAll(/^\+\+\+ b\/(.+)$/gm)) targets.add(m[1]);
  for (const m of diffText.matchAll(/^--- a\/(.+)$/gm)) targets.add(m[1]);
  return [...targets];
}

// True for an absolute path, or a relative path whose ".." segments walk out of `dir` - the diff-apply
// equivalent of protect-paths.mjs's outside-the-project refusal, checked the same way applyProposal checks
// protectedPaths: never by trusting the string, always by resolving it against `dir` first.
function isOutsideRepo(dir, relPath) {
  if (!relPath || relPath.startsWith("/")) return true;
  const resolved = resolve(dir, relPath);
  const base = resolve(dir);
  return resolved !== base && !resolved.startsWith(`${base}${sep}`);
}

// The applied-proposal ledger (cards memory-decisions, proposal-ledger-forgeable): one JSON line per successful
// applyProposal, appended after `git apply` succeeds, never before. plugins/doug-gates/lib/proposals.mjs reads
// this same file (its own small local copy of readAppliedLedger, not an import - no workspace dependency exists
// between doug-flow and doug-gates; see this file's header comment for the same precedent) to tell an approved
// proposal's write from a hand edit, so the line shape here is a contract: { target, sha256, diffSha256, at,
// proposal }, where `proposal` is the diff file's path relative to `dir` (forward slashes) and `diffSha256` is
// the sha256 of that diff file's bytes at apply time - card proposal-ledger-forgeable: a hand-written line
// carrying only `target`/`sha256` is not enough on its own, since the reader re-derives the target's content
// from this diff (git apply onto the committed base) rather than trusting the sha256 alone.
export const PROPOSAL_LEDGER_RELPATH = ".doug/.state/proposals/applied.jsonl";

// Every well-formed line, tolerant of a missing file or a torn line (a crashed process mid-write) - never fatal.
export function readAppliedLedger(dir) {
  const file = join(dir, PROPOSAL_LEDGER_RELPATH);
  if (!existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && o.target) out.push(o);
    } catch {
      // a torn line is skipped, never fatal
    }
  }
  return out;
}

function appendLedgerLine(dir, entry) {
  const file = join(dir, PROPOSAL_LEDGER_RELPATH);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

// sha256 of `target`'s current bytes under `dir`, or the sha of empty content when it cannot be read (a deleted
// target) - so a deleted file still gets a ledger line rather than throwing.
function targetSha256(dir, target) {
  try {
    return createHash("sha256").update(readFileSync(join(dir, target))).digest("hex");
  } catch {
    return createHash("sha256").update("").digest("hex");
  }
}

// Applies ONE proposal's diff file with `git apply`. Refuses (never touching the tree) when the diff file
// itself does not resolve under `dir`/LEARN_STATE_RELPATH (card proposal-ledger-forgeable: the ledger's
// re-derivation guard only ever looks there, so a diff from anywhere else could never satisfy it, and applying
// it would be a genuine write the gate could not later prove genuine), when the diff names more than one
// target file (a proposal is single-file, so this is refused outright before any target is checked), when its
// one target is outside the repository, when it is under .doug/config.json's protectedPaths, or when
// `git apply --check` fails; `run` is injectable for tests (same signature as node:child_process's spawnSync:
// `run(args) -> {status, stdout, stderr}`, invoked with cwd `dir`). Never called by `propose` - that guarantee
// is the whole point of this module. On success, appends one line to the applied-proposal ledger (above)
// before returning.
export function applyProposal(file, { dir, run } = {}) {
  // review MINOR 5: resolved against `dir`, not process.cwd() - a caller may reasonably pass a path relative
  // to `dir` while its own cwd is elsewhere (an absolute `file` is unaffected: path.resolve stops at the
  // rightmost absolute segment). Every read and git invocation below uses this resolved `fileAbs`, never the
  // original `file` string, so behavior does not depend on the calling process's cwd.
  const fileAbs = resolve(dir, file);
  const learnDirAbs = resolve(dir, LEARN_STATE_RELPATH);
  if (fileAbs !== learnDirAbs && !fileAbs.startsWith(`${learnDirAbs}${sep}`)) {
    return { ok: false, reason: `${file} is not under ${LEARN_STATE_RELPATH}; a proposal diff must live there, refusing` };
  }
  const raw = readFileSync(fileAbs);
  const diffText = raw.toString("utf8");
  const targets = parseDiffTargets(diffText);
  if (!targets.length) return { ok: false, reason: `${file} has no recognizable diff header (+++ b/<path> or --- a/<path>)` };
  if (targets.length > 1) return { ok: false, reason: `${file} touches more than one file (${targets.join(", ")}); a proposal is single-file, refusing` };
  const [target] = targets;
  if (isOutsideRepo(dir, target)) return { ok: false, reason: `${target} is outside the repository; refusing` };
  const protectedPaths = readConfigProtectedPaths(dir);
  if (isProtectedPath(target, protectedPaths)) {
    return { ok: false, reason: `${target} is a protected path (.doug/config.json protectedPaths); apply it by hand` };
  }
  const git = run || ((args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }));
  const check = git(["apply", "--check", fileAbs]);
  if (check.status !== 0) return { ok: false, reason: `git apply --check failed: ${(check.stderr || "").trim()}` };
  const applied = git(["apply", fileAbs]);
  if (applied.status !== 0) return { ok: false, reason: `git apply failed: ${(applied.stderr || "").trim()}` };
  const diffSha256 = createHash("sha256").update(raw).digest("hex");
  const proposalRel = relative(dir, fileAbs).split(sep).join("/");
  appendLedgerLine(dir, { target, sha256: targetSha256(dir, target), diffSha256, at: new Date().toISOString(), proposal: proposalRel });
  return { ok: true, target };
}
