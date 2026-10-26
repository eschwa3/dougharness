/** The tax on a subtotal in cents at a fractional rate (0.1 is 10%), in whole cents. */
export function taxFor(subtotalCents: number, rate: number): number {
  return Math.floor(subtotalCents * rate);
}
