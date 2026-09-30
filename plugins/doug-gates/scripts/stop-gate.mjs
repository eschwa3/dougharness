#!/usr/bin/env node
// Stop, and SubagentStop: before Claude ends its turn, or a subagent reports its task done, run the project's
// verification commands and block the stop while they fail, or while the session never ran a test or verify
// command itself (lib/evidence.mjs). A subagent's blocks are counted apart from the session's, against the same
// cap; a subagent's green gate records no checkpoint and no turn (proposal B, card task-completed-gate). Also blocks if a protected path was changed through Bash (the edit hook cannot
// see those), and, when .doug/plan.json is approved or done, if any changed file falls outside the
// files the plan's tasks own. When everything passes and checkpoint.enabled is set, records a
// checkpoint commit or tag (lib/checkpoint.mjs). Honors stop_hook_active and a per-session block
// cap so it can never loop forever.
//
// card stop-gate-read-only-subagent-skip: a SubagentStop whose own agent made no change skips the
// verification commands (step 3) and the evidence check (step 3b) entirely, and never takes or waits for
// gate.lock — the protected-path, proposal-path, and scope scans still run. The run trace, when it can vouch
// for the whole life of the agent (a SubagentStart line for its id), decides this on its own lines: any call to
// a tool that runs a shell command (SHELL_TOOLS: Bash, Monitor), or a successful Edit/Write/MultiEdit/NotebookEdit,
// is a change, and the trace wins over the agent's declared type either way. Only when the trace cannot vouch
// for it does the type fall back to a fixed list of read-only-by-policy agents (agentMadeNoChanges below).
//
// card stop-gate-defers-while-subagent-in-flight: the Stop hook fires whenever the lead's turn ends, even when
// it ends only to wait for a background subagent. A main Stop (never a SubagentStop) with a subagent of this
// session in flight defers instead of verifying: it still runs the cheap tree-state scans (protected paths,
// proposal paths, plan scope — steps 1, 1b, 2) and blocks on a real hit exactly as before, but skips the
// verification commands, the evidence check, gate.lock, state.verified, and the blocks.jsonl ledger, and
// returns one systemMessage naming the agents still running. "In flight" (subagentsInFlight below) is read off
// this session's run trace: an agent has stopped when some SubagentStop line for it after its last
// SubagentStart carries `decision: "allow"` (rule A), or when more of those lines carry no `decision` field at
// all than carry `decision: "block"` (rule B) — a decision-less line is the trace hook's own SubagentStop line
// (F2: it knows nothing of the gate's verdict), so more stop events than blocks means some stop the gate did
// not block, whether from a fail-open (a hook reader must never throw) or a project whose gate is not wired to
// SubagentStop at all; either way the agent is gone. A blocked SubagentStop still gets a trace line (Claude
// Code runs a BLOCKED SubagentStop's hooks same as an allowed one), so "any SubagentStop line at all" is never
// enough on its own — that is exactly what rule A/B replace. `decision` is written by the gate itself, once,
// at every SubagentStop exit (allow()/systemMessage() write "allow", blockStop() writes "block") — never by
// the trace hook, which cannot know the verdict. Transient window (F3, reviewer probe: trace [SubagentStart
// ag1, {event:"SubagentStop", agent:"ag1"}] + a main Stop → the commands ran): a main Stop that lands after
// the trace hook's own SubagentStop line for an event but before the gate's own decision-tagged line for that
// same event sees, for that agent, one decision-less line and zero block lines — 1 is more than 0, so rule B
// already reads the agent as stopped. This Stop runs the full gate (today's behaviour), never a skip: the
// window only ever makes the gate treat the agent as gone a little early, and running the full gate is always
// safe. Known limit, bounded (card stop-gate-deferral-cap): a project whose trace hook is wired to
// SubagentStart but not SubagentStop would defer on an agent that never shows a stop line; `doug init` wires
// both, and this is documented, not solved. A hand-appended SubagentStart line under .doug/.state/trace is
// possible too — that path is not a protected path, and (like state.verified) the trace is an honest-path
// record, not proof (decision 0006): a forged start line, or a subagent that dies without ever writing a
// SubagentStop line, no longer leaves the session deferring every Stop forever — state.deferrals counts
// consecutive deferred main Stops, and at stopGate.maxDeferrals (default 10) the gate runs the full
// verification anyway rather than skip it indefinitely; running the full gate is always safe, only costly.
// Background shells are out of scope — the gate cannot
// see their liveness, trace or no trace. Fails closed onto today's behaviour (subagentsInFlight returns [])
// when trace.enabled is false, the trace file is missing or unreadable, or anything throws: there is no
// config that turns the deferral on, and no way for the lead to skip verification by disabling the trace.
//
// card stop-gate-skips-orphan-subagent-stops: Claude Code also fires SubagentStop events for agents that never
// had a SubagentStart in this session's trace, carry no agent_type, and have no readable
// agent_transcript_path, on a roughly 31-second cadence while a background Agent-tool subagent is running
// (docs/research/gate-output-names-failures.md Q1: 88 such events in one session, 170 in another, zero in
// sessions with no spawns). The source component is unverified — the build depends only on the observed
// signature, never on the source's name. Each one that reached the verification path used to run the full
// verification suite concurrently with the real subagent (11 did in one session, the load a prior card
// suspected). A SubagentStop whose event matches that signature (isOrphanSubagentStop below) now allows
// immediately, with no verification commands, no evidence check, no gate.lock, no state.verified/agentBlocks
// write, and no blocks.jsonl line — only one stderr line naming the id and the usual decision-tagged trace
// line (D1). A SubagentStop with a SubagentStart line, an agent_type, or an agent_transcript_path naming an
// existing regular file is not an orphan and runs as today; the lead's main Stop is untouched (the check only
// ever runs on a SubagentStop).
// Fails closed exactly like subagentsInFlight: with trace.enabled false, or the trace file missing or
// unreadable, there is no evidence either way, so the gate runs as today.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync, closeSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runHook, allow, blockStop, systemMessage } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { matchAny } from "../lib/glob.mjs";
import { runCommand, failureSummary } from "../lib/run.mjs";
import { loadScopePlan, scopeViolations, describeViolations, PLAN_RELPATH } from "../lib/scope.mjs";
import { checkpoint, describeCheckpoint } from "../lib/checkpoint.mjs";
import { verificationEvidence, describeMissingEvidence } from "../lib/evidence.mjs";
import { changedFiles, captureBaseline, sinceBaseline, headAt, committedSince, walkProposalPathFiles, fileIdentity } from "../lib/baseline.mjs";
import { tracePath, readTrace, traceLine, appendTrace, agentLabel } from "../lib/trace.mjs";
import { isAppliedContent } from "../lib/proposals.mjs";
import { gitHead, mergeSnapshot, readDecisions, readPlanSummary, snapshotSection } from "../lib/anchor.mjs";
import { contextReading, recordAgentContext } from "../lib/agent-context.mjs";
import { parseTotals, validTotals, compareTotals, deltaTotals, waiverCovers } from "../lib/test-totals.mjs";
import { failingTestFilesFrom, classifyFinalBlock, appendBlockLine } from "../lib/block-ledger.mjs";

// Only the last this many characters of last_assistant_message are ever scanned for a partial claim
// (review, scan cost): a structured result lives at the end of a worker's message, and the balanced-span
// scan below is quadratic in the length of what it scans (each "{" starts its own forward search), which
// measured 1.6s at 130KB and 6.6s at 260KB of brace-heavy prose — real, if a worker's message ever grows
// that large. Bounding the input bounds the cost regardless of how long the message is.
const PARTIAL_SCAN_TAIL_CHARS = 32 * 1024;

// Every balanced {...} span that starts at some "{" in `text`, matched independently from that position
// (review MAJOR 1): a stray unmatched "{" earlier in the prose, or an odd number of quote characters
// before it, only ever breaks a scan that tracks nesting from the start of the whole string. Starting a
// fresh scan at every "{" means the real object's own span still balances correctly on its own, no matter
// what came before it. `quoteAware` skips over quoted string content while matching (so a literal "{" or
// "}" inside a JSON string value never affects that span's nesting); the caller falls back to a
// quote-blind pass (quoteAware: false) only when the quote-aware one finds nothing usable. Returns each
// span's offsets alongside its text, so the caller can tell a span nested inside another from a top-level
// one (review, nested-key shadow).
function balancedSpansFrom(text, quoteAware) {
  const spans = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoteAware) {
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') {
          inStr = true;
          continue;
        }
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) spans.push({ start, end, text: text.slice(start, end + 1) });
  }
  return spans;
}

// Every span from balancedSpansFrom that actually parses as a JSON object (never an array or a scalar),
// each carrying its own start/end offsets, in the order their "{" appears in `text`.
function parsedCandidates(text, quoteAware) {
  const out = [];
  for (const span of balancedSpansFrom(text, quoteAware)) {
    try {
      const obj = JSON.parse(span.text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push({ start: span.start, end: span.end, obj });
    } catch {
      // not valid JSON on its own (e.g. a partial span this scan matched by coincidence); skip it
    }
  }
  return out;
}

// True when `cand`'s span sits strictly inside some other candidate's span in `all` (review, nested-key
// shadow): a JSON value nested inside a larger object always starts later and ends earlier than its
// parent's own span, so containment on offsets alone tells top-level candidates from nested ones.
function isNestedWithin(cand, all) {
  return all.some((o) => o !== cand && o.start <= cand.start && o.end >= cand.end);
}

// The last candidate in `list` (by where its "{" appears) that carries `key` at all (generalised, card
// subagent-stop-gate-tester-red, from a `partial`-only helper: the tests_red_by_design claim below reuses
// this same scan for a different key).
function lastWithKey(list, key) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (Object.prototype.hasOwnProperty.call(list[i].obj, key)) return list[i].obj;
  }
  return null;
}

// One scan of `text`: the last TOP-LEVEL candidate carrying `key`, falling back to a nested one (review,
// nested-key shadow) only when no top-level candidate carries the key at all — a nested object happening
// to have its own matching key must never shadow its parent's, since the parent, not the value nested
// somewhere inside it, is what a worker's own top-level result object actually is. Falling back to a
// nested one when nothing top-level qualifies stays fail-closed: an object that could plausibly be read
// as a claim is still treated as one, rather than silently waved through.
function candidateOnePass(text, quoteAware, key) {
  const all = parsedCandidates(text, quoteAware);
  const topLevel = all.filter((c) => !isNestedWithin(c, all));
  return lastWithKey(topLevel, key) || lastWithKey(all, key);
}

// The object in a SubagentStop's last_assistant_message the harness should evaluate as a possible claim
// carrying `key` (review MAJOR 1; generalised to a key name for card subagent-stop-gate-tester-red):
// prefers the quote-aware scan; only when that scan finds no candidate carrying the key at all does it
// fall back to a quote-blind one (recovers the real object when an odd number of quotes, or a stray
// unmatched brace, in the surrounding prose broke the quote-aware scan's view of where the object even
// starts or ends). Only the message's last PARTIAL_SCAN_TAIL_CHARS are ever looked at.
function candidateForKey(text, key) {
  if (typeof text !== "string") return null;
  const tail = text.length > PARTIAL_SCAN_TAIL_CHARS ? text.slice(-PARTIAL_SCAN_TAIL_CHARS) : text;
  return candidateOnePass(tail, true, key) || candidateOnePass(tail, false, key);
}

// A partial claim (card worker-context-handoff, brief A): candidateForKey's object for "partial", only
// when it carries `partial: true` exactly. Anything else — no such object, or `partial` present but not
// exactly `true` (e.g. the string "true") — is not a claim.
function partialClaim(lastAssistantMessage) {
  const obj = candidateForKey(lastAssistantMessage, "partial");
  return obj && obj.partial === true ? obj : null;
}

// Only the last this many bytes of a subagent transcript are ever read by lastHandbackMessage below (same
// cost reasoning as PARTIAL_SCAN_TAIL_CHARS: a huge transcript must not stall the hook).
const HANDBACK_TAIL_BYTES = 2 * 1024 * 1024;

