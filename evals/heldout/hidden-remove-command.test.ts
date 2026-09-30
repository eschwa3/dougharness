import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-remove-hidden-")), "tasks.json"), now });

it("hidden: a removed id is not reused, and done on that id then fails", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["add", "B"], ctx);
  expect(run(["remove", "2"], ctx).code).toBe(0);
  const added = run(["add", "C"], ctx);
  expect(added.out).toEqual(["added #3 C"]);
  expect(run(["done", "2"], ctx).code).toBe(1);
});

it("hidden: removing the only task then list prints (no tasks)", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  expect(run(["remove", "1"], ctx).code).toBe(0);
  expect(run(["list"], ctx).out).toEqual(["(no tasks)"]);
});

it("hidden: clear then add never reuses a cleared id", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["done", "1"], ctx);
  expect(run(["clear"], ctx)).toEqual({ code: 0, out: ["cleared 1"], err: [] });
  expect(run(["add", "B"], ctx).out).toEqual(["added #2 B"]);
});

it("hidden: a done task can be removed", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["done", "1"], ctx);
  expect(run(["remove", "1"], ctx)).toEqual({ code: 0, out: ["removed #1"], err: [] });
});

it("hidden: removing the same id twice is code 1 the second time", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  expect(run(["remove", "1"], ctx).code).toBe(0);
  expect(run(["remove", "1"], ctx).code).toBe(1);
});

it("hidden: remove with no argument is code 1", () => {
  const ctx = freshCtx();
  expect(run(["remove"], ctx).code).toBe(1);
});

it("hidden: remove 1.5 is code 1", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  expect(run(["remove", "1.5"], ctx).code).toBe(1);
});

it("hidden: clear with no done tasks prints cleared 0", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  expect(run(["clear"], ctx)).toEqual({ code: 0, out: ["cleared 0"], err: [] });
});

it("hidden: clearing every task prints the count and the tasks stay gone", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["add", "B"], ctx);
  run(["done", "1"], ctx);
  run(["done", "2"], ctx);
  expect(run(["clear"], ctx)).toEqual({ code: 0, out: ["cleared 2"], err: [] });
  expect(run(["list"], ctx).out).toEqual(["(no tasks)"]);
});

it("hidden: removing a task keeps the others' order and ids", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["add", "B"], ctx);
  run(["add", "C"], ctx);
  expect(run(["remove", "2"], ctx).code).toBe(0);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] A", "#3 [open] C"]);
});
