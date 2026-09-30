// The board library and CLI behind /doug-next: card selection, moves, and run entries. No agents run.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBoard, saveBoard, boardPath, validateBoard, newBoard, addCard, editCard, removeCard, nextReadyCard, nextReadyCards, moveCard, reorderCard, findCard, runEntry, handEntry, runSummary, appendRun, DEFAULT_COLUMNS, DEFAULT_TAGS, boardTags, adversaryBlocks, classifyBlocks, parseAdversaryClasses, promoteResearchNote, recordLanding } from "../lib/board.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "scripts", "board.mjs");

function board() {
  return {
    version: 1,
    updated: "2026-09-01",
    columns: [{ id: "backlog", title: "Backlog" }, { id: "ready", title: "Ready" }, { id: "flow", title: "In flow" }, { id: "done", title: "Done" }],
    components: ["gates", "flow"],
    cards: [
      { id: "base", column: "done", component: "gates", title: "Base", size: "S", source: "commit 1111111", goal: "done already" },
      { id: "blocked", column: "ready", component: "flow", title: "Blocked", size: "S", deps: ["later"], goal: "waits on later" },
      { id: "first", column: "ready", component: "gates", title: "First", size: "S", deps: ["base"], goal: "the first runnable card" },
      { id: "second", column: "ready", component: "gates", title: "Second", size: "M", deps: [], goal: "the second runnable card" },
      { id: "later", column: "backlog", component: "flow", title: "Later", size: "L", goal: "not ready" },
    ],
  };
}

function project(b = board()) {
  const dir = mkdtempSync(join(tmpdir(), "doug-board-"));
  saveBoard(dir, b);
  return dir;
}

describe("boardPath, loadBoard, saveBoard", () => {
  it("reads and writes docs/board.json when only the fallback exists, without creating .doug/board.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/board.json"), JSON.stringify(board()));
    expect(boardPath(dir)).toBe(join(dir, "docs/board.json"));
    expect(findCard(loadBoard(dir), "first").title).toBe("First");
    saveBoard(dir, moveCard(loadBoard(dir), "first", "done", { date: "2026-09-04" }));
    expect(JSON.parse(readFileSync(join(dir, "docs/board.json"), "utf8")).updated).toBe("2026-09-04");
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(false);
  });
  it("prefers .doug/board.json when both exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, "docs/board.json"), JSON.stringify({ ...board(), updated: "2000-01-01" }));
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board()));
    expect(boardPath(dir)).toBe(join(dir, ".doug/board.json"));
    expect(loadBoard(dir).updated).toBe("2026-09-01");
  });
  it("writes .doug/board.json when neither exists and loadBoard says there is no board", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-board-"));
    expect(boardPath(dir)).toBe(join(dir, ".doug/board.json"));
    expect(() => loadBoard(dir)).toThrow(`no board at ${join(dir, ".doug/board.json")} (nor docs/board.json)`);
    saveBoard(dir, board());
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(true);
    expect(existsSync(join(dir, "docs/board.json"))).toBe(false);
  });
  it("refuses to load a broken record and lists every error", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(dir, ".doug"));
    const b = board();
    b.cards[2] = { ...b.cards[2], column: "archive", goal: "" };
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(b));
    expect(() => loadBoard(dir)).toThrow('.doug/board.json is not a valid board:\n- card "first": unknown column "archive"; columns are backlog, ready, flow, done\n- card "first": missing goal');
  });
});

describe("validateBoard", () => {
  it("accepts the fixture and a new board", () => {
    expect(validateBoard(board())).toEqual([]);
    expect(validateBoard(newBoard())).toEqual([]);
  });
  it("rejects a board that is not an object", () => {
    expect(validateBoard(null)).toEqual(["board is not an object"]);
    expect(validateBoard(7)).toEqual(["board is not an object"]);
    expect(validateBoard("board")).toEqual(["board is not an object"]);
    expect(validateBoard([])).toEqual(["board is not an object"]);
  });
  it("reports the top-level shape errors on separate inputs", () => {
    expect(validateBoard({ columns: [], components: [], cards: [] })).toEqual(["columns must be a non-empty array"]);
    expect(validateBoard({ columns: "x", components: [], cards: [] })).toEqual(["columns must be a non-empty array"]);
    expect(validateBoard({ columns: DEFAULT_COLUMNS, components: "x", cards: [] })).toEqual(["components must be an array of strings"]);
    expect(validateBoard({ columns: DEFAULT_COLUMNS, components: [1], cards: [] })).toEqual(["components must be an array of strings"]);
    expect(validateBoard({ columns: DEFAULT_COLUMNS, components: [], cards: {} })).toEqual(["cards must be an array"]);
  });
  it("reports every problem with a broken board, one message per rule", () => {
    const errors = validateBoard({
      version: 1,
      columns: [
        { id: "backlog", title: "Backlog" },
        { title: "No id" },
        { id: "untitled" },
        { id: "hinted", title: "Hinted", hint: 5 },
        { id: "backlog", title: "Again" },
        { id: "ready", title: "Ready" },
      ],
      components: ["gates"],
      cards: [
        { column: "backlog", title: "No id", goal: "x" },
        { id: "a", column: "backlog", component: "gates", title: "A", goal: "a" },
        { id: "a", column: "backlog", title: "A again", goal: "a" },
        { id: "b", column: "archive", component: "nope", size: "XL", deps: ["ghost"], goal: "b", source: 3 },
        { id: "c", column: "ready", title: "C", goal: "", deps: "a" },
      ],
    });
    expect(errors).toEqual([
      "column at index 1: missing id",
      "column at index 2: missing title",
      "column at index 3: hint must be a string",
      'duplicate column "backlog"',
      "card at index 0: missing id",
      'duplicate id "a"',
      'card "b": unknown column "archive"; columns are backlog, untitled, hinted, ready',
      'card "b": unknown component "nope"; components are gates',
      'card "b": missing title',
      'card "b": size must be S, M, or L',
      'card "b": unknown dep "ghost"',
      'card "b": source must be a string',
      'card "c": missing goal',
      'card "c": deps must be an array of strings',
    ]);
  });
  it("says no components are defined when the list is empty", () => {
    const b = newBoard();
    b.cards.push({ id: "x", column: "ready", component: "gates", title: "X", goal: "x" });
    expect(validateBoard(b)).toEqual(['card "x": unknown component "gates"; no components are defined']);
  });
  it("never throws on hostile field values", () => {
    const hostile = [Symbol("bad"), { nested: true }, 10n, () => "fn"];
    const fields = ["column", "component", "id", "size", "source"];
    for (const value of hostile) {
      for (const field of fields) {
        const b = board();
        b.cards[2] = { ...b.cards[2], [field]: value };
        let errors;
        expect(() => (errors = validateBoard(b))).not.toThrow();
        expect(errors.length, `${field}=${typeof value}`).toBeGreaterThan(0);
      }
      const b = board();
      b.cards[2] = { ...b.cards[2], deps: [value] };
      let errors;
      expect(() => (errors = validateBoard(b))).not.toThrow();
      expect(errors.length, `deps entry=${typeof value}`).toBeGreaterThan(0);
    }
    const b = board();
    b.cards[2] = { ...b.cards[2], column: Symbol("bad") };
    expect(validateBoard(b)).toEqual(['card "first": unknown column "Symbol(bad)"; columns are backlog, ready, flow, done']);
  });
  it("reports a board it cannot inspect instead of throwing", () => {
    const inputs = [
      { get columns() { throw new Error("getter boom"); } },
      (() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; })(),
    ];
    for (const input of inputs) {
      let result;
      expect(() => { result = validateBoard(input); }).not.toThrow();
      expect(result).toHaveLength(1);
      expect(result[0].startsWith("board could not be inspected:")).toBe(true);
    }
  });

  it("returns a single error even when the thrown value cannot be inspected either", () => {
    const board = {
      get columns() {
        throw { get message() { throw new Error("message boom"); } };
      },
    };
    let result;
    expect(() => { result = validateBoard(board); }).not.toThrow();
    expect(result).toHaveLength(1);
    expect(result[0].startsWith("board could not be inspected")).toBe(true);
  });
});

describe("validateBoard tags", () => {
  it("accepts an empty card tags array and a board with no tags field falling back to DEFAULT_TAGS", () => {
    const b = board();
    b.cards[3] = { ...b.cards[3], tags: [] };
    expect(validateBoard(b)).toEqual([]);
    expect(boardTags(b)).toEqual(DEFAULT_TAGS);
  });
  it("returns board.tags when set", () => {
    const b = { ...board(), tags: ["bug", "custom"] };
    expect(boardTags(b)).toEqual(["bug", "custom"]);
  });
  it("rejects a card tag outside the vocabulary, naming it", () => {
    const b = board();
    b.cards[3] = { ...b.cards[3], tags: ["nope"] };
    expect(validateBoard(b)).toEqual(['card "second": unknown tag "nope"; tags are bug, feature, chore, docs, refactor, spike']);
  });
  it("rejects a duplicate card tag", () => {
    const b = board();
    b.cards[3] = { ...b.cards[3], tags: ["bug", "bug"] };
    expect(validateBoard(b)).toEqual(['card "second": duplicate tag "bug"']);
  });
  it("rejects a non-array card tags", () => {
    const b = board();
    b.cards[3] = { ...b.cards[3], tags: "bug" };
    expect(validateBoard(b)).toEqual(['card "second": tags must be an array of strings']);
  });
  it("rejects a non-array top-level tags", () => {
    const b = { ...board(), tags: "bug" };
    expect(validateBoard(b)).toEqual(["tags must be an array of strings when present"]);
  });
  it("rejects a duplicate top-level tag", () => {
    const b = { ...board(), tags: ["bug", "bug"] };
    expect(validateBoard(b)).toEqual(['duplicate tag "bug"']);
  });
  it("accepts a card tag in a board's own custom vocabulary, not in DEFAULT_TAGS", () => {
    const b = { ...board(), tags: ["custom"] };
    b.cards[3] = { ...b.cards[3], tags: ["custom"] };
    expect(validateBoard(b)).toEqual([]);
  });
});

