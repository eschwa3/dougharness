// Shared helper for removing finished task worktrees, used by plan.mjs land and plan.mjs replan.
// A worktree is a candidate only when it is registered under `git worktree list --porcelain`, its
// real path (fs.realpathSync, so /var vs /private/var on macOS never causes a miss) sits strictly
// inside realpath(realpath(dir)/.claude/worktrees) — itself realpath'd, and never equal to that
// worktrees directory — it is not the main worktree or a path in `keep`, and it has a branch
// (detached worktrees are never touched). It qualifies for removal when its branch is one of
// `branches`, or `mergedInto` is a string and the branch is an ancestor of it. Qualifying worktrees
// are removed with `git worktree remove` (no --force); a refusal (modified/untracked files, or any
// other error) leaves the worktree in place and reports it as kept. This helper never deletes branches.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch (err) {
    return { error: err };
  }
}

function lastNonEmptyLine(text) {
  const lines = String(text || "").trimEnd().split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : "git worktree remove failed";
}

function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Parses the plain (newline-delimited) output of `git worktree list --porcelain`. Deliberately not
// the -z form: that needs git 2.36+ and this helper must work on older git too. Each block is a
// run of non-blank lines ("worktree <path>", "HEAD <sha>", then either "branch refs/heads/<name>"
// or "detached"), and blocks are separated by a blank line. A "worktree " line always starts a new
// block. Every path Doug's own workflow creates under .claude/worktrees never contains a newline,
// so this parser does not attempt to reassemble a path that spans multiple raw lines: a worktree
// whose pathname contains a literal newline is unsupported (not a defect) and is simply not handled.
function parsePorcelain(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) out.push({ path: cur.path, branch: cur.detached ? null : cur.branch || null });
    cur = null;
  };
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("branch ")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") cur.detached = true;
  }
  flush();
  return out;
}

// Returns { removed: string[], kept: { path, reason }[] }.
export function removeFinishedWorktrees(dir, { branches = [], mergedInto = null, keep = [] } = {}) {
  const result = { removed: [], kept: [] };
  const listing = tryGit(dir, ["worktree", "list", "--porcelain"]);
  if (listing && listing.error) return result;

  const worktrees = parsePorcelain(listing);

  const rootReal = realpathOrSelf(dir);
  const worktreesDirReal = realpathOrSelf(join(rootReal, ".claude", "worktrees"));
  const baseDir = worktreesDirReal + sep;
  const mainPath = worktrees.length ? worktrees[0].path : null;
  const mainReal = mainPath ? realpathOrSelf(mainPath) : null;
  // Resolve each keep entry against dir (never process.cwd()) before realpath'ing it.
  const keepReal = new Set(keep.map((p) => realpathOrSelf(resolve(dir, p))));

  for (const wt of worktrees) {
    if (!wt.branch) continue; // detached, never touched
    const real = realpathOrSelf(wt.path);
    if (real === mainReal) continue;
    if (real === worktreesDirReal) continue; // the worktrees dir itself is not inside itself
    if (!(real + sep).startsWith(baseDir)) continue;
    if (keepReal.has(real)) continue;

    const inBranches = branches.includes(wt.branch);
    const isMerged = typeof mergedInto === "string" && tryGit(dir, ["merge-base", "--is-ancestor", wt.branch, mergedInto]) === "";
    if (!inBranches && !isMerged) continue;

    const removal = tryGit(dir, ["worktree", "remove", wt.path]);
    if (removal && removal.error) {
      const stderr = removal.error.stderr || removal.error.message || "";
      result.kept.push({ path: wt.path, reason: lastNonEmptyLine(stderr) });
    } else {
      result.removed.push(wt.path);
    }
  }

  tryGit(dir, ["worktree", "prune"]);
  return result;
}

// The worktrees registered under .claude/worktrees that sit on a branch, as { path, branch }.
function taskWorktrees(dir) {
  const listing = tryGit(dir, ["worktree", "list", "--porcelain"]);
  if (listing && listing.error) return [];
  const rootReal = realpathOrSelf(dir);
  const worktreesDirReal = realpathOrSelf(join(rootReal, ".claude", "worktrees"));
  const baseDir = worktreesDirReal + sep;
  const worktrees = parsePorcelain(listing);
  const mainReal = worktrees.length ? realpathOrSelf(worktrees[0].path) : null;
  return worktrees.filter((wt) => {
    if (!wt.branch) return false;
    const real = realpathOrSelf(wt.path);
    return real !== mainReal && real !== worktreesDirReal && (real + sep).startsWith(baseDir);
  });
}

