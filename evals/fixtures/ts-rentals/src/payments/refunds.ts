import type { Day } from "../util/dates.js";
import { minCents } from "../util/money.js";
import type { Cents } from "../util/money.js";
import { netPaidCents } from "./ledger.js";
import type { Ledger, Payment } from "./ledger.js";

/** The most the shop can hand back for a reservation. */
export function refundableCents(ledger: Ledger, reservationId: string): Cents {
  return Math.max(0, netPaidCents(ledger, reservationId));
}

/** A requested refund held to what is refundable. */
export function planRefund(ledger: Ledger, reservationId: string, requestedCents: Cents): Cents {
  return minCents(Math.max(0, requestedCents), refundableCents(ledger, reservationId));
}

/** The ledger entry for a refund, or null when nothing can be handed back. */
export function refundEntry(ledger: Ledger, id: string, reservationId: string, requestedCents: Cents, day: Day): Payment | null {
  const cents = planRefund(ledger, reservationId, requestedCents);
  if (cents === 0) return null;
  return { id, reservationId, cents, kind: "refund", day };
}
