import { describe, it, expect } from "vitest";
import { netPaidCents, paidCents, paymentsFor, recordPayment, refundedCents } from "../src/payments/ledger.js";
import type { Ledger, Payment } from "../src/payments/ledger.js";
import { planRefund, refundEntry, refundableCents } from "../src/payments/refunds.js";

const pay = (id: string, reservationId: string, cents: number, day = "2025-03-10"): Payment => ({ id, reservationId, cents, kind: "payment", day });
const back = (id: string, reservationId: string, cents: number, day = "2025-03-14"): Payment => ({ id, reservationId, cents, kind: "refund", day });

const ledger: Ledger = [pay("pay-1", "res-1", 5000), pay("pay-2", "res-1", 2500), back("pay-3", "res-1", 1000), pay("pay-4", "res-2", 900)];

describe("ledger", () => {
  it("records a payment without changing the old ledger", () => {
    const grown = recordPayment([], pay("pay-1", "res-1", 5000));
    expect(grown).toHaveLength(1);
    expect(recordPayment(grown, pay("pay-2", "res-1", 100))).toHaveLength(2);
    expect(grown).toHaveLength(1);
  });
  it("refuses zero, fractional and duplicate payments", () => {
    expect(() => recordPayment([], pay("pay-1", "res-1", 0))).toThrow("positive");
    expect(() => recordPayment([], pay("pay-1", "res-1", 10.5))).toThrow("positive");
    expect(() => recordPayment(ledger, pay("pay-1", "res-9", 100))).toThrow("duplicate payment");
  });
  it("lists the entries of one reservation", () => {
    expect(paymentsFor(ledger, "res-1")).toHaveLength(3);
    expect(paymentsFor(ledger, "res-9")).toEqual([]);
  });
  it("adds up money in, money out and what is kept", () => {
    expect(paidCents(ledger, "res-1")).toBe(7500);
    expect(refundedCents(ledger, "res-1")).toBe(1000);
    expect(netPaidCents(ledger, "res-1")).toBe(6500);
    expect(netPaidCents(ledger, "res-2")).toBe(900);
    expect(netPaidCents(ledger, "res-9")).toBe(0);
  });
});

describe("refunds", () => {
  it("allows a refund of what is still held", () => {
    expect(refundableCents(ledger, "res-1")).toBe(6500);
    expect(refundableCents(ledger, "res-9")).toBe(0);
  });
  it("holds a requested refund to the refundable amount", () => {
    expect(planRefund(ledger, "res-1", 2000)).toBe(2000);
    expect(planRefund(ledger, "res-1", 9000)).toBe(6500);
    expect(planRefund(ledger, "res-1", -50)).toBe(0);
  });
  it("makes a refund entry, or none when nothing can go back", () => {
    expect(refundEntry(ledger, "pay-9", "res-2", 5000, "2025-03-15")).toEqual({ id: "pay-9", reservationId: "res-2", cents: 900, kind: "refund", day: "2025-03-15" });
    expect(refundEntry(ledger, "pay-9", "res-9", 5000, "2025-03-15")).toBeNull();
  });
});

describe("more payments", () => {
  it("keeps entries in the order they were recorded", () => {
    expect(ledger.map((p) => p.id)).toEqual(["pay-1", "pay-2", "pay-3", "pay-4"]);
  });
  it("counts refunds only as money out", () => {
    expect(paidCents([back("pay-1", "res-1", 100)], "res-1")).toBe(0);
    expect(refundedCents([back("pay-1", "res-1", 100)], "res-1")).toBe(100);
  });
  it("shows a negative net when more went back than came in", () => {
    expect(netPaidCents([back("pay-1", "res-1", 100)], "res-1")).toBe(-100);
    expect(refundableCents([back("pay-1", "res-1", 100)], "res-1")).toBe(0);
  });
  it("plans a full refund when the request equals what is held", () => {
    expect(planRefund(ledger, "res-2", 900)).toBe(900);
  });
  it("makes no refund entry for a zero request", () => {
    expect(refundEntry(ledger, "pay-9", "res-1", 0, "2025-03-15")).toBeNull();
  });
});