describe("newBoard and addCard", () => {
  it("newBoard has the default columns, no components, the default tags right after components, no cards, and a date", () => {
    const b = newBoard({ date: "2026-09-04" });
    expect(b).toEqual({ version: 1, updated: "2026-09-04", columns: DEFAULT_COLUMNS, components: [], tags: DEFAULT_TAGS, cards: [] });
    expect(Object.keys(b)).toEqual(["version", "updated", "columns", "components", "tags", "cards"]);
    expect(b.columns).not.toBe(DEFAULT_COLUMNS);
    expect(b.columns.map((c) => c.id)).toEqual(["decide", "backlog", "ready", "flow", "done"]);
    expect(newBoard().updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("addCard appends with defaults or all fields, in key order, without mutating the input", () => {
    const b = board();
    const withDefaults = addCard(b, { id: "new", title: "New", goal: "a new card" }, { date: "2026-09-04" });
    expect(withDefaults.updated).toBe("2026-09-04");
    expect(withDefaults.cards.length).toBe(6);
    expect(b.cards.length).toBe(5);
    const card = withDefaults.cards[5];
    expect(Object.keys(card)).toEqual(["id", "column", "title", "deps", "goal"]);
    expect(card).toEqual({ id: "new", column: "backlog", title: "New", deps: [], goal: "a new card" });
    const full = addCard(b, { id: "full", title: "Full", goal: "all fields", component: "flow", size: "M", track: "hand", deps: ["base"], column: "ready" }).cards[5];
    expect(Object.keys(full)).toEqual(["id", "column", "component", "title", "size", "track", "deps", "goal"]);
    expect(full).toEqual({ id: "full", column: "ready", component: "flow", title: "Full", size: "M", track: "hand", deps: ["base"], goal: "all fields" });
    expect(() => addCard(b, { id: "n", title: "N", goal: "x", track: "robot" })).toThrow('- card "n": track must be flow or hand');
  });
  it("addCard writes tags after track and before deps, and omits the key when undefined", () => {
    const b = board();
    const tagged = addCard(b, { id: "tagged", title: "Tagged", goal: "x", track: "hand", tags: ["bug", "docs"] }).cards[5];
    expect(Object.keys(tagged)).toEqual(["id", "column", "title", "track", "tags", "deps", "goal"]);
    expect(tagged.tags).toEqual(["bug", "docs"]);
    const untagged = addCard(b, { id: "untagged", title: "Untagged", goal: "x" }).cards[5];
    expect(Object.keys(untagged)).not.toContain("tags");
  });
  it("addCard rejects duplicate ids, unknown columns, components, and deps", () => {
    const b = board();
    expect(() => addCard(b, { id: "first", title: "Dup", goal: "x" })).toThrow('cannot add card "first":\n- duplicate id "first"');
    expect(() => addCard(b, { id: "n", title: "N", goal: "x", column: "archive" })).toThrow('- card "n": unknown column "archive"; columns are backlog, ready, flow, done');
    expect(() => addCard(b, { id: "n", title: "N", goal: "x", component: "nope" })).toThrow('- card "n": unknown component "nope"; components are gates, flow');
    expect(() => addCard(b, { id: "n", title: "N", goal: "x", deps: ["ghost"] })).toThrow('- card "n": unknown dep "ghost"');
  });
});

describe("editCard (card board-edit)", () => {
  it("edits title/size/component/track/deps/source on a ready card, stamps the date, and does not mutate the input", () => {
    const b = board();
    const { board: next, warnings } = editCard(
      b,
      "second",
      { title: "New title", size: "L", component: "flow", track: "hand", deps: ["base"], source: "commit 2222222" },
      { date: "2026-09-12" },
    );
    expect(warnings).toEqual([]);
    expect(next.updated).toBe("2026-09-12");
    expect(findCard(next, "second")).toMatchObject({ title: "New title", size: "L", component: "flow", track: "hand", deps: ["base"], source: "commit 2222222" });
    expect(findCard(b, "second").title).toBe("Second");
    expect(findCard(b, "second").deps).toEqual([]);
  });
  it("keeps the card's key order and keeps an empty deps array as []", () => {
    const b = board();
    const before = findCard(b, "second");
    const after = findCard(editCard(b, "second", { deps: [] }).board, "second");
    expect(after.deps).toEqual([]);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });
  it("refuses to edit the id", () => {
    expect(() => editCard(board(), "second", { id: "renamed" })).toThrow(
      "cannot edit card \"second\": the id is not editable (deps, the plan's card field, commit messages, and docs/live-runs.md cite it)",
    );
  });
  it("refuses an unknown field", () => {
    expect(() => editCard(board(), "second", { column: "done" })).toThrow(
      'cannot edit card "second": unknown field "column"; editable fields are title, goal, size, component, track, deps, source, tags',
    );
  });
  it("refuses an empty fields object", () => {
    expect(() => editCard(board(), "second", {})).toThrow('cannot edit card "second": no field to change');
  });
  it("refuses to edit a done card without --force", () => {
    expect(() => editCard(board(), "base", { goal: "new goal" })).toThrow(
      'cannot edit card "base": a done card changes only with --force; it landed as commit 1111111',
    );
  });
  it("refuses a disallowed field on a done card even with --force", () => {
    expect(() => editCard(board(), "base", { title: "New title" }, { force: true })).toThrow(
      'cannot edit card "base": a done card accepts only --goal and --source, with --force',
    );
  });
  it("allows goal or source on a done card with --force and carries the warning", () => {
    const { board: next, warnings } = editCard(board(), "base", { goal: "updated goal" }, { force: true });
    expect(findCard(next, "base").goal).toBe("updated goal");
    expect(warnings).toEqual(['editing done card "base", landed as commit 1111111: docs/live-runs.md and the landing commit still describe the old text']);
  });
  it("says an unrecorded commit when a done card has no source", () => {
    const b = board();
    const i = b.cards.findIndex((c) => c.id === "base");
    b.cards[i] = { id: "base", column: "done", component: "gates", title: "Base", size: "S", goal: "done already" };
    expect(() => editCard(b, "base", { goal: "x" })).toThrow("it landed as an unrecorded commit");
  });
  it("refuses goal on a flow-column card without --force", () => {
    const b = board();
    b.cards.push({ id: "inflow", column: "flow", title: "In flow", goal: "in progress" });
    expect(() => editCard(b, "inflow", { goal: "new goal" })).toThrow(
      "cannot edit card \"inflow\": \"inflow\" is in flow / is named by .doug/plan.json: --goal and --deps need --force, since an approved plan's acceptance may no longer describe the card",
    );
  });
  it("refuses deps on a flow-column card without --force", () => {
    const b = board();
    b.cards.push({ id: "inflow", column: "flow", title: "In flow", goal: "in progress" });
    expect(() => editCard(b, "inflow", { deps: ["base"] })).toThrow("--goal and --deps need --force");
  });
  it("allows goal on a flow-column card with --force and carries the warning", () => {
    const b = board();
    b.cards.push({ id: "inflow", column: "flow", title: "In flow", goal: "in progress" });
    const { board: next, warnings } = editCard(b, "inflow", { goal: "new goal" }, { force: true });
    expect(findCard(next, "inflow").goal).toBe("new goal");
    expect(warnings).toEqual([
      "\"inflow\" is in flow / is named by .doug/plan.json: --goal and --deps need --force, since an approved plan's acceptance may no longer describe the card",
    ]);
  });
  it("allows other fields on a flow-column card without --force", () => {
    const b = board();
    b.cards.push({ id: "inflow", column: "flow", title: "In flow", goal: "in progress" });
    const { warnings } = editCard(b, "inflow", { title: "Renamed" });
    expect(warnings).toEqual([]);
  });
  it("refuses goal without --force when .doug/plan.json names the card by plan.card", () => {
    expect(() => editCard(board(), "second", { goal: "x" }, { plan: { card: "second", tasks: [] } })).toThrow("--goal and --deps need --force");
  });
  it("refuses deps without --force when the plan names the card in plan.cards", () => {
    expect(() => editCard(board(), "second", { deps: [] }, { plan: { cards: ["second"], tasks: [] } })).toThrow("--goal and --deps need --force");
  });
  it("refuses goal without --force when a task's card field names it", () => {
    expect(() => editCard(board(), "second", { goal: "x" }, { plan: { tasks: [{ id: "t1", card: "second" }] } })).toThrow("--goal and --deps need --force");
  });
  it("refuses validation errors with the add-shaped message", () => {
    expect(() => editCard(board(), "second", { size: "XL" })).toThrow('cannot edit card "second":\n- card "second": size must be S, M, or L');
    expect(() => editCard(board(), "second", { component: "nope" })).toThrow('unknown component "nope"');
    expect(() => editCard(board(), "second", { deps: ["ghost"] })).toThrow('unknown dep "ghost"');
    expect(() => editCard(board(), "second", { title: "" })).toThrow('missing title');
    expect(() => editCard(board(), "second", { goal: "" })).toThrow('missing goal');
    expect(() => editCard(board(), "second", { source: 5 })).toThrow('source must be a string');
  });
  it("sets tags, clears them with [], and does not ask --force for tags on an in-flow or plan-named card", () => {
    const b = board();
    const { board: tagged } = editCard(b, "second", { tags: ["bug", "docs"] });
    expect(findCard(tagged, "second").tags).toEqual(["bug", "docs"]);
    const { board: cleared } = editCard(tagged, "second", { tags: [] });
    expect(findCard(cleared, "second").tags).toEqual([]);
    const inflow = { ...b, cards: [...b.cards, { id: "inflow", column: "flow", title: "In flow", goal: "in progress" }] };
    const { warnings } = editCard(inflow, "inflow", { tags: ["bug"] });
    expect(warnings).toEqual([]);
    const { warnings: planWarnings } = editCard(b, "second", { tags: ["bug"] }, { plan: { card: "second", tasks: [] } });
    expect(planWarnings).toEqual([]);
  });
  it("refuses tags on a done card even with --force, same message as any other disallowed field", () => {
    expect(() => editCard(board(), "base", { tags: ["bug"] }, { force: true })).toThrow(
      'cannot edit card "base": a done card accepts only --goal and --source, with --force',
    );
  });
});

describe("nextReadyCard", () => {
  it("returns the first Ready card whose deps are Done and lists the skipped ones", () => {
    const { card, skipped } = nextReadyCard(board());
    expect(card.id).toBe("first");
    expect(skipped).toEqual([{ id: "blocked", waitingOn: ["later"] }]);
  });
  it("skips a hand-track card ahead of the runnable one and says so", () => {
    const b = board();
    b.cards.splice(1, 0, { id: "byhand", column: "ready", component: "flow", title: "By hand", size: "S", track: "hand", deps: [], goal: "harness work" });
    const { card, skipped } = nextReadyCard(b);
    expect(card.id).toBe("first");
    expect(skipped).toEqual([{ id: "byhand", hand: true }, { id: "blocked", waitingOn: ["later"] }]);
    // On the hand track the flow cards are the ones skipped, and deps still gate.
    b.cards.splice(1, 0, { id: "handblocked", column: "ready", title: "Hand blocked", track: "hand", deps: ["later"], goal: "waits" });
    const hand = nextReadyCard(b, { track: "hand" });
    expect(hand.card.id).toBe("byhand");
    expect(hand.skipped).toEqual([{ id: "handblocked", waitingOn: ["later"] }]);
    const noHand = nextReadyCard(board(), { track: "hand" });
    expect(noHand.card).toBeNull();
    expect(noHand.skipped).toEqual([{ id: "blocked", flow: true }, { id: "first", flow: true }, { id: "second", flow: true }]);
  });
  it("returns null when nothing is runnable", () => {
    const b = board();
    b.cards = b.cards.filter((c) => c.id !== "first" && c.id !== "second");
    expect(nextReadyCard(b)).toEqual({ card: null, skipped: [{ id: "blocked", waitingOn: ["later"] }] });
  });
  it("filters to cards carrying a tag, silently skipping the rest, and throws on an unknown tag", () => {
    const b = board();
    const i = b.cards.findIndex((c) => c.id === "second");
    b.cards[i] = { ...b.cards[i], tags: ["bug"] };
    const { card, skipped } = nextReadyCard(b, { tag: "bug" });
    expect(card.id).toBe("second");
    // "blocked" and "first" are tagless: filtered out silently, with no skip entry for either.
    expect(skipped).toEqual([]);
    expect(() => nextReadyCard(b, { tag: "nope" })).toThrow('unknown tag "nope"; tags are bug, feature, chore, docs, refactor, spike');
    expect(() => nextReadyCards(b, { batch: 2, tag: "nope" })).toThrow('unknown tag "nope"; tags are bug, feature, chore, docs, refactor, spike');
  });
});

describe("artifactUrl on load (card artifact-path-removal)", () => {
  it("T1: a record carrying artifactUrl (valid or not) loads with no error and no artifactUrl key, and saveBoard drops it", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ ...board(), artifactUrl: "https://claude.ai/code/artifact/abc" }));
    const loaded = loadBoard(dir);
    expect(loaded).not.toHaveProperty("artifactUrl");
    saveBoard(dir, loaded);
    expect(JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"))).not.toHaveProperty("artifactUrl");

    const dir2 = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(dir2, ".doug"), { recursive: true });
    writeFileSync(join(dir2, ".doug/board.json"), JSON.stringify({ ...board(), artifactUrl: "not a url" }));
    expect(() => loadBoard(dir2)).not.toThrow();
    expect(loadBoard(dir2)).not.toHaveProperty("artifactUrl");

    const dir3 = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(dir3, ".doug"), { recursive: true });
    writeFileSync(join(dir3, ".doug/board.json"), JSON.stringify({ ...board(), artifactUrl: "" }));
    const loaded3 = loadBoard(dir3);
    expect(loaded3).not.toHaveProperty("artifactUrl");
    saveBoard(dir3, loaded3);
    expect(JSON.parse(readFileSync(join(dir3, ".doug/board.json"), "utf8"))).not.toHaveProperty("artifactUrl");
  });
});

describe("board.mjs url removed (card artifact-path-removal)", () => {
  it("T2: `url` behaves as an unknown command once removed, matching another unknown command's exit code, and setArtifactUrl is not exported", async () => {
    const dir = project();
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const unknown = run(["totally-bogus-command", dir]);
    const url = run(["url", dir]);
    expect(unknown.status, unknown.stderr).toBeGreaterThan(0);
    expect(url.status, url.stderr).toBe(unknown.status);
    const lib = await import("../lib/board.mjs");
    expect(lib.setArtifactUrl).toBeUndefined();
  });
});

describe("moveCard", () => {
  it("moves a card, sets the source when given, stamps the date, and leaves the input untouched", () => {
    const b = board();
    const moved = moveCard(b, "first", "done", { source: "commit abc1234", date: "2026-09-04" });
    expect(findCard(moved, "first")).toMatchObject({ column: "done", source: "commit abc1234" });
    expect(moved.updated).toBe("2026-09-04");
    expect(findCard(b, "first").column).toBe("ready");
    expect(findCard(moveCard(b, "second", "flow"), "second")).toMatchObject({ column: "flow" });
    expect(findCard(moveCard(b, "second", "flow"), "second").source).toBeUndefined();
    // A move to Done appends the card so Done is chronological; any other move keeps its place.
    expect(moved.cards.map((c) => c.id)).toEqual(["base", "blocked", "second", "later", "first"]);
    expect(moveCard(b, "second", "flow").cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);
  });
  it("rejects unknown cards and columns", () => {
    expect(() => moveCard(board(), "nope", "done")).toThrow('no card "nope"');
    expect(() => moveCard(board(), "first", "archive")).toThrow('unknown column "archive"; columns are backlog, ready, flow, done');
  });
});

