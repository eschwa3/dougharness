// Replay script for hard-auto (ts-rentals): the base auto steps, with every Ready card fixed from its solution
// patch in board order (a card that follows an overlapping one applies on top of it, because each patch is
// applied to the tree the earlier card left). The failing replay names one commit as the source of two cards.
import { withStage } from "../lib.mjs";
import * as base from "./auto.mjs";
import { boardCards, landCard, offer } from "./hand.mjs";

export const failStage = "build";
export const skills = base.skills;
export const writesWorkflowOutput = false;

export const steps = withStage(base.steps, "build", {
  fail({ dir, stream }) {
    offer(stream, "doug-flow:doug-next");
    const ready = boardCards(dir).filter((c) => c.column === "ready");
    if (ready.length < 2) throw new Error("replay: hard-auto needs two Ready cards");
    const first = landCard(dir, stream, ready[0].id);
    // The second card's code is committed as usual, but its Done source names the first card's commit.
    landCard(dir, stream, ready[1].id, { source: `commit ${first}` });
    for (const card of ready.slice(2)) landCard(dir, stream, card.id);
  },
});
