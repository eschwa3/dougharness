// The hard tier's library half (card rehearsal-harder-tier, task hard-tier-lib): the registry, the tier-aware lookups,
// the generic suite prepare, the held-out run for several files and the N-card build asserts. Everything runs on
// synthetic git repos and a temp tasks file over the ts-orders fixture; nothing reads the ts-rentals fixture or its
// tasks file, and the real claude binary is never spawned. No sync spawns (rehearse-fixtures.mjs): git goes through
// `git`, the library's spawning functions through `inLib`.
import { describe, it, expect, afterAll, vi } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import * as lib from "../scripts/rehearse-lib.mjs";
import { trackedTempDir, tempDirs, git, inLib, makeFakeClaude, cannedStream } from "./rehearse-fixtures.mjs";

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// Per-test timeout ceiling for a hung child, not a performance pin (see rehearse-fixtures.mjs).
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const built = existsSync(lib.CLI);

// ---- Synthetic repositories ------------------------------------------------------------------------------------------
// A repo whose `pnpm test` is check.mjs: it records which tests/heldout-* files were present at each run in
// .doug/seen.txt and exits 1 when one of them says FAIL. .doug/ is ignored by the clean-tree check, as in a fixture.
const CHECK = [
  'import { readdirSync, appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";',
  'mkdirSync(".doug", { recursive: true });',
  'const held = existsSync("tests") ? readdirSync("tests").filter((f) => f.startsWith("heldout-")).sort() : [];',
  'appendFileSync(".doug/seen.txt", held.join(",") + "\\n");',
  'process.exit(held.some((f) => readFileSync("tests/" + f, "utf8").includes("FAIL")) ? 1 : 0);',
  "",
].join("\n");

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

async function newRepo() {
  const dir = trackedTempDir("doug-hard-assert-");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  put(dir, "package.json", JSON.stringify({ name: "fake", private: true, scripts: { test: "node check.mjs" } }));
  put(dir, "check.mjs", CHECK);
  put(dir, ".doug/board.json", '{"cards":[]}\n');
  put(dir, "docs/live-runs.md", "");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "fixture");
  return { dir, baseline: await git(dir, "rev-parse", "HEAD") };
}

let counter = 0;
// One commit changing `files` (each gets fresh content). With `merge`, the commit is made on a branch and merged with
// --no-ff, so the credited commit is a two-parent merge whose first parent is the pre-merge main.
async function commitFiles(dir, files, message, { merge = false } = {}) {
  const write = () => {
    for (const f of files) put(dir, f, `${message} ${++counter}\n`);
  };
  if (merge) {
    const branch = `b-${++counter}`;
    await git(dir, "checkout", "-q", "-b", branch);
    write();
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", message);
    await git(dir, "checkout", "-q", "main");
    await git(dir, "merge", "-q", "--no-ff", "-m", message, branch);
  } else {
    write();
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", message);
  }
  return git(dir, "rev-parse", "HEAD");
}

const A = { id: "a", track: "hand", column: "ready", files: ["src/a.ts", "tests/a.test.ts"] };
const B = { id: "b", track: "hand", column: "ready", files: ["src/b.ts", "tests/b.test.ts"] };
const F = { id: "f", track: "flow", column: "ready", files: ["src/f.ts", "tests/f.test.ts"] };
const K = { id: "k", track: "hand", column: "backlog", files: ["src/k.ts"], goal: "Backlog goal" };

// A repo that looks like a finished queue run: one commit per card (a merge for a non-hand card), the board with
// each card Done and its source naming its commit, a hand-track entry for each hand card, and a held-out file per card.
// Options alter one thing: noCommit (no commit for these ids), plain (a non-hand card committed without a merge),
// order (the commit order), commitFiles (id -> files its commit changes), source (id -> (shas) => source text),
// notDone, noRuns, failHeld (ids whose held-out file says FAIL), moveBacklog, changeBacklog.
async function fakeQueue(defs, o = {}) {
  const { dir, baseline } = await newRepo();
  const heldDir = trackedTempDir("doug-hard-held-");
  const shas = {};
  const order = o.order || defs.filter((d) => d.column !== "backlog" && !(o.noCommit || []).includes(d.id)).map((d) => d.id);
  for (const id of order) {
    const d = defs.find((x) => x.id === id);
    const merge = d.track !== "hand" && !(o.plain || []).includes(id);
    shas[id] = await commitFiles(dir, (o.commitFiles || {})[id] || d.files, `land ${id}`, { merge });
  }
  const boardCards = defs.map((d) => {
    const source = (o.source || {})[d.id] ? o.source[d.id](shas) : shas[d.id] ? `commit ${shas[d.id].slice(0, 7)}` : "no commit";
    if (d.column === "backlog") return { id: d.id, column: o.moveBacklog ? "ready" : "backlog", goal: o.changeBacklog ? "Changed goal" : d.goal };
    return { id: d.id, column: (o.notDone || []).includes(d.id) ? "flow" : "done", goal: `Goal of ${d.id}`, source };
  });
  put(dir, ".doug/board.json", JSON.stringify({ cards: boardCards }, null, 2) + "\n");
  put(
    dir,
    "docs/live-runs.md",
    defs
      .filter((d) => d.track === "hand" && d.column !== "backlog" && !(o.noRuns || []).includes(d.id))
      .map((d) => `## \`${d.id}\`\nhand track: a gated by-hand change\n`)
      .join("\n"),
  );
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "Board: done");
  const cards = defs.map((d) => {
    const heldFile = join(heldDir, `h-${d.id}.txt`);
    writeFileSync(heldFile, (o.failHeld || []).includes(d.id) ? "FAIL\n" : "ok\n");
    return {
      id: d.id,
      column: d.column,
      track: d.track,
      goal: d.column === "backlog" ? d.goal : `Goal of ${d.id}`,
      deps: d.deps || [],
      files: d.files,
      requiredFiles: d.requiredFiles || d.files,
      requireTestFile: !!d.requireTestFile,
      heldOuts: d.column === "backlog" ? [] : [{ file: heldFile, to: `tests/heldout-${d.id}.txt` }],
    };
  });
  return { dir, baseline, shas, cards };
}

