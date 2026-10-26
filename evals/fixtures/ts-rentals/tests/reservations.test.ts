import { describe, it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer, } from "../src/customers/customer.js";
import { upgradeToMember } from "../src/customers/membership.js";
import { bookingsFrom, cancel, confirm, createReservation, markReturned, pickUp, plannedDays } from "../src/reservations/reservation.js";
import { quoteFor } from "../src/reservations/quote.js";
import { advance, canTransition, holdsItem, isFinal } from "../src/reservations/status.js";

const [drill, saw] = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });

const base = createReservation({ id: "res-0001", item: drill, customerId: "cus-0001", start: "2025-03-10", end: "2025-03-13" }, []);

describe("status", () => {
  it("allows the normal path and nothing backwards", () => {
    expect(canTransition("requested", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "picked-up")).toBe(true);
    expect(canTransition("picked-up", "returned")).toBe(true);
    expect(canTransition("returned", "confirmed")).toBe(false);
    expect(canTransition("requested", "returned")).toBe(false);
  });
  it("throws on a move that is not allowed", () => {
    expect(advance("requested", "confirmed")).toBe("confirmed");
    expect(() => advance("returned", "cancelled")).toThrow("cannot move a reservation from returned to cancelled");
  });
  it("knows final statuses and statuses that hold an item", () => {
    expect(isFinal("returned")).toBe(true);
    expect(isFinal("cancelled")).toBe(true);
    expect(isFinal("confirmed")).toBe(false);
    expect(holdsItem("picked-up")).toBe(true);
    expect(holdsItem("cancelled")).toBe(false);
  });
});

describe("createReservation", () => {
  it("starts as requested with the item's deposit", () => {
    expect(base).toMatchObject({ id: "res-0001", itemId: "itm-0001", status: "requested", depositCents: 5000 });
    expect(plannedDays(base)).toBe(3);
  });
  it("refuses backwards or empty dates", () => {
    expect(() => createReservation({ id: "res-0002", item: drill, customerId: "c", start: "2025-03-13", end: "2025-03-10" }, [])).toThrow("at least one day");
    expect(() => createReservation({ id: "res-0002", item: drill, customerId: "c", start: "2025-03-10", end: "2025-03-10" }, [])).toThrow("at least one day");
  });
  it("refuses dates inside a held booking", () => {
    expect(() => createReservation({ id: "res-0002", item: drill, customerId: "c", start: "2025-03-11", end: "2025-03-12" }, [base])).toThrow("not available");
  });
  it("accepts another item on the same dates and the same item on later dates", () => {
    expect(createReservation({ id: "res-0002", item: saw, customerId: "c", start: "2025-03-10", end: "2025-03-13" }, [base]).itemId).toBe("itm-0002");
    expect(createReservation({ id: "res-0003", item: drill, customerId: "c", start: "2025-03-20", end: "2025-03-22" }, [base]).status).toBe("requested");
  });
  it("ignores cancelled reservations when it looks for conflicts", () => {
    const cancelled = cancel(base);
    expect(bookingsFrom([cancelled])).toEqual([]);
    expect(createReservation({ id: "res-0004", item: drill, customerId: "c", start: "2025-03-11", end: "2025-03-12" }, [cancelled]).id).toBe("res-0004");
  });
});

describe("the reservation life", () => {
  it("moves through confirm, pickup and return and records the return day", () => {
    const returned = markReturned(pickUp(confirm(base)), "2025-03-12");
    expect(returned.status).toBe("returned");
    expect(returned.returnedOn).toBe("2025-03-12");
    expect(base.status).toBe("requested");
  });
  it("cannot be picked up before it is confirmed", () => {
    expect(() => pickUp(base)).toThrow("cannot move");
  });
});

describe("quoteFor", () => {
  it("prices the days at the day rate and carries the deposit", () => {
    const quote = quoteFor(drill, "2025-03-10", "2025-03-13");
    expect(quote).toMatchObject({ itemId: "itm-0001", days: 3, subtotalCents: 4500, discountCents: 0, totalCents: 4500, depositCents: 5000 });
    expect(quote.lines).toEqual([{ label: "Cordless drill, 3 days", cents: 4500 }]);
  });
  it("charges one day for a same day rental", () => {
    expect(quoteFor(drill, "2025-03-10", "2025-03-10").totalCents).toBe(1500);
  });
  it("takes the member discount off the total", () => {
    const quote = quoteFor(saw, "2025-03-10", "2025-03-12", upgradeToMember(ana));
    expect(quote.subtotalCents).toBe(8000);
    expect(quote.discountCents).toBe(800);
    expect(quote.totalCents).toBe(7200);
    expect(quote.lines[1]).toEqual({ label: "Member discount", cents: -800 });
  });
  it("gives a standard customer no discount line", () => {
    expect(quoteFor(saw, "2025-03-10", "2025-03-12", ana).lines).toHaveLength(1);
  });
});

describe("more reservation rules", () => {
  it("cannot be confirmed twice", () => {
    expect(() => confirm(confirm(base))).toThrow("cannot move");
  });
  it("can be cancelled while requested or confirmed but not after pickup", () => {
    expect(cancel(base).status).toBe("cancelled");
    expect(cancel(confirm(base)).status).toBe("cancelled");
    expect(() => cancel(pickUp(confirm(base)))).toThrow("cannot move");
  });
  it("holds the item while picked up and frees it once returned", () => {
    const out = pickUp(confirm(base));
    expect(bookingsFrom([out])).toEqual([{ itemId: "itm-0001", start: "2025-03-10", end: "2025-03-13" }]);
    expect(bookingsFrom([markReturned(out, "2025-03-12")])).toEqual([]);
  });
  it("copies the deposit of the item at the time of the booking", () => {
    expect(createReservation({ id: "res-0010", item: saw, customerId: "c", start: "2025-04-01", end: "2025-04-03" }, []).depositCents).toBe(15000);
  });
  it("prices a five day rental at the day rate times the days", () => {
    expect(quoteFor(saw, "2025-03-10", "2025-03-15").totalCents).toBe(20000);
  });
  it("names the item and the days on the first quote line", () => {
    expect(quoteFor(saw, "2025-03-10", "2025-03-11").lines[0].label).toBe("Tile saw, 1 day");
  });
});
