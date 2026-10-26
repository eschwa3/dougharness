import { it, expect } from "vitest";
import { buildInvoice, invoiceLines } from "../src/billing/invoice.js";
import { seedCatalog } from "../src/catalog/catalog.js";
import { revenueByCategory, revenueCents } from "../src/reports/revenue.js";
import { createReservation } from "../src/reservations/reservation.js";

const items = seedCatalog();
const [drill, saw] = items;

const rent = (id: string, itemIndex: number, start: string, end: string) =>
  createReservation({ id, item: items[itemIndex], customerId: "cus-0001", start, end }, []);

it("held-out: an invoice for a long rental shows the capped rental line", () => {
  const six = rent("res-0001", 0, "2025-03-10", "2025-03-16");
  expect(invoiceLines(six, drill)).toEqual([{ label: "Cordless drill, 6 days", cents: 7500 }]);
  const invoice = buildInvoice("inv-0001", six, drill);
  expect(invoice.subtotalCents).toBe(7500);
  expect(invoice.taxCents).toBe(600);
  expect(invoice.totalCents).toBe(8100);
  const nine = rent("res-0002", 1, "2025-03-10", "2025-03-19");
  expect(invoiceLines(nine, saw)[0].cents).toBe(28000);
});

it("held-out: the revenue report counts a long rental at its capped price", () => {
  const long = rent("res-0003", 0, "2025-04-01", "2025-04-09");
  const short = rent("res-0004", 1, "2025-04-01", "2025-04-03");
  expect(revenueCents([long], items)).toBe(9000);
  expect(revenueCents([long, short], items)).toBe(17000);
  expect(revenueByCategory([long, short], items)).toEqual({ tool: 17000 });
  const six = rent("res-0005", 0, "2025-05-01", "2025-05-07");
  expect(revenueCents([six], items)).toBe(7500);
});
