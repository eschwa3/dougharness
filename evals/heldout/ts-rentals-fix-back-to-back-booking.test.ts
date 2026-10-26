import { it, expect } from "vitest";
import { conflictsFor, isAvailable, overlaps } from "../src/calendar/availability.js";
import type { Booking } from "../src/calendar/availability.js";

const held: Booking[] = [{ itemId: "itm-0001", start: "2025-05-12", end: "2025-05-15" }];

it("held-out: a booking that ends on the day another starts is not a conflict", () => {
  expect(overlaps({ start: "2025-05-09", end: "2025-05-12" }, { start: "2025-05-12", end: "2025-05-14" })).toBe(false);
  expect(isAvailable(held, "itm-0001", { start: "2025-05-09", end: "2025-05-12" })).toBe(true);
  expect(conflictsFor(held, "itm-0001", { start: "2025-05-09", end: "2025-05-12" })).toEqual([]);
});

it("held-out: a booking that starts on the day another ends is not a conflict", () => {
  expect(overlaps({ start: "2025-05-12", end: "2025-05-15" }, { start: "2025-05-15", end: "2025-05-17" })).toBe(false);
  expect(isAvailable(held, "itm-0001", { start: "2025-05-15", end: "2025-05-17" })).toBe(true);
});

it("held-out: bookings that share a rental night still conflict", () => {
  expect(isAvailable(held, "itm-0001", { start: "2025-05-14", end: "2025-05-16" })).toBe(false);
  expect(isAvailable(held, "itm-0001", { start: "2025-05-10", end: "2025-05-13" })).toBe(false);
  expect(isAvailable(held, "itm-0001", { start: "2025-05-12", end: "2025-05-15" })).toBe(false);
  expect(isAvailable(held, "itm-0001", { start: "2025-05-01", end: "2025-05-30" })).toBe(false);
  expect(conflictsFor(held, "itm-0001", { start: "2025-05-13", end: "2025-05-14" })).toEqual(held);
});
