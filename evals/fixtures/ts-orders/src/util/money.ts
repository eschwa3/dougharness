/** Rounds a fractional cent amount to whole cents, halves going up. */
export function roundCents(value: number): number {
  return Math.round(value);
}

/** Parses "12.34" (or "12") into 1234 cents. Throws on anything else. */
export function toCents(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`not a money amount: ${amount}`);
  const cents = (m[2] ?? "").padEnd(2, "0");
  return Number(m[1]) * 100 + Number(cents);
}

/** Renders cents as "$12.34". */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
