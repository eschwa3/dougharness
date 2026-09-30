import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePlan, levelize, setStatus, renderPlan, loadPlan, savePlan, acceptanceEntries, DEFAULT_BUDGET, GATES, humanGateLevels, planWarnings, TASK_CAP, FEATURE_TASKS } from "../lib/plan.mjs";

function plan(overrides = {}) {
  return {
    version: 1,
    title: "Add truncate",
    goal: "Add a truncate helper with tests so callers can shorten strings safely.",
    status: "draft",
    acceptance: ["truncate('hello world', 5) returns 'hell…'"],
    verify: ["pnpm test"],
    tasks: [
      { id: "impl", title: "Implement truncate", spec: "Add truncate(input, max) to src/strings.ts with an ellipsis; add tests.", files: ["src/strings.ts", "tests/strings.test.ts"], verify: "pnpm exec vitest run tests/strings.test.ts" },
    ],
    ...overrides,
  };
}

describe("validatePlan", () => {
  it("accepts a minimal valid plan", () => {
    expect(validatePlan(plan())).toEqual([]);
  });
  it("rejects missing fields", () => {
    const errs = validatePlan({ version: 2, status: "maybe", tasks: [] });
    expect(errs).toContain("version must be 1");
    expect(errs).toContain("title is required");
    expect(errs.some((e) => e.startsWith("status must be"))).toBe(true);
    expect(errs).toContain("tasks must be a non-empty array");
  });
  it("rejects bad task ids, short specs, and absolute or escaping paths", () => {
    const errs = validatePlan(plan({ tasks: [{ id: "Bad_ID", title: "x", spec: "too short", files: ["/etc/passwd", "../x"] }] }));
    expect(errs.some((e) => e.includes(".id must match"))).toBe(true);
    expect(errs.some((e) => e.includes("at least 20 characters"))).toBe(true);
    expect(errs.filter((e) => e.includes("invalid path")).length).toBe(2);
  });
  it("rejects duplicate ids, unknown and self dependencies", () => {
    const t = (id, dependsOn) => ({ id, title: "t", spec: "a spec that is long enough to pass", files: [`f-${id}.ts`], dependsOn });
    expect(validatePlan(plan({ tasks: [t("a"), t("a")] }))).toContain('tasks[1].id "a" is duplicated');
    expect(validatePlan(plan({ tasks: [t("a", ["zzz"])] }))).toContain('task "a" depends on unknown task "zzz"');
    expect(validatePlan(plan({ tasks: [t("a", ["a"])] }))).toContain('task "a" depends on itself');
  });
  it("rejects dependency cycles", () => {
    const t = (id, dependsOn) => ({ id, title: "t", spec: "a spec that is long enough to pass", files: [`f-${id}.ts`], dependsOn });
    const errs = validatePlan(plan({ tasks: [t("a", ["b"]), t("b", ["a"])] }));
    expect(errs.some((e) => e.startsWith("dependency cycle"))).toBe(true);
  });
  it("rejects two independent tasks owning the same file, allows it with a dependency", () => {
    const t = (id, files, dependsOn) => ({ id, title: "t", spec: "a spec that is long enough to pass", files, dependsOn });
    expect(validatePlan(plan({ tasks: [t("a", ["x.ts"]), t("b", ["x.ts"])] }))).toContain('file "x.ts" is owned by both "a" and "b" with no dependency between them');
    expect(validatePlan(plan({ tasks: [t("a", ["x.ts"]), t("b", ["x.ts"], ["a"])] }))).toEqual([]);
  });
  it("requires a task that names another task's file in its spec or verify command to depend on that task (card planner-producer-level)", () => {
    // 2026-09-07, board-reorder (4 runs): the adversary judges a task branch against the whole plan goal, so a
    // consumer task that describes what a producer task builds blocks unless it lands in a later level.
    const t = (id, files, spec, extra = {}) => ({ id, title: "t", spec, files, ...extra });
    const producer = t("route", ["src/server.ts"], "Add PUT /board to src/server.ts that writes the record.");
    const consumer = (extra) => t("page", ["src/page.js"], "The page PUTs the moved card to src/server.ts and re-renders.", extra);
    const missing = 'task "page" names "src/server.ts", owned by "route", but does not depend on it; add "route" to tasks[1].dependsOn so "page" lands in a later level';
    expect(validatePlan(plan({ tasks: [producer, consumer()] }))).toEqual([missing]);
    expect(validatePlan(plan({ tasks: [producer, consumer({ dependsOn: ["route"] })] }))).toEqual([]);
    // A transitive dependency satisfies it, and so does the reverse edge: a producer may describe its consumer.
    const mid = t("mid", ["src/mid.ts"], "A middle task between the two that is long enough.", { dependsOn: ["route"] });
    expect(validatePlan(plan({ tasks: [producer, mid, consumer({ dependsOn: ["mid"] })] }))).toEqual([]);
    expect(validatePlan(plan({ tasks: [t("route", ["src/server.ts"], "Add PUT /board to src/server.ts; src/page.js will call it.", { dependsOn: ["page"] }), t("page", ["src/page.js"], "The page that will call the route, long enough spec.")] }))).toEqual([]);
    // The verify command counts too: running another task's test file is depending on it.
    const runsOther = t("docs", ["README.md"], "Document the route in the README with an example.", { verify: "pnpm exec vitest run tests/server.test.ts" });
    const owner = t("route", ["src/server.ts", "tests/server.test.ts"], "Add PUT /board to src/server.ts with its test.");
    expect(validatePlan(plan({ tasks: [owner, runsOther] }))).toEqual(['task "docs" names "tests/server.test.ts", owned by "route", but does not depend on it; add "route" to tasks[1].dependsOn so "docs" lands in a later level']);
    // Naming its own files, or a file no task owns, is not a dependency.
    expect(validatePlan(plan({ tasks: [t("solo", ["src/a.ts"], "Change src/a.ts and mention src/elsewhere.ts, which no task owns.")] }))).toEqual([]);
    // One error per pair, however many files are named.
    const two = t("page", ["src/page.js"], "Calls src/server.ts and reads tests/server.test.ts for the shape.");
    expect(validatePlan(plan({ tasks: [owner, two] })).length).toBe(1);
  });
  it("accepts an optional card string and rejects non-string or empty values", () => {
    expect(validatePlan(plan({ card: "board-flow" }))).toEqual([]);
    expect(validatePlan(plan({ card: 7 }))).toContain("card must be a non-empty string when present");
    expect(validatePlan(plan({ card: "" }))).toContain("card must be a non-empty string when present");
  });
  it("accepts a non-negative integer fixAttempts and rejects anything else", () => {
    expect(validatePlan(plan({ fixAttempts: 0 }))).toEqual([]);
    expect(validatePlan(plan({ fixAttempts: 3 }))).toEqual([]);
    for (const bad of [-1, 1.5, "2", null]) {
      expect(validatePlan(plan({ fixAttempts: bad }))).toEqual(["fixAttempts must be a non-negative integer when present"]);
    }
  });
  it("accepts plan without budget, with an empty object, and with valid budget values", () => {
    expect(validatePlan(plan())).toEqual([]);
    expect(validatePlan(plan({ budget: {} }))).toEqual([]);
    expect(validatePlan(plan({ budget: { agents: 8, tokens: 200000, wallMinutes: 30 } }))).toEqual([]);
  });
  it("rejects invalid budget values with exact messages", () => {
    expect(validatePlan(plan({ budget: null }))).toEqual(["budget must be an object with agents, tokens, and/or wallMinutes when present"]);
    expect(validatePlan(plan({ budget: [] }))).toEqual(["budget must be an object with agents, tokens, and/or wallMinutes when present"]);
    expect(validatePlan(plan({ budget: { agents: 0 } }))).toEqual(["budget.agents must be a positive integer when present"]);
    expect(validatePlan(plan({ budget: { agents: 1.5 } }))).toEqual(["budget.agents must be a positive integer when present"]);
    expect(validatePlan(plan({ budget: { tokens: "5" } }))).toEqual(["budget.tokens must be a positive integer when present"]);
    expect(validatePlan(plan({ budget: { wallMinutes: 0 } }))).toEqual(["budget.wallMinutes must be a positive number when present"]);
    expect(validatePlan(plan({ budget: { wallMinutes: Infinity } }))).toEqual(["budget.wallMinutes must be a positive number when present"]);
    expect(validatePlan(plan({ budget: { unknown: 5 } }))).toEqual(["budget.unknown is not a budget measure (agents, tokens, wallMinutes)"]);
  });
  it("accepts string and { text, command } acceptance entries and rejects malformed objects", () => {
    expect(validatePlan(plan({ acceptance: ["prose", { text: "x exists", command: "test -f x" }] }))).toEqual([]);
    expect(validatePlan(plan({ acceptance: [] }))).toContain("acceptance must be a non-empty array");
    const badEntries = [{ text: "x" }, { command: "true" }, { text: "", command: "true" }, { text: "x", command: "" }, { text: "x", command: 5 }, 7, null, "  "];
    for (const bad of badEntries) {
      expect(validatePlan(plan({ acceptance: ["ok", bad] })), JSON.stringify(bad)).toEqual(["acceptance[1] must be a non-empty string or { text, command } with non-empty strings"]);
    }
  });
  it("normalizes both acceptance forms with acceptanceEntries", () => {
    expect(acceptanceEntries(["p", { text: "t", command: "c" }, { text: "u", command: " " }])).toEqual([
      { text: "p", command: null },
      { text: "t", command: "c" },
      { text: "u", command: null },
    ]);
    expect(acceptanceEntries(undefined)).toEqual([]);
  });
});

