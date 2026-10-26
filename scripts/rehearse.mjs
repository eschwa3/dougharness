#!/usr/bin/env node
// On-demand live rehearsal of the flow, swarm, and hand tracks on a small real card (the ts-basic fixture's
// fix-hours), spawning the real `claude` binary. It is a script, not a test, and it never runs in the gate:
// evals/ already spends real money to measure arms and must not gain correctness assertions, and seam-contracts
// settles the deterministic side without a new top-level suite. It lives in root scripts/ because it depends on
// this checkout (evals fixtures, the CLI build); it loads the shipped plugin via --plugin-dir.
//
//   rehearse.mjs [flow|swarm|hand|auto|parallel|start|start-feature|init|board|memory|decide|swarm-skill|all]
//                [--tier hard] [--fixture ts-basic|ts-orders] [--dry-run] --card <id> --spend [dir]
//     no arguments             print the estimate table and exit 2; nothing is spawned
//     a scenario, no --spend   print that scenario's per-stage estimate and exit 2; nothing is spawned
//     --tier hard              the harder tier: flow, swarm-skill, start-feature, hand, auto and parallel run as hard-<name>
//                               on the ts-rentals fixture (12 modules, 11 tasks, 6-card queues); `all` runs the six; a name
//                               with no hard version exits 2; --fixture may only be ts-rentals. Without --tier the output
//                               is unchanged and a hard-* name is refused.
//     --dry-run                prepare the scenario's fixture, print each stage (name, kind, turn cap, $ cap) and the
//                               estimated cost of a live run, remove the fixture, and exit 0; no claude is spawned and
//                               nothing is recorded. With --spend it exits 2.
//     --fixture <name>         run the scenario on that fixture (flow, swarm, hand, auto, parallel and start-feature
//                               run on ts-basic by default and also on ts-orders, the larger order-management app;
//                               init, board, memory, decide and swarm-skill run on ts-orders only; start ignores it);
//                               a fixture the scenario does not run on exits 2 naming the ones it does
//     --spend, no --card       exit 2 ("--card <id> names the card this rehearsal records under"); nothing is spawned
//     --spend and --card       run it: [dir] is the real repository (default cwd) the outcome records under
//                               <the id> on its board; exit 0 when every run scenario is "passed", 1 otherwise
//
// Report-back: a live run (--spend) posts one completion line (scenarios, pass/fail, cost, docs/live-runs.md) to the session
// that launched it over CLAUDE_CODE_MESSAGING_SOCKET (scripts/report-back.mjs). It says nothing when that variable is absent;
// launch it with Bash run_in_background from the lead (not a subagent or Workflow seat) so the line is accepted as self-sent;
// a nohup launch is held by a bypass-mode lead (no-mode-asserted). The recorded outcome stays the record and polling stays the fallback. A replay run (DOUG_REPLAY_SCENARIO set, the fake
// claude in tests/replay) posts nothing.
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
import { resolve, join } from "node:path";
import { reportLine, postCompletion } from "./report-back.mjs";

const replayRun = (process.env.DOUG_REPLAY_SCENARIO ?? "").trim() !== "";
import { loadBoard, findCard, adversaryBlocks } from "../plugins/doug-flow/lib/board.mjs";
import { parseArgs, estimateLines, estimateFor, SCENARIOS, FIXTURE_NAMES, scenarioFixtures, scenarioTotal, capFor, SCENARIO_STAGES, TIERS, HARD_SCENARIOS, HARD_BASES, hardScenarioFor, isHardScenario, stagesFor, prepareFixture, runScenario, recordRunOutcome, recordHandOutcome, rehearsalNote, rehearsalGate, archiveEvidence, recordsAsHand } from "./rehearse-lib.mjs";

function fail(msg, code = 2) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function printEstimates(scenario, fixture = null, tier = null) {
  process.stdout.write("Estimated cost (USD), from docs/live-runs.md measurements:\n");
  for (const l of tier ? estimateLines(scenario, fixture, { tier }) : estimateLines(scenario, fixture)) process.stdout.write(l + "\n");
}

