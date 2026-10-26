import type { Item } from "../catalog/item.js";
import { addDays } from "../util/dates.js";
import type { Day } from "../util/dates.js";

/** Days between inspections, by category. */
const INTERVALS: Record<Item["category"], number> = {
  tool: 90,
  camera: 60,
  audio: 120,
  outdoor: 180,
};

export function inspectionIntervalDays(item: Item): number {
  return INTERVALS[item.category];
}

/** The day an item is next due for an inspection after the last one. */
export function nextInspectionDay(item: Item, lastInspected: Day): Day {
  return addDays(lastInspected, inspectionIntervalDays(item));
}

export interface InspectionWindow {
  itemId: string;
  /** First day the item is in the workshop. */
  start: Day;
  /** The day it is back on the shelf. */
  end: Day;
}

/** The workshop days for an inspection that begins on `start`. */
export function inspectionWindow(item: Item, start: Day, lengthDays = 1): InspectionWindow {
  if (lengthDays < 1) throw new Error("an inspection takes at least one day");
  return { itemId: item.id, start, end: addDays(start, lengthDays) };
}
