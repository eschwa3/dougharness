import { addDays, compareDays, daysBetween } from "../util/dates.js";
import type { Day } from "../util/dates.js";

export interface DateRange {
  from: Day;
  /** Up to but not including this day. */
  to: Day;
}

/** Number of days in a range. */
export function rangeDays(range: DateRange): number {
  return Math.max(0, daysBetween(range.from, range.to));
}

/** The days a span shares with a range, counting from the first rental day up to the due day. */
export function sharedDays(span: { start: Day; end: Day }, range: DateRange): number {
  const start = compareDays(span.start, range.from) > 0 ? span.start : range.from;
  const end = compareDays(span.end, range.to) < 0 ? span.end : range.to;
  return Math.max(0, daysBetween(start, end));
}

/** The range that follows another range and is as long. */
export function nextRange(range: DateRange): DateRange {
  const length = rangeDays(range);
  return { from: range.to, to: addDays(range.to, length) };
}
