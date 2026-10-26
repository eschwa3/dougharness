import { describe, it, expect } from "vitest";
import { taxFor } from "../src/billing/tax.js";
import { applyPercent } from "../src/billing/discount.js";
import { buildInvoice } from "../src/billing/invoice.js";
import { placeOrder } from "../src/orders/order.js";

describe("billing", () => {
  it("taxes an exact amount", () => {
    expect(taxFor(1000, 0.1)).toBe(100);
    expect(taxFor(0, 0.2)).toBe(0);
  });
  it("takes a percent off", () => {
    expect(applyPercent(1000, 10)).toBe(900);
    expect(applyPercent(1000, 0)).toBe(1000);
    expect(() => applyPercent(1000, 101)).toThrow();
  });
  it("builds an invoice", () => {
    const order = placeOrder([{ sku: "W-1", qty: 2, unitCents: 500 }], "ord-0001", new Date("2024-03-01T00:00:00.000Z"), 0.1);
    expect(buildInvoice(order)).toEqual(["Invoice ord-0001", "2 x W-1 @ $5.00 = $10.00", "Subtotal $10.00", "Tax $1.00", "Total $11.00"]);
  });
});
