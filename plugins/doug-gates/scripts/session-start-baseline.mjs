#!/usr/bin/env node
// SessionStart, every source (no matcher — startup, resume, clear, compact, fork all confirmed to fire this):
// capture the dirty-tree baseline as early as this event allows, so a tree the session never touches can skip
// verification entirely at Stop instead of waiting for the stop gate's own first-run fallback capture
// (card stop-gate-session-start; see docs/research/stop-gate-session-start.md for what is and is not
// confirmed about this event). Idempotent: only writes state.baseline when it is absent, so firing late,
// firing again for a subagent sharing the parent session_id, or firing more than once, can never clobber a
// baseline that is already there.
//
// The capture always happens on the first fire, but it is only labelled "session-start" (letting the stop
// gate narrow anyChange to the baseline-relative set) when BOTH:
//   - the session demonstrably has not acted yet (no recorded commands, edits, turns, or a prior gate) —
//     a late fire (ordering is unverified, per the research note) can otherwise land after the session
//     already changed something through Bash or Edit, and that must not be baselined as pre-existing; and
//   - the source is "startup" — `clear` and `fork` hand a NEW session_id a state file that may carry a
//     previous session's uncommitted, never-verified work, which must not be baselined away either.
// Anything else is labelled "stop", the same as the stop gate's own fallback capture, so the stop gate's
// narrowing never applies and it keeps reading the full changed set, exactly as if this had never fired.
//
// Never blocks: SessionStart cannot fail a session anyway. The happy path exits 0 with no stdout; an
// unexpected error still exits 0, via runHook's fail-open path, which does write a systemMessage.
import { runHook, allow, sessionStartReason } from "../lib/io.mjs";
import { projectDir, loadConfig } from "../lib/config.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, captureBaseline, headAt, walkProposalPathFiles } from "../lib/baseline.mjs";

function readLastGreen(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ".doug/.state/test-totals.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

runHook("session-start-baseline", async (input) => {
  const dir = projectDir(input);
  const state = loadState(dir, input.session_id);
  if (state.baseline !== null) return allow(); // already captured; idempotent
  const changed = changedFiles(dir);
  if (!Array.isArray(changed)) return allow(); // not a git repo, or git unavailable
  const cfg = loadConfig(dir);
  // Proposal-path files a project's own .gitignore hides from `git status` entirely (card
  // stop-scan-committed-changes) are folded into the same baseline capture as `changed`, so a pre-existing,
  // untouched one is never later read as new by the stop gate's sinceBaseline check.
  const walked = walkProposalPathFiles(dir, cfg.proposalPaths);
  const baseline = captureBaseline(dir, [...new Set([...changed, ...walked])]);
  const baselineHead = headAt(dir);
  // Re-read immediately before writing: capturing the baseline above can take a while on a large dirty
  // tree, and another hook (guard-bash's recordCommand, edit-loop's editedFiles) may have written state
  // in that window. Writing back the state object read at the top of this function would silently discard
  // that write, so merge only the baseline fields onto the freshest state instead.
  const fresh = loadState(dir, input.session_id);
  if (fresh.baseline !== null) return allow(); // captured by a concurrent fire meanwhile
  const pristine = fresh.commands.length === 0 && fresh.editedFiles.length === 0 && fresh.turns === 0 && fresh.lastGate === null;
  fresh.baseline = baseline;
  fresh.baselineSource = pristine && sessionStartReason(input) === "startup" ? "session-start" : "stop";
  // Never overwrite a non-null baselineHead (card stop-scan-committed-changes) - matches the baseline field's
  // own idempotency above, for the same reasons (a late or repeated fire must never clobber it).
  if (fresh.baselineHead === null) fresh.baselineHead = baselineHead;
  // This capture always performs the proposalPaths walk above, so the baseline it just wrote can be trusted
  // for the stop gate's walk-based check (state.baselineWalked; see its definition in lib/state.mjs).
  fresh.baselineWalked = true;
  // Card test-count-ratchet: copy the last-green totals record into state, same write as the baseline, never
  // overwriting a non-null value. Missing or unreadable: stays null (no count check). Never throws.
  if (fresh.testTotals === null) fresh.testTotals = readLastGreen(dir);
  saveState(dir, input.session_id, fresh);
  return allow();
});