describe("levelize", () => {
  it("groups by dependency depth", () => {
    const t = (id, dependsOn) => ({ id, dependsOn });
    const levels = levelize([t("a"), t("b", ["a"]), t("c"), t("d", ["b", "c"])]);
    expect(levels.map((l) => l.map((x) => x.id))).toEqual([["a", "c"], ["b"], ["d"]]);
  });
});

describe("status and rendering", () => {
  it("approves with a timestamp and renders levels", () => {
    const p = setStatus(plan(), "approved", "2026-09-04T00:00:00Z");
    expect(p.status).toBe("approved");
    expect(p.approvedAt).toBe("2026-09-04T00:00:00Z");
    const text = renderPlan(p);
    expect(text).toContain("[approved]");
    expect(text).toContain("Level 0");
    expect(text).toContain("owns: src/strings.ts, tests/strings.test.ts");
    expect(text).not.toContain("Card:");
    expect(() => setStatus(p, "bogus")).toThrow();
  });
  it("renders the card line directly after the title line when present", () => {
    const text = renderPlan(plan({ card: "board-flow" }));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Add truncate  [draft]");
    expect(lines[1]).toBe("Card: board-flow");
  });
  it("accepts a task size of S, M, or L, rejects any other, and shows the shape each size runs", () => {
    const sized = (size) => plan({ tasks: [{ ...plan().tasks[0], size }] });
    for (const size of ["S", "M", "L"]) expect(validatePlan(sized(size))).toEqual([]);
    expect(validatePlan(plan())).toEqual([]);
    expect(validatePlan(sized("XL"))).toEqual(["tasks[0].size must be one of S, M, L when present"]);
    expect(validatePlan(sized("s"))).toEqual(["tasks[0].size must be one of S, M, L when present"]);
    expect(renderPlan(sized("S"))).toContain("      size: S (implement, one focused check; the adversary reviews the level on the integration branch)");
    expect(renderPlan(sized("M"))).toContain("      size: M (full shape: implement, verify and review together, adversary)");
    expect(renderPlan(plan())).toContain("      size: unsized (full shape: implement, verify and review together, adversary)");
  });
  it("accepts adversary false or an object, and a fallback of false or { model, effort? }, and rejects the rest", () => {
    expect(validatePlan(plan({ adversary: false }))).toEqual([]);
    expect(validatePlan(plan({ adversary: { command: "codex-review" } }))).toEqual([]);
    expect(validatePlan(plan({ adversary: { fallback: false } }))).toEqual([]);
    expect(validatePlan(plan({ adversary: { fallback: { model: "opus" } } }))).toEqual([]);
    expect(validatePlan(plan({ adversary: { fallback: { model: "sonnet", effort: "medium" } } }))).toEqual([]);
    expect(validatePlan(plan({ adversary: "codex" }))).toEqual(["adversary must be false or an object when present"]);
    expect(validatePlan(plan({ adversary: [] }))).toEqual(["adversary must be false or an object when present"]);
    for (const bad of [true, "opus", {}, { model: 7 }, { model: "Opus!" }, null]) {
      expect(validatePlan(plan({ adversary: { fallback: bad } })), JSON.stringify(bad)).toEqual(["adversary.fallback must be false or { model, effort? } with a model name (opus, sonnet, haiku, fable, inherit, or a model id)"]);
    }
    expect(validatePlan(plan({ adversary: { fallback: { model: "opus", effort: "turbo" } } }))).toEqual(["adversary.fallback.effort must be one of inherit, low, medium, high, xhigh, max"]);
  });
  it("prints the adversary line with the fallback default, an explicit fallback, fallback off, and adversary off", () => {
    expect(renderPlan(plan())).toContain("Adversary: codex-review (or .doug/config.json commands.adversary); if it cannot run: Claude adversary on opus / high");
    expect(renderPlan(plan({ adversary: { command: "node /x/bin.js", fallback: { model: "sonnet" } } }))).toContain("Adversary: node /x/bin.js; if it cannot run: Claude adversary on sonnet / high");
    expect(renderPlan(plan({ adversary: { fallback: { model: "haiku", effort: "low" } } }))).toContain("if it cannot run: Claude adversary on haiku / low");
    expect(renderPlan(plan({ adversary: { fallback: false } }))).toContain("if it cannot run: off; a review that does not run blocks");
    expect(renderPlan(plan({ adversary: false }))).toContain("Adversary: off");
  });
  it("prints the fix attempts line with the default when absent", () => {
    expect(renderPlan(plan())).toContain("Fix attempts per blocked task: 5 (default)");
    const text = renderPlan(plan({ fixAttempts: 0 }));
    expect(text).toContain("Fix attempts per blocked task: 0");
    expect(text).not.toContain("Fix attempts per blocked task: 0 (default)");
  });
  it("prints the budget line with defaults for a plan without budget", () => {
    expect(renderPlan(plan())).toContain("Budget per task: agents 12 (default), tokens 400000 (default), wall 40 min (default)");
  });
  it("prints the budget line with specific values and defaults appropriately mixed", () => {
    const text = renderPlan(plan({ budget: { agents: 8, wallMinutes: 30 } }));
    expect(text).toContain("Budget per task: agents 8, tokens 400000 (default), wall 30 min");
  });
  it("DEFAULT_BUDGET has the expected literal values", () => {
    expect(DEFAULT_BUDGET).toEqual({ agents: 12, tokens: 400000, wallMinutes: 40 });
  });
  it("renders an acceptance command under its criterion", () => {
    expect(renderPlan(plan({ acceptance: ["p", { text: "t", command: "c" }] }))).toContain("Acceptance:\n  - p\n  - t\n    $ c\n");
    expect(renderPlan(plan()).split("\n").some((l) => l.startsWith("    $"))).toBe(false);
  });
  it("round-trips through the plan file", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-plan-"));
    expect(loadPlan(dir)).toBeNull();
    savePlan(dir, plan());
    expect(loadPlan(dir).title).toBe("Add truncate");
  });
});

