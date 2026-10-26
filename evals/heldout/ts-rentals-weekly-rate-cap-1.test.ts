import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { costForSpan, rentalCostCents } from "../src/pricing/rates.js";
import { quoteFor } from "../src/reservations/quote.js";

const [drill, saw, camera] = seedCatalog();

it("held-out: each full week of a rental costs the weekly rate", () => {
  expect(rentalCostCents(drill, 7)).toBe(7500);
  expect(rentalCostCents(drill, 14)).toBe(15000);
  expect(rentalCostCents(saw, 7)).toBe(20000);
  expect(rentalCostCents(saw, 21)).toBe(60000);
  expect(costForSpan(camera, "2025-03-03", "2025-03-10")).toBe(30000);
});

it("held-out: the days left over after the full weeks never cost more than one weekly rate", () => {
  expect(rentalCostCents(drill, 6)).toBe(7500);
  expect(rentalCostCents(drill, 5)).toBe(7500);
  expect(rentalCostCents(drill, 4)).toBe(6000);
  expect(rentalCostCents(drill, 8)).toBe(9000);
  expect(rentalCostCents(drill, 13)).toBe(15000);
  expect(rentalCostCents(camera, 12)).toBe(60000);
  expect(costForSpan(drill, "2025-03-10", "2025-03-16")).toBe(7500);
});

it("held-out: a quote for a long rental shows the capped subtotal", () => {
  const six = quoteFor(drill, "2025-03-10", "2025-03-16");
  expect(six.days).toBe(6);
  expect(six.subtotalCents).toBe(7500);
  expect(six.totalCents).toBe(7500);
  expect(six.lines[0].cents).toBe(7500);
  const nine = quoteFor(saw, "2025-03-10", "2025-03-19");
  expect(nine.subtotalCents).toBe(28000);
  expect(nine.totalCents).toBe(28000);
});
