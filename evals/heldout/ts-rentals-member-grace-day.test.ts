import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import type { Customer } from "../src/customers/customer.js";
import * as membership from "../src/customers/membership.js";
import { upgradeToMember } from "../src/customers/membership.js";
import * as fees from "../src/pricing/late-fees.js";

const lateDays = fees.lateDays as (due: string, returned: string, customer?: Customer) => number;
const lateFeeCents = fees.lateFeeCents as (item: ReturnType<typeof seedCatalog>[number], due: string, returned: string, customer?: Customer) => number;
const memberGraceDays = (membership as unknown as Record<string, unknown>).memberGraceDays as (customer: Customer | undefined) => number;

const [drill] = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });
const member = upgradeToMember(ana);

it("held-out: a member gets one grace day before late fees start", () => {
  expect(lateDays("2025-03-13", "2025-03-13", member)).toBe(0);
  expect(lateDays("2025-03-13", "2025-03-14", member)).toBe(0);
  expect(lateFeeCents(drill, "2025-03-13", "2025-03-14", member)).toBe(0);
});

it("held-out: a member returning two days after the due date is charged one late day", () => {
  expect(lateDays("2025-03-13", "2025-03-15", member)).toBe(1);
  expect(lateFeeCents(drill, "2025-03-13", "2025-03-15", member)).toBe(2250);
  expect(lateDays("2025-03-13", "2025-03-18", member)).toBe(4);
});

it("held-out: a standard customer gets no grace day", () => {
  expect(lateDays("2025-03-13", "2025-03-14", ana)).toBe(1);
  expect(lateDays("2025-03-13", "2025-03-14", undefined)).toBe(1);
  expect(lateFeeCents(drill, "2025-03-13", "2025-03-14", ana)).toBe(2250);
  expect(lateDays("2025-03-13", "2025-03-13", ana)).toBe(0);
});

it("held-out: memberGraceDays is one for a member and zero for anyone else", () => {
  expect(memberGraceDays(member)).toBe(1);
  expect(memberGraceDays(ana)).toBe(0);
  expect(memberGraceDays(undefined)).toBe(0);
});
