// Replay script for the start scenario (project mode, an empty git repo): one session per phase. Each session
// installs or writes what its phase writes, spawns the agents the skill spawns, and stops at its gate with
// nothing committed; the runner's act after it stands in for the human's approval. Written by hand per stage.
import { dougCli, writeFile } from "../lib.mjs";
import { boardCards, memoryCli, must, offer, ran } from "./hand.mjs";

export const failStage = "idea";
export const skills = ["plugins/doug-flow/skills/doug-start/SKILL.md"];
export const writesWorkflowOutput = false;

function begin(stream) {
  offer(stream, "doug-flow:doug-start");
}

function addCard(dir, stream, id, title, column) {
  must(dougCli(dir, stream, ["board", "add", id, "--title", title, "--goal", `${title} for the duration converter.`, "--size", "S", "--class", "code", "--track", "hand", "--column", column, dir]), `board add ${id}`);
}

function idea(dir, stream, { spawn }) {
  begin(stream);
  must(dougCli(dir, stream, ["init", ".", "--yes", "--quiet"]), "doug init");
  if (spawn) stream.agent("doug-flow:spec-writer");
  writeFile(dir, stream, "docs/product/idea.md", "# Idea\n\nA tiny Node command-line tool, no dependencies, that converts durations such as 90m or 1h30m to seconds.\n");
}

export const steps = [
  {
    stage: "idea",
    match: "My idea:",
    run: ({ dir, stream }) => idea(dir, stream, { spawn: true }),
    // The session writes the file but never spawns the spec-writer agent.
    fail: ({ dir, stream }) => idea(dir, stream, { spawn: false }),
  },
  {
    stage: "architecture",
    match: "I approved the idea",
    run({ dir, stream }) {
      begin(stream);
      ran(dir, stream, "node --test --help");
      stream.agent("doug-flow:researcher");
      stream.agent("architect");
      writeFile(dir, stream, "docs/product/architecture.md", "# Architecture\n\nA single ES module with no dependencies, tested with node --test.\n");
      writeFile(dir, stream, ".doug/.state/scratch/stack-body.md", "The stack is Node with the built-in test runner and no dependencies, because the tool is one small function and a CLI wrapper.\n");
      must(memoryCli(dir, stream, ["decision", "propose", "--title", "Stack: Node with node --test", "--file", ".doug/.state/scratch/stack-body.md", dir]), "decision propose");
    },
  },
  {
    stage: "skeleton",
    match: "I approved the architecture",
    run({ dir, stream }) {
      begin(stream);
      stream.agent("tester");
      stream.agent("coder");
      stream.agent("reviewer");
      writeFile(dir, stream, "package.json", `${JSON.stringify({ name: "durations", version: "0.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
      writeFile(dir, stream, "src/duration.js", 'export function toSeconds(text) {\n  const m = /^(\\d+)m$/.exec(text);\n  if (!m) throw new Error(`Invalid duration: ${text}`);\n  return Number(m[1]) * 60;\n}\n');
      writeFile(dir, stream, "test/duration.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { toSeconds } from "../src/duration.js";\n\ntest("90m is 5400 seconds", () => {\n  assert.equal(toSeconds("90m"), 5400);\n});\n');
      ran(dir, stream, "node --test");
      // Re-running init detects the test script as a gate command.
      must(dougCli(dir, stream, ["init", ".", "--yes", "--quiet"]), "doug init (again)");
      if (!boardCards(dir).some((c) => c.id === "walking-skeleton")) addCard(dir, stream, "walking-skeleton", "Walking skeleton", "flow");
    },
  },
  {
    stage: "scope",
    match: "I approved the walking skeleton",
    run({ dir, stream }) {
      begin(stream);
      stream.agent("doug-flow:spec-writer");
      writeFile(dir, stream, "docs/product/scope.md", "# Scope\n\nHours and days, then a command-line wrapper.\n");
      addCard(dir, stream, "hours-and-days", "Hours and days", "ready");
      addCard(dir, stream, "cli-wrapper", "Command-line wrapper", "backlog");
    },
  },
];
