import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { makeProject, runHookScript, scriptsDir } from "./helpers.mjs";
// card stop-gate-block-ledger, round 3: classifyFinalBlock exercised directly (same precedent as runCommand
// in hooks-stop-gate-runner.test.mjs and applyProposal in hooks-stop-gate.test.mjs) to pin the budget-dropped-without-timeout precondition and the
// budgetDeadline-gated race check without spinning up a whole gate run through stop-gate.mjs. changedFiles is
// the same helper classifyFinalBlock itself calls, used here only to build a realistic "changed right now"
// set to diff the test's own changedAtStart fixture against.
import { classifyFinalBlock } from "../lib/block-ledger.mjs";
import { changedFiles } from "../lib/baseline.mjs";
// card stop-gate-skips-orphan-subagent-stops: the state file the test seeds directly is written/read through
// loadState/saveState (the module's own default shape), never a guessed JSON literal.
import { loadState, saveState } from "../lib/state.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";
// Load-proofing (card gate-docs-skip-unless-named, same mechanism as 7d1c99b): vitest's worker answers its main
// process over an RPC whose calls time out after 60 s, and this file's cases spawn synchronously (git, hook
// scripts, the gate's own commands), awaiting only microtasks between tests, so the loop never turned and the
// replies queued behind the whole run. One macrotask turn after each test lets them through.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)));
// card verified-tree-record: records are built and inspected through the lib itself.
import { computeTree, readRecord, writeRecord as writeTreeRecord, RECORD_RELPATH } from "../lib/verified-tree.mjs";

