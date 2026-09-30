import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-report-hidden-")), "tasks.json"), now });

it("hidden: every command handles an empty store (count 0/0, search no matches, oldest none, export nothing)", () => {
  const ctx = freshCtx();
  expect(run(["count"], ctx).out).toEqual(["open: 0", "done: 0"]);
  expect(run(["search", "x"], ctx).out).toEqual(["(no matches)"]);
  expect(run(["oldest"], ctx).out).toEqual(["(no open tasks)"]);
  const exported = run(["export"], ctx);
  expect(exported.out).toEqual([]);
  expect(exported.code).toBe(0);
});

it("hidden: search matches case-insensitively regardless of the term's case", () => {
  const ctx = freshCtx();
  run(["add", "Buy Milk"], ctx);
  expect(run(["search", "MILK"], ctx).out).toEqual(["#1 [open] Buy Milk"]);
});

it("hidden: search's term is every word after 'search' joined by one space", () => {
  const ctx = freshCtx();
  run(["add", "Buy oat milk"], ctx);
  run(["add", "Buy milk"], ctx);
  expect(run(["search", "oat", "milk"], ctx).out).toEqual(["#1 [open] Buy oat milk"]);
});

it("hidden: search with no term is code 1 with err usage: search <term>", () => {
  const ctx = freshCtx();
  const r = run(["search"], ctx);
  expect(r.code).toBe(1);
  expect(r.err).toEqual(["usage: search <term>"]);
});

it("hidden: oldest ties (equal createdAt) are broken by the lower id", () => {
  const ctx = freshCtx();
  run(["add", "First"], ctx);
  run(["add", "Second"], ctx);
  expect(run(["oldest"], ctx).out).toEqual(["#1 [open] First"]);
});

it("hidden: oldest never returns a done task, even when it is chronologically oldest", () => {
  let current = new Date("2024-01-01T00:00:00.000Z");
  const ctx = { storePath: join(mkdtempSync(join(tmpdir(), "ts-app-report-hidden-")), "tasks.json"), now: () => current };
  run(["add", "First"], ctx);
  current = new Date("2024-01-02T00:00:00.000Z");
  run(["add", "Second"], ctx);
  run(["done", "1"], ctx);
  expect(run(["oldest"], ctx).out).toEqual(["#2 [open] Second"]);
});

it("hidden: each export line parses as JSON carrying id, title, status, and createdAt", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  const line = run(["export"], ctx).out[0];
  const parsed = JSON.parse(line);
  expect(parsed).toEqual({ id: 1, title: "A", status: "open", createdAt: now().toISOString() });
});

it("hidden: an unknown command is still code 2 with the extended usage line", () => {
  const ctx = freshCtx();
  const r = run(["bogus"], ctx);
  expect(r.code).toBe(2);
  expect(r.err).toEqual(["usage: <add|list|done|count|search|oldest|export> [args]"]);
});