describe("human gates between levels (decision 0002 #2)", () => {
  const t = (id, extra = {}) => ({ id, title: id, spec: "a spec that is long enough to pass validation", files: [`src/${id}.ts`], ...extra });
  const gated = (extra = {}) => plan({ tasks: [t("a", { gate: "human" }), t("c"), t("b", { dependsOn: ["a"] })], ...extra });

  it("accepts gate auto or human on a task, rejects anything else, and checks gatesOpened", () => {
    expect(GATES).toEqual(["auto", "human"]);
    expect(validatePlan(gated())).toEqual([]);
    expect(validatePlan(plan({ tasks: [t("a", { gate: "auto" })] }))).toEqual([]);
    expect(validatePlan(plan({ tasks: [t("a", { gate: "later" })] }))).toEqual(["tasks[0].gate must be one of auto, human when present"]);
    expect(validatePlan(gated({ gatesOpened: [0] }))).toEqual([]);
    expect(validatePlan(gated({ gatesOpened: "0" }))).toEqual(["gatesOpened must be an array of level indexes when present"]);
    expect(validatePlan(gated({ gatesOpened: [-1] }))).toEqual(["gatesOpened must be an array of level indexes when present"]);
  });
  it("lists the levels that end at a human gate and renders the gate as pending or opened", () => {
    expect(humanGateLevels(gated())).toEqual([0]);
    expect(humanGateLevels(plan())).toEqual([]);
    const pending = renderPlan(gated());
    expect(pending).toContain("      gate: human (the run pauses after level 0 integrates; open it with plan.mjs gate open 0 and resume the run with its id)");
    expect(pending.split("gate: human").length).toBe(2);
    expect(renderPlan(gated({ gatesOpened: [0] }))).toContain("      gate: human (opened; the run continues past this level)");
  });
});

