import type { Customer } from "./customer.js";

/** Members take this percentage off the rental. */
export const MEMBER_DISCOUNT_PERCENT = 10;

export function isMember(customer: Customer): boolean {
  return customer.tier === "member";
}

export function memberDiscountPercent(customer: Customer | undefined): number {
  return customer && isMember(customer) ? MEMBER_DISCOUNT_PERCENT : 0;
}

export function upgradeToMember(customer: Customer): Customer {
  return { ...customer, tier: "member" };
}

export function downgradeToStandard(customer: Customer): Customer {
  return { ...customer, tier: "standard" };
}
