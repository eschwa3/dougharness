import { it, expect } from "vitest";
import { searchProducts } from "../src/catalog/catalog.js";

const catalog = [
  { sku: "W-1", name: "Blue Widget", priceCents: 250, category: "parts" },
  { sku: "G-1", name: "gadget", priceCents: 1999, category: "tools" },
];

it("held-out: search ignores case in both the name and the query", () => {
  expect(searchProducts(catalog, "widget").map((p) => p.sku)).toEqual(["W-1"]);
  expect(searchProducts(catalog, "GADGET").map((p) => p.sku)).toEqual(["G-1"]);
  expect(searchProducts(catalog, "BLUE w").map((p) => p.sku)).toEqual(["W-1"]);
});