// card stop-gate-block-ledger: no implementation exists yet (writer + classifier in a new
// plugins/doug-gates/lib/block-ledger.mjs, called from scripts/stop-gate.mjs). Every test below reads
// `.doug/.state/blocks.jsonl` under the project dir, one JSON object per line: { hook: "stop-gate" |
// "subagent-stop", at: <ISO>, agent: <agent_type string, or null on the main Stop>, reason: <first line of
// the block message>, class: "expected-red" | "load-timeout" | "race" | "real" | "stood-down", session:
// <session_id> }. Distinct from the honoured-claim's own new state key, state.redByDesignClaim = { files,
// at: <ISO>, agent: <subagent.id, NOT agent_type> } — the ledger's "agent" and the state key's "agent" name
// different things (agent_type vs agent_id) by design (brief facts F1/F2/Rules).
describe("card stop-gate-block-ledger", () => {
  const LEDGER_RELPATH = ".doug/.state/blocks.jsonl";
  function readLedger(dir) {
    const file = join(dir, LEDGER_RELPATH);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  function sessionStateOf(dir) {
    return JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  }

  it("expected-red: a block whose failing file(s) are all covered by the standing tests_red_by_design claim is classified expected-red; once an uncovered file fails instead, the block is classified real", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
      git: true,
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });

    // The tester's covered claim records the standing state.redByDesignClaim (tests/a.test.mjs only) and is
    // itself honoured (systemMessage, not a block) — it must write no ledger line at all.
    const testerInput = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`,
    };
    const honoured = runHookScript("stop-gate", testerInput, { dir });
    expect(honoured.json.decision).toBeUndefined();
    expect(readLedger(dir)).toEqual([]);

    // Main Stop, same still-red file: it blocks (the main Stop never honours the claim itself, T5), but the
    // standing claim covers the one failing file, so the ledger classifies it expected-red.
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.decision).toBe("block");
    const line1 = readLedger(dir).find((l) => l.class === "expected-red");
    expect(line1, `expected an expected-red line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line1.hook).toBe("stop-gate");
    expect(line1.agent).toBeNull();

    // The project's verification command now fails on tests/b.test.mjs instead — a file the standing claim
    // never named — so this next block must not read as expected-red.
    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify({ ...baseConfig, commands: { test: "echo ' FAIL  tests/b.test.mjs > it'; exit 1" } }),
    );
    writeFileSync(join(dir, "tests/b.test.mjs"), "b");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/b.test.mjs" } }, { dir });
    const before = readLedger(dir).length;
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.json.decision).toBe("block");
    const after = readLedger(dir);
    expect(after.length, JSON.stringify(after)).toBe(before + 1);
    expect(after[after.length - 1].class).toBe("real");
  });

  it("load-timeout: a block where a command timed out and no captured output names a failing test file is classified load-timeout", () => {
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: { slow: `${process.execPath} -e "setTimeout(() => {}, 10000)"` },
        stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 1500, requireEvidence: false },
      },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBe("block");
    expect(r.json.reason.toLowerCase()).toContain("timed out");
    const line = readLedger(dir).find((l) => l.class === "load-timeout");
    expect(line, `expected a load-timeout line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.hook).toBe("stop-gate");
  });

  it("race: a block where the verification command itself dirties the tree (an untracked file appears) before failing is classified race", () => {
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: { test: `${process.execPath} -e "require('fs').writeFileSync('surprise.txt','x'); process.exit(1)"` },
      },
      git: true,
    });
    writeFileSync(join(dir, "src.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBe("block");
    const line = readLedger(dir).find((l) => l.class === "race");
    expect(line, `expected a race line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.hook).toBe("stop-gate");
  });

  it("real: a plain failing command, no standing claim, no timeout, and no tree change is classified real", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBe("block");
    const line = readLedger(dir).find((l) => l.class === "real");
    expect(line, `expected a real line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
  });

  it("stood-down: a stand-down at the counter cap writes one line with class stood-down and the stand-down message's first line as reason", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // baseConfig.stopGate.maxBlocks is 3; a session already blocked 3 times stands down instead of blocking again.
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 3 }));
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("standing down");
    const line = readLedger(dir).find((l) => l.class === "stood-down");
    expect(line, `expected a stood-down line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.hook).toBe("stop-gate");
    expect(line.reason).toContain("standing down");
    expect(r.json.systemMessage.startsWith(line.reason) || r.json.systemMessage === line.reason).toBe(true);
  });

  it("the lock-refusal line: a live lock still held when the hook-timeout budget runs out is classified load-timeout, naming the holder session", () => {
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('.doug/.state/runs.log','x')"` },
        stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
      },
      git: true,
    });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const holderScript = join(dir, ".doug/.state/holder-ledger.mjs");
    writeFileSync(holderScript, "setTimeout(() => {}, 12000);"); // well past both hookTimeoutSec (3s) and stopGate.timeoutMs (10s)
    const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".doug/.state/gate.lock"), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
    try {
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision).toBe("block");
      expect(r.json.reason).toContain("holder-session");
      const line = readLedger(dir).find((l) => l.class === "load-timeout" && l.reason.includes("holder-session"));
      expect(line, `expected a load-timeout lock-refusal line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
      expect(line.hook).toBe("stop-gate");
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("the honoured claim records state.redByDesignClaim = { files, at, agent } (agent is the subagent's id, not its type)", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
      git: true,
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(r.json.decision).toBeUndefined();
    const state = sessionStateOf(dir);
    expect(state.redByDesignClaim).toBeTruthy();
    expect(state.redByDesignClaim.files).toEqual(["tests/a.test.mjs"]);
    expect(typeof state.redByDesignClaim.at).toBe("string");
    expect(Number.isNaN(new Date(state.redByDesignClaim.at).getTime())).toBe(false);
    expect(state.redByDesignClaim.agent).toBe("ag1"); // subagent.id, not "tester" (agent_type)
  });

  it("line shape (main Stop): hook 'stop-gate', at an ISO string, agent null, reason a single line with no session/class leakage, class, and session", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    const lines = readLedger(dir);
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.hook).toBe("stop-gate");
    expect(typeof line.at).toBe("string");
    expect(Number.isNaN(new Date(line.at).getTime())).toBe(false);
    expect(line.agent).toBeNull();
    expect(typeof line.reason).toBe("string");
    expect(line.reason).not.toContain("\n");
    expect(line.reason).toBe(r.json.reason.split("\n")[0]);
    expect(["expected-red", "load-timeout", "race", "real", "stood-down"]).toContain(line.class);
    expect(line.session).toBe("test-session");
  });

  it("line shape (SubagentStop): hook 'subagent-stop' and agent is the agent_type string, not the agent_id", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" }, agent_id: "ag1", agent_type: "coder" }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json.decision).toBe("block");
    const line = readLedger(dir).find((l) => l.hook === "subagent-stop");
    expect(line, `expected a subagent-stop line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.agent).toBe("coder");
    expect(line.session).toBe("test-session");
  });

  it("writes no line at all on a green gate", () => {
    const dir = makeProject({ config: baseConfig, git: true }); // baseConfig's test command exits 0
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json).toBeNull();
    expect(existsSync(join(dir, LEDGER_RELPATH))).toBe(false);
  });

  it("never throws: a blocks.jsonl path that is itself a directory does not stop the gate from blocking normally (the writer skips silently)", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    // A directory sits where the ledger file would be written: the writer's appendFileSync must fail with
    // EISDIR, and that failure must never propagate out of the gate (a hook reader must never throw).
    mkdirSync(join(dir, LEDGER_RELPATH), { recursive: true });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    expect(r.json && r.json.decision, "the gate must still block, never fail open, when the ledger write fails").toBe("block");
    expect(r.json.reason).toContain("Verification failed");
  });

  // Reviewer pass 2 (coordinator brief): gaps the first tester pass left unpinned, against the now-landed
  // implementation (plugins/doug-gates/lib/block-ledger.mjs, imported by stop-gate.mjs).
  describe("reviewer pass 2: per-command coverage, other preconditions, and stand-down sites", () => {
    // Establishes a standing state.redByDesignClaim covering exactly `files` (default: tests/a.test.mjs
    // alone), the same way the existing tests red by design section's T1 does: a tester SubagentStop whose
    // command output fails only on `files` and whose claim covers exactly that.
    function establishStandingClaim(dir, files = ["tests/a.test.mjs"]) {
      const testerInput = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        last_assistant_message: `Ran the new tests; they fail as designed.\n${JSON.stringify({ tests_red_by_design: files })}`,
      };
      const r = runHookScript("stop-gate", testerInput, { dir });
      expect(r.json.decision, `setup: the tester claim must be honoured to establish the standing claim; got ${JSON.stringify(r.json)}`).toBeUndefined();
    }

    it("item 1 (MAJOR): a standing claim covering tests/a.test.mjs does not excuse a second, unrelated failing command that names no test file at all -> real, not expected-red", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      establishStandingClaim(dir, ["tests/a.test.mjs"]);

      // Reconfigure: two commands now fail — a typecheck-shaped one that names no test file at all, and the
      // original one still naming the covered file. Neither "FAIL" nor "failed" appears in the typecheck
      // line, so failingTestFilesFrom finds nothing for it — the claim cannot honestly account for it.
      writeFileSync(
        join(dir, ".doug/config.json"),
        JSON.stringify({
          ...baseConfig,
          commands: {
            typecheck: "echo 'src/x.ts(1,1): error TS2322: Type mismatch'; exit 1",
            test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1",
          },
          stopGate: { commands: ["typecheck", "test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
        }),
      );
      const before = readLedger(dir).length;
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      const after = readLedger(dir);
      expect(after.length, JSON.stringify(after)).toBe(before + 1);
      expect(
        after[after.length - 1].class,
        `the typecheck failure names no test file at all, so the claim cannot cover it; got ${JSON.stringify(after[after.length - 1])}`,
      ).toBe("real");
    });

    it("item 2: a standing claim covering the failing file, plus a dirty protected path, is not expected-red (a pre-verification problem disqualifies it)", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      establishStandingClaim(dir, ["tests/a.test.mjs"]);

      writeFileSync(join(dir, ".env"), "SECRET=1"); // baseConfig.protectedPaths includes ".env"
      const before = readLedger(dir).length;
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(".env");
      const after = readLedger(dir);
      expect(after.length, JSON.stringify(after)).toBe(before + 1);
      expect(after[after.length - 1].class, JSON.stringify(after[after.length - 1])).toBe("real");
    });

    it("item 3: a partial-claim refusal writes one ledger line with class real", () => {
      const dir = makeProject({ config: baseConfig, git: true }); // contextWindow defaults disabled
      const claim = JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test" });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Partial result refused");
      const lines = readLedger(dir);
      expect(lines.length, JSON.stringify(lines)).toBe(1);
      expect(lines[0].class).toBe("real");
      expect(lines[0].hook).toBe("subagent-stop");
      expect(lines[0].reason).toBe(r.json.reason.split("\n")[0]);
    });

    it("item 4: the partial-claim stand-down at the cap writes one stood-down line", () => {
      const dir = makeProject({ config: { ...baseConfig, stopGate: { ...baseConfig.stopGate, maxBlocks: 1 } }, git: true });
      const claim = JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test" });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim };
      const first = runHookScript("stop-gate", input, { dir });
      expect(first.json.decision).toBe("block");
      const before = readLedger(dir).length;
      const second = runHookScript("stop-gate", input, { dir });
      expect(second.json.decision).toBeUndefined();
      expect(second.json.systemMessage).toContain("standing down");
      const after = readLedger(dir);
      expect(after.length, JSON.stringify(after)).toBe(before + 1);
      expect(after[after.length - 1].class).toBe("stood-down");
      expect(after[after.length - 1].reason).toBe(second.json.systemMessage.split("\n")[0]);
    });

    it("item 5: the lock-refusal stand-down at the cap (blocks already at maxBlocks) writes one stood-down line, not load-timeout", () => {
      const dir = makeProject({
        config: {
          ...baseConfig,
          commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('.doug/.state/runs.log','x')"` },
          stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 1, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
        },
        git: true,
      });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "base");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "src/a.ts"), "edited this session");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      // Already at the cap (maxBlocks: 1) before this Stop even runs, so the refusal below must stand down
      // instead of blocking again.
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 1 }));
      const holderScript = join(dir, ".doug/.state/holder-item5.mjs");
      writeFileSync(holderScript, "setTimeout(() => {}, 12000);"); // outlives hookTimeoutSec (3s) and timeoutMs (10s)
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".doug/.state/gate.lock"), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
      try {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json && r.json.decision).toBeUndefined();
        expect(r.json.systemMessage).toContain("standing down");
        const line = readLedger(dir).find((l) => l.class === "stood-down");
        expect(line, `expected a stood-down line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
        expect(readLedger(dir).some((l) => l.class === "load-timeout"), "the cap must win over load-timeout here: one stood-down line, not a load-timeout one").toBe(false);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });

    it("item 6: a command dropped for budget ('not run'), with no failing test named anywhere, is classified load-timeout", () => {
      const runsLogRelpath = ".doug/.state/runs.log";
      const secondCommand = `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"`;
      const dir = makeProject({
        config: {
          ...baseConfig,
          commands: { slow: `${process.execPath} -e "setTimeout(() => {}, 10000)"`, second: secondCommand },
          stopGate: { commands: ["slow", "second"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 2, requireEvidence: false },
        },
        git: true,
      });
      writeFileSync(join(dir, "a.ts"), "x");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision).toBe("block");
      expect(r.json.reason).toContain("not run");
      expect(existsSync(join(dir, runsLogRelpath)), "the dropped command must never have run").toBe(false);
      const line = readLedger(dir).find((l) => l.class === "load-timeout");
      expect(line, `expected a load-timeout line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    });

    it("item 7: the turn-budget stand-down ('Gates are no longer blocking') writes one stood-down line", () => {
      const dir = makeProject({ config: { ...baseConfig, budget: { maxTurns: 1 } }, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ turns: 5 })); // already well past maxTurns
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Gates are no longer blocking");
      const lines = readLedger(dir);
      expect(lines.length, `expected one stood-down line; got ${JSON.stringify(lines)}`).toBe(1);
      expect(lines[0].class).toBe("stood-down");
      expect(lines[0].hook).toBe("stop-gate");
      expect(lines[0].agent).toBeNull();
      expect(lines[0].reason).toBe(r.json.systemMessage.split("\n")[0]);
    });
  });

  // Round 3 (coordinator brief): classifyFinalBlock exercised directly (imported at the top of this file),
  // pinning two preconditions the gate-level fixtures above cannot isolate as cleanly as calling the pure
  // function itself: (a) a budget-dropped command with no timed-out entry still reads load-timeout, and (b)
  // the budgetDeadline-gated race check (review pass 2, item 4 in block-ledger.mjs's own header comment).
  describe("round 3: classifyFinalBlock exercised directly", () => {
    it("(a) a results entry with only skipped: 'budget' (no timedOut entry at all) and no command failure naming a test file classifies as load-timeout", () => {
      const dir = makeProject({});
      const cls = classifyFinalBlock({
        preVerificationProblems: 0,
        evidenceProblemAdded: false,
        commandFailures: [],
        postCommandProblems: 1,
        results: [{ name: "second", command: "echo hi", ok: false, skipped: "budget" }],
        redByDesignClaimFiles: null,
        changedAtStart: null,
        dir,
        budgetDeadline: undefined,
      });
      expect(cls).toBe("load-timeout");
    });

    it("(b) a differing tree classifies as real once budgetDeadline has already passed, and as race while budgetDeadline is still ahead", () => {
      const dir = makeProject({ git: true });
      // changedAtStart is deliberately built to differ from what changedFiles(dir) will read right now: an
      // untracked file exists on disk that changedAtStart never named.
      writeFileSync(join(dir, "untracked.txt"), "x");
      const changedNow = changedFiles(dir);
      expect(changedNow, "setup: the untracked file must actually show up as changed for this test to mean anything").toContain("untracked.txt");
      const changedAtStart = []; // differs from changedNow as a set

      const base = {
        preVerificationProblems: 0,
        evidenceProblemAdded: false,
        commandFailures: [],
        postCommandProblems: 0,
        results: [],
        redByDesignClaimFiles: null,
        changedAtStart,
        dir,
      };

      const past = classifyFinalBlock({ ...base, budgetDeadline: Date.now() - 1 });
      expect(past, "a deadline already blown must skip the race check entirely and fall through to real").toBe("real");

      const future = classifyFinalBlock({ ...base, budgetDeadline: Date.now() + 60000 });
      expect(future, "with budget still ahead, the differing tree must be classified race").toBe("race");
    });
  });
});

// card block-ledger-stood-down-repeats: today every Stop/SubagentStop past the cap (or past the turn budget)
// appends another identical "stood-down" ledger line (evidence: two identical lines two seconds apart for one
// session, 2026-09-17T00:47, session a0f5e4fd). Wanted: at most one stood-down line per session per cause —
// turn-budget (lead only), and the block cap keyed per agent (the partial-claim cap and the verification/
// lock-refusal cap of one agent are the same cause). The record of "already written" lives in the session
// state file, set before the saveState that already precedes each logBlock, and a wrong-shaped marker (a
// string, an array, null) must never throw and must not permanently suppress the line by accident.
describe("card block-ledger-stood-down-repeats", () => {
  const LEDGER_RELPATH = ".doug/.state/blocks.jsonl";
  function readLedger(dir) {
    const file = join(dir, LEDGER_RELPATH);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  function sessionStateOf(dir, sessionId = "test-session") {
    return JSON.parse(readFileSync(join(dir, `.doug/.state/${sessionId}.json`), "utf8"));
  }
  const stoodDownLines = (dir) => readLedger(dir).filter((l) => l.class === "stood-down");

  it("T1 lead cap: state seeded at the cap, Stop run three times: exactly one line, and the stand-down message is still printed on the second and third run", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // baseConfig.stopGate.maxBlocks is 3; a session already blocked 3 times stands down instead of blocking again.
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 3 }));
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    for (const r of [r1, r2, r3]) {
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("standing down");
    }
    expect(stoodDownLines(dir), JSON.stringify(stoodDownLines(dir))).toHaveLength(1);
  });

  it("T2 turn budget: budget exceeded, Stop run three times: exactly one line", () => {
    const dir = makeProject({ config: { ...baseConfig, budget: { maxTurns: 1 } }, git: true });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ turns: 5 })); // already well past maxTurns
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    for (const r of [r1, r2, r3]) expect(r.json.systemMessage).toContain("Gates are no longer blocking");
    expect(stoodDownLines(dir), JSON.stringify(stoodDownLines(dir))).toHaveLength(1);
  });

  it("T3 two causes, one session: the turn-budget stand-down and the lead's cap stand-down each write their own line", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" }, budget: { maxTurns: 1 } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ turns: 5 })); // already well past maxTurns
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.systemMessage).toContain("Gates are no longer blocking");
    expect(stoodDownLines(dir)).toHaveLength(1);

    // Drop the turn budget so the next Stop reaches the lead's block-cap stand-down (a different cause)
    // instead of tripping the turn-budget check again; seed stopBlocks at the cap for that cause.
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: "exit 1" } }));
    const midState = sessionStateOf(dir);
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ ...midState, stopBlocks: 3 }));
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.json.systemMessage).toContain("standing down");
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(2);
  });

  it("T4 per agent: two subagents of one session each at their cap, each SubagentStop run twice: exactly two lines, one per agent", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ agentBlocks: { ag1: 3, ag2: 3 } }));
    const sub1 = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" };
    const sub2 = { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "coder" };
    const results = [
      runHookScript("stop-gate", sub1, { dir }),
      runHookScript("stop-gate", sub1, { dir }),
      runHookScript("stop-gate", sub2, { dir }),
      runHookScript("stop-gate", sub2, { dir }),
    ];
    for (const r of results) {
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("standing down");
    }
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(2);
  });

  it("T5 same agent, two stand-down sites (partial-claim cap, then the verification cap): one line, since they are the same cause for that agent", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ agentBlocks: { ag1: 3 } }));
    const claim = JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test" });
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim }, { dir });
    expect(r1.json.systemMessage).toContain("standing down");
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r2.json.systemMessage).toContain("standing down");
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(1);
  });

  it("T6 two sessions: the same cause stood down twice in each session gives one line per session", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/session-a.json"), JSON.stringify({ stopBlocks: 3 }));
    writeFileSync(join(dir, ".doug/.state/session-b.json"), JSON.stringify({ stopBlocks: 3 }));
    for (const session_id of ["session-a", "session-b"]) {
      const first = runHookScript("stop-gate", { hook_event_name: "Stop", session_id }, { dir });
      expect(first.json.systemMessage).toContain("standing down");
      const second = runHookScript("stop-gate", { hook_event_name: "Stop", session_id }, { dir });
      expect(second.json.systemMessage).toContain("standing down");
    }
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(2);
    expect(lines.map((l) => l.session).sort()).toEqual(["session-a", "session-b"]);
  });

  it.each([
    ["a plain string", "wrong-shape-a-plain-string"],
    ["an array", ["wrong-shape-an-array"]],
    ["null", null],
  ])("T7 wrong-shaped marker: overwriting stoodDownLogged with %s never throws and does not permanently suppress the line", (_label, wrongShape) => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const beforeJson = JSON.stringify({ stopBlocks: 3 });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), beforeJson);
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.systemMessage).toContain("standing down");
    const afterFirst = sessionStateOf(dir);
    expect(afterFirst.stoodDownLogged).toEqual({ "block-cap:lead": true });
    afterFirst.stoodDownLogged = wrongShape;
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(afterFirst));
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.status, "a hook reader must never throw").toBe(0);
    expect(r2.json && r2.json.systemMessage).toContain("standing down");
    const lines = stoodDownLines(dir);
    expect(lines.length, JSON.stringify(lines)).toBeLessThanOrEqual(2);
  });
});

// card gate-output-names-failures: the Stop-gate's captured command output today is a plain last-40-line tail
// (lib/run.mjs `tail`), so a real vitest failure buried under dozens of passing lines shows only the totals,
// with no failing test name (brief F1/F2). R1 (design) adds `failureSummary`, which leads with the vitest
// FAIL/×/→ lines and the totals ahead of the tail, within the same 40-line cap; R2 wires stop-gate.mjs's
// command-failure block to it, leaving `commandFailures` (the untruncated output the tests_red_by_design
// coverage check reads) unchanged. H1-H7 pin the design points; H7 imports `failureSummary` directly and is
// expected red until it exists.
describe("card gate-output-names-failures", () => {
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  // A single command reading a fixture file the test writes into the project dir, so the vitest-shaped
  // output (arrows, ×, ⎯⎯⎯ separators, ANSI codes) never has to survive shell quoting.
  const vitestConfig = () => ({
    ...baseConfig,
    commands: { test: "cat vt-output.txt; exit 1" },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  });

  const checkLines = (n) => Array.from({ length: n }, (_, i) => ` ✓ passing > case ${i + 1} 1ms`).join("\n");
  const stackFrames = (n) => Array.from({ length: n }, (_, i) => `    at Object.<anonymous> (tests/a.test.mjs:${i + 10}:1)`).join("\n");

  // vitest v2.1.9 failure shape (research Q2 / .doug/.state/scratch/vt/out.txt): two named failing tests in
  // tests/a.test.mjs, with ~60 passing checkmark lines ahead of the failure block and a realistic stack trace
  // under each error, so the first FAIL line sits well beyond the last 40 raw lines of the whole output - a
  // plain tail(output, 40) drops it (verified: the raw output here is 113 lines, and tail(*, 40) does not
  // contain the first FAIL line).
  function vitestFailureOutput({ passing = 60 } = {}) {
    return [
      checkLines(passing),
      " ❯ tests/a.test.mjs (3 tests | 2 failed) 4ms",
      "   × sample > fails one 3ms",
      "     → one is not two: expected 1 to be 2 // Object.is equality",
      "   × sample > nested > fails two 0ms",
      "     → boom",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  tests/a.test.mjs > sample > fails one",
      "AssertionError: one is not two: expected 1 to be 2 // Object.is equality",
      stackFrames(15),
      "",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
      "",
      " FAIL  tests/a.test.mjs > sample > nested > fails two",
      "Error: boom",
      stackFrames(15),
      "",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯",
      "",
      " Test Files  1 failed (1)",
      "      Tests  2 failed | 1 passed (3)",
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
  }

  // A single failing command's block reason is `\`<command>\` failed (exit 1):\n<captured output>`
  // (stop-gate.mjs); with only one command configured this is the only problem in the reason, so everything
  // from the marker to the end of the string is that command's captured-output section.
  const MARKER = "failed (exit 1):\n";
  function commandSection(reason) {
    const idx = reason.indexOf(MARKER);
    if (idx === -1) return null;
    return reason.slice(idx + MARKER.length);
  }

  function runFixture(content) {
    const dir = makeEditedProject(vitestConfig());
    writeFileSync(join(dir, "vt-output.txt"), content);
    return runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  }

  it("H1 the block reason names the failing tests, ahead of any passing line", () => {
    const r = runFixture(vitestFailureOutput());
    const reason = r.json && r.json.reason;
    expect(reason, `expected stop-gate to block on the failing command; got ${JSON.stringify(r.json)}`).toBeTruthy();
    expect(reason).toContain(" FAIL  tests/a.test.mjs > sample > fails one");
    expect(reason).toContain("× sample > nested > fails two");
    expect(reason).toContain("→ boom");
    expect(reason).toContain("2 failed | 1 passed");
    const failIdx = reason.indexOf(" FAIL  tests/a.test.mjs > sample > fails one");
    const checkIdx = reason.indexOf("✓");
    if (checkIdx !== -1) {
      expect(failIdx, "the FAIL line must appear before any ✓ line in the reason").toBeLessThan(checkIdx);
    }
  });

  it("H2 the cap holds: at most 40 lines in the failing command's captured-output section", () => {
    const r = runFixture(vitestFailureOutput());
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    expect(section.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("H3 no vitest lines: a command printing 50 plain lines then failing still gives exactly the last 40 lines (today's behaviour)", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { test: `${process.execPath} -e "for(let i=1;i<=50;i++) console.log('line'+i); process.exit(1)"` },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    const lines = section.split("\n");
    expect(lines.length).toBe(40);
    expect(lines[0]).toBe("line11");
    expect(lines[lines.length - 1]).toBe("line50");
  });

  it("H4 many failures: the reason keeps the totals and names how many more, still within the 40-line cap", () => {
    const n = 60;
    const failLines = [];
    for (let i = 1; i <= n; i++) {
      failLines.push(`   × sample > case ${i} 1ms`);
      failLines.push(`     → boom ${i}`);
    }
    const failBlocks = [];
    for (let i = 1; i <= n; i++) {
      failBlocks.push(` FAIL  tests/many.test.mjs > sample > case ${i}`, `Error: boom ${i}`, "");
    }
    const content = [
      checkLines(20),
      ` ❯ tests/many.test.mjs (${n} tests | ${n} failed) 4ms`,
      ...failLines,
      "",
      `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${n} ⎯⎯⎯⎯⎯⎯⎯`,
      "",
      ...failBlocks,
      " Test Files  1 failed (1)",
      `      Tests  ${n} failed (${n})`,
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
    const r = runFixture(content);
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    const lines = section.split("\n");
    expect(lines.length, `must still fit the 40-line cap:\n${section}`).toBeLessThanOrEqual(40);
    expect(section).toContain("more failing tests not shown");
    expect(section).toContain("60 failed");
    // The very first failure-naming line in output order must survive truncation; the last must not - proof
    // that some, not all, of the 60 failures are shown.
    expect(section).toContain("× sample > case 1 ");
    expect(section).not.toContain("case 60");
  });

  it("H5 ANSI escape codes wrapping a kept FAIL line are stripped", () => {
    const content = [
      checkLines(60),
      " ❯ tests/a.test.mjs (1 tests | 1 failed) 1ms",
      "   × sample > fails one 1ms",
      "     → boom",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      "\x1b[31m FAIL  tests/a.test.mjs > sample > fails one\x1b[39m",
      "Error: boom",
      stackFrames(15),
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
    ].join("\n");
    const r = runFixture(content);
    const reason = r.json.reason;
    expect(reason).toContain(" FAIL  tests/a.test.mjs > sample > fails one");
    expect(reason).not.toContain("\x1b");
  });

  it("H6 the tests_red_by_design coverage check still sees the whole output, beyond line 40 of the raw output", () => {
    const claim = (files) => JSON.stringify({ tests_red_by_design: files });
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: {
          test: `${process.execPath} -e "for(let i=1;i<=50;i++) console.log('noise'+i); console.log(' FAIL  tests/a.test.mjs > it'); process.exit(1)"`,
        },
      },
      git: true,
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${claim(["tests/a.test.mjs"])}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(
      r.json && r.json.decision,
      `expected the tests_red_by_design claim to be honoured even though the FAIL line sits beyond line 40 of the raw command output; got ${JSON.stringify(r.json)}`,
    ).toBeUndefined();
  });

  // (coordinator, round 2) H6 alone does not pin R2's own precondition: with only one failing file, that
  // file's one FAIL line always fits in failureSummary's 40-line cap regardless of what `commandFailures`
  // is given, so a mutation that wires `commandFailures` to the *summary* instead of the raw output (M7)
  // survives H6 undetected. H6b forces the overflow path failureSummary itself uses (same shape as H4):
  // 45 failing tests each write a `×`/`→` pair in the leading per-file summary section, well before the
  // later "Failed Tests" section's ` FAIL  <file> > ...` lines - real vitest's own ordering (F2). 45 × 2 =
  // 90 head-candidate lines alone already exceeds failureSummary's overflow budget (maxLines - 3 = 37 at
  // the default cap), so ALL 37 kept head lines come from the × section and not one of the 45 real FAIL
  // lines survives into the 40-line summary - and neither a `×` nor a `→` line contains the substring
  // "FAIL" or "failed" that failingTestFilesFrom (lib/block-ledger.mjs) requires, so a coverage check
  // reading the summary instead of the raw text finds zero test files named at all ("noFile"), not just a
  // missing one, and blocks with "named no test file in its output" - even though every one of the 45
  // claimed files really is red and really is modified in the working tree. Reading the untruncated raw
  // output (R2, the fix) finds all 45 and honours the claim.
  it("H6b (M7) the coverage check must read the raw output, not the 40-line display summary: an overflow of many failing files still honours the claim", () => {
    const claim = (files) => JSON.stringify({ tests_red_by_design: files });
    const n = 45;
    const files = Array.from({ length: n }, (_, i) => `tests/f${String(i + 1).padStart(2, "0")}.test.mjs`);
    const xLines = [];
    for (let i = 1; i <= n; i++) xLines.push(`   × sample > case ${i} 1ms`, `     → boom ${i}`);
    const failLines = [];
    for (let i = 1; i <= n; i++) failLines.push(` FAIL  ${files[i - 1]} > sample > case ${i}`, `Error: boom ${i}`, "");
    const content = [
      ` ❯ tests (${n} tests | ${n} failed) 4ms`,
      ...xLines,
      "",
      `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${n} ⎯⎯⎯⎯⎯⎯⎯`,
      "",
      ...failLines,
      " Test Files  1 failed (1)",
      `      Tests  ${n} failed (${n})`,
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");

    const dir = makeProject({ config: vitestConfig(), git: true });
    mkdirSync(join(dir, "tests"));
    for (const f of files) writeFileSync(join(dir, f), "it fails on purpose");
    writeFileSync(join(dir, "vt-output.txt"), content);
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new tests; they all fail as designed.\n${claim(files)}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(
      r.json && r.json.decision,
      `expected the tests_red_by_design claim (45 files) to be honoured; the coverage check must read the raw command output, not the 40-line display summary, or the whole per-file failure evidence is lost to overflow. got ${JSON.stringify(r.json)}`,
    ).toBeUndefined();
  });

  it("H7 failureSummary: garbage input never throws and always returns a string", async () => {
    // Imported dynamically (not at module scope) so this file's other, unrelated tests keep running even
    // while lib/run.mjs has no `failureSummary` export yet - this test alone fails, at the missing-function
    // call below, which is the expected red.
    const mod = await import("../lib/run.mjs");
    for (const input of [null, undefined, 42, {}, [], "plain string"]) {
      let result;
      expect(() => {
        result = mod.failureSummary(input);
      }, `failureSummary must never throw on ${JSON.stringify(input)}`).not.toThrow();
      expect(typeof result).toBe("string");
    }
  });

  // Review round 1 (coordinator): a blocker (G4, git-hooks.test.mjs) and a major (H10) plus three unpinned
  // mechanisms (H8, H9, H11) in failureSummary's own tail-filler and totals handling, against
  // plugins/doug-gates/lib/run.mjs's real implementation as landed.

  it("H8 tail filler: a short single-failure output still fills the remaining budget from the tail (error message, code frame)", () => {
    // H1's own two-failure, 60-line-padded fixture never reaches the filler branch at all (padding pushes
    // the head+totals size up, and remaining stays small); this fixture is deliberately short - one
    // failure, no padding - so headLines + totalsLines is well under maxLines and `remaining` is large.
    const content = [
      " ❯ tests/a.test.mjs (2 tests | 1 failed) 4ms",
      "   × sample > fails one 3ms",
      "     → one is not two: expected 1 to be 2 // Object.is equality",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  tests/a.test.mjs > sample > fails one",
      "AssertionError: one is not two: expected 1 to be 2 // Object.is equality",
      "",
      " ❯ tests/a.test.mjs:4:55",
      "      2| describe(\"sample\", () => {",
      "      3|   it(\"passes\", () => { expect(1).toBe(1); });",
      "      4|   it(\"fails one\", () => { expect(1, \"one is not two\").toBe(2); });",
      "       |                                                       ^",
      "      5| });",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 1 passed (2)",
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
    const r = runFixture(content);
    const reason = r.json.reason;
    expect(reason, `expected the tail filler (error message) in:\n${reason}`).toContain("AssertionError: one is not two");
    expect(reason, `expected the tail filler (code-frame line) in:\n${reason}`).toContain('it("fails one"');
  });

  it("H9 totals appear exactly once: the tail filler never re-adds an already-kept totals line", () => {
    const r = runFixture(vitestFailureOutput());
    const reason = r.json.reason;
    const occurrences = reason.split("Tests  2 failed | 1 passed").length - 1;
    expect(occurrences, `expected the totals line to appear exactly once in:\n${reason}`).toBe(1);
  });

  it("H10 (reviewer MAJOR) totals flood: a pnpm -r --stream shape with many per-package totals-looking lines does not crowd out the real failure, and the totals are capped to the last pair", () => {
    const repeatedTotals = [];
    for (let i = 0; i < 20; i++) repeatedTotals.push(" Test Files  1 failed (1)", "      Tests  1 failed (1)");
    const content = [
      ...repeatedTotals,
      "   × sample > fails one 1ms",
      "     → boom",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  packages/p7/tests/x.test.ts > t",
      "Error: boom",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
    const r = runFixture(content);
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    expect(section).toContain(" FAIL  packages/p7/tests/x.test.ts > t");
    expect(section).toContain("× sample > fails one");
    const lines = section.split("\n");
    expect(lines.length, `must still fit the 40-line cap:\n${section}`).toBeLessThanOrEqual(40);
    const totalsOccurrences = lines.filter((l) => /^\s*(Test Files|Tests)\s/.test(l)).length;
    expect(
      totalsOccurrences,
      `the totals must be capped to the last pair, not flooded by every package's own summary:\n${section}`,
    ).toBeLessThanOrEqual(2);
  });

  it("H11 overflow count: the dropped-test count is (total - kept), not inflated by also counting each dropped ×'s own → message line", () => {
    // A pure-×/→ fixture (no separate "Failed Tests"/FAIL section): the only way to build a case where the
    // dropped portion actually contains → lines (so a regex that wrongly also matches "→" would over-count)
    // is to overflow entirely within the × section itself, exactly like the real implementation's overflow
    // does whenever the × section alone already exceeds the head budget (same fact H4/H6b rely on).
    const n = 60;
    const lines = [];
    for (let i = 1; i <= n; i++) lines.push(`   × sample > case ${i} 1ms`, `     → boom ${i}`);
    lines.push(" Test Files  1 failed (1)", `      Tests  ${n} failed (${n})`, "   Start at  08:34:30", "   Duration  242ms");
    const r = runFixture(lines.join("\n"));
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    const keptX = (section.match(/^\s*×\s/gm) || []).length;
    const overflowMatch = section.match(/…\s*(\d+)\s*more failing tests not shown/);
    expect(overflowMatch, `expected an overflow line in:\n${section}`).toBeTruthy();
    const overflowCount = Number(overflowMatch[1]);
    expect(
      overflowCount,
      `overflow count must be ${n} - ${keptX} kept = ${n - keptX}, not inflated by counting → lines too:\n${section}`,
    ).toBe(n - keptX);
  });
});

// card stop-gate-credits-pre-commit: the pre-commit hook (.githooks/pre-commit, tested in
// git-hooks.test.mjs) writes a machine-readable record of its own run to
// .doug/.state/pre-commit/last-run.json (lead's design: { version: 1, tree, ok, at, commands: [{ name,
// command, exit, durationMs }] }). The Stop gate credits a passing record instead of re-running the same
// commands when the working tree has no changes beyond HEAD, the record parses, is version 1, ok, matches
// HEAD's tree, every command exited 0, and its command list equals resolveCommands(cfg) in order — crediting
// pushes `{ name, command, ok: true, credited: "pre-commit" }` into results and runs no command, but every
// other check (evidence, red-by-design, state.verified, the block ledger) still runs exactly as today. S7
// (the vendored copy staying byte-identical) is already covered generically by
// plugins/doug-gates/tests/vendored-copies.test.mjs; not duplicated here.
describe("stop-gate credits a passing pre-commit record (card stop-gate-credits-pre-commit)", () => {
  // A cheap, observable command: it writes ran.marker so a test can tell whether it actually ran, the same
  // convention the session-start-baseline tests above use.
  const preCommitConfig = () => ({
    ...baseConfig,
    commands: { test: `${process.execPath} -e "require('fs').writeFileSync('ran.marker','1')"` },
  });
  const commitAll = (dir, message) => {
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
  };
  const headTree = (dir) => execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  const writeRecord = (dir, record) => {
    mkdirSync(join(dir, ".doug/.state/pre-commit"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/pre-commit/last-run.json"), JSON.stringify(record));
  };
  // A record matching HEAD exactly, for the given cfg's resolved commands (here always the single "test"
  // command preCommitConfig defines).
  const passingRecord = (dir, cfg) => ({
    version: 1,
    tree: headTree(dir),
    ok: true,
    at: new Date().toISOString(),
    commands: [{ name: "test", command: cfg.commands.test, exit: 0, durationMs: 5 }],
  });
  const markerRan = (dir) => existsSync(join(dir, "ran.marker"));
  // Marks this session as having made an edit (state.editedFiles), so `onlyIfEdited`'s "nothing changed"
  // early exit never fires before the credit check is reached — the tree can still be clean (as it is right
  // after a commit) while the session did make changes this turn.
  const markEdited = (dir) => runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });

  it("S1: a clean tree whose HEAD tree matches a passing pre-commit record skips the commands, allows, and sets state.verified", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    markEdited(dir);
    writeRecord(dir, passingRecord(dir, cfg));

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json, JSON.stringify(r.json)).toBeNull(); // allowed
    expect(markerRan(dir), "the credited command must not run").toBe(false);
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.results[0]).toMatchObject({ name: "test", ok: true, credited: "pre-commit" });
    expect(state.verified, "state.verified must be set on a credited green gate").toBeTruthy();
  });

  it("S1 (evidence still applies): a credited run still blocks a session with changes and no test command of its own on record", () => {
    const cfg = preCommitConfig();
    const cfgEvidence = { ...cfg, stopGate: { ...cfg.stopGate, requireEvidence: true } };
    const dir = makeProject({ config: cfgEvidence, git: true });
    commitAll(dir, "init");
    markEdited(dir);
    writeRecord(dir, passingRecord(dir, cfgEvidence));

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("No test or verify command ran in this session");
    expect(markerRan(dir), "credited commands still must not run just because evidence is missing").toBe(false);
  });

  it("S2: a dirty tree after the commit still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    writeRecord(dir, passingRecord(dir, cfg));
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a dirty tree must not be credited").toBe(true);
  });

  it("S3: a record with ok: false (a non-zero exit) still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg);
    record.ok = false;
    record.commands[0].exit = 1;
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a failing pre-commit record must not be credited").toBe(true);
  });

  // Round 2 reviewer finding: S3 above flips `ok` and a command's `exit` together, so the credit check
  // could read the exit codes alone (dropping `if (record.ok !== true) return null;`) and still pass S3
  // (every command's exit is 0 elsewhere, but the flipped one's exit is 1, so the exit check alone already
  // catches it). This is the shape the hook now actually writes for a dirty working tree (a working-tree/
  // index mismatch, or an untracked file): ok:false with every command still exited 0 (the commands
  // themselves passed; the tree just isn't what was recorded). The `ok` field must be checked in its own
  // right, not inferred from the commands' exit codes.
  it("S3b: a record with ok:false but every command exited 0 (the dirty-tree shape) still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg); // every command exit: 0
    record.ok = false; // e.g. "working tree differs from the committed index"
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "an ok:false record must not be credited even when every command exited 0").toBe(true);
  });

  it("S4: a record whose command list differs from the configured commands still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg);
    record.commands = [{ name: "other", command: "echo hi", exit: 0, durationMs: 5 }];
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a mismatched command list must not be credited").toBe(true);
  });

  it("S5a: a record that is not JSON still runs the commands, without crashing the hook", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    mkdirSync(join(dir, ".doug/.state/pre-commit"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/pre-commit/last-run.json"), "not json{{{");
    markEdited(dir);

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0); // the reader never throws (a hook reader must never throw)
    expect(markerRan(dir), "a corrupt (non-JSON) record must not be credited").toBe(true);
  });

  it("S5b: a record of the wrong shape (commands not an array, tree a number) still runs the commands, without crashing the hook", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    writeRecord(dir, { version: 1, tree: 12345, ok: true, at: new Date().toISOString(), commands: "nope" });
    markEdited(dir);

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    expect(markerRan(dir), "a malformed-shape record must not be credited").toBe(true);
  });

  it("S6: a record for a different (stale) tree still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg);
    record.tree = "0".repeat(40);
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a stale-tree record must not be credited").toBe(true);
  });
});

