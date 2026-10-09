import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeProject, runHookScript, scriptsDir } from "./helpers.mjs";
// card stop-gate-process-storm: runCommand is exercised directly (case 1), the same way the proposal-ledger
// test in hooks-stop-gate.test.mjs crosses the plugin boundary for a documented reason.
// card gates-runner-no-color: commandEnv is exercised directly (T1) the same way runCommand is above.
import { runCommand, commandEnv } from "../lib/run.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";

// card stop-gate-process-storm, case 1: runCommand's own group-kill-on-timeout, tested directly against
// lib/run.mjs rather than through the stop-gate script (the script only ever calls it with a real command).
describe("runCommand (card stop-gate-process-storm)", () => {
  // A synchronous sleep: spawnSync-based runCommand blocks the whole time anyway, so a real (non-busy) wait
  // here costs nothing and keeps the polling loops below simple.
  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  it("kills the whole process group on timeout, including a grandchild the command spawned (case 1)", () => {
    const dir = makeProject({});
    const pidfile = join(dir, "grandchild.pid");
    const script = join(dir, "spawner.mjs");
    // Spawns a grandchild node that just sleeps, records its pid, then the parent itself also sleeps — the
    // 2026-09-16 process-storm shape: a command whose own child outlives it.
    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);',
        "writeFileSync(process.argv[2], String(child.pid));",
        "setTimeout(() => {}, 30000);",
      ].join("\n"),
    );
    let grandchildPid = null;
    try {
      const r = runCommand(`${process.execPath} ${script} ${pidfile}`, { cwd: dir, timeoutMs: 1000 });
      expect(r.timedOut).toBe(true);
      // The grandchild writes its pidfile within a few ms of starting, well inside the 1000ms budget.
      let seen = existsSync(pidfile);
      const pidDeadline = Date.now() + 500;
      while (!seen && Date.now() < pidDeadline) {
        sleepSync(20);
        seen = existsSync(pidfile);
      }
      expect(seen, "the grandchild process never even started").toBe(true);
      grandchildPid = Number(readFileSync(pidfile, "utf8").trim());
      // Case 1: "within 1 s of runCommand returning, that grandchild is dead" — process.kill(pid, 0) throws
      // (ESRCH) once it is gone; poll for up to 1s rather than assume it is instant.
      let dead = false;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          process.kill(grandchildPid, 0);
        } catch {
          dead = true;
          break;
        }
        sleepSync(20);
      }
      expect(dead, "runCommand must kill the whole process group on timeout, including a grandchild the timed-out command spawned").toBe(true);
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already gone (the expected outcome) or never started
        }
      }
    }
  });

  it("a command that finishes in time is unaffected", () => {
    const dir = makeProject({});
    const r = runCommand(`${process.execPath} -e "process.exit(0)"`, { cwd: dir, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
  });
});

// card gates-runner-no-color: gate runners must spawn commands with NO_COLOR=1 and never FORCE_COLOR, the same
// shape as commandEnv() in plugins/doug-flow/lib/land.mjs (0c38855) — vitest's colour library treats ANY
// FORCE_COLOR key, even "0", as colour on, which breaks the stop gate's captured-output and block-ledger
// parsing.
describe("gate runner env (card gates-runner-no-color)", () => {
  // Writes a script whose command dumps NO_COLOR/FORCE_COLOR from its own environment to an absolute tmp
  // file as JSON, so the test can assert on the exact env the runner spawned it with.
  const envDumpCommand = (envFile) =>
    `${process.execPath} -e "require('fs').writeFileSync('${envFile}', JSON.stringify({NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR})); process.exit(0)"`;
  const readEnv = (envFile) => JSON.parse(readFileSync(envFile, "utf8"));
  const withInheritedForceColor = (fn) => {
    const prev = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "0";
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prev;
    }
  };

  it("commandEnv sets NO_COLOR=1, keeps CI when set else defaults it, and drops FORCE_COLOR (T1)", () => {
    const env = commandEnv({ CI: "true", FORCE_COLOR: "0", PATH: "x" });
    expect(env).toEqual({ CI: "true", NO_COLOR: "1", PATH: "x" });
    expect(env).not.toHaveProperty("FORCE_COLOR");
    expect(commandEnv({}).CI).toBe("1");
  });

  describe("stop gate (T2)", () => {
    const stopGateProject = (envFile) => {
      const cfg = {
        ...baseConfig,
        commands: { test: envDumpCommand(envFile) },
        stopGate: { ...baseConfig.stopGate, commands: ["test"] },
      };
      const dir = makeProject({ config: cfg, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      // Dirty before any baseline capture, and never committed: the stop gate's own first-run capture (no
      // SessionStart) counts it all as changed, so the configured stopGate.commands run — see the existing
      // "fallback (no SessionStart)" case above for this same shape.
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      return dir;
    };

    it("runs stopGate.commands with NO_COLOR=1 and no FORCE_COLOR", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = stopGateProject(envFile);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });

    it("deletes an inherited FORCE_COLOR rather than passing it through", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = stopGateProject(envFile);
      withInheritedForceColor(() => {
        runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });
  });

  describe("format-on-edit (T3)", () => {
    const formatOnEditProject = (envFile) =>
      makeProject({
        config: {
          ...baseConfig,
          formatter: {
            command: [
              process.execPath,
              "-e",
              `require('fs').writeFileSync('${envFile}', JSON.stringify({NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR})); process.exit(0)`,
            ],
            extensions: [".ts"],
          },
        },
      });

    it("runs the formatter with NO_COLOR=1 and no FORCE_COLOR", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = formatOnEditProject(envFile);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "raw");
      runHookScript("format-on-edit", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });

    it("deletes an inherited FORCE_COLOR rather than passing it through", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = formatOnEditProject(envFile);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "raw");
      withInheritedForceColor(() => {
        runHookScript("format-on-edit", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
      });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });
  });
});

