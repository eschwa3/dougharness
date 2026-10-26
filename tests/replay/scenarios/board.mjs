// Replay script for the board scenario. No stage spawns claude (every stage is an act on the doug board CLI),
// so there is nothing for a fake to script and no step. The failing run damages the prepared fixture instead:
// a board file that is not JSON makes the first stage, list, fail.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const steps = [];
export const failStage = "list";
export const skills = [];
export const writesWorkflowOutput = false;

export function damage(dir) {
  writeFileSync(join(dir, ".doug/board.json"), "{ this is not json");
}
