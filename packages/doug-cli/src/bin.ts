#!/usr/bin/env node
import { runInit } from "./init.js";
import { runBoard } from "./board.js";
import { runAblate } from "./ablate.js";
import { runTrace } from "./trace.js";
import { runDoctor } from "./doctor.js";

const HELP = `doug — tailored, approval-gated harness install for Claude Code

Usage:
  doug init [dir] [--yes] [--dry-run] [--no-color] [--show-hooks] [--quiet]
  doug detect [dir]          Print what would be detected, as JSON.
  doug board init [dir]
  doug board add <id> --title <t> --goal <g> [--component <c>] [--size S|M|L] [--track flow|hand] [--class <c>] [--deps a,b] [--tag a,b] [--column <col>] [dir]
  doug board list [dir] [--column <id>] [--tag <t>] [--json]
  doug board next [dir] [--track flow|hand] [--batch <n>] [--tag <t>]
  doug board reorder <id> [dir] --before <other> | --after <other> | --top | --bottom
  doug board move <id> <column> [dir] [--source <text>]
  doug board edit <id> [dir] [--title <t>] [--goal <g> | --goal-file <path>] [--size S|M|L] [--component <c>] [--track flow|hand] [--class <c>] [--deps a,b] [--tag a,b] [--source <s>] [--force]
  doug board remove <id> [dir] [--force]
  doug board record <id> <report.json> [dir] [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]...
  doug board record <id> --hand [dir] [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>]
  doug board summary <report.json> [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>]
  doug board build [dir] [--out <file>]
  doug board serve [dir] [--port <n>] [--open] [--detach | --stop]
  doug ablate --from <evals/out/file.json> [--from <file> ...] [--json]
  doug ablate [dir] [--tasks a,b] [--conditions baseline,gates,full] [--runs <n>] [--max-turns <n>] [--suite <name>]
              [--max-budget-usd <n>] [--judge auto|codex|claude|off] [--judge-model <name>] [--dry-run] [--json]
  doug trace [dir] [--session <id>] [--json]
  doug doctor [dir] [--json]   Read-only install health check; exit 1 on any fail.
  doug --help

doug init detects the project's tooling deterministically, prints a diff of every file it
would write, and writes nothing until you approve. Re-run it to refresh the vendored hooks.
`;

function parse(argv: string[]) {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { flags, positional };
}

async function main(): Promise<number> {
  if (process.argv[2] === "board") return runBoard(process.argv.slice(3));
  if (process.argv[2] === "ablate") return runAblate(process.argv.slice(3));
  if (process.argv[2] === "trace") return runTrace(process.argv.slice(3));
  if (process.argv[2] === "doctor") return runDoctor(process.argv.slice(3));
  const { flags, positional } = parse(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.has("help") || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const dir = positional[1] || process.cwd();
  if (command === "detect") {
    const { detect } = await import("./detect/index.js");
    process.stdout.write(JSON.stringify(detect(dir), null, 2) + "\n");
    return 0;
  }
  if (command === "init") {
    return runInit({
      dir,
      yes: flags.has("yes") || flags.has("y"),
      dryRun: flags.has("dry-run"),
      color: !flags.has("no-color") && !!process.stdout.isTTY,
      quiet: flags.has("quiet"),
      showHookFiles: flags.has("show-hooks"),
    });
  }
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`doug: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
