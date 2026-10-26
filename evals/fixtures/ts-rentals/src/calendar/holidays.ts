import { addDays, weekday } from "../util/dates.js";
import type { Day } from "../util/dates.js";

/** Days the shop is shut besides Sundays. */
export const HOLIDAYS: Day[] = ["2025-01-01", "2025-07-04", "2025-11-27", "2025-12-25"];

export function isHoliday(day: Day): boolean {
  return HOLIDAYS.includes(day);
}

/** The shop is shut on Sundays and holidays. */
export function isClosed(day: Day): boolean {
  return weekday(day) === 0 || isHoliday(day);
}

/** The first open day on or after the given day. */
export function nextOpenDay(day: Day): Day {
  let candidate = day;
  while (isClosed(candidate)) candidate = addDays(candidate, 1);
  return candidate;
}
