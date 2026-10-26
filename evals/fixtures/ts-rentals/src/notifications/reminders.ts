import type { Item } from "../catalog/item.js";
import type { Customer } from "../customers/customer.js";
import { findCustomer } from "../customers/customer.js";
import type { Reservation } from "../reservations/reservation.js";
import { addDays } from "../util/dates.js";
import type { Day } from "../util/dates.js";
import { render, subjectFor } from "./templates.js";

export interface Reminder {
  reservationId: string;
  to: string;
  subject: string;
  body: string;
}

/** Reservations confirmed to start tomorrow. */
export function startingTomorrow(reservations: Reservation[], today: Day): Reservation[] {
  const tomorrow = addDays(today, 1);
  return reservations.filter((r) => r.status === "confirmed" && r.start === tomorrow);
}

/** A pickup reminder for each reservation starting tomorrow, sent to the customer's email address. */
export function pickupReminders(reservations: Reservation[], customers: Customer[], items: Item[], today: Day): Reminder[] {
  const reminders: Reminder[] = [];
  for (const reservation of startingTomorrow(reservations, today)) {
    const customer = findCustomer(customers, reservation.customerId);
    const item = items.find((i) => i.id === reservation.itemId);
    if (!customer || !item) continue;
    reminders.push({
      reservationId: reservation.id,
      to: customer.email,
      subject: subjectFor("pickup"),
      body: render("pickup", customer, reservation, item),
    });
  }
  return reminders;
}
