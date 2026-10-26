import { isAvailable } from "../calendar/availability.js";
import type { Booking } from "../calendar/availability.js";
import type { Item } from "../catalog/item.js";
import { daysBetween } from "../util/dates.js";
import type { Day } from "../util/dates.js";
import type { Cents } from "../util/money.js";
import { advance, holdsItem } from "./status.js";
import type { Status } from "./status.js";

export interface Reservation {
  id: string;
  itemId: string;
  customerId: string;
  /** First rental day. */
  start: Day;
  /** The day the item is due back. */
  end: Day;
  status: Status;
  depositCents: Cents;
  /** Set when the item comes back. */
  returnedOn?: Day;
}

export interface ReservationInput {
  id: string;
  item: Item;
  customerId: string;
  start: Day;
  end: Day;
}

/** The bookings that the live reservations hold. */
export function bookingsFrom(reservations: Reservation[]): Booking[] {
  return reservations.filter((r) => holdsItem(r.status)).map((r) => ({ itemId: r.itemId, start: r.start, end: r.end }));
}

/** Creates a requested reservation. Throws when the dates are backwards or the item is taken. */
export function createReservation(input: ReservationInput, existing: Reservation[]): Reservation {
  if (daysBetween(input.start, input.end) < 1) throw new Error("a rental needs at least one day");
  if (!isAvailable(bookingsFrom(existing), input.item.id, { start: input.start, end: input.end })) {
    throw new Error(`${input.item.id} is not available from ${input.start} to ${input.end}`);
  }
  return {
    id: input.id,
    itemId: input.item.id,
    customerId: input.customerId,
    start: input.start,
    end: input.end,
    status: "requested",
    depositCents: input.item.depositCents,
  };
}

export function confirm(reservation: Reservation): Reservation {
  return { ...reservation, status: advance(reservation.status, "confirmed") };
}

export function pickUp(reservation: Reservation): Reservation {
  return { ...reservation, status: advance(reservation.status, "picked-up") };
}

export function markReturned(reservation: Reservation, day: Day): Reservation {
  return { ...reservation, status: advance(reservation.status, "returned"), returnedOn: day };
}

export function cancel(reservation: Reservation): Reservation {
  return { ...reservation, status: advance(reservation.status, "cancelled") };
}

/** Days between the first rental day and the due day. */
export function plannedDays(reservation: Reservation): number {
  return daysBetween(reservation.start, reservation.end);
}
