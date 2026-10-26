import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import { createReservation } from "../src/reservations/reservation.js";
import { emptyState, loadState, saveState } from "../src/store/store.js";

let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "ts-rentals-")), "rentals.json");
});

describe("store", () => {
  it("loads an empty shop from a missing file", () => {
    expect(loadState(path)).toEqual(emptyState());
  });
  it("loads an empty shop from a blank file", () => {
    writeFileSync(path, "  \n");
    expect(loadState(path)).toEqual(emptyState());
  });
  it("round-trips the shop state", () => {
    const state = emptyState();
    state.customers.push(makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" }));
    state.reservations.push(createReservation({ id: "res-0001", item: seedCatalog()[0], customerId: "cus-0001", start: "2025-03-10", end: "2025-03-13" }, []));
    state.payments.push({ id: "pay-0001", reservationId: "res-0001", cents: 4500, kind: "payment", day: "2025-03-10" });
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
  });
  it("fills in lists a saved file leaves out", () => {
    writeFileSync(path, JSON.stringify({ customers: [] }));
    expect(loadState(path)).toEqual(emptyState());
  });
});

describe("more store", () => {
  it("writes pretty JSON ending in a newline", () => {
    saveState(path, emptyState());
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"reservations": []');
  });
  it("starts with three empty lists", () => {
    expect(emptyState()).toEqual({ customers: [], reservations: [], payments: [] });
  });
});
