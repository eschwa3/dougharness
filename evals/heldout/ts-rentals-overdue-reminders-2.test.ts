import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import type { Customer } from "../src/customers/customer.js";
import * as reminders from "../src/notifications/reminders.js";
import { confirm, createReservation, pickUp } from "../src/reservations/reservation.js";
import type { Reservation } from "../src/reservations/reservation.js";

type Item = ReturnType<typeof seedCatalog>[number];
type Reminder = { reservationId: string; to: string; subject: string; body: string };
const overdueReminders = (reminders as unknown as Record<string, unknown>).overdueReminders as (rs: Reservation[], cs: Customer[], items: Item[], today: string) => Reminder[];

// The contact preference is a new customer field, so inputs go through a cast.
const mk = (input: Record<string, unknown>) => makeCustomer(input as unknown as Parameters<typeof makeCustomer>[0]);

const items = seedCatalog();
const out = (id: string, customerId: string) => pickUp(confirm(createReservation({ id, item: items[0], customerId, start: "2025-03-10", end: "2025-03-13" }, [])));

it("held-out: a customer who prefers phone is reminded at their phone number", () => {
  const cy = mk({ id: "cus-0001", name: "Cy", email: "cy@example.com", phone: "555-0101", contact: "phone" });
  expect(overdueReminders([out("res-0001", "cus-0001")], [cy], items, "2025-03-20").map((r) => r.to)).toEqual(["555-0101"]);
});

it("held-out: a customer who prefers email is reminded at their email address", () => {
  const di = mk({ id: "cus-0002", name: "Di", email: "di@example.com", phone: "555-0102", contact: "email" });
  expect(overdueReminders([out("res-0002", "cus-0002")], [di], items, "2025-03-20").map((r) => r.to)).toEqual(["di@example.com"]);
});

it("held-out: a customer with no stated preference is reminded by email", () => {
  const ed = mk({ id: "cus-0003", name: "Ed", email: "ed@example.com", phone: "555-0103" });
  const reminder = overdueReminders([out("res-0003", "cus-0003")], [ed], items, "2025-03-20");
  expect(reminder).toHaveLength(1);
  expect(reminder[0].to).toBe("ed@example.com");
  expect(reminder[0].reservationId).toBe("res-0003");
});

it("held-out: a customer cannot prefer phone without a phone number", () => {
  expect(() => mk({ id: "cus-0004", name: "Flo", email: "flo@example.com", contact: "phone" })).toThrow();
  expect(() => mk({ id: "cus-0004", name: "Flo", email: "flo@example.com", contact: "email" })).not.toThrow();
});