const useLine = (name, input, extra = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] }, ...extra });
const streamOf = (...lines) => lines.join("\n") + "\n";

async function queue(defs, o = {}, { baseline, stream = "" } = {}) {
  const f = await fakeQueue(defs, o);
  return inLib("assertQueueBuilt", { dir: f.dir, baseline: baseline === undefined ? f.baseline : baseline, stream, cards: f.cards });
}

function expectFail(r, ...parts) {
  expect(r.ok, r.message).toBe(false);
  for (const p of parts) expect(r.message).toContain(p);
}

// ---- A01 to A05: registry, estimates, stages, lookups, arguments -----------------------------------------------------
describe("the hard registry sits beside the cheap one", () => {
  it("A01 the cheap registry is unchanged and the hard one is disjoint from it", () => {
    expect(lib.SCENARIOS).toHaveLength(12);
    expect(lib.FIXTURE_NAMES).toEqual(["ts-basic", "ts-orders"]);
    expect(lib.TIERS).toEqual(["hard"]);
    expect(lib.HARD_BASES).toEqual(["hand", "flow", "swarm-skill", "start-feature", "auto", "parallel"]);
    expect(lib.HARD_SCENARIOS).toEqual(["hard-hand", "hard-flow", "hard-swarm-skill", "hard-start-feature", "hard-auto", "hard-parallel"]);
    for (const s of lib.HARD_SCENARIOS) expect(lib.SCENARIOS).not.toContain(s);
    expect(lib.HARD_FIXTURE_NAMES).toEqual(["ts-rentals"]);
    expect(lib.HARD_SESSION_TIMEOUT_MS).toBe(180 * 60 * 1000);
    expect(lib.RENTALS_FIXTURE_DIR.endsWith(join("evals", "fixtures", "ts-rentals"))).toBe(true);
    expect(lib.RENTALS_TASKS_FILE.endsWith(join("evals", "tasks", "ts-rentals.json"))).toBe(true);
    expect(lib.isHardScenario("hard-auto")).toBe(true);
    expect(lib.isHardScenario("auto")).toBe(false);
    expect(lib.isHardScenario("hard-bogus")).toBe(false);
    expect(lib.hardScenarioFor("auto")).toBe("hard-auto");
    expect(lib.hardScenarioFor("swarm-skill")).toBe("hard-swarm-skill");
    expect(lib.hardScenarioFor("swarm")).toBeNull();
    expect(lib.hardScenarioFor("hard-auto")).toBeNull();
  });

  it("A02 HARD_ESTIMATES: stage keys, sources, totals and the cap", () => {
    const sessionOrCommand = (s) => lib.SCENARIO_STAGES[s].filter((st) => st.kind !== "act").map((st) => st.name);
    for (const h of lib.HARD_SCENARIOS) {
      expect(Object.keys(lib.HARD_ESTIMATES[h].stages), h).toEqual(sessionOrCommand(h.replace(/^hard-/, "")));
      expect(lib.HARD_ESTIMATES[h].source, h).toMatch(/^measured on ts-rentals:/);
      expect(lib.HARD_ESTIMATES[h].source, h).not.toContain("unmeasured");
    }
    expect(lib.HARD_ESTIMATES["hard-hand"].stages).toEqual({ gate: 0.38, build: 1.8 });
    expect(lib.HARD_ESTIMATES["hard-flow"].stages).toEqual({ gate: 0.94, implement: 2.14 });
    expect(lib.HARD_ESTIMATES["hard-swarm-skill"].stages).toEqual({ gate: 0.67, run: 2.79 });
    expect(lib.HARD_ESTIMATES["hard-start-feature"].stages).toEqual({ spec: 0.95, architecture: 0.92, plan: 0.99 });
    expect(lib.HARD_ESTIMATES["hard-auto"].stages).toEqual({ gate: 0.31, build: 15.23 });
    expect(lib.HARD_ESTIMATES["hard-parallel"].stages).toEqual({ gate: 0.32, build: 15.0 });
    const totals = [2.18, 3.08, 3.46, 2.86, 15.54, 15.32];
    lib.HARD_SCENARIOS.forEach((h, i) => expect(lib.scenarioTotal(h), h).toBeCloseTo(totals[i], 10));
    expect(lib.totalEstimate({ tier: "hard" })).toBeCloseTo(42.44, 10);
    expect(lib.totalEstimate()).toBeCloseTo(lib.SCENARIOS.reduce((sum, s) => sum + lib.scenarioTotal(s), 0), 10);
    expect(lib.totalEstimate({ tier: null })).toBe(lib.totalEstimate());
    expect(lib.capFor("hard-auto", "build")).toBe(45.69);
    expect(lib.capFor("hard-parallel", "build", "ts-rentals")).toBe(45);
    expect(() => lib.capFor("hard-auto", "nope")).toThrow(/no estimate/);
  });

  it("A03 HARD_STAGES copy each base stage and override turns, timeouts, asserts and acts", () => {
    const turns = {
      "hard-hand": { gate: 18, build: 90 },
      "hard-flow": { gate: 45, implement: 60 },
      "hard-swarm-skill": { gate: 60, run: 120 },
      "hard-start-feature": { spec: 30, architecture: 45, plan: 45 },
      "hard-auto": { gate: 30, build: 420 },
      "hard-parallel": { gate: 30, build: 480 },
    };
    expect(Object.keys(lib.HARD_STAGES)).toEqual(lib.HARD_SCENARIOS);
    for (const h of lib.HARD_SCENARIOS) {
      const base = lib.SCENARIO_STAGES[h.replace(/^hard-/, "")];
      const hard = lib.HARD_STAGES[h];
      expect(hard.map((s) => [s.name, s.kind]), h).toEqual(base.map((s) => [s.name, s.kind]));
      hard.forEach((s, i) => {
        if (s.kind !== "session") {
          expect(s.maxTurns, `${h}/${s.name}`).toBeUndefined();
          return;
        }
        expect(s.maxTurns, `${h}/${s.name}`).toBe(turns[h][s.name]);
        expect(s.prompt, `${h}/${s.name} prompt`).toBe(base[i].prompt);
        const long = (h === "hard-auto" || h === "hard-parallel") && s.name === "build";
        expect(s.timeoutMs, `${h}/${s.name}`).toBe(long ? 180 * 60 * 1000 : 90 * 60 * 1000);
      });
    }
    const stage = (h, name) => lib.HARD_STAGES[h].find((s) => s.name === name);
    const cheap = (b, name) => lib.SCENARIO_STAGES[b].find((s) => s.name === name);
    expect(stage("hard-hand", "build").assert).toBe(lib.assertHardHandBuilt);
    expect(stage("hard-auto", "build").assert).toBe(lib.assertQueueBuilt);
    expect(stage("hard-parallel", "build").assert).toBe(lib.assertHardParallelBuilt);
    expect(stage("hard-flow", "land").run).not.toBe(cheap("flow", "land").run);
    expect(stage("hard-swarm-skill", "run").assert).not.toBe(cheap("swarm-skill", "run").assert);
    // Not overridden: the gates and every other stage keep the cheap function.
    for (const [h, b] of [["hard-hand", "hand"], ["hard-auto", "auto"], ["hard-parallel", "parallel"], ["hard-flow", "flow"]]) {
      expect(stage(h, "gate").assert, `${h} gate`).toBe(cheap(b, "gate").assert);
    }
    expect(stage("hard-flow", "implement").assert).toBe(cheap("flow", "implement").assert);
    // The cheap stages were not touched.
    expect(cheap("auto", "build").maxTurns).toBe(140);
    expect(cheap("auto", "build").timeoutMs).toBeUndefined();
    expect(lib.stagesFor("hard-auto")).toBe(lib.HARD_STAGES["hard-auto"]);
    expect(lib.stagesFor("auto")).toBe(lib.SCENARIO_STAGES.auto);
  });

  it("A04 scenarioFixtures and estimateLines: hard names resolve to ts-rentals, the cheap output is the same", () => {
    for (const h of lib.HARD_SCENARIOS) expect(lib.scenarioFixtures(h), h).toEqual(["ts-rentals"]);
    expect(lib.scenarioFixtures("hand")).toEqual(["ts-basic", "ts-orders"]);
    expect(lib.scenarioFixtures("decide")).toEqual(["ts-orders"]);
    expect(lib.scenarioFixtures("start")).toEqual([]);
    const cheap = lib.estimateLines();
    expect(cheap).toHaveLength(lib.SCENARIOS.length + 1);
    expect(cheap.join("\n")).not.toContain("hard-");
    expect(lib.estimateLines(null, null, { tier: null })).toEqual(cheap);
    const tier = lib.estimateLines(null, null, { tier: "hard" });
    expect(tier).toHaveLength(7);
    lib.HARD_SCENARIOS.forEach((h, i) => {
      expect(tier[i]).toContain(h);
      expect(tier[i]).toContain("measured on ts-rentals");
      expect(tier[i]).not.toContain("unmeasured on ts-rentals");
    });
    expect(tier[6]).toContain("all --tier hard");
    expect(tier[6]).toContain("$42.44");
    const one = lib.estimateLines("hard-auto");
    expect(one[0]).toContain("hard-auto $15.54 total");
    expect(one.join("\n")).toContain("cap $45.69");
  });

  it("A05 parseArgs reads --tier and defaults it to null", () => {
    expect(lib.parseArgs(["all", "--tier", "hard"])).toEqual({ scenario: "all", dir: null, spend: false, card: null, fixture: null, dryRun: false, tier: "hard" });
    expect(lib.parseArgs(["--tier", "hard"]).scenario).toBeNull();
    expect(lib.parseArgs(["auto", "--tier"]).tier).toBe("");
    expect(lib.parseArgs(["auto", "--spend", "--tier", "hard", "--card", "x", "/tmp/r"])).toEqual({ scenario: "auto", dir: "/tmp/r", spend: true, card: "x", fixture: null, dryRun: false, tier: "hard" });
    expect(lib.parseArgs(["hand"]).tier).toBeNull();
  });
});

