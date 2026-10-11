// Split from git-hooks.test.mjs (card split-git-hooks-rehearse-tests) to balance runtime: the dist rebuild hooks.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { HOOKS_DIR, git, commit, gitA, commitA, makeRepoA } from "./git-hooks-fixtures.mjs";

// Load-proofing (card gate-docs-skip-unless-named, same mechanism as 7d1c99b / rehearse.test.mjs): vitest's worker
// answers its main process over an RPC whose calls time out after 60 s. A synchronous spawn blocks this worker's
// event loop for as long as the child runs, so the docs-rule cases below (many git calls and a full pre-commit hook
// run each) go through async spawns. Only the spawn mechanics are async; every assertion is unchanged. The per-test
// timeout is raised because a test now honours it and takes seconds on an idle machine, minutes on a loaded one.
vi.setConfig({ testTimeout: 600_000 });
// Back-to-back synchronous tests (the older cases here still spawn with spawnSync) only await microtasks between
// them, so the loop never turns and the worker's RPC replies queue up behind the whole run. One macrotask turn
// after each test lets them through.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)));

// card cli-dist-rebuild-post-commit: .githooks/post-commit (and post-merge) rebuild packages/doug-cli's dist
// when the commit (or merge) touched packages/doug-cli/src/**, packages/doug-cli/package.json or
// packages/doug-cli/tsconfig*.json. plugins/doug-flow/lib is not a trigger (dist loads it live). The hook never
// blocks or changes the commit; a failing build prints the error plus a "dist is stale" note and exits 0; a
// linked worktree does nothing. The fixture is a pnpm workspace whose `build` script is a fake that appends a
// line to $BUILD_CALLS (no write when unset, so setup commits stay silent) and exits $BUILD_EXIT.
// All spawns are async (as in 7d1c99b) so they cannot cause a vitest worker RPC timeout.
describe("dist rebuild hooks (card cli-dist-rebuild-post-commit)", () => {
  // The stable substring asserted for the stale-dist note; the rest of the wording is the hook's.
  const STALE = "dist is stale";
  const SRC = "packages/doug-cli/src/index.ts";
  const FLOW_LIB = "plugins/doug-flow/lib/board.mjs";
  const DOC = "docs/notes.md";

  const BUILD_SCRIPT =
    `import { appendFileSync } from "node:fs";\n` +
    `const leaked = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"].filter((k) => k in process.env);\n` +
    `if (process.env.BUILD_CALLS) appendFileSync(process.env.BUILD_CALLS, leaked.length ? "build LEAKED-GIT-ENV=" + leaked.join(",") + "\\n" : "build\\n");\n` +
    `if (leaked.length) { console.error("LEAKED-GIT-ENV=" + leaked.join(",")); process.exit(1); }\n` +
    `const code = Number(process.env.BUILD_EXIT || 0);\n` +
    `if (code) console.error("BUILD-FAIL-MARKER");\n` +
    `process.exit(code);\n`;

  // A pnpm workspace with the fake doug-cli build, one green baseline commit (made with BUILD_CALLS unset, so the
  // hook under test, if present, records nothing), and a calls file path outside the repo.
  async function buildRepo() {
    const cwd = await makeRepoA({ typecheckExit: 0, unitExit: 0 });
    const files = {
      "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n`,
      "packages/doug-cli/package.json": JSON.stringify({ name: "doug-cli-fixture", private: true, scripts: { build: "node build.mjs" } }, null, 2),
      "packages/doug-cli/build.mjs": BUILD_SCRIPT,
      "packages/doug-cli/tsconfig.build.json": "{ \"a\": 1 }\n",
      [SRC]: "export const a = 1;\n",
      [FLOW_LIB]: "export const b = 1;\n",
      [DOC]: "v1\n",
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, f)), { recursive: true });
      writeFileSync(join(cwd, f), body);
    }
    await gitA(cwd, ["add", "-A"]);
    const first = await commitA(cwd);
    expect(first.status, first.out).toBe(0);
    const calls = join(mkdtempSync(join(tmpdir(), "doug-githooks-calls-")), "calls.log");
    return { cwd, calls };
  }
  const readCalls = (calls) => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
  const headCount = async (cwd) => (await gitA(cwd, ["rev-list", "--count", "HEAD"])).stdout.trim();

  // Change `file` (appending to it), stage it, and commit with the fake build wired to `calls`.
  async function commitChange(cwd, calls, file, env = {}) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    const prior = existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";
    // a JSON file stays valid (pnpm reads the workspace's package.json files); anything else gets a comment line
    writeFileSync(join(cwd, file), file.endsWith(".json") ? prior.replace(/\s*\}\s*$/, ', "touched": 1 }\n') : prior + "// changed\n");
    await gitA(cwd, ["add", file]);
    const r = await gitA(cwd, ["commit", "-q", "-m", "x"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, BUILD_CALLS: calls, ...env });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("T0: the post-commit and post-merge hooks exist and are executable", () => {
    for (const name of ["post-commit", "post-merge"]) {
      const hook = join(HOOKS_DIR, name);
      expect(existsSync(hook), `${hook} must exist`).toBe(true);
      expect(statSync(hook).mode & 0o111, `${hook} must be executable`).not.toBe(0);
    }
  });

  // M1 (trigger never matches) fails this; it is also what proves the fixture's `pnpm --filter ... run build` works.
  it("T1: a commit touching packages/doug-cli/src runs the build exactly once, with no leaked git env", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, SRC);
    expect(status, out).toBe(0);
    expect(await headCount(cwd)).toBe("2");
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  // M1 (trigger never matches) fails these.
  it("T2: a commit touching packages/doug-cli/package.json runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, "packages/doug-cli/package.json");
    expect(status, out).toBe(0);
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  it("T3: a commit touching packages/doug-cli/tsconfig.build.json (the tsconfig*.json glob) runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, "packages/doug-cli/tsconfig.build.json");
    expect(status, out).toBe(0);
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  // M2 (trigger matches any path) and M3 (flow lib added to the trigger) fail these.
  it("T4: a commit touching only plugins/doug-flow/lib does not run the build", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, FLOW_LIB);
    expect(status, out).toBe(0);
    expect(await headCount(cwd)).toBe("2");
    expect(readCalls(calls), out).toEqual([]);
  });

  it("T5: a docs-only commit does not run the build", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, DOC);
    expect(status, out).toBe(0);
    expect(await headCount(cwd)).toBe("2");
    expect(readCalls(calls), out).toEqual([]);
  });

  // M4 (failure propagates / no note) fails this.
  it("T6: a failing build leaves the commit in place, prints the build error and the stale-dist note, and exits 0", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, SRC, { BUILD_EXIT: "1" });
    expect(status, `a failing rebuild must not fail the commit:\n${out}`).toBe(0);
    expect(await headCount(cwd), "the commit stays in place").toBe("2");
    expect(readCalls(calls), out).toEqual(["build"]);
    expect(out, "the build's own error is shown").toContain("BUILD-FAIL-MARKER");
    expect(out, `expected the note "${STALE}" in:\n${out}`).toContain(STALE);
    // tsc emits despite type errors, so the old dist is not guaranteed untouched: the note must not claim it is.
    expect(out, "the note must not claim the old dist is left in place").not.toContain("left in place");
  });

  // The stale note belongs to failures only: a good build prints none.
  it("T7: a successful build prints no stale-dist note", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, SRC);
    expect(status, out).toBe(0);
    expect(readCalls(calls), out).toEqual(["build"]);
    expect(out).not.toContain(STALE);
  });

  // M5 (GIT_* not unset) fails this: the fake build records and fails on any leaked git location variable.
  it("T8: git's exported GIT_* variables are unset before pnpm runs (the fake build sees none)", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, SRC);
    expect(status, out).toBe(0);
    expect(readCalls(calls), `the build must run and see no GIT_* variables:\n${out}`).toEqual(["build"]);
    expect(out).not.toMatch(/LEAKED-GIT-ENV=\S/);
  });

  // M7 (worktree check removed) fails this.
  it("T9: a commit touching packages/doug-cli/src inside a linked worktree does not run the build", async () => {
    const { cwd, calls } = await buildRepo();
    const wt = join(mkdtempSync(join(tmpdir(), "doug-githooks-wt-")), "wt");
    const add = await gitA(cwd, ["worktree", "add", "-q", "-b", "wt-branch", wt]);
    expect(add.status, add.stderr).toBe(0);
    await gitA(wt, ["config", "user.name", "Test"]);
    mkdirSync(dirname(join(wt, SRC)), { recursive: true });
    writeFileSync(join(wt, SRC), "export const a = 2;\n");
    await gitA(wt, ["add", SRC]);
    const r = await gitA(wt, ["commit", "-q", "-m", "wt"], { BUILD_CALLS: calls });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect((await gitA(wt, ["rev-list", "--count", "HEAD"])).stdout.trim(), "the worktree commit landed").toBe("2");
    expect(readCalls(calls), out).toEqual([]);
  });

  // post-merge: setup commits run with BUILD_CALLS unset so only the merge itself can record a call.
  async function branchCommit(cwd, branch, file, body) {
    await gitA(cwd, ["checkout", "-q", "-b", branch]);
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
    await gitA(cwd, ["add", file]);
    const c = await commitA(cwd);
    expect(c.status, c.out).toBe(0);
    await gitA(cwd, ["checkout", "-q", "main"]);
  }
  const merge = async (cwd, calls, extra = []) => {
    const r = await gitA(cwd, ["merge", "-q", "--no-edit", ...extra, "feat"], { BUILD_CALLS: calls });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  // M6 (post-merge missing or a no-op) fails these.
  it("T10: a non-fast-forward merge of a branch touching packages/doug-cli/src runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    await branchCommit(cwd, "feat", SRC, "export const a = 3;\n");
    writeFileSync(join(cwd, DOC), "diverged\n");
    await gitA(cwd, ["add", DOC]);
    expect((await commitA(cwd)).status).toBe(0);
    const { status, out } = await merge(cwd, calls, ["--no-ff"]);
    expect(status, out).toBe(0);
    expect(readFileSync(join(cwd, SRC), "utf8"), "the merge brought the change in").toBe("export const a = 3;\n");
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  it("T11: a fast-forward merge of a branch touching packages/doug-cli/src runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    await branchCommit(cwd, "feat", SRC, "export const a = 4;\n");
    const { status, out } = await merge(cwd, calls, ["--ff-only"]);
    expect(status, out).toBe(0);
    expect(readFileSync(join(cwd, SRC), "utf8")).toBe("export const a = 4;\n");
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  // M2 (trigger matches any path) fails this on the merge side.
  it("T12: a merge touching only docs does not run the build", async () => {
    const { cwd, calls } = await buildRepo();
    await branchCommit(cwd, "feat", DOC, "from the branch\n");
    writeFileSync(join(cwd, FLOW_LIB), "export const b = 2;\n");
    await gitA(cwd, ["add", FLOW_LIB]);
    expect((await commitA(cwd)).status).toBe(0);
    const { status, out } = await merge(cwd, calls, ["--no-ff"]);
    expect(status, out).toBe(0);
    expect(readFileSync(join(cwd, DOC), "utf8")).toBe("from the branch\n");
    expect(readCalls(calls), out).toEqual([]);
  });

  // T13 (review m1): a conflicting merge finished with `git commit` fires post-commit, where diff-tree on a merge
  // commit lists nothing; the hook must diff the first parent against HEAD when HEAD has two or more parents.
  it("T13: a conflicting merge resolved and finished with git commit runs the build exactly once", async () => {
    const { cwd, calls } = await buildRepo();
    const A = "packages/doug-cli/src/a.ts";
    const NEW = "packages/doug-cli/src/new.ts";
    mkdirSync(dirname(join(cwd, A)), { recursive: true });
    writeFileSync(join(cwd, A), "base\n");
    await gitA(cwd, ["add", A]);
    expect((await commitA(cwd)).status).toBe(0);
    await gitA(cwd, ["checkout", "-q", "-b", "feat"]);
    writeFileSync(join(cwd, A), "feat\n");
    writeFileSync(join(cwd, NEW), "export const n = 1;\n");
    await gitA(cwd, ["add", A, NEW]);
    expect((await commitA(cwd)).status).toBe(0);
    await gitA(cwd, ["checkout", "-q", "main"]);
    writeFileSync(join(cwd, A), "main\n");
    await gitA(cwd, ["add", A]);
    expect((await commitA(cwd)).status).toBe(0);
    const m = await merge(cwd, calls, ["--no-ff"]);
    expect(m.status, `the merge must conflict:\n${m.out}`).not.toBe(0);
    expect(readCalls(calls), "a conflicted merge has not committed yet").toEqual([]);
    writeFileSync(join(cwd, A), "resolved\n");
    await gitA(cwd, ["add", A]);
    const r = await gitA(cwd, ["commit", "-q", "--no-edit"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, BUILD_CALLS: calls });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect((await gitA(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(" ").length, "HEAD is a merge").toBe(3);
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  // T14 (review m3): git quotes non-ASCII paths ("packages/.../\303\251.ts") unless told not to, which hides them from the match.
  it("T14: a commit adding packages/doug-cli/src/\u00e9.ts (non-ASCII path) runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    const { status, out } = await commitChange(cwd, calls, "packages/doug-cli/src/\u00e9.ts");
    expect(status, out).toBe(0);
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  // T15 (gap): M7 on the merge side. The merge runs inside a linked worktree and brings in a src change.
  it("T15: a merge touching packages/doug-cli/src inside a linked worktree does not run the build", async () => {
    const { cwd, calls } = await buildRepo();
    await branchCommit(cwd, "feat", SRC, "export const a = 5;\n");
    const wt = join(mkdtempSync(join(tmpdir(), "doug-githooks-wtm-")), "wt");
    const add = await gitA(cwd, ["worktree", "add", "-q", "-b", "wt-branch", wt, "main"]);
    expect(add.status, add.stderr).toBe(0);
    const { status, out } = await (async () => {
      const r = await gitA(wt, ["merge", "-q", "--no-edit", "--no-ff", "feat"], { BUILD_CALLS: calls });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    })();
    expect(status, out).toBe(0);
    expect(readFileSync(join(wt, SRC), "utf8"), "the merge brought the change in").toBe("export const a = 5;\n");
    expect(readCalls(calls), out).toEqual([]);
  });

  // T16 (gap): the diff must span ORIG_HEAD..HEAD, not just the last commit: only the FIRST commit of the merged
  // branch touches src, the second is docs-only.
  async function twoCommitBranch(cwd) {
    await gitA(cwd, ["checkout", "-q", "-b", "feat"]);
    writeFileSync(join(cwd, SRC), "export const a = 6;\n");
    await gitA(cwd, ["add", SRC]);
    expect((await commitA(cwd)).status).toBe(0);
    writeFileSync(join(cwd, DOC), "later docs\n");
    await gitA(cwd, ["add", DOC]);
    expect((await commitA(cwd)).status).toBe(0);
    await gitA(cwd, ["checkout", "-q", "main"]);
  }
  it("T16: a non-fast-forward merge of a two-commit branch where only the first commit touches src runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    await twoCommitBranch(cwd);
    writeFileSync(join(cwd, FLOW_LIB), "export const b = 3;\n");
    await gitA(cwd, ["add", FLOW_LIB]);
    expect((await commitA(cwd)).status).toBe(0);
    const { status, out } = await merge(cwd, calls, ["--no-ff"]);
    expect(status, out).toBe(0);
    expect(readCalls(calls), out).toEqual(["build"]);
  });

  // Fast-forward variant: here HEAD~1 is the branch's first commit's successor, so a HEAD~1..HEAD diff misses src.
  it("T16b: a fast-forward merge of a two-commit branch where only the first commit touches src runs the build once", async () => {
    const { cwd, calls } = await buildRepo();
    await twoCommitBranch(cwd);
    const { status, out } = await merge(cwd, calls, ["--ff-only"]);
    expect(status, out).toBe(0);
    expect(readCalls(calls), out).toEqual(["build"]);
  });
});
