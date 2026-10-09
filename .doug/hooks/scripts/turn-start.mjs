#!/usr/bin/env node
// UserPromptSubmit: record the working tree's fingerprint at the start of a turn (card
// stop-gate-runs-only-on-code-turns), so a main Stop can tell a read-only turn from one that changed code
// (lib/baseline.mjs turnTreeStatus; scripts/stop-gate.mjs). Fires on typed prompts and on turns Claude Code
// starts itself (a background subagent reporting back). Written whatever trace.enabled says. Prints nothing:
// UserPromptSubmit stdout is added to the model's context. Never blocks; never throws (runHook fails open).
import { runHook, allow } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { writeTurnStart } from "../lib/baseline.mjs";

runHook("turn-start", async (input) => {
  // A subagent's own firing (agent_id set) must never write or overwrite the lead's record.
  if (input && input.agent_id) return allow();
  const dir = projectDir(input);
  writeTurnStart(dir, loadConfig(dir), input.session_id);
  return allow();
});
