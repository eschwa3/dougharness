import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProject } from "./helpers.mjs";
import { ownsPath, planScope, nearestTasks, scopeViolations, describeViolations, loadScopePlan } from "../lib/scope.mjs";

const plan = {
  version: 1,
  title: "T",
  goal: "g",
  status: "approved",
  acceptance: ["a"],
  verify: [],
  tasks: [
    { id: "core", title: "core", spec: "core work in src/lib", files: ["src/lib/parse.ts", "src/lib/format.ts"] },
    { id: "cli", title: "cli", spec: "cli entry point and its tests", files: ["src/cli.ts", "tests/cli.test.ts"] },
    { id: "docs", title: "docs", spec: "documentation under docs/", files: ["docs/", "README.md"] },
    { id: "gen", title: "gen", spec: "generated fixtures by glob", files: ["fixtures/*.json"] },
  ],
};

describe("ownsPath", () => {
  it("matches exact files and directories, not basenames elsewhere", () => {
    expect(ownsPath("src/a.ts", "src/a.ts")).toBe(true);
    expect(ownsPath("./src/a.ts", "src\\a.ts")).toBe(true);
    expect(ownsPath("src/a.ts", "src/a.tsx")).toBe(false);
    expect(ownsPath("docs/", "docs/x/y.md")).toBe(true);
    expect(ownsPath("docs", "docs/y.md")).toBe(true);
    expect(ownsPath("docs", "docsx/y.md")).toBe(false);
    expect(ownsPath("README.md", "docs/README.md")).toBe(false);
  });
  it("matches globs against the whole relative path", () => {
    expect(ownsPath("fixtures/*.json", "fixtures/a.json")).toBe(true);
    expect(ownsPath("fixtures/*.json", "fixtures/deep/a.json")).toBe(false);
    expect(ownsPath("src/**/*.ts", "src/x/y/z.ts")).toBe(true);
    expect(ownsPath("*.json", "pkg/a.json")).toBe(false);
  });
  it("rejects empty and non-string entries", () => {
    expect(ownsPath("", "a")).toBe(false);
    expect(ownsPath(null, "a")).toBe(false);
    expect(ownsPath("a", undefined)).toBe(false);
  });
});

describe("planScope and nearestTasks", () => {
  it("unions and sorts every owned path", () => {
    expect(planScope(plan)).toEqual(["README.md", "docs/", "fixtures/*.json", "src/cli.ts", "src/lib/format.ts", "src/lib/parse.ts", "tests/cli.test.ts"]);
  });
  it("picks the tasks with the longest shared directory prefix, keeping ties in plan order", () => {
    expect(nearestTasks(plan, "src/lib/other.ts")).toEqual([{ id: "core", via: "src/lib/parse.ts" }]);
    expect(nearestTasks(plan, "src/other.ts").map((n) => n.id)).toEqual(["core", "cli"]);
    expect(nearestTasks(plan, "tests/other.test.ts")).toEqual([{ id: "cli", via: "tests/cli.test.ts" }]);
    expect(nearestTasks(plan, "package.json")).toEqual([]);
  });
});

describe("scopeViolations", () => {
  it("reports only files no task owns, minus the ignore list and the flow's own files", () => {
    const changed = ["src/lib/parse.ts", "src/lib/other.ts", "docs/guide/a.md", "fixtures/a.json", "fixtures/deep/b.json", ".doug/plan.json", ".doug/anchor.md", ".doug/.state/s.json", "pnpm-lock.yaml", "package.json"];
    const v = scopeViolations(changed, plan, { ignore: ["pnpm-lock.yaml"] });
    expect(v.map((x) => x.file)).toEqual(["src/lib/other.ts", "fixtures/deep/b.json", "package.json"]);
    expect(v[0].nearest).toEqual([{ id: "core", via: "src/lib/parse.ts" }]);
    expect(v[1].nearest).toEqual([{ id: "gen", via: "fixtures/*.json" }]);
    expect(v[2].nearest).toEqual([]);
    const text = describeViolations(v, plan);
    expect(text).toContain('outside the approved plan "T"');
    expect(text).toContain("src/lib/other.ts  nearest task: core (owns src/lib/parse.ts)");
    expect(text).toContain("package.json  no task owns anything near it");
  });
  it("is empty when everything is owned", () => {
    expect(scopeViolations(["src/cli.ts", "docs/x.md"], plan)).toEqual([]);
  });
  it("always allows .doug/board.json, even when no task owns it", () => {
    const narrowPlan = { ...plan, tasks: [{ id: "a", title: "a", spec: "s", files: ["src/a.ts"] }] };
    const v = scopeViolations([".doug/board.json", "src/b.ts"], narrowPlan);
    expect(v.map((x) => x.file)).toEqual(["src/b.ts"]);
  });
});

describe("loadScopePlan", () => {
  it("returns the plan only for approved or done status", () => {
    const dir = makeProject();
    expect(loadScopePlan(dir)).toEqual({ plan: null, reason: "no-plan" });
    mkdirSync(join(dir, ".doug"), { recursive: true });
    for (const status of ["draft", "rejected"]) {
      writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...plan, status }));
      expect(loadScopePlan(dir)).toEqual({ plan: null, reason: `status:${status}` });
    }
    for (const status of ["approved", "done"]) {
      writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...plan, status }));
      expect(loadScopePlan(dir).plan.status).toBe(status);
    }
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...plan, status: "done", landed: { at: "2026-09-04T16:00:00.000Z", mergeCommit: "abc1234" } }));
    expect(loadScopePlan(dir)).toEqual({ plan: null, reason: "landed" });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ status: "approved" }));
    expect(loadScopePlan(dir).reason).toBe("invalid");
    writeFileSync(join(dir, ".doug/plan.json"), "nope");
    expect(loadScopePlan(dir).reason).toBe("unreadable");
  });
});
