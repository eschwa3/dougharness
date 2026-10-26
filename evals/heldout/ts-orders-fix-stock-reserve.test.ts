import { it, expect } from "vitest";
import { reserve, available } from "../src/inventory/stock.js";

it("held-out: a reservation cannot exceed the available units", () => {
  const stock = { "G-1": { onHand: 3, reserved: 2 } };
  expect(() => reserve(stock, "G-1", 2)).toThrow();
  expect(available(reserve(stock, "G-1", 1), "G-1")).toBe(0);
});

it("held-out: two reservations together cannot exceed what is on hand", () => {
  const once = reserve({ "W-1": { onHand: 5, reserved: 0 } }, "W-1", 4);
  expect(() => reserve(once, "W-1", 2)).toThrow();
});
