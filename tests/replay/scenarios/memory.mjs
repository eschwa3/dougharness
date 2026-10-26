// Replay script for the memory scenario. Its recall stage calls no model; reflect, model regen and ideas are
// command stages: memory.mjs spawns this fake with the prompt on stdin and reads one JSON envelope. A step is
// keyed by the opening line of the prompt memory.mjs builds (architecture.md fact 2). The answers cite lesson
// ids and Backlog card ids read from the prompt, because memory.mjs drops any proposal whose citation it cannot
// resolve. Written by hand per stage.
import { envelope } from "../lib.mjs";

export const failStage = "reflect";
export const skills = [];
export const writesWorkflowOutput = false;

const lessonIds = (prompt) => [...new Set([...String(prompt).matchAll(/\[([0-9a-f]{16})\]/g)].map((m) => m[1]))];

export const steps = [
  {
    stage: "reflect",
    match: "You are proposing at most 3 lessons for a coding harness's memory store",
    // The report credits a seeded lesson; the model proposes nothing new, which the prompt allows.
    envelope: () => envelope("lessons", []),
    // An envelope with no structured_output: memory.mjs throws "structured_output.lessons is missing".
    fail: () => JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0, session_id: "replay" }),
  },
  {
    stage: "model-regen",
    match: "You write the project model of a coding harness",
    envelope({ prompt, schema }) {
      const [id] = lessonIds(prompt);
      if (!id) throw new Error("replay: the model-regen prompt lists no lesson");
      const section = schema?.properties?.statements?.items?.properties?.section?.enum?.[0] || "conventions";
      return envelope("statements", [{ section, text: "Order totals round half up to the cent.", citations: [id] }]);
    },
  },
  {
    stage: "ideas",
    match: "You look over the lessons and run history of a coding harness",
    envelope({ prompt }) {
      const [id] = lessonIds(prompt);
      if (!id) throw new Error("replay: the ideas prompt lists no lesson");
      const backlog = /^- (\S+) \(backlog\):/m.exec(String(prompt));
      const ideas = [{ id: "replay-round-half-up-audit", title: "Audit the other money paths for half-up rounding", goal: "Check every money path rounds half up, as the tax path does.", component: "billing", size: "S", citations: [id] }];
      const reviews = backlog ? [{ text: "These Backlog cards touch the order store.", cards: [backlog[1]], citations: [id] }] : [];
      return envelope("ideas", ideas, { reviews });
    },
  },
];
