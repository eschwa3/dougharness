// Replay script for hard-start-feature (ts-rentals): the base start-feature steps. Every step reads its card and
// its plan from the fixture's board and the evals task files, so the same steps serve the harder fixture; the
// spec stage is re-exported through withStage with its failing variant unchanged (no spec-writer spawn).
import { withStage } from "../lib.mjs";
import * as base from "./start-feature.mjs";

export const failStage = "spec";
export const skills = base.skills;
export const writesWorkflowOutput = false;

export const steps = withStage(base.steps, "spec", { fail: base.steps.find((s) => s.stage === "spec").fail });
