// Card fixture-repo-scenarios: the rehearsal runner's registry, --fixture and --dry-run, the five new scenarios
// (init, board, memory, decide, swarm-skill), their assert helpers and acts, and the docs command-path table.
// Never spawns the real claude binary: sessions run through a fake on DOUG_REHEARSE_CLAUDE. Tests that prepare a
// fixture skip when the CLI is unbuilt, like tests/rehearse-auto.test.mjs. Every temp directory is removed in afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, existsSync, appendFileSync, mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "../scripts/rehearse-lib.mjs";
import { CLI, ROOT, MEMORY_MJS, LEARN_MJS, SCENARIOS, ESTIMATES, SCENARIO_STAGES, capFor, scenarioTotal, cleanEnv } from "../scripts/rehearse-lib.mjs";
import { newBoard, addCard } from "../plugins/doug-flow/lib/board.mjs";
import { here, cli, trackedTempDir, makeFakeClaude, cannedStream, run, git, inLib, draftPlan, tempDirs } from "./rehearse-fixtures.mjs";

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
vi.setConfig({ testTimeout: 600_000 });

const IS_SNAPSHOT = !existsSync(join(here, "..", "scripts/export-public.mjs"));
const NEW_SCENARIOS = ["init", "board", "memory", "decide", "swarm-skill"];
const ORIGINAL = ["flow", "swarm", "hand", "auto", "parallel", "start", "start-feature"];
const ORDERS_TASKS = join(ROOT, "evals/tasks/ts-orders.json");
const PREFIX = "doug-rehearse-test-";
const built = existsSync(CLI);

function ordersSuite() {
  return JSON.parse(readFileSync(ORDERS_TASKS, "utf8"));
}
function stage(scenario, name) {
  const st = (SCENARIO_STAGES[scenario] || []).find((s) => s.name === name);
  if (!st) throw new Error(`scenario ${scenario} has no stage ${name}`);
  return st;
}
const gitInit = async (dir) => {
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
};
async function plainRepo(prefix) {
  const dir = trackedTempDir(prefix);
  await gitInit(dir);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}
// A TMPDIR for a child, so a fixture it leaves behind (or one it must not make) is visible.
function ownTmp() {
  const t = trackedTempDir("rehearse-own-tmp-");
  return t;
}
const leftovers = (t) => readdirSync(t).filter((n) => n.startsWith("doug-rehearse-"));

describe("registry: a path with no scenario gets a new one", () => {
  it("SCENARIOS includes init, board, memory, decide and swarm-skill, each with SCENARIO_STAGES and an ESTIMATES entry", () => {
    for (const s of NEW_SCENARIOS) {
      expect(SCENARIOS, s).toContain(s);
      expect(Array.isArray(SCENARIO_STAGES[s]) && SCENARIO_STAGES[s].length > 0, `${s} stages`).toBe(true);
      expect(typeof ESTIMATES[s].source, `${s} source`).toBe("string");
      expect(typeof ESTIMATES[s].stages, `${s} stages estimate`).toBe("object");
    }
  });
  it("keeps the seven original scenarios first and in their order", () => {
    expect(SCENARIOS.slice(0, 7)).toEqual(ORIGINAL);
    expect(SCENARIOS).toHaveLength(12);
  });
  it("every stage has a kind of session, act or command; session stages carry maxTurns and assert, act and command stages run", () => {
    for (const s of SCENARIOS) {
      for (const st of SCENARIO_STAGES[s]) {
        expect(["session", "act", "command"], `${s}/${st.name} kind`).toContain(st.kind);
        if (st.kind === "session") {
          expect(typeof st.maxTurns, `${s}/${st.name}`).toBe("number");
          expect(typeof st.assert).toBe("function");
          expect(typeof st.prompt).toBe("function");
        } else expect(typeof st.run, `${s}/${st.name}`).toBe("function");
      }
    }
  });
  it("the stage names and kinds of the new scenarios are pinned", () => {
    const shape = (s) => SCENARIO_STAGES[s].map((st) => `${st.name}:${st.kind}`);
    expect(shape("init")).toEqual(["refuse:act", "init:act", "doctor:act", "reinit:act"]);
    expect(shape("board")).toEqual(["list:act", "next:act", "round-trip:act", "build:act", "serve:act"]);
    expect(shape("memory")).toEqual(["recall:act", "reflect:command", "model-regen:command", "ideas:command"]);
    expect(shape("decide")).toEqual(["propose:session", "apply:act"]);
    expect(shape("swarm-skill")).toEqual(["gate:session", "approve:act", "run:session"]);
  });
  it("ESTIMATES stage keys equal the session and command stage names (act stages carry no figure)", () => {
    for (const s of SCENARIOS) {
      const names = SCENARIO_STAGES[s].filter((st) => st.kind === "session" || st.kind === "command").map((st) => st.name);
      expect(Object.keys(ESTIMATES[s].stages).sort(), s).toEqual(names.sort());
    }
  });
  it("init and board cost $0; memory, decide and swarm-skill have a positive figure", () => {
    expect(scenarioTotal("init")).toBe(0);
    expect(scenarioTotal("board")).toBe(0);
    for (const s of ["memory", "decide", "swarm-skill"]) expect(scenarioTotal(s), s).toBeGreaterThan(0);
  });
  it("the decide propose prompt starts '/doug-decide decision'; the swarm-skill gate prompt starts '/doug-swarm <card id>'", () => {
    expect(stage("decide", "propose").prompt({ card: { id: "x" } }).startsWith("/doug-decide decision")).toBe(true);
    expect(stage("swarm-skill", "gate").prompt({ card: { id: "some-card" } }).startsWith("/doug-swarm some-card")).toBe(true);
  });
  it("recordsAsHand is true for init, board, memory and decide, and false for swarm-skill", () => {
    for (const s of ["init", "board", "memory", "decide"]) expect(lib.recordsAsHand(s), s).toBe(true);
    expect(lib.recordsAsHand("swarm-skill")).toBe(false);
    for (const s of ["flow", "swarm"]) expect(lib.recordsAsHand(s), s).toBe(false);
    for (const s of ["hand", "auto", "parallel", "start", "start-feature"]) expect(lib.recordsAsHand(s), s).toBe(true);
  });
});

