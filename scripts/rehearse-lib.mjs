// The pure and fixture-setup pieces behind scripts/rehearse.mjs (card workflow-rehearsal): estimates, argument
// parsing, the ts-basic fixture the three scenarios run in, the stream assertions a real `claude -p` session's
// stream-json output is checked against, and the recording that goes through the existing board.mjs run-report
// CLI (never lib/board.mjs directly, so a batch or a research-note promotion is never bypassed). Spawning the
// real `claude` binary (runStage) is the only side effect here that costs money; every other export is pure, or
// touches only a fixture directory the caller made. Facts this module leans on are cited in
// .doug/.state/research/workflow-rehearsal.md.

import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { newBoard, addCard, boardPath, BOARD_RELPATH } from "../plugins/doug-flow/lib/board.mjs";
import { commandEnv } from "../plugins/doug-flow/lib/land.mjs";
import { unwrapReport } from "../plugins/doug-flow/lib/plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const PLUGIN_DIR = join(ROOT, "plugins/doug-flow");
export const PLAN_MJS = join(PLUGIN_DIR, "scripts/plan.mjs");
export const BOARD_MJS = join(PLUGIN_DIR, "scripts/board.mjs");
export const MEMORY_MJS = join(PLUGIN_DIR, "scripts/memory.mjs");
export const CLI = join(ROOT, "packages/doug-cli/dist/bin.js");
export const FIXTURE_DIR = join(ROOT, "evals/fixtures/ts-basic");
export const TASKS_FILE = join(ROOT, "evals/tasks/ts-basic.json");
export const HELDOUT_FILE = join(ROOT, "evals/heldout/fix-hours.test.ts");
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
export const SCENARIOS = ["flow", "swarm", "hand"];
export const ESTIMATES = {
  flow: {
    // /doug-next's own first step moves the card (uncommitted working state, never a "Board: <id> moved to In
    // flow" commit) and spawns the planner before its approval gate (research §1, section 1), so there is no
    // separate /doug-plan stage to estimate: the gate stage now covers what the old $0.25 gate and $0.75 plan
    // stages did together (item rehearsal-first-live-findings #1).
    stages: { gate: 1.25, implement: 2.5 },
    source:
      "flow rehearsals on the ts-basic fixture measured $4.15/9 min (docs/live-runs.md, 2026-09-09), $3.93/10 min (2026-09-10), and $2.13/9 min (2026-09-20); the former gate ($0.25) and plan ($0.75) estimates merge into one gate stage since /doug-next runs the planner before its own approval gate, leaving implement as before",
  },
  swarm: {
    stages: { implement: 4.0 },
    source:
      "swarm rehearsal on the ts-basic fixture measured $4.32/12.7 min (docs/live-runs.md, 2026-09-10), predating the shape gate (3eb9485, 2026-09-12); the scenario fails at implement today, so this figure is not reproducible until rehearsal-swarm-splittable lands",
  },
  hand: {
    stages: { gate: 0.25, build: 3.75 },
    source: "hand rehearsal on the ts-basic fixture measured $2.16/3.8 min (docs/live-runs.md, 2026-09-09), measured before the tester seat and research step existed",
  },
};

export function scenarioTotal(scenario) {
  return Object.values(ESTIMATES[scenario].stages).reduce((a, b) => a + b, 0);
}

export function totalEstimate() {
  return SCENARIOS.reduce((sum, s) => sum + scenarioTotal(s), 0);
}

// Three times a session stage's own estimate (never the scenario total): the cap `runStage` passes as
// --max-budget-usd.
export function capFor(scenario, stageName) {
  const usd = ESTIMATES[scenario].stages[stageName];
  if (usd === undefined) throw new Error(`capFor: scenario "${scenario}" has no estimate for stage "${stageName}"`);
  return Math.round(usd * 3 * 100) / 100;
}

// With no scenario: one line per scenario (its total and source) plus the `all` total. With a scenario: its
// per-stage breakdown (card workflow-rehearsal-review #6).
export function estimateLines(scenario = null) {
  if (!scenario) {
    const lines = SCENARIOS.map((s) => `  ${s.padEnd(6)} $${scenarioTotal(s).toFixed(2)}  (${ESTIMATES[s].source})`);
    lines.push(`  ${"all".padEnd(6)} $${totalEstimate().toFixed(2)}  (sum of the three)`);
    return lines;
  }
  const est = ESTIMATES[scenario];
  const lines = [`  ${scenario} $${scenarioTotal(scenario).toFixed(2)} total  (${est.source})`];
  for (const [stage, usd] of Object.entries(est.stages)) lines.push(`    ${stage.padEnd(10)} $${usd.toFixed(2)}  (cap $${(usd * 3).toFixed(2)})`);
  return lines;
}

