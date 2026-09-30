// Parses the JSONL event stream from `codex exec --json`.
// Evidence comes from events, not from the model's prose: a command "ran" only if a
// command_execution item completed, and its exit code is whatever Codex observed.

import type { CommandRun } from "./schema.js";

export interface ParsedEvents {
  commandsRun: CommandRun[];
  /** Text of the last agent_message item, or null if none completed. */
  finalMessage: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Lines that were not valid JSON (codex prints some diagnostics to stdout). */
  unparsedLines: number;
  threadId: string | null;
  /** Messages from `error` and `turn.failed` events. Codex reports API errors here, not on stderr. */
  errors: string[];
}

interface CommandItem {
  id?: string;
  type: "command_execution";
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

const TAIL_CHARS = 600;

export function parseEvents(jsonl: string): ParsedEvents {
  const commands = new Map<string, CommandRun>();
  let order = 0;
  const seq = new Map<string, number>();
  let finalMessage: string | null = null;
  let usage: ParsedEvents["usage"] = null;
  let unparsedLines = 0;
  let threadId: string | null = null;
  const errors: string[] = [];

  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      unparsedLines++;
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
    if (ev.type === "error" && typeof ev.message === "string") errors.push(ev.message);
    if (ev.type === "turn.failed" && ev.error && typeof ev.error.message === "string" && !errors.includes(ev.error.message)) errors.push(ev.error.message);
    if (ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      usage = { inputTokens: Number(ev.usage.input_tokens) || 0, outputTokens: Number(ev.usage.output_tokens) || 0 };
    }
    const item = ev.item;
    if (!item || typeof item !== "object") continue;
    if (item.type === "command_execution" && (ev.type === "item.completed" || ev.type === "item.started")) {
      const c = item as CommandItem;
      const key = typeof c.id === "string" ? c.id : `anon-${order}`;
      if (!seq.has(key)) seq.set(key, order++);
      const completed = ev.type === "item.completed";
      const exitCode = completed && typeof c.exit_code === "number" ? c.exit_code : null;
      const out = typeof c.aggregated_output === "string" ? c.aggregated_output : "";
      commands.set(key, {
        command: typeof c.command === "string" ? c.command : "",
        exitCode,
        ok: exitCode === 0,
        outputTail: out.length > TAIL_CHARS ? out.slice(-TAIL_CHARS) : out || undefined,
      });
    }
    if (item.type === "agent_message" && ev.type === "item.completed" && typeof item.text === "string") {
      finalMessage = item.text;
    }
  }

  const commandsRun = [...commands.entries()].sort((a, b) => (seq.get(a[0]) ?? 0) - (seq.get(b[0]) ?? 0)).map(([, c]) => c);
  return { commandsRun, finalMessage, usage, unparsedLines, threadId, errors };
}

/**
 * Extracts a JSON object from a model message. Accepts bare JSON, a ```json fence, or
 * JSON with leading/trailing prose. Returns null when nothing parses.
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/m.exec(trimmed);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  // Last resort: the outermost {...} span. Scan for a balanced object so trailing prose does not break it.
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = tryParse(trimmed.slice(start, i + 1));
        return candidate === undefined ? null : candidate;
      }
    }
  }
  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