// card ratchet-pre-commit-credit: a credited pre-commit record runs no command, so the count check must run
// on the totals the hook recorded per command (record entry `totals`: the parseTotals result object) against
// state.testTotals, through the same code path, block text, waiver rule and conflict rule as a real run.
// A baselined command whose entry has no readable totals is not credited (fail closed to running).
describe("stop-gate count check on a credited pre-commit record (card ratchet-pre-commit-credit)", () => {
  const LAST_GREEN = ".doug/.state/test-totals.json";
  const WAIVERS = ".doug/.state/test-count-waivers";
  const T = { total: 137, skipped: 0, todo: 0 };
  const CMD = `${process.execPath} -e "require('fs').writeFileSync('ran.marker','1')"`;
  const okTotals = (t) => ({ status: "ok", totals: t });

  // Clean committed tree, edited session, state.testTotals seeded for CMD (unless baseline === null), and a
  // record matching HEAD whose single entry carries `entry` fields (e.g. totals).
  // `waiverCommitMsg`: state.baselineHead is pinned to the init commit and a further empty commit with that
  // message lands after it, so the message is a commit "since the session's baseline".
  function makeCredit({ baseline = T, entry = {}, waiverFile, lastGreen, waiverCommitMsg } = {}) {
    const cfg = { ...baseConfig, commands: { test: CMD } };
    const dir = makeProject({ config: cfg, git: true });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    if (waiverCommitMsg) execFileSync("git", ["commit", "-q", "--allow-empty", "-m", waiverCommitMsg], { cwd: dir });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    {
      const state = loadState(dir, "test-session");
      if (baseline !== null) state.testTotals = { [CMD]: baseline };
      if (waiverCommitMsg) state.baselineHead = baseHead;
      saveState(dir, "test-session", state);
    }
    mkdirSync(join(dir, ".doug/.state/pre-commit"), { recursive: true });
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(
      join(dir, ".doug/.state/pre-commit/last-run.json"),
      JSON.stringify({ version: 1, tree, ok: true, at: new Date().toISOString(), commands: [{ name: "test", command: CMD, exit: 0, durationMs: 5, ...entry }] }),
    );
    if (waiverFile !== undefined) writeFileSync(join(dir, WAIVERS), waiverFile);
    if (lastGreen !== undefined) writeFileSync(join(dir, LAST_GREEN), JSON.stringify(lastGreen));
    return dir;
  }
  const stopGate = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const ranMarker = (dir) => existsSync(join(dir, "ran.marker"));
  const state = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));

  it("C1: a credited run whose recorded total dropped blocks with the regression text; no verified tree, last-green unchanged; command not run", () => {
    const record = { [CMD]: T };
    const dir = makeCredit({ entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) }, lastGreen: record });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("test count regressed");
    expect(r.json.reason).toContain("total dropped from");
    expect(ranMarker(dir), "the credited command must not run").toBe(false);
    expect(state(dir).verified ?? null).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, LAST_GREEN), "utf8"))).toEqual(record);
  });

  it("C2: a credited run whose recorded skipped rose blocks with \"skipped rose from\"; command not run", () => {
    const dir = makeCredit({ baseline: { total: 137, skipped: 2, todo: 0 }, entry: { totals: okTotals({ total: 137, skipped: 5, todo: 0 }) } });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("skipped rose from");
    expect(ranMarker(dir)).toBe(false);
  });

  it("C3: a covering waiver passes a count-red credit; still credited, command not run", () => {
    const dir = makeCredit({
      entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) },
      waiverFile: "test-count-waiver: total=-6 skipped=0 todo=0; removed the obsolete suite\n",
    });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir), "the credited command must not run").toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
  });

  it("R2: a count-red credit covered by a waiver line in a commit message since the session's baseline passes; credited, command not run", () => {
    const dir = makeCredit({
      entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) },
      waiverCommitMsg: "prune tests\n\ntest-count-waiver: total=-6 skipped=0 todo=0; removed the obsolete suite\n",
    });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir), "the credited command must not run").toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
  });

  it("R2b (fixture check): the same drop with a non-covering commit-message waiver blocks", () => {
    const dir = makeCredit({
      entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) },
      waiverCommitMsg: "test-count-waiver: total=-5 skipped=0 todo=0; wrong number",
    });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("total dropped from");
  });

  it("C4: a record entry with no totals, for a command with a baseline, is not credited: the command runs", () => {
    const dir = makeCredit({ entry: {} });
    stopGate(dir);
    expect(ranMarker(dir), "a baselined command without recorded totals must run, not be credited").toBe(true);
  });

  it("C4b: a recorded {status:\"none\"} for a baselined command is not credited either", () => {
    const dir = makeCredit({ entry: { totals: { status: "none" } } });
    stopGate(dir);
    expect(ranMarker(dir)).toBe(true);
  });

  it("C4 (list baseline): a record entry with no totals, for a command with a list-shaped baseline [T], is not credited: the command runs", () => {
    const dir = makeCredit({ baseline: [T], entry: {} });
    stopGate(dir);
    expect(ranMarker(dir), "a list-baselined command without recorded totals must run, not be credited").toBe(true);
  });

  it("C4b (list baseline): a recorded {status:\"none\"} for a command with a list-shaped baseline [T] is not credited either", () => {
    const dir = makeCredit({ baseline: [T], entry: { totals: { status: "none" } } });
    stopGate(dir);
    expect(ranMarker(dir)).toBe(true);
  });

  for (const [label, totals] of [
    ["a string", "junk"],
    ["ok with non-numeric totals", { status: "ok", totals: { total: "many" } }],
  ]) {
    it(`C5: garbage recorded totals (${label}) for a baselined command: not credited, command runs, no throw, no fail-open message`, () => {
      const dir = makeCredit({ entry: { totals } });
      const r = stopGate(dir);
      expect(r.status).toBe(0);
      expect(ranMarker(dir), "garbage totals must not be credited").toBe(true);
      expect(JSON.stringify(r.json) ?? "").not.toMatch(/fail.?open|hook error/i);
    });
  }

  // C6 (an old pin) is replaced by the ADR 0013 cases G1-G5 below: a recorded conflict no longer blocks on its
  // own; the list of summaries is compared with the baseline's list under the new rules.
  const list2 = (a, b) => ({ status: "ok", summaries: [a, b], totals: { total: a.total + b.total, skipped: a.skipped + b.skipped, todo: a.todo + b.todo } });
  const P1 = { total: 100, skipped: 0, todo: 0 };
  const P2 = { total: 37, skipped: 0, todo: 0 };
  const LIST_BASE = [P1, P2];

  it("G1: a credited 2-summary list against a 2-summary baseline with equal sums is credited, command not run, last-green holds the list", () => {
    const dir = makeCredit({ baseline: LIST_BASE, entry: { totals: list2(P1, P2) } });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir)).toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
    expect(JSON.parse(readFileSync(join(dir, LAST_GREEN), "utf8"))[CMD]).toEqual(LIST_BASE);
  });

  it("G2: the same list whose summed total dropped blocks with the regression text, and a matching waiver covers it", () => {
    const dropped = list2(P1, { total: 31, skipped: 0, todo: 0 });
    const r = stopGate(makeCredit({ baseline: LIST_BASE, entry: { totals: dropped } }));
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("test count regressed");
    expect(r.json.reason).toContain("total dropped from");
    const w = stopGate(makeCredit({ baseline: LIST_BASE, entry: { totals: dropped }, waiverFile: "test-count-waiver: total=-6 skipped=0 todo=0; removed the obsolete suite\n" }));
    expect(w.json, JSON.stringify(w.json)).toBeNull();
  });

  it("G3: a credited 2-summary list against a 1-summary baseline blocks, naming 1 and 2; no waiver covers it; command not run", () => {
    const dir = makeCredit({
      baseline: [{ total: 137, skipped: 0, todo: 0 }],
      entry: { totals: list2(P1, P2) },
      waiverFile: "test-count-waiver: total=0 skipped=0 todo=0; same sum\ntest-count-waiver: total=-100 skipped=0 todo=0; x\n",
    });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toMatch(/summar/i);
    expect(r.json.reason).toMatch(/\b1\b/);
    expect(r.json.reason).toMatch(/\b2\b/);
    expect(ranMarker(dir)).toBe(false);
    expect(state(dir).verified ?? null).toBeNull();
  });

  it("G4: an old-shape baseline {total,skipped,todo} is a list of one: a credited 2-summary list against it blocks the same way", () => {
    const r = stopGate(makeCredit({ baseline: T, entry: { totals: list2(P1, P2) } }));
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toMatch(/summar/i);
  });

  it("G5: an old recorded {status:conflict, summaries} is read as that list: credited against a matching 2-summary baseline", () => {
    const dir = makeCredit({ baseline: LIST_BASE, entry: { totals: { status: "conflict", summaries: [P1, P2] } } });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir)).toBe(false);
  });

  it("G6: a 2-summary list recorded for a command with no baseline is credited and never blocks", () => {
    const dir = makeCredit({ baseline: null, entry: { totals: list2(P1, P2) } });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir)).toBe(false);
  });

  it("C7: a green credit with ok totals equal to the baseline passes, runs nothing, and writes the recorded totals to last-green", () => {
    const dir = makeCredit({ entry: { totals: okTotals(T) } });
    expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir)).toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
    // ADR 0013: the last-green entry is the list of summaries (here a list of one).
    expect(JSON.parse(readFileSync(join(dir, LAST_GREEN), "utf8"))[CMD]).toEqual([T]);
  });

  it("C8: a command with no baseline and no recorded totals still credits as today", () => {
    const dir = makeCredit({ baseline: null, entry: {} });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir), "no baseline: credited, not run").toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
  });
});

