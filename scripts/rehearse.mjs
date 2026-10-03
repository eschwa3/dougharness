#!/usr/bin/env node
// On-demand live rehearsal of the flow, swarm, and hand tracks on a small real card (the ts-basic fixture's
// fix-hours), spawning the real `claude` binary. It is a script, not a test, and it never runs in the gate:
// evals/ already spends real money to measure arms and must not gain correctness assertions, and seam-contracts
// settles the deterministic side without a new top-level suite. It lives in root scripts/ because it depends on
// this checkout (evals fixtures, the CLI build); it loads the shipped plugin via --plugin-dir.
//
//   rehearse.mjs [flow|swarm|hand|all] --card <id> --spend [dir]
//     no arguments             print the estimate table and exit 2; nothing is spawned
//     a scenario, no --spend   print that scenario's per-stage estimate and exit 2; nothing is spawned
//     --spend, no --card       exit 2 ("--card <id> names the card this rehearsal records under"); nothing is spawned
//     --spend and --card       run it: [dir] is the real repository (default cwd) the outcome records under
//                               <the id> on its board; exit 0 when every run scenario is "passed", 1 otherwise
//
// Recording goes through the existing `board.mjs record` CLI only, never lib/board.mjs directly (that would
// bypass its research-note promotion and batch handling): the run form for flow/swarm (a synthetic, honest
// report when the workflow never wrote one, never invented task rows) and the hand form for hand, both carrying
// a rehearsal --note and --rehearsal <scenario> (the entry's heading and commit sha read as the fixture's, not
// this repository's landing); never memory.mjs (a fixture run has no run id the cost script can find, and the
// outcome log is for this repository's own runs). Every adversary block a real report carries is printed for the
// user to classify by hand.
//
// A passed scenario's fixture is removed after its stream logs and last report are archived into this
// repository's own .doug/.state/rehearsal/<scenario>-<timestamp>/ (a failed scenario keeps the whole fixture
// instead, as before). Every session this script spawns disallows the Artifact tool, since a gate or build stage
// that reaches the doug-board skill must never actually publish from a rehearsal.
//
// The `claude` binary name is overridable with $DOUG_REHEARSE_CLAUDE; a real user never sets it.

import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadBoard, findCard, adversaryBlocks } from "../plugins/doug-flow/lib/board.mjs";
import { parseArgs, estimateLines, SCENARIOS, scenarioTotal, runScenario, recordRunOutcome, recordHandOutcome, rehearsalNote, extractGateLine, archiveEvidence } from "./rehearse-lib.mjs";

function fail(msg, code = 2) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function printEstimates(scenario) {
  process.stdout.write("Estimated cost (USD), from docs/live-runs.md measurements:\n");
  for (const l of estimateLines(scenario)) process.stdout.write(l + "\n");
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.scenario) {
  printEstimates(null);
  process.stdout.write("\nusage: rehearse.mjs [flow|swarm|hand|all] --card <id> --spend [dir]\n");
  process.exit(2);
}
if (opts.scenario !== "all" && !SCENARIOS.includes(opts.scenario)) fail(`unknown scenario "${opts.scenario}"; scenarios are ${SCENARIOS.join(", ")}, all`, 2);

if (!opts.spend) {
  printEstimates(opts.scenario === "all" ? null : opts.scenario);
  process.stdout.write("\nAdd --spend to run it.\n");
  process.exit(2);
}
if (!opts.card) fail("--card <id> names the card this rehearsal records under", 2);

const dir = resolve(opts.dir || process.cwd());
let board;
try {
  board = loadBoard(dir);
} catch (err) {
  fail(`cannot read the board at ${dir}: ${err.message}`, 2);
}
if (!findCard(board, opts.card)) fail(`no card "${opts.card}" on the board at ${dir}`, 2);

const scenarios = opts.scenario === "all" ? SCENARIOS : [opts.scenario];
process.stdout.write(`Estimated cost: $${scenarios.reduce((s, n) => s + scenarioTotal(n), 0).toFixed(2)}. Running ${scenarios.join(", ")} against ${opts.card} at ${dir}.\n`);

let allPassed = true;
for (const scenario of scenarios) {
  const result = runScenario(scenario);
  const passed = result.outcome === "passed";
  allPassed = allPassed && passed;

  const outcomeForNote = result.reportSynthesized ? `no report: the session ended at stage ${result.failedStage}: ${result.failedMessage}` : result.outcome;
  const note = rehearsalNote({ scenario, outcome: outcomeForNote, stages: result.stages, cost: result.totalCost, agentNames: result.agentNames });

  process.stdout.write(`\n${scenario}: ${result.outcome}\n`);
  process.stdout.write(`  wall clock: ${result.wallClock}\n`);
  process.stdout.write(`  measured cost: $${result.totalCost.toFixed(2)}\n`);
  for (const s of result.stages) process.stdout.write(`  stage ${s.name}: wall ${s.wallClock}${s.cost !== null ? `, cost $${s.cost.toFixed(2)}` : ""}${s.streamPath ? `, stream ${s.streamPath}` : ""}\n`);

  // A passed fixture's evidence (its stream logs and last report) is archived into this repository before the
  // fixture is removed. Archiving lives in the same defended path as recording, right below: a throw here (an
  // unwritable .doug/.state, ENOSPC, ...) must not abort the loop before the outcome is recorded, and the evidence
  // must survive somewhere, so an archive failure is reported on its own line and keeps the fixture instead of
  // removing it, exactly like a failed scenario already does.
  let evidencePath = null;
  let keepFixture = !passed;
  if (passed) {
    try {
      evidencePath = archiveEvidence({ fixtureDir: result.fixtureDir, dir, scenario });
      process.stdout.write(`  evidence archived: ${evidencePath}\n`);
    } catch (err) {
      keepFixture = true;
      process.stdout.write(`  evidence not archived: ${err.message}\n`);
    }
  }
  process.stdout.write(`  fixture: ${result.fixtureDir}${keepFixture ? " (kept for inspection)" : " (removed)"}\n`);

  try {
    let recorded;
    if (scenario === "hand") {
      recorded = recordHandOutcome(dir, opts.card, { commit: result.commit, wallClock: result.wallClock, gate: extractGateLine(result.fixtureDir) || "not observed", note, rehearsal: scenario });
    } else {
      recorded = recordRunOutcome(dir, opts.card, { reportFile: result.reportFile, wallClock: result.wallClock, cost: result.totalCost, mergeCommit: result.commit, note, rehearsal: scenario });
      if (!result.reportSynthesized) {
        const report = JSON.parse(readFileSync(result.reportFile, "utf8"));
        const blocks = adversaryBlocks(report);
        if (blocks.length) {
          process.stdout.write("  adversary blocks (classify by hand with board.mjs record --adversary):\n");
          for (const b of blocks) process.stdout.write(`    ${b.task}/${b.id}${b.pass !== null ? ` (pass ${b.pass})` : ""}: ${b.description}\n`);
        }
      }
    }
    process.stdout.write(`  recorded: ${recorded}`);
  } catch (err) {
    process.stdout.write(`  recording failed: ${err.message}\n`);
    allPassed = false;
  }

  if (!keepFixture) rmSync(result.fixtureDir, { recursive: true, force: true });
}

process.exit(allPassed ? 0 : 1);
