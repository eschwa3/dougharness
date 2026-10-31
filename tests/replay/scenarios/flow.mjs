// Replay of the flow scenario (the ci-e2e spec 4.2, G3). Spec decision 3: the fake writes what
// doug-implement.js would have written (task branches and worktrees, the fix in each, the integration branch with the
// merges, the report); the replay tests the stage asserts and the land act, not the workflow. No model runs.
//
// This file also exports the helpers the other workflow-output replays (swarm, swarm-skill, parallel and the hard
// files) share, because each task owns exactly its seven scenario files and no shared module.
//
// failStage is "land", an act stage: no fake claude runs there, so the failing replay is the implement step with
// DOUG_REPLAY_FAIL=land. The runner (tests/replay/claude) only calls `fail` for a step whose own stage name equals
// the variable, so the implement step reads the variable itself and commits a no-op fix (the held-out test stays red).
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../../../scripts/rehearse-lib.mjs";
import { integrationWorktreeFor } from "../../../plugins/doug-flow/lib/plan.mjs";
import { boardCli, planCli, writeWorkflowOutput } from "../lib.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---- Helpers shared by the workflow-output replays --------------------------------------------------------------

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// The fake's Stream.init() names no slash commands; the gate asserts want the one the prompt invoked.
export function announce(stream, ...commands) {
  const first = JSON.parse(stream.lines[0]);
  first.slash_commands = commands;
  stream.lines[0] = JSON.stringify(first);
  writeFileSync(stream.path, stream.text());
}

export function boardCards(dir) {
  return JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8")).cards || [];
}

export function cardFromPrompt(prompt) {
  const m = /^\/doug-(?:next|swarm) (\S+)/m.exec(String(prompt));
  if (!m) throw new Error(`replay: no card id in the prompt ${JSON.stringify(String(prompt).slice(0, 60))}`);
  return m[1];
}

// The eval task whose `plan` the planner would have drafted for a card (ts-basic names its flow card fix-hours after
// the task fix-hours-planned).
export function planTask(cardId) {
  for (const name of ["ts-rentals", "ts-orders", "ts-basic"]) {
    const suite = JSON.parse(readFileSync(join(ROOT, "evals/tasks", `${name}.json`), "utf8"));
    const task = suite.tasks.find((t) => t.plan && (t.id === cardId || t.id === `${cardId}-planned`));
    if (task) return task;
  }
  throw new Error(`replay: no eval task with a plan for card ${cardId}`);
}

