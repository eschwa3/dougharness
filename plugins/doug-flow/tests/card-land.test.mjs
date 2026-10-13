// Card parallel-card-queens B6: landCard (lib/card-land.mjs) and plan.mjs land-card on real temp repos.
// A hand card lands by: rebase the card branch on main in its worktree, gate the rebased tree through the
// vendored verify.mjs --json, fast-forward main, remove the card worktree. A refusal never throws.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { landCard } from "../lib/card-land.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const planCli = join(here, "..", "scripts", "plan.mjs");
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const BRANCH = "doug/card-x";
const WT_REL = ".claude/worktrees/card-x";

// A fake vendored verify.mjs: logs cwd, argv and whether main's new file is visible, then answers red when the
// tree holds red.flag, green otherwise, always reporting lockWaitMs 1234.
function fakeVerify(marker) {
  return `import fs from "node:fs";
import path from "node:path";
const cwd = process.cwd();
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd, argv: process.argv.slice(2), sawMainNew: fs.existsSync(path.join(cwd, "main-new.txt")) }) + "\\n");
const red = fs.existsSync(path.join(cwd, "red.flag"));
console.log(JSON.stringify({ ok: !red, credited: null, results: [{ command: "gate", ok: !red, status: red ? 1 : 0, durationMs: 1, outputTail: red ? "boom" : "" }], lockWaitMs: 1234 }));
process.exit(red ? 1 : 0);
`;
}

// main: README, a tracked .doug/board.json, the fake verify. The card worktree branches from main and commits
// card.txt (plus whatever `branchFiles` / `commitMessage` ask for). `moveMain` then adds main-new.txt on main.
function fx({ moveMain = true, branchFiles = {}, mainFiles = {}, commitMessage = "card work" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-card-land-"));
  const markerDir = mkdtempSync(join(tmpdir(), "doug-card-land-marker-"));
  const marker = join(markerDir, "verify.log");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# fx\n");
  writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n.claude/worktrees/\n");
  mkdirSync(join(dir, ".doug/hooks/scripts"), { recursive: true });
  writeFileSync(join(dir, ".doug/board.json"), "{}\n");
  writeFileSync(join(dir, ".doug/hooks/scripts/verify.mjs"), fakeVerify(marker));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  mkdirSync(join(dir, ".claude/worktrees"), { recursive: true });
  git(dir, "worktree", "add", "-q", "-b", BRANCH, WT_REL, "main");
  const wt = join(dir, WT_REL);
  writeFileSync(join(wt, "card.txt"), "card\n");
  for (const [f, c] of Object.entries(branchFiles)) writeFileSync(join(wt, f), c);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", commitMessage);
  if (moveMain) {
    writeFileSync(join(dir, "main-new.txt"), "main moved\n");
    for (const [f, c] of Object.entries(mainFiles)) writeFileSync(join(dir, f), c);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main moves on");
  }
  const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, wt, calls, opts: { id: "x", branch: BRANCH, worktree: wt } };
}

