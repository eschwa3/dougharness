import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelsSection, loadModels, resolvePlanModels, validateModelRefs, renderModels, ROLES } from "../lib/models.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const TABLE = `# Project instructions

## Commands

pnpm test

## Models

| Work      | Model   | Effort |
|-----------|---------|--------|
| lead      | inherit | high   |
| implement | sonnet  | medium |
| verify    | inherit | high   |
| adversary | inherit | low    |
| cheap     | haiku   | low    |
| careful   | \`claude-opus-5\` | xhigh |

## Gotchas

- none
`;

const task = (extra = {}) => ({ id: "t", title: "T", spec: "a spec long enough to pass validation", files: ["a.ts"], ...extra });
const plan = (tasks) => ({ version: 1, title: "P", goal: "g", status: "draft", acceptance: ["x"], verify: [], tasks });

describe("ROLES", () => {
  it("starts with plan, the planner agent's and the research step's researchers' row", () => {
    expect(ROLES[0]).toBe("plan");
  });
});

describe("parseModelsSection", () => {
  it("puts a plan row under roles.plan", () => {
    const m = parseModelsSection("## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| plan | opus | high |\n");
    expect(m.roles.plan).toEqual({ model: "opus", effort: "high" });
  });
  it("reads roles and named tiers from the table and stops at the next heading", () => {
    const m = parseModelsSection(TABLE);
    expect(m.present).toBe(true);
    expect(m.errors).toEqual([]);
    expect(m.roles).toEqual({ lead: { model: "inherit", effort: "high" }, implement: { model: "sonnet", effort: "medium" }, verify: { model: "inherit", effort: "high" }, adversary: { model: "inherit", effort: "low" } });
    expect(m.tiers).toEqual({ cheap: { model: "haiku", effort: "low" }, careful: { model: "claude-opus-5", effort: "xhigh" } });
  });
  it("is empty when there is no Models section", () => {
    const m = parseModelsSection("# Instructions\n\n## Commands\n\n| Work | Model |\n|--|--|\n| implement | haiku |\n");
    expect(m.present).toBe(false);
    expect(m.roles).toEqual({});
  });
  it("tolerates a missing effort column and case differences", () => {
    const m = parseModelsSection("## MODELS\n\n| Work | Model |\n|---|---|\n| Implement | Sonnet |\n");
    expect(m.roles.implement).toEqual({ model: "sonnet", effort: "inherit" });
  });
  it("reports bad model names, bad efforts, and duplicate rows instead of guessing", () => {
    const m = parseModelsSection("## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| implement | Not A Model | high |\n| verify | sonnet | turbo |\n| review | sonnet | high |\n| review | haiku | low |\n| Bad Name | sonnet | low |\n");
    expect(m.errors).toHaveLength(4);
    expect(m.errors[0]).toMatch(/model "Not A Model"/);
    expect(m.errors[1]).toMatch(/effort "turbo"/);
    expect(m.errors[2]).toMatch(/defined twice/);
    expect(m.errors[3]).toMatch(/work name/);
  });
});

describe("resolvePlanModels", () => {
  const models = parseModelsSection(TABLE);
  it("fills every role, defaulting to inherit, and gives implementers the implement row", () => {
    const r = resolvePlanModels(plan([task()]), models);
    for (const role of ROLES) expect(r.models.roles[role]).toBeDefined();
    expect(r.models.roles.review).toEqual({ model: "inherit", effort: "inherit" });
    expect(r.models.roles.plan).toEqual({ model: "inherit", effort: "inherit" });
    expect(r.models.roles.implement).toEqual({ model: "sonnet", effort: "medium" });
    expect(r.tasks[0]).toMatchObject({ model: "sonnet", effort: "medium" });
    // The swarm's rows (card swarm-lead): lead exists, worker is new and inherits when the table has no row.
    expect(ROLES).toContain("worker");
    expect(r.models.roles.worker).toEqual({ model: "inherit", effort: "inherit" });
    expect(parseModelsSection("## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| worker | haiku | low |\n").roles.worker).toEqual({ model: "haiku", effort: "low" });
  });
  it("applies precedence: explicit task fields beat the tier, the tier beats the implement row", () => {
    const r = resolvePlanModels(plan([task({ id: "a", tier: "cheap" }), task({ id: "b", tier: "cheap", effort: "HIGH" }), task({ id: "c", model: "opus" })]), models);
    expect(r.tasks[0]).toMatchObject({ model: "haiku", effort: "low" });
    expect(r.tasks[1]).toMatchObject({ model: "haiku", effort: "high" });
    expect(r.tasks[2]).toMatchObject({ model: "opus", effort: "medium" });
  });
  it("resolves to inherit everywhere when no table exists", () => {
    const r = resolvePlanModels(plan([task()]), null);
    expect(r.tasks[0]).toMatchObject({ model: "inherit", effort: "inherit" });
    expect(r.models.source).toBeNull();
  });
});