// ---- A06: the stage timeout ------------------------------------------------------------------------------------------
describe("runStage takes a timeout", () => {
  it("A06 a timeoutMs shorter than the session kills it with a signal", async () => {
    const binDir = trackedTempDir("fake-claude-sleep-");
    const bin = join(binDir, "claude");
    writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n");
    chmodSync(bin, 0o755);
    const dir = trackedTempDir("doug-hard-stage-");
    const started = Date.now();
    const r = await inLib("runStage", { dir, prompt: "x", maxTurns: 1, stage: "slow", claudeBin: bin, timeoutMs: 500 });
    expect(r.signal).toBe("SIGTERM");
    expect(Date.now() - started).toBeLessThan(4500);
  });
});

// ---- A07: several held-out files -------------------------------------------------------------------------------------
describe("runHeldOutsAndClean", () => {
  async function heldCard(failFile = false) {
    const { dir } = await newRepo();
    const heldDir = trackedTempDir("doug-hard-held-");
    const files = ["one", "two"].map((n) => {
      const file = join(heldDir, `${n}.txt`);
      writeFileSync(file, n === "two" && failFile ? "FAIL\n" : "ok\n");
      return { file, to: `tests/heldout-${n}.txt` };
    });
    return { dir, card: { id: "c1", heldOuts: files } };
  }

  it("A07 copies every file, runs pnpm test once, removes them on pass and on fail, names them on a failure, refuses a dirty tree", async () => {
    const pass = await heldCard();
    const ok = await inLib("runHeldOutsAndClean", pass.dir, pass.card);
    expect(ok.ok, ok.message).toBe(true);
    expect(readFileSync(join(pass.dir, ".doug/seen.txt"), "utf8")).toBe("heldout-one.txt,heldout-two.txt\n");
    for (const h of pass.card.heldOuts) expect(existsSync(join(pass.dir, h.to)), h.to).toBe(false);

    const bad = await heldCard(true);
    const r = await inLib("runHeldOutsAndClean", bad.dir, bad.card);
    expectFail(r, "c1", "tests/heldout-one.txt", "tests/heldout-two.txt");
    expect(readFileSync(join(bad.dir, ".doug/seen.txt"), "utf8")).toBe("heldout-one.txt,heldout-two.txt\n");
    for (const h of bad.card.heldOuts) expect(existsSync(join(bad.dir, h.to)), h.to).toBe(false);

    const dirty = await heldCard();
    put(dirty.dir, "stray.txt", "x\n");
    const d = await inLib("runHeldOutsAndClean", dirty.dir, dirty.card);
    expectFail(d, "not clean", "stray.txt");
    expect(existsSync(join(dirty.dir, ".doug/seen.txt"))).toBe(false);
  });
});

