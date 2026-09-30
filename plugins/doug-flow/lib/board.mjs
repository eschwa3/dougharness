// The development board (.doug/board.json, with docs/board.json read as a fallback) as the /doug-next
// skill sees it: pick the next Ready card, move a card, reorder a card within its column, add a card,
// validate the record, and append a run entry to the live-run log. Pure functions plus load/save/append.
// Whichever record file exists is the one written; a repo with neither gets .doug/board.json.
// The board page is a view of the same file, rendered by `doug board build` and served by `doug board serve`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BOARD_RELPATH = ".doug/board.json";
export const FALLBACK_RELPATH = "docs/board.json";
export const LIVE_RUNS_RELPATH = "docs/live-runs.md";
export const RESEARCH_NOTE_DIR = ".doug/.state/research";
export const RESEARCH_DOCS_DIR = "docs/research";
export const READY = "ready";
export const FLOW = "flow";
export const DONE = "done";
export const SIZES = ["S", "M", "L"];
export const TRACKS = ["flow", "hand"];
export const CLASSES = ["tests-only", "prose", "gate-script", "code", "docs", "eval", "decision"];
export const DEFAULT_TAGS = ["bug", "feature", "chore", "docs", "refactor", "spike"];

export const DEFAULT_COLUMNS = [
  { id: "decide", title: "Decide", hint: "needs a decision from the owner before it can be planned" },
  { id: "backlog", title: "Backlog", hint: "planned work, not yet specced tightly enough for a plan" },
  { id: "ready", title: "Ready", hint: "has a /goal statement; a doug flow can start it" },
  { id: "flow", title: "In flow", hint: "plan approved, doug-implement running or awaiting integration; keep to two at a time" },
  { id: "done", title: "Done", hint: "merged, gate green, documented" },
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

// The record path: .doug/board.json if present, else docs/board.json if present, else .doug/board.json.
export function boardPath(dir) {
  const canonical = join(dir, BOARD_RELPATH);
  if (existsSync(canonical)) return canonical;
  const fallback = join(dir, FALLBACK_RELPATH);
  if (existsSync(fallback)) return fallback;
  return canonical;
}

function relpathOf(dir, file) {
  return file === join(dir, FALLBACK_RELPATH) ? FALLBACK_RELPATH : BOARD_RELPATH;
}

export function newBoard({ date } = {}) {
  return { version: 1, updated: date || today(), columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), components: [], tags: [...DEFAULT_TAGS], cards: [] };
}

