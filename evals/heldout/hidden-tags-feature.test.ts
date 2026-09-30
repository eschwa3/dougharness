import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-tags-hidden-")), "tasks.json"), now });

it("hidden: a store file written by hand without tags loads and lists unchanged, alongside a tagged task", () => {
  const ctx = freshCtx();
  writeFileSync(ctx.storePath, JSON.stringify([{ id: 1, title: "Legacy", status: "open", createdAt: now().toISOString() }], null, 2) + "\n");
  run(["add", "--tag", "a", "Tagged"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Legacy", "#2 [open] Tagged [a]"]);
});

it("hidden: list --tag x prints (no tasks) when nothing carries it", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  expect(run(["list", "--tag", "x"], ctx).out).toEqual(["(no tasks)"]);
});

it("hidden: --tag a --tag a renders [a] once, since tags are a set", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "a", "--tag", "a", "X"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] X [a]"]);
});

it("hidden: done keeps every tag a task carries", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "a", "--tag", "b", "X"], ctx);
  run(["done", "1"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [done] X [a, b]"]);
});

it("hidden: tags survive being read by a second, independent run call on the same store", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "a", "X"], ctx);
  const ctx2 = { storePath: ctx.storePath, now };
  expect(run(["list"], ctx2).out).toEqual(["#1 [open] X [a]"]);
});

it("hidden: list --tag keeps id order", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "a", "First"], ctx);
  run(["add", "--tag", "a", "Second"], ctx);
  const out = run(["list", "--tag", "a"], ctx).out;
  expect(out[0].startsWith("#1 ")).toBe(true);
  expect(out[1].startsWith("#2 ")).toBe(true);
});

it("hidden: add --tag with the value missing is code 1", () => {
  const ctx = freshCtx();
  const r = run(["add", "--tag"], ctx);
  expect(r.code).toBe(1);
});

it("hidden: an exact-case lookup (the same case used at add time) finds only the tagged task", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "Work", "X"], ctx);
  run(["add", "--tag", "Home", "Y"], ctx);
  const out = run(["list", "--tag", "Work"], ctx).out;
  expect(out.some((l) => l.startsWith("#1 "))).toBe(true);
  expect(out.some((l) => l.startsWith("#2 "))).toBe(false);
});

it("hidden: case-sensitivity in --tag lookups is applied consistently", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "Work", "X"], ctx);
  const found = (out: string[]) => out.some((l: string) => l.startsWith("#1 "));
  expect(found(run(["list", "--tag", "work"], ctx).out)).toBe(found(run(["list", "--tag", "WORK"], ctx).out));
});

it("hidden: the tag suffix comes after the title on a done task", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "a", "X"], ctx);
  run(["done", "1"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [done] X [a]"]);
});

it("hidden: a whitespace-only tag is code 1", () => {
  const ctx = freshCtx();
  const r = run(["add", "--tag", "  ", "Bad"], ctx);
  expect(r.code).toBe(1);
});
