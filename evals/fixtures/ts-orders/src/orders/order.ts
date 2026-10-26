import type { Cart, CartLine } from "../cart/cart.js";
import { subtotal } from "../cart/cart.js";
import { taxFor } from "../billing/tax.js";
import { canTransition } from "./status.js";
import type { Status } from "./status.js";

export interface Order {
  id: string;
  lines: CartLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  status: Status;
  placedAt: string;
}

/** Turns a non-empty cart into a pending order with tax at the given rate. */
export function placeOrder(cart: Cart, id: string, now: Date, rate: number): Order {
  if (cart.length === 0) throw new Error("cannot place an order from an empty cart");
  const subtotalCents = subtotal(cart);
  const taxCents = taxFor(subtotalCents, rate);
  return { id, lines: cart, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, status: "pending", placedAt: now.toISOString() };
}

/** Moves an order to a new status. Throws when the status table does not allow it. */
export function advance(order: Order, to: Status): Order {
  if (!canTransition(order.status, to)) throw new Error(`cannot move an order from ${order.status} to ${to}`);
  return { ...order, status: to };
}
