// The pure and fixture-setup pieces behind scripts/rehearse.mjs (card workflow-rehearsal): estimates, argument
// parsing, the ts-basic fixture the three scenarios run in, the stream assertions a real `claude -p` session's
// stream-json output is checked against, and the recording that goes through the existing board.mjs run-report
// CLI (never lib/board.mjs directly, so a batch or a research-note promotion is never bypassed). Spawning the
// real `claude` binary (runStage) is the only side effect here that costs money; every other export is pure, or
// touches only a fixture directory the caller made. Facts this module leans on are cited in
// the card's research note.

import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { newBoard, addCard, boardPath, BOARD_RELPATH, wallCapMinutes, usdCapDollars } from "../plugins/doug-flow/lib/board.mjs";
import { commandEnv } from "../plugins/doug-flow/lib/land.mjs";
import { unwrapReport } from "../plugins/doug-flow/lib/plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const PLUGIN_DIR = join(ROOT, "plugins/doug-flow");
export const PLAN_MJS = join(PLUGIN_DIR, "scripts/plan.mjs");
export const BOARD_MJS = join(PLUGIN_DIR, "scripts/board.mjs");
export const MEMORY_MJS = join(PLUGIN_DIR, "scripts/memory.mjs");
export const LEARN_MJS = join(PLUGIN_DIR, "scripts/learn.mjs");
export const CLI = join(ROOT, "packages/doug-cli/dist/bin.js");
export const FIXTURE_DIR = join(ROOT, "evals/fixtures/ts-basic");
export const TASKS_FILE = join(ROOT, "evals/tasks/ts-basic.json");
// Card fixture-repo-scenarios: the larger fictitious order-management fixture, its tasks file (which also carries
// the rehearsal descriptor: per-scenario cards, background cards, seeded lessons, the memory query and the decide
// proposal) and the held-out directory both fixtures share.
export const ORDERS_FIXTURE_DIR = join(ROOT, "evals/fixtures/ts-orders");
export const ORDERS_TASKS_FILE = join(ROOT, "evals/tasks/ts-orders.json");
export const HELDOUT_DIR = join(ROOT, "evals/heldout");
// Card rehearsal-harder-tier: the equipment-rental fixture the hard tier (`--tier hard`) runs on and its tasks file.
export const RENTALS_FIXTURE_DIR = join(ROOT, "evals/fixtures/ts-rentals");
export const RENTALS_TASKS_FILE = join(ROOT, "evals/tasks/ts-rentals.json");
export const FIXTURE_NAMES = ["ts-basic", "ts-orders"];
export const HELDOUT_FILE = join(ROOT, "evals/heldout/fix-hours.test.ts");
// The swarm scenario's own task and held-out test (card rehearsal-swarm-splittable): one size M plan task owning two
// source files, so the shape gate lets the lead split it.
export const SWARM_TASK_ID = "swarm-split-planned";
export const SWARM_HELDOUT_FILE = join(ROOT, "evals/heldout/swarm-split-planned.test.ts");
export const RESULTS_FILE = ".doug/.state/last-report.json";
export const STREAM_DIR = ".doug/.state/rehearsal";
export const SYNTHETIC_REPORT_RELPATH = `${STREAM_DIR}/synthetic-report.json`;

// Every child process this module spawns clears CLAUDE_PROJECT_DIR and GIT_* (plugins/doug-flow/tests/seams.test.mjs's
// precedent, itself following plugins/doug-gates/tests/git-hooks.test.mjs): scripts/plan.mjs, board.mjs, and
// memory.mjs's dirFrom() all prefer CLAUDE_PROJECT_DIR over an explicit dir argument, so a value leaked from this
// process's own environment (set by a real Claude Code session running the rehearsal skill) would silently
// redirect every plan.mjs/board.mjs spawn at the real checkout instead of the fixture or the target repository
// the caller named explicitly (card workflow-rehearsal-review, round 2: "no card fix-hours on the board"). Used
// by every spawn this module makes: plan.mjs, board.mjs, doug init, git, pnpm, and the claude session itself
// (which already needs CLAUDE_PROJECT_DIR cleared to "" for its own reasons).
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  return { ...env, ...extra };
}

// ---- Estimates (docs/live-runs.md measurements the estimate table cites), per stage ------------------------
// Each scenario's total is the sum of its own stages; a session stage's --max-budget-usd is three times ITS OWN
// stage figure, not the scenario total (item workflow-rehearsal-review #6: research gives no single number, so
// the flow and hand totals are split across their sessions in proportion to what each is expected to do, and the
// swarm total is all in its one implement session).
export const SCENARIOS = ["flow", "swarm", "hand", "auto", "parallel", "start", "start-feature", "init", "board", "memory", "decide", "swarm-skill"];
export const ESTIMATES = {
  flow: {
    // /doug-next's own first step moves the card (uncommitted working state, never a "Board: <id> moved to In
    // flow" commit) and spawns the planner before its approval gate (research §1, section 1), so there is no
    // separate /doug-plan stage to estimate: the gate stage now covers what the old $0.25 gate and $0.75 plan
    // stages did together (item rehearsal-first-live-findings #1).
    stages: { gate: 0.75, implement: 1.75 },
    source:
      "flow rehearsals on the ts-basic fixture measured $4.15/9 min (2026-09-09), $3.93/10 min (2026-09-10), $2.13/9 min (2026-09-20), and $1.97/6.9 min (gate $0.58/3.3 min, implement $1.38/3.4 min, 2026-10-09); the former gate ($0.25) and plan ($0.75) estimates merge into one gate stage since /doug-next runs the planner before its own approval gate, leaving implement as before",
  },
  swarm: {
    stages: { implement: 3.0 },
    source:
      "swarm rehearsal estimate from the two pre-shape-gate split runs on the ts-basic fixture ($4.32/12.7 min 2026-09-10, $3.86/7.3 min 2026-09-09); the scenario now runs the two-source-file task swarm-split-planned, which the shape gate (3eb9485) lets split, and its first run measured $2.32/4.9 min (implement $2.32/4.8 min, the lead split split-helpers into 2 briefs, 2026-10-09)",
  },
  hand: {
    stages: { gate: 0.5, build: 2.0 },
    source: "hand rehearsal on the ts-basic fixture measured $2.16/3.8 min (2026-09-09), measured before the tester seat and research step existed, and $1.72/3.2 min (gate $0.32/0.3 min, build $1.39/2.9 min, the first run with the tester seat and research step, 2026-10-09)",
  },
  auto: {
    stages: { gate: 0.5, build: 3.0 },
    source: "autopilot rehearsal on the ts-basic fixture measured $2.69/6.4 min (gate $0.27/0.4 min, build $2.42/6 min, 2026-10-08, card autopilot-unlimited) and $2.67 (gate 0.5 min, build 6.6 min, card autopilot-edge-case-not-decision); stage figures rounded up to cover the measured stage cost",
  },
  parallel: {
    stages: { gate: 0.5, build: 5.0 },
    source: "parallel rehearsal on the ts-basic fixture (one flow card and one hand card at once) measured $4.32/6.3 min (gate $0.28/0.3 min, build $4.04/6 min, 2026-10-13, card parallel-card-queens); a failed run the same day cost $4.65; stage figures rounded up to cover the measured stage cost",
  },
  start: {
    stages: { idea: 0.5, architecture: 1.5, skeleton: 2.0, scope: 0.7 },
    source: "project mode from an empty git repo, one session per phase (idea, architecture, skeleton, scope): the first passing live run measured $2.81/7.3 min (2026-10-11, card doug-start-skill); the per-stage figures are the card's pre-run estimates, not measured per stage, and the skeleton figure is the hand build's measured $1.39 (2026-10-09) plus init and board calls, rounded up",
  },
  "start-feature": {
    stages: { spec: 0.5, architecture: 0.7, plan: 0.7 },
    source: "feature mode on the ts-basic fixture's fix-hours card, one session per phase (spec, architecture, plan): the first passing live run measured $1.57/3.6 min (2026-10-11, card doug-start-skill); the per-stage figures are the card's pre-run estimates, not measured per stage, and the plan figure is below the flow gate's measured $0.58 (2026-10-09) plus the lead's turns",
  },
  // Card fixture-repo-scenarios: the five command paths that had no scenario. All run on ts-orders and none has
  // run live yet, so every figure is a pre-run estimate (unmeasured on ts-orders).
  init: {
    stages: {},
    source: "measured on ts-orders: doug init, doug doctor and a re-init run offline with no model call, so $0 (measured $0.00/0 min, 2026-10-22)",
  },
  board: {
    stages: {},
    source: "measured on ts-orders: the doug board commands and the served page run offline with no model call, so $0 (measured $0.00/0 min, 2026-10-22)",
  },
  memory: {
    stages: { reflect: 0.05, "model-regen": 0.05, ideas: 0.05 },
    source: "measured on ts-orders: three cheap-row `claude -p --json-schema` calls measured $0.02/0.4 min in total (2026-10-22; per-stage cost not archived, so each stage is rounded up to $0.05); recall makes no model call",
  },
  decide: {
    stages: { propose: 0.25 },
    source: "measured on ts-orders: one /doug-decide session that runs memory.mjs decision propose and reads the diff measured $0.19/0.2 min (2026-10-22), rounded up; the apply act makes no model call",
  },
  "swarm-skill": {
    stages: { gate: 1.0, run: 3.5 },
    source: "unmeasured on ts-orders: the gate session spawns the planner (the flow gate measured $0.58, 2026-10-09, rounded up for a three-file plan) and the run session is the swarm implement stage (a two-brief split measured $2.32, 2026-10-09, plus a third brief and the landing) (estimated 2026-10-22)",
  },
};

// ---- Card rehearsal-harder-tier: the hard tier's registry (`--tier hard`), beside the cheap one -------------------------
// Six scenarios on the ts-rentals fixture. SCENARIOS, ESTIMATES, FIXTURE_NAMES and SCENARIO_STAGES stay as they are;
// HARD_STAGES (below SCENARIO_STAGES) reuses each base scenario's stages with the hard turn caps, timeouts and asserts.
export const TIERS = ["hard"];
export const HARD_FIXTURE_NAMES = ["ts-rentals"];
export const HARD_BASES = ["hand", "flow", "swarm-skill", "start-feature", "auto", "parallel"];
export const HARD_SCENARIOS = HARD_BASES.map((b) => `hard-${b}`);
export const HARD_SESSION_TIMEOUT_MS = 180 * 60 * 1000;
// Every figure is the cost measured on ts-rentals in the 2026-10-25 hard sweep (card rehearsals-hard-sweep), to the cent.
export const HARD_ESTIMATES = {
  "hard-hand": {
    stages: { gate: 0.38, build: 1.8 },
    source: "measured on ts-rentals: $2.18/5.9 min (gate $0.38, build $1.80, 2026-10-25)",
  },
  "hard-flow": {
    stages: { gate: 0.94, implement: 2.14 },
    source: "measured on ts-rentals: $3.08/7.6 min (gate $0.94, implement $2.14, 2026-10-25)",
  },
  "hard-swarm-skill": {
    stages: { gate: 0.67, run: 2.79 },
    source: "measured on ts-rentals: $3.46/7.1 min (gate $0.67, run $2.79, 2026-10-25)",
  },
  "hard-start-feature": {
    stages: { spec: 0.95, architecture: 0.92, plan: 0.99 },
    source: "measured on ts-rentals: $2.87/8.5 min (spec $0.95, architecture $0.92, plan $0.99, 2026-10-25); the stages sum to $2.86 at the cent",
  },
  "hard-auto": {
    stages: { gate: 0.31, build: 15.23 },
    source: "measured on ts-rentals: the passing rerun $15.54/26.3 min (gate $0.31, build $15.23, 2026-10-25); the first, failed run cost $14.64",
  },
  "hard-parallel": {
    stages: { gate: 0.32, build: 15.0 },
    source: "measured on ts-rentals: the passing rerun $15.33/17.3 min (gate $0.32, build $15.00, 2026-10-25); the stages sum to $15.32 at the cent; the first, failed run cost $15.42",
  },
};
export function isHardScenario(name) {
  return HARD_SCENARIOS.includes(name);
}
// "auto" -> "hard-auto"; a base with no hard version ("swarm", "start", ...) -> null.
export function hardScenarioFor(base) {
  return HARD_BASES.includes(base) ? `hard-${base}` : null;
}

// A scenario's default fixture is the first of its fixtures (ts-basic for the original six, none for `start`, which
// runs on an empty repo, ts-orders for the five new ones). `--fixture ts-orders` runs the original six on the larger
// repo instead.
export function scenarioFixtures(scenario) {
  if (isHardScenario(scenario)) return ["ts-rentals"];
  if (scenario === "start") return [];
  if (["flow", "swarm", "hand", "auto", "parallel", "start-feature"].includes(scenario)) return ["ts-basic", "ts-orders"];
  return ["ts-orders"];
}

const ORDERS_SCALE = 1.5;
// Measured ts-orders figures (the 2026-10-22 full ts-orders rehearsal, 4170165) for the original
// scenarios that passed there. Stage keys equal ESTIMATES[scenario].stages keys. The rest stay scaled and unmeasured.
const ORDERS_MEASURED = {
  flow: {
    stages: { gate: 0.75, implement: 1.75 },
    source: "measured on ts-orders: $2.34/6 min (gate $0.72, implement $1.62, 2026-10-22), rounded up",
  },
  hand: {
    stages: { gate: 0.5, build: 2.0 },
    source: "measured on ts-orders: $1.96/3.6 min (gate $0.38, build $1.58, 2026-10-22), rounded up",
  },
  "start-feature": {
    stages: { spec: 0.7, architecture: 0.7, plan: 0.7 },
    source: "measured on ts-orders: $1.93/4.9 min (spec $0.63, architecture $0.64, plan $0.66, 2026-10-22), rounded up",
  },
};
// The estimate for a scenario on a fixture. The default fixture's entry is ESTIMATES[scenario] itself. A scenario run
// on ts-orders when its default is ts-basic has no measurement: its figures are the ts-basic ones scaled for a repo
// with five times the source files, and its source says so ("unmeasured on ts-orders"), never presented as measured.
export function estimateFor(scenario, fixture = null) {
  if (isHardScenario(scenario)) return HARD_ESTIMATES[scenario];
  const base = ESTIMATES[scenario];
  if (!base) throw new Error(`estimateFor: unknown scenario "${scenario}"`);
  const fixtures = scenarioFixtures(scenario);
  if (!fixture || fixture === fixtures[0] || !fixtures.includes(fixture)) return base;
  if (ORDERS_MEASURED[scenario]) return ORDERS_MEASURED[scenario];
  const stages = Object.fromEntries(Object.entries(base.stages).map(([k, v]) => [k, Math.round(v * ORDERS_SCALE * 100) / 100]));
  const total = Object.values(base.stages).reduce((a, b) => a + b, 0);
  return {
    stages,
    source: `unmeasured on ts-orders: the ts-basic figure ($${total.toFixed(2)}) scaled by ${ORDERS_SCALE} for a repo with 17 source files instead of 3 (estimated 2026-10-22); ts-basic source: ${base.source}`,
  };
}

export function scenarioTotal(scenario, fixture = null) {
  return Object.values(estimateFor(scenario, fixture).stages).reduce((a, b) => a + b, 0);
}

export function totalEstimate({ tier = null } = {}) {
  return (tier === "hard" ? HARD_SCENARIOS : SCENARIOS).reduce((sum, s) => sum + scenarioTotal(s), 0);
}

// Three times a session stage's own estimate (never the scenario total): the cap `runStage` passes as
// --max-budget-usd.
export function capFor(scenario, stageName, fixture = null) {
  const usd = estimateFor(scenario, fixture).stages[stageName];
  if (usd === undefined) throw new Error(`capFor: scenario "${scenario}" has no estimate for stage "${stageName}"`);
  return Math.round(usd * 3 * 100) / 100;
}

// With no scenario: one line per scenario (its total and source) plus the `all` total. With a scenario: its
// per-stage breakdown (card workflow-rehearsal-review #6).
export function estimateLines(scenario = null, fixture = null, { tier = null } = {}) {
  if (!scenario && tier === "hard") {
    const lines = HARD_SCENARIOS.map((s) => `  ${s.padEnd(18)} $${scenarioTotal(s).toFixed(2)}  (${HARD_ESTIMATES[s].source})`);
    lines.push(`  ${"all --tier hard".padEnd(18)} $${totalEstimate({ tier: "hard" }).toFixed(2)}  (sum of every hard scenario)`);
    return lines;
  }
  if (!scenario) {
    const lines = SCENARIOS.map((s) => `  ${s.padEnd(6)} $${scenarioTotal(s).toFixed(2)}  (${ESTIMATES[s].source})`);
    lines.push(`  ${"all".padEnd(6)} $${totalEstimate().toFixed(2)}  (sum of every scenario)`);
    return lines;
  }
  const est = estimateFor(scenario, fixture);
  const lines = [`  ${scenario} $${scenarioTotal(scenario, fixture).toFixed(2)} total  (${est.source})`];
  for (const [stage, usd] of Object.entries(est.stages)) lines.push(`    ${stage.padEnd(10)} $${usd.toFixed(2)}  (cap $${(usd * 3).toFixed(2)})`);
  return lines;
}

