import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-report-")), "tasks.json"), now });

it("held-out: count prints open and done counts", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["add", "B"], ctx);
  run(["done", "1"], ctx);
  expect(run(["count"], ctx).out).toEqual(["open: 1", "done: 1"]);
});

it("held-out: search prints matching formatTask lines case-insensitively in id order", () => {
  const ctx = freshCtx();
  run(["add", "Buy milk"], ctx);
  run(["add", "Buy eggs"], ctx);
  run(["add", "Clean"], ctx);
  expect(run(["search", "buy"], ctx).out).toEqual(["#1 [open] Buy milk", "#2 [open] Buy eggs"]);
});

it("held-out: oldest prints the open task with the smallest createdAt", () => {
  let current = new Date("2024-01-01T00:00:00.000Z");
  const ctx = { storePath: join(mkdtempSync(join(tmpdir(), "ts-app-report-")), "tasks.json"), now: () => current };
  run(["add", "First"], ctx);
  current = new Date("2024-01-02T00:00:00.000Z");
  run(["add", "Second"], ctx);
  expect(run(["oldest"], ctx).out).toEqual(["#1 [open] First"]);
});

it("held-out: export prints one JSON.stringify(task) line per task in id order", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["add", "B"], ctx);
  const out = run(["export"], ctx).out;
  expect(out.map((l) => JSON.parse(l).title)).toEqual(["A", "B"]);
});
