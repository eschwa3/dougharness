// Checkpoint on green: when the stop gate passes with changes present, record the working tree so a
// later regression can be undone with git instead of by memory. Off by default (config key
// `checkpoint`). Two modes:
//   commit  stage every change (except Claude Code's worktrees) and commit on the current branch
//   tag     build a commit from a temporary index and tag it doug/checkpoint/<utc time>; the branch,
//           the index, and the working tree are untouched. Restore with `git checkout <tag> -- .`
// Never runs while a protected path is dirty, even one the Stop scan ignores (a lockfile), because a
// checkpoint must never quietly commit what a person is supposed to look at. Never throws.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchAny } from "./glob.mjs";

export const MODES = ["commit", "tag"];
export const DEFAULT_MESSAGE = "doug: checkpoint";
// Claude Code keeps subagent worktrees inside the repo, untracked and unignored. Never stage them,
// nor the per-session hook state (doug init ignores it, but a checkpoint must not depend on that).
const STAGE_PATHSPEC = [".", ":(exclude).claude/worktrees", ":(exclude).doug/.state"];

function git(args, cwd, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function tryGit(args, cwd, env) {
  try {
    return git(args, cwd, env);
  } catch {
    return null;
  }
}

export function refName(at = new Date()) {
  return "doug/checkpoint/" + at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function commitMessage(cfg, gateResults) {
  const head = (cfg.checkpoint && cfg.checkpoint.message) || DEFAULT_MESSAGE;
  const gate = (gateResults || []).map((r) => `${r.name} ${r.ok ? "ok" : "failed"}`).join(", ");
  return gate ? `${head}\n\ngate: ${gate}` : head;
}

// Returns one of: { skipped }, { error }, { mode, ref, sha }.
export function checkpoint({ dir, cfg, changed, gateResults, at = new Date() }) {
  const c = cfg.checkpoint || {};
  if (!c.enabled) return { skipped: "disabled" };
  const mode = c.mode || "commit";
  if (!MODES.includes(mode)) return { error: `checkpoint.mode must be one of ${MODES.join(", ")}, got ${JSON.stringify(c.mode)}` };
  if (!Array.isArray(changed)) return { skipped: "not a git repository" };
  if (changed.length === 0) return { skipped: "no changes" };
  const dirtyProtected = changed.filter((f) => matchAny(cfg.protectedPaths || [], f));
  if (dirtyProtected.length) return { skipped: `protected path dirty: ${dirtyProtected.join(", ")}` };
  const message = commitMessage(cfg, gateResults);

  try {
    if (mode === "commit") {
      const branch = tryGit(["symbolic-ref", "--short", "-q", "HEAD"], dir);
      if (!branch) return { skipped: "detached HEAD; a checkpoint commit needs a branch" };
      git(["add", "-A", "--", ...STAGE_PATHSPEC], dir);
      git(["commit", "-q", "-m", message], dir); // the repo's own commit hooks run; never bypassed
      return { mode, ref: branch, sha: git(["rev-parse", "--short", "HEAD"], dir) };
    }
    const tmp = mkdtempSync(join(tmpdir(), "doug-checkpoint-"));
    try {
      const env = { GIT_INDEX_FILE: join(tmp, "index") };
      const parent = tryGit(["rev-parse", "--verify", "-q", "HEAD"], dir);
      if (parent) git(["read-tree", "HEAD"], dir, env);
      git(["add", "-A", "--", ...STAGE_PATHSPEC], dir, env);
      const tree = git(["write-tree"], dir, env);
      const args = ["commit-tree", tree, "-m", message];
      if (parent) args.push("-p", parent);
      const full = git(args, dir);
      const ref = refName(at);
      git(["tag", ref, full], dir);
      return { mode, ref, sha: full.slice(0, 7) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    const text = (err && (err.stderr || err.message)) || String(err);
    return { error: String(text).trim().split("\n").slice(-3).join("\n") };
  }
}

export function describeCheckpoint(ck) {
  if (ck.error) return `[doug] Checkpoint failed: ${ck.error}`;
  if (ck.skipped) return `[doug] Checkpoint skipped: ${ck.skipped}.`;
  if (ck.mode === "commit") return `[doug] Checkpoint committed as ${ck.sha} on ${ck.ref}.`;
  return `[doug] Checkpoint tagged ${ck.ref} (${ck.sha}); branch, index, and working tree untouched. Restore with: git checkout ${ck.ref} -- .`;
}
