import { describe, it, expect } from "vitest";
import { depositFor, describeRefund, refundCents } from "../src/billing/deposit.js";
import { buildInvoice, invoiceLines } from "../src/billing/invoice.js";
import { DEFAULT_TAX_BP, taxCents, taxLabel, withTax } from "../src/billing/tax.js";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import { upgradeToMember } from "../src/customers/membership.js";
import { createReservation } from "../src/reservations/reservation.js";

const [drill, saw] = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });
const sawRental = createReservation({ id: "res-0001", item: saw, customerId: "cus-0001", start: "2025-03-10", end: "2025-03-12" }, []);
const drillRental = createReservation({ id: "res-0002", item: drill, customerId: "cus-0001", start: "2025-03-10", end: "2025-03-14" }, []);

describe("tax", () => {
  it("uses eight percent by default", () => {
    expect(DEFAULT_TAX_BP).toBe(800);
    expect(taxCents(10000)).toBe(800);
    expect(taxCents(8000)).toBe(640);
    expect(taxCents(0)).toBe(0);
  });
  it("takes a rate in basis points", () => {
    expect(taxCents(10000, 500)).toBe(500);
    expect(taxCents(10000, 0)).toBe(0);
  });
  it("adds tax to an amount and labels the rate", () => {
    expect(withTax(10000)).toBe(10800);
    expect(taxLabel()).toBe("8%");
    expect(taxLabel(500)).toBe("5%");
  });
});

describe("invoice", () => {
  it("has one rental line for a standard customer", () => {
    expect(invoiceLines(sawRental, saw)).toEqual([{ label: "Tile saw, 2 days", cents: 8000 }]);
  });
  it("adds a negative member discount line", () => {
    const lines = invoiceLines(sawRental, saw, { customer: upgradeToMember(ana) });
    expect(lines).toEqual([
      { label: "Tile saw, 2 days", cents: 8000 },
      { label: "Member discount", cents: -800 },
    ]);
  });
  it("adds a late fee line when a fee is given", () => {
    const lines = invoiceLines(drillRental, drill, { lateFeeCents: 2250 });
    expect(lines.at(-1)).toEqual({ label: "Late fee", cents: 2250 });
  });
  it("totals the lines and the tax", () => {
    const invoice = buildInvoice("inv-0001", sawRental, saw);
    expect(invoice).toMatchObject({ id: "inv-0001", reservationId: "res-0001", subtotalCents: 8000, taxCents: 640, totalCents: 8640 });
  });
  it("taxes the amount after the member discount", () => {
    const invoice = buildInvoice("inv-0002", sawRental, saw, { customer: upgradeToMember(ana) });
    expect(invoice.subtotalCents).toBe(7200);
    expect(invoice.taxCents).toBe(576);
    expect(invoice.totalCents).toBe(7776);
  });
  it("takes the tax rate from the options", () => {
    expect(buildInvoice("inv-0003", sawRental, saw, { taxBp: 0 }).totalCents).toBe(8000);
  });
});

describe("deposit", () => {
  it("holds the item's deposit", () => {
    expect(depositFor(saw)).toBe(15000);
  });
  it("hands back the deposit less damage that is within it", () => {
    expect(refundCents(15000, 0)).toBe(15000);
    expect(refundCents(15000, 4000)).toBe(11000);
    expect(refundCents(15000, 15000)).toBe(0);
  });
  it("describes the refund for the return slip", () => {
    expect(describeRefund(5000, 0)).toBe("Deposit $50.00 returned in full");
    expect(describeRefund(5000, 1200)).toBe("Deposit $50.00, damage $12.00, refund $38.00");
  });
});

describe("more billing", () => {
  it("rounds tax to the nearest cent", () => {
    expect(taxCents(1250)).toBe(100);
    expect(taxCents(1000, 725)).toBe(73);
  });
  it("builds an invoice for a one day rental", () => {
    const one = createReservation({ id: "res-0003", item: drill, customerId: "cus-0001", start: "2025-03-10", end: "2025-03-11" }, []);
    const invoice = buildInvoice("inv-0004", one, drill);
    expect(invoice.lines).toEqual([{ label: "Cordless drill, 1 day", cents: 1500 }]);
    expect(invoice.subtotalCents).toBe(1500);
    expect(invoice.taxCents).toBe(120);
    expect(invoice.totalCents).toBe(1620);
  });
  it("includes the late fee in the subtotal and the tax", () => {
    const invoice = buildInvoice("inv-0005", drillRental, drill, { lateFeeCents: 2250 });
    expect(invoice.subtotalCents).toBe(6000 + 2250);
    expect(invoice.taxCents).toBe(660);
  });
  it("ignores a zero late fee", () => {
    expect(invoiceLines(drillRental, drill, { lateFeeCents: 0 })).toHaveLength(1);
  });
  it("describes a small deduction", () => {
    expect(describeRefund(20000, 500)).toBe("Deposit $200.00, damage $5.00, refund $195.00");
  });
  it("keeps the invoice id and reservation id", () => {
    const invoice = buildInvoice("inv-0006", sawRental, saw);
    expect(invoice.id).toBe("inv-0006");
    expect(invoice.reservationId).toBe("res-0001");
  });
});
