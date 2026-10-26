import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { saveOrders } from "../src/store/store.js";
import { placeOrder } from "../src/orders/order.js";

let storePath: string;

beforeEach(() => {
  storePath = join(mkdtempSync(join(tmpdir(), "ts-orders-")), "orders.json");
});

describe("run", () => {
  it("prints (no orders) on an empty store", () => {
    expect(run(["orders"], { storePath })).toEqual({ code: 0, out: ["(no orders)"], err: [] });
    expect(run(["summary"], { storePath }).out).toEqual(["0 orders, $0.00 revenue, $0.00 average"]);
  });
  it("lists orders, sales and an invoice from a saved store", () => {
    const order = placeOrder([{ sku: "W-1", qty: 2, unitCents: 500 }], "ord-0001", new Date("2024-03-01T00:00:00.000Z"), 0.1);
    saveOrders(storePath, [order]);
    expect(run(["orders"], { storePath }).out).toEqual(["ord-0001 [pending] $11.00"]);
    expect(run(["sales"], { storePath }).out).toEqual(["2024-03-01 $11.00"]);
    expect(run(["invoice", "ord-0001"], { storePath }).out[0]).toBe("Invoice ord-0001");
  });
  it("unknown invoice is code 1, unknown command is code 2", () => {
    expect(run(["invoice", "nope"], { storePath }).code).toBe(1);
    expect(run(["bogus"], { storePath }).code).toBe(2);
    expect(run([], { storePath }).code).toBe(2);
  });
});
