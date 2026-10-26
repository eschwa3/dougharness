import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import type { Item } from "../src/catalog/item.js";
import { makeCustomer } from "../src/customers/customer.js";
import type { Customer } from "../src/customers/customer.js";
import { upgradeToMember } from "../src/customers/membership.js";
import * as discounts from "../src/pricing/discounts.js";

const memberPriceCents = (discounts as unknown as Record<string, unknown>).memberPriceCents as (customer: Customer | undefined, item: Item, days: number) => number;

const [drill, saw] = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });
const member = upgradeToMember(ana);

it("held-out: a member pays ten percent less than the capped price", () => {
  expect(memberPriceCents(member, drill, 6)).toBe(6750);
  expect(memberPriceCents(member, drill, 7)).toBe(6750);
  expect(memberPriceCents(member, saw, 14)).toBe(36000);
});

it("held-out: a member discount is worked out on the capped price, not on the day rate times the days", () => {
  expect(memberPriceCents(member, drill, 9)).toBe(9450);
  expect(memberPriceCents(member, saw, 10)).toBe(28800);
  expect(memberPriceCents(member, drill, 2)).toBe(2700);
});

it("held-out: a standard customer pays the capped price with no discount", () => {
  expect(memberPriceCents(ana, drill, 6)).toBe(7500);
  expect(memberPriceCents(undefined, drill, 9)).toBe(10500);
  expect(memberPriceCents(ana, saw, 14)).toBe(40000);
});
