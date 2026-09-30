// plan.mjs land on real temp repos: refuses on every precondition, lands with a merge commit otherwise.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { landPlan, INTEGRATION_WORKTREE, trailerCommits, commandEnv } from "../lib/land.mjs";
import { integrationBranchFor, loadPlan, savePlan } from "../lib/plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const planCli = join(here, "..", "scripts", "plan.mjs");
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function plan(overrides = {}) {
  return {
    version: 1,
    title: "Add greet",
    goal: "Add a greet helper so the CLI can say hello.",
    status: "done",
    acceptance: ["greet exists"],
    verify: ["node -e \"require('fs').accessSync('src/greet.js')\""],
    tasks: [{ id: "greet", title: "Add greet", spec: "Add greet(name) to src/greet.js returning a greeting string.", files: ["src/greet.js"] }],
    ...overrides,
  };
}

// main has README; the integration branch adds src/greet.js on top of main. The plan is saved as given.
function repo(p = plan(), { integrationWorktree = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-land-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# fx\n");
  writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n.claude/worktrees/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const branch = integrationBranchFor(p);
  if (integrationWorktree) {
    mkdirSync(join(dir, ".claude/worktrees"), { recursive: true });
    git(dir, "worktree", "add", "-q", "-B", branch, INTEGRATION_WORKTREE, "main");
    const wt = join(dir, INTEGRATION_WORKTREE);
    mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "src/greet.js"), "module.exports = (n) => `hi ${n}`;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "greet");
  } else {
    git(dir, "checkout", "-q", "-b", branch);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/greet.js"), "module.exports = (n) => `hi ${n}`;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "greet");
    git(dir, "checkout", "-q", "main");
  }
  savePlan(dir, p);
  return { dir, branch };
}

