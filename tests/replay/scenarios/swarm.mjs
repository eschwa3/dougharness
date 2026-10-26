// Replay of the swarm scenario (architecture.md 4.2, G3). The fixture starts with an approved swarm plan, so the only
// session is /doug-implement. The fake writes the workflow's output with the lead's workers in the report and on the
// stream (their lines carry the Workflow's id as parent_tool_use_id); the land act then runs for real.
//
// failStage is "implement": the report's task has no workers, so assertImplemented's requireWorkers check fails there.
import { runWorkflow } from "./flow.mjs";

export const steps = [
  {
    stage: "implement",
    match: "/doug-implement",
    run: (ctx) => runWorkflow(ctx, { swarm: true }),
    fail: (ctx) => runWorkflow(ctx, { swarm: true, lacksWorkers: true }),
  },
];
export const failStage = "implement";
export const skills = ["plugins/doug-flow/skills/doug-implement/SKILL.md", "plugins/doug-flow/workflows/doug-implement.js"];
export const writesWorkflowOutput = true;
