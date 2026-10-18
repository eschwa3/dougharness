#!/usr/bin/env node
// CLI for the development board, used by the /doug-next and doug-hand skills. Deterministic; no agents.
//   board.mjs next [dir] [--track flow|hand|any] [--tag <tag>] [--epic <id>] [--milestone <id>]
//                                                 the first Ready card on that track (default flow) whose deps are
//                                                 Done, as JSON (exit 1 if none); --tag filters to cards carrying it
//   board.mjs next --batch <n> [dir] [--track flow|hand|any] [--tag <tag>] [--epic <id>] [--milestone <id>]
//                                                 the first n runnable Ready cards, in board order, as a JSON array
//                                                 (exit 1 if none): the cards /doug-next plans together; stderr also
//                                                 carries a `wall cap: <m> min` line (the cards' budgets from the size x class table)
//                                                 and a `usd cap: $<x>` line after it (the cards' budgets from the usd table)
//   board.mjs budgets [dir] [--usd] [--from <live-runs file>]
//                                                 without --from, the shipped wall budget table as `table: <JSON>`;
//                                                 with --from, recomputes it (p80 per size/class cell) from the file's
//                                                 Wall clock rows joined to the board, one line per cell and a final
//                                                 `table:` line; writes nothing (replace WALL_BUDGET_MIN by hand). --usd does the same for the usd
//                                                 table (USD_BUDGET) from the Cost rows of flow and hand entries
//   board.mjs rollup [dir] [--epic <id> | --milestone <id>] [--from <live-runs file>]
//                                                 per epic and milestone: columns, done/total, size-weighted progress,
//                                                 measured cost and wall of Done cards, not-Done budget, as JSON; --from
//                                                 defaults to docs/live-runs.md when present (else measured is null)
//   board.mjs labels --check [dir]                one line per label colour under 3:1 against #ffffff or #1c2022; exit 0
//   board.mjs card <id> [dir]                     one card as JSON
//   board.mjs reorder <id> [dir] --before <other> | --after <other> | --top | --bottom
//                                                 reorder a card within its column
//   board.mjs move <id> <column> [dir] [--source <text>]
//                                                 move a card
//   board.mjs edit <id> [dir] [--title <t>] [--goal <g> | --goal-file <path>] [--size S|M|L] [--component <c>]
//                     [--track flow|hand] [--class <c>] [--deps a,b] [--tag a,b] [--source <s>] [--epic <id>] [--milestone <id>] [--force]
//                                                 changes a card's fields through the record's own validation
//                                                 (never the id or the column; move stays the way to change that);
//                                                 --tag "" clears a card's tags; --epic "" / --milestone "" clear those
//   board.mjs epic add <id> --title <t> --goal <g> [dir] [--version <v>] [--date YYYY-MM-DD]
//   board.mjs epic edit <id> [dir] [--title <t>] [--goal <g>] [--version <v>] [--date <d>] [--status planned|active|done] [--force]
//   board.mjs epic list [dir]                     epics as a JSON array; milestone add|edit|list takes the same flags.
//                                                 --status done is refused while a member card is not Done (--force sets it, with a warning)
//   board.mjs remove <id> [dir] [--force]         removes a card from the record: refused always when another card
//                                                 lists it in deps; refused without --force when it is done, in
//                                                 flow, or named by .doug/plan.json (each with --force removes it
//                                                 and prints a warning to stderr); prints the removed card as JSON
//                                                 to stdout so a mistaken removal can be re-added by hand
//   board.mjs record <id> <report.json> [dir] --summary "<one sentence>" [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]... [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>] [--run <run-id>] [--claude-dir <dir>]
//                                                 append a run entry for the card to docs/live-runs.md; every adversary block
//                                                 in the report is classified real, marginal, or false (repeat the flag per block).
//                                                 When .doug/plan.json lists the card among its `cards` (a batch), the entry
//                                                 shows only that card's tasks, --cost is that card's tasks' cost, and
//                                                 --shared-cost <usd> the shared integration agents', counted once
//   board.mjs record <id> --hand [dir] --summary "<one sentence>" [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>] [--cost <usd>]
//                                                 append a hand-track entry (no report) for the card
//   --rehearsal <scenario> (either form) marks the entry as a rehearse.mjs run on the ts-basic fixture (the start scenario: an empty git repo): the first
//   prose line and the commit sha (abbreviated to 7 characters) read as the fixture's, not this repository's.
//   --rehearsal-outcome <passed|failed> is required with --rehearsal (and refused without it): the entry's Outcome reads
//   "rehearsal <scenario> <outcome>", never "landed", and a rehearsal record writes no landing-block files (it is no landing).
//   Either record form also promotes .doug/.state/research/<id>.md to docs/research/<id>.md when that note
//   exists and differs from the docs copy, copying it and printing one line saying so; a card with no note, or
//   whose docs copy is already byte-identical, is untouched, silently.
//   board.mjs summary <report.json> --summary "<one sentence>" [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>] [--run <run-id>] [--claude-dir <dir>] [--note <text>]
//                                                 the three-line chat summary of a report (--card: that card's tasks only)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadBoard, saveBoard, findCard, nextReadyCard, nextReadyCards, moveCard, editCard, editEpic, editMilestone, initLabelGroups, addEpic, addMilestone, removeCard, reorderCard, readyCapWarning, wallCapMinutes, WALL_BUDGET_MIN, WALL_BUDGET_MIN_N, parseLiveRunWalls, wallBudgetTable, USD_BUDGET, USD_BUDGET_MIN_N, usdCapDollars, parseLiveRunCosts, usdBudgetTable, rollup, checkFilters, labelContrastFailures, LIVE_RUNS_RELPATH, runEntry, handEntry, handWallVerdict, runSummary, boardPath, parseAdversaryClasses, filterReportForCard, recordLanding } from "../lib/board.mjs";
import { loadPlan, planFor, unwrapReport, DEFAULT_BUDGET } from "../lib/plan.mjs";
import { wallForRun } from "../lib/cost.mjs";

