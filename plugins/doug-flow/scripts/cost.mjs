#!/usr/bin/env node
// Real cost of one doug-implement run from the local Claude Code transcripts; no network, nothing estimated.
//   cost.mjs --session <id|latest> [dir] [--json] [--claude-dir <path>]
//     --session           price one Claude Code session: its transcript plus every subagent transcript under it
//                         (latest = the most recently modified one in the project); exit 1 when none is found
//   cost.mjs <run-id> [dir] [--json] [--claude-dir <path>]
//     <run-id>            the Workflow run id (wf_...)
//     [dir]               the project directory whose ~/.claude/projects slug is searched first (default cwd)
//     --since <iso>, --until <iso>  with --session: price only the assistant messages whose timestamp is in the
//                         window (card usd-budget-size-class: a hand landing's cost, openedAt to the landing)
//     --json              print the full result as JSON instead of the text tables
//     --by-card           a batch run (the plan at [dir] lists `cards`): add the per-card table, each card's tasks'
//                         agents summed for that card and the shared integration agents listed once (`byCard` in --json)
//     --claude-dir <path> where ~/.claude lives (tests point it at a fixture)
//     --report <path>     a saved workflow report (card adversary-usage-in-report): prices its adversary relays'
//                         Codex usage as a separate line/`codex` key, never mixed into the Claude total; default
//                         <dir>/REPORT_RELPATH (the last report any run wrote there, not necessarily this run's -
//                         the report carries no run id) when no --report is given and that file is readable
// Exit 1 when the run's journal cannot be found, or an explicit --report cannot be read/parsed; the text output ends
// with the run total and any unpriced agent. An unreadable/invalid default report is ignored, not a usage error.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { costRun, costSession, renderSession, renderCost, costByCard, renderCostByCard } from "../lib/cost.mjs";
import { planFor, REPORT_RELPATH, unwrapReport } from "../lib/plan.mjs";

const argv = process.argv.slice(2);
const FLAGS = new Set(["json", "by-card"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) {
    positional.push(argv[i]);
    continue;
  }
  const name = argv[i].slice(2);
  if (FLAGS.has(name)) {
    opts[name] = true;
    continue;
  }
  opts[name] = argv[i + 1] ?? "";
  i++;
}
const [runId, dirArg] = opts.session !== undefined ? [null, positional[0]] : positional;
if (opts.session === "") {
  process.stderr.write("usage: cost.mjs --session <id|latest> [dir] [--json] [--claude-dir <path>]\n");
  process.exit(2);
}
const USAGE_SESSION = "usage: cost.mjs --session <id|latest> [dir] [--since <iso>] [--until <iso>] [--json] [--claude-dir <path>]\n";
const window = {};
for (const flag of ["since", "until"]) {
  if (opts[flag] === undefined) continue;
  const at = opts[flag] === "" ? NaN : Date.parse(opts[flag]);
  if (opts.session === undefined || Number.isNaN(at)) {
    process.stderr.write(`${USAGE_SESSION}--${flag} takes an ISO date with --session, got ${JSON.stringify(opts[flag])}.\n`);
    process.exit(2);
  }
  window[flag] = at;
}
if (!runId && opts.session === undefined) {
  process.stderr.write("usage: cost.mjs <run-id> [dir] [--json] [--claude-dir <path>]\n");
  process.exit(2);
}
try {
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || dirArg || process.cwd());
  if (opts.session !== undefined) {
    const result = costSession({ session: opts.session, projectDir, claudeDir: opts["claude-dir"] ? resolve(opts["claude-dir"]) : undefined, since: window.since ?? null, until: window.until ?? null });
    process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + "\n" : renderSession(result));
    process.exit(0);
  }
  let reportPath = opts.report ? resolve(opts.report) : join(projectDir, REPORT_RELPATH);
  let report = null;
  if (opts.report) {
    report = unwrapReport(JSON.parse(readFileSync(reportPath, "utf8")));
  } else {
    // The default report is whichever run last wrote it, not necessarily this run's; missing, unreadable, or
    // invalid JSON there is not this command's problem, so it is ignored rather than failing the whole run.
    try {
      report = unwrapReport(JSON.parse(readFileSync(reportPath, "utf8")));
    } catch {
      report = null;
      reportPath = null;
    }
  }
  const result = costRun({ runId, projectDir, claudeDir: opts["claude-dir"] ? resolve(opts["claude-dir"]) : undefined, report, reportPath });
  const byCard = opts["by-card"] ? costByCard(result, planFor(projectDir, opts.card)) : null;
  if (opts.json) process.stdout.write(JSON.stringify(byCard ? { ...result, byCard } : result, null, 2) + "\n");
  else process.stdout.write(renderCost(result) + (byCard ? "\n" + renderCostByCard(byCard) : ""));
} catch (err) {
  process.stderr.write(err.message + "\n");
  process.exit(1);
}
