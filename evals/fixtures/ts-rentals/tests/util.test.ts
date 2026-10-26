import { describe, it, expect } from "vitest";
import { addDays, compareDays, dayNumber, daysBetween, eachDay, fromDayNumber, isDay, isWeekend, weekday } from "../src/util/dates.js";
import { formatId, idNumber, nextId } from "../src/util/ids.js";
import { formatCents, isCents, minCents, parseCents, percentOf, sumCents } from "../src/util/money.js";
import { fill, padRight, pluralise, titleCase } from "../src/util/text.js";

describe("money", () => {
  it("formats cents as dollars", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(12345)).toBe("$123.45");
    expect(formatCents(-250)).toBe("-$2.50");
  });
  it("parses what it formats", () => {
    for (const cents of [0, 5, 100, 12345, -250]) expect(parseCents(formatCents(cents))).toBe(cents);
  });
  it("parses short and bare amounts", () => {
    expect(parseCents("12.3")).toBe(1230);
    expect(parseCents("7")).toBe(700);
    expect(parseCents(" $0.99 ")).toBe(99);
  });
  it("refuses text that is not money", () => {
    expect(() => parseCents("twelve")).toThrow("not a money amount");
    expect(() => parseCents("1.234")).toThrow("not a money amount");
  });
  it("sums, takes percentages and picks the smaller amount", () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(sumCents([])).toBe(0);
    expect(percentOf(2000, 10)).toBe(200);
    expect(percentOf(1000, 150)).toBe(1500);
    expect(minCents(300, 200)).toBe(200);
    expect(minCents(100, 200)).toBe(100);
  });
  it("knows whole cents from other numbers", () => {
    expect(isCents(10)).toBe(true);
    expect(isCents(10.5)).toBe(false);
    expect(isCents("10")).toBe(false);
  });
});

describe("dates", () => {
  it("accepts real ISO days only", () => {
    expect(isDay("2025-03-04")).toBe(true);
    expect(isDay("2025-02-30")).toBe(false);
    expect(isDay("2025-3-4")).toBe(false);
    expect(isDay("tomorrow")).toBe(false);
  });
  it("converts to and from day numbers", () => {
    expect(dayNumber("1970-01-02")).toBe(1);
    expect(fromDayNumber(dayNumber("2025-03-04"))).toBe("2025-03-04");
    expect(() => dayNumber("nope")).toThrow("not an ISO day");
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2025-02-27", 3)).toBe("2025-03-02");
    expect(addDays("2025-12-30", 3)).toBe("2026-01-02");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
  });
  it("counts the days between two days", () => {
    expect(daysBetween("2025-03-01", "2025-03-04")).toBe(3);
    expect(daysBetween("2025-03-04", "2025-03-04")).toBe(0);
    expect(daysBetween("2025-03-04", "2025-03-01")).toBe(-3);
  });
  it("compares days and finds weekends", () => {
    expect(compareDays("2025-03-01", "2025-03-02")).toBeLessThan(0);
    expect(compareDays("2025-03-02", "2025-03-02")).toBe(0);
    expect(weekday("2025-03-03")).toBe(1);
    expect(isWeekend("2025-03-01")).toBe(true);
    expect(isWeekend("2025-03-03")).toBe(false);
  });
  it("lists days from the first up to the last, not including it", () => {
    expect(eachDay("2025-03-01", "2025-03-04")).toEqual(["2025-03-01", "2025-03-02", "2025-03-03"]);
    expect(eachDay("2025-03-01", "2025-03-01")).toEqual([]);
  });
});

describe("ids", () => {
  it("formats and reads back counters", () => {
    expect(formatId("res", 7)).toBe("res-0007");
    expect(idNumber("res", "res-0007")).toBe(7);
    expect(idNumber("res", "inv-0007")).toBeNull();
  });
  it("hands out the next id after the highest one", () => {
    expect(nextId("res", [])).toBe("res-0001");
    expect(nextId("res", ["res-0001", "res-0009", "inv-0050"])).toBe("res-0010");
  });
});

describe("text", () => {
  it("pads, title-cases and pluralises", () => {
    expect(padRight("ab", 4)).toBe("ab  ");
    expect(padRight("abcd", 2)).toBe("abcd");
    expect(titleCase("cordless DRILL kit")).toBe("Cordless Drill Kit");
    expect(pluralise(1, "day")).toBe("1 day");
    expect(pluralise(3, "day")).toBe("3 days");
  });
  it("fills placeholders and leaves unknown ones", () => {
    expect(fill("Hi {name}, see {where}", { name: "Ana" })).toBe("Hi Ana, see {where}");
  });
});

describe("edge cases", () => {
  it("formats large amounts without grouping", () => {
    expect(formatCents(123456789)).toBe("$1234567.89");
  });
  it("rounds percentages to the nearest cent", () => {
    expect(percentOf(333, 10)).toBe(33);
    expect(percentOf(335, 10)).toBe(34);
    expect(percentOf(1, 50)).toBe(1);
    expect(percentOf(0, 80)).toBe(0);
  });
  it("accepts a negative amount with a dollar sign", () => {
    expect(parseCents("-$3.05")).toBe(-305);
  });
  it("walks a leap year", () => {
    expect(isDay("2024-02-29")).toBe(true);
    expect(isDay("2025-02-29")).toBe(false);
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(daysBetween("2024-01-01", "2025-01-01")).toBe(366);
  });
  it("finds the weekday of known days", () => {
    expect(weekday("2025-03-02")).toBe(0);
    expect(weekday("2025-03-08")).toBe(6);
    expect(isWeekend("2025-03-02")).toBe(true);
  });
  it("lists a whole week of days", () => {
    const week = eachDay("2025-03-03", "2025-03-10");
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2025-03-03");
    expect(week[6]).toBe("2025-03-09");
  });
  it("keeps counting ids past 9999", () => {
    expect(formatId("res", 12345)).toBe("res-12345");
    expect(nextId("res", ["res-9999"])).toBe("res-10000");
  });
  it("pads nothing when the text is already wide enough", () => {
    expect(padRight("abc", 3)).toBe("abc");
    expect(titleCase("")).toBe("");
    expect(pluralise(0, "item")).toBe("0 items");
  });
  it("fills the same placeholder twice", () => {
    expect(fill("{a}-{a}", { a: "x" })).toBe("x-x");
  });
});