describe("agent scaling warnings (proposal C)", () => {
  const t = (i, files) => ({ id: `t${i}`, title: `T${i}`, spec: "a spec that is long enough to pass validation", files: files || [`src/${i}.ts`] });
  const many = (n) => plan({ tasks: Array.from({ length: n }, (_, i) => t(i)) });
  it("warns past five and past eight tasks, and on several tasks for one file, and stays quiet otherwise", () => {
    expect([FEATURE_TASKS, TASK_CAP]).toEqual([5, 8]);
    expect(planWarnings(plan())).toEqual([]);
    expect(planWarnings(many(5))).toEqual([]);
    expect(planWarnings(many(6))).toEqual(["6 tasks: a feature is three to five; merge tasks that share a file group or split the plan"]);
    expect(planWarnings(many(9))).toEqual(["9 tasks: never more than eight in one plan; split the work into two cards or merge tasks that share a file group"]);
    const oneFile = plan({ tasks: [{ ...t(0, ["src/x.ts"]) }, { ...t(1, ["src/x.ts"]), dependsOn: ["t0"] }] });
    expect(validatePlan(oneFile)).toEqual([]);
    expect(planWarnings(oneFile)).toEqual(["2 tasks own the same single file (src/x.ts): single-file work is one task"]);
    expect(planWarnings({ tasks: "nope" })).toEqual([]);
    // Warnings never make a plan invalid.
    expect(validatePlan(many(9))).toEqual([]);
  });
});

