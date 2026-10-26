import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../lib/memory.mjs";
import { openMemory, addLesson, supersedeLesson, writeRunHistory } from "../lib/memory.mjs";
import { newBoard, addCard, saveBoard, loadBoard } from "../lib/board.mjs";

// Card memory-idea-proposals (ADR 0019 L3): `memory.mjs ideas [dir] [--claude-bin] [--model] [--max-usd] [--cap] [--dry-run] [--json]`
// files cited idea cards to Backlog and cited priority-review proposals to a jsonl file. Never a real model call.

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "memory.mjs");
const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
const tempDir = () => mkdtempSync(join(tmpdir(), "doug-memory-ideas-"));
const GHOST = "0123456789abcdef";
const REVIEWS_REL = join(".doug", ".state", "memory", "priority-reviews.jsonl");

function baseBoard() {
  let b = newBoard({ date: "2026-10-01" });
  b = { ...b, components: ["memory", "gates"] };
  const add = (id, column) => {
    b = addCard(b, { id, title: `Title ${id}`, goal: `Goal ${id}`, component: "memory", size: "S", track: "hand", column });
  };
  add("r1", "ready");
  add("bk1", "backlog");
  add("r2", "ready");
  add("bk2", "backlog");
  add("d1", "done");
  return b;
}

function seed(dir, { withBoard = true } = {}) {
  const m = openMemory(dir);
  let ids;
  try {
    const a = addLesson(m, { text: "Orphaned vitest workers hang the stop gate until the group is killed", kind: "pitfall", citation: "a.md", source: { agent: "t" } });
    const b = addLesson(m, { text: "Seed mutation fixtures from a real record so they bite", kind: "pattern", citation: "b.md", source: { agent: "t" } });
    const old = addLesson(m, { text: "Superseded advice about the old gate runner", kind: "pattern", citation: "old.md", source: { agent: "t" } });
    const fresh = addLesson(m, { text: "Current advice about the gate runner", kind: "pattern", citation: "fresh.md", source: { agent: "t" } });
    supersedeLesson(m, old.id, fresh.id);
    ids = { a, b, old, fresh };
  } finally {
    m.close();
  }
  writeRunHistory(dir, {
    card: "c1",
    run: "wf_1",
    scan: () => null,
    entries: [1, 2, 3].map((n) => ({ kind: "hand-back", seat: "lead", round: n, source: "journal.jsonl", value: `entry ${n}` })),
  });
  // one pitfall occurrence
  mkdirSync(join(dir, ".doug", ".state", "memory"), { recursive: true });
  writeFileSync(
    join(dir, lib.PITFALL_LEDGER_RELPATH),
    JSON.stringify({ lesson: ids.a.id, citation: "pitfall-citation-xyz", card: "c1", run: "wf_1", session: "s1" }) + "\n",
    "utf8"
  );
  if (withBoard) saveBoard(dir, baseBoard());
  return ids;
}