describe("card test-count-ratchet (end to end)", () => {
  const CMD = "cat summary.txt";
  const LAST_GREEN = ".doug/.state/test-totals.json";
  const WAIVERS = ".doug/.state/test-count-waivers";
  const T = { total: 137, skipped: 0, todo: 0 }; // the session's baseline unless a case says otherwise

  // The vitest summary block, colour off, for the given counts (total includes skipped and todo).
  const summary = ({ total, skipped = 0, todo = 0 }) => {
    const segs = [];
    if (total - skipped - todo > 0) segs.push(`${total - skipped - todo} passed`);
    if (skipped) segs.push(`${skipped} skipped`);
    if (todo) segs.push(`${todo} todo`);
    return ` Test Files  1 passed (1)\n      Tests  ${segs.join(" | ")} (${total})\n   Start at  08:34:30\n   Duration  242ms\n`;
  };
  const waiver = (t, s, d, reason = "removed the obsolete suite") => `test-count-waiver: total=${t} skipped=${s} todo=${d}; ${reason}`;

  // A real session, through the real hook scripts: last-green record (optional) -> SessionStart -> edits ->
  // optional commit carrying a waiver line -> the command's output on disk. Returns the project dir.
  function makeCountProject({ lastGreen, output, commitMsg, preBaselineCommitMsg, waiverFile, waiverFileAsDir, command = CMD } = {}) {
    const cfg = { ...baseConfig, commands: { test: command } };
    const dir = makeProject({ config: cfg, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    if (preBaselineCommitMsg) execFileSync("git", ["commit", "-q", "--allow-empty", "-m", preBaselineCommitMsg], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    if (lastGreen !== undefined) writeFileSync(join(dir, LAST_GREEN), typeof lastGreen === "string" ? lastGreen : JSON.stringify(lastGreen));
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    if (waiverFileAsDir) mkdirSync(join(dir, WAIVERS));
    else if (waiverFile !== undefined) writeFileSync(join(dir, WAIVERS), waiverFile);
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    if (commitMsg) {
      execFileSync("git", ["add", "src/a.ts"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", commitMsg], { cwd: dir });
      writeFileSync(join(dir, "src/b.ts"), "edited after the commit"); // keep a dirty change so the gate still has work
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/b.ts" } }, { dir });
    }
    if (output !== undefined) writeFileSync(join(dir, "summary.txt"), output);
    return dir;
  }
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
  const sessionState = (dir) => readJson(dir, ".doug/.state/test-session.json");
  const traceReasons = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((l) => l.reason).filter((x) => typeof x === "string");
  };
  const green = (r) => {
    expect(r.json, "expected an allow with no message").toBeNull();
  };
  const blocked = (r) => {
    expect(r.json && r.json.decision).toBe("block");
    return r.json.reason;
  };

  describe("SessionStart copies the last-green record (D1)", () => {
    it("copies the last-green record into state.testTotals in the same write as the baseline", () => {
      const record = { [CMD]: { total: 137, skipped: 4, todo: 2 } };
      const dir = makeCountProject({ lastGreen: record });
      const state = sessionState(dir);
      expect(state.testTotals).toEqual(record);
      expect(state.baselineSource).toBe("session-start");
    });
    it("leaves state.testTotals null when there is no record, and does not fail", () => {
      const dir = makeCountProject({});
      const state = sessionState(dir);
      expect(state).toHaveProperty("testTotals", null);
      expect(state.baseline).not.toBeNull();
    });
    it("never overwrites a non-null state.testTotals", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir }); // creates the state file, baseline still null
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: 50, skipped: 1, todo: 1 } };
      saveState(dir, "test-session", state);
      writeFileSync(join(dir, LAST_GREEN), JSON.stringify({ [CMD]: { total: 999, skipped: 0, todo: 0 } }));
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      const after = sessionState(dir);
      expect(after.baseline).not.toBeNull(); // this fire did capture the baseline...
      expect(after.testTotals).toEqual({ [CMD]: { total: 50, skipped: 1, todo: 1 } }); // ...and left the existing totals alone
    });
    it("a garbage last-green file leaves state.testTotals null, exits 0, prints no fail-open message", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, LAST_GREEN), "{{{ not json \u0000\u0001");
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(sessionState(dir).testTotals).toBeNull();
    });
    it("a last-green path that is a directory leaves state.testTotals null and does not fail", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, LAST_GREEN), { recursive: true });
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(sessionState(dir).testTotals).toBeNull();
    });
  });

  describe("the block (D6)", () => {
    it("a dropped test blocks and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) }); // skipped and todo unchanged at 0
      const reason = blocked(stop(dir));
      expect(reason).toContain("137");
      expect(reason).toContain("131");
      expect(reason).not.toContain("failed (exit"); // a count problem is not a failed command (D9)
    });
    it("an added it.skip blocks (skipped rose, total unchanged) and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 11, todo: 0 } }, output: summary({ total: 137, skipped: 19 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("11");
      expect(reason).toContain("19");
    });
    it("a todo that rose blocks (total and skipped unchanged) and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 0, todo: 21 } }, output: summary({ total: 137, todo: 29 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("21");
      expect(reason).toContain("29");
    });
    it("a rise in total with skipped and todo falling passes", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 19, todo: 21 } }, output: summary({ total: 140, skipped: 11, todo: 12 }) });
      green(stop(dir));
    });
    it("unchanged totals pass", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 4, todo: 2 } }, output: summary({ total: 137, skipped: 4, todo: 2 }) });
      green(stop(dir));
    });
    it("a blocked count records no verified tree and leaves the last-green record as it was (D9)", () => {
      const record = { [CMD]: T };
      const dir = makeCountProject({ lastGreen: record, output: summary({ total: 131 }) });
      blocked(stop(dir));
      expect(sessionState(dir).verified ?? null).toBeNull();
      expect(readJson(dir, LAST_GREEN)).toEqual(record);
    });
    it("compares only the same command's baseline: a command with no entry gets no check, logged (D2)", () => {
      const dir = makeCountProject({ lastGreen: { "some other command": T }, output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
    });
    it("a session cannot lower its own bar: the gate compares against state, not the last-green file", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) });
      // Another session goes green at 131 after this one started and rewrites the shared record.
      writeFileSync(join(dir, LAST_GREEN), JSON.stringify({ [CMD]: { total: 131, skipped: 0, todo: 0 } }));
      const reason = blocked(stop(dir));
      expect(reason).toContain("137");
      expect(sessionState(dir).testTotals).toEqual({ [CMD]: T });
    });
  });

  describe("the last-green record (D1)", () => {
    it("a green run writes its totals for the command", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 140 }) });
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([{ total: 140, skipped: 0, todo: 0 }]); // ADR 0013: a list
    });
    it("a first green run with no baseline creates the record", () => {
      const dir = makeCountProject({ output: summary({ total: 12, skipped: 1 }) });
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([{ total: 12, skipped: 1, todo: 0 }]); // ADR 0013: a list
    });
    it("a red run (command exits non-zero) writes no record", () => {
      const dir = makeCountProject({ output: summary({ total: 12 }), command: "cat summary.txt; exit 1" });
      const reason = blocked(stop(dir));
      expect(reason).toContain("failed (exit 1)");
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
    });
    it("a green run whose output has no summary writes no entry", () => {
      const dir = makeCountProject({ output: "all fine\n" });
      green(stop(dir));
      const has = existsSync(join(dir, LAST_GREEN)) && readJson(dir, LAST_GREEN)[CMD] !== undefined;
      expect(has).toBe(false);
    });
  });

  describe("waivers (D7)", () => {
    const dropped = () => ({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) }); // delta: total=-6 skipped=0 todo=0
    it("a covering waiver in a commit message since the baseline passes", () => {
      green(stop(makeCountProject({ ...dropped(), commitMsg: `prune tests\n\n${waiver("-6", "0", "0")}\n` })));
    });
    it("fixture check: with a commit since the baseline the gate still runs the command (a red command blocks)", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }), commitMsg: "some commit", command: "cat summary.txt; exit 1" });
      expect(blocked(stop(dir))).toContain("failed (exit 1)");
    });
    it("a covering waiver in the waiver file passes", () => {
      green(stop(makeCountProject({ ...dropped(), waiverFile: `# waivers\n${waiver("-6", "+0", "-0")}\n` })));
    });
    it("a waiver that differs from the actual delta in total only does not pass", () => {
      const reason = blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-5", "0", "0") })));
      expect(reason).toContain("131");
    });
    it("a waiver-file line that differs in total only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), waiverFile: waiver("-7", "0", "0") + "\n" })));
    });
    it("a waiver that differs in skipped only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-6", "+1", "0") })));
    });
    it("a waiver that differs in todo only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-6", "0", "-1") })));
    });
    it("a waiver with an empty reason does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: "test-count-waiver: total=-6 skipped=0 todo=0; " })));
      blocked(stop(makeCountProject({ ...dropped(), waiverFile: "test-count-waiver: total=-6 skipped=0 todo=0;\n" })));
    });
    it("a waiver in a commit made before the session's baseline does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), preBaselineCommitMsg: waiver("-6", "0", "0") })));
    });
    it("a covering waiver passes a skipped rise; one number off does not (the delta is now minus baseline)", () => {
      const rose = { lastGreen: { [CMD]: { total: 137, skipped: 11, todo: 0 } }, output: summary({ total: 137, skipped: 19 }) };
      green(stop(makeCountProject({ ...rose, commitMsg: waiver("0", "+8", "0") })));
      blocked(stop(makeCountProject({ ...rose, commitMsg: waiver("0", "+7", "0") })));
    });
    it("an unreadable or garbage waiver file never throws: the gate still blocks on the count", () => {
      const garbage = makeCountProject({ ...dropped(), waiverFile: "\u0000\u0001\u0002 not a waiver �\n" });
      expect(blocked(stop(garbage))).toContain("131");
      const asDir = makeCountProject({ ...dropped(), waiverFileAsDir: true });
      expect(blocked(stop(asDir))).toContain("131");
    });
  });

  // ADR 0013 replaces the D5 "conflicting summaries fail closed" describe: differing summaries are an ordered
  // list, compared with the baseline's list (one entry per Tests line). Shapes: state.testTotals[cmd] and the
  // last-green entry are arrays [{total,skipped,todo}, ...]; the old {total,skipped,todo} is read as a list of one.
  describe("per-package summaries: the baseline is a list (ADR 0013)", () => {
    const P1 = { total: 100, skipped: 0, todo: 0 };
    const P2 = { total: 37, skipped: 0, todo: 0 };
    const two = [P1, P2];
    const out2 = (a, b) => summary(a) + summary(b);
    const countNotes = (dir) => {
      const file = join(dir, ".doug/.state/trace/test-session.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === "CountCheck");
    };

    it("(a) baseline of 2 summaries, run prints 2 whose sums hold: passes, and last-green keeps the 2-entry list", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, P2) });
      expect(sessionState(dir).testTotals[CMD]).toEqual(two); // fixture check: the list reached state as written
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual(two);
    });
    it("(a2) a rise in the summed total with the same number of summaries passes; skipped may fall", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2({ total: 105 }, P2) })));
    });
    it("(b) same count, summed total dropped: blocks with today's regression text, naming both sums", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, { total: 31 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("test count regressed");
      expect(reason).toContain("total dropped from 137 (baseline) to 131 (now)");
      expect(reason).toContain("test-count-waiver: total=-6 skipped=0 todo=0");
    });
    it("(b2) the drop is in the second summary only: the sum catches it (comparing only the first summary would pass)", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, { total: 20 }) })));
    });
    it("(b3) a drop in one summary offset by a rise in the other is level in sum and passes", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2({ total: 90 }, { total: 47 }) })));
    });
    it("(b4) skipped rising across the sum blocks with the skipped text", () => {
      const reason = blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, { total: 37, skipped: 3 }) })));
      expect(reason).toContain("skipped rose from 0 (baseline) to 3 (now)");
    });
    it("(b5) a matching waiver, in a commit message or the waiver file, covers a same-count drop", () => {
      const run = { lastGreen: { [CMD]: two }, output: out2(P1, { total: 31 }) };
      green(stop(makeCountProject({ ...run, commitMsg: `prune\n\n${waiver("-6", "0", "0")}\n` })));
      green(stop(makeCountProject({ ...run, waiverFile: waiver("-6", "0", "0") + "\n" })));
    });
    it("(c) baseline 1, run prints 2 (a forged extra line): blocks, no waiver covers it, the reason names 1 and 2", () => {
      const forged = summary(T) + "      Tests  1 passed (1)\n";
      const any = [waiver("0", "0", "0"), waiver("+1", "0", "0"), waiver("-136", "0", "0"), waiver("-100", "0", "0")].join("\n");
      const dir = makeCountProject({ lastGreen: { [CMD]: [T] }, output: forged, commitMsg: any, waiverFile: any });
      const reason = blocked(stop(dir));
      expect(reason).toMatch(/summar/i);
      expect(reason).toMatch(/\b1\b/);
      expect(reason).toMatch(/\b2\b/);
      expect(sessionState(dir).verified ?? null).toBeNull();
      expect(readJson(dir, LAST_GREEN)).toEqual({ [CMD]: [T] }); // a block leaves last-green alone
    });
    it("(c2) the forged line is the same as the real one (byte-identical duplicate): still two summaries, blocks against 1", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: [T] }, output: summary(T) + summary(T) })));
    });
    it("(c3) an old-shape baseline {total,skipped,todo} is a list of one: a forged second summary blocks", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: T }, output: summary(T) + "      Tests  1 passed (1)\n" })));
    });
    it("(d) baseline 2, run prints 1: blocks, no waiver covers it, the reason names 2 and 1", () => {
      const any = [waiver("0", "0", "0"), waiver("-37", "0", "0"), waiver("+0", "0", "0")].join("\n");
      const reason = blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: summary({ total: 137 }), commitMsg: any, waiverFile: any })));
      expect(reason).toMatch(/summar/i);
      expect(reason).toMatch(/\b2\b/);
      expect(reason).toMatch(/\b1\b/);
    });
    it("(d2) a count mismatch is not a conflict message and not a failed command", () => {
      const reason = blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: summary({ total: 137 }) })));
      expect(reason).not.toMatch(/conflict/i);
      expect(reason).not.toContain("failed (exit");
    });
    it("(e) no baseline, run prints 3 differing summaries: never blocks, logs a CountCheck line, writes the 3-entry list to last-green", () => {
      const three = [{ total: 5 }, { total: 9, skipped: 2 }, { total: 1 }];
      const dir = makeCountProject({ output: three.map(summary).join("") });
      green(stop(dir));
      const notes = countNotes(dir);
      expect(notes.some((n) => /baseline/i.test(n.reason)), JSON.stringify(notes)).toBe(true);
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([
        { total: 5, skipped: 0, todo: 0 },
        { total: 9, skipped: 2, todo: 0 },
        { total: 1, skipped: 0, todo: 0 },
      ]);
    });
    it("(e1) no baseline: the CountCheck trace line carries each summary's values (ADR 0013), not only a count", () => {
      const dir = makeCountProject({ output: summary({ total: 311 }) + summary({ total: 523 }) });
      green(stop(dir));
      const notes = countNotes(dir).filter((n) => /baseline/i.test(n.reason));
      expect(notes.length, JSON.stringify(countNotes(dir))).toBeGreaterThan(0);
      expect(notes[0].reason).toContain("311");
      expect(notes[0].reason).toContain("523");
    });
    it("(e2) no baseline, a forged-looking 1 and 137 pair never blocks either", () => {
      green(stop(makeCountProject({ output: `      Tests  1 passed (1)\n${summary(T)}` })));
    });
    it("(e3) a baseline for a different command is no baseline: 3 differing summaries pass", () => {
      green(stop(makeCountProject({ lastGreen: { "some other command": two }, output: [5, 9, 1].map((n) => summary({ total: n })).join("") })));
    });
    it("(f) an old-shape baseline {total,skipped,todo} and a run printing 1 summary works as today: equal passes, a drop blocks, and a waiver covers it", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: T }, output: summary(T) })));
      const dropped = { lastGreen: { [CMD]: T }, output: summary({ total: 131 }) };
      expect(blocked(stop(makeCountProject(dropped)))).toContain("total dropped from 137 (baseline) to 131 (now)");
      green(stop(makeCountProject({ ...dropped, commitMsg: waiver("-6", "0", "0") })));
    });
    it("(f2) after a green run the old-shape baseline is rewritten as the list of one", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 140 }) });
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([{ total: 140, skipped: 0, todo: 0 }]);
    });
    it("(h) a garbage list baseline (a non-numeric entry, an empty list) is no baseline: no throw, no block, trace says so", () => {
      for (const bad of [[], [P1, { total: "many" }], [P1, null]]) {
        const dir = makeCountProject({ lastGreen: { [CMD]: bad }, output: out2(P1, { total: 1 }) });
        green(stop(dir));
        expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x)), JSON.stringify(bad)).toBe(true);
      }
    });
    it("(i) a run printing the same number of summaries as an unrelated shorter list is not mistaken: baseline 3, run prints 2 blocks", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: [P1, P2, { total: 3, skipped: 0, todo: 0 }] }, output: out2(P1, P2) })));
    });
  });

  describe("no check when there is nothing to compare (D8)", () => {
    it("no summary line passes and leaves a trace line saying the count check did not run", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("an unparseable summary passes with the same trace line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "      Tests  lots passed (many)\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("a `no tests` summary passes with the trace line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "      Tests  no tests\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("no baseline passes and leaves a trace line saying the count check did not run", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
    });
    it("a garbage last-green file means no baseline: the gate decides on its own checks, no fail-open message", () => {
      const dir = makeCountProject({ lastGreen: "{{{ nope", output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x))).toBe(true);
    });
    it("a garbage state.testTotals does not throw the gate", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      const state = loadState(dir, "test-session");
      state.testTotals = "junk";
      saveState(dir, "test-session", state);
      green(stop(dir));
    });
    it("a baseline entry that is not numbers does not throw the gate", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: "many", skipped: null } };
      saveState(dir, "test-session", state);
      green(stop(dir));
    });
  });

  describe("review m4: a baseline entry with a negative or fractional count is no baseline", () => {
    // Each case would block if the entry were compared: a fractional total above the run's, a negative skipped
    // below the run's 0 (a "rise"), a negative todo likewise.
    const cases = [
      ["fractional total", { total: 137.5, skipped: 0, todo: 0 }, summary({ total: 137 })],
      ["negative skipped", { total: 137, skipped: -3, todo: 0 }, summary({ total: 137 })],
      ["negative todo", { total: 137, skipped: 0, todo: -2 }, summary({ total: 137 })],
      ["fractional skipped", { total: 137, skipped: 0.5, todo: 0 }, summary({ total: 137, skipped: 1 })],
    ];
    for (const [name, entry, output] of cases) {
      it(`${name}: not compared, the gate passes and the trace says there is no baseline`, () => {
        const dir = makeCountProject({ lastGreen: { [CMD]: entry }, output });
        expect(sessionState(dir).testTotals[CMD]).toEqual(entry); // fixture check: the entry reached state as written
        green(stop(dir));
        expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
      });
    }
  });

  describe("review m2: count-check notes honour trace.enabled false", () => {
    it("a no-summary run passes and writes no trace file", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: CMD }, trace: { enabled: false } }));
      green(stop(dir));
      expect(existsSync(join(dir, ".doug/.state/trace/test-session.jsonl"))).toBe(false);
      expect(traceReasons(dir)).toEqual([]);
    });
    it("control: with trace enabled the same run does leave the count-check line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: CMD }, trace: { enabled: true } }));
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x))).toBe(true);
    });
  });

  describe("review m1: a count problem is not a failed command for the tests_red_by_design claim (D9)", () => {
    const GREEN_CMD = "cat green.txt";
    const RED_CMD = "echo ' FAIL  tests/a.test.mjs > it'; exit 1";
    function testerProject(greenOutput) {
      const dir = makeProject({ config: { ...baseConfig, commands: { red: RED_CMD, counted: GREEN_CMD }, stopGate: { ...baseConfig.stopGate, commands: ["red", "counted"] } }, git: true });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      writeFileSync(join(dir, "green.txt"), greenOutput);
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const state = loadState(dir, "test-session");
      state.testTotals = { [GREEN_CMD]: T };
      saveState(dir, "test-session", state);
      return dir;
    }
    const claimInput = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}` };
    it("control: the red command alone, the green one at its baseline, is allowed by the claim", () => {
      const r = runHookScript("stop-gate", claimInput, { dir: testerProject(summary(T)) });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("stopped with tests red by design: tests/a.test.mjs");
    });
    it("the same scenario with the green command's total dropped blocks, naming the count problem", () => {
      const r = runHookScript("stop-gate", claimInput, { dir: testerProject(summary({ total: 131 })) });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("test count regressed");
      expect(r.json.reason).toContain("137");
      expect(r.json.reason).toContain("131");
    });
  });
});

describe("stop-gate reuses its last red on an unchanged tree (card stop-gate-no-change-restop)", () => {
  const runsRel = ".doug/.state/runs.log";
  const SUMMARY = "RED-SUMMARY-XYZ";
  // Each run appends one "x" to the marker file (inside .doug/.state, which the tree fingerprint ignores),
  // prints a recognisable failure line, and exits 1.
  const redCommand = (extra = "") =>
    `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log('${SUMMARY}');process.exit(1)"${extra}`;
  const makeConfig = (over = {}) => ({
    ...baseConfig,
    commands: { test: redCommand() },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    ...over,
  });
  const runs = (dir) => (existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0);
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  const stop = (dir, extra = {}) => runHookScript("stop-gate", { hook_event_name: "Stop", ...extra }, { dir });
  const subStop = (dir, id, extra = {}) =>
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: id, agent_type: "coder", ...extra }, { dir });

  function makeEditedProject(config, agent = {}) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, ...agent }, { dir });
    return dir;
  }

  it("N1 an unchanged tree after a test failure: the second stop does not run the command, blocks, says nothing changed, repeats the summary, and counts", () => {
    const dir = makeEditedProject(makeConfig());
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain(SUMMARY);
    expect(r1.json.reason).toContain("(1/3)");
    expect(runs(dir)).toBe(1);

    const r2 = stop(dir);
    expect(runs(dir), "an unchanged tree after a red must not re-run the commands").toBe(1);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toMatch(/nothing changed/i);
    expect(r2.json.reason).toContain(SUMMARY);
    expect(r2.json.reason).toContain("(2/3)");
    expect(stateOf(dir).stopBlocks).toBe(2);
  });

  it("N2 an edited tree since the red runs the command again", () => {
    const dir = makeEditedProject(makeConfig());
    stop(dir);
    expect(runs(dir)).toBe(1);
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    const r2 = stop(dir);
    expect(runs(dir)).toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain(SUMMARY);
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
  });

  it("N3 a different agent_id on the same tree runs the command", () => {
    const dir = makeEditedProject(makeConfig(), { agent_id: "agA", agent_type: "coder" });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, agent_id: "agB", agent_type: "coder" }, { dir });
    const rA = subStop(dir, "agA");
    expect(rA.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const rB = subStop(dir, "agB");
    expect(runs(dir), "another agent's stop must run the commands itself").toBe(2);
    expect(rB.json.decision).toBe("block");
    expect(rB.json.reason).not.toMatch(/nothing changed/i);
    // and the same agent, unchanged, is what reuse is for
    subStop(dir, "agB");
    expect(runs(dir)).toBe(2);
  });

  it("N4 a recorded timeout is never reused: the next stop on the unchanged tree runs", () => {
    const sleeper = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');setTimeout(()=>{},8000)"`;
    const dir = makeEditedProject(
      makeConfig({
        commands: { test: sleeper },
        stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 1000, requireEvidence: false },
      }),
    );
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(runs(dir), "a timeout is a load-caused red and must get its rerun").toBe(2);
    expect(r2.json.decision).toBe("block");
  });

  it("N5 a corrupt lastRed record runs the command, with no throw and no fail-open", () => {
    // maxBlocks high enough that four garbage stops never reach the stand-down.
    const dir = makeEditedProject(makeConfig({ stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 10, timeoutMs: 10000, requireEvidence: false } }));
    stop(dir);
    expect(runs(dir)).toBe(1);
    let expected = 1;
    for (const garbage of ["garbage", { fingerprint: 5 }, { fingerprint: null, scope: 7, commands: "x", summary: 1 }, []]) {
      const state = stateOf(dir);
      state.lastRed = garbage;
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(state));
      const r = stop(dir);
      expected += 1;
      expect(runs(dir), `garbage ${JSON.stringify(garbage)} must not suppress the run`).toBe(expected);
      expect(r.status).toBe(0);
      expect(r.json.decision, `expected a block, got ${JSON.stringify(r.json)}`).toBe("block");
      expect(r.json.reason).toContain(SUMMARY);
      expect(r.stderr || "").not.toMatch(/fail(ed)?[- ]open|TypeError|Error:/i);
    }
  });

  it("N6 maxBlocks still stands down: the reuse counts, and the third stop on an unchanged tree stands down", () => {
    const dir = makeEditedProject(
      makeConfig({ stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 2, timeoutMs: 10000, requireEvidence: false } }),
    );
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain("(1/2)");
    const r2 = stop(dir);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain("(2/2)");
    expect(runs(dir), "the second stop is a reuse, not a run").toBe(1);
    const r3 = stop(dir);
    expect(r3.json.decision).toBeUndefined();
    expect(r3.json.systemMessage).toContain("standing down");
    expect(runs(dir)).toBe(1);
  });

  it("N6b maxBlocks 1: the second stop on an unchanged tree stands down before any reuse, running nothing", () => {
    const dir = makeEditedProject(
      makeConfig({ stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 1, timeoutMs: 10000, requireEvidence: false } }),
    );
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(r2.json.decision, "at the cap the gate stands down, it does not block").toBeUndefined();
    expect(r2.json.systemMessage).toContain("standing down");
    expect(r2.json.systemMessage).not.toMatch(/nothing changed/i);
    expect(runs(dir)).toBe(1);
  });

  it("N7 a changed configured command list runs the command", () => {
    const dir = makeEditedProject(makeConfig());
    stop(dir);
    expect(runs(dir)).toBe(1);
    // Same tree, same command name, different command text.
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(makeConfig({ commands: { test: redCommand(" # v2") } })));
    const r2 = stop(dir);
    expect(runs(dir), "a different command set must run").toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
    // And a different list of names.
    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify(
        makeConfig({
          commands: { test: redCommand(" # v2"), lint: "echo lint-ran; exit 1" },
          stopGate: { commands: ["test", "lint"], onlyIfEdited: true, maxBlocks: 5, timeoutMs: 10000, requireEvidence: false },
        }),
      ),
    );
    stop(dir);
    expect(runs(dir)).toBe(3);
  });

  // Seed variants of a real record: the fingerprint and scope stay exactly as recorded, so only the one
  // field under test can make the gate run.
  const OPEN = { stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 10, timeoutMs: 10000, requireEvidence: false } };
  function seedVariant(dir, mutate) {
    const state = stateOf(dir);
    expect(state.lastRed, "a real red must have recorded state.lastRed").toBeTruthy();
    state.lastRed = mutate(state.lastRed);
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(state));
  }

  it("N7b a recorded command list that differs from the configured one, with the fingerprint and scope intact, runs the command", () => {
    const dir = makeEditedProject(makeConfig(OPEN));
    stop(dir);
    expect(runs(dir)).toBe(1);
    // Capture the record straight after the real red, before any reuse clears it.
    const recorded = stateOf(dir).lastRed;
    expect(recorded, "a real red must have recorded state.lastRed").toBeTruthy();
    let expected = 1;
    const variants = [
      (r) => ({ ...r, commands: [...r.commands, "an extra command"] }),
      (r) => ({ ...r, commands: r.commands.map((c) => c + " # other") }),
      (r) => ({ ...r, commands: [] }),
    ];
    for (const mutate of variants) {
      seedVariant(dir, () => mutate(recorded));
      const r = stop(dir);
      expected += 1;
      expect(runs(dir), "a different command set must run").toBe(expected);
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).not.toMatch(/nothing changed/i);
    }
    // control, last: the last variant's run recorded a fresh, untouched record, which is reused.
    const rc = stop(dir);
    expect(runs(dir)).toBe(expected);
    expect(rc.json.reason).toMatch(/nothing changed/i);
  });

  it("N5b a wrong-shape record with a matching fingerprint, scope and commands runs the command, no throw, no fail-open", () => {
    const dir = makeEditedProject(makeConfig(OPEN));
    stop(dir);
    expect(runs(dir)).toBe(1);
    let expected = 1;
    const variants = [
      (r) => ({ ...r, summary: 5 }),
      (r) => ({ ...r, summary: null }),
      (r) => ({ ...r, summary: { text: r.summary } }),
      (r) => ({ ...r, commands: [5] }),
      (r) => ({ ...r, commands: [...r.commands, 5] }),
      (r) => ({ ...r, commands: "not an array" }),
      (r) => ({ ...r, scope: 7 }),
    ];
    for (const mutate of variants) {
      seedVariant(dir, mutate);
      const r = stop(dir);
      expected += 1;
      expect(runs(dir), `variant ${expected - 1} must not be reused`).toBe(expected);
      expect(r.status).toBe(0);
      expect(r.json.decision, `expected a block, got ${JSON.stringify(r.json)}`).toBe("block");
      expect(r.json.reason).toContain(SUMMARY);
      expect(r.json.reason).not.toMatch(/nothing changed/i);
      expect(r.stderr || "").not.toMatch(/fail(ed)?[- ]open|TypeError|Error:/i);
    }
  });

  it("N9 one reuse per record: after a reuse the next stop on the unchanged tree really runs, and the red it records can be reused again", () => {
    const dir = makeEditedProject(makeConfig(OPEN));
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(r2.json.reason).toMatch(/nothing changed/i);
    expect(runs(dir), "the second stop is the one reuse").toBe(1);
    const r3 = stop(dir);
    expect(runs(dir), "the third stop, after a reuse, must run the commands again").toBe(2);
    expect(r3.json.decision).toBe("block");
    expect(r3.json.reason).toContain(SUMMARY);
    expect(r3.json.reason).not.toMatch(/nothing changed/i);
    expect(r3.json.reason).toContain("(3/10)");
    const r4 = stop(dir);
    expect(runs(dir), "the new red recorded afresh is reusable once more").toBe(2);
    expect(r4.json.decision).toBe("block");
    expect(r4.json.reason).toMatch(/nothing changed/i);
    expect(r4.json.reason).toContain("(4/10)");
  });

  it("N4b a command killed by a signal is not recorded: the next stop on the unchanged tree runs", () => {
    const killed = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');process.kill(process.pid,'SIGKILL')"`;
    const dir = makeEditedProject(makeConfig({ commands: { test: killed }, ...OPEN }));
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(runs(dir), "a signal-killed command is load-suspect and must get its rerun").toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
  });

  // N4c-N4f (card ci-n4b-signal-rerun): a shell that forks instead of exec'ing (Linux dash on a lone command;
  // `; exit $?` forces it on bash too) reports a signal death as exit 128+n with no signal, so the gate must
  // treat 137 (SIGKILL) and 143 (SIGTERM) as load-suspect on every platform. N4e (a plain exit 1 is still
  // reused on the unchanged tree) is pinned by N9 and N6, whose OPEN command exits 1 and asserts runs stays 1.
  const shellReported = (body) => {
    const js = `require('fs').appendFileSync('${runsRel}','x');${body}`;
    return `${process.execPath} -e "${js}"; exit $?`;
  };
  const expectRerun = (cmd, why) => {
    const dir = makeEditedProject(makeConfig({ commands: { test: cmd }, ...OPEN }));
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(runs(dir), why).toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
  };

  it("N4c a SIGKILL reported by a forking shell (exit 137) is not recorded: the next stop runs", () => {
    expectRerun(shellReported("process.kill(process.pid,'SIGKILL')"), "exit 137 behind a shell is a signal kill and must get its rerun");
  });

  it("N4d a SIGTERM reported by a forking shell (exit 143) is not recorded: the next stop runs", () => {
    expectRerun(shellReported("process.kill(process.pid,'SIGTERM')"), "exit 143 behind a shell is a signal kill and must get its rerun");
  });

  it("N4f a command that itself exits 137 is indistinguishable from a shell-reported SIGKILL: treated as load-suspect", () => {
    expectRerun(`${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');process.exit(137)"`, "a literal exit 137 is load-suspect too");
  });

  it("N10 the reuse's blocks.jsonl line carries the class of the recorded block (expected-red under a standing claim)", () => {
    const failing = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log(' FAIL  tests/a.test.mjs > it');process.exit(1)"`;
    const dir = makeProject({ config: makeConfig({ commands: { test: failing }, ...OPEN }), git: true });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const claim = `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`;
    const honoured = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim }, { dir });
    expect(honoured.json.decision).toBeUndefined();
    const ledger = () => {
      const f = join(dir, ".doug/.state/blocks.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    };
    // Card stop-gate-lead-reuses-subagent-red: the first main Stop after the tester's honoured stop reuses the
    // tester's recorded red across scopes (no command runs), and its ledger line keeps the recorded class.
    const before = runs(dir);
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason, "the first main stop is the cross-scope reuse of ag1's red").toContain("ag1");
    expect(runs(dir), "a cross-scope reuse runs no command").toBe(before);
    const after1 = ledger();
    expect(after1[after1.length - 1].class, JSON.stringify(after1)).toBe("expected-red");
    // A second main stop runs the commands: a fresh red.
    const r2 = stop(dir);
    expect(runs(dir), "after one reuse the next stop really runs").toBe(before + 1);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
    const after2 = ledger();
    expect(after2.length).toBe(after1.length + 1);
    // A third main stop reuses that fresh red, keeping the class of the block it repeats.
    const r3 = stop(dir);
    expect(r3.json.reason, "the third stop must be the reuse").toMatch(/nothing changed/i);
    expect(runs(dir)).toBe(before + 1);
    const after3 = ledger();
    expect(after3.length).toBe(after2.length + 1);
    expect(after3[after3.length - 1].class, "a reuse keeps the class of the block it repeats").toBe("expected-red");
  });

  it("N11 a reuse block on the Stop that hit the deferral cap carries the cap note too", () => {
    const dir = makeEditedProject(
      makeConfig({ stopGate: { ...OPEN.stopGate, maxDeferrals: 2 }, trace: { enabled: true } }),
    );
    const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
    mkdirSync(dirname(traceFile), { recursive: true });
    writeFileSync(
      traceFile,
      JSON.stringify({ t: new Date().toISOString(), event: "SubagentStart", session: "test-session", agent: "ag1", agentType: "coder", tool: null, toolUseId: null, detail: null, ok: null, tokens: null, context: null, reason: null }) + "\n",
    );
    const d1 = stop(dir);
    expect(d1.json.systemMessage.toLowerCase()).toContain("deferred");
    expect(runs(dir)).toBe(0);
    const r2 = stop(dir); // hits the cap: runs the gate, blocks with the note
    expect(runs(dir)).toBe(1);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain("Deferral cap reached");
    const d3 = stop(dir);
    expect(d3.json.systemMessage.toLowerCase()).toContain("deferred");
    const r4 = stop(dir); // hits the cap again: unchanged tree, so the reuse block
    expect(runs(dir), "the fourth stop must be a reuse").toBe(1);
    expect(r4.json.decision).toBe("block");
    expect(r4.json.reason).toMatch(/nothing changed/i);
    expect(r4.json.reason, "a reuse block must carry the cap note like any block on this Stop").toContain("Deferral cap reached");
  });

  it("N8 a tester SubagentStop carrying a tests_red_by_design claim runs, even on an unchanged tree", () => {
    const failing = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log(' FAIL  tests/a.test.mjs > it');console.log(' ❯ tests/a.test.mjs (3 tests | 1 failed)');process.exit(1)"`;
    const dir = makeProject({ config: makeConfig({ commands: { test: failing } }), git: true });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const plain = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" };
    const r1 = runHookScript("stop-gate", { ...plain, last_assistant_message: "done" }, { dir });
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const claim = `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`;
    const r2 = runHookScript("stop-gate", { ...plain, last_assistant_message: claim }, { dir });
    expect(runs(dir), "the claim's coverage check needs real command output").toBe(2);
    expect(r2.json.decision).toBeUndefined();
    expect(r2.json.systemMessage).toContain("tests red by design: tests/a.test.mjs");
  });

  // Cross-scope reuse (card stop-gate-lead-reuses-subagent-red): a main Stop reuses a subagent's red on the same tree.
  describe("a main Stop reuses another scope's red (card stop-gate-lead-reuses-subagent-red)", () => {
    it("X1 a coder's red, then a main Stop on the same tree: blocks, runs nothing, names the subagent", () => {
      const dir = makeEditedProject(makeConfig(OPEN), { agent_id: "agA", agent_type: "coder" });
      const rA = subStop(dir, "agA");
      expect(rA.json.decision).toBe("block");
      expect(runs(dir)).toBe(1);
      const r = stop(dir);
      expect(runs(dir), "the main Stop must not re-run the commands").toBe(1);
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("agA");
      expect(r.json.reason).toContain(SUMMARY);
      expect(r.json.reason, "the main Stop's reuse block counts as the session's first block").toContain("(1/");
      expect(stateOf(dir).stopBlocks, "a cross-scope reuse must raise the main Stop's stopBlocks").toBe(1);
    });

    it("X2the tree changes between the subagent's red and the main Stop: the main Stop runs", () => {
      const dir = makeEditedProject(makeConfig(OPEN), { agent_id: "agA", agent_type: "coder" });
      subStop(dir, "agA");
      expect(runs(dir)).toBe(1);
      writeFileSync(join(dir, "src/a.ts"), "edited again");
      const r = stop(dir);
      expect(runs(dir)).toBe(2);
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).not.toContain("agA");
    });

    it("X3 a different configured command set at the main Stop: runs", () => {
      const dir = makeEditedProject(makeConfig(OPEN), { agent_id: "agA", agent_type: "coder" });
      subStop(dir, "agA");
      expect(runs(dir)).toBe(1);
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(makeConfig({ ...OPEN, commands: { test: redCommand(" # v2") } })));
      const r = stop(dir);
      expect(runs(dir), "a different command set must run").toBe(2);
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).not.toContain("agA");
    });

    it("X4 a tester's honoured red-by-design stop, then a main Stop on the same tree: blocks without running and names the tester", () => {
      const failing = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log(' FAIL  tests/a.test.mjs > it');console.log(' ❯ tests/a.test.mjs (3 tests | 1 failed)');process.exit(1)"`;
      const dir = makeProject({ config: makeConfig({ ...OPEN, commands: { test: failing } }), git: true });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "agT", agent_type: "tester" }, { dir });
      const claim = `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`;
      const honoured = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agT", agent_type: "tester", last_assistant_message: claim }, { dir });
      expect(honoured.json.decision, JSON.stringify(honoured.json)).toBeUndefined();
      expect(runs(dir)).toBe(1);
      const r = stop(dir);
      expect(runs(dir), "the main Stop must not re-run the suite the tester just ran").toBe(1);
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("agT");
    });

    it("X5 a board-only change after a subagent's red: the cross-scope record is not reused, the main Stop runs", () => {
      const cfg = makeConfig({ ...OPEN, preCommit: { noTestPaths: [".doug/board.json"] } });
      const dir = makeProject({ config: cfg, git: true });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "base");
      writeFileSync(join(dir, ".doug/board.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "src/a.ts"), "edited this session");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, agent_id: "agA", agent_type: "coder" }, { dir });
      expect(subStop(dir, "agA").json.decision).toBe("block");
      expect(runs(dir)).toBe(1);
      writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
      const r = stop(dir);
      expect(runs(dir), "a board-only change must not make a cross-scope record reusable").toBe(2);
      expect(r.json.decision).toBe("block");
    });

    it("X6 one reuse per record: a second main Stop on the same tree runs the commands", () => {
      const dir = makeEditedProject(makeConfig(OPEN), { agent_id: "agA", agent_type: "coder" });
      subStop(dir, "agA");
      const r1 = stop(dir);
      expect(runs(dir)).toBe(1);
      expect(r1.json.reason).toContain("agA");
      const r2 = stop(dir);
      expect(runs(dir), "the record is spent after one reuse").toBe(2);
      expect(r2.json.decision).toBe("block");
    });

    it("X7 a SubagentStop of agent B after agent A's red on the same tree still runs", () => {
      const dir = makeEditedProject(makeConfig(OPEN), { agent_id: "agA", agent_type: "coder" });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, agent_id: "agB", agent_type: "coder" }, { dir });
      subStop(dir, "agA");
      expect(runs(dir)).toBe(1);
      const rB = subStop(dir, "agB");
      expect(runs(dir), "another agent's stop must run the commands itself").toBe(2);
      expect(rB.json.decision).toBe("block");
      expect(rB.json.reason).not.toMatch(/nothing changed/i);
    });
  });
});

