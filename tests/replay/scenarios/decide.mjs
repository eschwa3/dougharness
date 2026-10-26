// Replay script for the decide scenario: the /doug-decide session writes the decision proposal with
// memory.mjs decision propose and stops at its apply/skip gate. The runner's apply act answers the gate.
// Written by hand per stage.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryCli, must, offer } from "./hand.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BODY = ".doug/.state/scratch/decision-body.md";

export const failStage = "propose";
export const skills = ["plugins/doug-flow/skills/doug-decide/SKILL.md"];
export const writesWorkflowOutput = false;

export const steps = [
  {
    stage: "propose",
    match: "/doug-decide decision",
    run({ dir, stream }) {
      offer(stream, "doug-flow:doug-decide");
      const { title } = JSON.parse(readFileSync(join(REPO, "evals/tasks/ts-orders.json"), "utf8")).rehearsal.decide;
      must(memoryCli(dir, stream, ["decision", "propose", "--title", title, "--file", BODY, dir]), "decision propose");
    },
    // The session reads the body and stops without writing a proposal.
    fail({ dir, stream }) {
      offer(stream, "doug-flow:doug-decide");
      stream.toolUse("Read", { file_path: join(dir, BODY) });
    },
  },
];
