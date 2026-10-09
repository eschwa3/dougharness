import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The repo's real hook directory, not a copy: the test proves the file that ships.
const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".githooks");

// Every git spawn starts from an env with git's own location variables removed,
// so the test stays in its temp repos even when it runs inside the outer hook.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return env;
}

function git(cwd, args, extraEnv = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...cleanEnv(), ...extraEnv } });
}

// Each case gets a fresh repo whose package.json maps `typecheck` and
// `test:unit` to trivial scripts, so the hook's `pnpm typecheck` /
// `pnpm test:unit` calls resolve to the case's exit codes.
function makeRepo({ typecheckExit, unitExit }) {
  const cwd = mkdtempSync(join(tmpdir(), "doug-githooks-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "core.hooksPath", HOOKS_DIR]);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        private: true,
        scripts: { typecheck: "node typecheck.mjs", "test:unit": "node test-unit.mjs" },
      },
      null,
      2,
    ),
  );
  // typecheck also fails on any git location vars the hook let through: with
  // GIT_DIR / GIT_INDEX_FILE set, git spawned by the real test suite would
  // operate on the committing repo instead of its own temp repos.
  writeFileSync(
    join(cwd, "typecheck.mjs"),
    `console.log("TYPECHECK-MARKER");\n` +
      `const leaked = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"].filter((k) => k in process.env);\n` +
      `if (leaked.length) { console.log("LEAKED-GIT-ENV=" + leaked.join(",")); process.exit(1); }\n` +
      `process.exit(${typecheckExit});\n`,
  );
  writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER");\nprocess.exit(${unitExit});\n`);
  git(cwd, ["add", "-A"]);
  return cwd;
}

