import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-10T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-due-")), "tasks.json"), now });

it("held-out: add --due +2d resolves against now, and shows the resolved date in list", () => {
  const ctx = freshCtx();
  run(["add", "--due", "+2d", "Ship", "it"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Ship it due 2024-01-12"]);
});

it("held-out: a past YYYY-MM-DD due date shows OVERDUE", () => {
  const ctx = freshCtx();
  run(["add", "--due", "2024-01-01", "Late", "one"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Late one due 2024-01-01 OVERDUE"]);
});

it("held-out: list --overdue filters, and done removes a task from --overdue", () => {
  const ctx = freshCtx();
  run(["add", "--due", "+2d", "Future"], ctx);
  run(["add", "--due", "2024-01-01", "Late"], ctx);
  expect(run(["list", "--overdue"], ctx).out).toEqual(["#2 [open] Late due 2024-01-01 OVERDUE"]);
  run(["done", "2"], ctx);
  expect(run(["list", "--overdue"], ctx).out).toEqual(["(no tasks)"]);
});

it("held-out: report prints the open, done, and overdue counts", () => {
  const ctx = freshCtx();
  run(["add", "--due", "+2d", "Future"], ctx);
  run(["add", "--due", "2024-01-01", "Late"], ctx);
  run(["done", "2"], ctx);
  expect(run(["report"], ctx).out).toEqual(["open: 1", "done: 1", "overdue: 0"]);
});

it("held-out: an unparseable --due spec is code 1", () => {
  const ctx = freshCtx();
  const r = run(["add", "--due", "soon", "Bad"], ctx);
  expect(r.code).toBe(1);
});
