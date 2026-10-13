// The autopilot state file (.doug/.state/autopilot.json, card autopilot-live-queue) as the pane and the served board
// page show it. The pure view lives in autopilot-core.mjs (no Node imports, so the pane can use it); this module adds
// the file read. Neither throws on a missing, unreadable, or malformed file; a view of "no run" is null.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOPILOT_FILE, parseAutopilot } from "./autopilot-core.mjs";

export { AUTOPILOT_FILE, STEPS, INACTIVE_MS, parseAutopilot, autopilotView, autopilotLines, shouldOpenPane } from "./autopilot-core.mjs";

// The parsed state, or null for a missing or unreadable file, invalid JSON, a wrong version, or a non-object.
export function readAutopilot(dir) {
  try {
    return parseAutopilot(readFileSync(join(dir, AUTOPILOT_FILE), "utf8"));
  } catch {
    return null;
  }
}
