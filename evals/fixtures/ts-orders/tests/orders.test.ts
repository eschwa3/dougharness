import { describe, it, expect } from "vitest";
import { createProduct } from "../src/catalog/product.js";
import { addItem } from "../src/cart/cart.js";
import { placeOrder, advance } from "../src/orders/order.js";
import { canTransition } from "../src/orders/status.js";

const now = new Date("2024-03-01T10:00:00.000Z");
const cart = addItem([], createProduct("W-1", "widget", 500, "parts"), 2);

describe("orders", () => {
  it("places a pending order with tax", () => {
    const order = placeOrder(cart, "ord-0001", now, 0.1);
    expect(order).toMatchObject({ id: "ord-0001", subtotalCents: 1000, taxCents: 100, totalCents: 1100, status: "pending", placedAt: "2024-03-01T10:00:00.000Z" });
  });
  it("refuses an empty cart", () => {
    expect(() => placeOrder([], "ord-0002", now, 0.1)).toThrow();
  });
  it("walks the status table", () => {
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("shipped", "paid")).toBe(false);
    const order = placeOrder(cart, "ord-0003", now, 0);
    expect(advance(advance(order, "paid"), "shipped").status).toBe("shipped");
    expect(() => advance(order, "shipped")).toThrow();
  });
});
