// Card fixture-repo-scenarios: the ts-orders fixture (a larger fictitious order-management app) and the
// rehearsal descriptor in evals/tasks/ts-orders.json. Checks the fixture is bigger than ts-app and green on its
// own, that every held-out test fails against it and typechecks with the rest, that the descriptor gives each
// scenario the cards D3 names, and that a prepared fixture carries the board and the seeded lessons. Never spawns
// claude. Prepared-fixture tests skip when the CLI is unbuilt (pnpm build), like tests/rehearse-auto.test.mjs.
import { describe, it, expect, afterAll, vi } from "vitest";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI, ROOT, MEMORY_MJS, cleanEnv } from "../scripts/rehearse-lib.mjs";
import { here, trackedTempDir, run, git, inLib, tempDirs } from "./rehearse-fixtures.mjs";

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const FIXTURE = join(ROOT, "evals/fixtures/ts-orders");
const TASKS = join(ROOT, "evals/tasks/ts-orders.json");
const HELDOUT = join(ROOT, "evals/heldout");
const PREFIX = "doug-rehearse-test-";
const built = existsSync(CLI);
const SCENARIOS_WITH_CARDS = ["flow", "swarm", "hand", "auto", "parallel", "start-feature", "swarm-skill"];

const suite = () => JSON.parse(readFileSync(TASKS, "utf8"));
const listFiles = (root) => (existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((f) => !f.includes("node_modules")) : []);
const cardsOf = (name) => suite().rehearsal.scenarios[name].cards;
const planFiles = (taskId) => {
  const task = suite().tasks.find((t) => t.id === taskId);
  return [...new Set(task.plan.tasks.flatMap((t) => t.files))];
};
const isTest = (f) => /(^|\/)tests?\//.test(f) || /\.test\.ts$/.test(f);

describe("the ts-orders fixture is a larger app with its own toolchain", () => {
  it("has the same package.json shape as ts-app", () => {
    const pkg = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.packageManager).toBe("pnpm@9.15.4");
    expect(pkg.devDependencies).toEqual({ "@types/node": "^20.17.0", typescript: "^5.6.0", vitest: "^2.1.0" });
    expect(readFileSync(join(FIXTURE, "pnpm-workspace.yaml"), "utf8")).toMatch(/packages:\s*\[\]/);
    expect(existsSync(join(FIXTURE, "pnpm-lock.yaml"))).toBe(true);
    expect(readFileSync(join(FIXTURE, ".gitignore"), "utf8")).toContain("node_modules");
  });
  it("is larger than ts-app: at least 15 src .ts files in at least 5 subdirectories, and at least 6 test files", () => {
    const src = listFiles(join(FIXTURE, "src")).filter((f) => f.endsWith(".ts"));
    expect(src.length).toBeGreaterThanOrEqual(15);
    const subdirs = new Set(src.filter((f) => f.includes("/")).map((f) => f.split("/")[0]));
    expect(subdirs.size).toBeGreaterThanOrEqual(5);
    const tests = listFiles(join(FIXTURE, "tests")).filter((f) => f.endsWith(".test.ts"));
    expect(tests.length).toBeGreaterThanOrEqual(6);
    const appSrc = listFiles(join(ROOT, "evals/fixtures/ts-app/src")).filter((f) => f.endsWith(".ts"));
    expect(src.length).toBeGreaterThan(appSrc.length);
  });
  it("checks in no .doug directory (board and memory seed live in the tasks file)", () => {
    expect(existsSync(join(FIXTURE, ".doug"))).toBe(false);
  });
});

