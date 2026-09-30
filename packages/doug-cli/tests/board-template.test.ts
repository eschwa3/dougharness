import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderBoardPage } from "../src/board-page.js";

const source = readFileSync(new URL("../templates/board-app.js", import.meta.url), "utf8");
const { dropPlacement, reorderCards, tagOptions, cardMatches } = new Function(
  source + "\nreturn { dropPlacement, reorderCards, tagOptions, cardMatches };",
)() as {
  dropPlacement: (clientY: number, rect: { top: number; height: number }) => "before" | "after";
  reorderCards: (cards: Array<{ id: string; column: string }>, id: string, placement: { before?: string; after?: string }) => Array<{ id: string; column: string }>;
  tagOptions: (cards: Array<{ tags?: string[] }>) => string[];
  cardMatches: (card: { component?: string; tags?: string[] }, filters: { component?: string; tag?: string }) => boolean;
};

describe("dropPlacement", () => {
  it("is before above the midpoint", () => {
    expect(dropPlacement(10, { top: 10, height: 40 })).toBe("before");
  });
  it("is after below the midpoint", () => {
    expect(dropPlacement(45, { top: 10, height: 40 })).toBe("after");
  });
  it("is after exactly at the midpoint", () => {
    expect(dropPlacement(30, { top: 10, height: 40 })).toBe("after");
  });
});

const READY = "ready";
const BACKLOG = "backlog";

function cards() {
  return [
    { id: "a", column: READY },
    { id: "x", column: BACKLOG },
    { id: "b", column: READY },
    { id: "c", column: READY },
  ];
}

describe("reorderCards", () => {
  it("places a card before another in the same column, leaving other columns' slots put", () => {
    const input = cards();
    const result = reorderCards(input, "b", { before: "a" });
    expect(result.map((c) => c.id)).toEqual(["b", "x", "a", "c"]);
    expect(input.map((c) => c.id)).toEqual(["a", "x", "b", "c"]);
  });

  it("places a card after another in the same column, leaving other columns' slots put", () => {
    const input = cards();
    const result = reorderCards(input, "a", { after: "c" });
    expect(result.map((c) => c.id)).toEqual(["b", "x", "c", "a"]);
    expect(input.map((c) => c.id)).toEqual(["a", "x", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = cards();
    const before = JSON.parse(JSON.stringify(input));
    reorderCards(input, "b", { before: "a" });
    expect(input).toEqual(before);
  });

  it("returns the input's copy unchanged when the target is the card itself", () => {
    const input = cards();
    const result = reorderCards(input, "a", { after: "a" });
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it("returns the input's copy unchanged when the target is in another column", () => {
    const input = cards();
    const result = reorderCards(input, "a", { before: "x" });
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

describe("tagOptions", () => {
  it("returns an empty array when no card carries a tag", () => {
    expect(tagOptions([{ id: "a" }, { id: "b", tags: [] }])).toEqual([]);
  });

  it("returns the sorted, deduplicated union of tags across cards", () => {
    const input = [{ tags: ["feature", "bug"] }, { tags: ["bug", "docs"] }, {}];
    const before = JSON.parse(JSON.stringify(input));
    expect(tagOptions(input)).toEqual(["bug", "docs", "feature"]);
    expect(input).toEqual(before);
  });
});

describe("cardMatches", () => {
  it("an untagged card matches with no tag filter", () => {
    expect(cardMatches({ component: "cli" }, { component: "", tag: "" })).toBe(true);
  });

  it("an untagged card does not match a tag filter", () => {
    expect(cardMatches({ component: "cli" }, { component: "", tag: "bug" })).toBe(false);
  });

  it("a tagged card matches only when the tag is present", () => {
    const card = { tags: ["bug", "docs"] };
    expect(cardMatches(card, { component: "", tag: "bug" })).toBe(true);
    expect(cardMatches(card, { component: "", tag: "feature" })).toBe(false);
  });

  it("requires both component and tag to match together", () => {
    const card = { component: "cli", tags: ["bug"] };
    expect(cardMatches(card, { component: "cli", tag: "bug" })).toBe(true);
    expect(cardMatches(card, { component: "flow", tag: "bug" })).toBe(false);
    expect(cardMatches(card, { component: "cli", tag: "docs" })).toBe(false);
  });

  it("does not mutate its input", () => {
    const card = { component: "cli", tags: ["bug"] };
    const before = JSON.parse(JSON.stringify(card));
    cardMatches(card, { component: "cli", tag: "bug" });
    expect(card).toEqual(before);
  });
});

describe("board page reorder wiring", () => {
  it("renders drag and keyboard reorder support in local mode", () => {
    const board = {
      version: 1,
      updated: "2026-01-01",
      columns: [
        { id: "backlog", title: "Backlog" },
        { id: "ready", title: "Ready" },
        { id: "done", title: "Done" },
      ],
      components: [],
      cards: [
        { id: "a", column: "ready", title: "A card", goal: "Do it", deps: [] },
        { id: "b", column: "ready", title: "B card", goal: "Do it too", deps: [] },
      ],
    };
    const html = renderBoardPage(board as any, { mode: "local", record: ".doug/board.json" });
    expect(html).toContain("drop-before");
    expect(html).toContain("Alt+Up");
    expect(html).toContain("placeCard(");
  });
});
