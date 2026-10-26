import { describe, it, expect } from "vitest";
import { displayName, findCustomer, makeCustomer } from "../src/customers/customer.js";
import { MEMBER_DISCOUNT_PERCENT, downgradeToStandard, isMember, memberDiscountPercent, upgradeToMember } from "../src/customers/membership.js";

const ana = makeCustomer({ id: "cus-0001", name: " Ana Ruiz ", email: "ana@example.com", phone: "555-0101" });

describe("makeCustomer", () => {
  it("makes a standard customer with a trimmed name", () => {
    expect(ana).toEqual({ id: "cus-0001", name: "Ana Ruiz", email: "ana@example.com", phone: "555-0101", tier: "standard" });
  });
  it("leaves the phone out when none is given", () => {
    const bo = makeCustomer({ id: "cus-0002", name: "Bo", email: "bo@example.com" });
    expect("phone" in bo).toBe(false);
  });
  it("refuses a bad email, a blank name and a missing id", () => {
    expect(() => makeCustomer({ id: "cus-0003", name: "Cy", email: "cy-at-example" })).toThrow("bad email");
    expect(() => makeCustomer({ id: "cus-0003", name: " ", email: "cy@example.com" })).toThrow("needs a name");
    expect(() => makeCustomer({ id: "", name: "Cy", email: "cy@example.com" })).toThrow("needs an id");
  });
  it("shows members in the display name", () => {
    expect(displayName(ana)).toBe("Ana Ruiz");
    expect(displayName(upgradeToMember(ana))).toBe("Ana Ruiz (member)");
  });
  it("finds a customer by id", () => {
    expect(findCustomer([ana], "cus-0001")).toBe(ana);
    expect(findCustomer([ana], "cus-0404")).toBeUndefined();
  });
});

describe("membership", () => {
  it("upgrades and downgrades without changing the original", () => {
    const member = upgradeToMember(ana);
    expect(isMember(member)).toBe(true);
    expect(isMember(ana)).toBe(false);
    expect(isMember(downgradeToStandard(member))).toBe(false);
  });
  it("gives members the member percentage and everyone else nothing", () => {
    expect(memberDiscountPercent(upgradeToMember(ana))).toBe(MEMBER_DISCOUNT_PERCENT);
    expect(memberDiscountPercent(ana)).toBe(0);
    expect(memberDiscountPercent(undefined)).toBe(0);
  });
});

describe("more customers", () => {
  it("keeps the phone number when it is given", () => {
    expect(ana.phone).toBe("555-0101");
  });
  it("starts every new customer as standard", () => {
    expect(makeCustomer({ id: "cus-0009", name: "Di", email: "di@example.com" }).tier).toBe("standard");
  });
  it("takes a member tier from the input", () => {
    expect(makeCustomer({ id: "cus-0009", name: "Di", email: "di@example.com", tier: "member" }).tier).toBe("member");
  });
  it("does not change the customer it upgrades", () => {
    upgradeToMember(ana);
    expect(ana.tier).toBe("standard");
  });
});
