import { describe, it, expect } from "vitest";
import { stripAnsi, parseTotals, compareTotals, deltaTotals, parseWaiver, waiverCovers, validTotals } from "../lib/test-totals.mjs";

// Card test-count-ratchet, the pure module. Every expectation follows from the card goal or decisions D3-D8 of
// .doug/.state/briefs/test-count-ratchet.md; the vitest lines are the ones quoted in
// .doug/.state/research/test-count-ratchet.md.
//
// Export shapes these tests pin (the brief leaves names open):
//   stripAnsi(text) -> string
//   parseTotals(output) -> { status: "ok", totals: { total, skipped, todo } }
//                        | { status: "none" }                                  (no parseable Tests summary)
//                        | { status: "conflict", summaries: [{ total, skipped, todo }, ...] }
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
    expect(parseTotals(" Test Files  1 passed (1)\n      Tests  3 passed (3)\n")).toEqual({ status: "ok", totals: { total: 3, skipped: 0, todo: 0 } });
  });
  it("reads all four segments; total is N, which includes skipped and todo", () => {
    expect(parseTotals("      Tests  1 failed | 2 passed | 3 skipped | 1 todo (7)\n")).toEqual({ status: "ok", totals: { total: 7, skipped: 3, todo: 1 } });
  });
  it("counts an absent skipped or todo segment as 0", () => {
    expect(parseTotals("      Tests  2 failed | 1 passed (3)\n")).toEqual({ status: "ok", totals: { total: 3, skipped: 0, todo: 0 } });
    expect(parseTotals("      Tests  4 passed | 2 todo (6)\n")).toEqual({ status: "ok", totals: { total: 6, skipped: 0, todo: 2 } });
    expect(parseTotals("      Tests  4 passed | 2 skipped (6)\n")).toEqual({ status: "ok", totals: { total: 6, skipped: 2, todo: 0 } });
  });
  it("takes the total from the parenthesised N even when the segments do not sum to it", () => {
    expect(parseTotals("      Tests  2 passed (9)\n")).toEqual({ status: "ok", totals: { total: 9, skipped: 0, todo: 0 } });
  });
  it("reads the line when vitest coloured it (ANSI inside the title, segments and total)", () => {
    const coloured = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m3 passed${ESC}[39m${ESC}[22m${ESC}[90m (3)${ESC}[39m\n`;
    expect(parseTotals(coloured)).toEqual({ status: "ok", totals: { total: 3, skipped: 0, todo: 0 } });
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
  it("two equal summaries are one summary", () => {
    const line = "      Tests  5 passed | 1 skipped (6)\n";
    expect(parseTotals(line + "noise\n" + line)).toEqual({ status: "ok", totals: { total: 6, skipped: 1, todo: 0 } });
  });
  it("two unequal summaries are a conflict, whichever order and whichever count differs (D5)", () => {
    const a = parseTotals("      Tests  5 passed (5)\n      Tests  6 passed (6)\n");
    expect(a.status).toBe("conflict");
    expect(a.summaries).toEqual([{ total: 5, skipped: 0, todo: 0 }, { total: 6, skipped: 0, todo: 0 }]);
    // same total, differing only in skipped
    expect(parseTotals("      Tests  6 passed (6)\n      Tests  5 passed | 1 skipped (6)\n").status).toBe("conflict");
    // same total, differing only in todo
    expect(parseTotals("      Tests  6 passed (6)\n      Tests  5 passed | 1 todo (6)\n").status).toBe("conflict");
    // the later line equal to the earlier one's total does not rescue it: never "take the last"
    expect(parseTotals("      Tests  1 passed (1)\n      Tests  137 passed (137)\n").status).toBe("conflict");
    expect(parseTotals("      Tests  137 passed (137)\n      Tests  1 passed (1)\n").status).toBe("conflict");
  });
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
