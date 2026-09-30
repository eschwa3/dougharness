import { isAbsolute, relative, resolve, sep, parse, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";

// Returns the path relative to the project dir with forward slashes,
// or null if the path escapes the project.
export function toProjectRelative(dir, p) {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : resolve(dir, p);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

// Expands a leading "~" or "~/..." against HOME. "~" alone, or "~/" followed by any number of extra leading
// slashes, resolves under homedir() (the extra slashes are stripped so "~//etc" means "$HOME/etc", never
// "/etc" — resolve() would otherwise discard the home prefix when the second argument is absolute). Anything
// else starting with "~" (e.g. "~x", "~root/x") is not tilde-home syntax and is returned unchanged.
function expandTilde(entry) {
  if (entry === "~") return homedir();
  if (entry.startsWith("~/")) return resolve(homedir(), entry.slice(2).replace(/^[/\\]+/, ""));
  return entry;
}

// True when a resolved path is exactly a filesystem root (e.g. "/" or "C:\").
function isFilesystemRoot(p) {
  return parse(p).root === p;
}

// Resolves the real path of p by realpath-ing its deepest existing ancestor and re-appending any path
// segments that do not exist yet (e.g. a Write creating a new file), so containment checks are resistant to
// symlinks and filesystem case-aliases. Uses realpathSync.native (the OS's own realpath) rather than plain
// realpathSync: on a case-insensitive, case-preserving volume (APFS's default on macOS) plain
// realpathSync only resolves symlinks and echoes back whatever case the input used, so it does NOT canonicalize
// a case-variant alias to the same string — verified directly (fs.realpathSync of a same-directory alias with
// swapped case returns the swapped-case string unchanged, while fs.realpathSync.native returns the one true
// on-disk casing for both). Falls back to the lexical, resolved path if realpath cannot be determined for any
// reason (a missing/inaccessible ancestor all the way to the root) — never throws.
export function realpathDeepestExisting(p) {
  const resolved = resolve(p);
  const pending = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return pending.length ? resolve(real, ...pending.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolved;
      pending.push(basename(current));
      current = parent;
    }
  }
}

// True when absPath is equal to, or really contained inside, one of allowedOutsidePaths (each entry an
// absolute or ~-prefixed path naming a file or directory). Used by protect-paths.mjs to let a write outside
// the project directory through when it is explicitly allowlisted in .doug/config.json's allowedOutsidePaths.
// Entries that are empty or not strings are ignored rather than thrown on, as is any entry whose REAL path is a
// filesystem root — never a legitimate allowlist entry, and catastrophic if honored, since "/" as the prefix
// matches every absolute path and would disable this guard globally. The root check runs after realpath
// resolution as well as before it, because an entry that is a symlink to "/" resolves lexically to something
// harmless-looking and only becomes the root once followed. No globs: directory containment on resolved,
// `..`-free paths is the right primitive for an escape hatch, and is safer than glob matching here. Containment
// requires a real path-segment boundary (the resolved entry plus a trailing separator, or an exact match) so
// that an entry "/a/allowed" does not also match a sibling "/a/allowed-other". Both sides are resolved through
// realpathDeepestExisting so a symlink or filesystem-case alias cannot be used to make a path look contained
// (or not) when its real target says otherwise.
export function isAllowedOutside(absPath, allowedOutsidePaths) {
  if (!absPath || !Array.isArray(allowedOutsidePaths)) return false;
  const target = realpathDeepestExisting(absPath);
  for (const entry of allowedOutsidePaths) {
    if (!entry || typeof entry !== "string") continue;
    const resolvedEntry = resolve(expandTilde(entry));
    if (isFilesystemRoot(resolvedEntry)) {
      process.stderr.write(`[doug] allowedOutsidePaths entry ${JSON.stringify(entry)} resolves to the filesystem root; ignoring it.\n`);
      continue;
    }
    const realEntry = realpathDeepestExisting(resolvedEntry);
    // The entry's real path is the root: a symlink (or chain of them) pointing at "/". Same treatment.
    if (isFilesystemRoot(realEntry)) {
      process.stderr.write(`[doug] allowedOutsidePaths entry ${JSON.stringify(entry)} resolves to the filesystem root; ignoring it.\n`);
      continue;
    }
    if (target === realEntry) return true;
    if (target.startsWith(realEntry.endsWith(sep) ? realEntry : realEntry + sep)) return true;
  }
  return false;
}

// Extracts file paths from a tool_input for Edit/Write/MultiEdit/NotebookEdit.
export function filePathsFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const out = [];
  if (typeof toolInput.file_path === "string") out.push(toolInput.file_path);
  if (typeof toolInput.notebook_path === "string") out.push(toolInput.notebook_path);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) if (e && typeof e.file_path === "string") out.push(e.file_path);
  }
  return out;
}