describe("the ts-orders fixture installs, passes, and every held-out test fails against it", () => {
  // Set up lazily (not in beforeAll) so a missing fixture fails each test instead of skipping them.
  let setup = null;
  function ensureInstalled() {
    setup ??= (async () => {
      const dir = trackedTempDir("doug-eval-ts-orders-");
      cpSync(FIXTURE, dir, { recursive: true });
      await git(dir, "init", "-q", "-b", "main");
      await git(dir, "config", "user.email", "t@example.com");
      await git(dir, "config", "user.name", "t");
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "fixture");
      const installed = await run("pnpm", ["install", "--prefer-offline", "--silent"], { cwd: dir, env: cleanEnv() });
      return { dir, installed };
    })();
    return setup;
  }
  const heldOuts = () => suite().tasks.flatMap((t) => t.heldOut || []);

  it("the ts-orders fixture's own pnpm test and pnpm typecheck pass", async () => {
    const { dir, installed } = await ensureInstalled();
    expect(installed.status, `pnpm install: ${installed.stderr}`).toBe(0);
    const test = await run("pnpm", ["test"], { cwd: dir, env: cleanEnv() });
    expect(test.status, `pnpm test: ${test.stdout}\n${test.stderr}`).toBe(0);
    const typecheck = await run("pnpm", ["typecheck"], { cwd: dir, env: cleanEnv() });
    expect(typecheck.status, `pnpm typecheck: ${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
  });
  it("every ts-orders held-out test fails against the baseline fixture", async () => {
    const { dir } = await ensureInstalled();
    const all = heldOuts();
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const h of all) {
      const dest = join(dir, h.to);
      cpSync(join(HELDOUT, h.from), dest);
      const r = await run("pnpm", ["test"], { cwd: dir, env: cleanEnv() });
      rmSync(dest);
      expect(r.status, `${h.from} did not fail: ${r.stdout}\n${r.stderr}`).not.toBe(0);
    }
  });
  it("all ts-orders held-out files typecheck together against the baseline fixture", async () => {
    const { dir } = await ensureInstalled();
    const all = heldOuts();
    for (const h of all) cpSync(join(HELDOUT, h.from), join(dir, h.to));
    const r = await run("pnpm", ["typecheck"], { cwd: dir, env: cleanEnv() });
    for (const h of all) rmSync(join(dir, h.to), { force: true });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

describe("evals/tasks/ts-orders.json is shaped like ts-basic.json", () => {
  it("names the fixture, the setup, and tasks with a prompt, mustPass, mustNotChange and (for a card's task) a held-out file under evals/heldout", () => {
    const s = suite();
    expect(s.fixture).toBe("ts-orders");
    expect(s.setup).toEqual(["pnpm install --prefer-offline --silent"]);
    expect(s.tasks.length).toBeGreaterThanOrEqual(4);
    const ids = new Set();
    for (const t of s.tasks) {
      expect(ids.has(t.id), `duplicate ${t.id}`).toBe(false);
      ids.add(t.id);
      expect(typeof t.prompt, t.id).toBe("string");
      expect(t.allowedFiles?.length, t.id).toBeGreaterThan(0);
      expect(t.mustPass, t.id).toEqual(expect.arrayContaining(["pnpm test", "pnpm typecheck"]));
      expect(Array.isArray(t.mustNotChange), t.id).toBe(true);
    }
    for (const name of SCENARIOS_WITH_CARDS) {
      for (const c of cardsOf(name)) {
        const t = s.tasks.find((x) => x.id === c.task);
        expect(t, `${name}: task ${c.task}`).toBeTruthy();
        expect(t.heldOut?.length, `${name}: ${c.task} held-out`).toBeGreaterThan(0);
        for (const h of t.heldOut) {
          expect(h.from, c.task).toMatch(/^ts-orders-.+\.test\.ts$/);
          expect(existsSync(join(HELDOUT, h.from)), h.from).toBe(true);
          expect(h.to).toMatch(/^tests\/.+\.test\.ts$/);
        }
      }
    }
  });
  it("every rehearsal card carries id, task, track, column, component, size and class code", () => {
    for (const name of SCENARIOS_WITH_CARDS) {
      expect(cardsOf(name).length, name).toBeGreaterThan(0);
      for (const c of cardsOf(name)) {
        for (const k of ["id", "task", "column", "component", "size", "class"]) expect(c[k], `${name}/${c.id} ${k}`).toBeTruthy();
        expect(c.class, `${name}/${c.id}`).toBe("code");
        expect(["S", "M", "L"]).toContain(c.size);
      }
    }
  });
  it("carries background cards (a Done and a Backlog one), at least 3 lessons, a memory query that a lesson answers, and a decide proposal", () => {
    const r = suite().rehearsal;
    expect(r.background.some((c) => c.column === "done")).toBe(true);
    expect(r.background.some((c) => c.column === "backlog")).toBe(true);
    expect(r.lessons.length).toBeGreaterThanOrEqual(3);
    for (const l of r.lessons) for (const k of ["text", "kind", "citation"]) expect(typeof l[k], k).toBe("string");
    expect(r.memory.recallQuery).toBeTruthy();
    expect(r.lessons.some((l) => l.text.includes(r.memory.expectText))).toBe(true);
    expect(r.decide.title).toBeTruthy();
    expect(r.decide.body).toBeTruthy();
  });
  it("the hand ts-orders fixture takes one Ready hand-track S card", () => {
    const cards = cardsOf("hand");
    expect(cards).toHaveLength(1);
    expect([cards[0].column, cards[0].track, cards[0].size]).toEqual(["ready", "hand", "S"]);
  });
  it("the flow ts-orders fixture takes one Ready flow card with a plan", () => {
    const cards = cardsOf("flow");
    expect(cards).toHaveLength(1);
    expect(cards[0].column).toBe("ready");
    expect([undefined, "flow"]).toContain(cards[0].track);
    expect(suite().tasks.find((t) => t.id === cards[0].task).plan.tasks.length).toBeGreaterThan(0);
  });
  it("the auto ts-orders fixture has two Ready hand S cards and one Backlog card", () => {
    const cards = cardsOf("auto");
    const ready = cards.filter((c) => c.column === "ready");
    expect(ready).toHaveLength(2);
    for (const c of ready) expect([c.track, c.size]).toEqual(["hand", "S"]);
    expect(cards.filter((c) => c.column === "backlog")).toHaveLength(1);
    expect(cards).toHaveLength(3);
  });
  it("the parallel ts-orders fixture has one flow and one hand card in different components and workers.max 2", () => {
    const cards = cardsOf("parallel");
    expect(cards).toHaveLength(2);
    expect(cards.filter((c) => c.track === "hand")).toHaveLength(1);
    expect(cards.filter((c) => c.track !== "hand")).toHaveLength(1);
    expect(new Set(cards.map((c) => c.component)).size).toBe(2);
  });
  for (const name of ["swarm", "swarm-skill"]) {
    it(`the ${name} task owns at least three non-test source files in at least two src/ subdirectories, size M or L`, () => {
      const cards = cardsOf(name);
      expect(cards).toHaveLength(1);
      expect(["M", "L"]).toContain(cards[0].size);
      const files = planFiles(cards[0].task).filter((f) => f.startsWith("src/") && !isTest(f));
      expect(files.length).toBeGreaterThanOrEqual(3);
      const subdirs = new Set(files.filter((f) => f.split("/").length >= 3).map((f) => f.split("/")[1]));
      expect(subdirs.size).toBeGreaterThanOrEqual(2);
      for (const f of files) expect(existsSync(join(FIXTURE, f)), `${f} exists in the fixture`).toBe(true);
    });
  }
  it("the swarm-skill card's goal directs one task that owns its source files, not three independent single-file helpers (card ts-orders-rehearsal-scenario-fixes)", () => {
    const task = suite().tasks.find((t) => t.id === cardsOf("swarm-skill")[0].task);
    const goal = task.plan.goal;
    expect(goal).toMatch(/\bone task\b/i);
    expect(goal).not.toMatch(/independent/i);
    expect(goal).not.toMatch(/three (independent )?(helpers|tasks)/i);
    // The plan the descriptor seeds is a single task owning at least two source files: the shape gate splits it.
    expect(task.plan.tasks).toHaveLength(1);
    expect(task.plan.tasks[0].files.filter((f) => !isTest(f)).length).toBeGreaterThanOrEqual(2);
  });
  it("the swarm-skill card is Ready on the flow track (not pre-approved), the swarm card too", () => {
    for (const name of ["swarm", "swarm-skill"]) {
      expect(cardsOf(name)[0].column).toBe("ready");
      expect([undefined, "flow"]).toContain(cardsOf(name)[0].track);
    }
  });
  it("every held-out file is copied into tests/", () => {
    for (const t of suite().tasks) for (const h of t.heldOut || []) expect(dirname(h.to)).toBe("tests");
  });
});

describe("a prepared ts-orders fixture carries the board and the seeded lessons", () => {
  async function prepare(scenario) {
    const fx = await inLib("prepareFixture", { scenario, fixture: "ts-orders", tempPrefix: PREFIX });
    tempDirs.push(fx.dir);
    return fx;
  }
  const readBoard = (dir) => JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));

  it.skipIf(!built)("a prepared ts-orders board has the scenario's cards plus a Done and a Backlog card", async () => {
    const bg = suite().rehearsal.background;
    for (const name of ["hand", "flow", "auto", "parallel", "swarm", "swarm-skill", "start-feature"]) {
      const fx = await prepare(name);
      const board = readBoard(fx.dir);
      for (const c of cardsOf(name)) {
        const on = board.cards.find((b) => b.id === c.id);
        expect(on, `${name}: card ${c.id}`).toBeTruthy();
        expect([on.column, on.size, on.component, on.class], `${name}/${c.id}`).toEqual([c.column, c.size, c.component, c.class]);
        expect(on.track ?? undefined, `${name}/${c.id} track`).toBe(c.track ?? undefined);
        expect(on.goal, `${name}/${c.id} goal`).toBeTruthy();
      }
      expect(board.cards.some((c) => c.column === "done"), `${name}: a Done card`).toBe(true);
      expect(board.cards.some((c) => c.column === "backlog"), `${name}: a Backlog card`).toBe(true);
      for (const b of bg) expect(board.cards.map((c) => c.id), `${name}: background ${b.id}`).toContain(b.id);
      expect((await git(fx.dir, "log", "--oneline")).split("\n").filter(Boolean), name).toHaveLength(1);
      expect(await git(fx.dir, "status", "--porcelain"), `${name}: clean tree`).toBe("");
    }
  });
  it.skipIf(!built)("a prepared ts-orders fixture's store holds every seeded lesson, and recall finds the one the memory scenario names", async () => {
    const fx = await prepare("memory");
    const r = await run(process.execPath, [MEMORY_MJS, "lessons", "--json", fx.dir], { env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    const stored = JSON.parse(r.stdout).map((l) => l.text);
    for (const l of suite().rehearsal.lessons) expect(stored, l.text).toContain(l.text);
    const res = await inLib("assertRecalled", fx.dir, { query: suite().rehearsal.memory.recallQuery, expectText: suite().rehearsal.memory.expectText });
    expect(res.ok, res.message).toBe(true);
  });
  it.skipIf(!built)("the parallel ts-orders fixture has workers.max 2 in .doug/config.json, and the other scenarios do not set it", async () => {
    const par = await prepare("parallel");
    expect(par.fixture).toBe("ts-orders");
    expect(readBoard(par.dir).cards.map((c) => c.id)).toEqual(expect.arrayContaining(cardsOf("parallel").map((c) => c.id)));
    expect(JSON.parse(readFileSync(join(par.dir, ".doug/config.json"), "utf8")).workers.max).toBe(2);
    const hand = await prepare("hand");
    expect(JSON.parse(readFileSync(join(hand.dir, ".doug/config.json"), "utf8")).workers?.max).not.toBe(2);
  });
  it.skipIf(!built)("the swarm ts-orders fixture installs an approved swarm plan for its card; swarm-skill installs none; the others none", async () => {
    const swarm = await prepare("swarm");
    const plan = JSON.parse(readFileSync(join(swarm.dir, ".doug/plan.json"), "utf8"));
    expect([plan.status, plan.swarm, plan.card]).toEqual(["approved", true, cardsOf("swarm")[0].id]);
    const split = suite().tasks.find((t) => t.id === "split-commerce-helpers");
    expect(plan.tasks, "installed plan tasks equal the suite's").toEqual(split.plan.tasks);
    expect(plan.tasks[0].spec).toContain("20% off from 50 units");
    for (const name of ["swarm-skill", "hand", "flow"]) {
      const fx = await prepare(name);
      expect(existsSync(join(fx.dir, ".doug/plan.json")), name).toBe(false);
    }
  });
});

describe("a ts-orders task whose prompt points at .doug/plan.json carries its numbered requirements in the plan spec", () => {
  const norm = (x) => x.replace(/\s+/g, " ").trim();
  it("states each numbered prompt part in the task's plan spec, since the session sees the plan and not the prompt", () => {
    const tasks = suite().tasks.filter((t) => t.prompt.includes(".doug/plan.json"));
    expect(tasks.map((t) => t.id)).toContain("split-commerce-helpers");
    for (const t of tasks) {
      const parts = t.prompt.split(/\(\d+\)\s+/).slice(1);
      if (t.id === "split-commerce-helpers") expect(parts.length, t.id).toBeGreaterThanOrEqual(3);
      const last = parts.length - 1;
      if (last >= 0) parts[last] = parts[last].split(" Add tests")[0];
      const spec = norm(t.plan.tasks.map((x) => x.spec).join(" "));
      parts.forEach((part, i) => {
        expect(spec, `task ${t.id} part (${i + 1}) missing from the plan spec: ${norm(part)}`).toContain(norm(part));
      });
    }
  });
});
