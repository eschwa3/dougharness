// Real cost of one doug-implement run, from the local Claude Code transcripts (decision 0005, card cost-per-run).
// No network: the run's agent ids come from its journal under ~/.claude/projects/<slug>/<session>/subagents/workflows/<run>/,
// each agent's tokens are summed from its transcript there, and the price comes from the table below.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// USD per million tokens, first-party Claude API list prices. Cache reads are 0.1x input (0.025x on Fable 5.1,
// 0.05x on Opus 5.5); cache writes are 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL. Opus 5.5:
// input 4, output 20, cacheRead 0.2, cacheWrite5m 5, cacheWrite1h 8; source
// https://platform.claude.com/docs/en/about-claude/pricing, fetched 2026-09-23. Update the date with the table.
export const PRICES_DATED = "2026-09-23";
export const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

// Card adversary-usage-in-report (decision 0007 follow-up): Codex's own tokens, from a workflow report's relayed
// ReviewResult.usage/durationMs (agents/adversary.md, doug-implement.js), priced separately from the Claude table
// above because they are a different vendor's tokens on a different model. USD per million tokens, short-context,
// uncached rates. Source: https://developers.openai.com/api/docs/pricing (fetched 2026-09-19; the page shows no
// last-updated date, so CODEX_PRICES_DATED is the fetch date). unverified: that the Codex CLI slug (e.g.
// "gpt-5.6-sol") is literally the API model id used by that pricing page - no documented mapping was found;
// unverified: the short/long context threshold for these rows, so a review's call is assumed short; unverified: no
// cached-input split exists in ReviewResult.usage, so all input is priced at the uncached rate, an upper bound.
export const CODEX_PRICES_DATED = "2026-09-19";
export const CODEX_PRICES = {
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-6-astra": { input: 10, output: 50 },
};
// ReviewResult.model (packages/doug-codex/src/schema.ts) is null unless codex-review was run with --model, which
// the workflow's command never passes, so the model a review actually ran on is not itself in the report; this is
// the assumption the printed Codex line names: the price assumes the Codex CLI's configured default model, gpt-5.6-sol.
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

