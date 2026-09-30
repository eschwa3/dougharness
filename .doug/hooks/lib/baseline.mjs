// Shared helpers for the "dirty tree at session start" baseline (card stop-gate-waiting-on-subagents,
// stop-gate-session-start): which paths are already dirty in the working tree, and a cheap content
// identity for each so a path already dirty when the baseline was captured is never mistaken for
// this session's own work later. Used by both the stop gate (its first-run fallback capture) and the
// SessionStart script (its earlier capture, when the platform fires it).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { matchAny } from "./glob.mjs";

// The working tree's changed paths (tracked and untracked), relative to `dir`. Null when `dir` is not
// a git repo or git is unavailable — callers treat that as "unknown" rather than "nothing changed".
export function changedFiles(dir) {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return out
      .split("\n")
      .map((l) => /^.. (.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => m[1].replace(/^"|"$/g, ""))
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
      // Claude Code keeps subagent worktrees under .claude/worktrees/ inside the repo, untracked and unignored.
      // Their contents (including node_modules) are not this session's changes.
      .filter((p) => !p.startsWith(".claude/worktrees/"))
      // The hooks' own state lives under .doug/.state/ (lib/state.mjs) and is untracked; a project that has not
      // gitignored it must not have the state file itself show up as a change (lib/scope.mjs exempts it too).
      .filter((p) => !p.startsWith(".doug/.state/"))
      // .doug/anchor.md is a handoff/compaction snapshot the hooks themselves write (lib/anchor.mjs, reanchor.mjs
      // on PreCompact, and stop-gate.mjs's context-window notice); like .doug/.state/, the harness's own write to
      // it must never read as "this session changed a file" — otherwise a green Stop's own notice would make the
      // very next Stop demand evidence for a session that changed nothing (lib/scope.mjs's ALWAYS_ALLOWED exempts
      // it from plan scope for the same reason).
      .filter((p) => p !== ".doug/anchor.md");
  } catch {
    return null; // not a git repo or git unavailable
  }
}

// Cheap content identity for a dirty path: size + a hash of its bytes, or null when it cannot be read
// (deleted, or never existed as a regular file). Used to tell a path that was already dirty when the
// session's baseline was captured from one this session actually changed further.
export function fileIdentity(absPath) {
  try {
    const buf = readFileSync(absPath);
    return `${buf.length}:${createHash("sha1").update(buf).digest("hex")}`;
  } catch {
    return null;
  }
}

// The repo's current HEAD sha in `dir`, or null when there is no git repo, no HEAD yet (a repo with no
// commits), or git is unavailable. Recorded once per session alongside state.baseline (card
// stop-scan-committed-changes), so a later Stop can scan `git diff --name-only <that sha>..HEAD` for changes
// the session committed instead of leaving dirty in the working tree (committedSince below).
export function headAt(dir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const sha = out.trim();
    return sha || null;
  } catch {
    return null; // no git repo, no HEAD yet, or git unavailable
  }
}

// A git commit sha, abbreviated or full (Minor 1, card stop-scan-committed-changes): state.baselineHead is
// agent-writable data (the whole session state file lives under .doug/.state/, which nothing prevents an
// agent from editing directly), so committedSince below must never hand it to git unvalidated - a string
// like "--output=/tmp/x" passed where git expects a revision could otherwise be read as an option instead,
// letting a forged state file steer the git invocation itself.
const GIT_SHA_RE = /^[0-9a-f]{7,64}$/;

// The paths that differ between `baseHead` and HEAD (card stop-scan-committed-changes): a protected- or
// proposal-path change the session commits before it stops leaves a clean tree, which changedFiles above
// cannot see. Filtered the same way changedFiles filters its own housekeeping paths. Null — callers treat
// this exactly like changedFiles' null, "unknown" rather than "nothing changed" — when `baseHead` does not
// look like a plausible git sha (GIT_SHA_RE above; Minor 1 - never recorded, e.g. an old state file predating
// this key, or a forged/malformed one), HEAD does not exist (a repo with no commits), or git exits non-zero
// (a rewritten base git no longer knows).
export function committedSince(dir, baseHead) {
  if (typeof baseHead !== "string" || !GIT_SHA_RE.test(baseHead)) return null;
  try {
    // The trailing "--" (Minor 1) tells git that nothing after it is an option, belt-and-braces alongside the
    // GIT_SHA_RE check above: even a validated-looking sha is passed as a positional revision, never anything
    // git could interpret as a flag.
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", baseHead, "HEAD", "--"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((p) => !p.startsWith(".claude/worktrees/"))
      .filter((p) => !p.startsWith(".doug/.state/"))
      .filter((p) => p !== ".doug/anchor.md");
  } catch {
    return null; // baseHead unknown to git, no HEAD, or git unavailable
  }
}

// The path segments of a glob pattern before its first glob metacharacter (*, ?, {) — for
// "docs/decisions/**" that is "docs/decisions/", for ".claude/rules/**" it is ".claude/rules/". Used by
// walkProposalPathFiles below to know where on disk to start walking without interpreting the glob itself. A
// pattern with no metacharacter before its first "/" (or none at all) yields "".
function fixedPrefix(pattern) {
  const idx = pattern.search(/[*?{]/);
  const cut = idx === -1 ? pattern : pattern.slice(0, idx);
  const lastSlash = cut.lastIndexOf("/");
  return lastSlash === -1 ? "" : cut.slice(0, lastSlash + 1);
}

// Every file on disk under each of `patterns`' fixed prefixes that itself matches one of `patterns` (card
// stop-scan-committed-changes): `git status` cannot see a path under a directory a project's own .gitignore
// covers (e.g. a .gitignore that ignores .claude/ entirely, hiding a Bash-written .claude/rules/*.md from git
// completely), so proposalPaths gets its own direct filesystem walk instead of relying on changedFiles.
// Symlinks are skipped by design, never followed and never reported (Minor 2): this is a deliberate choice to
// keep the walk cheap and confined to real files under `dir`, not an oversight, but it is a known hole - a
// proposalPaths file reachable only through a symlinked subdirectory (or a symlinked file directly) is
// invisible to this scan, the same way it is invisible to `git status` for an ignored one. A prefix that does
// not exist on disk, or resolves outside `dir` (Minor 3 - e.g. a "../**" pattern, which would otherwise walk
// the project's parent directory), is silently skipped. Deduped, relpaths using forward slashes. Only
// proposalPaths uses this — protectedPaths does not need it, per the card's goal.
export function walkProposalPathFiles(dir, patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  const prefixes = [...new Set(list.map(fixedPrefix).filter((p) => p !== ""))];
  const root = resolve(dir);
  const out = new Set();
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // prefix does not exist, or is not a directory
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir + entry.name;
      if (entry.isDirectory()) walk(join(absDir, entry.name), relPath + "/");
      else if (entry.isFile() && matchAny(list, relPath)) out.add(relPath);
    }
  };
  for (const prefix of prefixes) {
    const abs = resolve(dir, prefix);
    // Minor 3: clamp to the project dir - a prefix must resolve to `dir` itself or somewhere under it.
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    walk(abs, prefix);
  }
  return [...out];
}

export function captureBaseline(dir, paths) {
  const baseline = {};
  for (const p of paths) baseline[p] = fileIdentity(join(dir, p));
  return baseline;
}

// Paths considered this session's own work: absent from the baseline (new since the session started),
// or present but whose content identity has moved since the baseline was captured.
export function sinceBaseline(dir, paths, baseline) {
  return paths.filter((p) => !(p in baseline) || fileIdentity(join(dir, p)) !== baseline[p]);
}
