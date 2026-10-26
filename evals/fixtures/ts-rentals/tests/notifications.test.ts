import { describe, it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import { makeCustomer } from "../src/customers/customer.js";
import { pickupReminders, startingTomorrow } from "../src/notifications/reminders.js";
import { TEMPLATES, render, subjectFor } from "../src/notifications/templates.js";
import { confirm, createReservation } from "../src/reservations/reservation.js";

const items = seedCatalog();
const ana = makeCustomer({ id: "cus-0001", name: "Ana", email: "ana@example.com" });
const bo = makeCustomer({ id: "cus-0002", name: "Bo", email: "bo@example.com" });

const tomorrow = confirm(createReservation({ id: "res-0001", item: items[0], customerId: "cus-0001", start: "2025-03-11", end: "2025-03-14" }, []));
const later = confirm(createReservation({ id: "res-0002", item: items[1], customerId: "cus-0002", start: "2025-03-20", end: "2025-03-22" }, []));
const unconfirmed = createReservation({ id: "res-0003", item: items[2], customerId: "cus-0001", start: "2025-03-11", end: "2025-03-12" }, []);

describe("templates", () => {
  it("has a confirmation, a pickup and a thanks template", () => {
    expect(Object.keys(TEMPLATES)).toEqual(["confirmation", "pickup", "thanks"]);
  });
  it("fills the customer, item and dates", () => {
    expect(render("confirmation", ana, tomorrow, items[0])).toBe("Hello Ana, your rental of Cordless drill from 2025-03-11 to 2025-03-14 is confirmed.");
    expect(render("thanks", bo, later, items[1])).toBe("Thank you Bo for renting the Tile saw.");
  });
  it("has a subject per template", () => {
    expect(subjectFor("confirmation")).toBe("Your rental is confirmed");
    expect(subjectFor("pickup")).toBe("Pickup tomorrow");
    expect(subjectFor("thanks")).toBe("Thank you");
  });
});

describe("pickup reminders", () => {
  it("finds confirmed reservations that start tomorrow", () => {
    expect(startingTomorrow([tomorrow, later, unconfirmed], "2025-03-10").map((r) => r.id)).toEqual(["res-0001"]);
  });
  it("writes one reminder to the customer's email", () => {
    const reminders = pickupReminders([tomorrow, later], [ana, bo], items, "2025-03-10");
    expect(reminders).toEqual([
      { reservationId: "res-0001", to: "ana@example.com", subject: "Pickup tomorrow", body: "Hello Ana, your Cordless drill is ready for pickup tomorrow, 2025-03-11." },
    ]);
  });
  it("skips a reservation whose customer is unknown", () => {
    expect(pickupReminders([tomorrow], [bo], items, "2025-03-10")).toEqual([]);
  });
  it("sends nothing when nothing starts tomorrow", () => {
    expect(pickupReminders([tomorrow, later], [ana, bo], items, "2025-03-15")).toEqual([]);
  });
});

describe("more notifications", () => {
  it("fills the pickup text with the start day", () => {
    expect(render("pickup", bo, later, items[1])).toBe("Hello Bo, your Tile saw is ready for pickup tomorrow, 2025-03-20.");
  });
  it("writes a reminder per customer when two start tomorrow", () => {
    const second = confirm(createReservation({ id: "res-0004", item: items[3], customerId: "cus-0002", start: "2025-03-11", end: "2025-03-13" }, []));
    const reminders = pickupReminders([tomorrow, second], [ana, bo], items, "2025-03-10");
    expect(reminders.map((r) => r.to)).toEqual(["ana@example.com", "bo@example.com"]);
  });
  it("skips a reservation whose item is unknown", () => {
    expect(pickupReminders([tomorrow], [ana], [], "2025-03-10")).toEqual([]);
  });
  it("does not remind about a rental that started today", () => {
    expect(startingTomorrow([tomorrow], "2025-03-11")).toEqual([]);
  });
});
