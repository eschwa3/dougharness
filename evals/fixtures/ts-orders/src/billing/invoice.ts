import type { Order } from "../orders/order.js";
import { formatMoney } from "../util/money.js";

/** Plain-text invoice lines for an order: one per line item, then subtotal, tax and total. */
export function buildInvoice(order: Order): string[] {
  const lines = order.lines.map((l) => `${l.qty} x ${l.sku} @ ${formatMoney(l.unitCents)} = ${formatMoney(l.qty * l.unitCents)}`);
  return [`Invoice ${order.id}`, ...lines, `Subtotal ${formatMoney(order.subtotalCents)}`, `Tax ${formatMoney(order.taxCents)}`, `Total ${formatMoney(order.totalCents)}`];
}