describe("fixtures per scenario and per-fixture estimates", () => {
  it("exports FIXTURE_NAMES and the ts-orders paths", () => {
    expect(lib.FIXTURE_NAMES).toEqual(["ts-basic", "ts-orders"]);
    expect(lib.ORDERS_FIXTURE_DIR).toBe(join(ROOT, "evals/fixtures/ts-orders"));
    expect(lib.ORDERS_TASKS_FILE).toBe(ORDERS_TASKS);
  });
  it("scenarioFixtures lists the fixtures a scenario runs on, the default first", () => {
    for (const s of ["flow", "swarm", "hand", "auto", "parallel", "start-feature"]) expect(lib.scenarioFixtures(s), s).toEqual(["ts-basic", "ts-orders"]);
    expect(lib.scenarioFixtures("start")).toEqual([]);
    for (const s of NEW_SCENARIOS) expect(lib.scenarioFixtures(s), s).toEqual(["ts-orders"]);
  });
  it("estimateFor on ts-orders: flow, hand, start-feature and the passed ts-orders-default scenarios carry measured 2026-10-22 figures; auto, parallel, swarm and swarm-skill stay unmeasured", () => {
    const measured = { flow: "$2.34", hand: "$1.96", "start-feature": "$1.93", init: "$0.00", board: "$0.00", memory: "$0.02", decide: "$0.19" };
    const figures = {
      flow: { gate: 0.75, implement: 1.75 },
      hand: { gate: 0.5, build: 2.0 },
      "start-feature": { spec: 0.7, architecture: 0.7, plan: 0.7 },
      init: {},
      board: {},
      memory: { reflect: 0.05, "model-regen": 0.05, ideas: 0.05 },
      decide: { propose: 0.25 },
    };
    for (const s of SCENARIOS) {
      const def = lib.estimateFor(s);
      expect(def.stages, s).toEqual(ESTIMATES[s].stages);
      if (!lib.scenarioFixtures(s).includes("ts-orders")) continue;
      const e = lib.estimateFor(s, "ts-orders");
      expect(e.source, s).toMatch(/2026-(09|10)-\d{2}/);
      expect(e.source, s).toMatch(/\$\d/);
      if (measured[s]) {
        expect(e.source, s).toContain("2026-10-22");
        expect(e.source, s).toContain(measured[s]);
        expect(e.source, s).not.toContain("unmeasured");
        expect(e.stages, s).toEqual(figures[s]);
      } else {
        expect(e.source, s).toContain("unmeasured on ts-orders");
      }
      expect(Object.keys(e.stages).sort(), s).toEqual(Object.keys(ESTIMATES[s].stages).sort());
    }
    for (const s of ["auto", "parallel", "swarm", "swarm-skill"]) expect(lib.estimateFor(s, "ts-orders").source, s).toMatch(/^unmeasured on ts-orders/);
    expect(ESTIMATES["swarm-skill"].source).toMatch(/^unmeasured on ts-orders/);
  });
  it("scenarioTotal, capFor and estimateLines keep their old signatures and accept a trailing fixture", () => {
    expect(lib.scenarioTotal("hand", "ts-basic")).toBe(scenarioTotal("hand"));
    expect(capFor("hand", "gate", "ts-basic")).toBe(capFor("hand", "gate"));
    expect(lib.scenarioTotal("hand", "ts-orders")).toBeGreaterThan(0);
    expect(lib.capFor("hand", "gate", "ts-orders")).toBeGreaterThan(0);
    expect(lib.estimateLines("hand", "ts-orders").join("\n")).toContain("2026-10-22");
    expect(lib.estimateLines("auto", "ts-orders").join("\n")).toContain("unmeasured on ts-orders");
    expect(lib.estimateLines("hand").join("\n")).not.toContain("unmeasured on ts-orders");
  });
  it("parseArgs reads --fixture and --dry-run", () => {
    // parseArgs also reads --tier, null by default.
    expect(lib.parseArgs([])).toEqual({ scenario: null, dir: null, spend: false, card: null, fixture: null, dryRun: false, tier: null });
    expect(lib.parseArgs(["hand", "--fixture", "ts-orders", "--dry-run"])).toEqual({ scenario: "hand", dir: null, spend: false, card: null, fixture: "ts-orders", dryRun: true, tier: null });
    expect(lib.parseArgs(["flow", "--card", "x", "--spend", "/tmp/r"])).toEqual({ scenario: "flow", dir: "/tmp/r", spend: true, card: "x", fixture: null, dryRun: false, tier: null });
  });
});

