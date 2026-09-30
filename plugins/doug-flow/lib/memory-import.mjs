// One-way import of Claude Code auto memory (~/.claude/projects/<slug>/memory/*.md) into the lessons table
// (card memory-lib, task memory-import). This module only ever reads under the auto-memory directory: it never
// creates, writes, renames, or touches a file there, and it never writes MEMORY.md (the auto-memory index).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { projectSlug } from "./cost.mjs";
import { addLesson, getLesson, listLessons, supersedeLesson, unstaleLesson } from "./memory.mjs";

export function autoMemoryDir(projectDir, claudeDir = join(homedir(), ".claude")) {
  return join(claudeDir, "projects", projectSlug(projectDir), "memory");
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Frontmatter is a leading `---` line, top-level `key: value` lines up to a closing `---` line, plus the
// children of a `metadata:` block (a `metadata:` line, optionally trailing whitespace, followed by lines
// indented by two or more spaces of the same `key: value` form). A nested key never overrides a top-level key
// of the same name. A file with no leading `---` line has data = {} and the whole text as body.
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { data: {}, body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: {}, body: text };
  }
  const data = {};
  const nested = {};
  let inMetadata = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    const indented = line.match(/^(\s+)(.*)$/);
    if (inMetadata && indented && indented[1].length >= 2) {
      const kv = indented[2].match(/^([^:]+):\s*(.*)$/);
      if (kv) {
        const key = kv[1].trim();
        if (!(key in nested)) nested[key] = stripQuotes(kv[2].trim());
      }
      continue;
    }
    inMetadata = false;
    if (indented) continue;
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      data[key] = stripQuotes(kv[2].trim());
    }
  }
  for (const key of Object.keys(nested)) {
    if (!(key in data)) data[key] = nested[key];
  }
  const body = lines.slice(end + 1).join("\n");
  return { data, body };
}

export function importAutoMemory(m, opts = {}) {
  const { projectDir, claudeDir, now } = opts;
  // `now` (defaults to the current time) is only the retirement timestamp written to a stale row; every other
  // timestamp here is measured (data.modified or file mtime).
  const dir = autoMemoryDir(projectDir, claudeDir);
  if (!existsSync(dir)) {
    return { dir, found: false, added: 0, updated: 0, unchanged: 0, skipped: 0, retired: 0, files: [] };
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")
    .map((e) => e.name)
    .sort();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const files = [];
  for (const name of names) {
    const filePath = resolve(join(dir, name));
    const raw = readFileSync(filePath, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const text = body.trim();
    if (!text) {
      skipped++;
      files.push({ file: name, id: null, action: "skipped" });
      continue;
    }
    const kind = data.type === "feedback" ? "feedback" : "project";
    const id = createHash("sha256").update(`auto-memory\n${name}\n${text}`).digest("hex").slice(0, 16);
    const existing = getLesson(m, id);
    if (existing) {
      if (existing.stale) unstaleLesson(m, id);
      unchanged++;
      files.push({ file: name, id, action: "unchanged" });
      continue;
    }
    const created =
      typeof data.modified === "string" && Number.isFinite(Date.parse(data.modified))
        ? data.modified
        : statSync(filePath).mtime.toISOString();
    const citation = filePath;
    // Keyed on the file's basename (card memory-docs-drift #3), not the absolute citation path: a rewritten
    // auto-memory file supersedes the row it wrote before regardless of where the auto-memory dir lives (a
    // different --claude-dir, a moved home). source_agent "auto-memory" still guards a hand-authored lesson
    // that happens to share the name from ever being superseded here (memory.mjs refuses that source-agent on
    // `lesson add`, so only this importer's own prior rows can ever match). A file is identified by its name:
    // the same name seen from a second auto-memory directory supersedes the earlier row rather than adding a
    // second one. `names` above comes from one flat readdirSync of a single auto-memory dir per run, so names
    // are already unique within the set this loop iterates.
    const prior = listLessons(m).find((l) => l.source_agent === "auto-memory" && basename(l.citation) === name);
    addLesson(m, {
      id,
      text,
      kind,
      scope: [],
      citation,
      source: { agent: "auto-memory", model: null },
      created,
    });
    if (prior) {
      supersedeLesson(m, prior.id, id);
      updated++;
      files.push({ file: name, id, action: "updated" });
    } else {
      added++;
      files.push({ file: name, id, action: "added" });
    }
  }
  // Retire (mark stale) every live row this importer wrote (source_agent "auto-memory") whose file is no longer
  // under the directory: a rewritten file supersedes its prior row above, but a deleted file left no trace here
  // to react to. Keyed on basename, the same key the per-file loop above uses to find a prior row, so a row
  // whose citation dir differs from this run's dir but whose basename is still present is not retired (card
  // memory-import-retires-deleted).
  const nameSet = new Set(names);
  const retiredAt = (now ? new Date(now) : new Date()).toISOString();
  let retired = 0;
  for (const lesson of listLessons(m)) {
    if (lesson.source_agent !== "auto-memory") continue;
    if (lesson.stale) continue;
    if (nameSet.has(basename(lesson.citation))) continue;
    m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(retiredAt, lesson.id);
    retired++;
    files.push({ file: basename(lesson.citation), id: lesson.id, action: "retired" });
  }
  return { dir, found: true, added, updated, unchanged, skipped, retired, files };
}