describe("removeCard", () => {
  it("throws findCard's own message for an unknown id", () => {
    expect(() => removeCard(board(), "nope")).toThrow('no card "nope" on the board');
  });
  it("refuses always when another card lists it in deps, --force included", () => {
    // "later" is depended on by "blocked".
    const message = 'cannot remove card "later": cards depend on it: blocked; remove the dep first (the record would not load)';
    expect(() => removeCard(board(), "later")).toThrow(message);
    expect(() => removeCard(board(), "later", { force: true })).toThrow(message);
  });
  it("refuses a done card without --force and removes it with --force, warning who cites it", () => {
    const b = board();
    b.cards = b.cards.filter((c) => c.id !== "first"); // first depends on base; drop it so base has no dependents
    expect(() => removeCard(b, "base")).toThrow(
      'cannot remove card "base": a done card is removed only with --force; it landed as commit 1111111',
    );
    const { board: next, removed, warnings } = removeCard(b, "base", { force: true, date: "2026-09-13" });
    expect(removed).toEqual(findCard(b, "base"));
    expect(next.updated).toBe("2026-09-13");
    expect(next.cards.some((c) => c.id === "base")).toBe(false);
    expect(warnings).toEqual(['removed done card "base", landed as commit 1111111: the run log and the landing commit still cite the id']);
  });
  it("says an unrecorded commit when a done card with no dependents has no source", () => {
    const b = board();
    b.cards = b.cards.filter((c) => c.id !== "first");
    const i = b.cards.findIndex((c) => c.id === "base");
    b.cards[i] = { id: "base", column: "done", component: "gates", title: "Base", size: "S", goal: "done already" };
    expect(() => removeCard(b, "base")).toThrow('it landed as an unrecorded commit');
    const { warnings } = removeCard(b, "base", { force: true });
    expect(warnings).toEqual(['removed done card "base", landed as an unrecorded commit: the run log and the landing commit still cite the id']);
  });
  it("refuses an in-flow card without --force and removes it with --force, warning the flow/plan sentence", () => {
    const b = board();
    b.cards.push({ id: "inflow", column: "flow", title: "In flow", goal: "in progress" });
    const message = 'cannot remove card "inflow": "inflow" is in flow / is named by .doug/plan.json: removing it needs --force, since an approved plan still names the card';
    expect(() => removeCard(b, "inflow")).toThrow(message);
    const { removed, warnings } = removeCard(b, "inflow", { force: true });
    expect(removed.id).toBe("inflow");
    expect(warnings).toEqual(['"inflow" is in flow / is named by .doug/plan.json: removing it needs --force, since an approved plan still names the card']);
  });
  it("refuses a card named by plan.card without --force and removes it with --force, warning the same sentence", () => {
    const b = board();
    const plan = { card: "second", tasks: [] };
    expect(() => removeCard(b, "second", { plan })).toThrow('is in flow / is named by .doug/plan.json: removing it needs --force');
    const { warnings } = removeCard(b, "second", { force: true, plan });
    expect(warnings).toEqual(['"second" is in flow / is named by .doug/plan.json: removing it needs --force, since an approved plan still names the card']);
  });
  it("refuses a card named by plan.cards without --force", () => {
    const plan = { cards: ["second"], tasks: [] };
    expect(() => removeCard(board(), "second", { plan })).toThrow('is in flow / is named by .doug/plan.json: removing it needs --force');
    expect(removeCard(board(), "second", { force: true, plan }).warnings.length).toBe(1);
  });
  it("refuses a card named by a task's card field without --force", () => {
    const plan = { tasks: [{ id: "t1", card: "second" }] };
    expect(() => removeCard(board(), "second", { plan })).toThrow('is in flow / is named by .doug/plan.json: removing it needs --force');
    expect(removeCard(board(), "second", { force: true, plan }).warnings.length).toBe(1);
  });
  it("returns the removed card, stamps updated from date, and does not mutate the input board", () => {
    const b = board();
    const before = JSON.parse(JSON.stringify(b.cards));
    const { board: next, removed } = removeCard(b, "second", { date: "2026-09-13" });
    expect(removed).toEqual(findCard(b, "second"));
    expect(next.updated).toBe("2026-09-13");
    expect(next.cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "later"]);
    expect(b.cards).toEqual(before);
  });
});

describe("no migration: a tagless card round-trips with no tags key", () => {
  it("stays tagless through addCard, editCard, moveCard, reorderCard, and removeCard", () => {
    let b = addCard(board(), { id: "plain", title: "Plain", goal: "no tags" });
    expect(findCard(b, "plain").tags).toBeUndefined();
    b = editCard(b, "plain", { title: "Renamed" }).board;
    expect(findCard(b, "plain").tags).toBeUndefined();
    b = moveCard(b, "plain", "ready");
    expect(findCard(b, "plain").tags).toBeUndefined();
    b = reorderCard(b, "plain", { index: 0 });
    expect(findCard(b, "plain").tags).toBeUndefined();
    const { removed } = removeCard(b, "plain");
    expect(removed.tags).toBeUndefined();
    expect(Object.keys(removed)).not.toContain("tags");
  });
});

describe("reorderCard", () => {
  it("moves a card to the top of its column with index 0", () => {
    const moved = reorderCard(board(), "second", { index: 0 });
    expect(moved.cards.map((c) => c.id)).toEqual(["base", "second", "blocked", "first", "later"]);
  });
  it("moves a card to the bottom of its column with an index past the count", () => {
    const moved = reorderCard(board(), "blocked", { index: 99 });
    expect(moved.cards.map((c) => c.id)).toEqual(["base", "first", "second", "blocked", "later"]);
  });
  it("places a card before another card in the same column", () => {
    const moved = reorderCard(board(), "second", { before: "first" });
    expect(moved.cards.map((c) => c.id)).toEqual(["base", "blocked", "second", "first", "later"]);
  });
  it("places a card after another card in the same column", () => {
    const moved = reorderCard(board(), "blocked", { after: "first" });
    expect(moved.cards.map((c) => c.id)).toEqual(["base", "first", "blocked", "second", "later"]);
  });
  it("stamps the date and leaves the input untouched", () => {
    const b = board();
    const moved = reorderCard(b, "second", { index: 0 }, { date: "2026-09-06" });
    expect(moved.updated).toBe("2026-09-06");
    expect(moved).not.toBe(b);
    expect(moved.cards).not.toBe(b.cards);
    expect(b.cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);
    expect(b).toEqual(board());
  });
  it("returns a new stamped board even when the placement leaves the order unchanged", () => {
    const b = board();
    // "second" is already last among ready cards (blocked, first, second); index 2 keeps it there.
    const moved = reorderCard(b, "second", { index: 2 }, { date: "2026-09-06" });
    expect(moved).not.toBe(b);
    expect(moved.cards).not.toBe(b.cards);
    expect(moved.updated).toBe("2026-09-06");
    expect(moved.cards.map((c) => c.id)).toEqual(b.cards.map((c) => c.id));
    expect(b.cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);
    const sameByAfter = reorderCard(b, "second", { after: "first" });
    expect(sameByAfter).not.toBe(b);
    expect(sameByAfter.cards).not.toBe(b.cards);
    expect(sameByAfter.cards.map((c) => c.id)).toEqual(b.cards.map((c) => c.id));
  });
  it("rejects an unknown card", () => {
    expect(() => reorderCard(board(), "nope", { index: 0 })).toThrow('no card "nope"');
  });
  it("rejects an unknown target", () => {
    expect(() => reorderCard(board(), "second", { before: "nope" })).toThrow('no card "nope"');
  });
  it("rejects a target that is the card itself", () => {
    expect(() => reorderCard(board(), "second", { before: "second" })).toThrow('cannot reorder "second" relative to itself');
  });
  it("rejects a target in another column", () => {
    expect(() => reorderCard(board(), "second", { before: "later" })).toThrow('cannot reorder "second" before "later": "later" is in backlog, not ready');
  });
  it("rejects a malformed placement", () => {
    expect(() => reorderCard(board(), "second", "index0")).toThrow("reorderCard needs exactly one of before, after, or index");
    expect(() => reorderCard(board(), "second", {})).toThrow("reorderCard needs exactly one of before, after, or index");
    expect(() => reorderCard(board(), "second", { before: "first", after: "blocked" })).toThrow("reorderCard needs exactly one of before, after, or index");
    expect(() => reorderCard(board(), "second", { index: -1 })).toThrow("index must be a non-negative integer");
    expect(() => reorderCard(board(), "second", { index: 1.5 })).toThrow("index must be a non-negative integer");
  });
});

