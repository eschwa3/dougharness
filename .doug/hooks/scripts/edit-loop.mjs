#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): record edits per file for this session and nudge
// when the same file is edited `threshold` times inside `windowMinutes`. Also records the
// set of edited files so the stop gate knows whether anything changed.

import { runHook, allow, addContext } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { toProjectRelative, filePathsFromToolInput } from "../lib/paths.mjs";

runHook("edit-loop", async (input) => {
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  const paths = filePathsFromToolInput(input.tool_input).map((p) => toProjectRelative(dir, p)).filter(Boolean);
  if (paths.length === 0) return allow();

  const now = Date.now();
  const windowMs = (cfg.editLoop.windowMinutes || 30) * 60000;
  const threshold = cfg.editLoop.threshold || 6;
  const state = loadState(dir, input.session_id);
  const looping = [];

  for (const rel of paths) {
    const stamps = (state.edits[rel] || []).filter((t) => now - t < windowMs);
    stamps.push(now);
    state.edits[rel] = stamps;
    if (!state.editedFiles.includes(rel)) state.editedFiles.push(rel);
    if (stamps.length >= threshold && (stamps.length - threshold) % 3 === 0) looping.push({ rel, n: stamps.length });
  }
  saveState(dir, input.session_id, state);

  if (looping.length === 0) return allow();
  const lines = looping.map(({ rel, n }) => `${rel} has been edited ${n} times in the last ${cfg.editLoop.windowMinutes || 30} minutes.`);
  return addContext(
    "PostToolUse",
    `[doug] Possible edit loop. ${lines.join(" ")} Before editing it again: re-read the whole file, run the relevant test once, ` +
      `and state in one sentence what is actually wrong. If the approach is not working, say so and propose a different one.`,
  );
});
