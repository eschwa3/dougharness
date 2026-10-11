import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { makeProject, runHookScript, scriptsDir } from "./helpers.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";
// card verified-tree-record: records are built and inspected through the lib itself.
import { readRecord } from "../lib/verified-tree.mjs";
// Load-proofing (card gate-docs-skip-unless-named, same mechanism as 7d1c99b): vitest's worker answers its main
// process over an RPC whose calls time out after 60 s, and this file's cases spawn synchronously (git, hook
// scripts, the gate's own commands), awaiting only microtasks between tests, so the loop never turned and the
// replies queued behind the whole run. One macrotask turn after each test lets them through.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)));

// card stop-gate-tsc-red-claim: a tester whose new test imports a not-yet-written export leaves `pnpm typecheck`
// failing with tsc lines like `tests/strings.test.ts(2,19): error TS2305: ...`. failingTestFilesFrom
// (lib/block-ledger.mjs) only reads vitest FAIL/failed lines, so the SubagentStop gate refused the claim
// ("named no test file in its output"). The gate must credit a typecheck failure whose every tsc error line
// names a claimed test file; one error line naming a non-test file, or an unclaimed test file, still blocks.
describe("card stop-gate-tsc-red-claim", () => {
  const claim = (files) => JSON.stringify({ tests_red_by_design: files });
  const TSC_LINE = `tests/strings.test.ts(2,19): error TS2305: Module '"../src/strings.js"' has no exported member 'truncate'.`;
  const TSC_PREFIXED = `packages/doug-cli typecheck: ${TSC_LINE}`;
  const SRC_ERROR = `src/strings.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.`;
  const OTHER_TEST_ERROR = `tests/other.test.ts(5,3): error TS2304: Cannot find name 'nope'.`;
  const VITEST_FAIL = " FAIL  tests/strings.test.ts > truncate > shortens";
  const LEDGER = ".doug/.state/blocks.jsonl";

  const configFor = () => ({
    ...baseConfig,
    commands: { typecheck: "cat tsc-out.txt; exit 1", test: "cat vt-out.txt; exit 1" },
    stopGate: { commands: ["typecheck", "test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  });

  function setup(tscLines, vitestLines = [VITEST_FAIL]) {
    const dir = makeProject({ config: configFor(), git: true });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/strings.test.ts"), "import { truncate } from '../src/strings.js';");
    writeFileSync(join(dir, "tsc-out.txt"), tscLines.join("\n") + "\n");
    writeFileSync(join(dir, "vt-out.txt"), vitestLines.join("\n") + "\n");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/strings.test.ts" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    return dir;
  }
  const testerStop = (dir, files = ["tests/strings.test.ts"]) =>
    runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: `Red as designed.\n${claim(files)}` },
      { dir },
    );
  const readLedger = (dir) => {
    const f = join(dir, LEDGER);
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it("(a) the real tsc TS2305 line plus a vitest FAIL for the same claimed file: the claim is honoured", () => {
    const dir = setup([TSC_LINE]);
    const r = testerStop(dir);
    expect(r.json && r.json.decision, "claim honoured (decision)").toBeUndefined();
  });

  it("(b) a second tsc error naming src/strings.ts (not a test file) blocks, and the reason names that path", () => {
    const dir = setup([TSC_LINE, SRC_ERROR]);
    const r = testerStop(dir);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason.includes("type error in src/strings.ts"), "reason names src/strings.ts").toBe(true);
    expect(r.json.reason.includes("is not a test file"), "reason says not a test file").toBe(true);
  });

  it("(c) a tsc error naming an unclaimed test file, blocks as not listed in the claim", () => {
    const dir = setup([TSC_LINE, OTHER_TEST_ERROR]);
    const r = testerStop(dir);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason.includes("not listed in the claim"), "reason: not listed in the claim").toBe(true);
    expect(r.json.reason.includes("other.test.ts is failing"), "reason names tests/other.test.ts").toBe(true);
  });

  it("(d) a pnpm -r prefixed tsc line is credited like (a)", () => {
    const dir = setup([TSC_PREFIXED]);
    const r = testerStop(dir);
    expect(r.json && r.json.decision, "claim honoured (decision)").toBeUndefined();
  });

  it("(e) ledger class: the claim-covered tsc failure is expected-red; one with a non-test tsc path is not", () => {
    // First half: (a)'s failures. The tester claim is honoured (standing claim set), then the main Stop blocks
    // and the ledger must classify that block expected-red.
    const dirA = setup([TSC_LINE]);
    const honoured = testerStop(dirA);
    expect(honoured.json && honoured.json.decision, "setup: claim honoured").toBeUndefined();
    const rA = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dirA });
    expect(rA.json.decision).toBe("block");
    const linesA = readLedger(dirA);
    expect(linesA[linesA.length - 1] && linesA[linesA.length - 1].class, "ledger class").toBe("expected-red");

    // Second half: standing claim established while typecheck is clean of tsc lines (vitest-only red), then
    // typecheck output gains (b)'s non-test tsc path; that block must not read as expected-red.
    const dirB = setup(["tsc ok"]);
    writeFileSync(join(dirB, ".doug/config.json"), JSON.stringify({ ...configFor(), commands: { typecheck: "exit 0", test: "cat vt-out.txt; exit 1" } }));
    const honouredB = testerStop(dirB);
    expect(honouredB.json && honouredB.json.decision, "setup: claim honoured").toBeUndefined();
    writeFileSync(join(dirB, "tsc-out.txt"), [TSC_LINE, SRC_ERROR].join("\n") + "\n");
    writeFileSync(join(dirB, ".doug/config.json"), JSON.stringify(configFor()));
    const rB = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dirB });
    expect(rB.json.decision).toBe("block");
    const linesB = readLedger(dirB);
    expect(linesB.length).toBeGreaterThan(0);
    expect(linesB[linesB.length - 1].class, "ledger class").not.toBe("expected-red");
  });

  // Fix pass 1 (reviewer).
  const TAIL = ": error TS2305: Module has no exported member 'truncate'.";

  it("(timing) a 200,000-char line with no tsc match is scanned in under 200 ms by both readers", async () => {
    const { failingTestFilesFrom, nonTestTscPathsFrom } = await import("../lib/block-ledger.mjs");
    const big = "a".repeat(200000);
    for (const fn of [failingTestFilesFrom, nonTestTscPathsFrom]) {
      const started = Date.now();
      const out = fn(big, "/proj");
      const elapsed = Date.now() - started;
      expect(out, "no path named").toEqual([]);
      expect(elapsed, `scan took ${elapsed} ms`).toBeLessThan(200);
    }
  });

  it("(f) a tsc line whose path is absolute under the project dir is credited", () => {
    const dir = setup([TSC_LINE]);
    writeFileSync(join(dir, "tsc-out.txt"), `${dir}/tests/strings.test.ts(2,19)${TAIL}\n`);
    const r = testerStop(dir);
    expect(r.json && r.json.decision, "claim honoured (decision)").toBeUndefined();
  });

  it("(g) a tsc line with a leading ./ on the path is credited", () => {
    const dir = setup([TSC_LINE]);
    writeFileSync(join(dir, "tsc-out.txt"), `./tests/strings.test.ts(2,19)${TAIL}\n`);
    const r = testerStop(dir);
    expect(r.json && r.json.decision, "claim honoured (decision)").toBeUndefined();
  });

  it("(h) a line without TS<digits> is not a tsc error line: it names no file, and the command blocks", async () => {
    const line = "tests/strings.test.ts(2,19): error: something";
    const { failingTestFilesFrom, nonTestTscPathsFrom } = await import("../lib/block-ledger.mjs");
    expect(failingTestFilesFrom(line, "/proj")).toEqual([]);
    expect(nonTestTscPathsFrom(line, "/proj")).toEqual([]);
    const dir = setup([line]);
    const r = testerStop(dir);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason.includes("named no test file in its output"), "reason: named no test file").toBe(true);
  });

  it("(timing-2) a 200,000-char line that does contain the tsc marker is scanned in under 200 ms by both readers", async () => {
    const { failingTestFilesFrom, nonTestTscPathsFrom } = await import("../lib/block-ledger.mjs");
    const big = "a".repeat(200000) + " x(1,1): error TS1";
    for (const fn of [failingTestFilesFrom, nonTestTscPathsFrom]) {
      const started = Date.now();
      fn(big, "/proj");
      const elapsed = Date.now() - started;
      expect(elapsed, `scan took ${elapsed} ms`).toBeLessThan(200);
    }
  });

  it("(i) an error line with TS but no digits is not a tsc error line: both readers return []", async () => {
    const { failingTestFilesFrom, nonTestTscPathsFrom } = await import("../lib/block-ledger.mjs");
    const line = "tests/strings.test.ts(2,19): error TS: no digits";
    expect(failingTestFilesFrom(line, "/proj")).toEqual([]);
    expect(nonTestTscPathsFrom(line, "/proj")).toEqual([]);
  });
});

