import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const scriptsDir = join(here, "..", "scripts");

export function makeProject({ config = null, git = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-proj-"));
  if (config) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(config));
  }
  if (git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  }
  return dir;
}

export function runHookScript(name, input, { dir, env = {} } = {}) {
  const res = spawnSync(process.execPath, [join(scriptsDir, name + ".mjs")], {
    cwd: dir,
    input: JSON.stringify({ session_id: "test-session", cwd: dir, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
    timeout: 30000,
  });
  let json = null;
  const line = (res.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (line) {
    try {
      json = JSON.parse(line);
    } catch {
      json = null;
    }
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
export const context = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;
