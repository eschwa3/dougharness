export interface StockEntry {
  onHand: number;
  reserved: number;
}

export type Stock = Record<string, StockEntry>;

/** Units that can still be reserved: on hand minus already reserved. Unknown skus have none. */
export function available(stock: Stock, sku: string): number {
  const e = stock[sku];
  return e ? e.onHand - e.reserved : 0;
}

/** Returns new stock with qty more units of the sku reserved. Throws when there are not enough. */
export function reserve(stock: Stock, sku: string, qty: number): Stock {
  const e = stock[sku];
  if (!e || qty > e.onHand) throw new Error(`not enough stock for ${sku}`);
  return { ...stock, [sku]: { ...e, reserved: e.reserved + qty } };
}

/** Returns new stock with qty reserved units of the sku released. Never goes below zero reserved. */
export function release(stock: Stock, sku: string, qty: number): Stock {
  const e = stock[sku];
  if (!e) throw new Error(`unknown sku: ${sku}`);
  return { ...stock, [sku]: { ...e, reserved: Math.max(0, e.reserved - qty) } };
}