describe("landPlan", () => {
  it("lands a done plan: verify on the branch, --no-ff merge, worktree removed, plan.landed recorded", () => {
    const { dir, branch } = repo(plan(), { integrationWorktree: true });
    expect(existsSync(join(dir, INTEGRATION_WORKTREE))).toBe(true);
    const r = landPlan(dir, loadPlan(dir), { now: () => new Date("2026-09-04T16:00:00Z") });
    expect(r.ok, r.reason).toBe(true);
    expect(git(dir, "rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(3); // merge commit with two parents
    expect(git(dir, "log", "-1", "--format=%B")).toContain(`doug: land Add greet\n\n${branch} -> main`);
    expect(existsSync(join(dir, "src/greet.js"))).toBe(true);
    expect(existsSync(join(dir, INTEGRATION_WORKTREE))).toBe(false);
    expect(git(dir, "branch", "--list", branch)).toContain(branch); // kept
    const landed = loadPlan(dir).landed;
    expect(landed).toMatchObject({ at: "2026-09-04T16:00:00.000Z", base: "main", branch, mergeCommit: git(dir, "rev-parse", "--short", "HEAD") });
    expect(landed.verify[0].ok).toBe(true);
    expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe(""); // the merge left nothing half-applied
  });
  it("refuses a plan that is not done, and one already landed", () => {
    const { dir } = repo(plan({ status: "approved" }));
    expect(landPlan(dir, loadPlan(dir))).toMatchObject({ ok: false, reason: expect.stringContaining('status is "approved", not "done"') });
    const { dir: d2 } = repo(plan({ landed: { at: "x", mergeCommit: "abc1234" } }));
    expect(landPlan(d2, loadPlan(d2)).reason).toContain("already landed as abc1234");
    expect(git(dir, "rev-list", "--count", "main")).toBe("1");
  });
  it("refuses when verify fails on the branch and leaves main untouched", () => {
    const { dir } = repo(plan({ verify: ["node -e \"process.exit(1)\"", "echo never"] }));
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("verify failed");
    expect(r.verify).toHaveLength(1);
    expect(git(dir, "rev-list", "--count", "main")).toBe("1");
    expect(existsSync(join(dir, "src/greet.js"))).toBe(false);
    expect(loadPlan(dir).landed).toBeUndefined();
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1); // temp worktree cleaned up
  });
  it("runs plan.install before verify in the worktree", () => {
    const { dir } = repo(plan({ install: "echo installed > installed.txt", verify: ["test -f installed.txt"] }));
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(r.verify.map((v) => v.command)).toEqual(["echo installed > installed.txt", "test -f installed.txt"]);
    expect(existsSync(join(dir, "installed.txt"))).toBe(false); // ran in the worktree, not here
  });
  it("refuses when the base branch is not checked out, on detached HEAD, or with a missing branch", () => {
    const { dir } = repo(plan({ baseBranch: "release" }));
    expect(landPlan(dir, loadPlan(dir)).reason).toContain("base branch is release but main is checked out");
    const { dir: d2 } = repo();
    git(d2, "checkout", "-q", "--detach");
    expect(landPlan(d2, loadPlan(d2)).reason).toContain("detached HEAD");
    const { dir: d3 } = repo();
    savePlan(d3, plan({ integrationBranch: "doug/nope" })); // the helper made doug/greet, not this
    expect(landPlan(d3, loadPlan(d3)).reason).toContain("doug/nope does not exist");
  });
  it("refuses when tracked files outside .doug are modified, and when there is nothing to land", () => {
    const { dir } = repo();
    writeFileSync(join(dir, "README.md"), "# changed\n");
    expect(landPlan(dir, loadPlan(dir)).reason).toContain("tracked files are modified: README.md");
    const { dir: d2, branch } = repo();
    git(d2, "merge", "-q", "--no-ff", "--no-edit", branch);
    expect(landPlan(d2, loadPlan(d2)).reason).toContain("already contained in main");
  });
  it("refuses when an acceptance command fails after the verify commands pass, and leaves main untouched", () => {
    const { dir } = repo(plan({ verify: ["true"], acceptance: ["greet exists", { text: "greet file is present", command: "test -f src/nope.js" }, { text: "never runs", command: "echo never > never.txt" }] }));
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("acceptance failed on");
    expect(r.reason).toContain("greet file is present");
    expect(r.reason).toContain("test -f src/nope.js");
    expect(r.verify).toHaveLength(1);
    expect(r.verify[0].ok).toBe(true);
    expect(r.acceptance).toHaveLength(1);
    expect(r.acceptance[0].ok).toBe(false);
    expect(r.acceptance[0].status).toBe(1);
    expect(r.acceptance[0].command).toBe("test -f src/nope.js");
    expect(git(dir, "rev-list", "--count", "main")).toBe("1");
    expect(existsSync(join(dir, "src/greet.js"))).toBe(false);
    expect(loadPlan(dir).landed).toBeUndefined();
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
  });
  it("refuses when a commit on the branch since the base carries an attribution trailer, naming each commit", () => {
    const { dir, branch } = repo(plan({ verify: ["true"], acceptance: [] }));
    git(dir, "checkout", "-q", branch);
    writeFileSync(join(dir, "src/more.js"), "1\n");
    git(dir, "add", "src");
    git(dir, "commit", "-q", "-m", "greet: more\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x");
    writeFileSync(join(dir, "src/other.js"), "2\n");
    git(dir, "add", "src");
    git(dir, "commit", "-q", "-m", "greet: other\n\nco-authored-by: someone <s@example.com>");
    git(dir, "checkout", "-q", "main");
    expect(trailerCommits(dir, "main", branch).map((c) => [c.subject, c.trailers])).toEqual([["greet: other", ["Co-Authored-By"]], ["greet: more", ["Co-Authored-By", "Claude-Session"]]]);
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`commits on ${branch} carry attribution trailers (Co-Authored-By or Claude-Session), which this repository does not record; rewrite them first:`);
    expect(r.reason).toContain(" greet: more (Co-Authored-By, Claude-Session)");
    expect(r.reason).toContain(" greet: other (Co-Authored-By)");
    expect(r.reason).not.toContain(" greet (");
    expect(r.verify).toBeUndefined();
    expect(git(dir, "rev-list", "--count", "main")).toBe("1");
    expect(loadPlan(dir).landed).toBeUndefined();
    // A trailer word inside prose is not a trailer line.
    const { dir: clean } = repo(plan({ verify: ["true"], acceptance: [] }));
    git(clean, "checkout", "-q", branch);
    writeFileSync(join(clean, "src/more.js"), "1\n");
    git(clean, "add", "src");
    git(clean, "commit", "-q", "-m", "greet: more\n\nDrops the Co-Authored-By line the old hook added.");
    git(clean, "checkout", "-q", "main");
    expect(trailerCommits(clean, "main", branch)).toEqual([]);
    expect(landPlan(clean, loadPlan(clean)).ok).toBe(true);
  });
  it("lands with no acceptance commands and records an empty acceptance list", () => {
    const { dir } = repo(plan());
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(r.acceptance).toEqual([]);
    expect(loadPlan(dir).landed.acceptance).toEqual([]);
  });
  it("runs acceptance commands in the worktree after install and verify and records them", () => {
    const { dir } = repo(plan({ install: "echo installed > installed.txt", verify: ["test -f installed.txt"], acceptance: ["prose only", { text: "greet is present", command: "test -f src/greet.js && test -f installed.txt" }] }));
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(r.acceptance).toHaveLength(1);
    expect(r.acceptance[0]).toMatchObject({ text: "greet is present", ok: true, status: 0 });
    expect(r.verify.map((v) => v.command)).toEqual(["echo installed > installed.txt", "test -f installed.txt"]);
    expect(loadPlan(dir).landed.acceptance).toEqual([{ text: "greet is present", command: "test -f src/greet.js && test -f installed.txt", ok: true, durationMs: expect.any(Number) }]);
    expect(git(dir, "log", "-1", "--format=%B")).toContain("greet is present (test -f src/greet.js && test -f installed.txt): ok");
    expect(existsSync(join(dir, "installed.txt"))).toBe(false);
  });
  it("aborts a conflicting merge and leaves the tree clean", () => {
    const { dir } = repo(plan({ verify: [] }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/greet.js"), "conflict\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "conflicting greet on main");
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("failed and was aborted");
    expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("conflicting greet on main");
  });
  it("runs an acceptance command with NO_COLOR=1 and no inherited FORCE_COLOR (card land-force-color-enables-color)", () => {
    const envFile = join(mkdtempSync(join(tmpdir(), "doug-land-env-")), "env.json");
    const cmd = `node -e "require('fs').writeFileSync('${envFile}', JSON.stringify({ NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }))"`;
    const { dir } = repo(plan({ verify: ["true"], acceptance: [{ text: "prints env", command: cmd }] }));
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    const seen = JSON.parse(readFileSync(envFile, "utf8"));
    expect(seen.NO_COLOR).toBe("1");
    expect(seen.FORCE_COLOR).toBeUndefined();
  });
  it("deletes an inherited FORCE_COLOR from the spawned env instead of passing it through", () => {
    const envFile = join(mkdtempSync(join(tmpdir(), "doug-land-env-")), "env.json");
    const cmd = `node -e "require('fs').writeFileSync('${envFile}', JSON.stringify({ NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }))"`;
    const { dir } = repo(plan({ verify: ["true"], acceptance: [{ text: "prints env", command: cmd }] }));
    const original = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "0";
    try {
      const r = landPlan(dir, loadPlan(dir));
      expect(r.ok, r.reason).toBe(true);
    } finally {
      if (original === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = original;
    }
    const seen = JSON.parse(readFileSync(envFile, "utf8"));
    expect(seen.NO_COLOR).toBe("1");
    expect(seen.FORCE_COLOR).toBeUndefined();
  });
});

describe("commandEnv (card land-force-color-enables-color)", () => {
  it("keeps CI when set, defaults it otherwise, sets NO_COLOR, and drops an inherited FORCE_COLOR", () => {
    const env = commandEnv({ CI: "true", FORCE_COLOR: "0", PATH: "x" });
    expect(env).toEqual({ CI: "true", NO_COLOR: "1", PATH: "x" });
    expect(env).not.toHaveProperty("FORCE_COLOR");
    expect(commandEnv({})).toMatchObject({ CI: "1", NO_COLOR: "1" });
  });
});

// Builds on repo(): adds a real task branch doug/task-greet (carrying the greet commit) off main,
// then makes the plan's integration branch a --no-ff merge of that task branch on top of main.
// Leaves main checked out. Worktrees are added on top with addWorktree().
function repoWithTaskBranch(p = plan()) {
  const { dir, branch } = repo(p);
  git(dir, "branch", "doug/task-greet", branch);
  git(dir, "branch", "-f", branch, "main");
  git(dir, "checkout", "-q", branch);
  git(dir, "merge", "-q", "--no-ff", "--no-edit", "-m", "merge greet", "doug/task-greet");
  git(dir, "checkout", "-q", "main");
  return { dir, branch, taskBranch: "doug/task-greet" };
}

// Returns git's own resolved path (macOS resolves tmpdir's /var to /private/var), so comparisons
// against helper results — which come straight from `git worktree list --porcelain` — agree.
function addWorktree(dir, name, branch) {
  mkdirSync(join(dir, ".claude/worktrees"), { recursive: true });
  const wt = join(dir, ".claude/worktrees", name);
  git(dir, "worktree", "add", "-q", wt, branch);
  return realpathSync(wt);
}

describe("landPlan worktrees and branches", () => {
  it("removes a clean worktree on a task branch after land", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const wt = addWorktree(dir, "w1", taskBranch);
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(r.worktrees.removed).toContain(wt);
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(wt);
  });
  it("removes a worktree on an unrelated branch already merged into main", () => {
    const { dir } = repoWithTaskBranch();
    git(dir, "branch", "feature/old", "main");
    const wt = addWorktree(dir, "w2", "feature/old");
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(r.worktrees.removed).toContain(wt);
  });
  it("keeps a worktree on a task branch that holds an untracked file", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const wt = addWorktree(dir, "w3", taskBranch);
    writeFileSync(join(wt, "scratch.txt"), "keep me\n");
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(r.worktrees.kept).toHaveLength(1);
    expect(r.worktrees.kept[0].path).toBe(wt);
    expect(r.worktrees.kept[0].reason.length).toBeGreaterThan(0);
  });
  it("leaves a worktree on an unrelated branch with an unmerged commit untouched", () => {
    const { dir } = repoWithTaskBranch();
    git(dir, "branch", "feature/new", "main");
    const wt = addWorktree(dir, "w4", "feature/new");
    writeFileSync(join(wt, "extra.txt"), "x\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "extra");
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(r.worktrees.removed).not.toContain(wt);
    expect(r.worktrees.kept.some((k) => k.path === wt)).toBe(false);
  });
  it("leaves a worktree outside .claude/worktrees untouched", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const sibling = mkdtempSync(join(tmpdir(), "doug-land-sibling-"));
    git(dir, "worktree", "add", "-q", sibling, taskBranch);
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(sibling)).toBe(true);
    expect(r.worktrees.removed).not.toContain(sibling);
    expect(r.worktrees.kept.some((k) => k.path === sibling)).toBe(false);
  });
  it("keeps task branches by default; deletes them with deleteBranches while keeping the integration branch", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const r = landPlan(dir, loadPlan(dir));
    expect(r.ok, r.reason).toBe(true);
    expect(git(dir, "branch", "--list", taskBranch)).toContain(taskBranch);
    expect(r.branches.deleted).toEqual([]);
    expect(r.branches.kept).toEqual([]);

    const { dir: d2, branch: branch2, taskBranch: taskBranch2 } = repoWithTaskBranch();
    const r2 = landPlan(d2, loadPlan(d2), { deleteBranches: true });
    expect(r2.ok, r2.reason).toBe(true);
    expect(git(d2, "branch", "--list", taskBranch2)).toBe("");
    expect(r2.branches.deleted).toEqual([taskBranch2]);
    expect(git(d2, "branch", "--list", branch2)).toContain(branch2);
  });
  it("keeps the task branch when deleteBranches is true but a dirty worktree still holds it", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const wt = addWorktree(dir, "w6", taskBranch);
    writeFileSync(join(wt, "scratch.txt"), "dirty\n");
    const r = landPlan(dir, loadPlan(dir), { deleteBranches: true });
    expect(r.ok, r.reason).toBe(true);
    expect(git(dir, "branch", "--list", taskBranch)).toContain(taskBranch);
    expect(r.branches.kept).toHaveLength(1);
    expect(r.branches.kept[0].name).toBe(taskBranch);
    expect(r.branches.kept[0].reason.length).toBeGreaterThan(0);
  });
});