// Card tester-claim-missed-in-handback, pass 2: the `input.message` string of the LAST SubagentHandback
// tool_use in a subagent's transcript, or null. A fallback source for a claim when last_assistant_message
// carries none — a tester that puts its tests_red_by_design JSON only inside the SubagentHandback call
// (never on a plain-text line) used to have that claim go unseen (2026-09-24 evidence: transcript
// agent-ae0d6b0881e6539f8.jsonl, trace line 2026-09-24T14:14:48, SubagentStop decision "block"). Reads at
// most the file's last HANDBACK_TAIL_BYTES; when that cuts into the file, the first (possibly half) line
// of what was read is dropped, since a JSONL line broken at an arbitrary byte offset never parses. Never
// throws (a hook reader must never throw): a missing or unreadable file, a line that fails to parse, or a
// tool_use whose input.message is not a string are all skipped, same as returning null when there is no
// hand-back at all.
function lastHandbackMessage(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let text;
  let truncated = false;
  try {
    if (!existsSync(transcriptPath)) return null;
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - HANDBACK_TAIL_BYTES);
    truncated = start > 0;
    const fd = openSync(transcriptPath, "r");
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let lastMessage = null;
  const lines = text.split("\n");
  for (let i = truncated ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o && o.type === "assistant" && o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) continue;
    for (const item of content) {
      if (item && item.type === "tool_use" && item.name === "SubagentHandback" && item.input && typeof item.input.message === "string") {
        lastMessage = item.input.message;
      }
    }
  }
  return lastMessage;
}

// A red-by-design claim (design point 1, card subagent-stop-gate-tester-red): candidateForKey's object for
// "tests_red_by_design", only when that key's value is a non-empty array of non-empty strings. Any other
// shape — missing key, an empty array, a string, an object, or an array holding a non-string or empty
// string — is not a claim. Never throws (a hook reader must never throw): any failure here reads as no
// claim, same as the partial scan it reuses. This shape check is defense-in-depth (fix pass, reviewer
// minor 6): redByDesignCoverage's checks (ii)/(iii) already reject a malformed claim on their own (an
// empty or garbled list can never name the real failing file), so a bug here alone cannot let a stop
// through — but a clean claim shape is still validated up front rather than relied on implicitly. Called
// both on last_assistant_message and, as a fallback (card tester-claim-missed-in-handback, pass 2), on
// lastHandbackMessage's result — the object shape it validates is the same either way.
function redByDesignClaim(lastAssistantMessage) {
  try {
    const obj = candidateForKey(lastAssistantMessage, "tests_red_by_design");
    if (!obj) return null;
    const files = obj.tests_red_by_design;
    if (!Array.isArray(files) || files.length === 0) return null;
    if (!files.every((f) => typeof f === "string" && f.length > 0)) return null;
    return files.map(stripLeadingDotSlash);
  } catch {
    return null;
  }
}

// A leading "./" a claim entry or a parsed path token might carry is not part of its identity (fix pass,
// minor 3): both sides are normalised the same way before comparison, so "./tests/a.test.mjs" and
// "tests/a.test.mjs" name the same file.
function stripLeadingDotSlash(f) {
  return typeof f === "string" && f.startsWith("./") ? f.slice(2) : f;
}

// failingTestFilesFrom (design point 2, card subagent-stop-gate-tester-red) now lives in
// ../lib/block-ledger.mjs (card stop-gate-block-ledger), imported above: the block ledger's own classifier
// needs the same test-file extraction this coverage check does, so both share one implementation.

// Whether a tests_red_by_design claim covers this SubagentStop's failed verification commands (design
// point 2, card subagent-stop-gate-tester-red). `commandFailures` is one entry per failed command from
// step 3, `{ command, output }` (stderr + stdout, untruncated). `{ covered: true, files }` when every
// failed command's output names at least one test file, every named file is in the claim, and every
// claimed file is changed or untracked in the working tree (`changed`, from changedFiles(dir) above);
// otherwise `{ covered: false, reasonLine }` — one line, no newline, saying why.
function redByDesignCoverage(claimFiles, commandFailures, changed, dir) {
  const changedSet = new Set(Array.isArray(changed) ? changed : []);
  const namedByCommand = commandFailures.map((cf) => ({ command: cf.command, files: failingTestFilesFrom(cf.output, dir) }));
  const noFile = namedByCommand.filter((c) => c.files.length === 0);
  if (noFile.length > 0) {
    return {
      covered: false,
      reasonLine: `The tests_red_by_design claim does not cover this: ${noFile.map((c) => `\`${c.command}\``).join(", ")} named no test file in its output.`,
    };
  }
  const allNamed = [...new Set(namedByCommand.flatMap((c) => c.files))];
  const claimSet = new Set(claimFiles);
  const uncovered = allNamed.filter((f) => !claimSet.has(f));
  if (uncovered.length > 0) {
    return {
      covered: false,
      reasonLine: `The tests_red_by_design claim does not cover this: ${uncovered.join(", ")} is failing but not listed in the claim.`,
    };
  }
  const unmodified = claimFiles.filter((f) => !changedSet.has(f));
  if (unmodified.length > 0) {
    return {
      covered: false,
      reasonLine: `The tests_red_by_design claim does not cover this: ${unmodified.join(", ")} is claimed but not modified in the working tree.`,
    };
  }
  return { covered: true, files: claimFiles };
}

// D2 (card stop-gate-defers-while-subagent-in-flight): the agents of this session (`{ id, type }`, in start
// order) whose run trace (lib/trace.mjs) shows a SubagentStart with no later SubagentStop that counts as a
// stop. For each agent, only the SubagentStop lines after its own last SubagentStart are considered. It has
// stopped when either:
//   - rule A: any of those lines carries `decision: "allow"` (the gate itself only ever writes that when the
//     agent is let go — D1); or
//   - rule B: strictly more of those lines carry no `decision` field at all than carry `decision: "block"`.
//     A decision-less line is the trace hook's own SubagentStop line (F2 — the trace hook appends one per stop
//     event, whatever the gate later decides, and knows nothing of that verdict), so more stop events than
//     blocks means some stop the gate did not block — a fail-open (a hook reader must never throw) or a
//     project whose gate is not wired to SubagentStop at all — and the agent is gone either way.
// Otherwise the agent is still in flight (a BLOCKED SubagentStop still gets a trace line, so it is still
// working, not gone). `cfg` is the caller's already-loaded config (avoids loading it twice); a disabled trace,
// a missing or unreadable trace file, or any thrown error all read as `[]` — fail closed onto today's
// behaviour (D4). `contextNotice` below reuses this same reader (`.length > 0`) for its own suppression, so
// the notice and the deferral share one definition of "in flight".
function subagentsInFlight(dir, cfg, sessionId) {
  try {
    if (!cfg.trace || cfg.trace.enabled === false) return [];
    const file = tracePath(dir, sessionId);
    if (!existsSync(file)) return [];
    const lines = readTrace(file);
    const order = [];
    const lastStart = new Map(); // agent id -> { type, index: last SubagentStart line's index }
    lines.forEach((line, i) => {
      if (line.event !== "SubagentStart" || !line.agent) return;
      if (!lastStart.has(line.agent)) order.push(line.agent);
      lastStart.set(line.agent, { type: line.agentType || "agent", index: i });
    });
    const inFlight = [];
    for (const agent of order) {
      const { type, index } = lastStart.get(agent);
      const stopLines = lines.filter((l, i) => i > index && l.agent === agent && l.event === "SubagentStop");
      const allowed = stopLines.some((l) => l.decision === "allow");
      const blocked = stopLines.filter((l) => l.decision === "block").length;
      const undecided = stopLines.filter((l) => l.decision !== "allow" && l.decision !== "block").length;
      const stopped = allowed || undecided > blocked;
      if (!stopped) inFlight.push({ id: agent, type });
    }
    return inFlight;
  } catch {
    return [];
  }
}

// Agent types read-only by tool policy (card stop-gate-read-only-subagent-skip): the plugin's researcher,
// reviewer, architect, and flow-debugger agents, plus Claude Code's own Explore and Plan. Exact,
// case-sensitive match against subagent.type; only the fallback when the trace cannot vouch for the agent's
// whole life (agentMadeNoChanges below) — the trace, when it can, wins over this list either way.
const READ_ONLY_AGENT_TYPES = new Set(["researcher", "reviewer", "architect", "flow-debugger", "doug-flow:researcher", "doug-flow:reviewer", "Explore", "Plan"]);

// Tools whose successful PostToolUse counts as a change (card stop-gate-read-only-subagent-skip). Tools that
// run a shell command (SHELL_TOOLS below) are judged separately, on any line at all (Pre or Post, whatever
// ok): a shell command can change files whether or not its tool call itself is ever recorded as having
// succeeded.
const CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Tools that run a shell command (card stop-gate-monitor-is-a-change): Bash runs one directly, and Monitor
// (seen 4 times in this repo's real subagent traces, per the reviewer of e710a25) runs one to poll a
// background process. Either can change files whether or not its own tool call is ever recorded as having
// succeeded, so any Pre or PostToolUse line naming one counts as a change whatever its ok.
const SHELL_TOOLS = new Set(["Bash", "Monitor"]);

// True when this SubagentStop's own agent made no change during its life (card
// stop-gate-read-only-subagent-skip), so the caller can skip the verification commands and evidence check for
// it. Never throws (a hook reader must never throw): any failure here reads as false, the conservative answer
// (run the gate as today).
//
// With trace evidence — the trace is enabled, the file is readable, and it holds a SubagentStart line whose
// agent equals subagent.id (without that the trace cannot vouch for the whole life of the agent) — every line
// whose agent equals subagent.id is considered, and the type does not matter: a change is any line (Pre or
// PostToolUse, whatever ok) whose tool is in SHELL_TOOLS, or a PostToolUse line whose tool is in CHANGE_TOOLS
// and whose ok is not exactly false (a null ok counts as success — conservative). No change found -> true.
//
// Without trace evidence, true only when subagent.type is in READ_ONLY_AGENT_TYPES.
function agentMadeNoChanges(dir, cfg, sessionId, subagent) {
  try {
    if (!subagent) return false;
    if (cfg.trace && cfg.trace.enabled !== false) {
      const file = tracePath(dir, sessionId);
      if (existsSync(file)) {
        const lines = readTrace(file);
        const started = lines.some((l) => l.event === "SubagentStart" && l.agent === subagent.id);
        if (started) {
          const mine = lines.filter((l) => l.agent === subagent.id);
          const changed = mine.some((l) => {
            if (SHELL_TOOLS.has(l.tool)) return true;
            return l.event === "PostToolUse" && CHANGE_TOOLS.has(l.tool) && l.ok !== false;
          });
          return !changed;
        }
      }
    }
    return READ_ONLY_AGENT_TYPES.has(subagent.type);
  } catch {
    return false;
  }
}

// card stop-gate-skips-orphan-subagent-stops: true when a SubagentStop's own event carries none of the three
// signals of a real subagent of this session (docs/research/gate-output-names-failures.md Q1: Claude Code
// fires SubagentStop for agents that never had a SubagentStart, carry no agent_type, and have no readable
// agent_transcript_path, on a roughly 31-second cadence while a background Agent-tool subagent is running; the
// source component is unverified — this depends only on the observed signature, never on the source's name).
// All three must hold: no SubagentStart line for subagent.id in this session's trace, input.agent_type absent
// (undefined, null, or empty string), and input.agent_transcript_path absent, not a string, or naming a path
// that is not an existing regular file. `subagent` is unused when the event itself already carries everything
// needed (input.agent_id, mirroring how `subagent.id` itself is derived, keeps this correct even if ever
// called without a `subagent` object) — it is only the caller's `subagent &&` guard (main() below) that keeps
// this off the main Stop at all, so that guard is the one and only thing standing between this check and a
// main Stop; there is deliberately no second, redundant guard in here that would silently paper over its
// removal. Never throws (a hook reader must never throw): any failure here reads as false, the conservative
// answer. Fails closed exactly like subagentsInFlight: with trace.enabled false, or the trace file missing or
// unreadable, there is no evidence either way, so this returns false and the gate runs as today — there is no
// way to skip verification by turning the trace off.
function isOrphanSubagentStop(dir, cfg, sessionId, input) {
  try {
    if (!cfg.trace || cfg.trace.enabled === false) return false;
    const file = tracePath(dir, sessionId);
    if (!existsSync(file)) return false;
    const lines = readTrace(file);
    const id = String(input.agent_id || "unknown");
    if (lines.some((l) => l.event === "SubagentStart" && l.agent === id)) return false;
    if (input.agent_type) return false;
    const transcriptPath = input.agent_transcript_path;
    if (typeof transcriptPath === "string" && transcriptPath) {
      try {
        if (statSync(transcriptPath).isFile()) return false; // a readable transcript vouches for the agent: not an orphan
      } catch {
        // missing or unreadable: falls through, still counts as "no readable transcript"
      }
    }
    return true;
  } catch {
    return false;
  }
}

// The two green boundaries the Stop gate calls contextNotice from (card context-window-handoff, minor 3): the
// anchor's "Boundary:" line, the message clause, and whether the Gate line is meaningful for that boundary.
// On the verification path this Stop actually ran the gate, so its own just-computed state.lastGate is honest;
// on the skip path no gate ran this Stop at all, so the Gate line is omitted rather than reading a possibly
// stale state.lastGate from an earlier turn.
const CONTEXT_BOUNDARIES = {
  verification: { id: "verification passed", text: "verification passed this turn, no subagent running, nothing outside the plan", gate: true },
  skip: { id: "nothing changed", text: "nothing changed this turn, no subagent running", gate: false },
};

// Context-window handoff (card context-window-handoff): the harness only ever advises here, never compacts.
// At a green Stop, with contextWindow enabled, the run trace enabled (major 2: the in-flight subagent check
// below depends on it — a disabled trace must not let the notice claim "no subagent running" when it cannot
// know), and state.context past its threshold, and no subagent in flight, refresh the anchor snapshot with a
// handoff block and return the systemMessage text (mutating state.context.notifiedAt so the notice does not
// repeat until pct grows by repeatAfter). Returns null, and touches nothing, for every other case — disabled,
// the trace disabled, no reading, below threshold, a subagent in flight, or already notified at this pct. Never
// throws: any failure here is silent, exactly like an absent reading. `boundary` is "verification" or "skip"
// (CONTEXT_BOUNDARIES above), naming which green path called it.
function contextNotice(dir, cfg, state, sessionId, boundary) {
  try {
    if (!cfg.contextWindow || !cfg.contextWindow.enabled) return null;
    if (!cfg.trace || cfg.trace.enabled === false) return null;
    const b = CONTEXT_BOUNDARIES[boundary];
    if (!b) return null;
    const ctx = state.context;
    if (!ctx || typeof ctx.pct !== "number" || !Number.isFinite(ctx.pct)) return null;
    const threshold = cfg.contextWindow.threshold ?? 80;
    if (ctx.pct < threshold) return null;
    if (subagentsInFlight(dir, cfg, sessionId).length > 0) return null;
    const repeatAfter = cfg.contextWindow.repeatAfter ?? 5;
    if (typeof ctx.notifiedAt === "number" && ctx.pct < ctx.notifiedAt + repeatAfter) return null;

    const anchorFile = join(dir, ".doug/anchor.md");
    const section = snapshotSection({
      plan: readPlanSummary(dir),
      decisions: readDecisions(dir),
      state,
      now: new Date(),
      handoff: {
        boundary: b.id,
        gate: b.gate && state.lastGate ? { ok: state.lastGate.ok, at: state.lastGate.at } : null,
        head: gitHead(dir),
        contextPct: ctx.pct,
      },
    });
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const before = existsSync(anchorFile) ? readFileSync(anchorFile, "utf8") : "";
    writeFileSync(anchorFile, mergeSnapshot(before, section));

    state.context = { ...ctx, notifiedAt: ctx.pct };
    return `[doug] Context at ${ctx.pct}% (threshold ${threshold}). This is a convenient point: ${b.text}. Run /compact; .doug/anchor.md holds the handoff.`;
  } catch {
    return null;
  }
}

// ---- Test-count ratchet (card test-count-ratchet; the pure logic and its known limits are in lib/test-totals.mjs).
// Every reader below degrades to "no check" or "no waiver"; none may throw (runHook would fail open).
const LAST_GREEN_RELPATH = ".doug/.state/test-totals.json";
const WAIVER_FILE_RELPATH = ".doug/.state/test-count-waivers";

// Waiver sources: commit messages since the session's baseline HEAD, and the waiver file's text.
function waiverSources(dir, baselineHead) {
  const sources = [];
  try {
    if (typeof baselineHead === "string" && /^[0-9a-f]{7,64}$/.test(baselineHead)) {
      const out = execFileSync("git", ["log", "--format=%B%x00", `${baselineHead}..HEAD`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
      sources.push(...out.split("\0"));
    }
  } catch {
    // no git, or a base git no longer knows: no commit waivers
  }
  try {
    sources.push(readFileSync(join(dir, WAIVER_FILE_RELPATH), "utf8"));
  } catch {
    // no waiver file, or unreadable: no file waivers
  }
  return sources;
}

// The count check for the commands that ran green by exit code. Returns { problems, parsed }: `problems` are
// block reasons, `parsed` the per-command totals of every run with a clean single summary (for the last-green
// record). A missing or unparseable summary, or no baseline, is a trace line and no check.
function countCheck(dir, cfg, state, input, ran) {
  const problems = [];
  const parsed = {};
  // The note carries its own event name, never the stop event's: a decision-less SubagentStop line would read to
  // subagentsInFlight (more undecided stops than blocks) as "the agent is gone" (review B1). No reader keys on
  // "CountCheck"; it only adds one to attribution's per-agent event count. Honours trace.enabled false (review m2).
  const note = (reason) => {
    try {
      if (!cfg || !cfg.trace || cfg.trace.enabled === false) return;
      appendTrace(dir, { ...traceLine(input, { now: new Date() }), event: "CountCheck", reason });
    } catch {
      // logging must never fail the gate
    }
  };
  // Each entry is `{ command, stdout }` (a real run: parsed here) or `{ command, result }` (a credited pre-commit
  // run: the parseTotals-shaped result the hook recorded). Both take the identical path below.
  for (const { command, stdout, result } of ran) {
    try {
      const p = result !== undefined ? result : parseTotals(stdout);
      if (p.status === "conflict") {
        problems.push(`\`${command}\` printed conflicting test summaries (${p.summaries.map((x) => `${x.total} total, ${x.skipped} skipped, ${x.todo} todo`).join(" vs ")}); the test count cannot be trusted. A waiver does not cover this.`);
        continue;
      }
      if (p.status !== "ok") {
        note(`count check did not run for \`${command}\`: no test summary in its output`);
        continue;
      }
      parsed[command] = p.totals;
      const all = state.testTotals && typeof state.testTotals === "object" ? state.testTotals : null;
      const base = all ? validTotals(all[command]) : null;
      if (!base) {
        note(`count check did not run for \`${command}\`: no baseline totals for it`);
        continue;
      }
      const found = compareTotals(base, p.totals);
      if (found.length === 0) continue;
      const delta = deltaTotals(base, p.totals);
      if (waiverCovers(waiverSources(dir, state.baselineHead), delta)) continue;
      const lines = found.map((f) => `${f.kind} ${f.kind === "total" ? "dropped" : "rose"} from ${f.baseline} (baseline) to ${f.now} (now)`);
      problems.push(
        `\`${command}\` test count regressed: ${lines.join("; ")}. Deleting or skipping tests does not make a change green. Restore them, or waive it with a line \`test-count-waiver: total=${delta.total} skipped=${delta.skipped} todo=${delta.todo}; <reason>\` in the commit message or ${WAIVER_FILE_RELPATH}.`,
      );
    } catch {
      note(`count check did not run for \`${command}\`: error while checking`);
    }
  }
  return { problems, parsed };
}

