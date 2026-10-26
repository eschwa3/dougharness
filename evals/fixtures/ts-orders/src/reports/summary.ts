import type { Order } from "../orders/order.js";

export interface Summary {
  count: number;
  revenueCents: number;
  averageCents: number;
}

/** Count, revenue and average of the non-cancelled orders. The average of no orders is 0. */
export function summarize(orders: Order[]): Summary {
  const live = orders.filter((o) => o.status !== "cancelled");
  const revenueCents = live.reduce((sum, o) => sum + o.totalCents, 0);
  return { count: live.length, revenueCents, averageCents: live.length === 0 ? 0 : Math.round(revenueCents / live.length) };
}
