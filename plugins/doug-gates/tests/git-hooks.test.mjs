import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync, readdirSync } from "node:fs";
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
    it("P9: the record's commands carry parseTotals results: test:unit {status:ok,totals:{4,1,0}} from a vitest-shaped summary, typecheck {status:none}; the commit still succeeds", () => {
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
      expect(byName["test:unit"].totals, JSON.stringify(record)).toEqual({ status: "ok", totals: { total: 4, skipped: 1, todo: 0 } });
      expect(byName["typecheck"].totals, JSON.stringify(record)).toEqual({ status: "none" });
    });

    it("R1: a test:unit that prints two different Tests summaries records totals {status:conflict, summaries}; the commit still succeeds", () => {
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
      expect(t, JSON.stringify(record)).toMatchObject({ status: "conflict" });
      expect(Array.isArray(t.summaries) && t.summaries.length).toBeGreaterThanOrEqual(2);
      expect(t.summaries).toContainEqual({ total: 1, skipped: 0, todo: 0 });
      expect(t.summaries).toContainEqual({ total: 4, skipped: 1, todo: 0 });
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