// A green run's totals become the last-green record the next session starts from. Merged per command.
function writeLastGreen(dir, parsed) {
  try {
    if (Object.keys(parsed).length === 0) return;
    let record = {};
    try {
      const old = JSON.parse(readFileSync(join(dir, LAST_GREEN_RELPATH), "utf8"));
      if (old && typeof old === "object" && !Array.isArray(old)) record = old;
    } catch {
      // absent or unreadable: start a fresh record
    }
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, LAST_GREEN_RELPATH), JSON.stringify({ ...record, ...parsed }));
  } catch {
    // never fail the gate over the record
  }
}

function resolveCommands(cfg) {
  const out = [];
  for (const entry of cfg.stopGate.commands || []) {
    if (typeof entry !== "string") continue;
    const named = cfg.commands && cfg.commands[entry];
    out.push({ name: entry, command: typeof named === "string" ? named : entry });
  }
  return out;
}

// card stop-gate-credits-pre-commit: `git rev-parse HEAD^{tree}`, the tree sha of the current commit — what
// the pre-commit hook's own record (.doug/.state/pre-commit/last-run.json) compares its `tree` field against.
// Null on any failure (no git, no HEAD yet, ...): a reader must never throw.
function headTreeSha(dir) {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const sha = out.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// card ratchet-pre-commit-credit: a recorded parseTotals result, normalised, or null when it is not readable.
function readableRecordedTotals(t) {
  try {
    if (!t || typeof t !== "object") return null;
    if (t.status === "ok") {
      const totals = validTotals(t.totals);
      return totals ? { status: "ok", totals } : null;
    }
    if (t.status === "conflict") {
      if (!Array.isArray(t.summaries) || t.summaries.length === 0) return null;
      const summaries = t.summaries.map(validTotals);
      return summaries.every((x) => x) ? { status: "conflict", summaries } : null;
    }
    return t.status === "none" ? { status: "none" } : null;
  } catch {
    return null;
  }
}

// card stop-gate-credits-pre-commit: the pre-commit hook (.githooks/pre-commit) writes a machine-readable
// record of its own run to .doug/.state/pre-commit/last-run.json (version, tree, ok, at, commands: [{ name,
// command, exit, durationMs, totals? }], totals being the hook's parseTotals result for that command; a command with a baseline in state.testTotals is credited only if its totals are readable ok or conflict, else the commands run). When the working tree has no changes beyond HEAD (nothing left in `changed`
// once stopGate.ignoreChangedPaths paths are removed) and that record is a passing run, against HEAD's own
// tree, of exactly today's configured commands in order, the Stop gate credits it instead of re-running the
// same commands a second time — returning `{ name, command, ok: true, credited: "pre-commit" }` per command,
// same length and order as resolveCommands(cfg). Returns null (run as today) on a missing, unparsable,
// wrong-shape, failing, stale-tree, or mismatched-commands record, or a dirty tree — fail closed to running,
// never to passing. A reader must never throw: every path here is wrapped, so a corrupt record never crashes
// the hook (`runHook` fails open on a throw, which here would mean passing without running — forbidden).
function preCommitCredit(dir, cfg, changed, state) {
  try {
    if (!Array.isArray(changed)) return null;
    const ignore = cfg.stopGate.ignoreChangedPaths || [];
    const remaining = changed.filter((f) => !matchAny(ignore, f));
    if (remaining.length > 0) return null;
    const raw = readFileSync(join(dir, ".doug/.state/pre-commit/last-run.json"), "utf8");
    const record = JSON.parse(raw);
    if (!record || typeof record !== "object") return null;
    if (record.version !== 1) return null;
    if (record.ok !== true) return null;
    if (typeof record.tree !== "string") return null;
    if (!Array.isArray(record.commands)) return null;
    const head = headTreeSha(dir);
    if (!head || record.tree !== head) return null;
    for (const c of record.commands) {
      if (!c || typeof c !== "object" || c.exit !== 0) return null;
    }
    const configured = resolveCommands(cfg);
    if (record.commands.length !== configured.length) return null;
    for (let i = 0; i < configured.length; i++) {
      if (!record.commands[i] || record.commands[i].command !== configured[i].command) return null;
    }
    // card ratchet-pre-commit-credit: a command with a baseline in state.testTotals is credited only when the
    // record carries readable totals for it (ok with valid counts, or a conflict with valid summaries);
    // otherwise null and the commands really run. `recorded` is the parseTotals-shaped result for the count check.
    const all = state && state.testTotals && typeof state.testTotals === "object" ? state.testTotals : null;
    const out = [];
    for (let i = 0; i < configured.length; i++) {
      const { name, command } = configured[i];
      const recorded = readableRecordedTotals(record.commands[i].totals);
      const hasBaseline = all ? validTotals(all[command]) !== null : false;
      if (hasBaseline && (!recorded || recorded.status === "none")) return null;
      out.push({ name, command, ok: true, credited: "pre-commit", ...(recorded ? { recorded } : {}) });
    }
    return out;
  } catch {
    return null;
  }
}

// The verified-tree fingerprint (card stop-gate-process-storm, goal 2): the HEAD sha plus the content
// identity of every dirty path and every proposal-path file on disk, at the moment it is computed. Null
// when `changed` is not the array shape changedFiles returns (no git, or git unavailable) — there is
// nothing to fingerprint reliably, so the tree can never be judged "unchanged" on this path.
function treeFingerprint(dir, cfg, changed) {
  if (!Array.isArray(changed)) return null;
  const walked = walkProposalPathFiles(dir, cfg.proposalPaths);
  const paths = [...new Set([...changed, ...walked])];
  // `at` (state.mjs's comment for state.verified) is when this fingerprint was taken; sameTree below never
  // reads it, so recomputing it on the after-wait path (a fresh Date.now()) never affects equality.
  return { head: headAt(dir), tree: captureBaseline(dir, paths), at: Date.now() };
}

// Whether two treeFingerprint results describe the same tree: both present, the same HEAD, the same set of
// paths, and an identical identity for each. Never throws (a hook reader must never throw): a malformed
// fingerprint — e.g. a hand-edited state.verified — just compares unequal rather than blocking the gate.
function sameTree(a, b) {
  try {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (a.head !== b.head) return false;
    const at = a.tree && typeof a.tree === "object" ? a.tree : null;
    const bt = b.tree && typeof b.tree === "object" ? b.tree : null;
    if (!at || !bt) return false;
    const ak = Object.keys(at).sort();
    const bk = Object.keys(bt).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
    return ak.every((k) => at[k] === bt[k]);
  } catch {
    return false;
  }
}

// card stop-gate-process-storm, case 2 (second tester pass, reviewer-found gap): a verified-unchanged skip
// is a green gate in every way that matters, not a bare allow — it resets the same counters an ordinary
// green gate resets, and on the main Stop it still surfaces the context-window notice, exactly like the
// onlyIfEdited (nothing changed) skip just above it does. Shared by the immediate skip and the after-wait,
// reloaded-state skip inside the lock section below, so both behave identically. `capNote` (card
// stop-gate-deferral-cap, review round 1 minor 5): the deferral cap sentence, non-null only when this Stop's
// own deferral just hit the cap and this call is reached from the lock-wait's after-reload skip below — the
// only site this can ever be non-null from, since the immediate call above runs before this Stop's deferral
// check even exists. That exit returns straight from here, bypassing the *Releasing wrappers (R4), so the
// prepend happens inline instead of through them.
function verifiedUnchangedAllow(dir, cfg, state, input, subagent, capNote) {
  // D1 (card stop-gate-defers-while-subagent-in-flight): this is one of the gate's existing reason-carrying
  // exits (F4); the `decision` a SubagentStop's own line now always carries folds in here, alongside its
  // `reason`, rather than a second line being written for the same event. Only for a SubagentStop (subagent
  // set) — a main Stop's own trace line here is not an agent-stop decision.
  if (cfg.trace && cfg.trace.enabled !== false) {
    appendTrace(dir, { ...traceLine(input, { now: new Date() }), event: input.hook_event_name, reason: "verified-unchanged", ...(subagent ? { decision: "allow" } : {}) });
  }
  if (subagent) {
    state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: 0 };
    saveState(dir, input.session_id, state);
    return allow();
  }
  state.stopBlocks = 0;
  const notice = contextNotice(dir, cfg, state, input.session_id, "skip");
  saveState(dir, input.session_id, state);
  if (capNote) return systemMessage(notice ? `${capNote}\n\n${notice}` : capNote);
  return notice ? systemMessage(notice) : allow();
}