// Several cards in one plan (card parallel-cards): per-card drafts merged into one plan whose tasks carry their card,
// level k of the batch being the union of each card's level k; a file two cards own is sequenced by a dependency
// edge from the later card's task to the earlier card's, never refused; only a cycle across cards is refused, by name.
import { mergePlans } from "../lib/plan.mjs";

function draft(card, tasks, overrides = {}) {
  return {
    version: 1,
    title: `Card ${card}`,
    goal: `The goal of card ${card}, in enough words.`,
    status: "draft",
    card,
    acceptance: [`${card} works`, { text: `${card} command holds`, command: `true # ${card}` }],
    verify: ["pnpm typecheck", "pnpm test:unit"],
    tasks,
    ...overrides,
  };
}
const t = (id, files, extra = {}) => ({ id, title: id.toUpperCase(), spec: `Do the thing for ${id} with a test.`, files, size: "S", ...extra });

describe("mergePlans", () => {
  it("joins drafts level by level, tags every task and acceptance line with its card, and unions verify", () => {
    const a = draft("alpha", [t("a1", ["src/a.ts"]), t("a2", ["src/a2.ts"], { dependsOn: ["a1"] })]);
    const b = draft("beta", [t("b1", ["src/b.ts"]), t("b2", ["src/b2.ts"], { dependsOn: ["b1"] })], { verify: ["pnpm test:unit", "pnpm build"] });
    const { plan, sequenced, renamed } = mergePlans([{ card: "alpha", plan: a }, { card: "beta", plan: b }]);
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.status).toBe("draft");
    expect(plan.cards).toEqual(["alpha", "beta"]);
    expect(plan.card).toBeUndefined();
    expect(plan.title).toBe("2 cards: alpha, beta");
    expect(plan.goal).toContain("alpha: The goal of card alpha");
    expect(plan.goal).toContain("beta: The goal of card beta");
    expect(plan.tasks.map((x) => [x.id, x.card])).toEqual([["a1", "alpha"], ["a2", "alpha"], ["b1", "beta"], ["b2", "beta"]]);
    expect(levelize(plan.tasks).map((lvl) => lvl.map((x) => x.id))).toEqual([["a1", "b1"], ["a2", "b2"]]);
    expect(plan.acceptance).toEqual(["[alpha] alpha works", { text: "[alpha] alpha command holds", command: "true # alpha" }, "[beta] beta works", { text: "[beta] beta command holds", command: "true # beta" }]);
    expect(plan.verify).toEqual(["pnpm typecheck", "pnpm test:unit", "pnpm build"]);
    expect(sequenced).toEqual([]);
    expect(renamed).toEqual([]);
    // Each task keeps its own spec and verify; nothing else of the draft leaks into it.
    expect(plan.tasks[2]).toEqual({ ...t("b1", ["src/b.ts"]), card: "beta" });
  });
  it("sequences a file two cards own with a dependency edge from the later card's task to the earlier card's, in board order", () => {
    const a = draft("alpha", [t("a1", ["src/shared.ts", "src/a.ts"])]);
    const b = draft("beta", [t("b1", ["src/shared.ts"]), t("b2", ["src/b2.ts"], { dependsOn: ["b1"] })]);
    // Given out of board order: the merge sorts by the order passed in `order`.
    const { plan, sequenced } = mergePlans([{ card: "beta", plan: b }, { card: "alpha", plan: a }], { order: ["alpha", "beta"] });
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.cards).toEqual(["alpha", "beta"]);
    expect(plan.tasks.find((x) => x.id === "b1").dependsOn).toEqual(["a1"]);
    expect(plan.tasks.find((x) => x.id === "a1").dependsOn).toBeUndefined();
    expect(sequenced).toEqual([{ file: "src/shared.ts", after: { card: "alpha", task: "a1" }, task: { card: "beta", task: "b1" } }]);
    // The later card's level 0 task moved to level 1; its own dependents follow.
    expect(levelize(plan.tasks).map((lvl) => lvl.map((x) => x.id))).toEqual([["a1"], ["b1"], ["b2"]]);
  });
  it("adds one edge per owning task of the earlier card and none within a card", () => {
    const a = draft("alpha", [t("a1", ["src/x.ts"]), t("a2", ["src/x.ts"], { dependsOn: ["a1"] })]);
    const b = draft("beta", [t("b1", ["src/x.ts", "src/y.ts"]), t("b2", ["src/y.ts"], { dependsOn: ["b1"] })]);
    const { plan, sequenced } = mergePlans([{ card: "alpha", plan: a }, { card: "beta", plan: b }]);
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.tasks.find((x) => x.id === "b1").dependsOn).toEqual(["a1", "a2"]);
    expect(plan.tasks.find((x) => x.id === "b2").dependsOn).toEqual(["b1"]);
    expect(sequenced.map((s) => `${s.file}: ${s.task.task} after ${s.after.task}`)).toEqual(["src/x.ts: b1 after a1", "src/x.ts: b1 after a2"]);
  });
  it("renames a task id the later card reuses, rewriting that card's own dependsOn, and says so", () => {
    const a = draft("alpha", [t("impl", ["src/a.ts"]), t("docs", ["README.md"], { dependsOn: ["impl"] })]);
    const b = draft("beta", [t("impl", ["src/b.ts"]), t("docs", ["docs/b.md"], { dependsOn: ["impl"] })]);
    const { plan, renamed } = mergePlans([{ card: "alpha", plan: a }, { card: "beta", plan: b }]);
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.tasks.map((x) => x.id)).toEqual(["impl", "docs", "beta-impl", "beta-docs"]);
    expect(plan.tasks.find((x) => x.id === "beta-docs").dependsOn).toEqual(["beta-impl"]);
    expect(plan.tasks.find((x) => x.id === "docs").dependsOn).toEqual(["impl"]);
    expect(renamed).toEqual([{ card: "beta", from: "impl", to: "beta-impl" }, { card: "beta", from: "docs", to: "beta-docs" }]);
  });
  it("refuses a cycle across cards by name and nothing else", () => {
    // alpha's task already depends on beta's (a draft edited by hand); the overlap on src/x.ts adds the reverse edge.
    const a = draft("alpha", [t("a1", ["src/x.ts"], { dependsOn: ["b1"] })]);
    const b = draft("beta", [t("b1", ["src/x.ts"])]);
    expect(() => mergePlans([{ card: "alpha", plan: a }, { card: "beta", plan: b }])).toThrow("dependency cycle across cards alpha and beta: a1 -> b1 -> a1");
    // An invalid draft is refused with the card named and the validator's message.
    const bad = draft("gamma", [t("g1", ["/etc/passwd"])]);
    expect(() => mergePlans([{ card: "alpha", plan: draft("alpha", [t("a1", ["src/a.ts"])]) }, { card: "gamma", plan: bad }])).toThrow(/draft for card gamma is invalid:[\s\S]*invalid path/);
    expect(() => mergePlans([{ card: "alpha", plan: a }])).toThrow("a batch needs at least two cards");
    expect(() => mergePlans([{ card: "alpha", plan: a }, { card: "alpha", plan: a }])).toThrow('card "alpha" is listed twice');
  });
  it("takes install, baseBranch, adversary, budget, and fixAttempts from the first draft that sets them and names a disagreement", () => {
    const a = draft("alpha", [t("a1", ["src/a.ts"])], { fixAttempts: 2, adversary: { fallback: false } });
    const b = draft("beta", [t("b1", ["src/b.ts"])], { fixAttempts: 4, install: "pnpm i", budget: { agents: 6 } });
    const { plan, notes } = mergePlans([{ card: "alpha", plan: a }, { card: "beta", plan: b }]);
    expect(plan.fixAttempts).toBe(2);
    expect(plan.install).toBe("pnpm i");
    expect(plan.budget).toEqual({ agents: 6 });
    expect(plan.adversary).toEqual({ fallback: false });
    expect(notes).toEqual(["fixAttempts: kept 2 from alpha; beta asked for 4"]);
  });
});