describe("runEntry and appendRun", () => {
  const report = {
    plan: "First",
    integrationBranch: "doug/a-b",
    modelsSource: "CLAUDE.md",
    ok: true,
    levels: [
      {
        index: 0,
        tasks: [
          { id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, models: { implement: "sonnet / medium" } },
          { id: "b", implemented: false, blockedReason: "spec unclear", verified: false, reviewed: false, adversary: null, models: { implement: "inherit" } },
        ],
        integration: { ok: true },
        integrationModel: "inherit / high",
      },
    ],
  };
  it("renders measured numbers or says they are absent", () => {
    const md = runEntry({ card: { id: "first", title: "First" }, report, cost: 1.4, wallClock: "3 min", mergeCommit: "abc1234", record: ".doug/board.json", date: "2026-09-04" });
    expect(md).toContain("## 2026-09-04, first: First");
    expect(md).toContain("Ran through /doug-next on this repo from card `first` in `.doug/board.json`. Plan \"First\", integration branch `doug/a-b`, models from CLAUDE.md.");
    expect(md).toContain("| Outcome | green |");
    expect(md).toContain("| Cost | $1.40 |");
    expect(md).toContain("| Landed as | `abc1234` |");
    expect(md).toContain("| 0 | a | yes | yes | yes | pass | sonnet / medium |");
    expect(md).toContain("| 0 | b | blocked: spec unclear | no | no | skipped | inherit |");
    expect(md).toContain("| 0 | integration | ok | | | | inherit / high |");
    const bare = runEntry({ card: { id: "first", title: "First" }, report: { ...report, ok: false, stoppedAtLevel: 0 } });
    expect(bare).toContain("Ran through /doug-next on this repo from card `first`. Plan \"First\"");
    expect(bare).toContain("| Cost | not measured |");
    expect(bare).toContain("| Outcome | stopped at level 0 |");
    expect(bare).toContain("| Landed as | not landed |");
  });
  const reusedTask = {
    id: "a", implemented: true, reused: "doug/task-a", verified: true, reviewed: true,
    adversary: { ran: true, verdict: "pass", blocked: false },
    models: { implement: { model: "sonnet", effort: "medium" }, checkout: { model: "haiku", effort: "inherit" } },
  };
  const freshTask = {
    id: "b", implemented: true, reused: null, verified: true, reviewed: true,
    adversary: { ran: true, verdict: "pass", blocked: false },
    models: { implement: { model: "sonnet", effort: "medium" } },
  };
  const withTasks = (tasks) => ({ ...report, levels: [{ ...report.levels[0], tasks }] });
  it("names the reused branch and the checkout model for a reused task", () => {
    const md = runEntry({ card: { id: "first", title: "First" }, report: withTasks([reusedTask, freshTask]), date: "2026-09-05" });
    expect(md).toContain("| 0 | a | reused `doug/task-a` | yes | yes | pass | haiku (checkout) |");
    expect(md).toContain("| 0 | b | yes | yes | yes | pass | sonnet / medium |");
  });
  it("renders a reused task whose stage threw as blocked, not as reused (card thrown-reuse-reads-as-reused)", () => {
    const thrownReuse = {
      ...reusedTask,
      implemented: false,
      blockedReason: "task stage threw (agent error, unknown agent type, or user skip)",
    };
    const md = runEntry({ card: { id: "first", title: "First" }, report: withTasks([thrownReuse, freshTask]), date: "2026-09-05" });
    expect(md).toContain("| 0 | a | blocked: task stage threw (agent error, unknown agent type, or user skip) | yes | yes | pass | haiku (checkout) |");
    expect(md).not.toContain("reused `doug/task-a`");
  });
  it("renders a reused task whose checkout agent returned nothing as \"no\"/\"not implemented\", not as reused (review minor 1 on card thrown-reuse-reads-as-reused)", () => {
    const emptyCheckout = { ...reusedTask, implemented: false, blockedReason: null };
    const md = runEntry({ card: { id: "first", title: "First" }, report: withTasks([emptyCheckout, freshTask]), date: "2026-09-05" });
    expect(md).toContain("| 0 | a | no | yes | yes | pass | haiku (checkout) |");
    expect(md).not.toContain("reused `doug/task-a`");
    const summary = runSummary({ report: withTasks([emptyCheckout]) });
    expect(summary.split("\n")[1]).toBe("a: not implemented, 1 pass, verify yes, review yes, adversary pass");
  });
  it("shows the pass count when a task needed a fix", () => {
    const twice = [{ pass: 1 }, { pass: 2 }];
    const fresh = runEntry({ card: { id: "first", title: "First" }, report: withTasks([{ ...freshTask, id: "a", attempts: twice }]), date: "2026-09-05" });
    expect(fresh).toContain("| 0 | a | yes (2 passes) | yes | yes | pass | sonnet / medium |");
    const reused = runEntry({ card: { id: "first", title: "First" }, report: withTasks([{ ...reusedTask, attempts: twice }]), date: "2026-09-05" });
    expect(reused).toContain("| 0 | a | reused `doug/task-a` (2 passes) | yes | yes | pass | haiku (checkout) |");
    const once = runEntry({ card: { id: "first", title: "First" }, report: withTasks([{ ...freshTask, id: "a", attempts: [{ pass: 1 }] }]), date: "2026-09-05" });
    expect(once).toContain("| 0 | a | yes | yes | yes | pass | sonnet / medium |");
    const none = runEntry({ card: { id: "first", title: "First" }, report: withTasks([{ ...freshTask, id: "a" }]), date: "2026-09-05" });
    expect(none).toContain("| 0 | a | yes | yes | yes | pass | sonnet / medium |");
  });
  it("renders a run entry's note right after the measures table, like handEntry does (card workflow-rehearsal)", () => {
    const md = runEntry({ card: { id: "first", title: "First" }, report, cost: 1.4, wallClock: "3 min", mergeCommit: "abc1234", note: "Rehearsal flow on the ts-basic fixture: passed; stages gate (1 min), plan (2 min)", date: "2026-09-09" });
    expect(md).toContain("| Adversary precision | no blocks |\n\nRehearsal flow on the ts-basic fixture: passed; stages gate (1 min), plan (2 min)\n\n| Level | Task |");
    const bare = runEntry({ card: { id: "first", title: "First" }, report });
    expect(bare).not.toContain("Rehearsal");
  });
  it("--rehearsal <scenario> replaces the prose line and abbreviates the sha to 7 characters, so the entry reads as a rehearsal, not a landing (card rehearsal-first-live-findings #3)", () => {
    const md = runEntry({ card: { id: "first", title: "First" }, report, cost: 1.4, wallClock: "3 min", mergeCommit: "47fe70cca7eb3444ae8a382ee14018f3950bfe1c", record: ".doug/board.json", date: "2026-09-09", rehearsal: "flow" });
    expect(md).toContain("Rehearsal flow for card `first` on the ts-basic fixture (plugins/doug-flow/scripts/rehearse.mjs); the commit and gate below are the fixture's, not this repository's.");
    expect(md).not.toContain("Ran through /doug-next");
    expect(md).toContain("| Landed as | `47fe70c` |");
    expect(md).not.toContain("47fe70cca7eb3444ae8a382ee14018f3950bfe1c");
    // Without --rehearsal, the commit still renders in full.
    expect(runEntry({ card: { id: "first", title: "First" }, report, mergeCommit: "47fe70cca7eb3444ae8a382ee14018f3950bfe1c" })).toContain("| Landed as | `47fe70cca7eb3444ae8a382ee14018f3950bfe1c` |");
  });
  it("renders a hand-track entry with the commit, wall clock, gate, and note", () => {
    const md = handEntry({ card: { id: "core-next", title: "Core next" }, commit: "abc1234", wallClock: "25 min", gate: "typecheck 0; unit 380 passed", note: "The CLI parser needed a flag set.", record: ".doug/board.json", date: "2026-09-06" });
    expect(md).toContain("## 2026-09-06, core-next: Core next");
    expect(md).toContain("Built by hand through /core-next from card `core-next` in `.doug/board.json` (hand track, decision 0005); no workflow run.");
    expect(md).toContain("| Outcome | landed |");
    expect(md).toContain("| Commit | `abc1234` |");
    expect(md).toContain("| Wall clock | 25 min |");
    expect(md).toContain("| Gate | typecheck 0; unit 380 passed |");
    expect(md).toContain("\nThe CLI parser needed a flag set.\n");
    const bare = handEntry({ card: { id: "x", title: "X" }, date: "2026-09-06" });
    expect(bare).toContain("| Outcome | not landed |");
    expect(bare).toContain("| Commit | none |");
    expect(bare).toContain("| Wall clock | not measured |");
    expect(bare).toContain("| Gate | not recorded |");
    expect(bare.endsWith("| Gate | not recorded |\n\n")).toBe(true);
  });
  it("--rehearsal <scenario> replaces the prose line and abbreviates the sha (card rehearsal-first-live-findings #3)", () => {
    const md = handEntry({ card: { id: "fix-hours", title: "Fix hours" }, commit: "47fe70cca7eb3444ae8a382ee14018f3950bfe1c", wallClock: "3.3 min", gate: "unit 5 passed", record: ".doug/board.json", date: "2026-09-09", rehearsal: "hand" });
    expect(md).toContain("Rehearsal hand for card `fix-hours` on the ts-basic fixture (plugins/doug-flow/scripts/rehearse.mjs); the commit and gate below are the fixture's, not this repository's.");
    expect(md).not.toContain("Built by hand through /core-next");
    expect(md).toContain("| Commit | `47fe70c` |");
    expect(md).not.toContain("47fe70cca7eb3444ae8a382ee14018f3950bfe1c");
  });
  it("summarizes the two 2026-09-06 standard-agents reports and a green run in three lines", () => {
    const fixture = (name) => JSON.parse(readFileSync(join(here, "fixtures/reports", name), "utf8"));
    const run1 = runSummary({ report: fixture("standard-agents-run1.json"), wallClock: "30 min" }).split("\n");
    expect(run1.length).toBe(4);
    expect(run1[0]).toBe("Standard agents auto-created by project type: stopped at level 0; 1 task, 0 integrated; wall 30 min; cost not measured.");
    expect(run1[1]).toBe("agents-generator: implemented, 3 passes, verify yes, review yes, adversary pass");
    expect(run1[2]).toContain('Stopped: agents-generator: "open finding: F1; stopped: next attempt would exceed the task budget (agents 15 > 12)"');
    expect(run1[2]).toContain("Acceptance not met: After pnpm build, init --dry-run --no-color on the ts-pnpm fixture prints the fo... (agents-generator); grep -q");
    const run2 = runSummary({ report: fixture("standard-agents-run2.json"), wallClock: "18 min" }).split("\n");
    expect(run2[1]).toBe("agents-generator: reused doug/task-agents-generator, 3 passes, verify no, review no, adversary skipped");
    expect(run2[2]).toBe('Stopped: agents-generator: "a fixed finding reappeared: F1; stopped: fix pass 3 made no new commit on doug/task-agents-generator"');
    // A reused task whose stage threw carries implemented: false and a blockedReason; the summary must say
    // blocked, not reused, since a thrown stage never actually checked the branch out (card thrown-reuse-reads-as-reused).
    const thrown = {
      ...fixture("standard-agents-run2.json"),
      levels: fixture("standard-agents-run2.json").levels.map((l) => ({
        ...l,
        tasks: l.tasks.map((t) => ({ ...t, implemented: false, blockedReason: "task stage threw (agent error, unknown agent type, or user skip)" })),
      })),
    };
    const run3 = runSummary({ report: thrown, wallClock: "1 min" }).split("\n");
    expect(run3[1]).toBe("agents-generator: blocked: task stage threw (agent error, unknown agent type, or user skip), 3 passes, verify no, review no, adversary skipped");
    const green = runSummary({
      report: { plan: "P", ok: true, levels: [{ index: 0, integration: { ok: true }, tasks: [{ id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, attempts: [{ pass: 1 }], acceptance: [{ text: "it works", ok: true }] }] }] },
      cost: 1.5, wallClock: "4 min", mergeCommit: "abc1234",
    }).split("\n");
    expect(green[0]).toBe("P: green; 1 task, 1 integrated; wall 4 min; cost $1.50; landed as abc1234.");
    expect(green[1]).toBe("a: implemented, 1 pass, verify yes, review yes, adversary pass");
    expect(green[2]).toBe("Every stage and acceptance command passed.");
    expect(runSummary({ report: { plan: "E", ok: false, levels: [] } })).toBe("E: not green; 0 tasks, 0 integrated; wall not measured; cost not measured.\nno tasks\nEvery stage and acceptance command passed.\n");
  });
  it("names the human gate when a run is paused, in the summary and in the record", () => {
    // typed-gates d07f06f: a human gate writes paused { level, gate, next } with ok false and every stage passed,
    // which read as "not green" plus "Every stage and acceptance command passed." Say what actually happened.
    const done = { id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, attempts: [{ pass: 1 }], acceptance: [{ text: "it works", ok: true }], models: { implement: "sonnet / medium" } };
    const paused = { plan: "P", ok: false, integrationBranch: "doug/a-b-c", paused: { level: 0, gate: "human", next: ["b", "c"] }, levels: [{ index: 0, integration: { ok: true }, integrationModel: "inherit / high", tasks: [done] }] };
    const lines = runSummary({ report: paused, cost: 0.8, wallClock: "5 min" }).split("\n");
    expect(lines[0]).toBe("P: paused at the human gate after level 0; 1 task, 1 integrated; wall 5 min; cost $0.80.");
    expect(lines[1]).toBe("a: implemented, 1 pass, verify yes, review yes, adversary pass");
    expect(lines[2]).toBe("Paused at the human gate after level 0; next: b, c. Open it with plan.mjs gate open 0 and resume the run.");
    expect(lines.length).toBe(4);
    // A stop or an unmet acceptance on the same report still shows after the pause.
    const stopped = { ...paused, levels: [{ ...paused.levels[0], tasks: [{ ...done, stopReason: "budget" }] }] };
    expect(runSummary({ report: stopped }).split("\n")[2]).toBe('Paused at the human gate after level 0; next: b, c. Open it with plan.mjs gate open 0 and resume the run. | Stopped: a: "budget"');
    // stoppedAtLevel wins over paused: a run that stopped never reached the gate.
    expect(runSummary({ report: { ...paused, stoppedAtLevel: 0 } }).split("\n")[0]).toContain("P: stopped at level 0;");
    const md = runEntry({ card: { id: "first", title: "First" }, report: paused, cost: 0.8, wallClock: "5 min", record: ".doug/board.json", date: "2026-09-07" });
    expect(md).toContain("| Outcome | paused at the human gate after level 0; next: b, c |");
    expect(md).toContain("| Landed as | not landed |");
    expect(md).not.toContain("not green");
  });
  it("appends to docs/live-runs.md, creating it with a heading when absent", () => {
    const dir = project();
    const file = appendRun(dir, "## one\n\nbody\n");
    expect(readFileSync(file, "utf8")).toBe("# Live runs of doug-flow\n\n## one\n\nbody\n");
    appendRun(dir, "## two\n");
    expect(readFileSync(file, "utf8")).toBe("# Live runs of doug-flow\n\n## one\n\nbody\n\n## two\n");
  });
});

// Card run-report-codex-cost: the Codex adversary's cost is a separate figure from --cost (Claude's own cost),
// never added into it, and reaches docs/live-runs.md and the run summary as its own row/clause.
describe("Codex adversary cost on runEntry and runSummary (card run-report-codex-cost)", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
  const report = {
    plan: "First",
    integrationBranch: "doug/a-b",
    ok: true,
    levels: [
      { index: 0, tasks: [{ id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false } }], integration: { ok: true } },
    ],
  };
  it("B1: codexCost renders its own row right after the Cost row, and leaves the Cost row itself unchanged", () => {
    const md = runEntry({ card: { id: "first", title: "First" }, report, cost: 1.4, codexCost: 2.58, wallClock: "3 min", date: "2026-09-24" });
    expect(md).toContain("| Cost | $1.40 |\n| Codex adversary | $2.58, not included in Cost |\n| Wall clock | 3 min |");
  });
  it("B2: codexCost null (the default) shows \"not measured\", right after the Cost row", () => {
    const bare = runEntry({ card: { id: "first", title: "First" }, report, cost: 1.4, wallClock: "3 min", date: "2026-09-24" });
    expect(bare).toContain("| Cost | $1.40 |\n| Codex adversary | not measured |\n| Wall clock | 3 min |");
    const explicitNull = runEntry({ card: { id: "first", title: "First" }, report, cost: 1.4, codexCost: null, wallClock: "3 min", date: "2026-09-24" });
    expect(explicitNull).toContain("| Codex adversary | not measured |");
  });
  it("B3: runSummary's first line gets \"; Codex $X.XX\" right after the cost clause when codexCost is given, never folded into cost, and is absent otherwise", () => {
    const withCodex = runSummary({ report, cost: 1.4, codexCost: 2.58, wallClock: "3 min", mergeCommit: "abc1234" });
    expect(withCodex.split("\n")[0]).toBe("First: green; 1 task, 1 integrated; wall 3 min; cost $1.40; Codex $2.58; landed as abc1234.");
    const withoutCodex = runSummary({ report, cost: 1.4, wallClock: "3 min", mergeCommit: "abc1234" });
    expect(withoutCodex.split("\n")[0]).toBe("First: green; 1 task, 1 integrated; wall 3 min; cost $1.40; landed as abc1234.");
    expect(withoutCodex).not.toContain("Codex");
    const nullCodex = runSummary({ report, cost: 1.4, codexCost: null, wallClock: "3 min" });
    expect(nullCodex).not.toContain("Codex");
  });
  it("B4: board.mjs CLI record and summary accept --codex-cost, printing the row and the clause", () => {
    const dir = project();
    const reportFile = join(dir, "report.json");
    writeFileSync(reportFile, JSON.stringify(report));
    const rec = run(["record", "first", reportFile, dir, "--cost", "1.4", "--codex-cost", "2.58", "--wall", "3 min", "--commit", "abc1234"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    const log = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(log).toContain("| Codex adversary | $2.58, not included in Cost |");
    const sum = run(["summary", reportFile, "--cost", "1.4", "--codex-cost", "2.58", "--wall", "3 min", "--commit", "abc1234"], dir);
    expect(sum.status, sum.stderr).toBe(0);
    expect(sum.stdout.split("\n")[0]).toContain("; Codex $2.58; landed as abc1234.");
  });
  it("B5: in a batch, only the first card's entry shows the Codex adversary row", () => {
    const batchReport = {
      plan: "2 cards: alpha, beta",
      integrationBranch: "doug/a1-b1",
      ok: true,
      levels: [{ index: 0, tasks: [
        { id: "a1", card: "alpha", implemented: true, verified: true, reviewed: true },
        { id: "b1", card: "beta", implemented: true, verified: true, reviewed: true },
      ], integration: { ok: true } }],
    };
    const alpha = runEntry({ card: { id: "alpha", title: "Alpha" }, report: batchReport, batch: ["alpha", "beta"], cost: 1.2, codexCost: 2.58, sharedCost: 0.4, date: "2026-09-24" });
    // m-4 (card run-report-codex-cost, review round 1): the first batch card's row reads this exact string, the
    // same way the shared-integration-agents row reads "counted once for the batch here".
    expect(alpha).toContain("| Codex adversary | $2.58 for the whole batch, counted once here, not included in Cost |");
    const beta = runEntry({ card: { id: "beta", title: "Beta" }, report: batchReport, batch: ["alpha", "beta"], cost: 0.7, codexCost: 2.58, sharedCost: 0.4, date: "2026-09-24" });
    expect(beta).not.toContain("| Codex adversary |");
  });
});

