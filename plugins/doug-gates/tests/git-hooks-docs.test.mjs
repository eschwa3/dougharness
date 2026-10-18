// Split from git-hooks.test.mjs (card split-git-hooks-rehearse-tests) to balance runtime: the docs-named-by-tests rule.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { commit, gitA, commitA, makeRepoA } from "./git-hooks-fixtures.mjs";

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

  // card docs-gate-comment-mentions: in a code file outside tests/ a doc counts as named only by its full repo-relative path.
  const COMMENT = `// a note about 0005-two-tracks.md\n`;

  it("D28 (comment): a basename-only mention in a code file outside tests/ and no test naming the doc -> skipped", async () => {
    const cwd = await docsRepo({ tests: { [OTHER]: "it('x');\n" }, extra: { "plugins/doug-flow/lib/board.mjs": COMMENT } });
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(out).toContain(SKIP_LINE);
    expect(typechecked(out)).toBe(false);
    expect(readArgv(cwd)).toEqual([]);
  });

  it("D29 (comment): a basename-only mention in source plus a test naming the doc by its path -> only that test runs", async () => {
    const cwd = await docsRepo({ extra: { "plugins/doug-flow/lib/board.mjs": COMMENT } });
    await stage(cwd, ADR);
    const { status, out } = await commitA(cwd);
    expect(status, out).toBe(0);
    expect(readArgv(cwd)).toEqual([[NAMER]]);
    expect(typechecked(out)).toBe(false);
  });

  it("D30 (helper): a non-test helper under tests/ naming the doc only by basename segments -> the full gate (doubt fails closed)", async () => {
    const cwd = await docsRepo({ tests: { [OTHER]: "it('x');\n" }, extra: { "plugins/doug-flow/tests/helpers.mjs": SEGMENTS } });
    await stage(cwd, ADR);
    expectFull(cwd, await commitA(cwd));
  });
});
