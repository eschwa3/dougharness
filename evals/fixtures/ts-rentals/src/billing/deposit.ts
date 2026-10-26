import type { Item } from "../catalog/item.js";
import { formatCents } from "../util/money.js";
import type { Cents } from "../util/money.js";

/** The deposit held for an item. */
export function depositFor(item: Item): Cents {
  return item.depositCents;
}

/** What goes back to the customer once damage is taken out of the deposit. */
export function refundCents(depositCents: Cents, damageCents: Cents): Cents {
  return depositCents - damageCents;
}

/** One line for the return slip. */
export function describeRefund(depositCents: Cents, damageCents: Cents): string {
  const refund = refundCents(depositCents, damageCents);
  if (damageCents === 0) return `Deposit ${formatCents(depositCents)} returned in full`;
  return `Deposit ${formatCents(depositCents)}, damage ${formatCents(damageCents)}, refund ${formatCents(refund)}`;
}
