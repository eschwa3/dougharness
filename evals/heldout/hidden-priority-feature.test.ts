import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-priority-hidden-")), "tasks.json"), now });

it("hidden: priority values are case-sensitive; HIGH is rejected", () => {
  const ctx = freshCtx();
  const r = run(["add", "--priority", "HIGH", "Task"], ctx);
  expect(r.code).toBe(1);
});

it("hidden: --priority as the last argument with no value is code 1", () => {
  const ctx = freshCtx();
  const r = run(["add", "--priority"], ctx);
  expect(r.code).toBe(1);
});

it("hidden: an empty title with a valid priority is code 1", () => {
  const ctx = freshCtx();
  const r = run(["add", "--priority", "high"], ctx);
  expect(r.code).toBe(1);
});

it("hidden: a task stored without a priority field loads, shows no marker, and sorts as normal", () => {
  const ctx = freshCtx();
  writeFileSync(ctx.storePath, JSON.stringify([{ id: 1, title: "Legacy", status: "open", createdAt: now().toISOString() }], null, 2) + "\n");
  run(["add", "--priority", "high", "High"], ctx);
  run(["add", "--priority", "low", "Low"], ctx);
  const r = run(["list"], ctx);
  expect(r.out).toEqual(["#2 [open] High (high)", "#1 [open] Legacy", "#3 [open] Low (low)"]);
});

it("hidden: list --priority low prints (no tasks) when nothing matches", () => {
  const ctx = freshCtx();
  run(["add", "--priority", "high", "A"], ctx);
  const r = run(["list", "--priority", "low"], ctx);
  expect(r.out).toEqual(["(no tasks)"]);
});

it("hidden: ties within a priority break by id, across an interleaved set of four or more tasks", () => {
  const ctx = freshCtx();
  run(["add", "--priority", "low", "A"], ctx);
  run(["add", "--priority", "high", "B"], ctx);
  run(["add", "--priority", "low", "C"], ctx);
  run(["add", "--priority", "high", "D"], ctx);
  const r = run(["list"], ctx);
  expect(r.out).toEqual(["#2 [open] B (high)", "#4 [open] D (high)", "#1 [open] A (low)", "#3 [open] C (low)"]);
});

it("hidden: done keeps the priority marker", () => {
  const ctx = freshCtx();
  run(["add", "--priority", "high", "X"], ctx);
  run(["done", "1"], ctx);
  const r = run(["list"], ctx);
  expect(r.out).toEqual(["#1 [done] X (high)"]);
});

it("hidden: priority survives being read by a second, independent run call on the same store path", () => {
  const ctx = freshCtx();
  run(["add", "--priority", "high", "X"], ctx);
  const ctx2 = { storePath: ctx.storePath, now };
  const r = run(["list"], ctx2);
  expect(r.out).toEqual(["#1 [open] X (high)"]);
});