describe("promoteResearchNote", () => {
  it("copies a card's research note into docs/research/, leaving the state copy in place", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nA fact, with its source.\n");
    const promoted = promoteResearchNote(dir, "first");
    expect(promoted).toBe("docs/research/first.md");
    expect(readFileSync(join(dir, "docs/research/first.md"), "utf8")).toBe("# First\n\nA fact, with its source.\n");
    // Copy, not move: the state file is still there.
    expect(existsSync(join(dir, ".doug/.state/research/first.md"))).toBe(true);
  });
  it("does nothing and returns null when the card has no note", () => {
    const dir = project();
    expect(promoteResearchNote(dir, "first")).toBeNull();
    expect(existsSync(join(dir, "docs/research"))).toBe(false);
  });
  it("does nothing and returns null on a second call once the docs copy is byte-identical: re-recording an unchanged note prints nothing (card rehearsal-first-live-findings #4)", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nv1.\n");
    expect(promoteResearchNote(dir, "first")).toBe("docs/research/first.md");
    expect(promoteResearchNote(dir, "first")).toBeNull();
    expect(promoteResearchNote(dir, "first")).toBeNull();
    expect(readFileSync(join(dir, "docs/research/first.md"), "utf8")).toBe("# First\n\nv1.\n");
  });
  it("overwrites a docs/research/<id>.md that already exists with different content: the state note is the source of truth on a re-landing", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    mkdirSync(join(dir, "docs/research"), { recursive: true });
    writeFileSync(join(dir, "docs/research/first.md"), "# First\n\nstale, from an earlier landing.\n");
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nv2, the current note.\n");
    expect(promoteResearchNote(dir, "first")).toBe("docs/research/first.md");
    expect(readFileSync(join(dir, "docs/research/first.md"), "utf8")).toBe("# First\n\nv2, the current note.\n");
  });
  it("refuses an id that would escape docs/research/, before touching the filesystem", () => {
    const dir = project();
    expect(() => promoteResearchNote(dir, "../../../outside")).toThrow('cannot promote the research note for "../../../outside"');
    expect(existsSync(join(dir, "docs/research"))).toBe(false);
    // A namespaced id is refused the same way, with a clear message, rather than failing later with a
    // confusing ENOENT because only docs/research (not docs/research/feat) was created.
    expect(() => promoteResearchNote(dir, "feat/thing")).toThrow('cannot promote the research note for "feat/thing"');
    expect(existsSync(join(dir, "docs/research"))).toBe(false);
  });
});

describe("recordLanding", () => {
  it("promotes the research note before appending, so both command layers can call one function (card cli-record-promotion-drift)", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nA decisive fact.\n");
    const result = recordLanding(dir, "first", "## first\n\nbody\n");
    expect(result.promoted).toBe("docs/research/first.md");
    expect(result.file).toBe(join(dir, "docs/live-runs.md"));
    expect(readFileSync(join(dir, "docs/research/first.md"), "utf8")).toBe("# First\n\nA decisive fact.\n");
    expect(readFileSync(result.file, "utf8")).toContain("## first\n\nbody\n");
  });
  it("appends and returns promoted: null when the card has no research note", () => {
    const dir = project();
    const result = recordLanding(dir, "first", "## first\n\nbody\n");
    expect(result.promoted).toBeNull();
    expect(existsSync(join(dir, "docs/research"))).toBe(false);
    expect(readFileSync(result.file, "utf8")).toContain("## first\n\nbody\n");
  });
  it("a promotion failure throws before appending, leaving docs/live-runs.md unwritten", () => {
    const dir = project();
    expect(() => recordLanding(dir, "../../outside", "## x\n\nbody\n")).toThrow('cannot promote the research note for "../../outside"');
    expect(existsSync(join(dir, "docs/live-runs.md"))).toBe(false);
  });
});

