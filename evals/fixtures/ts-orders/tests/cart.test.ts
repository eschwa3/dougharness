import { describe, it, expect } from "vitest";
import { createProduct } from "../src/catalog/product.js";
import { addItem, removeItem, subtotal } from "../src/cart/cart.js";

const widget = createProduct("W-1", "widget", 250, "parts");
const gadget = createProduct("G-1", "gadget", 1999, "tools");

describe("cart", () => {
  it("adds lines and grows an existing one", () => {
    const cart = addItem(addItem(addItem([], widget, 2), gadget, 1), widget, 3);
    expect(cart).toEqual([
      { sku: "W-1", qty: 5, unitCents: 250 },
      { sku: "G-1", qty: 1, unitCents: 1999 },
    ]);
  });
  it("rejects a non-positive quantity", () => {
    expect(() => addItem([], widget, 0)).toThrow();
    expect(() => addItem([], widget, 1.5)).toThrow();
  });
  it("removes a line", () => {
    expect(removeItem(addItem(addItem([], widget, 1), gadget, 1), "W-1")).toEqual([{ sku: "G-1", qty: 1, unitCents: 1999 }]);
  });
  it("sums quantity times price", () => {
    expect(subtotal([])).toBe(0);
    expect(subtotal(addItem(addItem([], widget, 2), gadget, 1))).toBe(2499);
  });
});