// card stop-gate-process-storm, cases 2 and 3: a verified-tree fingerprint that lets a later Stop/SubagentStop
// with an unchanged tree skip re-running the verification commands, and a single-runner lock so concurrent
// SubagentStops share one suite instead of each starting its own (the 2026-09-16 process storm). Every
// gate command below appends to, or reads, a file under .doug/.state/ — changedFiles (lib/baseline.mjs)
// unconditionally filters that whole prefix out of "what changed", so a command's own side effects never
// pollute the very tree fingerprint being tested.
describe("stop-gate process storm (card stop-gate-process-storm)", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const lockSeenRelpath = ".doug/.state/lock-seen.json";
  const lockRelpath = ".doug/.state/gate.lock";

  // Counts verification runs: each run appends one "x" byte.
  const makeRunsConfig = (timeoutMs) => ({
    ...baseConfig,
    commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
    stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs, requireEvidence: false },
    trace: { enabled: true },
  });
  // Copies whatever gate.lock looks like while the command runs, so the test can inspect it afterward
  // (gate.lock itself is normally gone again by the time the hook process exits and stdout is read back).
  const makeLockSeenConfig = (timeoutMs) => ({
    ...baseConfig,
    commands: { "test:unit": `${process.execPath} -e "require('fs').copyFileSync('${lockRelpath}','${lockSeenRelpath}')"` },
    stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs, requireEvidence: false },
    trace: { enabled: true },
  });

  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);
  const lockPath = (dir) => join(dir, lockRelpath);

  // Base project for cases 2/2b/2c: a git repo, a base commit, then one file edited and dirtied — the shape
  // every "still dirty, still edited" sub-case below builds on.
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

  describe("case 2: verified tree recorded on green, and a later Stop/SubagentStop with a matching tree skips", () => {
    it("records state.verified on a green gate, and skips a Stop or SubagentStop whose tree still matches, tracing the skip", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));

      // Stop #1: green, must actually run the command once, and record state.verified.
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r1.json).toBeNull();
      expect(runsCount(dir)).toBe(1);
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.verified, "state.verified must be recorded by a green gate (goal 2)").toBeTruthy();
      expect(state1.verified.head).toBe(headSha);
      expect(state1.verified.tree).toHaveProperty("src/a.ts");
      expect(state1.verified.tree["src/a.ts"]).toMatch(/^\d+:[0-9a-f]{40}$/);

      // Stop #2: nothing has changed since Stop #1 — must be skipped, not rerun, with a trace line.
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json).toBeNull();
      expect(runsCount(dir), "a Stop whose tree matches the recorded verified tree must not rerun the verification commands").toBe(1);
      const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
      const traceLines = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      expect(traceLines.some((l) => l.reason === "verified-unchanged"), 'a verified-unchanged skip must append a trace line with that reason').toBe(true);

      // SubagentStop with nothing changed either: also skipped, sharing the same recorded verified tree.
      const r3 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
      expect(r3.json).toBeNull();
      expect(runsCount(dir), "a SubagentStop whose tree matches the recorded verified tree must not rerun the verification commands").toBe(1);
    });

    it("any difference in the tree since state.verified runs the commands again", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // run #1, records verified
      expect(runsCount(dir)).toBe(1);

      // The dirty path itself changes further: identity moves.
      writeFileSync(join(dir, "src/a.ts"), "edited again");
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a further edit to the already-dirty path must run verification again").toBe(2);

      // The session commits everything: HEAD moves, tree goes clean, but this session's own edit earlier
      // keeps `edited` true, so the gate still runs — and the recorded head no longer matches.
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "commit the edit"], { cwd: dir });
      // card verified-tree-record: the record of run #2 names this very tree and would (rightly) credit it across the
      // commit; this case pins state.verified's head signal, so the record is removed to isolate it.
      rmSync(join(dir, ".doug/.state/verified-tree.json"), { force: true });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a HEAD that moved since state.verified.head must run verification again").toBe(3);

      // A proposal-path file appears (added, not just modified): whichever the gate ultimately does with it
      // (block, or allow), the verification commands must still have run.
      const before = runsCount(dir);
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0001-x.md"), "# decision\n");
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a new proposal-path file on disk must run verification again").toBeGreaterThan(before);

      // A dirty path disappears.
      const before2 = runsCount(dir);
      rmSync(join(dir, "src/a.ts"));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a dirty path that was deleted must run verification again").toBeGreaterThan(before2);
    });

    it("a red gate records no verified tree, and an old-format state file with no state.verified key runs verification exactly as before", () => {
      const failConfig = { ...makeRunsConfig(10000), commands: { "test:unit": "exit 1" } };
      const dir = makeEditedProject(failConfig);
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.verified == null, "a red gate must not record a verified tree").toBe(true);

      // A separate, ordinary (old-format) state file: nothing has ever set state.verified. Verification
      // still runs, unaffected — exactly today's behavior.
      const dir2 = makeEditedProject(makeRunsConfig(10000));
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dir2 });
      expect(r2.json).toBeNull();
      expect(runsCount(dir2)).toBe(1);
    });

    // Second tester pass (reviewer-found gaps): each guard below isolates one signal sameTree must actually
    // compare, rather than letting some other coincidental change carry the assertion.
    it("a HEAD that moved since state.verified defeats the skip, even when the dirty set and its identities are completely untouched", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // run #1, records verified
      expect(runsCount(dir)).toBe(1);

      // HEAD moves; src/a.ts (the dirty path recorded in state.verified.tree) is not touched at all.
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "x"], { cwd: dir });
      // card verified-tree-record: the record of run #1 names this very tree and would (rightly) credit it across the
      // commit; this case pins state.verified's head signal, so the record is removed to isolate it.
      rmSync(join(dir, ".doug/.state/verified-tree.json"), { force: true });

      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(
        runsCount(dir),
        "a HEAD that moved since state.verified.head must defeat the skip even when the dirty set itself is byte-for-byte unchanged",
      ).toBe(2);
    });

    it("a gitignored proposal-path file that appears since state.verified defeats the skip, even though git status cannot see it", () => {
      const cfg = { ...makeRunsConfig(10000), proposalPaths: ["docs/decisions/**"] };
      const dir = makeProject({ config: cfg, git: true });
      writeFileSync(join(dir, ".gitignore"), "docs/decisions/\n.doug/.state/\n");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "base");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "src/a.ts"), "edited this session");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // run #1, records verified
      expect(runsCount(dir)).toBe(1);

      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0001-x.md"), "# decision\n"); // gitignored: invisible to `git status`

      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
      const traceLines = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const skipped = traceLines.some((l) => l.reason === "verified-unchanged");
      expect(skipped, "a gitignored proposal-path file that appeared since state.verified must not read as an unchanged tree").toBe(false);
      const ranOrBlocked = runsCount(dir) > 1 || (r.json && r.json.decision === "block");
      expect(ranOrBlocked, "the gate must not silently skip when a gitignored proposal-path file has newly appeared").toBe(true);
    });

    it("without git there is no head to fingerprint, so a green gate's tree is never trusted to skip a later Stop", () => {
      const dir = makeProject({ config: makeRunsConfig(10000), git: false });
      writeFileSync(join(dir, "a.ts"), "x");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });

      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r1.json).toBeNull();
      expect(runsCount(dir)).toBe(1);

      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json).toBeNull();
      expect(runsCount(dir), "without git there is no fingerprint to trust, so a later Stop must run the commands again rather than skip").toBe(2);
    });

    it("the verified-unchanged skip still fires the context-window notice, exactly like the onlyIfEdited (nothing-changed) skip does", () => {
      const cfg = { ...makeRunsConfig(10000), contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
      const dir = makeEditedProject(cfg);
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // green, records verified
      expect(r1.json).toBeNull();
      expect(runsCount(dir)).toBe(1);

      const statePath = join(dir, ".doug/.state/test-session.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.context = { pct: 85, at: Date.now() };
      writeFileSync(statePath, JSON.stringify(state));

      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json, "the verified-unchanged skip must still return the context-window notice, not a bare allow").not.toBeNull();
      expect(r2.json.systemMessage).toContain("Context at 85%");
      expect(existsSync(join(dir, ".doug/anchor.md")), "the notice must still write .doug/anchor.md").toBe(true);
      expect(runsCount(dir), "the skip itself must still have happened: the commands must not have rerun").toBe(1);
    });

    it("the verified-unchanged skip resets stopBlocks/agentBlocks exactly like an ordinary green gate does", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // green, records verified
      expect(r1.json).toBeNull();

      const statePath = join(dir, ".doug/.state/test-session.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.stopBlocks = 2;
      state.agentBlocks = { ag1: 2 };
      writeFileSync(statePath, JSON.stringify(state));

      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // nothing changed: skip
      expect(r2.json).toBeNull();
      const afterStop = JSON.parse(readFileSync(statePath, "utf8"));
      expect(afterStop.stopBlocks, "a verified-unchanged skip must reset stopBlocks to 0, exactly like an ordinary green Stop").toBe(0);

      const r3 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir }); // nothing changed: skip
      expect(r3.json).toBeNull();
      const afterSub = JSON.parse(readFileSync(statePath, "utf8"));
      expect(afterSub.agentBlocks.ag1, "a verified-unchanged skip must reset that agent's agentBlocks entry to 0, exactly like an ordinary green SubagentStop").toBe(0);
    });
  });

  describe("case 3: only one gate runs the commands at a time per project, via .doug/.state/gate.lock", () => {
    it("3a: holds gate.lock ({pid, session, at}) while its commands run, and removes it when they finish", () => {
      const dir = makeEditedProject(makeLockSeenConfig(10000));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const seenPath = join(dir, lockSeenRelpath);
      expect(existsSync(seenPath), "the gate's own command never saw .doug/.state/gate.lock while it ran").toBe(true);
      const seen = JSON.parse(readFileSync(seenPath, "utf8"));
      expect(typeof seen.pid).toBe("number");
      expect(seen.session).toBe("test-session");
      expect(typeof seen.at).toBe("number");
      expect(existsSync(lockPath(dir)), "the lock must be removed once the gate's commands finish").toBe(false);
    });

    it("3b: a lock whose pid is dead is stale, and is taken over rather than waited on", () => {
      const dir = makeEditedProject(makeLockSeenConfig(15000));
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      // A pid that is certainly free right now.
      const deadPid = 2 ** 22 - 1;
      let free = false;
      try {
        process.kill(deadPid, 0);
      } catch {
        free = true;
      }
      expect(free, "the chosen pid must actually be free for this test to mean anything").toBe(true);
      writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid, session: "someone-else", at: Date.now() }));
      const started = Date.now();
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const elapsed = Date.now() - started;
      expect(elapsed, "a stale lock (dead pid) must be taken over at once, not waited out for the timeout").toBeLessThan(8000);
      const seenPath = join(dir, lockSeenRelpath);
      expect(existsSync(seenPath)).toBe(true);
      const seen = JSON.parse(readFileSync(seenPath, "utf8"));
      expect(seen.session, "the gate must take the lock over with its own pid/session, not just run past someone else's stale one").toBe("test-session");
    });

    it("3c: a live lock is waited for, then state is reloaded and the reloaded verified tree is applied", () => {
      const dir = makeEditedProject(makeRunsConfig(5000));

      // Obtain a real state.verified via one green Stop.
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const statePath = join(dir, ".doug/.state/test-session.json");
      const savedState = readFileSync(statePath, "utf8");
      const parsed = JSON.parse(savedState);
      expect(parsed.verified, "case 2's mechanism must record a verified tree first, for this case to test anything").toBeTruthy();
      const before = runsCount(dir);

      // Strip verified from the state on disk, so this gate — absent the wait-then-reload — would see none
      // and rerun; a holder process will restore it partway through, as a concurrent gate's own green Stop
      // would have.
      writeFileSync(statePath, JSON.stringify({ ...parsed, verified: undefined }));

      // Holder: sleeps ~1.2s, then restores the saved (verified) state and releases the lock, as if it were
      // another gate that had just finished a green run of the same session.
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      const holderScript = join(dir, ".doug/.state/holder.mjs");
      writeFileSync(
        holderScript,
        [
          'import { writeFileSync, unlinkSync } from "node:fs";',
          "setTimeout(() => {",
          `  writeFileSync(${JSON.stringify(statePath)}, ${JSON.stringify(savedState)});`,
          `  try { unlinkSync(${JSON.stringify(lockPath(dir))}); } catch {}`,
          "}, 1200);",
        ].join("\n"),
      );
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));

      try {
        const started = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(r.json, "once the wait ends the reloaded verified tree matches, so the gate must allow").toBeNull();
        expect(elapsed, "a live lock must actually be waited for, not run past immediately").toBeGreaterThanOrEqual(900);
        expect(runsCount(dir), "after waiting, the reloaded state.verified matches the tree, so the commands must not run again").toBe(before);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });

    it("3d: the wait on a live lock is bounded by stopGate.timeoutMs and never hangs", () => {
      const dir = makeEditedProject(makeRunsConfig(1000));
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      const holderScript = join(dir, ".doug/.state/holder-long.mjs");
      writeFileSync(holderScript, "setTimeout(() => {}, 15000);"); // outlives the gate's own 1000ms timeout by far
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
      try {
        const started = Date.now();
        runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(elapsed, "a live lock must never be waited past stopGate.timeoutMs").toBeLessThan(8000);
        expect(elapsed, "the gate must actually have waited roughly timeoutMs, not returned immediately").toBeGreaterThanOrEqual(900);
        expect(runsCount(dir), "once the bound is hit the gate must proceed and run its own commands rather than give up silently").toBe(1);
        expect(existsSync(lockPath(dir)), "having taken the lock over past the bound, the gate must release it again once its own commands finish").toBe(false);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });

    // Second tester pass (reviewer-found gap): a lock file whose pid is not a real, checkable pid at all
    // (0, -1, a non-numeric value, or not even JSON) is garbage, not a live holder, and must be taken over
    // immediately rather than believed. process.kill(0, 0) and process.kill(-1, 0) do not throw (0 means "this
    // process's own group"; -1 broadcasts to every process the caller may signal), so a liveness check that
    // hands either straight to process.kill(pid, 0) reads them as live.
    for (const [label, lockContent] of [
      ["pid 0", JSON.stringify({ pid: 0, session: "x", at: Date.now() })],
      ["pid -1", JSON.stringify({ pid: -1, session: "x", at: Date.now() })],
      ['a non-numeric pid ("abc")', JSON.stringify({ pid: "abc", session: "x", at: Date.now() })],
      ["non-JSON text", "not json at all"],
    ]) {
      it(`a garbage lock (${label}) is stale and taken over immediately, not waited out for the timeout`, () => {
        const dir = makeEditedProject(makeRunsConfig(15000));
        mkdirSync(join(dir, ".doug/.state"), { recursive: true });
        writeFileSync(lockPath(dir), lockContent);
        const started = Date.now();
        runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(elapsed, `a garbage lock (${label}) must be taken over at once, not waited out for the timeout`).toBeLessThan(8000);
        expect(existsSync(lockPath(dir)), `after taking over a garbage lock (${label}), the gate must release its own lock once its commands finish`).toBe(false);
        expect(runsCount(dir), `taking over a garbage lock (${label}) must still let the gate's own commands run`).toBe(1);
      });
    }

    it("the wait bound on a live lock scales with the number of configured commands (timeoutMs x count), not a single flat timeoutMs", () => {
      const twoCommandConfig = {
        ...baseConfig,
        commands: {
          "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"`,
          "test:extra": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','y')"`,
        },
        stopGate: { commands: ["test:unit", "test:extra"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 600, requireEvidence: false },
        trace: { enabled: true },
      };
      const dir = makeEditedProject(twoCommandConfig);
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      const holderScript = join(dir, ".doug/.state/holder-scale.mjs");
      writeFileSync(holderScript, "setTimeout(() => {}, 3000);"); // outlives even the scaled (600 x 2) bound
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
      try {
        const started = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(
          elapsed,
          "with two configured commands, the wait bound must scale to roughly timeoutMs x 2 (≈1.1s here), not a single flat timeoutMs (≈0.6s)",
        ).toBeGreaterThanOrEqual(1100);
        expect(r.status, "the gate must still return once the (scaled) bound is hit, never hang").toBe(0);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });
  });
});

