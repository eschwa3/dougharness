import type { Order } from "../orders/order.js";

/** Revenue in cents per placement day (YYYY-MM-DD), cancelled orders left out. */
export function salesByDay(orders: Order[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of orders) {
    if (o.status === "cancelled") continue;
    const day = o.placedAt.slice(0, 10);
    out[day] = (out[day] ?? 0) + o.totalCents;
  }
  return out;
}
