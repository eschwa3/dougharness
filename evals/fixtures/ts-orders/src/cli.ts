import { pathToFileURL } from "node:url";
import { loadOrders } from "./store/store.js";
import { salesByDay } from "./reports/sales.js";
import { summarize } from "./reports/summary.js";
import { buildInvoice } from "./billing/invoice.js";
import { formatMoney } from "./util/money.js";

export interface Ctx {
  storePath: string;
}

export interface CommandResult {
  code: number;
  out: string[];
  err: string[];
}

const USAGE = "usage: <orders|sales|summary|invoice <id>>";

/** Dispatches argv[0] to a read-only report over the order file. Unknown or missing: code 2 with a usage line in err. */
export function run(argv: string[], ctx: Ctx): CommandResult {
  const [command, arg] = argv;
  const orders = loadOrders(ctx.storePath);
  switch (command) {
    case "orders":
      return { code: 0, out: orders.length === 0 ? ["(no orders)"] : orders.map((o) => `${o.id} [${o.status}] ${formatMoney(o.totalCents)}`), err: [] };
    case "sales": {
      const days = salesByDay(orders);
      return { code: 0, out: Object.keys(days).sort().map((d) => `${d} ${formatMoney(days[d] ?? 0)}`), err: [] };
    }
    case "summary": {
      const s = summarize(orders);
      return { code: 0, out: [`${s.count} orders, ${formatMoney(s.revenueCents)} revenue, ${formatMoney(s.averageCents)} average`], err: [] };
    }
    case "invoice": {
      const order = orders.find((o) => o.id === arg);
      if (!order) return { code: 1, out: [], err: [`no order ${arg ?? ""}`.trim()] };
      return { code: 0, out: buildInvoice(order), err: [] };
    }
    default:
      return { code: 2, out: [], err: [USAGE] };
  }
}

export function main(): void {
  const result = run(process.argv.slice(2), { storePath: process.env.ORDERS_FILE || "./orders.json" });
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  process.exit(result.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
