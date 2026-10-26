// Replay script for the init scenario. No stage spawns claude (refuse, init, doctor and reinit are acts), so
// there is nothing for a fake to script and no step. The failing run damages the prepared fixture instead:
// without package.json, doug init detects no gate command and its init stage fails.
import { rmSync } from "node:fs";
import { join } from "node:path";

export const steps = [];
export const failStage = "init";
export const skills = [];
export const writesWorkflowOutput = false;

export function damage(dir) {
  rmSync(join(dir, "package.json"), { force: true });
}
