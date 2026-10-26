// Replay script for the auto scenario: the gate session shows the queue and stops, the build session lands every
// Ready card the way doug-hand does and asks nothing. Written by hand per stage; no archived stream is copied.
import { boardCards, landCard, offer } from "./hand.mjs";

export const failStage = "build";
export const skills = ["plugins/doug-flow/skills/doug-next/SKILL.md", "plugins/doug-flow/skills/doug-hand/SKILL.md"];
export const writesWorkflowOutput = false;

function readyCards(dir) {
  const ready = boardCards(dir).filter((c) => c.column === "ready");
  if (!ready.length) throw new Error("replay: no Ready card on the board");
  return ready;
}

export const steps = [
  {
    stage: "gate",
    match: /^\/doug-next --auto$/,
    run({ dir, stream }) {
      offer(stream, "doug-flow:doug-next");
      stream.toolUse("Bash", { command: "node plugins/doug-flow/scripts/board.mjs list" });
      readyCards(dir);
    },
  },
  {
    stage: "build",
    match: "I approved the queue",
    run({ dir, stream }) {
      offer(stream, "doug-flow:doug-next");
      for (const card of readyCards(dir)) landCard(dir, stream, card.id);
    },
    // Autopilot asks a question between the cards: an AskUserQuestion tool_use in the stream.
    fail({ dir, stream }) {
      offer(stream, "doug-flow:doug-next");
      for (const card of readyCards(dir)) landCard(dir, stream, card.id);
      stream.toolUse("AskUserQuestion", { questions: [{ question: "Continue with the next card?", options: ["yes", "no"] }] });
    },
  },
];
