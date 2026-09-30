// Card seam-contracts, seam (c): proposal.test.ts's wiring tests only string-compare the hook commands doug init
// writes into .claude/settings.json; nothing actually fires one. This runs `doug init --yes` on a fresh temp
// repo and then executes the exact PreToolUse command it wrote for protect-paths.mjs, with a real stdin payload,
// proving the vendored hook denies a protected path and allows an ordinary one; it also checks (card
// no-nested-agents-gate) that the real end-to-end init writes the subagent spawn depth into env.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, cpSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInit } from "../src/init.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "ts-pnpm");

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-init-hooks-"));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookGroup[]>; env?: Record<string, string> };

// Clears CLAUDE_PROJECT_DIR and every GIT_* var (plugins/doug-gates/tests/git-hooks.test.mjs's precedent), then
// sets CLAUDE_PROJECT_DIR to the temp repo explicitly: the hook command itself is
// `node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/protect-paths.mjs"`, so unlike the board/plan/memory CLIs (which
// take an explicit dir argument) this hook has no other way to learn the project directory - the env var must
// name the temp repo, never leak the outer checkout's.
function hookEnv(projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: projectDir };
}

describe("doug init --yes wires a PreToolUse hook that actually fires", () => {
  it("denies an edit to a protected .env path and allows an ordinary file, running the exact command doug init wrote into .claude/settings.json", async () => {
    const dir = copyFixture();
    try {
      // runInit spawns git in-process with the inherited process.env; clear GIT_*/CLAUDE_PROJECT_DIR around the
      // call the same way every child process below is isolated, so runInit's own git calls can't be redirected
      // by a leaked location variable either.
      const savedEnv: Record<string, string | undefined> = {};
      for (const k of Object.keys(process.env)) {
        if (k.startsWith("GIT_") || k === "CLAUDE_PROJECT_DIR") {
          savedEnv[k] = process.env[k];
          delete process.env[k];
        }
      }
      let status: number;
      try {
        status = await runInit({ dir, yes: true, dryRun: false, color: false, quiet: true, showHookFiles: false });
      } finally {
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      expect(status).toBe(0);

      const settingsPath = join(dir, ".claude/settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
      const preToolUse = settings.hooks?.PreToolUse ?? [];
      let protectCommand: string | undefined;
      for (const group of preToolUse) {
        for (const hook of group.hooks) {
          if (hook.command.includes("protect-paths.mjs")) protectCommand = hook.command;
        }
      }
      expect(protectCommand, `no protect-paths.mjs hook found in ${JSON.stringify(preToolUse, null, 2)}`).toBeDefined();
      expect(protectCommand).toBe('node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/protect-paths.mjs"');
      expect(existsSync(join(dir, ".doug/hooks/scripts/protect-paths.mjs"))).toBe(true);

      // Card no-nested-agents-gate: the real init wires the subagent spawn depth into env.
      expect(settings.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");

      const fire = (payload: unknown) =>
        spawnSync("sh", ["-c", protectCommand as string], {
          cwd: dir,
          input: JSON.stringify(payload),
          encoding: "utf8",
          env: hookEnv(dir),
        });

      // A protected path (.env is in the default protectedPaths set, generate/config.ts:42): denied, naming the file.
      const denied = fire({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(dir, ".env") } });
      expect(denied.status, denied.stderr).toBe(0);
      // Named before the JSON.parse below so an always-allow mutation (empty stdout) fails on a clear message
      // instead of an opaque SyntaxError from parsing an empty string.
      expect(denied.stdout.trim(), "the hook allowed a protected path").not.toBe("");
      const denyOutput = JSON.parse(denied.stdout);
      expect(denyOutput.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(denyOutput.hookSpecificOutput.permissionDecisionReason).toContain(".env");

      // An ordinary file: allow() (plugins/doug-gates/lib/io.mjs) just exits 0 and prints nothing.
      const allowed = fire({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(dir, "src/ok.ts") } });
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type DougConfigLike = { stopGate?: { hookTimeoutSec?: number } };

// Card stop-gate-budget-under-hook-timeout: the stop-gate hook must bound its own wait-plus-commands to less
// than the platform's own hook timeout, and it learns that timeout from config, not from the hook's stdin
// (undocumented, unverified to exist) — so `doug init` has to write the budget into .doug/config.json's
// stopGate.hookTimeoutSec, kept equal to the `timeout` it also writes for the stop-gate hook itself in
// .claude/settings.json on both Stop and SubagentStop (they are two independently generated outputs of the
// same `doug init` run, and nothing else keeps them in step).
describe("doug init writes a stopGate.hookTimeoutSec that matches the stop-gate hook's own timeout", () => {
  it("carries stopGate.hookTimeoutSec in the generated config, equal to the stop-gate hook's timeout on Stop and SubagentStop in the generated settings", async () => {
    const dir = copyFixture();
    try {
      const savedEnv: Record<string, string | undefined> = {};
      for (const k of Object.keys(process.env)) {
        if (k.startsWith("GIT_") || k === "CLAUDE_PROJECT_DIR") {
          savedEnv[k] = process.env[k];
          delete process.env[k];
        }
      }
      let status: number;
      try {
        status = await runInit({ dir, yes: true, dryRun: false, color: false, quiet: true, showHookFiles: false });
      } finally {
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      expect(status).toBe(0);

      const config = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8")) as DougConfigLike;
      const hookTimeoutSec = config.stopGate?.hookTimeoutSec;
      expect(typeof hookTimeoutSec, `generated .doug/config.json's stopGate.hookTimeoutSec must be a number, got ${JSON.stringify(config.stopGate)}`).toBe("number");

      const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")) as Settings;
      for (const event of ["Stop", "SubagentStop"] as const) {
        const groups = settings.hooks?.[event] ?? [];
        let stopGateTimeout: number | undefined;
        for (const group of groups) {
          for (const hook of group.hooks) {
            if (hook.command.includes("stop-gate.mjs")) stopGateTimeout = hook.timeout;
          }
        }
        expect(stopGateTimeout, `no stop-gate.mjs hook found for ${event} in ${JSON.stringify(groups, null, 2)}`).toBeDefined();
        expect(
          hookTimeoutSec,
          `.doug/config.json's stopGate.hookTimeoutSec (${hookTimeoutSec}) must equal ${event}'s stop-gate.mjs hook timeout (${stopGateTimeout}) in .claude/settings.json`,
        ).toBe(stopGateTimeout);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