describe("validatePlan with cards", () => {
  const two = () => plan({ cards: ["alpha", "beta"], tasks: [{ id: "a", title: "A", spec: "a spec that is long enough to pass", files: ["a.ts"], card: "alpha" }, { id: "b", title: "B", spec: "a spec that is long enough to pass", files: ["b.ts"], card: "beta" }] });
  it("accepts cards with every task naming one of them, and rejects bad shapes", () => {
    expect(validatePlan(two())).toEqual([]);
    expect(validatePlan(plan({ cards: "alpha" }))).toContain("cards must be an array of card ids when present");
    expect(validatePlan(plan({ cards: ["alpha", "alpha"] }))).toContain('cards lists "alpha" twice');
    const stray = two();
    stray.tasks[1].card = "gamma";
    expect(validatePlan(stray)).toContain('tasks[1].card "gamma" is not one of the plan\'s cards (alpha, beta)');
    const untagged = two();
    delete untagged.tasks[1].card;
    expect(validatePlan(untagged)).toContain("tasks[1].card is required when the plan has cards");
    expect(validatePlan(plan({ tasks: [{ id: "a", title: "A", spec: "a spec that is long enough to pass", files: ["a.ts"], card: 7 }] }))).toContain("tasks[0].card must be a non-empty string when present");
  });
  it("renders the cards and each task's card", () => {
    const text = renderPlan(two());
    expect(text).toContain("Cards: alpha, beta");
    expect(text).toContain("  a: A\n      card: alpha");
    expect(text).toContain("  b: B\n      card: beta");
    expect(renderPlan(plan())).not.toContain("card:");
  });
});

