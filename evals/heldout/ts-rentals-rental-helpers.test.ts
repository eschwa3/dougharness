import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import type { Item } from "../src/catalog/item.js";
import * as inspections from "../src/maintenance/inspections.js";
import type { Inspection } from "../src/maintenance/inspections.js";
import * as ledgerModule from "../src/payments/ledger.js";
import type { Ledger, Payment } from "../src/payments/ledger.js";
import * as dates from "../src/util/dates.js";

const formatRentalSpan = (dates as unknown as Record<string, unknown>).formatRentalSpan as (start: string, end: string) => string;
const dueForInspection = (inspections as unknown as Record<string, unknown>).dueForInspection as (log: Inspection[], item: Item, today: string) => boolean;
const openBalance = (ledgerModule as unknown as Record<string, unknown>).openBalance as (ledger: Ledger, reservationId: string, dueCents: number) => number;

const [drill, , camera] = seedCatalog();
const check = (itemId: string, day: string): Inspection => ({ itemId, day, passed: true, notes: "ok" });
const pay = (id: string, reservationId: string, cents: number): Payment => ({ id, reservationId, cents, kind: "payment", day: "2025-03-10" });
const back = (id: string, reservationId: string, cents: number): Payment => ({ id, reservationId, cents, kind: "refund", day: "2025-03-12" });

it("held-out: formatRentalSpan shows both days and the number of days", () => {
  expect(formatRentalSpan("2025-03-10", "2025-03-13")).toBe("2025-03-10 to 2025-03-13 (3 days)");
  expect(formatRentalSpan("2025-02-26", "2025-03-05")).toBe("2025-02-26 to 2025-03-05 (7 days)");
});

it("held-out: formatRentalSpan says 1 day for a one day rental", () => {
  expect(formatRentalSpan("2025-03-10", "2025-03-11")).toBe("2025-03-10 to 2025-03-11 (1 day)");
});

it("held-out: dueForInspection is true for an item never inspected", () => {
  expect(dueForInspection([], drill, "2025-03-10")).toBe(true);
  expect(dueForInspection([check("itm-0003", "2025-03-01")], drill, "2025-03-10")).toBe(true);
});

it("held-out: dueForInspection is true from the day the interval ends and false before it", () => {
  const log = [check("itm-0001", "2025-01-01"), check("itm-0003", "2025-01-01")];
  expect(dueForInspection(log, drill, "2025-03-31")).toBe(false);
  expect(dueForInspection(log, drill, "2025-04-01")).toBe(true);
  expect(dueForInspection(log, drill, "2025-09-01")).toBe(true);
  expect(dueForInspection(log, camera, "2025-03-01")).toBe(false);
  expect(dueForInspection(log, camera, "2025-03-02")).toBe(true);
});

it("held-out: openBalance is what is still owed after payments and refunds", () => {
  const ledger: Ledger = [pay("pay-1", "res-1", 5000), back("pay-2", "res-1", 1000), pay("pay-3", "res-2", 900)];
  expect(openBalance(ledger, "res-1", 10000)).toBe(6000);
  expect(openBalance(ledger, "res-2", 1500)).toBe(600);
  expect(openBalance(ledger, "res-3", 2500)).toBe(2500);
});

it("held-out: openBalance is never negative", () => {
  const ledger: Ledger = [pay("pay-1", "res-1", 5000)];
  expect(openBalance(ledger, "res-1", 5000)).toBe(0);
  expect(openBalance(ledger, "res-1", 3000)).toBe(0);
  expect(openBalance([], "res-1", 0)).toBe(0);
});
