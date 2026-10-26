import { it, expect } from "vitest";
import * as money from "../src/util/money.js";
import * as catalog from "../src/catalog/catalog.js";
import * as status from "../src/orders/status.js";

const splitCents = (money as unknown as Record<string, unknown>).splitCents as (total: number, parts: number) => number[];
const byCategory = (catalog as unknown as Record<string, unknown>).byCategory as (products: { sku: string; category: string }[]) => Record<string, string[]>;
const isTerminal = (status as unknown as Record<string, unknown>).isTerminal as (s: string) => boolean;

it("held-out: splitCents shares a total, the first parts taking the extra cents", () => {
  expect(splitCents(100, 3)).toEqual([34, 33, 33]);
  expect(splitCents(10, 5)).toEqual([2, 2, 2, 2, 2]);
  expect(splitCents(2, 3)).toEqual([1, 1, 0]);
  expect(() => splitCents(100, 0)).toThrow();
});

it("held-out: byCategory groups skus per category in catalog order", () => {
  const products = [
    { sku: "W-1", category: "parts" },
    { sku: "G-1", category: "tools" },
    { sku: "W-2", category: "parts" },
  ];
  expect(byCategory(products)).toEqual({ parts: ["W-1", "W-2"], tools: ["G-1"] });
  expect(byCategory([])).toEqual({});
});

it("held-out: isTerminal is true for shipped and cancelled only", () => {
  expect(isTerminal("shipped")).toBe(true);
  expect(isTerminal("cancelled")).toBe(true);
  expect(isTerminal("pending")).toBe(false);
  expect(isTerminal("paid")).toBe(false);
});
