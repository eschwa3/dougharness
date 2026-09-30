// Proposal builders for docs/decisions/ ADRs and .claude/rules/ conventions (card memory-decisions). Pure given
// their inputs (a project dir to read existing files from, and the caller's title/body/paths text) - no LLM, no
// network - and every function here only ever calls writeProposals (lib/learn.mjs), which writes under
// .doug/.state/learn/. Nothing here ever touches docs/decisions/ or .claude/rules/ directly; the only writer for
// those paths is learn.mjs's applyProposal, and only after the user approves the diff this module renders.
//
// The .claude/rules/ contract this module's proposeRule follows (research note, memory-decisions): Claude Code
// loads every *.md under .claude/rules/ recursively; the frontmatter key is `paths:`, a YAML list of globs; a
// rule with no `paths` loads unconditionally for every file at session start; a path-scoped rule loads on demand
// when a matching file is read. Source: https://code.claude.com/docs/en/memory.md#path-specific-rules
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unifiedDiff, writeProposals, countLines, insertBulletUnderHeading, removeExactLine } from "./learn.mjs";

const DECISIONS_RELDIR = "docs/decisions";
const RULES_RELDIR = ".claude/rules";
const CLAUDE_MD_RELPATH = "CLAUDE.md";
const HOOK_SCRIPTS_RELDIR = ".doug/hooks/scripts";

