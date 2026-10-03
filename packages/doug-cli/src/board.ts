// `doug board ...`: the development board (.doug/board.json, docs/board.json as a read fallback) as a
// CLI-owned record. Built on the doug-flow plugin's board library; deterministic, no agents, never exits.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildBoardPage } from "./board-page.js";
import { startBoardServer } from "./board-serve.js";
import {
  findRunningServer,
  openBrowser,
  removePidfileIfOwn,
  spawnDetached,
  stopRunningServer,
  waitForDetached,
  writePidfile,
  type PidfileData,
} from "./board-serve-process.js";
import {
  addCard,
  boardPath,
  boardTags,
  editCard,
  findCard,
  loadBoard,
  moveCard,
  reorderCard,
  newBoard,
  nextReadyCard,
  nextReadyCards,
  filterReportForCard,
  removeCard,
  runEntry, handEntry, runSummary, parseAdversaryClasses,
  recordLanding,
  saveBoard,
  BOARD_RELPATH,
  type Board,
  type BoardCard,
  type EditFields,
} from "@dougharness/flow/lib/board.mjs";
import { loadPlan, unwrapReport } from "@dougharness/flow/lib/plan.mjs";

export interface BoardIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const BOARD_USAGE = `Usage:
  doug board init [dir]
  doug board add <id> --title <t> --goal <g> [--component <c>] [--size S|M|L] [--track flow|hand] [--class <c>] [--deps a,b] [--tag a,b] [--column <col>] [dir]
  doug board list [dir] [--column <id>] [--tag <t>] [--json]
  doug board next [dir] [--track flow|hand] [--batch <n>] [--tag <t>]
  doug board reorder <id> [dir] --before <other> | --after <other> | --top | --bottom
  doug board move <id> <column> [dir] [--source <text>]
  doug board edit <id> [dir] [--title <t>] [--goal <g> | --goal-file <path>] [--size S|M|L] [--component <c>] [--track flow|hand] [--class <c>] [--deps a,b] [--tag a,b] [--source <s>] [--force]
  doug board remove <id> [dir] [--force]
  doug board record <id> <report.json> [dir] [--cost <usd>] [--codex-cost <usd>] [--shared-cost <usd>] [--wall <text>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]...
  doug board record <id> --hand [dir] [--commit <sha>] [--wall <text>] [--gate <text>] [--note <text>]
  doug board summary <report.json> [--cost <usd>] [--codex-cost <usd>] [--wall <text>] [--commit <sha>] [--card <id>]
  doug board build [dir] [--out <file>]
  doug board serve [dir] [--port <n>] [--open] [--detach | --stop]

The record is .doug/board.json (docs/board.json is read, and written back, when only it exists).
Every adversary block in a recorded run is classified real (a defect a user would hit), marginal (true to the
spec, no user impact), or false (wrong); repeat --adversary once per block.
next --batch <n> prints the first n runnable Ready cards as a JSON array, the cards /doug-next plans together; when
.doug/plan.json lists the card among its cards, record shows only that card's tasks, --cost is that card's tasks'
cost and --shared-cost the shared integration agents', counted once; summary --card <id> filters the same way.
--codex-cost is the Codex adversary's own cost, shown once per run (once per batch, under its first card) and never
added to --cost.
`;

const BOOLEAN_FLAGS = new Set(["json", "help", "hand", "top", "bottom", "force", "open", "detach", "stop"]);
const EDIT_FIELD_ORDER = ["title", "goal", "size", "component", "track", "class", "tags", "deps", "source"] as const;
const REPEATABLE_FLAGS = new Set(["adversary"]);
const DEFAULT_PORT = 8787;

