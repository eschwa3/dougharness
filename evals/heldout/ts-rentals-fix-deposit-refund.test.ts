import { it, expect } from "vitest";
import { describeRefund, refundCents } from "../src/billing/deposit.js";

it("held-out: damage above the deposit leaves a refund of zero", () => {
  expect(refundCents(5000, 8000)).toBe(0);
  expect(refundCents(15000, 15001)).toBe(0);
  expect(refundCents(0, 300)).toBe(0);
});

it("held-out: the return slip for damage above the deposit shows a zero refund", () => {
  expect(describeRefund(5000, 8000)).toBe("Deposit $50.00, damage $80.00, refund $0.00");
  expect(describeRefund(15000, 20000)).toBe("Deposit $150.00, damage $200.00, refund $0.00");
});

it("held-out: damage within the deposit still comes out of the refund", () => {
  expect(refundCents(5000, 1200)).toBe(3800);
  expect(refundCents(5000, 5000)).toBe(0);
  expect(refundCents(5000, 0)).toBe(5000);
  expect(describeRefund(5000, 1200)).toBe("Deposit $50.00, damage $12.00, refund $38.00");
});
