import { it, expect } from "vitest";
import * as text from "../src/util/text.js";
import * as discount from "../src/billing/discount.js";
import * as restock from "../src/inventory/restock.js";

const padLeft = (text as unknown as Record<string, unknown>).padLeft as (s: string, width: number) => string;
const padRight = (text as unknown as Record<string, unknown>).padRight as (s: string, width: number) => string;
const bulkDiscount = (discount as unknown as Record<string, unknown>).bulkDiscount as (qty: number, unitCents: number) => number;
const reorderQuantity = (restock as unknown as Record<string, unknown>).reorderQuantity as (onHand: number, target: number, packSize: number) => number;

it("held-out: padLeft and padRight pad with spaces and never cut", () => {
  expect(padLeft("7", 3)).toBe("  7");
  expect(padRight("ab", 4)).toBe("ab  ");
  expect(padLeft("long", 2)).toBe("long");
  expect(padRight("long", 2)).toBe("long");
});

it("held-out: bulkDiscount prices a line with 10% off from 10 units and 20% off from 50", () => {
  expect(bulkDiscount(9, 100)).toBe(900);
  expect(bulkDiscount(10, 100)).toBe(900);
  expect(bulkDiscount(50, 100)).toBe(4000);
  expect(() => bulkDiscount(0, 100)).toThrow();
});

it("held-out: reorderQuantity rounds the shortfall up to whole packs", () => {
  expect(reorderQuantity(3, 20, 6)).toBe(18);
  expect(reorderQuantity(20, 20, 6)).toBe(0);
  expect(reorderQuantity(25, 20, 6)).toBe(0);
  expect(() => reorderQuantity(1, 10, 0)).toThrow();
});