// ---- A08: assertQueueBuilt -------------------------------------------------------------------------------------------
describe("assertQueueBuilt", () => {
  it("A08 passes a finished queue and returns every credited commit, the newest as commit", async () => {
    const f = await fakeQueue([A, { ...B, deps: ["a"] }, F, K]);
    const r = await inLib("assertQueueBuilt", { dir: f.dir, baseline: f.baseline, stream: "", cards: f.cards });
    expect(r.ok, r.message).toBe(true);
    expect(r.commits).toEqual([f.shas.a, f.shas.b, f.shas.f]);
    expect(r.commit).toBe(f.shas.f);
  });

  it("A08 no baseline", async () => {
    expect((await queue([A, K])).ok).toBe(true);
    expectFail(await queue([A, K], {}, { baseline: null }), "no baseline");
  });

  it("A08 AskUserQuestion in the stream", async () => {
    expect((await queue([A, K], {}, { stream: streamOf(useLine("Bash", { command: "ls" })) })).ok).toBe(true);
    expectFail(await queue([A, K], {}, { stream: streamOf(useLine("AskUserQuestion", {})) }), "AskUserQuestion");
  });

  it("A08 no commits since the baseline", async () => {
    expectFail(await queue([A, K], {}, { baseline: "HEAD" }), "never committed");
  });

  it("A08 a Backlog card moved or changed", async () => {
    expectFail(await queue([A, K], { moveBacklog: true }), "Backlog card k");
    expectFail(await queue([A, K], { changeBacklog: true }), "Backlog card k");
  });

  it("A08 a card not in Done", async () => {
    expect((await queue([A, B])).ok).toBe(true);
    expectFail(await queue([A, B], { notDone: ["b"] }), "does not have b in done");
  });

  it("A08 a source naming no commit since the baseline", async () => {
    expectFail(await queue([A], { source: { a: () => "landed it" } }), "a's source names no commit since the baseline");
    // The baseline itself exists but is not a commit of this run.
    const f = await fakeQueue([A]);
    put(f.dir, ".doug/board.json", JSON.stringify({ cards: [{ id: "a", column: "done", goal: "Goal of a", source: `commit ${f.baseline.slice(0, 7)}` }] }));
    expectFail(await inLib("assertQueueBuilt", { dir: f.dir, baseline: f.baseline, stream: "", cards: f.cards }), "names no commit since the baseline");
  });

  it("A08 a source naming two distinct commits is ambiguous", async () => {
    expect((await queue([A, B], { source: { a: (s) => `commit ${s.a.slice(0, 7)} (see also the baseline)` } })).ok).toBe(true);
    expectFail(await queue([A, B], { source: { a: (s) => `commit ${s.a.slice(0, 7)} and ${s.b.slice(0, 7)}` } }), "ambiguous");
  });

  it("A08 one commit per card: a source naming another card's commit is already credited", async () => {
    expectFail(await queue([A, B], { source: { b: (s) => `commit ${s.a.slice(0, 7)}` } }), "b's source names", "already credited to a");
  });

  it("A08 a flow card must be a two-parent merge, a hand card need not be", async () => {
    expect((await queue([F])).ok).toBe(true);
    expectFail(await queue([F], { plain: ["f"] }), "f did not land as a merge commit with two parents");
    expect((await queue([A])).ok).toBe(true);
  });

  it("A08 the required files are in the credited commit", async () => {
    expect((await queue([{ ...A, requiredFiles: ["src/a.ts"] }])).ok).toBe(true);
    expectFail(await queue([{ ...A, requiredFiles: ["src/a.ts"] }], { commitFiles: { a: ["tests/a.test.ts"] } }), "a's commit", "src/a.ts");
  });

  it("A08 requireTestFile wants a tests/ path in the commit", async () => {
    const def = { ...A, requiredFiles: ["src/a.ts"], requireTestFile: true };
    expect((await queue([def], { commitFiles: { a: ["src/a.ts", "tests/other.test.ts"] } })).ok).toBe(true);
    expectFail(await queue([def], { commitFiles: { a: ["src/a.ts"] } }), "a's commit", "tests/");
  });

  it("A08 a hand card needs its hand-track entry", async () => {
    expect((await queue([A])).ok).toBe(true);
    expectFail(await queue([A], { noRuns: ["a"] }), "no hand-track entry for a");
  });

  it("A08 a dep must land before the card", async () => {
    const dep = { ...B, deps: ["a"] };
    expect((await queue([A, dep])).ok).toBe(true);
    expectFail(await queue([A, dep], { order: ["b", "a"] }), "b landed before its dep a");
  });

  it("A08 a held-out failure is prefixed with the card id", async () => {
    expect((await queue([A, B])).ok).toBe(true);
    const r = await queue([A, B], { failHeld: ["b"] });
    expectFail(r, "tests/heldout-b.txt");
    expect(r.message.startsWith("b: ")).toBe(true);
  });

  it("A08 overlap: B's commit changes all of A's files and A's source names A's own commit, which passes; the old first-commit rule fails it", async () => {
    const shared = ["src/shared.ts", "tests/shared.test.ts"];
    const defs = [
      { ...A, files: shared },
      { ...B, files: [...shared, "src/b.ts"] },
      K,
    ];
    const f = await fakeQueue(defs);
    const r = await inLib("assertQueueBuilt", { dir: f.dir, baseline: f.baseline, stream: "", cards: f.cards });
    expect(r.ok, r.message).toBe(true);
    expect(r.commits).toEqual([f.shas.a, f.shas.b]);
    const old = await inLib("assertAutoBuilt", { dir: f.dir, baseline: f.baseline, stream: "", cards: f.cards });
    expectFail(old, "a's source does not name the code commit", f.shas.b);
  });

  it("A08 overlap: A's source naming B's commit fails as already credited", async () => {
    const shared = ["src/shared.ts", "tests/shared.test.ts"];
    const defs = [
      { ...A, files: shared },
      { ...B, files: [...shared, "src/b.ts"] },
      K,
    ];
    const r = await queue(defs, { source: { a: (s) => `commit ${s.b.slice(0, 7)}` } });
    expectFail(r, "b's source names", "already credited to a");
  });
});

