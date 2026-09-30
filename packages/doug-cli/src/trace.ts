// `doug trace`: replay one session's run trace (.doug/.state/trace/<session>.jsonl, written by the trace hook)
// and attribute events, tool calls, wall time, and tokens to each agent. Tokens are shown only where Claude
// Code reported them (a subagent's transcript at SubagentStop); everything else prints null. Nothing is estimated.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { TRACE_DIR_RELPATH, attribution, readTrace, replay, type AgentAttribution, type TraceLine } from "@dougharness/gates/lib/trace.mjs";

export interface TraceIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const TRACE_USAGE = `Usage:
  doug trace [dir] [--session <id>] [--json]

Replays the newest trace under <dir>/.doug/.state/trace (or the session named by --session) and attributes
events, tool calls, wall time, and tokens to each agent. Tokens come only from what Claude Code reported at
SubagentStop; the main session and anything unreported show null.
`;

function parse(argv: string[]): { opts: Record<string, string | true>; positional: string[] } {
  const opts: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key === "session" && next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else positional.push(a);
  }
  return { opts, positional };
}

export function pickTraceFile(traceDir: string, session: string | null): string | null {
  if (!existsSync(traceDir)) return null;
  const files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl")).sort();
  if (session) {
    const hit = files.find((f) => basename(f, ".jsonl") === session || basename(f, ".jsonl").startsWith(session));
    return hit ? join(traceDir, hit) : null;
  }
  const newest = files.map((f) => ({ f, m: statSync(join(traceDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return newest ? join(traceDir, newest.f) : null;
}

function fmtWall(ms: number | null): string {
  if (ms === null) return "null";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function fmtTokens(t: AgentAttribution["tokens"]): string {
  return t ? `${t.input} in / ${t.output} out / ${t.cacheRead} cache read` : "null";
}

export function renderTrace(session: string, file: string, lines: TraceLine[]): string {
  const out: string[] = [];
  const first = lines[0]?.t ?? "";
  const last = lines[lines.length - 1]?.t ?? "";
  out.push(`Trace ${session}: ${lines.length} events${first ? `, ${first} to ${last}` : ""} (${file})`);
  out.push("");
  for (const l of replay(lines)) out.push(`  ${l}`);
  out.push("");
  out.push("| Agent | Type | Events | Tool calls | Failed | Wall | Tokens |");
  out.push("|---|---|---|---|---|---|---|");
  for (const a of attribution(lines)) {
    const calls = Object.entries(a.toolCalls)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const id = a.agent === "main" ? "main" : a.agent.slice(0, 8);
    out.push(`| ${id} | ${a.agentType ?? "null"} | ${a.events} | ${calls || "none"} | ${a.failedCalls} | ${fmtWall(a.wallMs)} | ${fmtTokens(a.tokens)} |`);
  }
  return out.join("\n") + "\n";
}

export async function runTrace(argv: string[], io?: TraceIo): Promise<number> {
  const out: TraceIo = io || {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
  const { opts, positional } = parse(argv);
  if (opts.help === true) {
    out.stdout(TRACE_USAGE);
    return 0;
  }
  const dir = resolve(positional[0] || process.cwd());
  const traceDir = join(dir, TRACE_DIR_RELPATH);
  const session = typeof opts.session === "string" ? opts.session : null;
  const file = pickTraceFile(traceDir, session);
  if (!file) {
    out.stderr(
      session
        ? `no trace for session ${session} under ${traceDir}\n`
        : `no trace under ${traceDir}; the trace hook writes one file per session while trace.enabled is on in .doug/config.json\n`,
    );
    return 1;
  }
  const lines = readTrace(file);
  const name = basename(file, ".jsonl");
  if (opts.json === true) {
    out.stdout(JSON.stringify({ session: name, file, events: lines, agents: attribution(lines) }, null, 2) + "\n");
    return 0;
  }
  out.stdout(renderTrace(name, file, lines));
  return 0;
}