// The tag vocabulary a board uses: its own `tags` array when it has one (an installed project's board can
// pick its own set by editing the record), else DEFAULT_TAGS. .doug/board.json is not migrated by this
// function; a record with no `tags` field falls back here rather than being rewritten.
export function boardTags(board) {
  return board && Array.isArray(board.tags) && board.tags.every((t) => typeof t === "string") ? board.tags : DEFAULT_TAGS;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// A value as it appears in an error message; never throws (Symbol, BigInt, functions, objects included).
function show(v) {
  if (typeof v === "string") return v;
  try {
    return String(v);
  } catch {
    return typeof v;
  }
}

// Every problem with the board as a list of messages; [] when valid. Never throws: when the value itself
// cannot be inspected (a throwing getter, a revoked Proxy) the single message says so.
export function validateBoard(board) {
  try {
    return inspectBoard(board);
  } catch (err) {
    try {
      const message = err && err.message ? err.message : String(err);
      return [`board could not be inspected: ${show(message)}`];
    } catch {
      return ["board could not be inspected"];
    }
  }
}

function inspectBoard(board) {
  const errors = [];
  if (!board || typeof board !== "object" || Array.isArray(board)) return ["board is not an object"];

  const columnIds = [];
  if (!Array.isArray(board.columns) || board.columns.length === 0) {
    errors.push("columns must be a non-empty array");
  } else {
    board.columns.forEach((col, i) => {
      if (!col || typeof col !== "object" || Array.isArray(col)) return errors.push(`column at index ${i}: not an object`);
      if (!isNonEmptyString(col.id)) errors.push(`column at index ${i}: missing id`);
      else if (columnIds.includes(col.id)) errors.push(`duplicate column "${show(col.id)}"`);
      else columnIds.push(col.id);
      if (!isNonEmptyString(col.title)) errors.push(`column at index ${i}: missing title`);
      if (col.hint !== undefined && typeof col.hint !== "string") errors.push(`column at index ${i}: hint must be a string`);
    });
  }

  const components = Array.isArray(board.components) && board.components.every((c) => typeof c === "string") ? board.components : null;
  if (!components) errors.push("components must be an array of strings");

  if (board.tags !== undefined) {
    if (!Array.isArray(board.tags) || !board.tags.every((t) => isNonEmptyString(t))) {
      errors.push("tags must be an array of strings when present");
    } else {
      const seenTags = new Set();
      for (const t of board.tags) {
        if (seenTags.has(t)) errors.push(`duplicate tag "${t}"`);
        seenTags.add(t);
      }
    }
  }
  const vocabulary = boardTags(board);

  if (!Array.isArray(board.cards)) {
    errors.push("cards must be an array");
    return errors;
  }

  const ids = new Set();
  const seen = new Set();
  for (const c of board.cards) if (c && isNonEmptyString(c.id)) ids.add(c.id);
  board.cards.forEach((card, i) => {
    if (!card || typeof card !== "object" || Array.isArray(card)) return errors.push(`card at index ${i}: not an object`);
    if (!isNonEmptyString(card.id)) return errors.push(`card at index ${i}: missing id`);
    const id = card.id;
    if (seen.has(id)) errors.push(`duplicate id "${id}"`);
    seen.add(id);
    if (!columnIds.includes(card.column)) errors.push(`card "${id}": unknown column "${show(card.column)}"; columns are ${columnIds.join(", ")}`);
    if (card.component !== undefined && components && !components.includes(card.component)) {
      errors.push(`card "${id}": unknown component "${show(card.component)}"; ${components.length ? `components are ${components.join(", ")}` : "no components are defined"}`);
    }
    if (!isNonEmptyString(card.title)) errors.push(`card "${id}": missing title`);
    if (!isNonEmptyString(card.goal)) errors.push(`card "${id}": missing goal`);
    if (card.size !== undefined && !SIZES.includes(card.size)) errors.push(`card "${id}": size must be S, M, or L`);
    if (card.track !== undefined && !TRACKS.includes(card.track)) errors.push(`card "${id}": track must be flow or hand`);
    if (card.class !== undefined && !CLASSES.includes(card.class)) errors.push(`card "${id}": class must be ${CLASSES.slice(0, -1).join(", ")}, or ${CLASSES[CLASSES.length - 1]}`);
    if (card.deps !== undefined) {
      if (!Array.isArray(card.deps) || !card.deps.every((d) => typeof d === "string")) errors.push(`card "${id}": deps must be an array of strings`);
      else for (const d of card.deps) if (!ids.has(d)) errors.push(`card "${id}": unknown dep "${show(d)}"`);
    }
    if (card.source !== undefined && typeof card.source !== "string") errors.push(`card "${id}": source must be a string`);
    if (card.tags !== undefined) {
      if (!Array.isArray(card.tags) || !card.tags.every((t) => typeof t === "string")) {
        errors.push(`card "${id}": tags must be an array of strings`);
      } else {
        const seenCardTags = new Set();
        for (const t of card.tags) {
          if (seenCardTags.has(t)) errors.push(`card "${id}": duplicate tag "${t}"`);
          else if (!vocabulary.includes(t)) errors.push(`card "${id}": unknown tag "${show(t)}"; tags are ${vocabulary.join(", ")}`);
          seenCardTags.add(t);
        }
      }
    }
  });
  return errors;
}

function errorList(head, errors) {
  return [head, ...errors.map((e) => `- ${e}`)].join("\n");
}

export function loadBoard(dir) {
  const file = boardPath(dir);
  if (!existsSync(file)) throw new Error(`no board at ${join(dir, BOARD_RELPATH)} (nor ${FALLBACK_RELPATH})`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const errors = validateBoard(raw);
  if (errors.length) throw new Error(errorList(`${relpathOf(dir, file)} is not a valid board:`, errors));
  // artifactUrl is a retired field (card artifact-path-removal): a record still carrying it (any value,
  // valid or not — validateBoard no longer checks it) loads fine, with the key dropped on the way out so
  // the next saveBoard drops it too.
  const { artifactUrl, ...board } = raw;
  return board;
}

export function saveBoard(dir, board) {
  const file = boardPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(board, null, 2) + "\n");
  renameSync(tmp, file);
}

export function findCard(board, id) {
  const card = board.cards.find((c) => c.id === id);
  if (!card) throw new Error(`no card "${id}" on the board`);
  return card;
}

// The first Ready card, in board order, whose dependencies are all Done. Ready cards that are waiting
// on something are reported so the user can see why they were skipped.
// The first Ready card on the given track whose deps are Done. A card on the hand track is built directly in the
// checkout (tests, gate, commit) by /core-next, never by /doug-next; a flow card the other way round. A Ready card on
// the other track is skipped with hand: true or flow: true so the skill can say so. Decision 0005.
// `tag`, when given, filters to Ready cards carrying it: a card without it is skipped SILENTLY (not pushed onto
// `skipped`, since a caller-requested filter should not print a "skipping" line per card it filters out); a `tag`
// outside boardTags(board) throws.
export function nextReadyCard(board, { track = "flow", tag } = {}) {
  if (tag !== undefined && !boardTags(board).includes(tag)) throw new Error(`unknown tag "${tag}"; tags are ${boardTags(board).join(", ")}`);
  const done = new Set(board.cards.filter((c) => c.column === DONE).map((c) => c.id));
  const skipped = [];
  for (const c of board.cards) {
    if (c.column !== READY) continue;
    if (tag !== undefined && !(c.tags || []).includes(tag)) continue;
    const cardTrack = c.track === "hand" ? "hand" : "flow";
    if (cardTrack !== track) {
      skipped.push(cardTrack === "hand" ? { id: c.id, hand: true } : { id: c.id, flow: true });
      continue;
    }
    const waitingOn = (c.deps || []).filter((d) => !done.has(d));
    if (waitingOn.length) {
      skipped.push({ id: c.id, waitingOn });
      continue;
    }
    return { card: c, skipped };
  }
  return { card: null, skipped };
}

// The first `batch` runnable Ready cards on the track, in board order, with the skipped ones (card parallel-cards):
// what `board next --batch <n>` selects for one plan. Fewer than n when the board has fewer runnable cards.
// `tag`, like nextReadyCard's, filters to cards carrying it, silently, and throws on a tag outside boardTags(board).
export function nextReadyCards(board, { track = "flow", batch, tag } = {}) {
  if (!(Number.isInteger(batch) && batch > 0)) throw new Error("batch must be a positive integer");
  if (tag !== undefined && !boardTags(board).includes(tag)) throw new Error(`unknown tag "${tag}"; tags are ${boardTags(board).join(", ")}`);
  const done = new Set(board.cards.filter((c) => c.column === DONE).map((c) => c.id));
  const cards = [];
  const skipped = [];
  for (const c of board.cards) {
    if (c.column !== READY || cards.length >= batch) continue;
    if (tag !== undefined && !(c.tags || []).includes(tag)) continue;
    const cardTrack = c.track === "hand" ? "hand" : "flow";
    if (cardTrack !== track) {
      skipped.push(cardTrack === "hand" ? { id: c.id, hand: true } : { id: c.id, flow: true });
      continue;
    }
    const waitingOn = (c.deps || []).filter((d) => !done.has(d));
    if (waitingOn.length) {
      skipped.push({ id: c.id, waitingOn });
      continue;
    }
    cards.push(c);
  }
  return { cards, skipped };
}

// Returns a new board with the card moved. `source` replaces the card's source line (the landing commit).
// A move keeps the card's place in the record (order is priority in Ready) except a move to Done, which appends
// it: Done is then chronological, and the page shows it newest first.
export function moveCard(board, id, column, { source, date } = {}) {
  if (!board.columns.some((c) => c.id === column)) throw new Error(`unknown column "${column}"; columns are ${board.columns.map((c) => c.id).join(", ")}`);
  findCard(board, id);
  const moved = { ...findCard(board, id), column, ...(source ? { source } : {}) };
  const cards = column === DONE ? [...board.cards.filter((c) => c.id !== id), moved] : board.cards.map((c) => (c.id === id ? moved : c));
  return { ...board, updated: date || today(), cards };
}

// Returns a new board with the card reordered within its column. `placement` is exactly one of
// { before }, { after }, or { index }: before/after places the card relative to another card in the same
// column (a target elsewhere throws), index places it at that position (clamped to the column's last slot).
// The column's cards keep the same array slots they occupied; only the order within those slots changes.
// Never mutates the input; always returns a new board with the date stamped, even when the order is unchanged.
export function reorderCard(board, id, placement, { date } = {}) {
  const keys = placement && typeof placement === "object" ? ["before", "after", "index"].filter((k) => Object.prototype.hasOwnProperty.call(placement, k)) : [];
  if (!placement || typeof placement !== "object" || Array.isArray(placement) || keys.length !== 1) {
    throw new Error("reorderCard needs exactly one of before, after, or index");
  }
  const card = findCard(board, id);
  const column = card.column;
  const indices = [];
  board.cards.forEach((c, i) => {
    if (c.column === column) indices.push(i);
  });
  const others = indices.map((i) => board.cards[i]).filter((c) => c.id !== id);

  let insertAt;
  if (keys[0] === "index") {
    const idx = placement.index;
    if (!(Number.isInteger(idx) && idx >= 0)) throw new Error("index must be a non-negative integer");
    insertAt = Math.min(idx, others.length);
  } else {
    const key = keys[0];
    const targetId = placement[key];
    if (targetId === id) throw new Error(`cannot reorder "${id}" relative to itself`);
    const target = findCard(board, targetId);
    if (target.column !== column) {
      throw new Error(`cannot reorder "${id}" ${key} "${targetId}": "${targetId}" is in ${target.column}, not ${column}`);
    }
    const targetPos = others.findIndex((c) => c.id === targetId);
    insertAt = key === "before" ? targetPos : targetPos + 1;
  }

  const reordered = [...others.slice(0, insertAt), card, ...others.slice(insertAt)];
  const cards = board.cards.slice();
  indices.forEach((slot, i) => {
    cards[slot] = reordered[i];
  });
  return { ...board, updated: date || today(), cards };
}

// Returns a new board with a card appended (column defaults to backlog, deps to []). The result is
// validated; a duplicate id, unknown column, component, or dep, or a missing field throws.
export function addCard(board, { id, title, goal, component, size, track, deps, column, tags, class: cls }, { date } = {}) {
  const card = {
    id,
    column: column === undefined ? "backlog" : column,
    ...(component !== undefined ? { component } : {}),
    title,
    ...(size !== undefined ? { size } : {}),
    ...(track !== undefined ? { track } : {}),
    ...(tags !== undefined ? { tags } : {}),
    deps: deps === undefined ? [] : deps,
    goal,
    ...(cls !== undefined ? { class: cls } : {}),
  };
  const next = { ...board, updated: date || today(), cards: [...(board.cards || []), card] };
  const errors = validateBoard(next);
  if (errors.length) throw new Error(errorList(`cannot add card "${id}":`, errors));
  return next;
}

// Fields editCard accepts; the column is never one of them (move stays the way to change a column).
const EDITABLE_FIELDS = ["title", "goal", "size", "component", "track", "deps", "source", "tags", "class"];

// Returns a new board with the named card's fields changed (a new board, input untouched, `updated` stamped
// like moveCard) and `warnings`, an array of strings (empty when none). `fields` may carry any of
// EDITABLE_FIELDS; anything else, or an empty `fields`, is refused, as is editing the id. A card in `done`
// accepts only goal and source, and only with `force`; a card in `flow`, or named by `plan` (its `card`,
// `cards`, or a task's `card`), needs `force` only for goal or deps, since an approved plan's acceptance may
// no longer describe the card once those change. Either force path returns its sentence as a warning rather
// than refusing, so the caller (a CLI, printing `warning: <text>` on stderr) can decide what to do with it.
// The result is validated with validateBoard the same way addCard's result is, so a bad size, unknown
// component, unknown dep, empty title or goal, or non-string source is refused with the add-shaped message.
export function editCard(board, id, fields, { force = false, date, plan = null } = {}) {
  const prefix = `cannot edit card "${id}":`;
  const keys = fields && typeof fields === "object" && !Array.isArray(fields) ? Object.keys(fields) : [];
  if (!keys.length) throw new Error(`${prefix} no field to change`);
  if (Object.prototype.hasOwnProperty.call(fields, "id")) {
    throw new Error(`${prefix} the id is not editable (deps, the plan's card field, commit messages, and docs/live-runs.md cite it)`);
  }
  for (const k of keys) {
    if (!EDITABLE_FIELDS.includes(k)) throw new Error(`${prefix} unknown field "${k}"; editable fields are ${EDITABLE_FIELDS.join(", ")}`);
  }

  const card = findCard(board, id);
  const warnings = [];

  if (card.column === DONE) {
    if (keys.some((k) => k !== "goal" && k !== "source")) throw new Error(`${prefix} a done card accepts only --goal and --source, with --force`);
    const landed = card.source || "an unrecorded commit";
    if (!force) throw new Error(`${prefix} a done card changes only with --force; it landed as ${landed}`);
    warnings.push(`editing done card "${id}", landed as ${landed}: docs/live-runs.md and the landing commit still describe the old text`);
  }

  const planNamed = plan && (plan.card === id || (Array.isArray(plan.cards) && plan.cards.includes(id)) || (Array.isArray(plan.tasks) && plan.tasks.some((t) => t && t.card === id)));
  if (card.column === FLOW || planNamed) {
    const sentence = `"${id}" is in flow / is named by .doug/plan.json: --goal and --deps need --force, since an approved plan's acceptance may no longer describe the card`;
    if (keys.some((k) => k === "goal" || k === "deps")) {
      if (!force) throw new Error(`${prefix} ${sentence}`);
      warnings.push(sentence);
    }
  }

  const nextCard = { ...card };
  for (const k of keys) nextCard[k] = fields[k];
  const cards = board.cards.map((c) => (c.id === id ? nextCard : c));
  const next = { ...board, updated: date || today(), cards };
  const errors = validateBoard(next);
  if (errors.length) throw new Error(errorList(prefix, errors));
  return { board: next, warnings };
}

// Returns { board, removed, warnings }: a new board with the card gone (input untouched, `updated` stamped like
// moveCard), the removed card object, and warnings (empty when none). Message prefix: `cannot remove card "<id>":`.
// An unknown id throws findCard's own message. Refusals, checked in order: (a) a card another card lists in
// `deps` is refused ALWAYS, force included, because the result would fail validateBoard's unknown-dep rule and
// loadBoard would then refuse to read the record; (b) a done card needs --force (warns which commit still cites
// it); (c) a card in `flow`, or named by `plan` the same way editCard checks, needs --force (warns the same
// sentence editCard's flow/plan rule uses). The result is validated with validateBoard like addCard and editCard.
export function removeCard(board, id, { force = false, date, plan = null } = {}) {
  const prefix = `cannot remove card "${id}":`;
  const card = findCard(board, id);
  const warnings = [];

  const dependents = board.cards.filter((c) => c.id !== id && Array.isArray(c.deps) && c.deps.includes(id)).map((c) => c.id);
  if (dependents.length) {
    throw new Error(`${prefix} cards depend on it: ${dependents.join(", ")}; remove the dep first (the record would not load)`);
  }

  if (card.column === DONE) {
    const landed = card.source || "an unrecorded commit";
    if (!force) throw new Error(`${prefix} a done card is removed only with --force; it landed as ${landed}`);
    warnings.push(`removed done card "${id}", landed as ${landed}: the run log and the landing commit still cite the id`);
  }

  const planNamed = plan && (plan.card === id || (Array.isArray(plan.cards) && plan.cards.includes(id)) || (Array.isArray(plan.tasks) && plan.tasks.some((t) => t && t.card === id)));
  if (card.column === FLOW || planNamed) {
    const sentence = `"${id}" is in flow / is named by .doug/plan.json: removing it needs --force, since an approved plan still names the card`;
    if (!force) throw new Error(`${prefix} ${sentence}`);
    warnings.push(sentence);
  }

  const cards = board.cards.filter((c) => c.id !== id);
  const next = { ...board, updated: date || today(), cards };
  const errors = validateBoard(next);
  if (errors.length) throw new Error(errorList(prefix, errors));
  return { board: next, removed: card, warnings };
}

function yesNo(v) {
  return v ? "yes" : "no";
}

// One markdown section for docs/live-runs.md from a doug-implement report. Numbers are the ones passed
// in (measured by the caller) or absent; nothing is estimated.
// The "Model tier" cell of a run entry: `sonnet / medium (tier cheap)`, `inherit`, or an older string form.
// A reused task ran no implementer: the checkout agent's model is what it cost.
function describeTierCell(models, reused = false) {
  if (reused && models && typeof models.checkout === "object" && models.checkout !== null) return `${models.checkout.model || "inherit"} (checkout)`;
  const m = models && models.implement;
  if (!m) return "inherit";
  if (typeof m === "string") return m;
  const model = m.model || "inherit";
  const effort = m.effort && m.effort !== "inherit" ? ` / ${m.effort}` : "";
  const tier = models.tier ? ` (tier ${models.tier})` : "";
  return `${model}${effort}${tier}`;
}

export const ADVERSARY_CLASSES = ["real", "marginal", "false"];

// Every adversary block a report records, one per finding. With a ledger (the fix loop since 3d9049d) a block is a
// ledger entry the adversary raised as a blocker, with the pass that raised it from attempts[].newFindings; for a
// report from before the ledger, one block per pass the adversary blocked, named pass-<n>, described by that pass's
// blocker issue when the report kept it (only the last pass's issues survive) and otherwise by its summary.
export function adversaryBlocks(report) {
  const out = [];
  for (const level of report.levels || []) {
    for (const t of level.tasks || []) {
      const attempts = Array.isArray(t.attempts) ? t.attempts : [];
      if (Array.isArray(t.ledger)) {
        for (const e of t.ledger) {
          if (e.stage !== "adversary" || e.severity !== "blocker") continue;
          const raised = attempts.find((a) => Array.isArray(a.newFindings) && a.newFindings.includes(e.id));
          out.push({ task: t.id, id: e.id, pass: raised ? raised.pass : null, status: e.status || null, description: String(e.description || "") });
        }
        continue;
      }
      const blocked = attempts.filter((a) => a.adversary && a.adversary.blocked);
      const last = blocked.length ? blocked[blocked.length - 1] : null;
      const finalBlocker = t.adversary && t.adversary.blocked ? (t.adversary.issues || []).find((i) => i.severity === "blocker") : null;
      for (const a of blocked) {
        const description = a === last && finalBlocker ? finalBlocker.description : a.adversary.summary || "";
        out.push({ task: t.id, id: `pass-${a.pass}`, pass: a.pass, status: null, description: String(description) });
      }
      if (!blocked.length && t.adversary && t.adversary.blocked) out.push({ task: t.id, id: "pass-1", pass: 1, status: null, description: String(finalBlocker ? finalBlocker.description : t.adversary.summary || "") });
    }
  }
  return out;
}

// The name a block is classified under: its id when no other task's block shares it, else task/id.
export function blockKey(block, blocks) {
  return blocks.filter((b) => b.id === block.id).length > 1 ? `${block.task}/${block.id}` : block.id;
}

// `--adversary` values: each is `<id>=<class>[: <reason>]`; a value without a reason may list several, comma-separated.
export function parseAdversaryClasses(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const items = String(value).includes(":") ? [String(value)] : String(value).split(",");
    for (const raw of items) {
      const item = raw.trim();
      if (!item) continue;
      const m = /^([^=\s]+)=([a-z]+)(?::\s*(.*))?$/s.exec(item);
      if (!m) throw new Error(`cannot read adversary classification "${item}": expected <id>=<real|marginal|false>[: <reason>]`);
      if (!ADVERSARY_CLASSES.includes(m[2])) throw new Error(`unknown adversary class "${m[2]}" for ${m[1]}; classes are ${ADVERSARY_CLASSES.join(", ")}`);
      out.push({ id: m[1], class: m[2], reason: (m[3] || "").trim() || null });
    }
  }
  return out;
}

