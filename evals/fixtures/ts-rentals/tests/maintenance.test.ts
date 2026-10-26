import { describe, it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { failedInspections, inspectionsFor, lastInspectionDay, passRate, recordInspection } from "../src/maintenance/inspections.js";
import type { Inspection } from "../src/maintenance/inspections.js";
import { inspectionIntervalDays, inspectionWindow, nextInspectionDay } from "../src/maintenance/schedule.js";

const [drill, , camera, , tent] = seedCatalog();

const check = (itemId: string, day: string, passed: boolean): Inspection => ({ itemId, day, passed, notes: passed ? "ok" : "worn" });

describe("schedule", () => {
  it("inspects each category on its own interval", () => {
    expect(inspectionIntervalDays(drill)).toBe(90);
    expect(inspectionIntervalDays(camera)).toBe(60);
    expect(inspectionIntervalDays(tent)).toBe(180);
  });
  it("finds the next inspection day", () => {
    expect(nextInspectionDay(drill, "2025-01-01")).toBe("2025-04-01");
    expect(nextInspectionDay(camera, "2025-01-01")).toBe("2025-03-02");
  });
  it("makes a workshop window of the given length", () => {
    expect(inspectionWindow(drill, "2025-04-01")).toEqual({ itemId: "itm-0001", start: "2025-04-01", end: "2025-04-02" });
    expect(inspectionWindow(drill, "2025-04-01", 3).end).toBe("2025-04-04");
  });
  it("refuses a window shorter than a day", () => {
    expect(() => inspectionWindow(drill, "2025-04-01", 0)).toThrow("at least one day");
  });
});

describe("inspections", () => {
  const log = recordInspection(recordInspection(recordInspection([], check("itm-0001", "2025-02-01", true)), check("itm-0001", "2025-01-01", false)), check("itm-0003", "2025-01-15", true));

  it("keeps the log in day order", () => {
    expect(log.map((i) => i.day)).toEqual(["2025-01-01", "2025-01-15", "2025-02-01"]);
  });
  it("lists the inspections of one item", () => {
    expect(inspectionsFor(log, "itm-0001")).toHaveLength(2);
    expect(inspectionsFor(log, "itm-0009")).toEqual([]);
  });
  it("finds the latest inspection day", () => {
    expect(lastInspectionDay(log, "itm-0001")).toBe("2025-02-01");
    expect(lastInspectionDay(log, "itm-0009")).toBeUndefined();
  });
  it("lists failures and works out a pass rate", () => {
    expect(failedInspections(log, "itm-0001")).toHaveLength(1);
    expect(passRate(log, "itm-0001")).toBe(0.5);
    expect(passRate(log, "itm-0003")).toBe(1);
    expect(passRate(log, "itm-0009")).toBe(1);
  });
});

describe("more maintenance", () => {
  it("starts the next interval from the last inspection", () => {
    expect(nextInspectionDay(tent, "2025-01-01")).toBe("2025-06-30");
  });
  it("keeps same day inspections in the order they were recorded", () => {
    const log = recordInspection(recordInspection([], check("itm-0001", "2025-02-01", false)), check("itm-0001", "2025-02-01", true));
    expect(log.map((i) => i.passed)).toEqual([false, true]);
  });
  it("does not change the log it records into", () => {
    const log: Inspection[] = [];
    recordInspection(log, check("itm-0001", "2025-02-01", true));
    expect(log).toEqual([]);
  });
  it("starts a window on the given day", () => {
    expect(inspectionWindow(camera, "2025-05-05").start).toBe("2025-05-05");
  });
});
