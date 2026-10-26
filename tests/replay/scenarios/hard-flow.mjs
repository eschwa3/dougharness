// Replay of the hard-flow scenario (architecture.md 4.2, G3): the flow replay on ts-rentals. The implement step is
// registered again through withStage so the hard file owns it; the fix of each task is its solution patch under
// evals/solutions/ts-rentals (flow.mjs applyFix). failStage and the failing replay are the base's: the implement step
// commits a no-op fix, so the held-out tests stay red at the land act.
import { withStage } from "../lib.mjs";
import * as base from "./flow.mjs";

export const steps = withStage(base.steps, "implement", { run: base.implement });
export const failStage = base.failStage;
export const skills = base.skills;
export const writesWorkflowOutput = true;
