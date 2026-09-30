// plan.mjs set, and the install default from .doug/config.json: the plan file is what the workflow and
// land read, so these fields must live there rather than in launch arguments.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, savePlan, REPORT_RELPATH } from "../lib/plan.mjs";
import { openMemory, addLesson, memoryPath, setLessonEmbedding } from "../lib/memory.mjs";
import { buildIndex } from "../lib/code-index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "scripts", "plan.mjs");
const run = (args, dir) => spawnSync(process.execPath, [cli, ...args, dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

function project({ configInstall = "pnpm install --frozen-lockfile", planInstall } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-planset-"));
  mkdirSync(join(dir, ".doug"), { recursive: true });
  if (configInstall) writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ commands: { install: configInstall } }));
  savePlan(dir, {
    version: 1, title: "T", goal: "A goal that explains the change.", status: "draft", acceptance: ["ok"], verify: ["true"],
    ...(planInstall ? { install: planInstall } : {}),
    tasks: [{ id: "a", title: "A", spec: "Do the thing in src/a.ts with a test.", files: ["src/a.ts"] }],
  });
  return dir;
}

describe("plan.mjs set", () => {
  it("sets adversary.command and install in the file and refuses unknown keys or landed plans", () => {
    const dir = project();
    expect(run(["set", "adversary.command", "node /x/bin.js"], dir).status).toBe(0);
    expect(loadPlan(dir).adversary).toEqual({ command: "node /x/bin.js" });
    expect(run(["set", "install", "npm ci"], dir).status).toBe(0);
    expect(loadPlan(dir).install).toBe("npm ci");
    const bad = run(["set", "status", "done"], dir);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("usage: plan.mjs set");
    savePlan(dir, { ...loadPlan(dir), landed: { at: "x" } });
    expect(run(["set", "install", "x"], dir).stderr).toContain("Refusing to change a landed plan");
  });
  it("sets adversary.fallback as <model>[/<effort>] or off, shows it, and refuses bad values or an adversary that is off", () => {
    const dir = project();
    expect(run(["set", "adversary.fallback", "sonnet/medium"], dir).status).toBe(0);
    expect(loadPlan(dir).adversary).toEqual({ fallback: { model: "sonnet", effort: "medium" } });
    expect(run(["set", "adversary.command", "codex-review"], dir).status).toBe(0);
    expect(run(["set", "adversary.fallback", "opus"], dir).status).toBe(0);
    expect(loadPlan(dir).adversary).toEqual({ command: "codex-review", fallback: { model: "opus" } });
    expect(run(["show"], dir).stdout).toContain("Adversary: codex-review; if it cannot run: Claude adversary on opus / high");
    expect(run(["set", "adversary.fallback", "off"], dir).status).toBe(0);
    expect(loadPlan(dir).adversary).toEqual({ command: "codex-review", fallback: false });
    expect(run(["show"], dir).stdout).toContain("if it cannot run: off; a review that does not run blocks");
    for (const bad of ["opus/turbo", "Opus", "a/b/c"]) {
      const r = run(["set", "adversary.fallback", bad], dir);
      expect(r.status, bad).toBe(2);
      expect(r.stderr).toContain('"off" or <model>[/<effort>]');
    }
    expect(loadPlan(dir).adversary).toEqual({ command: "codex-review", fallback: false });
    savePlan(dir, { ...loadPlan(dir), adversary: false });
    const off = run(["set", "adversary.fallback", "opus"], dir);
    expect(off.status).toBe(2);
    expect(off.stderr).toContain("the adversary is off");
  });
});

describe("plan.mjs set card", () => {
  it("sets card, shows it, writes it into the anchor, and rejects an empty value", () => {
    const dir = project();
    expect(run(["set", "card", "board-flow"], dir).status).toBe(0);
    expect(loadPlan(dir).card).toBe("board-flow");
    expect(run(["show"], dir).stdout).toContain("Card: board-flow");
    expect(run(["anchor"], dir).status).toBe(0);
    const anchorLines = readFileSync(join(dir, ".doug/anchor.md"), "utf8").split("\n");
    expect(anchorLines[2]).toBe("Card: board-flow");
    expect(run(["set", "card", ""], dir).status).toBe(2);
  });
  it("without a card, show and anchor carry no Card: line", () => {
    const dir = project();
    expect(run(["show"], dir).stdout).not.toContain("Card:");
    expect(run(["anchor"], dir).status).toBe(0);
    expect(readFileSync(join(dir, ".doug/anchor.md"), "utf8")).not.toContain("Card:");
  });
});

describe("plan.mjs set fixAttempts", () => {
  it("stores a number, shows it, passes it through json, and rejects non-integers", () => {
    const dir = project();
    expect(run(["set", "fixAttempts", "3"], dir).status).toBe(0);
    expect(loadPlan(dir).fixAttempts).toBe(3);
    expect(run(["show"], dir).stdout).toContain("Fix attempts per blocked task: 3");
    expect(JSON.parse(run(["json"], dir).stdout).fixAttempts).toBe(3);
    const bad1 = run(["set", "fixAttempts", "x"], dir);
    expect(bad1.status).toBe(2);
    expect(bad1.stderr).toContain("non-negative integer");
    const bad2 = run(["set", "fixAttempts", "-1"], dir);
    expect(bad2.status).toBe(2);
    expect(bad2.stderr).toContain("non-negative integer");
  });
});

