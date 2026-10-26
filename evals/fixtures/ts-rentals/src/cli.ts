import { findItem, listLines, seedCatalog } from "./catalog/catalog.js";
import { findCustomer } from "./customers/customer.js";
import { revenueCents } from "./reports/revenue.js";
import { quoteFor } from "./reservations/quote.js";
import { isDay } from "./util/dates.js";
import { formatCents } from "./util/money.js";
import { loadState } from "./store/store.js";

export interface RunResult {
  code: number;
  out: string[];
  err: string[];
}

export interface RunOptions {
  storePath: string;
  customerId?: string;
}

/** Runs one command: items, quote <itemId> <start> <end>, reservations or revenue. */
export function run(argv: string[], options: RunOptions): RunResult {
  const [command, ...rest] = argv;
  const catalog = seedCatalog();
  const state = loadState(options.storePath);
  if (command === "items") return { code: 0, out: listLines(catalog), err: [] };
  if (command === "quote") {
    const [itemId, start, end] = rest;
    const item = itemId ? findItem(catalog, itemId) : undefined;
    if (!item) return { code: 1, out: [], err: [`unknown item ${itemId ?? ""}`.trim()] };
    if (!start || !end || !isDay(start) || !isDay(end)) return { code: 2, out: [], err: ["quote needs two ISO days"] };
    const customer = options.customerId ? findCustomer(state.customers, options.customerId) : undefined;
    const quote = quoteFor(item, start, end, customer);
    const lines = quote.lines.map((line) => `${line.label}: ${formatCents(line.cents)}`);
    return { code: 0, out: [...lines, `Total: ${formatCents(quote.totalCents)}`, `Deposit: ${formatCents(quote.depositCents)}`], err: [] };
  }
  if (command === "reservations") {
    if (state.reservations.length === 0) return { code: 0, out: ["(no reservations)"], err: [] };
    return { code: 0, out: state.reservations.map((r) => `${r.id} [${r.status}] ${r.itemId} ${r.start} to ${r.end}`), err: [] };
  }
  if (command === "revenue") {
    return { code: 0, out: [`Revenue: ${formatCents(revenueCents(state.reservations, catalog))}`], err: [] };
  }
  return { code: 2, out: [], err: [`unknown command ${command ?? ""}`.trim()] };
}
