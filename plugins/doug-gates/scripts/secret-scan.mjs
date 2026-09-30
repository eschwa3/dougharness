#!/usr/bin/env node
// PreToolUse (Edit/Write/MultiEdit/NotebookEdit/Bash): deny text that carries a credential shape.
// Rules live in lib/secret-rules.mjs and are unit-tested; this script only wires them to the hook I/O.

import { runHook, allow, denyTool } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { toProjectRelative } from "../lib/paths.mjs";
import { scanText, candidateTexts, denyReason } from "../lib/secret-rules.mjs";

runHook("secret-scan", async (input) => {
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  if (cfg.secrets.enabled === false) return allow();
  for (const { label, path, text } of candidateTexts(input.tool_input)) {
    let effectiveLabel = label;
    if (typeof path === "string") {
      const rel = toProjectRelative(dir, path);
      if (rel !== null && matchAny(cfg.secrets.ignorePaths, rel)) continue;
      effectiveLabel = rel ?? path;
    }
    const hit = scanText(text, cfg.secrets);
    if (hit) return denyTool(denyReason(hit, effectiveLabel));
  }
  return allow();
});