// GIT_DIR / GIT_WORK_TREE point at the same temp repo, so they are harmless
// here; git forwards them to the hook, which makes the leak check deterministic
// rather than depending on which variables git happens to export.
function commit(cwd) {
  const r = git(cwd, ["commit", "-q", "-m", "x"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

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

// An async spawn that never rejects: resolves { status, stdout, stderr } like spawnSync's result.
function runAsync(bin, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ status: null, stdout, stderr: String(e) });
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => (stderr += String(e)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
function gitA(cwd, args, extraEnv = {}) {
  return runAsync("git", args, { cwd, env: { ...cleanEnv(), ...extraEnv } });
}
async function commitA(cwd) {
  const r = await gitA(cwd, ["commit", "-q", "-m", "x"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// Async twin of makeRepo for the docs-rule cases (identical fixture, async git calls).
async function makeRepoA({ typecheckExit, unitExit }) {
  const cwd = mkdtempSync(join(tmpdir(), "doug-githooks-"));
  await gitA(cwd, ["init", "-q", "-b", "main"]);
  await gitA(cwd, ["config", "user.name", "Test"]);
  await gitA(cwd, ["config", "user.email", "test@example.com"]);
  await gitA(cwd, ["config", "core.hooksPath", HOOKS_DIR]);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: "node typecheck.mjs", "test:unit": "node test-unit.mjs" } }, null, 2),
  );
  writeFileSync(
    join(cwd, "typecheck.mjs"),
    `console.log("TYPECHECK-MARKER");\n` +
      `const leaked = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"].filter((k) => k in process.env);\n` +
      `if (leaked.length) { console.log("LEAKED-GIT-ENV=" + leaked.join(",")); process.exit(1); }\n` +
      `process.exit(${typecheckExit});\n`,
  );
  writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER");\nprocess.exit(${unitExit});\n`);
  await gitA(cwd, ["add", "-A"]);
  return cwd;
}

// card gate-output-names-failures (R3): the "full output kept at <path>" line is not quoted, so this grabs
// everything up to the end of that line.
function extractLogPath(out, cwd) {
  const m = out.match(/full output kept at (\S+)/);
  if (!m) return null;
  return m[1].startsWith("/") ? m[1] : join(cwd, m[1]);
}

describe("checked-in pre-commit hook", () => {
  it("exists and is executable", () => {
    const hook = join(HOOKS_DIR, "pre-commit");
    expect(existsSync(hook)).toBe(true);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it("refuses the commit when typecheck fails, showing its output", () => {
    const cwd = makeRepo({ typecheckExit: 1, unitExit: 0 });
    const { status, out } = commit(cwd);
    expect(status).not.toBe(0);
    expect(git(cwd, ["rev-parse", "HEAD"]).status).not.toBe(0);
    expect(out).toContain("TYPECHECK-MARKER");
    expect(out).toContain("pre-commit: pnpm typecheck failed; commit refused");
    expect(out).not.toContain("UNIT-MARKER");
    expect(out).not.toMatch(/LEAKED-GIT-ENV=\S/);
  });

  it("refuses the commit when the unit tests fail, showing their output", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 1 });
    const { status, out } = commit(cwd);
    expect(status).not.toBe(0);
    expect(git(cwd, ["rev-parse", "HEAD"]).status).not.toBe(0);
    expect(out).toContain("UNIT-MARKER");
    expect(out).toContain("pre-commit: pnpm test:unit failed; commit refused");
    expect(out).not.toMatch(/LEAKED-GIT-ENV=\S/);
  });

  // card gate-output-names-failures (brief F1/F3, design R3): a failing step's full output is kept under
  // .doug/.state/pre-commit and its path printed, so a discarded terminal (like the record commits for
  // 98fd1bb and 2f03658) still leaves something to read.
  it("G1: on a unit-test failure, the full output is kept under .doug/.state/pre-commit and its path is printed", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 1 });
    const { status, out } = commit(cwd);
    expect(status).not.toBe(0);
    expect(out, `expected a "full output kept at <path>" line in:\n${out}`).toContain("full output kept at ");
    const logPath = extractLogPath(out, cwd);
    expect(logPath).toMatch(/\.doug\/\.state\/pre-commit\//);
    expect(existsSync(logPath), `expected the kept log file to exist at ${logPath}`).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("UNIT-MARKER");
    expect(out, "the failing step's output must still stream to the terminal too").toContain("UNIT-MARKER");
    expect(out).toContain("pre-commit: pnpm test:unit failed; commit refused");
  });

  it("lets a green commit through", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(out).not.toMatch(/LEAKED-GIT-ENV=\S/);
    const log = git(cwd, ["log", "--oneline"]);
    expect(log.status).toBe(0);
    expect(log.stdout.trim().split("\n")).toHaveLength(1);
  });

  // card gate-output-names-failures (design R3): the same for the typecheck step, and the green case leaves
  // nothing behind.
  it("G2: on a typecheck failure, the full output is kept under .doug/.state/pre-commit and its path is printed", () => {
    const cwd = makeRepo({ typecheckExit: 1, unitExit: 0 });
    const { status, out } = commit(cwd);
    expect(status).not.toBe(0);
    expect(out, `expected a "full output kept at <path>" line in:\n${out}`).toContain("full output kept at ");
    const logPath = extractLogPath(out, cwd);
    expect(logPath).toMatch(/\.doug\/\.state\/pre-commit\//);
    expect(existsSync(logPath), `expected the kept log file to exist at ${logPath}`).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("TYPECHECK-MARKER");
    expect(out, "the failing step's output must still stream to the terminal too").toContain("TYPECHECK-MARKER");
    expect(out).toContain("pre-commit: pnpm typecheck failed; commit refused");
  });

  // Updated for card stop-gate-credits-pre-commit: every run (pass or fail) now writes
  // .doug/.state/pre-commit/last-run.json (the machine-readable record the Stop gate credits), so a green
  // commit no longer leaves that directory empty. This still pins the original guarantee — no per-step log
  // survives a green run — by excluding only that one expected file.
  it("G3: on a green commit, no step log is left under .doug/.state/pre-commit (only last-run.json)", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    const { status } = commit(cwd);
    expect(status).toBe(0);
    const dir = join(cwd, ".doug/.state/pre-commit");
    const remaining = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f !== "last-run.json");
    expect(remaining, `expected no step-log files left under .doug/.state/pre-commit, found: ${remaining.join(", ")}`).toEqual([]);
  });

  // Review round 1 (coordinator's BLOCKER): review B1 already made a missing/non-numeric $log.status file
  // read as failure inside run_step (line ~36-42), but that guard is only reached once `mkdir -p
  // .doug/.state/pre-commit` itself has already succeeded. This pins the step before it: when
  // .doug/.state already exists as a plain FILE (not a directory), that mkdir -p can never succeed, no
  // step ever runs, and no status file is ever written - the hook must still fail closed instead of
  // silently letting the commit through.
  it("G4 (reviewer BLOCKER) fails closed when .doug/.state cannot become a directory: refuses the commit rather than silently letting it through", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 1 });
    mkdirSync(join(cwd, ".doug"), { recursive: true });
    writeFileSync(join(cwd, ".doug/.state"), "not a directory"); // blocks `mkdir -p .doug/.state/pre-commit`
    const { status, out } = commit(cwd);
    expect(status, out).not.toBe(0);
    expect(git(cwd, ["rev-parse", "HEAD"]).status).not.toBe(0);
    expect(out).toContain("commit refused");
  });

  // card stop-gate-credits-pre-commit: the hook records a machine-readable result of its own run, so the
  // Stop gate can credit a passing pre-commit run instead of re-running the same commands. Record path
  // (lead's design): .doug/.state/pre-commit/last-run.json, shape
  // { version: 1, tree: "<40-hex>", ok: bool, at: "<ISO time>",
  //   commands: [ { name, command, exit, durationMs }, ... ] }.
  describe("pre-commit run record (card stop-gate-credits-pre-commit)", () => {
    const recordPath = (cwd) => join(cwd, ".doug/.state/pre-commit/last-run.json");
    const headTree = (cwd) => git(cwd, ["rev-parse", "HEAD^{tree}"]).stdout.trim();

    it("P1: a passing commit writes last-run.json with ok true, the new commit's tree, and two commands with exit 0 and numeric durationMs", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      const { status, out } = commit(cwd);
      expect(status, out).toBe(0);
      expect(existsSync(recordPath(cwd)), `expected ${recordPath(cwd)} to exist after a passing commit`).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(record.version).toBe(1);
      expect(record.ok).toBe(true);
      expect(record.tree).toBe(headTree(cwd));
      expect(record.commands).toHaveLength(2);
      expect(record.commands.map((c) => c.name)).toEqual(["typecheck", "test:unit"]);
      expect(record.commands.map((c) => c.command)).toEqual(["pnpm typecheck", "pnpm test:unit"]);
      for (const c of record.commands) {
        expect(c.exit).toBe(0);
        expect(typeof c.durationMs, `expected a numeric durationMs, got ${JSON.stringify(c.durationMs)}`).toBe("number");
        expect(Number.isFinite(c.durationMs)).toBe(true);
      }
    });

    it("P2: a failing test:unit run never leaves a passing record in place, even overwriting an earlier passing one", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      const first = commit(cwd);
      expect(first.status, first.out).toBe(0);
      // Sanity: a passing record exists from the first (green) commit before the failing attempt below.
      expect(JSON.parse(readFileSync(recordPath(cwd), "utf8")).ok).toBe(true);

      writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER");\nprocess.exit(1);\n`);
      git(cwd, ["add", "-A"]);
      const second = commit(cwd);
      expect(second.status).not.toBe(0);

      if (existsSync(recordPath(cwd))) {
        const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
        expect(
          record.ok,
          `expected no passing record left after a failing pre-commit run, got: ${JSON.stringify(record)}`,
        ).toBe(false);
      }
    });

    it("P3: `git commit -a` (a tracked file modified but not staged) records the resulting commit's tree", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      const first = commit(cwd);
      expect(first.status, first.out).toBe(0);

      // Modify a tracked file without staging it, then commit with -a: git points GIT_INDEX_FILE at a
      // temporary index for this commit, so the record's tree must reflect that index, not a plain
      // `git write-tree` of whatever the real .git/index currently holds.
      const original = readFileSync(join(cwd, "typecheck.mjs"), "utf8");
      writeFileSync(join(cwd, "typecheck.mjs"), original + "// touched, not staged\n");
      const r = git(cwd, ["commit", "-a", "-q", "-m", "y"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(record.ok).toBe(true);
      expect(record.tree).toBe(headTree(cwd));
    });

    // Round 2 (reviewer BLOCKER): the commands above run against the WORKING TREE, but the record's `tree`
    // is the committed INDEX. A file staged one way and left a different way on disk lets a broken committed
    // version hide behind a passing working-tree run; an untracked file the tests depend on is invisible to
    // `git write-tree` the same way. Fix (lead's design): the hook also fails ok:true unless the working
    // tree has nothing beyond the index being committed — `git diff --quiet` (against GIT_INDEX_FILE, run
    // before the unset) and no untracked files (`git ls-files --others --exclude-standard`), both ignoring
    // .doug/.state/, .doug/anchor.md, and .claude/worktrees/. The commit itself is never refused for this;
    // only `ok` moves off true.
    it("P4: staged content differs from disk (a different unstaged edit atop the staged one) → commit succeeds but the record is not ok", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      // Stage one passing version of test-unit.mjs...
      writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER-STAGED");\nprocess.exit(0);\n`);
      git(cwd, ["add", "test-unit.mjs"]);
      // ...then leave a DIFFERENT passing version on disk, unstaged: the commit records the staged one, but
      // the hook's commands run against this one.
      writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER-DISK");\nprocess.exit(0);\n`);

      const { status, out } = commit(cwd);
      expect(status, out).toBe(0); // the commit itself is not refused for this
      expect(existsSync(recordPath(cwd))).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(
        record.ok,
        `expected ok !== true (disk deviates from the committed index): ${JSON.stringify(record)}`,
      ).not.toBe(true);
    });

    it("P5: an untracked (not ignored) file present at commit time → commit succeeds but the record is not ok", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      writeFileSync(join(cwd, "untracked-extra.txt"), "not part of the commit");
      const { status, out } = commit(cwd);
      expect(status, out).toBe(0);
      expect(existsSync(recordPath(cwd))).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(
        record.ok,
        `expected ok !== true with an untracked file present: ${JSON.stringify(record)}`,
      ).not.toBe(true);
    });

    it("P6: only .doug/anchor.md dirty-unstaged plus an untracked file under .doug/.state/ → record ok:true (exclusions honoured)", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      mkdirSync(join(cwd, ".doug"), { recursive: true });
      writeFileSync(join(cwd, ".doug/anchor.md"), "# anchor\n");
      git(cwd, ["add", "-A"]); // anchor.md is tracked from this first commit on
      const first = commit(cwd);
      expect(first.status, first.out).toBe(0);

      // Dirty anchor.md on disk, unstaged (no part of this next commit), and an untracked file under
      // .doug/.state/ that is not one of the hook's own logs — both must be excluded from the check.
      writeFileSync(join(cwd, ".doug/anchor.md"), "# anchor, changed after the commit\n");
      mkdirSync(join(cwd, ".doug/.state"), { recursive: true });
      writeFileSync(join(cwd, ".doug/.state/scratch.txt"), "not part of any commit");
      // A real, staged, matching-disk change to commit.
      writeFileSync(join(cwd, "notes.txt"), "x");
      git(cwd, ["add", "notes.txt"]);

      const second = commit(cwd);
      expect(second.status, second.out).toBe(0);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(
        record.ok,
        `expected ok:true with only excluded paths dirty/untracked: ${JSON.stringify(record)}`,
      ).toBe(true);
    });

    it("P7: `git commit -a`, everything tracked and nothing untracked, still records ok:true (the temp-index diff check must pass too, not just the tree)", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      const first = commit(cwd);
      expect(first.status, first.out).toBe(0);

      const original = readFileSync(join(cwd, "package.json"), "utf8");
      writeFileSync(join(cwd, "package.json"), original.replace("fixture", "fixture-v2"));
      const r = git(cwd, ["commit", "-a", "-q", "-m", "y"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(
        record.ok,
        `expected ok:true for a clean -a commit with nothing untracked: ${JSON.stringify(record)}`,
      ).toBe(true);
    });

    // Round 2 reviewer finding: an unquoted `for f in $combined` walk over the untracked-file list
    // glob-expands each entry against the working tree. An untracked file literally named
    // ".doug/anchor.m[d]" (bracket glob metacharacters) sits right next to the tracked, committed
    // ".doug/anchor.md" this fixture also has — "m[d]" is a valid glob matching "md", so the untracked
    // path's own name expands into the excluded ".doug/anchor.md" and is wrongly dropped from the check.
    // The exclusion list must compare literal names, never glob-match them.
    it("P8: an untracked file literally named \".doug/anchor.m[d]\" at commit time still leaves ok !== true", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      mkdirSync(join(cwd, ".doug"), { recursive: true });
      writeFileSync(join(cwd, ".doug/anchor.md"), "# anchor\n");
      git(cwd, ["add", "-A"]); // anchor.md tracked and committed below
      const first = commit(cwd);
      expect(first.status, first.out).toBe(0);

      writeFileSync(join(cwd, ".doug/anchor.m[d]"), "not the excluded path");
      writeFileSync(join(cwd, "notes.txt"), "x");
      git(cwd, ["add", "notes.txt"]);

      const second = commit(cwd);
      expect(second.status, second.out).toBe(0);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(
        record.ok,
        `expected ok !== true with an untracked ".doug/anchor.m[d]" present: ${JSON.stringify(record)}`,
      ).not.toBe(true);
    });

    // card ratchet-pre-commit-credit: each command's entry also carries `totals`, the parseTotals result
    // (lib/test-totals.mjs) of that step's output, so the Stop gate can run the count check on a credit.
    // Fixture fact for the coder: the hook runs in the temp repo's top level, which has no plugins/ tree, so
    // this test copies the real lib/test-totals.mjs to <repo>/plugins/doug-gates/lib/test-totals.mjs and
    // stages it (keeping the tree clean so ok stays true). The hook must import it from there (repo
    // top-level), as the lead's design says; it has no imports of its own.
    it("P9: the record's commands carry parseTotals results: test:unit {status:ok,summaries:[{4,1,0}],totals:{4,1,0}} from a vitest-shaped summary, typecheck {status:none}; the commit still succeeds", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      const libSrc = join(HOOKS_DIR, "..", "plugins/doug-gates/lib/test-totals.mjs");
      mkdirSync(join(cwd, "plugins/doug-gates/lib"), { recursive: true });
      writeFileSync(join(cwd, "plugins/doug-gates/lib/test-totals.mjs"), readFileSync(libSrc, "utf8"));
      writeFileSync(
        join(cwd, "test-unit.mjs"),
        `console.log("UNIT-MARKER");\nconsole.log(" Test Files  1 passed (1)");\nconsole.log("      Tests  3 passed | 1 skipped (4)");\nprocess.exit(0);\n`,
      );
      git(cwd, ["add", "-A"]);
      const { status, out } = commit(cwd);
      expect(status, out).toBe(0);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(record.version).toBe(1);
      expect(record.ok).toBe(true);
      const byName = Object.fromEntries(record.commands.map((c) => [c.name, c]));
      // ADR 0013: the recorded result carries the list of summaries too (a list of one here).
      expect(byName["test:unit"].totals, JSON.stringify(record)).toEqual({ status: "ok", summaries: [{ total: 4, skipped: 1, todo: 0 }], totals: { total: 4, skipped: 1, todo: 0 } });
      expect(byName["typecheck"].totals, JSON.stringify(record)).toEqual({ status: "none" });
    });

    // R1 (an old pin) is replaced for ADR 0013: two differing summaries are no longer a recorded "conflict";
    // the record carries parseTotals' list shape: {status:"ok", summaries:[...in output order], totals:<sum>}.
    it("R1: a test:unit that prints two different Tests summaries records {status:ok, summaries:[both, in order], totals:<sum>}; the commit still succeeds", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      mkdirSync(join(cwd, "plugins/doug-gates/lib"), { recursive: true });
      writeFileSync(join(cwd, "plugins/doug-gates/lib/test-totals.mjs"), readFileSync(join(HOOKS_DIR, "..", "plugins/doug-gates/lib/test-totals.mjs"), "utf8"));
      writeFileSync(
        join(cwd, "test-unit.mjs"),
        `console.log("      Tests  1 passed (1)");\nconsole.log("      Tests  3 passed | 1 skipped (4)");\nprocess.exit(0);\n`,
      );
      git(cwd, ["add", "-A"]);
      const { status, out } = commit(cwd);
      expect(status, out).toBe(0);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      const t = record.commands.find((c) => c.name === "test:unit").totals;
      expect(t, JSON.stringify(record)).toEqual({
        status: "ok",
        summaries: [{ total: 1, skipped: 0, todo: 0 }, { total: 4, skipped: 1, todo: 0 }],
        totals: { total: 5, skipped: 1, todo: 0 },
      });
    });

    it("R2: two byte-identical Tests summaries are recorded as two entries, not collapsed", () => {
      const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
      mkdirSync(join(cwd, "plugins/doug-gates/lib"), { recursive: true });
      writeFileSync(join(cwd, "plugins/doug-gates/lib/test-totals.mjs"), readFileSync(join(HOOKS_DIR, "..", "plugins/doug-gates/lib/test-totals.mjs"), "utf8"));
      writeFileSync(
        join(cwd, "test-unit.mjs"),
        `console.log("      Tests  3 passed (3)");\nconsole.log("      Tests  3 passed (3)");\nprocess.exit(0);\n`,
      );
      git(cwd, ["add", "-A"]);
      const { status, out } = commit(cwd);
      expect(status, out).toBe(0);
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      const t = record.commands.find((c) => c.name === "test:unit").totals;
      expect(t.summaries, JSON.stringify(record)).toHaveLength(2);
      expect(t.totals).toEqual({ total: 6, skipped: 0, todo: 0 });
    });
  });

  // S7 (card stop-gate-credits-pre-commit): stop-gate.mjs's vendored copy staying byte-identical to its
  // plugin source is already pinned generically by plugins/doug-gates/tests/vendored-copies.test.mjs
  // ("keeps .doug/hooks/scripts byte-identical to plugins/doug-gates/scripts, both files present on both
  // sides") — it walks every file under scripts/ and lib/ both ways, so it covers this card's edit (and any
  // new lib module the coder vendors) without a duplicate test here.
});