const EDIT_FIELD_ORDER = ["title", "goal", "size", "component", "track", "class", "tags", "deps", "source", "epic", "milestone"];
const EDIT_USAGE = "usage: board.mjs edit <id> [dir] [--title <t>] [--goal <g> | --goal-file <path>] [--size S|M|L] [--component <c>] [--track flow|hand] [--class <c>] [--tag a,b] [--deps a,b] [--source <s>] [--epic <id>] [--milestone <id>] [--force]";

const argv = process.argv.slice(2);
const FLAGS = new Set(["hand", "top", "bottom", "force", "usd", "check"]);
const REPEATABLE = new Set(["adversary"]);

// Each subcommand's allowed flags, derived from what that case actually reads (card board-cli-unknown-flags).
// `record` has two forms (--hand or not) with different allowed sets, handled separately below.
const SUBCOMMAND_FLAGS = {
  next: ["track", "batch", "tag", "epic", "milestone"],
  card: [],
  move: ["source"],
  edit: ["title", "goal", "goal-file", "size", "component", "track", "class", "deps", "tag", "source", "epic", "milestone", "force"],
  remove: ["force"],
  reorder: ["before", "after", "top", "bottom"],
  budgets: ["from", "usd"],
  rollup: ["epic", "milestone", "from"],
  labels: ["check"],
  summary: ["summary", "cost", "codex-cost", "wall", "commit", "card", "run", "claude-dir", "note"],
};
// epic and milestone: `<kind> add|edit|list`, each action with its own allowed flags.
const PLAN_ACTION_FLAGS = {
  add: ["title", "goal", "version", "date"],
  edit: ["title", "goal", "version", "date", "status", "force"],
  list: [],
};
const planUsage = (kind) => [
  `usage: board.mjs ${kind} add <id> --title <t> --goal <g> [dir] [--version <v>] [--date YYYY-MM-DD]`,
  `       board.mjs ${kind} edit <id> [dir] [--title <t>] [--goal <g>] [--version <v>] [--date YYYY-MM-DD] [--status planned|active|done] [--force]`,
  `       board.mjs ${kind} list [dir]`,
].join("\n");
const RECORD_HAND_FLAGS = ["summary", "hand", "commit", "wall", "gate", "note", "rehearsal", "rehearsal-outcome", "cost"];
const RECORD_REPORT_FLAGS = ["summary", "cost", "codex-cost", "wall", "commit", "adversary", "shared-cost", "note", "rehearsal", "rehearsal-outcome", "run", "claude-dir"];
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
  if (REPEATABLE.has(name)) (opts[name] ||= []).push(argv[i + 1] ?? "");
  else opts[name] = argv[i + 1] ?? "";
  i++;
}
const [cmd, ...rest] = positional;

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const USAGE_FOR = {
  next: "usage: board.mjs next [dir] [--track flow|hand|any] [--batch <n>] [--tag <tag>] [--epic <id>] [--milestone <id>]",
  card: "usage: board.mjs card <id> [dir]",
  move: "usage: board.mjs move <id> <column> [dir] [--source <text>]",
  edit: EDIT_USAGE,
  remove: "usage: board.mjs remove <id> [dir] [--force]",
  reorder: "usage: board.mjs reorder <id> [dir] --before <other> | --after <other> | --top | --bottom",
  budgets: "usage: board.mjs budgets [dir] [--usd] [--from <live-runs file>]",
  rollup: "usage: board.mjs rollup [dir] [--epic <id> | --milestone <id>] [--from <live-runs file>]",
  labels: "usage: board.mjs labels --check [dir] | labels init [dir]",
  summary: "usage: board.mjs summary <report.json> --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>] [--run <run-id>] [--claude-dir <dir>] [--note <text>]",
};
const RECORD_HAND_USAGE = "usage: board.mjs record <id> --hand [dir] --summary \"<one sentence>\" [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>] [--cost <usd>]";
const RECORD_REPORT_USAGE = "usage: board.mjs record <id> <report.json> [dir] --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary \"<id>=<class>[: <reason>]\"]... [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>] [--run <run-id>] [--claude-dir <dir>]";

