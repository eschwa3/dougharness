// Deterministic facts about the change, computed by git rather than asserted by a model.

import { execFileSync } from "node:child_process";

export interface ChangeFacts {
  changedFiles: string[];
  diff: string;
  diffBytes: number;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** `git status --porcelain` lines, sorted, so two snapshots can be compared. Untracked files included. */
export function statusSnapshot(dir: string): string[] {
  return git(["status", "--porcelain", "--untracked-files=all"], dir)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .sort();
}

/**
 * The commit checked out in dir versus the commit `head` names. The reviewer runs commands in dir,
 * so they must be the same tree; otherwise every test it runs exercises the wrong code.
 */
export function checkedOutMismatch(dir: string, head: string): string | null {
  const actual = git(["rev-parse", "--verify", "HEAD"], dir);
  const wanted = git(["rev-parse", "--verify", `${head}^{commit}`], dir);
  if (actual === wanted) return null;
  return `${head} (${wanted.slice(0, 12)}) is not what is checked out in ${dir} (${actual.slice(0, 12)}); check it out there or point --dir at its worktree`;
}

/** Throws with git's own message when a ref does not resolve or dir is not a repository. */
export function changeFacts(dir: string, base: string, head: string): ChangeFacts {
  const range = `${base}...${head}`;
  const names = git(["diff", "--name-only", range], dir);
  const diff = git(["diff", range], dir);
  return {
    changedFiles: names.split("\n").map((s) => s.trim()).filter(Boolean),
    diff,
    diffBytes: Buffer.byteLength(diff, "utf8"),
  };
}