// ---- CLI argument parsing ------------------------------------------------------------------------------
// `rehearse.mjs <scenario|all> [--tier <name>] [--fixture <name>] [--dry-run] --card <id> --spend [dir]`. Pure: does not validate the
// scenario or fixture name or check the card exists (the caller does, before anything is spawned).
export function parseArgs(argv) {
  const positional = [];
  const opts = { spend: false, card: null, fixture: null, dryRun: false, tier: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spend") opts.spend = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--card") opts.card = argv[++i] ?? null;
    else if (a === "--fixture") opts.fixture = argv[++i] ?? null;
    else if (a === "--tier") opts.tier = argv[++i] ?? "";
    else positional.push(a);
  }
  const [scenario, dir] = positional;
  return { scenario: scenario ?? null, dir: dir ?? null, spend: opts.spend, card: opts.card, fixture: opts.fixture, dryRun: opts.dryRun, tier: opts.tier };
}

// ---- Stream assertions (research §2: the exact stream-json shapes on 2.1.266) -----------------------------
function* jsonLines(stream) {
  for (const line of String(stream || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // not a JSON line; skip
    }
  }
}

function initEvent(stream) {
  for (const j of jsonLines(stream)) if (j.type === "system" && j.subtype === "init") return j;
  return null;
}

export function pluginsLoaded(stream, names) {
  const init = initEvent(stream);
  const loaded = new Set((init && Array.isArray(init.plugins) ? init.plugins : []).map((p) => p && p.name));
  return names.every((n) => loaded.has(n));
}

export function slashCommandPresent(stream, command) {
  const init = initEvent(stream);
  return !!(init && Array.isArray(init.slash_commands) && init.slash_commands.includes(command));
}

// Every agent name from an "Agent type '<x>' not found" tool_result (research §2): a name Claude Code could not
// resolve. [] when the stream carries no such error.
export function unresolvedAgentNames(stream) {
  const names = [];
  const re = /Agent type '([^']+)' not found/;
  for (const j of jsonLines(stream)) {
    const content = j && j.type === "user" && j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) {
      if (c && c.type === "tool_result" && c.is_error && typeof c.content === "string") {
        const m = re.exec(c.content);
        if (m) names.push(m[1]);
      }
    }
  }
  return names;
}

// `total_cost_usd` from the final result line; null when the stream carries none (the session never finished).
export function sessionCost(stream) {
  let cost = null;
  for (const j of jsonLines(stream)) if (j.type === "result") cost = typeof j.total_cost_usd === "number" ? j.total_cost_usd : null;
  return cost;
}

// ---- The report a doug-implement session writes (evals/run.mjs REPORT_FILE, reportVerdict; reimplemented
// here rather than imported, since evals/ must not gain a new export for this) --------------------------------
export function readReport(dir) {
  const file = join(dir, RESULTS_FILE);
  if (!existsSync(file)) return { ok: false, reason: `no report at ${RESULTS_FILE}: the session ended before the workflow returned`, report: null };
  let report;
  try {
    report = unwrapReport(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    return { ok: false, reason: `unreadable report at ${RESULTS_FILE}: ${err.message}`, report: null };
  }
  return { ok: report && report.ok === true, reason: report && report.ok === true ? null : "report ok is not true", report };
}

function reportTasks(report) {
  return (report && Array.isArray(report.levels) ? report.levels : []).flatMap((l) => l.tasks || []);
}

// A minimal, honest report for a flow/swarm scenario that stopped before the workflow ever wrote one (a gate,
// plan, or approve stage failed, or the implement session died before returning): no levels, no invented tasks,
// `ok: false`, `stoppedAtLevel: 0` so runEntry's outcomeOf reads it as "stopped at level 0", and a `rehearsal`
// field carrying the stage and the assertion message that stopped it (card workflow-rehearsal-review #4).
// integrationBranch is a plain string, never null/undefined: runEntry renders it unconditionally inside backticks
// (`integration branch \`${report.integrationBranch}\``, lib/board.mjs, no "missing branch" form exists there),
// so a nullish value would render literally as "integration branch `null`" in the real docs/live-runs.md (card
// workflow-rehearsal-review, round 2, #19).
export function syntheticReport(scenario, stage, message) {
  return { ok: false, plan: `${scenario} rehearsal (no report)`, integrationBranch: "none (no report)", levels: [], stoppedAtLevel: 0, rehearsal: { stage, message } };
}

// ---- Assertions shared by a scenario's gate and implement stages -------------------------------------------

function fail(message, cost) {
  return cost === undefined ? { ok: false, message } : { ok: false, message, cost };
}
function pass(message, extra = {}) {
  return { ok: true, message, ...extra };
}

// `git status --porcelain`, tracked or untracked, with every `.doug/` path filtered out (lib/land.mjs's own
// tracked-files filter, matched here): a plan file the runner's own act stages leave modified or untracked (a
// draft plan.json, `plan.mjs done` flipping its status) and a board record are never themselves "dirty" for a
// clean-tree check, since nothing in the fixture commits them mid-run. Shared by every clean-tree check the
// runner makes, so a real land or build is never blocked by its own bookkeeping (card workflow-rehearsal-review,
// round 2, #16).
export function dirtyOutsideDoug(dir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", env: cleanEnv() })
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.slice(3).startsWith(".doug/"));
}

// A gate stage asserts that a skill reached its human gate (AskUserQuestion, denied in print mode) and stopped
// there without doing anything: the runtime loaded the plugin and offered the slash command, but the fixture is
// otherwise exactly as prepareFixture left it (research §1, "Starting is never automatic").
export function assertGateHeld(dir, stream, { plugins, command, cardId, expectColumn = "ready", unchangedFiles = [], planAbsent = false }) {
  const missingPlugins = plugins.filter((p) => !pluginsLoaded(stream, [p]));
  if (missingPlugins.length) return fail(`the init event's plugins did not name ${missingPlugins.join(", ")}`);
  if (!slashCommandPresent(stream, command)) return fail(`the init event's slash_commands did not carry ${command}`);
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  } catch (err) {
    return fail(`could not read the fixture board: ${err.message}`);
  }
  const card = (board.cards || []).find((c) => c.id === cardId);
  if (!card || card.column !== expectColumn) return fail(`the fixture board no longer has ${cardId} in ${expectColumn}`);
  let log;
  try {
    log = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim().split("\n").filter(Boolean);
  } catch (err) {
    return fail(`git log failed: ${err.message}`);
  }
  if (log.length !== 1) return fail(`git log has ${log.length} commit(s); expected only the fixture commit`);
  if (planAbsent && existsSync(join(dir, ".doug/plan.json"))) return fail(".doug/plan.json exists; the gate must not have started planning");
  for (const f of unchangedFiles) {
    const status = execFileSync("git", ["status", "--porcelain", "--", f], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
    if (status) return fail(`${f} changed even though the gate should have stopped before any edit`);
  }
  const rest = dirtyOutsideDoug(dir);
  if (rest.length) return fail(`working tree is not clean apart from .doug/: ${rest.join(", ")}`);
  return pass("gate held: the skill did not proceed past the denied human gate");
}

// The flow scenario's gate stage (item rehearsal-first-live-findings #1): /doug-next has no gate before planning,
// only its approval gate after planning, so a run that follows the skill exactly moves the card to In flow
// (uncommitted working state), spawns the planner, and stops at AskUserQuestion with a draft plan on disk.
// Asserting the card was still Ready (assertGateHeld's shape) fails a correct run; this asserts the real stopping
// point instead: the card is in flow in the working-tree record, `git log` holds only the fixture commit (task
// rehearse-uncommitted-move: /doug-next leaves the move uncommitted, landing it only in the card's landing
// commit), a draft plan exists and validates, and nothing past the gate (a task worktree, an integration branch)
// exists yet.
export function assertFlowGateHeld(dir, stream, { plugins, command, cardId }) {
  const missingPlugins = plugins.filter((p) => !pluginsLoaded(stream, [p]));
  if (missingPlugins.length) return fail(`the init event's plugins did not name ${missingPlugins.join(", ")}`);
  if (!slashCommandPresent(stream, command)) return fail(`the init event's slash_commands did not carry ${command}`);
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  } catch (err) {
    return fail(`could not read the fixture board: ${err.message}`);
  }
  const card = (board.cards || []).find((c) => c.id === cardId);
  if (!card || card.column !== "flow") return fail(`the fixture board does not have ${cardId} in flow`);
  let log;
  try {
    log = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim().split("\n").filter(Boolean);
  } catch (err) {
    return fail(`git log failed: ${err.message}`);
  }
  if (log.some((l) => l.includes(`Board: ${cardId} moved to In flow`)))
    return fail(`git log carries a "Board: ${cardId} moved to In flow" commit; /doug-next leaves the move uncommitted, landing it only in the card's landing commit`);
  if (log.length !== 1) return fail(`git log has ${log.length} commit(s); expected only the fixture commit`);
  const planPath = join(dir, ".doug/plan.json");
  if (!existsSync(planPath)) return fail(".doug/plan.json does not exist; the planner did not run");
  const validate = act(PLAN_MJS, ["validate"], dir);
  if (!validate.ok) return fail(`plan.mjs validate failed: ${validate.stderr || validate.stdout}`);
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (err) {
    return fail(`.doug/plan.json is not valid JSON: ${err.message}`);
  }
  if (plan.status === "approved") return fail("the plan is already approved; the planning skill must never approve on its own");
  let branches;
  try {
    branches = execFileSync("git", ["branch", "--list"], { cwd: dir, encoding: "utf8", env: cleanEnv() })
      .split("\n")
      .map((l) => l.replace(/^\*?\s*/, "").trim())
      .filter(Boolean);
  } catch (err) {
    return fail(`git branch failed: ${err.message}`);
  }
  const stray = branches.filter((b) => b !== "main");
  if (stray.length) return fail(`an integration branch already exists: ${stray.join(", ")}`);
  const worktreesDir = join(dir, ".claude/worktrees");
  if (existsSync(worktreesDir) && readdirSync(worktreesDir).length) return fail("a task worktree exists; the session proceeded past the approval gate");
  const rest = dirtyOutsideDoug(dir);
  if (rest.length) return fail(`working tree is not clean apart from .doug/: ${rest.join(", ")}`);
  return pass("gate held: the card moved to In flow, a draft plan exists, and the session stopped at the approval gate");
}

// The implement stage of the flow and swarm scenarios: the plugin loaded, no agent name went unresolved, and the
// workflow's own report says every task was verified, reviewed, and carries an adversary field. `requireWorkers`
// is the swarm scenario's extra check (a real lead/worker split happened, not just an implementer).
export function assertImplemented(dir, stream, { plugins, requireWorkers = false } = {}) {
  const missingPlugins = plugins.filter((p) => !pluginsLoaded(stream, [p]));
  if (missingPlugins.length) return fail(`the init event's plugins did not name ${missingPlugins.join(", ")}`);
  const unresolved = unresolvedAgentNames(stream);
  if (unresolved.length) return fail(`unresolved agent name(s) in the stream: ${unresolved.join(", ")}`);
  const { ok, reason, report } = readReport(dir);
  if (!ok) return fail(reason);
  const tasks = reportTasks(report);
  if (!tasks.length) return fail("the report carries no tasks");
  for (const t of tasks) {
    if (!t.verified) return fail(`task ${t.id}: verified is not true`);
    if (!t.reviewed) return fail(`task ${t.id}: reviewed is not true`);
    if (!("adversary" in t)) return fail(`task ${t.id}: report carries no adversary field`);
  }
  if (requireWorkers) {
    const swarmed = tasks.filter((t) => Array.isArray(t.workers) && t.workers.length);
    if (!swarmed.length) {
      // Since 3eb9485, a deterministic shape gate (plugins/doug-flow/skills/swarm-launch/SKILL.md) keeps a task
      // shaped like this fixture's (one source file plus its tests) off the lead: doug-implement.js's swarmReport()
      // records that on the task as `swarm: { applies: false, reason, ... }`. When that is why no task swarmed, say
      // so by name instead of the old blanket message.
      const gated = tasks.find((t) => t.swarm && t.swarm.applies === false);
      if (gated) {
        return fail(
          `task ${gated.id}: no workers (${gated.swarm.reason}); the shape gate kept it off the lead`,
        );
      }
      return fail("no task in the report carried workers: the swarm did not run");
    }
  }
  return pass(`implemented: ${tasks.map((t) => t.id).join(", ")}`);
}

// Every agent name a swarmed report's tasks actually ran: each attempt's own `stages` (lead, worker-n, lead-merge,
// verify, review, adversary, integrate — not just the last pass's, doug-implement.js's per-task report around
// line 1794-1811 keeps `attempts` as the full pass history and `stages` on the task itself as only the last one),
// plus each worker's brief id from the `workers` list.
export function agentNamesFromReport(report) {
  const names = new Set();
  for (const t of reportTasks(report)) {
    for (const a of Array.isArray(t.attempts) ? t.attempts : []) for (const s of a.stages || []) names.add(s);
    for (const w of Array.isArray(t.workers) ? t.workers : []) if (w && w.id) names.add(w.id);
  }
  return [...names];
}

// ---- Fixture (a fresh temp copy of evals/fixtures/ts-basic, prepared like evals/run.mjs prepare()) ------------

function fixtureSuite() {
  return JSON.parse(readFileSync(TASKS_FILE, "utf8"));
}

function fixtureTask(suite, id = "fix-hours-planned") {
  const task = suite.tasks.find((t) => t.id === id);
  if (!task || !task.plan) throw new Error(`task "${id}" with a plan was not found in ${TASKS_FILE}`);
  return task;
}

// A fresh fixture for one scenario: the suite's own setup commands (so a checkout that never ran evals still
// gets node_modules; evals/fixtures/ts-basic/node_modules is gitignored), `doug init`, a board holding one card
// `fix-hours` (title/goal from the fix-hours-planned task's plan), on the hand track only for the hand scenario,
// and, for the swarm scenario, a card `swarm-split-planned` from that task's plan (two source files, size M, so
// the shape gate lets it split) with the plan installed pre-approved with swarm on (the swarm opt-in and
// the approval are the user's acts, standing in for /doug-swarm here since the swarm scenario starts at
// implement, not at a gate). CLAUDE.md's Models table is left exactly as `doug init` generated it, worker row
// included; the runner edits no row. Throws with a `pnpm build` message when the CLI is missing.
// `tempPrefix` lets a caller (the test file) mark its own fixtures distinctly from a real run's, so a fixture
// left behind by --spend on failure is recognisable as the runner's (card workflow-rehearsal-review #7).
// The auto scenario's second card: its goal is the add-truncate task's prompt in the same suite.
const AUTO_BACKLOG_CARD = { id: "add-capitalize", title: "Add capitalize", goal: "Add a capitalize helper to src/strings.ts that upper-cases the first letter of a string." };
function autoSecondCard(suite) {
  const task = suite.tasks.find((t) => t.id === "add-truncate");
  if (!task || !task.prompt) throw new Error(`task "add-truncate" with a prompt was not found in ${TASKS_FILE}`);
  return { id: "add-truncate", title: "Add truncate", goal: task.prompt };
}

