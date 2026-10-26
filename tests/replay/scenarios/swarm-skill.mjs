// Replay of the swarm-skill scenario (architecture.md 4.2, G3): /doug-swarm plans with swarm on and stops at the plan
// approval (gate), the approve act answers it, and the run session runs swarm-launch, saves the report, lands the plan
// and moves the card to Done. The fake writes the workflow's output with workers (spec decision 3); done and land run
// for real, and the Done move is the last act, so HEAD stays the merge commit the run assert wants.
//
// failStage is "run": the failing replay writes no last-report.json.
import { announce, boardCards, cardFromPrompt, draftPlan, git, runInSession, runWorkflow } from "./flow.mjs";
import { boardCli, planCli } from "../lib.mjs";

export function gate(ctx) {
  const { dir, stream } = ctx;
  const id = cardFromPrompt(ctx.prompt);
  announce(stream, "doug-flow:doug-swarm");
  stream.toolResult(stream.agent("doug-flow:planner"), "draft plan written");
  boardCli(dir, stream, ["move", id, "flow", dir]);
  draftPlan(dir, id, { patch: { swarm: true } });
  planCli(dir, stream, ["validate", dir]);
}

export function run(ctx) {
  const { dir, stream } = ctx;
  const id = cardFromPrompt(ctx.prompt);
  if (!boardCards(dir).some((c) => c.id === id)) throw new Error(`replay: no card ${id} on the board`);
  runWorkflow(ctx, { swarm: true });
  for (const args of [["done"], ["land"]]) {
    const r = planCli(dir, stream, args);
    if (!r.ok) throw new Error(`plan.mjs ${args[0]} failed: ${r.stderr || r.stdout}`);
  }
  runInSession(ctx, "pnpm test");
  const moved = boardCli(dir, stream, ["move", id, "done", dir, "--source", `Landed as ${git(dir, "rev-parse", "HEAD")}`]);
  if (!moved.ok) throw new Error(`board.mjs move failed: ${moved.stderr || moved.stdout}`);
}

export const steps = [
  { stage: "gate", match: "Do sections 1 to 3 only", run: gate },
  // The failing replay: the session ends before the workflow returns, so nothing is written.
  { stage: "run", match: "Resume at section 4", run, fail: () => {} },
];
export const failStage = "run";
export const skills = [
  "plugins/doug-flow/skills/doug-swarm/SKILL.md",
  "plugins/doug-flow/skills/swarm-launch/SKILL.md",
  "plugins/doug-flow/workflows/doug-implement.js",
];
export const writesWorkflowOutput = true;
