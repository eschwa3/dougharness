import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import type { Customer } from "../src/customers/customer.js";
import { upgradeToMember } from "../src/customers/membership.js";
import * as reminders from "../src/notifications/reminders.js";
import { cancel, confirm, createReservation, markReturned, pickUp } from "../src/reservations/reservation.js";
import type { Reservation } from "../src/reservations/reservation.js";
import * as status from "../src/reservations/status.js";

type Item = ReturnType<typeof seedCatalog>[number];
type Reminder = { reservationId: string; to: string; subject: string; body: string };
const overdueReminders = (reminders as unknown as Record<string, unknown>).overdueReminders as (rs: Reservation[], cs: Customer[], items: Item[], today: string) => Reminder[];
const isOverdue = (status as unknown as Record<string, unknown>).isOverdue as (st: Reservation["status"], end: string, today: string, graceDays: number) => boolean;

const items = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });
const cy = upgradeToMember(makeCustomer({ id: "cus-0002", name: "Cy", email: "cy@example.com" }));

const rental = (id: string, customerId: string, itemIndex: number) =>
  createReservation({ id, item: items[itemIndex], customerId, start: "2025-03-10", end: "2025-03-13" }, []);
const out = (id: string, customerId: string, itemIndex = 0) => pickUp(confirm(rental(id, customerId, itemIndex)));

it("held-out: a reminder lists a picked up rental once it is past its due date", () => {
  const res = out("res-0001", "cus-0001");
  expect(overdueReminders([res], [ana], items, "2025-03-13")).toEqual([]);
  expect(overdueReminders([res], [ana], items, "2025-03-14").map((r) => r.reservationId)).toEqual(["res-0001"]);
  expect(overdueReminders([res], [ana], items, "2025-04-01").map((r) => r.reservationId)).toEqual(["res-0001"]);
});

it("held-out: a member's rental is listed only after the grace day", () => {
  const res = out("res-0002", "cus-0002", 1);
  expect(overdueReminders([res], [cy], items, "2025-03-13")).toEqual([]);
  expect(overdueReminders([res], [cy], items, "2025-03-14")).toEqual([]);
  expect(overdueReminders([res], [cy], items, "2025-03-15").map((r) => r.reservationId)).toEqual(["res-0002"]);
});

it("held-out: a rental that is returned, cancelled or not picked up gets no overdue reminder", () => {
  const returned = markReturned(out("res-0003", "cus-0001", 2), "2025-03-12");
  const cancelled = cancel(rental("res-0004", "cus-0001", 3));
  const confirmedOnly = confirm(rental("res-0005", "cus-0001", 4));
  const requested = rental("res-0006", "cus-0001", 0);
  expect(overdueReminders([returned, cancelled, confirmedOnly, requested], [ana], items, "2025-05-01")).toEqual([]);
});

it("held-out: isOverdue is true only for a picked up rental past its due date plus the grace days", () => {
  expect(isOverdue("picked-up", "2025-03-13", "2025-03-13", 0)).toBe(false);
  expect(isOverdue("picked-up", "2025-03-13", "2025-03-14", 0)).toBe(true);
  expect(isOverdue("picked-up", "2025-03-13", "2025-03-14", 1)).toBe(false);
  expect(isOverdue("picked-up", "2025-03-13", "2025-03-15", 1)).toBe(true);
  for (const s of ["requested", "confirmed", "returned", "cancelled"] as const) expect(isOverdue(s, "2025-03-13", "2025-06-01", 0)).toBe(false);
});
