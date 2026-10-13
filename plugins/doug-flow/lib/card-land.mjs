// landCard: land a hand card's branch (card parallel-card-queens B6, ADR 0015). The card's worktree is rebased on the
// base branch, the rebased tree is gated through the vendored verify.mjs (--json; its gate.lock is shared by every
// card), main fast-forwards to the branch, and only the card's own worktree is removed. A refusal returns
// { ok: false, reason } with main untouched; it never throws (landPlan's contract, lib/land.mjs).
//
//   1. the base branch is the one checked out in dir, and no tracked file outside .doug/ is modified
//   2. no commit on the branch since the base carries a Co-Authored-By or Claude-Session line
//   3. git rebase <base> in the worktree; a conflict is aborted and refused as "rebase-conflict: <files>", any
//      other rebase failure is refused under its own reason
//   4. gate: .doug/hooks/scripts/verify.mjs --json with its cwd at the worktree; red refuses, nothing merges
//   5. git merge --ff-only <branch> in dir
//   6. removeFinishedWorktrees(dir, { branches: [branch] }) only, never mergedInto

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandEnv, trailerCommits, vendoredVerifySpawnTimeoutMs } from "./land.mjs";
import { removeFinishedWorktrees } from "./worktrees.mjs";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

function tail(text, lines = 30) {
  return String(text || "").trimEnd().split("\n").slice(-lines).join("\n");
}

const GATE_TIMEOUT_MS = 600000;

// Returns { ok: true, commit, gateLine, lockWaitMs, removed, kept } or { ok: false, reason }.
export function landCard(dir, { id, branch, worktree, base = "main" } = {}) {
  try {
    return land(dir, { id, branch, worktree, base });
  } catch (err) {
    return { ok: false, reason: `land-card failed: ${tail((err && (err.stderr || err.message)) || err, 5)}` };
  }
}

function land(dir, { id, branch, worktree, base }) {
  if (!branch || !worktree) return { ok: false, reason: "land-card needs a branch and a worktree" };
  if (tryGit(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]) === null) return { ok: false, reason: `branch ${branch} does not exist; nothing to land` };
  if (!existsSync(worktree)) return { ok: false, reason: `worktree ${worktree} does not exist` };
  if (tryGit(worktree, ["symbolic-ref", "--short", "-q", "HEAD"]) !== branch) return { ok: false, reason: `worktree ${worktree} does not have ${branch} checked out` };

  const current = tryGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!current) return { ok: false, reason: "detached HEAD; check out the base branch first" };
  if (current !== base) return { ok: false, reason: `base branch is ${base} but ${current} is checked out; check out ${base} first (land never switches your branch)` };

  // Not through git(): its trim() would eat the leading status column of the first line.
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((p) => !p.startsWith(".doug/"));
  if (dirty.length) return { ok: false, reason: `tracked files are modified: ${dirty.join(", ")}; commit or stash them first` };

  const trailered = trailerCommits(dir, base, branch);
  if (trailered.length) return { ok: false, reason: `commits on ${branch} carry attribution trailers (Co-Authored-By or Claude-Session), which this repository does not record; rewrite them first:\n${trailered.map((c) => `  ${c.sha} ${c.subject} (${c.trailers.join(", ")})`).join("\n")}` };

  try {
    git(worktree, ["rebase", base]);
  } catch (err) {
    const files = (tryGit(worktree, ["diff", "--name-only", "--diff-filter=U"]) || "").split("\n").filter(Boolean);
    if (files.length) {
      tryGit(worktree, ["rebase", "--abort"]);
      return { ok: false, reason: `rebase-conflict: ${files.join(", ")}` };
    }
    tryGit(worktree, ["rebase", "--abort"]);
    return { ok: false, reason: `rebase-failed: ${tail(err.stderr || err.message, 3)}` };
  }

  const vendored = join(dir, ".doug/hooks/scripts/verify.mjs");
  if (!existsSync(vendored)) return { ok: false, reason: `gate not run: ${vendored} does not exist` };
  const r = spawnSync(process.execPath, [vendored, "--json", "--by", "land-card", "--cwd", worktree, "--record-dir", dir, "--timeout-ms", String(GATE_TIMEOUT_MS)], {
    cwd: worktree,
    encoding: "utf8",
    timeout: vendoredVerifySpawnTimeoutMs(GATE_TIMEOUT_MS, 2),
    maxBuffer: 64 * 1024 * 1024,
    env: commandEnv(),
  });
  let out = null;
  try {
    out = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
  } catch {
    out = null;
  }
  if (!out || !Array.isArray(out.results) || out.results.length === 0) {
    const why = r.error && r.error.code === "ETIMEDOUT" ? "timed out" : "gave no readable result";
    return { ok: false, reason: `gate failed on ${branch}: the vendored verify.mjs ${why}` };
  }
  const gateLine = "gate: " + out.results.map((x) => `${x.name || x.command} ${x.ok === true ? "ok" : `exit ${x.status}`}`).join("; ");
  const lockWaitMs = typeof out.lockWaitMs === "number" ? out.lockWaitMs : 0;
  if (out.ok !== true) {
    const bad = out.results.find((x) => x.ok !== true) || out.results[0];
    return { ok: false, reason: `gate red on ${branch}: \`${bad.command}\` (${bad.timedOut ? "timed out" : `exit ${bad.status}`})\n${bad.outputTail || ""}`, gateLine, lockWaitMs };
  }

  try {
    git(dir, ["merge", "--ff-only", branch]);
  } catch (err) {
    tryGit(dir, ["merge", "--abort"]);
    return { ok: false, reason: `fast-forward of ${base} to ${branch} failed:\n${tail((err.stdout || "") + "\n" + (err.stderr || ""), 10)}`, gateLine, lockWaitMs };
  }
  const commit = git(dir, ["rev-parse", "--short", "HEAD"]);
  const wt = removeFinishedWorktrees(dir, { branches: [branch] });
  return { ok: true, id, commit, gateLine, lockWaitMs, removed: wt.removed, kept: wt.kept };
}