// Scans docs/decisions/NNNN-*.md and returns the next zero-padded number ("0001" when the directory is empty
// or missing). A file that does not match the NNNN-*.md shape (a stray README, say) is ignored rather than
// breaking the scan.
export function nextDecisionNumber(dir) {
  const decisionsDir = join(dir, DECISIONS_RELDIR);
  let max = 0;
  if (existsSync(decisionsDir)) {
    for (const f of readdirSync(decisionsDir)) {
      const m = /^(\d{4})-.+\.md$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(4, "0");
}

// lowercase, non-alphanumerics collapsed to a single "-", trimmed of leading/trailing "-", capped at ~60 chars
// (re-trimmed after the cut so a mid-word slice never leaves a trailing "-").
export function slugify(title) {
  const collapsed = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.slice(0, 60).replace(/-+$/, "");
}

// The repo's ADR shape, exactly like docs/decisions/0006-out-of-workflow-access.md: "# NNNN. <title>", blank,
// "Date: YYYY-MM-DD. Status: accepted.", blank, then the body verbatim (the author's own markdown - never
// wrapped or reformatted), with exactly one trailing newline on the whole file regardless of how the body's own
// trailing whitespace was written.
export function renderDecision({ number, title, body, date }) {
  const trimmedBody = String(body || "").replace(/\s+$/, "");
  return `# ${number}. ${title}\n\nDate: ${date}. Status: accepted.\n\n${trimmedBody}\n`;
}

function validRuleName(name) {
  return /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/.test(String(name ?? ""));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Today's local date as YYYY-MM-DD (not UTC - a caller in any timezone gets their own "today").
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Resolves the `date` a caller passes to proposeDecision/proposeAmendment: defaults to today's local date when
// omitted (undefined, null, or ""), refuses anything else that is not YYYY-MM-DD. renderDecision and the
// amendment text below interpolate this string directly with no check of their own, so a missing or malformed
// date must never reach them (reviewer defect: a lib caller with no `date` wrote a literal "Date: undefined.").
function resolveDate(date) {
  const d = date === undefined || date === null || date === "" ? todayLocal() : String(date);
  if (!DATE_RE.test(d)) return { ok: false, reason: `date must be YYYY-MM-DD, got ${JSON.stringify(date)}` };
  return { ok: true, date: d };
}

// unifiedDiff(relPath, oldText, newText) returns null when the two are identical - nothing to propose. Every
// proposal builder below goes through this rather than handing a null diff to writeProposals, which would
// silently write no diff file and leave the caller printing `diff: undefined` / `apply with: ... undefined`
// (reviewer defect, reproduced with `memory.mjs rule propose <name> --file <path-to-the-same-content>`).
function diffOrRefuse(relPath, oldText, newText) {
  const diff = unifiedDiff(relPath, oldText, newText);
  if (diff === null) return { ok: false, reason: `${relPath} already has exactly this content; nothing to propose` };
  return { ok: true, diff };
}

// Builds one proposal for `content` at `relPath`: a diff from the file's current text when it exists (an
// ordinary unifiedDiff), or a creation diff (unifiedDiff from "" - git apply creates the file, including any
// missing parent directory, from a plain "--- a/<p>" / "+++ b/<p>" header with an all-add hunk; verified against
// a real `git apply --check` in decisions.test.mjs, so no special "new file mode" header is needed). Refuses
// (via diffOrRefuse) rather than building a proposal with no diff when `content` already matches the file.
function buildProposal(dir, relPath, content, { kind, id, reason }) {
  const target = join(dir, relPath);
  const exists = existsSync(target);
  const oldText = exists ? readFileSync(target, "utf8") : "";
  const diffResult = diffOrRefuse(relPath, oldText, content);
  if (!diffResult.ok) return diffResult;
  return { ok: true, proposal: { id, kind, target: relPath, reason, diff: diffResult.diff } };
}

function writeOne(proposal, { dir, now }) {
  const written = writeProposals([proposal], { dir, now });
  return { ok: true, proposal, dir: written.dir, diffPath: written.diffPaths[0] };
}

// Proposes a brand-new ADR at docs/decisions/<NNNN>-<slug>.md. Refuses (never writing anything) when the target
// already exists, title/body is empty, the title slugs to nothing (punctuation-only, e.g. "!!!"), or `date` is
// given and is not YYYY-MM-DD; `date` defaults to today's local date when omitted.
export function proposeDecision({ dir, title, body, date, now = new Date() } = {}) {
  if (!String(title || "").trim()) return { ok: false, reason: "title is required" };
  const slug = slugify(title);
  if (!slug) return { ok: false, reason: "title yields an empty slug" };
  if (!String(body || "").trim()) return { ok: false, reason: "body is required" };
  const resolvedDate = resolveDate(date);
  if (!resolvedDate.ok) return resolvedDate;
  const number = nextDecisionNumber(dir);
  const relPath = `${DECISIONS_RELDIR}/${number}-${slug}.md`;
  if (existsSync(join(dir, relPath))) return { ok: false, reason: `${relPath} already exists` };
  const content = renderDecision({ number, title, body, date: resolvedDate.date });
  const built = buildProposal(dir, relPath, content, { kind: "decision", id: "01", reason: `new ADR ${number}: ${title}` });
  if (!built.ok) return built;
  return writeOne(built.proposal, { dir, now });
}

// `id` is a decision number ("0007") or a full basename/path ("0007-x.md", or a path ending in one) - only the
// leading NNNN is read from it. Finds the one existing docs/decisions/<NNNN>-*.md; refuses when none or several
// match, `text` is empty, or `date` is given and is not YYYY-MM-DD (`date` defaults to today's local date when
// omitted). Appends a dated "## Amendment" section to the file's current content.
export function proposeAmendment({ dir, id, text, date, now = new Date() } = {}) {
  const m = /^(\d{4})/.exec(String(id ?? "").split("/").pop());
  if (!m) return { ok: false, reason: `${id} is not a valid decision id (expected NNNN, or a NNNN-slug.md basename/path)` };
  const number = m[1];
  const decisionsDir = join(dir, DECISIONS_RELDIR);
  const matches = existsSync(decisionsDir) ? readdirSync(decisionsDir).filter((f) => new RegExp(`^${number}-.+\\.md$`).test(f)) : [];
  if (matches.length === 0) return { ok: false, reason: `no ADR found for ${number} in ${DECISIONS_RELDIR}/` };
  if (matches.length > 1) return { ok: false, reason: `ambiguous: multiple ADRs match ${number}: ${matches.sort().join(", ")}` };
  if (!String(text || "").trim()) return { ok: false, reason: "text is required" };
  const resolvedDate = resolveDate(date);
  if (!resolvedDate.ok) return resolvedDate;
  const relPath = `${DECISIONS_RELDIR}/${matches[0]}`;
  const oldText = readFileSync(join(dir, relPath), "utf8");
  const appendText = String(text).replace(/\n+$/, "");
  const newText = `${oldText}\n## Amendment ${resolvedDate.date}\n\n${appendText}\n`;
  const diffResult = diffOrRefuse(relPath, oldText, newText);
  if (!diffResult.ok) return diffResult;
  const proposal = { id: "01", kind: "amend", target: relPath, reason: `amend ${matches[0]}`, diff: diffResult.diff };
  return writeOne(proposal, { dir, now });
}

// Proposes creating or replacing .claude/rules/<name>.md. `name` must be a slug ([a-z0-9][a-z0-9-]*), optionally
// with one "/" level for a subdirectory ("web/api"); refused otherwise (so "../x" or "A B" cannot escape the
// rules directory or produce a malformed file name). With a non-empty `paths` list, the file gets a `paths:`
// YAML frontmatter block (the research note's contract: a path-scoped rule loads only for a matching file);
// with none, the body alone (loads unconditionally for every file, at session start).
export function proposeRule({ dir, name, paths = [], body, now = new Date() } = {}) {
  if (!validRuleName(name)) return { ok: false, reason: `"${name}" is not a valid rule name (expected [a-z0-9][a-z0-9-]*, optionally one /subdir level)` };
  if (!String(body || "").trim()) return { ok: false, reason: "body is required" };
  const relPath = `${RULES_RELDIR}/${name}.md`;
  const trimmedBody = String(body).replace(/\s+$/, "");
  const list = Array.isArray(paths) ? paths.filter((p) => String(p || "").trim()) : [];
  const content = list.length ? `---\npaths:\n${list.map((p) => `  - "${p}"`).join("\n")}\n---\n\n${trimmedBody}\n` : `${trimmedBody}\n`;
  const exists = existsSync(join(dir, relPath));
  const built = buildProposal(dir, relPath, content, { kind: "rule", id: "01", reason: `${exists ? "update" : "new"} rule ${relPath}` });
  if (!built.ok) return built;
  return writeOne(built.proposal, { dir, now });
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

// Validates one `remove` entry against `oldLines` (CLAUDE.md's lines before any edit is applied). Returns
// { ok:false, reason } on the first problem, else { ok:true }. Never throws for any shape JSON.parse can
// produce - every field is type-checked before use (lesson 1ee7d426432aca82: a data-driven reader that throws
// is a defect).
function validateRemoveEntry(entry, oldLines, dir) {
  if (!isPlainObject(entry)) return { ok: false, reason: "each remove entry must be an object" };
  if (typeof entry.line !== "string") return { ok: false, reason: "each remove entry needs a string \"line\"" };
  const count = oldLines.filter((l) => l === entry.line).length;
  if (count === 0) return { ok: false, reason: `remove line not found in CLAUDE.md: ${JSON.stringify(entry.line)}` };
  if (count > 1) return { ok: false, reason: `remove line occurs ${count} times in CLAUDE.md, expected exactly once: ${JSON.stringify(entry.line)}` };
  if (!nonEmptyString(entry.source)) return { ok: false, reason: "each remove entry needs a non-empty string \"source\"" };
  if (!nonEmptyString(entry.enforcedBy)) return { ok: false, reason: "each remove entry needs a non-empty string \"enforcedBy\"" };
  if (entry.enforcedBy.endsWith(".mjs")) {
    const relHook = `${HOOK_SCRIPTS_RELDIR}/${entry.enforcedBy}`;
    if (!existsSync(join(dir, relHook))) return { ok: false, reason: `enforcedBy names a hook that does not exist: ${relHook}` };
  }
  return { ok: true };
}

// Validates one `add` entry: `heading` must be the trimmed text of some line of CLAUDE.md, and that line must
// itself start with "## " (so an add can never target a non-heading line or a heading level other than "##").
function validateAddEntry(entry, claudeLines) {
  if (!isPlainObject(entry)) return { ok: false, reason: "each add entry must be an object" };
  if (typeof entry.line !== "string") return { ok: false, reason: "each add entry needs a string \"line\"" };
  if (!entry.line.startsWith("- ")) return { ok: false, reason: `add line must start with "- ": ${JSON.stringify(entry.line)}` };
  if (!nonEmptyString(entry.source)) return { ok: false, reason: "each add entry needs a non-empty string \"source\"" };
  if (typeof entry.heading !== "string" || !entry.heading.startsWith("## ")) {
    return { ok: false, reason: `add heading must be a "## " heading: ${JSON.stringify(entry.heading)}` };
  }
  const found = claudeLines.some((l) => l.trim() === entry.heading);
  if (!found) return { ok: false, reason: `add heading not found in CLAUDE.md: ${JSON.stringify(entry.heading)}` };
  return { ok: true };
}

// The substring from the "## Models" line to end of text - null when CLAUDE.md has no such line (never expected
// in this repo's own CLAUDE.md, but a caller could point `dir` elsewhere).
function modelsSectionText(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Models");
  if (start === -1) return null;
  return lines.slice(start).join("\n");
}

// The lines strictly between the "```sh" fence and the next "```" fence, scoped to the "## Commands" section
// (from that heading to the next "## " heading or end of file) - null when there is no "## Commands" heading
// or no ```sh fence within its section. An unrelated ```sh fence elsewhere in the file (before or after the
// Commands section) must never be mistaken for the Commands block (F1: an earlier shell fence let an edit
// change the real Commands block undetected).
function commandsBlockText(text) {
  const lines = text.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === "## Commands");
  if (headingIdx === -1) return null;
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }
  const section = lines.slice(headingIdx + 1, sectionEnd);
  const start = section.findIndex((l) => l.startsWith("```sh"));
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 1; i < section.length; i++) {
    if (section[i] === "```") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return section.slice(start + 1, end).join("\n");
}

// Proposes a diff to CLAUDE.md from an already-parsed, source-cited `edits` object: { add?: [{ heading, line,
// source }], remove?: [{ line, enforcedBy, source }], note? }. Pure given its inputs: reads CLAUDE.md, never
// writes it - only ever calls writeOne/writeProposals (learn.mjs), which writes under .doug/.state/learn/. Every
// refusal returns { ok:false, reason } with nothing written; `edits` can be ANY value JSON.parse can produce
// (null, an array, a string, a number, or an object whose fields are the wrong shape) and this never throws -
// every field is type-checked before use (lesson 1ee7d426432aca82).
export function proposeClaudeMd({ dir, edits, now = new Date() } = {}) {
  const target = join(dir, CLAUDE_MD_RELPATH);
  if (!existsSync(target)) return { ok: false, reason: `${CLAUDE_MD_RELPATH} does not exist under ${dir}` };

  if (!isPlainObject(edits)) return { ok: false, reason: "edits must be an object" };
  const rawAdd = edits.add;
  const rawRemove = edits.remove;
  if (rawAdd !== undefined && !Array.isArray(rawAdd)) return { ok: false, reason: "edits.add must be an array" };
  if (rawRemove !== undefined && !Array.isArray(rawRemove)) return { ok: false, reason: "edits.remove must be an array" };
  const add = rawAdd || [];
  const remove = rawRemove || [];
  if (add.length === 0 && remove.length === 0) return { ok: false, reason: "edits.add and edits.remove cannot both be empty" };

  const oldText = readFileSync(target, "utf8");
  const oldLines = oldText.split("\n");

  for (const entry of remove) {
    const v = validateRemoveEntry(entry, oldLines, dir);
    if (!v.ok) return v;
  }
  for (const entry of add) {
    const v = validateAddEntry(entry, oldLines);
    if (!v.ok) return v;
  }

  let text = oldText;
  for (const entry of remove) {
    const updated = removeExactLine(text, entry.line);
    if (updated === null) return { ok: false, reason: `remove line not found in CLAUDE.md: ${JSON.stringify(entry.line)}` };
    text = updated;
  }
  for (const entry of add) {
    const updated = insertBulletUnderHeading(text, entry.heading, entry.line);
    if (updated === null) return { ok: false, reason: `add heading not found in CLAUDE.md: ${JSON.stringify(entry.heading)}` };
    text = updated;
  }
  const newText = text;

  if (modelsSectionText(oldText) !== modelsSectionText(newText)) {
    return { ok: false, reason: "this edit would change the Models section; the Models table is parsed by lib/models.mjs and is not editable here" };
  }
  if (commandsBlockText(oldText) !== commandsBlockText(newText)) {
    return { ok: false, reason: "this edit would change the fenced Commands block, which is not editable here" };
  }
  const after = countLines(newText);
  if (after > 60) return { ok: false, reason: `CLAUDE.md would be ${after} lines, over its 60-line limit` };

  const diffResult = diffOrRefuse(CLAUDE_MD_RELPATH, oldText, newText);
  if (!diffResult.ok) return diffResult;

  const before = countLines(oldText);
  const reason = `CLAUDE.md: +${add.length} -${remove.length} lines (${before} -> ${after} lines)`;
  const rationale = {
    note: typeof edits.note === "string" ? edits.note : "",
    added: add.map((e) => ({ heading: e.heading, line: e.line, source: e.source })),
    removed: remove.map((e) => ({ line: e.line, enforcedBy: e.enforcedBy, source: e.source })),
    lines: { before, after },
  };
  const proposal = { id: "01", kind: "claude-md", target: CLAUDE_MD_RELPATH, reason, rationale, diff: diffResult.diff };
  return writeOne(proposal, { dir, now });
}
