import { available } from "./stock.js";
import type { Stock } from "./stock.js";

/** The skus whose available units are at or below the threshold, sorted. */
export function lowStock(stock: Stock, threshold: number): string[] {
  return Object.keys(stock)
    .filter((sku) => available(stock, sku) <= threshold)
    .sort();
}
