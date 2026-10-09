// Shared helpers for the "dirty tree at session start" baseline (card stop-gate-waiting-on-subagents,
// stop-gate-session-start): which paths are already dirty in the working tree, and a cheap content
// identity for each so a path already dirty when the baseline was captured is never mistaken for
// this session's own work later. Used by both the stop gate (its first-run fallback capture) and the
// SessionStart script (its earlier capture, when the platform fires it).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
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

// The verified-tree fingerprint (card stop-gate-process-storm, goal 2): the HEAD sha plus the content
// identity of every dirty path and every proposal-path file on disk, at the moment it is computed. Null
// when `changed` is not the array shape changedFiles returns (no git, or git unavailable) — there is
// nothing to fingerprint reliably, so the tree can never be judged "unchanged" on this path.
export function treeFingerprint(dir, cfg, changed) {
  if (!Array.isArray(changed)) return null;
  const walked = walkProposalPathFiles(dir, cfg.proposalPaths);
  const paths = [...new Set([...changed, ...walked])];
  // `at` (state.mjs's comment for state.verified) is when this fingerprint was taken; sameTree below never
  // reads it, so recomputing it on the after-wait path (a fresh Date.now()) never affects equality.
  return { head: headAt(dir), tree: captureBaseline(dir, paths), at: Date.now() };
}

// Whether two treeFingerprint results describe the same tree: both present, the same HEAD, the same set of
// paths, and an identical identity for each. Never throws (a hook reader must never throw): a malformed
// fingerprint — e.g. a hand-edited state.verified — just compares unequal rather than blocking the gate.
export function sameTree(a, b) {
  try {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (a.head !== b.head) return false;
    const at = a.tree && typeof a.tree === "object" ? a.tree : null;
    const bt = b.tree && typeof b.tree === "object" ? b.tree : null;
    if (!at || !bt) return false;
    const ak = Object.keys(at).sort();
    const bk = Object.keys(bt).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
    return ak.every((k) => at[k] === bt[k]);
  } catch {
    return false;
  }
}

// card stop-gate-no-test-paths: whether every path changed since the last green verification (`verified`, a
// treeFingerprint recorded in state.verified) is on preCommit.noTestPaths, read with the pre-commit hook's
// exact rule (.githooks/pre-commit): an entry matches a path when equal, or, ending in "/", when the path
// starts with it. Not a glob. "Changed since" is the union of the paths committed since verified.head that are
// absent from verified.tree or whose current identity differs from the recorded one (a path committed with the
// verified content is not a change), every path dirty now (read with --no-renames, both sides of a rename) that is absent from verified.tree or whose identity moved, and every verified.tree path
// whose identity moved (reverted or committed with other content). Fails closed: false when there is no
// verified fingerprint, its head is unknown to git, git is unavailable, the union is empty, the list is
// missing, empty, or holds a non-string or empty entry, or any path is off the list. Never throws.
export function onlyNoTestPathsChanged(dir, cfg, verified, changed) {
  try {
    const list = cfg && cfg.preCommit && cfg.preCommit.noTestPaths;
    if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === "string" && e !== "")) return false;
    const moved = movedSinceVerified(dir, verified, changed);
    if (!moved || moved.size === 0) return false;
    const hit = (p) => list.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
    return [...moved].every(hit);
  } catch {
    return false;
  }
}