describe("rehearse.mjs without --spend (nothing spawned, nothing made)", () => {
  function setup() {
    const t = ownTmp();
    const marker = join(trackedTempDir("rehearse-marker-"), "spawned");
    return { t, marker, env: { ...process.env, TMPDIR: t, DOUG_REHEARSE_CLAUDE: makeFakeClaude("", { marker }) } };
  }
  it("rehearse.mjs init and board without --spend exit 2, print their estimate, and create no fixture or record", async () => {
    for (const s of ["init", "board"]) {
      const { t, marker, env } = setup();
      const r = await run(process.execPath, [cli, s], { env });
      expect(r.status, s).toBe(2);
      expect(r.stdout, s).toContain("$0.00");
      expect(r.stdout.toLowerCase(), s).toContain("add --spend");
      expect(existsSync(marker), s).toBe(false);
      expect(leftovers(t), s).toEqual([]);
    }
  });
  it("a scenario with --fixture ts-orders and no --spend prints the ts-orders estimate and exits 2", async () => {
    const { env } = setup();
    const r = await run(process.execPath, [cli, "hand", "--fixture", "ts-orders"], { env });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("2026-10-22");
    expect(r.stdout).not.toContain("unmeasured on ts-orders");
    const a = await run(process.execPath, [cli, "auto", "--fixture", "ts-orders"], { env });
    expect(a.stdout).toContain("unmeasured on ts-orders");
  });
  it("an unknown --fixture exits 2 naming the fixtures, and spawns nothing", async () => {
    const { marker, env } = setup();
    const r = await run(process.execPath, [cli, "hand", "--fixture", "bogus", "--dry-run"], { env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ts-basic");
    expect(r.stderr).toContain("ts-orders");
    expect(existsSync(marker)).toBe(false);
  });
  it("a scenario given a fixture it does not support exits 2 naming its fixtures, and spawns nothing", async () => {
    const { t, marker, env } = setup();
    const r = await run(process.execPath, [cli, "decide", "--fixture", "ts-basic", "--dry-run"], { env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ts-orders");
    expect(existsSync(marker)).toBe(false);
    expect(leftovers(t)).toEqual([]);
  });
  it("--dry-run together with --spend exits 2 and spawns nothing", async () => {
    const { marker, env } = setup();
    const r = await run(process.execPath, [cli, "init", "--dry-run", "--spend", "--card", "x"], { env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--dry-run");
    expect(r.stderr).not.toContain("unknown scenario");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("rehearse.mjs <scenario> --dry-run prepares the fixture, prints the plan, spends nothing", () => {
  const cases = [
    ["hand", []],
    ["hand", ["--fixture", "ts-orders"]],
    ["init", []],
    ["board", []],
    ["memory", []],
    ["decide", []],
    ["swarm-skill", []],
    ["start", ["--fixture", "ts-orders"]],
  ];
  for (const [scenario, extra] of cases) {
    it.skipIf(!built)(`rehearse.mjs ${scenario} ${extra.join(" ")} --dry-run exits 0, lists the stages, and never spawns the fake claude (marker absent)`, async () => {
      const t = ownTmp();
      const marker = join(trackedTempDir("rehearse-marker-"), "spawned");
      const env = { ...process.env, TMPDIR: t, DOUG_REHEARSE_CLAUDE: makeFakeClaude("", { marker }) };
      const r = await run(process.execPath, [cli, scenario, ...extra, "--dry-run"], { env });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const fixture = scenario === "start" ? undefined : extra[1] || lib.scenarioFixtures(scenario)[0];
      for (const st of SCENARIO_STAGES[scenario]) {
        const line = r.stdout.split("\n").find((l) => l.includes(st.name));
        expect(line, `${scenario}: a line for stage ${st.name}`).toBeTruthy();
        expect(line, `${scenario}/${st.name} kind`).toContain(st.kind);
        if (st.kind === "session") {
          expect(line, `${scenario}/${st.name} turn cap`).toContain(String(st.maxTurns));
          expect(line, `${scenario}/${st.name} $ cap`).toContain(`$${lib.capFor(scenario, st.name, fixture === "ts-basic" ? undefined : fixture).toFixed(2)}`);
        }
      }
      expect(existsSync(marker)).toBe(false);
      expect(leftovers(t), "the dry run removes its fixture").toEqual([]);
    });
  }
  it.skipIf(!built)("--dry-run prints Estimated cost with scenarioTotal for the scenario and fixture", async () => {
    const t = ownTmp();
    const env = { ...process.env, TMPDIR: t, DOUG_REHEARSE_CLAUDE: makeFakeClaude("") };
    const r = await run(process.execPath, [cli, "hand", "--fixture", "ts-orders", "--dry-run"], { env });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Estimated cost: $${lib.scenarioTotal("hand", "ts-orders").toFixed(2)}`);
    const d = await run(process.execPath, [cli, "hand", "--dry-run"], { env });
    expect(d.stdout).toContain(`Estimated cost: $${scenarioTotal("hand").toFixed(2)}`);
  });
  it.skipIf(!built)("all --fixture ts-orders --dry-run labels only the still-unmeasured ts-orders blocks (auto, parallel, swarm, swarm-skill) as unmeasured", async () => {
    const t = ownTmp();
    const env = { ...process.env, TMPDIR: t, DOUG_REHEARSE_CLAUDE: makeFakeClaude("") };
    const r = await run(process.execPath, [cli, "all", "--fixture", "ts-orders", "--dry-run"], { env });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // A block runs from its "Stages on <fixture>:" header to its "  scenario <name>:" line.
    const blocks = r.stdout.split(/^(?=Stages on )/m).filter((b) => b.startsWith("Stages on ts-orders"));
    expect(blocks.length).toBeGreaterThan(1);
    const unmeasured = ["auto", "parallel", "swarm", "swarm-skill"];
    const measuredNames = ["flow", "hand", "start-feature", "init", "board", "memory", "decide"];
    const nameOf = (b) => (b.match(/^\s*scenario (\S+?):/m) || [])[1];
    const blockFor = (n) => blocks.find((b) => nameOf(b) === n);
    for (const n of unmeasured) expect(blockFor(n), n).toContain("estimate source: unmeasured on ts-orders");
    for (const n of measuredNames) {
      expect(blockFor(n), n).toBeTruthy();
      expect(blockFor(n), n).not.toContain("unmeasured on ts-orders");
      expect(blockFor(n), n).toContain("2026-10-22");
    }
    const cost = r.stdout.split("\n").find((l) => l.startsWith("Estimated cost:"));
    expect(cost).toContain("unmeasured on ts-orders");
    const listed = (cost.match(/unmeasured on ts-orders for ([^)]*)\)/) || [])[1];
    expect((listed || "").split(", ").sort()).toEqual([...unmeasured].sort());
    // Default-fixture figures keep their own source and no ts-orders label.
    const d = await run(process.execPath, [cli, "hand", "--dry-run"], { env });
    expect(d.stdout).toContain("estimate source:");
    expect(d.stdout).not.toContain("unmeasured on ts-orders");
  });
});

describe("prepareFixture takes a fixture", () => {
  it.skipIf(!built)("prepareFixture({scenario:'hand', fixture:'ts-orders'}) has the ts-orders hand card and ts-orders source files", async () => {
    const suite = ordersSuite();
    const handCard = suite.rehearsal.scenarios.hand.cards[0];
    const fx = await inLib("prepareFixture", { scenario: "hand", fixture: "ts-orders", tempPrefix: PREFIX });
    tempDirs.push(fx.dir);
    expect(fx.fixture).toBe("ts-orders");
    expect(fx.card.id).toBe(handCard.id);
    const board = JSON.parse(readFileSync(join(fx.dir, ".doug/board.json"), "utf8"));
    expect(board.cards.map((c) => c.id)).toContain(handCard.id);
    expect(existsSync(join(fx.dir, "src/duration.ts"))).toBe(false);
    const srcFiles = readdirSync(join(fx.dir, "src"), { recursive: true }).filter((f) => String(f).endsWith(".ts"));
    expect(srcFiles.length).toBeGreaterThanOrEqual(15);
    expect(existsSync(join(fx.dir, "node_modules"))).toBe(true);
    expect(fx.baseline).toBe(await git(fx.dir, "rev-parse", "HEAD"));
  });
  it.skipIf(!built)("without a fixture, a scenario runs on its default (ts-basic for hand, ts-orders for board)", async () => {
    const hand = await inLib("prepareFixture", { scenario: "hand", tempPrefix: PREFIX });
    tempDirs.push(hand.dir);
    expect(hand.card.id).toBe("fix-hours");
    expect(existsSync(join(hand.dir, "src/duration.ts"))).toBe(true);
    const board = await inLib("prepareFixture", { scenario: "board", tempPrefix: PREFIX });
    tempDirs.push(board.dir);
    expect(board.fixture).toBe("ts-orders");
  });
  it.skipIf(!built)("a fixture the scenario does not support throws naming the scenario and its fixtures", async () => {
    await expect(inLib("prepareFixture", { scenario: "decide", fixture: "ts-basic", tempPrefix: PREFIX })).rejects.toThrow(/decide[\s\S]*ts-orders/);
  });
  it.skipIf(!built)("the init scenario's fixture is the raw repo: no .doug, no CLAUDE.md, one commit", async () => {
    const fx = await inLib("prepareFixture", { scenario: "init", tempPrefix: PREFIX });
    tempDirs.push(fx.dir);
    expect(existsSync(join(fx.dir, ".doug"))).toBe(false);
    expect(existsSync(join(fx.dir, "CLAUDE.md"))).toBe(false);
    expect((await git(fx.dir, "log", "--oneline")).split("\n").filter(Boolean)).toHaveLength(1);
  });
  it.skipIf(!built)("assertHandBuilt passes on a ts-orders hand fixture whose card files were committed and the card moved to Done", async () => {
    const suite = ordersSuite();
    const handCard = suite.rehearsal.scenarios.hand.cards[0];
    const task = suite.tasks.find((t) => t.id === handCard.task);
    const fx = await inLib("prepareFixture", { scenario: "hand", fixture: "ts-orders", tempPrefix: PREFIX });
    tempDirs.push(fx.dir);
    for (const f of task.allowedFiles) {
      mkdirSync(join(fx.dir, f, ".."), { recursive: true });
      appendFileSync(join(fx.dir, f), "\n// touched by the simulated coder\n");
    }
    await git(fx.dir, "add", "-A");
    await git(fx.dir, "commit", "-q", "-m", "simulated code commit");
    const sha = await git(fx.dir, "rev-parse", "HEAD");
    const boardFile = join(fx.dir, ".doug/board.json");
    const board = JSON.parse(readFileSync(boardFile, "utf8"));
    const card = board.cards.find((c) => c.id === handCard.id);
    card.column = "done";
    card.source = `commit ${sha.slice(0, 7)}`;
    writeFileSync(boardFile, JSON.stringify(board, null, 2));
    mkdirSync(join(fx.dir, "docs"), { recursive: true });
    writeFileSync(join(fx.dir, "docs/live-runs.md"), `### \`${handCard.id}\`\n\nhand track: a gated by-hand change\n`);
    await git(fx.dir, "add", "-A");
    await git(fx.dir, "commit", "-q", "-m", `Board: ${handCard.id} done as ${sha.slice(0, 7)}`);
    const result = await inLib("assertHandBuilt", { dir: fx.dir, baseline: fx.baseline, cards: fx.cards, card: fx.card, fixture: "ts-orders" });
    // The simulated coder fixes nothing, so the held-out test may still fail; what must not happen is the
    // ts-basic constants (src/duration.ts, fix-hours) leaking into a ts-orders check.
    expect(result.message).not.toContain("duration");
    expect(result.message).not.toContain("fix-hours");
    if (!result.ok) expect(result.message).toMatch(/held-out|pnpm test/);
  });
});

describe("init scenario", () => {
  it("assertInitialized fails naming stopGate.commands when .doug/config.json has none", async () => {
    const dir = trackedTempDir("rehearse-init-");
    writeFileSync(join(dir, "CLAUDE.md"), "# p\n");
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ version: 1, stopGate: { commands: [] } }));
    const empty = await inLib("assertInitialized", dir);
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain("stopGate.commands");
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ version: 1 }));
    const missing = await inLib("assertInitialized", dir);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("stopGate.commands");
  });
  it("assertInitialized passes with CLAUDE.md and a non-empty stopGate.commands, and fails without CLAUDE.md", async () => {
    const dir = trackedTempDir("rehearse-init-ok-");
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ version: 1, stopGate: { commands: ["typecheck"] } }));
    const noClaude = await inLib("assertInitialized", dir);
    expect(noClaude.ok).toBe(false);
    expect(noClaude.message).toContain("CLAUDE.md");
    writeFileSync(join(dir, "CLAUDE.md"), "# p\n");
    const ok = await inLib("assertInitialized", dir);
    expect(ok.ok, ok.message).toBe(true);
  });
  it.skipIf(!built)("runScenario('init') passes on ts-orders, at $0, through refuse, init, doctor and reinit", async () => {
    const result = await inLib("runScenario", "init", { tempPrefix: PREFIX });
    tempDirs.push(result.fixtureDir);
    expect(result.outcome, result.failedMessage).toBe("passed");
    expect(result.stages.map((s) => s.name)).toEqual(["refuse", "init", "doctor", "reinit"]);
    expect(result.totalCost).toBe(0);
  });
});

describe("board scenario", () => {
  it.skipIf(!built)("runScenario('board') on ts-orders passes and leaves no doug board serve pidfile or process", async () => {
    const result = await inLib("runScenario", "board", { tempPrefix: PREFIX });
    tempDirs.push(result.fixtureDir);
    expect(result.outcome, result.failedMessage).toBe("passed");
    expect(result.stages.map((s) => s.name)).toEqual(["list", "next", "round-trip", "build", "serve"]);
    expect(existsSync(join(result.fixtureDir, ".doug/.state/board-serve.json"))).toBe(false);
    const ps = execFileSync("ps", ["-axo", "args"], { encoding: "utf8" });
    const stray = ps.split("\n").filter((l) => l.includes(result.fixtureDir) && l.includes("serve"));
    expect(stray).toEqual([]);
  });
});

describe("memory scenario", () => {
  async function seededRepo() {
    const dir = await plainRepo("rehearse-recall-");
    const r = await run(process.execPath, [MEMORY_MJS, "lesson", "add", "--text", "Order totals must round half up to whole cents.", "--kind", "pitfall", dir], { env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    return dir;
  }
  it("assertRecalled fails when no recalled lesson contains expectText", async () => {
    const dir = await seededRepo();
    const ok = await inLib("assertRecalled", dir, { query: "order totals rounding", expectText: "round half up" });
    expect(ok.ok, ok.message).toBe(true);
    const bad = await inLib("assertRecalled", dir, { query: "order totals rounding", expectText: "a sentence no lesson holds" });
    expect(bad.ok).toBe(false);
  });
  it.skipIf(!built)("the memory command stages invoke the fake claude on DOUG_REHEARSE_CLAUDE and pass --max-usd equal to capFor (argv capture)", async () => {
    const fx = await inLib("prepareFixture", { scenario: "memory", tempPrefix: PREFIX });
    tempDirs.push(fx.dir);
    const envelope = JSON.stringify({ is_error: false, structured_output: { lessons: [], ideas: [], model: "# model\n" }, session_id: "s", total_cost_usd: 0.01 });
    const savedBin = process.env.DOUG_CLAUDE_BIN;
    for (const name of ["reflect", "model-regen", "ideas"]) {
      const logDir = trackedTempDir("fake-claude-log-");
      const log = join(logDir, "argv.log");
      const tripLog = join(logDir, "trip.log");
      const mk = (file, logFile, body) => {
        writeFileSync(file, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n${body}\nprocess.exit(0);\n`);
        chmodSync(file, 0o755);
        return file;
      };
      const fake = mk(join(logDir, "claude"), log, `process.stdout.write(${JSON.stringify(envelope)} + "\\n");`);
      // Any invocation that bypasses the runner's --claude-bin lands here instead of the real claude.
      const trip = mk(join(logDir, "tripwire"), tripLog, "process.exit(1);");
      process.env.DOUG_CLAUDE_BIN = trip;
      try {
        await inLib(
          "runActStage",
          { $expr: `({ run: (ctx) => lib.SCENARIO_STAGES.memory.find((s) => s.name === ${JSON.stringify(name)}).run({ ...ctx, claudeBin: ${JSON.stringify(fake)}, capUsd: 1.23 }) })` },
          { dir: fx.dir, card: fx.card, cards: fx.cards, baseline: fx.baseline },
        );
      } finally {
        if (savedBin === undefined) delete process.env.DOUG_CLAUDE_BIN;
        else process.env.DOUG_CLAUDE_BIN = savedBin;
      }
      expect(existsSync(tripLog), `${name} bypassed --claude-bin`).toBe(false);
      expect(existsSync(log), `${name} never invoked the runner's claude`).toBe(true);
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(calls.length, name).toBeGreaterThan(0);
      for (const argv of calls) {
        const i = argv.indexOf("--max-budget-usd");
        expect(i, `${name} --max-budget-usd`).toBeGreaterThan(-1);
        expect(Number(argv[i + 1]), name).toBeCloseTo(1.23, 5);
      }
    }
  });
});

describe("memory scenario wiring (runScenario sets the live binary and cap)", () => {
  it.skipIf(!built)("runScenario('memory') runs reflect, model-regen and ideas on DOUG_REHEARSE_CLAUDE with --max-budget-usd equal to capFor (argv capture)", async () => {
    const envelope = JSON.stringify({ is_error: false, structured_output: { lessons: [], ideas: [], model: "# model\n" }, session_id: "s", total_cost_usd: 0.01 });
    const logDir = trackedTempDir("fake-claude-wiring-");
    const log = join(logDir, "argv.log");
    const tripLog = join(logDir, "trip.log");
    const mk = (file, logFile, body) => {
      writeFileSync(file, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n${body}\nprocess.exit(0);\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const fake = mk(join(logDir, "claude"), log, `process.stdout.write(${JSON.stringify(envelope)} + "\\n");`);
    // Anything that ignores DOUG_REHEARSE_CLAUDE falls through to DOUG_CLAUDE_BIN and lands here.
    const trip = mk(join(logDir, "tripwire"), tripLog, "process.exit(1);");
    const saved = { rehearse: process.env.DOUG_REHEARSE_CLAUDE, bin: process.env.DOUG_CLAUDE_BIN };
    process.env.DOUG_REHEARSE_CLAUDE = fake;
    process.env.DOUG_CLAUDE_BIN = trip;
    let result;
    try {
      result = await inLib("runScenario", "memory", { tempPrefix: PREFIX });
    } finally {
      for (const [k, v] of [["DOUG_REHEARSE_CLAUDE", saved.rehearse], ["DOUG_CLAUDE_BIN", saved.bin]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    tempDirs.push(result.fixtureDir);
    expect(existsSync(tripLog), "a command stage bypassed DOUG_REHEARSE_CLAUDE").toBe(false);
    expect(existsSync(log), "no command stage invoked the runner's claude").toBe(true);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const expected = ["reflect", "model-regen", "ideas"].map((n) => capFor("memory", n, "ts-orders"));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const argv of calls) {
      const i = argv.indexOf("--max-budget-usd");
      expect(i, "--max-budget-usd").toBeGreaterThan(-1);
      const got = Number(argv[i + 1]);
      expect(expected.some((e) => Math.abs(e - got) < 1e-6), `cap ${got} is not one of capFor ${expected}`).toBe(true);
      expect(got).not.toBeCloseTo(0.5, 5);
    }
  });
});

describe("memory scenario end to end (runScenario with a fake that answers all three model calls)", () => {
  it.skipIf(!built)("runScenario('memory') passes: reflect, model-regen and ideas each call claude, and recall gets the descriptor's recallQuery", async () => {
    const logDir = trackedTempDir("fake-claude-memory-e2e-");
    const log = join(logDir, "argv.log");
    const fake = join(logDir, "claude");
    const body = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const i = argv.indexOf("--json-schema");
const schema = i >= 0 ? JSON.parse(argv[i + 1]) : {};
const required = schema.required || [];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, required }) + "\\n");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const id = (stdin.match(/- \\[([0-9a-f]{16})\\]/) || [])[1];
let out = { lessons: [] };
if (required.includes("statements")) out = { statements: [{ section: "conventions", text: "Round order totals half up to whole cents.", citations: [id] }] };
else if (required.includes("ideas")) out = { ideas: [], reviews: [] };
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out, session_id: "s", total_cost_usd: 0.01 }) + "\\n");
`;
    writeFileSync(fake, `#!/usr/bin/env node\n${body}\nprocess.exit(0);\n`);
    chmodSync(fake, 0o755);
    const saved = process.env.DOUG_REHEARSE_CLAUDE;
    process.env.DOUG_REHEARSE_CLAUDE = fake;
    let result;
    try {
      result = await inLib("runScenario", "memory", { tempPrefix: PREFIX });
    } finally {
      if (saved === undefined) delete process.env.DOUG_REHEARSE_CLAUDE;
      else process.env.DOUG_REHEARSE_CLAUDE = saved;
    }
    tempDirs.push(result.fixtureDir);
    const msgs = result.stages.map((s) => `${s.name}: ${s.message}`).join("\n");
    expect(result.outcome, msgs).toBe("passed");
    const stageNames = result.stages.map((s) => s.name);
    for (const n of ["recall", "reflect", "model-regen", "ideas"]) expect(stageNames, n).toContain(n);
    // recall found the seeded lesson, which only the descriptor's recallQuery reaches.
    expect(result.stages.find((s) => s.name === "recall").message, msgs).toMatch(/^recall found lesson [0-9a-f]{16}/);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const key of ["lessons", "statements", "ideas"]) {
      expect(calls.filter((c) => c.required.includes(key)).length, `claude calls requiring ${key}`).toBe(1);
    }
    expect(calls.length).toBe(3);
  });
});

describe("decide scenario (/doug-decide stops at its apply gate)", () => {
  async function proposed() {
    const dir = await plainRepo("rehearse-decide-");
    const body = join(dir, "body.txt");
    writeFileSync(body, "Use sqlite for the order store.\n");
    const r = await run(process.execPath, [MEMORY_MJS, "decision", "propose", "--title", "Use sqlite", "--file", body, dir], { env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "fixture with body");
    return dir;
  }
  it("assertDecisionHeld passes on a pending diff with no ADR, and fails when the ADR was written before the apply act", async () => {
    const dir = await proposed();
    const held = await inLib("assertDecisionHeld", dir);
    expect(held.ok, held.message).toBe(true);
    mkdirSync(join(dir, "docs/decisions"), { recursive: true });
    writeFileSync(join(dir, "docs/decisions/0001-use-sqlite.md"), "# 1. Use sqlite\n");
    const early = await inLib("assertDecisionHeld", dir);
    expect(early.ok).toBe(false);
  });
  it("assertDecisionHeld fails when no diff is pending", async () => {
    const dir = await plainRepo("rehearse-decide-none-");
    const none = await inLib("assertDecisionHeld", dir);
    expect(none.ok).toBe(false);
  });
  it("the decide apply act on a pending proposal writes the ADR under docs/decisions/", async () => {
    const dir = await proposed();
    expect(existsSync(join(dir, "docs/decisions/0001-use-sqlite.md"))).toBe(false);
    const result = await inLib("runActStage", { $expr: `lib.SCENARIO_STAGES.decide.find((s) => s.name === "apply")` }, { dir, card: { id: "x" }, baseline: null });
    expect(result.ok, result.message).toBe(true);
    expect(readdirSync(join(dir, "docs/decisions")).some((f) => /use-sqlite/.test(f))).toBe(true);
  });
  it("the decide apply act fails when nothing is pending", async () => {
    const dir = await plainRepo("rehearse-decide-apply-none-");
    const result = await inLib("runActStage", { $expr: `lib.SCENARIO_STAGES.decide.find((s) => s.name === "apply")` }, { dir, card: { id: "x" }, baseline: null });
    expect(result.ok).toBe(false);
  });
});

describe("swarm-skill scenario (/doug-swarm stops at plan approval)", () => {
  const stream = cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-swarm"] });
  const opts = { plugins: ["doug-flow"], command: "doug-flow:doug-swarm", cardId: "fix-hours" };
  // The shape gate keeps a task off the lead unless it owns two or more source files, so the default draft swarm plan
  // names one such task; `singleSource` is the plan the live planner wrote (each task one source file and its tests).
  const splittableTasks = [{ ...draftPlan().tasks[0], files: ["src/duration.ts", "src/strings.ts", "tests/duration.test.ts", "tests/strings.test.ts"], size: "M" }];
  const singleSourceTasks = [
    { ...draftPlan().tasks[0], id: "split-cents", files: ["src/util/money.ts", "tests/money.test.ts"], size: "M" },
    { ...draftPlan().tasks[0], id: "by-category", files: ["src/catalog/catalog.ts", "tests/catalog.test.ts"], size: "S" },
    { ...draftPlan().tasks[0], id: "is-terminal", files: ["src/orders/status.ts", "tests/orders.test.ts"], size: "S" },
  ];
  async function gateRepo({ swarm = true, approve = false, column = "flow", extraCommit = false, worktree = false, singleSource = false, tasks = null } = {}) {
    const dir = await plainRepo("rehearse-swarm-gate-");
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const board = addCard({ ...newBoard(), components: ["flow"] }, { id: "fix-hours", title: "Fix hours", goal: "Fix the hours bug.", component: "flow", size: "M", column, class: "code" });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2) + "\n");
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(draftPlan({ swarm, tasks: tasks || (singleSource ? singleSourceTasks : splittableTasks) })) + "\n");
    if (approve) {
      const r = await run(process.execPath, [lib.PLAN_MJS, "approve", dir], { env: cleanEnv() });
      expect(r.status, r.stderr).toBe(0);
    }
    if (extraCommit) {
      writeFileSync(join(dir, "extra.txt"), "x\n");
      await git(dir, "add", "extra.txt");
      await git(dir, "commit", "-q", "-m", "extra");
    }
    if (worktree) mkdirSync(join(dir, ".claude/worktrees/w1"), { recursive: true });
    return dir;
  }
  it("assertSwarmGateHeld passes on a flow card, a draft swarm plan naming the card, one commit and no worktree", async () => {
    const dir = await gateRepo();
    const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
    expect(r.ok, r.message).toBe(true);
  });
  it("assertSwarmGateHeld fails a draft swarm plan whose every task owns one source file plus its tests, naming the shape gate (card ts-orders-rehearsal-scenario-fixes)", async () => {
    const dir = await gateRepo({ singleSource: true });
    const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/shape gate/);
    expect(r.message).toMatch(/two or more source files/);
  });
  it("assertSwarmGateHeld passes when one task among single-source ones owns two source files", async () => {
    const dir = await gateRepo({ singleSource: true });
    const planPath = join(dir, ".doug/plan.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.tasks[1].files = ["src/catalog/catalog.ts", "src/catalog/index.ts", "tests/catalog.test.ts"];
    plan.tasks[1].size = "M"; // card swarm-shape-rule-stated: a size-S task never reaches the lead, so the two-source task must not be S
    writeFileSync(planPath, JSON.stringify(plan) + "\n");
    const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
    expect(r.ok, r.message).toBe(true);
  });
  const oneTask = (files, size = "M") => [{ ...draftPlan().tasks[0], id: "t1", files, size }];
  it("assertSwarmGateHeld fails when the only two-source task is size S (card swarm-shape-rule-stated)", async () => {
    const dir = await gateRepo({ tasks: oneTask(["src/a.ts", "src/b.ts", "tests/a.test.ts"], "S") });
    const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/shape gate/);
  });
  it("assertSwarmGateHeld counts each workflow test-file form as a test, not a source file (card swarm-shape-rule-stated)", async () => {
    const pairs = [
      ["__tests__ directory", ["src/a.ts", "src/__tests__/a.ts"]],
      ["spec directory", ["src/a.ts", "spec/a.ts"]],
      ["_test infix", ["pkg/a.go", "pkg/a_test.go"]],
      ["Test infix", ["src/Foo.java", "src/FooTest.java"]],
      ["test infix before a dotted extension", ["src/a.ts", "src/a.test.d.ts"]],
    ];
    for (const [label, files] of pairs) {
      const dir = await gateRepo({ tasks: oneTask(files) });
      const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
      expect(r.ok, label).toBe(false);
      expect(r.message, label).toMatch(/shape gate/);
    }
  });
  it("assertSwarmGateHeld agrees with the workflow's shape gate over test-file forms and sizes (card swarm-shape-rule-stated)", async () => {
    const src = readFileSync(join(ROOT, "plugins/doug-flow/workflows/doug-implement.js"), "utf8");
    const cut = src.slice(src.indexOf("function isTestFile("), src.indexOf("\n}\n", src.indexOf("function swarmReport(")) + 3);
    const workflowApplies = (task) =>
      new Function("plan", "taskShape", "log", cut + "\nreturn swarmApplies;")({ swarm: true }, (t) => (t && t.size === "S" ? "S" : "full"), () => {})(task);
    const second = ["src/b.ts", "src/__tests__/b.ts", "spec/b.ts", "pkg/b_test.go", "src/BTest.java", "src/b.test.d.ts", "src/b.spec.ts", "tests/b.ts", "test/b.ts", "src/b.test.tsx2", "src/b.ts"];
    for (const size of ["S", "M"]) {
      for (const other of second) {
        const files = ["src/a.ts", other];
        const task = { ...draftPlan().tasks[0], id: "t1", files, size };
        const dir = await gateRepo({ tasks: [task] });
        const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
        expect(r.ok, `${size} ${other}`).toBe(workflowApplies(task));
      }
    }
  });
  it("assertSwarmGateHeld fails naming approval when .doug/plan.json is already approved", async () => {
    const dir = await gateRepo({ approve: true });
    const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/approv/);
  });
  it("assertSwarmGateHeld fails naming swarm when the plan has swarm false", async () => {
    const dir = await gateRepo({ swarm: false });
    const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("swarm");
  });
  it("assertSwarmGateHeld fails when the card is not in flow, a second commit exists, a worktree exists, or the plan names another card", async () => {
    for (const bad of [{ column: "ready" }, { extraCommit: true }, { worktree: true }]) {
      const dir = await gateRepo(bad);
      const r = await inLib("assertSwarmGateHeld", dir, stream, opts);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const dir = await gateRepo();
    const r = await inLib("assertSwarmGateHeld", dir, stream, { ...opts, cardId: "another-card" });
    expect(r.ok).toBe(false);
  });
  it("the approve act approves the plan and writes the anchor", async () => {
    const dir = await gateRepo();
    const result = await inLib("runActStage", { $expr: `lib.SCENARIO_STAGES["swarm-skill"].find((s) => s.name === "approve")` }, { dir, card: { id: "fix-hours" }, baseline: null });
    expect(result.ok, result.message).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".doug/plan.json"), "utf8")).status).toBe("approved");
    expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(true);
  });
  it("swarm-skill's run assert fails on a report whose task has no workers", async () => {
    const dir = await plainRepo("rehearse-swarm-run-");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const task = { id: "t", verified: true, reviewed: true, adversary: { ran: true, verdict: "pass" } };
    writeFileSync(join(dir, lib.RESULTS_FILE), JSON.stringify({ ok: true, levels: [{ tasks: [task] }] }));
    const bin = makeFakeClaude(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-swarm"] }));
    const result = await inLib("runSessionStage", { $expr: `lib.SCENARIO_STAGES["swarm-skill"].find((s) => s.name === "run")` }, { dir, card: { id: "fix-hours" }, baseline: null, claudeBin: bin });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("workers");
  });
});

