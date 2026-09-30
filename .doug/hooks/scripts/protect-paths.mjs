#!/usr/bin/env node
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit): deny edits to protected paths.
// Protected patterns come from .doug/config.json `protectedPaths` (globs, ".gitignore"-like).
// Bash writes are not intercepted here; the stop gate scans `git status` for protected changes.

import { isAbsolute, resolve } from "node:path";
import { runHook, allow, denyTool } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { toProjectRelative, filePathsFromToolInput, isAllowedOutside, realpathDeepestExisting } from "../lib/paths.mjs";

runHook("protect-paths", async (input) => {
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  const realDir = realpathDeepestExisting(dir);
  const paths = filePathsFromToolInput(input.tool_input);
  if (paths.length === 0) return allow();

  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(dir, p);
    const realAbs = realpathDeepestExisting(abs);
    const rel = toProjectRelative(realDir, realAbs);
    if (rel === null) {
      // Outside the project even after resolving aliases: allowed only when an allowedOutsidePaths entry
      // covers it.
      if (isAllowedOutside(realAbs, cfg.allowedOutsidePaths)) continue;
      return denyTool(
        `Refusing to edit ${p}: it is outside the project directory ${dir}, and no allowedOutsidePaths entry in .doug/config.json covers it.`,
      );
    }
    const hit = matchAny(cfg.protectedPaths, rel);
    if (hit) {
      return denyTool(
        `Refusing to edit ${rel}: it matches protected path pattern "${hit}" in .doug/config.json. ` +
          `If this file must change, ask the user to edit it or to adjust protectedPaths.`,
      );
    }
    // Decisions/rules (card memory-decisions): written only through an approved proposal diff.
    const proposalHit = matchAny(cfg.proposalPaths, rel);
    if (proposalHit) {
      return denyTool(
        `Refusing to edit ${rel}: it matches proposal-only path "${proposalHit}" in .doug/config.json. ` +
          `Decisions and rules are written only through an approved proposal: /doug-decide, or ` +
          `memory.mjs decision|rule propose then learn.mjs apply.`,
      );
    }
  }
  return allow();
});