// Each subcommand's allowed flags, derived from what that case actually reads (card board-cli-unknown-flags).
// `record` has two forms (--hand or not) with different allowed sets, handled separately below.
const SUBCOMMAND_FLAGS: Record<string, string[]> = {
  init: [],
  add: ["title", "goal", "component", "size", "track", "class", "deps", "tag", "column"],
  list: ["column", "tag", "json"],
  next: ["track", "batch", "tag"],
  reorder: ["before", "after", "top", "bottom"],
  move: ["source"],
  edit: ["title", "goal", "goal-file", "size", "component", "track", "class", "deps", "tag", "source", "force"],
  remove: ["force"],
  summary: ["cost", "codex-cost", "wall", "commit", "card"],
  build: ["out"],
  serve: ["port", "open", "detach", "stop"],
};
const RECORD_HAND_FLAGS = ["hand", "commit", "wall", "gate", "note"];
const RECORD_REPORT_FLAGS = ["cost", "codex-cost", "shared-cost", "commit", "wall", "adversary"];

interface Parsed {
  opts: Record<string, string | true>;
  repeated: Record<string, string[]>;
  positional: string[];
}

function parse(argv: string[]): Parsed {
  const opts: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) opts[name] = true;
      else if (REPEATABLE_FLAGS.has(name)) {
        (repeated[name] ||= []).push(argv[i + 1] ?? "");
        i++;
      } else {
        opts[name] = argv[i + 1] ?? "";
        i++;
      }
    } else positional.push(a);
  }
  return { opts, repeated, positional };
}

function stringOpt(opts: Parsed["opts"], name: string): string | undefined {
  const v = opts[name];
  return typeof v === "string" ? v : undefined;
}

function dirFrom(args: string[], n: number): string {
  return resolve(args[n] || process.cwd());
}

function relpathOf(dir: string, file: string): string {
  return relative(dir, file) || BOARD_RELPATH;
}

function cardLines(cards: BoardCard[]): string[] {
  return cards.map((c) => `  ${c.id}  ${c.size || "-"}  ${c.title}${c.track === "hand" ? "  [hand]" : ""}${c.deps && c.deps.length ? `  deps: ${c.deps.join(", ")}` : ""}`);
}

// The usage line(s) for one subcommand, pulled from BOARD_USAGE.
function subcommandUsage(cmd: string): string {
  const lines = BOARD_USAGE.split("\n").filter((l) => new RegExp(`^\\s*doug board ${cmd}\\b`).test(l));
  return (lines.length ? lines : [BOARD_USAGE.trimEnd()]).join("\n") + "\n";
}

// An unknown --flag for the given subcommand: exit 2, name the flag and the subcommand's usage.
// Runs on flag names only (parse order doesn't matter), before any work or write.
function unknownFlagFor(cmd: string, opts: Parsed["opts"], repeated: Parsed["repeated"]): string | undefined {
  const allowed = new Set(cmd === "record" ? (opts.hand === true ? RECORD_HAND_FLAGS : RECORD_REPORT_FLAGS) : SUBCOMMAND_FLAGS[cmd]);
  for (const name of [...Object.keys(opts), ...Object.keys(repeated)]) {
    if (!allowed.has(name)) return name;
  }
  return undefined;
}

function listText(board: Board, columnId: string | undefined): string {
  const columns = columnId === undefined ? board.columns : board.columns.filter((c) => c.id === columnId);
  const out: string[] = [];
  for (const col of columns) {
    const cards = board.cards.filter((c) => c.column === col.id);
    out.push(`${col.title} (${cards.length})`);
    out.push(...cardLines(cards));
  }
  return out.join("\n") + "\n";
}

