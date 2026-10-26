import type { Item } from "../catalog/item.js";
import { daysBetween } from "../util/dates.js";
import type { Day } from "../util/dates.js";
import { percentOf } from "../util/money.js";
import type { Cents } from "../util/money.js";

/** A late day costs this percentage of the day rate. */
export const LATE_FEE_PERCENT = 150;

/** How many late days a return costs, given the due day and the day the item came back. */
export function lateDays(due: Day, returned: Day): number {
  return Math.max(0, daysBetween(due, returned) + 1);
}

/** The fee for a number of late days. */
export function feeForDays(item: Item, days: number): Cents {
  return percentOf(item.dayRateCents * days, LATE_FEE_PERCENT);
}

/** The fee for returning on `returned` an item that was due on `due`. */
export function lateFeeCents(item: Item, due: Day, returned: Day): Cents {
  return feeForDays(item, lateDays(due, returned));
}
