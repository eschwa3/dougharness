import { roundCents } from "../util/money.js";

/** Takes percent off an amount in cents. Throws unless percent is between 0 and 100. */
export function applyPercent(cents: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new Error("percent must be between 0 and 100");
  return roundCents((cents * (100 - percent)) / 100);
}
