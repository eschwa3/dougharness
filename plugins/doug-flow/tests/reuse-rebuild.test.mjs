// Card replan-reuse-stale-base: the rebuild recipe in reusePrompt (steps a-d), run for real in a temp git repo.
// The command strings match the ones template.test.mjs asserts on the prompt text.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const git = (...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitFile = (file, content, msg) => {
  writeFileSync(join(dir, file), content);
  git("add", file);
  git("commit", "-m", msg);
  return git("rev-parse", "HEAD");
};
const names = (out) => out.split("\n").filter(Boolean);

const BASE = "new-integ";
const TASK = "doug/task-a";
const OWNED = ["x.ts", "x.test.ts"];

// Step a: every non-merge commit on the task that the new base lacks. This includes run 1's sibling commit,
// which came in through the old integration branch and is not the task's own work.
const listed = () => names(git("log", "--no-merges", "--reverse", "--format=%H", `${BASE}..${TASK}`));
const filesOf = (sha) => names(git("show", "--name-only", "--format=", sha));
// Step b: a commit touching no owned file belongs to another task and is dropped; a commit touching an owned file
// AND a file the task does not own blocks the reuse, naming commit and file.
const classify = (shas) => {
  const keep = [];
  const blocked = [];
  for (const sha of shas) {
    const files = filesOf(sha);
    const bad = files.filter((f) => !OWNED.includes(f));
    if (files.length === 0) continue;
    if (bad.length === 0) keep.push(sha);
    else if (bad.length < files.length) for (const file of bad) blocked.push({ sha, file });
  }
  return { keep, blocked };
};
// Step c + d. Picks run on a detached HEAD at the base; the branch moves (checkout -B, no base argument) only after
// every pick succeeded. Returns the skipped (empty) shas; on a real conflict aborts and throws, branch ref untouched.
// When the base is already an ancestor of the task, the rebuild is skipped for a plain checkout.
// Steps a and b always run first; the plain checkout is taken only when the base is an ancestor AND b kept every
// listed commit (dropped none).
const rebuild = (shas) => {
  const skipped = [];
  let ancestor = false;
  try {
    git("merge-base", "--is-ancestor", BASE, TASK);
    ancestor = true;
  } catch {}
  if (ancestor && shas.length === listed().length) {
    git("checkout", TASK);
    return skipped;
  }
  git("checkout", "--detach", BASE);
  for (const sha of shas) {
    try {
      git("cherry-pick", "-x", sha);
    } catch (e) {
      const conflicts = names(git("diff", "--name-only", "--diff-filter=U"));
      if (conflicts.length === 0) {
        git("cherry-pick", "--skip");
        skipped.push(sha);
      } else {
        git("cherry-pick", "--abort");
        throw new Error(`conflict in ${sha}: ${conflicts.join(", ")}`);
      }
    }
  }
  git("checkout", "-B", TASK);
  return skipped;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reuse-rebuild-"));
  git("init", "-q", "-b", "main");
  commitFile("base.txt", "base\n", "base");
  // Run 1: integration branch with a sibling task merged in.
  git("checkout", "-q", "-b", "old-integ", "main");
  commitFile("s.ts", "sibling v1\n", "sibling");
  // The task is cut from run 1's integration commit and adds two commits touching only x.ts.
  git("checkout", "-q", "-b", TASK, "old-integ");
  commitFile("x.ts", "one\n", "a: first");
  commitFile("x.ts", "one\ntwo\n", "a: second");
  // Run 2: integration rebuilt from main with a different commit for the sibling (same file, new sha).
  git("checkout", "-q", "-b", BASE, "main");
  commitFile("s.ts", "sibling v2 (fix pass)\n", "sibling fixed");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reuse rebuild recipe (card replan-reuse-stale-base)", () => {
  it("shows the bug: a reused branch cut from the old integration carries the sibling's file in its diff", () => {
    expect(names(git("diff", "--name-only", `${BASE}...${TASK}`))).toContain("s.ts");
  });

  it("rebuilds the task on the new base so its diff is only the owned files", () => {
    const { keep, blocked } = classify(listed());
    expect(blocked).toEqual([]);
    expect(keep).toHaveLength(2);
    rebuild(keep);
    expect(names(git("diff", "--name-only", `${BASE}...${TASK}`))).toEqual(["x.ts"]);
    expect(git("rev-parse", `${BASE}`)).toBe(git("merge-base", BASE, TASK));
  });

  it("reports a task commit that also touches a file the task does not own", () => {
    git("checkout", "-q", TASK);
    writeFileSync(join(dir, "x.ts"), "three\n");
    writeFileSync(join(dir, "s.ts"), "sibling edited by the task\n");
    git("add", "x.ts", "s.ts");
    git("commit", "-m", "a: strays into s.ts");
    const stray = git("rev-parse", "HEAD");
    const { blocked } = classify(listed());
    expect(blocked).toEqual([{ sha: stray, file: "s.ts" }]);
  });

  it("skips a task commit whose patch is already on the new base, without failing", () => {
    const [first] = listed().slice(1, 2);
    // The new base already carries the task's first commit (same patch, new sha).
    git("checkout", "-q", BASE);
    commitFile("x.ts", "one\n", "a: first, already integrated");
    const { keep } = classify(listed());
    const skipped = rebuild(keep);
    expect(first).toBeTruthy();
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(names(git("diff", "--name-only", `${BASE}...${TASK}`))).toEqual(["x.ts"]);
    expect(git("show", `${TASK}:x.ts`)).toBe("one\ntwo");
  });

  it("aborts and names the files when a pick conflicts", () => {
    git("checkout", "-q", BASE);
    commitFile("x.ts", "conflicting\n", "base edits x.ts differently");
    const { keep } = classify(listed());
    expect(() => rebuild(keep)).toThrow(/conflict in [0-9a-f]{40}: x\.ts/);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("leaves the task branch at its reviewed head when a pick conflicts", () => {
    const head = git("rev-parse", TASK);
    git("checkout", "-q", BASE);
    commitFile("x.ts", "conflicting\n", "base edits x.ts differently");
    const { keep } = classify(listed());
    expect(() => rebuild(keep)).toThrow(/conflict in/);
    expect(git("rev-parse", TASK)).toBe(head);
  });

  it("changes nothing when the task branch already contains the new base", () => {
    // The base is the task's own parent integration commit, so the task already contains it.
    git("checkout", "-q", TASK);
    git("branch", "-f", BASE, "old-integ");
    const head = git("rev-parse", TASK);
    const { keep } = classify(listed());
    rebuild(keep);
    expect(git("rev-parse", TASK)).toBe(head);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("log", "--format=%B", `${BASE}..${TASK}`)).not.toContain("cherry picked from");
  });

  it("rebuilds even when the base is an ancestor but the branch carries a sibling's commit (review 2 repro)", () => {
    git("checkout", "-q", TASK);
    git("branch", "-f", BASE, "main");
    expect(() => git("merge-base", "--is-ancestor", "main", TASK)).not.toThrow();
    const { keep } = classify(listed());
    expect(keep).toHaveLength(2);
    expect(listed()).toHaveLength(3);
    rebuild(keep);
    expect(names(git("diff", "--name-only", `main...${TASK}`))).toEqual(["x.ts"]);
  });

  it("drops a commit with no files", () => {
    git("checkout", "-q", TASK);
    git("commit", "--allow-empty", "-m", "a: empty");
    const empty = git("rev-parse", "HEAD");
    expect(listed()).toContain(empty);
    const { keep, blocked } = classify(listed());
    expect(keep).not.toContain(empty);
    expect(blocked).toEqual([]);
  });
});
