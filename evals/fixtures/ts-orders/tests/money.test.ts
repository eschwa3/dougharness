import { describe, it, expect } from "vitest";
import { toCents, formatMoney, roundCents } from "../src/util/money.js";
import { makeId, nextSeq } from "../src/util/ids.js";
import { slug } from "../src/util/text.js";

describe("money", () => {
  it("parses whole and fractional amounts", () => {
    expect(toCents("12")).toBe(1200);
    expect(toCents("12.3")).toBe(1230);
    expect(toCents("0.05")).toBe(5);
  });
  it("rejects garbage", () => {
    expect(() => toCents("twelve")).toThrow();
    expect(() => toCents("1.234")).toThrow();
  });
  it("formats cents", () => {
    expect(formatMoney(1234)).toBe("$12.34");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(-250)).toBe("-$2.50");
  });
  it("rounds halves up", () => {
    expect(roundCents(2.5)).toBe(3);
    expect(roundCents(2.4)).toBe(2);
  });
});

describe("ids and text", () => {
  it("builds and sequences ids", () => {
    expect(makeId("ord", 7)).toBe("ord-0007");
    expect(nextSeq([], "ord")).toBe(1);
    expect(nextSeq(["ord-0003", "ord-0009", "inv-0020"], "ord")).toBe(10);
  });
  it("slugs text", () => {
    expect(slug("Blue Widget, Large!")).toBe("blue-widget-large");
  });
});