describe("board.mjs record promotes a card's research note", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
  it("hand-track record: promotes the note and prints one line about it", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nA decisive fact.\n");
    const rec = run(["record", "first", "--hand", dir, "--commit", "abc1234", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    expect(rec.stdout).toContain("Promoted the research note for first to docs/research/first.md.\n");
    expect(readFileSync(join(dir, "docs/research/first.md"), "utf8")).toBe("# First\n\nA decisive fact.\n");
    expect(existsSync(join(dir, ".doug/.state/research/first.md"))).toBe(true);
  });
  it("hand-track record: a second recording of a card whose note has not changed prints nothing about promotion (card rehearsal-first-live-findings #4)", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nA decisive fact.\n");
    const first = run(["record", "first", "--hand", dir, "--commit", "abc1234", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed"], dir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("Promoted");
    const second = run(["record", "first", "--hand", dir, "--commit", "def5678", "--wall", "6 min", "--gate", "typecheck 0; unit 2 passed"], dir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).not.toContain("Promoted");
  });
  it("hand-track record: says nothing about promotion when the card has no note", () => {
    const dir = project();
    const rec = run(["record", "first", "--hand", dir, "--commit", "abc1234", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    expect(rec.stdout).not.toContain("Promoted");
    expect(existsSync(join(dir, "docs/research"))).toBe(false);
  });
  it("flow-track record (a report file): also promotes the note", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nA decisive fact.\n");
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ plan: "First", integrationBranch: "doug/x", ok: true, levels: [] }));
    const rec = run(["record", "first", report, dir, "--wall", "2 min", "--commit", "abc1234"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    expect(rec.stdout).toContain("Promoted the research note for first to docs/research/first.md.\n");
    expect(readFileSync(join(dir, "docs/research/first.md"), "utf8")).toBe("# First\n\nA decisive fact.\n");
  });
  it("promotes before appending: a promotion failure exits 1 and leaves no live-runs entry, so a retry does not duplicate it", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/first.md"), "# First\n\nA decisive fact.\n");
    // docs/research as a plain file, not a directory, makes mkdirSync's recursive create fail with EEXIST -
    // a plain environmental trigger for the same failure a bad id or a permissions problem would cause.
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs/research"), "not a directory\n");
    const rec = run(["record", "first", "--hand", dir, "--commit", "abc1234", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed"], dir);
    expect(rec.status).toBe(1);
    expect(rec.stderr).toContain("EEXIST");
    expect(existsSync(join(dir, "docs/live-runs.md"))).toBe(false);
  });
});

describe("board.mjs CLI", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
  it("board.mjs summary and record on a paused report name the human gate", () => {
    const dir = project();
    const paused = { plan: "P", ok: false, integrationBranch: "doug/a", paused: { level: 0, gate: "human", next: ["b"] }, levels: [{ index: 0, integration: { ok: true }, tasks: [{ id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false } }] }] };
    const report = join(dir, "paused.json");
    writeFileSync(report, JSON.stringify(paused));
    const sum = run(["summary", report, "--wall", "5 min"], dir);
    expect(sum.status).toBe(0);
    expect(sum.stdout.split("\n")[0]).toBe("P: paused at the human gate after level 0; 1 task, 1 integrated; wall 5 min; cost not measured.");
    expect(sum.stdout.split("\n")[2]).toContain("next: b.");
    const rec = run(["record", "first", report, dir, "--wall", "5 min"], dir);
    expect(rec.status).toBe(0);
    expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).toContain("| Outcome | paused at the human gate after level 0; next: b |");
  });
  // Card report-save-wrapper, M2: the same paused report as above, saved as the Workflow tool's own output shape
  // ({ summary, agentCount, logs, result: <report> }) instead of bare, must give board.mjs summary and record the
  // same outcome (both call sites - record and summary - unwrap what they parsed).
  it("M2: board.mjs summary and record accept a wrapped report the same as bare (same paused report, wrapped)", () => {
    const dir = project();
    const paused = { plan: "P", ok: false, integrationBranch: "doug/a", paused: { level: 0, gate: "human", next: ["b"] }, levels: [{ index: 0, integration: { ok: true }, tasks: [{ id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false } }] }] };
    const wrapped = { summary: "x", agentCount: 1, logs: [], result: paused };
    const report = join(dir, "paused-wrapped.json");
    writeFileSync(report, JSON.stringify(wrapped));
    const sum = run(["summary", report, "--wall", "5 min"], dir);
    expect(sum.status).toBe(0);
    expect(sum.stdout.split("\n")[0]).toBe("P: paused at the human gate after level 0; 1 task, 1 integrated; wall 5 min; cost not measured.");
    expect(sum.stdout.split("\n")[2]).toContain("next: b.");
    const rec = run(["record", "first", report, dir, "--wall", "5 min"], dir);
    expect(rec.status).toBe(0);
    expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).toContain("| Outcome | paused at the human gate after level 0; next: b |");
  });
  it("board.mjs record <id> <report> --note renders the note through the run form's CLI (card workflow-rehearsal-review #3)", () => {
    const dir = project();
    const rec = run(["record", "second", join(here, "fixtures/reports/standard-agents-run1.json"), dir, "--note", "Rehearsal flow on the ts-basic fixture: passed"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).toContain("Rehearsal flow on the ts-basic fixture: passed");
  });
  it("next, card, move, and record", () => {
    const dir = project();
    const next = run(["next", dir], dir);
    expect(next.status).toBe(0);
    expect(JSON.parse(next.stdout).id).toBe("first");
    expect(next.stderr).toContain("skipping blocked: waiting on later");
    const byHand = project();
    const withHand = JSON.parse(readFileSync(join(byHand, ".doug/board.json"), "utf8"));
    withHand.cards.unshift({ id: "byhand", column: "ready", title: "By hand", track: "hand", deps: [], goal: "harness work" });
    writeFileSync(join(byHand, ".doug/board.json"), JSON.stringify(withHand));
    const skipHand = run(["next", byHand], byHand);
    expect(JSON.parse(skipHand.stdout).id).toBe("first");
    expect(skipHand.stderr).toContain("skipping byhand: hand track (built by hand with /core-next, not by doug-next)");
    const handNext = run(["next", byHand, "--track", "hand"], byHand);
    expect(handNext.status, handNext.stderr).toBe(0);
    expect(JSON.parse(handNext.stdout).id).toBe("byhand");
    expect(handNext.stderr).toBe("");
    expect(run(["next", byHand, "--track", "robot"], byHand).status).toBe(2);
    const noHand = run(["next", dir, "--track", "hand"], dir);
    expect(noHand.status).toBe(1);
    expect(noHand.stderr).toContain("skipping first: flow track (run it with /doug-next)");
    expect(noHand.stderr).toContain("No Ready hand-track card whose dependencies are Done.");
    const handRec = run(["record", "byhand", "--hand", byHand, "--commit", "abc1234", "--wall", "20 min", "--gate", "typecheck 0; unit 380 passed", "--note", "kept"], byHand);
    expect(handRec.status, handRec.stderr).toBe(0);
    expect(handRec.stdout).toContain("Appended a hand-track entry for byhand to");
    const handLog = readFileSync(join(byHand, "docs/live-runs.md"), "utf8");
    expect(handLog).toContain("byhand: By hand");
    expect(handLog).toContain("| Commit | `abc1234` |");
    expect(handLog).toContain("| Gate | typecheck 0; unit 380 passed |");
    expect(handLog).toContain("\nkept\n");
    expect(run(["record", "--hand"], byHand).status).toBe(2);
    const sum = run(["summary", join(here, "fixtures/reports/standard-agents-run2.json"), "--wall", "18 min"], dir);
    expect(sum.status, sum.stderr).toBe(0);
    expect(sum.stdout.split("\n").length).toBe(4);
    expect(sum.stdout).toContain("stopped at level 0; 1 task, 0 integrated; wall 18 min; cost not measured.");
    expect(run(["summary"], dir).status).toBe(2);
    expect(JSON.parse(run(["card", "second", dir], dir).stdout).title).toBe("Second");
    expect(run(["card", "nope", dir], dir).status).toBe(1);

    const mv = run(["move", "first", "done", dir, "--source", "commit abc1234"], dir);
    expect(mv.status, mv.stderr).toBe(0);
    expect(mv.stdout).toBe("Moved first to done in .doug/board.json.\n");
    expect(findCard(loadBoard(dir), "first")).toMatchObject({ column: "done", source: "commit abc1234" });
    expect(run(["move", "first", "archive", dir], dir).status).toBe(1);

    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ plan: "First", integrationBranch: "doug/x", ok: true, levels: [] }));
    const rec = run(["record", "first", report, dir, "--wall", "2 min", "--commit", "abc1234"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    const log = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(log).toContain("first: First");
    expect(log).toContain("| Wall clock | 2 min |");
    expect(log).toContain("| Cost | not measured |");
    expect(log).toContain("from card `first` in `.doug/board.json`");

    const fallbackDir = mkdtempSync(join(tmpdir(), "doug-board-"));
    mkdirSync(join(fallbackDir, "docs"), { recursive: true });
    writeFileSync(join(fallbackDir, "docs/board.json"), JSON.stringify(board()));
    const fallbackReport = join(fallbackDir, "report.json");
    writeFileSync(fallbackReport, JSON.stringify({ plan: "First", integrationBranch: "doug/x", ok: true, levels: [] }));
    const fallbackRec = run(["record", "first", fallbackReport, fallbackDir, "--commit", "abc1234"], fallbackDir);
    expect(fallbackRec.status, fallbackRec.stderr).toBe(0);
    const fallbackLog = readFileSync(join(fallbackDir, "docs/live-runs.md"), "utf8");
    expect(fallbackLog).toContain("from card `first` in `docs/board.json`");
  });
  it("reorder: before, after, top, and bottom, cross-column errors, and bad usage", () => {
    const dir = project();
    // Initial ready order: blocked, first, second (slots 1..3).
    const before = run(["reorder", "second", dir, "--before", "first"], dir);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toBe("Reordered second before first in .doug/board.json.\n");
    expect(loadBoard(dir).cards.map((c) => c.id)).toEqual(["base", "blocked", "second", "first", "later"]);

    const after = run(["reorder", "second", dir, "--after", "first"], dir);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe("Reordered second after first in .doug/board.json.\n");
    expect(loadBoard(dir).cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);

    const top = run(["reorder", "second", dir, "--top"], dir);
    expect(top.status, top.stderr).toBe(0);
    expect(top.stdout).toBe("Reordered second to the top of ready in .doug/board.json.\n");
    expect(loadBoard(dir).cards.map((c) => c.id)).toEqual(["base", "second", "blocked", "first", "later"]);

    const bottom = run(["reorder", "second", dir, "--bottom"], dir);
    expect(bottom.status, bottom.stderr).toBe(0);
    expect(bottom.stdout).toBe("Reordered second to the bottom of ready in .doug/board.json.\n");
    expect(loadBoard(dir).cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);
    // Other columns' cards stay where they are.
    expect(loadBoard(dir).cards.map((c) => c.column)).toEqual(["done", "ready", "ready", "ready", "backlog"]);

    const crossColumn = run(["reorder", "second", dir, "--before", "later"], dir);
    expect(crossColumn.status).toBe(1);
    expect(crossColumn.stderr).toContain('is in backlog, not ready');

    expect(run(["reorder", "second", dir, "--before", "first", "--after", "first"], dir).status).toBe(2);
    expect(run(["reorder", "second", dir], dir).status).toBe(2);
    expect(run(["reorder"], dir).status).toBe(2);

    // A missing value, or a value that is itself an option, is the same usage error, not a library error.
    const missing = run(["reorder", "second", "--before"], dir);
    expect(missing.status).toBe(2);
    expect(loadBoard(dir).cards.map((c) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);
    expect(run(["reorder", "second", dir, "--before", "--top"], dir).status).toBe(2);
    expect(run(["reorder", "second", dir, "--after"], dir).status).toBe(2);
    expect(run(["reorder", "second", dir, "--after", "--bottom"], dir).status).toBe(2);
  });
  it("exits 1 with a message when no card is runnable", () => {
    const b = board();
    b.cards = b.cards.filter((c) => c.column !== "ready");
    const dir = project(b);
    const r = run(["next", dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No Ready card");
  });
});

describe("board.mjs rejects an unknown flag per subcommand (card board-cli-unknown-flags)", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("U5: move <id> ready <dir> --bogus x exits 2, names --bogus and board.mjs move, and the record is unchanged", () => {
    const dir = project();
    const before = readFileSync(join(dir, ".doug/board.json"), "utf8");
    const r = run(["move", "later", "ready", dir, "--bogus", "x"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--bogus");
    expect(r.stderr).toContain("board.mjs move");
    // Beyond the "unknown option" line, move's own usage line is printed too.
    expect(r.stderr).toContain("board.mjs move <id> <column> [dir] [--source <text>]");
    expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);
    expect(findCard(loadBoard(dir), "later").column).toBe("backlog");
  });

  it("U6: record <id> --hand <dir> --artifact exits 2 and appends nothing to docs/live-runs.md", () => {
    const dir = project();
    const r = run(["record", "first", "--hand", dir, "--artifact"], dir);
    expect(r.status).toBe(2);
    expect(existsSync(join(dir, "docs/live-runs.md"))).toBe(false);
  });
});

describe("board.mjs edit", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("edits a card and reports the fields and record path", () => {
    const dir = project();
    const r = run(["edit", "second", dir, "--title", "Retitled", "--size", "L"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("Edited second (title, size) in .doug/board.json.\n");
    expect(findCard(loadBoard(dir), "second")).toMatchObject({ title: "Retitled", size: "L" });
  });

  it("reads the goal from --goal-file, trimming a trailing newline", () => {
    const dir = project();
    const goalFile = join(dir, "goal.txt");
    writeFileSync(goalFile, "a goal from a file\n");
    const r = run(["edit", "second", dir, "--goal-file", goalFile], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(findCard(loadBoard(dir), "second").goal).toBe("a goal from a file");
  });

  it("exits 2 when --goal and --goal-file are both given", () => {
    const dir = project();
    const r = run(["edit", "second", dir, "--goal", "x", "--goal-file", "y.txt"], dir);
    expect(r.status).toBe(2);
  });

  it("exits 2 with no field at all", () => {
    const dir = project();
    const r = run(["edit", "second", dir], dir);
    expect(r.status).toBe(2);
  });

  it("exits 1 with the library message for a refused edit", () => {
    const dir = project();
    const r = run(["edit", "second", dir, "--size", "XL"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot edit card "second":');
    expect(r.stderr).toContain("size must be S, M, or L");
  });

  it("prints the warning line on stderr with --force", () => {
    const dir = project();
    const r = run(["edit", "base", dir, "--goal", "updated goal", "--force"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('warning: editing done card "base", landed as commit 1111111');
  });
});

describe("board.mjs remove", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("exits 2 with no id", () => {
    expect(run(["remove"], project()).status).toBe(2);
  });

  it("removes a card, prints the confirmation line then the removed card as JSON, and saves the record", () => {
    const dir = project();
    const original = findCard(loadBoard(dir), "second");
    const r = run(["remove", "second", dir], dir);
    expect(r.status, r.stderr).toBe(0);
    const nl = r.stdout.indexOf("\n");
    expect(r.stdout.slice(0, nl + 1)).toBe("Removed second (ready) from .doug/board.json.\n");
    expect(JSON.parse(r.stdout.slice(nl + 1))).toEqual(original);
    expect(() => findCard(loadBoard(dir), "second")).toThrow('no card "second"');
  });

  it("refuses a card another card depends on, with and without --force", () => {
    const dir = project();
    const withoutForce = run(["remove", "later", dir], dir);
    expect(withoutForce.status).toBe(1);
    expect(withoutForce.stderr).toContain("cards depend on it: blocked");
    const withForce = run(["remove", "later", dir, "--force"], dir);
    expect(withForce.status).toBe(1);
    expect(withForce.stderr).toContain("cards depend on it: blocked");
  });

  it("refuses a done card without --force and removes it with --force, printing the warning", () => {
    const dir = project();
    // Drop "first" first: it depends on "base", which would otherwise trigger the dependent refusal.
    run(["remove", "first", dir, "--force"], dir);
    const withoutForce = run(["remove", "base", dir], dir);
    expect(withoutForce.status).toBe(1);
    expect(withoutForce.stderr).toContain("a done card is removed only with --force");
    const withForce = run(["remove", "base", dir, "--force"], dir);
    expect(withForce.status, withForce.stderr).toBe(0);
    expect(withForce.stderr).toContain('warning: removed done card "base", landed as commit 1111111:');
  });

  it("refuses a card named by .doug/plan.json without --force and removes it with --force, printing the warning", () => {
    const dir = project();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ card: "second", tasks: [] }));
    const withoutForce = run(["remove", "second", dir], dir);
    expect(withoutForce.status).toBe(1);
    expect(withoutForce.stderr).toContain("is in flow / is named by .doug/plan.json");
    const withForce = run(["remove", "second", dir, "--force"], dir);
    expect(withForce.status, withForce.stderr).toBe(0);
    expect(withForce.stderr).toContain('warning: "second" is in flow / is named by .doug/plan.json');
  });
});

describe("board.mjs edit --tag and next --tag", () => {
  const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("edit --tag sets tags and clearing with an empty value empties them", () => {
    const dir = project();
    const r = run(["edit", "second", dir, "--tag", "bug,docs"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("Edited second (tags) in .doug/board.json.\n");
    expect(findCard(loadBoard(dir), "second").tags).toEqual(["bug", "docs"]);
    const cleared = run(["edit", "second", dir, "--tag", ""], dir);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(findCard(loadBoard(dir), "second").tags).toEqual([]);
  });

  it("edit --tag with an unknown tag exits 1 with the library message", () => {
    const dir = project();
    const r = run(["edit", "second", dir, "--tag", "nope"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown tag "nope"');
  });

  it("next --tag prints the first Ready card carrying it and skips tagless cards with no skip line", () => {
    const dir = project();
    saveBoard(dir, editCard(loadBoard(dir), "second", { tags: ["bug"] }).board);
    const r = run(["next", dir, "--tag", "bug"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).id).toBe("second");
    expect(r.stderr).not.toContain("skipping");
  });

  it("next --tag with a comma exits 2", () => {
    const dir = project();
    const r = run(["next", dir, "--tag", "bug,docs"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--tag takes one tag here; got "bug,docs"');
  });

  it("next --tag with an unknown tag exits 1", () => {
    const dir = project();
    const r = run(["next", dir, "--tag", "nope"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown tag "nope"');
  });

  it("next --batch --tag returns only tagged cards", () => {
    const dir = project();
    saveBoard(dir, editCard(loadBoard(dir), "second", { tags: ["bug"] }).board);
    const r = run(["next", dir, "--batch", "2", "--tag", "bug"], dir);
    expect(r.status, r.stderr).toBe(0);
    const cards = JSON.parse(r.stdout);
    expect(cards.map((c) => c.id)).toEqual(["second"]);
  });
});

describe("runEntry model tier cell", () => {
  const rep = (models) => ({ plan: "P", integrationBranch: "doug/x", modelsSource: "CLAUDE.md", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" }, models }], integration: { ok: true } }] });
  const card = { id: "t", title: "T", column: "done" };
  it("renders the resolved model, effort, and tier instead of an object", () => {
    const out = runEntry({ card, report: rep({ implement: { model: "haiku", effort: "medium" }, tier: "cheap" }) });
    expect(out).toContain("| haiku / medium (tier cheap) |");
    expect(out).not.toContain("[object Object]");
    expect(runEntry({ card, report: rep({ implement: { model: "inherit", effort: "inherit" }, tier: null }) })).toContain("| inherit |");
    expect(runEntry({ card, report: rep(undefined) })).toContain("| inherit |");
    const withIntegration = rep({ implement: { model: "sonnet", effort: "medium" } });
    withIntegration.levels[0].integrationModel = { model: "sonnet", effort: "medium" };
    expect(runEntry({ card, report: withIntegration })).toContain("| integration | ok | | | | sonnet / medium |");
  });
});

describe("adversary precision", () => {
  const run1 = JSON.parse(readFileSync(join(here, "fixtures/reports/standard-agents-run1.json"), "utf8"));
  const run2 = JSON.parse(readFileSync(join(here, "fixtures/reports/standard-agents-run2.json"), "utf8"));
  // A report from before the ledger: no ids, the adversary blocked two passes, only the last pass's issues survive.
  const old = {
    plan: "Old", integrationBranch: "doug/old", ok: false, stoppedAtLevel: 0,
    levels: [{ index: 0, tasks: [
      { id: "loop", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "fail", blocked: true, summary: "probe found stale evidence", issues: [{ severity: "blocker", file: "w.js", description: "evidence=null keeps stale evidence" }] },
        attempts: [{ pass: 1, adversary: { ran: true, verdict: "fail", blocked: true, summary: "an unmet reporting requirement" } }, { pass: 2, adversary: { ran: true, verdict: "fail", blocked: true, summary: "probe found stale evidence" } }] },
      { id: "other", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, attempts: [{ pass: 1, adversary: { ran: true, verdict: "pass", blocked: false } }] },
    ], integration: null }],
  };
  const card = { id: "c", title: "C" };
  it("lists every block a report records, from the ledger or from the blocked passes", () => {
    expect(adversaryBlocks(run1)).toEqual([expect.objectContaining({ task: "agents-generator", id: "F1", pass: 1, status: "open" })]);
    expect(adversaryBlocks(run1)[0].description).toContain("unquoted YAML scalars");
    expect(adversaryBlocks(run2)).toEqual([expect.objectContaining({ task: "agents-generator", id: "F1", pass: 1 })]);
    expect(adversaryBlocks(old)).toEqual([
      { task: "loop", id: "pass-1", pass: 1, status: null, description: "an unmet reporting requirement" },
      { task: "loop", id: "pass-2", pass: 2, status: null, description: "evidence=null keeps stale evidence" },
    ]);
    expect(adversaryBlocks({ plan: "E", levels: [] })).toEqual([]);
    // The same id in two tasks is told apart by task/id.
    const twice = { levels: [{ index: 0, tasks: [{ id: "a", ledger: [{ id: "F1", stage: "adversary", severity: "blocker" }] }, { id: "b", ledger: [{ id: "F1", stage: "adversary", severity: "blocker" }, { id: "F2", stage: "verifier", severity: "blocker" }, { id: "F3", stage: "adversary", severity: "major" }] }] }] };
    expect(classifyBlocks(twice).map((b) => b.key)).toEqual(["a/F1", "b/F1"]);
  });
  it("does not count a non-blocking fail as a block, and renders it with its notes (card fix-loop-minor-verdict)", () => {
    const notes = {
      plan: "P", integrationBranch: "doug/x", ok: true,
      levels: [{ index: 0, integration: { ok: true }, tasks: [
        { id: "a", implemented: true, verified: true, reviewed: true, models: { implement: "sonnet / medium" },
          adversary: { ran: true, verdict: "fail", blocked: false, summary: "a text-format nit", issues: [{ severity: "minor", file: "src/a.ts", description: "prefer const" }] } },
      ] }],
    };
    expect(adversaryBlocks(notes)).toEqual([]);
    const md = runEntry({ card, report: notes, date: "2026-09-07" });
    expect(md).toContain("| 0 | a | yes | yes | yes | fail (1 note) | sonnet / medium |");
    expect(md).not.toContain("Adversary blocks, classified");
    const summary = runSummary({ report: notes }).split("\n")[1];
    expect(summary).toContain("adversary fail (1 note)");
    // A real block still reads as blocked, unchanged.
    const blocked = { ...notes, levels: [{ ...notes.levels[0], tasks: [{ ...notes.levels[0].tasks[0], adversary: { ran: true, verdict: "fail", blocked: true, summary: "off by one", issues: [{ severity: "blocker", file: "src/a.ts", description: "returns 1" }] } }] }] };
    expect(runEntry({ card, report: blocked, date: "2026-09-07" })).toContain("| 0 | a | yes | yes | yes | fail (blocked) | sonnet / medium |");
    expect(adversaryBlocks(blocked)).not.toEqual([]);
  });
  it("parses --adversary values and refuses bad classes, bad shapes, and unknown ids", () => {
    expect(parseAdversaryClasses(["F1=real: invalid YAML, the agent would not load", "F2=marginal,F3=false"])).toEqual([
      { id: "F1", class: "real", reason: "invalid YAML, the agent would not load" },
      { id: "F2", class: "marginal", reason: null },
      { id: "F3", class: "false", reason: null },
    ]);
    expect(parseAdversaryClasses("loop/pass-2=marginal: spec-true, no user impact")).toEqual([{ id: "loop/pass-2", class: "marginal", reason: "spec-true, no user impact" }]);
    expect(() => parseAdversaryClasses(["F1=bogus"])).toThrow('unknown adversary class "bogus" for F1; classes are real, marginal, false');
    expect(() => parseAdversaryClasses(["F1"])).toThrow("expected <id>=<real|marginal|false>[: <reason>]");
    expect(() => classifyBlocks(run1, [{ id: "F9", class: "real", reason: null }])).toThrow("no adversary block named F9 in this report; its blocks are: F1");
    expect(() => classifyBlocks({ levels: [] }, [{ id: "F1", class: "real", reason: null }])).toThrow("its blocks are: none");
  });
  it("renders the precision line and one classified line per block in the run entry", () => {
    const md = runEntry({ card, report: run1, adversary: parseAdversaryClasses(["F1=real: the generated architect.md had invalid YAML frontmatter"]), date: "2026-09-06" });
    expect(md).toContain("| Adversary precision | 1 real / 0 marginal / 0 false |");
    expect(md).toContain("Adversary blocks, classified (real: a defect a user would hit; marginal: true to the spec, no user impact; false: wrong):\n- F1 (agents-generator, pass 1): real. the generated architect.md had invalid YAML frontmatter\n");
    const unclassified = runEntry({ card, report: run2, date: "2026-09-06" });
    expect(unclassified).toContain("| Adversary precision | 0 real / 0 marginal / 0 false / 1 unclassified |");
    expect(unclassified).toContain("- F1 (agents-generator, pass 1): unclassified. The spec requires tests to assert paths/order for each case and the frontmatter keys. npm-bare never has its paths/order asserted, and the frontmatter test d...");
    const two = runEntry({ card, report: old, adversary: parseAdversaryClasses(["pass-1=marginal", "pass-2=false: the spec never said null overwrites"]), date: "2026-09-06" });
    expect(two).toContain("| Adversary precision | 0 real / 1 marginal / 1 false |");
    expect(two).toContain("- pass-1 (loop, pass 1): marginal. no reason given\n- pass-2 (loop, pass 2): false. the spec never said null overwrites\n");
    const clean = runEntry({ card, report: { plan: "P", integrationBranch: "doug/x", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" } }], integration: { ok: true } }] }, date: "2026-09-06" });
    expect(clean).toContain("| Adversary precision | no blocks |");
    expect(clean).not.toContain("Adversary blocks, classified");
    expect(() => runEntry({ card, report: run1, adversary: [{ id: "F2", class: "real", reason: null }] })).toThrow("no adversary block named F2");
  });
  it("board.mjs record takes --adversary once per block and refuses an id the report does not have", () => {
    const run = (args, dir) => spawnSync(process.execPath, [join(here, "..", "scripts", "board.mjs"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const dir = project();
    const report = join(here, "fixtures/reports/standard-agents-run1.json");
    const ok = run(["record", "first", report, dir, "--wall", "30 min", "--adversary", "F1=real: invalid YAML frontmatter, Claude Code would not load the agent"], dir);
    expect(ok.status, ok.stderr).toBe(0);
    const log = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(log).toContain("| Adversary precision | 1 real / 0 marginal / 0 false |");
    expect(log).toContain("- F1 (agents-generator, pass 1): real. invalid YAML frontmatter, Claude Code would not load the agent");
    const bad = run(["record", "first", report, dir, "--adversary", "F1=real", "--adversary", "F2=false: nope"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("no adversary block named F2 in this report; its blocks are: F1");
    expect(run(["record", "first", report, dir, "--adversary", "F1=maybe"], dir).stderr).toContain('unknown adversary class "maybe"');
  });
});

describe("runEntry pipeline shape", () => {
  const card = { id: "t", title: "T" };
  const rep = (extra) => ({ plan: "P", integrationBranch: "doug/x", ok: true, levels: [{ index: 0, tasks: [{ id: "s", implemented: true, verified: true, reviewed: true, adversary: null, shape: "S", size: "S" }, { id: "m", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" }, shape: "full", size: "M" }], integration: { ok: true }, ...extra }] });
  it("shows each task's shape and the level adversary in the integration row", () => {
    const md = runEntry({ card, report: rep({ levelAdversary: { ran: true, verdict: "pass", blocked: false, tasks: ["s"] } }) });
    expect(md).toContain("| Level | Task | Implemented | Verified | Reviewed | Adversary | Model tier | Shape |");
    expect(md).toContain("| 0 | s | yes | yes | yes | skipped | inherit | S |");
    expect(md).toContain("| 0 | m | yes | yes | yes | pass | inherit | full |");
    expect(md).toContain("| 0 | integration | ok | | | | inherit | level adversary on s: pass |");
    // A report from before sizes reads as full, with an empty cell for the level adversary.
    const old = runEntry({ card, report: { plan: "P", integrationBranch: "doug/x", ok: true, levels: [{ index: 0, tasks: [{ id: "a", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] } });
    expect(old).toContain("| 0 | a | yes | yes | yes | skipped | inherit | full |");
    expect(old).toContain("| 0 | integration | ok | | | | inherit |  |");
    const fed = runEntry({ card, report: rep({ levelAdversary: { ran: true, verdict: "fail", blocked: true, tasks: ["s"], fixed: [{ task: "s", ready: true, stopReason: null }], reintegration: { ok: true }, confirm: { ran: true, verdict: "pass", blocked: false } } }) });
    expect(fed).toContain("| level adversary on s: fail (blocked); fix pass on s; re-integration ok; confirm pass |");
    const stuck = runEntry({ card, report: rep({ levelAdversary: { ran: true, verdict: "fail", blocked: true, tasks: ["s"], unowned: ["lib/z.js"], fixed: [] } }) });
    expect(stuck).toContain("| level adversary on s: fail (blocked); no owner for lib/z.js |");
    const absent = runEntry({ card, report: rep({ levelAdversary: { ran: false, verdict: "inconclusive", blocked: true, tasks: ["s"], error: "codex-review not found" } }) });
    expect(absent).toContain("| level adversary on s: did not run: codex-review not found |");
    // A non-blocking fail (only major/minor issues) renders with its notes here too, not a bare "fail"
    // (card fix-loop-minor-verdict); the confirm cell uses the same rendering.
    const notes = runEntry({ card, report: rep({ levelAdversary: { ran: true, verdict: "fail", blocked: false, tasks: ["s"], issues: [{ severity: "minor", file: "src/a.ts", description: "prefer const" }], confirm: { ran: true, verdict: "fail", blocked: false, issues: [{ severity: "minor", file: "src/a.ts", description: "still there" }] } } }) });
    expect(notes).toContain("| level adversary on s: fail (1 note); confirm fail (1 note) |");
  });
});

// Several cards in one plan (card parallel-cards): batch selection, and a run entry per card of a batch showing only
// that card's tasks, with the shared integration agents' cost listed once.
import { filterReportForCard } from "../lib/board.mjs";

describe("nextReadyCards and next --batch", () => {
  it("returns the first n runnable Ready cards in board order with the skipped ones", () => {
    const { cards, skipped } = nextReadyCards(board(), { batch: 2 });
    expect(cards.map((c) => c.id)).toEqual(["first", "second"]);
    expect(skipped).toEqual([{ id: "blocked", waitingOn: ["later"] }]);
    expect(nextReadyCards(board(), { batch: 1 }).cards.map((c) => c.id)).toEqual(["first"]);
    expect(nextReadyCards(board(), { batch: 5 }).cards.map((c) => c.id)).toEqual(["first", "second"]);
    const b = board();
    b.cards.push({ id: "byhand", column: "ready", title: "By hand", track: "hand", deps: [], goal: "harness work" });
    const hand = nextReadyCards(b, { track: "hand", batch: 3 });
    expect(hand.cards.map((c) => c.id)).toEqual(["byhand"]);
    expect(hand.skipped.map((s) => s.id)).toEqual(["blocked", "first", "second"]);
    expect(nextReadyCards({ ...b, cards: b.cards.filter((c) => c.column !== "ready") }, { batch: 2 })).toEqual({ cards: [], skipped: [] });
    expect(() => nextReadyCards(board(), { batch: 0 })).toThrow("batch must be a positive integer");
  });
  it("with a tag, returns only tagged cards, silently skipping the rest", () => {
    const b = board();
    const i = b.cards.findIndex((c) => c.id === "second");
    b.cards[i] = { ...b.cards[i], tags: ["bug"] };
    const { cards, skipped } = nextReadyCards(b, { batch: 2, tag: "bug" });
    expect(cards.map((c) => c.id)).toEqual(["second"]);
    expect(skipped).toEqual([]);
  });
  it("board.mjs next --batch <n> prints a JSON array, in board order, and exits 1 when nothing is runnable", () => {
    const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const dir = project();
    const two = run(["next", dir, "--batch", "2"], dir);
    expect(two.status, two.stderr).toBe(0);
    expect(JSON.parse(two.stdout).map((c) => c.id)).toEqual(["first", "second"]);
    expect(two.stderr).toBe("skipping blocked: waiting on later\n");
    expect(JSON.parse(run(["next", dir, "--batch", "1"], dir).stdout).map((c) => c.id)).toEqual(["first"]);
    const bad = run(["next", dir, "--batch", "x"], dir);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--batch must be a positive integer");
    const b = board();
    b.cards = b.cards.filter((c) => c.column !== "ready");
    const none = run(["next", project(b), "--batch", "2"], dir);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("No Ready card whose dependencies are Done.");
  });
});

describe("run entries for a batch", () => {
  const batchReport = {
    plan: "2 cards: alpha, beta",
    integrationBranch: "doug/a1-b1-a2",
    ok: true,
    levels: [
      {
        index: 0,
        tasks: [
          { id: "a1", card: "alpha", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, models: { implement: "sonnet / medium" } },
          { id: "b1", card: "beta", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "fail", blocked: true, issues: [{ severity: "blocker", description: "b1 breaks" }] }, attempts: [{ pass: 1, adversary: { blocked: true, summary: "b1 breaks" } }, { pass: 2, adversary: { blocked: false } }], models: { implement: "sonnet / medium" } },
        ],
        integration: { ok: true },
        integrationModel: "sonnet / medium",
      },
      { index: 1, tasks: [{ id: "a2", card: "alpha", implemented: true, verified: true, reviewed: true, adversary: null, models: { implement: "sonnet / medium" } }], integration: { ok: true }, integrationModel: "sonnet / medium" },
    ],
  };
  it("filterReportForCard keeps only the card's tasks and the levels that hold one, and names the whole batch's cards in batchCards (card batch-summary-acceptance-noise, MINOR 1 regression)", () => {
    const beta = filterReportForCard(batchReport, "beta");
    expect(beta.levels.map((l) => [l.index, l.tasks.map((t) => t.id)])).toEqual([[0, ["b1"]]]);
    expect(beta.plan).toBe("2 cards: alpha, beta");
    // batchCards is the UNFILTERED report's card set, not what survives filtering to one card - the whole
    // point is to still name the card(s) filtering just made invisible to this task list.
    expect(beta.batchCards).toEqual(["alpha", "beta"]);
    expect(filterReportForCard(batchReport, "alpha").batchCards).toEqual(["alpha", "beta"]);
    // A report from before the workflow recorded `card` is filtered by the plan's task ids instead, and
    // carries no batchCards at all (absent, not an empty array): there is nothing to name.
    const old = { ...batchReport, levels: batchReport.levels.map((l) => ({ ...l, tasks: l.tasks.map(({ card, ...t }) => t) })) };
    const oldFiltered = filterReportForCard(old, "alpha", ["a1", "a2"]);
    expect(oldFiltered.levels.map((l) => l.tasks.map((t) => t.id))).toEqual([["a1"], ["a2"]]);
    expect(oldFiltered.batchCards).toBeUndefined();
    expect(filterReportForCard(old, "alpha").levels).toEqual([]);
  });
  it("renders one entry per card: its tasks only, its own cost, and the shared integration agents once", () => {
    const alpha = runEntry({ card: { id: "alpha", title: "Alpha" }, report: batchReport, batch: ["alpha", "beta"], cost: 1.2, sharedCost: 0.4, wallClock: "12 min", mergeCommit: "abc1234", record: ".doug/board.json", date: "2026-09-07" });
    expect(alpha).toContain("## 2026-09-07, alpha: Alpha");
    expect(alpha).toContain("Ran through /doug-next on this repo from card `alpha` in `.doug/board.json`, in one plan with beta (one approval, one run, one landing). Plan \"2 cards: alpha, beta\", integration branch `doug/a1-b1-a2`.");
    expect(alpha).toContain("| Cost | $1.20 for this card's tasks |");
    expect(alpha).toContain("| Shared integration agents | $0.40, counted once for the batch here |");
    expect(alpha).toContain("| Landed as | `abc1234` |");
    expect(alpha).toContain("| 0 | a1 | yes |");
    expect(alpha).toContain("| 1 | a2 | yes |");
    expect(alpha).not.toContain("| b1 |");
    expect(alpha).toContain("| Adversary precision | no blocks |");
    const beta = runEntry({ card: { id: "beta", title: "Beta" }, report: batchReport, batch: ["alpha", "beta"], cost: 0.7, sharedCost: 0.4, mergeCommit: "abc1234", adversary: [{ id: "pass-1", class: "real", reason: "it did" }], date: "2026-09-07" });
    expect(beta).toContain("in one plan with alpha (one approval, one run, one landing)");
    expect(beta).toContain("| Cost | $0.70 for this card's tasks |");
    expect(beta).toContain("| Shared integration agents | $0.40, counted once for the batch under alpha |");
    expect(beta).toContain("| 0 | b1 | yes (2 passes) |");
    expect(beta).not.toContain("| a1 |");
    expect(beta).not.toContain("| 1 | integration |");
    expect(beta).toContain("| Adversary precision | 1 real / 0 marginal / 0 false |");
    const unmeasured = runEntry({ card: { id: "beta", title: "Beta" }, report: batchReport, batch: ["alpha", "beta"], date: "2026-09-07" });
    expect(unmeasured).toContain("| Cost | not measured |");
    expect(unmeasured).toContain("| Shared integration agents | not measured |");
    // The third card's entry names the batch in board order without itself.
    const three = runEntry({ card: { id: "beta", title: "Beta" }, report: batchReport, batch: ["alpha", "beta", "gamma"], date: "2026-09-07" });
    expect(three).toContain("in one plan with alpha and gamma");
    // The per-card summary reads the same filtered report.
    expect(runSummary({ report: filterReportForCard(batchReport, "alpha"), wallClock: "12 min" })).toContain("2 tasks, 2 integrated");
  });
  it("board.mjs record reads the batch from the plan file and takes --shared-cost; summary takes --card", () => {
    const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const b = board();
    b.cards.push({ id: "alpha", column: "flow", title: "Alpha", deps: [], goal: "a" }, { id: "beta", column: "flow", title: "Beta", deps: [], goal: "b" });
    const dir = project(b);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ version: 1, title: "2 cards: alpha, beta", goal: "g", status: "done", cards: ["alpha", "beta"], acceptance: ["ok"], verify: [], tasks: [
      { id: "a1", card: "alpha", title: "A1", spec: "Do the thing for a1 with a test.", files: ["a.ts"] },
      { id: "b1", card: "beta", title: "B1", spec: "Do the thing for b1 with a test.", files: ["b.ts"] },
      { id: "a2", card: "alpha", title: "A2", spec: "Do the thing for a2 with a test.", files: ["a2.ts"], dependsOn: ["a1"] },
    ] }));
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ ...batchReport, levels: batchReport.levels.map((l) => ({ ...l, tasks: l.tasks.map(({ card, ...t }) => t) })) }));
    const rec = run(["record", "alpha", report, dir, "--cost", "1.2", "--shared-cost", "0.4", "--commit", "abc1234", "--wall", "12 min"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    const rec2 = run(["record", "beta", report, dir, "--cost", "0.7", "--shared-cost", "0.4", "--commit", "abc1234", "--wall", "12 min", "--adversary", "pass-1=real: it did"], dir);
    expect(rec2.status, rec2.stderr).toBe(0);
    const log = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(log).toContain("## ");
    expect(log).toContain("alpha: Alpha");
    expect(log).toContain("in one plan with beta");
    expect(log).toContain("| Shared integration agents | $0.40, counted once for the batch here |");
    expect(log).toContain("| Shared integration agents | $0.40, counted once for the batch under alpha |");
    expect(log.split("| 0 | b1 |").length).toBe(2);
    expect(log.split("| 0 | a1 |").length).toBe(2);
    const sum = run(["summary", report, "--card", "alpha"], dir);
    expect(sum.status, sum.stderr).toBe(0);
    expect(sum.stdout).toContain("2 cards: alpha, beta: green; 2 tasks, 2 integrated;");
    expect(sum.stdout).toContain("a1: implemented");
    expect(sum.stdout).not.toContain("b1:");
  });
});

// A task's verifier runs every plan acceptance command on its own branch, before the rest of a batch's cards or
// later levels exist, so most of a batch report's `ok: false` entries are noise, not real failures of that
// task's card (card batch-summary-acceptance-noise). The fixture: two cards, alpha (tasks a1, flags, a2) and
// beta (task b1); every task's acceptance array carries both cards' plan commands, its own tagged `[<card>] `
// and (except "flags", the dropped-prefix case) tagged for the other card too; a1 and b1 see the other card's
// command fail on their own branch (noise to drop); a2, at the final level, carries one real same-card failure
// that must still show; "flags" carries the same two commands with no tag at all (set aside, not counted).
describe("runSummary reads a batch report's acceptance without cross-card noise", () => {
  const fixture = () => JSON.parse(readFileSync(join(here, "fixtures/reports/batch-acceptance-noise.json"), "utf8"));

  it("per-task [card] tag under --card: filterReportForCard's batchCards still names the other card, so its tagged entries are confirmed cross-card noise and dropped outright, with no set-aside count for them; only the genuinely untagged/unknown ones are set aside, and a real same-card failure still shows (regression: a naive cardsInView built only from the filtered task list cannot see the other card at all, seen live on .doug/.state/last-report.json)", () => {
    const alpha = runSummary({ report: filterReportForCard(fixture(), "alpha") }).split("\n");
    expect(alpha[2]).toBe("Acceptance not met: [alpha] alpha real defect (a2) (acceptance read per task by [card] tag; 2 unattributed entries set aside, 1 failing: flags)");
    expect(alpha[2]).not.toContain("[beta]");
    expect(alpha[2]).not.toContain("(a1)"); // a1's [beta] entry is dropped, not set aside: a1 names no aside count

    const beta = runSummary({ report: filterReportForCard(fixture(), "beta") }).split("\n");
    // b1's only entries are its own [beta] (true) and alpha's known-but-foreign [alpha] (false, dropped): clean.
    expect(beta[2]).toBe("Every stage and acceptance command passed (acceptance read per task by [card] tag).");
  });

  it("reads the same way with no --card filter: with both cards already in view, a genuinely known other card's entries are confirmed cross-card noise and dropped outright; only the untagged task's entries are set aside and the real defect shown", () => {
    const whole = runSummary({ report: fixture() }).split("\n")[2];
    expect(whole).toBe("Acceptance not met: [alpha] alpha real defect (a2) (acceptance read per task by [card] tag; 2 unattributed entries set aside, 1 failing: flags)");
    expect(whole).not.toContain("[beta]");
  });

  it("reads the final integration level's acceptance instead, when the report carries it, regardless of per-task noise", () => {
    const withIntegration = (acceptance) => {
      const f = fixture();
      const last = f.levels[f.levels.length - 1];
      last.integration = { ...last.integration, acceptance };
      return f;
    };
    const green = runSummary({
      report: withIntegration([
        { text: "alpha thing works", command: "true", ok: true, exitCode: 0 },
        { text: "beta thing works", command: "true", ok: true, exitCode: 0 },
      ]),
    }).split("\n")[2];
    expect(green).toBe("Every stage and acceptance command passed (acceptance read from the final integration level).");

    const failing = runSummary({
      report: withIntegration([
        { text: "alpha thing works", command: "true", ok: true, exitCode: 0 },
        { text: "beta thing works", command: "true", ok: false, exitCode: 1 },
      ]),
    }).split("\n")[2];
    expect(failing).toBe("Acceptance not met: beta thing works (acceptance read from the final integration level)");
  });

  it("a report where no task carries `card` at all (from before batching existed) keeps today's behaviour untouched: no source suffix, every ok:false entry counts", () => {
    const noCard = {
      plan: "P",
      ok: true,
      levels: [
        {
          index: 0,
          integration: { ok: true },
          tasks: [{ id: "x", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, acceptance: [{ text: "plain command", ok: false }] }],
        },
      ],
    };
    expect(runSummary({ report: noCard }).split("\n")[2]).toBe("Acceptance not met: plain command (x)");
  });

  it("MAJOR: a card whose only task lost every acceptance tag never falls back to rule 3's everything-counts reading with the rest of the batch's noise in it; its untagged entries are set aside, not read as unmet, and the source still names them (review finding on card batch-summary-acceptance-noise)", () => {
    const droppedPrefix = {
      plan: "2 cards: alpha, beta",
      ok: true,
      levels: [
        {
          index: 0,
          integration: { ok: true },
          tasks: [
            {
              id: "cli-flags",
              card: "alpha",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: { ran: true, verdict: "pass", blocked: false },
              // Mirrors the real report (task cli-remove-and-tag-flags, 12/12 untagged): no entry here carries
              // a [card] prefix at all, including a genuinely failing one of alpha's own.
              acceptance: [
                { text: "alpha thing one", ok: true },
                { text: "alpha thing two", ok: false },
                { text: "beta thing one", ok: false },
              ],
            },
            { id: "b1", card: "beta", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, acceptance: [{ text: "[beta] beta thing works", ok: true }] },
          ],
        },
      ],
    };
    const alpha = runSummary({ report: filterReportForCard(droppedPrefix, "alpha") }).split("\n")[2];
    expect(alpha).not.toContain("Acceptance not met");
    expect(alpha).toBe("No attributed acceptance command failed (acceptance read per task by [card] tag; 3 unattributed entries set aside, 2 failing: cli-flags).");
  });

  it("MINOR 1: a tag naming no card in this task list (a typo, e.g. [gamma]) is set aside, not silently dropped, and neither is a tag on a task with no card of its own; a genuinely known other card's entry is still dropped outright", () => {
    const mixed = {
      plan: "P",
      ok: true,
      levels: [
        {
          index: 0,
          integration: { ok: true },
          tasks: [
            {
              id: "p",
              card: "alpha",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: { ran: true, verdict: "pass", blocked: false },
              acceptance: [
                { text: "[alpha] a ok", ok: true },
                { text: "[beta] known other card", ok: false }, // beta IS a card in this list: dropped, not shown
                { text: "[gamma] unknown card", ok: false }, // gamma names no task's card here: set aside
              ],
            },
            { id: "q", card: "beta", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, acceptance: [{ text: "[beta] b ok", ok: true }] },
            // A task carrying no `card` at all in an otherwise-batch report: a tag on it cannot be compared
            // against an own card that does not exist, so it is set aside rather than dropped or counted.
            { id: "r", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, acceptance: [{ text: "[alpha] tagged but no card owner", ok: false }] },
          ],
        },
      ],
    };
    const line = runSummary({ report: mixed }).split("\n")[2];
    expect(line).not.toContain("beta");
    expect(line).toBe("No attributed acceptance command failed (acceptance read per task by [card] tag; 2 unattributed entries set aside, 2 failing: p, r).");
  });

  it("the CLI: board.mjs summary <fixture> --card alpha prints the same third line as the library call", () => {
    const run = (args, dir) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const dir = project();
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(fixture()));
    const sum = run(["summary", reportPath, "--card", "alpha"], dir);
    expect(sum.status, sum.stderr).toBe(0);
    expect(sum.stdout).toBe(runSummary({ report: filterReportForCard(fixture(), "alpha") }));
  });
});

// Card board-card-class: an optional `class` field on a card, a closed enum, so a hand-track report's
// condition can be pinned before the brief (decision 2, docs/proposals/hand-track-report.md).
describe("card class (card board-card-class)", () => {
  const CLASSES = ["tests-only", "prose", "gate-script", "code", "docs", "eval", "decision"];
  const enumMessage = "class must be tests-only, prose, gate-script, code, docs, eval, or decision";

  it("validateBoard accepts each of the seven classes and no class at all (C1)", () => {
    const b = board();
    for (const cls of CLASSES) {
      const withClass = { ...b, cards: b.cards.map((c, i) => (i === 2 ? { ...c, class: cls } : c)) };
      expect(validateBoard(withClass), cls).toEqual([]);
    }
    expect(validateBoard(b)).toEqual([]);
  });

  it("validateBoard rejects a class outside the enum, naming the card (C1)", () => {
    const b = board();
    const bogus = { ...b, cards: b.cards.map((c, i) => (i === 2 ? { ...c, class: "bogus" } : c)) };
    expect(validateBoard(bogus)).toEqual([`card "first": ${enumMessage}`]);
    // The enum is case-sensitive: the exact values only.
    const wrongCase = { ...b, cards: b.cards.map((c, i) => (i === 2 ? { ...c, class: "Code" } : c)) };
    expect(validateBoard(wrongCase)).toEqual([`card "first": ${enumMessage}`]);
  });

  it("addCard refuses a class outside the enum and stores a valid one (C1, C2)", () => {
    const b = board();
    expect(() => addCard(b, { id: "n", title: "N", goal: "x", class: "bogus" })).toThrow(enumMessage);
    const withClass = addCard(b, { id: "n", title: "N", goal: "x", class: "code" }).cards[5];
    expect(withClass.class).toBe("code");
    const withoutClass = addCard(b, { id: "m", title: "M", goal: "x" }).cards[5];
    expect(withoutClass).not.toHaveProperty("class");
  });

  it("editCard refuses a class outside the enum and stores a valid one on a ready card (C1, C3)", () => {
    expect(() => editCard(board(), "second", { class: "bogus" })).toThrow(enumMessage);
    const { board: next } = editCard(board(), "second", { class: "prose" });
    expect(findCard(next, "second").class).toBe("prose");
  });

  it("editCard refuses class on a done card, with and without --force, same as any other disallowed field (C4)", () => {
    expect(() => editCard(board(), "base", { class: "code" })).toThrow(
      'cannot edit card "base": a done card accepts only --goal and --source, with --force',
    );
    expect(() => editCard(board(), "base", { class: "code" }, { force: true })).toThrow(
      'cannot edit card "base": a done card accepts only --goal and --source, with --force',
    );
  });

  it("board.mjs edit --class stores it and names class in the Edited line; a bad value exits 1 (C3)", () => {
    const dir = project();
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const r = run(["edit", "second", dir, "--class", "prose"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("Edited second (class) in .doug/board.json.\n");
    expect(findCard(loadBoard(dir), "second").class).toBe("prose");
    const bad = run(["edit", "second", dir, "--class", "bogus"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(enumMessage);
  });

  it("board.mjs edit --class on a done card is refused, with and without --force (C4)", () => {
    const dir = project();
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    const refused = run(["edit", "base", dir, "--class", "code"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("a done card accepts only --goal and --source, with --force");
    const forced = run(["edit", "base", dir, "--class", "code", "--force"]);
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain("a done card accepts only --goal and --source, with --force");
  });

  it("board.mjs card and next print the class when a card carries one (C5)", () => {
    const dir = project();
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    saveBoard(dir, editCard(loadBoard(dir), "first", { class: "code" }).board);
    const card = run(["card", "first", dir]);
    expect(card.status, card.stderr).toBe(0);
    expect(JSON.parse(card.stdout).class).toBe("code");
    const next = run(["next", dir]);
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout).class).toBe("code");
  });
});
