// Replay of the hard-parallel scenario (architecture.md 4.2, G3): the parallel replay on ts-rentals with six queued
// cards (three flow, three hand) and workers.max 3. Cards that share an owned file run in later waves (parallel.mjs
// wavesFor), so a later card's queen starts after the earlier card landed, and each fix is the card's solution patch
// (a later overlapping card's patch applies on top of the earlier one).
//
// failStage is "build": the failing replay launches one queen, lands it, and only then launches the rest, so one queen
// launch comes before the first plan.mjs land.
import { withStage } from "../lib.mjs";
import * as base from "./parallel.mjs";

export const steps = withStage(base.steps, "build", {
  run: (ctx) => base.build(ctx),
  fail: (ctx) => base.build(ctx, { splitFirst: true }),
});
export const failStage = "build";
export const skills = base.skills;
export const writesWorkflowOutput = true;