// ---- A09: assertHardParallelBuilt ------------------------------------------------------------------------------------
describe("assertHardParallelBuilt", () => {
  // One finished repo shared by the stream cases; each case varies the stream and, for two, the disk.
  let memo = null;
  async function distinct() {
    if (!memo) {
      const f = await fakeQueue([F, B]);
      memo = { ...f, queen: (id) => useLine("Workflow", { scriptPath: `${f.dir}/.doug/.state/reports/${id}/queen.js` }), land: (id) => useLine("Bash", { command: `node /p/plan.mjs land-card ${id} ${f.dir}` }) };
      writeReports(f.dir, f.cards);
    }
    return memo;
  }
  function writeReports(dir, cards) {
    for (const c of cards) if (c.column === "ready") put(dir, `.doug/.state/reports/${c.id}/${c.track === "hand" ? "card-report.json" : "last-report.json"}`, "{}\n");
  }
  const call = (f, stream, cards = f.cards) => inLib("assertHardParallelBuilt", { dir: f.dir, baseline: f.baseline, stream, cards });

  it("A09 passes queens started together, then landed", async () => {
    const f = await distinct();
    const r = await call(f, streamOf(f.queen("f"), f.queen("b"), f.land("f"), f.land("b")));
    expect(r.ok, r.message).toBe(true);
    expect(r.commits).toEqual([f.shas.f, f.shas.b]);
  });

  it("A09 main editing under src/ fails; a subagent's edit does not", async () => {
    const f = await distinct();
    const base = [f.queen("f"), f.queen("b"), f.land("f"), f.land("b")];
    const edit = (extra) => useLine("Edit", { file_path: `${f.dir}/src/f.ts` }, extra);
    expectFail(await call(f, streamOf(edit({}), ...base)), "main edited a source file under src/");
    expect((await call(f, streamOf(edit({ parent_tool_use_id: "toolu_1" }), ...base))).ok).toBe(true);
  });

  it("A09 a .doug/plan.json fails", async () => {
    const f = await distinct();
    const stream = streamOf(f.queen("f"), f.queen("b"), f.land("f"), f.land("b"));
    put(f.dir, ".doug/plan.json", "{}\n");
    try {
      expectFail(await call(f, stream), ".doug/plan.json exists");
    } finally {
      rmSync(join(f.dir, ".doug/plan.json"), { force: true });
    }
    expect((await call(f, stream)).ok).toBe(true);
  });

  it("A09 a card without a queen launch fails", async () => {
    const f = await distinct();
    expectFail(await call(f, streamOf(f.queen("f"), f.land("f"), f.land("b"))), "queen.js", "card b");
  });

  it("A09 fewer than two launches before the first land call fails", async () => {
    const f = await distinct();
    expectFail(await call(f, streamOf(f.queen("f"), f.land("f"), f.queen("b"), f.land("b"))), "only 1 queen launch");
  });

  it("A09 a missing per-card report fails", async () => {
    const f = await distinct();
    const stream = streamOf(f.queen("f"), f.queen("b"), f.land("f"), f.land("b"));
    const report = join(f.dir, ".doug/.state/reports/b/card-report.json");
    rmSync(report);
    try {
      expectFail(await call(f, stream), "no per-card report for b");
    } finally {
      writeFileSync(report, "{}\n");
    }
    expect((await call(f, stream)).ok).toBe(true);
  });

  it("A09 overlap order: a later card's queen must start after the earlier card's land call", async () => {
    const shared = ["src/shared.ts", "tests/shared.test.ts"];
    const f = await fakeQueue([
      { ...A, files: shared },
      { ...B, files: [...shared, "src/b.ts"] },
      { id: "c", track: "hand", column: "ready", files: ["src/c.ts", "tests/c.test.ts"] },
    ]);
    writeReports(f.dir, f.cards);
    const queen = (id) => useLine("Workflow", { scriptPath: `${f.dir}/.doug/.state/reports/${id}/queen.js` });
    const landCard = (id) => useLine("Bash", { command: `node /p/plan.mjs land-card ${id} ${f.dir}` });
    const landFlag = (id) => useLine("Bash", { command: `node /p/plan.mjs land --card ${id} ${f.dir}` });
    const ok = await call(f, streamOf(queen("a"), queen("c"), landCard("a"), queen("b"), landFlag("b"), landCard("c")));
    expect(ok.ok, ok.message).toBe(true);
    expectFail(await call(f, streamOf(queen("a"), queen("b"), queen("c"), landCard("a"), landCard("b"), landCard("c"))), "b started its queen before a landed");
    // No land call that names a: nothing to order by.
    expectFail(await call(f, streamOf(queen("a"), queen("c"), useLine("Bash", { command: "node /p/plan.mjs land x" }), queen("b"))), "no plan.mjs land-card a");
    // A land call for card ab does not count as card a's.
    expectFail(await call(f, streamOf(queen("a"), queen("c"), useLine("Bash", { command: `node /p/plan.mjs land-card ab ${f.dir}` }), queen("b"))), "no plan.mjs land-card a");
  });

  // A land whose card id goes through a shell variable bound earlier in the same Bash command.
  describe("A09 shell-variable land", () => {
    let g = null;
    async function fx() {
      if (!g) {
        const shared = ["src/shared.ts", "tests/shared.test.ts"];
        const f = await fakeQueue([
          { ...A, files: shared },
          { ...B, files: [...shared, "src/b.ts"] },
          { id: "c", track: "hand", column: "ready", files: ["src/c.ts", "tests/c.test.ts"] },
        ]);
        writeReports(f.dir, f.cards);
        g = f;
      }
      const f = g;
      const queen = (id) => useLine("Workflow", { scriptPath: `${f.dir}/.doug/.state/reports/${id}/queen.js` });
      const bash = (command) => useLine("Bash", { command });
      const tail = [bash(`node /p/plan.mjs land-card b ${f.dir}`), bash(`node /p/plan.mjs land-card c ${f.dir}`)];
      // a's land is `aLand` (a command string); b's queen starts after it.
      const landed = (aLand) => call(f, streamOf(queen("a"), queen("c"), bash(aLand), queen("b"), ...tail));
      return { f, queen, bash, tail, landed };
    }

    it("A09 literal id passes", async () => {
      const { landed } = await fx();
      const r = await landed("node /p/plan.mjs land-card a --branch card/a");
      expect(r.ok, r.message).toBe(true);
    });

    it("A09 variable id passes: $id, ${id}, \"$id\", and land --card", async () => {
      const { landed } = await fx();
      for (const cmd of [
        "S=/p && id=a && node $S/plan.mjs land-card $id --branch card/$id",
        "id=a && node /p/plan.mjs land-card ${id} --branch card/${id}",
        'id=a && node /p/plan.mjs land-card "$id" --branch card/$id',
        "id=a && node /p/plan.mjs land --card $id",
        "id=a; node /p/plan.mjs land-card $id",
      ]) {
        const r = await landed(cmd);
        expect(r.ok, `${cmd}: ${r.message}`).toBe(true);
      }
    });

    it("A09 a variable bound to another id is not a's land", async () => {
      const { landed } = await fx();
      expectFail(await landed("id=x && node /p/plan.mjs land-card $id"), "no plan.mjs land-card a");
      expectFail(await landed("id=ab && node /p/plan.mjs land-card $id"), "no plan.mjs land-card a");
      expectFail(await landed("id=x && node /p/plan.mjs land --card $id"), "no plan.mjs land-card a");
    });

    it("A09 the value at the call counts: a later reassignment wins", async () => {
      const { landed } = await fx();
      expectFail(await landed("id=a && S=/p && id=x && node $S/plan.mjs land-card $id"), "no plan.mjs land-card a");
      const r = await landed("id=x && id=a && node /p/plan.mjs land-card $id");
      expect(r.ok, r.message).toBe(true);
    });

    it("A09 an unset variable is not a land of a", async () => {
      const { landed } = await fx();
      expectFail(await landed("node /p/plan.mjs land-card $id"), "no plan.mjs land-card a");
      expectFail(await landed("node /p/plan.mjs land-card ${id}"), "no plan.mjs land-card a");
    });

    it("A09 ordering still holds with the variable form", async () => {
      const { f, queen, bash, tail } = await fx();
      const varLand = bash("id=a && node /p/plan.mjs land-card $id");
      expectFail(await call(f, streamOf(queen("a"), queen("b"), queen("c"), varLand, ...tail)), "b started its queen before a landed");
    });
  });
});

