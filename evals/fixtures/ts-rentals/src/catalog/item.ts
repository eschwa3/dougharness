import type { Cents } from "../util/money.js";

export const CATEGORIES = ["tool", "camera", "audio", "outdoor"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Item {
  id: string;
  name: string;
  category: Category;
  /** Price of one rental day. */
  dayRateCents: Cents;
  /** Price of seven rental days. */
  weekRateCents: Cents;
  /** Held against damage until the item comes back. */
  depositCents: Cents;
}

/** Checks an item and returns it. Throws on a missing name, a bad category or a rate that is not whole cents. */
export function makeItem(input: Item): Item {
  if (!input.id) throw new Error("item needs an id");
  if (!input.name.trim()) throw new Error(`item ${input.id} needs a name`);
  if (!CATEGORIES.includes(input.category)) throw new Error(`item ${input.id} has unknown category ${input.category}`);
  for (const key of ["dayRateCents", "weekRateCents", "depositCents"] as const) {
    const value = input[key];
    if (!Number.isInteger(value) || value < 0) throw new Error(`item ${input.id}: ${key} must be whole cents`);
  }
  return { ...input, name: input.name.trim() };
}