// Single-runner lock (card stop-gate-process-storm, goal 3): only one gate runs the verification commands
// at a time per project, so concurrent SubagentStops share one suite instead of each starting its own (the
// 2026-09-16 process storm). `.doug/.state/gate.lock` holds `{ pid, session, at }` while a gate's commands
// run.
const GATE_LOCK_RELPATH = ".doug/.state/gate.lock";
function gateLockPath(dir) {
  return join(dir, GATE_LOCK_RELPATH);
}

// Reads gate.lock, tolerating garbage (a hook reader must never throw): a missing file, unreadable file, or
// content that fails to parse or carries no numeric pid all read as null — the same as "no lock", which the
// caller treats exactly like a stale one.
function readGateLock(dir) {
  try {
    const o = JSON.parse(readFileSync(gateLockPath(dir), "utf8"));
    // A pid only counts when it is a positive integer (reviewer-found gap): 0 means "this process's own
    // group" and -1 broadcasts to every process the caller may signal, so process.kill(pid, 0) does not
    // throw for either and a liveness check that hands them straight to it reads a garbage lock as live.
    return o && typeof o === "object" && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
  } catch {
    return null;
  }
}

function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is owned by another user (permission denied, not "no such process") —
    // that holder is still alive, just not signallable by us. Every other error (ESRCH: no such process, or
    // anything else) reads as dead.
    return err && err.code === "EPERM";
  }
}

// Creates gate.lock exclusively (throws EEXIST when one is already there, or any other fs error). The
// caller decides what a failure means.
function writeGateLock(dir, sessionId) {
  mkdirSync(join(dir, ".doug/.state"), { recursive: true });
  writeFileSync(gateLockPath(dir), JSON.stringify({ pid: process.pid, session: sessionId, at: Date.now() }), { flag: "wx" });
}

// Overwrites gate.lock with this gate's own pid/session, whether it was stale (a dead pid) or its holder
// simply never let go inside the wait bound — either way, never lets a lock the gate cannot even write hang
// it (best-effort; a failure here just leaves lockOwned false to the caller, which never releases a lock it
// does not hold).
function takeOverGateLock(dir, sessionId) {
  try {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(gateLockPath(dir), JSON.stringify({ pid: process.pid, session: sessionId, at: Date.now() }));
  } catch {
    // best-effort takeover only
  }
}

// Card stop-gate-budget-under-hook-timeout: cfg.stopGate.hookTimeoutSec must equal the platform's own
// Stop/SubagentStop hook `timeout` (hooks.json/settings.json), but a hook reader never throws (F6), so a
// missing, non-number, or non-positive value reads as the platform's own default, 600.
function resolveHookTimeoutSec(cfg) {
  const sec = cfg && cfg.stopGate && cfg.stopGate.hookTimeoutSec;
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec : 600;
}

// Computed once per gate run: the wall-clock instant past which the platform itself would cancel this
// hook (F1 — a timed-out hook is killed, fails open, and its output, including a block message, is
// discarded), less a margin so the gate's own block reaches Claude Code before that happens. gateStart
// is this process's own start time, not the moment this function runs, so the budget covers everything
// this invocation has done so far (config/state loads, earlier checks), not just what follows.
function gateBudget(cfg) {
  const hookTimeoutSec = resolveHookTimeoutSec(cfg);
  const hookTimeoutMs = hookTimeoutSec * 1000;
  const marginMs = Math.min(30000, hookTimeoutMs / 10);
  // process.uptime() is fractional seconds; runCommand's timeoutMs must be an unsigned integer (Node's
  // spawnSync throws otherwise), so every value derived from this deadline is rounded down.
  const gateStart = Date.now() - Math.floor(process.uptime() * 1000);
  return { hookTimeoutSec, hookTimeoutMs, deadline: Math.floor(gateStart + hookTimeoutMs - marginMs) };
}

// A lock whose numeric `at` is older than the hook-timeout budget is stale regardless of a live pid: no
// legitimate holder can still be running that long, since the platform itself would have killed its hook
// by then (F1). A missing or non-numeric `at` changes nothing here; the pid liveness check still decides.
function lockStaleByAge(lock, hookTimeoutMs) {
  return !!lock && typeof lock.at === "number" && Number.isFinite(lock.at) && Date.now() - lock.at > hookTimeoutMs;
}

// Card stop-gate-timeout-normalise: cfg.stopGate.timeoutMs normalised once, shared by the per-command timeout
// and the wait bound below, so the two never disagree on what a garbage or fractional value means. A finite
// number above 0 floors to an integer, clamped up to at least 1ms (0.5 must not floor to 0 — spawnSync reads a
// timeout of 0 as none at all, letting a command run past the budget unclamped; 2.5 must not reach spawnSync
// un-floored — it throws ERR_OUT_OF_RANGE there, and a hook reader must never throw, F6). Anything else
// (non-number, NaN, Infinity, 0, negative, null) is "unset" (null), read by each call site as its own default.
function normalizedTimeoutMs(cfg) {
  const t = cfg.stopGate.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.max(1, Math.floor(t)) : null;
}

// Card stop-gate-deferral-cap (R2): cfg.stopGate.maxDeferrals normalised the same shape as
// normalizedTimeoutMs above — a hook reader must never throw (F6/F10), so a finite number >= 1 is floored
// and used; anything else (missing, 0, negative, NaN, a string, null, an object) reads as the default, 10.
function normalizedMaxDeferrals(cfg) {
  const m = cfg && cfg.stopGate && cfg.stopGate.maxDeferrals;
  return typeof m === "number" && Number.isFinite(m) && m >= 1 ? Math.floor(m) : 10;
}

// Card stop-gate-deferral-cap, review round 1 minor 4: state.deferrals read the same defensive way as
// stopGate.maxDeferrals above — a hook reader must never throw, and a hand-edited or otherwise non-numeric
// state file value (e.g. "deferrals": "1", which `(state.deferrals || 0) + 1` would concatenate into "11")
// must not misbehave. A finite number >= 0 floors to an integer; anything else (missing, negative, NaN, a
// string, null, an object) reads as 0.
function normalizedDeferrals(state) {
  const d = state && state.deferrals;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0;
}