describe("install default", () => {
  it("json fills install from .doug/config.json when the plan has none, and keeps the plan's own value", () => {
    const dir = project();
    expect(JSON.parse(run(["json"], dir).stdout).install).toBe("pnpm install --frozen-lockfile");
    expect(loadPlan(dir).install).toBeUndefined(); // the file is not rewritten by json
    const own = project({ planInstall: "npm ci" });
    expect(JSON.parse(run(["json"], own).stdout).install).toBe("npm ci");
    const none = project({ configInstall: null });
    expect(JSON.parse(run(["json"], none).stdout).install).toBeUndefined();
  });
});

describe("plan.mjs set guards and config defaults", () => {
  it("refuses a value that is a directory, which is what an omitted value looks like", () => {
    const dir = project();
    // The dir argument lands in the value slot, so plan.mjs falls back to its cwd for the project: run it from
    // dir, not from the checkout, whose own .doug/plan.json may be absent (the public export has none).
    const r = spawnSync(process.execPath, [cli, "set", "card", dir], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is a directory");
    expect(loadPlan(dir).card).toBeUndefined();
  });
  it("json fills adversary.command from config with {root} resolved, unless the plan names one or disables the adversary", () => {
    const dir = project();
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ commands: { install: "npm ci", adversary: "node {root}/tools/review.js" } }));
    expect(JSON.parse(run(["json"], dir).stdout).adversary).toEqual({ command: `node ${dir}/tools/review.js` });
    expect(run(["set", "adversary.command", "codex-review"], dir).status).toBe(0);
    expect(JSON.parse(run(["json"], dir).stdout).adversary).toEqual({ command: "codex-review" });
    savePlan(dir, { ...loadPlan(dir), adversary: false });
    expect(JSON.parse(run(["json"], dir).stdout).adversary).toBe(false);
    const bare = project();
    expect(JSON.parse(run(["json"], bare).stdout).adversary).toBeUndefined();
  });
});

describe("plan.mjs gate open, and done while a run is paused", () => {
  function gatedProject(status = "draft") {
    const dir = mkdtempSync(join(tmpdir(), "doug-plangate-"));
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const t = (id, extra = {}) => ({ id, title: id, spec: "Do the thing in the owned file with a test.", files: [`src/${id}.ts`], ...extra });
    savePlan(dir, { version: 1, title: "T", goal: "A goal that explains the change.", status, acceptance: ["ok"], verify: ["true"], tasks: [t("a", { gate: "human" }), t("b", { dependsOn: ["a"] })] });
    return dir;
  }
  it("records the opened level in the plan file, once, and refuses a level without a human gate or a bad argument", () => {
    const dir = gatedProject();
    const ok = run(["gate", "open", "0"], dir);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Opened the human gate after level 0");
    expect(ok.stdout).toContain("continues with level 1");
    expect(loadPlan(dir).gatesOpened).toEqual([0]);
    run(["gate", "open", "0"], dir);
    expect(loadPlan(dir).gatesOpened).toEqual([0]);
    expect(run(["show"], dir).stdout).toContain("gate: human (opened");
    const none = run(["gate", "open", "1"], dir);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("level 1 has no human gate (levels with one: 0)");
    const usage = run(["gate", "close", "0"], dir);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage: plan.mjs gate open <level>");
    const plain = project();
    expect(run(["gate", "open", "0"], plain).stderr).toContain("this plan has none");
  });
  it("refuses plan.mjs done while the last run of this plan is paused at a human gate, and allows it otherwise", () => {
    const dir = gatedProject("approved");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "T", levels: [{ index: 0, tasks: [] }], paused: { level: 0, gate: "human", next: ["b"] }, ok: false }));
    const refused = run(["done"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("paused at the human gate after level 0 (next: b)");
    expect(refused.stderr).toContain("plan.mjs gate open 0");
    expect(loadPlan(dir).status).toBe("approved");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "T", levels: [], ok: true }));
    expect(run(["done"], dir).status).toBe(0);
    expect(loadPlan(dir).status).toBe("done");
  });
});

