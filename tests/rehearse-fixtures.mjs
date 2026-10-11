// Shared helpers for tests/rehearse.test.mjs and tests/rehearse-auto.test.mjs (card split-git-hooks-rehearse-tests):
// moved verbatim from the original single file so both halves use one copy. Each test file keeps its own afterAll
// cleanup of `tempDirs` and its own vi.setConfig.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanEnv } from "../scripts/rehearse-lib.mjs";
import { BOARD_RELPATH } from "../plugins/doug-flow/lib/board.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
export const cli = join(here, "..", "scripts", "rehearse.mjs");
export const TEST_PREFIX = "doug-rehearse-test-"; // distinct from a real run's "doug-rehearse-<scenario>-" (review #7)

// Every temp directory this file creates is removed here, whether the test that made it passed or not.
export const tempDirs = [];
export function trackedTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// A fake `claude` executable: writes a marker file (if given) and/or its argv (if given), then prints the given
// stream-json lines and exits 0. No extension and a shebang, like packages/doug-codex/tests/helpers.ts's fake
// codex, so `spawnSync(bin, ...)` runs it directly.
export function makeFakeClaude(streamText = "", { marker = null, argvFile = null } = {}) {
  const dir = trackedTempDir("fake-claude-");
  const bin = join(dir, "claude");
  const lines = String(streamText)
    .split("\n")
    .filter(Boolean)
    .map((l) => `process.stdout.write(${JSON.stringify(l)} + "\\n");`)
    .join("\n");
  const script = [
    "#!/usr/bin/env node",
    marker ? `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");` : "",
    argvFile ? `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));` : "",
    lines,
    "process.exit(0);",
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

export function cannedStream({ plugins = ["doug-flow"], commands = ["doug-flow:doug-next"], cost = 0.01 } = {}) {
  const init = { type: "system", subtype: "init", plugins: plugins.map((name) => ({ name, path: "/x", source: `${name}@inline` })), slash_commands: commands };
  const result = { type: "result", total_cost_usd: cost, num_turns: 1 };
  return `${JSON.stringify(init)}\n${JSON.stringify(result)}\n`;
}

// Every spawn this file makes uses the library's own cleanEnv, so the file is green whether or not a leaked
// CLAUDE_PROJECT_DIR/GIT_* is set in this process's environment (card workflow-rehearsal-review, round 2).
//
// Load-proofing (card rehearse-worker-rpc-timeout): vitest's worker answers its main process over an RPC whose
// calls time out after 60 s (DEFAULT_TIMEOUT in vitest's dist/chunks/index.68735LiX.js, raised as "[vitest-worker]:
// Timeout calling onTaskUpdate" from rpc.C3q9uwRX.js). A synchronous spawn (spawnSync, execFileSync) blocks this
// worker's event loop for as long as the child runs, so on a loaded machine a run of consecutive sync spawns
// (prepareFixture alone is a shell setup, doug init, and a dozen git calls) outlasts that timeout and the whole
// file fails to report. So no test here spawns synchronously: child processes go through `run` (async spawn) and
// the rehearse-lib functions that spawn internally go through `inLib` (a worker thread, whose own loop is the one
// that blocks). Only the spawn mechanics are async; every assertion is unchanged.
//
// With the loop turning, vitest's per-test timeout (20 s in vitest.config.ts) is enforceable here, which it never
// was while a sync spawn blocked the worker: a test that builds a fixture (a shell setup, doug init, git) takes
// seconds on an idle machine and minutes on a loaded one. This file's own bound is a ceiling for a hung child,
// not a performance pin.
//
// An async spawn that never rejects: resolves { status, stdout, stderr, error } like spawnSync's result.
export function run(bin, args, { cwd, env, trim = false } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let error = null;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ status: null, stdout, stderr, error: e });
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => (error = e));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: trim ? stdout.trim() : stdout, stderr, error }));
  });
}
export async function git(dir, ...args) {
  const r = await run("git", args, { cwd: dir, env: cleanEnv(), trim: true });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}
export function spawnScript(script, args) {
  return run(process.execPath, [script, ...args], { env: cleanEnv() });
}