// The fixture a scenario runs on for this invocation: none for `start` (an empty repo, --fixture is ignored), else the
// one named or the scenario's default.
function fixtureFor(scenario, requested) {
  if (isHardScenario(scenario)) return "ts-rentals";
  return scenario === "start" ? null : requested || scenarioFixtures(scenario)[0];
}

// The scenarios an invocation runs: the one named, or for `all` every scenario (on its default fixture), or, with
// --fixture, every scenario that runs on that fixture plus start (which has none).
function scenariosFor(scenario, fixture) {
  if (scenario !== "all") return [scenario];
  if (opts.tier === "hard") return HARD_SCENARIOS;
  return fixture ? SCENARIOS.filter((s) => s === "start" || scenarioFixtures(s).includes(fixture)) : SCENARIOS;
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.scenario && opts.tier === null) {
  printEstimates(null);
  process.stdout.write("\nusage: rehearse.mjs [flow|swarm|hand|auto|parallel|start|start-feature|init|board|memory|decide|swarm-skill|all] [--tier hard] [--fixture <name>] [--dry-run] --card <id> --spend [dir]\n");
  process.exit(2);
}
if (opts.tier !== null && !TIERS.includes(opts.tier)) fail(`unknown tier "${opts.tier}"; tiers are ${TIERS.join(", ")}`, 2);
if (opts.tier === "hard") {
  if (!opts.scenario) {
    printEstimates(null, null, "hard");
    process.stdout.write("\nusage: rehearse.mjs [flow|swarm-skill|start-feature|hand|auto|parallel|all] [--tier hard] [--fixture ts-rentals] [--dry-run] --card <id> --spend [dir]\n");
    process.exit(2);
  }
  if (opts.scenario !== "all") {
    const hard = hardScenarioFor(opts.scenario);
    if (hard === null) fail(`scenario "${opts.scenario}" has no hard version; with --tier hard the scenarios are ${HARD_BASES.join(", ")}, all`, 2);
    opts.scenario = hard;
  }
} else if (opts.scenario !== "all" && !SCENARIOS.includes(opts.scenario)) {
  fail(`unknown scenario "${opts.scenario}"; scenarios are ${SCENARIOS.join(", ")}, all`, 2);
}

if (opts.dryRun && opts.spend) fail("--dry-run prepares the fixture and spends nothing; it cannot be combined with --spend", 2);
if (opts.tier === "hard") {
  if (opts.fixture !== null && opts.fixture !== "ts-rentals") fail("the hard tier runs on ts-rentals only", 2);
} else if (opts.fixture !== null && !FIXTURE_NAMES.includes(opts.fixture)) fail(`unknown fixture "${opts.fixture}"; fixtures are ${FIXTURE_NAMES.join(", ")}`, 2);
if (opts.tier !== "hard" && opts.fixture !== null && opts.scenario !== "all" && opts.scenario !== "start" && !scenarioFixtures(opts.scenario).includes(opts.fixture)) {
  fail(`scenario "${opts.scenario}" does not run on fixture "${opts.fixture}"; its fixtures are ${scenarioFixtures(opts.scenario).join(", ")}`, 2);
}
if (opts.scenario === "start" && opts.fixture !== null) process.stdout.write("Note: start runs on an empty git repo; --fixture is ignored.\n");