describe("landCard (card parallel-card-queens B6)", () => {
  it("L01: rebases the card onto a moved main, gates the rebased tree, and fast-forwards (no merge commit)", () => {
    const { dir, wt, calls, opts } = fx();
    const mainTip = git(dir, "rev-parse", "main");
    const wtReal = realpathSync(wt); // before landing: landing removes the worktree
    const r = landCard(dir, opts);
    expect(r.ok, r.reason).toBe(true);
    expect(git(dir, "rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(2); // one parent: a fast-forward
    expect(git(dir, "rev-parse", "HEAD^")).toBe(mainTip); // the card commit sits on the moved main
    expect(git(dir, "log", "-1", "--format=%s")).toBe("card work");
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(dir, "rev-parse", BRANCH));
    expect(git(dir, "rev-parse", "HEAD").startsWith(r.commit)).toBe(true);
    expect(existsSync(join(dir, "card.txt")) && existsSync(join(dir, "main-new.txt"))).toBe(true);
    const seen = calls();
    expect(seen).toHaveLength(1);
    expect(seen[0].sawMainNew, "verify ran on the rebased tree").toBe(true);
    expect(seen[0].cwd.replace(/^\/private/, "")).toBe(wtReal.replace(/^\/private/, "")); // the worktree is gone now: compare strings
    expect(seen[0].argv).toContain("--json");
    expect(typeof r.gateLine).toBe("string");
    expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("L01b: a card on an unmoved main fast-forwards too", () => {
    const { dir, opts } = fx({ moveMain: false });
    const r = landCard(dir, opts);
    expect(r.ok, r.reason).toBe(true);
    expect(git(dir, "rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(2);
    expect(existsSync(join(dir, "card.txt"))).toBe(true);
  });

  it("L02: a rebase conflict is aborted, refused as rebase-conflict naming the file, and main and the branch are unchanged", () => {
    const { dir, wt, calls, opts } = fx({ moveMain: true, mainFiles: { "README.md": "# main edit\n" }, branchFiles: { "README.md": "# card edit\n" } });
    const mainTip = git(dir, "rev-parse", "main");
    const branchTip = git(dir, "rev-parse", BRANCH);
    const r = landCard(dir, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^rebase-conflict:/);
    expect(r.reason).toContain("README.md");
    expect(git(dir, "rev-parse", "main")).toBe(mainTip);
    expect(git(dir, "rev-parse", BRANCH)).toBe(branchTip);
    const inProgress = ["rebase-merge", "rebase-apply"].some((p) => existsSync(git(wt, "rev-parse", "--path-format=absolute", "--git-path", p)));
    expect(inProgress, "the rebase was aborted").toBe(false);
    expect(git(wt, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(calls(), "no gate on a refused rebase").toHaveLength(0);
    expect(existsSync(wt)).toBe(true);
  });

  it("L02b: a rebase that fails for a reason other than a conflict is refused under another reason", () => {
    const { dir, wt, opts } = fx();
    writeFileSync(join(wt, "card.txt"), "dirty edit\n"); // a tracked change in the worktree: git refuses to rebase
    const mainTip = git(dir, "rev-parse", "main");
    const r = landCard(dir, opts);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason).not.toMatch(/^rebase-conflict/);
    expect(git(dir, "rev-parse", "main")).toBe(mainTip);
  });

  it("L03: a branch commit carrying a Co-Authored-By or Claude-Session line is refused; nothing is gated or merged", () => {
    const { dir, wt, calls, opts } = fx({ commitMessage: "card work\n\nCo-Authored-By: Someone <s@example.com>\nClaude-Session: https://example.com/s" });
    const mainTip = git(dir, "rev-parse", "main");
    const r = landCard(dir, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Co-Authored-By/);
    expect(r.reason).toMatch(/Claude-Session/);
    expect(git(dir, "rev-parse", "main")).toBe(mainTip);
    expect(calls()).toHaveLength(0);
    expect(existsSync(wt)).toBe(true);
  });

  it("L04: a tracked change in main outside .doug/ is refused and main is untouched", () => {
    const { dir, calls, opts } = fx();
    writeFileSync(join(dir, "README.md"), "# dirty\n");
    const mainTip = git(dir, "rev-parse", "main");
    const r = landCard(dir, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("README.md");
    expect(git(dir, "rev-parse", "main")).toBe(mainTip);
    expect(calls()).toHaveLength(0);
  });

  it("L04b: a tracked change under .doug/ does not stop the landing", () => {
    const { dir, opts } = fx();
    writeFileSync(join(dir, ".doug/board.json"), '{"edited":true}\n');
    const r = landCard(dir, opts);
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(join(dir, "card.txt"))).toBe(true);
  });

  it("L04c: refuses when the base branch is not the one checked out in main", () => {
    const { dir, opts } = fx();
    git(dir, "checkout", "-q", "-b", "other");
    const otherTip = git(dir, "rev-parse", "HEAD");
    const r = landCard(dir, opts);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(git(dir, "rev-parse", "HEAD")).toBe(otherTip);
    expect(git(dir, "rev-parse", "main")).not.toBe(git(dir, "rev-parse", BRANCH));
  });

  it("L05: a red gate is refused and nothing merges; the worktree and branch stay", () => {
    const { dir, wt, calls, opts } = fx({ branchFiles: { "red.flag": "1\n" } });
    const mainTip = git(dir, "rev-parse", "main");
    const r = landCard(dir, opts);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(calls()).toHaveLength(1);
    expect(git(dir, "rev-parse", "main")).toBe(mainTip);
    expect(existsSync(join(dir, "card.txt"))).toBe(false);
    expect(existsSync(wt)).toBe(true);
    expect(git(dir, "branch", "--list", BRANCH)).toContain(BRANCH);
  });

  it("L06: after landing, only the card worktree is removed (branch kept); a sibling worktree merged into main is left", () => {
    const { dir, wt, opts } = fx();
    git(dir, "worktree", "add", "-q", "-b", "doug/sibling", ".claude/worktrees/sibling", "main"); // an ancestor of main
    const r = landCard(dir, opts);
    expect(r.ok, r.reason).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(r.removed.some((p) => p.endsWith("card-x"))).toBe(true);
    expect(r.removed.some((p) => p.endsWith("sibling"))).toBe(false);
    expect(existsSync(join(dir, ".claude/worktrees/sibling")), "never swept by mergedInto").toBe(true);
    expect(git(dir, "branch", "--list", BRANCH)).toContain(BRANCH);
  });

  it("L07: lockWaitMs comes from verify's JSON", () => {
    const { dir, opts } = fx();
    const r = landCard(dir, opts);
    expect(r.ok, r.reason).toBe(true);
    expect(r.lockWaitMs).toBe(1234);
  });

  it("returns a refusal, never throws, for a branch or worktree that does not exist", () => {
    const { dir, opts } = fx();
    let r;
    expect(() => {
      r = landCard(dir, { ...opts, branch: "doug/nope" });
    }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(() => {
      r = landCard(dir, { ...opts, worktree: join(dir, ".claude/worktrees/missing") });
    }).not.toThrow();
    expect(r.ok).toBe(false);
  });
});

describe("plan.mjs land-card (card parallel-card-queens B6)", () => {
  const run = (dir, extra) => spawnSync(process.execPath, [planCli, "land-card", "x", ...extra], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

  it("L08: lands with no plan file at all, printing the commit, the lock wait and the removed worktree", () => {
    const { dir, wt } = fx();
    expect(existsSync(join(dir, ".doug/plan.json"))).toBe(false);
    const res = run(dir, ["--branch", BRANCH, "--worktree", wt]);
    expect(res.status, res.stderr).toBe(0);
    const head = git(dir, "rev-parse", "--short", "HEAD");
    expect(res.stdout).toContain(head);
    expect(res.stdout).toContain("1234");
    expect(res.stdout).toMatch(/removed worktree .*card-x/);
    expect(existsSync(wt)).toBe(false);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("card work");
    expect(existsSync(join(dir, ".doug/plan.json"))).toBe(false);
  });

  it("L08b: a refusal exits non-zero with the reason on stderr and merges nothing", () => {
    const { dir, wt } = fx({ branchFiles: { "red.flag": "1\n" } });
    const mainTip = git(dir, "rev-parse", "main");
    const res = run(dir, ["--branch", BRANCH, "--worktree", wt, "--base", "main"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
    expect(git(dir, "rev-parse", "main")).toBe(mainTip);
  });
});