// The "changed since the last green" set onlyNoTestPathsChanged judges (card gate-docs-skip-unless-named factors
// it out so the docs rule reads the same set): a Set of paths, or null when there is no usable verified
// fingerprint, `changed` is not an array, its head is unknown to git, or anything throws. Never throws.
export function movedSinceVerified(dir, verified, changed) {
  try {
    if (!verified || typeof verified !== "object" || !verified.tree || typeof verified.tree !== "object" || Array.isArray(verified.tree)) return null;
    if (!Array.isArray(changed)) return null;
    const committed = committedSince(dir, verified.head);
    if (!Array.isArray(committed)) return null;
    const moved = new Set();
    for (const p of committed) {
      if (!(p in verified.tree) || fileIdentity(join(dir, p)) !== verified.tree[p]) moved.add(p);
    }
    // changedFiles collapses a rename `old -> new` to `new`, hiding a path moved out of a source location, so
    // the dirty set is collected here with --no-renames (both sides), exactly as pre-commit does.
    const git = (args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((p) => !p.startsWith(".claude/worktrees/") && !p.startsWith(".doug/.state/") && p !== ".doug/anchor.md");
    const dirty = [...git(["diff", "--name-only", "--no-renames", "HEAD", "--"]), ...git(["ls-files", "--others", "--exclude-standard"])];
    for (const p of new Set([...dirty, ...Object.keys(verified.tree)])) {
      if (!(p in verified.tree) || fileIdentity(join(dir, p)) !== verified.tree[p]) moved.add(p);
    }
    return moved;
  } catch {
    return null;
  }
}

// card gate-skip-readonly-researchers: the start fingerprint of a subagent, written by the trace hook on
// SubagentStart and read by the stop gate. One small JSON file per agent under .doug/.state/agent-start/<session>/.
// Ids are reduced to [A-Za-z0-9_-] so one can never escape the directory. Both functions never throw: a failed
// write means no record, an unreadable record reads as null (the gate then runs as before).
function agentStartFile(dir, sessionId, agentId) {
  const clean = (v) => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "_";
  return join(dir, ".doug/.state/agent-start", clean(sessionId), `${clean(agentId)}.json`);
}

export function writeAgentStart(dir, cfg, sessionId, agentId) {
  try {
    const fp = treeFingerprint(dir, cfg, changedFiles(dir));
    if (!fp) return;
    const file = agentStartFile(dir, sessionId, agentId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(fp));
  } catch {
    // no record
  }
}

export function readAgentStart(dir, sessionId, agentId) {
  try {
    return JSON.parse(readFileSync(agentStartFile(dir, sessionId, agentId), "utf8"));
  } catch {
    return null;
  }
}

// card stop-gate-runs-only-on-code-turns: the turn-start fingerprint, written by scripts/turn-start.mjs on
// UserPromptSubmit and read by the main Stop gate. One small JSON file per session under
// .doug/.state/turn-start/<session>.json, same id sanitising as agentStartFile. Both functions never throw: a
// failed write means no record, an unreadable record reads as null (the gate then verifies as before).
function turnStartFile(dir, sessionId) {
  const clean = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "_";
  return join(dir, ".doug/.state/turn-start", `${clean}.json`);
}

export function writeTurnStart(dir, cfg, sessionId) {
  try {
    const fp = treeFingerprint(dir, cfg, changedFiles(dir));
    if (!fp) return;
    const file = turnStartFile(dir, sessionId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(fp));
  } catch {
    // no record
  }
}

export function readTurnStart(dir, sessionId) {
  try {
    return JSON.parse(readFileSync(turnStartFile(dir, sessionId), "utf8"));
  } catch {
    return null;
  }
}

// Whether the tree still matches a turn-start record once every path on preCommit.noTestPaths is dropped from
// both (the pre-commit hook's rule: equal, or a prefix when the entry ends in "/"). Returns null when it cannot
// tell (no or malformed record, no current fingerprint, any throw) so the caller verifies; otherwise
// { same, exact, dirty }: `exact` = equal with nothing dropped; `same` = same HEAD, same code paths, same identities; `dirty` = the current tree still holds
// code paths. Never throws.
export function turnTreeStatus(cfg, start, current) {
  try {
    if (!start || !current || typeof start !== "object" || typeof current !== "object") return null;
    if (!start.tree || typeof start.tree !== "object" || Array.isArray(start.tree)) return null;
    if (!current.tree || typeof current.tree !== "object" || Array.isArray(current.tree)) return null;
    const list = cfg && cfg.preCommit && Array.isArray(cfg.preCommit.noTestPaths) ? cfg.preCommit.noTestPaths.filter((e) => typeof e === "string" && e !== "") : [];
    const skip = (p) => list.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
    const strip = (fp) => ({ head: fp.head, tree: Object.fromEntries(Object.entries(fp.tree).filter(([p]) => !skip(p))) });
    const a = strip(start);
    const b = strip(current);
    return { same: sameTree(a, b), exact: sameTree(start, current), dirty: Object.keys(b.tree).length > 0 };
  } catch {
    return null;
  }
}
