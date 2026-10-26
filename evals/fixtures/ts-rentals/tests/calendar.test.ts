import { describe, it, expect } from "vitest";
import { bookingsOf, conflictsFor, isAvailable, overlaps } from "../src/calendar/availability.js";
import type { Booking } from "../src/calendar/availability.js";
import { HOLIDAYS, isClosed, isHoliday, nextOpenDay } from "../src/calendar/holidays.js";

const bookings: Booking[] = [
  { itemId: "itm-0001", start: "2025-03-10", end: "2025-03-14" },
  { itemId: "itm-0001", start: "2025-03-03", end: "2025-03-05" },
  { itemId: "itm-0002", start: "2025-03-10", end: "2025-03-14" },
];

describe("overlaps", () => {
  it("is true for spans that clearly share days", () => {
    expect(overlaps({ start: "2025-03-01", end: "2025-03-08" }, { start: "2025-03-04", end: "2025-03-06" })).toBe(true);
    expect(overlaps({ start: "2025-03-01", end: "2025-03-08" }, { start: "2025-03-05", end: "2025-03-12" })).toBe(true);
  });
  it("is false for spans with days between them", () => {
    expect(overlaps({ start: "2025-03-01", end: "2025-03-03" }, { start: "2025-03-08", end: "2025-03-10" })).toBe(false);
    expect(overlaps({ start: "2025-03-08", end: "2025-03-10" }, { start: "2025-03-01", end: "2025-03-03" })).toBe(false);
  });
});

describe("availability", () => {
  it("lists the conflicts of one item only", () => {
    const hits = conflictsFor(bookings, "itm-0001", { start: "2025-03-11", end: "2025-03-12" });
    expect(hits).toEqual([bookings[0]]);
  });
  it("is available when the dates are clear of every booking of the item", () => {
    expect(isAvailable(bookings, "itm-0001", { start: "2025-03-20", end: "2025-03-22" })).toBe(true);
    expect(isAvailable(bookings, "itm-0001", { start: "2025-03-07", end: "2025-03-08" })).toBe(true);
  });
  it("is not available inside a booking", () => {
    expect(isAvailable(bookings, "itm-0002", { start: "2025-03-11", end: "2025-03-13" })).toBe(false);
  });
  it("treats an item with no bookings as free", () => {
    expect(isAvailable(bookings, "itm-0005", { start: "2025-03-11", end: "2025-03-13" })).toBe(true);
  });
  it("lists the bookings of an item in start order", () => {
    expect(bookingsOf(bookings, "itm-0001").map((b) => b.start)).toEqual(["2025-03-03", "2025-03-10"]);
  });
});

describe("holidays", () => {
  it("knows the listed holidays", () => {
    for (const day of HOLIDAYS) expect(isHoliday(day)).toBe(true);
    expect(isHoliday("2025-03-04")).toBe(false);
  });
  it("is shut on Sundays and holidays", () => {
    expect(isClosed("2025-03-02")).toBe(true);
    expect(isClosed("2025-12-25")).toBe(true);
    expect(isClosed("2025-03-03")).toBe(false);
  });
  it("finds the next open day", () => {
    expect(nextOpenDay("2025-03-03")).toBe("2025-03-03");
    expect(nextOpenDay("2025-03-02")).toBe("2025-03-03");
    expect(nextOpenDay("2025-12-25")).toBe("2025-12-26");
  });
});

describe("more availability", () => {
  const one: Booking[] = [{ itemId: "itm-0003", start: "2025-06-02", end: "2025-06-06" }];
  it("is not available for a span that wraps a booking", () => {
    expect(isAvailable(one, "itm-0003", { start: "2025-06-01", end: "2025-06-10" })).toBe(false);
  });
  it("is not available for a span that starts inside a booking", () => {
    expect(isAvailable(one, "itm-0003", { start: "2025-06-03", end: "2025-06-09" })).toBe(false);
  });
  it("is not available for a span that ends inside a booking", () => {
    expect(isAvailable(one, "itm-0003", { start: "2025-05-28", end: "2025-06-04" })).toBe(false);
  });
  it("is available well before and well after", () => {
    expect(isAvailable(one, "itm-0003", { start: "2025-05-01", end: "2025-05-05" })).toBe(true);
    expect(isAvailable(one, "itm-0003", { start: "2025-06-20", end: "2025-06-25" })).toBe(true);
  });
  it("finds both bookings a long span collides with", () => {
    expect(conflictsFor(bookings, "itm-0001", { start: "2025-03-01", end: "2025-03-31" })).toHaveLength(2);
  });
  it("does not change the bookings it is given", () => {
    const copy = JSON.stringify(bookings);
    bookingsOf(bookings, "itm-0001");
    expect(JSON.stringify(bookings)).toBe(copy);
  });
  it("has no closed day in an ordinary week", () => {
    for (const day of ["2025-03-03", "2025-03-04", "2025-03-05"]) expect(isClosed(day)).toBe(false);
  });
  it("skips a holiday that falls on a weekday", () => {
    expect(nextOpenDay("2025-07-04")).toBe("2025-07-05");
  });
});