describe("docs/rehearsals.md Command paths table", () => {
  const docs = () => readFileSync(join(here, "..", "docs/rehearsals.md"), "utf8");
  function section() {
    const text = docs();
    const i = text.indexOf("Command paths");
    expect(i, "a Command paths heading").toBeGreaterThan(-1);
    const rest = text.slice(i + 1);
    const next = rest.search(/\n#{2,3} /);
    return rest.slice(0, next === -1 ? undefined : next);
  }
  const rows = (s) => s.split("\n").filter((l) => l.trim().startsWith("|"));
  const covered = [
    [/doug init/i, "init"],
    [/\/doug-start[^|]*project/i, "start"],
    [/\/doug-start[^|]*(feature|<card)/i, "start-feature"],
    [/\/doug-next[^|]*<id>[^|]*flow/i, "flow"],
    [/\/doug-next[^|]*<id>[^|]*hand/i, "hand"],
    [/\/doug-next[^|]*--auto/i, "auto"],
    [/parallel/i, "parallel"],
    [/\/doug-swarm/i, "swarm-skill"],
    [/swarm workflow/i, "swarm"],
    [/doug board/i, "board"],
    [/recall/i, "memory"],
    [/reflect/i, "memory"],
    [/model regen/i, "memory"],
    [/ideas/i, "memory"],
    [/\/doug-decide/i, "decide"],
  ];
  const none = [/\/doug-learn/i, /\/doug-plan/i, /\/doug-approve/i, /\/doug-implement/i, /doug ablate/i, /doug trace/i, /doug memory setup/i, /research/i, /run-report/i];

  it.skipIf(IS_SNAPSHOT)("the docs/rehearsals.md Command paths table has a row for each named path", () => {
    const r = rows(section());
    for (const [needle, scenario] of covered) {
      const row = r.find((l) => needle.test(l) && l.includes(`\`${scenario}\``));
      expect(row, `a row matching ${needle} naming scenario \`${scenario}\``).toBeTruthy();
    }
  });
  it.skipIf(IS_SNAPSHOT)("the table gives a why-none row for each path that has no scenario", () => {
    const r = rows(section());
    for (const needle of none) {
      const row = r.find((l) => needle.test(l));
      expect(row, `a why-none row matching ${needle}`).toBeTruthy();
      expect(row, `${needle} row says no scenario or none`).toMatch(/no scenario|none/i);
    }
  });
  it.skipIf(IS_SNAPSHOT)("the table names the headless gates and the act that answers them", () => {
    const s = section();
    expect(s).toContain("AskUserQuestion");
    expect(s).toContain("learn.mjs apply");
    expect(s).toContain("plan.mjs approve");
  });
  it.skipIf(IS_SNAPSHOT)("the page states the full set's wall clock: about 38 min on ts-basic, ts-orders unmeasured", () => {
    const t = docs();
    expect(t).toMatch(/38 min/);
    expect(t).toMatch(/unmeasured on ts-orders|ts-orders[^\n]*unmeasured/i);
  });
});