// The report's blocks with their classes attached. An id that names no block is an error (the message lists the
// report's blocks); a block nobody classified stays unclassified and is counted as such.
export function classifyBlocks(report, classes = []) {
  const blocks = adversaryBlocks(report);
  const classified = blocks.map((b) => ({ ...b, key: blockKey(b, blocks), class: null, reason: null }));
  for (const c of classes) {
    const hit = classified.find((b) => b.key === c.id || `${b.task}/${b.id}` === c.id);
    if (!hit) throw new Error(`no adversary block named ${c.id} in this report; its blocks are: ${classified.length ? classified.map((b) => b.key).join(", ") : "none"}`);
    hit.class = c.class;
    hit.reason = c.reason;
  }
  return classified;
}

// "1 real / 0 marginal / 1 false", with "/ n unclassified" when a block has no class; "no blocks" for a clean run.
export function precisionLine(blocks) {
  if (!blocks.length) return "no blocks";
  const n = (cls) => blocks.filter((b) => b.class === cls).length;
  const unclassified = blocks.filter((b) => !b.class).length;
  return `${n("real")} real / ${n("marginal")} marginal / ${n("false")} false${unclassified ? ` / ${unclassified} unclassified` : ""}`;
}

export function blockLines(blocks) {
  return blocks.map((b) => `- ${b.key} (${b.task}${b.pass !== null ? `, pass ${b.pass}` : ""}): ${b.class || "unclassified"}. ${b.class ? b.reason || "no reason given" : b.description.length > 160 ? b.description.slice(0, 157) + "..." : b.description}`);
}

