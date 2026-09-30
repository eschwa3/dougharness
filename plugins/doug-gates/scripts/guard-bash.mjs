#!/usr/bin/env node
// PreToolUse (Bash): deny --no-verify, force-push to protected branches, destructive commands,
// and the wrong package manager. Rules live in lib/bash-rules.mjs and are unit-tested.

import { execFileSync } from "node:child_process";
import { runHook, allow, denyTool } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { evaluateBash } from "../lib/bash-rules.mjs";
import { recordCommand } from "../lib/state.mjs";

function currentBranch(dir) {
  // symbolic-ref works even before the first commit; rev-parse does not.
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

runHook("guard-bash", async (input) => {
  const command = input.tool_input && input.tool_input.command;
  if (!command) return allow();
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  // Only resolve the branch when a push or a reset is involved; keeps the hot path at zero subprocesses.
  const branch = /git\s+(push|reset)\b/.test(command) ? currentBranch(dir) : null;
  const reasons = evaluateBash(command, { config: cfg, currentBranch: branch });
  if (reasons.length) return denyTool(reasons.join(" "));
  // An allowed command is about to run: the stop gate reads these as evidence that the session verified its work.
  recordCommand(dir, input.session_id, command);
  return allow();
});
