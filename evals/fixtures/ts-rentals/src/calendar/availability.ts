import type { Day } from "../util/dates.js";

/** A booking holds an item from `start` up to the return day `end`. */
export interface Booking {
  itemId: string;
  start: Day;
  end: Day;
}

export interface Span {
  start: Day;
  end: Day;
}

/** True when two spans share a rental night. ISO days compare correctly as strings. */
export function overlaps(a: Span, b: Span): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** The bookings of one item that collide with a span. */
export function conflictsFor(bookings: Booking[], itemId: string, span: Span): Booking[] {
  return bookings.filter((booking) => booking.itemId === itemId && overlaps(booking, span));
}

export function isAvailable(bookings: Booking[], itemId: string, span: Span): boolean {
  return conflictsFor(bookings, itemId, span).length === 0;
}

/** Bookings of one item in start order. */
export function bookingsOf(bookings: Booking[], itemId: string): Booking[] {
  return bookings.filter((booking) => booking.itemId === itemId).sort((a, b) => a.start.localeCompare(b.start));
}