// card stop-gate-lock-release-on-throw: an exception inside runVerification, after gate.lock is taken, still
// reaches runHook (lib/io.mjs), which fails open — but until this card, nothing released the lock on that
// path, leaving it behind for a reused pid or a slow platform to make a later gate wait on a lock nobody
// holds. The forced throw here is input-only: cfg.protectedPaths set to [42] (a valid array holding a
// non-string entry) makes matchAny's `raw.startsWith("!")` (lib/glob.mjs) throw "raw.startsWith is not a
// function" the first time scanTreeProblems' step-1 protected-paths check calls it
// (`changed.filter((f) => matchAny(cfg.protectedPaths, f) ...)`, stop-gate.mjs:965) — inside runVerification
// (called from stop-gate.mjs:1247), after gate.lock is already taken, and before any verification command
// runs. Card gates-config-shape-check, then gates-config-shape-all-arrays, normalise every array-typed
// DEFAULTS key (protectedPaths, proposalPaths, allowedOutsidePaths, bash.denyForcePushTo,
// secrets.placeholders, secrets.ignorePaths, stopGate.commands, stopGate.ignoreChangedPaths,
// stopGate.evidencePatterns, anchor) to its default when the value is not an array at all — but a
// wrong-typed entry INSIDE a valid array stays out of scope for that check (gates-config-shape-all-arrays.md's
// Rules), so an array like [42] still passes shape normalisation unchanged and still reaches this same throw.
// Confirmed through the real hook (a scratch copy of plugins/doug-gates, run via spawnSync exactly as
// runHookScript does, never the live plugin files): protectedPaths: [42] throws with the stack
// `matchAny (lib/glob.mjs:78) -> stop-gate.mjs:965 (scanTreeProblems step 1) -> runVerification
// (stop-gate.mjs:1247) -> stop-gate.mjs:1421 -> io.mjs runHook`, after the lock-acquire block above it (L1);
// with the exit handler's `releaseLock()` call removed (the same mutation the reviewer names), gate.lock is
// left behind (probe: "lock exists after: true"), so L1 actually goes red on that mutation. proposalPaths is
// the wrong key for this: cfg.proposalPaths is walked once already, on the FIRST Stop, at stop-gate.mjs:876
// (`walkProposalPathFiles(dir, cfg.proposalPaths)`, the baseline capture) — well before gate.lock is ever
// taken — so `proposalPaths: [42]` (this describe's original forced throw, and an earlier revision of this
// comment) throws inside `fixedPrefix` (lib/baseline.mjs:105) via that walk, and the same probe with that
// mutation applied still shows "lock exists after: false": the lock was never taken, so removing
// `releaseLock()` changes nothing and L1 would not have pinned the release-on-throw behaviour at all. L3 below
// reaches the same protectedPaths throw on the SubagentStop reviewer-skip path (lockOwned never set true, the
// same probe there also confirms the live holder's lock file is left byte-for-byte unchanged).
describe("card stop-gate-lock-release-on-throw", () => {
  const lockPath = (dir) => join(dir, ".doug/.state/gate.lock");

  // Same dirty-project shape as makeEditedProject above (this describe sits outside that one's scope), plus
  // whatever config the case needs.
  function makeDirtyProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const throwConfig = {
    ...baseConfig,
    protectedPaths: [42],
    commands: { test: `${process.execPath} -e "process.exit(0)"` },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  };

  it("L1 (red at HEAD): a forced throw after gate.lock is taken still fails open, and now releases the lock", () => {
    const dir = makeDirtyProject(throwConfig);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    // The fail-open decision itself is unchanged by this card (a hook reader must never throw).
    expect(r.status).toBe(0);
    expect(
      r.json && r.json.systemMessage,
      `expected a "hook error, failing open" systemMessage; got ${JSON.stringify(r.json)}, stderr=${r.stderr}`,
    ).toMatch(/hook error, failing open/);
    // The bug this card fixes: at HEAD, gate.lock is left behind here.
    expect(existsSync(lockPath(dir)), "gate.lock must not be left behind once the hook has failed open").toBe(false);
  });

  it("L2 (guard, green at HEAD): an ordinary run with no throw still removes the lock", () => {
    const dir = makeDirtyProject(baseConfig);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    expect(existsSync(lockPath(dir)), "an ordinary green gate must still release the lock through the existing wrappers").toBe(false);
  });

  it("L3 (guard): a forced throw in a gate that never owned the lock leaves another live holder's lock untouched", () => {
    // agent_type "reviewer" is in READ_ONLY_AGENT_TYPES (agentMadeNoChanges), so this SubagentStop's own
    // agent counts as having made no changes: skipVerification is true, the whole gate.lock acquire section
    // (guarded by `if (!skipVerification)`) never runs, and lockOwned stays false all the way into
    // runVerification, which still throws at the same protected-paths check (scanTreeProblems is called
    // unconditionally from runVerification, regardless of skipVerification). This is the one shape that
    // reaches the throw point without this gate ever touching the lock at all.
    const dir = makeDirtyProject(throwConfig);
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const holderScript = join(dir, ".doug/.state/holder-throw.mjs");
    writeFileSync(holderScript, "setTimeout(() => {}, 15000);");
    const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
    const lockContent = JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() });
    writeFileSync(lockPath(dir), lockContent);
    try {
      const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "reviewer" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json && r.json.systemMessage, `expected a "hook error, failing open" systemMessage; got ${JSON.stringify(r.json)}`).toMatch(/hook error, failing open/);
      expect(
        readFileSync(lockPath(dir), "utf8"),
        "a gate that never owned the lock must never remove or alter another live holder's lock file",
      ).toBe(lockContent);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });
});