// A per-task adversary cell (card fix-loop-minor-verdict): a real block still reads "verdict (blocked)", unchanged;
// a `fail` that did not block (only major/minor issues, so it never reached the ledger as a blocker) carries the
// notes it kept, so it never reads as a bare "fail" with nothing said about why it did not stop the task.
function adversaryVerdictCell(adv) {
  if (adv.blocked) return `${adv.verdict} (blocked)`;
  if (adv.verdict === "fail") {
    const n = Array.isArray(adv.issues) ? adv.issues.length : 0;
    return n ? `fail (${n} note${n === 1 ? "" : "s"})` : "fail (notes)";
  }
  return adv.verdict;
}

// The integration row's last cell: what the level adversary (the one review of a level's size-S tasks on the
// integration branch) found, the fix pass it caused, and whether its confirmation cleared the level.
function levelAdversaryCell(la) {
  if (!la) return "";
  const verdict = la.ran ? adversaryVerdictCell(la) : `did not run${la.error ? `: ${la.error}` : ""}`;
  const parts = [`level adversary on ${(la.tasks || []).join(", ") || "no task"}: ${verdict}`];
  if (la.unowned && la.unowned.length) parts.push(`no owner for ${la.unowned.join(", ")}`);
  if (Array.isArray(la.fixed) && la.fixed.length) parts.push(`fix pass on ${la.fixed.map((f) => `${f.task}${f.ready ? "" : " (not ready)"}`).join(", ")}`);
  if (la.reintegration) parts.push(`re-integration ${la.reintegration.ok ? "ok" : "failed"}`);
  if (la.confirm) parts.push(`confirm ${la.confirm.ran ? adversaryVerdictCell(la.confirm) : "did not run"}`);
  return parts.join("; ");
}