// "claude-haiku-4-5-20251001" and "claude-opus-5[1m]" price as "claude-haiku-4-5" and "claude-opus-5".
export function normalizeModel(model) {
  return String(model || "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

function addUsage(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
}

// Price one usage record for a model; null when the model is not in the table.
export function priceUsage(usage, model) {
  const p = PRICES[normalizeModel(model)];
  if (!p) return null;
  const write5m = Math.max(0, usage.cacheWrite - usage.cacheWrite1h);
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + write5m * p.cacheWrite5m + usage.cacheWrite1h * p.cacheWrite1h) / 1e6;
}

// The transcript writes one line per content block of an API response, each carrying that response's usage (and
// the early blocks a partial output count), so usage is taken once per message id, the largest value seen per field.
export function transcriptUsage(file) {
  const perMessage = new Map();
  const models = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
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
    const cur = perMessage.get(id) || { ...emptyUsage(), model: m.model || null };
    cur.input = Math.max(cur.input, u.input_tokens || 0);
    cur.output = Math.max(cur.output, u.output_tokens || 0);
    cur.cacheRead = Math.max(cur.cacheRead, u.cache_read_input_tokens || 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, u.cache_creation_input_tokens || 0);
    cur.cacheWrite1h = Math.max(cur.cacheWrite1h, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
    if (m.model) cur.model = m.model;
    perMessage.set(id, cur);
  }
  const usage = emptyUsage();
  for (const v of perMessage.values()) {
    addUsage(usage, v);
    models.set(v.model, (models.get(v.model) || 0) + 1);
  }
  // The agent's model is the one most of its messages ran on (a transcript names one model in practice).
  const model = [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || null;
  return { usage, model, messages: perMessage.size };
}

// The workflow's label for an agent: `stage:task[:pass]` (`integrate:level-0`, `fix:agents-generator:2`). A swarm's
// workers are `worker:task:n` (card swarm-lead): the trailing number is the worker, not a pass, so it is returned as
// `worker` and the agent still groups under its task.
export function parseLabel(label) {
  const parts = String(label || "").split(":");
  const stage = parts[0] || null;
  let pass = null;
  let worker = null;
  if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) {
    const n = Number(parts.pop());
    if (stage === "worker") worker = n;
    else pass = n;
  }
  const task = parts.slice(1).join(":") || null;
  return stage === "worker" ? { stage, task, pass, worker } : { stage, task, pass };
}

export function projectSlug(projectDir) {
  return String(projectDir).replace(/[^A-Za-z0-9]/g, "-");
}

// Locate a run's journal directory: the project's own slug first, then every other project under ~/.claude/projects.
export function findRunDir({ runId, claudeDir = join(homedir(), ".claude"), projectDir = process.cwd() }) {
  const projects = join(claudeDir, "projects");
  if (!existsSync(projects)) return null;
  const slug = projectSlug(projectDir);
  const order = [slug, ...readdirSync(projects).filter((d) => d !== slug)];
  for (const proj of order) {
    const projDir = join(projects, proj);
    if (!existsSync(projDir)) continue;
    let sessions;
    try {
      sessions = readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const dir = join(projDir, session, "subagents", "workflows", runId);
      if (existsSync(join(dir, "journal.jsonl"))) return { dir, session, project: proj, runFile: join(projDir, session, "workflows", `${runId}.json`) };
    }
  }
  return null;
}

function readJournal(dir) {
  const agents = new Map();
  for (const line of readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.agentId) continue;
    const a = agents.get(o.agentId) || { agentId: o.agentId, taskId: null };
    if (o.type === "result" && o.result && typeof o.result.taskId === "string") a.taskId = o.result.taskId;
    agents.set(o.agentId, a);
  }
  return [...agents.values()];
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Card adversary-usage-in-report: walks a workflow report's levels (produced by doug-implement.js: each task's
// `adversary` and each level's `levelAdversary` carry usage/durationMs copied from ReviewResult) and sums the
// entries that actually carry Codex usage. `reviews` counts only entries with a real {inputTokens, outputTokens}
// object; `unpriced` counts an entry that ran and is not a fallback but carries no usage (codex-review printed
// none, or the relay predates this card) - never estimated, only counted.
export function codexUsageFromReport(report) {
  let reviews = 0;
  let input = 0;
  let output = 0;
  let durationMs = 0;
  let unpriced = 0;
  const consider = (adv) => {
    if (!adv) return;
    const usage = adv.usage;
    if (usage && typeof usage === "object" && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
      reviews++;
      input += usage.inputTokens;
      output += usage.outputTokens;
      if (typeof adv.durationMs === "number") durationMs += adv.durationMs;
    } else if (adv.ran && !adv.fallback) {
      unpriced++;
    }
  };
  for (const level of (report && report.levels) || []) {
    for (const t of level.tasks || []) consider(t.adversary);
    consider(level.levelAdversary);
  }
  return { reviews, input, output, durationMs, unpriced };
}

// Prices a codexUsageFromReport() result at a CODEX_PRICES row; null when the model is not in the table (never
// estimated).
export function priceCodexUsage(codexUsage, model = CODEX_DEFAULT_MODEL) {
  const p = CODEX_PRICES[model];
  if (!p) return null;
  return (codexUsage.input * p.input + codexUsage.output * p.output) / 1e6;
}

const CODEX_RELAY = "doug-flow:adversary";

// Sum and price every agent of one run. Throws when the run cannot be found; an agent without a transcript or on
// an unpriced model is reported in `notes`, never estimated.
// `report` (card adversary-usage-in-report): a parsed workflow report, or null/omitted. When given and it carries
// any Codex usage, the result's `codex` key prices it (see codexUsageFromReport/priceCodexUsage) and the relay note
// below is dropped, since the priced Codex line supersedes it; otherwise codex is null and the note is unchanged.
// `reportPath` is carried through into `codex.reportPath` only for display (renderCost); it is never read here.
export function costRun({ runId, claudeDir, projectDir, report, reportPath } = {}) {
  if (!runId) throw new Error("a run id is required (wf_...)");
  const found = findRunDir({ runId, claudeDir, projectDir });
  if (!found) throw new Error(`no journal for run ${runId} under ${join(claudeDir || join(homedir(), ".claude"), "projects")}`);
  const { dir, session, project, runFile } = found;
  const run = readJson(runFile);
  const labels = new Map();
  for (const p of (run && run.workflowProgress) || []) if (p.type === "workflow_agent" && p.agentId) labels.set(p.agentId, p);
  const notes = [];
  const agents = [];
  let codexRelays = 0;
  for (const j of readJournal(dir)) {
    const meta = readJson(join(dir, `agent-${j.agentId}.meta.json`)) || {};
    const progress = labels.get(j.agentId);
    const parsed = progress ? parseLabel(progress.label) : { stage: (meta.agentType || "").replace(/^doug-flow:/, "") || null, task: j.taskId, pass: null };
    const agent = {
      agentId: j.agentId,
      label: progress ? progress.label : null,
      stage: parsed.stage,
      task: parsed.task || j.taskId,
      pass: parsed.pass,
      agentType: meta.agentType || null,
      model: null,
      messages: 0,
      usage: emptyUsage(),
      usd: null,
      transcript: false,
    };
    const file = join(dir, `agent-${j.agentId}.jsonl`);
    if (existsSync(file)) {
      const t = transcriptUsage(file);
      agent.transcript = true;
      agent.model = t.model;
      agent.messages = t.messages;
      agent.usage = t.usage;
      agent.usd = t.model ? priceUsage(t.usage, t.model) : null;
      if (t.model && agent.usd === null) notes.push(`${j.agentId} (${agent.label || agent.stage}): model ${t.model} is not in the price table; not priced`);
      if (!t.model && t.messages === 0) notes.push(`${j.agentId} (${agent.label || agent.stage}): transcript has no usage lines; not priced`);
    } else {
      notes.push(`${j.agentId} (${agent.label || agent.stage}): no transcript file; not priced`);
    }
    if (meta.agentType === CODEX_RELAY) codexRelays++;
    agents.push(agent);
  }
  if (codexRelays) notes.push(`${codexRelays} adversary agent${codexRelays === 1 ? "" : "s"} relayed codex-review; Codex's own tokens are not in local transcripts and are not priced`);
  let codex = null;
  if (report) {
    const codexUsage = codexUsageFromReport(report);
    if (codexUsage.reviews > 0) {
      codex = {
        model: CODEX_DEFAULT_MODEL,
        reviews: codexUsage.reviews,
        input: codexUsage.input,
        output: codexUsage.output,
        durationMs: codexUsage.durationMs,
        usd: priceCodexUsage(codexUsage, CODEX_DEFAULT_MODEL),
        unpriced: codexUsage.unpriced,
        pricesDated: CODEX_PRICES_DATED,
        reportPath: reportPath || null,
      };
      const relayNoteIdx = notes.findIndex((n) => /relayed codex-review/.test(n));
      if (relayNoteIdx !== -1) notes.splice(relayNoteIdx, 1);
    }
  }
  const group = (key) => {
    const out = new Map();
    for (const a of agents) {
      const k = key(a) || "(unknown)";
      const g = out.get(k) || { agents: 0, usage: emptyUsage(), usd: 0, unpriced: 0 };
      g.agents++;
      addUsage(g.usage, a.usage);
      if (a.usd === null) g.unpriced++;
      else g.usd += a.usd;
      out.set(k, g);
    }
    return [...out.entries()].map(([name, g]) => ({ name, ...g }));
  };
  const total = { agents: agents.length, usage: emptyUsage(), usd: 0, unpriced: 0 };
  for (const a of agents) {
    addUsage(total.usage, a.usage);
    if (a.usd === null) total.unpriced++;
    else total.usd += a.usd;
  }
  return {
    runId,
    session,
    project,
    dir,
    startedAt: run && run.timestamp ? run.timestamp : null,
    durationMs: run && typeof run.durationMs === "number" ? run.durationMs : null,
    pricesDated: PRICES_DATED,
    agents,
    tasks: group((a) => a.task),
    stages: group((a) => a.stage),
    total,
    codex,
    notes,
  };
}

// A batch run's cost split per card (card parallel-cards): every agent whose task is one of a card's plan tasks
// counts for that card; the shared stages (integrate, the level adversary: task `level-<n>`) are listed once as
// `shared`; agents on no card's task are `other`. Nothing estimated: unpriced agents are counted, not summed.
export function costByCard(result, plan) {
  if (!plan || !Array.isArray(plan.cards) || !plan.cards.length) throw new Error("the plan has no cards; costByCard splits a batch plan's run (plan.mjs merge)");
  const cardOf = new Map((plan.tasks || []).filter((t) => t && typeof t.card === "string").map((t) => [t.id, t.card]));
  const bucket = () => ({ agents: 0, usd: 0, unpriced: 0 });
  const add = (b, a) => {
    b.agents++;
    if (a.usd === null || a.usd === undefined) b.unpriced++;
    else b.usd += a.usd;
  };
  const cards = plan.cards.map((card) => ({ card, ...bucket(), tasks: [...cardOf.entries()].filter(([, c]) => c === card).map(([id]) => id) }));
  const shared = { ...bucket(), labels: [] };
  const other = { ...bucket(), labels: [] };
  for (const a of result.agents || []) {
    const card = cardOf.get(a.task);
    if (card) add(cards.find((c) => c.card === card), a);
    else if (/^level-\d+$/.test(String(a.task || ""))) {
      add(shared, a);
      shared.labels.push(a.label || a.agentId);
    } else {
      add(other, a);
      other.labels.push(a.label || a.agentId);
    }
  }
  return { cards, shared, other };
}

export function renderCostByCard(byCard) {
  const lines = ["| Per card | Agents | USD |", "|---|---|---|"];
  const usd = (b) => `${fmtUsd(b.usd)}${b.unpriced ? ` (${b.unpriced} unpriced)` : ""}`;
  for (const c of byCard.cards) lines.push(`| ${c.card} | ${c.agents} | ${usd(c)} |`);
  lines.push(`| shared integration agents${byCard.shared.labels.length ? ` (${byCard.shared.labels.join(", ")})` : ""} | ${byCard.shared.agents} | ${usd(byCard.shared)} |`);
  if (byCard.other.agents) lines.push(`| on no card's task (${byCard.other.labels.join(", ")}) | ${byCard.other.agents} | ${usd(byCard.other)} |`);
  return lines.join("\n") + "\n";
}

const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const fmtUsd = (n) => (n === null ? "unpriced" : `$${n.toFixed(2)}`);

export function renderCost(result) {
  const lines = [];
  const when = result.startedAt ? `, ${result.startedAt}` : "";
  const dur = result.durationMs !== null ? `, ${Math.round(result.durationMs / 60000)} min` : "";
  lines.push(`Run ${result.runId}: ${result.agents.length} agent${result.agents.length === 1 ? "" : "s"} in session ${result.session}${when}${dur}.`);
  lines.push("");
  lines.push("| Agent | Stage | Task | Pass | Model | Input | Output | Cache read | Cache write | USD |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const a of result.agents) {
    lines.push(`| ${a.agentId} | ${a.stage || "?"} | ${a.task || "?"} | ${a.pass === null ? "" : a.pass} | ${a.model ? normalizeModel(a.model) : "?"} | ${fmtInt(a.usage.input)} | ${fmtInt(a.usage.output)} | ${fmtInt(a.usage.cacheRead)} | ${fmtInt(a.usage.cacheWrite)} | ${fmtUsd(a.usd)} |`);
  }
  for (const [title, rows] of [["Per task", result.tasks], ["Per stage", result.stages]]) {
    lines.push("");
    lines.push(`| ${title} | Agents | Input | Output | Cache read | Cache write | USD |`);
    lines.push("|---|---|---|---|---|---|---|");
    for (const g of rows) lines.push(`| ${g.name} | ${g.agents} | ${fmtInt(g.usage.input)} | ${fmtInt(g.usage.output)} | ${fmtInt(g.usage.cacheRead)} | ${fmtInt(g.usage.cacheWrite)} | ${fmtUsd(g.usd)}${g.unpriced ? ` (${g.unpriced} unpriced)` : ""} |`);
  }
  const t = result.total;
  lines.push("");
  lines.push(`Run total: ${fmtInt(t.usage.input)} input, ${fmtInt(t.usage.output)} output, ${fmtInt(t.usage.cacheRead)} cache read, ${fmtInt(t.usage.cacheWrite)} cache write tokens; ${fmtUsd(t.usd)}${t.unpriced ? ` for ${t.agents - t.unpriced} of ${t.agents} agents (${t.unpriced} unpriced)` : ""} at list prices dated ${result.pricesDated}.`);
  if (result.codex) {
    const c = result.codex;
    const secs = Math.round(c.durationMs / 1000);
    const from = c.reportPath ? ` (from ${c.reportPath})` : "";
    const unpriced = c.unpriced ? ` (${c.unpriced} review(s) printed no usage)` : "";
    lines.push(`Codex: ${c.reviews} review(s), ${fmtInt(c.input)} input, ${fmtInt(c.output)} output tokens in ${secs} s; ${fmtUsd(c.usd)} at ${c.model} list price dated ${c.pricesDated}${from}; not included in the run total.${unpriced}`);
  }
  for (const n of result.notes) lines.push(`Note: ${n}.`);
  return lines.join("\n") + "\n";
}

