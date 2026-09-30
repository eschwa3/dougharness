#!/usr/bin/env node
// SubagentStart, SubagentStop, PreToolUse, PostToolUse, InstructionsLoaded, PermissionDenied: append one JSON
// line per event to .doug/.state/trace/<session>.jsonl (lib/trace.mjs). Observation only: never blocks, never prints a decision —
// except a PostToolUse inside a subagent whose own measured context (lib/agent-context.mjs, card
// worker-context-handoff) has crossed contextWindow.threshold, which gets one additionalContext notice telling
// the worker to wrap up. Off with `"trace": { "enabled": false }` in .doug/config.json; contextWindow.enabled
// (also off by default) gates the notice, not the trace line itself.
//
// Two review fixes (worker-context-handoff, brief A) live here:
// - (major 2) edit-loop.mjs writes the same session state file on the same PostToolUse event, and
//   stop-gate.mjs holds its own copy for a whole SubagentStop gate run. A plain load -> mutate -> save here
//   can win a race and drop an agentBlocks increment or an edit-loop counter written in between. So the
//   state read at the top is used only to decide what changed; the actual write reloads the file fresh
//   immediately before saving and merges in only this agent's own entry, touching nothing else.
// - (minor 4) re-reading and re-parsing a subagent's whole transcript on every tool call is wasted work once
//   nothing has changed: the transcript's byte size at the last reading is cached in the entry, and a
//   PostToolUse whose file is still that size skips straight to allow() without opening it.

import { statSync } from "node:fs";
import { runHook, allow, addContext } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { appendTrace, traceLine } from "../lib/trace.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { agentTranscriptPath, contextReading, recordAgentContext, shouldNotify, noticeText } from "../lib/agent-context.mjs";

runHook("trace", async (input) => {
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  if (!cfg.trace || cfg.trace.enabled === false) return allow();

  const isSubagentPostToolUse = input.hook_event_name === "PostToolUse" && input.agent_id && cfg.contextWindow && cfg.contextWindow.enabled;
  let state = null;
  let reading = null;

  if (isSubagentPostToolUse) {
    const file = agentTranscriptPath(input);
    if (file) {
      state = loadState(dir, input.session_id);
      let size = null;
      try {
        size = statSync(file).size;
      } catch {
        size = null;
      }
      const prevContext = state.agents && state.agents[input.agent_id] && state.agents[input.agent_id].context;
      const unchanged = size !== null && prevContext && typeof prevContext.size === "number" && prevContext.size === size;
      if (!unchanged) {
        reading = contextReading(file);
        if (reading && size !== null) reading.size = size;
      }
    }
  }

  appendTrace(dir, traceLine(input, { context: reading ? reading.pct : null }));

  if (!reading) return allow();

  const prevEntry = state.agents && state.agents[input.agent_id] && state.agents[input.agent_id].context;
  const entry = recordAgentContext(state, input.agent_id, reading, new Date());
  let notice = null;
  if (shouldNotify(entry, cfg)) {
    entry.notifiedAt = entry.pct;
    notice = noticeText(entry, cfg);
  }

  const changed = !prevEntry || prevEntry.pct !== entry.pct || prevEntry.tokens !== entry.tokens || prevEntry.notifiedAt !== entry.notifiedAt || prevEntry.size !== entry.size;
  if (changed) {
    const fresh = loadState(dir, input.session_id);
    fresh.agents = fresh.agents || {};
    fresh.agents[input.agent_id] = { ...(fresh.agents[input.agent_id] || {}), context: entry };
    saveState(dir, input.session_id, fresh);
  }

  return notice ? addContext("PostToolUse", notice) : allow();
});