// card trace-redact-secrets (T9): the trace script passes the project's secrets config to the line builder.
// The token is built by concatenation so this file never holds a whole token.
describe("trace script redaction (card trace-redact-secrets)", () => {
  const GH = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "echo " + GH } };
  const lines = (dir) =>
    readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("T9 default config writes the token redacted; a config disabling githubToken writes it unredacted", () => {
    const def = makeProject({ config: { trace: { enabled: true } }, git: true });
    runHookScript("trace", input, { dir: def });
    const [l1] = lines(def);
    expect(l1.detail).toBe("[redacted: githubToken]");
    expect(readFileSync(join(def, ".doug/.state/trace/test-session.jsonl"), "utf8")).not.toContain(GH.slice(0, 12));

    const off = makeProject({ config: { trace: { enabled: true }, secrets: { rules: { githubToken: false } } }, git: true });
    runHookScript("trace", input, { dir: off });
    const [l2] = lines(off);
    expect(l2.detail).toContain(GH);
  });
});

// card gate-skip-readonly-researchers: a SubagentStop whose agent changed nothing in the working tree since it
// started (same HEAD, same tree identities) skips the verification commands even when the run trace shows Bash
// lines (so no-agent-changes cannot apply). The start fingerprint is recorded by the trace hook on
// SubagentStart; these tests fire that hook for real and pin behaviour, not where the fingerprint is stored.
describe("card gate-skip-readonly-researchers", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsCount = (dir) => (existsSync(join(dir, runsLogRelpath)) ? readFileSync(join(dir, runsLogRelpath), "utf8").length : 0);

  function makeConfig() {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
    };
  }

  // Committed base plus a file this session edited before any agent started (dirty at start).
  function makeEditedProject() {
    const dir = makeProject({ config: makeConfig(), git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited before the agent started");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const agentIds = (id, type) => ({ agent_id: id, agent_type: type });
  const fireStart = (dir, id, type) => runHookScript("trace", { hook_event_name: "SubagentStart", ...agentIds(id, type) }, { dir });
  const fireBash = (dir, id, type) =>
    runHookScript("trace", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1", ...agentIds(id, type) }, { dir });
  const stop = (dir, id, type, extra = {}) =>
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", ...agentIds(id, type), ...extra }, { dir });
  const traceLines = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it("(a) a researcher with a Bash line whose tree is unchanged since SubagentStart stops without a gate run, reason tree-unchanged", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    const r = stop(dir, "ag1", "researcher");
    expect(r.json, "an unchanged tree must be allowed").toBeNull();
    expect(runsCount(dir), "no verification command may run").toBe(0);
    const line = traceLines(dir).find((l) => l.event === "SubagentStop");
    expect(line, "a SubagentStop trace line").toBeTruthy();
    expect(line.reason).toBe("tree-unchanged");
    expect(line.decision).toBe("allow");
  });

  it("(b) the agent edits a tracked file between start and stop: the gate runs", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    writeFileSync(join(dir, "src/a.ts"), "edited again during the agent's life");
    stop(dir, "ag1", "researcher");
    expect(runsCount(dir)).toBe(1);
  });

  it("(b2) the agent creates an untracked file between start and stop: the gate runs", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    writeFileSync(join(dir, "src/new.ts"), "created during the agent's life");
    stop(dir, "ag1", "researcher");
    expect(runsCount(dir)).toBe(1);
  });

  it("(c) a tester with an unchanged tree but a tests_red_by_design claim still runs the gate", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "tester");
    fireBash(dir, "ag1", "tester");
    stop(dir, "ag1", "tester", {
      last_assistant_message: `Tests are red as designed.\n${JSON.stringify({ tests_red_by_design: ["src/a.ts"] })}`,
    });
    expect(runsCount(dir)).toBe(1);
  });

  it("(d) no start record for the agent (SubagentStart never went through the hook): the gate runs", () => {
    const dir = makeEditedProject();
    // A coder, not a researcher: a read-only agent type is skipped by the older type rule when no trace line vouches for it.
    fireBash(dir, "ag1", "coder");
    stop(dir, "ag1", "coder");
    expect(runsCount(dir)).toBe(1);
  });

  it("(e) HEAD moves between start and stop with no dirty change: the gate runs", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved head"], { cwd: dir });
    stop(dir, "ag1", "researcher");
    expect(runsCount(dir)).toBe(1);
  });

  it("(f) a tester with an unchanged tree whose tests_red_by_design claim is only in the last hand-back still runs the gate", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "tester");
    fireBash(dir, "ag1", "tester");
    // Outside the project: a file inside it would change the tree after start and make the gate run regardless.
    const transcriptPath = join(mkdtempSync(join(tmpdir(), "doug-f-")), "transcript.jsonl");
    const message = JSON.stringify({ tests_red_by_design: ["src/a.ts"] });
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } }) + "\n",
    );
    stop(dir, "ag1", "tester", { agent_transcript_path: transcriptPath, last_assistant_message: "Report delivered via SubagentHandback." });
    expect(runsCount(dir)).toBe(1);
  });

  it("(g) a successful Edit in the agent's own trace with the tree unchanged since start (no Bash) still runs the gate", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "coder");
    const edit = { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, tool_use_id: "tu2", ...agentIds("ag1", "coder") };
    runHookScript("trace", { hook_event_name: "PreToolUse", ...edit }, { dir });
    runHookScript("trace", { hook_event_name: "PostToolUse", tool_response: { success: true }, ...edit }, { dir });
    const post = traceLines(dir).find((l) => l.event === "PostToolUse" && l.tool === "Edit");
    expect(post && post.ok, "fixture: the trace must record the Edit as successful").toBe(true);
    stop(dir, "ag1", "coder");
    expect(runsCount(dir)).toBe(1);
  });
});

