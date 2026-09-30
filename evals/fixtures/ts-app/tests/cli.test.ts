import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const now = () => new Date("2024-01-01T00:00:00.000Z");
let storePath: string;

beforeEach(() => {
  storePath = join(mkdtempSync(join(tmpdir(), "ts-app-")), "tasks.json");
});

describe("run", () => {
  it("add creates a task and prints it", () => {
    const r = run(["add", "Ship", "it"], { storePath, now });
    expect(r).toEqual({ code: 0, out: ["added #1 Ship it"], err: [] });
  });

  it("list prints (no tasks) when empty, then one line per task in id order", () => {
    expect(run(["list"], { storePath, now })).toEqual({ code: 0, out: ["(no tasks)"], err: [] });
    run(["add", "First"], { storePath, now });
    run(["add", "Second"], { storePath, now });
    expect(run(["list"], { storePath, now })).toEqual({
      code: 0,
      out: ["#1 [open] First", "#2 [open] Second"],
      err: [],
    });
  });

  it("done marks a task done and prints it, list then shows the new status", () => {
    run(["add", "First"], { storePath, now });
    expect(run(["done", "1"], { storePath, now })).toEqual({ code: 0, out: ["done #1"], err: [] });
    expect(run(["list"], { storePath, now })).toEqual({ code: 0, out: ["#1 [done] First"], err: [] });
  });

  it("done on an unknown id is code 1 with err naming it", () => {
    const r = run(["done", "99"], { storePath, now });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("99");
  });

  it("an unknown or missing command is code 2 with a usage line in err", () => {
    expect(run(["bogus"], { storePath, now }).code).toBe(2);
    expect(run([], { storePath, now }).code).toBe(2);
    expect(run([], { storePath, now }).err[0]).toMatch(/usage/i);
  });
});
