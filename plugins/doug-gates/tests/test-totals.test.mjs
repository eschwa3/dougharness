import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripAnsi, parseTotals, compareTotals, deltaTotals, parseWaiver, waiverCovers, validTotals, readSummaries, sumTotals } from "../lib/test-totals.mjs";

// Card test-count-ratchet, the pure module. Every expectation follows from the card goal or decisions D3-D8 of
// .doug/.state/briefs/test-count-ratchet.md; the vitest lines are the ones quoted in
// .doug/.state/research/test-count-ratchet.md.
//
// Export shapes these tests pin (the brief leaves names open):
//   stripAnsi(text) -> string
//   parseTotals(output) -> { status: "ok", summaries: [{ total, skipped, todo }, ...], totals: <their sum> }
//                        | { status: "none" }                                  (no parseable Tests summary)
//   (card ratchet-per-package-runner / ADR 0013: the old "conflict" status is gone; see the new describe at the end)
//   compareTotals(baseline, now) -> [{ kind: "total" | "skipped" | "todo", baseline, now }, ...]  (empty: no problem)
//   deltaTotals(baseline, now) -> { total, skipped, todo }                     (now minus baseline)
//   parseWaiver(line) -> { total, skipped, todo, reason } | null
//   waiverCovers(sources, delta) -> boolean   (sources: array of strings, each may hold several lines)

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("removes colour codes and leaves the text", () => {
    expect(stripAnsi(`${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m3 passed${ESC}[39m${ESC}[22m${ESC}[90m (3)${ESC}[39m`)).toBe("      Tests  3 passed (3)");
  });
});

