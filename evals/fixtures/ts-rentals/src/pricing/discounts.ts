import type { Customer } from "../customers/customer.js";
import { memberDiscountPercent } from "../customers/membership.js";
import { percentOf } from "../util/money.js";
import type { Cents } from "../util/money.js";

/** The amount a percentage takes off. */
export function percentOffCents(cents: Cents, percent: number): Cents {
  return percentOf(cents, percent);
}

/** The member discount on an amount; zero for a customer who is not a member. */
export function memberDiscountCents(customer: Customer | undefined, cents: Cents): Cents {
  return percentOf(cents, memberDiscountPercent(customer));
}

/** Renting several items together takes 5 percent off from the second item on. */
export function bundleDiscountCents(itemCount: number, cents: Cents): Cents {
  return itemCount >= 2 ? percentOf(cents, 5) : 0;
}

/** An amount after a discount, never below zero. */
export function afterDiscount(cents: Cents, discountCents: Cents): Cents {
  return Math.max(0, cents - discountCents);
}