// The start scenario's fixture (card doug-start-skill): a git repo on main with one empty commit and nothing else, so
// the session starts where a new project starts. Doug is not installed in it; the idea session runs `doug init`.
function prepareStartFixture({ dir, tempPrefix } = {}) {
  const target = dir || mkdtempSync(join(tmpdir(), tempPrefix || "doug-rehearse-start-"));
  mkdirSync(target, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8", env: cleanEnv() }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "rehearse@example.com");
  git("config", "user.name", "rehearse");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  return { dir: target, card: { id: "start", title: "Start a project", goal: "Start a new project from an idea." }, task: null, baseline: git("rev-parse", "HEAD") };
}

// ---- The ts-orders fixture (card fixture-repo-scenarios) -----------------------------------------------------------
// evals/tasks/ts-orders.json carries, beside its tasks, a `rehearsal` descriptor: the cards each scenario takes, the
// background cards every board holds, the lessons seeded into the memory store, the memory scenario's recall query and
// the decide scenario's proposal. The fixture checks in no .doug directory; prepareFixture builds the board and the
// store from this descriptor.
export const DECISION_BODY_RELPATH = ".doug/.state/scratch/decision-body.md";

function ordersSuite() {
  return JSON.parse(readFileSync(ORDERS_TASKS_FILE, "utf8"));
}

// A descriptor card joined with its task: the board fields, the files its build must change (the task's allowedFiles)
// and the held-out test that checks it (an absolute path under evals/heldout).
// Card rehearsal-harder-tier: shared by the ts-orders and ts-rentals suites. `heldOut` is still the first held-out entry
// (heldOutOf's callers); `heldOuts` lists every entry with its in-fixture path; `deps` come from the descriptor;
// `requiredFiles` defaults to the owned files; `requireTestFile` asks for a tests/ path in the card's commit.
function suiteCards(suite, specs, tasksFile) {
  return specs.map((c) => {
    const task = suite.tasks.find((t) => t.id === c.task);
    if (!task || !task.plan) throw new Error(`task "${c.task}" with a plan was not found in ${tasksFile}`);
    const held = (task.heldOut || [])[0];
    return {
      id: c.id,
      task: c.task,
      title: task.plan.title,
      goal: task.plan.goal,
      track: c.track,
      column: c.column,
      component: c.component,
      size: c.size,
      class: c.class,
      deps: c.deps || [],
      files: [...task.allowedFiles],
      requiredFiles: [...(task.requiredFiles || task.allowedFiles)],
      requireTestFile: !!task.requireTestFile,
      heldOut: held ? { id: c.id, file: join(HELDOUT_DIR, held.from) } : null,
      heldOuts: (task.heldOut || []).map((h) => ({ file: join(HELDOUT_DIR, h.from), to: h.to })),
    };
  });
}

// Prepares a temp copy of a suite fixture (ts-orders or ts-rentals) from its tasks file's `rehearsal` descriptor.
export function prepareSuiteFixture({ scenario, fixtureName, fixtureDir, tasksFile, dir, tempPrefix }) {
  const suite = JSON.parse(readFileSync(tasksFile, "utf8"));
  const rehearsal = suite.rehearsal;
  const spec = rehearsal.scenarios[scenario] || { cards: [] };
  const cards = suiteCards(suite, spec.cards, tasksFile);
  const target = dir || mkdtempSync(join(tmpdir(), tempPrefix || `doug-rehearse-${scenario}-`));
  mkdirSync(target, { recursive: true });
  cpSync(fixtureDir, target, { recursive: true, filter: (src) => !src.split(sep).includes("node_modules") });
  const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8", env: cleanEnv() }).trim();
  const raw = scenario === "init";

  if (!raw) {
    for (const cmd of suite.setup || []) {
      const r = spawnSync(cmd, { cwd: target, shell: true, encoding: "utf8", timeout: 600000, env: commandEnv(cleanEnv()) });
      if (r.status !== 0) throw new Error(`fixture setup failed in ${target}: ${cmd}\n${(r.stdout || "") + (r.stderr || "")}`);
    }
    const init = spawnSync(process.execPath, [CLI, "init", target, "--yes", "--quiet"], { encoding: "utf8", env: cleanEnv() });
    if (init.status !== 0) throw new Error(`doug init failed in ${target}: ${init.stdout}${init.stderr}`);
    const gitignorePath = join(target, ".gitignore");
    const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (!gitignore.split("\n").some((l) => l.trim() === ".claude/worktrees/")) {
      writeFileSync(gitignorePath, `${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}.claude/worktrees/\n`);
    }

    const everyCard = [...cards, ...rehearsal.background];
    let board = { ...newBoard(), components: [...new Set(everyCard.map((c) => c.component))] };
    for (const c of everyCard) {
      board = addCard(board, { id: c.id, title: c.title, goal: c.goal, component: c.component, size: c.size, track: c.track, deps: c.deps, column: c.column, class: c.class });
    }
    mkdirSync(join(target, ".doug"), { recursive: true });
    writeFileSync(join(target, BOARD_RELPATH), JSON.stringify(board, null, 2) + "\n");

    if (spec.workersMax) {
      const configPath = join(target, ".doug/config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, workers: { ...(config.workers || {}), max: spec.workersMax } }, null, 2) + "\n");
    }
    if (scenario === "swarm") {
      const task = suite.tasks.find((t) => t.id === cards[0].task);
      writeFileSync(join(target, ".doug/plan.json"), JSON.stringify({ ...task.plan, status: "approved", card: cards[0].id, swarm: true }, null, 2) + "\n");
    }
    if (scenario === "decide") {
      mkdirSync(join(target, ".doug/.state/scratch"), { recursive: true });
      writeFileSync(join(target, DECISION_BODY_RELPATH), `${rehearsal.decide.body}\n`);
    }
  }

  git("init", "-q", "-b", "main");
  git("config", "user.email", "rehearse@example.com");
  git("config", "user.name", "rehearse");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const baseline = git("rev-parse", "HEAD");

  // The seeded lessons go in after the commit: the store lives under .doug/.state, which the fixture's .gitignore
  // (doug init adds it) keeps out of the tree.
  if (!raw) {
    for (const l of rehearsal.lessons || []) {
      const r = spawnSync(process.execPath, [MEMORY_MJS, "lesson", "add", "--text", l.text, "--kind", l.kind, "--citation", l.citation, target], { encoding: "utf8", env: cleanEnv() });
      if (r.status !== 0) throw new Error(`memory.mjs lesson add failed in ${target}: ${r.stderr || r.stdout}`);
    }
  }
  const first = cards[0];
  const card = first ? { id: first.id, title: first.title, goal: first.goal } : { id: scenario, title: `${scenario} rehearsal`, goal: `Exercise the ${scenario} command path.` };
  const task = first ? suite.tasks.find((t) => t.id === first.task) : null;
  return { dir: target, card, cards, task, baseline, fixture: fixtureName };
}

export function prepareFixture({ scenario, fixture, dir, tempPrefix } = {}) {
  if (isHardScenario(scenario)) {
    if (!existsSync(CLI)) throw new Error(`the doug CLI is not built (${relative(ROOT, CLI)} is missing); run "pnpm build" first`);
    if (fixture && fixture !== "ts-rentals") throw new Error(`prepareFixture: scenario "${scenario}" does not run on fixture "${fixture}"; the hard tier runs on ts-rentals only`);
    return prepareSuiteFixture({ scenario, fixtureName: "ts-rentals", fixtureDir: RENTALS_FIXTURE_DIR, tasksFile: RENTALS_TASKS_FILE, dir, tempPrefix });
  }
  if (!SCENARIOS.includes(scenario)) throw new Error(`prepareFixture: unknown scenario "${scenario}"; scenarios are ${SCENARIOS.join(", ")}`);
  if (!existsSync(CLI)) throw new Error(`the doug CLI is not built (${relative(ROOT, CLI)} is missing); run "pnpm build" first`);
  if (scenario === "start") return prepareStartFixture({ dir, tempPrefix });
  const fixtures = scenarioFixtures(scenario);
  const chosen = fixture || fixtures[0];
  if (!fixtures.includes(chosen)) throw new Error(`prepareFixture: scenario "${scenario}" does not run on fixture "${chosen}"; its fixtures are ${fixtures.join(", ")}`);
  if (chosen === "ts-orders") return prepareSuiteFixture({ scenario, fixtureName: "ts-orders", fixtureDir: ORDERS_FIXTURE_DIR, tasksFile: ORDERS_TASKS_FILE, dir, tempPrefix });
  const suite = fixtureSuite();
  const task = fixtureTask(suite, scenario === "swarm" ? SWARM_TASK_ID : "fix-hours-planned");
  const cardId = scenario === "swarm" ? SWARM_TASK_ID : "fix-hours";
  const target = dir || mkdtempSync(join(tmpdir(), tempPrefix || `doug-rehearse-${scenario}-`));
  cpSync(FIXTURE_DIR, target, { recursive: true });

  for (const cmd of suite.setup || []) {
    const r = spawnSync(cmd, { cwd: target, shell: true, encoding: "utf8", timeout: 600000, env: commandEnv(cleanEnv()) });
    if (r.status !== 0) throw new Error(`fixture setup failed in ${target}: ${cmd}\n${(r.stdout || "") + (r.stderr || "")}`);
  }

  const init = spawnSync(process.execPath, [CLI, "init", target, "--yes", "--quiet"], { encoding: "utf8", env: cleanEnv() });
  if (init.status !== 0) throw new Error(`doug init failed in ${target}: ${init.stdout}${init.stderr}`);

  // A workflow run leaves worktrees under .claude/worktrees/; the fixture's own .gitignore does not cover it
  // (doug init only adds .doug/.state/), so every clean-tree check the runner makes would otherwise see them as
  // untracked (card workflow-rehearsal-review, round 2, #17). Appended after doug init so it is not overwritten.
  const gitignorePath = join(target, ".gitignore");
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.split("\n").some((l) => l.trim() === ".claude/worktrees/")) {
    writeFileSync(gitignorePath, `${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}.claude/worktrees/\n`);
  }

  // Card parallel-card-queens (B13): the parallel scenario's pair is one flow card and one hand card in different
  // components, so the coordinator's disjointness rule lets them run together under workers.max 2.
  const parallel = scenario === "parallel";
  let board = { ...newBoard(), components: parallel ? ["duration", "strings"] : ["flow"] };
  board = addCard(board, {
    id: cardId,
    title: task.plan.title,
    goal: task.plan.goal,
    component: parallel ? "duration" : "flow",
    size: "S",
    track: scenario === "hand" || scenario === "auto" ? "hand" : undefined,
    column: "ready",
    // doug-hand's Start step now refuses a classless card before it stamps the landing's condition
    // (scripts/memory.mjs's "condition open"); every fixture card carries one so a rehearsal never trips that
    // refusal (plugins/doug-flow/skills/doug-hand/SKILL.md step 2).
    class: "code",
  });
  if (scenario === "auto") {
    const second = autoSecondCard(suite);
    board = addCard(board, { ...second, component: "flow", size: "S", track: "hand", column: "ready", class: "code" });
    // Card autopilot-unlimited: a bare `--auto` takes Ready cards only, so this Backlog card must come out untouched.
    board = addCard(board, { ...AUTO_BACKLOG_CARD, component: "flow", size: "S", track: "hand", column: "backlog", class: "code" });
  }
  if (parallel) {
    board = addCard(board, { ...autoSecondCard(suite), component: "strings", size: "S", track: "hand", column: "ready", class: "code" });
    const configPath = join(target, ".doug/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, workers: { ...(config.workers || {}), max: 2 } }, null, 2) + "\n");
  }
  mkdirSync(join(target, ".doug"), { recursive: true });
  writeFileSync(join(target, BOARD_RELPATH), JSON.stringify(board, null, 2) + "\n");

  if (scenario === "swarm") {
    const plan = { ...task.plan, status: "approved", card: cardId, swarm: true };
    writeFileSync(join(target, ".doug/plan.json"), JSON.stringify(plan, null, 2) + "\n");
  }

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["config", "user.email", "rehearse@example.com"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["config", "user.name", "rehearse"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["add", "-A"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: target, env: cleanEnv() });
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8", env: cleanEnv() }).trim();
  return { dir: target, card: { id: cardId, title: task.plan.title, goal: task.plan.goal }, task, baseline, fixture: "ts-basic" };
}

// ---- One `claude -p` session (evals/run.mjs runWorkflowSession's spawn shape exactly) --------------------------
const SESSION_TIMEOUT_MS = 90 * 60 * 1000;

// Spawns one stage's session, saving the full stream to <dir>/.doug/.state/rehearsal/<stage>.jsonl so a failed
// assertion can be read afterwards. `claudeBin` defaults to $DOUG_REHEARSE_CLAUDE or "claude"; a real user never
// sets that env var, the test file points it at a fake. `capUsd` becomes --max-budget-usd. `spawnSync` never
// throws on a missing binary; it sets `.error` instead (ENOENT), surfaced here as `error`/`signal` rather than
// left for the caller to notice only from empty output (card workflow-rehearsal-review #5).
export function runStage({ dir, prompt, maxTurns, stage, capUsd = null, claudeBin = process.env.DOUG_REHEARSE_CLAUDE || "claude", timeoutMs = SESSION_TIMEOUT_MS }) {
  const streamDir = join(dir, STREAM_DIR);
  mkdirSync(streamDir, { recursive: true });
  const streamPath = join(streamDir, `${stage}.jsonl`);
  const env = cleanEnv({ CLAUDE_PROJECT_DIR: "", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" });
  // --disallowedTools Artifact: a gate/build session that reaches the doug-board skill tries to publish, and the
  // first live flow rehearsal found the Artifact tool merely absent from the -p tool list, not denied — a runtime
  // where it happened to be present would let the session actually publish (item rehearsal-first-live-findings
  // #5). This lockout is the runner's own, not evals/run.mjs's: an eval session never invokes a board skill.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(maxTurns), "--plugin-dir", PLUGIN_DIR, "--dangerously-skip-permissions", "--disallowedTools", "Artifact"];
  if (capUsd !== null) args.push("--max-budget-usd", String(capUsd));
  const r = spawnSync(claudeBin, args, { cwd: dir, encoding: "utf8", timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(streamPath, r.stdout || "");
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status, signal: r.signal || null, error: r.error || null, streamPath, cost: sessionCost(r.stdout || "") };
}

// The last ~20 lines of a child's stderr, capped to ~2000 chars, as a message suffix; empty stderr gives "" (card
// rehearse-stop-block-message: a non-zero exit or a Stop-hook block used to fail with no reason).
function stderrTail(stderr) {
  const lines = String(stderr || "").trim().split("\n");
  const tail = lines.slice(-20).join("\n").slice(-2000).trim();
  return tail ? `: ${tail}` : "";
}

// Runs one session stage end to end: spawn, then assert, with every failure mode (the binary could not run, it
// was killed, or the assertion itself threw) turned into a normal `{ ok:false, message }` instead of a crash or
// a misleading assertion failure (card workflow-rehearsal-review #5). Always carries `streamPath` and `cost`.
export function runSessionStage(stage, { dir, card, cards, fixture, baseline, capUsd = null, claudeBin } = {}) {
  let head = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
  } catch {
    // no git HEAD: the held-at-gate commit check is skipped for this stage
  }
  const r = runStage({ dir, prompt: stage.prompt({ card, cards, fixture }), maxTurns: stage.maxTurns, stage: stage.name, capUsd, ...(claudeBin ? { claudeBin } : {}), ...(stage.timeoutMs ? { timeoutMs: stage.timeoutMs } : {}) });
  if (r.error) return { ok: false, message: `claude could not run: ${r.error.message}`, streamPath: r.streamPath, cost: null };
  if (r.signal) return { ok: false, message: `claude was killed by signal ${r.signal} before finishing${stderrTail(r.stderr)}`, streamPath: r.streamPath, cost: r.cost };
  // Card rehearse-max-turns-exit: the docs do not say what exit code claude -p gives when a session ends on
  // --max-turns or --max-budget-usd, so the final result line's subtype decides, not the status.
  let endedBy = null;
  if (r.status !== 0) {
    let last = null;
    for (const j of jsonLines(r.stdout || "")) if (j.type === "result") last = j;
    if (last && (last.subtype === "error_max_turns" || last.subtype === "error_max_budget_usd")) endedBy = last.subtype;
    else return { ok: false, message: `claude exited with status ${r.status}${stderrTail(r.stderr)}`, streamPath: r.streamPath, cost: r.cost };
  }
  let result;
  try {
    result = stage.assert({ dir, card, cards, fixture, baseline, head, stream: r.stdout });
  } catch (err) {
    result = fail(`assertion threw: ${err && err.message ? err.message : String(err)}`);
  }
  if (endedBy && !result.ok) result = { ...result, message: `${result.message} (session ended ${endedBy}, exit ${r.status})` };
  return { ...result, streamPath: r.streamPath, cost: r.cost };
}

// Runs one act stage (the runner performing a human gate's act, or a deterministic step): a throw becomes a
// normal failed result instead of crashing the scenario (card workflow-rehearsal-review #5).
export function runActStage(stage, ctx = {}) {
  try {
    return { ...stage.run(ctx), streamPath: null, cost: null };
  } catch (err) {
    return { ok: false, message: `threw: ${err && err.message ? err.message : String(err)}`, streamPath: null, cost: null };
  }
}

// Runs one command stage (card fixture-repo-scenarios): a step that spends model money through a Doug CLI that
// spawns claude itself (memory.mjs reflect, model regen, ideas). The runner hands it the claude binary
// ($DOUG_REHEARSE_CLAUDE or "claude") and the stage's cap; the stage passes them on as --claude-bin and --max-usd.
// The cost it returns is kept, unlike an act's.
export function runCommandStage(stage, ctx = {}) {
  const claudeBin = ctx.claudeBin || process.env.DOUG_REHEARSE_CLAUDE || "claude";
  try {
    const r = stage.run({ ...ctx, claudeBin });
    return { ...r, streamPath: null, cost: typeof r.cost === "number" ? r.cost : null };
  } catch (err) {
    return { ok: false, message: `threw: ${err && err.message ? err.message : String(err)}`, streamPath: null, cost: null };
  }
}

// A runner act: node <script> <args...> <dir>, the same shape plan.mjs and board.mjs subcommands take.
function act(script, args, dir) {
  const r = spawnSync(process.execPath, [script, ...args, dir], { encoding: "utf8", env: cleanEnv() });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// A clean-before, held-out-test-after helper shared by every scenario's last stage (card workflow-rehearsal-review
// #1b): checks the tree is clean BEFORE the held-out test is copied in (a dirty tree afterwards used to be
// unwinnable, since the copy itself is what made it dirty), then always removes the held-out file again, whether
// `pnpm test` passed or not, so the fixture is left exactly as the build/land left it.
function runHeldOutAndClean(dir, { id = "fix-hours", file = HELDOUT_FILE } = {}) {
  const before = dirtyOutsideDoug(dir);
  if (before.length) return fail(`working tree is not clean before the held-out test is added: ${before.join(", ")}`);
  const heldOutPath = join(dir, `tests/heldout-${id}.test.ts`);
  cpSync(file, heldOutPath);
  let test;
  try {
    test = spawnSync("pnpm", ["test"], { cwd: dir, encoding: "utf8", shell: true, env: cleanEnv() });
  } finally {
    rmSync(heldOutPath, { force: true });
  }
  if (test.status !== 0) return fail(`pnpm test failed in the fixture after the held-out test was added:\n${((test.stdout || "") + (test.stderr || "")).slice(0, 2000)}`);
  return pass("held-out test passed");
}

// The hard tier's held-out run (card rehearsal-harder-tier): a card can own several held-out files. Same order as
// runHeldOutAndClean: the clean-tree check first, every `heldOuts[].to` copied in, one `pnpm test`, and every copy removed
// whether it passed or not. A failure names the card and each held-out file.
export function runHeldOutsAndClean(dir, card) {
  const id = (card && card.id) || "card";
  const held = card && Array.isArray(card.heldOuts) ? card.heldOuts : [];
  const before = dirtyOutsideDoug(dir);
  if (before.length) return fail(`working tree is not clean before the held-out tests for ${id} are added: ${before.join(", ")}`);
  const copied = [];
  let test;
  try {
    for (const h of held) {
      const dest = join(dir, h.to);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(h.file, dest);
      copied.push(dest);
    }
    test = spawnSync("pnpm", ["test"], { cwd: dir, encoding: "utf8", shell: true, env: cleanEnv() });
  } finally {
    for (const dest of copied) rmSync(dest, { force: true });
  }
  if (test.status !== 0) {
    return fail(`pnpm test failed in the fixture after the held-out tests for ${id} were added (${held.map((h) => h.to).join(", ") || "none"}):\n${((test.stdout || "") + (test.stderr || "")).slice(0, 2000)}`);
  }
  return pass(`held-out tests passed for ${id}`);
}

// A passed run used to be removed, streams and report and all, so a passed scenario's evidence could only be read
// afterwards from ~/.claude/projects (item rehearsal-first-live-findings #2). Before a fixture is removed, its
// stream logs (<fixtureDir>/.doug/.state/rehearsal/*.jsonl, this module's own STREAM_DIR) and its last report
// (RESULTS_FILE, when the workflow wrote one) are copied into the real repository at `dir`, under
// .doug/.state/rehearsal/<scenario>-<ISO timestamp>/, so a passed run's evidence survives the fixture's removal
// the same way a failed run's already does by being kept. Returns the absolute path copied into, so the caller
// can print it.
export function archiveEvidence({ fixtureDir, dir, scenario, now = new Date() }) {
  const dest = join(dir, STREAM_DIR, `${scenario}-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dest, { recursive: true });
  const streamSrc = join(fixtureDir, STREAM_DIR);
  if (existsSync(streamSrc)) cpSync(streamSrc, dest, { recursive: true });
  const reportSrc = join(fixtureDir, RESULTS_FILE);
  if (existsSync(reportSrc)) cpSync(reportSrc, join(dest, "last-report.json"));
  return dest;
}

// ---- Recording, through the existing board.mjs CLI only (never lib/board.mjs's runEntry/handEntry/appendRun
// directly: the CLI is what does research-note promotion and batch handling, card workflow-rehearsal-review #3) --

function runBoardCli(args) {
  const r = spawnSync(process.execPath, [BOARD_MJS, ...args], { encoding: "utf8", env: cleanEnv() });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// The one-line note a rehearsal's run entry carries (runEntry/handEntry's `note`, rendered where handEntry
// already renders one). The swarm scenario's note also names the plugin and the agents its report resolved,
// since that scenario is the one that proves plugin loading and agent-name resolution in the real runtime.
// A stage's own message (for example the approve act's "the plan also owns ..." note) is folded into the stage
// list so it reaches the record instead of being discarded (card workflow-rehearsal-review #10).
// Scenarios whose outcome records in the hand form (no workflow report): hand, auto, and the two start scenarios.
export function recordsAsHand(scenario) {
  return ["hand", "auto", "parallel", "start", "start-feature", "init", "board", "memory", "decide", "hard-hand", "hard-auto", "hard-parallel", "hard-start-feature"].includes(scenario);
}

export function rehearsalNote({ scenario, outcome, stages, cost = null, agentNames = null, fixture = null }) {
  const stageList = stages.map((s) => `${s.name} (${s.wallClock})${s.message ? ` — ${s.message}` : ""}`).join(", ");
  const onFixture = `the ${fixture || scenarioFixtures(scenario)[0] || "ts-basic"} fixture`;
  const base =
    recordsAsHand(scenario)
      ? `Rehearsal ${scenario} on ${scenario === "start" ? "an empty git repo" : onFixture}: ${outcome}; cost ${cost === null ? "not measured" : `$${Number(cost).toFixed(2)}`}; stages ${stageList}`
      : `Rehearsal ${scenario} on ${onFixture}: ${outcome}; stages ${stageList}`;
  if (scenario !== "swarm") return base;
  return `${base}; plugin loading and agent-name resolution asserted in the runtime (plugins: doug-flow; agents resolved: ${(agentNames || []).join(", ") || "none"})`;
}

// The fixture's own hand-track "| Gate |" line (the fixture's doug-hand build session ran board.mjs record
// --hand on itself): the last such line in the fixture's docs/live-runs.md, or null when there is none, so the
// real repository's record can carry the same gate text the fixture build reported, or "not observed".
export function extractGateLine(dir) {
  const file = join(dir, "docs/live-runs.md");
  if (!existsSync(file)) return null;
  const matches = [...readFileSync(file, "utf8").matchAll(/\|\s*Gate\s*\|\s*(.*?)\s*\|/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1][1];
  return last && last !== "not recorded" ? last : null;
}

// The gate text a rehearsal records: the scenario result's own (start's end assert ran the fixture's verify.mjs),
// else the fixture's recorded "| Gate |" row, else "not observed".
export function rehearsalGate(result, fixtureDir) {
  return (result && result.gate) || extractGateLine(fixtureDir) || "not observed";
}

// Records a flow or swarm outcome under `cardId` on the board at `dir` (the real repository by default; a temp
// copy in tests) by spawning `board.mjs record <id> <report> [dir] ...` exactly as a normal run does. Throws on a
// non-zero exit (the caller decides how to report that; it is never swallowed).
export function recordRunOutcome(dir, cardId, { reportFile, wallClock = null, cost = null, mergeCommit = null, note = null, rehearsal = null, outcome = null, fixture = null }) {
  const args = ["record", cardId, reportFile, "--summary", "A rehearsal run was recorded."];
  if (cost !== null) args.push("--cost", String(cost));
  if (wallClock !== null) args.push("--wall", wallClock);
  if (mergeCommit) args.push("--commit", mergeCommit);
  if (note) args.push("--note", note);
  if (rehearsal) {
    args.push("--rehearsal", rehearsal, "--rehearsal-outcome", outcome);
    if (fixture) args.push("--rehearsal-fixture", fixture);
  }
  args.push(dir);
  const r = runBoardCli(args);
  if (!r.ok) throw new Error(`board.mjs record failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Records a hand outcome under `cardId` on the board at `dir` by spawning `board.mjs record <id> --hand [dir]
// ...` exactly as a normal hand-track landing does.
export function recordHandOutcome(dir, cardId, { commit = null, wallClock = null, gate = null, note = null, rehearsal = null, outcome = null, fixture = null }) {
  const args = ["record", cardId, "--hand", "--summary", "A rehearsal hand landing was recorded."];
  if (commit) args.push("--commit", commit);
  if (wallClock !== null) args.push("--wall", wallClock);
  if (gate !== null) args.push("--gate", gate);
  if (note) args.push("--note", note);
  if (rehearsal) {
    args.push("--rehearsal", rehearsal, "--rehearsal-outcome", outcome);
    if (fixture) args.push("--rehearsal-fixture", fixture);
  }
  args.push(dir);
  const r = runBoardCli(args);
  if (!r.ok) throw new Error(`board.mjs record --hand failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---- The start scenarios' acts and end assertions (card doug-start-skill) ---------------------------------------
// In `claude -p` AskUserQuestion is absent from the tool list (measured, Claude Code 2.1.296: the init event's tools
// lack it and ToolSearch finds nothing), and the skill's unanswered-gate rule ends the phase there, with its file written;
// the act after it stands in for the human's approval by committing what the session left, so the next session,
// deriving state from disk, resumes at the next phase. Nothing here spawns claude or reads a stream.
function commitPhase(dir, message) {
  try {
    const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
    run("add", "-A");
    if (run("status", "--porcelain").trim()) run("commit", "-q", "-m", message);
    return pass(`committed: ${message}`);
  } catch (err) {
    return fail(`git commit failed: ${err.stderr || err.stdout || err.message}`);
  }
}

// The tool_use names and Agent spawns in a stream (the Agent tool was called Task in older runtimes).
function agentSpawns(stream) {
  const types = new Set();
  for (const j of jsonLines(stream)) {
    const content = j && j.type === "assistant" && j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) if (c && c.type === "tool_use" && (c.name === "Agent" || c.name === "Task") && c.input && c.input.subagent_type) types.add(c.input.subagent_type);
  }
  return types;
}

// Proof a /doug-start session really ran the skill: the plugin loaded, the command was offered, every expected agent
// was spawned by its subagent_type. The gate itself leaves no trace in the stream (the tool is absent in print mode),
// so being held at it is checked on disk by heldAtGate. A session that only wrote a file by itself would otherwise
// pass on the file check alone.
export function assertSkillRan(stream, { agents }) {
  const prefix = "the skill did not run";
  if (!pluginsLoaded(stream, ["doug-flow"])) return fail(`${prefix}: the init event's plugins did not name doug-flow`);
  if (!slashCommandPresent(stream, "doug-flow:doug-start")) return fail(`${prefix}: the init event's slash_commands did not carry doug-flow:doug-start`);
  const spawned = agentSpawns(stream);
  const missing = agents.filter((a) => !spawned.has(a));
  if (missing.length) return fail(`${prefix}: the stream never spawned ${missing.join(", ")} (spawned: ${[...spawned].join(", ") || "none"})`);
  return pass("the skill ran: plugin loaded, command present, agents spawned");
}

// Held at the gate: no later phase's file exists and the session made no commit. `head` is HEAD when the session
// started (runSessionStage records it; the acts between sessions commit, so the fixture baseline cannot serve);
// a caller that passes none gets the file check only.
function heldAtGate({ dir, head }, later) {
  const written = later.filter((rel) => existsSync(join(dir, rel)));
  if (written.length) return fail(`the session ran past its gate: ${written.join(", ")} was written`);
  if (head) {
    let now;
    try {
      now = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
    } catch (err) {
      return fail(`git rev-parse HEAD failed: ${err.message}`);
    }
    if (now !== head) return fail(`the session ran past its gate: it made a commit (HEAD ${head.slice(0, 7)} -> ${now.slice(0, 7)})`);
  }
  return pass("held at the gate");
}

// A session stage's assert: the stream proof, then held-at-gate state (nothing later written, no commit), then the
// stage's own file check. `later` lists the files of the phases after this one.
function afterSkillRan(agents, filesCheck, later = []) {
  return (ctx) => {
    const ran = assertSkillRan(ctx.stream, { agents });
    if (!ran.ok) return ran;
    const held = heldAtGate(ctx, typeof later === "function" ? later(ctx) : later);
    return held.ok ? filesCheck(ctx) : held;
  };
}

// The pending decision proposals (`memory.mjs decision propose` writes <ts>/NN-decision.diff under .doug/.state/learn/).
// docs/decisions/** is proposal-only, so a project-mode Architecture session leaves one of these and never the ADR.
function pendingDecisionProposals(dir) {
  const root = join(dir, ".doug/.state/learn");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((d) => (existsSync(join(root, d)) && readdirSync(join(root, d)).filter((f) => /-decision\.diff$/.test(f)).map((f) => join(root, d, f))) || []);
}

function boardCards(dir) {
  return JSON.parse(readFileSync(join(dir, BOARD_RELPATH), "utf8")).cards || [];
}

function stopGateCommands(dir) {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
    return Array.isArray(cfg?.stopGate?.commands) ? cfg.stopGate.commands : [];
  } catch {
    return [];
  }
}

// The start scenario's end: a board with walking-skeleton Done and at least one other card, and every
// gate passes in the project (its own verify.mjs --no-credit exits 0), so the gates check something green.
function assertStartEnded(dir) {
  let cards = [];
  try {
    cards = boardCards(dir);
  } catch (err) {
    return fail(`cannot read the board: ${err.message}`);
  }
  const skeleton = cards.find((c) => c.id === "walking-skeleton");
  if (!skeleton || skeleton.column !== "done") return fail("the walking-skeleton card is not in Done on the board");
  if (!cards.some((c) => c.id !== "walking-skeleton")) return fail("the board has no card besides walking-skeleton");
  const commands = stopGateCommands(dir);
  if (!commands.length) return fail(".doug/config.json stopGate.commands is empty");
  // Run the gate the way Doug does: the fixture's own vendored verify.mjs (doug init copies it), which resolves each
  // stopGate entry (a package script name such as "test", or a shell command) exactly as the Stop gate does.
  const verify = join(dir, ".doug/hooks/scripts/verify.mjs");
  if (!existsSync(verify)) return fail(".doug/hooks/scripts/verify.mjs is missing from the project; doug init should have vendored it");
  const r = spawnSync(process.execPath, [verify, "--no-credit", "--dir", dir], { cwd: dir, encoding: "utf8", timeout: 600000, env: commandEnv(cleanEnv()) });
  if (r.status !== 0) return fail(`verify.mjs --no-credit exited ${r.status === null ? `by signal ${r.signal}` : r.status}: ${((r.stdout || "") + (r.stderr || "")).trim().slice(-600) || "(no output)"}`);
  // verify.mjs's last "gate: <command> <exit>; ..." line, without the prefix, is the run's gate for the record.
  const gateLines = (r.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("gate: "));
  const gate = gateLines.length ? gateLines[gateLines.length - 1].slice("gate: ".length).trim() : null;
  return pass(`the board has ${cards.length} card(s) and the gate (verify.mjs, ${commands.length} command(s)) exits 0`, gate ? { gate } : {});
}

// The start-feature scenario's end: the spec, the architecture, and a plan that is still a draft (approval is the
// user's, through /doug-approve, never the skill's).
function assertFeatureEnded(dir, id = "fix-hours") {
  for (const rel of [`docs/specs/${id}/spec.md`, `docs/specs/${id}/architecture.md`, ".doug/plan.json"]) {
    if (!existsSync(join(dir, rel))) return fail(`${rel} was not written`);
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(join(dir, ".doug/plan.json"), "utf8"));
  } catch (err) {
    return fail(`.doug/plan.json is not valid JSON: ${err.message}`);
  }
  if (plan.status === "approved") return fail("the plan is already approved; the skill must leave approval to /doug-approve");
  const validate = act(PLAN_MJS, ["validate"], dir);
  if (!validate.ok) return fail(`plan.mjs validate failed: ${validate.stderr || validate.stdout}`);
  if (plan.card !== id) return fail(`the plan's card is ${JSON.stringify(plan.card)}, not ${JSON.stringify(id)}`);
  // Not checked: that every file architecture.md names is owned by a task. architecture.md is free prose with no
  // machine-readable files list, and a file it only mentions (read, not changed) would fail a correct paid run.
  return pass(`spec, architecture, and a ${plan.status || "draft"} plan exist`);
}

// ---- Card fixture-repo-scenarios: asserts and helpers for the init, board, memory, decide and swarm-skill scenarios ----

// node <script> <args...>, synchronously, with the runner's clean environment. Unlike act(), the directory is not
// appended: the caller places it. status is the exit code (null when the process was killed).
function spawnNode(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: cleanEnv(), timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// doug init's result: CLAUDE.md written and a .doug/config.json whose stopGate.commands names at least one gate command.
export function assertInitialized(dir) {
  if (!existsSync(join(dir, "CLAUDE.md"))) return fail("CLAUDE.md was not written");
  if (!stopGateCommands(dir).length) return fail(".doug/config.json has no stopGate.commands (missing or empty)");
  return pass(`initialized: CLAUDE.md written and ${stopGateCommands(dir).length} stopGate command(s) detected`);
}

// memory.mjs recall <query> --json must return a lesson whose text contains expectText.
export function assertRecalled(dir, { query, expectText }) {
  const r = spawnNode(MEMORY_MJS, ["recall", query, dir, "--json"]);
  if (r.status !== 0) return fail(`memory.mjs recall exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch (err) {
    return fail(`memory.mjs recall --json printed no JSON: ${err.message}`);
  }
  const lessons = Array.isArray(result && result.lessons) ? result.lessons : [];
  const hit = lessons.find((l) => typeof l.text === "string" && l.text.includes(expectText));
  return hit ? pass(`recall found lesson ${hit.id} (${result.mode})`) : fail(`recall for ${JSON.stringify(query)} returned ${lessons.length} lesson(s), none containing ${JSON.stringify(expectText)}`);
}

// The live lessons in the store at `dir`, as memory.mjs lessons --json lists them.
function memoryLessons(dir) {
  const r = spawnNode(MEMORY_MJS, ["lessons", dir, "--json"]);
  if (r.status !== 0) throw new Error(`memory.mjs lessons exited ${r.status}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

// One memory.mjs command that spawns claude itself: the runner's binary and cap go on as --claude-bin and --max-usd.
// cost is the call's measured usd from the --json result, or null.
function memoryCommand(args, { dir, claudeBin, capUsd }) {
  const flags = ["--json"];
  if (claudeBin) flags.push("--claude-bin", claudeBin);
  if (typeof capUsd === "number") flags.push("--max-usd", String(capUsd));
  const r = spawnNode(MEMORY_MJS, [...args, dir, ...flags]);
  let cost = null;
  try {
    const j = JSON.parse(r.stdout);
    if (j && typeof j.usd === "number") cost = j.usd;
  } catch {
    // no JSON result: the call failed before it printed one
  }
  return { ...r, cost };
}

// The path a proposal diff creates or changes: the `+++ <path>` line.
function diffTarget(diffFile) {
  const m = /^\+\+\+ (?:b\/)?(\S+)/m.exec(readFileSync(diffFile, "utf8"));
  return m ? m[1] : null;
}

// /doug-decide stopped at its apply/skip gate: a proposal diff is pending under .doug/.state/learn/ and the file it
// would write does not exist yet.
export function assertDecisionHeld(dir) {
  const pending = pendingDecisionProposals(dir);
  if (!pending.length) return fail("no pending decision proposal under .doug/.state/learn/: /doug-decide wrote no diff");
  for (const diff of pending) {
    const target = diffTarget(diff);
    if (!target) return fail(`cannot read the target path from ${diff}`);
    if (existsSync(join(dir, target))) return fail(`${target} already exists: the proposal was applied before the apply act`);
  }
  return pass(`held at the apply gate: ${pending.length} pending proposal(s), no ADR written`);
}

// /doug-swarm stopped at its plan approval: the flow gate's state (the card in flow and uncommitted, a valid draft plan,
// no worktree or branch, only the fixture commit), and the plan names the card and has swarm on.
export function assertSwarmGateHeld(dir, stream, opts) {
  const held = assertFlowGateHeld(dir, stream, opts);
  if (!held.ok) return held;
  let plan;
  try {
    plan = JSON.parse(readFileSync(join(dir, ".doug/plan.json"), "utf8"));
  } catch (err) {
    return fail(`.doug/plan.json is not valid JSON: ${err.message}`);
  }
  if (plan.swarm !== true) return fail("the plan does not have swarm on: /doug-swarm must plan with swarm true");
  if (plan.card !== opts.cardId) return fail(`the plan's card is ${JSON.stringify(plan.card)}, not ${JSON.stringify(opts.cardId)}`);
  // The shape gate keeps a task off the lead unless it owns two or more source files and is not size S. The test-file
  // predicate mirrors isTestFile in workflows/doug-implement.js (a test checks the two agree); a plan without a
  // splittable task costs the whole run stage.
  const isTestFile = (f) => /(^|\/)(test|tests|__tests__|spec)\//.test(f) || /\.test\.|\.spec\.|_test\.|Test\./.test(f.slice(f.lastIndexOf("/") + 1));
  const splittable = (plan.tasks || []).some((t) => t.size !== "S" && (t.files || []).filter((f) => !isTestFile(String(f))).length >= 2);
  if (!splittable) return fail("the plan has no task the shape gate will split: a swarm task needs two or more source files (not counting tests) and a size other than S, so the run would keep every task off the lead");
  return pass("gate held: the card is in flow, the swarm plan is a draft, and the session stopped at the approval gate");
}

// The card a stage works on: the stage context's card (ts-orders names its own; the ts-basic constants stand in when a
// caller passes none, as the tests that call a stage directly do), its owned files, and its held-out test.
function cardIdOf(ctx, fallback = "fix-hours") {
  return (ctx && ctx.card && ctx.card.id) || fallback;
}
function cardOf(ctx, id) {
  return (ctx && Array.isArray(ctx.cards) ? ctx.cards : []).find((c) => c.id === id) || null;
}
function ownedFilesOf(ctx, id, fallback) {
  const c = cardOf(ctx, id);
  return c ? c.files : fallback;
}
function heldOutOf(ctx, id, fallback) {
  const c = cardOf(ctx, id);
  return c && c.heldOut ? c.heldOut : fallback;
}

// ---- The three scenarios, stage by stage ------------------------------------------------------------------
// Each entry is a session stage (spawns `claude -p`, then asserts on the stream and the fixture) or an act stage
// (the runner performs the human gate's act, or a deterministic step like `plan.mjs land`, itself). A session
// stage's `prompt`/`assert` take `{ dir, card, baseline, stream }`; an act stage's `run` takes `{ dir, card,
// baseline }` and returns `{ ok, message, ...extra }` (`commit` when it lands or builds something).
export const SCENARIO_STAGES = {
  start: [
    {
      kind: "session",
      name: "idea",
      maxTurns: 25,
      prompt: () =>
        [
          "/doug-start",
          `Project mode. My idea: a tiny Node command-line tool, no dependencies, that converts durations such as "90m" or "1h30m" to seconds. Doug is not installed in this repo yet: first run \`node ${CLI} init . --yes --quiet\` (use that command wherever the skill says \`doug\`). Do only the Idea phase, then stop at its gate as the skill says; do not invoke the doug-board skill.`,
        ].join("\n\n"),
      assert: afterSkillRan(["doug-flow:spec-writer"], ({ dir }) => (existsSync(join(dir, "docs/product/idea.md")) ? pass("idea.md written") : fail("docs/product/idea.md was not written")), ["docs/product/architecture.md", "docs/decisions/0001-stack.md", "package.json", "docs/product/scope.md"]),
    },
    { kind: "act", name: "approve-idea", run: ({ dir }) => commitPhase(dir, "docs: idea") },
    {
      kind: "session",
      name: "architecture",
      maxTurns: 30,
      prompt: () =>
        [
          "/doug-start",
          `Project mode. I approved the idea (committed). The doug CLI here is \`node ${CLI}\`. Keep the stack to Node with the built-in \`node --test\` runner and no dependencies. Spawn one researcher with one question answerable offline: what \`node --test\` does in the installed Node (its \`--version\` and \`--help\`, no web). Then spawn the project's architect agent as the skill says; the stack ADR goes through the proposal path and is not applied by you. Do only the Architecture phase, then stop at its gate as the skill says.`,
        ].join("\n\n"),
      assert: afterSkillRan(
        ["doug-flow:researcher", "architect"],
        ({ dir }) => {
          if (!existsSync(join(dir, "docs/product/architecture.md"))) return fail("docs/product/architecture.md was not written");
          return pendingDecisionProposals(dir).length ? pass("architecture.md written and the stack ADR is a pending proposal") : fail("no pending decision proposal under .doug/.state/learn/: the ADR must go through memory.mjs decision propose");
        },
        // docs/decisions/0001-stack.md exists only once the proposal is applied, which is the human's yes (the act below).
        ["docs/decisions/0001-stack.md", "package.json", "docs/product/scope.md"],
      ),
    },
    {
      kind: "act",
      name: "approve-architecture",
      run: ({ dir }) => {
        // Standing in for the human's yes to the stack ADR proposal: apply it, then commit (docs/decisions/** is proposal-only).
        const pending = pendingDecisionProposals(dir);
        if (pending.length !== 1) return fail(`expected exactly one pending decision proposal under .doug/.state/learn/, found ${pending.length}`);
        const applied = act(LEARN_MJS, ["apply", pending[0]], dir);
        if (!applied.ok) return fail(`learn.mjs apply failed: ${applied.stderr || applied.stdout}`);
        return commitPhase(dir, "docs: architecture");
      },
    },
    {
      kind: "session",
      name: "skeleton",
      maxTurns: 60,
      prompt: () =>
        [
          "/doug-start",
          `Project mode. I approved the architecture (committed). The doug CLI here is \`node ${CLI}\`. Do only the Walking skeleton phase, keeping it tiny: a package.json with a "test" script running \`node --test\`, one source file, one passing test. Then re-run \`node ${CLI} init . --yes --quiet\` so the gate commands are detected, then stop at its gate as the skill says. Do not move the walking-skeleton card to Done: that is the approval, which I give. Do not invoke the doug-board skill.`,
        ].join("\n\n"),
      assert: afterSkillRan(["tester", "coder", "reviewer"], ({ dir }) => {
        if (!existsSync(join(dir, "package.json"))) return fail("no package.json: the walking skeleton was not built");
        if (!stopGateCommands(dir).length) return fail(".doug/config.json stopGate.commands is empty after the skeleton");
        let skeleton;
        try {
          skeleton = boardCards(dir).find((c) => c.id === "walking-skeleton");
        } catch (err) {
          return fail(`cannot read the board: ${err.message}`);
        }
        if (!skeleton) return fail("the walking-skeleton card is not on the board");
        // Done is the approval's act (approve-skeleton), so a Done card here means the session ran past its gate.
        return skeleton.column !== "done" ? pass("skeleton built, stopGate.commands detected, walking-skeleton waiting at the gate") : fail("the walking-skeleton card is already Done: the session ran past its gate");
      }, ["docs/product/scope.md"]),
    },
    {
      kind: "act",
      name: "approve-skeleton",
      run: ({ dir }) => {
        // Standing in for the human's yes: Done on the board, then commit the skeleton with it.
        const moved = act(BOARD_MJS, ["move", "walking-skeleton", "done"], dir);
        if (!moved.ok) return fail(`board.mjs move walking-skeleton done failed: ${moved.stderr || moved.stdout}`);
        return commitPhase(dir, "feat: walking skeleton");
      },
    },
    {
      kind: "session",
      name: "scope",
      maxTurns: 30,
      prompt: () =>
        [
          "/doug-start",
          `Project mode. I approved the walking skeleton (committed). The doug CLI here is \`node ${CLI}\`. Do only the Scope phase. I approve in advance the card list the spec-writer returns, as long as it has two or three cards: add them with \`node ${CLI} board add\`, then stop at its gate as the skill says.`,
        ].join("\n\n"),
      assert: afterSkillRan(["doug-flow:spec-writer"], ({ dir }) => {
        if (!existsSync(join(dir, "docs/product/scope.md"))) return fail("docs/product/scope.md was not written");
        try {
          return boardCards(dir).some((c) => c.id !== "walking-skeleton") ? pass("scope.md written and cards added") : fail("no card besides walking-skeleton was added to the board");
        } catch (err) {
          return fail(`cannot read the board: ${err.message}`);
        }
      }),
    },
    {
      kind: "act",
      name: "approve-scope",
      run: ({ dir }) => {
        const committed = commitPhase(dir, "docs: scope");
        if (!committed.ok) return committed;
        return assertStartEnded(dir);
      },
    },
  ],
  "start-feature": [
    {
      kind: "session",
      name: "spec",
      maxTurns: 20,
      prompt: (ctx) => [`/doug-start ${cardIdOf(ctx)}`, "Do only the Specification phase, then stop at its gate as the skill says. Do not invoke the doug-board skill."].join("\n\n"),
      assert: afterSkillRan(["doug-flow:spec-writer"], (ctx) => (existsSync(join(ctx.dir, `docs/specs/${cardIdOf(ctx)}/spec.md`)) ? pass("spec.md written") : fail(`docs/specs/${cardIdOf(ctx)}/spec.md was not written`)), (ctx) => [`docs/specs/${cardIdOf(ctx)}/pseudocode.md`, `docs/specs/${cardIdOf(ctx)}/architecture.md`, ".doug/plan.json"]),
    },
    { kind: "act", name: "approve-spec", run: (ctx) => commitPhase(ctx.dir, `docs: ${cardIdOf(ctx)} spec`) },
    {
      kind: "session",
      name: "architecture",
      maxTurns: 30,
      prompt: (ctx) => [`/doug-start ${cardIdOf(ctx)}`, "I approved the spec (committed) and skipped Pseudocode. Do only the Architecture phase, then stop at its gate as the skill says."].join("\n\n"),
      assert: afterSkillRan(["architect"], (ctx) => (existsSync(join(ctx.dir, `docs/specs/${cardIdOf(ctx)}/architecture.md`)) ? pass("architecture.md written") : fail(`docs/specs/${cardIdOf(ctx)}/architecture.md was not written`)), [".doug/plan.json"]),
    },
    { kind: "act", name: "approve-architecture", run: (ctx) => commitPhase(ctx.dir, `docs: ${cardIdOf(ctx)} architecture`) },
    {
      kind: "session",
      name: "plan",
      maxTurns: 30,
      prompt: (ctx) => [`/doug-start ${cardIdOf(ctx)}`, "I approved the architecture (committed) and skipped Pseudocode. Do only the Refinement phase: write the draft plan, show it, then stop at its gate as the skill says. Do not approve the plan."].join("\n\n"),
      assert: afterSkillRan(["doug-flow:planner"], (ctx) => assertFeatureEnded(ctx.dir, cardIdOf(ctx))),
    },
  ],
  hand: [
    {
      kind: "session",
      name: "gate",
      maxTurns: 12,
      prompt: (ctx) => `/doug-next ${cardIdOf(ctx)}`,
      assert: (ctx) => assertGateHeld(ctx.dir, ctx.stream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: cardIdOf(ctx), unchangedFiles: [ownedFilesOf(ctx, cardIdOf(ctx), ["src/duration.ts"])[0]] }),
    },
    {
      kind: "act",
      name: "start-gate",
      run: (ctx) => {
        const { dir } = ctx;
        const id = cardIdOf(ctx);
        // task rehearse-uncommitted-move: the board move stays uncommitted working state (it lands only in the
        // card's landing commit), so this act no longer commits it.
        const move = act(BOARD_MJS, ["move", id, "flow"], dir);
        if (!move.ok) return fail(`board.mjs move failed: ${move.stderr || move.stdout}`);
        // doug-hand step 2 stamps the landing's condition before the brief (plugins/doug-flow/skills/doug-hand/SKILL.md):
        // `memory.mjs condition open <id>` writes .doug/.state/reports/<id>/condition.json, and refuses a classless
        // card or a dir with no git HEAD — the fixture already has a HEAD (its own baseline commit) regardless of
        // the uncommitted move above. `act()` passes `dir` positionally and spawns with cleanEnv(), so this writes
        // into the fixture, never this repository (dirFrom prefers CLAUDE_PROJECT_DIR, which cleanEnv scrubs, over
        // that positional argument).
        const condition = act(MEMORY_MJS, ["condition", "open", id], dir);
        if (!condition.ok) return fail(`memory.mjs condition open failed: ${condition.stderr || condition.stdout}`);
        return pass(`moved ${id} to In flow (uncommitted) and opened its condition, standing in for the start gate`);
      },
    },
    {
      kind: "session",
      name: "build",
      maxTurns: 60,
      prompt: (ctx) =>
        [
          `/doug-next ${cardIdOf(ctx)}`,
          "I answered Start at the start gate and moved the card to In flow myself (it is uncommitted), and I chose by hand. Do not invoke the doug-board skill at any step: this checkout publishes nothing. Do the doug-hand skill's steps 3 and 4, then stop before step 5: do not suggest follow-up cards and do not ask the continue gate.",
        ].join("\n\n"),
      assert: (ctx) => assertHandBuilt(ctx),
    },
  ],
  auto: [
    {
      kind: "session",
      name: "gate",
      maxTurns: 20,
      prompt: () => "/doug-next --auto",
      assert: ({ dir, stream, cards }) => assertAutoGateHeld(dir, stream, { cards }),
    },
    {
      kind: "session",
      name: "build",
      maxTurns: 140,
      prompt: ({ cards } = {}) => autoBuildPrompt(cards),
      assert: (ctx) => assertAutoBuilt(ctx),
    },
  ],
  parallel: [
    {
      kind: "session",
      name: "gate",
      maxTurns: 20,
      prompt: () => "/doug-next --auto",
      assert: ({ dir, stream, cards }) => assertParallelGateHeld(dir, stream, { cards }),
    },
    {
      kind: "session",
      name: "build",
      maxTurns: 160,
      prompt: ({ cards } = {}) => autoBuildPrompt(cards),
      assert: (ctx) => assertParallelBuilt(ctx),
    },
  ],
  flow: [
    {
      kind: "session",
      name: "gate",
      maxTurns: 30,
      prompt: (ctx) => `/doug-next ${cardIdOf(ctx)}`,
      assert: (ctx) => assertFlowGateHeld(ctx.dir, ctx.stream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: cardIdOf(ctx) }),
    },
    {
      kind: "act",
      name: "approve",
      run: (ctx) => {
        const { dir } = ctx;
        const id = cardIdOf(ctx);
        const setCard = act(PLAN_MJS, ["set", "card", id], dir);
        if (!setCard.ok) return fail(`plan.mjs set card failed: ${setCard.stderr || setCard.stdout}`);
        let plan = null;
        try {
          plan = JSON.parse(readFileSync(join(dir, ".doug/plan.json"), "utf8"));
        } catch {
          // approve below reports the same problem
        }
        const owned = new Set((plan && plan.tasks ? plan.tasks : []).flatMap((t) => t.files || []));
        const expected = ownedFilesOf(ctx, id, ["src/duration.ts", "tests/duration.test.ts"]);
        const outOfScope = [...owned].filter((f) => !expected.includes(f));
        const approve = act(PLAN_MJS, ["approve"], dir);
        if (!approve.ok) return fail(`plan.mjs approve failed: ${approve.stderr || approve.stdout}`);
        return pass(outOfScope.length ? `approved; the plan also owns ${outOfScope.join(", ")} (noted, not blocking)` : "approved");
      },
    },
    {
      kind: "session",
      name: "implement",
      maxTurns: 40,
      prompt: () => ["/doug-implement", "When the run completes, write the `result` object of the Workflow tool's output to .doug/.state/last-report.json with the Write tool, then reply done."].join("\n\n"),
      assert: ({ dir, stream }) => assertImplemented(dir, stream, { plugins: ["doug-flow"] }),
    },
    {
      kind: "act",
      name: "land",
      run: (ctx) => landAndVerify(ctx.dir, heldOutOf(ctx, cardIdOf(ctx), undefined)),
    },
  ],
  swarm: [
    {
      kind: "session",
      name: "implement",
      maxTurns: 40,
      prompt: () => ["/doug-implement", "When the run completes, write the `result` object of the Workflow tool's output to .doug/.state/last-report.json with the Write tool, then reply done."].join("\n\n"),
      assert: ({ dir, stream }) => assertImplemented(dir, stream, { plugins: ["doug-flow"], requireWorkers: true }),
    },
    {
      kind: "act",
      name: "land",
      run: (ctx) => landAndVerify(ctx.dir, heldOutOf(ctx, cardIdOf(ctx, SWARM_TASK_ID), { id: SWARM_TASK_ID, file: SWARM_HELDOUT_FILE })),
    },
  ],
  // ---- Card fixture-repo-scenarios: the command paths that had no scenario. They run on ts-orders. ---------------
  // init: doug init is a CLI that needs no model. Without --yes and without a TTY it writes nothing and exits 2.
  init: [
    {
      kind: "act",
      name: "refuse",
      run: ({ dir }) => {
        const r = spawnNode(CLI, ["init", dir]);
        const text = `${r.stdout}${r.stderr}`;
        if (r.status !== 2) return fail(`doug init without --yes and without a TTY exited ${r.status}, not 2: ${text.trim().slice(0, 300)}`);
        if (!text.includes("Not a TTY and --yes not given. Nothing written.")) return fail(`doug init did not print "Not a TTY and --yes not given. Nothing written.": ${text.trim().slice(0, 300)}`);
        for (const rel of [".doug", "CLAUDE.md"]) if (existsSync(join(dir, rel))) return fail(`doug init refused but ${rel} exists: it wrote something`);
        return pass("refused with exit 2 and wrote nothing");
      },
    },
    {
      kind: "act",
      name: "init",
      run: ({ dir }) => {
        const r = spawnNode(CLI, ["init", dir, "--yes", "--quiet"]);
        if (r.status !== 0) return fail(`doug init --yes --quiet exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(0, 400)}`);
        return assertInitialized(dir);
      },
    },
    {
      kind: "act",
      name: "doctor",
      run: ({ dir }) => {
        const r = spawnNode(CLI, ["doctor", dir]);
        return r.status === 0 ? pass(`doug doctor exited 0: ${r.stdout.trim().split("\n").pop()}`) : fail(`doug doctor exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(-500)}`);
      },
    },
    {
      kind: "act",
      name: "reinit",
      run: ({ dir }) => {
        const before = readFileSync(join(dir, "CLAUDE.md"), "utf8");
        const r = spawnNode(CLI, ["init", dir, "--yes", "--quiet"]);
        if (r.status !== 0) return fail(`a second doug init --yes exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(0, 400)}`);
        if (readFileSync(join(dir, "CLAUDE.md"), "utf8") !== before) return fail("a second doug init changed CLAUDE.md");
        return assertInitialized(dir);
      },
    },
  ],
  // board: the doug board CLI and the served page, offline.
  board: [
    {
      kind: "act",
      name: "list",
      run: ({ dir }) => {
        const r = spawnNode(CLI, ["board", "list", dir, "--json"]);
        if (r.status !== 0) return fail(`doug board list exited ${r.status}: ${r.stderr.trim()}`);
        const missing = ordersSuite().rehearsal.background.map((c) => c.id).filter((id) => !r.stdout.includes(`"${id}"`));
        return missing.length ? fail(`doug board list does not name ${missing.join(", ")}`) : pass("doug board list names every background card");
      },
    },
    {
      kind: "act",
      name: "next",
      run: ({ dir }) => {
        // The background board holds no Ready card, so `next` finds none and exits 1 saying so; the round-trip act below
        // promotes a scratch card and `next` names it.
        const r = spawnNode(CLI, ["board", "next", dir]);
        const text = `${r.stdout}${r.stderr}`;
        return r.status === 1 && text.includes("No Ready card") ? pass("doug board next found no Ready card") : fail(`doug board next on a board with no Ready card exited ${r.status}: ${text.trim().slice(0, 300)}`);
      },
    },
    {
      kind: "act",
      name: "round-trip",
      run: ({ dir }) => {
        const board = (...args) => spawnNode(CLI, ["board", ...args, dir]);
        const snapshot = () => {
          const b = JSON.parse(readFileSync(join(dir, BOARD_RELPATH), "utf8"));
          delete b.updated;
          return JSON.stringify(b);
        };
        const before = snapshot();
        const steps = [
          ["add", "scratch-card", "--title", "Scratch", "--goal", "A scratch card for the round trip.", "--component", "store", "--size", "S", "--class", "code", "--column", "backlog"],
          ["edit", "scratch-card", "--title", "Scratch edited"],
          ["reorder", "scratch-card", "--top"],
          ["move", "scratch-card", "ready"],
        ];
        for (const args of steps) {
          const r = board(...args);
          if (r.status !== 0) return fail(`doug board ${args[0]} exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
        }
        const next = board("next");
        if (next.status !== 0 || !next.stdout.includes("scratch-card")) return fail(`doug board next did not name the promoted scratch card (exit ${next.status}): ${(next.stdout + next.stderr).trim().slice(0, 300)}`);
        const removed = board("remove", "scratch-card");
        if (removed.status !== 0) return fail(`doug board remove exited ${removed.status}: ${(removed.stdout + removed.stderr).trim().slice(0, 300)}`);
        return snapshot() === before ? pass("add, edit, reorder, move and remove left the board as it started") : fail("the board differs from how it started after the round trip");
      },
    },
    {
      kind: "act",
      name: "build",
      run: ({ dir }) => {
        const out = join(dir, ".doug/.state/scratch/board.html");
        mkdirSync(dirname(out), { recursive: true });
        const r = spawnNode(CLI, ["board", "build", dir, "--out", out]);
        if (r.status !== 0) return fail(`doug board build exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
        const html = readFileSync(out, "utf8");
        const missing = ordersSuite().rehearsal.background.map((c) => c.id).filter((id) => !html.includes(id));
        return missing.length ? fail(`the built page does not name ${missing.join(", ")}`) : pass("the built page names every background card");
      },
    },
    {
      kind: "act",
      name: "serve",
      run: ({ dir }) => {
        const started = spawnNode(CLI, ["board", "serve", dir, "--detach", "--port", "0"]);
        if (started.status !== 0) return fail(`doug board serve --detach exited ${started.status}: ${(started.stdout + started.stderr).trim().slice(0, 300)}`);
        let message = null;
        try {
          const url = /https?:\/\/[^\s]+/.exec(started.stdout);
          if (!url) message = `doug board serve --detach printed no URL: ${started.stdout.trim()}`;
          else {
            const probe = spawnNode("-e", [`fetch(process.argv[1]).then((r) => { console.log(r.status); }, (e) => { console.log("error " + e.message); })`, url[0]]);
            if (probe.stdout.trim() !== "200") message = `GET ${url[0]} answered ${probe.stdout.trim() || probe.stderr.trim()}, not 200`;
          }
        } finally {
          // Always stop the server, whatever the probe found: a rehearsal never leaves one running.
          const stopped = spawnNode(CLI, ["board", "serve", dir, "--stop"]);
          if (stopped.status !== 0) message = `${message ? `${message}; ` : ""}doug board serve --stop exited ${stopped.status}: ${(stopped.stdout + stopped.stderr).trim().slice(0, 300)}`;
        }
        return message ? fail(message) : pass("the served page answered 200 and --stop ended it");
      },
    },
  ],
  // memory: recall makes no model call; reflect, model regen and ideas each make one cheap-row call through
  // memory.mjs, so they are command stages (the runner's claude binary and the stage's cap go through
  // --claude-bin and --max-usd, never the ambient defaults).
  memory: [
    {
      kind: "act",
      name: "recall",
      run: ({ dir }) => {
        const { recallQuery, expectText } = ordersSuite().rehearsal.memory;
        return assertRecalled(dir, { query: recallQuery, expectText });
      },
    },
    {
      kind: "command",
      name: "reflect",
      run: (ctx) => {
        const { dir } = ctx;
        const { expectText } = ordersSuite().rehearsal.memory;
        const listed = memoryLessons(dir);
        const target = listed.find((l) => l.text.includes(expectText)) || listed[0];
        if (!target) return fail("the memory store holds no lesson to credit");
        const reportFile = join(dir, ".doug/.state/scratch/memory-report.json");
        mkdirSync(dirname(reportFile), { recursive: true });
        // A minimal workflow report: one verified task that was given the seeded lesson, so reflect credits it.
        writeFileSync(reportFile, JSON.stringify({ ok: true, plan: "memory rehearsal", levels: [{ index: 0, tasks: [{ id: "memory-rehearsal", verified: true, reviewed: true, passes: 1, memoryUsed: [target.id], ledger: [] }] }] }, null, 2) + "\n");
        const r = memoryCommand(["reflect", reportFile], ctx);
        if (r.status !== 0) return fail(`memory.mjs reflect exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(-400)}`, r.cost);
        const after = memoryLessons(dir).find((l) => l.id === target.id);
        if (!after || after.helpful <= target.helpful) return fail(`lesson ${target.id}'s helpful count did not rise (${target.helpful} -> ${after ? after.helpful : "gone"})`, r.cost);
        return pass(`reflect credited lesson ${target.id} (helpful ${target.helpful} -> ${after.helpful})`, { cost: r.cost });
      },
    },
    {
      kind: "command",
      name: "model-regen",
      run: (ctx) => {
        const r = memoryCommand(["model", "regen"], ctx);
        if (r.status !== 0) return fail(`memory.mjs model regen exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(-400)}`, r.cost);
        const file = join(ctx.dir, ".doug/project-model.md");
        if (!existsSync(file) || readFileSync(file, "utf8").trim().length === 0) return fail(".doug/project-model.md is missing or empty after model regen", r.cost);
        return pass("model regen wrote a non-empty .doug/project-model.md", { cost: r.cost });
      },
    },
    {
      kind: "command",
      name: "ideas",
      run: (ctx) => {
        const cardsOf = () => boardCards(ctx.dir);
        const before = cardsOf();
        const r = memoryCommand(["ideas"], ctx);
        if (r.status !== 0) return fail(`memory.mjs ideas exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(-400)}`, r.cost);
        const after = cardsOf();
        const readyBefore = JSON.stringify(before.filter((c) => c.column === "ready"));
        if (JSON.stringify(after.filter((c) => c.column === "ready")) !== readyBefore) return fail("memory.mjs ideas changed the Ready column", r.cost);
        const known = new Set(before.map((c) => c.id));
        const stray = after.filter((c) => !known.has(c.id) && c.column !== "backlog").map((c) => c.id);
        if (stray.length) return fail(`memory.mjs ideas filed ${stray.join(", ")} outside Backlog`, r.cost);
        return pass(`ideas filed ${after.length - before.length} card(s) to Backlog only`, { cost: r.cost });
      },
    },
  ],
  // decide: /doug-decide writes the proposal diff and stops at its apply/skip gate (AskUserQuestion is absent in
  // `claude -p`); the apply act answers it the way step 5 does.
  decide: [
    {
      kind: "session",
      name: "propose",
      maxTurns: 15,
      prompt: () => {
        const { title } = ordersSuite().rehearsal.decide;
        return [`/doug-decide decision "${title}" --file ${DECISION_BODY_RELPATH}`, "Stop at the apply/skip question as the skill says: do not apply the diff and do not commit."].join("\n\n");
      },
      assert: (ctx) => {
        if (!pluginsLoaded(ctx.stream, ["doug-flow"])) return fail("the init event's plugins did not name doug-flow");
        if (!slashCommandPresent(ctx.stream, "doug-flow:doug-decide")) return fail("the init event's slash_commands did not carry doug-flow:doug-decide");
        const held = heldAtGate(ctx, []);
        return held.ok ? assertDecisionHeld(ctx.dir) : held;
      },
    },
    {
      kind: "act",
      name: "apply",
      run: ({ dir }) => {
        const pending = pendingDecisionProposals(dir);
        if (pending.length !== 1) return fail(`expected exactly one pending decision proposal under .doug/.state/learn/, found ${pending.length}`);
        const applied = act(LEARN_MJS, ["apply", pending[0]], dir);
        if (!applied.ok) return fail(`learn.mjs apply failed: ${applied.stderr || applied.stdout}`);
        const target = diffTarget(pending[0]);
        if (!target || !existsSync(join(dir, target))) return fail(`learn.mjs apply exited 0 but ${target || "the proposal's target"} does not exist`);
        return pass(`applied: ${target}`);
      },
    },
  ],
  // swarm-skill: /doug-swarm <card> plans with swarm on and stops at the plan approval (AskUserQuestion is absent in
  // `claude -p`); the approve act answers it as /doug-next's step 3 does, and a second session runs, lands and moves
  // the card to Done.
  "swarm-skill": [
    {
      kind: "session",
      name: "gate",
      maxTurns: 40,
      prompt: (ctx) => [`/doug-swarm ${cardIdOf(ctx)}`, "Do sections 1 to 3 only: pick the card, plan it with swarm on, show the plan, then stop at the approval gate as the skill says. Do not invoke the doug-board skill."].join("\n\n"),
      assert: (ctx) => assertSwarmGateHeld(ctx.dir, ctx.stream, { plugins: ["doug-flow"], command: "doug-flow:doug-swarm", cardId: cardIdOf(ctx) }),
    },
    {
      kind: "act",
      name: "approve",
      run: ({ dir }) => {
        const approve = act(PLAN_MJS, ["approve"], dir);
        if (!approve.ok) return fail(`plan.mjs approve failed: ${approve.stderr || approve.stdout}`);
        const anchor = act(PLAN_MJS, ["anchor"], dir);
        if (!anchor.ok) return fail(`plan.mjs anchor failed: ${anchor.stderr || anchor.stdout}`);
        return pass("approved and anchored the plan");
      },
    },
    {
      kind: "session",
      name: "run",
      maxTurns: 80,
      prompt: (ctx) =>
        [
          `/doug-swarm ${cardIdOf(ctx)}`,
          "I approved the plan as shown and anchored it (it is .doug/plan.json, approved, swarm on). Resume at section 4: run swarm-launch, save the result object to .doug/.state/last-report.json, then land as section 5 says (plan.mjs done, plan.mjs land, the card to Done with the merge commit). Do not invoke the doug-board or run-report skill, and stop before section 6: file no follow-up cards and do not ask the continue gate.",
        ].join("\n\n"),
      assert: (ctx) => {
        const id = cardIdOf(ctx);
        const done = assertImplemented(ctx.dir, ctx.stream, { plugins: ["doug-flow"], requireWorkers: true });
        if (!done.ok) return done;
        let card;
        try {
          card = boardCards(ctx.dir).find((c) => c.id === id);
        } catch (err) {
          return fail(`cannot read the board: ${err.message}`);
        }
        if (!card || card.column !== "done") return fail(`the fixture board does not have ${id} in done`);
        const merged = assertTwoParents(ctx.dir);
        if (!merged.ok) return merged;
        if (!card.source || !String(card.source).includes(merged.commit.slice(0, 7))) return fail(`${id}'s source does not name the merge commit ${merged.commit} (source: ${card.source || "none"})`);
        const held = runHeldOutAndClean(ctx.dir, heldOutOf(ctx, id, undefined));
        return held.ok ? pass(`swarmed and landed as ${merged.commit}`, { commit: merged.commit }) : held;
      },
    },
  ],
};

// The hand scenario's build assertion (card workflow-rehearsal-review #1): doug-hand's own step 4.3 commits the
// board and docs/live-runs.md AFTER the code commit ("Board: <id> done as <sha>"), so HEAD is that board commit,
// not the code commit — take every commit since the fixture's recorded baseline instead of assuming HEAD is it,
// require that one of them changes both owned files, and require the board's `source` to name THAT commit.
export function assertHandBuilt(ctx) {
  const { dir, baseline } = ctx;
  const id = cardIdOf(ctx);
  const owned = ownedFilesOf(ctx, id, ["src/duration.ts", "tests/duration.test.ts"]);
  if (!baseline) return fail("no baseline commit was recorded for this fixture");
  let shas;
  try {
    shas = execFileSync("git", ["rev-list", `${baseline}..HEAD`], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim().split("\n").filter(Boolean);
  } catch (err) {
    return fail(`git rev-list failed: ${err.message}`);
  }
  if (!shas.length) return fail("no commits since the fixture baseline; the build never committed");
  let codeCommit = null;
  for (const sha of shas) {
    const files = execFileSync("git", ["show", "--name-only", "--pretty=format:", sha], { cwd: dir, encoding: "utf8", env: cleanEnv() }).split("\n").filter(Boolean);
    if (owned.every((f) => files.includes(f))) {
      codeCommit = sha;
      break;
    }
  }
  if (!codeCommit) return fail(`no commit since the fixture baseline changes both ${owned.join(" and ")} (commits since baseline: ${shas.join(", ")})`);
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  } catch (err) {
    return fail(`could not read the fixture board: ${err.message}`);
  }
  const card = (board.cards || []).find((c) => c.id === id);
  if (!card || card.column !== "done") return fail(`the fixture board does not have ${id} in done`);
  if (!card.source || !String(card.source).includes(codeCommit.slice(0, 7))) return fail(`${id}'s source does not name the code commit ${codeCommit} (source: ${card.source || "none"})`);
  const runs = existsSync(join(dir, "docs/live-runs.md")) ? readFileSync(join(dir, "docs/live-runs.md"), "utf8") : "";
  if (!runs.includes(`\`${id}\``) || !runs.includes("hand track: a gated by-hand change")) return fail(`docs/live-runs.md carries no hand-track entry for ${id} (board.mjs record --hand did not run)`);
  const held = runHeldOutAndClean(dir, heldOutOf(ctx, id, undefined));
  if (!held.ok) return held;
  return pass(`built as ${codeCommit}`, { commit: codeCommit });
}

// The auto scenario's two cards, in board order: what each one's build must change and which held-out test checks it.
const AUTO_CARDS = [
  { id: "fix-hours", size: "S", class: "code", files: ["src/duration.ts", "tests/duration.test.ts"], heldOut: { id: "fix-hours", file: HELDOUT_FILE } },
  { id: "add-truncate", size: "S", class: "code", files: ["src/strings.ts", "tests/strings.test.ts"], heldOut: { id: "add-truncate", file: join(ROOT, "evals/heldout/add-truncate.test.ts") } },
];

// The auto scenario's gate stage: a bare `/doug-next --auto` shows the queue and asks its one approval, which is denied
// in print mode, so both cards are still Ready, only the fixture commit exists, and no source file was touched.
// The auto scenario's Ready hand cards and its Backlog card: the ts-orders descriptor's when the fixture names them,
// else the ts-basic constants.
// The auto and parallel build prompt: the fresh build session never showed the queue, so name the approved Ready cards
// (board order) and the caps autopilot proposes for them (wallCapMinutes and usdCapDollars, as board.mjs next --batch prints).
function autoBuildPrompt(cards) {
  const queue = Array.isArray(cards) && cards.length ? cards.filter((c) => c.column === "ready") : AUTO_CARDS;
  const ids = queue.map((c) => c.id).join(", ");
  return [
    "/doug-next --auto",
    `I approved the queue ${ids} (board order) with a wall cap of ${wallCapMinutes(queue)} min and a USD cap of $${usdCapDollars(queue).toFixed(2)}; unlimited autopilot has no card cap. I gave that approval before this session, so this session has not shown the queue: do not ask again, start the queue now. Do not invoke the doug-board skill at any step: this checkout publishes nothing.`,
  ].join("\n\n");
}
function autoReadyCards(cards) {
  return Array.isArray(cards) && cards.length ? cards.filter((c) => c.column === "ready").map((c) => ({ id: c.id, files: c.files, heldOut: c.heldOut })) : AUTO_CARDS;
}
function autoBacklogCard(cards) {
  const b = Array.isArray(cards) ? cards.find((c) => c.column === "backlog") : null;
  return b ? { id: b.id, goal: b.goal } : AUTO_BACKLOG_CARD;
}

export function assertAutoGateHeld(dir, stream, { cards } = {}) {
  const ready = autoReadyCards(cards);
  for (const c of ready) {
    const held = assertGateHeld(dir, stream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: c.id, unchangedFiles: ready.flatMap((x) => x.files.slice(0, 1)) });
    if (!held.ok) return held;
  }
  return pass("gate held: the queue approval was not given, and both cards are untouched");
}

// Tool names the stream's assistant messages called.
function toolUseNames(stream) {
  const names = [];
  for (const j of jsonLines(stream)) {
    const content = j && j.type === "assistant" && j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) if (c && c.type === "tool_use" && c.name) names.push(c.name);
  }
  return names;
}

// What the card's queen reported when it stopped (reason, seat, detail), or "" when no card-report.json says so.
function queenStopNote(dir, id) {
  try {
    const r = JSON.parse(readFileSync(join(dir, ".doug/.state/reports", id, "card-report.json"), "utf8"));
    if (!r || r.ok === true || !r.reason) return "";
    return `card ${id} queen stopped: ${r.reason}${r.stoppedAt ? ` at ${r.stoppedAt}` : ""}${r.detail ? ` (${r.detail})` : ""}; `;
  } catch {
    return "";
  }
}

// The auto scenario's build assertion: doug-hand's landing for EACH card (a code commit changing that card's source
// and test files, the card Done with a `source` naming it, a hand-track entry in docs/live-runs.md, its held-out
// test passing), and no AskUserQuestion in the stream: a gate prompt between the cards is exactly what autopilot
// must not do. Never throws on a missing piece; every miss names the card.
export function assertAutoBuilt({ dir, baseline, stream, cards }) {
  const ready = autoReadyCards(cards);
  const backlogCard = autoBacklogCard(cards);
  if (!baseline) return fail("no baseline commit was recorded for this fixture");
  if (toolUseNames(stream).includes("AskUserQuestion")) return fail("the build stream carries an AskUserQuestion tool_use: autopilot asked a question between or within the cards");
  let shas;
  try {
    shas = execFileSync("git", ["rev-list", `${baseline}..HEAD`], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim().split("\n").filter(Boolean);
  } catch (err) {
    return fail(`git rev-list failed: ${err.message}`);
  }
  if (!shas.length) return fail("no commits since the fixture baseline; the build never committed");
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  } catch (err) {
    return fail(`could not read the fixture board: ${err.message}`);
  }
  const runs = existsSync(join(dir, "docs/live-runs.md")) ? readFileSync(join(dir, "docs/live-runs.md"), "utf8") : "";
  const backlog = (board.cards || []).find((x) => x.id === backlogCard.id);
  if (!backlog || backlog.column !== "backlog" || backlog.goal !== backlogCard.goal) return fail(`the Backlog card ${backlogCard.id} was moved or changed: unlimited autopilot must take Ready cards only`);
  const commits = [];
  for (const c of ready) {
    let codeCommit = null;
    for (const sha of shas) {
      const files = execFileSync("git", ["show", "--name-only", "--pretty=format:", sha], { cwd: dir, encoding: "utf8", env: cleanEnv() }).split("\n").filter(Boolean);
      if (c.files.every((f) => files.includes(f))) {
        codeCommit = sha;
        break;
      }
    }
    if (!codeCommit) return fail(`${queenStopNote(dir, c.id)}no commit since the fixture baseline changes both ${c.files.join(" and ")} (card ${c.id}; commits since baseline: ${shas.join(", ")})`);
    const card = (board.cards || []).find((x) => x.id === c.id);
    if (!card || card.column !== "done") return fail(`the fixture board does not have ${c.id} in done`);
    if (!card.source || !String(card.source).includes(codeCommit.slice(0, 7))) return fail(`${c.id}'s source does not name the code commit ${codeCommit} (source: ${card.source || "none"})`);
    if (!runs.includes(`\`${c.id}\``) || !runs.includes("hand track: a gated by-hand change")) return fail(`docs/live-runs.md carries no hand-track entry for ${c.id} (board.mjs record --hand did not run)`);
    commits.push(codeCommit);
  }
  for (const c of ready) {
    const held = runHeldOutAndClean(dir, c.heldOut);
    if (!held.ok) return fail(`${c.id}: ${held.message}`);
  }
  return pass(`built as ${commits.join(", ")}`, { commit: commits[commits.length - 1] });
}

// The parallel scenario's gate stage: assertAutoGateHeld (both cards Ready, only the fixture commit, no source touched)
// plus no Workflow launch: the denied queue approval must stop main before any queen starts.
export function assertParallelGateHeld(dir, stream, { cards } = {}) {
  if (toolUseNames(stream).includes("Workflow")) return fail("the gate stream carries a Workflow tool_use: a queen was launched before the queue approval");
  return assertAutoGateHeld(dir, stream, { cards });
}

// The parallel scenario's build assertion (card parallel-card-queens, B13): a doug-implement Workflow launch and a
// card-queen.js Workflow launch both come before the first `plan.mjs land`/`land-card` Bash call (the cards ran at
// once, not one after the other); main edited no source file and asked no question; each card has a per-card report
// under .doug/.state/reports/<id>/; no .doug/plan.json; the flow card landed as a merge commit with two parents; the
// hand card has its code commit, Done record and hand-track entry; both held-out tests pass. Every miss names the card.
const PARALLEL_FLOW_BASIC = { id: "fix-hours", files: ["src/duration.ts", "tests/duration.test.ts"], heldOut: { id: "fix-hours", file: HELDOUT_FILE } };
const PARALLEL_HAND_BASIC = { id: "add-truncate", files: ["src/strings.ts", "tests/strings.test.ts"], heldOut: { id: "add-truncate", file: join(ROOT, "evals/heldout/add-truncate.test.ts") } };

function toolUses(stream, { mainOnly = false } = {}) {
  const uses = [];
  for (const j of jsonLines(stream)) {
    if (mainOnly && j && j.parent_tool_use_id) continue;
    const content = j && j.type === "assistant" && j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) if (c && c.type === "tool_use" && c.name) uses.push(c);
  }
  return uses;
}

export function assertParallelBuilt({ dir, baseline, stream, cards }) {
  // The pair: the ts-orders descriptor's flow card and hand card when the fixture names them, else the ts-basic constants.
  const named = Array.isArray(cards) && cards.length ? cards : null;
  const asPair = (c) => ({ id: c.id, files: c.files, heldOut: c.heldOut });
  const PARALLEL_FLOW = named ? asPair(named.find((c) => c.track !== "hand")) : PARALLEL_FLOW_BASIC;
  const PARALLEL_HAND = named ? asPair(named.find((c) => c.track === "hand")) : PARALLEL_HAND_BASIC;
  if (!baseline) return fail("no baseline commit was recorded for this fixture");
  const uses = toolUses(stream);
  const mainUses = toolUses(stream, { mainOnly: true });
  if (uses.some((u) => u.name === "AskUserQuestion")) return fail("the build stream carries an AskUserQuestion tool_use: autopilot asked a question");
  for (const u of mainUses) {
    if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(u.name)) continue;
    const p = String((u.input && (u.input.file_path || u.input.notebook_path)) || "").replaceAll("\\", "/");
    if (/(^|\/)src\//.test(p.startsWith(dir) ? p.slice(dir.length) : p) && !p.includes("/.doug/")) return fail(`main edited a source file under src/ itself (${u.name} ${p}): the queens' seats do the building`);
  }
  const launch = (needle) => uses.findIndex((u) => u.name === "Workflow" && [u.input && u.input.name, u.input && u.input.scriptPath].some((v) => typeof v === "string" && v.includes(needle)));
  const firstLand = uses.findIndex((u) => u.name === "Bash" && /plan\.mjs"?\s+land(-card)?\b/.test(String(u.input && u.input.command)));
  if (firstLand < 0) return fail("no plan.mjs land or land-card Bash call in the build stream");
  // doug-next launches each queen by its per-card script, .doug/.state/reports/<id>/queen.js, whose path names neither
  // doug-implement nor card-queen; that launch counts for the card it is under.
  const first = (...ix) => ix.filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const perCard = (id) => launch(`/.doug/.state/reports/${id}/queen.js`);
  const implement = first(launch("doug-implement"), perCard(PARALLEL_FLOW.id));
  if (implement < 0 || implement > firstLand) return fail("no doug-implement Workflow launch before the first plan.mjs land/land-card call: the flow card's queen did not start before landing");
  const queen = first(launch("card-queen"), perCard(PARALLEL_HAND.id));
  if (queen < 0 || queen > firstLand) return fail("no card-queen.js Workflow launch before the first plan.mjs land/land-card call: the hand card's queen did not start before landing");
  for (const [c, name] of [[PARALLEL_FLOW, "last-report.json"], [PARALLEL_HAND, "card-report.json"]]) {
    if (!existsSync(join(dir, ".doug/.state/reports", c.id, name))) return fail(`no per-card report for ${c.id}: .doug/.state/reports/${c.id}/${name} is missing`);
  }
  if (existsSync(join(dir, ".doug/plan.json"))) return fail(".doug/plan.json exists: a parallel flow card's plan is per card (.doug/plans/<id>.json)");
  let shas;
  let merges;
  let board;
  try {
    const revs = (...a) => execFileSync("git", ["rev-list", ...a, `${baseline}..HEAD`], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim().split("\n").filter(Boolean);
    shas = revs();
    merges = revs("--merges");
    board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  } catch (err) {
    return fail(`could not read the fixture's git history or board: ${err.message}`);
  }
  if (!shas.length) return fail("no commits since the fixture baseline; the build never committed");
  const filesOf = (sha) => execFileSync("git", ["show", "--name-only", "--pretty=format:", sha], { cwd: dir, encoding: "utf8", env: cleanEnv() }).split("\n").filter(Boolean);
  const codeCommitOf = (c) => shas.find((sha) => c.files.every((f) => filesOf(sha).includes(f)));
  const runs = existsSync(join(dir, "docs/live-runs.md")) ? readFileSync(join(dir, "docs/live-runs.md"), "utf8") : "";
  const doneCard = (c) => {
    const card = (board.cards || []).find((x) => x.id === c.id);
    return card && card.column === "done" ? card : null;
  };
  const flowCode = codeCommitOf(PARALLEL_FLOW);
  if (!flowCode) return fail(`no commit since the fixture baseline changes both ${PARALLEL_FLOW.files.join(" and ")} (card ${PARALLEL_FLOW.id})`);
  const flowCard = doneCard(PARALLEL_FLOW);
  if (!flowCard) return fail(`the fixture board does not have ${PARALLEL_FLOW.id} in done`);
  if (!merges.length) return fail(`${PARALLEL_FLOW.id} did not land as a merge commit with two parents: no merge commit since the baseline`);
  if (!merges.some((m) => String(flowCard.source || "").includes(m.slice(0, 7)))) return fail(`${PARALLEL_FLOW.id}'s source does not name a merge commit with two parents (source: ${flowCard.source || "none"}; merges: ${merges.join(", ")})`);
  const handCode = codeCommitOf(PARALLEL_HAND);
  if (!handCode) return fail(`no commit since the fixture baseline changes both ${PARALLEL_HAND.files.join(" and ")} (card ${PARALLEL_HAND.id})`);
  const handCard = doneCard(PARALLEL_HAND);
  if (!handCard) return fail(`the fixture board does not have ${PARALLEL_HAND.id} in done`);
  if (!handCard.source || !String(handCard.source).includes(handCode.slice(0, 7))) return fail(`${PARALLEL_HAND.id}'s source does not name the code commit ${handCode} (source: ${handCard.source || "none"})`);
  if (!runs.includes(`\`${PARALLEL_HAND.id}\``) || !runs.includes("hand track: a gated by-hand change")) return fail(`docs/live-runs.md carries no hand-track entry for ${PARALLEL_HAND.id} (board.mjs record --hand did not run)`);
  for (const c of [PARALLEL_FLOW, PARALLEL_HAND]) {
    const held = runHeldOutAndClean(dir, c.heldOut);
    if (!held.ok) return fail(`${c.id}: ${held.message}`);
  }
  return pass(`built: ${PARALLEL_FLOW.id} merged, ${PARALLEL_HAND.id} as ${handCode}`, { commit: shas[0] });
}

// HEAD is a merge commit (two parents), not a fast-forward or a no-op: `git rev-list --parents -n 1 HEAD` lists
// the commit followed by each parent, so a plain commit has one token after it and a merge has two or more.
export function assertTwoParents(dir) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim().split(" ");
  if (parents.length < 3) return fail(`HEAD (${commit}) has ${parents.length - 1} parent(s); land should have produced a merge commit with two`);
  return pass(`HEAD is a merge commit: ${commit}`, { commit });
}

// The runner act shared by the flow and swarm scenarios' last stage: `plan.mjs done`, `plan.mjs land`, a check
// that land actually produced a merge commit (two parents) rather than a fast-forward or a no-op, then the
// held-out test on the landed fixture (as /doug-next step 5 and the eval scorer both do).
function landAndVerify(dir, heldOut) {
  const done = act(PLAN_MJS, ["done"], dir);
  if (!done.ok) return fail(`plan.mjs done failed: ${done.stderr || done.stdout}`);
  const land = act(PLAN_MJS, ["land"], dir);
  if (!land.ok) return fail(`plan.mjs land failed: ${land.stderr || land.stdout}`);
  const merged = assertTwoParents(dir);
  if (!merged.ok) return merged;
  const held = runHeldOutAndClean(dir, heldOut);
  if (!held.ok) return held;
  return pass(`landed as ${merged.commit}`, { commit: merged.commit });
}

// ---- Card rehearsal-harder-tier: the hard tier's build assertions and stages ------------------------------------------

function gitLines(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() }).split("\n").filter(Boolean);
}

// The one commit a card's board `source` names, among the commits since the baseline (`inRange`, full shas). The source
// is read for 7-40 character hex runs, each resolved with rev-parse and kept when it is in range. Never a search of
// history by file: with overlapping cards that credits a later card's commit to an earlier one. Returns { sha } or { error }.
function commitFromSource(dir, card, source, inRange) {
  const found = new Set();
  for (const tok of String(source || "").match(/\b[0-9a-f]{7,40}\b/gi) || []) {
    let full = null;
    try {
      full = gitLines(dir, "rev-parse", "--verify", "--quiet", `${tok}^{commit}`)[0] || null;
    } catch {
      // not a commit in this repository
    }
    if (full && inRange.includes(full)) found.add(full);
  }
  if (found.size === 0) return { error: `${card.id}'s source names no commit since the baseline (source: ${source || "none"})` };
  if (found.size > 1) return { error: `${card.id}'s source names more than one commit since the baseline, so its commit is ambiguous (${[...found].join(", ")}; source: ${source})` };
  return { sha: [...found][0] };
}

// The per-card checks 4.1.4.1 to 4.1.4.6 shared by the queue check and the hard hand check: Done, the commit from its
// source and not credited to another card, a two-parent merge for a non-hand card, the required files (and a tests/ path
// under requireTestFile) in `git diff --name-only <sha>^1 <sha>`, and a hand-track entry for a hand card. Returns { sha }
// or { error }.
function checkLandedCard({ dir, c, board, runs, inRange, credited }) {
  const bc = (board.cards || []).find((x) => x.id === c.id);
  if (!bc || bc.column !== "done") return { error: `${queenStopNote(dir, c.id)}the fixture board does not have ${c.id} in done` };
  const credit = commitFromSource(dir, c, bc.source, inRange);
  if (credit.error) return credit;
  const sha = credit.sha;
  const other = [...credited.entries()].find(([id, s]) => s === sha && id !== c.id);
  if (other) return { error: `${c.id}'s source names ${sha}, already credited to ${other[0]}` };
  if (c.track !== "hand") {
    const parents = gitLines(dir, "rev-list", "--parents", "-n", "1", sha)[0].trim().split(" ");
    if (parents.length < 3) return { error: `${c.id} did not land as a merge commit with two parents (${sha} has ${parents.length - 1})` };
  }
  const changed = gitLines(dir, "diff", "--name-only", `${sha}^1`, sha);
  const required = Array.isArray(c.requiredFiles) ? c.requiredFiles : Array.isArray(c.files) ? c.files : [];
  const missing = required.filter((f) => !changed.includes(f));
  if (missing.length) return { error: `${c.id}'s commit ${sha} does not change ${missing.join(", ")} (changed: ${changed.join(", ") || "none"})` };
  if (c.requireTestFile && !changed.some((f) => f.startsWith("tests/"))) return { error: `${c.id}'s commit ${sha} changes no file under tests/ (changed: ${changed.join(", ") || "none"})` };
  if (c.track === "hand" && (!runs.includes(`\`${c.id}\``) || !runs.includes("hand track: a gated by-hand change"))) return { error: `docs/live-runs.md carries no hand-track entry for ${c.id} (board.mjs record --hand did not run)` };
  return { sha };
}

function readBoardAndRuns(dir) {
  const board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  const runs = existsSync(join(dir, "docs/live-runs.md")) ? readFileSync(join(dir, "docs/live-runs.md"), "utf8") : "";
  return { board, runs };
}

// The hard tier's N-card queue check (used by hard-auto, and by hard-parallel after its stream checks): for every Ready
// card in descriptor order, the card is Done, its commit is the one its `source` names (never a search of history),
// each commit is credited to one card, a non-hand card landed as a two-parent merge, the commit changed the required
// files, a hand card is recorded, and every dep landed first. Then each card's held-out files run on the end state. A
// Backlog card must be untouched and no AskUserQuestion may appear. Every miss names the card; it never throws.
export function assertQueueBuilt({ dir, baseline, stream, cards }) {
  if (!baseline) return fail("no baseline commit was recorded for this fixture");
  if (toolUseNames(stream).includes("AskUserQuestion")) return fail("the build stream carries an AskUserQuestion tool_use: autopilot asked a question between or within the cards");
  const all = Array.isArray(cards) ? cards : [];
  const ready = all.filter((c) => c.column === "ready");
  try {
    const inRange = gitLines(dir, "rev-list", `${baseline}..HEAD`);
    if (!inRange.length) return fail("no commits since the fixture baseline; the build never committed");
    const { board, runs } = readBoardAndRuns(dir);
    const backlogCard = all.find((c) => c.column === "backlog");
    if (backlogCard) {
      const b = (board.cards || []).find((x) => x.id === backlogCard.id);
      if (!b || b.column !== "backlog" || b.goal !== backlogCard.goal) return fail(`the Backlog card ${backlogCard.id} was moved or changed: unlimited autopilot must take Ready cards only`);
    }
    const credited = new Map();
    for (const c of ready) {
      const r = checkLandedCard({ dir, c, board, runs, inRange, credited });
      if (r.error) return fail(r.error);
      for (const d of c.deps || []) {
        const dep = credited.get(d);
        if (!dep) continue;
        let ancestor = false;
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", dep, r.sha], { cwd: dir, env: cleanEnv(), stdio: "ignore" });
          ancestor = true;
        } catch {
          ancestor = false;
        }
        if (!ancestor) return fail(`${c.id} landed before its dep ${d}`);
      }
      credited.set(c.id, r.sha);
    }
    for (const c of ready) {
      const held = runHeldOutsAndClean(dir, c);
      if (!held.ok) return fail(`${c.id}: ${held.message}`);
    }
    const commits = [...credited.values()];
    const newest = inRange.find((s) => commits.includes(s));
    return pass(`built as ${commits.join(", ")}`, { commit: newest, commits });
  } catch (err) {
    return fail(`the queue check could not read the fixture: ${err && err.message ? err.message : String(err)}`);
  }
}

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// hard-parallel's build: the stream checks of assertParallelBuilt generalised to N cards, then assertQueueBuilt. Main
// edited no file under src/ and made no plan.json; every queued card has a queen.js Workflow launch; at least two
// launches come before the first plan.mjs land/land-card call (cards ran at once); every card has its per-card report;
// and for each pair of queued cards whose owned files overlap, the later card's first queen launch comes after the
// earlier card's land call (`plan.mjs land-card <id>` or `plan.mjs land --card <id>`).
export function assertHardParallelBuilt({ dir, baseline, stream, cards }) {
  if (!baseline) return fail("no baseline commit was recorded for this fixture");
  const queued = (Array.isArray(cards) ? cards : []).filter((c) => c.column === "ready");
  const uses = toolUses(stream);
  const mainUses = toolUses(stream, { mainOnly: true });
  if (uses.some((u) => u.name === "AskUserQuestion")) return fail("the build stream carries an AskUserQuestion tool_use: autopilot asked a question");
  for (const u of mainUses) {
    if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(u.name)) continue;
    const p = String((u.input && (u.input.file_path || u.input.notebook_path)) || "").replaceAll("\\", "/");
    if (/(^|\/)src\//.test(p.startsWith(dir) ? p.slice(dir.length) : p) && !p.includes("/.doug/")) return fail(`main edited a source file under src/ itself (${u.name} ${p}): the queens' seats do the building`);
  }
  if (existsSync(join(dir, ".doug/plan.json"))) return fail(".doug/plan.json exists: a parallel flow card's plan is per card (.doug/plans/<id>.json)");
  const launchOf = (id) =>
    uses.findIndex((u) => u.name === "Workflow" && [u.input && u.input.name, u.input && u.input.scriptPath].some((v) => typeof v === "string" && v.includes(`/.doug/.state/reports/${id}/queen.js`)));
  const launches = new Map();
  for (const c of queued) {
    const i = launchOf(c.id);
    if (i < 0) return fail(`no Workflow launch of .doug/.state/reports/${c.id}/queen.js in the build stream: card ${c.id}'s queen never started`);
    launches.set(c.id, i);
  }
  const firstLand = uses.findIndex((u) => u.name === "Bash" && /plan\.mjs"?\s+land(-card)?\b/.test(String(u.input && u.input.command)));
  if (firstLand < 0) return fail("no plan.mjs land or land-card Bash call in the build stream");
  const before = [...launches.values()].filter((i) => i < firstLand).length;
  if (before < 2) return fail(`only ${before} queen launch(es) come before the first plan.mjs land/land-card call; at least two cards must run at once`);
  for (const c of queued) {
    const name = c.track === "hand" ? "card-report.json" : "last-report.json";
    if (!existsSync(join(dir, ".doug/.state/reports", c.id, name))) return fail(`no per-card report for ${c.id}: .doug/.state/reports/${c.id}/${name} is missing`);
  }
  // A land call's id is the literal card id or a $name / ${name} / "$name" bound by the last `name=value` assignment
  // before the call in the same command (bare, single- or double-quoted value); an unset or other-valued variable is no land.
  const landsCard = (command, id) => {
    const lit = new RegExp(`plan\\.mjs"?\\s+(?:land-card\\s+${reEscape(id)}(?![\\w-])|land\\s+--card\\s+${reEscape(id)}(?![\\w-]))`);
    if (lit.test(command)) return true;
    const call = /plan\.mjs"?\s+(?:land-card|land\s+--card)\s+"?\$(?:\{(\w+)\}|(\w+))"?(?![\w-])/g;
    for (let m; (m = call.exec(command)); ) {
      const name = m[1] || m[2];
      const assign = new RegExp(`(?:^|[\\s;&|(])${name}=("[^"]*"|'[^']*'|[^\\s;&|"']*)`, "g");
      let value = null;
      for (let a; (a = assign.exec(command.slice(0, m.index))); ) value = a[1].replace(/^(["'])(.*)\1$/, "$2");
      if (value === id) return true;
    }
    return false;
  };
  const landOf = (id) => uses.findIndex((u) => u.name === "Bash" && landsCard(String(u.input && u.input.command), id));
  for (let i = 0; i < queued.length; i++) {
    for (let j = i + 1; j < queued.length; j++) {
      const a = queued[i];
      const b = queued[j];
      const shared = (a.files || []).filter((f) => (b.files || []).includes(f));
      if (!shared.length) continue;
      const aLand = landOf(a.id);
      if (aLand < 0) return fail(`${a.id} and ${b.id} share ${shared.join(", ")}, but no plan.mjs land-card ${a.id} (or land --card ${a.id}) call is in the build stream to order them by`);
      if (launches.get(b.id) < aLand) return fail(`${b.id} started its queen before ${a.id} landed, though they share ${shared.join(", ")}`);
    }
  }
  return assertQueueBuilt({ dir, baseline, stream, cards });
}

// hard-hand's build: assertHandBuilt's checks (a baseline, the card Done with a source naming the code commit, a
// hand-track entry), with the commit read from `source` rather than found by a file search, the required files (and a
// tests/ path under requireTestFile) in it, and every held-out file run.
export function assertHardHandBuilt(ctx) {
  const { dir, baseline } = ctx;
  const id = cardIdOf(ctx);
  const named = cardOf(ctx, id);
  if (!named) return fail(`the stage context carries no card ${id}`);
  const c = { ...named, track: "hand" };
  if (!baseline) return fail("no baseline commit was recorded for this fixture");
  try {
    const inRange = gitLines(dir, "rev-list", `${baseline}..HEAD`);
    if (!inRange.length) return fail("no commits since the fixture baseline; the build never committed");
    const { board, runs } = readBoardAndRuns(dir);
    const r = checkLandedCard({ dir, c, board, runs, inRange, credited: new Map() });
    if (r.error) return fail(r.error);
    const held = runHeldOutsAndClean(dir, c);
    if (!held.ok) return held;
    return pass(`built as ${r.sha}`, { commit: r.sha });
  } catch (err) {
    return fail(`the hand check could not read the fixture: ${err && err.message ? err.message : String(err)}`);
  }
}

// The hard tier's swarm-skill scenario exists to prove the lead splits a six-file, three-module task: some swarmed task
// must carry swarm.briefs >= 2 (the first split's round-one count, so a re-brief does not inflate it) and at least
// two workers. The failure names the task, the brief count and the lead's splitReason.
function assertSplit(dir) {
  const { ok, reason, report } = readReport(dir);
  if (!ok) return fail(reason);
  const swarmed = reportTasks(report).filter((t) => Array.isArray(t.workers) && t.workers.length);
  const briefsOf = (t) => (t.swarm && Number.isFinite(t.swarm.briefs) ? t.swarm.briefs : 0);
  if (swarmed.some((t) => briefsOf(t) >= 2 && t.workers.length >= 2)) return pass("split into two or more briefs");
  const t = swarmed[0];
  const n = briefsOf(t);
  const why = t.swarm && t.swarm.splitReason ? t.swarm.splitReason : "none recorded";
  return fail(`task ${t.id}: the lead did not split it (${n} brief${n === 1 ? "" : "s"}, ${t.workers.length} worker${t.workers.length === 1 ? "" : "s"}); splitReason: ${why}`);
}

// hard-swarm-skill's run assert: the cheap swarm-skill run assert, with every held-out file of the card run.
function assertSwarmSkillRun(ctx) {
  const id = cardIdOf(ctx);
  const done = assertImplemented(ctx.dir, ctx.stream, { plugins: ["doug-flow"], requireWorkers: true });
  if (!done.ok) return done;
  const split = assertSplit(ctx.dir);
  if (!split.ok) return split;
  let card;
  try {
    card = boardCards(ctx.dir).find((c) => c.id === id);
  } catch (err) {
    return fail(`cannot read the board: ${err.message}`);
  }
  if (!card || card.column !== "done") return fail(`the fixture board does not have ${id} in done`);
  const merged = assertTwoParents(ctx.dir);
  if (!merged.ok) return merged;
  if (!card.source || !String(card.source).includes(merged.commit.slice(0, 7))) return fail(`${id}'s source does not name the merge commit ${merged.commit} (source: ${card.source || "none"})`);
  const held = runHeldOutsAndClean(ctx.dir, cardOf(ctx, id) || { id });
  return held.ok ? pass(`swarmed and landed as ${merged.commit}`, { commit: merged.commit }) : held;
}

// hard-flow's land act: plan.mjs done, plan.mjs land, a two-parent check, then every held-out file of the card.
function landAndVerifyAll(dir, card) {
  const done = act(PLAN_MJS, ["done"], dir);
  if (!done.ok) return fail(`plan.mjs done failed: ${done.stderr || done.stdout}`);
  const land = act(PLAN_MJS, ["land"], dir);
  if (!land.ok) return fail(`plan.mjs land failed: ${land.stderr || land.stdout}`);
  const merged = assertTwoParents(dir);
  if (!merged.ok) return merged;
  const held = runHeldOutsAndClean(dir, card);
  if (!held.ok) return held;
  return pass(`landed as ${merged.commit}`, { commit: merged.commit });
}

// Session-stage turn caps of the hard tier (architecture 3.2); an act stage has none.
const HARD_TURNS = {
  "hard-hand": { gate: 18, build: 90 },
  "hard-flow": { gate: 45, implement: 60 },
  "hard-swarm-skill": { gate: 60, run: 120 },
  "hard-start-feature": { spec: 30, architecture: 45, plan: 45 },
  "hard-auto": { gate: 30, build: 420 },
  "hard-parallel": { gate: 30, build: 480 },
};
const HARD_OVERRIDES = {
  "hard-hand": { build: { assert: assertHardHandBuilt } },
  "hard-flow": { land: { run: (ctx) => landAndVerifyAll(ctx.dir, cardOf(ctx, cardIdOf(ctx)) || { id: cardIdOf(ctx) }) } },
  "hard-swarm-skill": { run: { assert: assertSwarmSkillRun } },
  "hard-auto": { build: { assert: assertQueueBuilt } },
  "hard-parallel": { build: { assert: assertHardParallelBuilt } },
};
// Each SCENARIO_STAGES[base] stage copied by name, kind, prompt and act, with the hard caps, timeouts and asserts.
export const HARD_STAGES = Object.fromEntries(
  HARD_BASES.map((base) => {
    const hard = `hard-${base}`;
    return [
      hard,
      SCENARIO_STAGES[base].map((stage) => {
        const copy = { ...stage, ...((HARD_OVERRIDES[hard] || {})[stage.name] || {}) };
        if (stage.kind === "session") {
          copy.maxTurns = HARD_TURNS[hard][stage.name];
          copy.timeoutMs = (hard === "hard-auto" || hard === "hard-parallel") && stage.name === "build" ? HARD_SESSION_TIMEOUT_MS : SESSION_TIMEOUT_MS;
        }
        return copy;
      }),
    ];
  }),
);
export function stagesFor(scenario) {
  return HARD_STAGES[scenario] || SCENARIO_STAGES[scenario];
}

// ---- Running a whole scenario end to end (never called by the tests: it spawns the real claude) ---------------

// Runs every stage of `scenario` in order, stopping at the first failed assertion. Every stage runs through
// runSessionStage/runActStage, so a throw anywhere (a missing binary, a killed session, an assertion that threw)
// becomes a normal failed stage instead of crashing the run (card workflow-rehearsal-review #5). Returns
// `{ scenario, outcome, stages, totalCost, wallClock, fixtureDir, commit, gate, reportFile, reportSynthesized,
// failedStage, failedMessage, agentNames }`. For flow/swarm, `reportFile` always exists on return: the real one
// when the workflow wrote it, otherwise a small synthetic one this function writes (never inventing task rows).
export function runScenario(scenario, { tempPrefix, fixture } = {}) {
  const started = Date.now();
  const prepared = prepareFixture({ scenario, fixture, tempPrefix });
  const { dir, card, cards, baseline } = prepared;
  // The fixture that prices the stages: the one prepareFixture ran on (none for `start`, an empty repo).
  const ran = prepared.fixture || null;
  const stages = [];
  let outcome = "passed";
  let commit = null;
  let gate = null;
  let failedStage = null;
  let failedMessage = null;
  for (const stage of stagesFor(scenario)) {
    const stageStarted = Date.now();
    const ctx = { dir, card, cards, fixture: ran, baseline };
    let result;
    if (stage.kind === "session") result = runSessionStage(stage, { ...ctx, capUsd: capFor(scenario, stage.name, ran) });
    else if (stage.kind === "command") result = runCommandStage(stage, { ...ctx, capUsd: capFor(scenario, stage.name, ran) });
    else result = runActStage(stage, ctx);
    const wallClock = `${Math.round((Date.now() - stageStarted) / 6000) / 10} min`;
    stages.push({ name: stage.name, wallClock, cost: result.cost, streamPath: result.streamPath, message: result.message });
    if (result.commit) commit = result.commit;
    if (result.gate) gate = result.gate;
    if (!result.ok) {
      outcome = `failed at ${stage.name}: ${result.message}`;
      failedStage = stage.name;
      failedMessage = result.message;
      break;
    }
  }
  const totalCost = stages.reduce((sum, s) => sum + (s.cost || 0), 0);

  let reportFile = null;
  let reportSynthesized = false;
  let agentNames = [];
  if (!recordsAsHand(scenario)) {
    const realReport = join(dir, RESULTS_FILE);
    if (existsSync(realReport)) {
      reportFile = realReport;
      if (scenario === "swarm") agentNames = agentNamesFromReport(readReport(dir).report || {});
    } else {
      reportFile = join(dir, SYNTHETIC_REPORT_RELPATH);
      mkdirSync(dirname(reportFile), { recursive: true });
      writeFileSync(reportFile, JSON.stringify(syntheticReport(scenario, failedStage || "prepare", failedMessage || "no stage ran"), null, 2) + "\n");
      reportSynthesized = true;
    }
  }

  return {
    scenario,
    outcome,
    stages,
    totalCost,
    wallClock: `${Math.round((Date.now() - started) / 6000) / 10} min`,
    fixtureDir: dir,
    fixture: ran,
    commit,
    gate,
    reportFile,
    reportSynthesized,
    failedStage,
    failedMessage,
    agentNames,
  };
}