// card stop-gate-lock-release-pins: found by the reviewer's two coverage minors (M2b and M5) on card
// stop-gate-lock-release-on-throw (4ef4903) — nothing pinned that releaseLock's pid comparison actually
// matters (dropping it left the whole file green), and nothing pinned that the *Releasing wrappers release
// the lock themselves rather than relying solely on the process.on("exit", ...) handler (stripping
// releaseLock() out of allowReleasing/blockStopReleasing/systemMessageReleasing also left the whole file
// green). Tests only, no production change.
describe("card stop-gate-lock-release-pins", () => {
  const lockRelpath = ".doug/.state/gate.lock";
  const lockWrittenRelpath = ".doug/.state/lock-written.json";
  const lockPath = (dir) => join(dir, lockRelpath);

  // Same dirty-project shape used by the neighboring "card stop-gate-lock-release-on-throw" describe (that
  // describe's own makeDirtyProject is out of scope here).
  function makeDirtyProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  // P1 (reviewer's R1 shape): a verification command overwrites gate.lock with {pid: <another live pid>,
  // session, at} while it runs, then exits 1. releaseLock's pid comparison (`lock.pid === process.pid`) must
  // see a foreign pid and leave the file alone; without that comparison (M1: keep only `if (!lockOwned)
  // return`), releaseLock would unlink it regardless of who owns it now, and this test would fail because
  // gate.lock would be gone instead of byte-identical to what the command wrote.
  it("P1: a verification command that overwrites gate.lock with another live pid still leaves it untouched, byte-identical, and the gate still blocks", () => {
    let holder;
    try {
      // A real, live pid this test does not own but can prove is alive and can clean up.
      holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      const foreignPid = holder.pid;
      const command =
        `${process.execPath} -e "const fs=require('fs'); ` +
        `const c=JSON.stringify({pid:${foreignPid},session:'foreign-session',at:Date.now()}); ` +
        `fs.writeFileSync('${lockRelpath}', c); ` +
        `fs.copyFileSync('${lockRelpath}','${lockWrittenRelpath}'); ` +
        `process.exit(1)"`;
      const dir = makeDirtyProject({
        ...baseConfig,
        commands: { test: command },
        stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision, "a failing verification command must still block the stop").toBe("block");
      expect(existsSync(lockPath(dir)), "gate.lock must still exist: it was overwritten by a live foreign pid, not this gate's own").toBe(true);
      const writtenPath = join(dir, lockWrittenRelpath);
      expect(existsSync(writtenPath), "the command's own copy of what it wrote must exist for this test to mean anything").toBe(true);
      expect(
        readFileSync(lockPath(dir), "utf8"),
        "gate.lock must be byte-identical to what the command wrote: releaseLock must never touch a lock file whose pid is not this process's own",
      ).toBe(readFileSync(writtenPath, "utf8"));
    } finally {
      if (holder) {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  });

  // P2 (the wrappers' own release, not just the exit handler): on a normal path that actually emits stdout
  // JSON (allow() emits nothing at all, so this needs a path through blockStop — a failing verification
  // command), gate.lock must already be gone by the moment the hook's stdout JSON arrives at an outside
  // reader, not merely by the time the process has exited. The wrappers call releaseLock() before emit()
  // (lib/io.mjs's blockStop writes stdout then calls process.exit(0)); with that call stripped from
  // blockStopReleasing (M2), the process.on("exit", ...) handler would still release the lock, but only
  // after emit() has already written to stdout — reversing the order this test observes. Verified
  // empirically against both HEAD and a scratch copy with M2 applied (never against the real production
  // file, and never committed): on this platform, HEAD showed the lock already gone at the first stdout
  // chunk 70/70 runs, and the M2 mutant showed it still present 70/70 runs — fully deterministic and
  // discriminating in both directions here, because unlinkSync (a blocking syscall) either strictly precedes
  // or strictly follows the stdout write in the child's own program order, and that order is what this test
  // observes.
  it("P2: gate.lock is already gone the moment the hook's stdout JSON arrives, not only after the process has exited", async () => {
    const command = `${process.execPath} -e "process.exit(1)"`;
    const dir = makeDirtyProject({
      ...baseConfig,
      commands: { test: command },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(scriptsDir, "stop-gate.mjs")], {
        cwd: dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let lockGoneAtFirstData = null;
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (lockGoneAtFirstData === null) {
          // Checked synchronously, in the same tick the first byte of stdout arrives — before anything else
          // this test does can run.
          lockGoneAtFirstData = !existsSync(lockPath(dir));
        }
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, lockGoneAtFirstData }));
      child.stdin.write(JSON.stringify({ session_id: "test-session", cwd: dir, hook_event_name: "Stop" }));
      child.stdin.end();
    });
    const line = result.out.trim().split("\n").filter(Boolean).pop();
    const json = line ? JSON.parse(line) : null;
    expect(json && json.decision, "the hook must actually have reached the blockStopReleasing path for this test to mean anything").toBe("block");
    expect(
      result.lockGoneAtFirstData,
      "gate.lock must already be gone by the time the hook's stdout JSON reaches an outside reader",
    ).toBe(true);
  });

  // P3 (same observation as P2, a different path to systemMessageReleasing): the counter-cap stand-down at
  // the top of runVerification (`blocksSoFar >= maxBlocks`) is reached only after the gate has already
  // acquired gate.lock — writeGateLock runs unconditionally for the main Stop (skipVerification is only ever
  // true for a SubagentStop) just above runVerification's own definition, and a fresh project with no
  // existing lock file always succeeds at it. Seeded exactly like the neighboring "stood-down: a stand-down
  // at the counter cap ..." test (case 3 describe, baseConfig.stopGate.maxBlocks 3): a session already
  // blocked 3 times stands down on this Stop before any command runs, past the lock acquisition earlier in
  // the file. With releaseLock() stripped from systemMessageReleasing (M2), the exit handler would still
  // release the lock, but only after emit() has already written stdout — reversing the order this test
  // observes, exactly like P2's reasoning for blockStopReleasing. (allow() emits no stdout at all — see
  // io.mjs — so the green allow path gives an outside reader nothing to observe here, and stays unpinned by
  // design.)
  it("P3: gate.lock is already gone the moment the counter-cap stand-down's systemMessage JSON arrives, not only after the process has exited", async () => {
    const dir = makeDirtyProject({
      ...baseConfig,
      commands: { test: "exit 1" },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // Already at the cap before this Stop even runs, so runVerification's first check stands down at once.
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 3 }));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(scriptsDir, "stop-gate.mjs")], {
        cwd: dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let lockGoneAtFirstData = null;
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (lockGoneAtFirstData === null) {
          // Checked synchronously, in the same tick the first byte of stdout arrives — before anything else
          // this test does can run.
          lockGoneAtFirstData = !existsSync(lockPath(dir));
        }
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, lockGoneAtFirstData }));
      child.stdin.write(JSON.stringify({ session_id: "test-session", cwd: dir, hook_event_name: "Stop" }));
      child.stdin.end();
    });
    const line = result.out.trim().split("\n").filter(Boolean).pop();
    const json = line ? JSON.parse(line) : null;
    expect(
      json && json.systemMessage,
      "the hook must actually have reached the counter-cap stand-down inside runVerification for this test to mean anything",
    ).toContain("standing down");
    expect(
      result.lockGoneAtFirstData,
      "gate.lock must already be gone by the time the stand-down's systemMessage JSON reaches an outside reader",
    ).toBe(true);
  });
});

