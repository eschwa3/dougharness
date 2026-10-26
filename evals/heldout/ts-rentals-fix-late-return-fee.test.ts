import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { lateDays, lateFeeCents } from "../src/pricing/late-fees.js";

const [drill, saw] = seedCatalog();

it("held-out: a return on or before the due date costs no late fee", () => {
  expect(lateDays("2025-03-13", "2025-03-13")).toBe(0);
  expect(lateFeeCents(drill, "2025-03-13", "2025-03-13")).toBe(0);
  expect(lateFeeCents(saw, "2025-03-13", "2025-03-13")).toBe(0);
  expect(lateDays("2025-03-13", "2025-03-12")).toBe(0);
  expect(lateFeeCents(drill, "2025-03-13", "2025-03-01")).toBe(0);
});

it("held-out: a return one day after the due date costs one late day", () => {
  expect(lateDays("2025-03-13", "2025-03-14")).toBe(1);
  expect(lateFeeCents(drill, "2025-03-13", "2025-03-14")).toBe(2250);
  expect(lateDays("2025-03-13", "2025-03-16")).toBe(3);
  expect(lateFeeCents(saw, "2025-03-13", "2025-03-15")).toBe(12000);
});
