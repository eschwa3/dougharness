import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Order } from "../orders/order.js";

/** Loads orders from a JSON file. A missing or blank file is an empty list. */
export function loadOrders(path: string): Order[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as Order[];
}

export function saveOrders(path: string, orders: Order[]): void {
  writeFileSync(path, JSON.stringify(orders, null, 2) + "\n");
}