// An unknown --flag for the given subcommand: exit 2, name the flag and the subcommand's usage.
// Runs on flag names only (parse order doesn't matter), before any work or write.
function unknownFlagFor(cmd, opts) {
  const allowed = new Set(cmd === "record" ? (opts.hand ? RECORD_HAND_FLAGS : RECORD_REPORT_FLAGS) : SUBCOMMAND_FLAGS[cmd] || []);
  for (const name of Object.keys(opts)) {
    if (!allowed.has(name)) return name;
  }
  return undefined;
}

function dirFrom(args, n) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || args[n] || process.cwd());
}

if (cmd === "epic" || cmd === "milestone") {
  const action = rest[0];
  if (!Object.prototype.hasOwnProperty.call(PLAN_ACTION_FLAGS, action)) fail(planUsage(cmd), 2);
  const unknown = Object.keys(opts).find((name) => !PLAN_ACTION_FLAGS[action].includes(name));
  if (unknown !== undefined) fail(`unknown option --${unknown} for board.mjs ${cmd}\n${planUsage(cmd)}`, 2);
}
if (cmd === "record" || Object.prototype.hasOwnProperty.call(SUBCOMMAND_FLAGS, cmd)) {
  const unknown = unknownFlagFor(cmd, opts);
  if (unknown !== undefined) {
    const usageLine = cmd === "record" ? (opts.hand ? RECORD_HAND_USAGE : RECORD_REPORT_USAGE) : USAGE_FOR[cmd];
    fail(`unknown option --${unknown} for board.mjs ${cmd}\n${usageLine}`, 2);
  }
}

// --summary: the lead's one sentence of what changed for the user, required by record and summary (card
// landing-one-sentence-summary). Trimmed, non-empty, one line, no sentence end followed by more text.
// Checked before anything is appended or promoted; printed as stdout's first line, never written to a file.
let summarySentence = null;
if (cmd === "record" || cmd === "summary") {
  const text = typeof opts.summary === "string" ? opts.summary.trim() : "";
  if (!text) fail(`--summary "<one sentence>" is required for board.mjs ${cmd}: one sentence, in plain words, of what changed for the user${cmd === "record" ? `\n${opts.hand ? RECORD_HAND_USAGE : RECORD_REPORT_USAGE}` : ""}`, 2);
  if (/[\r\n]/.test(text) || /[.!?]\s+\S/.test(text)) fail(`--summary must be one sentence for board.mjs ${cmd}: no newline, and no sentence end followed by more text`, 2);
  summarySentence = text;
}

// --rehearsal-outcome (card rehearsal-failure-not-landed): required with --rehearsal, refused without it; checked before any write.
if (cmd === "record") {
  const ro = opts["rehearsal-outcome"];
  if (opts.rehearsal !== undefined && ro !== "passed" && ro !== "failed") fail(`--rehearsal needs --rehearsal-outcome passed|failed, got ${ro === undefined ? "none" : JSON.stringify(ro)}\n${opts.hand ? RECORD_HAND_USAGE : RECORD_REPORT_USAGE}`, 2);
  if (opts.rehearsal === undefined && ro !== undefined) fail(`--rehearsal-outcome is only valid with --rehearsal\n${opts.hand ? RECORD_HAND_USAGE : RECORD_REPORT_USAGE}`, 2);
}

