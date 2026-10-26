// Replay script for hard-hand (ts-rentals): the base hand steps, with the card fixed from its solution patch
// (hand.mjs applies it for any card that is not a ts-basic one). The failing replay lands a commit that touches
// only tests/, so the card's required source file is missing from it. The one test it adds passes, so the Stop
// gate lets the session end and the build assert is what fails.
import { withStage, writeFile } from "../lib.mjs";
import * as base from "./hand.mjs";
import { boardCards, landCard, offer } from "./hand.mjs";

export const failStage = "build";
export const skills = base.skills;
export const writesWorkflowOutput = false;

function testsOnly(dir, stream) {
  writeFile(dir, stream, "tests/replay-placeholder.test.ts", 'import { expect, it } from "vitest";\n\nit("is a test and nothing else", () => {\n  expect(1).toBe(1);\n});\n');
}

export const steps = withStage(base.steps, "build", {
  fail({ dir, stream }) {
    offer(stream, "doug-flow:doug-next");
    const card = boardCards(dir).find((c) => c.column === "flow");
    if (!card) throw new Error("replay: no card is in flow");
    landCard(dir, stream, card.id, { fix: testsOnly });
  },
});
