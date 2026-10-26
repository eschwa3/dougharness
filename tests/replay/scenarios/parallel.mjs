// Replay of the parallel scenario (architecture.md 4.2, G3): /doug-next --auto with workers.max 2 runs one flow card and
// one hand card at once, each under its own queen, and lands them one at a time. The gate session stops at the queue
// approval; the build session (the approval is in its prompt) launches every queen of a wave before the first land,
// and main edits no file under src/ (the fixes are made by the queens, so they never appear as main-thread lines).
//
// The fake writes the queens' output (spec decision 3): a flow card gets a per-card plan, task and integration
// branches and .doug/.state/reports/<id>/last-report.json (kind "queen"); a hand card gets a card/<id> branch and
// worktree, one commit, and card-report.json. Landing is real: plan.mjs done/land --card for a flow card,
// plan.mjs land-card for a hand card, board.mjs move and record --hand, then the board commit doug-hand makes.
//
// failStage is "gate": the failing replay launches a queen from the gate session.
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { planPathFor } from "../../../plugins/doug-flow/lib/plan.mjs";
import { ROOT, announce, applyFix, boardCards, draftPlan, git, installModules, runInSession, runWorkflow } from "./flow.mjs";
import { boardCli, commit, planCli } from "../lib.mjs";

function ownedFiles(cardId) {
  for (const name of ["ts-rentals", "ts-orders", "ts-basic"]) {
    const suite = JSON.parse(readFileSync(join(ROOT, "evals/tasks", `${name}.json`), "utf8"));
    const task = suite.tasks.find((t) => t.id === cardId || t.id === `${cardId}-planned`);
    if (task) return task.allowedFiles;
  }
  throw new Error(`replay: no eval task for card ${cardId}`);
}

// The cards in board order, in waves: a card waits for the wave after any earlier card it shares an owned file with
// or depends on (the disjointness rule of doug-next's parallel section), so the others can run at once.
export function wavesFor(dir) {
  const ready = boardCards(dir).filter((c) => c.column === "ready");
  const level = new Map();
  const waves = [];
  for (const card of ready) {
    const files = ownedFiles(card.id);
    let w = 0;
    for (const earlier of ready.slice(0, ready.indexOf(card))) {
      const shared = ownedFiles(earlier.id).some((f) => files.includes(f));
      if (shared || (card.deps || []).includes(earlier.id)) w = Math.max(w, level.get(earlier.id) + 1);
    }
    level.set(card.id, w);
    (waves[w] = waves[w] || []).push(card);
  }
  return waves;
}

function launchFlow(ctx, card) {
  const { dir, stream } = ctx;
  const id = card.id;
  boardCli(dir, stream, ["move", id, "flow", dir]);
  draftPlan(dir, id, { rel: planPathFor(id) });
  for (const args of [
    ["set", "card", id, "--card", id],
    ["set", "integrationBranch", `doug/${id}`, "--card", id],
    ["set", "integrationWorktree", `.claude/worktrees/doug-integration-${id}`, "--card", id],
    ["approve", "--card", id],
  ]) {
    const r = planCli(dir, stream, args);
    if (!r.ok) throw new Error(`plan.mjs ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  runWorkflow(ctx, { kind: "queen", cardId: id });
}

function launchHand(ctx, card) {
  const { dir, stream } = ctx;
  const id = card.id;
  boardCli(dir, stream, ["move", id, "flow", dir]);
  const worktree = join(dir, ".claude/worktrees", `card-${id}`);
  git(dir, "worktree", "add", "-q", "-B", `card/${id}`, worktree, "HEAD");
  applyFix(worktree, { id });
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", `${id}: replay fix`);
  installModules(worktree);
  stream.toolUse("Workflow", { scriptPath: join(dir, ".doug/.state/reports", id, "queen.js") });
  const reports = join(dir, ".doug/.state/reports", id);
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "card-report.json"), `${JSON.stringify({ ok: true, card: id, branch: `card/${id}`, worktree, commit: git(worktree, "rev-parse", "HEAD") }, null, 2)}\n`);
}

function must(r, what) {
  if (!r.ok) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

function land(ctx, card) {
  const { dir, stream } = ctx;
  const id = card.id;
  if (card.track === "hand") {
    must(planCli(dir, stream, ["land-card", id, "--branch", `card/${id}`, "--worktree", join(dir, ".claude/worktrees", `card-${id}`)]), `plan.mjs land-card ${id}`);
    const sha = git(dir, "rev-parse", "HEAD");
    must(boardCli(dir, stream, ["move", id, "done", dir, "--source", `Landed as ${sha}`]), `board.mjs move ${id}`);
    must(boardCli(dir, stream, ["record", id, "--hand", "--summary", `Landed ${id} by hand.`, "--commit", sha, "--gate", "replay: gate ran at land-card", dir]), `board.mjs record ${id}`);
    return;
  }
  must(planCli(dir, stream, ["done", "--card", id]), `plan.mjs done --card ${id}`);
  must(planCli(dir, stream, ["land", "--card", id]), `plan.mjs land --card ${id}`);
  must(boardCli(dir, stream, ["move", id, "done", dir, "--source", `Landed as ${git(dir, "rev-parse", "HEAD")}`]), `board.mjs move ${id}`);
}

// `splitFirst` is the failing replay of hard-parallel: the first card runs and lands alone, so only one queen launch
// comes before the first land.
export function build(ctx, { splitFirst = false } = {}) {
  const { dir, stream } = ctx;
  announce(stream, "doug-flow:doug-next");
  let waves = wavesFor(dir);
  if (splitFirst) waves = [[waves[0][0]], waves[0].slice(1), ...waves.slice(1)].filter((w) => w.length);
  for (const wave of waves) {
    for (const card of wave) (card.track === "hand" ? launchHand : launchFlow)(ctx, card);
    for (const card of wave) land(ctx, card);
  }
  runInSession(ctx, "pnpm test");
  const done = commit(dir, stream, `Board: ${waves.flat().map((c) => c.id).join(", ")} done`);
  if (!done.ok) throw new Error(`git commit failed: ${done.stderr}`);
}

export function gate(ctx) {
  announce(ctx.stream, "doug-flow:doug-next");
}

// A queen launched before the queue approval: the Workflow line the gate assert forbids.
export function gateWithLaunch(ctx) {
  announce(ctx.stream, "doug-flow:doug-next");
  const first = boardCards(ctx.dir).find((c) => c.column === "ready");
  ctx.stream.toolUse("Workflow", { scriptPath: join(ctx.dir, ".doug/.state/reports", first.id, "queen.js") });
}

export const steps = [
  { stage: "gate", match: /^\/doug-next --auto$/, run: gate, fail: gateWithLaunch },
  { stage: "build", match: "I approved the queue", run: (ctx) => build(ctx) },
];
export const failStage = "gate";
export const skills = [
  "plugins/doug-flow/skills/doug-next/SKILL.md",
  "plugins/doug-flow/skills/doug-hand/SKILL.md",
  "plugins/doug-flow/workflows/card-queen.js",
];
export const writesWorkflowOutput = true;