describe("plan.mjs done refuses a report that is not ok", () => {
  function notOkProject(status = "draft") {
    const dir = mkdtempSync(join(tmpdir(), "doug-plandone-"));
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    savePlan(dir, { version: 1, title: "T", goal: "A goal that explains the change.", status, acceptance: ["ok"], verify: ["true"], tasks: [{ id: "a", title: "A", spec: "Do the thing.", files: ["src/a.ts"] }] });
    return dir;
  }
  it("refuses done when the last run stopped and is not ok, naming the level and every task's stopReason across levels, and leaves the plan approved", () => {
    const dir = notOkProject("approved");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({
      plan: "T", ok: false, stoppedAtLevel: 1,
      levels: [
        { index: 0, tasks: [{ id: "a", stopReason: "verify failed: missing test" }] },
        { index: 1, tasks: [{ id: "b", stopReason: "level adversary blocked: leaked a secret" }, { id: "c", stopReason: null }] },
      ],
    }));
    const refused = run(["done"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("the last run is not ok");
    expect(refused.stderr).toContain("stopped at level 1");
    expect(refused.stderr).toContain("a: verify failed: missing test");
    expect(refused.stderr).toContain("b: level adversary blocked: leaked a secret");
    expect(refused.stderr).toContain("plan.mjs replan");
    expect(refused.stderr).toContain("plan.mjs done --force");
    expect(loadPlan(dir).status).toBe("approved");
  });
  it("lets done proceed when a not-ok report belongs to a different plan", () => {
    const dir = notOkProject("approved");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "Some other plan", ok: false, stoppedAtLevel: 0, levels: [{ index: 0, tasks: [{ id: "a", stopReason: "integration failed" }] }] }));
    const ok = run(["done"], dir);
    expect(ok.status, ok.stderr).toBe(0);
    expect(loadPlan(dir).status).toBe("done");
  });
  it("lets done proceed on a not-ok report matching by title when the plan is not approved", () => {
    const dir = notOkProject("draft");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "T", ok: false, stoppedAtLevel: 0, levels: [{ index: 0, tasks: [{ id: "a", stopReason: "integration failed" }] }] }));
    const ok = run(["done"], dir);
    expect(ok.status, ok.stderr).toBe(0);
    expect(loadPlan(dir).status).toBe("done");
  });
  it("allows done when the last run of this plan finished ok", () => {
    const dir = notOkProject("approved");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "T", ok: true, levels: [{ index: 0, tasks: [{ id: "a", stopReason: null }] }] }));
    const ok = run(["done"], dir);
    expect(ok.status, ok.stderr).toBe(0);
    expect(loadPlan(dir).status).toBe("done");
  });
  it("still refuses a paused report even with --force, and force alone does not mark it done", () => {
    const dir = notOkProject("approved");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "T", ok: false, paused: { level: 0, gate: "human", next: ["b"] }, levels: [{ index: 0, tasks: [] }] }));
    const forced = run(["done", "--force"], dir);
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain("paused at the human gate after level 0");
    expect(loadPlan(dir).status).toBe("approved");
  });
  it("--force marks a stopped, not-ok run done and prints a warning", () => {
    const dir = notOkProject("approved");
    writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify({ plan: "T", ok: false, stoppedAtLevel: 1, levels: [{ index: 1, tasks: [{ id: "a", stopReason: "integration failed" }] }] }));
    const forced = run(["done", "--force"], dir);
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.stderr).toContain("Warning: marking the plan done although the last run is not ok");
    expect(forced.stderr).toContain("stopped at level 1");
    expect(loadPlan(dir).status).toBe("done");
  });
});

describe("plan.mjs prints scaling warnings without refusing", () => {
  it("validate, show, and approve print the task-count warning and still succeed", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-planscale-"));
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, spec: "Do the thing in the owned file with a test.", files: [`src/${i}.ts`] }));
    savePlan(dir, { version: 1, title: "T", goal: "A goal that explains the change.", status: "draft", acceptance: ["ok"], verify: ["true"], tasks });
    const v = run(["validate"], dir);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain("Plan is valid: 9 tasks");
    expect(v.stdout).toContain("Warnings:\n  ! 9 tasks: never more than eight in one plan");
    expect(run(["show"], dir).stdout).toContain("  ! 9 tasks: never more than eight");
    const a = run(["approve"], dir);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("  ! 9 tasks");
    expect(a.stdout).toContain("Approved: T.");
    expect(run(["validate"], project()).stdout).not.toContain("Warnings");
  });
});

describe("plan.mjs set swarm", () => {
  it("sets swarm on or off, shows it, and refuses other values", () => {
    const dir = project();
    expect(run(["set", "swarm", "on"], dir).status).toBe(0);
    expect(loadPlan(dir).swarm).toBe(true);
    expect(run(["show"], dir).stdout).toContain("Swarm: on");
    expect(run(["set", "swarm", "off"], dir).status).toBe(0);
    expect(loadPlan(dir).swarm).toBe(false);
    const bad = run(["set", "swarm", "maybe"], dir);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("must be on or off");
  });
});

describe("plan.mjs set workerCheck", () => {
  it("sets workerCheck on or off, shows it, and refuses other values", () => {
    const dir = project();
    expect(run(["set", "workerCheck", "on"], dir).status).toBe(0);
    expect(loadPlan(dir).workerCheck).toBe(true);
    expect(run(["show"], dir).stdout).toContain("Worker check: on");
    expect(run(["set", "workerCheck", "off"], dir).status).toBe(0);
    expect(loadPlan(dir).workerCheck).toBe(false);
    const bad = run(["set", "workerCheck", "maybe"], dir);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("must be on or off");
  });
});

