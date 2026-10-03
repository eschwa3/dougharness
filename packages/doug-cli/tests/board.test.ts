import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBoard } from "../src/board.js";

const here = dirname(fileURLToPath(import.meta.url));
// The doug-flow plugin's equivalent CLI, for the parity test (card cli-record-promotion-drift).
const pluginCli = join(here, "..", "..", "..", "plugins", "doug-flow", "scripts", "board.mjs");

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "doug-board-"));
}

async function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runBoard(argv, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr };
}

function readBoard(dir: string, rel = ".doug/board.json") {
  return JSON.parse(readFileSync(join(dir, rel), "utf8"));
}

const COLUMNS = [
  { id: "decide", title: "Decide" },
  { id: "backlog", title: "Backlog" },
  { id: "ready", title: "Ready" },
  { id: "flow", title: "In flow" },
  { id: "done", title: "Done" },
];

function writeBoard(dir: string, cards: object[], rel = ".doug/board.json", components: string[] = []) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), JSON.stringify({ version: 1, updated: "2026-01-01", columns: COLUMNS, components, cards }, null, 2) + "\n");
}

describe("doug board init", () => {
  it("writes a fresh .doug/board.json", async () => {
    const dir = fresh();
    const r = await run(["init", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Wrote ${join(dir, ".doug/board.json")} with 5 columns and no cards.\n`);
    const board = readBoard(dir);
    expect(board.version).toBe(1);
    expect(board.columns.map((c: { id: string }) => c.id)).toEqual(["decide", "backlog", "ready", "flow", "done"]);
    expect(board.components).toEqual([]);
    expect(board.cards).toEqual([]);
  });
  it("refuses to overwrite an existing board", async () => {
    const dir = fresh();
    expect((await run(["init", dir])).code).toBe(0);
    const r = await run(["init", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`a board already exists at ${join(dir, ".doug/board.json")}\n`);
  });
});

describe("doug board add", () => {
  it("adds a card with defaults", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const r = await run(["add", "one", "--title", "First", "--goal", "Do it", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Added one to backlog in .doug/board.json.\n");
    const board = readBoard(dir);
    expect(board.cards).toEqual([{ id: "one", column: "backlog", title: "First", deps: [], goal: "Do it" }]);
    expect(board.cards[0]).not.toHaveProperty("component");
    expect(board.cards[0]).not.toHaveProperty("size");
  });
  it("adds a card with every option", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const board = readBoard(dir);
    board.components = ["cli"];
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2));
    expect((await run(["add", "base", "--title", "Base", "--goal", "g", dir])).code).toBe(0);
    const r = await run(["add", "two", "--title", "Second", "--goal", "Go", "--component", "cli", "--size", "M", "--track", "hand", "--deps", "base, ,", "--column", "ready", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Added two to ready in .doug/board.json.\n");
    const cards = readBoard(dir).cards;
    expect(cards[1]).toEqual({ id: "two", column: "ready", component: "cli", title: "Second", size: "M", track: "hand", deps: ["base"], goal: "Go" });
  });
  it("is a usage error without --goal", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const r = await run(["add", "one", "--title", "First", dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("doug board add <id>");
  });
  it("splits --tag a,b into tags, trimmed and empties dropped", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const r = await run(["add", "one", "--title", "First", "--goal", "g", "--tag", "bug, docs,", dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(readBoard(dir).cards[0].tags).toEqual(["bug", "docs"]);
  });
  it("adds a card with --class and stores it; add without --class stores no class key (card board-card-class C2)", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const withClass = await run(["add", "one", "--title", "First", "--goal", "Do it", "--class", "code", dir]);
    expect(withClass.code, withClass.stderr).toBe(0);
    expect(readBoard(dir).cards[0].class).toBe("code");
    const withoutClass = await run(["add", "two", "--title", "Second", "--goal", "Do that", dir]);
    expect(withoutClass.code, withoutClass.stderr).toBe(0);
    expect(readBoard(dir).cards[1]).not.toHaveProperty("class");
  });
  it("rejects a --class outside the enum with the library message (card board-card-class C1)", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const r = await run(["add", "one", "--title", "First", "--goal", "g", "--class", "bogus", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("class must be tests-only, prose, gate-script, code, docs, eval, or decision");
  });
  it("rejects duplicates, unknown columns, components and deps with the library message", async () => {
    const dir = fresh();
    await run(["init", dir]);
    expect((await run(["add", "one", "--title", "First", "--goal", "g", dir])).code).toBe(0);
    let r = await run(["add", "one", "--title", "Again", "--goal", "g", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot add card "one":');
    expect(r.stderr).toContain('duplicate id "one"');
    r = await run(["add", "two", "--title", "T", "--goal", "g", "--column", "nope", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown column "nope"');
    r = await run(["add", "two", "--title", "T", "--goal", "g", "--component", "web", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown component "web"');
    r = await run(["add", "two", "--title", "T", "--goal", "g", "--deps", "missing", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown dep "missing"');
    expect(readBoard(dir).cards).toHaveLength(1);
  });
});

describe("doug board list", () => {
  const cards = [
    { id: "a", column: "ready", title: "Alpha", size: "S", deps: [], goal: "g" },
    { id: "b", column: "backlog", title: "Beta", deps: ["a"], goal: "g" },
    { id: "c", column: "ready", title: "Gamma", size: "L", track: "hand", deps: ["a", "b"], goal: "g" },
  ];
  it("prints every column in board order", async () => {
    const dir = fresh();
    writeBoard(dir, cards);
    const r = await run(["list", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      ["Decide (0)", "Backlog (1)", "  b  -  Beta  deps: a", "Ready (2)", "  a  S  Alpha", "  c  L  Gamma  [hand]  deps: a, b", "In flow (0)", "Done (0)"].join("\n") + "\n",
    );
  });
  it("filters by --column", async () => {
    const dir = fresh();
    writeBoard(dir, cards);
    const r = await run(["list", dir, "--column", "ready"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(["Ready (2)", "  a  S  Alpha", "  c  L  Gamma  [hand]  deps: a, b"].join("\n") + "\n");
  });
  it("rejects an unknown --column", async () => {
    const dir = fresh();
    writeBoard(dir, cards);
    const r = await run(["list", dir, "--column", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown column");
  });
  it("prints cards as JSON with --json", async () => {
    const dir = fresh();
    writeBoard(dir, cards);
    const all = await run(["list", dir, "--json"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toBe(JSON.stringify(cards, null, 2) + "\n");
    const ready = await run(["list", "--json", "--column", "ready", dir]);
    expect(JSON.parse(ready.stdout)).toEqual([cards[0], cards[2]]);
  });
  it("filters by --tag in text and --json output, combined with --column as an AND", async () => {
    const dir = fresh();
    const tagged = [
      { id: "a", column: "ready", title: "Alpha", size: "S", deps: [], goal: "g", tags: ["bug"] },
      { id: "b", column: "backlog", title: "Beta", deps: [], goal: "g", tags: ["bug", "docs"] },
      { id: "c", column: "ready", title: "Gamma", size: "L", deps: [], goal: "g", tags: ["docs"] },
    ];
    writeBoard(dir, tagged);
    const text = await run(["list", dir, "--tag", "bug"]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(["Decide (0)", "Backlog (1)", "  b  -  Beta", "Ready (1)", "  a  S  Alpha", "In flow (0)", "Done (0)"].join("\n") + "\n");
    const json = await run(["list", dir, "--tag", "bug", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual([tagged[0], tagged[1]]);
    const combined = await run(["list", dir, "--tag", "bug", "--column", "ready", "--json"]);
    expect(JSON.parse(combined.stdout)).toEqual([tagged[0]]);
  });
  it("refuses a comma in --tag with exit 2, and an unknown tag with exit 1", async () => {
    const dir = fresh();
    writeBoard(dir, cards);
    const comma = await run(["list", dir, "--tag", "a,b"]);
    expect(comma.code).toBe(2);
    expect(comma.stderr).toBe('--tag takes one tag here; got "a,b"\n');
    const unknown = await run(["list", dir, "--tag", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe('unknown tag "nope"; tags are bug, feature, chore, docs, refactor, spike\n');
  });
});

describe("doug board next", () => {
  it("picks the first Ready card whose deps are Done and reports blocked ones", async () => {
    const dir = fresh();
    writeBoard(dir, [
      { id: "d", column: "done", title: "Done", deps: [], goal: "g" },
      { id: "blocked", column: "ready", title: "Blocked", deps: ["later"], goal: "g" },
      { id: "byhand", column: "ready", title: "By hand", track: "hand", deps: [], goal: "g" },
      { id: "later", column: "backlog", title: "Later", deps: [], goal: "g" },
      { id: "go", column: "ready", title: "Go", deps: ["d"], goal: "g" },
    ]);
    const r = await run(["next", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("skipping blocked: waiting on later\nskipping byhand: hand track (a by-hand card; /doug-next byhand takes it)\n");
    expect(JSON.parse(r.stdout)).toEqual({ id: "go", column: "ready", title: "Go", deps: ["d"], goal: "g" });
  });
  it("--batch <n> prints the first n runnable Ready cards as an array and refuses a bad n", async () => {
    const dir = fresh();
    writeBoard(dir, [
      { id: "blocked", column: "ready", title: "Blocked", deps: ["later"], goal: "g" },
      { id: "a", column: "ready", title: "A", deps: [], goal: "g" },
      { id: "b", column: "ready", title: "B", deps: [], goal: "g" },
      { id: "c", column: "ready", title: "C", deps: [], goal: "g" },
      { id: "later", column: "backlog", title: "Later", deps: [], goal: "g" },
    ]);
    const r = await run(["next", dir, "--batch", "2"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("skipping blocked: waiting on later\n");
    expect(JSON.parse(r.stdout).map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
    const bad = await run(["next", dir, "--batch", "0"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe('--batch must be a positive integer, got "0"\n');
    writeBoard(dir, [{ id: "x", column: "backlog", title: "X", deps: [], goal: "g" }]);
    const none = await run(["next", dir, "--batch", "2"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toBe("No Ready card whose dependencies are Done.\n");
  });
  it("returns 1 when nothing is ready", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "backlog", title: "X", deps: [], goal: "g" }]);
    const r = await run(["next", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("No Ready card whose dependencies are Done.\n");
    expect(r.stdout).toBe("");
  });
  it("picks the first Ready hand-track card with --track hand and reports the flow cards", async () => {
    const dir = fresh();
    writeBoard(dir, [
      { id: "go", column: "ready", title: "Go", deps: [], goal: "g" },
      { id: "byhand", column: "ready", title: "By hand", track: "hand", deps: [], goal: "g" },
    ]);
    const r = await run(["next", dir, "--track", "hand"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("skipping go: flow track (run it with /doug-next)\n");
    expect(JSON.parse(r.stdout).id).toBe("byhand");
    const none = await run(["next", dir, "--track", "hand"].concat([]));
    expect(none.code).toBe(0);
    const bad = await run(["next", dir, "--track", "robot"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe('unknown track "robot"; tracks are flow, hand\n');
    writeBoard(dir, [{ id: "go", column: "ready", title: "Go", deps: [], goal: "g" }]);
    const empty = await run(["next", dir, "--track", "hand"]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toBe("skipping go: flow track (run it with /doug-next)\nNo Ready hand-track card whose dependencies are Done.\n");
  });
  it("--tag filters silently to Ready cards carrying it", async () => {
    const dir = fresh();
    writeBoard(dir, [
      { id: "notag", column: "ready", title: "No tag", deps: [], goal: "g" },
      { id: "tagged", column: "ready", title: "Tagged", deps: [], goal: "g", tags: ["bug"] },
    ]);
    const r = await run(["next", dir, "--tag", "bug"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).id).toBe("tagged");
  });
  it("refuses a comma in --tag with exit 2", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "ready", title: "X", deps: [], goal: "g" }]);
    const r = await run(["next", dir, "--tag", "a,b"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('--tag takes one tag here; got "a,b"\n');
  });
  it("refuses an unknown tag", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "ready", title: "X", deps: [], goal: "g" }]);
    const r = await run(["next", dir, "--tag", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('unknown tag "nope"; tags are bug, feature, chore, docs, refactor, spike\n');
  });
});

describe("doug board move", () => {
  it("changes the column and source and stamps updated", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "ready", title: "X", deps: [], goal: "g" }]);
    const r = await run(["move", "x", "done", dir, "--source", "landed as abc123"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Moved x to done in .doug/board.json.\n");
    const board = readBoard(dir);
    expect(board.cards[0].column).toBe("done");
    expect(board.cards[0].source).toBe("landed as abc123");
    expect(board.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(board.updated).not.toBe("2026-01-01");
  });
  it("rejects an unknown column", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "ready", title: "X", deps: [], goal: "g" }]);
    const r = await run(["move", "x", "nowhere", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown column "nowhere"');
    expect(readBoard(dir).cards[0].column).toBe("ready");
  });
});

describe("doug board edit", () => {
  function cardsFixture() {
    return [
      { id: "x", column: "ready", title: "X", size: "S", deps: [], goal: "g" },
      { id: "done1", column: "done", title: "Done one", deps: [], goal: "g", source: "commit abc1234" },
    ];
  }

  it("edits every field and reports the fields and record path", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture(), ".doug/board.json", ["cli"]);
    const r = await run([
      "edit",
      "x",
      dir,
      "--title",
      "Renamed",
      "--goal",
      "new goal",
      "--size",
      "M",
      "--component",
      "cli",
      "--track",
      "hand",
      "--deps",
      "done1",
      "--source",
      "commit 2222222",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("Edited x (title, goal, size, component, track, deps, source) in .doug/board.json.\n");
    const board = readBoard(dir);
    expect(board.cards[0]).toMatchObject({ title: "Renamed", goal: "new goal", size: "M", component: "cli", track: "hand", deps: ["done1"], source: "commit 2222222" });
  });

  it("reads the goal from --goal-file, trimming a trailing newline", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const goalFile = join(dir, "goal.txt");
    writeFileSync(goalFile, "goal text from file\n");
    const r = await run(["edit", "x", dir, "--goal-file", goalFile]);
    expect(r.code, r.stderr).toBe(0);
    expect(readBoard(dir).cards[0].goal).toBe("goal text from file");
  });

  it("splits --deps a,b into two deps, and --deps \"\" clears them", async () => {
    const dir = fresh();
    writeBoard(dir, [...cardsFixture(), { id: "extra", column: "backlog", title: "Extra", deps: [], goal: "g" }]);
    const r = await run(["edit", "x", dir, "--deps", "done1,extra"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readBoard(dir).cards[0].deps).toEqual(["done1", "extra"]);
    const cleared = await run(["edit", "x", dir, "--deps", ""]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(readBoard(dir).cards[0].deps).toEqual([]);
  });

  it("splits --tag a,b into tags, and --tag \"\" clears them", async () => {
    const dir = fresh();
    writeBoard(dir, [{ ...cardsFixture()[0], tags: ["chore"] }, cardsFixture()[1]]);
    const r = await run(["edit", "x", dir, "--tag", "bug,docs"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("Edited x (tags) in .doug/board.json.\n");
    expect(readBoard(dir).cards[0].tags).toEqual(["bug", "docs"]);
    const cleared = await run(["edit", "x", dir, "--tag", ""]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(readBoard(dir).cards[0].tags).toEqual([]);
  });

  it("is a usage error when --goal and --goal-file are both given", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const r = await run(["edit", "x", dir, "--goal", "a", "--goal-file", "b.txt"]);
    expect(r.code).toBe(2);
  });

  it("is a usage error with no field at all", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const r = await run(["edit", "x", dir]);
    expect(r.code).toBe(2);
  });

  it("refuses a done card without --force, then allows it with --force and the warning", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const refused = await run(["edit", "done1", dir, "--goal", "new goal"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("a done card changes only with --force; it landed as commit abc1234");
    const forced = await run(["edit", "done1", dir, "--goal", "new goal", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stderr).toContain('warning: editing done card "done1", landed as commit abc1234');
    expect(readBoard(dir).cards.find((c: { id: string }) => c.id === "done1").goal).toBe("new goal");
  });

  it("refuses --goal on a card .doug/plan.json names, without --force", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ card: "x", tasks: [] }));
    const r = await run(["edit", "x", dir, "--goal", "new goal"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"x" is in flow / is named by .doug/plan.json');
  });

  it("reports the library validation message for a bad --size", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const r = await run(["edit", "x", dir, "--size", "XL"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot edit card "x":');
    expect(r.stderr).toContain("size must be S, M, or L");
  });

  it("edits --class and names it in the Edited line; rejects a value outside the enum (card board-card-class C1, C3)", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture(), ".doug/board.json", ["cli"]);
    const r = await run(["edit", "x", dir, "--class", "prose"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("Edited x (class) in .doug/board.json.\n");
    expect(readBoard(dir).cards[0].class).toBe("prose");
    const bad = await run(["edit", "x", dir, "--class", "bogus"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("class must be tests-only, prose, gate-script, code, docs, eval, or decision");
  });

  it("refuses --class on a done card, with and without --force (card board-card-class C4)", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const refused = await run(["edit", "done1", dir, "--class", "code"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("a done card accepts only --goal and --source, with --force");
    const forced = await run(["edit", "done1", dir, "--class", "code", "--force"]);
    expect(forced.code).toBe(1);
    expect(forced.stderr).toContain("a done card accepts only --goal and --source, with --force");
  });
});

describe("doug board remove", () => {
  function cardsFixture() {
    return [
      { id: "x", column: "ready", title: "X", size: "S", deps: [], goal: "g" },
      { id: "dependent", column: "backlog", title: "Dependent", deps: ["x"], goal: "g" },
      { id: "done1", column: "done", title: "Done one", deps: [], goal: "g", source: "commit abc1234" },
      { id: "solo", column: "backlog", title: "Solo", deps: [], goal: "g" },
    ];
  }

  it("removes a card, printing the confirmation line then the removed card as JSON", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const r = await run(["remove", "solo", dir]);
    expect(r.code, r.stderr).toBe(0);
    const removed = { id: "solo", column: "backlog", title: "Solo", deps: [], goal: "g" };
    expect(r.stdout).toBe(`Removed solo (backlog) from .doug/board.json.\n${JSON.stringify(removed, null, 2)}\n`);
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(["x", "dependent", "done1"]);
  });

  it("refuses a card another card lists in deps, always, even with --force", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const r = await run(["remove", "x", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cards depend on it: dependent");
    const forced = await run(["remove", "x", dir, "--force"]);
    expect(forced.code).toBe(1);
    expect(forced.stderr).toContain("cards depend on it: dependent");
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(["x", "dependent", "done1", "solo"]);
  });

  it("refuses a done card without --force, then allows it with --force and a warning", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const refused = await run(["remove", "done1", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("a done card is removed only with --force; it landed as commit abc1234");
    const forced = await run(["remove", "done1", dir, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stderr).toContain('warning: removed done card "done1", landed as commit abc1234');
    expect(readBoard(dir).cards.some((c: { id: string }) => c.id === "done1")).toBe(false);
  });

  it("refuses a card in flow, or named by .doug/plan.json, without --force, and warns with it", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "inflow", column: "flow", title: "In flow", deps: [], goal: "g" }]);
    const refused = await run(["remove", "inflow", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('"inflow" is in flow / is named by .doug/plan.json');
    const forced = await run(["remove", "inflow", dir, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stderr).toContain('warning: "inflow" is in flow / is named by .doug/plan.json');

    writeBoard(dir, [{ id: "named", column: "backlog", title: "Named", deps: [], goal: "g" }]);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ card: "named", tasks: [] }));
    const planRefused = await run(["remove", "named", dir]);
    expect(planRefused.code).toBe(1);
    expect(planRefused.stderr).toContain('"named" is in flow / is named by .doug/plan.json');
    const planForced = await run(["remove", "named", dir, "--force"]);
    expect(planForced.code, planForced.stderr).toBe(0);
  });

  it("exits 1 with the library message for an unknown id", async () => {
    const dir = fresh();
    writeBoard(dir, cardsFixture());
    const r = await run(["remove", "nope", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no card "nope" on the board');
  });

  it("is a usage error with no id", async () => {
    const r = await run(["remove"]);
    expect(r.code).toBe(2);
  });
});

describe("doug board reorder", () => {
  const readyCards = [
    { id: "blocked", column: "ready", title: "Blocked", deps: ["later"], goal: "g" },
    { id: "first", column: "ready", title: "First", deps: [], goal: "g" },
    { id: "second", column: "ready", title: "Second", deps: [], goal: "g" },
  ];
  function cards() {
    return [{ id: "base", column: "done", title: "Base", deps: [], goal: "g" }, ...readyCards, { id: "later", column: "backlog", title: "Later", deps: [], goal: "g" }];
  }
  it("reorders before, after, top, and bottom, leaving other columns' cards in place", async () => {
    const dir = fresh();
    writeBoard(dir, cards());

    const before = await run(["reorder", "second", dir, "--before", "first"]);
    expect(before.code, before.stderr).toBe(0);
    expect(before.stdout).toBe("Reordered second before first in .doug/board.json.\n");
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(["base", "blocked", "second", "first", "later"]);

    const after = await run(["reorder", "second", dir, "--after", "first"]);
    expect(after.code, after.stderr).toBe(0);
    expect(after.stdout).toBe("Reordered second after first in .doug/board.json.\n");
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);

    const top = await run(["reorder", "second", dir, "--top"]);
    expect(top.code, top.stderr).toBe(0);
    expect(top.stdout).toBe("Reordered second to the top of ready in .doug/board.json.\n");
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(["base", "second", "blocked", "first", "later"]);

    const bottom = await run(["reorder", "second", dir, "--bottom"]);
    expect(bottom.code, bottom.stderr).toBe(0);
    expect(bottom.stdout).toBe("Reordered second to the bottom of ready in .doug/board.json.\n");
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(["base", "blocked", "first", "second", "later"]);
    expect(readBoard(dir).cards.map((c: { column: string }) => c.column)).toEqual(["done", "ready", "ready", "ready", "backlog"]);
  });
  it("exits 1 with the library message for a cross-column target", async () => {
    const dir = fresh();
    writeBoard(dir, cards());
    const r = await run(["reorder", "second", dir, "--before", "later"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is in backlog, not ready");
  });
  it("is a usage error with two options or none", async () => {
    const dir = fresh();
    writeBoard(dir, cards());
    expect((await run(["reorder", "second", dir, "--before", "first", "--after", "first"])).code).toBe(2);
    expect((await run(["reorder", "second", dir])).code).toBe(2);
    expect((await run(["reorder", dir])).code).toBe(2);
  });
  it("is a usage error, not a library error, for a missing or malformed --before/--after value", async () => {
    const dir = fresh();
    writeBoard(dir, cards());
    expect((await run(["reorder", "second", dir, "--before"])).code).toBe(2);
    expect((await run(["reorder", "second", dir, "--before", "--top"])).code).toBe(2);
    expect((await run(["reorder", "second", dir, "--after"])).code).toBe(2);
    expect((await run(["reorder", "second", dir, "--after", "--bottom"])).code).toBe(2);
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toEqual(cards().map((c) => c.id));
  });
  it("writes back docs/board.json when only it exists", async () => {
    const dir = fresh();
    writeBoard(dir, cards(), "docs/board.json");
    const r = await run(["reorder", "second", dir, "--top"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("Reordered second to the top of ready in docs/board.json.\n");
    expect(readBoard(dir, "docs/board.json").cards.map((c: { id: string }) => c.id)).toEqual(["base", "second", "blocked", "first", "later"]);
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(false);
  });
});

describe("doug board record", () => {
  it("appends a run entry to docs/live-runs.md", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
    const report = join(dir, "report.json");
    writeFileSync(
      report,
      JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] }),
    );
    const r = await run(["record", "x", report, dir, "--cost", "1.5", "--wall", "12m", "--commit", "abc123"]);
    expect(r.code).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Appended a run entry for x to ${file}.\n`);
    const md = readFileSync(file, "utf8");
    expect(md).toContain("x: X card");
    expect(md).toContain("| Wall clock | 12m |");
    expect(md).toContain("| Cost | $1.50 |");
    expect(md).toContain("| Landed as | `abc123` |");
    expect(md).toContain("| Adversary precision | no blocks |");
  });
  it("classifies every adversary block with --adversary, once per block, and refuses an unknown id", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
    const report = join(dir, "report.json");
    const task = { id: "t", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, attempts: [{ pass: 1, newFindings: ["F1", "F2"] }], ledger: [{ id: "F1", stage: "adversary", severity: "blocker", status: "fixed", description: "d1" }, { id: "F2", stage: "adversary", severity: "blocker", status: "fixed", description: "d2" }] };
    writeFileSync(report, JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [task], integration: { ok: true } }] }));
    const r = await run(["record", "x", report, dir, "--adversary", "F1=real: a user would hit it", "--adversary", "F2=false: the spec allows it"]);
    expect(r.code, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(md).toContain("| Adversary precision | 1 real / 0 marginal / 1 false |");
    expect(md).toContain("- F1 (t, pass 1): real. a user would hit it\n- F2 (t, pass 1): false. the spec allows it");
    const bad = await run(["record", "x", report, dir, "--adversary", "F3=real"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("no adversary block named F3 in this report; its blocks are: F1, F2");
  });
  it("T3 (card artifact-path-removal): `url` behaves as an unknown command once removed, matching another unknown command's exit code", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "ready", title: "X", deps: [], goal: "g" }]);
    const unknown = await run(["totally-bogus-command", dir]);
    const url = await run(["url", dir]);
    expect(unknown.code).toBeGreaterThan(0);
    expect(url.code, url.stderr).toBe(unknown.code);
  });
  it("prints the three-line summary of a report", async () => {
    const dir = fresh();
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ plan: "p", ok: true, levels: [{ index: 0, integration: { ok: true }, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true, adversary: null, attempts: [{ pass: 1 }, { pass: 2 }] }] }] }));
    const r = await run(["summary", report, "--wall", "12m", "--commit", "abc123", "--cost", "2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("p: green; 1 task, 1 integrated; wall 12m; cost $2.00; landed as abc123.\nt: implemented, 2 passes, verify yes, review yes, adversary skipped\nEvery stage and acceptance command passed.\n");
    expect((await run(["summary"])).code).toBe(2);
  });
  it("appends a hand-track entry with --hand and no report", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "h", column: "done", title: "Hand card", track: "hand", deps: [], goal: "g" }]);
    const r = await run(["record", "h", "--hand", dir, "--commit", "abc123", "--wall", "20 min", "--gate", "typecheck 0; unit 380 passed", "--note", "one line"]);
    expect(r.code).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Appended a hand-track entry for h to ${file}.\n`);
    const md = readFileSync(file, "utf8");
    expect(md).toContain("h: Hand card");
    expect(md).toContain("Built by hand through doug-hand from card `h` in `.doug/board.json` (hand track: a gated by-hand change); no workflow run.");
    expect(md).not.toContain("/core-next");
    expect(md).not.toContain("decision 0005");
    expect(md).toContain("| Commit | `abc123` |");
    expect(md).toContain("| Gate | typecheck 0; unit 380 passed |");
    expect(md).toContain("\none line\n");
    expect((await run(["record", "--hand"])).code).toBe(2);
  });
  it("--hand promotes a card's research note and prints the Promoted line before the Appended line (card cli-record-promotion-drift)", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "h", column: "done", title: "Hand card", track: "hand", deps: [], goal: "g" }]);
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/h.md"), "# H\n\nA decisive fact.\n");
    const r = await run(["record", "h", "--hand", dir, "--commit", "abc123", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed"]);
    expect(r.code, r.stderr).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Promoted the research note for h to docs/research/h.md.\nAppended a hand-track entry for h to ${file}.\n`);
    expect(readFileSync(join(dir, "docs/research/h.md"), "utf8")).toBe("# H\n\nA decisive fact.\n");
    expect(existsSync(join(dir, ".doug/.state/research/h.md"))).toBe(true);
  });
  it("the run form promotes a card's research note and prints the Promoted line before the Appended line", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/x.md"), "# X\n\nA decisive fact.\n");
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [] }));
    const r = await run(["record", "x", report, dir, "--wall", "2 min", "--commit", "abc123"]);
    expect(r.code, r.stderr).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Promoted the research note for x to docs/research/x.md.\nAppended a run entry for x to ${file}.\n`);
    expect(readFileSync(join(dir, "docs/research/x.md"), "utf8")).toBe("# X\n\nA decisive fact.\n");
  });
});

describe("doug board record and board.mjs record agree on the promotion step (card cli-record-promotion-drift)", () => {
  const runPlugin = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [pluginCli, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("hand-track record: the same args against identical fixtures append identical text and promote identical content", async () => {
    const dirA = fresh(); // driven by the plugin script
    const dirB = fresh(); // driven by the CLI, in-process
    for (const dir of [dirA, dirB]) {
      writeBoard(dir, [{ id: "h", column: "done", title: "Hand card", track: "hand", deps: [], goal: "g" }]);
      mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/research/h.md"), "# H\n\nA decisive, shared fact.\n");
    }
    const args = ["record", "h", "--hand", "--commit", "abc123", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed", "--note", "kept"];
    const plugin = runPlugin([...args, dirA], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run([...args, dirB]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(readFileSync(join(dirA, "docs/live-runs.md"), "utf8")).toBe(readFileSync(join(dirB, "docs/live-runs.md"), "utf8"));
    expect(readFileSync(join(dirA, "docs/research/h.md"), "utf8")).toBe(readFileSync(join(dirB, "docs/research/h.md"), "utf8"));
  });

  it("run-form record: the same args (shared flags only - the CLI's run form takes no --note or --rehearsal) append identical text and promote identical content", async () => {
    const dirA = fresh();
    const dirB = fresh();
    for (const dir of [dirA, dirB]) {
      writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
      mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/research/x.md"), "# X\n\nA decisive, shared fact.\n");
      writeFileSync(join(dir, "report.json"), JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] }));
    }
    const flags = ["--cost", "1.5", "--wall", "12m", "--commit", "abc123"];
    const plugin = runPlugin(["record", "x", join(dirA, "report.json"), dirA, ...flags], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["record", "x", join(dirB, "report.json"), dirB, ...flags]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(readFileSync(join(dirA, "docs/live-runs.md"), "utf8")).toBe(readFileSync(join(dirB, "docs/live-runs.md"), "utf8"));
    expect(readFileSync(join(dirA, "docs/research/x.md"), "utf8")).toBe(readFileSync(join(dirB, "docs/research/x.md"), "utf8"));
  });

  it('record on a Workflow-tool-wrapped report.json matches the plugin CLI, not the silent-wrong "undefined: not green" entry (card report-unwrap-cli-and-evals, M1)', async () => {
    const dirA = fresh(); // driven by the plugin script
    const dirB = fresh(); // driven by the CLI, in-process
    const innerReport = { plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] };
    const wrapped = { summary: "did it", agentCount: 2, logs: [], result: innerReport };
    for (const dir of [dirA, dirB]) {
      writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
      writeFileSync(join(dir, "report.json"), JSON.stringify(wrapped));
    }
    const flags = ["--cost", "1.5", "--wall", "12m", "--commit", "abc123"];
    const plugin = runPlugin(["record", "x", join(dirA, "report.json"), dirA, ...flags], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["record", "x", join(dirB, "report.json"), dirB, ...flags]);
    expect(cli.code, cli.stderr).toBe(0);
    const cliMd = readFileSync(join(dirB, "docs/live-runs.md"), "utf8");
    expect(cliMd).not.toContain("undefined: not green");
    expect(cliMd).toBe(readFileSync(join(dirA, "docs/live-runs.md"), "utf8"));
  });

  it('summary on a Workflow-tool-wrapped report.json matches the plugin CLI, not the silent-wrong entry (card report-unwrap-cli-and-evals, M2)', async () => {
    const dir = fresh();
    const innerReport = { plan: "p", ok: true, levels: [{ index: 0, integration: { ok: true }, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true, adversary: null, attempts: [{ pass: 1 }] }] }] };
    const wrapped = { summary: "did it", agentCount: 2, logs: [], result: innerReport };
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify(wrapped));
    const flags = ["--wall", "12m", "--commit", "abc123", "--cost", "2"];
    const plugin = runPlugin(["summary", report, ...flags], dir);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["summary", report, ...flags]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).not.toContain("undefined: not green");
    expect(cli.stdout).toBe(plugin.stdout);
  });

  it('summary and record print a stopped task\'s class and match the plugin CLI byte for byte (card flow-stop-class)', async () => {
    const stopped = { plan: "p", integrationBranch: "doug/p", ok: false, stoppedAtLevel: 0, levels: [{ index: 0, integration: { ok: true }, tasks: [{ id: "a", implemented: true, verified: false, reviewed: false, adversary: null, attempts: [{ pass: 1 }], stopReason: "over budget", stopClass: "budget" }] }] };
    const dirA = fresh(); // driven by the plugin script
    const dirB = fresh(); // driven by the CLI, in-process
    for (const dir of [dirA, dirB]) {
      writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
      writeFileSync(join(dir, "report.json"), JSON.stringify(stopped));
    }
    const flags = ["--wall", "12m", "--commit", "abc123", "--cost", "2"];
    const plugin = runPlugin(["summary", join(dirA, "report.json"), ...flags], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["summary", join(dirB, "report.json"), ...flags]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('Stopped: a [budget]: "over budget"');
    expect(cli.stdout).toBe(plugin.stdout);

    const pluginRec = runPlugin(["record", "x", join(dirA, "report.json"), dirA, ...flags], dirA);
    expect(pluginRec.status, pluginRec.stderr).toBe(0);
    const cliRec = await run(["record", "x", join(dirB, "report.json"), dirB, ...flags]);
    expect(cliRec.code, cliRec.stderr).toBe(0);
    const md = readFileSync(join(dirB, "docs/live-runs.md"), "utf8");
    expect(md).toContain('\nStopped: a [budget]: "over budget"\n');
    expect(md).toBe(readFileSync(join(dirA, "docs/live-runs.md"), "utf8"));
  });
});

describe("doug board rejects an unknown flag per subcommand (card board-cli-unknown-flags)", () => {
  it("U1: `build <dir> --artifact --out <file>` exits 2, names --artifact and doug board build, and writes no file", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const outFile = join(dir, "page.html");
    const r = await run(["build", dir, "--artifact", "--out", outFile]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--artifact");
    expect(r.stderr).toContain("doug board build");
    // Beyond the "unknown option" line, the subcommand's own usage line is printed too.
    expect(r.stderr).toContain("doug board build [dir] [--out <file>]");
    expect(existsSync(outFile)).toBe(false);
    expect(r.stdout).toBe("");
  });
  it("U2: `build --artifact <dir>` exits 2 (the swallowing case, where --artifact takes <dir> as its value)", async () => {
    const dir = fresh();
    await run(["init", dir]);
    const r = await run(["build", "--artifact", dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--artifact");
  });
  it("U3: a flag valid for one subcommand but not another is rejected, and the record is unchanged", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "backlog", title: "X", deps: [], goal: "g" }]);
    const before = readFileSync(join(dir, ".doug/board.json"), "utf8");
    const r = await run(["move", "x", "ready", dir, "--top"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--top");
    // Beyond the "unknown option" line, move's own usage line is printed too.
    expect(r.stderr).toContain("doug board move <id> <column> [dir] [--source <text>]");
    expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);
    expect(readBoard(dir).cards[0].column).toBe("backlog");
  });
  it("rejects --adversary on `record <id> --hand` (the CLI's repeated-key check)", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "h", column: "done", title: "Hand card", track: "hand", deps: [], goal: "g" }]);
    const r = await run(["record", "h", "--hand", dir, "--adversary", "F1=real: x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--adversary");
    expect(existsSync(join(dir, "docs/live-runs.md"))).toBe(false);
  });
  it("still accepts `record ... --shared-cost <usd>` and `summary ... --card <id>`", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
    const report = join(dir, "report.json");
    writeFileSync(
      report,
      JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] }),
    );
    const rec = await run(["record", "x", report, dir, "--cost", "1.5", "--shared-cost", "0.4", "--wall", "12m", "--commit", "abc123"]);
    expect(rec.code, rec.stderr).toBe(0);
    const sum = await run(["summary", report, dir, "--card", "x"]);
    expect(sum.code, sum.stderr).toBe(0);
  });

  it("C1 (card run-report-codex-cost): `doug board record` and `summary` accept --codex-cost and print the row and the clause", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
    const report = join(dir, "report.json");
    writeFileSync(
      report,
      JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] }),
    );
    const rec = await run(["record", "x", report, dir, "--cost", "1.5", "--codex-cost", "2.58", "--wall", "12m", "--commit", "abc123"]);
    expect(rec.code, rec.stderr).toBe(0);
    const md = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(md).toContain("| Codex adversary | $2.58, not included in Cost |");
    const sum = await run(["summary", report, "--cost", "1.5", "--codex-cost", "2.58", "--wall", "12m", "--commit", "abc123"]);
    expect(sum.code, sum.stderr).toBe(0);
    expect(sum.stdout).toContain("; Codex $2.58; landed as abc123.");
  });
});

describe("docs/board.json fallback", () => {
  it("lists, moves and writes docs/board.json without creating .doug/board.json", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "ready", title: "X", deps: [], goal: "g" }], "docs/board.json");
    const list = await run(["list", dir, "--column", "ready"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toBe("Ready (1)\n  x  -  X\n");
    const move = await run(["move", "x", "flow", dir]);
    expect(move.code).toBe(0);
    expect(move.stdout).toBe("Moved x to flow in docs/board.json.\n");
    expect(readBoard(dir, "docs/board.json").cards[0].column).toBe("flow");
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(false);
  });
});

describe("errors", () => {
  it("reports an invalid board", async () => {
    const dir = fresh();
    writeBoard(dir, [
      { id: "x", column: "ready", title: "X", deps: [], goal: "g" },
      { id: "x", column: "ready", title: "X again", deps: [], goal: "g" },
    ]);
    const r = await run(["list", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is not a valid board");
    expect(r.stderr).toContain("duplicate id");
  });
  it("is a usage error for an unknown or missing subcommand", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("doug board init [dir]");
    expect((await run([])).code).toBe(2);
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("doug board record <id> <report.json>");
    expect(help.stdout).toContain("doug board build [dir]");
    expect(help.stdout).toContain("doug board serve [dir]");
  });
});
