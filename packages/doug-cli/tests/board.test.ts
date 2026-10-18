import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBoard } from "../src/board.js";
import { cardBudgetMinutes } from "../../../plugins/doug-flow/lib/board.mjs";

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
    expect(board.version).toBe(2);
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
    const r = await run(["add", "one", "--title", "First", "--goal", "g", "--tag", "bug, urgent,", dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(readBoard(dir).cards[0].tags).toEqual(["bug", "urgent"]);
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
    const r = await run(["record", "x", report, dir, "--cost", "1.5", "--wall", "12m", "--commit", "abc123", "--summary", "Test summary."]);
    expect(r.code).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Test summary.\nAppended a run entry for x to ${file}.\n`);
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
    const r = await run(["record", "x", report, dir, "--adversary", "F1=real: a user would hit it", "--adversary", "F2=false: the spec allows it", "--summary", "Test summary."]);
    expect(r.code, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(md).toContain("| Adversary precision | 1 real / 0 marginal / 1 false |");
    expect(md).toContain("- F1 (t, pass 1): real. a user would hit it\n- F2 (t, pass 1): false. the spec allows it");
    const bad = await run(["record", "x", report, dir, "--adversary", "F3=real", "--summary", "Test summary."]);
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
    const r = await run(["summary", report, "--wall", "12m", "--commit", "abc123", "--cost", "2", "--summary", "Test summary."]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Test summary.\np: green; 1 task, 1 integrated; wall 12m; cost $2.00; landed as abc123.\nt: implemented, 2 passes, verify yes, review yes, adversary skipped\nEvery stage and acceptance command passed.\n");
    expect((await run(["summary"])).code).toBe(2);
  });
  it("appends a hand-track entry with --hand and no report", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "h", column: "done", title: "Hand card", track: "hand", deps: [], goal: "g" }]);
    const r = await run(["record", "h", "--hand", dir, "--commit", "abc123", "--wall", "20 min", "--gate", "typecheck 0; unit 380 passed", "--note", "one line", "--summary", "Test summary."]);
    expect(r.code).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Test summary.\nAppended a hand-track entry for h to ${file}.\n`);
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
    const r = await run(["record", "h", "--hand", dir, "--commit", "abc123", "--wall", "5 min", "--gate", "typecheck 0; unit 1 passed", "--summary", "Test summary."]);
    expect(r.code, r.stderr).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Test summary.\nPromoted the research note for h to docs/research/h.md.\nAppended a hand-track entry for h to ${file}.\n`);
    expect(readFileSync(join(dir, "docs/research/h.md"), "utf8")).toBe("# H\n\nA decisive fact.\n");
    expect(existsSync(join(dir, ".doug/.state/research/h.md"))).toBe(true);
  });
  it("--hand prints a Wall budget line only when the wall is over the card's p80 budget (card hand-wall-flag)", async () => {
    const budget = cardBudgetMinutes({ size: "S" });
    const over = fresh();
    writeBoard(over, [{ id: "h", column: "done", title: "Hand card", track: "hand", size: "S", deps: [], goal: "g" }]);
    const r = await run(["record", "h", "--hand", over, "--commit", "abc123", "--wall", `${budget + 1} min`, "--gate", "g", "--summary", "Test summary."]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("Wall budget:"))).toEqual([`Wall budget: over: ${budget + 1} min vs ${budget} min (S/all, p80); per-seat times unverified`]);
    expect(readFileSync(join(over, "docs/live-runs.md"), "utf8")).toContain(`| Wall budget | over: ${budget + 1} min vs ${budget} min`);
    const within = fresh();
    writeBoard(within, [{ id: "h", column: "done", title: "Hand card", track: "hand", size: "S", deps: [], goal: "g" }]);
    const w = await run(["record", "h", "--hand", within, "--commit", "abc123", "--wall", `${budget} min`, "--gate", "g", "--summary", "Test summary."]);
    expect(w.code, w.stderr).toBe(0);
    expect(w.stdout).not.toContain("Wall budget");
    expect(readFileSync(join(within, "docs/live-runs.md"), "utf8")).toContain(`| Wall budget | within: ${budget} min vs ${budget} min`);
  });
  it("the run form promotes a card's research note and prints the Promoted line before the Appended line", async () => {
    const dir = fresh();
    writeBoard(dir, [{ id: "x", column: "done", title: "X card", deps: [], goal: "g" }]);
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/x.md"), "# X\n\nA decisive fact.\n");
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ plan: "p", integrationBranch: "doug/p", ok: true, levels: [] }));
    const r = await run(["record", "x", report, dir, "--wall", "2 min", "--commit", "abc123", "--summary", "Test summary."]);
    expect(r.code, r.stderr).toBe(0);
    const file = join(dir, "docs/live-runs.md");
    expect(r.stdout).toBe(`Test summary.\nPromoted the research note for x to docs/research/x.md.\nAppended a run entry for x to ${file}.\n`);
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
    const plugin = runPlugin([...args, dirA, "--summary", "Test summary."], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run([...args, dirB, "--summary", "Test summary."]);
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
    const plugin = runPlugin(["record", "x", join(dirA, "report.json"), dirA, ...flags, "--summary", "Test summary."], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["record", "x", join(dirB, "report.json"), dirB, ...flags, "--summary", "Test summary."]);
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
    const plugin = runPlugin(["record", "x", join(dirA, "report.json"), dirA, ...flags, "--summary", "Test summary."], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["record", "x", join(dirB, "report.json"), dirB, ...flags, "--summary", "Test summary."]);
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
    const plugin = runPlugin(["summary", report, ...flags, "--summary", "Test summary."], dir);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["summary", report, ...flags, "--summary", "Test summary."]);
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
    const plugin = runPlugin(["summary", join(dirA, "report.json"), ...flags, "--summary", "Test summary."], dirA);
    expect(plugin.status, plugin.stderr).toBe(0);
    const cli = await run(["summary", join(dirB, "report.json"), ...flags, "--summary", "Test summary."]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('Stopped: a [budget]: "over budget"');
    expect(cli.stdout).toBe(plugin.stdout);

    const pluginRec = runPlugin(["record", "x", join(dirA, "report.json"), dirA, ...flags, "--summary", "Test summary."], dirA);
    expect(pluginRec.status, pluginRec.stderr).toBe(0);
    const cliRec = await run(["record", "x", join(dirB, "report.json"), dirB, ...flags, "--summary", "Test summary."]);
    expect(cliRec.code, cliRec.stderr).toBe(0);
    const md = readFileSync(join(dirB, "docs/live-runs.md"), "utf8");
    expect(md).toContain('\nStopped: a [budget]: "over budget"\n');
    expect(md).toBe(readFileSync(join(dirA, "docs/live-runs.md"), "utf8"));
  });
});

describe("doug board record and summary require --summary, one sentence, printed first (card cli-record-summary-flag)", () => {
  const GREEN = { plan: "p", integrationBranch: "doug/p", ok: true, levels: [{ index: 0, tasks: [{ id: "t", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] };
  function setup() {
    const dir = fresh();
    writeBoard(dir, [{ id: "h", column: "done", title: "Hand card", track: "hand", deps: [], goal: "g" }]);
    mkdirSync(join(dir, ".doug/.state/research"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/research/h.md"), "# H\n\nA fact.\n");
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify(GREEN));
    return { dir, report };
  }
  const handArgs = (dir: string) => ["record", "h", "--hand", dir, "--commit", "abc123", "--wall", "5 min", "--gate", "g"];
  const runArgs = (dir: string, report: string) => ["record", "h", report, dir, "--commit", "abc123", "--wall", "5 min"];
  const sumArgs = (report: string) => ["summary", report, "--commit", "abc123", "--wall", "5 min"];
  const notWritten = (dir: string) => {
    expect(existsSync(join(dir, "docs/live-runs.md"))).toBe(false);
    expect(existsSync(join(dir, "docs/research/h.md"))).toBe(false);
  };

  it("record <report> requires --summary: missing and blank are exit 2, naming the flag and doug board record, and nothing is appended or promoted", async () => {
    const { dir, report } = setup();
    for (const extra of [[], ["--summary", "   "]]) {
      const r = await run([...runArgs(dir, report), ...extra]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--summary");
      expect(r.stderr).toContain("is required for doug board record");
      expect(r.stderr).not.toContain("board.mjs");
      expect(r.stdout).toBe("");
    }
    notWritten(dir);
  });
  it("record --hand requires --summary: missing and blank are exit 2, and nothing is appended or promoted", async () => {
    const { dir } = setup();
    for (const extra of [[], ["--summary", ""]]) {
      const r = await run([...handArgs(dir), ...extra]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("is required for doug board record");
      expect(r.stdout).toBe("");
    }
    notWritten(dir);
  });
  it("summary requires --summary: missing and blank are exit 2, naming doug board summary, with no output", async () => {
    const { report } = setup();
    for (const extra of [[], ["--summary", " "]]) {
      const r = await run([...sumArgs(report), ...extra]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--summary");
      expect(r.stderr).toContain("is required for doug board summary");
      expect(r.stderr).not.toContain("board.mjs");
      expect(r.stdout).toBe("");
    }
  });
  it("two sentences are refused for each form, with exit 2 and the one-sentence message", async () => {
    const { dir, report } = setup();
    const two = "Did one thing. Then did another.";
    for (const [args, cmd] of [[runArgs(dir, report), "record"], [handArgs(dir), "record"], [sumArgs(report), "summary"]] as const) {
      const r = await run([...args, "--summary", two]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`--summary must be one sentence for doug board ${cmd}`);
      expect(r.stdout).toBe("");
    }
    notWritten(dir);
  });
  it("a newline inside the sentence is refused for each form, even with no sentence end", async () => {
    const { dir, report } = setup();
    for (const [args, cmd] of [[runArgs(dir, report), "record"], [handArgs(dir), "record"], [sumArgs(report), "summary"]] as const) {
      const r = await run([...args, "--summary", "one\nline"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`--summary must be one sentence for doug board ${cmd}`);
    }
    notWritten(dir);
  });
  it("a refused record appends nothing and leaves the research note unpromoted (checked before append)", async () => {
    const { dir, report } = setup();
    const r = await run([...runArgs(dir, report), "--summary", "A. B."]);
    expect(r.code).toBe(2);
    notWritten(dir);
    const h = await run([...handArgs(dir), "--summary", "A. B."]);
    expect(h.code).toBe(2);
    notWritten(dir);
  });
  it("a sentence with an inner dot but no following text is accepted and printed (trimmed)", async () => {
    const { dir, report } = setup();
    const r = await run([...runArgs(dir, report), "--summary", "  Fixed v1.2 handling.  "]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("Fixed v1.2 handling.");
  });
  it("record <report> prints the sentence as stdout's first line, before Promoted and Appended, and never writes it to a file", async () => {
    const { dir, report } = setup();
    const r = await run([...runArgs(dir, report), "--summary", "Users can now see X."]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Users can now see X.");
    expect(lines[1]).toMatch(/^Promoted the research note/);
    expect(lines[2]).toMatch(/^Appended a run entry/);
    expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).not.toContain("Users can now see X.");
  });
  it("record --hand prints the sentence as stdout's first line, before Promoted and Appended", async () => {
    const { dir } = setup();
    const r = await run([...handArgs(dir), "--summary", "Users can now see Y."]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Users can now see Y.");
    expect(lines[1]).toMatch(/^Promoted the research note/);
    expect(lines[2]).toMatch(/^Appended a hand-track entry/);
    expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).not.toContain("Users can now see Y.");
  });
  it("summary prints the sentence as stdout's first line, before the summary block", async () => {
    const { report } = setup();
    const r = await run([...sumArgs(report), "--summary", "Users can now see Z."]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Users can now see Z.");
    expect(lines[1]).toMatch(/^p: green/);
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
    const r = await run(["record", "h", "--hand", dir, "--adversary", "F1=real: x", "--summary", "Test summary."]);
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
    const rec = await run(["record", "x", report, dir, "--cost", "1.5", "--shared-cost", "0.4", "--wall", "12m", "--commit", "abc123", "--summary", "Test summary."]);
    expect(rec.code, rec.stderr).toBe(0);
    const sum = await run(["summary", report, dir, "--card", "x", "--summary", "Test summary."]);
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
    const rec = await run(["record", "x", report, dir, "--cost", "1.5", "--codex-cost", "2.58", "--wall", "12m", "--commit", "abc123", "--summary", "Test summary."]);
    expect(rec.code, rec.stderr).toBe(0);
    const md = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(md).toContain("| Codex adversary | $2.58, not included in Cost |");
    const sum = await run(["summary", report, "--cost", "1.5", "--codex-cost", "2.58", "--wall", "12m", "--commit", "abc123", "--summary", "Test summary."]);
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

// 2026-10-03 (card follow-ups-backlog-ranked): Ready is capped at 7; only the user promotes cards to Ready.
// `doug board add` into ready and `doug board next` warn above the cap on stderr; stdout and exit status are unchanged.
describe("doug board Ready cap (card follow-ups-backlog-ranked)", () => {
  const warning = (n: number) => `warning: Ready holds ${n} cards, above the cap of 7; only the user promotes cards to Ready\n`;
  const readyCards = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, column: "ready", title: `R${i + 1}`, deps: [], goal: "g" }));

  it("add --column ready making 8 warns on stderr, still adds, exits 0, and leaves stdout alone", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(7));
    const r = await run(["add", "x", "--title", "X", "--goal", "g", "--column", "ready", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(warning(8));
    expect(r.stdout).toBe("Added x to ready in .doug/board.json.\n");
    expect(readBoard(dir).cards.map((c: { id: string }) => c.id)).toContain("x");
  });
  it("add --column ready making 7 does not warn", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(6));
    const r = await run(["add", "x", "--title", "X", "--goal", "g", "--column", "ready", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("above the cap");
  });
  it("add --column backlog with 9 cards in Ready does not warn", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(9));
    const r = await run(["add", "x", "--title", "X", "--goal", "g", "--column", "backlog", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("above the cap");
  });
  it("add with no --column (backlog) with 9 cards in Ready does not warn", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(9));
    const r = await run(["add", "x", "--title", "X", "--goal", "g", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("above the cap");
  });
  it("next with 8 Ready cards warns on stderr and prints the card on stdout, exit 0", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(8));
    const r = await run(["next", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(warning(8));
    expect(JSON.parse(r.stdout).id).toBe("r1");
  });
  it("next with 7 Ready cards does not warn", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(7));
    const r = await run(["next", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("above the cap");
  });
  it("move into Ready making 8 warns on stderr, leaves stdout alone, exits 0, and moves the card", async () => {
    const dir = fresh();
    writeBoard(dir, [...readyCards(7), { id: "x", column: "backlog", title: "X", deps: [], goal: "g" }]);
    const r = await run(["move", "x", "ready", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(warning(8));
    expect(r.stdout).toBe("Moved x to ready in .doug/board.json.\n");
    expect(readBoard(dir).cards.find((c: { id: string }) => c.id === "x").column).toBe("ready");
  });
  it("move out of Ready while still above the cap does not warn", async () => {
    const dir = fresh();
    writeBoard(dir, readyCards(9));
    const r = await run(["move", "r1", "backlog", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("warning: Ready holds");
  });
  it("move into Ready making 7 does not warn", async () => {
    const dir = fresh();
    writeBoard(dir, [...readyCards(6), { id: "x", column: "backlog", title: "X", deps: [], goal: "g" }]);
    const r = await run(["move", "x", "ready", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("above the cap");
  });
});

describe("doug board epic and milestone commands (card board-v2-cli)", () => {
  // Version 2 record: card-x (no epic), card-a (e1/m1, Ready), card-c (e2/m2, Ready), card-d (e1/m1, Done), card-z (e3/m3, Done).
  const EPICS = () => [
    { id: "e1", title: "Epic one", goal: "first epic", status: "active" },
    { id: "e2", title: "Epic two", goal: "second epic", status: "planned" },
    { id: "e3", title: "Epic three", goal: "third epic", status: "active" },
  ];
  const MILESTONES = () => [
    { id: "m1", title: "One four", goal: "ship 1.4", target: { version: "1.4", date: "2026-10-31" }, status: "planned" },
    { id: "m2", title: "One five", goal: "ship 1.5", status: "planned" },
    { id: "m3", title: "Old", goal: "shipped", status: "active" },
  ];
  const card = (id: string, column: string, extra: object = {}) => ({ id, column, title: id.toUpperCase(), size: "S", deps: [], goal: `goal of ${id}`, ...extra });
  function v2dir(): string {
    const dir = fresh();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug/board.json"),
      JSON.stringify(
        {
          version: 2,
          updated: "2026-01-01",
          columns: COLUMNS,
          components: [],
          epics: EPICS(),
          milestones: MILESTONES(),
          cards: [
            card("card-x", "ready"),
            card("card-a", "ready", { epic: "e1", milestone: "m1" }),
            card("card-c", "ready", { epic: "e2", milestone: "m2" }),
            card("card-d", "done", { epic: "e1", milestone: "m1", source: "commit 2222222" }),
            card("card-z", "done", { epic: "e3", milestone: "m3", source: "commit 3333333" }),
          ],
        },
        null,
        2,
      ) + "\n",
    );
    return dir;
  }
  function v1dir(): string {
    const dir = fresh();
    writeBoard(dir, [card("card-x", "ready")]);
    return dir;
  }
  const raw = (dir: string) => readFileSync(join(dir, ".doug/board.json"), "utf8");
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  const lineFor = (stdout: string, id: string) => stdout.split("\n").find((l) => l.includes(id)) ?? "";

  describe("epic", () => {
    it("epic add writes the epic and makes the record version 2", async () => {
      const dir = v1dir();
      const r = await run(["epic", "add", "e1", "--title", "Epic one", "--goal", "the goal", dir]);
      expect(r.code).toBe(0);
      const b = readBoard(dir);
      expect(b.version).toBe(2);
      expect(b.epics).toEqual([{ id: "e1", title: "Epic one", goal: "the goal", status: "planned" }]);
    });
    it("epic add --version and --date write the target", async () => {
      const dir = v1dir();
      expect((await run(["epic", "add", "e1", "--title", "T", "--goal", "G", "--version", "1.4", "--date", "2026-10-31", dir])).code).toBe(0);
      expect(readBoard(dir).epics[0].target).toEqual({ version: "1.4", date: "2026-10-31" });
    });
    it("epic add without --title or --goal is a usage error; a duplicate id is refused", async () => {
      const dir = v2dir();
      const before = raw(dir);
      expect((await run(["epic", "add", "e9", "--goal", "G", dir])).code).toBe(2);
      expect((await run(["epic", "add", "e9", "--title", "T", dir])).code).toBe(2);
      const dup = await run(["epic", "add", "e1", "--title", "T", "--goal", "G", dir]);
      expect(dup.code).toBe(1);
      expect(dup.stderr).toContain('duplicate epic "e1"');
      expect(raw(dir)).toBe(before);
    });
    it("epic edit changes title and goal, and --status sets the status", async () => {
      const dir = v2dir();
      expect((await run(["epic", "edit", "e2", "--title", "New title", "--goal", "New goal", dir])).code).toBe(0);
      expect(readBoard(dir).epics[1]).toMatchObject({ id: "e2", title: "New title", goal: "New goal", status: "planned" });
      expect((await run(["epic", "edit", "e2", "--status", "active", dir])).code).toBe(0);
      expect(readBoard(dir).epics[1].status).toBe("active");
    });
    it("epic edit sets the target and clears --version with an empty value", async () => {
      const dir = v2dir();
      expect((await run(["epic", "edit", "e1", "--version", "2.0", "--date", "2026-12-01", dir])).code).toBe(0);
      expect(readBoard(dir).epics[0].target).toEqual({ version: "2.0", date: "2026-12-01" });
      expect((await run(["epic", "edit", "e1", "--version", "", dir])).code).toBe(0);
      const t = readBoard(dir).epics[0].target;
      expect(t.version).toBeUndefined();
      expect(t.date).toBe("2026-12-01");
    });
    it("epic edit with no field is a usage error; an unknown id and a bad status are refused, record unchanged", async () => {
      const dir = v2dir();
      const before = raw(dir);
      expect((await run(["epic", "edit", "e1", dir])).code).toBe(2);
      const ghost = await run(["epic", "edit", "ghost", "--title", "T", dir]);
      expect(ghost.code).toBe(1);
      expect(ghost.stderr).toContain('no epic "ghost" on the board');
      const bad = await run(["epic", "edit", "e1", "--status", "late", dir]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("status must be planned, active, or done");
      expect(raw(dir)).toBe(before);
    });
    it("epic list prints one line per epic, and --json the array", async () => {
      const dir = v2dir();
      const r = await run(["epic", "list", dir]);
      expect(r.code).toBe(0);
      const l1 = lineFor(r.stdout, "e1");
      expect(l1).toContain("active");
      expect(l1).toContain("Epic one");
      expect(lineFor(r.stdout, "e2")).toContain("planned");
      expect(r.stdout.split("\n").filter((l) => l.trim()).length).toBe(3);
      const j = await run(["epic", "list", dir, "--json"]);
      expect(j.code).toBe(0);
      expect(JSON.parse(j.stdout)).toEqual(EPICS());
      const empty = await run(["epic", "list", v1dir(), "--json"]);
      expect(JSON.parse(empty.stdout)).toEqual([]);
    });
    it("epic edit --status done is refused while a member card is not Done, and allowed when all are Done", async () => {
      const dir = v2dir();
      const before = raw(dir);
      const r = await run(["epic", "edit", "e1", "--status", "done", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("card-a");
      expect(r.stderr).toContain("--force");
      expect(raw(dir)).toBe(before);
      expect((await run(["epic", "edit", "e3", "--status", "done", dir])).code).toBe(0);
      expect(readBoard(dir).epics[2].status).toBe("done");
    });
  });

  describe("milestone", () => {
    it("milestone add --version 1.4 --date 2026-11-01 writes the target", async () => {
      const dir = v1dir();
      const r = await run(["milestone", "add", "m1", "--title", "One four", "--goal", "ship it", "--version", "1.4", "--date", "2026-11-01", dir]);
      expect(r.code).toBe(0);
      const b = readBoard(dir);
      expect(b.version).toBe(2);
      expect(b.milestones).toEqual([{ id: "m1", title: "One four", goal: "ship it", target: { version: "1.4", date: "2026-11-01" }, status: "planned" }]);
    });
    it("milestone add with only --version writes just the version; a bad date and a missing --goal are refused", async () => {
      const dir = v1dir();
      expect((await run(["milestone", "add", "m1", "--title", "T", "--goal", "G", "--version", "1.4", dir])).code).toBe(0);
      expect(readBoard(dir).milestones[0].target).toEqual({ version: "1.4" });
      const before = raw(dir);
      const bad = await run(["milestone", "add", "m2", "--title", "T", "--goal", "G", "--date", "tomorrow", dir]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("YYYY-MM-DD");
      expect((await run(["milestone", "add", "m3", "--title", "T", dir])).code).toBe(2);
      expect(raw(dir)).toBe(before);
    });
    it("milestone edit --status active sets the status", async () => {
      const dir = v2dir();
      expect((await run(["milestone", "edit", "m2", "--status", "active", dir])).code).toBe(0);
      expect(readBoard(dir).milestones[1]).toMatchObject({ id: "m2", status: "active", title: "One five" });
    });
    it("milestone edit changes title, goal and target; an unknown id is refused", async () => {
      const dir = v2dir();
      expect((await run(["milestone", "edit", "m1", "--title", "T2", "--goal", "G2", "--version", "1.5", dir])).code).toBe(0);
      expect(readBoard(dir).milestones[0]).toMatchObject({ title: "T2", goal: "G2", target: { version: "1.5", date: "2026-10-31" } });
      const ghost = await run(["milestone", "edit", "ghost", "--title", "T", dir]);
      expect(ghost.code).toBe(1);
      expect(ghost.stderr).toContain('no milestone "ghost" on the board');
      expect((await run(["milestone", "edit", "m1", dir])).code).toBe(2);
    });
    it("milestone list prints one line per milestone, and --json the array", async () => {
      const dir = v2dir();
      const r = await run(["milestone", "list", dir]);
      expect(r.code).toBe(0);
      const l1 = lineFor(r.stdout, "m1");
      expect(l1).toContain("planned");
      expect(l1).toContain("One four");
      expect(l1).toContain("1.4");
      expect(lineFor(r.stdout, "m3")).toContain("active");
      expect(r.stdout).not.toContain("Epic one");
      expect(JSON.parse((await run(["milestone", "list", dir, "--json"])).stdout)).toEqual(MILESTONES());
    });
    it("milestone edit --status done is refused while a member card is not Done", async () => {
      const dir = v2dir();
      const before = raw(dir);
      const r = await run(["milestone", "edit", "m1", "--status", "done", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('cannot edit milestone "m1"');
      expect(r.stderr).toContain("card-a");
      expect(r.stderr).not.toContain("card-d");
      expect(r.stderr).toContain("--force");
      expect(raw(dir)).toBe(before);
    });
    it("milestone edit --status done is allowed when every member card is Done", async () => {
      const dir = v2dir();
      expect((await run(["milestone", "edit", "m3", "--status", "done", dir])).code).toBe(0);
      expect(readBoard(dir).milestones[2].status).toBe("done");
    });
    it("milestone edit --status done --force sets done with a warning", async () => {
      const dir = v2dir();
      const r = await run(["milestone", "edit", "m1", "--status", "done", "--force", dir]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("warning:");
      expect(r.stderr).toContain("card-a");
      expect(readBoard(dir).milestones[0].status).toBe("done");
    });
    it("epic edit --status done --force sets done with a warning", async () => {
      const dir = v2dir();
      const r = await run(["epic", "edit", "e1", "--status", "done", "--force", dir]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("warning:");
      expect(readBoard(dir).epics[0].status).toBe("done");
    });
  });

  describe("--epic and --milestone on add, edit, list and next", () => {
    it("add --epic e1 --milestone m1 writes both fields; an unknown epic is refused", async () => {
      const dir = v2dir();
      const r = await run(["add", "card-new", "--title", "New", "--goal", "G", "--epic", "e1", "--milestone", "m1", dir]);
      expect(r.code).toBe(0);
      const added = readBoard(dir).cards.find((c: { id: string }) => c.id === "card-new");
      expect(added.epic).toBe("e1");
      expect(added.milestone).toBe("m1");
      const before = raw(dir);
      const bad = await run(["add", "card-bad", "--title", "T", "--goal", "G", "--epic", "ghost", dir]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('unknown epic "ghost"');
      expect(raw(dir)).toBe(before);
    });
    it("add with an empty --epic means no epic", async () => {
      const dir = v2dir();
      expect((await run(["add", "card-new", "--title", "New", "--goal", "G", "--epic", "", dir])).code).toBe(0);
      const added = readBoard(dir).cards.find((c: { id: string }) => c.id === "card-new");
      expect(Object.keys(added)).not.toContain("epic");
    });
    it("edit --epic e2 changes it, and --milestone m2 sets the milestone", async () => {
      const dir = v2dir();
      expect((await run(["edit", "card-a", "--epic", "e2", "--milestone", "m2", dir])).code).toBe(0);
      const c = readBoard(dir).cards.find((x: { id: string }) => x.id === "card-a");
      expect(c.epic).toBe("e2");
      expect(c.milestone).toBe("m2");
    });
    it('edit --milestone "" removes the card\'s milestone key and --epic "" its epic key', async () => {
      const dir = v2dir();
      expect((await run(["edit", "card-a", "--milestone", "", dir])).code).toBe(0);
      let c = readBoard(dir).cards.find((x: { id: string }) => x.id === "card-a");
      expect(Object.keys(c)).not.toContain("milestone");
      expect(c.epic).toBe("e1");
      expect((await run(["edit", "card-a", "--epic", "", dir])).code).toBe(0);
      c = readBoard(dir).cards.find((x: { id: string }) => x.id === "card-a");
      expect(Object.keys(c)).not.toContain("epic");
    });
    it("list --milestone m1 shows only m1's cards (text and --json); list --epic ghost exits 1 with unknown epic \"ghost\"", async () => {
      const dir = v2dir();
      const text = await run(["list", dir, "--milestone", "m1"]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("card-a");
      expect(text.stdout).toContain("card-d");
      expect(text.stdout).not.toMatch(/card-x|card-c|card-z/);
      const json = await run(["list", dir, "--milestone", "m1", "--json"]);
      expect(ids(JSON.parse(json.stdout)).sort()).toEqual(["card-a", "card-d"]);
      const epic = await run(["list", dir, "--epic", "e2", "--json"]);
      expect(ids(JSON.parse(epic.stdout))).toEqual(["card-c"]);
      const both = await run(["list", dir, "--epic", "e1", "--milestone", "m1", "--column", "ready", "--json"]);
      expect(ids(JSON.parse(both.stdout))).toEqual(["card-a"]);
      const ghost = await run(["list", dir, "--epic", "ghost"]);
      expect(ghost.code).toBe(1);
      expect(ghost.stderr).toContain('unknown epic "ghost"');
      const gm = await run(["list", dir, "--milestone", "ghost"]);
      expect(gm.code).toBe(1);
      expect(gm.stderr).toContain('unknown milestone "ghost"');
    });
    it("next --epic e2 picks the e2 card past a higher Ready card, and its stderr does not name the excluded cards", async () => {
      const dir = v2dir();
      const r = await run(["next", dir, "--epic", "e2"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).id).toBe("card-c");
      expect(r.stderr).not.toMatch(/card-x|card-a/);
    });
    it("next --milestone m1 picks only an m1 card; no match exits 1", async () => {
      const dir = v2dir();
      const r = await run(["next", dir, "--milestone", "m1"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).id).toBe("card-a");
      expect(r.stderr).not.toMatch(/card-x|card-c/);
      const none = await run(["next", dir, "--epic", "e1", "--milestone", "m2"]);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("No Ready card");
    });
    it("next --batch 5 --epic e1 prints only e1's cards, and --milestone filters the batch too", async () => {
      const dir = v2dir();
      const r = await run(["next", dir, "--batch", "5", "--epic", "e1"]);
      expect(r.code).toBe(0);
      expect(ids(JSON.parse(r.stdout))).toEqual(["card-a"]);
      expect(r.stderr).not.toMatch(/card-x|card-c/);
      const m = await run(["next", dir, "--batch", "5", "--milestone", "m2"]);
      expect(ids(JSON.parse(m.stdout))).toEqual(["card-c"]);
    });
    it("next with an unknown epic or milestone exits 1 naming it", async () => {
      const dir = v2dir();
      const e = await run(["next", dir, "--epic", "ghost"]);
      expect(e.code).toBe(1);
      expect(e.stderr).toContain('unknown epic "ghost"');
      const m = await run(["next", dir, "--batch", "2", "--milestone", "ghost"]);
      expect(m.code).toBe(1);
      expect(m.stderr).toContain('unknown milestone "ghost"');
    });
  });

  describe("unknown flags and usage", () => {
    it("epic add e1 --title T --goal G --bogus x exits 2 naming --bogus, and writes nothing", async () => {
      const dir = v1dir();
      const before = raw(dir);
      const r = await run(["epic", "add", "e1", "--title", "T", "--goal", "G", "--bogus", "x", dir]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown option --bogus for doug board epic");
      expect(raw(dir)).toBe(before);
    });
    it("milestone edit m1 --bogus x exits 2 naming --bogus; milestone add refuses one too; epic list refuses a flag it does not read", async () => {
      const dir = v2dir();
      const before = raw(dir);
      const edit = await run(["milestone", "edit", "m1", "--bogus", "x", dir]);
      expect(edit.code).toBe(2);
      expect(edit.stderr).toContain("--bogus");
      const add = await run(["milestone", "add", "m9", "--title", "T", "--goal", "G", "--bogus", "x", dir]);
      expect(add.code).toBe(2);
      expect(add.stderr).toContain("unknown option --bogus for doug board milestone");
      expect((await run(["epic", "list", dir, "--title", "x"])).code).toBe(2);
      expect(raw(dir)).toBe(before);
    });
    it("add, edit, list and next still refuse an unknown flag", async () => {
      const dir = v2dir();
      for (const argv of [["add", "n", "--title", "T", "--goal", "G", "--bogus", "x", dir], ["edit", "card-x", "--bogus", "x", dir], ["list", dir, "--bogus", "x"], ["next", dir, "--bogus", "x"]]) {
        expect((await run(argv)).code).toBe(2);
      }
    });
    it("`doug board epic` and `milestone` with no or an unknown action exit 2 with that kind's usage", async () => {
      for (const kind of ["epic", "milestone"]) {
        for (const argv of [[kind], [kind, "frob"]]) {
          const r = await run(argv);
          expect(r.code).toBe(2);
          for (const action of ["add", "edit", "list"]) expect(r.stderr).toContain(`doug board ${kind} ${action}`);
        }
      }
    });
    it("BOARD_USAGE has epic add|edit|list, milestone add|edit|list and --epic/--milestone on add, edit, list, next", async () => {
      const { BOARD_USAGE } = await import("../src/board.js");
      const lines = BOARD_USAGE.split("\n");
      for (const kind of ["epic", "milestone"]) {
        for (const action of ["add", "edit", "list"]) expect(lines.some((l) => l.trimStart().startsWith(`doug board ${kind} ${action}`)), `${kind} ${action}`).toBe(true);
      }
      for (const cmd of ["add", "edit", "list", "next"]) {
        const line = lines.find((l) => l.trimStart().startsWith(`doug board ${cmd} `)) ?? "";
        expect(line, cmd).toContain("--epic");
        expect(line, cmd).toContain("--milestone");
      }
      const help = await run(["--help"]);
      expect(help.stdout).toContain("doug board epic add");
      expect(help.stdout).toContain("doug board milestone edit");
    });
  });
});

describe("doug board labels init (card board-label-groups-migrate)", () => {
  function v1dir(): string {
    const dir = fresh();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug/board.json"),
      JSON.stringify({
        version: 1,
        updated: "2026-01-01",
        columns: COLUMNS,
        components: ["gates"],
        tags: ["bug", "perf"],
        cards: [
          { id: "a", column: "ready", component: "gates", title: "A", size: "S", goal: "a", tags: ["bug"] },
          { id: "b", column: "backlog", component: "gates", title: "B", size: "S", goal: "b", tags: ["perf"] },
        ],
      }, null, 2) + "\n",
    );
    return dir;
  }
  it("migrates a v1 board with tagged cards and the result loads", async () => {
    const dir = v1dir();
    const r = await run(["labels", "init", dir]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const rec = readBoard(dir);
    expect(rec.version).toBe(2);
    expect(rec.labelGroups.map((g: { id: string }) => g.id)).toEqual(["type", "priority"]);
    expect(rec.labelGroups[0].labels.map((l: { name: string }) => l.name)).toEqual(["bug", "perf"]);
    const list = await run(["list", dir]);
    expect(list.code).toBe(0);
  });
  it("refuses a board that already has label groups and leaves the file unchanged", async () => {
    const dir = fresh();
    expect((await run(["init", dir])).code).toBe(0);
    const before = readFileSync(join(dir, ".doug/board.json"), "utf8");
    const r = await run(["labels", "init", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already has label groups");
    expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);
  });
});

describe("doug board rollup and labels --check (card doug-cli-rollup)", () => {
  const LIVE = [
    "# Live runs", "",
    "## 2026-10-01, cs: S card", "", "| Measure | Value |", "|---|---|", "| Outcome | landed |", "| Cost | $2.50 |", "| Wall clock | 40 min |", "",
    "## 2026-10-02, cm: M card", "", "| Measure | Value |", "|---|---|", "| Cost | $9.00 |", "| Wall clock | 30 min |", "",
    "## 2026-10-03, cl: L card", "", "| Measure | Value |", "|---|---|", "| Outcome | landed |", "| Wall clock | 150 min |", "",
  ].join("\n");
  // twoMilestones puts m0 (with its own card c0, no epic) before m1, so a lookup that returns milestones[0] gives m0, not m1.
  function rdir(opts: { live?: boolean; labels?: Array<[string, string]>; twoMilestones?: boolean } = {}): string {
    const dir = fresh();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const board: Record<string, unknown> = {
      version: 2,
      updated: "2026-01-01",
      columns: COLUMNS,
      components: ["gates"],
      epics: [{ id: "e1", title: "Epic one", goal: "first", status: "active" }],
      milestones: [{ id: "m1", title: "One four", goal: "ship", target: { version: "1.4", date: "2026-10-31" }, status: "planned" }],
      cards: [
        { id: "cs", column: "done", component: "gates", title: "S", size: "S", source: "commit 1111111", goal: "s", epic: "e1", milestone: "m1" },
        { id: "cm", column: "flow", component: "gates", title: "M", size: "M", goal: "m", epic: "e1", milestone: "m1" },
        { id: "cl", column: "done", component: "gates", title: "L", size: "L", source: "commit 2222222", goal: "l", epic: "e1" },
      ],
    };
    if (opts.twoMilestones) {
      board.milestones = [{ id: "m0", title: "One three", goal: "earlier", target: { version: "1.3" }, status: "done" }, ...(board.milestones as object[])];
      board.cards = [{ id: "c0", column: "done", component: "gates", title: "Zero", size: "S", source: "commit 0000000", goal: "z", milestone: "m0" }, ...(board.cards as object[])];
    }
    if (opts.labels) {
      board.tags = opts.labels.map(([n]) => n);
      board.labelGroups = [{ id: "type", title: "Type", exclusive: false, labels: opts.labels.map(([name, color]) => ({ name, color })) }];
    }
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2) + "\n");
    if (opts.live) {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/live-runs.md"), LIVE);
    }
    return dir;
  }

  describe("rollup", () => {
    it("defaults --from to docs/live-runs.md when present, else null measured", async () => {
      const withFile = await run(["rollup", rdir({ live: true })]);
      expect(withFile.code).toBe(0);
      expect(JSON.parse(withFile.stdout).epics[0].measured.usd).toBe(2.5);
      const without = await run(["rollup", rdir()]);
      expect(without.code).toBe(0);
      expect(JSON.parse(without.stdout).epics[0].measured.usd).toBeNull();
    });
    it("--from reads a file outside docs/; an unreadable --from exits 1 naming the file", async () => {
      const dir = rdir();
      const f = join(dir, "elsewhere.md");
      writeFileSync(f, LIVE);
      const ok = await run(["rollup", dir, "--from", f]);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout).epics[0].measured.usd).toBe(2.5);
      const missing = join(dir, "nope.md");
      const bad = await run(["rollup", dir, "--from", missing]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("nope.md");
      expect(bad.stdout).toBe("");
    });
    it("--milestone m1 prints one entry with id m1, no milestones key, and cards [cs, cm]; --epic e1 likewise with all three", async () => {
      const dir = rdir({ live: true, twoMilestones: true });
      const m = JSON.parse((await run(["rollup", dir, "--milestone", "m1"])).stdout);
      expect(m).toMatchObject({ id: "m1", total: 2 });
      expect(m.milestones).toBeUndefined();
      expect(m.cards).toEqual(["cs", "cm"]);
      const e = JSON.parse((await run(["rollup", dir, "--epic", "e1"])).stdout);
      expect(e).toMatchObject({ id: "e1", total: 3 });
      expect(e.epics).toBeUndefined();
      expect(e.cards).toEqual(["cs", "cm", "cl"]);
    });
    it("with no filter prints {epics, milestones}, each entry carrying cards", async () => {
      const out = JSON.parse((await run(["rollup", rdir({ live: true })])).stdout);
      expect(Object.keys(out).sort()).toEqual(["epics", "milestones"]);
      expect(out.epics[0].cards).toEqual(["cs", "cm", "cl"]);
      expect(out.milestones[0].cards).toEqual(["cs", "cm"]);
    });
    it("--epic with --milestone exits 2 with usage", async () => {
      const r = await run(["rollup", rdir(), "--epic", "e1", "--milestone", "m1"]);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/usage/i);
    });
    it("an unknown epic or milestone id exits 1 naming it", async () => {
      const dir = rdir();
      const e = await run(["rollup", dir, "--epic", "zz"]);
      expect(e.code).toBe(1);
      expect(e.stderr).toContain('unknown epic "zz"');
      const m = await run(["rollup", dir, "--milestone", "zz"]);
      expect(m.code).toBe(1);
      expect(m.stderr).toContain('unknown milestone "zz"');
    });
    it("refuses an unknown flag with exit 2", async () => {
      const r = await run(["rollup", rdir(), "--bogus", "x"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown option --bogus for doug board rollup");
    });
    it("stdout is byte-identical to board.mjs rollup on the same board and live-runs", async () => {
      const dir = rdir({ live: true });
      for (const extra of [[], ["--milestone", "m1"], ["--epic", "e1"]]) {
        const mine = await run(["rollup", dir, ...extra]);
        const theirs = spawnSync(process.execPath, [pluginCli, "rollup", dir, ...extra], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
        expect(theirs.status).toBe(0);
        expect(mine.stdout).toBe(theirs.stdout);
      }
    });
  });

  describe("labels --check", () => {
    it("prints a line naming the label, its colour and the surface for a colour under 3:1, and exits 0", async () => {
      const r = await run(["labels", "--check", rdir({ labels: [["pale", "#ffff00"]] })]);
      expect(r.code).toBe(0);
      const line = r.stdout.split("\n").find((l) => l.includes("pale")) ?? "";
      expect(line).toContain("#ffff00");
      expect(line).toContain("#ffffff");
    });
    it("prints one newline-terminated line per failing label, in board order", async () => {
      const r = await run(["labels", "--check", rdir({ labels: [["pale", "#ffff00"], ["mist", "#eeeeee"]] })]);
      expect(r.code).toBe(0);
      const lines = r.stdout.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe("");
      expect(lines[0]).toMatch(/^pale #ffff00 \d+\.\d\d:1 against #ffffff$/);
      expect(lines[1]).toMatch(/^mist #eeeeee \d+\.\d\d:1 against #ffffff$/);
    });
    it("prints nothing for the default palette", async () => {
      const dir = fresh();
      expect((await run(["init", dir])).code).toBe(0);
      const r = await run(["labels", "--check", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });
    it("parses --check as a flag so the directory still resolves (cwd is elsewhere)", async () => {
      const dir = rdir({ labels: [["pale", "#ffff00"]] });
      const elsewhere = fresh();
      const before = process.cwd();
      process.chdir(elsewhere);
      try {
        expect(realpathSync(process.cwd())).toBe(realpathSync(elsewhere));
        expect(existsSync(join(process.cwd(), ".doug"))).toBe(false);
        const r = await run(["labels", "--check", dir]);
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("pale");
      } finally {
        process.chdir(before);
      }
    });
    it("labels with neither init nor --check exits 2 and writes nothing", async () => {
      const dir = rdir({ labels: [["pale", "#ffff00"]] });
      const before = readFileSync(join(dir, ".doug/board.json"), "utf8");
      const r = await run(["labels", dir]);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);
    });
    it("labels init still works", async () => {
      const dir = rdir();
      expect(readBoard(dir).labelGroups).toBeUndefined();
      const r = await run(["labels", "init", dir]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Added label groups type and priority");
      expect(readBoard(dir).labelGroups.map((g: { id: string }) => g.id)).toEqual(["type", "priority"]);
    });
  });

  it("BOARD_USAGE has a rollup line with --epic, --milestone, --from and a labels --check [dir] line", async () => {
    const { BOARD_USAGE } = await import("../src/board.js");
    const lines = BOARD_USAGE.split("\n");
    const roll = lines.find((l) => l.trim().startsWith("doug board rollup")) ?? "";
    for (const t of ["--epic", "--milestone", "--from"]) expect(roll, t).toContain(t);
    expect(lines.some((l) => l.includes("doug board labels --check [dir]"))).toBe(true);
  });

  it("ADR 0016 has exactly one Status line and it is accepted", () => {
    const adr = join(here, "..", "..", "..", "docs", "decisions", "0016-board-epics-milestones-and-label-groups.md");
    if (!existsSync(adr)) return;
    const lines = readFileSync(adr, "utf8").split("\n").filter((l) => /^Date: .*Status:/.test(l));
    expect(lines).toEqual(["Date: 2026-10-13. Status: accepted."]);
  });
});