// The part of a batch run's report that is one card's: only that card's tasks (a task carries `card` since the
// workflow records it; a report from before that is matched by `taskIds`, the plan's task ids for the card), and
// only the levels that hold one of them. The integration rows of those levels stay: they are shared by the batch.
// Also carries `batchCards`, the sorted unique `card` values of every task in the UNFILTERED report, present only
// when at least one task carries `card` (absent for a report from before batching): acceptanceUnmet needs the
// whole batch's card set to tell a confirmed other-card entry (dropped) from one naming a card the report never
// had (card batch-summary-acceptance-noise, MINOR 1 regression) - a filtered-down task list alone cannot answer
// that, since filtering to one card is exactly what makes every other card invisible to it.
export function filterReportForCard(report, cardId, taskIds = []) {
  const ids = new Set(Array.isArray(taskIds) ? taskIds : []);
  const mine = (t) => t && (t.card === cardId || (t.card === undefined && ids.has(t.id)));
  const levels = (report.levels || []).map((l) => ({ ...l, tasks: (l.tasks || []).filter(mine) })).filter((l) => l.tasks.length);
  const allCards = new Set((report.levels || []).flatMap((l) => (l.tasks || []).map((t) => t && t.card)).filter((c) => c !== undefined));
  return { ...report, levels, ...(allCards.size ? { batchCards: [...allCards].sort() } : {}) };
}

