import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Customer } from "../customers/customer.js";
import type { Ledger } from "../payments/ledger.js";
import type { Reservation } from "../reservations/reservation.js";

export interface State {
  customers: Customer[];
  reservations: Reservation[];
  payments: Ledger;
}

export function emptyState(): State {
  return { customers: [], reservations: [], payments: [] };
}

/** Loads the shop state from a JSON file. A missing or blank file is an empty shop. */
export function loadState(path: string): State {
  if (!existsSync(path)) return emptyState();
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) return emptyState();
  return { ...emptyState(), ...(JSON.parse(raw) as Partial<State>) };
}

export function saveState(path: string, state: State): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}