// card pre-commit-skip-no-test-paths: when every staged path is on preCommit.noTestPaths (.doug/config.json),
// the hook skips both commands, says so on one line, and leaves no passing record. Anything else runs the gate.
describe("no-test paths (card pre-commit-skip-no-test-paths)", () => {
  const recordPath = (cwd) => join(cwd, ".doug/.state/pre-commit/last-run.json");
  const SKIP_LINE = "pre-commit: gate skipped";

  // A fixture with one green baseline commit (config + board.json tracked), then a changed board.json staged
  // and nothing else. `config` is written as-is when it is a string, as JSON otherwise, and omitted for null.
  function boardRepo(config) {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    mkdirSync(join(cwd, ".doug"), { recursive: true });
    if (config !== null) {
      writeFileSync(join(cwd, ".doug/config.json"), typeof config === "string" ? config : JSON.stringify(config));
    }
    writeFileSync(join(cwd, ".doug/board.json"), '{"cards":[]}\n');
    git(cwd, ["add", "-A"]);
    const first = commit(cwd);
    expect(first.status, first.out).toBe(0);
    writeFileSync(join(cwd, ".doug/board.json"), '{"cards":["changed"]}\n');
    git(cwd, ["add", ".doug/board.json"]);
    return cwd;
  }
  const boardConfig = { preCommit: { noTestPaths: [".doug/board.json"] } };
  const ran = (out) => out.includes("TYPECHECK-MARKER") && out.includes("UNIT-MARKER");
  const headCount = (cwd) => git(cwd, ["rev-list", "--count", "HEAD"]).stdout.trim();

  it("S1: only the listed board.json staged -> commit succeeds, neither command runs, one skip line is printed", () => {
    const cwd = boardRepo(boardConfig);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(headCount(cwd)).toBe("2");
    expect(out).not.toContain("TYPECHECK-MARKER");
    expect(out).not.toContain("UNIT-MARKER");
    expect(out).toContain(SKIP_LINE);
    expect(out.split("\n").filter((l) => l.includes(SKIP_LINE))).toHaveLength(1);
  });

  it("S2: board.json plus another staged file -> both commands run, no skip line", () => {
    const cwd = boardRepo(boardConfig);
    writeFileSync(join(cwd, "other.txt"), "x");
    git(cwd, ["add", "other.txt"]);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  // git puts its own exec-path first on a hook's PATH, and on this machine that directory holds a real `git`,
  // so a plain PATH shim never reaches the hook (confirmed by experiment; diff.* config errors do not work
  // either, because `git commit` itself reads them and dies before the hook). Pointing GIT_EXEC_PATH at a
  // temp directory holding a `git` shim does: git puts that directory first on the hook's PATH. The shim
  // fails `diff --cached` and runs the real git for every other call.
  it("S3: `git diff --cached` failing inside the hook -> the full gate runs (fail closed), no skip line", () => {
    const cwd = boardRepo(boardConfig);
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: cleanEnv() }).stdout.trim();
    const shimDir = mkdtempSync(join(tmpdir(), "doug-githooks-shim-"));
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\n` +
        `case " $* " in *" diff --cached "*|*" diff "*" --cached "*) echo "SHIM: git diff --cached refused" >&2; exit 1 ;; esac\n` +
        `unset GIT_EXEC_PATH\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const r = git(cwd, ["commit", "-q", "-m", "x"], {
      GIT_DIR: join(cwd, ".git"),
      GIT_WORK_TREE: cwd,
      GIT_EXEC_PATH: shimDir,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(out, "the shim must be what the hook's `git diff --cached` ran").toContain("SHIM: git diff --cached refused");
    expect(r.status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("S4: a skipped commit writes no passing record and removes the stale one from the earlier green commit", () => {
    const cwd = boardRepo(boardConfig);
    const before = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
    expect(before.ok, "sanity: the baseline green commit left a passing record").toBe(true);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(out).toContain(SKIP_LINE);
    if (existsSync(recordPath(cwd))) {
      const record = JSON.parse(readFileSync(recordPath(cwd), "utf8"));
      expect(record.ok, `a skipped run must not leave a passing record: ${JSON.stringify(record)}`).not.toBe(true);
    }
  });

  it("S5a: an empty noTestPaths list with only board.json staged -> the gate runs", () => {
    const cwd = boardRepo({ preCommit: { noTestPaths: [] } });
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("S5b: `git commit --allow-empty` with the board config (nothing staged) -> the gate runs", () => {
    const cwd = boardRepo(boardConfig);
    git(cwd, ["reset", "-q"]); // nothing staged
    const r = git(cwd, ["commit", "-q", "--allow-empty", "-m", "e"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(headCount(cwd)).toBe("2");
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("S6a: no .doug/config.json, board.json staged -> the gate runs", () => {
    const cwd = boardRepo(null);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("S6b: a config without preCommit.noTestPaths (or with a non-array / unparseable one), board.json staged -> the gate runs", () => {
    for (const config of [{ stopGate: {} }, { preCommit: {} }, { preCommit: { noTestPaths: ".doug/board.json" } }, "{ not json"]) {
      const cwd = boardRepo(config);
      const { status, out } = commit(cwd);
      expect(status, out).toBe(0);
      expect(ran(out), `config ${JSON.stringify(config)}:\n${out}`).toBe(true);
      expect(out).not.toContain(SKIP_LINE);
    }
  });

  // Reviewer gaps: "any other staged path runs the full gate", fail closed.
  // Baseline: tracked files (plus .doug/config.json) committed green; the caller then stages its change.
  function baselineRepo(config, files) {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    mkdirSync(join(cwd, ".doug"), { recursive: true });
    writeFileSync(join(cwd, ".doug/config.json"), JSON.stringify(config));
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, f)), { recursive: true });
      writeFileSync(join(cwd, f), body);
    }
    git(cwd, ["add", "-A"]);
    const first = commit(cwd);
    expect(first.status, first.out).toBe(0);
    return cwd;
  }

  it("R1: a rename into a listed directory (docs/) -> the gate runs, because the rename's source path counts as staged", () => {
    const cwd = baselineRepo({ preCommit: { noTestPaths: ["docs/"] } }, { "src/x.txt": "x\n" });
    mkdirSync(join(cwd, "docs"), { recursive: true });
    expect(git(cwd, ["mv", "src/x.txt", "docs/x.txt"]).status).toBe(0);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("R2: `git commit -a` with board.json and another tracked file modified, nothing staged -> the gate runs", () => {
    const cwd = baselineRepo(boardConfig, { ".doug/board.json": "{}\n", "other.txt": "a\n" });
    // board.json is staged in the real index; other.txt is modified but unstaged. `commit -a` commits both
    // through a temporary index, so a hook that reads the real index (after git's GIT_INDEX_FILE is gone)
    // would see only board.json and wrongly skip.
    writeFileSync(join(cwd, ".doug/board.json"), '{"changed":1}\n');
    git(cwd, ["add", ".doug/board.json"]);
    writeFileSync(join(cwd, "other.txt"), "b\n");
    const r = git(cwd, ["commit", "-a", "-q", "-m", "y"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("R3: only .doug/board.json.bak staged with [\".doug/board.json\"] listed -> the gate runs (no trailing slash means exact match only)", () => {
    const cwd = baselineRepo(boardConfig, { ".doug/board.json": "{}\n" });
    writeFileSync(join(cwd, ".doug/board.json.bak"), "{}\n");
    git(cwd, ["add", ".doug/board.json.bak"]);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("R4: an unstaged edit adding \"src/\" to the working-tree config is not a switch -> only src/a.txt staged still runs the gate", () => {
    const cwd = baselineRepo(boardConfig, { "src/a.txt": "a\n" });
    writeFileSync(join(cwd, ".doug/config.json"), JSON.stringify({ preCommit: { noTestPaths: [".doug/board.json", "src/"] } }));
    writeFileSync(join(cwd, "src/a.txt"), "b\n");
    git(cwd, ["add", "src/a.txt"]); // config.json stays modified and unstaged
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(ran(out), out).toBe(true);
    expect(out).not.toContain(SKIP_LINE);
  });
});

// card verified-tree-record (brief A): the hook always runs both commands, and writes
// .doug/.state/verified-tree.json (the tree of the WORKING tree it verified) after a green run.
describe("verified-tree record (card verified-tree-record)", () => {
  const recPath = (cwd) => join(cwd, ".doug/.state/verified-tree.json");
  const lib = () => import("../lib/verified-tree.mjs");
  const CMDS = ["pnpm typecheck", "pnpm test:unit"];
  const record = (tree, over = {}) => ({
    version: 1,
    tree,
    node: process.version,
    at: "2000-01-01T00:00:00.000Z",
    by: "verify",
    commands: [
      { name: "typecheck", command: CMDS[0], exit: 0, durationMs: 1 },
      { name: "test:unit", command: CMDS[1], exit: 0, durationMs: 1 },
    ],
    totals: {},
    ...over,
  });

  it("G-a: a matching record does not skip the hook: both commands still run; a failing one still refuses", async () => {
    const { computeTree, writeRecord } = await lib();
    const green = makeRepo({ typecheckExit: 0, unitExit: 0 });
    writeRecord(green, record(computeTree(green)));
    const ok = commit(green);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain("TYPECHECK-MARKER");
    expect(ok.out).toContain("UNIT-MARKER");

    const red = makeRepo({ typecheckExit: 0, unitExit: 1 });
    writeRecord(red, record(computeTree(red)));
    const bad = commit(red);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("UNIT-MARKER");
    expect(bad.out).toContain("pre-commit: pnpm test:unit failed; commit refused");
    expect(git(red, ["rev-parse", "HEAD"]).status).not.toBe(0);
  });

  it("G-b: a green commit writes verified-tree.json for the working tree, by pre-commit", async () => {
    const { computeTree, readRecord } = await lib();
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(existsSync(recPath(cwd)), `expected ${recPath(cwd)} after a green commit`).toBe(true);
    const rec = readRecord(cwd);
    expect(rec, "the record must pass readRecord's shape check").not.toBeNull();
    expect(rec.by).toBe("pre-commit");
    expect(rec.tree).toBe(computeTree(cwd));
    expect(rec.node).toMatch(/^v\d+/);
    expect(rec.node).toBe(process.version);
    expect(rec.commands.map((c) => [c.name, c.command, c.exit])).toEqual([
      ["typecheck", "pnpm typecheck", 0],
      ["test:unit", "pnpm test:unit", 0],
    ]);
    for (const c of rec.commands) expect(Number.isFinite(c.durationMs)).toBe(true);
  });

  // Mg: the `record` step re-computes the tree after the commands; a command that wrote into the tree means
  // the record would describe a tree the commands did not run on.
  it("G-e: a step that changes the working tree leaves no record (commit result unchanged)", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    writeFileSync(
      join(cwd, "test-unit.mjs"),
      `import { writeFileSync } from "node:fs";\nconsole.log("UNIT-MARKER");\nwriteFileSync("side-effect.txt", "written by the unit step\\n");\nprocess.exit(0);\n`,
    );
    git(cwd, ["add", "-A"]);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(out).toContain("UNIT-MARKER");
    expect(existsSync(join(cwd, "side-effect.txt"))).toBe(true);
    expect(existsSync(recPath(cwd)), "the tree changed during the run: no record").toBe(false);
  });

  it("G-c: a red commit (typecheck or unit) removes an existing record", async () => {
    const { computeTree, writeRecord } = await lib();
    for (const exits of [{ typecheckExit: 1, unitExit: 0 }, { typecheckExit: 0, unitExit: 1 }]) {
      const cwd = makeRepo(exits);
      writeRecord(cwd, record(computeTree(cwd)));
      expect(existsSync(recPath(cwd))).toBe(true);
      const { status } = commit(cwd);
      expect(status).not.toBe(0);
      expect(existsSync(recPath(cwd)), `record must be removed after ${JSON.stringify(exits)}`).toBe(false);
    }
  });

  it("G-d: a noTestPaths skip leaves an existing record byte-identical", async () => {
    const { computeTree, writeRecord } = await lib();
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    mkdirSync(join(cwd, ".doug"), { recursive: true });
    writeFileSync(join(cwd, ".doug/config.json"), JSON.stringify({ preCommit: { noTestPaths: [".doug/board.json"] } }));
    writeFileSync(join(cwd, ".doug/board.json"), '{"cards":[]}\n');
    git(cwd, ["add", "-A"]);
    const first = commit(cwd);
    expect(first.status, first.out).toBe(0);
    writeRecord(cwd, record(computeTree(cwd)));
    const before = readFileSync(recPath(cwd));
    writeFileSync(join(cwd, ".doug/board.json"), '{"cards":["changed"]}\n');
    git(cwd, ["add", ".doug/board.json"]);
    const { status, out } = commit(cwd);
    expect(status, out).toBe(0);
    expect(out).toContain("pre-commit: gate skipped");
    expect(out).not.toContain("TYPECHECK-MARKER");
    expect(existsSync(recPath(cwd))).toBe(true);
    expect(readFileSync(recPath(cwd)).equals(before)).toBe(true);
  });
});

// card gate-docs-skip-unless-named: a staged docs/**/*.md file does not by itself run the suite. When every
// staged path is on preCommit.noTestPaths or is a docs .md, the hook looks for tracked test files that name
// each doc (its repo-relative path, or its basename): none -> skip like a no-test path; some -> run only
// `pnpm test:unit <those files>` (sorted, no typecheck, never credited as a full run). Any other path, a dirty
// working tree, or any doubt runs the full gate.
describe("docs named by tests (card gate-docs-skip-unless-named)", () => {
  const recPath = (cwd) => join(cwd, ".doug/.state/verified-tree.json");
  const lastRun = (cwd) => join(cwd, ".doug/.state/pre-commit/last-run.json");
  const argvLog = (cwd) => join(cwd, ".doug/.state/unit-argv.log");
  const SKIP_LINE = "pre-commit: gate skipped";
  const ADR = "docs/decisions/0005-two-tracks.md";
  const UNNAMED = "docs/decisions/0099-unnamed.md";
  const NAMER = "plugins/doug-flow/tests/naming-a.test.mjs";
  const OTHER = "plugins/doug-flow/tests/other.test.mjs";
  const LITERAL = `const p = join(root, "..", "..", "docs/decisions/0005-two-tracks.md");\n`;
  const SEGMENTS = `const p = join(root, "docs", "decisions", "0005-two-tracks.md");\n`;
  const CONFIG = { preCommit: { noTestPaths: [".doug/board.json", "docs/live-runs.md"] } };

  const readArgv = (cwd) =>
    existsSync(argvLog(cwd)) ? readFileSync(argvLog(cwd), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const typechecked = (out) => out.includes("TYPECHECK-MARKER");

  // A green baseline commit holding the docs, the given test files and extra files; the argv log of that
  // baseline's own full run is removed so the case's run is the only entry. targetedExit is the trivial
  // test:unit script's exit when it was given file arguments (the full run always exits 0).
  async function docsRepo({ tests = { [NAMER]: LITERAL, [OTHER]: "it('x');\n" }, extra = {}, config = CONFIG, targetedExit = 0, prepare = null } = {}) {
    const cwd = await makeRepoA({ typecheckExit: 0, unitExit: 0 });
    writeFileSync(
      join(cwd, "test-unit.mjs"),
      `import { appendFileSync, mkdirSync } from "node:fs";\n` +
        `const a = process.argv.slice(2);\n` +
        `mkdirSync(".doug/.state", { recursive: true });\n` +
        `appendFileSync(".doug/.state/unit-argv.log", JSON.stringify(a) + "\\n");\n` +
        `console.log("UNIT-MARKER");\n` +
        `process.exit(a.length ? ${targetedExit} : 0);\n`,
    );
    const files = {
      ".doug/config.json": JSON.stringify(config),
      ".doug/board.json": "{}\n",
      [ADR]: "v1\n",
      [UNNAMED]: "v1\n",
      "docs/data.json": "{}\n",
      "src/x.mjs": "export const x = 1;\n",
      "src/z.txt": "z\n",
      ...tests,
      ...extra,
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, f)), { recursive: true });
      writeFileSync(join(cwd, f), body);
    }
    if (prepare) prepare(cwd);
    await gitA(cwd, ["add", "-A"]);
    const first = await commitA(cwd);
    expect(first.status, first.out).toBe(0);
    rmSync(argvLog(cwd), { force: true });
    return cwd;
  }
  const stage = async (cwd, f, body = "v2\n") => {
    mkdirSync(dirname(join(cwd, f)), { recursive: true });
    writeFileSync(join(cwd, f), body);
    await gitA(cwd, ["add", f]);
  };
  const headCount = async (cwd) => (await gitA(cwd, ["rev-list", "--count", "HEAD"])).stdout.trim();
  const expectFull = (cwd, { status, out }) => {
    expect(status, out).toBe(0);
    expect(out, "the full gate runs typecheck").toContain("TYPECHECK-MARKER");
    expect(out).toContain("UNIT-MARKER");
    expect(out).not.toContain(SKIP_LINE);
    expect(readArgv(cwd), "the full run passes test:unit no file arguments").toEqual([[]]);
  };

  it("D1 (a): an ADR no test names, alone staged -> skipped like a no-test path: exit 0, neither command runs, one skip line naming docs, last-run.json gone", async () => {
    const cwd = await docsRepo();
    expect(existsSync(lastRun(cwd)), "fixture: the baseline left a record").toBe(true);
    await stage(cwd, UNNAMED);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(await headCount(cwd)).toBe("2");
    expect(typechecked(out)).toBe(false);
    expect(out).not.toContain("UNIT-MARKER");
    expect(readArgv(cwd), "test:unit must not run at all").toEqual([]);
    const lines = out.split("\n").filter((l) => l.includes(SKIP_LINE));
    expect(lines, out).toHaveLength(1);
    expect(lines[0], "the skip line names docs").toMatch(/docs/);
    expect(existsSync(lastRun(cwd)), "a skip must remove the stale pass record").toBe(false);
  });

  it("D2 (a): an unnamed ADR plus a listed board.json staged -> skipped", async () => {
    const cwd = await docsRepo();
    await stage(cwd, UNNAMED);
    await stage(cwd, ".doug/board.json", '{"cards":[1]}\n');
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(out).toContain(SKIP_LINE);
    expect(typechecked(out)).toBe(false);
    expect(readArgv(cwd)).toEqual([]);
  });

  it("D3 (b): 0005-two-tracks.md named by one test file (full literal path) -> only `pnpm test:unit <that file>` runs, no typecheck", async () => {
    const cwd = await docsRepo();
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(await headCount(cwd)).toBe("2");
    expect(readArgv(cwd), "exactly one targeted run with exactly the naming test file").toEqual([[NAMER]]);
    expect(typechecked(out), "typecheck is not run on a targeted run").toBe(false);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("D4 (b): a targeted green run is never credited as a full run: last-run.json is not a pass and the verified-tree record is untouched", async () => {
    const cwd = await docsRepo();
    const before = readFileSync(recPath(cwd));
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(readArgv(cwd), "fixture: the targeted run must have happened").toEqual([[NAMER]]);
    if (existsSync(lastRun(cwd))) {
      const rec = JSON.parse(readFileSync(lastRun(cwd), "utf8"));
      expect(rec.ok, `a targeted run must not leave a passing record: ${JSON.stringify(rec)}`).not.toBe(true);
    }
    const after = existsSync(recPath(cwd)) ? readFileSync(recPath(cwd)) : null;
    expect(after === null || after.equals(before), "a targeted run writes no verified-tree record for the new tree").toBe(true);
  });

  it("D5 (b): several naming test files (.mjs .ts .js .cjs), found by path or basename -> one run with all of them, repo-relative and sorted", async () => {
    const names = {
      "plugins/zeta/tests/z.test.mjs": LITERAL,
      "packages/doug-cli/tests/b.test.ts": SEGMENTS,
      "evals/tests/c.test.js": LITERAL,
      "tests/a.test.cjs": SEGMENTS,
      [OTHER]: "it('x');\n",
    };
    const cwd = await docsRepo({ tests: names });
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    const expected = Object.keys(names).filter((f) => f !== OTHER).sort();
    expect(readArgv(cwd)).toEqual([expected]);
  });

  it("D6 (b): two docs staged, only one named -> the run covers the named doc's tests", async () => {
    const cwd = await docsRepo();
    await stage(cwd, ADR);
    await stage(cwd, UNNAMED);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(readArgv(cwd)).toEqual([[NAMER]]);
    expect(typechecked(out)).toBe(false);
  });

  it("D7 (c): a test naming the doc only by join(\"docs\", \"decisions\", \"<basename>\") segments is found by the basename", async () => {
    const cwd = await docsRepo({ tests: { [NAMER]: SEGMENTS, [OTHER]: "it('x');\n" } });
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(readArgv(cwd)).toEqual([[NAMER]]);
    expect(typechecked(out)).toBe(false);
  });

  it("D8 (d): a docs .md plus a code path staged -> the full gate (both commands, no file arguments)", async () => {
    const cwd = await docsRepo();
    await stage(cwd, UNNAMED);
    await stage(cwd, "src/x.mjs", "export const x = 2;\n");
    expectFull(cwd, await commitA(cwd));
  });

  it("D9 (d): a docs .md named by a test plus a code path staged -> the full gate, not a targeted run", async () => {
    const cwd = await docsRepo();
    await stage(cwd, ADR);
    await stage(cwd, "src/x.mjs", "export const x = 2;\n");
    expectFull(cwd, await commitA(cwd));
  });

  it("D10 (e): the targeted run exits non-zero -> the commit is refused, no typecheck, no new commit", async () => {
    const cwd = await docsRepo({ targetedExit: 1 });
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(readArgv(cwd), "fixture: the targeted run must have happened").toEqual([[NAMER]]);
    expect(status, out).not.toBe(0);
    expect(out).toContain("commit refused");
    expect(out).toContain("UNIT-MARKER");
    expect(typechecked(out)).toBe(false);
    expect(await headCount(cwd)).toBe("1");
    if (existsSync(lastRun(cwd))) expect(JSON.parse(readFileSync(lastRun(cwd), "utf8")).ok).not.toBe(true);
  });

  it("D11 (f): a non-test helper under a tests/ directory naming the doc cannot be mapped to test files -> the full gate", async () => {
    const cwd = await docsRepo({ tests: { [OTHER]: "it('x');\n" }, extra: { "plugins/doug-flow/tests/helpers.mjs": LITERAL } });
    await stage(cwd, ADR);
    expectFull(cwd, await commitA(cwd));
  });

  it("D12 (f): a code file outside tests/ that names the doc (it reads the doc at runtime) -> the full gate", async () => {
    const cwd = await docsRepo({ tests: { [OTHER]: "it('x');\n" }, extra: { "packages/doug-codex/src/contract.ts": LITERAL } });
    await stage(cwd, ADR);
    expectFull(cwd, await commitA(cwd));
  });

  it("D13 (g): a non-.md file under docs/ staged -> the full gate", async () => {
    const cwd = await docsRepo();
    await stage(cwd, "docs/data.json", '{"v":2}\n');
    expectFull(cwd, await commitA(cwd));
  });

  it("D14: a docs file that is not .md-named at the end (docs/notes.md.bak) -> the full gate", async () => {
    const cwd = await docsRepo({ extra: { "docs/notes.md.bak": "v1\n" } });
    await stage(cwd, "docs/notes.md.bak");
    expectFull(cwd, await commitA(cwd));
  });

  it("D15: a code file renamed into docs/ as .md -> the rename's source path counts: the full gate", async () => {
    const cwd = await docsRepo();
    mkdirSync(join(cwd, "docs/decisions"), { recursive: true });
    expect((await gitA(cwd, ["mv", "src/x.mjs", "docs/decisions/moved.md"])).status).toBe(0);
    expectFull(cwd, await commitA(cwd));
  });

  it("D16 (dirty): a staged unnamed ADR with an unstaged edit to a tracked file -> the working tree differs from the index: the full gate", async () => {
    const cwd = await docsRepo();
    await stage(cwd, UNNAMED);
    writeFileSync(join(cwd, "src/z.txt"), "unstaged edit\n");
    expectFull(cwd, await commitA(cwd));
  });

  it("D17 (dirty): a staged named ADR with an untracked file in the working tree -> the full gate, not a targeted run", async () => {
    const cwd = await docsRepo();
    await stage(cwd, ADR);
    writeFileSync(join(cwd, "untracked.txt"), "x\n");
    expectFull(cwd, await commitA(cwd));
  });

  it("D18: an empty noTestPaths list (or none) -> a docs-only change runs the full gate (fail closed on the config)", async () => {
    for (const config of [{ preCommit: { noTestPaths: [] } }, { stopGate: {} }]) {
      const cwd = await docsRepo({ config });
      await stage(cwd, UNNAMED);
      expectFull(cwd, await commitA(cwd));
    }
  });

  // preCommit.docsTests (user decision 2026-10-08): test files that read every doc generically and name none.
  const DOCS_TEST = "tests/all-docs.test.mjs";
  const docsCfg = (docsTests) => ({ preCommit: { ...CONFIG.preCommit, docsTests } });

  it("D19 (h): an unnamed ADR with preCommit.docsTests naming a tracked file -> a targeted run of exactly that file, never a skip", async () => {
    const cwd = await docsRepo({ config: docsCfg([DOCS_TEST]), extra: { [DOCS_TEST]: "it('x');\n" } });
    await stage(cwd, UNNAMED);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(readArgv(cwd)).toEqual([[DOCS_TEST]]);
    expect(typechecked(out)).toBe(false);
    expect(out).not.toContain(SKIP_LINE);
  });

  it("D20 (i): a named ADR plus docsTests -> one run of the sorted, de-duplicated union", async () => {
    const cwd = await docsRepo({ config: docsCfg([DOCS_TEST, NAMER]), extra: { [DOCS_TEST]: "it('x');\n" } });
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(readArgv(cwd)).toEqual([[NAMER, DOCS_TEST].sort()]);
    expect(typechecked(out)).toBe(false);
  });

  it("D21 (j): docsTests naming a file that is not tracked (missing, or a directory) -> the full gate", async () => {
    for (const entry of ["tests/missing.test.mjs", "tests"]) {
      const cwd = await docsRepo({ config: docsCfg([entry]), extra: { [DOCS_TEST]: "it('x');\n" } });
      await stage(cwd, UNNAMED);
      expectFull(cwd, await commitA(cwd));
    }
  });

  it("D22 (k): docsTests malformed (a string, an empty entry, a non-string entry) -> the full gate", async () => {
    for (const bad of [DOCS_TEST, [""], [5], [DOCS_TEST, ""], { a: DOCS_TEST }]) {
      const cwd = await docsRepo({ config: docsCfg(bad), extra: { [DOCS_TEST]: "it('x');\n" } });
      await stage(cwd, UNNAMED);
      expectFull(cwd, await commitA(cwd));
    }
  });

  it("D27 (m-a): a tracked docsTests entry whose path holds a space -> the full gate (the safe-path check covers the docsTests entries too)", async () => {
    const spaced = "tests/has space.test.mjs";
    const cwd = await docsRepo({ config: docsCfg([spaced]), extra: { [spaced]: "it('x');\n" } });
    await stage(cwd, UNNAMED);
    expectFull(cwd, await commitA(cwd));
  });

  it("D23 (absent/empty): docsTests absent or [] -> behaviour as before: an unnamed ADR skips", async () => {
    for (const docsTests of [undefined, []]) {
      const cwd = await docsRepo({ config: docsCfg(docsTests), extra: { [DOCS_TEST]: "it('x');\n" } });
      await stage(cwd, UNNAMED);
      const { status, out } = await commitA(cwd);
      expect(status, out).toBe(0);
      expect(out).toContain(SKIP_LINE);
      expect(readArgv(cwd)).toEqual([]);
    }
  });

  it("D24 (O1/O6): the test tree cannot be read (a tracked *.test.mjs that is a symlink to a directory -> EISDIR) -> the full gate, never a skip", async () => {
    const cwd = await docsRepo({ prepare: (d) => symlinkSync("src", join(d, "tests-dirlink.test.mjs")) });
    await stage(cwd, UNNAMED);
    expectFull(cwd, await commitA(cwd));
  });

  it("D25 (O2): a naming test file whose path holds shell-unsafe characters (a space, a $) -> the full gate", async () => {
    for (const unsafe of ["plugins/doug-flow/tests/has space.test.mjs", "tests/a$b.test.mjs"]) {
      const cwd = await docsRepo({ tests: { [unsafe]: LITERAL, [OTHER]: "it('x');\n" } });
      await stage(cwd, ADR);
      expectFull(cwd, await commitA(cwd));
    }
  });

  it("D26 (O7): a non-code file under tests/ (tests/fixtures/x.json) naming the doc cannot be mapped to test files -> the full gate", async () => {
    for (const f of ["tests/fixtures/x.json", "plugins/doug-flow/tests/fixtures/x.json"]) {
      const cwd = await docsRepo({ tests: { [OTHER]: "it('x');\n" }, extra: { [f]: LITERAL } });
      await stage(cwd, ADR);
      expectFull(cwd, await commitA(cwd));
    }
  });
});

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
