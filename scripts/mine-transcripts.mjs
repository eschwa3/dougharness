#!/usr/bin/env node
// Card usage-path-transcript-mining: mine local Claude Code workflow transcripts for per-seat wall time, re-runs and
// wasted agents. Node builtins only; no network, no model, no default to the real ~/.claude (--projects is required).
//   node scripts/mine-transcripts.mjs --projects <dir> --board <board.json> [--top <n>] [--json]
// <dir> is one project folder, e.g. ~/.claude/projects/-Users-me-proj, holding <session>/subagents/workflows/<runId>/
// (journal.jsonl, agent-<id>.jsonl) and <session>/workflows/<runId>.json (the run file).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLabel } from "../plugins/doug-flow/lib/cost.mjs";

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readLines(p) {
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a malformed line is skipped, never thrown
    }
  }
  return rows;
}

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// First-to-last "timestamp" in an agent transcript, in ms; null when fewer than two readable stamps.
function transcriptSpan(file) {
  const times = readLines(file).map((r) => Date.parse(r?.timestamp)).filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function stat(values) {
  return { n: values.length, totalMs: values.reduce((a, b) => a + b, 0), medianMs: median(values) };
}

function boardSizes(boardPath) {
  const board = boardPath ? readJson(boardPath) : null;
  const sizes = new Map();
  for (const c of Array.isArray(board?.cards) ? board.cards : []) if (c?.id) sizes.set(c.id, c.size);
  return sizes;
}

export function mineTranscripts({ projectsDir, boardPath, top = 10 } = {}) {
  const sizes = boardSizes(boardPath);
  const reruns = { resumed: [], fixPasses: [], failed: [] };
  const nullAgents = [];
  const inFlight = [];
  const unused = [];
  const walls = []; // { runId, label, agentId, ms }

  for (const session of dirs(projectsDir)) {
    const wfRoot = join(projectsDir, session, "subagents", "workflows");
    for (const runId of dirs(wfRoot)) {
      const runDir = join(wfRoot, runId);
      const journal = readLines(join(runDir, "journal.jsonl"));
      const runFile = readJson(join(projectsDir, session, "workflows", `${runId}.json`));
      const progress = new Map();
      for (const e of Array.isArray(runFile?.workflowProgress) ? runFile.workflowProgress : []) {
        if (e?.type === "workflow_agent" && e.agentId) progress.set(e.agentId, e);
      }

      // A run is live when it has no run file yet or its status is not a finished one.
      const runLive = !runFile || !["completed", "killed", "failed"].includes(runFile.status);
      const started = []; // journal order
      const byId = new Map();
      const ended = new Map(); // agentId -> "result" | "failed"
      const results = new Map();
      for (const row of journal) {
        if (row?.type === "started" && row.agentId) {
          const a = { agentId: row.agentId, label: row.label ?? progress.get(row.agentId)?.label ?? null };
          started.push(a);
          byId.set(a.agentId, a);
        } else if (row?.type === "result" && row.agentId) {
          ended.set(row.agentId, "result");
          results.set(row.agentId, row.result);
        } else if (row?.type === "failed" && row.agentId) {
          ended.set(row.agentId, "failed");
          reruns.failed.push({ runId, label: byId.get(row.agentId)?.label ?? null, agentId: row.agentId });
        }
      }

      // Re-runs by resume: a label started more than once in one journal; earlier agents are superseded.
      const byLabel = new Map();
      for (const a of started) {
        if (!a.label) continue;
        if (!byLabel.has(a.label)) byLabel.set(a.label, []);
        byLabel.get(a.label).push(a.agentId);
      }
      for (const [label, ids] of byLabel) {
        if (ids.length < 2) continue;
        reruns.resumed.push({ runId, label, agentIds: ids });
        for (const id of ids.slice(0, -1)) unused.push({ runId, label, agentId: id, why: "superseded" });
      }

      for (const a of started) {
        // Fix passes: round or pass above 1.
        const p = parseLabel(a.label);
        if (p.stage && p.pass != null && p.pass > 1) reruns.fixPasses.push({ label: a.label, seat: p.stage, round: p.pass });
        // Null and in-flight agents.
        if (!ended.has(a.agentId)) {
          const rec = { runId, label: a.label, agentId: a.agentId };
          if (runLive && progress.get(a.agentId)?.state !== "error") inFlight.push(rec);
          else nullAgents.push(rec);
        } else if (p.task && ended.get(a.agentId) === "result" && typeof results.get(a.agentId) === "string") {
          unused.push({ runId, label: a.label, agentId: a.agentId, why: "string-result" });
        }
      }

      // Wall time: run-file durationMs, replays (cached) add nothing, transcript span as the fallback.
      const agentsSeen = new Map(started.map((a) => [a.agentId, a.label]));
      for (const [id, e] of progress) if (!agentsSeen.has(id)) agentsSeen.set(id, e.label ?? null);
      for (const [agentId, label] of agentsSeen) {
        const e = progress.get(agentId);
        if (e?.cached) continue;
        let ms = typeof e?.durationMs === "number" ? e.durationMs : null;
        if (ms == null) ms = transcriptSpan(join(runDir, `agent-${agentId}.jsonl`));
        if (ms == null || !label) continue;
        walls.push({ runId, label, agentId, ms });
      }
    }
  }

  const bySeat = new Map();
  const bySeatSize = new Map();
  for (const w of walls) {
    const { stage, task } = parseLabel(w.label);
    if (!stage) continue;
    if (!bySeat.has(stage)) bySeat.set(stage, []);
    bySeat.get(stage).push(w.ms);
    const size = sizes.get(task) ?? "?";
    if (!bySeatSize.has(stage)) bySeatSize.set(stage, new Map());
    const sm = bySeatSize.get(stage);
    if (!sm.has(size)) sm.set(size, []);
    sm.get(size).push(w.ms);
  }
  const wallBySeat = {};
  const wallBySeatSize = {};
  for (const [seat, v] of bySeat) wallBySeat[seat] = stat(v);
  for (const [seat, m] of bySeatSize) {
    wallBySeatSize[seat] = {};
    for (const [size, v] of m) wallBySeatSize[seat][size] = stat(v);
  }
  const slowest = [...walls].sort((a, b) => b.ms - a.ms).slice(0, Math.max(0, top));
  return { wallBySeat, wallBySeatSize, reruns, nullAgents, inFlight, unused, slowest };
}

const min = (ms) => (ms / 60000).toFixed(1);

function format(r) {
  const out = ["Per-seat wall time (minutes):"];
  for (const [seat, s] of Object.entries(r.wallBySeat).sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    const sizes = Object.entries(r.wallBySeatSize[seat] ?? {}).map(([k, v]) => `${k} ${min(v.medianMs)} (n=${v.n})`).join(", ");
    out.push(`  ${seat}: n=${s.n} median ${min(s.medianMs)} total ${min(s.totalMs)}; by size ${sizes}`);
  }
  out.push(`Re-runs: ${r.reruns.resumed.length} resumed labels, ${r.reruns.fixPasses.length} fix passes, ${r.reruns.failed.length} failed agents`);
  out.push(`Null agents: ${r.nullAgents.length}; in flight: ${r.inFlight.length}; unused: ${r.unused.length}`);
  out.push("Slowest steps:");
  for (const s of r.slowest) out.push(`  ${min(s.ms)} min  ${s.label}  (${s.runId} ${s.agentId})`);
  return out.join("\n");
}

function main(argv) {
  let projects = null;
  let board = null;
  let top = 10;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--projects") projects = argv[++i];
    else if (argv[i] === "--board") board = argv[++i];
    else if (argv[i] === "--top") top = Number(argv[++i]);
    else if (argv[i] === "--json") json = true;
    else {
      console.error(`mine-transcripts: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  if (!projects || !existsSync(projects) || !Number.isInteger(top) || top < 0) {
    console.error("usage: mine-transcripts.mjs --projects <dir> [--board <board.json>] [--top <n>] [--json]");
    return 2;
  }
  const r = mineTranscripts({ projectsDir: projects, boardPath: board, top });
  console.log(json ? JSON.stringify(r, null, 2) : format(r));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
