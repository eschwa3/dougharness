#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): run the configured formatter on the edited file(s).
// Silent on success. On failure, tells Claude what the formatter said (usually a syntax error).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { runHook, allow, addContext } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { toProjectRelative, filePathsFromToolInput } from "../lib/paths.mjs";
import { tail, commandEnv } from "../lib/run.mjs";

runHook("format-on-edit", async (input) => {
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  const fmt = cfg.formatter;
  if (!fmt || !Array.isArray(fmt.command) || fmt.command.length === 0) return allow();

  const targets = [];
  for (const p of filePathsFromToolInput(input.tool_input)) {
    const rel = toProjectRelative(dir, p);
    if (!rel) continue;
    if (fmt.extensions && fmt.extensions.length && !fmt.extensions.includes(extname(rel))) continue;
    if (!existsSync(join(dir, rel))) continue;
    if (!targets.includes(rel)) targets.push(rel);
  }
  if (targets.length === 0) return allow();

  const [bin, ...args] = fmt.command;
  const res = spawnSync(bin, [...args, ...targets], {
    cwd: dir,
    encoding: "utf8",
    timeout: fmt.timeoutMs || 20000,
    stdio: ["ignore", "pipe", "pipe"],
    env: commandEnv(),
  });
  if (res.status === 0) return allow();

  const output = tail((res.stderr || "") + "\n" + (res.stdout || ""), 20);
  return addContext(
    "PostToolUse",
    `[doug] Formatter "${fmt.command.join(" ")}" failed on ${targets.join(", ")} (exit ${res.status ?? "timeout"}). ` +
      `This usually means the file no longer parses. Output:\n${output}`,
  );
});