// ---- CLI argument parsing ------------------------------------------------------------------------------
// `rehearse.mjs [flow|swarm|hand|all] --card <id> --spend [dir]`. Pure: does not validate the scenario name
// or check the card exists (the caller does, before anything is spawned).
export function parseArgs(argv) {
  const positional = [];
  const opts = { spend: false, card: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spend") opts.spend = true;
    else if (a === "--card") opts.card = argv[++i] ?? null;
    else positional.push(a);
  }
  const [scenario, dir] = positional;
  return { scenario: scenario ?? null, dir: dir ?? null, spend: opts.spend, card: opts.card };
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

function fail(message) {
  return { ok: false, message };
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
      // so by name instead of the old blanket message, and point at the card that would give this scenario a
      // splittable task.
      const gated = tasks.find((t) => t.swarm && t.swarm.applies === false);
      if (gated) {
        return fail(
          `task ${gated.id}: no workers (${gated.swarm.reason}); the shape gate kept it off the lead, so this scenario cannot prove a split until card rehearsal-swarm-splittable lands`,
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

function fixtureTask(suite) {
  const task = suite.tasks.find((t) => t.id === "fix-hours-planned");
  if (!task || !task.plan) throw new Error(`task "fix-hours-planned" with a plan was not found in ${TASKS_FILE}`);
  return task;
}

// A fresh fixture for one scenario: the suite's own setup commands (so a checkout that never ran evals still
// gets node_modules; evals/fixtures/ts-basic/node_modules is gitignored), `doug init`, a board holding one card
// `fix-hours` (title/goal from the fix-hours-planned task's plan), on the hand track only for the hand scenario,
// and, for the swarm scenario, the same task's plan installed pre-approved with swarm on (the swarm opt-in and
// the approval are the user's acts, standing in for /doug-swarm here since the swarm scenario starts at
// implement, not at a gate). CLAUDE.md's Models table is left exactly as `doug init` generated it, worker row
// included; the runner edits no row. Throws with a `pnpm build` message when the CLI is missing.
// `tempPrefix` lets a caller (the test file) mark its own fixtures distinctly from a real run's, so a fixture
// left behind by --spend on failure is recognisable as the runner's (card workflow-rehearsal-review #7).
export function prepareFixture({ scenario, dir, tempPrefix } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`prepareFixture: unknown scenario "${scenario}"; scenarios are ${SCENARIOS.join(", ")}`);
  if (!existsSync(CLI)) throw new Error(`the doug CLI is not built (${relative(ROOT, CLI)} is missing); run "pnpm build" first`);
  const suite = fixtureSuite();
  const task = fixtureTask(suite);
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

  let board = { ...newBoard(), components: ["flow"] };
  board = addCard(board, {
    id: "fix-hours",
    title: task.plan.title,
    goal: task.plan.goal,
    component: "flow",
    size: "S",
    track: scenario === "hand" ? "hand" : undefined,
    column: "ready",
    // doug-hand's Start step now refuses a classless card before it stamps the landing's condition
    // (scripts/memory.mjs's "condition open"); every fixture card carries one so a rehearsal never trips that
    // refusal (plugins/doug-flow/skills/doug-hand/SKILL.md step 2).
    class: "code",
  });
  mkdirSync(join(target, ".doug"), { recursive: true });
  writeFileSync(join(target, BOARD_RELPATH), JSON.stringify(board, null, 2) + "\n");

  if (scenario === "swarm") {
    const plan = { ...task.plan, status: "approved", card: "fix-hours", swarm: true };
    writeFileSync(join(target, ".doug/plan.json"), JSON.stringify(plan, null, 2) + "\n");
  }

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["config", "user.email", "rehearse@example.com"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["config", "user.name", "rehearse"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["add", "-A"], { cwd: target, env: cleanEnv() });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: target, env: cleanEnv() });
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8", env: cleanEnv() }).trim();
  return { dir: target, card: { id: "fix-hours", title: task.plan.title, goal: task.plan.goal }, task, baseline };
}

// ---- One `claude -p` session (evals/run.mjs runWorkflowSession's spawn shape exactly) --------------------------
const SESSION_TIMEOUT_MS = 90 * 60 * 1000;

// Spawns one stage's session, saving the full stream to <dir>/.doug/.state/rehearsal/<stage>.jsonl so a failed
// assertion can be read afterwards. `claudeBin` defaults to $DOUG_REHEARSE_CLAUDE or "claude"; a real user never
// sets that env var, the test file points it at a fake. `capUsd` becomes --max-budget-usd. `spawnSync` never
// throws on a missing binary; it sets `.error` instead (ENOENT), surfaced here as `error`/`signal` rather than
// left for the caller to notice only from empty output (card workflow-rehearsal-review #5).
export function runStage({ dir, prompt, maxTurns, stage, capUsd = null, claudeBin = process.env.DOUG_REHEARSE_CLAUDE || "claude" }) {
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
  const r = spawnSync(claudeBin, args, { cwd: dir, encoding: "utf8", timeout: SESSION_TIMEOUT_MS, env, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(streamPath, r.stdout || "");
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status, signal: r.signal || null, error: r.error || null, streamPath, cost: sessionCost(r.stdout || "") };
}

// Runs one session stage end to end: spawn, then assert, with every failure mode (the binary could not run, it
// was killed, or the assertion itself threw) turned into a normal `{ ok:false, message }` instead of a crash or
// a misleading assertion failure (card workflow-rehearsal-review #5). Always carries `streamPath` and `cost`.
export function runSessionStage(stage, { dir, card, baseline, capUsd = null, claudeBin } = {}) {
  const r = runStage({ dir, prompt: stage.prompt({ card }), maxTurns: stage.maxTurns, stage: stage.name, capUsd, ...(claudeBin ? { claudeBin } : {}) });
  if (r.error) return { ok: false, message: `claude could not run: ${r.error.message}`, streamPath: r.streamPath, cost: null };
  if (r.signal) return { ok: false, message: `claude was killed by signal ${r.signal} before finishing`, streamPath: r.streamPath, cost: r.cost };
  let result;
  try {
    result = stage.assert({ dir, card, baseline, stream: r.stdout });
  } catch (err) {
    result = fail(`assertion threw: ${err && err.message ? err.message : String(err)}`);
  }
  return { ...result, streamPath: r.streamPath, cost: r.cost };
}

// Runs one act stage (the runner performing a human gate's act, or a deterministic step): a throw becomes a
// normal failed result instead of crashing the scenario (card workflow-rehearsal-review #5).
export function runActStage(stage, { dir, card, baseline } = {}) {
  try {
    return { ...stage.run({ dir, card, baseline }), streamPath: null, cost: null };
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
function runHeldOutAndClean(dir) {
  const before = dirtyOutsideDoug(dir);
  if (before.length) return fail(`working tree is not clean before the held-out test is added: ${before.join(", ")}`);
  const heldOutPath = join(dir, "tests/heldout-fix-hours.test.ts");
  cpSync(HELDOUT_FILE, heldOutPath);
  let test;
  try {
    test = spawnSync("pnpm", ["test"], { cwd: dir, encoding: "utf8", shell: true, env: cleanEnv() });
  } finally {
    rmSync(heldOutPath, { force: true });
  }
  if (test.status !== 0) return fail(`pnpm test failed in the fixture after the held-out test was added:\n${((test.stdout || "") + (test.stderr || "")).slice(0, 2000)}`);
  return pass("held-out test passed");
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
export function rehearsalNote({ scenario, outcome, stages, cost = null, agentNames = null }) {
  const stageList = stages.map((s) => `${s.name} (${s.wallClock})${s.message ? ` — ${s.message}` : ""}`).join(", ");
  const base =
    scenario === "hand"
      ? `Rehearsal hand on the ts-basic fixture: ${outcome}; cost ${cost === null ? "not measured" : `$${Number(cost).toFixed(2)}`}; stages ${stageList}`
      : `Rehearsal ${scenario} on the ts-basic fixture: ${outcome}; stages ${stageList}`;
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

// Records a flow or swarm outcome under `cardId` on the board at `dir` (the real repository by default; a temp
// copy in tests) by spawning `board.mjs record <id> <report> [dir] ...` exactly as a normal run does. Throws on a
// non-zero exit (the caller decides how to report that; it is never swallowed).
export function recordRunOutcome(dir, cardId, { reportFile, wallClock = null, cost = null, mergeCommit = null, note = null, rehearsal = null }) {
  const args = ["record", cardId, reportFile];
  if (cost !== null) args.push("--cost", String(cost));
  if (wallClock !== null) args.push("--wall", wallClock);
  if (mergeCommit) args.push("--commit", mergeCommit);
  if (note) args.push("--note", note);
  if (rehearsal) args.push("--rehearsal", rehearsal);
  args.push(dir);
  const r = runBoardCli(args);
  if (!r.ok) throw new Error(`board.mjs record failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Records a hand outcome under `cardId` on the board at `dir` by spawning `board.mjs record <id> --hand [dir]
// ...` exactly as a normal hand-track landing does.
export function recordHandOutcome(dir, cardId, { commit = null, wallClock = null, gate = null, note = null, rehearsal = null }) {
  const args = ["record", cardId, "--hand"];
  if (commit) args.push("--commit", commit);
  if (wallClock !== null) args.push("--wall", wallClock);
  if (gate !== null) args.push("--gate", gate);
  if (note) args.push("--note", note);
  if (rehearsal) args.push("--rehearsal", rehearsal);
  args.push(dir);
  const r = runBoardCli(args);
  if (!r.ok) throw new Error(`board.mjs record --hand failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---- The three scenarios, stage by stage ------------------------------------------------------------------
// Each entry is a session stage (spawns `claude -p`, then asserts on the stream and the fixture) or an act stage
// (the runner performs the human gate's act, or a deterministic step like `plan.mjs land`, itself). A session
// stage's `prompt`/`assert` take `{ dir, card, baseline, stream }`; an act stage's `run` takes `{ dir, card,
// baseline }` and returns `{ ok, message, ...extra }` (`commit` when it lands or builds something).
export const SCENARIO_STAGES = {
  hand: [
    {
      kind: "session",
      name: "gate",
      maxTurns: 12,
      prompt: () => "/doug-next fix-hours",
      assert: ({ dir, stream }) => assertGateHeld(dir, stream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours", unchangedFiles: ["src/duration.ts"] }),
    },
    {
      kind: "act",
      name: "start-gate",
      run: ({ dir }) => {
        // task rehearse-uncommitted-move: the board move stays uncommitted working state (it lands only in the
        // card's landing commit), so this act no longer commits it.
        const move = act(BOARD_MJS, ["move", "fix-hours", "flow"], dir);
        if (!move.ok) return fail(`board.mjs move failed: ${move.stderr || move.stdout}`);
        // doug-hand step 2 stamps the landing's condition before the brief (plugins/doug-flow/skills/doug-hand/SKILL.md):
        // `memory.mjs condition open <id>` writes .doug/.state/reports/<id>/condition.json, and refuses a classless
        // card or a dir with no git HEAD — the fixture already has a HEAD (its own baseline commit) regardless of
        // the uncommitted move above. `act()` passes `dir` positionally and spawns with cleanEnv(), so this writes
        // into the fixture, never this repository (dirFrom prefers CLAUDE_PROJECT_DIR, which cleanEnv scrubs, over
        // that positional argument).
        const condition = act(MEMORY_MJS, ["condition", "open", "fix-hours"], dir);
        if (!condition.ok) return fail(`memory.mjs condition open failed: ${condition.stderr || condition.stdout}`);
        return pass("moved fix-hours to In flow (uncommitted) and opened its condition, standing in for the start gate");
      },
    },
    {
      kind: "session",
      name: "build",
      maxTurns: 60,
      prompt: () =>
        [
          "/doug-next fix-hours",
          "I answered Start at the start gate and moved the card to In flow myself (it is uncommitted), and I chose by hand. Do not invoke the doug-board skill at any step: this checkout publishes nothing. Do the doug-hand skill's steps 3 and 4, then stop before step 5: do not suggest follow-up cards and do not ask the continue gate.",
        ].join("\n\n"),
      assert: (ctx) => assertHandBuilt(ctx),
    },
  ],
  flow: [
    {
      kind: "session",
      name: "gate",
      maxTurns: 30,
      prompt: () => "/doug-next fix-hours",
      assert: ({ dir, stream }) => assertFlowGateHeld(dir, stream, { plugins: ["doug-flow"], command: "doug-flow:doug-next", cardId: "fix-hours" }),
    },
    {
      kind: "act",
      name: "approve",
      run: ({ dir }) => {
        const setCard = act(PLAN_MJS, ["set", "card", "fix-hours"], dir);
        if (!setCard.ok) return fail(`plan.mjs set card failed: ${setCard.stderr || setCard.stdout}`);
        let plan = null;
        try {
          plan = JSON.parse(readFileSync(join(dir, ".doug/plan.json"), "utf8"));
        } catch {
          // approve below reports the same problem
        }
        const owned = new Set((plan && plan.tasks ? plan.tasks : []).flatMap((t) => t.files || []));
        const outOfScope = [...owned].filter((f) => f !== "src/duration.ts" && f !== "tests/duration.test.ts");
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
      run: ({ dir }) => landAndVerify(dir),
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
      run: ({ dir }) => landAndVerify(dir),
    },
  ],
};

// The hand scenario's build assertion (card workflow-rehearsal-review #1): doug-hand's own step 4.3 commits the
// board and docs/live-runs.md AFTER the code commit ("Board: <id> done as <sha>"), so HEAD is that board commit,
// not the code commit — take every commit since the fixture's recorded baseline instead of assuming HEAD is it,
// require that one of them changes both owned files, and require the board's `source` to name THAT commit.
export function assertHandBuilt({ dir, baseline }) {
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
    if (files.includes("src/duration.ts") && files.includes("tests/duration.test.ts")) {
      codeCommit = sha;
      break;
    }
  }
  if (!codeCommit) return fail(`no commit since the fixture baseline changes both src/duration.ts and tests/duration.test.ts (commits since baseline: ${shas.join(", ")})`);
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath(dir), "utf8"));
  } catch (err) {
    return fail(`could not read the fixture board: ${err.message}`);
  }
  const card = (board.cards || []).find((c) => c.id === "fix-hours");
  if (!card || card.column !== "done") return fail("the fixture board does not have fix-hours in done");
  if (!card.source || !String(card.source).includes(codeCommit.slice(0, 7))) return fail(`fix-hours's source does not name the code commit ${codeCommit} (source: ${card.source || "none"})`);
  const runs = existsSync(join(dir, "docs/live-runs.md")) ? readFileSync(join(dir, "docs/live-runs.md"), "utf8") : "";
  if (!runs.includes("`fix-hours`") || !runs.includes("hand track: a gated by-hand change")) return fail("docs/live-runs.md carries no hand-track entry for fix-hours (board.mjs record --hand did not run)");
  const held = runHeldOutAndClean(dir);
  if (!held.ok) return held;
  return pass(`built as ${codeCommit}`, { commit: codeCommit });
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
function landAndVerify(dir) {
  const done = act(PLAN_MJS, ["done"], dir);
  if (!done.ok) return fail(`plan.mjs done failed: ${done.stderr || done.stdout}`);
  const land = act(PLAN_MJS, ["land"], dir);
  if (!land.ok) return fail(`plan.mjs land failed: ${land.stderr || land.stdout}`);
  const merged = assertTwoParents(dir);
  if (!merged.ok) return merged;
  const held = runHeldOutAndClean(dir);
  if (!held.ok) return held;
  return pass(`landed as ${merged.commit}`, { commit: merged.commit });
}

// ---- Running a whole scenario end to end (never called by the tests: it spawns the real claude) ---------------

// Runs every stage of `scenario` in order, stopping at the first failed assertion. Every stage runs through
// runSessionStage/runActStage, so a throw anywhere (a missing binary, a killed session, an assertion that threw)
// becomes a normal failed stage instead of crashing the run (card workflow-rehearsal-review #5). Returns
// `{ scenario, outcome, stages, totalCost, wallClock, fixtureDir, commit, reportFile, reportSynthesized,
// failedStage, failedMessage, agentNames }`. For flow/swarm, `reportFile` always exists on return: the real one
// when the workflow wrote it, otherwise a small synthetic one this function writes (never inventing task rows).
export function runScenario(scenario, { tempPrefix } = {}) {
  const started = Date.now();
  const { dir, card, baseline } = prepareFixture({ scenario, tempPrefix });
  const stages = [];
  let outcome = "passed";
  let commit = null;
  let failedStage = null;
  let failedMessage = null;
  for (const stage of SCENARIO_STAGES[scenario]) {
    const stageStarted = Date.now();
    const result = stage.kind === "session" ? runSessionStage(stage, { dir, card, baseline, capUsd: capFor(scenario, stage.name) }) : runActStage(stage, { dir, card, baseline });
    const wallClock = `${Math.round((Date.now() - stageStarted) / 6000) / 10} min`;
    stages.push({ name: stage.name, wallClock, cost: result.cost, streamPath: result.streamPath, message: result.message });
    if (result.commit) commit = result.commit;
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
  if (scenario !== "hand") {
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
    commit,
    reportFile,
    reportSynthesized,
    failedStage,
    failedMessage,
    agentNames,
  };
}