// The landing block (card landing-block-enforced): three lines (Changed / Outcome / Learned), at most 100 words,
// printed last by record and summary, kept under .doug/.state/reports/<id>/ for the Stop gate to check against the
// lead's final message. Built and checked before anything is written, so a refusal leaves no trace.
const LANDING_BLOCK_WORDS = 100;
function landingBlock({ id, ok, commit, wall, gate, cost, codexCost, note, rehearsal = null, rehearsalOutcome = null }) {
  const money = (v) => `$${Number(v).toFixed(2)}`;
  const costText = cost !== undefined && cost !== null ? `${money(cost)}${codexCost !== undefined && codexCost !== null ? ` + Codex ${money(codexCost)}` : ""}` : codexCost !== undefined && codexCost !== null ? `Codex ${money(codexCost)}` : "";
  const verdict = rehearsal ? `rehearsal ${rehearsal} ${rehearsalOutcome}` : `${ok ? "landed" : "stopped"} ${id}${commit ? ` at ${commit}` : ""}`;
  const outcome = [verdict, wall, gate, costText].filter(Boolean).join(", ");
  const learned = typeof note === "string" && note.trim() ? note.trim().replace(/\s+/g, " ") : "nothing new";
  const lines = [`Changed: ${summarySentence}`, `Outcome: ${outcome}`, `Learned: ${learned}`];
  const words = lines.join("\n").split(/\s+/).filter(Boolean).length;
  if (words > LANDING_BLOCK_WORDS) fail(`landing block is ${words} words; the limit is ${LANDING_BLOCK_WORDS}. Shorten --summary or --note.`);
  return lines;
}
// The pending marker holds the session that landed, so only that session's Stop checks it (empty when unset).
function arm(d) {
  writeFileSync(join(d, "landing-block.pending"), process.env.CLAUDE_CODE_SESSION_ID || "");
}
function writeLandingBlock(dir, id, lines, keepFile = false, printOnly = false) {
  // The block files only arm the Stop gate's check; a state dir that cannot be written must not fail a landing that
  // is already recorded, so the block still prints and the gate simply has nothing to check.
  if (!printOnly) try {
    const d = join(dir, ".doug/.state/reports", id);
    mkdirSync(d, { recursive: true });
    if (!keepFile) writeFileSync(join(d, "landing-block.txt"), lines.join("\n") + "\n");
    arm(d);
  } catch (e) {
    process.stderr.write(`warning: landing block not saved for the Stop gate: ${e.message}\n`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}
function acceptanceGate(report) {
  const levels = (report.levels || []).filter((l) => l && l.integration);
  const acc = levels.length && Array.isArray(levels[levels.length - 1].integration.acceptance) ? levels[levels.length - 1].integration.acceptance : [];
  return `acceptance ${acc.filter((a) => a && a.ok).length}/${acc.length}`;
}

try {
  switch (cmd) {
    case "next": {
      const dir = dirFrom(rest, 0);
      const track = opts.track === "hand" ? "hand" : opts.track === "any" ? "any" : "flow";
      if (opts.track !== undefined && opts.track !== "flow" && opts.track !== "hand" && opts.track !== "any") fail(`unknown track "${opts.track}"; tracks are flow, hand, any`, 2);
      const batch = opts.batch !== undefined ? Number(opts.batch) : null;
      if (batch !== null && !(Number.isInteger(batch) && batch > 0)) fail(`--batch must be a positive integer, got ${JSON.stringify(opts.batch)}`, 2);
      if (opts.tag !== undefined && opts.tag.includes(",")) fail(`--tag takes one tag here; got "${opts.tag}"`, 2);
      const board = loadBoard(dir);
      const { card, cards, skipped } = batch === null ? nextReadyCard(board, { track, tag: opts.tag, epic: opts.epic, milestone: opts.milestone }) : nextReadyCards(board, { track, batch, tag: opts.tag, epic: opts.epic, milestone: opts.milestone });
      for (const s of skipped) process.stderr.write(s.hand ? `skipping ${s.id}: hand track (a by-hand card; /doug-next ${s.id} takes it)\n` : s.flow ? `skipping ${s.id}: flow track (run it with /doug-next)\n` : `skipping ${s.id}: waiting on ${s.waitingOn.join(", ")}\n`);
      const capLine = readyCapWarning(board);
      if (capLine) process.stderr.write(capLine);
      if (batch === null ? !card : !cards.length) fail(track === "hand" ? "No Ready hand-track card whose dependencies are Done." : "No Ready card whose dependencies are Done.");
      if (batch !== null) process.stderr.write(`wall cap: ${wallCapMinutes(cards)} min (size x class table at p80, board.mjs budgets; no size counts as M)\n`);
      if (batch !== null) process.stderr.write(`usd cap: $${usdCapDollars(cards).toFixed(2)} (size x class table at p80 of measured cost, board.mjs budgets --usd; no size counts as M)\n`);
      process.stdout.write(JSON.stringify(batch === null ? card : cards, null, 2) + "\n");
      break;
    }
    case "budgets": {
      const usd = opts.usd === true;
      if (opts.from === undefined) {
        process.stdout.write(`table: ${JSON.stringify(usd ? USD_BUDGET : WALL_BUDGET_MIN)}\n`);
        break;
      }
      const dir = dirFrom(rest, 0);
      let text;
      try {
        text = readFileSync(resolve(opts.from), "utf8");
      } catch (e) {
        fail(`cannot read --from file ${opts.from}: ${e.message}`, 2);
      }
      const { table, cells } = usd ? usdBudgetTable(parseLiveRunCosts(text), loadBoard(dir)) : wallBudgetTable(parseLiveRunWalls(text), loadBoard(dir));
      const shown = (v) => (usd ? `$${v.toFixed(2)}` : String(v));
      const shipped = usd ? USD_BUDGET : WALL_BUDGET_MIN;
      const minN = usd ? USD_BUDGET_MIN_N : WALL_BUDGET_MIN_N;
      const out = [];
      for (const size of ["S", "M", "L"]) {
        for (const c of cells.filter((x) => x.size === size)) {
          if (c.cls === "all") out.push(c.n === 0 ? `${size}/all n=0 (no landings; keeps the shipped ${shown(shipped[size].all)})` : `${size}/all n=${c.n} p80 ${shown(c.p80)}`);
          else out.push(`${size}/${c.cls} n=${c.n} p80 ${shown(c.p80)}${c.n < minN ? ` (fewer than ${minN}; falls back to ${size}/all ${shown(table[size].all)})` : ""}`);
        }
      }
      out.push(`table: ${JSON.stringify(table)}`);
      process.stdout.write(out.join("\n") + "\n");
      break;
    }
    case "rollup": {
      if (opts.epic !== undefined && opts.milestone !== undefined) fail(USAGE_FOR.rollup, 2);
      const dir = dirFrom(rest, 0);
      const board = loadBoard(dir);
      try {
        checkFilters(board, { epic: opts.epic, milestone: opts.milestone });
      } catch (e) {
        fail(e.message, 2);
      }
      let text = null;
      if (opts.from !== undefined) {
        try {
          text = readFileSync(resolve(opts.from), "utf8");
        } catch (e) {
          fail(`cannot read --from file ${opts.from}: ${e.message}`, 2);
        }
      } else if (existsSync(join(dir, LIVE_RUNS_RELPATH))) {
        text = readFileSync(join(dir, LIVE_RUNS_RELPATH), "utf8");
      }
      const r = rollup(board, text);
      const out = opts.epic !== undefined ? r.epics.find((e) => e.id === opts.epic) : opts.milestone !== undefined ? r.milestones.find((m) => m.id === opts.milestone) : r;
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      break;
    }
    case "labels": {
      if (rest[0] === "init" && opts.check !== true) {
        const dir = dirFrom(rest, 1);
        saveBoard(dir, initLabelGroups(loadBoard(dir)));
        process.stdout.write(`Added label groups type and priority to ${relative(dir, boardPath(dir))}.\n`);
        break;
      }
      if (opts.check !== true) fail(USAGE_FOR.labels, 2);
      const lines = labelContrastFailures(loadBoard(dirFrom(rest, 0)));
      if (lines.length) process.stdout.write(lines.join("\n") + "\n");
      break;
    }
    case "card": {
      const dir = dirFrom(rest, 1);
      process.stdout.write(JSON.stringify(findCard(loadBoard(dir), rest[0]), null, 2) + "\n");
      break;
    }
    case "move": {
      const [id, column] = rest;
      if (!id || !column) fail("usage: board.mjs move <id> <column> [dir] [--source <text>]", 2);
      const dir = dirFrom(rest, 2);
      const moved = moveCard(loadBoard(dir), id, column, { source: opts.source });
      saveBoard(dir, moved);
      process.stdout.write(`Moved ${id} to ${column} in ${relative(dir, boardPath(dir))}.\n`);
      // A card moved to done re-arms the Stop gate's landing-block check, only when record left a block (never creates one).
      if (column === "done" && /^[a-z0-9._-]+$/.test(id)) {
        const d = join(dir, ".doug/.state/reports", id);
        if (existsSync(join(d, "landing-block.txt"))) arm(d);
      }
      const capLine = column === "ready" ? readyCapWarning(moved) : null;
      if (capLine) process.stderr.write(capLine);
      break;
    }
    case "edit": {
      const [id] = rest;
      if (!id) fail(EDIT_USAGE, 2);
      if (opts.goal !== undefined && opts["goal-file"] !== undefined) fail(EDIT_USAGE, 2);
      const fields = {};
      if (opts.title !== undefined) fields.title = opts.title;
      if (opts.goal !== undefined) fields.goal = opts.goal;
      if (opts["goal-file"] !== undefined) fields.goal = readFileSync(resolve(opts["goal-file"]), "utf8").trimEnd();
      if (opts.size !== undefined) fields.size = opts.size;
      if (opts.component !== undefined) fields.component = opts.component;
      if (opts.track !== undefined) fields.track = opts.track;
      if (opts.class !== undefined) fields.class = opts.class;
      if (opts.deps !== undefined) fields.deps = opts.deps.split(",").map((d) => d.trim()).filter(Boolean);
      if (opts.tag !== undefined) fields.tags = opts.tag.split(",").map((t) => t.trim()).filter(Boolean);
      if (opts.source !== undefined) fields.source = opts.source;
      if (opts.epic !== undefined) fields.epic = opts.epic === "" ? null : opts.epic;
      if (opts.milestone !== undefined) fields.milestone = opts.milestone === "" ? null : opts.milestone;
      const changed = EDIT_FIELD_ORDER.filter((k) => Object.prototype.hasOwnProperty.call(fields, k));
      if (!changed.length) fail(EDIT_USAGE, 2);
      const dir = dirFrom(rest, 1);
      const plan = loadPlan(dir);
      const { board, warnings } = editCard(loadBoard(dir), id, fields, { force: !!opts.force, plan });
      saveBoard(dir, board);
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      process.stdout.write(`Edited ${id} (${changed.join(", ")}) in ${relative(dir, boardPath(dir))}.\n`);
      break;
    }
    case "epic":
    case "milestone": {
      const [action, id] = rest;
      const add = cmd === "epic" ? addEpic : addMilestone;
      const edit = cmd === "epic" ? editEpic : editMilestone;
      const targetOf = () => {
        const t = {};
        if (opts.version !== undefined) t.version = opts.version === "" ? null : opts.version;
        if (opts.date !== undefined) t.date = opts.date === "" ? null : opts.date;
        return t;
      };
      if (action === "list") {
        const board = loadBoard(dirFrom(rest, 1));
        process.stdout.write(JSON.stringify(board[`${cmd}s`] || [], null, 2) + "\n");
        break;
      }
      if (!id) fail(planUsage(cmd), 2);
      if (action === "add") {
        if (!opts.title || !opts.goal) fail(planUsage(cmd), 2);
        const dir = dirFrom(rest, 2);
        const target = {};
        if (opts.version) target.version = opts.version;
        if (opts.date) target.date = opts.date;
        saveBoard(dir, add(loadBoard(dir), { id, title: opts.title, goal: opts.goal, ...(Object.keys(target).length ? { target } : {}) }));
        process.stdout.write(`Added ${cmd} ${id} in ${relative(dir, boardPath(dir))}.\n`);
        break;
      }
      const fields = {};
      if (opts.title !== undefined) fields.title = opts.title;
      if (opts.goal !== undefined) fields.goal = opts.goal;
      if (opts.status !== undefined) fields.status = opts.status;
      const target = targetOf();
      if (Object.keys(target).length) fields.target = target;
      if (!Object.keys(fields).length) fail(planUsage(cmd), 2);
      const dir = dirFrom(rest, 2);
      const { board, warnings } = edit(loadBoard(dir), id, fields, { force: !!opts.force });
      saveBoard(dir, board);
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      process.stdout.write(`Edited ${cmd} ${id} (${Object.keys(fields).join(", ")}) in ${relative(dir, boardPath(dir))}.\n`);
      break;
    }
    case "remove": {
      const [id] = rest;
      if (!id) fail("usage: board.mjs remove <id> [dir] [--force]", 2);
      const dir = dirFrom(rest, 1);
      const plan = loadPlan(dir);
      const { board, removed, warnings } = removeCard(loadBoard(dir), id, { force: !!opts.force, plan });
      saveBoard(dir, board);
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      process.stdout.write(`Removed ${id} (${removed.column}) from ${relative(dir, boardPath(dir))}.\n`);
      process.stdout.write(JSON.stringify(removed, null, 2) + "\n");
      break;
    }
    case "reorder": {
      const [id] = rest;
      const optionCount = ["before", "after", "top", "bottom"].filter((k) => opts[k] !== undefined).length;
      const validValue = (v) => typeof v === "string" && v !== "" && !v.startsWith("--");
      const badValue = (opts.before !== undefined && !validValue(opts.before)) || (opts.after !== undefined && !validValue(opts.after));
      if (!id || optionCount !== 1 || badValue) fail("usage: board.mjs reorder <id> [dir] --before <other> | --after <other> | --top | --bottom", 2);
      const dir = dirFrom(rest, 1);
      const board = loadBoard(dir);
      const card = findCard(board, id);
      const record = relative(dir, boardPath(dir));
      let placement, message;
      if (opts.before !== undefined) {
        placement = { before: opts.before };
        message = `Reordered ${id} before ${opts.before} in ${record}.\n`;
      } else if (opts.after !== undefined) {
        placement = { after: opts.after };
        message = `Reordered ${id} after ${opts.after} in ${record}.\n`;
      } else if (opts.top) {
        placement = { index: 0 };
        message = `Reordered ${id} to the top of ${card.column} in ${record}.\n`;
      } else {
        placement = { index: board.cards.filter((c) => c.column === card.column).length };
        message = `Reordered ${id} to the bottom of ${card.column} in ${record}.\n`;
      }
      saveBoard(dir, reorderCard(board, id, placement));
      process.stdout.write(message);
      break;
    }
    case "record": {
      if (opts.hand) {
        const [id] = rest;
        if (!id) fail("usage: board.mjs record <id> --hand [dir] --summary \"<one sentence>\" [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>] [--cost <usd>]", 2);
        if (opts.cost !== undefined && !/^\d+(\.\d+)?$/.test(opts.cost)) fail(`--cost takes a non-negative number of dollars, got ${JSON.stringify(opts.cost)}`, 2);
        const dir = dirFrom(rest, 1);
        const card = findCard(loadBoard(dir), id);
        const entry = handEntry({ card, commit: opts.commit ?? null, wallClock: opts.wall ?? null, gate: opts.gate ?? null, note: opts.note ?? null, record: relative(dir, boardPath(dir)), rehearsal: opts.rehearsal ?? null, rehearsalOutcome: opts["rehearsal-outcome"] ?? null, cost: opts.cost !== undefined ? Number(opts.cost) : null });
        const block = landingBlock({ id, ok: true, commit: opts.commit, wall: opts.wall, gate: opts.gate, cost: opts.cost, note: opts.note, rehearsal: opts.rehearsal ?? null, rehearsalOutcome: opts["rehearsal-outcome"] ?? null });
        const { file, promoted } = recordLanding(dir, id, entry);
        process.stdout.write(`${summarySentence}\n`);
        if (!opts.rehearsal) {
          const verdict = handWallVerdict(card, opts.wall ?? null);
          if (verdict.over) process.stdout.write(`Wall budget: ${verdict.text}\n`);
        }
        if (promoted) process.stdout.write(`Promoted the research note for ${id} to ${promoted}.\n`);
        process.stdout.write(`Appended a hand-track entry for ${id} to ${file}.\n`);
        writeLandingBlock(dir, id, block, false, !!opts.rehearsal);
        break;
      }
      const [id, reportFile] = rest;
      if (!id || !reportFile) fail("usage: board.mjs record <id> <report.json> [dir] --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary \"<id>=<class>[: <reason>]\"]... [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>] [--run <run-id>] [--claude-dir <dir>]", 2);
      const dir = dirFrom(rest, 2);
      const card = findCard(loadBoard(dir), id);
      const report = unwrapReport(JSON.parse(readFileSync(resolve(reportFile), "utf8")));
      // A batch plan (its `cards` list this card) makes the entry that card's part of the run.
      const plan = planFor(dir, id);
      const batch = plan && Array.isArray(plan.cards) && plan.cards.includes(id) ? plan.cards : null;
      const taskIds = batch ? plan.tasks.filter((t) => t.card === id).map((t) => t.id) : [];
      const wall = opts.run ? wallForRun({ runId: opts.run, claudeDir: opts["claude-dir"], projectDir: dir, wallMinutes: report.budget?.wallMinutes ?? DEFAULT_BUDGET.wallMinutes }) : null;
      const entry = runEntry({ card, report, wall, cost: opts.cost !== undefined ? Number(opts.cost) : null, codexCost: opts["codex-cost"] !== undefined ? Number(opts["codex-cost"]) : null, wallClock: opts.wall ?? null, mergeCommit: opts.commit ?? null, record: relative(dir, boardPath(dir)), adversary: parseAdversaryClasses(opts.adversary || []), batch, taskIds, sharedCost: opts["shared-cost"] !== undefined ? Number(opts["shared-cost"]) : null, note: opts.note ?? null, rehearsal: opts.rehearsal ?? null, rehearsalOutcome: opts["rehearsal-outcome"] ?? null });
      const block = landingBlock({ id, ok: report.ok === true, commit: opts.commit, wall: opts.wall, gate: acceptanceGate(report), cost: opts.cost, codexCost: opts["codex-cost"], note: opts.note, rehearsal: opts.rehearsal ?? null, rehearsalOutcome: opts["rehearsal-outcome"] ?? null });
      const { file, promoted } = recordLanding(dir, id, entry);
      process.stdout.write(`${summarySentence}\n`);
      if (promoted) process.stdout.write(`Promoted the research note for ${id} to ${promoted}.\n`);
      process.stdout.write(`Appended a run entry for ${id} to ${file}.\n`);
      writeLandingBlock(dir, id, block, false, !!opts.rehearsal);
      break;
    }
    case "summary": {
      const [reportFile] = rest;
      if (!reportFile) fail("usage: board.mjs summary <report.json> --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>] [--run <run-id>] [--claude-dir <dir>] [--note <text>]", 2);
      let report = unwrapReport(JSON.parse(readFileSync(resolve(reportFile), "utf8")));
      const wholeReport = report; // the block's gate reads the final level's acceptance, which the --card filter drops
      if (opts.card !== undefined) {
        // With the plan at hand the filter also covers a report whose tasks carry no card.
        const plan = planFor(dirFrom(rest, 1), opts.card);
        report = filterReportForCard(report, opts.card, plan && Array.isArray(plan.tasks) ? plan.tasks.filter((t) => t.card === opts.card).map((t) => t.id) : []);
      }
      const wall = opts.run ? wallForRun({ runId: opts.run, claudeDir: opts["claude-dir"], projectDir: process.cwd(), wallMinutes: report.budget?.wallMinutes ?? DEFAULT_BUDGET.wallMinutes }) : null;
      const sumPlan = opts.card !== undefined ? planFor(dirFrom(rest, 1), opts.card) : null;
      const sumBatch = sumPlan && Array.isArray(sumPlan.cards) && sumPlan.cards.includes(opts.card) ? sumPlan.cards : null;
      // A block record already saved for this card is reprinted verbatim and re-armed, never recomputed or rewritten.
      let sumSaved = null;
      if (opts.card !== undefined && /^[a-z0-9._-]+$/.test(opts.card)) {
        try {
          const saved = readFileSync(join(dirFrom(rest, 1), ".doug/.state/reports", opts.card, "landing-block.txt"), "utf8").split("\n").filter(Boolean);
          if (saved.length === 3) sumSaved = saved;
        } catch {}
      }
      const sumBlock = sumSaved ? sumSaved : opts.card !== undefined ? landingBlock({ id: opts.card, ok: report.ok === true, commit: opts.commit, wall: opts.wall, gate: acceptanceGate(wholeReport), cost: opts.cost, codexCost: opts["codex-cost"], note: opts.note }) : null;
      process.stdout.write(`${summarySentence}\n`);
      process.stdout.write(runSummary({ report, wall, batch: sumBatch, card: opts.card ?? null, cost: opts.cost !== undefined ? Number(opts.cost) : null, codexCost: opts["codex-cost"] !== undefined ? Number(opts["codex-cost"]) : null, wallClock: opts.wall ?? null, mergeCommit: opts.commit ?? null }));
      if (sumBlock) writeLandingBlock(dirFrom(rest, 1), opts.card, sumBlock, sumSaved !== null);
      break;
    }
    default:
      fail("usage: board.mjs <next|card|reorder|move|edit|epic|milestone|rollup|labels|remove|record|summary> ...", 2);
  }
} catch (err) {
  fail(err.message);
}