export function draftPlan(dir, cardId, { rel = ".doug/plan.json", patch = {} } = {}) {
  const plan = { ...planTask(cardId).plan, status: "draft", card: cardId, ...patch };
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

// A worktree has no node_modules (git ignores them) and verify runs there, so install them from the pnpm store. A
// symlink to the checkout's node_modules is not an option: pnpm rewrites the links it finds in the worktree.
export function installModules(worktree) {
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--silent"], { cwd: worktree, env: cleanEnv(), stdio: "pipe" });
}

// A command the session ran itself: its Bash line, the fixture's PreToolUse hooks for Bash (guard-bash records the
// command in the session state, which is where the stop gate looks for evidence that the session ran a test), the real
// run, and its result. The replay does not run PreToolUse hooks otherwise.
export function runInSession(ctx, command) {
  const { dir, stream } = ctx;
  const id = stream.toolUse("Bash", { command });
  const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  const payload = JSON.stringify({ session_id: "replay", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, transcript_path: stream.path });
  for (const entry of (settings.hooks && settings.hooks.PreToolUse) || []) {
    if (entry.matcher && !/\bBash\b/.test(entry.matcher)) continue;
    for (const h of entry.hooks || []) {
      const r = spawnSync("sh", ["-c", h.command], { cwd: dir, env: cleanEnv({ CLAUDE_PROJECT_DIR: dir }), input: payload, encoding: "utf8" });
      if (r.status === 2) throw new Error(`a PreToolUse hook blocked \`${command}\`: ${r.stderr || r.stdout}`);
    }
  }
  const r = spawnSync(command, { cwd: dir, shell: true, env: cleanEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  stream.toolResult(id, out.slice(-2000));
  if (r.status !== 0) throw new Error(`\`${command}\` failed in the session:\n${out.slice(-1500)}`);
}

function sub(wt, rel, from, to) {
  const file = join(wt, rel);
  const body = readFileSync(file, "utf8");
  if (!body.includes(from)) throw new Error(`replay fix: ${rel} does not contain ${JSON.stringify(from)}`);
  writeFileSync(file, body.replace(from, () => to));
}
function add(wt, rel, text) {
  appendFileSync(join(wt, rel), text);
}

// Hand-written fixes for the ts-basic and ts-orders tasks (ts-rentals has solution patches under evals/solutions).
const FIXES = {
  "fix-hours": (wt) => {
    sub(wt, "src/duration.ts", "n * 60_000; // bug: should be 3_600_000", "n * 3_600_000;");
    add(wt, "tests/duration.test.ts", '\ndescribe("parseDuration hours", () => {\n  it("parses hours", () => {\n    expect(parseDuration("2h")).toBe(7_200_000);\n  });\n});\n');
  },
  "split-helpers": (wt) => {
    add(wt, "src/duration.ts", "\n/** Converts a duration like \"90s\" to seconds. */\nexport function toSeconds(text: string): number {\n  return parseDuration(text) / 1000;\n}\n");
    add(wt, "src/strings.ts", '\n/** Capitalizes each word and collapses whitespace. */\nexport function titleCase(input: string): string {\n  return input\n    .trim()\n    .split(/\\s+/)\n    .filter(Boolean)\n    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())\n    .join(" ");\n}\n');
    add(wt, "tests/duration.test.ts", '\nimport { toSeconds } from "../src/duration.js";\ndescribe("toSeconds", () => {\n  it("converts to seconds", () => {\n    expect(toSeconds("90s")).toBe(90);\n  });\n});\n');
    add(wt, "tests/strings.test.ts", '\nimport { titleCase } from "../src/strings.js";\ndescribe("titleCase", () => {\n  it("capitalizes each word", () => {\n    expect(titleCase("hello   WORLD")).toBe("Hello World");\n  });\n});\n');
  },
  "add-truncate": (wt) => {
    add(wt, "src/strings.ts", '\n/** Cuts a string to max characters, ending in an ellipsis when it was cut. */\nexport function truncate(input: string, max: number): string {\n  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;\n}\n');
    add(wt, "tests/strings.test.ts", '\nimport { truncate } from "../src/strings.js";\ndescribe("truncate", () => {\n  it("cuts with an ellipsis", () => {\n    expect(truncate("hello world", 5)).toBe("hell…");\n  });\n});\n');
  },
  "fix-tax-rounding": (wt) => {
    sub(wt, "src/billing/tax.ts", "Math.floor(subtotalCents * rate)", "Math.round(subtotalCents * rate)");
    add(wt, "tests/billing.test.ts", '\ndescribe("taxFor rounding", () => {\n  it("rounds a fractional cent half up", () => {\n    expect(taxFor(1005, 0.15)).toBe(151);\n  });\n});\n');
  },
  "fix-stock-reserve": (wt) => {
    sub(wt, "src/inventory/stock.ts", "qty > e.onHand", "qty > e.onHand - e.reserved");
    add(wt, "tests/inventory.test.ts", '\ndescribe("reserve past the stock", () => {\n  it("refuses a second reservation past what is available", () => {\n    expect(() => reserve(stock, "G-1", 2)).toThrow();\n  });\n});\n');
  },
  "split-money-catalog": (wt) => {
    add(wt, "src/util/money.ts", '\n/** Shares a total in cents across parts, the first parts taking the extra cents. */\nexport function splitCents(total: number, parts: number): number[] {\n  if (!Number.isInteger(parts) || parts < 1) throw new Error(`parts must be a positive whole number: ${parts}`);\n  const base = Math.floor(total / parts);\n  const extra = total - base * parts;\n  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));\n}\n');
    add(wt, "src/catalog/catalog.ts", '\n/** Maps each category to its skus in catalog order. */\nexport function byCategory(products: Product[]): Record<string, string[]> {\n  const groups = new Map<string, string[]>();\n  for (const p of products) groups.set(p.category, [...(groups.get(p.category) ?? []), p.sku]);\n  return Object.fromEntries(groups);\n}\n');
    add(wt, "src/orders/status.ts", "\nexport function isTerminal(status: Status): boolean {\n  return NEXT[status].length === 0;\n}\n");
    add(wt, "tests/money.test.ts", '\nimport { splitCents } from "../src/util/money.js";\ndescribe("splitCents", () => {\n  it("gives the first parts the extra cents", () => {\n    expect(splitCents(100, 3)).toEqual([34, 33, 33]);\n  });\n});\n');
    add(wt, "tests/catalog.test.ts", '\nimport { byCategory } from "../src/catalog/catalog.js";\ndescribe("byCategory", () => {\n  it("groups skus per category", () => {\n    expect(byCategory([widget, gadget])).toEqual({ parts: ["W-1"], tools: ["G-1"] });\n  });\n});\n');
    add(wt, "tests/orders.test.ts", '\nimport { isTerminal } from "../src/orders/status.js";\ndescribe("isTerminal", () => {\n  it("is true for shipped and cancelled", () => {\n    expect(isTerminal("shipped")).toBe(true);\n    expect(isTerminal("paid")).toBe(false);\n  });\n});\n');
  },
};

// The fix for one task, made in its worktree: a hand-written edit, or a ts-rentals solution patch.
export function applyFix(wt, task) {
  if (FIXES[task.id]) return FIXES[task.id](wt);
  const patch = join(ROOT, "evals/solutions/ts-rentals", `${task.id}.patch`);
  if (!existsSync(patch)) throw new Error(`replay: no fix for task ${task.id}`);
  execFileSync("git", ["apply", patch], { cwd: wt, env: cleanEnv(), stdio: "pipe" });
}

// A commit that fixes nothing: a comment on the first source file the task owns.
export function applyNoop(wt, task) {
  const file = (task.files || []).find((f) => !/(^|\/)tests?\//.test(f));
  appendFileSync(join(wt, file), "\n// replay: no-op\n");
}

function isTest(f) {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(f);
}

// The workers a lead would have split a full-shape task into: one per source file.
function workersFor(dir, t) {
  return (t.files || [])
    .filter((f) => !isTest(f))
    .map((file, i) => ({
      n: i + 1,
      id: `worker-${i + 1}`,
      title: `Change ${file}`,
      files: [file],
      round: 1,
      branch: `doug/task-${t.id}-w${i + 1}`,
      commit: git(dir, "rev-parse", `doug/task-${t.id}`),
      filesTouched: [file],
      commandsRun: [],
      blocked: false,
      blockedReason: null,
      partial: false,
      handoff: null,
      resumed: 0,
    }));
}

function taskReport(dir, t, { swarm }) {
  const workers = swarm ? workersFor(dir, t) : undefined;
  return {
    id: t.id,
    implemented: true,
    blockedReason: null,
    stages: swarm ? ["lead", "worker-1", "verify", "review", "adversary"] : ["fix", "verify", "review", "adversary"],
    verified: true,
    verifierFindings: [],
    acceptance: [],
    reviewed: true,
    reviewIssues: [],
    inScope: true,
    memoryUsed: [],
    indexUsed: [],
    adversary: { ran: true, verdict: "pass", blocked: false, summary: "replay: nothing to flag", issues: [], commandsRun: [], error: null },
    size: t.size || "S",
    shape: "full",
    gate: "auto",
    branch: `doug/task-${t.id}`,
    commit: git(dir, "rev-parse", `doug/task-${t.id}`),
    partial: false,
    handoff: null,
    resumed: 0,
    reused: null,
    card: null,
    ...(swarm ? { workers, swarm: { applies: true, reason: "two or more source files", splitReason: "replay: independent files", briefs: workers.length, rebrief: null, workerCheck: false, checkFailed: [] } } : {}),
  };
}

// What `doug-implement.js` returns, in the shape rehearse-lib's readReport/reportTasks read.
export function reportFor(dir, plan, branch, { swarm = false, lacksWorkers = false } = {}) {
  const tasks = plan.tasks.map((t) => taskReport(dir, t, { swarm: swarm && !lacksWorkers }));
  return {
    ok: true,
    plan: plan.title,
    integrationBranch: branch,
    modelsSource: "CLAUDE.md",
    ...(swarm ? { swarm: { on: true, workerCheck: false } } : {}),
    levels: [{ index: 0, tasks }],
  };
}

// Workflow output for one plan: kind "implement" (doug-implement.js) or "queen" (a per-card queen.js).
// `swarm` adds the lead and workers to the report and their lines to the stream, with the Workflow's id as parent.
export function runWorkflow(ctx, { kind = "implement", cardId, noop = false, swarm = false, lacksWorkers = false } = {}) {
  const { dir, stream } = ctx;
  let planned = null;
  const out = writeWorkflowOutput(dir, stream, {
    kind,
    cardId,
    fix: (wt, task) => {
      if (noop) applyNoop(wt, task);
      else applyFix(wt, task);
    },
    report: (plan, { branch }) => {
      planned = plan;
      return reportFor(dir, plan, branch, { swarm, lacksWorkers });
    },
  });
  installModules(join(dir, integrationWorktreeFor(planned)));
  if (swarm && !lacksWorkers) {
    const wf = [...stream.lines].reverse().map((l) => JSON.parse(l)).find((j) => j.type === "assistant" && j.message.content.some((c) => c.type === "tool_use" && c.name === "Workflow"));
    const parent = wf.message.content.find((c) => c.name === "Workflow").id;
    stream.toolResult(stream.agent("doug-flow:swarm-lead", { parent }), "split into briefs", { parent });
    for (const t of planned.tasks) {
      for (const w of workersFor(dir, t)) {
        const id = stream.agent("doug-flow:worker", { parent });
        stream.toolResult(id, `${w.id} done`, { parent });
      }
    }
  }
  return out;
}

// ---- The flow scenario ------------------------------------------------------------------------------------------

// The gate session: /doug-next moves the card to In flow (uncommitted), spawns the planner, writes a draft plan, and
// stops at its approval gate.
function gate(ctx) {
  const { dir, stream } = ctx;
  const id = cardFromPrompt(ctx.prompt);
  announce(stream, "doug-flow:doug-next");
  stream.toolResult(stream.agent("doug-flow:planner"), "draft plan written");
  boardCli(dir, stream, ["move", id, "flow", dir]);
  draftPlan(dir, id);
  planCli(dir, stream, ["validate", dir]);
}

export function implement(ctx) {
  runWorkflow(ctx, { noop: process.env.DOUG_REPLAY_FAIL === "land" });
}

export const steps = [
  { stage: "gate", match: /^\/doug-next \S+$/, run: gate },
  { stage: "implement", match: "/doug-implement", run: implement },
];
export const failStage = "land";
export const skills = [
  "plugins/doug-flow/skills/doug-next/SKILL.md",
  "plugins/doug-flow/skills/doug-plan/SKILL.md",
  "plugins/doug-flow/skills/doug-implement/SKILL.md",
  "plugins/doug-flow/workflows/doug-implement.js",
];
export const writesWorkflowOutput = true;