function listOthers(batch, cardId) {
  const others = batch.filter((c) => c !== cardId);
  return others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}` : others[0] || "";
}

// `batch` (the plan's cards, in plan order) makes this one card's entry of a batch run: its tasks only, `cost` as
// that card's tasks' measured cost, and the shared integration agents' cost (`sharedCost`) counted once, under the
// batch's first card. `taskIds` is the fallback for a report whose tasks carry no `card`.
// The one-phrase outcome of a report, shared by the record and the summary. A run that stopped never reached a
// gate, so stoppedAtLevel wins; a paused run (typed gates, d07f06f) has ok false with every stage passed, and
// saying "not green" for it misread the report until 2026-09-07.
function pausedAt(report) {
  return report.paused && typeof report.paused === "object" && Number.isInteger(report.paused.level) ? report.paused : null;
}
function listNext(report) {
  const next = Array.isArray(pausedAt(report)?.next) ? pausedAt(report).next : [];
  return next.length ? next.join(", ") : "none";
}
function outcomeOf(report) {
  if (report.ok) return "green";
  if (report.stoppedAtLevel !== undefined) return `stopped at level ${report.stoppedAtLevel}`;
  if (pausedAt(report)) return `paused at the human gate after level ${pausedAt(report).level}`;
  return "not green";
}

export function runEntry({ card, report, cost = null, codexCost = null, wallClock = null, mergeCommit = null, record = null, adversary = [], date = new Date().toISOString().slice(0, 10), batch = null, sharedCost = null, taskIds = [], note = null, rehearsal = null }) {
  const inBatch = Array.isArray(batch) && batch.length > 1;
  if (inBatch) report = filterReportForCard(report, card.id, taskIds);
  const lines = [];
  lines.push(`## ${date}, ${card.id}: ${card.title}`);
  lines.push("");
  const batchNote = inBatch ? `, in one plan with ${listOthers(batch, card.id)} (one approval, one run, one landing)` : "";
  lines.push(
    rehearsal
      ? `Rehearsal ${rehearsal} for card \`${card.id}\` on the ts-basic fixture (plugins/doug-flow/scripts/rehearse.mjs); the commit and gate below are the fixture's, not this repository's.`
      : `Ran through /doug-next on this repo from card \`${card.id}\`${record ? ` in \`${record}\`` : ""}${batchNote}. Plan "${report.plan}", integration branch \`${report.integrationBranch}\`${report.modelsSource ? `, models from ${report.modelsSource}` : ""}.`,
  );
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("|---|---|");
  lines.push(`| Outcome | ${outcomeOf(report)}${pausedAt(report) ? `; next: ${listNext(report)}` : ""} |`);
  lines.push(`| Cost | ${cost === null ? "not measured" : `$${Number(cost).toFixed(2)}${inBatch ? " for this card's tasks" : ""}`} |`);
  if (!inBatch || batch[0] === card.id) {
    lines.push(
      `| Codex adversary | ${
        codexCost === null
          ? "not measured"
          : inBatch
            ? `$${Number(codexCost).toFixed(2)} for the whole batch, counted once here, not included in Cost`
            : `$${Number(codexCost).toFixed(2)}, not included in Cost`
      } |`,
    );
  }
  if (inBatch) lines.push(`| Shared integration agents | ${sharedCost === null ? "not measured" : `$${Number(sharedCost).toFixed(2)}, counted once for the batch ${batch[0] === card.id ? "here" : `under ${batch[0]}`}`} |`);
  lines.push(`| Wall clock | ${wallClock === null ? "not measured" : wallClock} |`);
  const blocks = classifyBlocks(report, adversary);
  const shownCommit = rehearsal && mergeCommit ? String(mergeCommit).slice(0, 7) : mergeCommit;
  lines.push(`| Landed as | ${shownCommit ? `\`${shownCommit}\`` : "not landed"} |`);
  lines.push(`| Adversary precision | ${precisionLine(blocks)} |`);
  lines.push("");
  if (note) {
    lines.push(String(note));
    lines.push("");
  }
  lines.push("| Level | Task | Implemented | Verified | Reviewed | Adversary | Model tier | Shape |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const level of report.levels || []) {
    for (const t of level.tasks || []) {
      const adv = t.adversary ? (t.adversary.ran ? adversaryVerdictCell(t.adversary) : `did not run${t.adversary.error ? `: ${t.adversary.error}` : ""}`) : "skipped";
      const tier = describeTierCell(t.models, t.reused);
      // A reuse task that did not implement (a thrown stage, or a checkout agent that returned nothing) must read
      // as blocked/not-implemented, not as reused: `reused` records the task's intent for the memory outcome log,
      // but this table says what happened, and a task that never implemented never actually checked the branch
      // out (card thrown-reuse-reads-as-reused). So `!implemented` owns the branch outright.
      let implemented = !t.implemented ? (t.blockedReason ? `blocked: ${t.blockedReason}` : "no") : typeof t.reused === "string" && t.reused ? `reused \`${t.reused}\`` : "yes";
      if (Array.isArray(t.attempts) && t.attempts.length > 1) implemented += ` (${t.attempts.length} passes)`;
      lines.push(`| ${level.index} | ${t.id} | ${implemented} | ${yesNo(t.verified)} | ${yesNo(t.reviewed)} | ${adv} | ${tier} | ${t.shape === "S" ? "S" : "full"} |`);
    }
    lines.push(`| ${level.index} | integration | ${level.integration ? (level.integration.ok ? "ok" : "failed") : "not run"} | | | | ${describeTierCell({ implement: level.integrationModel })} | ${levelAdversaryCell(level.levelAdversary)} |`);
  }
  if (blocks.length) {
    lines.push("");
    lines.push("Adversary blocks, classified (real: a defect a user would hit; marginal: true to the spec, no user impact; false: wrong):");
    lines.push(...blockLines(blocks));
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

// The live-runs entry for a hand-track card (decision 0005): no workflow report and no levels, so it records what
// /core-next can measure: the landing commit, the wall clock, and the gate result, plus an optional note.
export function handEntry({ card, commit = null, wallClock = null, gate = null, note = null, record = null, date = new Date().toISOString().slice(0, 10), rehearsal = null }) {
  const lines = [];
  lines.push(`## ${date}, ${card.id}: ${card.title}`);
  lines.push("");
  lines.push(
    rehearsal
      ? `Rehearsal ${rehearsal} for card \`${card.id}\` on the ts-basic fixture (plugins/doug-flow/scripts/rehearse.mjs); the commit and gate below are the fixture's, not this repository's.`
      : `Built by hand through /core-next from card \`${card.id}\`${record ? ` in \`${record}\`` : ""} (hand track, decision 0005); no workflow run.`,
  );
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("|---|---|");
  lines.push(`| Outcome | ${commit ? "landed" : "not landed"} |`);
  const shownCommit = rehearsal && commit ? String(commit).slice(0, 7) : commit;
  lines.push(`| Commit | ${shownCommit ? `\`${shownCommit}\`` : "none"} |`);
  lines.push(`| Wall clock | ${wallClock === null ? "not measured" : wallClock} |`);
  lines.push(`| Gate | ${gate === null ? "not recorded" : gate} |`);
  lines.push("");
  if (note) {
    lines.push(String(note));
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function truncateAcceptanceText(text) {
  const s = String(text);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}

// A batch report's `[<card>] ` tag, written onto every plan acceptance text by plan.mjs merge (lib/plan.mjs).
const ACCEPTANCE_TAG = /^\[([^\]]+)\]\s/;

// The acceptance entries runSummary's third line reads as unmet, and how it says so (card
// batch-summary-acceptance-noise): a task's verifier runs every plan acceptance command on that task's own
// branch, before the rest of a batch's cards or later levels exist, so most of a batch report's `ok: false`
// entries are not real failures of that task's card. Precedence:
//  1. The final level's `integration.acceptance` (written by the workflow's integrate stage since card
//     integration-acceptance-recorded), when it is a non-empty array: the plan's acceptance run once, after
//     everything integrated, so nothing per-task needs reconciling and this wins regardless of tags.
//  2. Otherwise, whenever the report is a batch (some task carries `card`; a report from before batching never
//     does): the gate is `isBatch` alone, not whether any entry anywhere is tagged, because a whole task can
//     lose its tag (the real report: task cli-remove-and-tag-flags returned 12/12 untagged) and that must not
//     fall through to rule 3's every-entry-counts reading with the rest of the batch's noise still in it. The
//     known-card set is `report.batchCards` (every card the whole, unfiltered batch has, written by
//     filterReportForCard) when present, unioned with the cards this task list itself carries, so a report
//     from before that field existed still falls back to what it can see. Per entry:
//       - tagged `[<t.card>] ` (this task's own card): counts as unmet when `ok === false`.
//       - tagged with a card the known-card set has but that isn't this task's own: genuine cross-card noise,
//         dropped outright (not shown, not counted anywhere) - true even under `--card`, where the task list
//         holds only one card, since `batchCards` still names the others.
//       - anything else - no tag at all, a tag naming a card the known-card set does not have at all (a typo,
//         or a report with no `batchCards` and no other task carrying that card in view), or any tag at all on
//         a task whose own `card` is undefined (a mixed report) - cannot be attributed either way, so it is set
//         aside rather than guessed at, and the source clause names how many were set aside, how many of those
//         failed, and for which task(s), so a real failure hidden behind an unreadable tag is never silent.
//  3. Otherwise (no task in the report carries `card` at all): every `ok: false` entry counts, unchanged from
//     before this card.
// Returns { unmet, source, dirty }: `unmet` the display strings for "Acceptance not met: ...", `source` the
// clause (with its own leading space, no trailing punctuation) to append to the third line ("" under rule 3, so
// an old report's summary is byte-identical to before), and `dirty` (rule 2 only) true when a set-aside entry
// itself failed, so a batch report never reads as a clean pass while one of those is left unresolved.
function acceptanceUnmet(report, tasks) {
  const levels = report.levels || [];
  const finalLevel = levels.length ? levels[levels.length - 1] : null;
  const integrationAcceptance = finalLevel && finalLevel.integration && Array.isArray(finalLevel.integration.acceptance) ? finalLevel.integration.acceptance : null;
  if (integrationAcceptance && integrationAcceptance.length) {
    const unmet = integrationAcceptance.filter((a) => a && a.ok === false).map((a) => truncateAcceptanceText(a.text));
    return { unmet, source: " (acceptance read from the final integration level)", dirty: false };
  }

  const isBatch = tasks.some(({ task: t }) => t.card !== undefined);
  if (!isBatch) {
    const unmet = tasks.flatMap(({ task: t }) => (t.acceptance || []).filter((a) => a && a.ok === false).map((a) => `${truncateAcceptanceText(a.text)} (${t.id})`));
    return { unmet, source: "", dirty: false };
  }

  const knownCards = new Set(tasks.map(({ task: t }) => t.card).filter((c) => c !== undefined));
  if (Array.isArray(report.batchCards)) for (const c of report.batchCards) knownCards.add(c);
  const unmet = [];
  const setAside = new Map(); // task id -> { count, failing }
  const noteAside = (id, ok) => {
    const entry = setAside.get(id) || { count: 0, failing: 0 };
    entry.count += 1;
    if (ok === false) entry.failing += 1;
    setAside.set(id, entry);
  };
  for (const { task: t } of tasks) {
    for (const a of t.acceptance || []) {
      if (!a) continue;
      const m = typeof a.text === "string" ? ACCEPTANCE_TAG.exec(a.text) : null;
      if (!m || t.card === undefined) {
        noteAside(t.id, a.ok); // no tag, or a tag we cannot compare against this task's own (missing) card
        continue;
      }
      if (m[1] === t.card) {
        if (a.ok === false) unmet.push(`${truncateAcceptanceText(a.text)} (${t.id})`);
        continue;
      }
      if (!knownCards.has(m[1])) {
        noteAside(t.id, a.ok); // names a card the whole batch never carries: unreadable, not confirmed cross-card noise
        continue;
      }
      // else: another card actually in this task list owns it, evaluated on this task's branch before that
      // card's own work existed: real cross-card noise, dropped outright.
    }
  }
  let asideCount = 0;
  let asideFailing = 0;
  for (const v of setAside.values()) {
    asideCount += v.count;
    asideFailing += v.failing;
  }
  const asideNote = asideCount
    ? `; ${asideCount} unattributed ${asideCount === 1 ? "entry" : "entries"} set aside${asideFailing ? `, ${asideFailing} failing` : ""}: ${[...setAside.keys()].join(", ")}`
    : "";
  return { unmet, source: ` (acceptance read per task by [card] tag${asideNote})`, dirty: asideFailing > 0 };
}

// Three lines for the chat after a run: the outcome, the tasks, and what stopped or was not met. Everything in it
// is read from the report; nothing is estimated.
export function runSummary({ report, cost = null, codexCost = null, wallClock = null, mergeCommit = null }) {
  const tasks = (report.levels || []).flatMap((l) => (l.tasks || []).map((t) => ({ level: l, task: t })));
  const integrated = tasks.filter(({ level }) => level.integration && level.integration.ok).length;
  const outcome = outcomeOf(report);
  const first = `${report.plan}: ${outcome}; ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${integrated} integrated; wall ${wallClock === null ? "not measured" : wallClock}; cost ${cost === null ? "not measured" : `$${Number(cost).toFixed(2)}`}${codexCost === null ? "" : `; Codex $${Number(codexCost).toFixed(2)}`}${mergeCommit ? `; landed as ${mergeCommit}` : ""}.`;
  const second = tasks.length
    ? tasks.map(({ task: t }) => {
        const passes = Array.isArray(t.attempts) && t.attempts.length ? t.attempts.length : 1;
        const adv = t.adversary ? (t.adversary.ran ? adversaryVerdictCell(t.adversary) : "did not run") : "skipped";
        // Same precedence as the run-entry table above: `!implemented` owns the branch outright.
        const impl = !t.implemented ? (t.blockedReason ? `blocked: ${t.blockedReason}` : "not implemented") : typeof t.reused === "string" && t.reused ? `reused ${t.reused}` : "implemented";
        return `${t.id}: ${impl}, ${passes} pass${passes === 1 ? "" : "es"}, verify ${yesNo(t.verified)}, review ${yesNo(t.reviewed)}, adversary ${adv}`;
      }).join("; ")
    : "no tasks";
  const stops = tasks.filter(({ task: t }) => t.stopReason).map(({ task: t }) => `${t.id}: "${t.stopReason}"`);
  const { unmet, source, dirty } = acceptanceUnmet(report, tasks);
  const pause = pausedAt(report) ? `Paused at the human gate after level ${pausedAt(report).level}; next: ${listNext(report)}. Open it with plan.mjs gate open ${pausedAt(report).level} and resume the run.` : "";
  const third = pause || stops.length || unmet.length
    ? [pause, stops.length ? `Stopped: ${stops.join("; ")}` : "", unmet.length ? `Acceptance not met: ${unmet.join("; ")}` : ""].filter(Boolean).join(" | ") + source
    : `${dirty ? "No attributed acceptance command failed" : "Every stage and acceptance command passed"}${source}.`;
  return `${first}\n${second}\n${third}\n`;
}

// Promotes card <id>'s research note into docs/ when recording a landing (card research-notes-survive): a note
// under .doug/.state/research/ is session state, gitignored and disposable, which is right for a note the
// planner used and discarded and wrong for a note a landed commit cites — nothing is there to read afterward.
// Copies, never moves: .doug/.state/ may still be read this session, and it stays gitignored either way. Returns
// the docs-relative path it wrote, or null when the card has no note (most cards; nothing is printed for those).
// The mechanism is one note per card, keyed by card id: a note not named for a card (memory-architecture.md) and
// a directory of parts (memory-parts/) are out of it by shape, not by oversight, and stay in state, unpromoted.
// A failure (a bad id, or the filesystem) throws rather than promoting nothing and staying quiet about it — the
// silent loss of a cited note is the defect this function exists to close — so the caller must promote before
// it writes anything else, or a failed retry duplicates what did get written.
// When the docs copy already exists and is byte-identical to the state note, nothing is copied and null is
// returned (the caller prints nothing): re-recording a card whose note has not changed used to overwrite an
// unchanged file and print "Promoted the research note" every time, which reads as if something happened when
// nothing did (card rehearsal-first-live-findings #4).
const SAFE_RESEARCH_ID = /^[a-z0-9._-]+$/;
export function promoteResearchNote(dir, id) {
  if (!SAFE_RESEARCH_ID.test(id)) {
    throw new Error(`cannot promote the research note for "${id}": card ids must match ${SAFE_RESEARCH_ID} to stay inside ${RESEARCH_DOCS_DIR}/`);
  }
  const src = join(dir, RESEARCH_NOTE_DIR, `${id}.md`);
  if (!existsSync(src)) return null;
  const destDir = join(dir, RESEARCH_DOCS_DIR);
  const relPath = `${RESEARCH_DOCS_DIR}/${id}.md`;
  const destPath = join(dir, relPath);
  if (existsSync(destPath) && readFileSync(destPath).equals(readFileSync(src))) return null;
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, destPath);
  return relPath;
}

export function appendRun(dir, markdown) {
  const file = join(dir, LIVE_RUNS_RELPATH);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "# Live runs of doug-flow\n\n");
  const current = readFileSync(file, "utf8");
  appendFileSync(file, (current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n") + markdown);
  return file;
}

// The one step both `board.mjs record` and `doug board record` take when landing a card: promote its research
// note (if any), then append the run entry. Both command layers call this instead of each re-implementing the
// two calls, so the promotion cannot be added to one surface and not the other (card cli-record-promotion-drift).
// Promote first: appendFileSync is not idempotent, so a promotion failure must leave the entry unwritten, not
// written twice on the retry that follows a loud failure.
export function recordLanding(dir, id, markdown) {
  const promoted = promoteResearchNote(dir, id);
  const file = appendRun(dir, markdown);
  return { file, promoted };
}
