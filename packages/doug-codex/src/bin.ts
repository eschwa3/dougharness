#!/usr/bin/env node
// codex-review: Codex CLI as an adversarial reviewer for one change.
// Prints a ReviewResult JSON object to stdout. Exit 0 = no blockers, 1 = blockers/fail, 2 = could not review, 64 = usage.

import { readFileSync } from "node:fs";
import { runCodexReview } from "./run.js";
import { exitCodeFor } from "./schema.js";
import { parseArgs, HELP } from "./cli.js";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    process.stderr.write(`codex-review: ${parsed}\n\n${HELP}`);
    return 64;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const spec = parsed.specStdin ? readFileSync(0, "utf8") : readFileSync(parsed.specFile!, "utf8");
  if (!spec.trim()) {
    process.stderr.write("codex-review: the spec is empty\n");
    return 64;
  }
  const result = await runCodexReview({
    spec,
    base: parsed.base!,
    head: parsed.head,
    dir: parsed.dir || process.cwd(),
    model: parsed.model,
    effort: parsed.effort,
    timeoutMs: parsed.timeoutMs,
    verifyCommands: parsed.verify,
    keepMcpServers: parsed.keepMcp,
    codexBin: parsed.codex,
    sandbox: parsed.sandbox,
    networkAccess: parsed.networkAccess,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return exitCodeFor(result);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`codex-review: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(2);
  },
);
