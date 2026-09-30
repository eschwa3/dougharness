import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
const freshCtx = () => ({ storePath: join(mkdtempSync(join(tmpdir(), "ts-app-remove-")), "tasks.json"), now });

it("held-out: remove deletes a task, and list no longer shows it", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  const r = run(["remove", "1"], ctx);
  expect(r).toEqual({ code: 0, out: ["removed #1"], err: [] });
  expect(run(["list"], ctx).out).toEqual(["(no tasks)"]);
});

it("held-out: removing an unknown or non-numeric id is code 1, err naming it", () => {
  const ctx = freshCtx();
  const r = run(["remove", "99"], ctx);
  expect(r.code).toBe(1);
  expect(r.err[0]).toContain("99");
});

it("held-out: clear removes only done tasks and prints the count", () => {
  const ctx = freshCtx();
  run(["add", "A"], ctx);
  run(["add", "B"], ctx);
  run(["done", "1"], ctx);
  const r = run(["clear"], ctx);
  expect(r).toEqual({ code: 0, out: ["cleared 1"], err: [] });
  expect(run(["list"], ctx).out).toEqual(["#2 [open] B"]);
});

it("held-out: the usage line names remove and clear", () => {
  const ctx = freshCtx();
  const err = run([], ctx).err[0];
  expect(err).toMatch(/remove/);
  expect(err).toMatch(/clear/);
});
