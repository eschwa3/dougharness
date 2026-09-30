#!/usr/bin/env node
// SessionStart (compact|resume): re-inject the few facts that must survive compaction. Sources: `anchor` lines
// and `commands` in .doug/config.json, plus .doug/anchor.md if the user or a workflow wrote a current-task
// anchor; when that file holds a compaction snapshot (see below), the snapshot goes first so the 4000-character
// cap never cuts it. Deterministic, no model calls.
// PreCompact: before compaction, snapshot the plan, task ownership, decisions, this session's edited files and
// recent commands, and (card precompact-keeps-handoff) a Handoff boundary block naming the compaction trigger,
// the Stop gate's last result when one was recorded, the current HEAD, and the context percentage when one was
// recorded, into .doug/anchor.md (lib/anchor.mjs); tell the user via a top-level systemMessage that the snapshot
// was taken (this build's hook-output validator rejects hookSpecificOutput.hookEventName "PreCompact"/
// "PostCompact", so no hookSpecificOutput is emitted for either event; the model-facing re-anchor rides on
// SessionStart(compact)).
// PostCompact: clears state.context (card context-window-handoff), so a context reading recorded before the cut
// cannot produce a handoff notice after it, then allow() with no output. The payload's token estimates are
// ignored: nothing here estimates tokens (decision 0002 #4).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runHook, allow, addContext, systemMessage } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { gitHead, mergeSnapshot, readDecisions, readPlanSummary, snapshotSection, splitSnapshot } from "../lib/anchor.mjs";

runHook("reanchor", async (input) => {
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  const anchorFile = join(dir, ".doug/anchor.md");

  if (input.hook_event_name === "PreCompact") {
    const state = loadState(dir, input.session_id);
    const section = snapshotSection({
      plan: readPlanSummary(dir),
      decisions: readDecisions(dir),
      state,
      now: new Date(),
      handoff: {
        boundary: `compaction (${typeof input.trigger === "string" && input.trigger ? input.trigger : "auto"})`,
        gate: state.lastGate ? { ok: state.lastGate.ok, at: state.lastGate.at } : null,
        head: gitHead(dir),
        contextPct: state.context && Number.isFinite(state.context.pct) ? state.context.pct : undefined,
      },
    });
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const before = existsSync(anchorFile) ? readFileSync(anchorFile, "utf8") : "";
    writeFileSync(anchorFile, mergeSnapshot(before, section));
    return systemMessage(
      "[doug] Compacting: .doug/anchor.md now holds a snapshot of the plan, task ownership, decisions, and this session's edited files and recent commands; the SessionStart hook re-injects it after compaction.",
    );
  }

  if (input.hook_event_name === "PostCompact") {
    // Clear the recorded context reading (card context-window-handoff) so a pre-compaction reading cannot
    // produce a handoff notice after the cut.
    const state = loadState(dir, input.session_id);
    if (state.context !== undefined) {
      delete state.context;
      saveState(dir, input.session_id, state);
    }
    return allow();
  }

  const parts = [];
  if (Array.isArray(cfg.anchor) && cfg.anchor.length) {
    parts.push("Project facts that must hold:\n" + cfg.anchor.map((l) => `- ${l}`).join("\n"));
  }
  const cmds = Object.entries(cfg.commands || {}).filter(([, v]) => typeof v === "string" && v);
  if (cmds.length) {
    parts.push("Commands:\n" + cmds.map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  }
  if (existsSync(anchorFile)) {
    const text = readFileSync(anchorFile, "utf8").trim();
    if (text) {
      const { snapshot, rest } = splitSnapshot(text);
      const ordered = snapshot ? (rest ? `${snapshot}\n\n${rest}` : snapshot) : text;
      parts.push("Current task anchor (.doug/anchor.md):\n" + ordered.slice(0, 4000));
    }
  }
  if (parts.length === 0) return allow();

  return addContext("SessionStart", `[doug] Context was compacted or resumed. Re-anchoring.\n\n${parts.join("\n\n")}`);
});
