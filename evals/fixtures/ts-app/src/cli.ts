import { pathToFileURL } from "node:url";
import { add } from "./commands/add.js";
import { list } from "./commands/list.js";
import { done } from "./commands/done.js";

/** Shared context every command runs with. */
export interface Ctx {
  storePath: string;
  now: () => Date;
}

/** The outcome of a command: an exit code plus the lines it printed to stdout and stderr. */
export interface CommandResult {
  code: number;
  out: string[];
  err: string[];
}

const USAGE = "usage: <add|list|done> [args]";

/** Dispatches argv[0] to the matching command. Unknown or missing: code 2 with a usage line in err. */
export function run(argv: string[], ctx: Ctx): CommandResult {
  const [command, ...rest] = argv;
  switch (command) {
    case "add":
      return add(rest, ctx);
    case "list":
      return list(rest, ctx);
    case "done":
      return done(rest, ctx);
    default:
      return { code: 2, out: [], err: [USAGE] };
  }
}

export function main(): void {
  const ctx: Ctx = { storePath: process.env.TASKS_FILE || "./tasks.json", now: () => new Date() };
  const result = run(process.argv.slice(2), ctx);
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  process.exit(result.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
