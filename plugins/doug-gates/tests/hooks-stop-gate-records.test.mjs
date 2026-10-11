import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { makeProject, runHookScript } from "./helpers.mjs";
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
