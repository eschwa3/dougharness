// Argument parsing for the codex-review binary. Pure so it can be unit-tested without spawning.

import { SANDBOXES, REASONING_EFFORTS } from "./schema.js";
import type { Sandbox, ReasoningEffort } from "./schema.js";

export const HELP = `codex-review — run Codex read-only as an adversarial reviewer of a change

Usage:
  codex-review --base <ref> [--head <ref>] [--dir <path>] (--spec-file <file> | --spec -)
               [--verify <cmd>]... [--model <name>] [--effort <level>] [--timeout-ms <n>] [--keep-mcp]
               [--sandbox <mode>] [--network-access | --no-network-access] [--codex <bin>]

  --base <ref>        Ref the change is measured against (required). Diff is base...head.
  --head <ref>        Ref holding the change. Default HEAD.
  --dir <path>        Repository or worktree directory. Default cwd. Codex runs inside it, read-only.
  --spec-file <file>  The task spec the change claims to implement.
  --spec -            Read the spec from stdin.
  --verify <cmd>      A command the reviewer must run; non-zero exit is a blocker. Repeatable.
  --model <name>      Codex model override.
  --effort <level>    One of minimal, low, medium, high, xhigh. Maps to -c model_reasoning_effort=<level>.
  --timeout-ms <n>    Kill codex after n ms (default 900000). Yields verdict "inconclusive".
  --keep-mcp          Keep MCP servers from ~/.codex/config.toml (default: none are started).
  --sandbox <mode>    workspace-write (default; test runners need scratch files) or read-only.
                      Either way the working tree is compared before and after; a change voids the review.
  --network-access    Pass -c sandbox_workspace_write.network_access=true so a verify command may bind a
                      localhost port. Default: on under workspace-write when at least one --verify is given.
                      Never passed under read-only, where Codex ignores it, even with --network-access.
                      --no-network-access turns it off.
  --codex <bin>       Codex executable (default: codex on PATH).

Output: one JSON object with verdict (pass|fail|inconclusive), summary, issues[{severity,file,line?,description,evidence?}],
commandsRun[{command,exitCode,ok,outputTail?}] taken from Codex's own event stream, changedFiles from git, and error when
the review could not run (codex-not-found, timeout, codex-failed, no-final-message, unparseable, git).

Exit codes: 0 no blockers, 1 fail verdict or blocker issue, 2 could not review, 64 usage error.
`;

export interface CliArgs {
  base?: string;
  head?: string;
  dir?: string;
  specFile?: string;
  specStdin: boolean;
  verify: string[];
  model?: string;
  effort?: ReasoningEffort;
  timeoutMs?: number;
  keepMcp: boolean;
  codex?: string;
  sandbox?: Sandbox;
  networkAccess?: boolean;
  help: boolean;
}

/** Returns parsed args, or an error message string for usage problems. */
export function parseArgs(argv: string[]): CliArgs | string {
  const a: CliArgs = { specStdin: false, verify: [], keepMcp: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    try {
      if (k === "--help" || k === "-h") a.help = true;
      else if (k === "--base") a.base = next();
      else if (k === "--head") a.head = next();
      else if (k === "--dir") a.dir = next();
      else if (k === "--spec-file") a.specFile = next();
      else if (k === "--spec") {
        const v = next();
        if (v === "-") a.specStdin = true;
        else a.specFile = v;
      } else if (k === "--verify") a.verify.push(next());
      else if (k === "--model") a.model = next();
      else if (k === "--effort") {
        const v = next();
        if (!REASONING_EFFORTS.includes(v as ReasoningEffort)) return `--effort must be one of ${REASONING_EFFORTS.join(", ")}`;
        a.effort = v as ReasoningEffort;
      } else if (k === "--timeout-ms") {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) return "--timeout-ms must be a positive number";
        a.timeoutMs = n;
      } else if (k === "--keep-mcp") a.keepMcp = true;
      else if (k === "--codex") a.codex = next();
      else if (k === "--sandbox") {
        const v = next();
        if (!SANDBOXES.includes(v as Sandbox)) return `--sandbox must be one of ${SANDBOXES.join(", ")}`;
        a.sandbox = v as Sandbox;
      } else if (k === "--network-access") a.networkAccess = true;
      else if (k === "--no-network-access") a.networkAccess = false;
      else return `unknown argument: ${k}`;
    } catch (e: any) {
      return String(e.message);
    }
  }
  if (a.help) return a;
  if (!a.base) return "--base is required";
  if (!a.specFile && !a.specStdin) return "give the spec with --spec-file <file> or --spec -";
  return a;
}
