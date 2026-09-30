import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-priority-")), "tasks.json"), now });

it("held-out: add --priority high marks the task, a plain add shows no marker", () => {
  const ctx = freshCtx();
  run(["add", "--priority", "high", "Ship", "it"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Ship it (high)"]);
  run(["add", "Plain", "task"], ctx);
  expect(run(["list"], ctx).out[1]).toBe("#2 [open] Plain task");
});

it("held-out: an unknown priority is code 1, err naming the three allowed values", () => {
  const ctx = freshCtx();
  const r = run(["add", "--priority", "urgent", "Bad"], ctx);
  expect(r.code).toBe(1);
  const err = r.err.join(" ");
  expect(err).toContain("low");
  expect(err).toContain("normal");
  expect(err).toContain("high");
});

it("held-out: list --priority filters, and the default order is high, normal, low, then id", () => {
  const ctx = freshCtx();
  run(["add", "--priority", "low", "A"], ctx);
  run(["add", "--priority", "high", "B"], ctx);
  run(["add", "--priority", "normal", "C"], ctx);
  expect(run(["list", "--priority", "high"], ctx).out).toEqual(["#2 [open] B (high)"]);
  expect(run(["list"], ctx).out).toEqual(["#2 [open] B (high)", "#3 [open] C", "#1 [open] A (low)"]);
});
