import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderBoardPage } from "../src/board-page.js";
import { DEFAULT_LABEL_GROUPS, nextReadyCards, rollup } from "@dougharness/flow/lib/board.mjs";

const source = readFileSync(new URL("../templates/board-app.js", import.meta.url), "utf8");
const { priorityBandMove, columnHtml, READY_COL_HINT, dropPlacement, reorderCards, tagOptions, cardMatches, contrastRatio, applyLiveBoard, columnCardsHtml, doneHiddenCount } = new Function(
  source + "\nreturn { dropPlacement, reorderCards, tagOptions, cardMatches, contrastRatio: typeof contrastRatio === 'function' ? contrastRatio : undefined, applyLiveBoard, columnCardsHtml: typeof columnCardsHtml === 'function' ? columnCardsHtml : undefined, doneHiddenCount: typeof doneHiddenCount === 'function' ? doneHiddenCount : undefined, priorityBandMove: typeof priorityBandMove === 'function' ? priorityBandMove : undefined, columnHtml: typeof columnHtml === 'function' ? columnHtml : undefined, READY_COL_HINT: typeof READY_COL_HINT === 'string' ? READY_COL_HINT : undefined };",
)() as {
  priorityBandMove: (cards: any[], labelGroups: any, id: string, column: string, targetId: string) => "place" | "refuse" | "column";
  columnHtml: (col: any, cards: any[], columns: any[], labelGroups: any) => string;
  READY_COL_HINT: string | undefined;
  columnCardsHtml: (col: any, cards: any[], columns: any[], labelGroups: any, expanded: boolean) => string;
  doneHiddenCount: (cards: any[], filters: any) => number;
  contrastRatio: (a: string, b: string) => number;
  applyLiveBoard: (board: any, next: any, config: any, opts: any) => any;
  dropPlacement: (clientY: number, rect: { top: number; height: number }) => "before" | "after";
  reorderCards: (cards: Array<{ id: string; column: string }>, id: string, placement: { before?: string; after?: string }) => Array<{ id: string; column: string }>;
  tagOptions: (cards: Array<{ tags?: string[] }>) => string[];
  cardMatches: (card: { component?: string; tags?: string[] }, filters: { component?: string; tag?: string; groups?: Record<string, string> }) => boolean;
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

// ---- ADR 0016: coloured label chips, label-group filters, priority-sorted Ready ----

const COLS = [
  { id: "backlog", title: "Backlog" },
  { id: "ready", title: "Ready" },
  { id: "done", title: "Done" },
];

function v2Board(labelGroups: any, cards: any[]) {
  return { version: 2, updated: "2026-01-01", columns: COLS, components: [], labelGroups, cards };
}

function card(id: string, tags: string[] = [], column = "ready") {
  return { id, column, title: `T ${id}`, goal: "g", deps: [], size: "S", track: "any", tags };
}

function page(board: any) {
  return renderBoardPage(board, { mode: "local", record: ".doug/board.json" });
}

// Every label chip on a page: its name text and the colours in its style attribute.
function chips(html: string) {
  const out: Array<{ text: string; bg: string; fg: string }> = [];
  for (const m of html.split("<script")[0].matchAll(/<span class="chip tag"([^>]*)>([^<]*)<\/span>/g)) {
    const style = /style="([^"]*)"/.exec(m[1])?.[1] ?? "";
    const bg = /(?:^|;)\s*background(?:-color)?:\s*(#[0-9a-fA-F]{6})/.exec(style)?.[1] ?? "";
    const fg = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/.exec(style)?.[1] ?? "";
    out.push({ text: m[2], bg: bg.toLowerCase(), fg: fg.toLowerCase(), });
  }
  return out;
}

// Ready column card ids in rendered order.
function readyIds(html: string): string[] {
  const sec = /<section class="col" data-column="ready">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
  return Array.from(sec.matchAll(/<article class="card"[^>]*data-id="([^"]+)"/g)).map((m) => m[1]);
}