// Everything uncommitted in a worktree as one patch: tracked changes against HEAD, then each untracked file as an
// addition. Empty when the worktree is clean.
function uncommittedDiff(wtPath) {
  const parts = [];
  const tracked = tryGit(wtPath, ["diff", "HEAD"]);
  if (typeof tracked === "string" && tracked) parts.push(tracked);
  const untracked = tryGit(wtPath, ["ls-files", "--others", "--exclude-standard"]);
  for (const f of (typeof untracked === "string" ? untracked : "").split("\n").filter(Boolean)) {
    // diff --no-index exits 1 when the files differ, which is the normal case here.
    const r = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", f], { cwd: wtPath, encoding: "utf8", timeout: 60000 });
    if (r.stdout && r.stdout.trim()) parts.push(r.stdout.trim());
  }
  return parts.length ? parts.join("\n") + "\n" : "";
}

// The head commit of a local branch, or null when it does not exist. A resolver for lib/plan.mjs reusePlan and
// staleReuseErrors (their optional `git.branchHead`), used to find a recorded reuse branch that a prior replan
// renamed to `<branch>-stale-<n>`.
export function branchHead(dir, name) {
  const r = tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return typeof r === "string" && r ? r : null;
}

// Whether `dir` is inside a git working tree at all, by git's own test (`git rev-parse --git-dir`) rather than
// checking for a `.git` entry: that check misses a repo whose GIT_DIR is set elsewhere, or a `dir` that is inside
// a repo but not at its root (a subdirectory has no `.git` of its own). scripts/plan.mjs uses this to decide
// whether to hand reusePlan/staleReuseErrors a branchHead resolver at all.
export function isGitRepo(dir) {
  const r = tryGit(dir, ["rev-parse", "--git-dir"]);
  return typeof r === "string" && !!r;
}

// The smallest n >= 1 for which <branch>-stale-<n> is not a branch yet.
function staleName(dir, branch) {
  for (let n = 1; ; n++) {
    const name = `${branch}-stale-${n}`;
    if (tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).error) return name;
  }
}

// Retires the worktree and branch of every task replan marks fresh (card replan-clean-worktrees, 2026-09-07): the
// worktree's uncommitted work is saved to <saveDir>/<task id>.diff first (only when there is any), the worktree is
// removed with --force, and the branch is renamed to <branch>-stale-<n> so the next run's git checkout -b finds the
// name free. Nothing is ever deleted: a branch is renamed, never removed. A task whose branch no longer exists, or
// whose worktree is already gone, is skipped without error.
// Returns { removed: string[], saved: { task, path }[], renamed: { task, from, to }[] }.
export function retireTaskWorktrees(dir, { tasks = [], saveDir }) {
  const result = { removed: [], saved: [], renamed: [] };
  const worktrees = taskWorktrees(dir);
  for (const t of tasks) {
    if (!t || typeof t.branch !== "string" || !t.branch) continue;
    for (const wt of worktrees.filter((w) => w.branch === t.branch)) {
      const diff = uncommittedDiff(wt.path);
      if (diff) {
        mkdirSync(saveDir, { recursive: true });
        const file = join(saveDir, `${t.id}.diff`);
        writeFileSync(file, diff);
        result.saved.push({ task: t.id, path: file });
      }
      const removal = tryGit(dir, ["worktree", "remove", "--force", wt.path]);
      if (!(removal && removal.error)) result.removed.push(wt.path);
    }
    if (tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).error) continue;
    const to = staleName(dir, t.branch);
    const rename = tryGit(dir, ["branch", "-m", t.branch, to]);
    if (!(rename && rename.error)) result.renamed.push({ task: t.id, from: t.branch, to });
  }
  tryGit(dir, ["worktree", "prune"]);
  return result;
}

// Retires the integration worktree at .claude/worktrees/doug-integration, if one is registered (card
// integration-worktree-stale, 2026-09-08): a leftover from an abandoned run must not survive into the next one,
// since the workflow's own leftover-vs-this-run's-own check (integratePrompt's firstIntegration) only runs inside
// a run already underway. Removed with --force; the branch is never renamed or deleted (the workflow's
// `git worktree add -B` on the next run's first integration resets it from the base branch). A worktree that is
// not there is not an error.
// Returns { removed: string | null } - the path removed, or null when none was registered.
export function retireIntegrationWorktree(dir) {
  const target = join(realpathOrSelf(dir), ".claude", "worktrees", "doug-integration");
  const match = taskWorktrees(dir).find((wt) => realpathOrSelf(wt.path) === realpathOrSelf(target));
  if (!match) return { removed: null };
  const removal = tryGit(dir, ["worktree", "remove", "--force", match.path]);
  tryGit(dir, ["worktree", "prune"]);
  return { removed: removal && removal.error ? null : match.path };
}