describe("card stop-gate-no-test-paths", () => {
  const runsRel = ".doug/.state/runs.log";
  const runs = (dir) => (existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0);
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  const traceOf = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir });
  // Each gate run appends one "x" to runs.log (inside .doug/.state, which the tree fingerprint ignores).
  const cfgWith = (noTestPaths, extra = {}) => {
    const c = {
      ...baseConfig,
      commands: { test: `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x')"` },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
    if (noTestPaths !== undefined) c.preCommit = { noTestPaths };
    return c;
  };
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const subStop = (dir) => runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agA", agent_type: "coder" }, { dir });

  // A committed base (src/a.ts, docs/x.md, .doug/board.json), then src/a.ts edited this session and a first
  // Stop that runs the gate green: state.verified is recorded with src/a.ts dirty. The run counter is 1 after.
  function makeGreen(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "docs/x.md"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base b");
    writeFileSync(join(dir, ".doug/board.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    const first = stop(dir);
    expect(first.json, "fixture: the first gate must run green").toBeNull();
    expect(runs(dir), "fixture: the first gate must run the command once").toBe(1);
    expect(stateOf(dir).verified, "fixture: green records state.verified").toBeTruthy();
    return dir;
  }
  const commitOnly = (dir, file) => {
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", `change ${file}`);
  };

  it("a1 a dirty board-only change since the last green skips: allow, no command, trace reason no-test-paths, lastGate.skipped", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "no configured command may run").toBe(1);
    expect(traceOf(dir).some((l) => l.reason === "no-test-paths"), "a trace line must carry reason no-test-paths").toBe(true);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("a2 a committed board-only change since the last green skips the same way", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(traceOf(dir).some((l) => l.reason === "no-test-paths")).toBe(true);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("g1 a source path committed unchanged since verification, then a board-only commit, still skips", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    commitOnly(dir, "src/a.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "no configured command may run").toBe(1);
    expect(traceOf(dir).some((l) => l.reason === "no-test-paths")).toBe(true);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("g2 a source path whose content changed after verification and was committed runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, "src/a.ts"), "edited after verification");
    commitOnly(dir, "src/a.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the gate must run").toBe(2);
  });

  it("g3 a committed source path absent from the verified record runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    expect(stateOf(dir).verified.tree["src/b.ts"], "fixture: src/b.ts is not in the record").toBeUndefined();
    writeFileSync(join(dir, "src/b.ts"), "new b");
    commitOnly(dir, "src/b.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the gate must run").toBe(2);
  });

  it("a3 SubagentStop skips on a board-only change too", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = subStop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(traceOf(dir).some((l) => l.event === "SubagentStop" && l.reason === "no-test-paths")).toBe(true);
  });

  it("b1 a dirty board change plus a dirty source change runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    stop(dir);
    expect(runs(dir), "a path off the list must run the gate").toBe(2);
  });

  it("b2 a committed board change plus a dirty source change since the green runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("b3 a committed source change plus a dirty board change runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, "docs/x.md"), "committed change");
    commitOnly(dir, "docs/x.md");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("c1 a missing noTestPaths list runs the gate", () => {
    const dir = makeGreen(cfgWith(undefined));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("c2 an empty noTestPaths list runs the gate", () => {
    const dir = makeGreen(cfgWith([]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("c3 a list holding a non-string or empty entry runs the gate (fail closed, like pre-commit)", () => {
    const dir = makeGreen(cfgWith([".doug/board.json", 7]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("d no prior green verification this session: a board-only change runs the gate", () => {
    const config = cfgWith([".doug/board.json"]);
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, ".doug/board.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: ".doug/board.json" } }, { dir });
    stop(dir);
    expect(runs(dir), "with no state.verified there is no baseline to compare against").toBe(1);
  });

  it("e1 a directory entry covers a file under it (prefix rule)", () => {
    const dir = makeGreen(cfgWith(["docs/"]));
    writeFileSync(join(dir, "docs/x.md"), "changed");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("e2 a glob-looking entry does not match (exact semantics, same as pre-commit)", () => {
    const dir = makeGreen(cfgWith(["docs/*"]));
    writeFileSync(join(dir, "docs/x.md"), "changed");
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("f a board-only skip still runs the scans: a protected path on the list still blocks", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"], { protectedPaths: [...baseConfig.protectedPaths, ".doug/board.json"] }));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json && r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified");
    expect(runs(dir), "the commands are skipped even though the scan blocks").toBe(1);
  });

  it("g a rename out of a source path into a listed directory runs the gate (moved-from path counts)", () => {
    const dir = makeGreen(cfgWith(["docs/"]));
    git(dir, "mv", "src/b.ts", "docs/b.ts");
    stop(dir);
    expect(runs(dir), "src/b.ts changed (moved away) and is off the list").toBe(2);
  });

  it("h a source file dirty at the green then reverted, plus a board edit, runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    git(dir, "checkout", "--", "src/a.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir), "the reverted source path moved since the green").toBe(2);
  });

  it("i an exact entry does not cover a sibling path sharing its prefix", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json.bak"), "x");
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("j a no-test-paths skip leaves state.verified unchanged", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    const before = stateOf(dir).verified;
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped, "fixture: the skip must have happened").toBe("no-test-paths");
    expect(stateOf(dir).verified).toEqual(before);
  });

  // card no-test-paths-plan-files: .doug/plan.json is a noTestPaths entry in this repo and in doug init's default.
  const PLAN = ".doug/plan.json";
  const writePlan = (dir, body) => writeFileSync(join(dir, PLAN), body);

  it("P1 a plan.json-only change (dirty, then committed) with the list holding it skips: no command, lastGate.skipped no-test-paths", () => {
    const dir = makeGreen(cfgWith([PLAN]));
    writePlan(dir, '{"v":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "no configured command may run on a dirty plan.json").toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
    commitOnly(dir, PLAN);
    const r2 = stop(dir);
    expect(r2.json, JSON.stringify(r2.json)).toBeNull();
    expect(runs(dir), "no configured command may run on a committed plan.json").toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("P2 a planner SubagentStop whose only change is plan.json, with the list holding it, runs no command and is allowed", () => {
    const dir = makeGreen(cfgWith([PLAN]));
    writePlan(dir, '{"v":1}');
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agP", agent_type: "planner" }, { dir });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the planner's plan.json write must not run the suite").toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("P3 the same plan.json-only change with the list lacking plan.json runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writePlan(dir, '{"v":1}');
    stop(dir);
    expect(runs(dir), "plan.json off the list must run the gate").toBe(2);
  });
});

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

// card verified-tree-record, brief B: the Stop and SubagentStop gates write .doug/.state/verified-tree.json after a
// green run and credit a record of the same tree (or a tree differing only on preCommit.noTestPaths) instead of
// re-running. Every gate command appends to .doug/.state/ran.marker (outside the tree), so a run is countable
// without changing the tree, and prints a vitest Tests line so totals are recorded.
describe("card verified-tree-record", () => {
  const CMD =
    `${process.execPath} -e "const fs=require('fs');fs.mkdirSync('.doug/.state',{recursive:true});` +
    `fs.appendFileSync('.doug/.state/ran.marker','x');console.log(' Tests  3 passed (3)');` +
    `process.exit(fs.existsSync('fail.flag')?1:0)"`;
  const cfgFor = (extra = {}) => ({
    ...baseConfig,
    commands: { test: CMD },
    preCommit: { noTestPaths: [".doug/board.json"] },
    ...extra,
  });
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commitAll = (dir, msg = "next") => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", msg);
  };
  function makeRec(config = cfgFor()) {
    const dir = makeProject({ config, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.js"), "base");
    commitAll(dir, "base");
    return dir;
  }
  const tree = (dir) => {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    return computeTree(dir);
  };
  const markEdited = (dir, sid = "test-session") =>
    runHookScript("edit-loop", { session_id: sid, tool_name: "Edit", tool_input: { file_path: "src/a.js" } }, { dir });
  const edit = (dir, content, sid = "test-session") => {
    writeFileSync(join(dir, "src/a.js"), content);
    markEdited(dir, sid);
  };
  const stop = (dir, sid = "test-session") => runHookScript("stop-gate", { session_id: sid, hook_event_name: "Stop" }, { dir });
  const runs = (dir) => {
    const f = join(dir, ".doug/.state/ran.marker");
    return existsSync(f) ? readFileSync(f, "utf8").length : 0;
  };
  const sessionState = (dir, sid = "test-session") => JSON.parse(readFileSync(join(dir, `.doug/.state/${sid}.json`), "utf8"));
  const totalsFor = (total) => ({ [CMD]: { status: "ok", summaries: [{ total, skipped: 0, todo: 0 }], totals: { total, skipped: 0, todo: 0 } } });
  const goodRecord = (dir, over = {}) => ({
    version: 1,
    tree: tree(dir),
    node: process.version,
    at: new Date().toISOString(),
    by: "verify",
    commands: [{ name: "test", command: CMD, exit: 0, durationMs: 5 }],
    totals: totalsFor(3),
    ...over,
  });
  const seed = (dir, over) => {
    writeTreeRecord(dir, goodRecord(dir, over));
  };

  it("R1: a green Stop writes the record for the current tree, with the node version and totals keyed by command", () => {
    const dir = makeRec();
    edit(dir, "edited");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    const rec = readRecord(dir);
    expect(rec, "a green Stop must write .doug/.state/verified-tree.json").not.toBeNull();
    expect(rec.by).toBe("stop");
    expect(rec.tree).toBe(tree(dir));
    expect(rec.node).toBe(process.version);
    expect(rec.commands).toEqual([expect.objectContaining({ name: "test", command: CMD, exit: 0 })]);
    expect(rec.totals[CMD]).toMatchObject({ status: "ok", summaries: [{ total: 3, skipped: 0, todo: 0 }] });
  });

  it("R2: a fresh session credits the record across a commit: no command runs, lastGate.credited is verified-tree, state.verified set", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    expect(runs(dir)).toBe(1);
    commitAll(dir);
    markEdited(dir, "s2");
    const r = stop(dir, "s2");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the recorded commands must not run again").toBe(1);
    const state = sessionState(dir, "s2");
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.results[0]).toMatchObject({ name: "test", ok: true, credited: "verified-tree" });
    expect(state.verified).toBeTruthy();
  });

  it("R3: a fresh session credits the record across a diff that touches only preCommit.noTestPaths", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    writeFileSync(join(dir, ".doug/board.json"), '{"cards":[]}');
    commitAll(dir);
    markEdited(dir, "s2");
    const r = stop(dir, "s2");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(sessionState(dir, "s2").lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R4: a diff that touches a source file refuses the credit: the commands run and a new record names the new tree", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    const before = readRecord(dir).tree;
    edit(dir, "edited again", "s2");
    const r = stop(dir, "s2");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(2);
    const rec = readRecord(dir);
    expect(rec.tree).not.toBe(before);
    expect(rec.tree).toBe(tree(dir));
  });

  it("R5: a record of a different command set refuses the credit (tree equal, so only the command set differs)", () => {
    // control: the same fixture with a matching record credits, so the refusal below is the poisoned field's doing
    const ctl = makeRec();
    edit(ctl, "edited");
    seed(ctl);
    expect(stop(ctl).json).toBeNull();
    expect(runs(ctl), "control: a matching record must be credited").toBe(0);
    const dir = makeRec();
    edit(dir, "edited");
    seed(dir, { commands: [{ name: "other", command: "some other command", exit: 0, durationMs: 5 }], totals: {} });
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
  });

  it("R6: a record from another Node version, or a malformed record file, refuses the credit and the hook still exits 0 with a gate result", () => {
    // control: the same fixture with a matching record credits, so the refusal below is the poisoned field's doing
    const ctl = makeRec();
    edit(ctl, "edited");
    seed(ctl);
    expect(stop(ctl).json).toBeNull();
    expect(runs(ctl), "control: a matching record must be credited").toBe(0);
    const dir = makeRec();
    edit(dir, "edited");
    seed(dir, { node: "v0.0.0" });
    const a = stop(dir);
    expect(a.status).toBe(0);
    expect(runs(dir)).toBe(1);

    const dir2 = makeRec();
    edit(dir2, "edited");
    mkdirSync(join(dir2, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir2, RECORD_RELPATH), "{");
    const b = stop(dir2);
    expect(b.status).toBe(0);
    expect(b.json, JSON.stringify(b.json)).toBeNull();
    expect(runs(dir2)).toBe(1);
  });

  it("R7: a red run removes the record", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    expect(readRecord(dir)).not.toBeNull();
    writeFileSync(join(dir, "fail.flag"), "1");
    markEdited(dir, "s2");
    const r = stop(dir, "s2");
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(runs(dir)).toBe(2);
    expect(existsSync(join(dir, RECORD_RELPATH)), "a red run must remove the record").toBe(false);
  });

  it("R8: the count ratchet applies to the recorded totals of a credited run; a record without totals runs the commands instead", () => {
    const seedBaseline = (dir) => {
      markEdited(dir); // creates the session state
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: 5, skipped: 0, todo: 0 } };
      saveState(dir, "test-session", state);
    };
    const dir = makeRec();
    edit(dir, "edited");
    seedBaseline(dir);
    seed(dir, { totals: totalsFor(4) });
    const r = stop(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("test count regressed");
    expect(runs(dir), "the credited command must not run").toBe(0);

    const dir2 = makeRec();
    edit(dir2, "edited");
    seedBaseline(dir2);
    seed(dir2, { totals: {} });
    stop(dir2);
    expect(runs(dir2), "a baseline with no readable recorded totals must run the commands").toBe(1);
  });

  it("R9: scans and evidence still run on a credited gate", () => {
    // protected files
    const dir = makeRec();
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    writeFileSync(join(dir, ".env"), "SECRET=1");
    markEdited(dir);
    seed(dir);
    const p = stop(dir);
    expect(p.json && p.json.decision, JSON.stringify(p.json)).toBe("block");
    expect(p.json.reason).toContain("Protected files were modified");
    expect(runs(dir), "the credited command must not run").toBe(0);

    // evidence
    const cfg = cfgFor({ stopGate: { ...baseConfig.stopGate, requireEvidence: true } });
    const dir2 = makeRec(cfg);
    edit(dir2, "edited");
    seed(dir2);
    const noEvidence = stop(dir2);
    expect(noEvidence.json && noEvidence.json.decision, JSON.stringify(noEvidence.json)).toBe("block");
    expect(noEvidence.json.reason).toContain("No test or verify command ran in this session");
    expect(runs(dir2)).toBe(0);
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "node .doug/hooks/scripts/verify.mjs" } }, { dir: dir2 });
    const withEvidence = stop(dir2);
    expect(withEvidence.json, JSON.stringify(withEvidence.json)).toBeNull();
    expect(runs(dir2)).toBe(0);
    expect(sessionState(dir2).lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R10: a coder SubagentStop on a recorded tree is credited: allow, no command runs", () => {
    const dir = makeRec(cfgFor({ trace: { enabled: true } }));
    edit(dir, "edited");
    const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
    mkdirSync(dirname(traceFile), { recursive: true });
    const line = (l) => ({ t: new Date().toISOString(), event: null, session: "test-session", agent: null, agentType: null, tool: null, toolUseId: null, detail: null, ok: null, tokens: null, context: null, reason: null, ...l });
    writeFileSync(
      traceFile,
      [
        line({ event: "SubagentStart", agent: "ag1", agentType: "coder" }),
        line({ event: "PreToolUse", agent: "ag1", agentType: "coder", tool: "Edit" }),
        line({ event: "PostToolUse", agent: "ag1", agentType: "coder", tool: "Edit", ok: true }),
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    seed(dir);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "a credited SubagentStop must not run the commands").toBe(0);
    expect(sessionState(dir).lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R11: a stale red for the same tree does not shadow a matching green record", () => {
    const dir = makeRec();
    edit(dir, "edited");
    writeFileSync(join(dir, "fail.flag"), "1");
    markEdited(dir);
    const red = stop(dir);
    expect(red.json && red.json.decision, JSON.stringify(red.json)).toBe("block");
    expect(runs(dir)).toBe(1);
    seed(dir); // a green record for exactly this (failing-flag) tree, as another agent's verify run would leave
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the green record must be credited rather than the red reused or the commands rerun").toBe(1);
    expect(sessionState(dir).lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R12: a Stop whose command changes a non-ignored file while it runs ends green but writes no record", () => {
    const MUT =
      `${process.execPath} -e "const fs=require('fs');fs.mkdirSync('.doug/.state',{recursive:true});` +
      `fs.appendFileSync('.doug/.state/ran.marker','x');fs.writeFileSync('src/changed-by-gate.js','mutated');` +
      `console.log(' Tests  3 passed (3)')"`;
    const dir = makeRec(cfgFor({ commands: { test: MUT } }));
    edit(dir, "edited");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the command must have really run").toBe(1);
    expect(existsSync(join(dir, "src/changed-by-gate.js")), "the command must have changed the tree").toBe(true);
    expect(readRecord(dir), "a tree that changed across the run must not be recorded").toBeNull();
  });
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
