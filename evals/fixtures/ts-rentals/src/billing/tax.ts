import type { Cents } from "../util/money.js";

/** Sales tax in basis points: 800 is 8 percent. */
export const DEFAULT_TAX_BP = 800;

export function taxCents(cents: Cents, rateBp: number = DEFAULT_TAX_BP): Cents {
  return Math.round((cents * rateBp) / 10_000);
}

/** The amount with tax added. */
export function withTax(cents: Cents, rateBp: number = DEFAULT_TAX_BP): Cents {
  return cents + taxCents(cents, rateBp);
}

/** Tax shown as a percentage, "8%" for 800. */
export function taxLabel(rateBp: number = DEFAULT_TAX_BP): string {
  return `${rateBp / 100}%`;
}