// plan.mjs merge <card>... : the per-card drafts under .doug/.state/drafts become one plan (card parallel-cards).
describe("plan.mjs merge", () => {
  const draftFor = (card, tasks) => ({
    version: 1, title: `Card ${card}`, goal: `The goal of card ${card} in words.`, status: "draft", card,
    acceptance: [`${card} ok`], verify: ["true"], tasks,
  });
  const task = (id, files, extra = {}) => ({ id, title: id, spec: `Do the thing for ${id} with a test.`, files, size: "S", ...extra });
  function batchProject({ withPlan = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "doug-merge-"));
    mkdirSync(join(dir, ".doug/.state/drafts"), { recursive: true });
    // The board decides the order: beta before alpha, whatever order the ids are passed in.
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }], components: [], cards: [
      { id: "beta", column: "ready", title: "Beta", goal: "b" }, { id: "alpha", column: "ready", title: "Alpha", goal: "a" }, { id: "gamma", column: "ready", title: "Gamma", goal: "g" },
    ] }));
    writeFileSync(join(dir, ".doug/.state/drafts/alpha.json"), JSON.stringify(draftFor("alpha", [task("a1", ["src/shared.ts"])])));
    writeFileSync(join(dir, ".doug/.state/drafts/beta.json"), JSON.stringify(draftFor("beta", [task("b1", ["src/shared.ts", "src/b.ts"])])));
    if (withPlan) savePlan(dir, { ...draftFor("old", [task("o1", ["src/o.ts"])]), status: "approved" });
    return dir;
  }
  it("merges the drafts in board order into .doug/plan.json and prints the sequencing", () => {
    const dir = batchProject();
    const r = run(["merge", "alpha", "beta"], dir);
    expect(r.status, r.stderr).toBe(0);
    const merged = loadPlan(dir);
    expect(merged.cards).toEqual(["beta", "alpha"]);
    expect(merged.status).toBe("draft");
    expect(merged.tasks.map((x) => [x.id, x.card, x.dependsOn])).toEqual([["b1", "beta", undefined], ["a1", "alpha", ["b1"]]]);
    expect(r.stdout).toContain("Merged 2 cards into .doug/plan.json: beta, alpha (board order).");
    expect(r.stdout).toContain("  src/shared.ts: alpha/a1 runs after beta/b1 (both own it)");
    expect(r.stdout).toContain("Plan is valid: 2 tasks in 2 levels, status draft.");
    expect(run(["show"], dir).stdout).toContain("Cards: beta, alpha");
  });
  it("refuses a cycle across cards, a missing draft, one card, and an approved plan that has not landed", () => {
    const dir = batchProject();
    const missing = run(["merge", "alpha", "gamma"], dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no draft for card gamma at .doug/.state/drafts/gamma.json");
    expect(run(["merge", "alpha"], dir).status).toBe(2);
    const cyc = JSON.parse(readFileSync(join(dir, ".doug/.state/drafts/beta.json"), "utf8"));
    cyc.tasks[0].dependsOn = ["a1"];
    writeFileSync(join(dir, ".doug/.state/drafts/beta.json"), JSON.stringify(cyc));
    const cycle = run(["merge", "alpha", "beta"], dir);
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain("dependency cycle across cards beta and alpha: b1 -> a1 -> b1");
    const busy = batchProject({ withPlan: true });
    const refused = run(["merge", "alpha", "beta"], busy);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Refusing to replace an approved plan that has not landed");
    expect(loadPlan(busy).title).toBe("Card old");
  });
  it("validate and show take --file for a draft that is not the plan", () => {
    const dir = batchProject();
    const ok = run(["validate", "--file", ".doug/.state/drafts/alpha.json"], dir);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Plan is valid: 1 tasks in 1 levels, status draft.");
    expect(run(["show", "--file", ".doug/.state/drafts/beta.json"], dir).stdout).toContain("Card beta  [draft]");
    const none = run(["validate", "--file", ".doug/.state/drafts/nope.json"], dir);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("No plan at");
  });
});