// card stop-gate-budget-under-hook-timeout: the platform kills the Stop/SubagentStop hook itself at its own
// `timeout` (hooks.json/settings.json: 600s), and a timed-out hook is cancelled, fails open, and its output is
// discarded (research note: docs/en/hooks — "Claude Code cancels it and treats it as a failed hook", "A timed-out
// hook doesn't block the action", "Output is discarded"). Case 3's scaled wait bound (stopGate.timeoutMs x
// command count, above) can itself exceed that platform timeout, so a waiter riding it out — or a holder whose
// commands both run to their own timeoutMs — can be killed by the platform mid-command: an ungated stop, and
// any block message it printed is lost. stopGate.hookTimeoutSec (new config key, must equal the stop-gate
// hook's declared `timeout`) bounds the whole gate — wait plus commands, with a margin — under that platform
// timeout: a waiter that would outrun the budget refuses the stop instead of taking over past it, a lock older
// than the budget is stale regardless of a live pid, and a holder drops (never starts) a command that cannot
// fit in what is left, naming it in the block message, rather than let the platform cut it off mid-run.
// Fixture `hookTimeoutSec` values are small (2) so these stay fast to run once the mechanism exists.
describe("card stop-gate-budget-under-hook-timeout", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const lockRelpath = ".doug/.state/gate.lock";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);
  const lockPath = (dir) => join(dir, lockRelpath);
  const appendCommand = (relpath) => `${process.execPath} -e "require('fs').appendFileSync('${relpath}','x')"`;
  const sleepCommand = (ms) => `${process.execPath} -e "setTimeout(() => {}, ${ms})"`;

  // Same shape as case 2/3's own makeEditedProject just above: a git repo, a base commit, then one file this
  // session edited, so onlyIfEdited's anyChange is true and the gate reaches the lock/verification steps
  // instead of exiting early on nothing-changed.
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

  // A node process that stays alive for `ms` before exiting on its own — a "live" lock pid the gate must
  // treat as a real holder, not a dead or garbage one.
  function spawnHolder(dir, ms) {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const script = join(dir, `.doug/.state/holder-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(script, `setTimeout(() => {}, ${ms});`);
    return spawn(process.execPath, [script], { cwd: dir, stdio: "ignore" });
  }

  it("B1: a live lock still held when the hook-timeout budget runs out refuses the stop instead of taking over", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { "test:unit": appendCommand(runsLogRelpath) },
      // R3 (fix pass, flake): hookTimeoutSec: 2 gave a margin of only 200ms between the refusal deadline
      // and the lock's own stale-by-age threshold (hookTimeoutMs), so a slow spawn under load could cross
      // staleness first and take the lock over instead of refusing. hookTimeoutSec: 3 (margin 300ms) keeps
      // the same assertions with more room; nothing this test checks changed.
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
      trace: { enabled: true },
    });
    const holder = spawnHolder(dir, 12000); // outlives both the hook-timeout budget and stopGate.timeoutMs's old scaled bound
    writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
    try {
      const started = Date.now();
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const elapsed = Date.now() - started;
      expect(
        elapsed,
        "hookTimeoutSec: 3 must cut the wait off under the hook's own timeout, not ride stopGate.timeoutMs's scaled bound (10s here) out",
      ).toBeLessThan(4000);
      expect(r.json && r.json.decision, "a waiter that would outrun the hook's own timeout must refuse (block) the stop, never allow it").toBe("block");
      expect(r.json.reason, "the refusal must name the session still holding the lock").toContain("holder-session");
      expect(runsCount(dir), "a refused waiter must never run its own commands").toBe(0);
      expect(existsSync(lockPath(dir)), "a refused waiter must leave the holder's lock in place, not take it over").toBe(true);
      const lock = JSON.parse(readFileSync(lockPath(dir), "utf8"));
      expect(lock.session, "the lock on disk must still belong to the original holder").toBe("holder-session");
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("B2: a live lock older than the hook-timeout budget is stale by age and is taken over at once, not waited on", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { "test:unit": appendCommand(runsLogRelpath) },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 15000, hookTimeoutSec: 20, requireEvidence: false },
      trace: { enabled: true },
    });
    const holder = spawnHolder(dir, 25000); // pid stays live throughout; only its lock's age must make it stale
    writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() - 60_000 }));
    try {
      const started = Date.now();
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const elapsed = Date.now() - started;
      expect(
        elapsed,
        "a lock whose age (60s) already exceeds the hook-timeout budget (20s) is stale even with a live pid — no legitimate holder could still be running — and must be taken over at once",
      ).toBeLessThan(8000);
      expect(runsCount(dir), "having taken the stale-by-age lock over, the gate must run its own command").toBe(1);
      expect(existsSync(lockPath(dir)), "the gate must release the lock again once its own command finishes").toBe(false);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("B3: a command is clamped to what's left of the hook-timeout budget, timing out and blocking rather than running to its own timeoutMs", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(10000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 2, requireEvidence: false },
      trace: { enabled: true },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      "the command's own timeoutMs (60s) must be clamped to what's left of the hook-timeout budget (2s) so it cannot run anywhere near its configured timeout",
    ).toBeLessThan(3000);
    expect(r.json && r.json.decision, "a command cut off by the budget must block, not pass").toBe("block");
    expect(r.json.reason.toLowerCase()).toContain("timed out");
  });

  it("B4: a second command that cannot fit before the hook-timeout budget runs out is dropped, named 'not run', and never started", () => {
    const secondCommand = appendCommand(runsLogRelpath);
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(10000), second: secondCommand },
      stopGate: { commands: ["slow", "second"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 2, requireEvidence: false },
      trace: { enabled: true },
    });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "the second command must never run once the first has used up the hook-timeout budget").toBe(0);
    expect(r.json && r.json.decision, "a dropped command must still block the stop").toBe("block");
    const idx = r.json.reason.indexOf(secondCommand);
    expect(idx, `the block reason must name the dropped command:\n${r.json.reason}`).toBeGreaterThanOrEqual(0);
    expect(r.json.reason.slice(idx), "'not run' must follow the named dropped command").toContain("not run");
    expect(r.json.reason.toLowerCase(), "the reason must say why: the hook's own budget ran out before the command could start").toContain("budget");
  });

  // Pass 2 (reviewer findings R1/R2, 2026-09-16): T1-T5 below pin the fixes and the mechanisms the reviewer's
  // surviving mutations found untested. T1 mirrors the tests-red-by-design section's own setup (a SubagentStop
  // from agent_type tester with a tests_red_by_design claim), so it lives here rather than nested there.
  const claim = (files) => JSON.stringify({ tests_red_by_design: files });

  it("T1 (R1): a claim covering only command 1's failure does not also excuse command 2 being dropped for budget: the gate still blocks, naming command 2 as not run", () => {
    const secondCommand = appendCommand(runsLogRelpath);
    // "first" prints its FAIL line immediately, then sleeps far longer than any possible budget, so it is
    // always killed right at whatever budget remained when it started - leaving ~0 (or less) for "second"
    // regardless of how much the surrounding harness overhead varies. This makes the drop deterministic
    // without pinning a fragile pair of sleep/budget numbers against each other.
    const firstCommand = `echo ' FAIL  tests/a.test.mjs > it'; ${sleepCommand(30000)}`;
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { first: firstCommand, second: secondCommand },
      stopGate: { commands: ["first", "second"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 3, requireEvidence: false },
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the tests; command 1 is red as designed.\n${claim(["tests/a.test.mjs"])}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(runsCount(dir), "the second command must never run once command 1 used up the hook-timeout budget").toBe(0);
    expect(
      r.json && r.json.decision,
      "a claim that covers command 1's failure must not also cover a command dropped for budget: that part of verification never ran, so the gate must still block",
    ).toBe("block");
    expect(r.json.reason, "the pass-1 red-by-design systemMessage must not appear here").not.toContain("red by design");
    const idx = r.json.reason.indexOf(secondCommand);
    expect(idx, `the block reason must name the dropped command:\n${r.json.reason}`).toBeGreaterThanOrEqual(0);
    expect(r.json.reason.slice(idx)).toContain("not run");
  });

  it('T2 (A5): a garbage hookTimeoutSec ("abc", -1, 0) behaves as the platform default 600, never a fail-open', () => {
    for (const hookTimeoutSec of ["abc", -1, 0]) {
      const dir = makeEditedProject({
        ...baseConfig,
        commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" },
        stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec, requireEvidence: false },
      });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision, `hookTimeoutSec ${JSON.stringify(hookTimeoutSec)} must read as 600 and still run the command, never fail open`).toBe("block");
      expect(r.json.reason).toContain("FAIL");
    }
  });

  it("T3 (A6): a live-pid lock with no `at`, or a non-numeric `at`, is not stale by age: it is waited for and refused like any other live lock", () => {
    for (const lockExtra of [{}, { at: "not-a-number" }]) {
      const dir = makeEditedProject({
        ...baseConfig,
        commands: { "test:unit": appendCommand(runsLogRelpath) },
        stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
      });
      const holder = spawnHolder(dir, 12000);
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", ...lockExtra }));
      try {
        const started = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(
          elapsed,
          `a live-pid lock with ${JSON.stringify(lockExtra)} for \`at\` must be waited on for the hook-timeout budget, not treated as stale by age`,
        ).toBeGreaterThan(1500);
        expect(elapsed).toBeLessThan(4500);
        expect(r.json && r.json.decision, "it must be refused (blocked), never taken over").toBe("block");
        expect(r.json.reason).toContain("holder-session");
        expect(existsSync(lockPath(dir)), "a refused waiter must leave the holder's lock in place").toBe(true);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  });

  it("T4 (A3/A4): a refusal counts against maxBlocks like any other block, and maxBlocks caps it with the standing-down systemMessage", () => {
    const commonStopGate = { commands: ["test:unit"], onlyIfEdited: true, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false };

    // Two refusals in the same session count up: (1/3), then (2/3). The lock's `at` is refreshed to "now"
    // right before each call: a real holder's own `at` never moves, so one refusal already spends most of
    // lockStaleByAge's budget (hookTimeoutMs) off the original write, and a second full wait-then-refuse
    // cycle against that same stale timestamp would legitimately (and correctly) find the lock stale by
    // age instead of live - taking it over rather than refusing again. Refreshing `at` simulates a holder
    // that is still genuinely within its own hook-timeout window at the moment of each check, which is what
    // "another gate is still running the verification commands" means here, without weakening B2/T3's own
    // coverage of the stale-by-age path itself.
    {
      const dir = makeEditedProject({ ...baseConfig, commands: { "test:unit": appendCommand(runsLogRelpath) }, stopGate: { ...commonStopGate, maxBlocks: 3 } });
      const holder = spawnHolder(dir, 20000);
      try {
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r1.json && r1.json.decision).toBe("block");
        expect(r1.json.reason).toContain("(1/3)");
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r2.json && r2.json.decision).toBe("block");
        expect(r2.json.reason).toContain("(2/3)");
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }

    // With maxBlocks: 1, the second refusal stands down instead of blocking again.
    {
      const dir = makeEditedProject({ ...baseConfig, commands: { "test:unit": appendCommand(runsLogRelpath) }, stopGate: { ...commonStopGate, maxBlocks: 1 } });
      const holder = spawnHolder(dir, 20000);
      try {
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r1.json && r1.json.decision).toBe("block");
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r2.json && r2.json.decision, "the second refusal must stand down, not block again").toBeUndefined();
        expect(r2.json.systemMessage).toContain("standing down");
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  });

  it("T5 (R2): timeoutMs: 0 does not bypass the hook-timeout budget: the command is still clamped and the gate blocks in time", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(10000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 0, hookTimeoutSec: 2, requireEvidence: false },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      "timeoutMs: 0 must not let the command run unclamped to its natural length (10s); it must still be cut to what's left of the hook-timeout budget",
    ).toBeLessThan(3000);
    expect(r.json && r.json.decision, "a command cut off by the budget must block, not pass").toBe("block");
    expect(r.json.reason.toLowerCase()).toContain("timed out");
  });
});

