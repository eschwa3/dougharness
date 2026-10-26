// Replay script for the start-feature scenario (feature mode on a card): one session per phase (specification,
// architecture, refinement), each stopping at its gate with its file written and nothing committed. The plan the
// refinement session writes is the fixture task's own plan, as a draft. Written by hand per stage.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planCli, writeFile } from "../lib.mjs";
import { boardCards, must, offer, ran } from "./hand.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const failStage = "spec";
export const skills = ["plugins/doug-flow/skills/doug-start/SKILL.md"];
export const writesWorkflowOutput = false;

// The card the scenario works on is the one Ready card on the fixture's board.
function theCard(dir) {
  const ready = boardCards(dir).filter((c) => c.column === "ready");
  if (ready.length !== 1) throw new Error(`replay: expected one Ready card, found ${ready.length}`);
  return ready[0];
}

// The draft plan: the plan of the evals task whose plan title is the card's title.
function planFor(card) {
  for (const file of ["ts-basic", "ts-orders", "ts-rentals"]) {
    const suite = JSON.parse(readFileSync(join(REPO, "evals/tasks", `${file}.json`), "utf8"));
    const task = (suite.tasks || []).find((t) => t.plan && t.plan.title === card.title);
    if (task) return task.plan;
  }
  throw new Error(`replay: no evals task has a plan titled "${card.title}"`);
}

function specify(dir, stream, { spawn }) {
  const card = theCard(dir);
  offer(stream, "doug-flow:doug-start");
  if (spawn) stream.agent("doug-flow:spec-writer");
  writeFile(dir, stream, `docs/specs/${card.id}/spec.md`, `# ${card.id}: spec\n\n${card.goal}\n`);
}

export const steps = [
  {
    stage: "spec",
    match: "Do only the Specification phase",
    run: ({ dir, stream }) => specify(dir, stream, { spawn: true }),
    // The session writes spec.md but never spawns the spec-writer agent.
    fail: ({ dir, stream }) => specify(dir, stream, { spawn: false }),
  },
  {
    stage: "architecture",
    match: "Do only the Architecture phase",
    run({ dir, stream }) {
      const card = theCard(dir);
      offer(stream, "doug-flow:doug-start");
      ran(dir, stream, "pnpm test");
      stream.agent("architect");
      writeFile(dir, stream, `docs/specs/${card.id}/architecture.md`, `# ${card.id}: architecture\n\nChange the files the plan owns and keep the tests green.\n`);
    },
  },
  {
    stage: "plan",
    match: "Do only the Refinement phase",
    run({ dir, stream }) {
      const card = theCard(dir);
      offer(stream, "doug-flow:doug-start");
      stream.agent("doug-flow:planner");
      writeFile(dir, stream, ".doug/plan.json", `${JSON.stringify({ ...planFor(card), status: "draft", card: card.id }, null, 2)}\n`);
      must(planCli(dir, stream, ["validate"]), "plan validate");
    },
  },
];
