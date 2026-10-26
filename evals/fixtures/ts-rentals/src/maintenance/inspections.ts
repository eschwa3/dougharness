import type { Day } from "../util/dates.js";

export interface Inspection {
  itemId: string;
  day: Day;
  passed: boolean;
  notes: string;
}

export function recordInspection(log: Inspection[], inspection: Inspection): Inspection[] {
  return [...log, inspection].sort((a, b) => a.day.localeCompare(b.day));
}

export function inspectionsFor(log: Inspection[], itemId: string): Inspection[] {
  return log.filter((i) => i.itemId === itemId);
}

/** The day of the latest inspection of an item, or undefined when it was never inspected. */
export function lastInspectionDay(log: Inspection[], itemId: string): Day | undefined {
  const mine = inspectionsFor(log, itemId);
  return mine.length === 0 ? undefined : mine[mine.length - 1].day;
}

export function failedInspections(log: Inspection[], itemId: string): Inspection[] {
  return inspectionsFor(log, itemId).filter((i) => !i.passed);
}

/** Share of inspections passed, 0 to 1. An item with none has a rate of 1. */
export function passRate(log: Inspection[], itemId: string): number {
  const mine = inspectionsFor(log, itemId);
  if (mine.length === 0) return 1;
  return mine.filter((i) => i.passed).length / mine.length;
}
