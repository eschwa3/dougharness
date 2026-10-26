import type { Day } from "../util/dates.js";
import { sumCents } from "../util/money.js";
import type { Cents } from "../util/money.js";

export type PaymentKind = "payment" | "refund";

export interface Payment {
  id: string;
  reservationId: string;
  cents: Cents;
  kind: PaymentKind;
  day: Day;
}

/** A ledger is an append-only list of payments and refunds. */
export type Ledger = Payment[];

export function recordPayment(ledger: Ledger, payment: Payment): Ledger {
  if (!Number.isInteger(payment.cents) || payment.cents <= 0) throw new Error("a payment is a positive whole number of cents");
  if (ledger.some((p) => p.id === payment.id)) throw new Error(`duplicate payment ${payment.id}`);
  return [...ledger, payment];
}

export function paymentsFor(ledger: Ledger, reservationId: string): Payment[] {
  return ledger.filter((p) => p.reservationId === reservationId);
}

/** Money received for a reservation, before refunds. */
export function paidCents(ledger: Ledger, reservationId: string): Cents {
  return sumCents(
    paymentsFor(ledger, reservationId)
      .filter((p) => p.kind === "payment")
      .map((p) => p.cents),
  );
}

/** Money handed back for a reservation. */
export function refundedCents(ledger: Ledger, reservationId: string): Cents {
  return sumCents(
    paymentsFor(ledger, reservationId)
      .filter((p) => p.kind === "refund")
      .map((p) => p.cents),
  );
}

/** What the shop has kept for a reservation: received less refunded. */
export function netPaidCents(ledger: Ledger, reservationId: string): Cents {
  return paidCents(ledger, reservationId) - refundedCents(ledger, reservationId);
}
