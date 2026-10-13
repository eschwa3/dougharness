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

// card parallel-card-queens (B7): per-card plans tracked at .doug/plans/<id>.json.
describe("loadScopePlan with per-card plans (.doug/plans/*.json)", () => {
  const card = (id, files, extra = {}) => ({ version: 1, title: `Card ${id}`, goal: "g", status: "approved", card: id, acceptance: ["a"], verify: [], tasks: [{ id: `${id}-t`, title: "t", spec: "s", files }], ...extra });
  const put = (dir, name, body) => {
    mkdirSync(join(dir, ".doug/plans"), { recursive: true });
    writeFileSync(join(dir, ".doug/plans", name), typeof body === "string" ? body : JSON.stringify(body));
  };

  it("allows .doug/plans/** without a plan owning it", () => {
    expect(scopeViolations([".doug/plans/a.json", ".doug/plans/sub/b.json"], plan)).toEqual([]);
  });

  it("S01 with no .doug/plan.json, unions every approved per-card plan into one scope", () => {
    const dir = makeProject();
    put(dir, "a.json", card("a", ["src/a.ts"]));
    put(dir, "b.json", card("b", ["src/b.ts"], { status: "done" }));
    const { plan: merged, reason } = loadScopePlan(dir);
    expect(reason).toBeNull();
    expect(merged.status).toMatch(/^(approved|done)$/);
    expect(typeof merged.title).toBe("string");
    expect(planScope(merged)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scopeViolations(["src/a.ts", "src/b.ts", "src/c.ts"], merged).map((v) => v.file)).toEqual(["src/c.ts"]);
  });

  it("S01 a per-card plan whose status is not enforced adds nothing", () => {
    const dir = makeProject();
    put(dir, "a.json", card("a", ["src/a.ts"]));
    put(dir, "d.json", card("d", ["src/d.ts"], { status: "draft" }));
    expect(planScope(loadScopePlan(dir).plan)).toEqual(["src/a.ts"]);
  });

  it("S02 a landed per-card plan is ignored", () => {
    const dir = makeProject();
    put(dir, "a.json", card("a", ["src/a.ts"]));
    put(dir, "old.json", card("old", ["src/old.ts"], { status: "done", landed: { at: "2026-09-04T16:00:00.000Z", mergeCommit: "abc1234" } }));
    expect(planScope(loadScopePlan(dir).plan)).toEqual(["src/a.ts"]);
    // only landed plans: nothing holds scope
    const dir2 = makeProject();
    put(dir2, "old.json", card("old", ["src/old.ts"], { status: "done", landed: { at: "2026-09-04T16:00:00.000Z", mergeCommit: "abc1234" } }));
    expect(loadScopePlan(dir2).plan).toBeNull();
  });

  it("an enforced .doug/plan.json keeps its own scope; per-card plans are not unioned into it", () => {
    const dir = makeProject();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(plan));
    put(dir, "a.json", card("a", ["src/a.ts"]));
    expect(planScope(loadScopePlan(dir).plan)).toEqual(planScope(plan));
  });

  it("a non-enforced .doug/plan.json falls through to the per-card plans", () => {
    const dir = makeProject();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...plan, status: "draft" }));
    put(dir, "a.json", card("a", ["src/a.ts"]));
    expect(planScope(loadScopePlan(dir).plan)).toEqual(["src/a.ts"]);
  });

  it("S03 an unreadable per-card file never throws and is reported as unreadable", () => {
    const dir = makeProject();
    put(dir, "bad.json", "{ nope");
    let out;
    expect(() => {
      out = loadScopePlan(dir);
    }).not.toThrow();
    expect(out.plan).toBeNull();
    expect(out.reason).toBe("unreadable");
  });

  it("S03 a readable per-card plan next to an unreadable one still does not throw", () => {
    const dir = makeProject();
    put(dir, "a.json", card("a", ["src/a.ts"]));
    put(dir, "bad.json", "{ nope");
    expect(() => loadScopePlan(dir)).not.toThrow();
  });

  it("S03b (fix pass) a valid per-card plan next to a corrupt one fails open: unreadable, naming the corrupt file, no scope", () => {
    const dir = makeProject();
    put(dir, "a.json", card("a", ["src/a.ts"]));
    put(dir, "b.json", "{ nope");
    const out = loadScopePlan(dir);
    expect(out.plan).toBeNull();
    expect(out.reason).toBe("unreadable");
    expect(out.file).toBe(".doug/plans/b.json");
  });

  it("an unreadable .doug/plan.json names itself as the file", () => {
    const dir = makeProject();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/plan.json"), "nope");
    expect(loadScopePlan(dir).file).toBe(".doug/plan.json");
  });

  it("describeViolations names the per-card source when the scope is a union", () => {
    const dir = makeProject();
    put(dir, "a.json", card("a", ["src/a.ts"]));
    put(dir, "b.json", card("b", ["src/b.ts"]));
    const merged = loadScopePlan(dir).plan;
    const text = describeViolations(scopeViolations(["src/c.ts"], merged), merged);
    expect(text).toContain("per-card plans a, b");
    expect(text).not.toContain("(.doug/plan.json)");
  });
});
