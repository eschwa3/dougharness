import type { Product } from "../catalog/product.js";

export interface CartLine {
  sku: string;
  qty: number;
  unitCents: number;
}

export type Cart = CartLine[];

/** Returns a new cart with qty more of the product. A product already in the cart has its line grown. */
export function addItem(cart: Cart, product: Product, qty: number): Cart {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("qty must be a positive whole number");
  const existing = cart.find((l) => l.sku === product.sku);
  if (!existing) return [...cart, { sku: product.sku, qty, unitCents: product.priceCents }];
  return cart.map((l) => (l.sku === product.sku ? { ...l, qty: l.qty + qty } : l));
}

export function removeItem(cart: Cart, sku: string): Cart {
  return cart.filter((l) => l.sku !== sku);
}

/** The sum of every line's qty times unit price, in cents. */
export function subtotal(cart: Cart): number {
  return cart.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
}
