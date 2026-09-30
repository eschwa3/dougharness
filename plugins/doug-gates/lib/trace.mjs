// Run trace (decision 0002, card run-trace): the trace hook appends one JSON line per SubagentStart, SubagentStop,
// PreToolUse, and PostToolUse event to <project>/.doug/.state/trace/<session>.jsonl. The readers here (replay,
// per-agent attribution) are what `doug trace` prints. Tokens are recorded only where Claude Code reports them:
// a SubagentStop carries the agent's transcript path, whose assistant lines carry per-message usage. Everything
// else records null; nothing is ever estimated. `context` (card worker-context-handoff) is the worker's own
// measured context pct on a PostToolUse inside a subagent, from lib/agent-context.mjs; null everywhere else.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TRACE_DIR_RELPATH = ".doug/.state/trace";

function safeId(id) {
  return String(id || "no-session")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
}

export function tracePath(dir, sessionId) {
  return join(dir, TRACE_DIR_RELPATH, safeId(sessionId) + ".jsonl");
}

function clip(s, n = 120) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// A one-line summary of a tool's input: the command, the file, the pattern, or the description. Never the whole input.
// "skill" (card learn-signals) records a Skill tool call's skill name, so trace-derived signals can count
// which skills actually get invoked.
export function detailOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  for (const key of ["command", "file_path", "notebook_path", "pattern", "description", "prompt", "url", "skill"]) {
    if (typeof toolInput[key] === "string" && toolInput[key].trim()) return clip(toolInput[key]);
  }
  return null;
}

// Token usage summed from a Claude Code transcript (one line per content block, each repeating its message's
// usage, so the largest value per message id counts once). null when the file is missing or has no usage lines.
export function usageFromTranscript(file) {
  if (!file || !existsSync(file)) return null;
  const perMessage = new Map();
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o && o.message;
    if (o.type !== "assistant" || !m || !m.usage) continue;
    const id = m.id || o.requestId || o.uuid;
    const u = m.usage;
    const cur = perMessage.get(id) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: m.model || null };
    cur.input = Math.max(cur.input, u.input_tokens || 0);
    cur.output = Math.max(cur.output, u.output_tokens || 0);
    cur.cacheRead = Math.max(cur.cacheRead, u.cache_read_input_tokens || 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, u.cache_creation_input_tokens || 0);
    if (m.model) cur.model = m.model;
    perMessage.set(id, cur);
  }
  if (perMessage.size === 0) return null;
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: perMessage.size, model: null };
  const models = new Map();
  for (const v of perMessage.values()) {
    out.input += v.input;
    out.output += v.output;
    out.cacheRead += v.cacheRead;
    out.cacheWrite += v.cacheWrite;
    if (v.model) models.set(v.model, (models.get(v.model) || 0) + 1);
  }
  out.model = [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || null;
  return out;
}

// The line for one hook input. `now` is injectable for tests. `context` (card worker-context-handoff) is the
// caller's already-computed reading pct for a PostToolUse inside a subagent (scripts/trace.mjs); null when there
// is none, which is every other event and every caller that doesn't pass it.
//
// InstructionsLoaded and PermissionDenied (card learn-signals) record path-only, never-block observation, the
// same as every other event here: InstructionsLoaded's `detail` is the loaded file's path and its `reason` the
// matcher's load_reason ("session_start", "path_glob_match", ...) - `file_content` is never read off the input,
// so it can never end up on the line even by accident. PermissionDenied's `detail` is the denied tool's input
// (via detailOf, same as a Pre/PostToolUse line), `ok` is forced false, and `reason` is the clipped denial_reason.
// Every other event's `reason` is null.
export function traceLine(input, { now = new Date(), context = null } = {}) {
  const event = input.hook_event_name || null;
  const response = input.tool_response ?? input.tool_output ?? null;
  let ok = null;
  if (event === "PostToolUse") {
    ok = response === null ? null : !(typeof response === "object" && (response.is_error === true || typeof response.error === "string"));
  } else if (event === "PermissionDenied") {
    ok = false;
  }
  const tokens = event === "SubagentStop" ? usageFromTranscript(input.agent_transcript_path) : null;
  let detail = null;
  let reason = null;
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PermissionDenied") {
    detail = detailOf(input.tool_input);
  }
  if (event === "PermissionDenied") {
    reason = typeof input.denial_reason === "string" && input.denial_reason.trim() ? clip(input.denial_reason, 120) : null;
  } else if (event === "InstructionsLoaded") {
    detail = typeof input.file_path === "string" && input.file_path ? input.file_path : null;
    reason = typeof input.load_reason === "string" && input.load_reason ? input.load_reason : null;
  }
  return {
    t: now.toISOString(),
    event,
    session: input.session_id || null,
    agent: input.agent_id || null,
    agentType: input.agent_type || null,
    tool: input.tool_name || null,
    toolUseId: input.tool_use_id || null,
    detail,
    ok,
    tokens,
    context,
    reason,
  };
}

