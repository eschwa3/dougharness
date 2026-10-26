import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import type { Item } from "../src/catalog/item.js";
import { makeCustomer } from "../src/customers/customer.js";
import type { Customer } from "../src/customers/customer.js";
import * as templates from "../src/notifications/templates.js";
import type { Ledger, Payment } from "../src/payments/ledger.js";
import { cancel, createReservation } from "../src/reservations/reservation.js";
import type { Reservation } from "../src/reservations/reservation.js";

// The statement module does not exist yet, so it is loaded at run time through a non-literal specifier.
const statementModule = await import("../src/billing/" + "statement.js");
type Statement = { customerId: string; month: string; lines: { reservationId: string; label: string; cents: number }[]; chargesCents: number; receivedCents: number; balanceCents: number };
const statementFor = statementModule.statementFor as (customer: Customer, reservations: Reservation[], items: Item[], ledger: Ledger, month: string) => Statement;
const renderStatement = (templates as unknown as Record<string, unknown>).renderStatement as (customer: Customer, statement: Statement) => string;

const items = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });
const bo = makeCustomer({ id: "cus-0002", name: "Bo", email: "bo@example.com" });
const rent = (id: string, customerId: string, itemIndex: number, start: string, end: string) =>
  createReservation({ id, item: items[itemIndex], customerId, start, end }, []);
const pay = (id: string, reservationId: string, cents: number, day: string): Payment => ({ id, reservationId, cents, kind: "payment", day });

const drillMay = rent("res-0001", "cus-0001", 0, "2025-05-12", "2025-05-15");
const sawMay = rent("res-0002", "cus-0001", 1, "2025-05-20", "2025-05-22");
const drillJune = rent("res-0003", "cus-0001", 0, "2025-06-02", "2025-06-04");
const camMay = rent("res-0004", "cus-0002", 2, "2025-05-13", "2025-05-14");

it("held-out: a statement charges each rental of the customer that starts in the month", () => {
  const s = statementFor(ana, [drillMay, sawMay, drillJune, camMay], items, [], "2025-05");
  expect(s.customerId).toBe("cus-0001");
  expect(s.month).toBe("2025-05");
  expect(s.lines.map((l) => [l.reservationId, l.cents])).toEqual([
    ["res-0001", 4500],
    ["res-0002", 8000],
  ]);
  expect(s.chargesCents).toBe(12500);
  expect(statementFor(ana, [drillMay, drillJune], items, [], "2025-07").lines).toEqual([]);
});

it("held-out: a statement leaves out cancelled rentals and rentals of other customers", () => {
  const s = statementFor(ana, [cancel(drillMay), sawMay, camMay], items, [], "2025-05");
  expect(s.lines.map((l) => l.reservationId)).toEqual(["res-0002"]);
  expect(s.chargesCents).toBe(8000);
  expect(statementFor(bo, [drillMay, sawMay, camMay], items, [], "2025-05").lines.map((l) => l.reservationId)).toEqual(["res-0004"]);
});

it("held-out: the balance is the charges less the payments received in the month, net of refunds", () => {
  const refund: Payment = { id: "pay-3", reservationId: "res-0001", cents: 500, kind: "refund", day: "2025-05-16" };
  const ledger: Ledger = [pay("pay-1", "res-0001", 3000, "2025-05-12"), pay("pay-2", "res-0003", 2000, "2025-06-02"), refund, pay("pay-4", "res-0004", 900, "2025-05-13")];
  const s = statementFor(ana, [drillMay, sawMay, drillJune], items, ledger, "2025-05");
  expect(s.receivedCents).toBe(2500);
  expect(s.balanceCents).toBe(12500 - 2500);
  expect(statementFor(ana, [drillMay, sawMay, drillJune], items, [], "2025-05").balanceCents).toBe(12500);
});

it("held-out: the statement text greets the customer and states the balance", () => {
  const ledger: Ledger = [pay("pay-1", "res-0001", 2500, "2025-05-12")];
  const s = statementFor(ana, [drillMay, sawMay], items, ledger, "2025-05");
  const text = renderStatement(ana, s);
  expect(text).toContain("Ana");
  expect(text).toContain("2025-05");
  expect(text).toContain("$100.00");
});
