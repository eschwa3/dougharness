import { it, expect } from "vitest";
import * as sales from "../src/reports/sales.js";

type Order = { id: string; lines: { sku: string; qty: number; unitCents: number }[]; subtotalCents: number; taxCents: number; totalCents: number; status: "pending" | "paid" | "shipped" | "cancelled"; placedAt: string };
const topProducts = (sales as unknown as Record<string, unknown>).topProducts as (orders: Order[], n: number) => { sku: string; qty: number }[];

const order = (id: string, status: Order["status"], lines: Order["lines"]): Order => ({ id, lines, subtotalCents: 0, taxCents: 0, totalCents: 0, status, placedAt: "2024-03-01T00:00:00.000Z" });

it("held-out: topProducts ranks skus by units sold, leaving cancelled orders out", () => {
  const orders = [
    order("a", "paid", [{ sku: "W-1", qty: 2, unitCents: 100 }, { sku: "G-1", qty: 5, unitCents: 100 }]),
    order("b", "shipped", [{ sku: "W-1", qty: 4, unitCents: 100 }]),
    order("c", "cancelled", [{ sku: "X-1", qty: 50, unitCents: 100 }]),
  ];
  expect(topProducts(orders, 2)).toEqual([
    { sku: "W-1", qty: 6 },
    { sku: "G-1", qty: 5 },
  ]);
  expect(topProducts(orders, 1)).toEqual([{ sku: "W-1", qty: 6 }]);
});

it("held-out: topProducts breaks ties by sku and returns [] for no orders", () => {
  const orders = [order("a", "paid", [{ sku: "B-1", qty: 1, unitCents: 1 }, { sku: "A-1", qty: 1, unitCents: 1 }])];
  expect(topProducts(orders, 5).map((r) => r.sku)).toEqual(["A-1", "B-1"]);
  expect(topProducts([], 3)).toEqual([]);
});