export function appendTrace(dir, line) {
  mkdirSync(join(dir, TRACE_DIR_RELPATH), { recursive: true });
  appendFileSync(tracePath(dir, line.session), JSON.stringify(line) + "\n");
}

// Every well-formed line of a trace file, in order.
export function readTrace(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && o.event) out.push(o);
    } catch {
      // a torn line from a crashed hook is skipped, never fatal
    }
  }
  return out;
}

export function agentLabel(line) {
  return line.agent ? `${line.agentType || "agent"}:${String(line.agent).slice(0, 8)}` : "main";
}

// One text line per event: time, who, what.
export function replay(lines) {
  return lines.map((l) => {
    const time = /T(\d\d:\d\d:\d\d)/.exec(l.t || "")?.[1] || "??:??:??";
    const parts = [time, agentLabel(l).padEnd(22), (l.event || "").padEnd(13)];
    if (l.tool) parts.push(l.tool);
    if (l.detail) parts.push(l.detail);
    if (l.ok === false) parts.push("FAILED");
    if ((l.event === "InstructionsLoaded" || l.event === "PermissionDenied") && l.reason) parts.push(l.reason);
    if (l.event === "SubagentStop") parts.push(l.tokens ? `tokens in ${l.tokens.input} out ${l.tokens.output}` : "tokens null");
    return parts.join("  ").trimEnd();
  });
}

// Per agent: events, tool calls by name, failed calls, wall time, and tokens (null unless a SubagentStop reported them).
export function attribution(lines) {
  const byAgent = new Map();
  for (const l of lines) {
    const key = l.agent || "main";
    const a = byAgent.get(key) || { agent: key, agentType: l.agent ? l.agentType || null : "main", events: 0, toolCalls: {}, failedCalls: 0, startedAt: l.t || null, endedAt: l.t || null, wallMs: null, tokens: null };
    a.events += 1;
    if (l.agentType && l.agent) a.agentType = l.agentType;
    if (l.event === "PreToolUse" && l.tool) a.toolCalls[l.tool] = (a.toolCalls[l.tool] || 0) + 1;
    if (l.event === "PostToolUse" && l.ok === false) a.failedCalls += 1;
    if (l.event === "SubagentStart") a.startedAt = l.t || a.startedAt;
    if (l.event === "SubagentStop") {
      a.endedAt = l.t || a.endedAt;
      a.tokens = l.tokens || null;
    } else if (l.t && (!a.endedAt || l.t > a.endedAt)) a.endedAt = l.t;
    if (l.t && (!a.startedAt || l.t < a.startedAt) && l.event !== "SubagentStart") a.startedAt = a.startedAt || l.t;
    byAgent.set(key, a);
  }
  const out = [...byAgent.values()];
  for (const a of out) {
    const s = Date.parse(a.startedAt || "");
    const e = Date.parse(a.endedAt || "");
    a.wallMs = Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : null;
  }
  out.sort((x, y) => (x.agent === "main" ? -1 : y.agent === "main" ? 1 : String(x.startedAt).localeCompare(String(y.startedAt))));
  return out;
}
