import { describe, it, expect } from "vitest";
import { salesByDay } from "../src/reports/sales.js";
import { summarize } from "../src/reports/summary.js";
import type { Order } from "../src/orders/order.js";

const order = (id: string, day: string, totalCents: number, status: Order["status"] = "paid"): Order => ({
  id,
  lines: [],
  subtotalCents: totalCents,
  taxCents: 0,
  totalCents,
  status,
  placedAt: `${day}T12:00:00.000Z`,
});

describe("reports", () => {
  const orders = [order("a", "2024-03-01", 1000), order("b", "2024-03-01", 500), order("c", "2024-03-02", 700, "cancelled"), order("d", "2024-03-02", 300)];
  it("sums sales per day without cancelled orders", () => {
    expect(salesByDay(orders)).toEqual({ "2024-03-01": 1500, "2024-03-02": 300 });
  });
  it("summarizes live orders", () => {
    expect(summarize(orders)).toEqual({ count: 3, revenueCents: 1800, averageCents: 600 });
    expect(summarize([])).toEqual({ count: 0, revenueCents: 0, averageCents: 0 });
  });
});