describe("card stop-gate-board-edit-reuses-red", () => {
  const runsRel = ".doug/.state/runs.log";
  const SUMMARY = "RED-SUMMARY-BOARD";
  const REUSE = "Only paths on preCommit.noTestPaths changed";
  const runs = (dir) => (existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0);
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  const ledgerOf = (dir) => {
    const file = join(dir, ".doug/.state/blocks.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir });
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  // Red command: each run appends one "x" to runs.log (ignored by the tree fingerprint), prints SUMMARY, exits 1.
  // Green command: appends one "x" and exits 0.
  const redCommand = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log('${SUMMARY}');process.exit(1)"`;
  const greenCommand = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x')"`;
  const cfgWith = (command, noTestPaths, maxBlocks = 10) => {
    const c = {
      ...baseConfig,
      commands: { test: command },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks, timeoutMs: 10000, requireEvidence: false },
    };
    if (noTestPaths !== undefined) c.preCommit = { noTestPaths };
    return c;
  };

  // Committed base, src/a.ts edited, the first Stop runs the gate once. Returns { dir, first }.
  function makeFirstStop(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base b");
    writeFileSync(join(dir, ".doug/board.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    const first = stop(dir);
    expect(runs(dir), "fixture: the first gate must run the command once").toBe(1);
    return { dir, first };
  }
  function makeRed(config) {
    const { dir, first } = makeFirstStop(config);
    expect(first.json.decision, "fixture: the first gate must block red").toBe("block");
    expect(first.json.reason).toContain(SUMMARY);
    expect(stateOf(dir).lastRed, "fixture: the red is recorded in state.lastRed").toBeTruthy();
    return dir;
  }

  it("B1 red, then a board-only edit: blocks with the same summary and the board-only sentence, zero commands, counts", () => {
    const dir = makeRed(cfgWith(redCommand, [".doug/board.json"]));
    expect(stateOf(dir).stopBlocks).toBe(1);
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(runs(dir), "a board-only edit after a red must not re-run the commands").toBe(1);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain(SUMMARY);
    expect(r.json.reason).toContain(REUSE);
    expect(r.json.reason).not.toContain("Nothing changed since the last block");
    expect(r.json.reason).toContain("(2/10)");
    expect(stateOf(dir).stopBlocks).toBe(2);
  });

  it("B2 red, then two board-only edits in a row: both reuse, zero commands, the record is kept", () => {
    const dir = makeRed(cfgWith(redCommand, [".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r1 = stop(dir);
    expect(r1.json.reason).toContain(REUSE);
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":2}');
    const r2 = stop(dir);
    expect(runs(dir), "the second board-only edit must still reuse the red").toBe(1);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain(SUMMARY);
    expect(r2.json.reason).toContain(REUSE);
    expect(r2.json.reason).toContain("(3/10)");
    expect(stateOf(dir).stopBlocks).toBe(3);
    expect(stateOf(dir).lastRed, "a board-only reuse keeps state.lastRed").toBeTruthy();
  });

  it("B3 red, then a source edit: reruns the command, no reuse sentence", () => {
    const dir = makeRed(cfgWith(redCommand, [".doug/board.json"]));
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    const r = stop(dir);
    expect(runs(dir)).toBe(2);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).not.toContain(REUSE);
  });

  it("B4 red, then a board edit plus a source edit: reruns", () => {
    const dir = makeRed(cfgWith(redCommand, [".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    const r = stop(dir);
    expect(runs(dir)).toBe(2);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).not.toContain(REUSE);
  });

  it("B5 green, then a board-only edit: allowed with no commands", () => {
    const { dir, first } = makeFirstStop(cfgWith(greenCommand, [".doug/board.json"]));
    expect(first.json, "fixture: the first gate must run green").toBeNull();
    expect(stateOf(dir).verified, "fixture: green records state.verified").toBeTruthy();
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
  });

  it("B6 red, then a rename of a source path into a listed path: reruns", () => {
    const dir = makeRed(cfgWith(redCommand, ["docs/"]));
    git(dir, "mv", "src/b.ts", "docs/b.ts");
    const r = stop(dir);
    expect(runs(dir), "a rename out of a source path must run the gate").toBe(2);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).not.toContain(REUSE);
  });

  it("B7 red with no noTestPaths list, then a board-only edit: reruns (fail closed)", () => {
    const dir = makeRed(cfgWith(redCommand, undefined));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(runs(dir)).toBe(2);
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).not.toContain(REUSE);
  });

  it("B8 a board-only reuse logs the recorded red's class", () => {
    const dir = makeRed(cfgWith(redCommand, [".doug/board.json"]));
    const before = ledgerOf(dir);
    expect(before.length, "fixture: the first red logged one ledger line").toBe(1);
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json.reason, "fixture: the board-only edit must be the reuse").toContain(REUSE);
    const after = ledgerOf(dir);
    expect(after.length, JSON.stringify(after)).toBe(2);
    expect(after[1].class).toBe(before[0].class);
    expect(after[1].class).toBe("real");
  });
});

// card stop-gate-runs-only-on-code-turns: a main Stop verifies only when the finishing turn changed code. The
// UserPromptSubmit hook (scripts/turn-start.mjs) records a tree fingerprint; a Stop whose tree still matches it,
// with no successful main-agent Edit traced since, is a read-only turn and skips verification. These tests fire
// the real scripts and pin behaviour, not where the record is stored.
describe("card stop-gate-runs-only-on-code-turns", () => {
  const runsRel = ".doug/.state/runs.log";
  const runs = (dir) => (existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0);
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir });
  const READ_ONLY_LINE = "[doug] Read-only turn: verification skipped; the working tree holds unverified changes from other agents.";
  // Each gate run appends one "x" to runs.log (inside .doug/.state, which the tree fingerprint ignores) and fails,
  // so a run that happens shows as a count and a block.
  const cfgWith = (noTestPaths) => {
    const c = {
      ...baseConfig,
      commands: { test: `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');process.exit(1)"` },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
    };
    if (noTestPaths !== undefined) c.preCommit = { noTestPaths };
    return c;
  };
  const turnStart = (dir) => runHookScript("turn-start", { hook_event_name: "UserPromptSubmit", prompt: "hello" }, { dir });
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const mainEdit = (dir, file) => {
    const edit = { tool_name: "Edit", tool_input: { file_path: file }, tool_use_id: "tuM" };
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: file } }, { dir });
    runHookScript("trace", { hook_event_name: "PreToolUse", ...edit }, { dir });
    runHookScript("trace", { hook_event_name: "PostToolUse", tool_response: { success: true }, ...edit }, { dir });
  };
  const markEdited = (dir) => runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

  // Committed base (src/a.ts, src/b.ts, .doug/board.json). src/b.ts is then left dirty: another agent's work,
  // present before the turn starts.
  function makeDirty(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base a");
    writeFileSync(join(dir, "src/b.ts"), "base b");
    writeFileSync(join(dir, ".doug/board.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/b.ts"), "another agent's unverified work");
    return dir;
  }

  it("A a read-only turn over another agent's dirty tree skips the gate with the read-only note", () => {
    const dir = makeDirty(cfgWith());
    const ts = turnStart(dir);
    expect(ts.status, "fixture: the turn-start script must run").toBe(0);
    const r = stop(dir);
    expect(runs(dir), "no configured command may run").toBe(0);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).not.toBe("block");
    expect(r.json && r.json.systemMessage, JSON.stringify(r.json)).toContain(READ_ONLY_LINE);
    expect(r.json.systemMessage.split("\n").filter((l) => l.includes("Read-only turn")).length, "the line appears once").toBe(1);
  });

  it("B an Edit-tool turn that changes an already-dirty file verifies", () => {
    const dir = makeDirty(cfgWith());
    turnStart(dir);
    writeFileSync(join(dir, "src/b.ts"), "edited again during this turn");
    mainEdit(dir, "src/b.ts");
    const r = stop(dir);
    expect(runs(dir), "the command must run").toBe(1);
    expect(r.json && r.json.decision).toBe("block");
  });

  it("B2 an Edit reverted by content within the turn (tree identical to turn start) still verifies", () => {
    const dir = makeDirty(cfgWith());
    turnStart(dir);
    writeFileSync(join(dir, "src/b.ts"), "temporary edit");
    mainEdit(dir, "src/b.ts");
    writeFileSync(join(dir, "src/b.ts"), "another agent's unverified work");
    const r = stop(dir);
    expect(runs(dir), "a successful traced Edit means the turn changed code").toBe(1);
    expect(r.json && r.json.decision).toBe("block");
  });

  it("C a Bash write (no Edit trace) to an already-dirty file verifies", () => {
    const dir = makeDirty(cfgWith());
    turnStart(dir);
    writeFileSync(join(dir, "src/b.ts"), "rewritten by a shell command");
    const r = stop(dir);
    expect(runs(dir), "a content change must verify").toBe(1);
    expect(r.json && r.json.decision).toBe("block");
  });

  it("C2 a Bash-created untracked code file verifies", () => {
    const dir = makeDirty(cfgWith());
    turnStart(dir);
    writeFileSync(join(dir, "src/new.ts"), "created by a shell command");
    const r = stop(dir);
    expect(runs(dir)).toBe(1);
    expect(r.json && r.json.decision).toBe("block");
  });

  it("D no turn-start record (the UserPromptSubmit hook never ran) over the same dirty tree verifies as today", () => {
    const dir = makeDirty(cfgWith());
    const r = stop(dir);
    expect(runs(dir)).toBe(1);
    expect(r.json && r.json.decision).toBe("block");
    expect(JSON.stringify(r.json)).not.toContain("Read-only turn");
  });

  it("D2 a malformed turn-start record fails safe to verifying", () => {
    const dir = makeDirty(cfgWith());
    turnStart(dir);
    const base = join(dir, ".doug/.state/turn-start");
    expect(existsSync(base), "fixture: the turn-start script must have written a record").toBe(true);
    for (const f of readdirSync(base)) writeFileSync(join(base, f), "{not json");
    const r = stop(dir);
    expect(runs(dir)).toBe(1);
    expect(r.json && r.json.decision).toBe("block");
  });

  it("E a noTestPaths-only change during the turn is still read-only", () => {
    const dir = makeDirty(cfgWith([".doug/board.json"]));
    turnStart(dir);
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(runs(dir), "a board-only change is not code").toBe(0);
    expect(r.json && r.json.decision).not.toBe("block");
    expect(r.json && r.json.systemMessage, JSON.stringify(r.json)).toContain(READ_ONLY_LINE);
  });

  it("F a read-only turn over a clean tree allows with no command and no read-only note", () => {
    const dir = makeProject({ config: cfgWith(), git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base a");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    // An earlier turn edited, so the session counts as edited and today's gate would verify even a clean tree.
    markEdited(dir);
    turnStart(dir);
    const r = stop(dir);
    expect(runs(dir), "no command may run on a read-only turn").toBe(0);
    expect(r.json && r.json.decision).not.toBe("block");
    expect(JSON.stringify(r.json)).not.toContain("Read-only turn");
  });

  it("G the turn-start script prints nothing to stdout and exits 0, even on malformed stdin", () => {
    const dir = makeDirty(cfgWith());
    const ok = runHookScript("turn-start", { hook_event_name: "UserPromptSubmit", prompt: "hello" }, { dir });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("");
    for (const input of ["{not json", "", "[1,2"]) {
      const res = spawnSync(process.execPath, [join(scriptsDir, "turn-start.mjs")], {
        cwd: dir,
        input,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        timeout: 30000,
      });
      expect(res.status, `malformed stdin ${JSON.stringify(input)}`).toBe(0);
      expect(res.stdout, `stdout for ${JSON.stringify(input)}`).toBe("");
    }
  });

  it("G2 the turn-start script writes its record even when trace is disabled", () => {
    const dir = makeDirty({ ...cfgWith(), trace: { enabled: false } });
    turnStart(dir);
    const r = stop(dir);
    expect(runs(dir)).toBe(0);
    expect(r.json && r.json.systemMessage, JSON.stringify(r.json)).toContain(READ_ONLY_LINE);
  });

  it("H a commit during the turn (HEAD moved, tree otherwise unchanged) verifies", () => {
    const dir = makeDirty(cfgWith());
    markEdited(dir);
    turnStart(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "committed during the turn");
    const r = stop(dir);
    expect(runs(dir), "HEAD moved: the command must run").toBe(1);
    expect(r.json && r.json.decision).toBe("block");
  });

  it("H2 an empty commit during the turn (HEAD moved, tree identical) verifies", () => {
    const dir = makeDirty(cfgWith());
    markEdited(dir);
    turnStart(dir);
    git(dir, "commit", "-q", "--allow-empty", "-m", "moved head");
    stop(dir);
    expect(runs(dir)).toBe(1);
  });

  // Fix pass: the read-only skip must not bypass the tree checks (plan scope, proposal paths) for a file the turn
  // changed by Bash that sits on preCommit.noTestPaths.
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const approvedPlan = {
    version: 1,
    title: "Owns a",
    goal: "g",
    status: "approved",
    acceptance: ["a"],
    verify: [],
    tasks: [{ id: "t1", title: "t", spec: "s", files: ["src/a.ts"] }],
  };
  function makePlanned(noTestPaths) {
    const dir = makeProject({ config: cfgWith(noTestPaths), git: true });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src/a.ts"), "base a");
    writeFileSync(join(dir, "docs/notes.md"), "base notes");
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(approvedPlan));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
  }

  for (const withRecord of [true, false]) {
    const tag = withRecord ? "with a turn-start record" : "without a record";
    it(`I1 a Bash write to a noTestPaths file outside the approved plan still blocks on scope (${tag})`, () => {
      const dir = makePlanned(["docs/notes.md"]);
      if (withRecord) turnStart(dir);
      writeFileSync(join(dir, "docs/notes.md"), "written by a shell command");
      const r = stop(dir);
      expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
      expect(r.json.reason).toContain("Files changed outside the approved plan");
      expect(r.json.reason).toContain("docs/notes.md");
    });

    it(`I2 a Bash-written proposal-path file on noTestPaths still blocks on the proposal-path message (${tag})`, () => {
      const dir = makeProject({ config: cfgWith(["docs/"]), git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/keep.md"), "base");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      if (withRecord) turnStart(dir);
      writeFileSync(join(dir, "docs/decisions/0099-x.md"), "# 0099. hand written\n");
      const r = stop(dir);
      expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain("docs/decisions/0099-x.md");
    });
  }

  it("I3 a board-only Bash change with no plan stays a read-only skip (E is not contradicted)", () => {
    const dir = makeDirty(cfgWith([".doug/board.json"]));
    turnStart(dir);
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":2}');
    const r = stop(dir);
    expect(runs(dir)).toBe(0);
    expect(r.json && r.json.decision).not.toBe("block");
    expect(r.json && r.json.systemMessage, JSON.stringify(r.json)).toContain(READ_ONLY_LINE);
  });

  it("J a main-agent Edit traced before the turn-start record (an earlier turn) does not stop the read-only skip", () => {
    const dir = makeDirty(cfgWith());
    mainEdit(dir, "src/b.ts");
    sleepMs(30);
    turnStart(dir);
    const r = stop(dir);
    expect(runs(dir), "the earlier turn's Edit must not count").toBe(0);
    expect(r.json && r.json.decision).not.toBe("block");
    expect(r.json && r.json.systemMessage, JSON.stringify(r.json)).toContain(READ_ONLY_LINE);
  });

  it("K a SubagentStop is unchanged: a matching turn-start record, dirty code, no agent-start record, no Edit trace still verifies", () => {
    const dir = makeDirty(cfgWith());
    turnStart(dir);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(runs(dir), "a subagent Stop never takes the main read-only skip").toBe(1);
    expect(JSON.stringify(r.json)).not.toContain("Read-only turn");
  });

  it("L turn-start given an agent_id writes no record, prints nothing, and leaves the lead's record untouched", () => {
    const dir = makeDirty(cfgWith());
    const sub = { hook_event_name: "UserPromptSubmit", prompt: "x", agent_id: "ag1", agent_type: "coder" };
    const first = runHookScript("turn-start", sub, { dir });
    expect(first.status).toBe(0);
    expect(first.stdout).toBe("");
    const base = join(dir, ".doug/.state/turn-start");
    expect(existsSync(base) ? readdirSync(base) : [], "a subagent firing must write no record").toEqual([]);
    // The lead's record survives a later subagent firing over a changed tree.
    turnStart(dir);
    const files = readdirSync(base);
    expect(files.length, "fixture: the lead's record exists").toBe(1);
    const before = readFileSync(join(base, files[0]), "utf8");
    writeFileSync(join(dir, "src/b.ts"), "changed after the lead's record");
    const second = runHookScript("turn-start", sub, { dir });
    expect(second.stdout).toBe("");
    expect(readFileSync(join(base, files[0]), "utf8")).toBe(before);
  });

  // Second fix pass: the read-only skip must not fall into the green block's side effects (checkpoint commit,
  // state.verified, stopBlocks reset, lastRed clear), and must not hide files dirtied before the record.
  const ckCfg = (noTestPaths) => ({ ...cfgWith(noTestPaths), checkpoint: { enabled: true, mode: "commit" } });
  const stateFile = (dir) => join(dir, ".doug/.state/test-session.json");
  const readState = (dir) => (existsSync(stateFile(dir)) ? JSON.parse(readFileSync(stateFile(dir), "utf8")) : {});
  const seedState = (dir) => {
    const lastRed = { scope: "main", summary: "seeded red", commands: ["seeded"], fingerprint: { head: "x", files: {} } };
    writeFileSync(stateFile(dir), JSON.stringify({ ...readState(dir), stopBlocks: 2, lastRed }));
    return lastRed;
  };

  it("N1a a board-only Bash change on a read-only turn makes no checkpoint commit and runs no command", () => {
    const dir = makeDirty(ckCfg([".doug/board.json"]));
    const head = git(dir, "rev-parse", "HEAD").toString();
    turnStart(dir);
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(runs(dir), "no command may run").toBe(0);
    expect(r.json && r.json.decision).not.toBe("block");
    expect(git(dir, "rev-parse", "HEAD").toString(), "no checkpoint commit").toBe(head);
    expect(git(dir, "status", "--porcelain", "--", "src/b.ts").toString(), "src/b.ts must stay uncommitted").toContain("src/b.ts");
  });

  it("N1b an exact-match read-only turn with checkpoint on makes no commit", () => {
    const dir = makeDirty(ckCfg());
    const head = git(dir, "rev-parse", "HEAD").toString();
    turnStart(dir);
    const r = stop(dir);
    expect(runs(dir)).toBe(0);
    expect(r.json && r.json.decision).not.toBe("block");
    expect(git(dir, "rev-parse", "HEAD").toString()).toBe(head);
    expect(git(dir, "status", "--porcelain", "--", "src/b.ts").toString()).toContain("src/b.ts");
  });

  for (const withRecord of [true, false]) {
    const tag = withRecord ? "with a turn-start record written after it" : "without a record";
    it(`N2a a proposal-path file written before the turn-start record still blocks on a read-only turn (${tag})`, () => {
      const dir = makeProject({ config: cfgWith(), git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/keep.md"), "base");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      writeFileSync(join(dir, "docs/decisions/0099-x.md"), "# 0099. hand written, earlier turn\n");
      if (withRecord) turnStart(dir);
      const r = stop(dir);
      expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain("docs/decisions/0099-x.md");
    });

    it(`N2b a protected-path file dirty before the turn-start record still blocks on a read-only turn (${tag})`, () => {
      const dir = makeDirty(cfgWith());
      writeFileSync(join(dir, ".env"), "SECRET=1");
      if (withRecord) turnStart(dir);
      const r = stop(dir);
      expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
      expect(r.json.reason).toContain(".env");
    });
  }

  for (const [label, noTest, change] of [
    ["exact", undefined, false],
    ["noTestPaths-only", [".doug/board.json"], true],
  ]) {
    it(`N3 a ${label} read-only turn leaves state.verified unset and stopBlocks/lastRed as they were`, () => {
      const dir = makeDirty(cfgWith(noTest));
      turnStart(dir);
      const lastRed = seedState(dir);
      if (change) writeFileSync(join(dir, ".doug/board.json"), '{"changed":3}');
      const r = stop(dir);
      expect(runs(dir)).toBe(0);
      expect(r.json && r.json.decision).not.toBe("block");
      const state = readState(dir);
      expect(state.verified, "a skipped turn verified nothing").toBeFalsy();
      expect(state.stopBlocks, "stopBlocks must not reset").toBe(2);
      expect(state.lastRed, "lastRed must not be cleared").toEqual(lastRed);
    });
  }
});

// card gate-docs-skip-unless-named: a changed docs/**/*.md file does not by itself run the suite. When every path
// changed since the last green is on preCommit.noTestPaths or is a docs .md, the Stop gate looks for tracked
// test files naming each doc (its repo-relative path or its basename): none -> skip like no-test-paths; some ->
// run only `pnpm test:unit <those files>` (sorted, no typecheck, never credited as a full run). Any other path,
// a helper or source file naming the doc, an unreadable test tree, or a config without test:unit runs the full
// gate. The fixture's typecheck and test:unit are real `pnpm` scripts that log every run, so "only this file"
// is read from the logged argv.
describe("card gate-docs-skip-unless-named (Stop gate)", () => {
  const ADR = "docs/decisions/0005-two-tracks.md";
  const UNNAMED = "docs/decisions/0099-unnamed.md";
  const NAMER = "plugins/doug-flow/tests/naming-a.test.mjs";
  const OTHER = "plugins/doug-flow/tests/other.test.mjs";
  const LITERAL = `const p = join(root, "..", "..", "docs/decisions/0005-two-tracks.md");\n`;
  const SEGMENTS = `const p = join(root, "docs", "decisions", "0005-two-tracks.md");\n`;
  const argvRel = ".doug/.state/unit-argv.log";
  const typecheckRel = ".doug/.state/typecheck.log";
  const runsRel = ".doug/.state/runs.log";
  const LAST_GREEN = ".doug/.state/test-totals.json";

  const UNIT =
    `const fs = require("fs");\nfs.mkdirSync(".doug/.state", { recursive: true });\n` +
    `const a = process.argv.slice(2);\nfs.appendFileSync("${argvRel}", JSON.stringify(a) + "\\n");\n` +
    `const n = a.length ? 3 : 100;\nconsole.log(" Tests  " + n + " passed (" + n + ")");\n` +
    `process.exit(a.length && fs.existsSync(".doug/.state/fail-targeted") ? 1 : 0);\n`;
  const TYPECHECK = `const fs = require("fs");\nfs.mkdirSync(".doug/.state", { recursive: true });\nfs.appendFileSync("${typecheckRel}", "x");\n`;

  const pnpmCfg = () => ({
    ...baseConfig,
    commands: { typecheck: "pnpm typecheck", "test:unit": "pnpm test:unit" },
    stopGate: { commands: ["typecheck", "test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, requireEvidence: false },
    trace: { enabled: true },
    preCommit: { noTestPaths: [".doug/board.json", "docs/live-runs.md"] },
    proposalPaths: [], // docs/decisions/** is a proposal path by default and blocks on its own; this card's clause is isolated
  });
  // No test:unit entry at all: the one configured command counts its runs in runs.log.
  const noUnitCfg = () => ({
    ...baseConfig,
    commands: { test: `${process.execPath} -e "require('fs').mkdirSync('.doug/.state',{recursive:true});require('fs').appendFileSync('${runsRel}','x')"` },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, requireEvidence: false },
    trace: { enabled: true },
    preCommit: { noTestPaths: [".doug/board.json", "docs/live-runs.md"] },
    proposalPaths: [], // docs/decisions/** is a proposal path by default and blocks on its own; this card's clause is isolated
  });

  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir });
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  const traceOf = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const argvs = (dir) =>
    existsSync(join(dir, argvRel)) ? readFileSync(join(dir, argvRel), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const typechecks = (dir) => (existsSync(join(dir, typecheckRel)) ? readFileSync(join(dir, typecheckRel), "utf8").length : 0);
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const write = (dir, rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };

  // A committed base (docs, tests, src), src/a.ts edited this session, and a first Stop that runs the full
  // gate green: state.verified, the last-green totals (pnpm test:unit = 100 tests) and a verified-tree record
  // are written. The run logs are then cleared so each case counts only its own runs.
  function makeGreen({ tests = { [NAMER]: LITERAL, [OTHER]: "it('x');\n" }, extra = {}, cfg = pnpmCfg(), prepare = null } = {}) {
    const dir = makeProject({ config: cfg, git: true });
    const files = {
      ".gitignore": ".doug/.state/\n",
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: "node typecheck.cjs", "test:unit": "node test-unit.cjs" } }),
      "typecheck.cjs": TYPECHECK,
      "test-unit.cjs": UNIT,
      "src/a.ts": "base",
      "src/b.ts": "base b",
      "docs/live-runs.md": "base",
      "docs/data.json": "{}",
      [ADR]: "v1",
      [UNNAMED]: "v1",
      ".doug/board.json": "{}",
      ...tests,
      ...extra,
    };
    for (const [f, body] of Object.entries(files)) write(dir, f, body);
    if (prepare) prepare(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    write(dir, "src/a.ts", "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    const first = stop(dir);
    expect(first.json, "fixture: the first gate must run green").toBeNull();
    expect(stateOf(dir).verified, "fixture: green records state.verified").toBeTruthy();
    if (cfg.stopGate.commands.includes("test:unit")) {
      expect(argvs(dir), "fixture: the first gate is the full run").toEqual([[]]);
      expect(typechecks(dir), "fixture: the first gate ran typecheck").toBeGreaterThan(0);
      expect(existsSync(join(dir, LAST_GREEN)), "fixture: the first green writes the last-green totals").toBe(true);
    }
    rmSync(join(dir, argvRel), { force: true });
    rmSync(join(dir, typecheckRel), { force: true });
    rmSync(join(dir, runsRel), { force: true });
    return dir;
  }
  const expectSkipped = (dir, r) => {
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(argvs(dir), "test:unit must not run").toEqual([]);
    expect(typechecks(dir), "typecheck must not run").toBe(0);
    const skipped = stateOf(dir).lastGate && stateOf(dir).lastGate.skipped;
    expect(String(skipped), "lastGate.skipped carries a no-test-paths-style reason").toMatch(/no-test-paths/);
    expect(traceOf(dir).some((l) => typeof l.reason === "string" && /no-test-paths/.test(l.reason)), "a trace line carries the reason").toBe(true);
  };
  const expectFull = (dir, r) => {
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(argvs(dir), "the full run passes test:unit no file arguments").toEqual([[]]);
    expect(typechecks(dir), "the full gate runs typecheck").toBeGreaterThan(0);
  };

  it("DS1 (a): an ADR no test names changed -> skip with a no-test-paths-style reason, no command runs", () => {
    const dir = makeGreen();
    write(dir, UNNAMED, "v2");
    expectSkipped(dir, stop(dir));
  });

  it("DS2 (a): an unnamed ADR plus a listed board.json changed -> skip", () => {
    const dir = makeGreen();
    write(dir, UNNAMED, "v2");
    write(dir, ".doug/board.json", '{"changed":1}');
    expectSkipped(dir, stop(dir));
  });

  it("DS3 (a): the skip leaves state.verified unchanged", () => {
    const dir = makeGreen();
    const before = stateOf(dir).verified;
    write(dir, UNNAMED, "v2");
    expectSkipped(dir, stop(dir));
    expect(stateOf(dir).verified).toEqual(before);
  });

  it("DS4 (b): 0005-two-tracks.md named by one test file (full literal path) and no other test -> only `pnpm test:unit <that file>` runs", () => {
    const dir = makeGreen();
    write(dir, ADR, "v2");
    const r = stop(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).not.toBe("block");
    expect(argvs(dir)).toEqual([[NAMER]]);
    expect(typechecks(dir), "typecheck is not run on a targeted run").toBe(0);
  });

  it("DS5 (b): a committed (not dirty) change to the named ADR since the green also runs only the naming test", () => {
    const dir = makeGreen();
    write(dir, ADR, "v2");
    git(dir, "add", ADR);
    git(dir, "commit", "-q", "-m", "adr");
    const r = stop(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).not.toBe("block");
    expect(argvs(dir)).toEqual([[NAMER]]);
    expect(typechecks(dir)).toBe(0);
  });

  it("DS6 (b): several naming test files (.mjs .ts .js .cjs), by path or basename -> one run with all of them, repo-relative and sorted", () => {
    const names = {
      "plugins/zeta/tests/z.test.mjs": LITERAL,
      "packages/doug-cli/tests/b.test.ts": SEGMENTS,
      "evals/tests/c.test.js": LITERAL,
      "tests/a.test.cjs": SEGMENTS,
      [OTHER]: "it('x');\n",
    };
    const dir = makeGreen({ tests: names });
    write(dir, ADR, "v2");
    stop(dir);
    expect(argvs(dir)).toEqual([Object.keys(names).filter((f) => f !== OTHER).sort()]);
  });

  it("DS7 (b): one named doc and one unnamed doc changed -> the run covers the named doc's tests", () => {
    const dir = makeGreen();
    write(dir, ADR, "v2");
    write(dir, UNNAMED, "v2");
    stop(dir);
    expect(argvs(dir)).toEqual([[NAMER]]);
    expect(typechecks(dir)).toBe(0);
  });

  it("DS8 (c): a test naming the doc only by join(\"docs\", \"decisions\", \"<basename>\") segments is found by the basename", () => {
    const dir = makeGreen({ tests: { [NAMER]: SEGMENTS, [OTHER]: "it('x');\n" } });
    write(dir, ADR, "v2");
    stop(dir);
    expect(argvs(dir)).toEqual([[NAMER]]);
    expect(typechecks(dir)).toBe(0);
  });

  it("DS9 (d): a docs .md plus a code change -> the full gate", () => {
    const dir = makeGreen();
    write(dir, UNNAMED, "v2");
    write(dir, "src/b.ts", "edited b");
    expectFull(dir, stop(dir));
  });

  it("DS10 (d): a named docs .md plus a code change -> the full gate, not a targeted run", () => {
    const dir = makeGreen();
    write(dir, ADR, "v2");
    write(dir, "src/b.ts", "edited b");
    expectFull(dir, stop(dir));
  });

  it("DS11 (e): the targeted run exits non-zero -> the Stop blocks like any red", () => {
    const dir = makeGreen();
    write(dir, ".doug/.state/fail-targeted", "1");
    write(dir, ADR, "v2");
    const r = stop(dir);
    expect(argvs(dir), "fixture: the targeted run must have happened").toEqual([[NAMER]]);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
  });

  it("DS12 (f): a non-test helper under a tests/ directory naming the doc cannot be mapped to test files -> the full gate", () => {
    const dir = makeGreen({ tests: { [OTHER]: "it('x');\n" }, extra: { "plugins/doug-flow/tests/helpers.mjs": LITERAL } });
    write(dir, ADR, "v2");
    expectFull(dir, stop(dir));
  });

  it("DS13 (f): a code file outside tests/ naming the doc (it reads the doc at runtime) -> the full gate", () => {
    const dir = makeGreen({ tests: { [OTHER]: "it('x');\n" }, extra: { "packages/doug-codex/src/contract.ts": LITERAL } });
    write(dir, ADR, "v2");
    expectFull(dir, stop(dir));
  });

  it("DS14 (g): a non-.md file under docs/ changed -> the full gate", () => {
    const dir = makeGreen();
    write(dir, "docs/data.json", '{"v":2}');
    expectFull(dir, stop(dir));
  });

  it("DS15: a code file renamed into docs/ as .md -> the rename's source path counts: the full gate", () => {
    const dir = makeGreen();
    mkdirSync(join(dir, "docs/decisions"), { recursive: true });
    git(dir, "mv", "src/b.ts", "docs/decisions/moved.md");
    expectFull(dir, stop(dir));
  });

  it("DS16: a config without a test:unit command (an unnamed ADR that would skip) -> the full gate runs its commands", () => {
    const dir = makeGreen({ cfg: noUnitCfg() });
    write(dir, UNNAMED, "v2");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0, "the configured command must run").toBe(1);
  });

  it("DS17: an empty noTestPaths list -> a docs-only change runs the full gate (fail closed on the config)", () => {
    const cfg = pnpmCfg();
    cfg.preCommit = { noTestPaths: [] };
    const dir = makeGreen({ cfg });
    write(dir, UNNAMED, "v2");
    expectFull(dir, stop(dir));
  });

  it("DS18 (credit): a targeted green run is never credited as a full run: state.verified, state.testTotals, the last-green totals and the verified-tree record are untouched, and fewer tests do not trip the ratchet", () => {
    const dir = makeGreen();
    const before = {
      verified: stateOf(dir).verified,
      totals: stateOf(dir).testTotals,
      lastGreen: readFileSync(join(dir, LAST_GREEN), "utf8"),
      record: readRecord(dir),
    };
    write(dir, ADR, "v2");
    const r = stop(dir);
    expect(argvs(dir), "fixture: the targeted run must have happened").toEqual([[NAMER]]);
    expect(r.json && r.json.decision, `3 tests against a baseline of 100 must not trip the ratchet: ${JSON.stringify(r.json)}`).not.toBe("block");
    expect(stateOf(dir).verified, "state.verified is not advanced by a targeted run").toEqual(before.verified);
    expect(stateOf(dir).testTotals, "the ratchet baseline is not updated").toEqual(before.totals);
    expect(readFileSync(join(dir, LAST_GREEN), "utf8"), "the last-green totals are not rewritten").toBe(before.lastGreen);
    expect(readRecord(dir), "no verified-tree record is written for a targeted run").toEqual(before.record);
  });

  // preCommit.docsTests (user decision 2026-10-08): test files that read every doc generically and name none.
  const DOCS_TEST = "tests/all-docs.test.mjs";
  const docsTestsCfg = (docsTests) => {
    const cfg = pnpmCfg();
    cfg.preCommit = { ...cfg.preCommit, docsTests };
    return cfg;
  };

  it("DS19 (h): an unnamed ADR with preCommit.docsTests naming a tracked file -> a targeted run of exactly that file, never a skip", () => {
    const dir = makeGreen({ cfg: docsTestsCfg([DOCS_TEST]), extra: { [DOCS_TEST]: "it('x');\n" } });
    write(dir, UNNAMED, "v2");
    const r = stop(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).not.toBe("block");
    expect(argvs(dir)).toEqual([[DOCS_TEST]]);
    expect(typechecks(dir), "typecheck is not run on a targeted run").toBe(0);
  });

  it("DS20 (i): a named ADR plus docsTests -> one run of the sorted, de-duplicated union", () => {
    const dir = makeGreen({ cfg: docsTestsCfg([DOCS_TEST, NAMER]), extra: { [DOCS_TEST]: "it('x');\n" } });
    write(dir, ADR, "v2");
    stop(dir);
    expect(argvs(dir)).toEqual([[NAMER, DOCS_TEST].sort()]);
    expect(typechecks(dir)).toBe(0);
  });

  it("DS21 (j): docsTests naming a file that is not tracked (missing, or a directory) -> the full gate", () => {
    for (const entry of ["tests/missing.test.mjs", "tests"]) {
      const dir = makeGreen({ cfg: docsTestsCfg([entry]), extra: { [DOCS_TEST]: "it('x');\n" } });
      write(dir, UNNAMED, "v2");
      expectFull(dir, stop(dir));
    }
  });

  it("DS22 (k): docsTests malformed (a string, an empty entry, a non-string entry) -> the full gate", () => {
    for (const bad of [DOCS_TEST, [""], [5], [DOCS_TEST, ""], { a: DOCS_TEST }]) {
      const dir = makeGreen({ cfg: docsTestsCfg(bad), extra: { [DOCS_TEST]: "it('x');\n" } });
      write(dir, UNNAMED, "v2");
      expectFull(dir, stop(dir));
    }
  });

  it("DS27 (m-a): a tracked docsTests entry whose path holds a space -> the full gate (the safe-path check covers the docsTests entries too)", () => {
    const spaced = "tests/has space.test.mjs";
    const dir = makeGreen({ cfg: docsTestsCfg([spaced]), extra: { [spaced]: "it('x');\n" } });
    write(dir, UNNAMED, "v2");
    expectFull(dir, stop(dir));
  });

  it("DS23 (absent/empty): docsTests absent or [] -> behaviour as before: an unnamed ADR skips", () => {
    for (const docsTests of [undefined, []]) {
      const dir = makeGreen({ cfg: docsTestsCfg(docsTests), extra: { [DOCS_TEST]: "it('x');\n" } });
      write(dir, UNNAMED, "v2");
      expectSkipped(dir, stop(dir));
    }
  });

  it("DS24 (O1/O6): the test tree cannot be read (a tracked *.test.mjs that is a symlink to a directory -> EISDIR) -> the full gate, never a skip", () => {
    const dir = makeGreen({ prepare: (d) => symlinkSync("src", join(d, "tests-dirlink.test.mjs")) });
    write(dir, UNNAMED, "v2");
    expectFull(dir, stop(dir));
  });

  it("DS25 (O2): a naming test file whose path holds shell-unsafe characters (a space, a $) -> the full gate", () => {
    for (const unsafe of ["plugins/doug-flow/tests/has space.test.mjs", "tests/a$b.test.mjs"]) {
      const dir = makeGreen({ tests: { [unsafe]: LITERAL, [OTHER]: "it('x');\n" } });
      write(dir, ADR, "v2");
      expectFull(dir, stop(dir));
    }
  });

  it("DS26 (O7): a non-code file under tests/ (tests/fixtures/x.json) naming the doc cannot be mapped to test files -> the full gate", () => {
    for (const f of ["tests/fixtures/x.json", "plugins/doug-flow/tests/fixtures/x.json"]) {
      const dir = makeGreen({ tests: { [OTHER]: "it('x');\n" }, extra: { [f]: LITERAL } });
      write(dir, ADR, "v2");
      expectFull(dir, stop(dir));
    }
  });
});