// plan.mjs json's memory recall (card memory-recall #2): per-task lessons attached from a seeded memory db,
// capped at 2000 characters, never written to the plan file itself. Review minor 1: there is no plan-level
// list — the planner recalls on its own before writing the plan, and json only ever attaches per task.
describe("plan.mjs json memory recall", () => {
  function memoryProject({ goal, task } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "doug-planset-memory-"));
    mkdirSync(join(dir, ".doug"), { recursive: true });
    savePlan(dir, {
      version: 1,
      title: "T",
      goal: goal || "A goal that explains the change.",
      status: "draft",
      acceptance: ["ok"],
      verify: ["true"],
      tasks: [task || { id: "a", title: "A", spec: "Do the thing in src/a.ts with a test.", files: ["src/a.ts"] }],
    });
    return dir;
  }

  it("attaches task-level lessons and ids from a seeded memory db, and never a plan-level list", () => {
    const task = {
      id: "a",
      title: "zzzplatypus renamer",
      spec: "Implement a zzzplatypus rename helper for zzzduck records in src/platypus.ts.",
      files: ["src/platypus.ts"],
    };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    const taskLesson = addLesson(m, {
      text: "zzzplatypus rename helper preserves zzzduck order",
      kind: "pattern",
      scope: ["src/platypus.ts"],
      source: { agent: "worker" },
    });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    expect(plan.lessons).toBeUndefined();
    expect(plan.lessonIds).toBeUndefined();
    const t = plan.tasks.find((x) => x.id === "a");
    expect(t.lessons).toContain(`[${taskLesson.id}]`);
    expect(t.lessonIds).toEqual([taskLesson.id]);
    // Never written to the plan file itself.
    expect(loadPlan(dir).tasks[0].lessons).toBeUndefined();
  });

  it("caps a task's lessons string at 2000 characters, cutting each lesson's own line and skipping any that still overflow, with lessonIds matching the lines kept", () => {
    const task = { id: "a", title: "zzzcapword task", spec: "zzzcapword goal for the cap test.", files: ["src/a.ts"] };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    const seeded = [];
    for (let i = 0; i < 8; i++) {
      const text = `zzzcapword filler lesson number ${i} ` + "y".repeat(260);
      seeded.push(addLesson(m, { text, kind: "pattern", source: { agent: "worker" } }));
    }
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    const t = plan.tasks.find((x) => x.id === "a");
    expect(t.lessons.length).toBeLessThanOrEqual(2000);
    const lines = t.lessons.split("\n");
    expect(lines.length).toBe(t.lessonIds.length);
    expect(t.lessonIds.length).toBeLessThan(seeded.length);
    for (const line of lines) expect(line).toMatch(/^- \[[0-9a-f]{16}\] /);
    for (const id of t.lessonIds) expect(t.lessons).toContain(`[${id}]`);
    // Proof the cap actually triggered: every candidate line is the same length, so all of them would have
    // overflowed 2000 characters had none been cut.
    const lineLength = lines[0].length;
    expect(lineLength * seeded.length + (seeded.length - 1)).toBeGreaterThan(2000);
  });

  it("gives each lesson its own budget: a 12k-char top hit and two short lessons all render, in rank order, within the cap", () => {
    const task = {
      id: "a",
      title: "zzzhugeball rewrite task",
      spec: "Rewrite the zzzhugeball documentation for the project with a new structure.",
      files: ["src/a.ts"],
    };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    const big = addLesson(m, {
      text: "zzzhugeball documentation rewrite project structure notes. ".repeat(200).slice(0, 12000),
      kind: "pattern",
      source: { agent: "worker" },
    });
    const short1 = addLesson(m, { text: "zzzhugeball short lesson one about structure.", kind: "pattern", source: { agent: "worker" } });
    const short2 = addLesson(m, { text: "zzzhugeball short lesson two about documentation.", kind: "pattern", source: { agent: "worker" } });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    const t = plan.tasks.find((x) => x.id === "a");
    // Proof this store actually exercises the fix: the 12k lesson must rank first, ahead of the two short ones.
    expect(t.lessonIds[0]).toBe(big.id);
    expect(t.lessonIds).toEqual([big.id, short1.id, short2.id]);
    expect(t.lessons.length).toBeLessThanOrEqual(2000);
    const lines = t.lessons.split("\n");
    expect(lines.length).toBe(3);
    // The 12k lesson's line is cut to its own budget, at a sentence boundary, with an ellipsis, its citation
    // (falling back to kind, here "pattern") still at the end of the line.
    const bigLine = lines[0];
    expect(bigLine.length).toBeLessThan(500);
    expect(bigLine).toMatch(/\.… \(pattern\)$/);
    expect(lines[1]).toBe(`- [${short1.id}] zzzhugeball short lesson one about structure. (pattern)`);
    expect(lines[2]).toBe(`- [${short2.id}] zzzhugeball short lesson two about documentation. (pattern)`);
  });

  it("still renders a cut head for every lesson when the whole store is oversized, skipping past nothing rather than stopping", () => {
    const task = { id: "a", title: "zzzoversized task", spec: "zzzoversized goal needing recall.", files: ["src/a.ts"] };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    // Three shapes of oversized lesson: an early sentence boundary, a word boundary but no sentence-ender, and
    // no boundary at all (one long unbroken token), so the cut logic's three fallbacks all get exercised.
    const withSentence = addLesson(m, { text: "zzzoversized lesson with a sentence. " + "z".repeat(3000), kind: "pattern", source: { agent: "worker" } });
    const withWord = addLesson(m, { text: "zzzoversized lesson word boundary " + "y".repeat(3000), kind: "pattern", source: { agent: "worker" } });
    const noBoundary = addLesson(m, { text: "x".repeat(3000) + " zzzoversized marker", kind: "pattern", source: { agent: "worker" } });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    const t = plan.tasks.find((x) => x.id === "a");
    expect([...t.lessonIds].sort()).toEqual([withSentence.id, withWord.id, noBoundary.id].sort());
    expect(t.lessons.length).toBeLessThanOrEqual(2000);
    const lines = t.lessons.split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line).toContain("…");
      expect(line.length).toBeLessThan(500);
    }
  });

  it("skips an earlier-ranked line that overflows the cap so a later, shorter lesson still renders (review MAJOR: skip, not stop)", () => {
    const task = {
      id: "a",
      title: "zzzskiptest task",
      spec: "zzzskiptest goal for the skip test.",
      files: ["src/a.ts"],
    };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    // Repeating the keyword heavily gives these four filler lessons, plus the fifth "overflow" one, the
    // strongest possible bm25 match, so all five out-rank the weakly-matching "short" lesson below despite it
    // being far shorter — the tie-break the fix must survive.
    const repeatedText = (len, marker) => {
      const room = len - marker.length;
      let text = "";
      while (text.length < room) text += "zzzskiptest ";
      return text.slice(0, room) + marker;
    };
    const fillerIds = [];
    for (let i = 0; i < 4; i++) {
      fillerIds.push(addLesson(m, { text: repeatedText(399, `mark${i}`), kind: "pattern", source: { agent: "worker" } }).id);
    }
    const overflow = addLesson(m, { text: repeatedText(399, "markoverflow"), kind: "pattern", source: { agent: "worker" } });
    const short = addLesson(m, { text: "zzzskiptest short lesson.", kind: "pattern", source: { agent: "worker" } });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    const t = plan.tasks.find((x) => x.id === "a");
    // The four ~430-char filler lines alone already total ~1723 of the 2000 cap; the fifth same-sized line
    // (overflow), ranked right after them, would push that past 2000 and must be skipped, while the far
    // shorter line ranked after it still fits.
    expect(t.lessonIds).toEqual([...fillerIds, short.id]);
    expect(t.lessonIds).not.toContain(overflow.id);
    expect(t.lessons).not.toContain(`[${overflow.id}]`);
    expect(t.lessons).toContain(`[${short.id}]`);
    expect(t.lessons.length).toBeLessThanOrEqual(2000);
  });

  it("does not collapse a lesson to almost nothing when a boundary sits too close to the start (review MINOR)", () => {
    const task = {
      id: "a",
      title: "zzznewlinetest task",
      spec: "zzznewlinetest goal for the newline test.",
      files: ["src/a.ts"],
    };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    // The keyword is followed immediately by a newline, then 600 unbroken characters with no further space or
    // sentence-ender within the budget: the newline alone would cut this down to almost nothing.
    const lesson = addLesson(m, { text: "zzznewlinetest\n" + "z".repeat(600), kind: "pattern", source: { agent: "worker" } });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    const t = plan.tasks.find((x) => x.id === "a");
    expect(t.lessonIds).toEqual([lesson.id]);
    // A cut collapsed to the newline alone would render "zzznewlinetest…"; the fix falls through past it
    // (here, to the hard-cut fallback, since there is no later space either) and keeps most of a budget's
    // worth of text instead.
    expect(t.lessons).toContain("zzznewlinetest\nz");
    expect(t.lessons.length).toBeGreaterThan(300);
  });

  it("omits the fields when there is no memory database", () => {
    const dir = memoryProject();
    expect(existsSync(memoryPath(dir))).toBe(false);
    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toBe("");
    const plan = JSON.parse(out.stdout);
    expect(plan.lessons).toBeUndefined();
    expect(plan.lessonIds).toBeUndefined();
    expect(plan.tasks[0].lessons).toBeUndefined();
    expect(plan.tasks[0].lessonIds).toBeUndefined();
  });

  it("omits the fields and prints one stderr line when the memory database file is broken", () => {
    const dir = memoryProject();
    mkdirSync(join(dir, ".doug/.state/memory"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/memory/memory.db"), "not a sqlite file at all");
    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    expect(plan.lessons).toBeUndefined();
    expect(plan.tasks[0].lessons).toBeUndefined();
    expect(out.stderr).toContain("[doug] memory recall skipped:");
  });

  // A free port, closed the instant it is handed out: nothing else in the test run can be listening on it, and
  // it stays closed at least as long as this test needs (review MAJOR).
  function closedPort() {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
  }

  it("caches a down embeddings provider after its first failure: json for 8 tasks stays well under 5s and prints exactly one stderr line (review MAJOR)", async () => {
    const port = await closedPort();
    const tasks = [];
    for (let i = 0; i < 8; i++) tasks.push({ id: `t${i}`, title: `zzzslow task ${i}`, spec: "zzzslow provider timing test.", files: [`src/t${i}.ts`] });
    const dir = mkdtempSync(join(tmpdir(), "doug-planset-memory-slow-"));
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify({ memory: { embeddings: { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${port}`, model: "zzzslow-model", dims: 3 } } })
    );
    savePlan(dir, {
      version: 1,
      title: "T",
      goal: "A goal that explains the change.",
      status: "draft",
      acceptance: ["ok"],
      verify: ["true"],
      tasks,
    });
    const m = openMemory(dir);
    const lesson = addLesson(m, { text: "zzzslow provider timing lesson", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, lesson.id, { model: "zzzslow-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    m.close();

    const started = Date.now();
    const out = run(["json"], dir);
    const elapsed = Date.now() - started;
    expect(out.status, out.stderr).toBe(0);
    expect(elapsed).toBeLessThan(5000);
    const plan = JSON.parse(out.stdout);
    expect(plan.tasks).toHaveLength(8);
    for (const t of plan.tasks) {
      expect(t.lessons, t.id).toContain(`[${lesson.id}]`);
      expect(t.lessonIds).toEqual([lesson.id]);
    }
    const stderrLines = out.stderr.split("\n").filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toMatch(/^\[doug\] memory recall: embeddings provider unavailable \(.+\); keyword-only$/);
  });

  // The closed-port test above proves the single-stderr-line half of the fix, but a closed port refuses the
  // connection near-instantly: even 8 uncached embeds would cost only a few milliseconds there, so it does not
  // pin caching itself (a warn-once-but-still-request wrapper would pass it too). Reproducing the original
  // finding needs a provider that hangs instead of refusing, so every uncached request pays its full timeout.
  // A genuinely unroutable address (192.0.2.1, TEST-NET-1, RFC 5737 - the literal black hole) does that too,
  // but measured directly in this sandbox it is flaky: fetch() + AbortSignal.timeout aborts the request at a
  // clean 2s every time, yet the underlying TCP *connect* attempt's socket stays open for several more seconds
  // after that (process._getActiveHandles() still shows it), and how many varies run to run - 4.2s to 10.9s
  // total across repeated runs of this exact test, straddling the 5s bound. A local server that accepts the
  // connection and then writes nothing hangs the request the same way (the client still has nothing to read
  // and still needs its own timeout to give up) without that connect-phase jitter, since the TCP handshake to
  // localhost completes immediately and there is no connect attempt left dangling for the OS to tear down;
  // confirmed directly (5 runs, 2.00-2.01s each) where the black-holed address gave 4.2-10.9s. Uncached, 8
  // tasks would cost 8 * 2s = 16s; cached, one 2s timeout for the whole run.
  function hangingServer() {
    return new Promise((resolve, reject) => {
      const srv = createServer(() => {
        // Accept the connection and hold it open, writing nothing: the client's request never resolves on its
        // own, only via its own timeout.
      });
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => resolve(srv));
    });
  }

  it(
    "against a provider that accepts the connection and never responds, json for 8 tasks pays one 2s timeout, not nine, and prints exactly one stderr line (review: reproduces the original finding)",
    async () => {
      const srv = await hangingServer();
      try {
        const port = srv.address().port;
        const tasks = [];
        for (let i = 0; i < 8; i++) tasks.push({ id: `t${i}`, title: `zzzhang task ${i}`, spec: "zzzhang provider timing test.", files: [`src/t${i}.ts`] });
        const dir = mkdtempSync(join(tmpdir(), "doug-planset-memory-hang-"));
        mkdirSync(join(dir, ".doug"), { recursive: true });
        writeFileSync(
          join(dir, ".doug/config.json"),
          JSON.stringify({ memory: { embeddings: { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${port}`, model: "zzzhang-model", dims: 3 } } })
        );
        savePlan(dir, {
          version: 1,
          title: "T",
          goal: "A goal that explains the change.",
          status: "draft",
          acceptance: ["ok"],
          verify: ["true"],
          tasks,
        });
        const m = openMemory(dir);
        const lesson = addLesson(m, { text: "zzzhang provider timing lesson", kind: "pattern", source: { agent: "worker" } });
        setLessonEmbedding(m, lesson.id, { model: "zzzhang-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
        m.close();

        const started = Date.now();
        const out = run(["json"], dir);
        const elapsed = Date.now() - started;
        expect(out.status, out.stderr).toBe(0);
        // 12s budget, not 5s: one 2s fetch timeout plus a spawned plan.mjs json (node startup, module load,
        // sqlite open, 8 recalls) can pass 5s on a loaded machine; the defect this guards against is nine
        // timeouts (18s+), still comfortably outside this budget.
        expect(elapsed).toBeLessThan(12000);
        const plan = JSON.parse(out.stdout);
        expect(plan.tasks).toHaveLength(8);
        for (const t of plan.tasks) {
          expect(t.lessons, t.id).toContain(`[${lesson.id}]`);
          expect(t.lessonIds).toEqual([lesson.id]);
        }
        const stderrLines = out.stderr.split("\n").filter(Boolean);
        expect(stderrLines).toHaveLength(1);
        expect(stderrLines[0]).toMatch(/^\[doug\] memory recall: embeddings provider unavailable \(.+\); keyword-only$/);
      } finally {
        srv.close();
      }
    },
    30000,
  );

  it("honors memory.staleDays from .doug/config.json: a 40-day-old lesson reaches the task's attached lessons only once staleDays is 60", () => {
    const task = {
      id: "a",
      title: "zzzstaledays task",
      spec: "zzzstaledays goal about a lesson that is forty days old.",
      files: ["src/a.ts"],
    };
    const dir = memoryProject({ task });
    const m = openMemory(dir);
    const oldLesson = addLesson(m, {
      text: "zzzstaledays: an old lesson about this exact task from forty days back",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(Date.now() - 40 * 86400000).toISOString(),
    });
    m.close();

    const withoutKey = run(["json"], dir);
    expect(withoutKey.status, withoutKey.stderr).toBe(0);
    const planWithoutKey = JSON.parse(withoutKey.stdout);
    const tWithoutKey = planWithoutKey.tasks.find((x) => x.id === "a");
    expect(tWithoutKey.lessonIds || []).not.toContain(oldLesson.id);

    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ memory: { staleDays: 60 } }));
    const withKey = run(["json"], dir);
    expect(withKey.status, withKey.stderr).toBe(0);
    const planWithKey = JSON.parse(withKey.stdout);
    const tWithKey = planWithKey.tasks.find((x) => x.id === "a");
    expect(tWithKey.lessonIds || []).toContain(oldLesson.id);
  });
});