describe("plan.mjs land worktrees and branches CLI", () => {
  it("--delete-branches deletes task branches and prints removed worktrees", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const wt = addWorktree(dir, "w5", taskBranch);
    const r = spawnSync(process.execPath, [planCli, "land", "--delete-branches", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`deleted branch ${taskBranch}`);
    expect(r.stdout).toContain(`removed worktree ${wt}`);
  });
  it("uses land.deleteBranches from .doug/config.json when no flag is given", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ land: { deleteBranches: true } }));
    const r = spawnSync(process.execPath, [planCli, "land", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(r.status, r.stderr).toBe(0);
    expect(git(dir, "branch", "--list", taskBranch)).toBe("");
  });
  it("prints kept worktrees", () => {
    const { dir, taskBranch } = repoWithTaskBranch();
    const wt = addWorktree(dir, "w7", taskBranch);
    writeFileSync(join(wt, "scratch.txt"), "keep me\n");
    const r = spawnSync(process.execPath, [planCli, "land", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`kept worktree ${wt}`);
  });
});

describe("integration branch naming", () => {
  it("is the same expression in lib/plan.mjs and the workflow, which cannot import it", () => {
    const source = readFileSync(join(here, "..", "workflows", "doug-implement.js"), "utf8");
    expect(source).toContain("plan.integrationBranch || `doug/${plan.tasks.map(t => t.id).join('-').slice(0, 40)}`");
    expect(integrationBranchFor({ tasks: [{ id: "a" }, { id: "b" }] })).toBe("doug/a-b");
    expect(integrationBranchFor({ integrationBranch: "doug/custom", tasks: [] })).toBe("doug/custom");
    expect(integrationBranchFor({ tasks: [{ id: "x".repeat(50) }] })).toBe("doug/" + "x".repeat(40));
  });
});

describe("plan.mjs land", () => {
  it("prints the result and exits 1 on a refusal", () => {
    const { dir, branch } = repo();
    const ok = spawnSync(process.execPath, [planCli, "land", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`Landed ${branch} into main as`);
    const again = spawnSync(process.execPath, [planCli, "land", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("Refusing to land: plan was already landed");
  });
  it("prints acceptance results", () => {
    const { dir } = repo(plan({ acceptance: [{ text: "greet is present", command: "test -f src/greet.js" }] }));
    const ok = spawnSync(process.execPath, [planCli, "land", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("acceptance ok: greet is present");
  });
});
