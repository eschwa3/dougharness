// card gate-load-timeouts: two gates waiting on one live gate.lock must not both run their suites when it is
// released (ledger blocks 425 and 426: both waiters left the wait loop together and took the lock over with a
// plain overwrite, so two full suites ran at once). Fixtures: two linked worktrees of one repo share one
// gate.lock; a fake live holder owns it; each gate's command logs [start, end] around a short sleep.
import { describe, it, expect, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProject, scriptsDir } from "./helpers.mjs";
import { gateLockPath } from "../lib/gate-lock.mjs";

vi.setConfig({ testTimeout: 120_000 });

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify.mjs");
const CMD_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && k !== "DOUG_STOP_GATE_TREE") env[k] = v;
  return { ...env, ...extra };
}
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() }).trim();

// Appends "start <tag> <ms>" then "end <tag> <ms>" around a CMD_MS sleep to the shared log (outside every tree).
function writeLogger(root) {
  const script = join(root, "logger.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "const [log, tag] = process.argv.slice(2);",
      'appendFileSync(log, "start " + tag + " " + Date.now() + "\\n");',
      `setTimeout(() => { appendFileSync(log, "end " + tag + " " + Date.now() + "\\n"); }, ${CMD_MS});`,
      "",
    ].join("\n"),
  );
  return script;
}
function intervals(log) {
  const out = {};
  for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const [kind, tag, t] = line.split(" ");
    (out[tag] ||= {})[kind] = Number(t);
  }
  return out;
}
function expectDisjoint(log) {
  const iv = intervals(log);
  const tags = Object.keys(iv);
  expect(tags.sort(), "both gates must run their command").toEqual(["a", "b"]);
  for (const t of tags) expect(typeof iv[t].start === "number" && typeof iv[t].end === "number", `${t} logged start and end`).toBe(true);
  const [first, second] = iv.a.start <= iv.b.start ? [iv.a, iv.b] : [iv.b, iv.a];
  expect(second.start, `suites overlapped: ${JSON.stringify(iv)}`).toBeGreaterThanOrEqual(first.end);
}

// A repo (main checkout plus one linked worktree), each with the gate config committed.
function twoWorktrees(root, config) {
  const main = makeProject({ config, git: true });
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/a.ts"), "base");
  writeFileSync(join(main, ".gitignore"), ".doug/.state/\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "base"]);
  const wt = join(mkdtempSync(join(root, "wt-")), "wt");
  git(main, ["worktree", "add", "-q", "-b", "wt-branch", wt]);
  return [main, wt];
}
function sleeper() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 90000)"], { stdio: "ignore" });
}
function holdLock(dir, pid) {
  mkdirSync(dirname(gateLockPath(dir)), { recursive: true });
  writeFileSync(gateLockPath(dir), JSON.stringify({ pid, session: "holder", at: Date.now() }));
}
function run(bin, args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
    child.stdin.end(input || "");
  });
}

describe("gate.lock waiters run one at a time (card gate-load-timeouts)", () => {
  it("L1: two Stop gates in two worktrees waiting on one live holder do not run their suites together once it releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "doug-glo-"));
    const log = join(root, "log.txt");
    const logger = writeLogger(root);
    const mk = (tag) => `${JSON.stringify(process.execPath)} ${JSON.stringify(logger)} ${JSON.stringify(log)} ${tag}`;
    const config = (tag) => ({
      packageManager: "pnpm",
      commands: { "test:unit": mk(tag) },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 20000, requireEvidence: false },
      editLoop: { threshold: 3, windowMinutes: 30 },
      anchor: ["x"],
    });
    const [main, wt] = twoWorktrees(root, config("a"));
    // The commit carries tag "a"; the worktree's own config says "b".
    writeFileSync(join(wt, ".doug/config.json"), JSON.stringify(config("b")));
    const holder = sleeper();
    try {
      for (const d of [main, wt]) {
        writeFileSync(join(d, "src/a.ts"), "edited in " + d);
        await run(process.execPath, [join(scriptsDir, "edit-loop.mjs")], {
          cwd: d,
          env: cleanEnv({ CLAUDE_PROJECT_DIR: d }),
          input: JSON.stringify({ session_id: "test-session", cwd: d, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }),
        });
      }
      holdLock(main, holder.pid);
      const gate = (d) =>
        run(process.execPath, [join(scriptsDir, "stop-gate.mjs")], {
          cwd: d,
          env: cleanEnv({ CLAUDE_PROJECT_DIR: d }),
          input: JSON.stringify({ session_id: "test-session", cwd: d, hook_event_name: "Stop" }),
        });
      const gates = [gate(main), gate(wt)];
      await sleep(3000); // both gates are in their wait loop (polling every 200 ms)
      expect(existsSync(log), "neither gate may run its command while the holder lives").toBe(false);
      rmSync(gateLockPath(main));
      const results = await Promise.all(gates);
      for (const r of results) {
        expect(r.status, r.out).toBe(0);
        expect(r.stdout, "a gate that waited and ran green must allow").not.toContain('"decision":"block"');
      }
      expectDisjoint(log);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("L2: two verify.mjs runs in two worktrees waiting on one live holder do not run their commands together once it releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "doug-glo-"));
    const log = join(root, "log.txt");
    const logger = writeLogger(root);
    const mk = (tag) => `${JSON.stringify(process.execPath)} ${JSON.stringify(logger)} ${JSON.stringify(log)} ${tag}`;
    const config = {
      packageManager: "pnpm",
      commands: { test: "node -e 0" },
      stopGate: { commands: ["test"], timeoutMs: 20000 },
    };
    const [main, wt] = twoWorktrees(root, config);
    const holder = sleeper();
    try {
      holdLock(main, holder.pid);
      const verify = (d, tag) => run(process.execPath, [VERIFY, "--no-credit", "--command", mk(tag), "--timeout-ms", "10000"], { cwd: d, env: cleanEnv() });
      const runs = [verify(main, "a"), verify(wt, "b")];
      await sleep(3000);
      expect(existsSync(log), "neither verify may run its command while the holder lives").toBe(false);
      rmSync(gateLockPath(main));
      const results = await Promise.all(runs);
      for (const r of results) expect(r.status, r.out).toBe(0);
      expectDisjoint(log);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