if (opts.dryRun) {
  // Prepare each named scenario's fixture, print the plan and its estimated cost, and remove the fixture. Nothing spawns
  // claude and nothing is recorded (card fixture-repo-scenarios).
  const names = scenariosFor(opts.scenario, opts.fixture);
  let prepared = true;
  let total = 0;
  const unmeasured = new Map();
  for (const scenario of names) {
    const fixture = fixtureFor(scenario, opts.fixture);
    let fx;
    try {
      fx = prepareFixture({ scenario, fixture: fixture || undefined, tempPrefix: `doug-rehearse-${scenario}-` });
    } catch (err) {
      prepared = false;
      process.stderr.write(`${scenario}: the fixture could not be prepared: ${err.message}\n`);
      continue;
    }
    rmSync(fx.dir, { recursive: true, force: true });
    // The header names the fixture only and the scenario's own line closes its block, so a scenario named like one of
    // its stages (init) never shadows that stage's line.
    process.stdout.write(`Stages${fixture ? ` on ${fixture}` : " on an empty git repo"}:\n`);
    for (const st of stagesFor(scenario)) {
      const detail = st.kind === "session" ? `turns ${st.maxTurns}, cap $${capFor(scenario, st.name, fixture).toFixed(2)}${isHardScenario(scenario) && st.timeoutMs ? `, timeout ${Math.round(st.timeoutMs / 60000)} min` : ""}` : st.kind === "command" ? `cap $${capFor(scenario, st.name, fixture).toFixed(2)}` : "no model call";
      process.stdout.write(`  ${st.name.padEnd(20)} ${st.kind.padEnd(8)} ${detail}\n`);
    }
    total += scenarioTotal(scenario, fixture);
    // Each block names its estimate source once, the same text estimateLines prints, so a figure that is not measured on
    // this fixture says so ("unmeasured on ts-orders: ...") in the output the live amount is approved from.
    const source = estimateFor(scenario, fixture || null).source;
    process.stdout.write(`  estimate source: ${source}\n`);
    const label = source.match(/^unmeasured on [\w-]+/);
    if (label) unmeasured.set(label[0], [...(unmeasured.get(label[0]) || []), scenario]);
    process.stdout.write(`  scenario ${scenario}: $${scenarioTotal(scenario, fixture).toFixed(2)} estimated\n`);
  }
  const partial = [...unmeasured].map(([label, ss]) => ` (${label} for ${ss.join(", ")})`).join("");
  process.stdout.write(`Estimated cost: $${total.toFixed(2)}${partial}\n`);
  process.exit(prepared ? 0 : 1);
}

if (!opts.spend) {
  printEstimates(opts.scenario === "all" ? null : opts.scenario, opts.fixture, opts.scenario === "all" ? opts.tier : null);
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

const scenarios = scenariosFor(opts.scenario, opts.fixture);
process.stdout.write(`Estimated cost: $${scenarios.reduce((s, n) => s + scenarioTotal(n, fixtureFor(n, opts.fixture)), 0).toFixed(2)}. Running ${scenarios.join(", ")} against ${opts.card} at ${dir}.\n`);

let allPassed = true;
let totalCost = 0;
const summaries = [];
try {
for (const scenario of scenarios) {
  const result = runScenario(scenario, { fixture: fixtureFor(scenario, opts.fixture) || undefined });
  const passed = result.outcome === "passed";
  allPassed = allPassed && passed;
  totalCost += result.totalCost || 0;
  summaries.push(`${scenario} ${passed ? "passed" : "failed"}`);

  const outcomeForNote = result.reportSynthesized ? `no report: the session ended at stage ${result.failedStage}: ${result.failedMessage}` : result.outcome;
  const note = rehearsalNote({ scenario, outcome: outcomeForNote, stages: result.stages, cost: result.totalCost, agentNames: result.agentNames, fixture: result.fixture });

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
    if (recordsAsHand(scenario)) {
      recorded = recordHandOutcome(dir, opts.card, { commit: result.commit, wallClock: result.wallClock, gate: rehearsalGate(result, result.fixtureDir), note, rehearsal: scenario, outcome: result.outcome === "passed" ? "passed" : "failed", fixture: result.fixture });
    } else {
      recorded = recordRunOutcome(dir, opts.card, { reportFile: result.reportFile, wallClock: result.wallClock, cost: result.totalCost, mergeCommit: result.commit, note, rehearsal: scenario, outcome: result.outcome === "passed" ? "passed" : "failed", fixture: result.fixture });
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
} catch (err) {
  process.stderr.write(`${err.stack || String(err)}\n`);
  if (!replayRun) await postCompletion(reportLine({ kind: "rehearsal", passed: false, summary: `crashed: ${String(err?.message ?? err).split("\n")[0]}`, costUsd: totalCost, resultPath: null }));
  process.exit(1);
}

if (!replayRun) await postCompletion(reportLine({ kind: "rehearsal", passed: allPassed, summary: summaries.join(", "), costUsd: totalCost, resultPath: join(dir, "docs/live-runs.md") }));
process.exit(allPassed ? 0 : 1);
