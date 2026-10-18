// The autopilot state file (.doug/.state/autopilot.json, card autopilot-live-queue) as the pane and the served board
// page show it. The pure view lives in autopilot-core.mjs (no Node imports, so the pane can use it); this module adds
// the file read. Neither throws on a missing, unreadable, or malformed file; a view of "no run" is null.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AUTOPILOT_FILE, parseAutopilot, startedFromList } from "./autopilot-core.mjs";

export { AUTOPILOT_FILE, STEPS, INACTIVE_MS, parseAutopilot, autopilotView, autopilotLines, shouldOpenPane, clearable, journalSeats, startedFromList } from "./autopilot-core.mjs";

// The parsed state, or null for a missing or unreadable file, invalid JSON, a wrong version, or a non-object.
export function readAutopilot(dir) {
  try {
    return parseAutopilot(readFileSync(join(dir, AUTOPILOT_FILE), "utf8"));
  } catch {
    return null;
  }
}

// The run data autopilotView reads for each running queen card: its journal texts and the seat start times from the
// agent meta files beside them. Never throws; an unreadable journal is left out.
export function readRuns(state) {
  const out = {};
  try {
    for (const c of Array.isArray(state?.cards) ? state.cards : []) {
      if (!c || c.state !== "running" || !Array.isArray(c.journals)) continue;
      const journals = [];
      let startedMs = {};
      for (const j of c.journals) {
        try {
          journals.push(readFileSync(j, "utf8"));
          const d = dirname(j);
          const list = readdirSync(d).map((name) => ({ name, mtimeMs: statSync(join(d, name)).mtimeMs }));
          startedMs = { ...startedMs, ...startedFromList(list) };
        } catch {
          // an unreadable journal adds no seats
        }
      }
      if (journals.length) out[c.id] = { journals, startedMs };
    }
  } catch {
    // no run data
  }
  return out;
}