// Calls a rehearse-lib export in a worker thread and resolves with its (structured-cloned) return value, or
// rejects with an Error carrying the thrown message. The worker takes its environment from process.env at the
// moment of the call, so a test that sets CLAUDE_PROJECT_DIR around a call still hands the library that value.
// A stage object holds functions and cannot be cloned, so a stage argument is passed as { $expr: "<source>" },
// evaluated inside the worker with the library bound to `lib` (e.g. "lib.SCENARIO_STAGES.hand[0]").
const LIB_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "rehearse-lib.mjs")).href;
const LIB_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  try {
    const lib = await import(workerData.libUrl);
    const args = workerData.args.map((a) => (a && typeof a.$expr === "string" ? new Function("lib", "return " + a.$expr)(lib) : a));
    parentPort.postMessage({ value: await lib[workerData.fn](...args) });
  } catch (e) {
    parentPort.postMessage({ error: String((e && e.message) || e) });
  }
})();
`;
export function inLib(fn, ...args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(LIB_WORKER, { eval: true, env: { ...process.env }, workerData: { libUrl: LIB_URL, fn, args } });
    worker.once("message", (m) => {
      worker.terminate();
      if (m.error === undefined) resolve(m.value);
      else reject(new Error(m.error));
    });
    worker.once("error", reject);
    // A no-op once the message has settled the promise; otherwise a worker that exits silently cannot hang the test.
    worker.once("exit", (code) => reject(new Error(`rehearse-lib worker exited (${code}) without a result`)));
  });
}

// The uncommitted move /doug-next's own step 1 does before it ever reaches the planner (task
// rehearse-uncommitted-move: the move stays uncommitted working state, landing only in the card's landing
// commit), used by the flow gate tests below to build the exact fixture state a correct run leaves.
export function moveUncommitted(dir) {
  const board = JSON.parse(readFileSync(join(dir, BOARD_RELPATH), "utf8"));
  board.cards.find((c) => c.id === "fix-hours").column = "flow";
  writeFileSync(join(dir, BOARD_RELPATH), JSON.stringify(board, null, 2));
}

// What a run that (incorrectly) commits the board move leaves behind, used to prove assertFlowGateHeld fails it.
export async function moveAndCommit(dir) {
  moveUncommitted(dir);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "Board: fix-hours moved to In flow");
}

// A draft plan shaped like the one the real planner wrote in the first live flow rehearsal (fixture
// doug-rehearse-flow-A6oITj): valid against plan.mjs validate, one task owning the two files fix-hours touches.
export function draftPlan(overrides = {}) {
  return {
    version: 1,
    title: "Fix hours in parseDuration",
    goal: "parseDuration returns the right number of milliseconds for hour inputs",
    status: "draft",
    baseBranch: "main",
    card: "fix-hours",
    acceptance: [{ text: "parseDuration(\"2h\") returns 7_200_000", command: "pnpm exec vitest run tests/duration.test.ts" }],
    verify: ["pnpm typecheck", "pnpm test"],
    tasks: [
      {
        id: "fix-hours-factor",
        title: "Use 3_600_000 for the h unit in parseDuration",
        spec: "Size S. Change the h case of parseDuration to multiply by 3_600_000 and add a covering test.",
        files: ["src/duration.ts", "tests/duration.test.ts"],
        verify: "pnpm exec vitest run tests/duration.test.ts",
        dependsOn: [],
        size: "S",
        gate: "auto",
      },
    ],
    ...overrides,
  };
}

// The bug parseDuration ships with (hours computed as minutes) and its one-line fix, plus a test for it, used
// below to simulate what doug-hand's coder does (both owned files, one commit) so the held-out test can pass.
export function fixDurationBug(dir) {
  const srcPath = join(dir, "src/duration.ts");
  writeFileSync(srcPath, readFileSync(srcPath, "utf8").replace('return n * 60_000; // bug: should be 3_600_000', "return n * 3_600_000;"));
  const testPath = join(dir, "tests/duration.test.ts");
  writeFileSync(testPath, readFileSync(testPath, "utf8").replace('  it("rejects garbage"', '  it("parses hours", () => {\n    expect(parseDuration("2h")).toBe(7_200_000);\n  });\n  it("rejects garbage"'));
}