// Crew per task (card crew-sizing): researchers, reviewers, adversaries, default one each; validated and shown.
import { crewOf, CREW_ROLES } from "../lib/plan.mjs";

describe("crew", () => {
  const t = (extra = {}) => ({ id: "a", title: "A", spec: "a spec that is long enough to pass", files: ["a.ts"], ...extra });
  it("defaults to one per role, lets a task override the plan, and validates the shape", () => {
    expect(CREW_ROLES).toEqual(["researchers", "reviewers", "adversaries"]);
    expect(crewOf(plan(), t())).toEqual({ researchers: 1, reviewers: 1, adversaries: 1 });
    expect(crewOf(plan({ crew: { reviewers: 2 } }), t())).toEqual({ researchers: 1, reviewers: 2, adversaries: 1 });
    expect(crewOf(plan({ crew: { reviewers: 2 } }), t({ crew: { reviewers: 3, adversaries: 2 } }))).toEqual({ researchers: 1, reviewers: 3, adversaries: 2 });
    expect(validatePlan(plan({ crew: { reviewers: 2, adversaries: 2 }, tasks: [t({ crew: { researchers: 2 } })] }))).toEqual([]);
    expect(validatePlan(plan({ crew: [] }))).toEqual(["crew must be an object with researchers, reviewers, adversaries when present"]);
    expect(validatePlan(plan({ crew: { coders: 2 } }))).toEqual(["crew.coders is not a crew role (researchers, reviewers, adversaries)"]);
    expect(validatePlan(plan({ crew: { reviewers: 0 } }))).toEqual(["crew.reviewers must be a positive integer"]);
    expect(validatePlan(plan({ tasks: [t({ crew: { adversaries: "2" } })] }))).toEqual(["tasks[0].crew.adversaries must be a positive integer"]);
  });
  it("renders the plan crew and a task's crew above one, and says a size-S task runs the focused check", () => {
    const text = renderPlan(plan({ crew: { reviewers: 2 }, tasks: [t(), t({ id: "b", files: ["b.ts"], crew: { adversaries: 2 }, size: "S" })] }));
    expect(text).toContain("Crew per task: researchers 1, reviewers 2, adversaries 1 (a task's own crew overrides)");
    expect(text).toContain("  a: A\n      owns: a.ts\n      size: unsized (full shape: implement, verify and review together, adversary)\n      crew: reviewers 2\n");
    expect(text).toContain("      crew: reviewers 2, adversaries 2 (a size-S task runs one focused check; the crew applies to the full shape)");
    expect(renderPlan(plan())).not.toContain("crew");
  });
});