describe("parseTotals (D4, research note line format)", () => {
  it("reads the plain one-segment line", () => {
    expect(parseTotals(" Test Files  1 passed (1)\n      Tests  3 passed (3)\n")).toEqual({ status: "ok", summaries: [{ total: 3, skipped: 0, todo: 0 }], totals: { total: 3, skipped: 0, todo: 0 } });
  });
  it("reads all four segments; total is N, which includes skipped and todo", () => {
    expect(parseTotals("      Tests  1 failed | 2 passed | 3 skipped | 1 todo (7)\n")).toEqual({ status: "ok", summaries: [{ total: 7, skipped: 3, todo: 1 }], totals: { total: 7, skipped: 3, todo: 1 } });
  });
  it("counts an absent skipped or todo segment as 0", () => {
    expect(parseTotals("      Tests  2 failed | 1 passed (3)\n")).toEqual({ status: "ok", summaries: [{ total: 3, skipped: 0, todo: 0 }], totals: { total: 3, skipped: 0, todo: 0 } });
    expect(parseTotals("      Tests  4 passed | 2 todo (6)\n")).toEqual({ status: "ok", summaries: [{ total: 6, skipped: 0, todo: 2 }], totals: { total: 6, skipped: 0, todo: 2 } });
    expect(parseTotals("      Tests  4 passed | 2 skipped (6)\n")).toEqual({ status: "ok", summaries: [{ total: 6, skipped: 2, todo: 0 }], totals: { total: 6, skipped: 2, todo: 0 } });
  });
  it("takes the total from the parenthesised N even when the segments do not sum to it", () => {
    expect(parseTotals("      Tests  2 passed (9)\n")).toEqual({ status: "ok", summaries: [{ total: 9, skipped: 0, todo: 0 }], totals: { total: 9, skipped: 0, todo: 0 } });
  });
  it("reads the line when vitest coloured it (ANSI inside the title, segments and total)", () => {
    const coloured = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m3 passed${ESC}[39m${ESC}[22m${ESC}[90m (3)${ESC}[39m\n`;
    expect(parseTotals(coloured)).toEqual({ status: "ok", summaries: [{ total: 3, skipped: 0, todo: 0 }], totals: { total: 3, skipped: 0, todo: 0 } });
  });
  it("ignores the Test Files line: it counts files, not tests", () => {
    expect(parseTotals(" Test Files  4 passed (4)\n")).toEqual({ status: "none" });
    expect(parseTotals(" Test Files  4 passed (4)\n      Tests  25 passed (25)\n").totals).toEqual({ total: 25, skipped: 0, todo: 0 });
  });
  it("ignores per-file progress lines", () => {
    const progress = " ❯ t/a.test.mjs (6 tests | 1 failed | 3 skipped) 5ms\n";
    expect(parseTotals(progress)).toEqual({ status: "none" });
    expect(parseTotals(progress + "      Tests  1 failed | 2 passed | 3 skipped (6)\n").totals).toEqual({ total: 6, skipped: 3, todo: 0 });
  });
  // ADR 0013 replaced these two pins: byte-identical summaries are no longer collapsed to one, and differing
  // summaries are no longer a "conflict"; both are a list (see "parseTotals keeps every summary" below).
  it("`no tests` is no summary", () => {
    expect(parseTotals("      Tests  no tests\n")).toEqual({ status: "none" });
  });
  it("empty, unrelated, garbled, and non-string input is no summary and never throws", () => {
    expect(parseTotals("")).toEqual({ status: "none" });
    expect(parseTotals("all good\n")).toEqual({ status: "none" });
    expect(parseTotals("      Tests  lots passed (many)\n")).toEqual({ status: "none" });
    expect(parseTotals(undefined)).toEqual({ status: "none" });
    expect(parseTotals(null)).toEqual({ status: "none" });
    expect(parseTotals(42)).toEqual({ status: "none" });
  });
});

describe("compareTotals (D6)", () => {
  const base = { total: 137, skipped: 4, todo: 0 };
  it("a drop in total is a problem naming both numbers", () => {
    expect(compareTotals(base, { total: 131, skipped: 4, todo: 0 })).toEqual([{ kind: "total", baseline: 137, now: 131 }]);
  });
  it("a rise in skipped is a problem naming both numbers", () => {
    expect(compareTotals(base, { total: 137, skipped: 9, todo: 0 })).toEqual([{ kind: "skipped", baseline: 4, now: 9 }]);
  });
  it("a rise in todo is a problem naming both numbers", () => {
    expect(compareTotals(base, { total: 137, skipped: 4, todo: 3 })).toEqual([{ kind: "todo", baseline: 0, now: 3 }]);
  });
  it("a rise in total, or a fall in skipped or todo, is never a problem", () => {
    expect(compareTotals(base, { total: 140, skipped: 4, todo: 0 })).toEqual([]);
    expect(compareTotals(base, { total: 137, skipped: 1, todo: 0 })).toEqual([]);
    expect(compareTotals({ total: 10, skipped: 0, todo: 5 }, { total: 10, skipped: 0, todo: 2 })).toEqual([]);
    expect(compareTotals(base, { ...base })).toEqual([]);
  });
  it("reports every offending count, one entry each", () => {
    const problems = compareTotals(base, { total: 130, skipped: 5, todo: 1 });
    expect(problems).toHaveLength(3);
    expect(problems).toEqual(expect.arrayContaining([
      { kind: "total", baseline: 137, now: 130 },
      { kind: "skipped", baseline: 4, now: 5 },
      { kind: "todo", baseline: 0, now: 1 },
    ]));
  });
});

describe("deltaTotals (D7: now minus baseline)", () => {
  it("subtracts each count", () => {
    expect(deltaTotals({ total: 137, skipped: 4, todo: 2 }, { total: 131, skipped: 12, todo: 1 })).toEqual({ total: -6, skipped: 8, todo: -1 });
  });
});

describe("parseWaiver (D7)", () => {
  it("reads signed integers and the reason", () => {
    expect(parseWaiver("test-count-waiver: total=-6 skipped=+8 todo=0; removed the dead suite")).toEqual({ total: -6, skipped: 8, todo: 0, reason: "removed the dead suite" });
  });
  it("reads +0 and -0 as 0", () => {
    const w = parseWaiver("test-count-waiver: total=+0 skipped=-0 todo=0; reason");
    expect(w).not.toBeNull();
    expect(w.total === 0 && w.skipped === 0 && w.todo === 0).toBe(true);
  });
  it("trims the reason", () => {
    expect(parseWaiver("test-count-waiver: total=-1 skipped=0 todo=0;    spaced out   ").reason).toBe("spaced out");
  });
  it("an empty or blank reason is no waiver", () => {
    expect(parseWaiver("test-count-waiver: total=-6 skipped=0 todo=0;")).toBeNull();
    expect(parseWaiver("test-count-waiver: total=-6 skipped=0 todo=0; ")).toBeNull();
    expect(parseWaiver("test-count-waiver: total=-6 skipped=0 todo=0;    \t")).toBeNull();
  });
  it("a missing reason separator is no waiver", () => {
    expect(parseWaiver("test-count-waiver: total=-6 skipped=0 todo=0")).toBeNull();
  });
  it("a missing field, a non-integer, or a wrong prefix is no waiver", () => {
    expect(parseWaiver("test-count-waiver: total=-6 skipped=0; reason")).toBeNull();
    expect(parseWaiver("test-count-waiver: total=1.5 skipped=0 todo=0; reason")).toBeNull();
    expect(parseWaiver("test-count-waiver: total=abc skipped=0 todo=0; reason")).toBeNull();
    expect(parseWaiver("count-waiver: total=-6 skipped=0 todo=0; reason")).toBeNull();
    expect(parseWaiver("")).toBeNull();
  });
  it("never throws on non-string input", () => {
    expect(parseWaiver(undefined)).toBeNull();
    expect(parseWaiver(null)).toBeNull();
    expect(parseWaiver(7)).toBeNull();
  });
});

describe("waiverCovers (D7: only when all three deltas equal the actual ones)", () => {
  const delta = { total: -6, skipped: 8, todo: 0 };
  const line = (t, s, d, reason = "removed the dead suite") => `test-count-waiver: total=${t} skipped=${s} todo=${d}; ${reason}`;
  it("covers an exact match", () => {
    expect(waiverCovers([line("-6", "+8", "0")], delta)).toBe(true);
  });
  it("finds the line inside a multi-line commit message and among other sources", () => {
    expect(waiverCovers(["fix: prune\n\nlonger body\n" + line("-6", "+8", "+0") + "\nmore text\n"], delta)).toBe(true);
    expect(waiverCovers(["unrelated commit", line("-6", "+8", "0")], delta)).toBe(true);
  });
  it("does not cover when only total differs", () => {
    expect(waiverCovers([line("-5", "+8", "0")], delta)).toBe(false);
  });
  it("does not cover when only skipped differs", () => {
    expect(waiverCovers([line("-6", "+7", "0")], delta)).toBe(false);
  });
  it("does not cover when only todo differs", () => {
    expect(waiverCovers([line("-6", "+8", "+1")], delta)).toBe(false);
  });
  it("does not cover on an empty reason", () => {
    expect(waiverCovers(["test-count-waiver: total=-6 skipped=+8 todo=0; "], delta)).toBe(false);
  });
  it("covers when one of several waivers matches", () => {
    expect(waiverCovers([line("-1", "0", "0"), line("-6", "+8", "0")], delta)).toBe(true);
  });
  it("no sources, and junk sources, cover nothing and never throw", () => {
    expect(waiverCovers([], delta)).toBe(false);
    expect(waiverCovers([null, 5, undefined, {}], delta)).toBe(false);
    expect(waiverCovers(undefined, delta)).toBe(false);
  });
});

describe("validTotals (review m4: counts are non-negative integers)", () => {
  it("accepts a whole-number entry, zeros included", () => {
    expect(validTotals({ total: 137, skipped: 4, todo: 0 })).toEqual({ total: 137, skipped: 4, todo: 0 });
    expect(validTotals({ total: 0, skipped: 0, todo: 0 })).toEqual({ total: 0, skipped: 0, todo: 0 });
  });
  it("rejects a negative count in any field", () => {
    expect(validTotals({ total: -1, skipped: 0, todo: 0 })).toBeNull();
    expect(validTotals({ total: 5, skipped: -1, todo: 0 })).toBeNull();
    expect(validTotals({ total: 5, skipped: 0, todo: -1 })).toBeNull();
  });
  it("rejects a fractional count in any field", () => {
    expect(validTotals({ total: 5.5, skipped: 0, todo: 0 })).toBeNull();
    expect(validTotals({ total: 5, skipped: 0.5, todo: 0 })).toBeNull();
    expect(validTotals({ total: 5, skipped: 0, todo: 0.1 })).toBeNull();
  });
});

// Card ratchet-per-package-runner (ADR 0013). Shapes chosen here, which the coder implements to:
//   parseTotals(output) -> { status: "ok", summaries: [{ total, skipped, todo }, ...], totals: <sum of summaries> } | { status: "none" }
//     one entry per parseable `Tests` line, in output order; identical lines each count; never "conflict".
//   sumTotals(summaries) -> { total, skipped, todo }                (field-wise sum)
//   readSummaries(x) -> [{ total, skipped, todo }, ...] | null      reads ANY of these, null when unreadable, never throws:
//       a baseline list [{...}, ...]                                (the new baseline shape: state.testTotals[cmd])
//       an old baseline {total, skipped, todo}                      (-> list of one)
//       a recorded {status:"ok", summaries:[...], totals}           (new pre-commit record -> summaries)
//       an old recorded {status:"ok", totals:{...}}                 (-> list of one)
//       an old recorded {status:"conflict", summaries:[...]}        (-> that list)
//     a recorded {status:"none"}, an empty list, or any entry that fails validTotals -> null.
describe("parseTotals keeps every summary (ADR 0013)", () => {
  const A = { total: 5, skipped: 0, todo: 0 };
  const B = { total: 6, skipped: 1, todo: 2 };
  it("two differing summaries are a list of two plus their sum, not a conflict", () => {
    expect(parseTotals("      Tests  5 passed (5)\n      Tests  3 passed | 1 skipped | 2 todo (6)\n")).toEqual({
      status: "ok",
      summaries: [A, B],
      totals: { total: 11, skipped: 1, todo: 2 },
    });
  });
  it("order is output order", () => {
    expect(parseTotals("      Tests  3 passed | 1 skipped | 2 todo (6)\n      Tests  5 passed (5)\n").summaries).toEqual([B, A]);
  });
  it("byte-identical summaries count twice", () => {
    const line = "      Tests  5 passed | 1 skipped (6)\n";
    expect(parseTotals(line + "noise\n" + line)).toEqual({
      status: "ok",
      summaries: [{ total: 6, skipped: 1, todo: 0 }, { total: 6, skipped: 1, todo: 0 }],
      totals: { total: 12, skipped: 2, todo: 0 },
    });
  });
  it("one summary is a list of one whose totals equal today's totals", () => {
    expect(parseTotals("      Tests  5 passed (5)\n")).toEqual({ status: "ok", summaries: [A], totals: A });
  });
  it("a differing summary where the later equals the earlier's number is still two entries", () => {
    expect(parseTotals("      Tests  1 passed (1)\n      Tests  137 passed (137)\n").summaries).toHaveLength(2);
  });
  it("an unparseable Tests line among parseable ones is skipped, not counted", () => {
    expect(parseTotals("      Tests  5 passed (5)\n      Tests  lots (many)\n").summaries).toEqual([A]);
  });
  it("the result never has status conflict", () => {
    expect(parseTotals("      Tests  1 passed (1)\n      Tests  2 passed (2)\n").status).toBe("ok");
  });
});

describe("sumTotals (ADR 0013)", () => {
  it("sums total, skipped and todo field-wise", () => {
    expect(sumTotals([{ total: 5, skipped: 1, todo: 0 }, { total: 6, skipped: 2, todo: 3 }])).toEqual({ total: 11, skipped: 3, todo: 3 });
  });
  it("a list of one is itself", () => {
    expect(sumTotals([{ total: 5, skipped: 1, todo: 2 }])).toEqual({ total: 5, skipped: 1, todo: 2 });
  });
});

describe("readSummaries reads the new and the old shapes (ADR 0013)", () => {
  const A = { total: 5, skipped: 0, todo: 0 };
  const B = { total: 6, skipped: 1, todo: 2 };
  it("a baseline list is read as is", () => {
    expect(readSummaries([A, B])).toEqual([A, B]);
  });
  it("an old baseline {total, skipped, todo} is a list of one", () => {
    expect(readSummaries(B)).toEqual([B]);
  });
  it("a new recorded ok result gives its summaries", () => {
    expect(readSummaries({ status: "ok", summaries: [A, B], totals: { total: 11, skipped: 1, todo: 2 } })).toEqual([A, B]);
  });
  it("an old recorded {status:ok, totals} is a list of one", () => {
    expect(readSummaries({ status: "ok", totals: B })).toEqual([B]);
  });
  it("an old recorded {status:conflict, summaries} is that list", () => {
    expect(readSummaries({ status: "conflict", summaries: [A, B] })).toEqual([A, B]);
  });
  it("unreadable input is null and never throws", () => {
    const junk = [
      null, undefined, 42, "junk", [], {}, { status: "none" }, { status: "ok" }, { status: "ok", totals: { total: "many" } },
      { status: "ok", summaries: [] }, { status: "ok", summaries: [A, { total: -1, skipped: 0, todo: 0 }] },
      { status: "conflict", summaries: [] }, { status: "conflict", summaries: [A, "x"] }, [A, { total: 1.5, skipped: 0, todo: 0 }],
      { total: "many", skipped: null },
    ];
    for (const j of junk) expect(readSummaries(j), JSON.stringify(j)).toBeNull();
  });
});

describe("known-limits comment (ADR 0013 Consequences)", () => {
  const src = readFileSync(new URL("../lib/test-totals.mjs", import.meta.url), "utf8");
  it("drops the pnpm -r line", () => {
    expect(src).not.toContain("`pnpm -r`");
  });
  it("states the new limit", () => {
    expect(src.replace(/\s*\n\/\/\s*/g, " ")).toMatch(/adds or removes a package changes the number of summaries and blocks with no waiver until a new baseline is taken/);
  });
});