describe("validateModelRefs", () => {
  const models = parseModelsSection(TABLE);
  it("rejects unknown tiers and malformed fields, and lists the known tiers", () => {
    const errs = validateModelRefs(plan([task({ tier: "nope" }), task({ id: "b", model: "??" }), task({ id: "c", effort: "max" })]), models);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatch(/tier "nope" is not defined/);
    expect(errs[0]).toMatch(/known: cheap, careful/);
    expect(errs[1]).toMatch(/tasks\[1\]\.model/);
  });
  it("accepts a role name as a tier reference", () => {
    expect(validateModelRefs(plan([task({ tier: "lead" })]), models)).toEqual([]);
  });
});

describe("loadModels and renderModels", () => {
  it("reads CLAUDE.md from the project dir and renders only non-inherit settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-models-"));
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, "CLAUDE.md"), TABLE);
    const m = loadModels(dir);
    expect(m.source).toBe("CLAUDE.md");
    const lines = renderModels(resolvePlanModels(plan([task()]), m).models);
    expect(lines).toContain("  implement: sonnet / medium");
    expect(lines).toContain("  tier cheap: haiku / low");
    expect(lines.some((l) => l.startsWith("  review:"))).toBe(false);
    expect(loadModels(mkdtempSync(join(tmpdir(), "doug-nomodels-"))).source).toBeNull();
  });
  it("prints a plan: line when the row is set and not when it inherits", () => {
    const set = parseModelsSection("## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| plan | opus | high |\n");
    expect(renderModels(resolvePlanModels(plan([task()]), set).models)).toContain("  plan: opus / high");
    const inherit = parseModelsSection("## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| implement | sonnet | medium |\n");
    expect(renderModels(resolvePlanModels(plan([task()]), inherit).models).some((l) => l.startsWith("  plan:"))).toBe(false);
  });
  it("loads this repository's own CLAUDE.md and resolves the plan row to opus/high", () => {
    const m = loadModels(repoRoot);
    expect(m.roles.plan).toEqual({ model: "opus", effort: "high" });
  });
});

describe("codex on the adversary row", () => {
  const withRow = (row) => TABLE.replace("| adversary | inherit | low    |", row);
  it("is accepted on the adversary row and resolves to codex", () => {
    const m = parseModelsSection(withRow("| adversary | codex | low |"));
    expect(m.errors).toEqual([]);
    expect(m.roles.adversary).toEqual({ model: "codex", effort: "low" });
  });
  it("is rejected on any other role row and as a tier", () => {
    const impl = parseModelsSection(TABLE.replace("| implement | sonnet  | medium |", "| implement | codex | medium |"));
    expect(impl.errors.join("\n")).toMatch(/"codex" is only valid on the adversary row/);
    const tier = parseModelsSection(TABLE.replace("| cheap     | haiku   | low    |", "| cheap | codex | low |"));
    expect(tier.errors.join("\n")).toMatch(/only valid on the adversary row/);
  });
  it("is rejected as a task model", () => {
    const m = parseModelsSection(TABLE);
    const errors = validateModelRefs(plan([task({ model: "codex" })]), m);
    expect(errors.join("\n")).toMatch(/cannot be "codex"/);
  });
});
