import { it, expect } from "vitest";
import * as calendar from "../src/calendar/availability.js";
import type { Booking, Span } from "../src/calendar/availability.js";
import { seedCatalog } from "../src/catalog/catalog.js";
import { inspectionWindow } from "../src/maintenance/schedule.js";
import type { InspectionWindow } from "../src/maintenance/schedule.js";
import * as schedule from "../src/maintenance/schedule.js";

// The inspection windows are a new optional fourth argument, and isInWorkshop is a new function.
const isAvailable = calendar.isAvailable as (bookings: Booking[], itemId: string, span: Span, windows?: InspectionWindow[]) => boolean;
const isInWorkshop = (schedule as unknown as Record<string, unknown>).isInWorkshop as (windows: InspectionWindow[], itemId: string, day: string) => boolean;

const [drill, saw] = seedCatalog();
const windows = [inspectionWindow(drill, "2025-06-10", 3)];

it("held-out: an item cannot be reserved on a day it is in the workshop", () => {
  expect(isAvailable([], "itm-0001", { start: "2025-06-09", end: "2025-06-11" }, windows)).toBe(false);
  expect(isAvailable([], "itm-0001", { start: "2025-06-11", end: "2025-06-12" }, windows)).toBe(false);
  expect(isAvailable([], "itm-0001", { start: "2025-06-12", end: "2025-06-15" }, windows)).toBe(false);
  expect(isAvailable([], "itm-0001", { start: "2025-06-01", end: "2025-06-30" }, windows)).toBe(false);
  expect(isAvailable([], "itm-0001", { start: "2025-06-01", end: "2025-06-05" }, windows)).toBe(true);
  expect(isAvailable([], "itm-0001", { start: "2025-06-20", end: "2025-06-25" }, windows)).toBe(true);
});

it("held-out: another item's inspection window does not block a reservation", () => {
  expect(isAvailable([], "itm-0002", { start: "2025-06-10", end: "2025-06-13" }, windows)).toBe(true);
  expect(isAvailable([], "itm-0002", { start: "2025-06-10", end: "2025-06-13" }, [inspectionWindow(saw, "2025-06-20")])).toBe(true);
  const booked: Booking[] = [{ itemId: "itm-0002", start: "2025-06-11", end: "2025-06-12" }];
  expect(isAvailable(booked, "itm-0002", { start: "2025-06-10", end: "2025-06-13" }, windows)).toBe(false);
});

it("held-out: isInWorkshop is true from the first workshop day until the day before the item is back", () => {
  expect(isInWorkshop(windows, "itm-0001", "2025-06-09")).toBe(false);
  expect(isInWorkshop(windows, "itm-0001", "2025-06-10")).toBe(true);
  expect(isInWorkshop(windows, "itm-0001", "2025-06-12")).toBe(true);
  expect(isInWorkshop(windows, "itm-0001", "2025-06-13")).toBe(false);
  expect(isInWorkshop(windows, "itm-0002", "2025-06-11")).toBe(false);
  expect(isInWorkshop([], "itm-0001", "2025-06-11")).toBe(false);
});
