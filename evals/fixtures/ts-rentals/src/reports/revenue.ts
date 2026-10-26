import type { Item } from "../catalog/item.js";
import { billableDays, rentalCostCents } from "../pricing/rates.js";
import type { Reservation } from "../reservations/reservation.js";
import { sumCents } from "../util/money.js";
import type { Cents } from "../util/money.js";

/** Reservations that count as revenue: everything except cancelled ones. */
function earning(reservations: Reservation[]): Reservation[] {
  return reservations.filter((r) => r.status !== "cancelled");
}

/** The rental charge of one reservation, priced like a quote. */
export function reservationRevenueCents(reservation: Reservation, item: Item): Cents {
  return rentalCostCents(item, billableDays(reservation.start, reservation.end));
}

/** Rental revenue over the reservations. A reservation whose item is unknown adds nothing. */
export function revenueCents(reservations: Reservation[], items: Item[]): Cents {
  const parts = earning(reservations).map((r) => {
    const item = items.find((i) => i.id === r.itemId);
    return item ? reservationRevenueCents(r, item) : 0;
  });
  return sumCents(parts);
}

/** Rental revenue per item category. */
export function revenueByCategory(reservations: Reservation[], items: Item[]): Record<string, Cents> {
  const totals: Record<string, Cents> = {};
  for (const r of earning(reservations)) {
    const item = items.find((i) => i.id === r.itemId);
    if (!item) continue;
    totals[item.category] = (totals[item.category] ?? 0) + reservationRevenueCents(r, item);
  }
  return totals;
}