// ---- A10: assertHardHandBuilt ----------------------------------------------------------------------------------------
describe("assertHardHandBuilt", () => {
  const H1 = { id: "fix-late-return-fee", track: "hand", column: "ready", files: ["src/pricing/late-fees.ts", "tests/pricing.test.ts"], requiredFiles: ["src/pricing/late-fees.ts"], requireTestFile: true };
  async function hand(files, o = {}) {
    const f = await fakeQueue([H1], { commitFiles: { [H1.id]: files }, ...o });
    return inLib("assertHardHandBuilt", { dir: f.dir, baseline: f.baseline, card: { id: H1.id }, cards: f.cards, stream: "" });
  }

  it("A10 passes on a commit changing late-fees.ts and any tests/ file", async () => {
    const r = await hand(["src/pricing/late-fees.ts", "tests/anything.test.ts"]);
    expect(r.ok, r.message).toBe(true);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("A10 fails with no tests/ path", async () => {
    expectFail(await hand(["src/pricing/late-fees.ts"]), "tests/");
  });

  it("A10 fails without the required file", async () => {
    expectFail(await hand(["tests/pricing.test.ts"]), "src/pricing/late-fees.ts");
  });

  it("A10 fails without a hand-track entry or with a held-out failure", async () => {
    const files = ["src/pricing/late-fees.ts", "tests/pricing.test.ts"];
    expectFail(await hand(files, { noRuns: [H1.id] }), "no hand-track entry");
    expectFail(await hand(files, { failHeld: [H1.id] }), "tests/heldout-fix-late-return-fee.txt");
  });

  it("A10 reads the commit from the source: a later commit that also changes the files is not credited", async () => {
    const f = await fakeQueue([H1], { commitFiles: { [H1.id]: ["src/pricing/late-fees.ts", "tests/pricing.test.ts"] } });
    // A later commit changes the same files; the board's source still names the first.
    await commitFiles(f.dir, ["src/pricing/late-fees.ts", "tests/pricing.test.ts"], "later");
    const r = await inLib("assertHardHandBuilt", { dir: f.dir, baseline: f.baseline, card: { id: H1.id }, cards: f.cards, stream: "" });
    expect(r.ok, r.message).toBe(true);
    expect(r.commit).toBe(f.shas[H1.id]);
  });
});

// ---- A11: recording under the tier's names ---------------------------------------------------------------------------
describe("recording under the hard names", () => {
  it("A11 recordsAsHand, rehearsalNote and archiveEvidence", async () => {
    for (const h of ["hard-hand", "hard-auto", "hard-parallel", "hard-start-feature"]) expect(lib.recordsAsHand(h), h).toBe(true);
    for (const h of ["hard-flow", "hard-swarm-skill"]) expect(lib.recordsAsHand(h), h).toBe(false);
    expect(lib.recordsAsHand("hand")).toBe(true);
    expect(lib.recordsAsHand("flow")).toBe(false);
    const stages = [{ name: "gate", wallClock: "1 min", message: "ok" }];
    expect(lib.rehearsalNote({ scenario: "hard-auto", fixture: "ts-rentals", outcome: "passed", stages, cost: 1 })).toMatch(/^Rehearsal hard-auto on the ts-rentals fixture: passed/);
    expect(lib.rehearsalNote({ scenario: "hard-auto", outcome: "passed", stages })).toMatch(/^Rehearsal hard-auto on the ts-rentals fixture: passed/);
    expect(lib.rehearsalNote({ scenario: "hard-flow", outcome: "passed", stages })).toMatch(/^Rehearsal hard-flow on the ts-rentals fixture: passed; stages/);
    const dir = trackedTempDir("doug-hard-archive-");
    const fixtureDir = trackedTempDir("doug-hard-archive-fx-");
    const dest = await inLib("archiveEvidence", { fixtureDir, dir, scenario: "hard-auto" });
    expect(basename(dest).startsWith("hard-auto-")).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });
});

// ---- A12: the generic suite prepare ----------------------------------------------------------------------------------
describe("prepareSuiteFixture", () => {
  it.skipIf(!built)("A12 writes the descriptor's deps to the board and returns heldOuts and the default requiredFiles", async () => {
    const suite = JSON.parse(readFileSync(lib.ORDERS_TASKS_FILE, "utf8"));
    const withHeld = suite.tasks.filter((t) => t.plan && (t.heldOut || []).length);
    const [t1, t2] = withHeld;
    const tasks = suite.tasks.map((t) => (t.id === t2.id ? { ...t, requiredFiles: [t.allowedFiles[0]], requireTestFile: true } : t));
    const card = (task, id, extra = {}) => ({ task: task.id, id, column: "ready", component: "billing", size: "S", class: "code", track: "hand", ...extra });
    const rehearsal = {
      scenarios: { synth: { cards: [card(t1, "synth-one"), card(t2, "synth-two", { deps: ["synth-one"] })] } },
      background: suite.rehearsal.background,
      lessons: [],
    };
    const dir = trackedTempDir("doug-hard-tasks-");
    const tasksFile = join(dir, "tasks.json");
    writeFileSync(tasksFile, JSON.stringify({ ...suite, tasks, rehearsal }, null, 2));
    const fx = await inLib("prepareSuiteFixture", { scenario: "synth", fixtureName: "ts-orders", fixtureDir: lib.ORDERS_FIXTURE_DIR, tasksFile, tempPrefix: "doug-rehearse-test-" });
    tempDirs.push(fx.dir);
    expect(fx.fixture).toBe("ts-orders");
    expect(fx.cards.map((c) => c.id)).toEqual(["synth-one", "synth-two"]);
    expect(fx.cards[0].deps).toEqual([]);
    expect(fx.cards[1].deps).toEqual(["synth-one"]);
    expect(fx.cards[0].requiredFiles).toEqual(t1.allowedFiles);
    expect(fx.cards[1].requiredFiles).toEqual([t2.allowedFiles[0]]);
    expect(fx.cards[0].requireTestFile).toBe(false);
    expect(fx.cards[1].requireTestFile).toBe(true);
    expect(fx.cards[0].heldOut.file).toBe(fx.cards[0].heldOuts[0].file);
    expect(fx.cards[0].heldOuts.map((h) => h.to)).toEqual(t1.heldOut.map((h) => h.to));
    expect(fx.cards[0].files).toEqual(t1.allowedFiles);
    const board = JSON.parse(readFileSync(join(fx.dir, ".doug/board.json"), "utf8"));
    expect(board.cards.find((c) => c.id === "synth-two").deps).toEqual(["synth-one"]);
    expect(board.cards.find((c) => c.id === "synth-one").deps).toEqual([]);
    expect(await git(fx.dir, "status", "--porcelain")).toBe("");
  });

  it.skipIf(!built)("A12 prepareFixture still refuses an unknown scenario and a hard scenario on another fixture", async () => {
    await expect(inLib("prepareFixture", { scenario: "bogus" })).rejects.toThrow(/unknown scenario/);
    await expect(inLib("prepareFixture", { scenario: "hard-auto", fixture: "ts-orders" })).rejects.toThrow(/ts-rentals/);
  });
});

// ---- A10: hard-swarm-skill's run assert needs a real split (card rehearse-hard-swarm-requires-split) -----------------
// The task shape is seeded from the real 2026-10-25 hard-swarm-skill report (levels[0].tasks[0]): shape full,
// swarm {applies, reason, splitReason, briefs: 3, rebrief: null, workerCheck: false}, three round-one workers.
describe("A10 hard-swarm-skill run assert requires a split", () => {
  const SPLIT_REASON = "The task has three independent deliverables, one per module, so the briefs share no file and no new symbol.";
  const worker = (n, round = 1) => ({
    n,
    id: `w${n}`,
    title: `deliverable ${n}`,
    files: [`src/m${n}.ts`, `tests/m${n}.test.ts`],
    round,
    branch: `doug/task-rental-helpers-w${n}`,
    commit: "a".repeat(40),
    blocked: false,
    blockedReason: null,
  });
  const swarm = (briefs, rebrief = null) => ({ applies: true, reason: "two or more source files", splitReason: SPLIT_REASON, briefs, rebrief, workerCheck: false });
  const taskOf = (o) => ({
    id: "rental-helpers",
    implemented: true,
    verified: true,
    reviewed: true,
    adversary: { ran: true, verdict: "pass" },
    shape: "full",
    ...o,
  });

  // A finished swarm run: a merge commit on main, the card Done with a source naming it, the report on disk.
  async function swarmRepo(task) {
    const { dir, baseline } = await newRepo();
    const sha = await commitFiles(dir, ["src/m1.ts"], "land rental-helpers", { merge: true });
    put(dir, ".doug/board.json", JSON.stringify({ cards: [{ id: "rental-helpers", column: "done", goal: "g", source: `commit ${sha.slice(0, 7)}` }] }, null, 2) + "\n");
    put(dir, lib.RESULTS_FILE, JSON.stringify({ ok: true, levels: [{ tasks: [task] }] }));
    return { dir, baseline };
  }
  const heldFile = () => {
    const f = join(trackedTempDir("doug-hard-held-"), "h.txt");
    writeFileSync(f, "ok\n");
    return f;
  };
  async function runStageOf(scenario, task) {
    const { dir, baseline } = await swarmRepo(task);
    const card = { id: "rental-helpers", heldOuts: [{ file: heldFile(), to: "tests/heldout-rental-helpers.txt" }] };
    const bin = makeFakeClaude(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-swarm"] }));
    const table = scenario === "hard-swarm-skill" ? "HARD_STAGES" : "SCENARIO_STAGES";
    const name = scenario === "hard-swarm-skill" ? "hard-swarm-skill" : "swarm-skill";
    return inLib("runSessionStage", { $expr: `lib.${table}["${name}"].find((s) => s.name === "run")` }, { dir, card, cards: [card], baseline, claudeBin: bin });
  }

  it("a real split (3 briefs, 3 round-one workers) passes", async () => {
    const r = await runStageOf("hard-swarm-skill", taskOf({ swarm: swarm(3), workers: [worker(1), worker(2), worker(3)] }));
    expect(r.ok, r.message).toBe(true);
  });

  it("one brief and one worker fails, naming the task, the brief count and the splitReason", async () => {
    const r = await runStageOf("hard-swarm-skill", taskOf({ swarm: swarm(1), workers: [worker(1)] }));
    expectFail(r, "rental-helpers", SPLIT_REASON);
    expect(r.message).toMatch(/\b1 brief/);
  });

  it("one brief with a round-two worker row (a re-brief) fails: the first split is judged by briefs", async () => {
    const r = await runStageOf("hard-swarm-skill", taskOf({ swarm: swarm(1, { reason: "w1 blocked" }), workers: [worker(1), worker(2, 2)] }));
    expectFail(r, "rental-helpers");
  });

  it("two briefs but only one worker row fails: at least two workers", async () => {
    const r = await runStageOf("hard-swarm-skill", taskOf({ swarm: swarm(2), workers: [worker(1)] }));
    expectFail(r, "rental-helpers");
  });

  it("the cheap swarm-skill run assert is not failed by the split rule: one brief and one worker still passes", async () => {
    const r = await runStageOf("swarm-skill", taskOf({ swarm: swarm(1), workers: [worker(1)] }));
    expect(r.message || "").not.toContain(SPLIT_REASON);
    expect(r.ok, r.message).toBe(true);
  });
});