runHook("stop-gate", async (input) => {
  if (input.stop_hook_active) return allow();
  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  let state = loadState(dir, input.session_id);
  const subagent = input.hook_event_name === "SubagentStop" ? { id: String(input.agent_id || "unknown"), type: input.agent_type || "subagent" } : null;
  // R6 (card stop-gate-deferral-cap): a SubagentStop of this session ends any run of consecutive deferred
  // main Stops the counter (R1) is tracking — reset right here, after loadState, so every SubagentStop exit
  // below that saves state (including the one that reloads state again mid-lock-wait, R6 note there) persists
  // the reset.
  if (subagent) state.deferrals = 0;
  if (!subagent) state.turns += 1;
  const maxBlocks = cfg.stopGate.maxBlocks ?? 3;
  const blocksSoFar = subagent ? (state.agentBlocks && state.agentBlocks[subagent.id]) || 0 : state.stopBlocks;
  const who = subagent ? `Subagent ${subagent.type} (${subagent.id})` : null;
  // D1 (card stop-gate-defers-while-subagent-in-flight): one choke point for the `decision` every SubagentStop
  // exit's own trace line now carries, so no exit (present or future) can miss it — except the
  // `stop_hook_active` early return above, which runs before `subagent` exists and so writes no decision line
  // at all; that is benign, since it leaves only the trace hook's own decision-less line for the event, and
  // rule B (below) reads a decision-less line with no matching block as the agent already gone, the right
  // answer. `decision` is "block"
  // exactly when the exit is blockStop, "allow" for allow()/systemMessage() (either lets the agent stop, so it
  // is gone). Never fires for a main Stop (subagent is null there — a main Stop's exits are not agent-stop
  // decisions). `traceReason`/`extra` let the three exits that already wrote a reason-carrying line (F4:
  // verified-unchanged is handled directly in verifiedUnchangedAllow below since it is a shared, non-closure
  // function; no-agent-changes and tests_red_by_design use these) fold their reason (and, for
  // tests_red_by_design, its `detail`) into this same line instead of a second one being written. Wrapped so a
  // trace failure never blocks the real exit (a hook reader must never throw).
  function traceSubagentDecision(decision, traceReason, extra) {
    if (!subagent) return;
    try {
      if (!cfg.trace || cfg.trace.enabled === false) return;
      appendTrace(dir, { ...traceLine(input, { now: new Date() }), event: "SubagentStop", decision, reason: traceReason ?? null, ...(extra || {}) });
    } catch {
      // never block the real exit on a trace failure
    }
  }
  const allowDecided = (traceReason, extra) => {
    traceSubagentDecision("allow", traceReason, extra);
    return allow();
  };
  const blockStopDecided = (reason) => {
    traceSubagentDecision("block", null);
    return blockStop(reason);
  };
  const systemMessageDecided = (message, traceReason, extra) => {
    traceSubagentDecision("allow", traceReason, extra);
    return systemMessage(message);
  };
  // Card stop-gate-block-ledger: one ledger line per block/stand-down below, written synchronously right
  // before the blockStop/systemMessage call it belongs to (those call process.exit(0) themselves, so
  // nothing queued after them ever runs). appendBlockLine never throws.
  const logBlock = (reason, cls) =>
    appendBlockLine(dir, { hook: subagent ? "subagent-stop" : "stop-gate", agent: subagent ? subagent.type : null, reason, class: cls, session: input.session_id });
  // Card block-ledger-stood-down-repeats: a stood-down line is written at most once per session per
  // cause, so a session standing down at its cap does not append a fresh identical line on every later
  // Stop/SubagentStop past it. Cause key: "turn-budget" (lead only), or "block-cap:<lead|agent id>" — the
  // partial-claim cap and the verification/lock-refusal cap of one agent are the same block-cap cause for
  // that agent. The record lives in state.stoodDownLogged, mutated in place before the saveState that
  // already precedes every stand-down site below (so it survives across hook processes). A wrong-shaped
  // value there (not a plain object) is treated as nothing written yet rather than thrown on.
  const markStoodDown = (cause) => {
    const key = cause === "turn-budget" ? "turn-budget" : `block-cap:${subagent ? subagent.id : "lead"}`;
    if (!state.stoodDownLogged || typeof state.stoodDownLogged !== "object" || Array.isArray(state.stoodDownLogged)) {
      state.stoodDownLogged = {};
    }
    const already = !!state.stoodDownLogged[key];
    if (!already) state.stoodDownLogged[key] = true;
    return already;
  };
  // Card stop-gate-budget-under-hook-timeout: the whole gate (wait plus commands) must fit under the
  // platform's own hook timeout. Computed once so the wait loop and the command loop share one clock.
  const { hookTimeoutSec, hookTimeoutMs, deadline: budgetDeadline } = gateBudget(cfg);

  // card stop-gate-skips-orphan-subagent-stops: checked before the partial-claim block, the tree scans, the
  // deferral logic, gate.lock, skipVerification, and runVerification — an orphan SubagentStop is not a real
  // agent of this session, so none of that runs for it. No saveState (R6's in-memory `state.deferrals = 0`
  // above is left unpersisted), no logBlock, no gate.lock, state.verified/agentBlocks untouched; the trace
  // still gets one decision-tagged SubagentStop line (D1) via allowDecided.
  if (subagent && isOrphanSubagentStop(dir, cfg, input.session_id, input)) {
    process.stderr.write(
      `[doug] SubagentStop for orphan agent ${subagent.id} (no SubagentStart in the trace, no agent_type, no readable transcript): verification skipped\n`,
    );
    return allowDecided("orphan-subagent-stop");
  }

  // Partial claim (card worker-context-handoff, brief A): a subagent cannot be observed compacting, so a
  // partial=true claim is only honoured when the harness itself measured this agent's context at or above
  // contextWindow.threshold at some point (state.agents[id].context.maxPct) — never on the agent's say-so, and
  // never when contextWindow is disabled (there can be no reading). Refused before the onlyIfEdited early
  // return below: a claim with nothing to verify must still be checked. Counted and capped through the same
  // agentBlocks map and cap as every other SubagentStop block; never runs on the main Stop.
  if (subagent) {
    const claim = partialClaim(input.last_assistant_message);
    if (claim) {
      if (blocksSoFar >= maxBlocks) {
        const alreadyStoodDown = markStoodDown("block-cap");
        saveState(dir, input.session_id, state);
        const reason = `[doug] ${who}'s partial claim was refused ${blocksSoFar} times and the gate is standing down for it. Do not treat its work as done.`;
        if (!alreadyStoodDown) logBlock(reason, "stood-down");
        return systemMessageDecided(reason);
      }
      // (review minor 10) trace disabled means no reading was ever possible for this agent, which is a
      // different fact than "contextWindow is off" or "nothing crossed the threshold yet" — say so plainly
      // rather than a refusal reason that implies a measurement was attempted.
      if (!cfg.trace || cfg.trace.enabled === false) {
        const blocks = blocksSoFar + 1;
        state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: blocks };
        saveState(dir, input.session_id, state);
        const reason =
          `[doug] Partial result refused: context readings need trace.enabled (it is off), so no reading could ever be recorded for this agent. ` +
          `A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.`;
        logBlock(reason, "real");
        return blockStopDecided(reason);
      }
      const threshold = cfg.contextWindow.threshold ?? 80;
      const enabled = !!(cfg.contextWindow && cfg.contextWindow.enabled);
      let entry = enabled ? state.agents && state.agents[subagent.id] && state.agents[subagent.id].context : null;
      let maxPct = entry && typeof entry.maxPct === "number" ? entry.maxPct : null;
      // (review minor 11) a fresh, one-off reading: the last recorded PostToolUse can be stale by the time a
      // worker actually stops, so when nothing recorded so far clears the threshold, take one more reading
      // from the transcript SubagentStop itself carries. A worker that crossed the threshold after its last
      // tool call is then still accepted, instead of refused on a reading that predates its own stop.
      if (enabled && (maxPct === null || maxPct < threshold) && typeof input.agent_transcript_path === "string" && input.agent_transcript_path) {
        const fresh = contextReading(input.agent_transcript_path);
        if (fresh) {
          entry = recordAgentContext(state, subagent.id, fresh, new Date());
          maxPct = entry.maxPct;
        }
      }
      if (maxPct === null || maxPct < threshold) {
        const blocks = blocksSoFar + 1;
        state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: blocks };
        saveState(dir, input.session_id, state);
        const last = entry ? `${entry.pct}%` : "none";
        const reason =
          `[doug] Partial result refused: no context reading at or above ${threshold}% was recorded for this agent (${last}). ` +
          `A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.`;
        logBlock(reason, "real");
        return blockStopDecided(reason);
      }
      // Accepted: the recorded maxPct clears the threshold, so this falls through to the normal gate below.
    }
  }

  // Budget: when a turn cap is set and exceeded, stop blocking and say so, so loops can end.
  if (!subagent && cfg.budget && cfg.budget.maxTurns && state.turns > cfg.budget.maxTurns) {
    const alreadyStoodDown = markStoodDown("turn-budget");
    saveState(dir, input.session_id, state);
    // Card stop-gate-block-ledger, review pass 2 item 3: a stand-down whatever its cause (lead's ruling:
    // every stand-down is recorded), not only the counter-cap ones.
    const reason = `[doug] Turn budget of ${cfg.budget.maxTurns} exceeded (${state.turns}). Gates are no longer blocking; review before continuing.`;
    if (!alreadyStoodDown) logBlock(reason, "stood-down");
    return systemMessage(reason);
  }

  const edited = state.editedFiles.length > 0;
  const changed = changedFiles(dir);
  // Snapshot whatever was already dirty so it is never mistaken for this session's own work (card
  // stop-gate-waiting-on-subagents). Ideally this happens on SessionStart (scripts/session-start-baseline.mjs),
  // before the session can have dirtied anything itself; this is the fallback for a session where that
  // never fired, capturing on the stop gate's own first run instead (card stop-gate-session-start). Whichever
  // captured it is recorded in state.baselineSource. Step 1 (protected paths) and step 2 (plan scope) below
  // still read the full `changed` set, unfiltered: they are about the state of the tree, not who dirtied it.
  // True only for the one Stop that repairs an old-format baseline (Minor 4 below): the walk-based check must
  // sit out for exactly that run, even though state.baselineWalked is set true within it.
  let baselineJustRepaired = false;
  if (state.baseline === null && Array.isArray(changed)) {
    const walked = walkProposalPathFiles(dir, cfg.proposalPaths);
    state.baseline = captureBaseline(dir, [...new Set([...changed, ...walked])]);
    state.baselineSource = "stop";
    // Recorded in the same write as state.baseline (card stop-scan-committed-changes). Never overwrite a
    // non-null baselineHead: an old state file's baseline predates this key and loads it as null via
    // emptyState's spread, so this null check, rather than an unconditional set, is what "never overwrite"
    // means in practice on this path.
    if (state.baselineHead === null) state.baselineHead = headAt(dir);
    // This capture always performs the proposalPaths walk above, so the baseline it just wrote can be
    // trusted for the walk-based check below (state.baselineWalked; see its definition in lib/state.mjs).
    state.baselineWalked = true;
  } else if (state.baseline !== null && !state.baselineWalked && Array.isArray(changed)) {
    // One-time repair (Minor 4, card stop-scan-committed-changes): a baseline captured before this walk
    // existed (an old state file, or - the way this actually surfaced live - a session whose baseline was
    // captured under an older stop-gate.mjs/session-start-baseline.mjs before this card's vendored copies
    // were redeployed mid-session) has no entries at all for most proposalPaths files. Rather than sitting
    // out the walk-based check for the rest of the session, the very first Stop to see such a baseline folds
    // the walked files' current identities into it (only for a path not already a key - never overwriting an
    // entry a real capture already recorded) and marks it walked, so the walk is exact again from the next
    // Stop on. This one Stop still cannot trust what it just backfilled (a file could have been sitting there
    // dirty since before this repair, not truly "untouched"), so it alone skips the walk-based check -
    // baselineJustRepaired below, not state.baselineWalked, is what this run's check reads.
    const walked = walkProposalPathFiles(dir, cfg.proposalPaths);
    for (const f of walked) {
      if (!(f in state.baseline)) state.baseline[f] = fileIdentity(join(dir, f));
    }
    state.baselineWalked = true;
    baselineJustRepaired = true;
    // Same repair, same reasoning, for the committed-changes scan (card stop-scan-committed-changes): an old
    // state file predating baselineHead has recorded no HEAD either, so committedSince has been sitting out
    // for this session exactly like the walk was. Nothing before this moment is attributed to the session
    // either way (the walk repair above makes the same tradeoff), so recording HEAD now is equally safe, and
    // brings the committed scan on from the next Stop the same way the walk comes back on.
    if (state.baselineHead === null) state.baselineHead = headAt(dir);
  }
  // Paths committed since the session's baseline HEAD (card stop-scan-committed-changes): a protected- or
  // proposal-path change the session commits before it stops leaves a clean tree, invisible to `changed`
  // alone. Null exactly like `changed` when unknown — no baselineHead was ever recorded (no git, or an old
  // state file predating this key), there is no HEAD yet, or git no longer knows the baseline sha (a
  // rewritten base) — so steps 1 and 1b below fall back to scanning nothing extra, today's behavior.
  const committed = committedSince(dir, state.baselineHead);
  // Gitignored proposal-path files, on disk right now, whose identity has moved since the baseline (card
  // stop-scan-committed-changes): computed here, ahead of onlyIfEdited below, and reused by step 1b, so a
  // project that gitignores a proposalPaths prefix (e.g. .claude/) does not need a git-visible or committed
  // change to reach the scan that catches it (see the anyChange comment just below for why). Gated on
  // state.baselineWalked and !baselineJustRepaired: an untrustworthy or just-backfilled baseline sits out
  // this one check rather than false-blocking on files it cannot yet vouch for (see the repair branch above).
  const walkedProposalHits = Array.isArray(changed) && state.baselineWalked && !baselineJustRepaired
    ? sinceBaseline(dir, walkProposalPathFiles(dir, cfg.proposalPaths), state.baseline || {}).filter((f) => !matchAny(cfg.stopGate.ignoreChangedPaths || [], f))
    : [];
  // A path counts as this session's own work only when it is absent from the baseline, or present but
  // moved since: a path still identical to its baseline entry is not this session's work.
  const sessionChanged = Array.isArray(changed) ? sinceBaseline(dir, changed, state.baseline || {}) : changed;
  const sessionMadeChanges = edited || (Array.isArray(sessionChanged) && sessionChanged.length > 0);
  // With a baseline captured at SessionStart — before the session could have dirtied anything — an
  // already-dirty tree the session never touched can safely skip verification entirely: narrow anyChange
  // to the baseline-relative set. A baseline captured by the stop gate's own fallback above cannot make
  // that promise (the session may have made Bash changes before this gate's first run ever captured it),
  // so it keeps reading the full `changed` set, exactly as before this card. `committed` and
  // `walkedProposalHits` also count on either path (card stop-scan-committed-changes): otherwise
  // onlyIfEdited's early return below would make the new scans in steps 1 and 1b unreachable for exactly the
  // bypasses they close — a session that only committed by Bash and left a clean tree, or one that wrote a
  // gitignored proposal-path file by Bash, which neither `git status` nor the Edit-tool tracking ever sees.
  const anyChange =
    (state.baselineSource === "session-start" ? sessionMadeChanges : edited || (Array.isArray(changed) && changed.length > 0)) ||
    (Array.isArray(committed) && committed.length > 0) ||
    walkedProposalHits.length > 0;
  if (cfg.stopGate.onlyIfEdited && !anyChange) {
    const notice = subagent ? null : contextNotice(dir, cfg, state, input.session_id, "skip");
    saveState(dir, input.session_id, state);
    return notice ? systemMessage(notice) : allowDecided();
  }

  // card stop-gate-process-storm, case 2: a tree already verified by an earlier green gate this session
  // needs no recheck at all — placed ahead of maxBlocks and every problems check below, since a red gate
  // never records `verified` and there is nothing left here to recheck when nothing has changed since.
  const currentFingerprint = treeFingerprint(dir, cfg, changed);
  if (sameTree(state.verified, currentFingerprint)) {
    return verifiedUnchangedAllow(dir, cfg, state, input, subagent);
  }

  // D3 (card stop-gate-defers-while-subagent-in-flight): steps 1, 1b, and 2 (protected paths, committed
  // protected paths, proposal paths, and plan scope) below are about the state of the tree, not about who is
  // running — the deferral just below and the ordinary verification path (inside runVerification) both need
  // them, so they are extracted here rather than kept as two copies that could drift apart.
  function scanTreeProblems() {
    const problems = [];

    // 1. Protected paths changed outside the Edit tool (e.g. via Bash), still dirty in the working tree now.
    const protectedHits = Array.isArray(changed) ? changed.filter((f) => matchAny(cfg.protectedPaths, f) && !matchAny(cfg.stopGate.ignoreChangedPaths || [], f)) : [];
    if (protectedHits.length) {
      problems.push(`Protected files were modified: ${protectedHits.join(", ")}. Revert them or ask the user; these paths are protected in .doug/config.json.`);
    }

    // 1 (committed). The same check for paths the session committed since its baseline HEAD (card
    // stop-scan-committed-changes): `committed` already excludes the same housekeeping paths `changed` does
    // (baseline.mjs's committedSince), and respects stopGate.ignoreChangedPaths the same way. Pushed as its own
    // problem, with the same leading phrase plus a "(committed this session)" suffix, so a hit found only by
    // this scan reads as the same kind of problem the working-tree scan above reports, not a different one.
    // Minor 6: a path that is both a dirty hit above AND a committed hit here (committed, then modified again
    // uncommitted) is dropped from this list - it is already named once by the working-tree problem above, and
    // must not read as two separate problems.
    if (Array.isArray(committed)) {
      const ignore = cfg.stopGate.ignoreChangedPaths || [];
      const committedProtectedHits = committed.filter((f) => matchAny(cfg.protectedPaths, f) && !matchAny(ignore, f) && !protectedHits.includes(f));
      if (committedProtectedHits.length) {
        problems.push(`Protected files were modified: ${committedProtectedHits.join(", ")} (committed this session). Revert them or ask the user; these paths are protected in .doug/config.json.`);
      }
    }

    // 1b. Decisions/rules changed outside the proposal path (cards memory-decisions, proposal-ledger-forgeable,
    // stop-scan-committed-changes): changedFiles already includes untracked paths (--untracked-files=all), so a
    // newly created ADR/rule is a hit here too, not just a modified one. `committed` adds paths the session
    // committed since its baseline HEAD, which leave a clean tree invisible to `changed` alone; a direct
    // filesystem walk under each proposalPaths pattern's fixed prefix (walkProposalPathFiles) adds paths a
    // project's own .gitignore hides from `git status` entirely, narrowed to those whose identity moved since
    // the baseline (sinceBaseline) so a pre-existing, untouched file under a gitignored proposal path is never
    // mistaken for this session's work. A hit from any of the three is fine only when the applied-proposal
    // ledger (.doug/.state/proposals/applied.jsonl) has a line for it whose content sha256 matches AND whose
    // named diff (under .doug/.state/learn/), applied onto the session's baseline HEAD (or HEAD when there is
    // none - lib/proposals.mjs's `base` option), re-derives those same bytes - a hand-written ledger line alone
    // no longer satisfies this (isAppliedContent in ../lib/proposals.mjs). Decided (card d-proposal-authorization,
    // decision 0006, amendment 2026-09-13): this ledger is an honest-path record, not proof the user said yes -
    // it stops the honest path and raises a forgery's cost, but a determined agent can still write all three
    // files by hand, so the message below says so rather than implying the ledger proves consent.
    if (Array.isArray(changed)) {
      const ignore = cfg.stopGate.ignoreChangedPaths || [];
      const changedHits = changed.filter((f) => matchAny(cfg.proposalPaths, f) && !matchAny(ignore, f));
      const committedHits = Array.isArray(committed) ? committed.filter((f) => matchAny(cfg.proposalPaths, f) && !matchAny(ignore, f)) : [];
      const proposalHits = [...new Set([...changedHits, ...committedHits, ...walkedProposalHits])];
      const unapproved = proposalHits.filter((f) => !isAppliedContent(dir, f, { base: state.baselineHead }));
      if (unapproved.length) {
        problems.push(
          `Decisions/rules were written outside the proposal path: ${unapproved.join(", ")}. These paths (proposalPaths in .doug/config.json) change only through an approved proposal (/doug-decide, then learn.mjs apply). Revert them or ask the user. The ledger records the honest path; it is not proof the user approved (decision 0006, amendment 2026-09-13).`,
        );
      }
    }

    // 2. Plan scope: with an approved or done plan, every changed file must belong to a task.
    // Draft and rejected plans are not contracts yet, so they are ignored.
    let scope = null;
    if (Array.isArray(changed) && cfg.stopGate.planScope !== false) {
      const { plan, reason, error } = loadScopePlan(dir);
      if (reason === "unreadable") process.stderr.write(`[doug] ${PLAN_RELPATH} is unreadable (${error}); scope not checked\n`);
      if (plan) {
        const violations = scopeViolations(changed, plan, { ignore: cfg.stopGate.ignoreChangedPaths || [] });
        scope = { plan: plan.title, status: plan.status, outOfScope: violations.map((v) => v.file) };
        if (violations.length) problems.push(describeViolations(violations, plan));
      }
    }

    return { problems, scope };
  }

  // D3 (card stop-gate-defers-while-subagent-in-flight): a main Stop (subagent is null there, so this is
  // always `[]` on a SubagentStop) with a subagent of this session still in flight defers instead of claiming
  // this turn's tree is verified. The tree-state scans above still run — cheap, and about the tree, not about
  // who is running — so a real protected-path, proposal-path, or scope problem still blocks exactly as today
  // (that block is real and counts as today); only with no such problem does this Stop defer, skipping
  // gate.lock, the verification commands, the evidence check, state.verified, and the blocks.jsonl ledger
  // entirely, and touching neither state.stopBlocks nor state.agentBlocks. The next Stop after the last
  // SubagentStop (subagentsInFlight then returns `[]`) runs the full gate as today. state.lastGate is left
  // untouched — this Stop verified nothing, so there is nothing honest to record there.
  // R1/R3 (card stop-gate-deferral-cap): state.deferrals counts consecutive deferred main Stops; unbounded,
  // a dead or forged subagent (the module header's "Known limit") would defer forever. deferralCapNote is
  // set only when this Stop's own deferral just hit stopGate.maxDeferrals, and is read by the releasing
  // wrappers below (R4) to prepend the cap sentence to whatever the ordinary verification path this Stop
  // falls through to ends up returning. The cap only ever widens when the full verification runs (R7): it
  // never lets a Stop skip verification that would otherwise have run.
  let deferralCapNote = null;
  const inFlight = subagent ? [] : subagentsInFlight(dir, cfg, input.session_id);
  if (inFlight.length > 0) {
    const { problems: deferProblems } = scanTreeProblems();
    if (deferProblems.length === 0) {
      const maxDeferrals = normalizedMaxDeferrals(cfg);
      const n = normalizedDeferrals(state) + 1;
      const names = inFlight.map((a) => agentLabel({ agent: a.id, agentType: a.type })).join(", ");
      if (n < maxDeferrals) {
        state.deferrals = n;
        saveState(dir, input.session_id, state);
        return systemMessage(
          `[doug] Verification deferred: ${inFlight.length} subagent(s) of this session still in flight (${names}). The stop gate runs the full verification at the first Stop after they stop. Do not treat this work as done.`,
        );
      }
      // R3: the cap is hit on this Stop — do not defer again. Reset the counter (R5) and fall through to
      // the ordinary verification path below exactly as a Stop with no agent in flight, remembering the cap
      // sentence for the releasing wrappers (R4) to prepend to whatever that path returns. Review round 1
      // minor 3: `n` counts this Stop too, so the number actually deferred before it is `n - 1`; the cap
      // value itself (stopGate.maxDeferrals) is named alongside it so the message stays informative once the
      // deferred count is no longer always the cap.
      state.deferrals = 0;
      deferralCapNote = `[doug] Deferral cap reached: ${n - 1} consecutive Stops deferred (stopGate.maxDeferrals ${maxDeferrals}) while subagents of this session were still in flight (${names}); running the full verification anyway.`;
    } else {
      state.deferrals = 0; // R5: a real tree problem — this Stop does not defer
    }
    // A real problem, or the cap was just hit: fall through to the ordinary path below, which finds the
    // same problem again inside runVerification and blocks on it exactly as today (deferral only ever
    // widens "nothing to check yet", never what counts as a real problem).
  } else if (!subagent) {
    state.deferrals = 0; // R5: no agent in flight — this Stop runs the gate
  }

  // card stop-gate-read-only-subagent-skip: computed once, ahead of the gate.lock acquire just below, so a
  // SubagentStop whose own agent made no change never takes or waits for the lock at all — waiting up to
  // timeoutMs on a suite it will never even need is the other half of the 2026-09-16 process storm. Only ever
  // true for a SubagentStop; the main Stop always runs the full gate.
  const skipVerification = subagent ? agentMadeNoChanges(dir, cfg, input.session_id, subagent) : false;

  // card stop-gate-no-change-restop: a stop in the same scope on a tree unchanged since a red block whose
  // commands all really ran (state.lastRed, recorded at the final block below) repeats that block without
  // running the commands or touching gate.lock, counted against maxBlocks like any final block, logged with the
  // recorded block's class and carrying the deferral cap note like blockStopReleasing. One reuse per record: the
  // record is cleared by the reuse, so the next stop runs the commands (a new red records afresh). Anything
  // unreadable, different, or not plainly a command-failure red degrades to running (fail closed to running).
  if (!skipVerification) {
    let lastRed = null;
    try {
      const rec = state.lastRed;
      const scopeNow = subagent ? subagent.id : "main";
      const commandsNow = resolveCommands(cfg).map((c) => c.command);
      if (
        rec &&
        typeof rec === "object" &&
        !Array.isArray(rec) &&
        typeof rec.scope === "string" &&
        typeof rec.summary === "string" &&
        Array.isArray(rec.commands) &&
        rec.commands.every((c) => typeof c === "string") &&
        rec.scope === scopeNow &&
        rec.commands.length === commandsNow.length &&
        rec.commands.every((c, i) => c === commandsNow[i]) &&
        rec.fingerprint &&
        typeof rec.fingerprint === "object" &&
        currentFingerprint &&
        sameTree(rec.fingerprint, currentFingerprint) &&
        !(subagent && (redByDesignClaim(input.last_assistant_message) ?? redByDesignClaim(lastHandbackMessage(input.agent_transcript_path)))) &&
        !preCommitCredit(dir, cfg, changed, state)
      ) {
        lastRed = rec;
      }
    } catch {
      lastRed = null;
    }
    if (lastRed) {
      if (blocksSoFar >= maxBlocks) {
        const alreadyStoodDown = markStoodDown("block-cap");
        saveState(dir, input.session_id, state);
        const reason = who
          ? `[doug] ${who} was blocked ${blocksSoFar} times and the gate is standing down for it. Verification is still failing; do not treat its work as done.`
          : `[doug] Stop gate blocked ${state.stopBlocks} times this session and is standing down. Verification is still failing; do not treat this work as done.`;
        if (!alreadyStoodDown) logBlock(reason, "stood-down");
        return systemMessageDecided(reason);
      }
      const { problems: treeProblems } = scanTreeProblems();
      const blocks = blocksSoFar + 1;
      if (subagent) state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: blocks };
      else state.stopBlocks = blocks;
      state.lastRed = null; // one reuse per record: the next stop on this tree really runs
      saveState(dir, input.session_id, state);
      const reason =
        (who ? `[doug] ${who} cannot report done: verification failed (${blocks}/${maxBlocks}). Fix the following before finishing the task. ` : `[doug] Verification failed (${blocks}/${maxBlocks}). Fix the following before finishing. `) +
        `Do not claim the task is done while this fails.\n\n` +
        `Nothing changed since the last block, so the commands were not re-run. The last run's failure:\n\n` +
        [...treeProblems, lastRed.summary].join("\n\n");
      const reuseClass = typeof lastRed.class === "string" ? lastRed.class : "real";
      const capped = deferralCapNote && !subagent ? `${deferralCapNote}\n\n${reason}` : reason;
      logBlock(reason, reuseClass);
      return blockStopDecided(capped);
    }
  }

  // card stop-gate-process-storm, case 3: only one gate runs the verification commands at a time per
  // project (the 2026-09-16 process storm: four concurrent SubagentStops each ran the full suite, each
  // 300s timeout orphaning ten vitest workers). A gate holds .doug/.state/gate.lock while its commands run;
  // a second gate that finds a live lock waits for it, bounded by stopGate.timeoutMs, then reloads state and
  // reapplies the skip above — the holder's own green run may have just recorded the very `verified` tree
  // this gate needs, letting it skip instead of also running the full suite.
  let verifiedCandidate = currentFingerprint;
  let lockOwned = false;
  // card stop-gate-lock-release-on-throw: an exception anywhere below (e.g. inside runVerification, after
  // the lock is taken) reaches runHook, which fails open via process.exit(0) — skipping every return path
  // here, including the *Releasing wrappers below. Registered once, right where lockOwned exists, so it is
  // in place before anything that can throw while this gate holds the lock; `releaseLock` is a hoisted
  // function declaration (not a const) so it is safe to call here even though it is defined later in this
  // scope. Synchronous and never throws, matching the `process.on("exit", ...)` contract.
  process.on("exit", () => {
    try {
      releaseLock();
    } catch {
      // a hook reader must never throw, including from here
    }
  });
  if (!skipVerification) {
    try {
      writeGateLock(dir, input.session_id);
      lockOwned = true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        // Some other failure writing the lock (e.g. an unwritable .doug/.state): never let a lock the gate
        // cannot even write hang it. Proceed unlocked, exactly like before this card.
        lockOwned = false;
      } else {
        const lock = readGateLock(dir);
        if (!lock || !pidIsLive(lock.pid) || lockStaleByAge(lock, hookTimeoutMs)) {
          // Stale (a dead pid, a lock file that fails to parse, or one older than the hook-timeout budget —
          // card stop-gate-budget-under-hook-timeout: no legitimate holder can still be running that long):
          // take it over at once, no wait.
          takeOverGateLock(dir, input.session_id);
          lockOwned = true;
        } else {
          // The bound scales with the number of configured commands (reviewer-found gap): a holder legitimately
          // runs each of resolveCommands(cfg) with its own timeoutMs budget, one after another, so a flat
          // timeoutMs would give up on — and duplicate — a holder still legitimately partway through its own
          // (later) command. Card stop-gate-timeout-normalise: an unset (garbage or fractional-to-zero)
          // timeoutMs no longer defaults to a flat 300000ms here — the budget deadline below is the real bound
          // either way, so an unset value waits only for what remains of it, unmultiplied.
          const normalizedTimeout = normalizedTimeoutMs(cfg);
          const waitBoundMs = normalizedTimeout !== null ? normalizedTimeout * Math.max(1, resolveCommands(cfg).length) : budgetDeadline - Date.now();
          const waitDeadline = Date.now() + waitBoundMs;
          // Card stop-gate-budget-under-hook-timeout: waitDeadline alone can outrun the platform's own hook
          // timeout (F1), so a waiter also stops at budgetDeadline — but there it refuses the stop instead of
          // taking the lock over, since taking over and running past the platform's own timeout would just get
          // this gate killed mid-command too (an ungated stop, its block message discarded).
          let refusedLock = null;
          while (true) {
            const live = readGateLock(dir);
            if (!live || !pidIsLive(live.pid) || lockStaleByAge(live, hookTimeoutMs)) break; // released, died, or stale by age
            if (Date.now() >= budgetDeadline) {
              refusedLock = live;
              break;
            }
            if (Date.now() >= waitDeadline) break; // bounded: never hang the gate on someone else's lock
            await new Promise((r) => setTimeout(r, 200));
          }
          if (refusedLock) {
            // Refused: not a pass. Counted against maxBlocks like any other block (design point 3), including
            // the same standing-down cap as an ordinary failed-verification block.
            if (blocksSoFar >= maxBlocks) {
              const alreadyStoodDown = markStoodDown("block-cap");
              saveState(dir, input.session_id, state);
              const reason = who
                ? `[doug] ${who} was blocked ${blocksSoFar} times and the gate is standing down for it. Verification is still failing; do not treat its work as done.`
                : `[doug] Stop gate blocked ${state.stopBlocks} times this session and is standing down. Verification is still failing; do not treat this work as done.`;
              if (!alreadyStoodDown) logBlock(reason, "stood-down");
              return systemMessageDecided(reason);
            }
            const blocks = blocksSoFar + 1;
            if (subagent) state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: blocks };
            else state.stopBlocks = blocks;
            state.lastRed = null; // card stop-gate-no-change-restop: a lock refusal is load-caused, never reused
            saveState(dir, input.session_id, state);
            const reason =
              (who ? `[doug] ${who} cannot report done` : `[doug] Stop gate`) +
              `: another gate (session ${refusedLock.session || "unknown"}) is still running the verification commands, and this hook's own budget (hookTimeoutSec ${hookTimeoutSec} s) ran out while waiting for it (${blocks}/${maxBlocks}). Stop again once it finishes.`;
            logBlock(reason, "load-timeout");
            return blockStopDecided(reason);
          }
          // The holder may have just finished its own green run of this same session while we waited.
          state = loadState(dir, input.session_id);
          // R6 (card stop-gate-deferral-cap; review round 1 MAJOR 1): this reload just replaced `state` with
          // a fresh disk load, discarding whatever reset this Stop had already decided before reaching the
          // lock section — the R6 SubagentStop reset above, or (on a main Stop) the R3/R5 reset the deferral
          // check just above made in memory but never got to save (this Stop had to reach the lock section
          // to even get here, so it already passed that check point and always intends 0). Unconditional:
          // every path that reaches here, subagent or not, means 0.
          state.deferrals = 0;
          verifiedCandidate = treeFingerprint(dir, cfg, changed);
          if (sameTree(state.verified, verifiedCandidate)) {
            // Review round 1 minor 5: this exit returns straight from verifiedUnchangedAllow, bypassing the
            // *Releasing wrappers (R4) below — release the lock here (a no-op when this gate never took it)
            // and hand the cap note through so a cap Stop landing on this path still carries it.
            releaseLock();
            return verifiedUnchangedAllow(dir, cfg, state, input, subagent, deferralCapNote);
          }
          // Still different, or the wait hit its bound with the lock still held: take it over and run.
          takeOverGateLock(dir, input.session_id);
          lockOwned = true;
        }
      }
    }
  }

  // card stop-gate-process-storm, case 3: the lock is held only around the commands actually running.
  // io.mjs's allow/blockStop/systemMessage each call process.exit(0) themselves — a wrapping try/finally
  // around runVerification below would never run, since process.exit() cuts the call stack off before any
  // enclosing finally gets a turn — so the lock must be released just before each of those calls instead,
  // through these wrappers used only from here down, once lockOwned may be true. Card
  // stop-gate-lock-release-on-throw: the same release also runs from the `process.on("exit", ...)` handler
  // registered above, which covers the path these wrappers cannot — an exception that reaches runHook's own
  // fail-open `process.exit(0)` without passing through any of them.
  function releaseLock() {
    if (!lockOwned) return;
    const lock = readGateLock(dir);
    if (lock && lock.pid === process.pid) {
      try {
        unlinkSync(gateLockPath(dir));
      } catch {
        // already gone
      }
    }
  }
  // R4 (card stop-gate-deferral-cap): when this Stop's own deferral just hit the cap (deferralCapNote set,
  // main Stop only — it is never set for a SubagentStop, but the `!subagent` guard is kept explicit to
  // match the rule), the cap sentence is prepended to whatever this Stop's ordinary verification path
  // returns: a green that would otherwise allow silently now allows with a systemMessage carrying it, a
  // green that already carries a message gets it prepended, and a red block gets it prepended to the reason.
  const allowReleasing = (traceReason, extra) => {
    releaseLock();
    if (deferralCapNote && !subagent) return systemMessageDecided(deferralCapNote, traceReason, extra);
    return allowDecided(traceReason, extra);
  };
  const blockStopReleasing = (reason) => {
    releaseLock();
    return blockStopDecided(deferralCapNote && !subagent ? `${deferralCapNote}\n\n${reason}` : reason);
  };
  const systemMessageReleasing = (message, traceReason, extra) => {
    releaseLock();
    return systemMessageDecided(deferralCapNote && !subagent ? `${deferralCapNote}\n\n${message}` : message, traceReason, extra);
  };

  const runVerification = async () => {
    if (blocksSoFar >= maxBlocks) {
      const alreadyStoodDown = markStoodDown("block-cap");
      saveState(dir, input.session_id, state);
      const reason = who
        ? `[doug] ${who} was blocked ${blocksSoFar} times and the gate is standing down for it. Verification is still failing; do not treat its work as done.`
        : `[doug] Stop gate blocked ${state.stopBlocks} times this session and is standing down. Verification is still failing; do not treat this work as done.`;
      if (!alreadyStoodDown) logBlock(reason, "stood-down");
      return systemMessageReleasing(reason);
    }

    // D3 (card stop-gate-defers-while-subagent-in-flight): steps 1, 1b, and 2 (protected paths, committed
    // protected paths, proposal paths, and plan scope) now live in scanTreeProblems above, shared with the
    // deferral check — the deferral already ran this same scan once when a subagent was in flight, and finding
    // a real problem there falls through to here, which finds it again and blocks on it exactly as today.
    const { problems, scope } = scanTreeProblems();

  // Precondition for a tests_red_by_design claim (design point 2): "the gate is otherwise about to block
  // on failed commands only" means no protected-path, committed-protected, proposal-path, or scope problem
  // — everything pushed to `problems` up to here.
  const preVerificationProblems = problems.length;

  // 3. Verification commands. Skipped entirely (card stop-gate-read-only-subagent-skip) when this
  // SubagentStop's own agent made no change: `results` stays [] and no command runs.
  const results = [];
  // One entry per failed command, `{ command, output }` (stderr + stdout, untruncated), for the
  // tests_red_by_design coverage check below (design point 2, card subagent-stop-gate-tester-red).
  const commandFailures = [];
  const ranGreen = []; // count check input: { command, stdout } of each command that really ran and exited 0, plus { command, result } of each credited pre-commit command whose recorded totals are readable
  // card stop-gate-credits-pre-commit: a passing pre-commit record for this exact tree and command set
  // stands in for actually running them — see preCommitCredit above. Every other check below (evidence,
  // red-by-design, state.verified, the block ledger) runs exactly as it would after a real run.
  const credited = skipVerification ? null : preCommitCredit(dir, cfg, changed, state);
  if (!skipVerification && credited) {
    for (const { recorded, ...r } of credited) {
      results.push(r);
      if (recorded) ranGreen.push({ command: r.command, result: recorded });
    }
  } else if (!skipVerification) {
    for (const { name, command } of resolveCommands(cfg)) {
      // Card stop-gate-budget-under-hook-timeout: a command that cannot even start before the platform
      // would kill this hook's own process is dropped rather than let the platform cut it off mid-run,
      // silently, with its block message discarded (F1). One still runs with what budget is left, clamped
      // to it, so the existing timed-out message below reports the timeout actually used.
      const remaining = budgetDeadline - Date.now();
      if (remaining <= 0) {
        results.push({ name, command, ok: false, skipped: "budget" });
        problems.push(
          `\`${command}\` not run: the stop gate's budget (hook timeout ${hookTimeoutSec} s) was used up before it could start.`,
        );
        continue;
      }
      // R2 (pass 2 review; card stop-gate-timeout-normalise): a garbage or non-positive cfg.stopGate.timeoutMs
      // (0, null, "abc", 2.5, 0.5 — any of which would otherwise reach spawnSync unclamped, floored to 0 (read
      // as no timeout), or un-floored (throws ERR_OUT_OF_RANGE there, and a throw fails open per F6)) must
      // never bypass the budget: normalizedTimeoutMs floors and clamps up to at least 1ms; unset uses the
      // remaining budget outright. The timed-out message below reports this same value.
      const commandTimeoutMs = Math.min(normalizedTimeoutMs(cfg) ?? remaining, remaining);
      const r = runCommand(command, { cwd: dir, timeoutMs: commandTimeoutMs });
      results.push({ name, command, ok: r.ok, durationMs: r.durationMs, timedOut: r.timedOut, status: r.status });
      if (r.ok) ranGreen.push({ command, stdout: r.stdout });
      if (!r.ok) {
        const why = r.timedOut ? `timed out after ${commandTimeoutMs} ms` : `exit ${r.status}`;
        const output = r.stderr + "\n" + r.stdout;
        // card gate-output-names-failures: the block reason leads with the failing test names (R1/R2);
        // commandFailures below keeps the untruncated output for the tests_red_by_design coverage check.
        problems.push(`\`${command}\` failed (${why}):\n${failureSummary(output, 40)}`);
        commandFailures.push({ command, output });
      }
    }
  }
  const postCommandProblems = problems.length;

  // 3b. Evidence: the session must have run a test or verify command itself (lib/evidence.mjs), so a session that
  // says done without ever looking is told so, in different words from one whose verification failed. A path
  // that was already dirty when the session's baseline was captured, and is still identical to it, is not this
  // session's work, so it cannot trigger a demand to verify a change the session never made. Also skipped on a
  // no-agent-changes skip (card stop-gate-read-only-subagent-skip): 3b demands the session itself ran a test,
  // and a no-change agent blocked by it would satisfy that only by rerunning the suite — exactly what this
  // card stops.
  let evidence = null;
  if (!skipVerification && cfg.stopGate.requireEvidence !== false && sessionMadeChanges) {
    evidence = verificationEvidence(state.commands || [], cfg);
    if (evidence.ran.length === 0) problems.push(describeMissingEvidence(evidence.looked, results.every((r) => r.ok)));
  }
  const evidenceProblemAdded = problems.length > postCommandProblems;

  // 3c. Test-count ratchet (card test-count-ratchet): its own kind of problem, not a failed command.
  const counted = countCheck(dir, cfg, state, input, ranGreen);
  problems.push(...counted.problems);
  const countProblemAdded = counted.problems.length > 0;

  state.lastGate = { ok: problems.length === 0, at: Date.now(), results, scope, evidence, ...(subagent ? { subagent } : {}), ...(skipVerification ? { skipped: "no-agent-changes" } : {}) };
  // card stop-gate-process-storm, case 2: a green gate records the tree it just verified, so a later
  // Stop/SubagentStop whose tree still matches can skip re-running these commands (the sameTree check
  // above). A red gate never reaches here, so it records nothing (goal 2). Never on a no-agent-changes skip
  // (card stop-gate-read-only-subagent-skip): nothing was actually verified.
  state.lastRed = null; // card stop-gate-no-change-restop: re-set at the final block below when it qualifies
  if (problems.length === 0 && !skipVerification) state.verified = verifiedCandidate;
  if (problems.length === 0 && !skipVerification) writeLastGreen(dir, counted.parsed); // empty when nothing really ran
  if (problems.length === 0 && subagent) {
    // A subagent's green gate: its counter resets; the checkpoint, if any, belongs to the session's own Stop.
    state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: 0 };
    saveState(dir, input.session_id, state);
    // card stop-gate-read-only-subagent-skip: the "no-agent-changes" reason folds into this exit's own
    // decision-tagged trace line (D1) rather than a second one being written.
    return allowReleasing(skipVerification ? "no-agent-changes" : null);
  }
  if (problems.length === 0) {
    state.stopBlocks = 0;
    // 4. Checkpoint on green (off unless checkpoint.enabled): record the working tree now that the
    // gate passed with changes present, so a later regression can be undone with git.
    const ck = checkpoint({ dir, cfg, changed, gateResults: results });
    const silent = ck.skipped === "disabled" || ck.skipped === "no changes";
    if (!silent) state.lastCheckpoint = { ...ck, at: Date.now() };
    const notice = contextNotice(dir, cfg, state, input.session_id, "verification");
    saveState(dir, input.session_id, state);
    if (notice) return systemMessageReleasing(silent ? notice : `${describeCheckpoint(ck)}\n\n${notice}`);
    return silent ? allowReleasing() : systemMessageReleasing(describeCheckpoint(ck));
  }

  // Tests red by design (design points 1-4, card subagent-stop-gate-tester-red): a SubagentStop whose
  // last_assistant_message, or (card tester-claim-missed-in-handback, pass 2, when the plain text carries
  // no claim) whose transcript's last SubagentHandback call, carries a tests_red_by_design claim lets the
  // tester stop once instead of being blocked and retrying the suite, but only when every problem so far
  // comes from a failed verification command (no protected-path, scope, or evidence problem) and the claim
  // exactly accounts for the test files those commands' output names. The plain-text claim always wins
  // when it is present and valid; the hand-back is read only as a fallback. Never on the main Stop (point
  // 4): gated on `subagent`, which is null there. Never throws: any failure here falls through to the
  // ordinary block below, unevaluated.
  if (subagent && problems.length > 0) {
    try {
      const claimFiles = redByDesignClaim(input.last_assistant_message) ?? redByDesignClaim(lastHandbackMessage(input.agent_transcript_path));
      if (claimFiles) {
        // Fix pass MAJOR (T11): the claim is honoured only for the tester agent exactly — the same
        // claim from any other agent_type (a coder relaying it, or an unset type) still blocks, naming
        // the type seen, rather than being silently evaluated for coverage.
        if (subagent.type !== "tester") {
          problems.push(`The tests_red_by_design claim is only honoured for the tester agent; this SubagentStop's agent_type is "${subagent.type}".`);
        } else if (
          preVerificationProblems === 0 &&
          !evidenceProblemAdded &&
          !countProblemAdded &&
          commandFailures.length > 0 &&
          // R1 (pass 2 review): a command dropped for budget also adds one problem in step 3 (line ~892),
          // but is not in commandFailures — that part of the verification never ran at all, so the claim
          // cannot honestly account for it. Requiring every step-3 problem to be an accounted-for failure
          // (none of them a dropped command) closes that gap.
          postCommandProblems - preVerificationProblems === commandFailures.length
        ) {
          const coverage = redByDesignCoverage(claimFiles, commandFailures, changed, dir);
          if (coverage.covered) {
            // Same as a subagent's green gate: counter resets, no checkpoint, no turn.
            state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: 0 };
            state.lastGate = { ...state.lastGate, redByDesign: coverage.files };
            // Card stop-gate-block-ledger: the standing claim, distinct from state.lastGate above (which a
            // later gate run replaces wholesale, line ~942) — this is what a later block's classifier reads.
            state.redByDesignClaim = { files: coverage.files, at: new Date().toISOString(), agent: subagent.id };
            saveState(dir, input.session_id, state);
            // Card stop-gate-defers-while-subagent-in-flight: the "tests_red_by_design" reason (and its
            // covered-files detail) folds into this exit's own decision-tagged trace line (D1) rather than a
            // second one being written.
            return systemMessageReleasing(
              `[doug] ${who} stopped with tests red by design: ${coverage.files.join(", ")}. The coder's change is expected to turn them green; do not treat the suite as passing.`,
              "tests_red_by_design",
              { detail: coverage.files.join(", ") },
            );
          }
          if (coverage.reasonLine) problems.push(coverage.reasonLine);
        }
      }
    } catch {
      // A broken scan must never let a stop through incorrectly; fall through to the ordinary block.
    }
  }

    const blocks = blocksSoFar + 1;
    if (subagent) state.agentBlocks = { ...(state.agentBlocks || {}), [subagent.id]: blocks };
    else state.stopBlocks = blocks;
    saveState(dir, input.session_id, state);
    const reason =
      (who ? `[doug] ${who} cannot report done: verification failed (${blocks}/${maxBlocks}). Fix the following before finishing the task. ` : `[doug] Verification failed (${blocks}/${maxBlocks}). Fix the following before finishing. `) +
      `Do not claim the task is done while this fails.\n\n` +
      problems.join("\n\n");
    // card stop-gate-block-ledger, review pass 2 item 2 (MAJOR): classifyFinalBlock never throws on its own
    // (it has its own internal try/catch), but this call sits between the gate's decision to block and the
    // blockStopReleasing call that carries it out — guarded again here so nothing between them can ever fail
    // the whole gate open, whatever future change touches either side.
    let finalClass = "real";
    try {
      finalClass = classifyFinalBlock({
        preVerificationProblems,
        evidenceProblemAdded,
        commandFailures,
        postCommandProblems,
        results,
        redByDesignClaimFiles: state.redByDesignClaim && Array.isArray(state.redByDesignClaim.files) ? state.redByDesignClaim.files : null,
        changedAtStart: changed,
        dir,
        budgetDeadline,
      });
    } catch {
      finalClass = "real";
    }
    // card stop-gate-no-change-restop: record this red for reuse only when every configured command really
    // ran (not credited, none dropped for budget or timed out) and at least one failed, every failure by a
    // numeric non-zero exit (a signal kill has status null and is load-suspect). Stored with the block's ledger
    // class so a reuse logs the same class. state.lastRed was cleared above, so every other path leaves none.
    try {
      const configured = resolveCommands(cfg);
      if (
        !skipVerification &&
        !credited &&
        commandFailures.length > 0 &&
        results.length === configured.length &&
        results.every((r) => !r.timedOut && !r.skipped && (r.ok || (typeof r.status === "number" && r.status !== 0))) &&
        postCommandProblems - preVerificationProblems === commandFailures.length &&
        verifiedCandidate
      ) {
        state.lastRed = {
          fingerprint: verifiedCandidate,
          scope: subagent ? subagent.id : "main",
          commands: configured.map((c) => c.command),
          summary: problems.slice(preVerificationProblems, postCommandProblems).join("\n\n"),
          class: finalClass,
        };
        saveState(dir, input.session_id, state);
      }
    } catch {
      state.lastRed = null;
    }
    logBlock(reason, finalClass);
    return blockStopReleasing(reason);
  };

  return runVerification();
});