// plan.mjs json's code context (card semantic-index, brief B): per-task chunks from the opt-in code index,
// attached only when memory.index.enabled is true and the store holds at least one chunk; never a plan-level
// field, never written to the plan file itself. Shares attachLessons' cachingProvider instance so a down
// embeddings endpoint is still probed only once per run across both attach steps.
describe("plan.mjs json code context", () => {
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  function codeContextRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "doug-planset-codectx-"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    for (const [p, content] of Object.entries(files)) {
      const abs = join(dir, p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
  }

  function planFor(task) {
    return {
      version: 1,
      title: "T",
      goal: "A goal that explains the change.",
      status: "draft",
      acceptance: ["ok"],
      verify: ["true"],
      tasks: [task],
    };
  }

  function writeIndexConfig(dir, memory) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ memory }));
  }

  it("attaches per-task codeContext and codeContextIds from a seeded code index when memory.index.enabled is true, and never a plan-level field", async () => {
    const task = { id: "a", title: "zzzwombat helper", spec: "Implement zzzwombat support in src/wombat.ts.", files: ["src/wombat.ts"] };
    const dir = codeContextRepo({ "src/wombat.ts": "export function zzzwombat() {\n  return 42;\n}\n" });
    savePlan(dir, planFor(task));
    writeIndexConfig(dir, { index: { enabled: true } });
    const m = openMemory(dir);
    await buildIndex(m, dir, { cfg: {} });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const plan = JSON.parse(out.stdout);
    expect(plan.codeContext).toBeUndefined();
    expect(plan.codeContextIds).toBeUndefined();
    const t = plan.tasks.find((x) => x.id === "a");
    expect(t.codeContext).toContain("src/wombat.ts:");
    expect(t.codeContext).toContain("zzzwombat");
    expect(Array.isArray(t.codeContextIds)).toBe(true);
    expect(t.codeContextIds.length).toBeGreaterThan(0);
    expect(loadPlan(dir).tasks[0].codeContext).toBeUndefined();
  });

  it("carries neither field when memory.index.enabled is false, and when the key is absent, even with chunks in the store", async () => {
    for (const memory of [{ index: { enabled: false } }, undefined]) {
      const task = { id: "a", title: "A", spec: "Do the thing in src/a.ts with a test.", files: ["src/a.ts"] };
      const dir = codeContextRepo({ "src/a.ts": "export function a() {\n  return 1;\n}\n" });
      savePlan(dir, planFor(task));
      if (memory) writeIndexConfig(dir, memory);
      const m = openMemory(dir);
      await buildIndex(m, dir, { cfg: {} });
      m.close();

      const out = run(["json"], dir);
      expect(out.status, out.stderr).toBe(0);
      const p = JSON.parse(out.stdout);
      expect(p.tasks[0].codeContext).toBeUndefined();
      expect(p.tasks[0].codeContextIds).toBeUndefined();
    }
  });

  it("carries neither field, and prints nothing, when the index is enabled but the store has no chunks", () => {
    const task = { id: "a", title: "A", spec: "Do the thing in src/a.ts.", files: ["src/a.ts"] };
    const dir = codeContextRepo({ "src/a.ts": "export function a() {}\n" });
    savePlan(dir, planFor(task));
    writeIndexConfig(dir, { index: { enabled: true } });
    const m = openMemory(dir); // creates the v6 schema; no build ever run, so code_chunks is empty
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toBe("");
    const p = JSON.parse(out.stdout);
    expect(p.tasks[0].codeContext).toBeUndefined();
    expect(p.tasks[0].codeContextIds).toBeUndefined();
  });

  it("caps codeContext at 2000 characters, skipping an overflowing line rather than stopping, with codeContextIds matching the lines kept in rank order", async () => {
    const longDir = "z".repeat(220);
    const files = {};
    for (let i = 0; i < 6; i++) files[`${longDir}/f${i}${longDir}.ts`] = "// zzzcapchunk marker\nexport function chunk() {\n  return 1;\n}\n";
    const dir = codeContextRepo(files);
    const task = { id: "a", title: "zzzcapchunk task", spec: "zzzcapchunk goal touching many files.", files: Object.keys(files) };
    savePlan(dir, planFor(task));
    writeIndexConfig(dir, { index: { enabled: true } });
    const m = openMemory(dir);
    await buildIndex(m, dir, { cfg: {} });
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const p = JSON.parse(out.stdout);
    const t = p.tasks[0];
    expect(t.codeContext.length).toBeLessThanOrEqual(2000);
    const lines = t.codeContext.split("\n");
    expect(lines.length).toBe(t.codeContextIds.length);
    expect(t.codeContextIds.length).toBeLessThan(6);
    // Proof the cap actually triggered: every candidate line is the same length (same path length, same content),
    // so all six would have overflowed 2000 characters had none been cut.
    const lineLength = lines[0].length;
    expect(lineLength * 6 + 5).toBeGreaterThan(2000);
  });

  function closedPort() {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
  }

  it("with a down embeddings provider, lessons and code context share one probe: exit 0, keyword-only, exactly one stderr line", async () => {
    const port = await closedPort();
    const task = { id: "a", title: "zzzshared task", spec: "zzzshared goal in src/shared.ts.", files: ["src/shared.ts"] };
    const dir = codeContextRepo({ "src/shared.ts": "export function zzzshared() {\n  return 1;\n}\n" });
    savePlan(dir, planFor(task));
    writeIndexConfig(dir, {
      embeddings: { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${port}`, model: "zzzshared-model", dims: 3 },
      index: { enabled: true },
    });

    const m = openMemory(dir);
    const lesson = addLesson(m, { text: "zzzshared lesson about src/shared.ts", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, lesson.id, { model: "zzzshared-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    await buildIndex(m, dir, { cfg: {} });
    const chunk = m.prepare("SELECT id FROM code_chunks LIMIT 1").get();
    const vector = Float32Array.from([1, 0, 0]);
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    m.prepare("UPDATE code_chunks SET embedding_model = ?, embedding_dims = ?, embedding = ? WHERE id = ?").run("zzzshared-model", 3, blob, chunk.id);
    m.close();

    const out = run(["json"], dir);
    expect(out.status, out.stderr).toBe(0);
    const stderrLines = out.stderr.split("\n").filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toMatch(/^\[doug\] memory recall: embeddings provider unavailable \(.+\); keyword-only$/);
  });
});
