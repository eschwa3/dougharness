import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync, readdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { HOOKS_DIR, cleanEnv, git, makeRepo, commit, commitA, extractLogPath } from "./git-hooks-fixtures.mjs";

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

  // card remove-pre-commit-credit: the hook writes no pre-commit run record of its own, so a green commit leaves
  // nothing at all under .doug/.state/pre-commit (the verified-tree record lives one level up).
  it("G3: on a green commit, nothing is left under .doug/.state/pre-commit", () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    const { status } = commit(cwd);
    expect(status).toBe(0);
    const dir = join(cwd, ".doug/.state/pre-commit");
    const remaining = existsSync(dir) ? readdirSync(dir) : [];
    expect(remaining, `expected nothing left under .doug/.state/pre-commit, found: ${remaining.join(", ")}`).toEqual([]);
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

  // card remove-pre-commit-credit: the parsed test totals reach .doug/.state/verified-tree.json (the only
  // record the hook writes), keyed by command; only status "ok" totals are stored there.
  describe("hook totals reach the verified-tree record (card remove-pre-commit-credit)", () => {
    const vtPath = (cwd) => join(cwd, ".doug/.state/verified-tree.json");
    const readVt = (cwd) => JSON.parse(readFileSync(vtPath(cwd), "utf8"));

    // card ratchet-pre-commit-credit: each command's entry also carries `totals`, the parseTotals result
    // (lib/test-totals.mjs) of that step's output, so the Stop gate can run the count check on a credit.
    // Fixture fact for the coder: the hook runs in the temp repo's top level, which has no plugins/ tree, so
    // this test copies the real lib/test-totals.mjs to <repo>/plugins/doug-gates/lib/test-totals.mjs and
    // stages it (the hook runs with the lib present at the repo top level). The hook must import it from there (repo
    // top-level), as the lead's design says; it has no imports of its own.
    it("P9: the verified-tree record's totals carry the test:unit parseTotals result {status:ok,summaries:[{4,1,0}],totals:{4,1,0}} from a vitest-shaped summary; typecheck's {status:none} is not stored; the commit still succeeds", () => {
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
      const record = readVt(cwd);
      expect(record.version).toBe(1);
      expect(record.by).toBe("pre-commit");
      // ADR 0013: the recorded result carries the list of summaries too (a list of one here).
      expect(record.totals["pnpm test:unit"], JSON.stringify(record)).toEqual({ status: "ok", summaries: [{ total: 4, skipped: 1, todo: 0 }], totals: { total: 4, skipped: 1, todo: 0 } });
      expect(record.totals["pnpm typecheck"], JSON.stringify(record)).toBeUndefined();
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
      const record = readVt(cwd);
      const t = record.totals["pnpm test:unit"];
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
      const record = readVt(cwd);
      const t = record.totals["pnpm test:unit"];
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

// card gate-load-timeouts: the pre-commit suites go through the shared gate.lock (ledger blocks 422, 432 and 435: a
// commit's full suite ran with no lock next to a gate's). Each case runs the real hook in a temp repo whose lock
// lives at <repo>/.git/doug/gate.lock, never this repository's.
describe("pre-commit takes gate.lock around each step (card gate-load-timeouts)", () => {
  const lockOf = (cwd) => join(cwd, ".git/doug/gate.lock");
  const seenOf = (cwd) => join(cwd, ".doug/.state/lock-seen.json");
  const startOf = (cwd) => join(cwd, ".doug/.state/unit-start.txt");

  // test-unit.mjs logs its start time and copies whatever gate.lock looks like while it runs.
  function logUnit(cwd, config) {
    mkdirSync(join(cwd, ".doug/.state"), { recursive: true });
    writeFileSync(
      join(cwd, "test-unit.mjs"),
      [
        'import { copyFileSync, writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(startOf(cwd))}, String(Date.now()));`,
        `try { copyFileSync(${JSON.stringify(lockOf(cwd))}, ${JSON.stringify(seenOf(cwd))}); } catch {}`,
        'console.log("UNIT-MARKER");',
        "",
      ].join("\n"),
    );
    if (config) {
      mkdirSync(join(cwd, ".doug"), { recursive: true });
      writeFileSync(join(cwd, ".doug/config.json"), JSON.stringify(config));
    }
    git(cwd, ["add", "-A"]);
  }
  const put = (cwd, pid) => {
    mkdirSync(dirname(lockOf(cwd)), { recursive: true });
    writeFileSync(lockOf(cwd), JSON.stringify({ pid, session: "fake-holder", at: Date.now() }));
  };
  const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 90000)"], { stdio: "ignore" });

  it("PL1: a commit waits for a live holder to release gate.lock, then runs its suite, holds the lock itself and frees it", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    logUnit(cwd);
    const releaseFile = join(cwd, ".doug/.state/release.txt");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `setTimeout(() => { const fs = require("fs"); fs.writeFileSync(${JSON.stringify(releaseFile)}, String(Date.now())); try { fs.unlinkSync(${JSON.stringify(lockOf(cwd))}); } catch {} }, 2500); setTimeout(() => {}, 20000);`,
      ],
      { stdio: "ignore" },
    );
    try {
      put(cwd, holder.pid);
      const { status, out } = await commitA(cwd);
      expect(status, out).toBe(0);
      expect(existsSync(releaseFile), "the holder must have released while the hook waited").toBe(true);
      const released = Number(readFileSync(releaseFile, "utf8"));
      const started = Number(readFileSync(startOf(cwd), "utf8"));
      expect(started, "the suite must not start before the holder released the lock").toBeGreaterThanOrEqual(released);
      const seen = JSON.parse(readFileSync(seenOf(cwd), "utf8"));
      expect(seen.pid, "while the suite ran, the lock names the hook's runner, not the old holder").not.toBe(holder.pid);
      expect(existsSync(lockOf(cwd)), "the runner releases the lock after its command").toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("PL2: with no holder, the suite runs under a lock that is gone again afterwards", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    logUnit(cwd);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(existsSync(seenOf(cwd)), "gate.lock must exist while the suite runs").toBe(true);
    expect(JSON.parse(readFileSync(seenOf(cwd), "utf8")).pid).toBeGreaterThan(0);
    expect(existsSync(lockOf(cwd)), "no lock left behind after a green commit").toBe(false);
  });

  it("PL3: a failing suite still refuses the commit and still releases the lock", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 1 });
    const { status, out } = await commitA(cwd);
    expect(status).not.toBe(0);
    expect(out).toContain("UNIT-MARKER");
    expect(existsSync(lockOf(cwd)), "a red step frees the lock too").toBe(false);
  });

  it("PL4: a live holder that never releases is waited for only up to stopGate.timeoutMs, then the commit runs anyway", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    logUnit(cwd, { stopGate: { commands: ["test:unit"], timeoutMs: 1000 } });
    const holder = sleeper();
    try {
      put(cwd, holder.pid);
      const t0 = Date.now();
      const { status, out } = await commitA(cwd);
      const elapsed = Date.now() - t0;
      expect(status, out).toBe(0);
      expect(out).toContain("UNIT-MARKER");
      expect(elapsed, "the live lock must actually be waited for").toBeGreaterThanOrEqual(900);
      expect(elapsed, "the wait is bounded, never a hang").toBeLessThan(15_000);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("PL5: a lock naming a dead pid is taken at once, not waited out", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    logUnit(cwd, { stopGate: { commands: ["test:unit"], timeoutMs: 15000 } });
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const deadPid = (() => {
      const c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
      return c.pid;
    })();
    await new Promise((r) => setTimeout(r, 500)); // let it exit
    expect(dead.status).toBe(0);
    put(cwd, deadPid);
    const t0 = Date.now();
    const { status, out } = await commitA(cwd);
    const elapsed = Date.now() - t0;
    expect(status, out).toBe(0);
    expect(elapsed, "a dead holder must not be waited on").toBeLessThan(8000);
    const seen = JSON.parse(readFileSync(seenOf(cwd), "utf8"));
    expect(seen.pid, "the runner replaced the stale lock with its own").not.toBe(deadPid);
    expect(existsSync(lockOf(cwd))).toBe(false);
  });
  // Card gate-lock-takeover-exclusive (F2): one lock for the whole hook, so the steps share one holder and one wait.
  function logBoth(cwd, config) {
    mkdirSync(join(cwd, ".doug/.state"), { recursive: true });
    for (const [file, marker, seen] of [
      ["typecheck.mjs", "TYPECHECK-MARKER", "seen-typecheck.json"],
      ["test-unit.mjs", "UNIT-MARKER", "seen-unit.json"],
    ]) {
      writeFileSync(
        join(cwd, file),
        [
          'import { copyFileSync } from "node:fs";',
          `try { copyFileSync(${JSON.stringify(lockOf(cwd))}, ${JSON.stringify(join(cwd, ".doug/.state", seen))}); } catch {}`,
          `console.log(${JSON.stringify(marker)});`,
          "",
        ].join("\n"),
      );
    }
    if (config) writeFileSync(join(cwd, ".doug/config.json"), JSON.stringify(config));
    git(cwd, ["add", "-A"]);
  }

  it("PL6: typecheck and test:unit run under one lock held by one process for the whole hook, gone after the commit", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    logBoth(cwd);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    const a = join(cwd, ".doug/.state/seen-typecheck.json");
    const b = join(cwd, ".doug/.state/seen-unit.json");
    expect(existsSync(a), "gate.lock must exist while typecheck runs").toBe(true);
    expect(existsSync(b), "gate.lock must exist while test:unit runs").toBe(true);
    const pa = JSON.parse(readFileSync(a, "utf8")).pid;
    const pb = JSON.parse(readFileSync(b, "utf8")).pid;
    expect(pa).toBeGreaterThan(0);
    expect(pb, "both steps see the same holder: the lock is taken once for the whole hook").toBe(pa);
    expect(existsSync(lockOf(cwd)), "no lock left behind after a green commit").toBe(false);
  });

  it("PL7: a live holder that never releases is waited on once for the whole hook, not once per step", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    logBoth(cwd, { stopGate: { commands: ["test:unit"], timeoutMs: 1000 } });
    const holder = sleeper();
    try {
      put(cwd, holder.pid);
      const { status, out } = await commitA(cwd);
      expect(status, out).toBe(0);
      expect(out).toContain("TYPECHECK-MARKER");
      expect(out).toContain("UNIT-MARKER");
      const warnings = out.match(/gate\.lock still held/g) ?? [];
      expect(warnings.length, `the give-up warning must print once for the whole hook:\n${out}`).toBe(1);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  // Card gate-lock-takeover-exclusive (F3): a missing lock runner refuses the commit naming the runner.
  it("PL8: a missing gate-lock runner refuses the commit with a line naming the runner, not the step", async () => {
    const cwd = makeRepo({ typecheckExit: 0, unitExit: 0 });
    const hooks = join(mkdtempSync(join(tmpdir(), "doug-githooks-nolock-")), ".githooks");
    mkdirSync(hooks, { recursive: true });
    copyFileSync(join(HOOKS_DIR, "pre-commit"), join(hooks, "pre-commit"));
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(cwd, ["config", "core.hooksPath", hooks]);
    const { status, out } = await commitA(cwd);
    expect(status, out).not.toBe(0);
    expect(out, "the hook's own refusal line must name the lock runner").toMatch(/^pre-commit: .*gate-lock\.mjs.*commit refused/m);
    expect(out).not.toMatch(/pnpm typecheck failed/);
  });
});
