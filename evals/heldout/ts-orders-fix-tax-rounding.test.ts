import { it, expect } from "vitest";
import { taxFor } from "../src/billing/tax.js";

it("held-out: tax rounds half up to whole cents", () => {
  expect(taxFor(1005, 0.15)).toBe(151);
  expect(taxFor(999, 0.1)).toBe(100);
  expect(taxFor(1000, 0.1)).toBe(100);
});