function fakeClaude(dir, envelope) {
  const scriptPath = join(dir, "fake-claude-ideas.mjs");
  const marker = join(dir, "called.txt");
  writeFileSync(
    scriptPath,
    "#!/usr/bin/env node\n" +
      'import { readFileSync, writeFileSync } from "node:fs";\n' +
      `writeFileSync(${JSON.stringify(marker)}, "called");\n` +
      `writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));\n` +
      `writeFileSync(${JSON.stringify(join(dir, "prompt.txt"))}, readFileSync(0, "utf8"));\n` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`,
    "utf8"
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
const envelope = (ideas, reviews = []) => ({ structured_output: { ideas, reviews }, session_id: "sess-ideas", total_cost_usd: 0.0123, is_error: false });
const idea = (id, citations, extra = {}) => ({ id, title: `Idea ${id}`, goal: `Fix the recurring problem ${id}.`, component: "memory", size: "S", citations, ...extra });
const review = (text, cards, citations) => ({ text, cards, citations });
const ideas = (dir, bin, extra = []) => run(["ideas", dir, "--claude-bin", bin, ...extra], dir);
const called = (dir) => existsSync(join(dir, "called.txt"));

describe("lib: constants and schema", () => {
  it("IDEA_CAP is 3 and the reviews file lives under .doug/.state/memory", () => {
    expect(lib.IDEA_CAP).toBe(3);
    expect(lib.PRIORITY_REVIEWS_RELPATH).toBe(".doug/.state/memory/priority-reviews.jsonl");
  });

  it("IDEAS_SCHEMA requires ideas and reviews, with cited items and no column, deps, milestone or order field", () => {
    const s = lib.IDEAS_SCHEMA;
    expect(s.type).toBe("object");
    expect([...s.required].sort()).toEqual(["ideas", "reviews"]);
    const item = s.properties.ideas.items;
    for (const k of ["id", "title", "goal", "component", "size", "citations"]) expect(item.properties).toHaveProperty(k);
    expect(item.properties.citations.minItems).toBe(1);
    for (const k of ["column", "deps", "milestone", "order"]) expect(item.properties).not.toHaveProperty(k);
    const rv = s.properties.reviews.items;
    for (const k of ["text", "cards", "citations"]) expect(rv.properties).toHaveProperty(k);
    expect(rv.properties.cards.minItems).toBe(1);
    expect(rv.properties.citations.minItems).toBe(1);
  });
});

describe("lib: checkIdeaCitations (M4, M5)", () => {
  it("M4: a ghost id and a superseded lesson are dropped; a live lesson and a real history ref are kept", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const m = openMemory(dir);
      try {
        const items = [
          idea("live", [ids.a.id]),
          idea("ghost", [GHOST]),
          idea("old", [ids.old.id]),
          idea("hist", ["c1/wf_1:2"]),
          idea("badhist", ["c1/wf_9"]),
          idea("mixed", [ids.a.id, GHOST]),
        ];
        const { kept, dropped } = lib.checkIdeaCitations(m, dir, items);
        expect(kept.map((i) => i.id)).toEqual(["live", "hist"]);
        expect(dropped).toHaveLength(4);
      } finally {
        m.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M5: an idea with an empty citations array is dropped", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const m = openMemory(dir);
      try {
        const { kept, dropped } = lib.checkIdeaCitations(m, dir, [idea("nocite", [])]);
        expect(kept).toEqual([]);
        expect(dropped).toHaveLength(1);
      } finally {
        m.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lib: fileIdeaCards (M1, M2, M3, M6, M7)", () => {
  const cite = ["aaaaaaaaaaaaaaaa", "c1/wf_1"];
  const five = () => ["i1", "i2", "i3", "i4", "i5"].map((id) => idea(id, cite));

  it("M1: with the default cap, 3 are filed in input order and the rest are skipped as over cap", () => {
    const r = lib.fileIdeaCards(baseBoard(), five(), { date: "2026-10-21" });
    expect(r.filed).toEqual(["i1", "i2", "i3"]);
    expect(r.skipped).toEqual([
      { id: "i4", reason: "over cap" },
      { id: "i5", reason: "over cap" },
    ]);
    expect(r.board.cards.filter((c) => c.id.startsWith("i"))).toHaveLength(3);
  });

  it("M1: an explicit cap of 1 files one", () => {
    const r = lib.fileIdeaCards(baseBoard(), five(), { cap: 1, date: "2026-10-21" });
    expect(r.filed).toEqual(["i1"]);
    expect(r.skipped.map((s) => s.id)).toEqual(["i2", "i3", "i4", "i5"]);
  });

  it("M2: an idea carrying column ready (or any other column field) is still filed to backlog, track hand, no deps", () => {
    const before = baseBoard();
    const readyBefore = before.cards.filter((c) => c.column === "ready").length;
    const r = lib.fileIdeaCards(before, [idea("sneaky", cite, { column: "ready", deps: ["r1"], track: "flow" })], { date: "2026-10-21" });
    const card = r.board.cards.find((c) => c.id === "sneaky");
    expect(card.column).toBe("backlog");
    expect(card.track).toBe("hand");
    expect(card.deps).toEqual([]);
    expect(r.board.cards.filter((c) => c.column === "ready")).toHaveLength(readyBefore);
  });

  it("M3: existing cards keep content and order, ready order is identical, new cards are appended", () => {
    const before = baseBoard();
    const snapshot = JSON.parse(JSON.stringify(before.cards));
    const r = lib.fileIdeaCards(before, five(), { date: "2026-10-21" });
    expect(r.board.cards.slice(0, snapshot.length)).toEqual(snapshot);
    expect(r.board.cards.slice(snapshot.length).map((c) => c.id)).toEqual(["i1", "i2", "i3"]);
    expect(r.board.cards.filter((c) => c.column === "ready").map((c) => c.id)).toEqual(["r1", "r2"]);
    expect(before.cards).toEqual(snapshot); // the input is not mutated
  });

  it("M6: the card's source starts memory-proposed and its goal carries the date, the idea goal and each citation", () => {
    const r = lib.fileIdeaCards(baseBoard(), [idea("one", cite)], { date: "2026-10-21" });
    const card = r.board.cards.find((c) => c.id === "one");
    expect(card.source).toBe(`memory-proposed: ${cite.join(", ")}`);
    expect(card.goal.startsWith("Memory-proposed (memory.mjs ideas, 2026-10-21)")).toBe(true);
    expect(card.goal).toContain("Fix the recurring problem one.");
    for (const c of cite) expect(card.goal).toContain(c);
    expect(card.title).toBe("Idea one");
    expect(card.component).toBe("memory");
    expect(card.size).toBe("S");
  });

  it("M7: a duplicate id and an unknown component are skipped with the error as reason, never count against the cap, and do not throw", () => {
    const list = [
      idea("r1", cite), // existing card id
      idea("bad-comp", cite, { component: "nonsense" }),
      idea("good-a", cite),
      idea("good-b", cite),
      idea("good-c", cite),
      idea("good-d", cite),
    ];
    let r;
    expect(() => (r = lib.fileIdeaCards(baseBoard(), list, { cap: 3, date: "2026-10-21" }))).not.toThrow();
    expect(r.filed).toEqual(["good-a", "good-b", "good-c"]);
    const byId = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
    expect(Object.keys(byId).sort()).toEqual(["bad-comp", "good-d", "r1"]);
    expect(byId["good-d"]).toBe("over cap");
    expect(byId["r1"]).not.toBe("over cap");
    expect(typeof byId["r1"]).toBe("string");
    expect(byId["r1"].length).toBeGreaterThan(0);
    expect(byId["bad-comp"]).not.toBe("over cap");
    expect(byId["bad-comp"]).toMatch(/nonsense|component/);
  });
});

describe("lib: checkPriorityReviews (M8)", () => {
  it("keeps a review only when every named card is in backlog; ready, done and unknown ids drop it", () => {
    const board = baseBoard();
    const reviews = [
      review("two backlog cards share a pitfall", ["bk1", "bk2"], ["c1/wf_1"]),
      review("names a ready card", ["bk1", "r1"], ["c1/wf_1"]),
      review("names an unknown card", ["nope"], ["c1/wf_1"]),
      review("names a done card", ["d1"], ["c1/wf_1"]),
    ];
    const { kept, dropped } = lib.checkPriorityReviews(board, reviews);
    expect(kept.map((r) => r.text)).toEqual(["two backlog cards share a pitfall"]);
    expect(dropped).toHaveLength(3);
  });

  it("keeps at most cap reviews and never changes the board", () => {
    const board = baseBoard();
    const snap = JSON.stringify(board);
    const reviews = ["a", "b", "c"].map((t) => review(t, ["bk1"], ["c1/wf_1"]));
    const { kept } = lib.checkPriorityReviews(board, reviews, { cap: 2 });
    expect(kept).toHaveLength(2);
    expect(JSON.stringify(board)).toBe(snap);
  });
});

describe("lib: buildIdeasPrompt (M10)", () => {
  it("carries live lessons, run refs, pitfall occurrences, existing card ids and the follow-up threshold; omits superseded lessons", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const m = openMemory(dir);
      let prompt;
      try {
        prompt = lib.buildIdeasPrompt({
          lessons: lib.listLessons(m),
          runs: lib.listRunHistoryRefs(dir),
          pitfalls: lib.readPitfallOccurrences(dir),
          cards: baseBoard().cards.filter((c) => c.column === "backlog" || c.column === "ready"),
        });
      } finally {
        m.close();
      }
      expect(prompt).toContain(ids.a.id);
      expect(prompt).toContain("c1/wf_1");
      expect(prompt).toContain("pitfall-citation-xyz");
      expect(prompt).toContain("bk1");
      expect(prompt).toContain("Title bk1");
      expect(prompt).toContain("realistic drift");
      expect(prompt).not.toContain(ids.old.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs ideas (CLI)", () => {
  it("spawns claude with the schema, the cheap-tier model and the 0.5 budget; files only cited ideas, capped, to Backlog; the prompt carries the inputs (M1, M4, M5, M10)", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const bin = fakeClaude(
        dir,
        envelope([
          idea("n1", [ids.a.id]),
          idea("ghost", [GHOST]),
          idea("n2", ["c1/wf_1"]),
          idea("old", [ids.old.id]),
          idea("nocite", []),
          idea("n3", [ids.b.id]),
          idea("n4", [ids.b.id]),
        ])
      );
      const before = readFileSync(join(dir, ".doug", "board.json"), "utf8");
      const res = ideas(dir, bin);
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
      expect(args).toContain("-p");
      expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(lib.IDEAS_SCHEMA);
      expect(args[args.indexOf("--model") + 1]).toBe("haiku");
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
      const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
      expect(prompt).toContain(ids.a.id);
      expect(prompt).toContain("c1/wf_1");
      expect(prompt).toContain("pitfall-citation-xyz");
      expect(prompt).toContain("bk1");
      expect(prompt).toContain("realistic drift");
      expect(prompt).not.toContain(ids.old.id);

      const board = loadBoard(dir);
      const origIds = JSON.parse(before).cards.map((c) => c.id);
      expect(board.cards.slice(0, origIds.length).map((c) => c.id)).toEqual(origIds);
      const added = board.cards.slice(origIds.length);
      expect(added.map((c) => c.id)).toEqual(["n1", "n2", "n3"]); // ghost, old, nocite dropped; n4 over cap
      for (const c of added) {
        expect(c.column).toBe("backlog");
        expect(c.source.startsWith("memory-proposed")).toBe(true);
      }
      expect(res.stdout).toContain("n1");
      expect(res.stdout).toContain("n4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M1: --cap 1 files one card", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const bin = fakeClaude(dir, envelope([idea("n1", [ids.a.id]), idea("n2", [ids.a.id]), idea("n3", [ids.a.id])]));
      const res = ideas(dir, bin, ["--cap", "1"]);
      expect(res.status, res.stderr).toBe(0);
      const board = loadBoard(dir);
      expect(board.cards.length).toBe(baseBoard().cards.length + 1);
      expect(board.cards.some((c) => c.id === "n1")).toBe(true);
      expect(board.cards.some((c) => c.id === "n2")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M2: an idea with column ready from the model is filed to backlog; the ready cards are unchanged", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const bin = fakeClaude(dir, envelope([idea("sneaky", [ids.a.id], { column: "ready" })]));
      const res = ideas(dir, bin);
      expect(res.status, res.stderr).toBe(0);
      const board = loadBoard(dir);
      expect(board.cards.find((c) => c.id === "sneaky").column).toBe("backlog");
      expect(board.cards.filter((c) => c.column === "ready").map((c) => c.id)).toEqual(["r1", "r2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M7: a duplicate or invalid idea is skipped and the pass goes on", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const bin = fakeClaude(dir, envelope([idea("r1", [ids.a.id]), idea("bad", [ids.a.id], { component: "nonsense" }), idea("ok", [ids.a.id])]));
      const res = ideas(dir, bin);
      expect(res.status, res.stderr).toBe(0);
      const board = loadBoard(dir);
      expect(board.cards.some((c) => c.id === "ok")).toBe(true);
      expect(board.cards.some((c) => c.id === "bad")).toBe(false);
      expect(res.stdout).toContain("bad");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M8: appends exactly the kept review to priority-reviews.jsonl and changes no card other than the filed ideas", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const before = JSON.parse(readFileSync(join(dir, ".doug", "board.json"), "utf8")).cards;
      const bin = fakeClaude(
        dir,
        envelope(
          [idea("n1", [ids.a.id])],
          [
            review("bk1 and bk2 share the orphaned-worker pitfall", ["bk1", "bk2"], [ids.a.id]),
            review("promote r1 first", ["r1"], [ids.a.id]),
            review("names an unknown card", ["nope"], [ids.a.id]),
            review("uncited", ["bk1"], [GHOST]),
          ]
        )
      );
      const res = ideas(dir, bin);
      expect(res.status, res.stderr).toBe(0);
      const lines = readFileSync(join(dir, REVIEWS_REL), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toBe("bk1 and bk2 share the orphaned-worker pitfall");
      expect(lines[0].cards).toEqual(["bk1", "bk2"]);
      expect(lines[0].citations).toEqual([ids.a.id]);
      expect(typeof lines[0].at).toBe("string");
      const after = loadBoard(dir).cards;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length).map((c) => c.id)).toEqual(["n1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F1: a board edit made while the model call runs survives the pass, and reviews are checked against the fresh board", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const boardFile = join(dir, ".doug", "board.json");
      const bin = fakeClaude(dir, envelope([idea("n1", [ids.a.id])], [review("bk1 and bk2 belong together", ["bk1", "bk2"], [ids.a.id])]));
      const wrapper = join(dir, "racing-claude.mjs");
      writeFileSync(
        wrapper,
        "#!/usr/bin/env node\n" +
          'import { readFileSync, writeFileSync } from "node:fs";\n' +
          'import { spawnSync } from "node:child_process";\n' +
          `const f = ${JSON.stringify(boardFile)};\n` +
          "const b = JSON.parse(readFileSync(f, 'utf8'));\n" +
          "b.cards.find((c) => c.id === 'bk1').column = 'ready';\n" +
          "writeFileSync(f, JSON.stringify(b, null, 2));\n" +
          `const r = spawnSync(${JSON.stringify(bin)}, process.argv.slice(2), { input: readFileSync(0), encoding: "utf8" });\n` +
          "process.stdout.write(r.stdout);\n",
        "utf8"
      );
      chmodSync(wrapper, 0o755);
      const res = ideas(dir, wrapper);
      expect(res.status, res.stderr).toBe(0);
      const cards = loadBoard(dir).cards;
      expect(cards.find((c) => c.id === "bk1").column).toBe("ready");
      expect(cards.some((c) => c.id === "n1")).toBe(true);
      expect(existsSync(join(dir, REVIEWS_REL))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Card memory-dry-run-no-model-call: --dry-run never calls the model; it prints the prompt and what it would write.
  const mustNotRun = (dir) => {
    const scriptPath = join(dir, "fake-claude-must-not-run.mjs");
    const marker = join(dir, "claude-was-called.marker");
    writeFileSync(
      scriptPath,
      "#!/usr/bin/env node\n" +
        'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(marker)}, "called");\n` +
        "process.exit(7);\n",
      "utf8"
    );
    chmodSync(scriptPath, 0o755);
    return { bin: scriptPath, marker };
  };

  it("M9: --dry-run never spawns the claude bin, leaves board.json byte-identical, creates no reviews file, and prints the prompt and the files it would write", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const boardFile = join(dir, ".doug", "board.json");
      const before = readFileSync(boardFile, "utf8");
      const { bin, marker } = mustNotRun(dir);
      const res = ideas(dir, bin, ["--dry-run"]);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(boardFile, "utf8")).toBe(before);
      expect(existsSync(join(dir, REVIEWS_REL))).toBe(false);
      expect(res.stdout).toContain("propose follow-up work for its user");
      expect(res.stdout).toContain(ids.a.id);
      expect(res.stdout).toContain(".doug/board.json");
      expect(res.stdout).toContain(".doug/.state/memory/priority-reviews.jsonl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--json prints { filed, skipped, reviews, droppedReviews, unresolved, usd, usdSource, dryRun }", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const bin = fakeClaude(
        dir,
        envelope([idea("n1", [ids.a.id]), idea("ghost", [GHOST])], [review("pair", ["bk1", "bk2"], [ids.a.id]), review("bad", ["r1"], [ids.a.id])])
      );
      const res = ideas(dir, bin, ["--json"]);
      expect(res.status, res.stderr).toBe(0);
      const j = JSON.parse(res.stdout);
      expect(Object.keys(j).sort()).toEqual(["droppedReviews", "dryRun", "filed", "reviews", "skipped", "unresolved", "usd", "usdSource"]);
      expect(j.dryRun).toBe(false);
      expect(j.usd).toBeCloseTo(0.0123, 4);
      expect(JSON.stringify(j.filed)).toContain("n1");
      expect(JSON.stringify(j.reviews)).toContain("pair");
      expect(JSON.stringify(j.droppedReviews)).toContain("bad");
      expect(JSON.stringify(j.unresolved)).toContain("ghost");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--json --dry-run never spawns the claude bin and carries the prompt, usd 0 and dryRun true", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const { bin, marker } = mustNotRun(dir);
      const res = ideas(dir, bin, ["--json", "--dry-run"]);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const j = JSON.parse(res.stdout);
      expect(j.dryRun).toBe(true);
      expect(j.usd).toBe(0);
      expect(j.prompt).toContain("propose follow-up work for its user");
      expect(j.prompt).toContain(ids.a.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M11: a dir with a memory store but no board exits 1 before any model call", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir, { withBoard: false });
      const bin = fakeClaude(dir, envelope([idea("n1", [ids.a.id])]));
      const res = ideas(dir, bin);
      expect(res.status).toBe(1);
      expect(called(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M11: a dir with a board but no memory store exits 1 before any model call", () => {
    const dir = tempDir();
    try {
      saveBoard(dir, baseBoard());
      const bin = fakeClaude(dir, envelope([idea("n1", ["c1/wf_1"])]));
      const res = ideas(dir, bin);
      expect(res.status).toBe(1);
      expect(called(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M12: --cap 0, --cap 1.5 and --cap x each exit 2 with usage on stderr and no model call", () => {
    for (const bad of ["0", "1.5", "x"]) {
      const dir = tempDir();
      try {
        const ids = seed(dir);
        const bin = fakeClaude(dir, envelope([idea("n1", [ids.a.id])]));
        const res = ideas(dir, bin, ["--cap", bad]);
        expect(res.status, `--cap ${bad}`).toBe(2);
        expect(res.stderr).toContain("usage");
        expect(res.stderr).toContain("--cap");
        expect(called(dir)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("a model-call failure exits 1 and writes neither the board nor the reviews file", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const boardFile = join(dir, ".doug", "board.json");
      const before = readFileSync(boardFile, "utf8");
      const bin = fakeClaude(dir, { ...envelope([idea("n1", [ids.a.id])]), is_error: true });
      const res = ideas(dir, bin);
      expect(res.status).toBe(1);
      expect(readFileSync(boardFile, "utf8")).toBe(before);
      expect(existsSync(join(dir, REVIEWS_REL))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M13: the usage header of scripts/memory.mjs and docs/memory.md document the subcommand", () => {
    const lines = readFileSync(script, "utf8").split("\n").slice(1);
    const header = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).join("\n");
    expect(header).toContain("memory.mjs ideas");
    expect(header).toContain("--cap");
    const doc = readFileSync(join(here, "..", "..", "..", "docs", "memory.md"), "utf8");
    expect(doc).toContain("## memory.mjs ideas");
    expect(doc).toContain("priority-reviews.jsonl");
  });
});

describe("card memory-ideas-id-and-review-dedupe: lib", () => {
  const cite = ["aaaaaaaaaaaaaaaa", "c1/wf_1"];
  const BAD = ["Probe Bad Id", "UPPER-case", "snake_case", "trailing-", "a--b"];

  it("R1: non-kebab ids are skipped with a kebab reason and never count against the cap; kebab ids are still filed", () => {
    const items = [...BAD, "good-a1", "good-b"].map((id) => idea(id, cite));
    const r = lib.fileIdeaCards(baseBoard(), items, { cap: 2, date: "2026-10-21" });
    expect(r.filed).toEqual(["good-a1", "good-b"]);
    for (const id of BAD) {
      const s = r.skipped.find((x) => x.id === id);
      expect(s, id).toBeTruthy();
      expect(s.reason).toMatch(/kebab/);
      expect(r.board.cards.some((c) => c.id === id)).toBe(false);
    }
  });

  it("R2: a review identical (same card set, same text) to a recorded one is dropped; different text or cards is kept", () => {
    const recorded = [{ text: "pair", cards: ["bk2", "bk1"] }];
    const reviews = [
      review("pair", ["bk1", "bk2"], ["c1/wf_1"]),
      review("pair", ["bk1"], ["c1/wf_1"]),
      review("other text", ["bk1", "bk2"], ["c1/wf_1"]),
    ];
    const { kept, dropped } = lib.checkPriorityReviews(baseBoard(), reviews, { recorded });
    expect(kept.map((r) => r.text + "|" + r.cards.join(","))).toEqual(["pair|bk1", "other text|bk1,bk2"]);
    expect(dropped).toHaveLength(1);
    expect(JSON.stringify(dropped)).toMatch(/already recorded/);
  });

  it("R2: an already-recorded review does not count against the cap", () => {
    const recorded = [{ text: "dup", cards: ["bk1"] }];
    const { kept } = lib.checkPriorityReviews(baseBoard(), [review("dup", ["bk1"], ["c1/wf_1"]), review("new", ["bk1"], ["c1/wf_1"])], { cap: 1, recorded });
    expect(kept.map((r) => r.text)).toEqual(["new"]);
  });

  it("R2: two identical reviews in one call keep one", () => {
    const r = review("same", ["bk1"], ["c1/wf_1"]);
    const { kept, dropped } = lib.checkPriorityReviews(baseBoard(), [r, { ...r }]);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(dropped)).toMatch(/already recorded/);
  });

  it("readPriorityReviews returns [] for a missing file and skips malformed lines", () => {
    const dir = tempDir();
    try {
      expect(lib.readPriorityReviews(dir)).toEqual([]);
      mkdirSync(join(dir, ".doug", ".state", "memory"), { recursive: true });
      writeFileSync(join(dir, REVIEWS_REL), "not json\n\n" + JSON.stringify({ text: "t", cards: ["bk1"] }) + "\n", "utf8");
      const got = lib.readPriorityReviews(dir);
      expect(got).toHaveLength(1);
      expect(got[0].text).toBe("t");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("card memory-ideas-id-and-review-dedupe: CLI", () => {
  const reviewLines = (dir) => readFileSync(join(dir, REVIEWS_REL), "utf8").split("\n").filter(Boolean);

  it("R1: a non-kebab idea is skipped and printed, a kebab idea is filed, exit 0", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const bin = fakeClaude(dir, envelope([idea("Probe Bad Id", [ids.a.id]), idea("ok-1", [ids.a.id])]));
      const res = ideas(dir, bin);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("skipped Probe Bad Id");
      expect(res.stdout).toContain("kebab");
      const cardIds = loadBoard(dir).cards.map((c) => c.id);
      expect(cardIds).toContain("ok-1");
      expect(cardIds).not.toContain("Probe Bad Id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R2: rerunning with the same review records it once; a new review is still appended", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const r1 = review("bk1 and bk2 share the pitfall", ["bk1", "bk2"], [ids.a.id]);
      const bin = fakeClaude(dir, envelope([], [r1]));
      expect(ideas(dir, bin).status).toBe(0);
      expect(ideas(dir, bin).status).toBe(0);
      expect(reviewLines(dir)).toHaveLength(1);
      const bin2 = fakeClaude(dir, envelope([], [r1, review("a different review", ["bk1"], [ids.a.id])]));
      const res = ideas(dir, bin2);
      expect(res.status, res.stderr).toBe(0);
      const lines = reviewLines(dir).map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[1].text).toBe("a different review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R2: a garbage line in priority-reviews.jsonl does not break the pass and the duplicate is still dropped", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const r1 = review("bk1 and bk2 share the pitfall", ["bk1", "bk2"], [ids.a.id]);
      mkdirSync(join(dir, ".doug", ".state", "memory"), { recursive: true });
      writeFileSync(join(dir, REVIEWS_REL), "{garbage\n" + JSON.stringify({ at: "x", text: r1.text, cards: r1.cards, citations: r1.citations }) + "\n", "utf8");
      const bin = fakeClaude(dir, envelope([], [r1]));
      const res = ideas(dir, bin);
      expect(res.status, res.stderr).toBe(0);
      expect(reviewLines(dir)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
