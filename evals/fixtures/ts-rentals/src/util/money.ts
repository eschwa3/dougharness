/** Money is integer cents throughout the shop. */
export type Cents = number;

/** True for a whole number of cents. */
export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isInteger(value);
}

/** Formats cents as dollars, for example 12345 becomes "$123.45". */
export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/** Parses "$12.30", "12.3" or "-4" into cents. Throws on anything else. */
export function parseCents(text: string): Cents {
  const match = /^(-?)\$?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error(`not a money amount: ${text}`);
  const whole = Number(match[2]) * 100;
  const fraction = Number((match[3] ?? "").padEnd(2, "0") || "0");
  const cents = whole + fraction;
  return match[1] ? -cents : cents;
}

export function sumCents(values: Cents[]): Cents {
  return values.reduce((total, value) => total + value, 0);
}

/** A percentage of an amount, rounded to the nearest cent (halves round up). */
export function percentOf(cents: Cents, percent: number): Cents {
  return Math.round((cents * percent) / 100);
}

/** The smaller of two amounts. */
export function minCents(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}
