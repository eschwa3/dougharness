#!/usr/bin/env node
// CLI for the development board, used by the /doug-next and doug-hand skills. Deterministic; no agents.
//   board.mjs next [dir] [--track flow|hand|any] [--tag <tag>]
//                                                 the first Ready card on that track (default flow) whose deps are
//                                                 Done, as JSON (exit 1 if none); --tag filters to cards carrying it
//   board.mjs next --batch <n> [dir] [--track flow|hand|any] [--tag <tag>]
//                                                 the first n runnable Ready cards, in board order, as a JSON array
//                                                 (exit 1 if none): the cards /doug-next plans together; stderr also
//                                                 carries a `wall cap: <m> min` line (the cards' budgets from the size x class table)
//   board.mjs budgets [dir] [--from <live-runs file>]
//                                                 without --from, the shipped wall budget table as `table: <JSON>`;
//                                                 with --from, recomputes it (p80 per size/class cell) from the file's
//                                                 Wall clock rows joined to the board, one line per cell and a final
//                                                 `table:` line; writes nothing (replace WALL_BUDGET_MIN by hand)
//   board.mjs card <id> [dir]                     one card as JSON
//   board.mjs reorder <id> [dir] --before <other> | --after <other> | --top | --bottom
//                                                 reorder a card within its column
//   board.mjs move <id> <column> [dir] [--source <text>]
//                                                 move a card
//   board.mjs edit <id> [dir] [--title <t>] [--goal <g> | --goal-file <path>] [--size S|M|L] [--component <c>]
//                     [--track flow|hand] [--class <c>] [--deps a,b] [--tag a,b] [--source <s>] [--force]
//                                                 changes a card's fields through the record's own validation
//                                                 (never the id or the column; move stays the way to change that);
//                                                 --tag "" clears a card's tags
//   board.mjs remove <id> [dir] [--force]         removes a card from the record: refused always when another card
//                                                 lists it in deps; refused without --force when it is done, in
//                                                 flow, or named by .doug/plan.json (each with --force removes it
//                                                 and prints a warning to stderr); prints the removed card as JSON
//                                                 to stdout so a mistaken removal can be re-added by hand
//   board.mjs record <id> <report.json> [dir] --summary "<one sentence>" [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]... [--note <text>] [--rehearsal <scenario>] [--run <run-id>] [--claude-dir <dir>]
//                                                 append a run entry for the card to docs/live-runs.md; every adversary block
//                                                 in the report is classified real, marginal, or false (repeat the flag per block).
//                                                 When .doug/plan.json lists the card among its `cards` (a batch), the entry
//                                                 shows only that card's tasks, --cost is that card's tasks' cost, and
//                                                 --shared-cost <usd> the shared integration agents', counted once
//   board.mjs record <id> --hand [dir] --summary "<one sentence>" [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>] [--rehearsal <scenario>]
//                                                 append a hand-track entry (no report) for the card
//   --rehearsal <scenario> (either form) marks the entry as a rehearse.mjs run on the ts-basic fixture: the first
//   prose line and the commit sha (abbreviated to 7 characters) read as the fixture's, not this repository's.
//   Either record form also promotes .doug/.state/research/<id>.md to docs/research/<id>.md when that note
//   exists and differs from the docs copy, copying it and printing one line saying so; a card with no note, or
//   whose docs copy is already byte-identical, is untouched, silently.
//   board.mjs summary <report.json> --summary "<one sentence>" [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>] [--run <run-id>] [--claude-dir <dir>]
//                                                 the three-line chat summary of a report (--card: that card's tasks only)

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadBoard, saveBoard, findCard, nextReadyCard, nextReadyCards, moveCard, editCard, removeCard, reorderCard, readyCapWarning, wallCapMinutes, WALL_BUDGET_MIN, WALL_BUDGET_MIN_N, parseLiveRunWalls, wallBudgetTable, runEntry, handEntry, handWallVerdict, runSummary, boardPath, parseAdversaryClasses, filterReportForCard, recordLanding } from "../lib/board.mjs";
import { loadPlan, unwrapReport, DEFAULT_BUDGET } from "../lib/plan.mjs";
import { wallForRun } from "../lib/cost.mjs";

const EDIT_FIELD_ORDER = ["title", "goal", "size", "component", "track", "class", "tags", "deps", "source"];
const EDIT_USAGE = "usage: board.mjs edit <id> [dir] [--title <t>] [--goal <g> | --goal-file <path>] [--size S|M|L] [--component <c>] [--track flow|hand] [--class <c>] [--tag a,b] [--deps a,b] [--source <s>] [--force]";

const argv = process.argv.slice(2);
const FLAGS = new Set(["hand", "top", "bottom", "force"]);
const REPEATABLE = new Set(["adversary"]);

