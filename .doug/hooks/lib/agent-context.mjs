// Worker context handoff (card worker-context-handoff, brief A): a subagent cannot be observed
// compacting (PreCompact/PostCompact never fire inside one — research note
// .doug/.state/research/worker-context-handoff.md), so this is graceful degradation, not compaction.
// The measured signal is the worker's own transcript (subagents/agent-<agent_id>.jsonl): the last
// assistant line's usage against its model's context window. Nothing here blocks; scripts/trace.mjs
// uses it to notice a worker approaching its limit, and scripts/stop-gate.mjs uses it to refuse an
// unearned partial claim.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// The recorded transcript path for a hook input firing inside a subagent (agent_id present). Prefers
// an explicit agent_transcript_path (as SubagentStop already carries), then a transcript_path that
// already names the subagent's own file, then derives the documented layout
// (<dirname of transcript_path>/<session_id>/subagents/agent-<agent_id>.jsonl). null without agent_id
// or without any path to derive from — never a guess.
export function agentTranscriptPath(input) {
  if (!input || !input.agent_id) return null;
  if (typeof input.agent_transcript_path === "string" && input.agent_transcript_path) return input.agent_transcript_path;
  const tp = input.transcript_path;
  if (typeof tp !== "string" || !tp) return null;
  if (tp.endsWith(`agent-${input.agent_id}.jsonl`)) return tp;
  return join(dirname(tp), String(input.session_id || ""), "subagents", `agent-${input.agent_id}.jsonl`);
}

// The context window for a model id: 1M for a Fable/Opus/Sonnet 5 model, 200k otherwise (an unknown
// or missing model errs early, on the smaller window).
export function windowFor(model) {
  if (typeof model !== "string") return 200000;
  return /fable-5|opus-5|sonnet-5/.test(model) ? 1000000 : 200000;
}

// The last assistant line with usage in a transcript file, against its model's window. null when the
// file is missing, unreadable, or has no assistant line carrying usage — never a number in that case.
// Parses line by line and skips bad lines, the way lib/trace.mjs usageFromTranscript does (that
// function is unchanged; this one answers a different question — the LAST reading, not a sum).
export function contextReading(file, { windows = windowFor } = {}) {
  if (!file || !existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let lastMessage = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && o.type === "assistant" && o.message && o.message.usage) lastMessage = o.message;
  }
  if (!lastMessage) return null;
  const u = lastMessage.usage;
  const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const model = lastMessage.model || null;
  const window = windows(model);
  return { tokens, model, window, pct: Math.round((100 * tokens) / window) };
}

// Writes state.agents[agentId].context from a fresh reading, keeping the running maximum pct
// (maxPct — what stop-gate.mjs checks a partial claim against) and preserving notifiedAt across
// updates (cleared only by the caller, when it actually notifies). `reading.size` (review MAJOR/minor
// 4) — the transcript file's byte length at the time of the reading — passes through unchanged when the
// caller supplies one (scripts/trace.mjs does, to skip re-reading an unchanged file; a one-off
// SubagentStop reading doesn't, and that's fine: size ends up undefined, JSON drops it). Returns the new
// context entry.
export function recordAgentContext(state, agentId, reading, now) {
  state.agents = state.agents || {};
  const prev = state.agents[agentId] || {};
  const prevContext = prev.context || {};
  const maxPct = typeof prevContext.maxPct === "number" ? Math.max(prevContext.maxPct, reading.pct) : reading.pct;
  const entry = {
    pct: reading.pct,
    tokens: reading.tokens,
    window: reading.window,
    model: reading.model,
    at: now.toISOString(),
    maxPct,
    notifiedAt: prevContext.notifiedAt,
    size: reading.size,
  };
  state.agents[agentId] = { ...prev, context: entry };
  return entry;
}

// True when a context entry has crossed contextWindow.threshold (default 80) and either has never
// notified or has grown by contextWindow.repeatAfter (default 5) points since the last notice.
export function shouldNotify(entry, cfg) {
  if (!entry || typeof entry.pct !== "number") return false;
  const cw = (cfg && cfg.contextWindow) || {};
  const threshold = cw.threshold ?? 80;
  const repeatAfter = cw.repeatAfter ?? 5;
  if (entry.pct < threshold) return false;
  if (typeof entry.notifiedAt === "number" && entry.pct < entry.notifiedAt + repeatAfter) return false;
  return true;
}

// The one-line notice delivered to a worker via PostToolUse additionalContext. Quoted verbatim by
// brief B's agents and workflow — keep this wording.
export function noticeText(entry, cfg) {
  const cw = (cfg && cfg.contextWindow) || {};
  const threshold = cw.threshold ?? 80;
  return (
    `[doug] Worker context at ${entry.pct}% of ${entry.window} tokens (threshold ${threshold}). ` +
    `Finish the file you are on and its named test, commit, then return partial=true with a handoff (completed, remaining, next, verify). Do not start another file.`
  );
}