export async function runBoard(argv: string[], io?: BoardIo): Promise<number> {
  const out: BoardIo = io || {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
  const { opts, repeated, positional } = parse(argv);
  const [cmd, ...rest] = positional;

  if (opts.help === true) {
    out.stdout(BOARD_USAGE);
    return 0;
  }
  const usage = (): number => {
    out.stderr(BOARD_USAGE);
    return 2;
  };

  if (cmd === "record" || (cmd !== undefined && Object.prototype.hasOwnProperty.call(SUBCOMMAND_FLAGS, cmd))) {
    const unknown = unknownFlagFor(cmd, opts, repeated);
    if (unknown !== undefined) {
      out.stderr(`unknown option --${unknown} for doug board ${cmd}\n`);
      out.stderr(subcommandUsage(cmd));
      return 2;
    }
  }

  try {
    switch (cmd) {
      case "init": {
        const dir = dirFrom(rest, 0);
        const existing = boardPath(dir);
        if (existsSync(existing)) {
          out.stderr(`a board already exists at ${existing}\n`);
          return 1;
        }
        const board = newBoard();
        saveBoard(dir, board);
        out.stdout(`Wrote ${resolve(dir, BOARD_RELPATH)} with ${board.columns.length} columns and no cards.\n`);
        return 0;
      }
      case "add": {
        const id = rest[0];
        const title = stringOpt(opts, "title");
        const goal = stringOpt(opts, "goal");
        if (!id || !title || !goal) return usage();
        const dir = dirFrom(rest, 1);
        const depsOpt = stringOpt(opts, "deps");
        const deps = depsOpt === undefined ? undefined : depsOpt.split(",").map((d) => d.trim()).filter(Boolean);
        const tagOpt = stringOpt(opts, "tag");
        const tags = tagOpt === undefined ? undefined : tagOpt.split(",").map((t) => t.trim()).filter(Boolean);
        const board = addCard(loadBoard(dir), {
          id,
          title,
          goal,
          component: stringOpt(opts, "component"),
          size: stringOpt(opts, "size"),
          track: stringOpt(opts, "track"),
          class: stringOpt(opts, "class"),
          deps,
          tags,
          column: stringOpt(opts, "column"),
        });
        saveBoard(dir, board);
        out.stdout(`Added ${id} to ${findCard(board, id).column} in ${relpathOf(dir, boardPath(dir))}.\n`);
        return 0;
      }
      case "list": {
        const dir = dirFrom(rest, 0);
        const board = loadBoard(dir);
        const columnId = stringOpt(opts, "column");
        if (columnId !== undefined && !board.columns.some((c) => c.id === columnId)) {
          out.stderr(`unknown column "${columnId}"; columns are ${board.columns.map((c) => c.id).join(", ")}\n`);
          return 1;
        }
        const tagOpt = stringOpt(opts, "tag");
        if (tagOpt !== undefined && tagOpt.includes(",")) {
          out.stderr(`--tag takes one tag here; got "${tagOpt}"\n`);
          return 2;
        }
        if (tagOpt !== undefined && !boardTags(board).includes(tagOpt)) {
          out.stderr(`unknown tag "${tagOpt}"; tags are ${boardTags(board).join(", ")}\n`);
          return 1;
        }
        const filtered = (cards: BoardCard[]): BoardCard[] =>
          (columnId === undefined ? cards : cards.filter((c) => c.column === columnId)).filter(
            (c) => tagOpt === undefined || (c.tags || []).includes(tagOpt),
          );
        if (opts.json === true) {
          out.stdout(JSON.stringify(filtered(board.cards), null, 2) + "\n");
        } else out.stdout(listText({ ...board, cards: filtered(board.cards) }, columnId));
        return 0;
      }
      case "next": {
        const dir = dirFrom(rest, 0);
        const trackOpt = stringOpt(opts, "track");
        if (trackOpt !== undefined && trackOpt !== "flow" && trackOpt !== "hand") {
          out.stderr(`unknown track "${trackOpt}"; tracks are flow, hand\n`);
          return 2;
        }
        const track = trackOpt === "hand" ? "hand" : "flow";
        const batchOpt = stringOpt(opts, "batch");
        const batch = batchOpt === undefined ? null : Number(batchOpt);
        if (batch !== null && !(Number.isInteger(batch) && batch > 0)) {
          out.stderr(`--batch must be a positive integer, got ${JSON.stringify(batchOpt)}\n`);
          return 2;
        }
        const tagOpt = stringOpt(opts, "tag");
        if (tagOpt !== undefined && tagOpt.includes(",")) {
          out.stderr(`--tag takes one tag here; got "${tagOpt}"\n`);
          return 2;
        }
        const board = loadBoard(dir);
        const picked = batch === null ? nextReadyCard(board, { track, tag: tagOpt }) : nextReadyCards(board, { track, batch, tag: tagOpt });
        const skipped = picked.skipped;
        const card = "card" in picked ? picked.card : picked.cards.length ? picked.cards : null;
        for (const s of skipped) {
          out.stderr(
            "hand" in s
              ? `skipping ${s.id}: hand track (a by-hand card; /doug-next ${s.id} takes it)\n`
              : "flow" in s
                ? `skipping ${s.id}: flow track (run it with /doug-next)\n`
                : `skipping ${s.id}: waiting on ${s.waitingOn.join(", ")}\n`,
          );
        }
        if (!card) {
          out.stderr(track === "hand" ? "No Ready hand-track card whose dependencies are Done.\n" : "No Ready card whose dependencies are Done.\n");
          return 1;
        }
        out.stdout(JSON.stringify(card, null, 2) + "\n");
        return 0;
      }
      case "reorder": {
        const id = rest[0];
        const before = stringOpt(opts, "before");
        const after = stringOpt(opts, "after");
        const top = opts.top === true;
        const bottom = opts.bottom === true;
        const optionCount = [before !== undefined, after !== undefined, top, bottom].filter(Boolean).length;
        const validValue = (v: string | undefined): boolean => v !== undefined && v !== "" && !v.startsWith("--");
        const badValue = (before !== undefined && !validValue(before)) || (after !== undefined && !validValue(after));
        if (!id || optionCount !== 1 || badValue) return usage();
        const dir = dirFrom(rest, 1);
        const board = loadBoard(dir);
        const card = findCard(board, id);
        const record = relpathOf(dir, boardPath(dir));
        let placement: { before: string } | { after: string } | { index: number };
        let message: string;
        if (before !== undefined) {
          placement = { before };
          message = `Reordered ${id} before ${before} in ${record}.\n`;
        } else if (after !== undefined) {
          placement = { after };
          message = `Reordered ${id} after ${after} in ${record}.\n`;
        } else if (top) {
          placement = { index: 0 };
          message = `Reordered ${id} to the top of ${card.column} in ${record}.\n`;
        } else {
          placement = { index: board.cards.filter((c) => c.column === card.column).length };
          message = `Reordered ${id} to the bottom of ${card.column} in ${record}.\n`;
        }
        saveBoard(dir, reorderCard(board, id, placement));
        out.stdout(message);
        return 0;
      }
      case "move": {
        const [id, column] = rest;
        if (!id || !column) return usage();
        const dir = dirFrom(rest, 2);
        saveBoard(dir, moveCard(loadBoard(dir), id, column, { source: stringOpt(opts, "source") }));
        out.stdout(`Moved ${id} to ${column} in ${relpathOf(dir, boardPath(dir))}.\n`);
        return 0;
      }
      case "edit": {
        const id = rest[0];
        if (!id) return usage();
        const goal = stringOpt(opts, "goal");
        const goalFile = stringOpt(opts, "goal-file");
        if (goal !== undefined && goalFile !== undefined) return usage();
        const fields: EditFields = {};
        const title = stringOpt(opts, "title");
        if (title !== undefined) fields.title = title;
        if (goal !== undefined) fields.goal = goal;
        if (goalFile !== undefined) fields.goal = readFileSync(resolve(goalFile), "utf8").trimEnd();
        const size = stringOpt(opts, "size");
        if (size !== undefined) fields.size = size;
        const component = stringOpt(opts, "component");
        if (component !== undefined) fields.component = component;
        const track = stringOpt(opts, "track");
        if (track !== undefined) fields.track = track;
        const cls = stringOpt(opts, "class");
        if (cls !== undefined) fields.class = cls;
        const depsOpt = stringOpt(opts, "deps");
        if (depsOpt !== undefined) fields.deps = depsOpt.split(",").map((d) => d.trim()).filter(Boolean);
        const tagOpt = stringOpt(opts, "tag");
        if (tagOpt !== undefined) fields.tags = tagOpt.split(",").map((t) => t.trim()).filter(Boolean);
        const source = stringOpt(opts, "source");
        if (source !== undefined) fields.source = source;
        const changed = EDIT_FIELD_ORDER.filter((k) => Object.prototype.hasOwnProperty.call(fields, k));
        if (!changed.length) return usage();
        const dir = dirFrom(rest, 1);
        const plan = loadPlan(dir);
        const { board, warnings } = editCard(loadBoard(dir), id, fields, { force: opts.force === true, plan });
        saveBoard(dir, board);
        for (const w of warnings) out.stderr(`warning: ${w}\n`);
        out.stdout(`Edited ${id} (${changed.join(", ")}) in ${relpathOf(dir, boardPath(dir))}.\n`);
        return 0;
      }
      case "remove": {
        const id = rest[0];
        if (!id) return usage();
        const dir = dirFrom(rest, 1);
        const plan = loadPlan(dir);
        const { board, removed, warnings } = removeCard(loadBoard(dir), id, { force: opts.force === true, plan });
        saveBoard(dir, board);
        for (const w of warnings) out.stderr(`warning: ${w}\n`);
        out.stdout(`Removed ${id} (${removed.column}) from ${relpathOf(dir, boardPath(dir))}.\n`);
        out.stdout(JSON.stringify(removed, null, 2) + "\n");
        return 0;
      }
      case "record": {
        if (opts.hand === true) {
          const id = rest[0];
          if (!id) return usage();
          const dir = dirFrom(rest, 1);
          const card = findCard(loadBoard(dir), id);
          const entry = handEntry({
            card,
            commit: stringOpt(opts, "commit") ?? null,
            wallClock: stringOpt(opts, "wall") ?? null,
            gate: stringOpt(opts, "gate") ?? null,
            note: stringOpt(opts, "note") ?? null,
            record: relpathOf(dir, boardPath(dir)),
          });
          const { file, promoted } = recordLanding(dir, id, entry);
          if (promoted) out.stdout(`Promoted the research note for ${id} to ${promoted}.\n`);
          out.stdout(`Appended a hand-track entry for ${id} to ${file}.\n`);
          return 0;
        }
        const [id, reportFile] = rest;
        if (!id || !reportFile) return usage();
        const dir = dirFrom(rest, 2);
        const card = findCard(loadBoard(dir), id);
        const report = unwrapReport(JSON.parse(readFileSync(resolve(reportFile), "utf8")));
        const cost = stringOpt(opts, "cost");
        const codexCost = stringOpt(opts, "codex-cost");
        const sharedCost = stringOpt(opts, "shared-cost");
        // A batch plan (its cards list this card) makes the entry that card's part of the run.
        const plan = loadPlan(dir);
        const batch = plan && Array.isArray(plan.cards) && plan.cards.includes(id) ? plan.cards : null;
        const taskIds = batch && plan ? plan.tasks.filter((t) => t.card === id).map((t) => t.id) : [];
        const entry = runEntry({
          card,
          report,
          cost: cost !== undefined ? Number(cost) : null,
          codexCost: codexCost !== undefined ? Number(codexCost) : null,
          wallClock: stringOpt(opts, "wall") ?? null,
          mergeCommit: stringOpt(opts, "commit") ?? null,
          record: relpathOf(dir, boardPath(dir)),
          adversary: parseAdversaryClasses(repeated.adversary || []),
          batch,
          taskIds,
          sharedCost: sharedCost !== undefined ? Number(sharedCost) : null,
        });
        const { file, promoted } = recordLanding(dir, id, entry);
        if (promoted) out.stdout(`Promoted the research note for ${id} to ${promoted}.\n`);
        out.stdout(`Appended a run entry for ${id} to ${file}.\n`);
        return 0;
      }
      case "summary": {
        const reportFile = rest[0];
        if (!reportFile) return usage();
        let report = unwrapReport(JSON.parse(readFileSync(resolve(reportFile), "utf8")));
        const cardOpt = stringOpt(opts, "card");
        if (cardOpt !== undefined) {
          const plan = loadPlan(dirFrom(rest, 1));
          report = filterReportForCard(report, cardOpt, plan && Array.isArray(plan.tasks) ? plan.tasks.filter((t) => t.card === cardOpt).map((t) => t.id) : []);
        }
        const cost = stringOpt(opts, "cost");
        const codexCost = stringOpt(opts, "codex-cost");
        out.stdout(runSummary({ report, cost: cost !== undefined ? Number(cost) : null, codexCost: codexCost !== undefined ? Number(codexCost) : null, wallClock: stringOpt(opts, "wall") ?? null, mergeCommit: stringOpt(opts, "commit") ?? null }));
        return 0;
      }
      case "build": {
        const dir = dirFrom(rest, 0);
        const { html, board } = buildBoardPage(dir);
        const outFile = stringOpt(opts, "out");
        if (outFile === undefined) {
          out.stdout(html);
          return 0;
        }
        const file = resolve(outFile);
        writeFileSync(file, html);
        const byColumn: Record<string, number> = {};
        for (const c of board.cards) byColumn[c.column] = (byColumn[c.column] || 0) + 1;
        out.stdout(`Wrote ${file}: ${board.cards.length} cards ${JSON.stringify(byColumn)}\n`);
        return 0;
      }
      case "serve": {
        const dir = dirFrom(rest, 0);
        const portOpt = stringOpt(opts, "port");
        if (portOpt !== undefined && !/^\d+$/.test(portOpt)) return usage();
        const port = portOpt === undefined ? DEFAULT_PORT : Number(portOpt);
        if (!Number.isSafeInteger(port)) return usage();
        const openFlag = opts.open === true;
        const detachFlag = opts.detach === true;
        const stopFlag = opts.stop === true;
        if (stopFlag && (openFlag || detachFlag)) return usage();
        const record = relpathOf(dir, boardPath(dir));

        if (stopFlag) {
          const { stopped, data } = await stopRunningServer(dir, 5000);
          if (!data) {
            out.stdout(`No doug board serve is running for ${record}.\n`);
            return 0;
          }
          if (stopped) {
            out.stdout(`Stopped doug board serve (pid ${data.pid}) at ${data.url}.\n`);
            return 0;
          }
          out.stderr(`doug board serve (pid ${data.pid}) at ${data.url} is still running after 5s.\n`);
          return 1;
        }

        const running = await findRunningServer(dir);
        if (running) {
          if (openFlag) await openBrowser(running.url, out.stderr);
          out.stdout(`Already serving ${record} at ${running.url}\n`);
          return 0;
        }

        if (detachFlag) {
          loadBoard(dir);
          const child = spawnDetached(dir, port);
          let data: PidfileData;
          try {
            data = await waitForDetached(dir, child, 10000);
          } catch (err) {
            out.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
            return 1;
          }
          if (openFlag) await openBrowser(data.url, out.stderr);
          out.stdout(
            `Serving ${record} at ${data.url} in the background (pid ${data.pid}); doug board serve --stop ends it.\n`,
          );
          return 0;
        }

        const server = await startBoardServer(dir, { port });
        writePidfile(dir, { pid: process.pid, port: server.port, url: server.url, record });
        process.once("exit", () => removePidfileIfOwn(dir, process.pid));
        if (openFlag) await openBrowser(server.url, out.stderr);
        out.stdout(`Serving ${record} at ${server.url} (Ctrl-C stops it; moves write the file, nothing else is reported).\n`);
        await new Promise<void>((done) => {
          const stop = (): void => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            done();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        await server.close();
        return 0;
      }
      default:
        if (cmd) out.stderr(`Unknown board command: ${cmd}\n\n`);
        return usage();
    }
  } catch (err) {
    out.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
