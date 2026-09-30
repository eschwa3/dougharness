import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-10T00:00:00.000Z");
const freshCtx = (nowFn = now) => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-due-hidden-")), "tasks.json"), now: nowFn });

it("hidden: +0d resolves to today and is not overdue", () => {
  const ctx = freshCtx();
  run(["add", "--due", "+0d", "Today"], ctx);
  const r = run(["list"], ctx);
  expect(r.out).toEqual(["#1 [open] Today due 2024-01-10"]);
});

it("hidden: a task due today is not overdue", () => {
  const ctx = freshCtx();
  run(["add", "--due", "2024-01-10", "Today"], ctx);
  expect(run(["list", "--overdue"], ctx).out).toEqual(["(no tasks)"]);
});

it("hidden: a task due yesterday is overdue", () => {
  const ctx = freshCtx();
  run(["add", "--due", "2024-01-09", "Yesterday"], ctx);
  expect(run(["list", "--overdue"], ctx).out).toEqual(["#1 [open] Yesterday due 2024-01-09 OVERDUE"]);
});

it("hidden: a done task with a past due date is neither OVERDUE in list nor counted by --overdue or report", () => {
  const ctx = freshCtx();
  run(["add", "--due", "2024-01-01", "Late"], ctx);
  run(["done", "1"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [done] Late due 2024-01-01"]);
  expect(run(["list", "--overdue"], ctx).out).toEqual(["(no tasks)"]);
  expect(run(["report"], ctx).out).toEqual(["open: 0", "done: 1", "overdue: 0"]);
});

it("hidden: report on an empty store prints all zeroes", () => {
  const ctx = freshCtx();
  expect(run(["report"], ctx).out).toEqual(["open: 0", "done: 0", "overdue: 0"]);
});

it("hidden: an unparseable due spec is code 1", () => {
  const ctx = freshCtx();
  for (const spec of ["+d", "+-1d", "2024-1-1", "2024/01/01"]) {
    expect(run(["add", "--due", spec, "Bad"], ctx).code).toBe(1);
  }
});

it("hidden: a task added without --due shows no due suffix, alongside one that has it", () => {
  const ctx = freshCtx();
  run(["add", "Plain"], ctx);
  run(["add", "--due", "2024-01-20", "Dated"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Plain", "#2 [open] Dated due 2024-01-20"]);
});

it("hidden: +2d from 2024-01-30 resolves to 2024-02-01", () => {
  const ctx = freshCtx(() => new Date("2024-01-30T00:00:00.000Z"));
  run(["add", "--due", "+2d", "X"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] X due 2024-02-01"]);
});

it("hidden: +1d from 2024-02-28 resolves to 2024-02-29 in a leap year", () => {
  const ctx = freshCtx(() => new Date("2024-02-28T00:00:00.000Z"));
  run(["add", "--due", "+1d", "X"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] X due 2024-02-29"]);
});

it("hidden: list --overdue prints in id order", () => {
  const ctx = freshCtx();
  run(["add", "--due", "2024-01-01", "A"], ctx);
  run(["add", "--due", "2024-01-05", "B"], ctx);
  run(["add", "--due", "+5d", "C"], ctx);
  run(["add", "--due", "2024-01-02", "D"], ctx);
  expect(run(["list", "--overdue"], ctx).out).toEqual([
    "#1 [open] A due 2024-01-01 OVERDUE",
    "#2 [open] B due 2024-01-05 OVERDUE",
    "#4 [open] D due 2024-01-02 OVERDUE",
  ]);
});

it("hidden: a task due in the future shows no OVERDUE", () => {
  const ctx = freshCtx();
  run(["add", "--due", "+5d", "Future"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Future due 2024-01-15"]);
});

it("hidden: a done task with a due date renders the date with no OVERDUE", () => {
  const ctx = freshCtx();
  run(["add", "--due", "2024-01-01", "Late"], ctx);
  run(["done", "1"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [done] Late due 2024-01-01"]);
});
