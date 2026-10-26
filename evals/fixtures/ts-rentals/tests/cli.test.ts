import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import { upgradeToMember } from "../src/customers/membership.js";
import { createReservation } from "../src/reservations/reservation.js";
import { emptyState, saveState } from "../src/store/store.js";

let storePath: string;

beforeEach(() => {
  storePath = join(mkdtempSync(join(tmpdir(), "ts-rentals-")), "rentals.json");
});

describe("run", () => {
  it("lists the catalog", () => {
    const result = run(["items"], { storePath });
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("itm-0001 Cordless drill (tool)");
    expect(result.out).toHaveLength(5);
  });
  it("quotes a rental with the deposit", () => {
    expect(run(["quote", "itm-0001", "2025-03-10", "2025-03-13"], { storePath })).toEqual({
      code: 0,
      out: ["Cordless drill, 3 days: $45.00", "Total: $45.00", "Deposit: $50.00"],
      err: [],
    });
  });
  it("quotes a member rental with the discount line", () => {
    const state = emptyState();
    state.customers.push(upgradeToMember(makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" })));
    saveState(storePath, state);
    const result = run(["quote", "itm-0002", "2025-03-10", "2025-03-12"], { storePath, customerId: "cus-0001" });
    expect(result.out).toEqual(["Tile saw, 2 days: $80.00", "Member discount: -$8.00", "Total: $72.00", "Deposit: $150.00"]);
  });
  it("reports an unknown item as code 1 and bad days as code 2", () => {
    expect(run(["quote", "itm-9999", "2025-03-10", "2025-03-13"], { storePath }).code).toBe(1);
    expect(run(["quote", "itm-0001", "soon", "later"], { storePath }).code).toBe(2);
  });
  it("prints (no reservations) on an empty store and lists saved ones", () => {
    expect(run(["reservations"], { storePath }).out).toEqual(["(no reservations)"]);
    const state = emptyState();
    state.reservations.push(createReservation({ id: "res-0001", item: seedCatalog()[0], customerId: "cus-0001", start: "2025-03-10", end: "2025-03-13" }, []));
    saveState(storePath, state);
    expect(run(["reservations"], { storePath }).out).toEqual(["res-0001 [requested] itm-0001 2025-03-10 to 2025-03-13"]);
  });
  it("reports revenue from the saved reservations", () => {
    expect(run(["revenue"], { storePath }).out).toEqual(["Revenue: $0.00"]);
    const state = emptyState();
    state.reservations.push(createReservation({ id: "res-0001", item: seedCatalog()[0], customerId: "cus-0001", start: "2025-03-10", end: "2025-03-13" }, []));
    saveState(storePath, state);
    expect(run(["revenue"], { storePath }).out).toEqual(["Revenue: $45.00"]);
  });
  it("an unknown command is code 2", () => {
    expect(run(["bogus"], { storePath }).code).toBe(2);
    expect(run([], { storePath }).code).toBe(2);
  });
});

describe("more run", () => {
  it("says which item was unknown", () => {
    expect(run(["quote", "itm-9999", "2025-03-10", "2025-03-13"], { storePath }).err).toEqual(["unknown item itm-9999"]);
  });
  it("needs both days for a quote", () => {
    expect(run(["quote", "itm-0001", "2025-03-10"], { storePath }).err).toEqual(["quote needs two ISO days"]);
  });
  it("names an unknown command", () => {
    expect(run(["bogus"], { storePath }).err).toEqual(["unknown command bogus"]);
  });
  it("quotes a customer who is not in the store like any other", () => {
    const result = run(["quote", "itm-0001", "2025-03-10", "2025-03-13"], { storePath, customerId: "cus-0404" });
    expect(result.out[0]).toBe("Cordless drill, 3 days: $45.00");
  });
});
