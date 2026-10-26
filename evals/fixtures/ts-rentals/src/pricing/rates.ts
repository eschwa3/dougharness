import type { Item } from "../catalog/item.js";
import { daysBetween } from "../util/dates.js";
import type { Day } from "../util/dates.js";
import { formatCents } from "../util/money.js";
import type { Cents } from "../util/money.js";

/** Rental days between pickup and the due day. A same day rental still costs one day. */
export function billableDays(start: Day, end: Day): number {
  return Math.max(1, daysBetween(start, end));
}

/** The rental charge for a number of days at the item's day rate. */
export function rentalCostCents(item: Item, days: number): Cents {
  return item.dayRateCents * days;
}

/** The rental charge for a pickup and due day. */
export function costForSpan(item: Item, start: Day, end: Day): Cents {
  return rentalCostCents(item, billableDays(start, end));
}

/** "$15.00/day". */
export function dayRateLabel(item: Item): string {
  return `${formatCents(item.dayRateCents)}/day`;
}

/** "$75.00/week". */
export function weekRateLabel(item: Item): string {
  return `${formatCents(item.weekRateCents)}/week`;
}