describe("swarm opt-in", () => {
  it("accepts a boolean swarm, rejects anything else, and shows it", () => {
    expect(validatePlan(plan({ swarm: true }))).toEqual([]);
    expect(validatePlan(plan({ swarm: false }))).toEqual([]);
    expect(validatePlan(plan({ swarm: "on" }))).toEqual(["swarm must be true or false when present"]);
    expect(renderPlan(plan({ swarm: true }))).toContain("Swarm: on (a lead on the lead row splits each full-shape task into worker briefs");
    expect(renderPlan(plan({ swarm: false }))).not.toContain("Swarm");
  });
});

describe("worker check opt-in (card swarm-topology)", () => {
  it("accepts a boolean workerCheck, rejects anything else, accepts absent, and shows it only when true", () => {
    expect(validatePlan(plan({ swarm: true, workerCheck: true }))).toEqual([]);
    expect(validatePlan(plan({ swarm: true, workerCheck: false }))).toEqual([]);
    expect(validatePlan(plan({ swarm: true }))).toEqual([]);
    expect(validatePlan(plan({ swarm: true, workerCheck: "yes" }))).toEqual(["workerCheck must be true or false when present"]);
    expect(renderPlan(plan({ swarm: true, workerCheck: true }))).toContain("Worker check: on (before the merge the workflow checks each swarm worker's filesTouched against its brief and that it committed; a failure is a block the lead may re-brief once)");
    expect(renderPlan(plan({ swarm: true, workerCheck: false }))).not.toContain("Worker check");
    expect(renderPlan(plan({ swarm: true }))).not.toContain("Worker check");
  });
});
