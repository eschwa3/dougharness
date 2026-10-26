import { it, expect } from "vitest";
import { seedCatalog } from "../src/catalog/catalog.js";
import * as utilisation from "../src/reports/utilisation.js";
import type { DateRange } from "../src/reports/utilisation.js";
import { cancel, createReservation } from "../src/reservations/reservation.js";
import type { Reservation } from "../src/reservations/reservation.js";

const bookedDaysByItem = (utilisation as unknown as Record<string, unknown>).bookedDaysByItem as (reservations: Reservation[], range: DateRange) => Record<string, number>;

const items = seedCatalog();
const rent = (id: string, itemIndex: number, start: string, end: string) =>
  createReservation({ id, item: items[itemIndex], customerId: "cus-0001", start, end }, []);
const range: DateRange = { from: "2025-06-01", to: "2025-06-15" };

it("held-out: booked days per item count each rental day inside the range", () => {
  const a = rent("res-0001", 0, "2025-06-02", "2025-06-05");
  const b = rent("res-0002", 0, "2025-06-10", "2025-06-12");
  const c = rent("res-0003", 1, "2025-06-03", "2025-06-04");
  expect(bookedDaysByItem([a, b, c], range)).toEqual({ "itm-0001": 5, "itm-0002": 1 });
  const before = rent("res-0004", 2, "2025-05-28", "2025-06-03");
  const after = rent("res-0005", 3, "2025-06-13", "2025-06-20");
  expect(bookedDaysByItem([before, after], range)).toEqual({ "itm-0003": 2, "itm-0004": 2 });
});

it("held-out: cancelled reservations book no days", () => {
  const a = rent("res-0006", 0, "2025-06-02", "2025-06-05");
  const b = rent("res-0007", 1, "2025-06-02", "2025-06-04");
  expect(bookedDaysByItem([cancel(a), b], range)).toEqual({ "itm-0002": 2 });
  expect(bookedDaysByItem([cancel(a)], range)).toEqual({});
});

it("held-out: an item with no booked days in the range is left out", () => {
  const outside = rent("res-0008", 0, "2025-07-01", "2025-07-05");
  const endsOnStart = rent("res-0009", 1, "2025-05-25", "2025-06-01");
  expect(bookedDaysByItem([outside, endsOnStart], range)).toEqual({});
  expect(bookedDaysByItem([], range)).toEqual({});
  expect(Object.keys(bookedDaysByItem([outside, rent("res-0010", 2, "2025-06-02", "2025-06-03")], range))).toEqual(["itm-0003"]);
});
