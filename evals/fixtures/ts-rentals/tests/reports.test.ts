import { describe, it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { revenueByCategory, revenueCents, reservationRevenueCents } from "../src/reports/revenue.js";
import { nextRange, rangeDays, sharedDays } from "../src/reports/utilisation.js";
import { cancel, createReservation } from "../src/reservations/reservation.js";

const items = seedCatalog();

const make = (id: string, itemIndex: number, start: string, end: string) =>
  createReservation({ id, item: items[itemIndex], customerId: "cus-0001", start, end }, []);

const drillRental = make("res-0001", 0, "2025-03-10", "2025-03-13");
const sawRental = make("res-0002", 1, "2025-03-10", "2025-03-12");
const cameraRental = make("res-0003", 2, "2025-03-18", "2025-03-19");

describe("revenue", () => {
  it("prices one reservation like a quote", () => {
    expect(reservationRevenueCents(drillRental, items[0])).toBe(4500);
    expect(reservationRevenueCents(sawRental, items[1])).toBe(8000);
  });
  it("adds up the rentals", () => {
    expect(revenueCents([drillRental, sawRental, cameraRental], items)).toBe(18500);
    expect(revenueCents([], items)).toBe(0);
  });
  it("leaves out cancelled reservations", () => {
    expect(revenueCents([drillRental, cancel(sawRental)], items)).toBe(4500);
  });
  it("adds nothing for a reservation whose item is unknown", () => {
    expect(revenueCents([drillRental], [])).toBe(0);
  });
  it("splits revenue by category", () => {
    expect(revenueByCategory([drillRental, sawRental, cameraRental], items)).toEqual({ tool: 12500, camera: 6000 });
  });
});

describe("date ranges", () => {
  it("counts the days in a range, never below zero", () => {
    expect(rangeDays({ from: "2025-03-01", to: "2025-03-08" })).toBe(7);
    expect(rangeDays({ from: "2025-03-08", to: "2025-03-01" })).toBe(0);
  });
  it("counts the days a span shares with a range", () => {
    const range = { from: "2025-03-10", to: "2025-03-20" };
    expect(sharedDays({ start: "2025-03-12", end: "2025-03-15" }, range)).toBe(3);
    expect(sharedDays({ start: "2025-03-05", end: "2025-03-12" }, range)).toBe(2);
    expect(sharedDays({ start: "2025-03-18", end: "2025-03-25" }, range)).toBe(2);
    expect(sharedDays({ start: "2025-03-25", end: "2025-03-27" }, range)).toBe(0);
  });
  it("makes the next range as long as the last", () => {
    expect(nextRange({ from: "2025-03-01", to: "2025-03-08" })).toEqual({ from: "2025-03-08", to: "2025-03-15" });
  });
});

describe("more reports", () => {
  it("adds nothing for an empty reservation list", () => {
    expect(revenueByCategory([], items)).toEqual({});
  });
  it("sums two reservations of one category", () => {
    const second = make("res-0004", 0, "2025-04-01", "2025-04-03");
    expect(revenueByCategory([drillRental, second], items)).toEqual({ tool: 7500 });
  });
  it("counts a range that sits wholly inside a span", () => {
    expect(sharedDays({ start: "2025-03-01", end: "2025-03-31" }, { from: "2025-03-10", to: "2025-03-20" })).toBe(10);
  });
  it("shares no days when the span ends the day the range starts", () => {
    expect(sharedDays({ start: "2025-03-01", end: "2025-03-10" }, { from: "2025-03-10", to: "2025-03-20" })).toBe(0);
  });
});
