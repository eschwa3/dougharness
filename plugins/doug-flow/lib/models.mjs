// Model tiers: which model and effort does which work. Defined by the user in CLAUDE.md under a
// "## Models" heading as a table, parsed here deterministically, and resolved into the plan JSON by
// `plan.mjs json` so the workflow (which cannot read files) receives explicit values per task.
//
//   ## Models
//
//   | Work       | Model   | Effort |
//   |------------|---------|--------|
//   | plan       | opus    | high   |     <- the planner agent and the research step's researchers
//   | lead       | inherit | high   |
//   | worker     | sonnet  | medium |     <- a swarm's workers; the lead row is its lead
//   | implement  | sonnet  | medium |
//   | verify     | inherit | high   |
//   | cheap      | haiku   | low    |     <- any other row is a named tier a task can reference with "tier"
//
// Model: "inherit" (the session's model), an alias (opus, sonnet, haiku, fable), or a full model id.
// The adversary row may say "codex": the adversarial review runs on Codex through codex-review, and the
// workflow runs the Claude agent that launches it on haiku; that row's effort is that relay agent's.
// Effort: inherit | low | medium | high | xhigh | max. "inherit" means the workflow's own default for that role.
// Precedence for an implementer: task.model/effort > task.tier row > implement row > inherit.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// `plan` is the row the planner agent and the research step's researchers run on (card doug-next-lead-only).
// `worker` is the row a swarm's workers run on (card swarm-lead); the lead row is the swarm's lead.
export const ROLES = ["plan", "lead", "worker", "implement", "verify", "review", "adversary", "integrate"];
export const EFFORTS = ["inherit", "low", "medium", "high", "xhigh", "max"];
export const MODELS_HEADING = /^##\s+models\s*$/i;

export function isModelName(s) {
  return typeof s === "string" && /^[a-z][a-z0-9.:_-]{0,79}$/.test(s);
}

/** Parses the "## Models" table out of CLAUDE.md text. Returns { roles, tiers, errors, present }. */
export function parseModelsSection(markdown) {
  const out = { roles: {}, tiers: {}, errors: [], present: false };
  if (typeof markdown !== "string") return out;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => MODELS_HEADING.test(l.trim()));
  if (start < 0) return out;
  out.present = true;
  let rows = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break; // next section
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
    if (rows === 0 && /^work$/i.test(cells[0]) && /^model$/i.test(cells[1])) {
      rows++;
      continue; // header row
    }
    rows++;
    const work = cells[0].toLowerCase().replace(/`/g, "");
    const model = (cells[1] || "inherit").toLowerCase().replace(/`/g, "") || "inherit";
    const effort = (cells[2] || "inherit").toLowerCase().replace(/`/g, "") || "inherit";
    const where = `CLAUDE.md Models row "${cells[0]}"`;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(work)) {
      out.errors.push(`${where}: work name must be a role (${ROLES.join(", ")}) or a kebab-case tier name`);
      continue;
    }
    if (!isModelName(model)) {
      out.errors.push(`${where}: model "${cells[1]}" must be "inherit", an alias, or a model id`);
      continue;
    }
    if (model === "codex" && work !== "adversary") {
      out.errors.push(`${where}: "codex" is only valid on the adversary row; it names the adversarial reviewer (codex-review), not a Claude model`);
      continue;
    }
    if (!EFFORTS.includes(effort)) {
      out.errors.push(`${where}: effort "${cells[2]}" must be one of ${EFFORTS.join(", ")}`);
      continue;
    }
    const entry = { model, effort };
    if (ROLES.includes(work)) {
      if (out.roles[work]) out.errors.push(`${where}: role "${work}" is defined twice`);
      out.roles[work] = entry;
    } else {
      if (out.tiers[work]) out.errors.push(`${where}: tier "${work}" is defined twice`);
      out.tiers[work] = entry;
    }
  }
  return out;
}

/** Reads <dir>/CLAUDE.md and parses its Models section. Absent file or section yields an empty definition. */
export function loadModels(dir) {
  const file = join(dir, "CLAUDE.md");
  if (!existsSync(file)) return { roles: {}, tiers: {}, errors: [], present: false, source: null };
  return { ...parseModelsSection(readFileSync(file, "utf8")), source: "CLAUDE.md" };
}

const INHERIT = Object.freeze({ model: "inherit", effort: "inherit" });

/** Errors for task model fields and tier references. Empty when valid. */
export function validateModelRefs(plan, models) {
  const errors = [];
  if (!plan || !Array.isArray(plan.tasks)) return errors;
  for (const [i, t] of plan.tasks.entries()) {
    if (!t || typeof t !== "object") continue;
    const where = `tasks[${i}]`;
    if (t.model !== undefined && !isModelName(String(t.model).toLowerCase())) errors.push(`${where}.model must be "inherit", an alias, or a model id`);
    if (t.model !== undefined && String(t.model).toLowerCase() === "codex") errors.push(`${where}.model cannot be "codex"; Codex is the adversarial reviewer, not an implementer`);
    if (t.effort !== undefined && !EFFORTS.includes(String(t.effort).toLowerCase())) errors.push(`${where}.effort must be one of ${EFFORTS.join(", ")}`);
    if (t.tier !== undefined) {
      if (typeof t.tier !== "string" || !t.tier.trim()) errors.push(`${where}.tier must be a tier name from the CLAUDE.md Models table`);
      else if (models && !models.tiers[t.tier.toLowerCase()] && !models.roles[t.tier.toLowerCase()]) {
        const known = [...Object.keys(models.tiers), ...Object.keys(models.roles)];
        errors.push(`${where}.tier "${t.tier}" is not defined in the CLAUDE.md Models table${known.length ? ` (known: ${known.join(", ")})` : " (no table found)"}`);
      }
    }
  }
  return errors;
}

/**
 * Returns a copy of the plan with `models` (per-role settings) and every task's `model` and `effort`
 * resolved to explicit values. "inherit" is kept as a literal so the workflow can map it to its defaults.
 */
export function resolvePlanModels(plan, models) {
  const m = models || { roles: {}, tiers: {}, source: null };
  const roles = {};
  for (const r of ROLES) roles[r] = { ...INHERIT, ...(m.roles[r] || {}) };
  const tasks = (plan.tasks || []).map((t) => {
    const tierName = typeof t.tier === "string" ? t.tier.toLowerCase() : null;
    const tier = tierName ? m.tiers[tierName] || m.roles[tierName] || null : null;
    const base = tier || roles.implement;
    return {
      ...t,
      model: (t.model !== undefined ? String(t.model).toLowerCase() : base.model) || "inherit",
      effort: (t.effort !== undefined ? String(t.effort).toLowerCase() : base.effort) || "inherit",
    };
  });
  return { ...plan, models: { roles, tiers: { ...m.tiers }, source: m.source || null }, tasks };
}

/** One line per role and tier, for `plan show`. */
export function renderModels(models) {
  const lines = [];
  const roles = models && models.roles ? models.roles : {};
  const tiers = models && models.tiers ? models.tiers : {};
  const fmt = (e) => `${e.model}${e.effort && e.effort !== "inherit" ? ` / ${e.effort}` : ""}`;
  for (const r of ROLES) if (roles[r] && (roles[r].model !== "inherit" || roles[r].effort !== "inherit")) lines.push(`  ${r}: ${fmt(roles[r])}`);
  for (const [name, e] of Object.entries(tiers)) lines.push(`  tier ${name}: ${fmt(e)}`);
  return lines.length ? lines : ["  (all roles inherit the session model)"];
}
