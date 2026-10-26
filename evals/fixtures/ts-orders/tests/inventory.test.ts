import { describe, it, expect } from "vitest";
import { available, reserve, release } from "../src/inventory/stock.js";
import { lowStock } from "../src/inventory/restock.js";
import type { Stock } from "../src/inventory/stock.js";

const stock: Stock = { "W-1": { onHand: 10, reserved: 0 }, "G-1": { onHand: 3, reserved: 2 } };

describe("stock", () => {
  it("reports available units", () => {
    expect(available(stock, "W-1")).toBe(10);
    expect(available(stock, "G-1")).toBe(1);
    expect(available(stock, "nope")).toBe(0);
  });
  it("reserves and releases", () => {
    const after = reserve(stock, "W-1", 4);
    expect(available(after, "W-1")).toBe(6);
    expect(available(release(after, "W-1", 10), "W-1")).toBe(10);
  });
  it("refuses a reservation larger than what is on hand, and an unknown sku", () => {
    expect(() => reserve(stock, "W-1", 11)).toThrow();
    expect(() => reserve(stock, "nope", 1)).toThrow();
  });
  it("lists low-stock skus sorted", () => {
    expect(lowStock(stock, 1)).toEqual(["G-1"]);
    expect(lowStock(stock, 10)).toEqual(["G-1", "W-1"]);
  });
});
