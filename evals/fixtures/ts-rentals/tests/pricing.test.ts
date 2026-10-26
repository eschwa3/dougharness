import { describe, it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import { upgradeToMember } from "../src/customers/membership.js";
import { afterDiscount, bundleDiscountCents, memberDiscountCents, percentOffCents } from "../src/pricing/discounts.js";
import { feeForDays, lateDays, lateFeeCents } from "../src/pricing/late-fees.js";
import { billableDays, costForSpan, dayRateLabel, rentalCostCents, weekRateLabel } from "../src/pricing/rates.js";

const [drill, saw] = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });

describe("rates", () => {
  it("counts the days from pickup to the due day, at least one", () => {
    expect(billableDays("2025-03-10", "2025-03-13")).toBe(3);
    expect(billableDays("2025-03-10", "2025-03-11")).toBe(1);
    expect(billableDays("2025-03-10", "2025-03-10")).toBe(1);
  });
  it("multiplies the day rate by the days", () => {
    expect(rentalCostCents(drill, 1)).toBe(1500);
    expect(rentalCostCents(drill, 4)).toBe(6000);
    expect(rentalCostCents(saw, 2)).toBe(8000);
  });
  it("prices a pickup and due day", () => {
    expect(costForSpan(drill, "2025-03-10", "2025-03-13")).toBe(4500);
  });
  it("labels the rates", () => {
    expect(dayRateLabel(drill)).toBe("$15.00/day");
    expect(weekRateLabel(drill)).toBe("$75.00/week");
  });
});

describe("discounts", () => {
  it("takes a percentage off", () => {
    expect(percentOffCents(4000, 25)).toBe(1000);
    expect(percentOffCents(4000, 0)).toBe(0);
  });
  it("gives members ten percent and others nothing", () => {
    expect(memberDiscountCents(upgradeToMember(ana), 4500)).toBe(450);
    expect(memberDiscountCents(ana, 4500)).toBe(0);
    expect(memberDiscountCents(undefined, 4500)).toBe(0);
  });
  it("gives a bundle discount from the second item", () => {
    expect(bundleDiscountCents(1, 10000)).toBe(0);
    expect(bundleDiscountCents(2, 10000)).toBe(500);
  });
  it("never goes below zero after a discount", () => {
    expect(afterDiscount(1000, 400)).toBe(600);
    expect(afterDiscount(1000, 1500)).toBe(0);
  });
});

describe("late fees", () => {
  it("charges nothing for an item that came back before the due day", () => {
    expect(lateDays("2025-03-13", "2025-03-11")).toBe(0);
    expect(lateDays("2025-03-13", "2025-03-06")).toBe(0);
    expect(lateFeeCents(drill, "2025-03-13", "2025-03-10")).toBe(0);
  });
  it("charges one and a half day rates for each late day", () => {
    expect(feeForDays(drill, 1)).toBe(2250);
    expect(feeForDays(drill, 2)).toBe(4500);
    expect(feeForDays(saw, 3)).toBe(18000);
    expect(feeForDays(saw, 0)).toBe(0);
  });
});

describe("more pricing", () => {
  it("prices every seeded item for one day at its day rate", () => {
    for (const item of seedCatalog()) expect(rentalCostCents(item, 1)).toBe(item.dayRateCents);
  });
  it("prices two days for every seeded item at twice the day rate", () => {
    for (const item of seedCatalog()) expect(costForSpan(item, "2025-03-10", "2025-03-12")).toBe(item.dayRateCents * 2);
  });
  it("rounds a bundle discount to the cent", () => {
    expect(bundleDiscountCents(3, 999)).toBe(50);
  });
  it("gives members ten percent of a small amount", () => {
    expect(memberDiscountCents(upgradeToMember(ana), 1500)).toBe(150);
    expect(memberDiscountCents(upgradeToMember(ana), 0)).toBe(0);
  });
  it("labels week rates for the seeded items", () => {
    expect(weekRateLabel(saw)).toBe("$200.00/week");
    expect(dayRateLabel(saw)).toBe("$40.00/day");
  });
  it("charges the late fee of three late days at four and a half day rates", () => {
    expect(feeForDays(drill, 3)).toBe(6750);
  });
});