// card stop-gate-timeout-normalise: reviewer findings on stop-gate-budget-under-hook-timeout (0efee81), pass 2
// minors. (1) A fractional stopGate.timeoutMs between 0 and 1 (e.g. 0.5) passes the finite-positive check, floors
// to 0, and spawnSync reads a timeout of 0 as none — the command then runs past the hook-timeout budget instead
// of being clamped. (2) Nothing pinned the Math.floor itself: a fractional timeoutMs such as 2.5 must still floor
// and clamp, not reach spawnSync un-floored. (3) Nothing pinned a lock that is fresh when the wait begins but
// goes stale by age partway through it: it must be taken over once it ages out, not refused.
describe("card stop-gate-timeout-normalise", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const lockRelpath = ".doug/.state/gate.lock";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);
  const lockPath = (dir) => join(dir, lockRelpath);
  const appendCommand = (relpath) => `${process.execPath} -e "require('fs').appendFileSync('${relpath}','x')"`;
  const sleepCommand = (ms) => `${process.execPath} -e "setTimeout(() => {}, ${ms})"`;

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

  function spawnHolder(dir, ms) {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const script = join(dir, `.doug/.state/holder-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(script, `setTimeout(() => {}, ${ms});`);
    return spawn(process.execPath, [script], { cwd: dir, stdio: "ignore" });
  }

  it("T1: a fractional timeoutMs below 1 (0.5) is clamped to at least 1ms, not floored to 0 (which spawnSync reads as no timeout)", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(5000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 0.5, hookTimeoutSec: 2, requireEvidence: false },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      "timeoutMs: 0.5 must not floor to 0 (spawnSync treats 0 as no timeout, letting the 5s command run to completion past the budget); it must clamp to at least 1ms and the gate must still block in time",
    ).toBeLessThan(3000);
    expect(r.json && r.json.decision, "a command that ran unclamped past the budget must not be allowed to pass").toBe("block");
  });

  it("T2: a fractional timeoutMs above 1 (2.5) still floors and clamps, never reaching spawnSync un-floored", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(5000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 2.5, hookTimeoutSec: 2, requireEvidence: false },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(elapsed, "timeoutMs: 2.5 must floor and clamp the command's timeout, cutting it off well under its 5s natural length").toBeLessThan(3000);
    expect(r.json && r.json.decision, "a fractional timeoutMs must never make the gate fail open (no decision) or pass unverified").toBe("block");
  });

  it("T3: a lock fresh when the wait begins but stale by age before the refusal deadline is taken over mid-wait, not refused", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { "test:unit": appendCommand(runsLogRelpath) },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
    });
    // hookTimeoutSec: 3 => hookTimeoutMs 3000 (the stale-by-age threshold) and a refusal deadline ~2700ms after
    // gate start (marginMs 300). at: now - 2000 is fresh at the start (2000 < 3000) but ages past 3000 about 1s
    // into the wait — well before the 2700ms refusal deadline — so a correct gate takes it over mid-wait.
    const holder = spawnHolder(dir, 12000);
    writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() - 2000 }));
    try {
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const refused = !!(r.json && r.json.reason && r.json.reason.includes("ran out while waiting"));
      expect(
        refused,
        `a lock that ages out mid-wait must be taken over, not refused as though it were still live for the whole budget (got: ${JSON.stringify(r.json)})`,
      ).toBe(false);
      expect(runsCount(dir), "having taken the lock over once it aged out, the gate must run its own command").toBe(1);
      expect(existsSync(lockPath(dir)), "the gate must release the lock again once its own command finishes").toBe(false);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });
});