describe("contrastRatio", () => {
  it("pins known pairs (#000000 vs #ffffff = 21, #767676 vs #ffffff ~ 4.54) and is symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#767676"), 10);
    expect(contrastRatio("#ffff00", "#ffff00")).toBeCloseTo(1, 5);
  });
});

describe("label chips", () => {
  it("chip text contrast is at least 4.5:1 for every DEFAULT_LABEL_GROUPS label", () => {
    const labels = DEFAULT_LABEL_GROUPS.flatMap((g: any) => g.labels);
    const html = page(v2Board(DEFAULT_LABEL_GROUPS, labels.map((l: any) => card(`c-${l.name}`, [l.name], "backlog"))));
    const found = chips(html);
    expect(found.map((c) => c.text).sort()).toEqual(labels.map((l: any) => l.name).sort());
    for (const l of labels) {
      const chip = found.find((c) => c.text === l.name)!;
      expect(chip.bg).toBe(l.color);
      expect(["#000000", "#ffffff"]).toContain(chip.fg);
      expect(computeRatio(chip.fg, chip.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("#ffff00 gets black text at >= 4.5:1", () => {
    const g = [{ id: "x", title: "X", exclusive: false, labels: [{ name: "sun", color: "#ffff00" }] }];
    const [chip] = chips(page(v2Board(g, [card("a", ["sun"], "backlog")])));
    expect(chip.fg).toBe("#000000");
    expect(computeRatio(chip.fg, chip.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("#000080 gets white text at >= 4.5:1", () => {
    const g = [{ id: "x", title: "X", exclusive: false, labels: [{ name: "navy", color: "#000080" }] }];
    const [chip] = chips(page(v2Board(g, [card("a", ["navy"], "backlog")])));
    expect(chip.fg).toBe("#ffffff");
    expect(computeRatio(chip.fg, chip.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("a version 2 card's chip contains the label name as text", () => {
    const html = page(v2Board(DEFAULT_LABEL_GROUPS, [card("a", ["bug", "high"], "backlog")]));
    expect(chips(html).map((c) => c.text)).toEqual(["bug", "high"]);
  });

  it("a version 2 card's chip has background set to its label colour and black/white text", () => {
    const html = page(v2Board(DEFAULT_LABEL_GROUPS, [card("a", ["bug"], "backlog")]));
    const [chip] = chips(html);
    expect(chip.bg).toBe("#d73a4a");
    expect(["#000000", "#ffffff"]).toContain(chip.fg);
  });
});

// Independent WCAG ratio so the chip tests do not lean on the helper under test.
function computeRatio(a: string, b: string): number {
  const lum = (h: string) => {
    const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("label group filters", () => {
  it("a version 2 board renders one select per label group listing that group's label names, and no tag-filter", () => {
    const html = page(v2Board(DEFAULT_LABEL_GROUPS, [card("a", ["bug"], "backlog")]));
    expect(html.split("<script")[0]).not.toContain('id="tag-filter"');
    for (const g of DEFAULT_LABEL_GROUPS as any[]) {
      const m = new RegExp(`<select id="group-filter-${g.id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
      expect(m, `select for group ${g.id}`).not.toBeNull();
      const values = Array.from(m![1].matchAll(/<option value="([^"]*)"/g)).map((o) => o[1]);
      expect(values).toEqual(["", ...g.labels.map((l: any) => l.name)]);
    }
  });

  it("a version 1 board with tagged cards still renders the single tag-filter and no group filter", () => {
    const board = { version: 1, updated: "2026-01-01", columns: COLS, components: [], cards: [{ ...card("a", ["bug", "docs"], "backlog") }] };
    const html = page(board);
    expect(html.split("<script")[0]).toContain('<label for="tag-filter">tag</label><select id="tag-filter">');
    expect(html.split("<script")[0]).not.toContain("group-filter-");
  });

  it("cardMatches with a group selection hides a card lacking that group's selected label and keeps one carrying it", () => {
    const groups = { type: "bug" };
    expect(cardMatches({ tags: ["bug", "high"] }, { component: "", tag: "", groups })).toBe(true);
    expect(cardMatches({ tags: ["docs", "high"] }, { component: "", tag: "", groups })).toBe(false);
    expect(cardMatches({}, { component: "", tag: "", groups })).toBe(false);
    expect(cardMatches({ tags: ["docs"] }, { component: "", tag: "", groups: { type: "" } })).toBe(true);
    expect(cardMatches({ tags: ["bug", "high"] }, { component: "", tag: "", groups: { type: "bug", priority: "low" } })).toBe(false);
  });
});

describe("Ready column order", () => {
  const mixed = () => [
    card("n1"), // no priority label
    card("lo", ["bug", "low"]),
    card("ur", ["urgent"]),
    card("md", ["medium"]),
    card("hi", ["high"]),
    card("x", ["bug"], "backlog"),
  ];

  it("the rendered Ready column lists urgent, high, medium, low, then unlabelled cards, matching nextReadyCards(board, { track: 'any', batch: n })", () => {
    const board = v2Board(DEFAULT_LABEL_GROUPS, mixed());
    const ids = readyIds(page(board));
    expect(ids).toEqual(["ur", "hi", "md", "lo", "n1"]);
    const next = nextReadyCards(board as any, { track: "any", batch: 50 }).cards.map((c: any) => c.id);
    expect(ids).toEqual(next);
  });

  it("two Ready cards of the same priority keep their board order", () => {
    const board = v2Board(DEFAULT_LABEL_GROUPS, [card("b", ["high"]), card("a", ["high"]), card("c", ["high"]), card("u", ["urgent"])]);
    expect(readyIds(page(board))).toEqual(["u", "b", "a", "c"]);
  });

  it("the rendered Ready column lists an unlabelled card after a low card", () => {
    const board = v2Board(DEFAULT_LABEL_GROUPS, [card("n1"), card("lo", ["low"])]);
    expect(readyIds(page(board))).toEqual(["lo", "n1"]);
  });

  it("applyLiveBoard re-renders the Ready container in priority order (fake document, as board-page.test.ts does)", () => {
    const board = v2Board(DEFAULT_LABEL_GROUPS, [card("n1"), card("lo", ["low"]), card("ur", ["urgent"], "backlog"), card("hi", ["high"], "backlog")]);
    const next = v2Board(DEFAULT_LABEL_GROUPS, [card("n1"), card("lo", ["low"]), card("ur", ["urgent"]), card("hi", ["high"])]);
    const containers: Record<string, { innerHTML: string }> = {};
    const fakeDoc = {
      querySelector(sel: string) {
        const m = sel.match(/data-column="([^"]+)"/);
        if (m) return (containers[m[1]] ||= { innerHTML: "" });
        if (sel === "header .sub") return { innerHTML: "" };
        return null;
      },
    };
    const result = applyLiveBoard(board, next, { record: ".doug/board.json" }, { location: { reload: () => { throw new Error("reloaded"); } }, document: fakeDoc });
    expect(result).toEqual(next);
    const ids = Array.from(containers.ready.innerHTML.matchAll(/data-id="([^"]+)"/g)).map((m) => m[1]);
    expect(ids).toEqual(["ur", "hi", "lo", "n1"]);
  });
});

// ---- card board-page-roadmap: milestone strip, epic and milestone filters (ADR 0016) ----

const ROADMAP_COLUMNS = [
  { id: "decide", title: "Decide" },
  { id: "backlog", title: "Backlog" },
  { id: "ready", title: "Ready" },
  { id: "flow", title: "In flow" },
  { id: "done", title: "Done" },
];

function roadmapCard(id: string, column: string, size: string, extra: Record<string, unknown>) {
  return { id, column, title: `T ${id}`, goal: "g", deps: [], size, track: "flow", tags: [], ...extra };
}

function roadmapBoard(): any {
  return {
    version: 2,
    updated: "2026-01-01",
    columns: ROADMAP_COLUMNS,
    components: [],
    labelGroups: DEFAULT_LABEL_GROUPS,
    epics: [{ id: "ep", title: "Epic one", goal: "g", status: "active" }],
    milestones: [
      { id: "m14", title: "1.4", goal: "g", status: "active", target: { version: "1.4" } },
      { id: "evals", title: "Evals", goal: "g", status: "planned", target: { date: "2026-12-01" } },
    ],
    cards: [
      roadmapCard("a", "done", "S", { class: "code", milestone: "m14", epic: "ep" }),
      roadmapCard("b", "ready", "M", { class: "code", milestone: "m14" }),
      roadmapCard("c", "backlog", "S", { class: "docs", milestone: "m14", epic: "ep" }),
      roadmapCard("d", "done", "L", { milestone: "evals" }),
      roadmapCard("e", "flow", "S", { milestone: "evals" }),
    ],
  };
}

const ROADMAP_LIVE_RUNS = [
  "## 2026-10-01, a: A",
  "",
  "| Field | Value |",
  "|---|---|",
  "| Wall clock | 40 min |",
  "| Cost | $2.50 |",
  "",
  "## 2026-10-02, d: D",
  "",
  "| Field | Value |",
  "|---|---|",
  "| Wall clock | 150 min |",
  "",
].join("\n");

function roadmapPage(board: any, liveRuns: string | null): string {
  return renderBoardPage(board, { mode: "local", record: ".doug/board.json", rollup: rollup(board, liveRuns) } as any);
}

// The visible markup: everything before the page's own scripts.
function markupOf(html: string): string {
  return html.split("<script")[0];
}

function stripItems(html: string): Array<{ id: string; text: string }> {
  return [...markupOf(html).matchAll(/<li class="milestone" data-milestone="([^"]*)">([^<]*)<\/li>/g)].map((m) => ({
    id: m[1],
    text: m[2].replace(/&amp;/g, "&"),
  }));
}

function optionValues(html: string, selectId: string): string[] | null {
  const m = new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`).exec(markupOf(html));
  if (!m) return null;
  return [...m[1].matchAll(/<option value="([^"]*)"/g)].map((o) => o[1]);
}

describe("milestone strip", () => {
  it("milestone strip text for a two-milestone fixture", () => {
    const items = stripItems(roadmapPage(roadmapBoard(), ROADMAP_LIVE_RUNS));
    expect(items).toEqual([
      {
        id: "m14",
        text: "1.4 · target 1.4 · active · 1/3 done · 28% weighted · $2.50 over 1 of 1 Done cards · 40 min wall over 1 of 1 Done cards",
      },
      {
        id: "evals",
        text: "Evals · target 2026-12-01 · planned · 1/2 done · 77% weighted · $0.00 over 0 of 1 Done cards · 150 min wall over 1 of 1 Done cards",
      },
    ]);
  });

  it("leaves the measured parts out without live-runs text", () => {
    const items = stripItems(roadmapPage(roadmapBoard(), null));
    expect(items.map((i) => i.text)).toEqual([
      "1.4 · target 1.4 · active · 1/3 done · 28% weighted",
      "Evals · target 2026-12-01 · planned · 1/2 done · 77% weighted",
    ]);
  });

  it("the milestone strip sits above the columns", () => {
    const html = roadmapPage(roadmapBoard(), null);
    const strip = html.indexOf('id="milestones"');
    const board = html.indexOf('<main class="board"');
    expect(strip).toBeGreaterThan(-1);
    expect(board).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(board);
    expect(strip).toBeLessThan(html.indexOf("<script"));
  });

  it("a version 1 board renders no milestone strip", () => {
    const v1 = {
      version: 1,
      updated: "2026-01-01",
      columns: COLS,
      components: [],
      cards: [{ id: "a", column: "ready", title: "A", goal: "g", deps: [] }],
    };
    expect(markupOf(renderBoardPage(v1 as any, { mode: "local", record: "r" }))).not.toContain('id="milestones"');
    expect(markupOf(renderBoardPage(v1 as any, { mode: "local", record: "r", rollup: rollup(v1 as any, null) } as any))).not.toContain('id="milestones"');
  });
});

describe("epic and milestone filters", () => {
  it("a board with epics and milestones renders epic-filter and milestone-filter", () => {
    const html = roadmapPage(roadmapBoard(), null);
    expect(optionValues(html, "epic-filter")).toEqual(["", "ep"]);
    expect(optionValues(html, "milestone-filter")).toEqual(["", "m14", "evals"]);
    expect(markupOf(html)).toContain(">Epic one</option>");
    expect(markupOf(html)).toContain(">Evals</option>");
  });

  it("a version 1 board renders no epic or milestone filter", () => {
    const v1 = { version: 1, updated: "2026-01-01", columns: COLS, components: [], cards: [] };
    const html = renderBoardPage(v1 as any, { mode: "local", record: "r" });
    expect(optionValues(html, "epic-filter")).toBeNull();
    expect(optionValues(html, "milestone-filter")).toBeNull();
    const noPlan = { ...roadmapBoard(), epics: [], milestones: [], cards: [] };
    const html2 = roadmapPage(noPlan, null);
    expect(optionValues(html2, "epic-filter")).toBeNull();
    expect(optionValues(html2, "milestone-filter")).toBeNull();
  });

  it("cardMatches with an epic or milestone filter", () => {
    const m = cardMatches as unknown as (c: any, f: any) => boolean;
    const inBoth = { epic: "ep", milestone: "m14" };
    const bare = {};
    expect(m(inBoth, { epic: "ep" })).toBe(true);
    expect(m(bare, { epic: "ep" })).toBe(false);
    expect(m({ epic: "other" }, { epic: "ep" })).toBe(false);
    expect(m(inBoth, { milestone: "m14" })).toBe(true);
    expect(m(bare, { milestone: "m14" })).toBe(false);
    expect(m({ milestone: "evals" }, { milestone: "m14" })).toBe(false);
    expect(m(bare, { epic: "", milestone: "" })).toBe(true);
    expect(m(inBoth, { epic: "ep", milestone: "evals" })).toBe(false);
    expect(m(inBoth, { epic: "ep", milestone: "m14" })).toBe(true);
  });

  it("a card article carries data-epic and data-milestone", () => {
    const html = markupOf(roadmapPage(roadmapBoard(), null));
    const art = (id: string) => new RegExp(`<article[^>]*data-id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(art("a")).toContain('data-epic="ep"');
    expect(art("a")).toContain('data-milestone="m14"');
    expect(art("b")).not.toContain("data-epic");
    expect(art("b")).toContain('data-milestone="m14"');
    expect(art("d")).toContain('data-milestone="evals"');
  });
});

// ---- card board-page-done-collapse: latest 20 Done cards, then "show all <n>" (ADR 0016) ----

function doneBoard(n: number) {
  const cards = Array.from({ length: n }, (_, i) => card(`d${i + 1}`, [], "done"));
  return v2Board(DEFAULT_LABEL_GROUPS, [card("r1"), ...cards]);
}

function doneSection(html: string): string {
  return /<section class="col" data-column="done">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
}

function articleIds(sec: string): string[] {
  return Array.from(sec.matchAll(/<article class="card"[^>]*data-id="([^"]+)"/g)).map((m) => m[1]);
}

function showAllButtons(sec: string): string[] {
  return Array.from(sec.matchAll(/<button[^>]*data-show-all="done"[^>]*>([^<]*)<\/button>/g)).map((m) => m[1].trim());
}

function liveContainers(board: any, next: any, opts: any = {}) {
  const containers: Record<string, { innerHTML: string }> = {};
  const fakeDoc = {
    querySelector(sel: string) {
      const m = sel.match(/data-column="([^"]+)"/);
      if (m) return (containers[m[1]] ||= { innerHTML: "" });
      if (sel === "header .sub") return { innerHTML: "" };
      return null;
    },
  };
  applyLiveBoard(board, next, { record: ".doug/board.json" }, { location: { reload: () => { throw new Error("reloaded"); } }, document: fakeDoc, ...opts });
  return containers;
}

describe("Done column collapse", () => {
  const board = doneBoard(25);
  const doneCol = COLS[2];
  const expectedNewest = Array.from({ length: 20 }, (_, i) => `d${25 - i}`);

  it("a 25-Done page renders exactly 20 Done cards", () => {
    expect(articleIds(doneSection(page(board)))).toHaveLength(20);
  });

  it("the 20 rendered Done ids are the newest, d25..d6 in order", () => {
    expect(articleIds(doneSection(page(board)))).toEqual(expectedNewest);
  });

  it("the Done column has one button with text 'show all 25'", () => {
    expect(showAllButtons(doneSection(page(board)))).toEqual(["show all 25"]);
  });

  it("the Done column head count reads 25", () => {
    expect(/<span class="n">(\d+)<\/span>/.exec(doneSection(page(board)))?.[1]).toBe("25");
  });

  it("columnCardsHtml expanded renders all 25 Done cards and no button", () => {
    const html = columnCardsHtml(doneCol, board.cards, COLS, DEFAULT_LABEL_GROUPS, true);
    expect(articleIds(html)).toHaveLength(25);
    expect(articleIds(html)[0]).toBe("d25");
    expect(showAllButtons(html)).toEqual([]);
  });

  it("columnCardsHtml collapsed renders 20 plus the button", () => {
    const html = columnCardsHtml(doneCol, board.cards, COLS, DEFAULT_LABEL_GROUPS, false);
    expect(articleIds(html)).toEqual(expectedNewest);
    expect(showAllButtons(html)).toEqual(["show all 25"]);
  });

  it("a 20-Done page renders 20 cards and no show-all button", () => {
    const sec = doneSection(page(doneBoard(20)));
    expect(articleIds(sec)).toHaveLength(20);
    expect(showAllButtons(sec)).toEqual([]);
    expect(sec).not.toContain("data-show-all");
  });

  it("non-Done columns never get a show-all button", () => {
    const html = page(board);
    expect(/<section class="col" data-column="ready">([\s\S]*?)<\/section>/.exec(html)?.[1]).not.toContain("data-show-all");
  });

  it("doneHiddenCount is 5 for 25 Done, 0 for 20, and counts only matching older cards under a filter", () => {
    expect(doneHiddenCount(board.cards, {})).toBe(5);
    expect(doneHiddenCount(doneBoard(20).cards, {})).toBe(0);
    const tagged = doneBoard(25).cards.map((c: any) => (c.id === "d2" ? { ...c, tags: ["zz"] } : c));
    expect(doneHiddenCount(tagged, { tag: "zz" })).toBe(1);
    expect(doneHiddenCount(tagged, { tag: "nomatch" })).toBe(0);
  });

  it("applyLiveBoard keeps Done collapsed by default and expands with doneExpanded", () => {
    const collapsed = liveContainers(board, board);
    expect(articleIds(collapsed.done.innerHTML)).toEqual(expectedNewest);
    expect(showAllButtons(collapsed.done.innerHTML)).toEqual(["show all 25"]);
    const expanded = liveContainers(board, board, { doneExpanded: true });
    expect(articleIds(expanded.done.innerHTML)).toHaveLength(25);
    expect(showAllButtons(expanded.done.innerHTML)).toEqual([]);
  });

  it("the embedded board-data record keeps all 25 Done cards", () => {
    const m = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(page(board));
    expect(m).not.toBeNull();
    const data = JSON.parse(m![1].replace(/\\u003c/gi, "<"));
    expect(data.cards.filter((c: any) => c.column === "done")).toHaveLength(25);
  });
});

// ---- card board-ready-priority-reorder: bands, version 1 Ready order, the Ready hint ----

describe("priorityBandMove", () => {
  const groups = DEFAULT_LABEL_GROUPS;
  const cards = [
    card("hi1", ["high"]),
    card("hi2", ["high"]),
    card("lo", ["low"]),
    card("bug-hi", ["bug", "high"]),
    card("none", []),
    card("bk-hi", ["high"], "backlog"),
    card("bk-lo", ["low"], "backlog"),
  ];
  const mv = (id: string, column: string, target: string, g: any = groups) => priorityBandMove(cards, g, id, column, target);

  it("returns 'place' for two Ready cards of the same priority", () => {
    expect(mv("hi1", "ready", "hi2")).toBe("place");
  });
  it("returns 'refuse' for a Ready card moved onto a Ready card of another priority", () => {
    expect(mv("hi1", "ready", "lo")).toBe("refuse");
    expect(mv("lo", "ready", "hi1")).toBe("refuse");
  });
  it("returns 'column' for a Backlog card dropped on a Ready card of another priority, and 'place' for one of the same priority", () => {
    expect(mv("bk-lo", "ready", "hi1")).toBe("column");
    expect(mv("bk-hi", "ready", "hi1")).toBe("place");
  });
  it("returns 'place' for a Ready card tagged ['bug','high'] moved before one tagged ['high']", () => {
    expect(mv("bug-hi", "ready", "hi1")).toBe("place");
  });
  it("returns 'refuse' for an unlabelled Ready card moved before a low card", () => {
    expect(mv("none", "ready", "lo")).toBe("refuse");
  });
  it("returns 'place' for any move outside Ready", () => {
    expect(priorityBandMove([card("a", ["high"], "backlog"), card("b", ["low"], "backlog")], groups, "a", "backlog", "b")).toBe("place");
  });
  it("returns 'place' on a board with no labelGroups even when the two Ready cards carry different priority tags", () => {
    expect(mv("hi1", "ready", "lo", null)).toBe("place");
    expect(mv("hi1", "ready", "lo", [])).toBe("place");
  });
  it("returns 'place' for a missing card or target", () => {
    expect(mv("ghost", "ready", "lo")).toBe("place");
    expect(mv("hi1", "ready", "ghost")).toBe("place");
  });
});

describe("version 1 board Ready order (R1)", () => {
  it("a version 1 board whose Ready cards are tagged low, urgent, high renders Ready in record order, matching nextReadyCards", () => {
    const board = { version: 1, updated: "2026-01-01", columns: COLS, components: [], cards: [card("c1", ["low"]), card("c2", ["urgent"]), card("c3", ["high"])] };
    const ids = readyIds(page(board));
    expect(ids).toEqual(["c1", "c2", "c3"]);
    expect(nextReadyCards(board as any, { track: "any", batch: 3 }).cards.map((c: any) => c.id)).toEqual(ids);
  });
});

describe("Ready column hint", () => {
  const readyHint = (html: string) => /<section class="col" data-column="ready">[\s\S]*?<div class="col-hint">([^<]*)<\/div>/.exec(html)?.[1] ?? "";
  const cols = [{ id: "backlog", title: "Backlog" }, { id: "ready", title: "Ready", hint: "next up" }, { id: "done", title: "Done" }];

  it("on a board with a priority group, the Ready column's .col-hint contains READY_COL_HINT", () => {
    expect(typeof READY_COL_HINT).toBe("string");
    expect(READY_COL_HINT).toContain("priority");
    const board = { ...v2Board(DEFAULT_LABEL_GROUPS, [card("a", ["high"])]), columns: cols };
    expect(readyHint(page(board))).toContain(READY_COL_HINT as string);
    expect(readyHint(page(board))).toContain("next up");
  });
  it("on a version 1 board, the Ready column's .col-hint equals the column's own hint and does not contain READY_COL_HINT", () => {
    expect(typeof READY_COL_HINT).toBe("string");
    const board = { version: 1, updated: "2026-01-01", columns: cols, components: [], cards: [card("a", ["high"])] };
    const hint = readyHint(page(board));
    expect(hint).toBe("next up");
    expect(hint).not.toContain(READY_COL_HINT as string);
  });
});
