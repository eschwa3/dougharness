// Replay of the hard-swarm-skill scenario (architecture.md 4.2, G3): the swarm-skill replay on ts-rentals, where the
// card is rental-helpers (three source files, size M) and its fix is the solution patch under evals/solutions/ts-rentals.
// failStage and the failing replay are the base's: no last-report.json is written at run.
import { withStage } from "../lib.mjs";
import * as base from "./swarm-skill.mjs";

export const steps = withStage(base.steps, "run", { run: base.run });
export const failStage = base.failStage;
export const skills = base.skills;
export const writesWorkflowOutput = true;
