import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-tags-")), "tasks.json"), now });

it("held-out: add with two tags renders them after the title", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "a", "--tag", "b", "Ship", "it"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Ship it [a, b]"]);
});

it("held-out: list --tag filters to tasks carrying that tag", () => {
  const ctx = freshCtx();
  run(["add", "--tag", "work", "A"], ctx);
  run(["add", "B"], ctx);
  expect(run(["list", "--tag", "work"], ctx).out).toEqual(["#1 [open] A [work]"]);
});

it("held-out: a task with no tags renders unchanged", () => {
  const ctx = freshCtx();
  run(["add", "Plain"], ctx);
  expect(run(["list"], ctx).out).toEqual(["#1 [open] Plain"]);
});

it("held-out: an empty tag is code 1", () => {
  const ctx = freshCtx();
  const r = run(["add", "--tag", "", "Bad"], ctx);
  expect(r.code).toBe(1);
});