// Each subcommand's allowed flags, derived from what that case actually reads (card board-cli-unknown-flags).
// `record` has two forms (--hand or not) with different allowed sets, handled separately below.
const SUBCOMMAND_FLAGS = {
  next: ["track", "batch", "tag"],
  card: [],
  move: ["source"],
  edit: ["title", "goal", "goal-file", "size", "component", "track", "class", "deps", "tag", "source", "force"],
  remove: ["force"],
  reorder: ["before", "after", "top", "bottom"],
  budgets: ["from"],
  summary: ["summary", "cost", "codex-cost", "wall", "commit", "card", "run", "claude-dir"],
};
const RECORD_HAND_FLAGS = ["summary", "hand", "commit", "wall", "gate", "note", "rehearsal"];
const RECORD_REPORT_FLAGS = ["summary", "cost", "codex-cost", "wall", "commit", "adversary", "shared-cost", "note", "rehearsal", "run", "claude-dir"];
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
  next: "usage: board.mjs next [dir] [--track flow|hand|any] [--batch <n>] [--tag <tag>]",
  card: "usage: board.mjs card <id> [dir]",
  move: "usage: board.mjs move <id> <column> [dir] [--source <text>]",
  edit: EDIT_USAGE,
  remove: "usage: board.mjs remove <id> [dir] [--force]",
  reorder: "usage: board.mjs reorder <id> [dir] --before <other> | --after <other> | --top | --bottom",
  budgets: "usage: board.mjs budgets [dir] [--from <live-runs file>]",
  summary: "usage: board.mjs summary <report.json> --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>] [--run <run-id>] [--claude-dir <dir>]",
};
const RECORD_HAND_USAGE = "usage: board.mjs record <id> --hand [dir] --summary \"<one sentence>\" [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>] [--rehearsal <scenario>]";
const RECORD_REPORT_USAGE = "usage: board.mjs record <id> <report.json> [dir] --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary \"<id>=<class>[: <reason>]\"]... [--note <text>] [--rehearsal <scenario>] [--run <run-id>] [--claude-dir <dir>]";

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
  if (!text) fail(`--summary "<one sentence>" is required for board.mjs ${cmd}: one sentence, in plain words, of what changed for the user`, 2);
  if (/[\r\n]/.test(text) || /[.!?]\s+\S/.test(text)) fail(`--summary must be one sentence for board.mjs ${cmd}: no newline, and no sentence end followed by more text`, 2);
  summarySentence = text;
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
      const { card, cards, skipped } = batch === null ? nextReadyCard(board, { track, tag: opts.tag }) : nextReadyCards(board, { track, batch, tag: opts.tag });
      for (const s of skipped) process.stderr.write(s.hand ? `skipping ${s.id}: hand track (a by-hand card; /doug-next ${s.id} takes it)\n` : s.flow ? `skipping ${s.id}: flow track (run it with /doug-next)\n` : `skipping ${s.id}: waiting on ${s.waitingOn.join(", ")}\n`);
      const capLine = readyCapWarning(board);
      if (capLine) process.stderr.write(capLine);
      if (batch === null ? !card : !cards.length) fail(track === "hand" ? "No Ready hand-track card whose dependencies are Done." : "No Ready card whose dependencies are Done.");
      if (batch !== null) process.stderr.write(`wall cap: ${wallCapMinutes(cards)} min (size x class table at p80, board.mjs budgets; no size counts as M)\n`);
      process.stdout.write(JSON.stringify(batch === null ? card : cards, null, 2) + "\n");
      break;
    }
    case "budgets": {
      if (opts.from === undefined) {
        process.stdout.write(`table: ${JSON.stringify(WALL_BUDGET_MIN)}\n`);
        break;
      }
      const dir = dirFrom(rest, 0);
      let text;
      try {
        text = readFileSync(resolve(opts.from), "utf8");
      } catch (e) {
        fail(`cannot read --from file ${opts.from}: ${e.message}`, 2);
      }
      const { table, cells } = wallBudgetTable(parseLiveRunWalls(text), loadBoard(dir));
      const out = [];
      for (const size of ["S", "M", "L"]) {
        for (const c of cells.filter((x) => x.size === size)) {
          if (c.cls === "all") out.push(c.n === 0 ? `${size}/all n=0 (no landings; keeps the shipped ${WALL_BUDGET_MIN[size].all})` : `${size}/all n=${c.n} p80 ${c.p80}`);
          else out.push(`${size}/${c.cls} n=${c.n} p80 ${c.p80}${c.n < WALL_BUDGET_MIN_N ? ` (fewer than ${WALL_BUDGET_MIN_N}; falls back to ${size}/all ${table[size].all})` : ""}`);
        }
      }
      out.push(`table: ${JSON.stringify(table)}`);
      process.stdout.write(out.join("\n") + "\n");
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
        if (!id) fail("usage: board.mjs record <id> --hand [dir] --summary \"<one sentence>\" [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>] [--rehearsal <scenario>]", 2);
        const dir = dirFrom(rest, 1);
        const card = findCard(loadBoard(dir), id);
        const entry = handEntry({ card, commit: opts.commit ?? null, wallClock: opts.wall ?? null, gate: opts.gate ?? null, note: opts.note ?? null, record: relative(dir, boardPath(dir)), rehearsal: opts.rehearsal ?? null });
        const { file, promoted } = recordLanding(dir, id, entry);
        process.stdout.write(`${summarySentence}\n`);
        if (!opts.rehearsal) {
          const verdict = handWallVerdict(card, opts.wall ?? null);
          if (verdict.over) process.stdout.write(`Wall budget: ${verdict.text}\n`);
        }
        if (promoted) process.stdout.write(`Promoted the research note for ${id} to ${promoted}.\n`);
        process.stdout.write(`Appended a hand-track entry for ${id} to ${file}.\n`);
        break;
      }
      const [id, reportFile] = rest;
      if (!id || !reportFile) fail("usage: board.mjs record <id> <report.json> [dir] --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary \"<id>=<class>[: <reason>]\"]... [--note <text>] [--rehearsal <scenario>] [--run <run-id>] [--claude-dir <dir>]", 2);
      const dir = dirFrom(rest, 2);
      const card = findCard(loadBoard(dir), id);
      const report = unwrapReport(JSON.parse(readFileSync(resolve(reportFile), "utf8")));
      // A batch plan (its `cards` list this card) makes the entry that card's part of the run.
      const plan = loadPlan(dir);
      const batch = plan && Array.isArray(plan.cards) && plan.cards.includes(id) ? plan.cards : null;
      const taskIds = batch ? plan.tasks.filter((t) => t.card === id).map((t) => t.id) : [];
      const wall = opts.run ? wallForRun({ runId: opts.run, claudeDir: opts["claude-dir"], projectDir: dir, wallMinutes: report.budget?.wallMinutes ?? DEFAULT_BUDGET.wallMinutes }) : null;
      const entry = runEntry({ card, report, wall, cost: opts.cost !== undefined ? Number(opts.cost) : null, codexCost: opts["codex-cost"] !== undefined ? Number(opts["codex-cost"]) : null, wallClock: opts.wall ?? null, mergeCommit: opts.commit ?? null, record: relative(dir, boardPath(dir)), adversary: parseAdversaryClasses(opts.adversary || []), batch, taskIds, sharedCost: opts["shared-cost"] !== undefined ? Number(opts["shared-cost"]) : null, note: opts.note ?? null, rehearsal: opts.rehearsal ?? null });
      const { file, promoted } = recordLanding(dir, id, entry);
      process.stdout.write(`${summarySentence}\n`);
      if (promoted) process.stdout.write(`Promoted the research note for ${id} to ${promoted}.\n`);
      process.stdout.write(`Appended a run entry for ${id} to ${file}.\n`);
      break;
    }
    case "summary": {
      const [reportFile] = rest;
      if (!reportFile) fail("usage: board.mjs summary <report.json> --summary \"<one sentence>\" [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>] [--run <run-id>] [--claude-dir <dir>]", 2);
      let report = unwrapReport(JSON.parse(readFileSync(resolve(reportFile), "utf8")));
      if (opts.card !== undefined) {
        // With the plan at hand the filter also covers a report whose tasks carry no card.
        const plan = loadPlan(dirFrom(rest, 1));
        report = filterReportForCard(report, opts.card, plan && Array.isArray(plan.tasks) ? plan.tasks.filter((t) => t.card === opts.card).map((t) => t.id) : []);
      }
      const wall = opts.run ? wallForRun({ runId: opts.run, claudeDir: opts["claude-dir"], projectDir: process.cwd(), wallMinutes: report.budget?.wallMinutes ?? DEFAULT_BUDGET.wallMinutes }) : null;
      const sumPlan = opts.card !== undefined ? loadPlan(dirFrom(rest, 1)) : null;
      const sumBatch = sumPlan && Array.isArray(sumPlan.cards) && sumPlan.cards.includes(opts.card) ? sumPlan.cards : null;
      process.stdout.write(`${summarySentence}\n`);
      process.stdout.write(runSummary({ report, wall, batch: sumBatch, card: opts.card ?? null, cost: opts.cost !== undefined ? Number(opts.cost) : null, codexCost: opts["codex-cost"] !== undefined ? Number(opts["codex-cost"]) : null, wallClock: opts.wall ?? null, mergeCommit: opts.commit ?? null }));
      break;
    }
    default:
      fail("usage: board.mjs <next|card|reorder|move|edit|remove|record|summary> ...", 2);
  }
} catch (err) {
  fail(err.message);
}
