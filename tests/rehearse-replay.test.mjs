// The e2e replays at $0 (the ci-e2e spec 5.2): the hand-written fake claude (tests/replay/claude)
// carries every rehearsal scenario through scripts/rehearse.mjs --spend to a pass, and each scenario has one
// failing replay that fails at a named stage. No model, no Codex, no spend: a shim dir holding claude, codex and
// codex-review records any call to them in trip.log and exits 1, and the test requires that log to stay absent.
// A failed expectation first records a finding (tests/replay/findings.mjs) so scripts/e2e-cards.mjs can file it.
import { describe, it, expect, afterAll, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, ROOT, SCENARIOS, HARD_SCENARIOS, HARD_BASES, stagesFor } from "../scripts/rehearse-lib.mjs";
import { newBoard, addCard, saveBoard } from "../plugins/doug-flow/lib/board.mjs";
import { buildReflectPrompt, buildProjectModelPrompt, buildIdeasPrompt } from "../plugins/doug-flow/lib/memory.mjs";
import { run, inLib, TEST_PREFIX } from "./rehearse-fixtures.mjs";
import { FAKE, REPLAY_DIR } from "./replay/lib.mjs";
import { finding, recordFindings } from "./replay/findings.mjs";

const SOURCE = "tests/rehearse-replay.test.mjs";
const REHEARSE = join(ROOT, "scripts", "rehearse.mjs");
const CARD = "e2e-replay-card";
const built = existsSync(CLI);
const ALL = [...SCENARIOS, ...HARD_SCENARIOS];
const NO_FAKE = ["init", "board"]; // no stage of these spawns claude
const FAKED = ALL.filter((s) => !NO_FAKE.includes(s));

// A run of the full suite builds fixtures (a shell setup, doug init, git) and runs the fixture's Stop gate
// commands; the ceiling is for a hung child, not a performance pin.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
const findings = [];
afterAll(() => {
  // A green run records an empty list, which clears this source's findings from an earlier red run.
  recordFindings(SOURCE, findings);
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// At most 4 CLI runs in flight (each prepares a fixture and runs Stop gate commands).
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting = [];
async function limited(fn) {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = waiting.shift();
    if (next) next();
  }
}

function hardArgs(scenario) {
  return scenario.startsWith("hard-") ? [scenario.slice("hard-".length), "--tier", "hard"] : [scenario];
}

function makeTarget() {
  const target = tempDir("rehearse-replay-target-");
  let board = { ...newBoard(), components: ["flow"] };
  board = addCard(board, { id: CARD, title: "Replay card", goal: "g", component: "flow", size: "S", track: "hand", column: "ready", class: "code" });
  saveBoard(target, board);
  return target;
}

function makeShim() {
  const shim = tempDir("rehearse-replay-shim-");
  const log = join(shim, "trip.log");
  for (const name of ["claude", "codex", "codex-review"]) {
    const bin = join(shim, name);
    writeFileSync(bin, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\nexit 1\n`);
    chmodSync(bin, 0o755);
  }
  return { shim, log };
}

// One CLI run of a scenario, memoized per (scenario, fail): E01/E02/E04/E05/E06 read the same result.
const runs = new Map();
function cliRun(scenario, fail = null) {
  const key = `${scenario}|${fail || ""}`;
  if (!runs.has(key)) {
    runs.set(
      key,
      limited(async () => {
        const target = makeTarget();
        const { shim, log: tripLog } = makeShim();
        const replayLog = join(tempDir("rehearse-replay-log-"), "blocks.log");
        const env = { ...process.env, DOUG_REHEARSE_CLAUDE: FAKE, DOUG_CLAUDE_BIN: join(shim, "claude"), PATH: `${shim}:${process.env.PATH}`, DOUG_REPLAY_SCENARIO: scenario, DOUG_REPLAY_LOG: replayLog };
        delete env.ANTHROPIC_API_KEY;
        delete env.DOUG_REPLAY_FAIL;
        if (fail) env.DOUG_REPLAY_FAIL = fail;
        const args = [REHEARSE, ...hardArgs(scenario), "--spend", "--card", CARD, target];
        const r = await run(process.execPath, args, { env });
        const kept = (r.stdout.match(/fixture: (\S+) \(kept for inspection\)/) || [])[1] || null;
        if (kept) {
          // Removed here: the test only needs the printed path, and a kept fixture holds a node_modules tree.
          rmSync(kept, { recursive: true, force: true });
        }
        const reproduce = `${fail ? `DOUG_REPLAY_FAIL=${fail} ` : ""}DOUG_REHEARSE_CLAUDE=${FAKE} DOUG_CLAUDE_BIN=${join(shim, "claude")} PATH=${shim}:$PATH DOUG_REPLAY_SCENARIO=${scenario} DOUG_REPLAY_LOG=${replayLog} node scripts/rehearse.mjs ${hardArgs(scenario).join(" ")} --spend --card ${CARD} ${target}`;
        return { ...r, target, tripLog, replayLog, kept, reproduce, scenario };
      }),
    );
  }
  return runs.get(key);
}

const replayFile = (scenario) => relative(ROOT, join(REPLAY_DIR, "scenarios", `${scenario}.mjs`));

// Runs the expectations; on a failure records a finding first (E08) and rethrows.
function check(res, { scenario, stage, kind, suspect = "either" }, fn) {
  try {
    fn();
  } catch (e) {
    findings.push(finding({ scenario, stage, message: e && e.message ? e.message : String(e), kind, suspect, replayFile: replayFile(scenario), reproduce: res ? res.reproduce : null, source: SOURCE }));
    throw e;
  }
}

async function loadScenario(name) {
  return import(pathToFileURL(join(REPLAY_DIR, "scenarios", `${name}.mjs`)).href);
}

describe.concurrent("E01 every pass replay", () => {
  for (const scenario of FAKED) {
    it.skipIf(!built)(`E01 ${scenario} passes through scripts/rehearse.mjs at $0`, async () => {
      const res = await cliRun(scenario);
      check(res, { scenario, stage: "run", kind: "replay-failed" }, () => {
        expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
        expect(res.stdout).toContain(`${scenario}: passed`);
        expect(res.stdout).toContain("measured cost: $0.00");
        const live = readFileSync(join(res.target, "docs/live-runs.md"), "utf8");
        expect(live).toContain(`Rehearsal ${scenario}`);
        if (existsSync(res.replayLog)) expect(readFileSync(res.replayLog, "utf8").trim(), "a pass replay's session stage logged a Stop block").toBe("");
      });
    });
  }
});

describe.concurrent("E02 init and board through the same CLI", () => {
  for (const scenario of NO_FAKE) {
    it.skipIf(!built)(`E02 ${scenario} passes through scripts/rehearse.mjs at $0`, async () => {
      const res = await cliRun(scenario);
      check(res, { scenario, stage: "run", kind: "replay-failed" }, () => {
        expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
        expect(res.stdout).toContain(`${scenario}: passed`);
        expect(res.stdout).toContain("measured cost: $0.00");
        expect(readFileSync(join(res.target, "docs/live-runs.md"), "utf8")).toContain(`Rehearsal ${scenario}`);
      });
    });
  }
});

describe("E03 each scenario file keys exactly its session and command stages", () => {
  const ctx = { dir: "/nonexistent", card: { id: "fix-hours" }, cards: [{ id: "fix-hours" }], fixture: "ts-orders" };
  const commandPrompts = () => [buildReflectPrompt({ tasks: [] }), buildProjectModelPrompt({}), buildIdeasPrompt({})];
  const hits = (step, prompt) => (step.match instanceof RegExp ? step.match.test(prompt) : typeof step.match === "string" && prompt.includes(step.match));

  for (const scenario of ALL) {
    it(`E03 ${scenario} has a step per session stage, matching its own prompt only`, async () => {
      const file = join(REPLAY_DIR, "scenarios", `${scenario}.mjs`);
      expect(existsSync(file), `no scenario file ${file}`).toBe(true);
      const mod = await loadScenario(scenario);
      const stages = stagesFor(scenario);
      const names = stages.map((s) => s.name);
      const sessions = stages.filter((s) => s.kind === "session");
      const commands = stages.filter((s) => s.kind === "command");
      const prompts = Object.fromEntries(sessions.map((s) => [s.name, s.prompt(ctx)]));
      for (const step of mod.steps) expect(names, `${scenario}: step "${step.stage}" names a stage missing from stagesFor`).toContain(step.stage);
      for (const s of sessions) {
        const own = mod.steps.filter((step) => step.stage === s.name);
        expect(own.length, `${scenario}: stage ${s.name} needs exactly one step`).toBe(1);
        for (const [name, prompt] of Object.entries(prompts)) {
          expect(hits(own[0], prompt), `${scenario}: the step for ${s.name} ${name === s.name ? "misses its own prompt" : `also hits the ${name} prompt`}`).toBe(name === s.name);
        }
      }
      for (const c of commands) {
        const own = mod.steps.filter((step) => step.stage === c.name);
        expect(own.length, `${scenario}: command stage ${c.name} needs exactly one step`).toBe(1);
        expect(commandPrompts().filter((p) => hits(own[0], p)).length, `${scenario}: the step for ${c.name} must match exactly one command prompt`).toBe(1);
      }
      if (sessions.length === 0 && commands.length === 0) expect(mod.steps.length).toBe(0);
    });
  }
});

describe.concurrent("E04 each scenario has one failing replay at a named stage", () => {
  for (const scenario of FAKED) {
    it.skipIf(!built)(`E04 ${scenario} fails at its named stage`, async () => {
      const { failStage } = await loadScenario(scenario);
      const res = await cliRun(scenario, failStage);
      const kind = res.status === 0 ? "fail-replay-passed" : "fail-replay-wrong-stage";
      check(res, { scenario, stage: failStage, kind, suspect: "replay" }, () => {
        expect(res.status, `the failing replay passed:\n${res.stdout}`).toBe(1);
        expect(res.stdout).toContain(`failed at ${failStage}`);
      });
      expect(res.kept, "a failed scenario keeps its fixture").not.toBeNull();
    });
  }

  for (const scenario of NO_FAKE) {
    it.skipIf(!built)(`E04 ${scenario} fails at its named stage on a damaged fixture`, async () => {
      const mod = await loadScenario(scenario);
      const prepared = await limited(() => inLib("prepareFixture", { scenario, tempPrefix: TEST_PREFIX }));
      tempDirs.push(prepared.dir);
      mod.damage(prepared.dir);
      const ctx = { dir: prepared.dir, card: prepared.card, cards: prepared.cards, fixture: prepared.fixture || null, baseline: prepared.baseline };
      const stages = stagesFor(scenario);
      let failed = null;
      for (let i = 0; i < stages.length && failed === null; i++) {
        expect(stages[i].kind, `${scenario}: stage ${stages[i].name} would spawn claude`).toBe("act");
        const r = await limited(() => inLib("runActStage", { $expr: `lib.stagesFor(${JSON.stringify(scenario)})[${i}]` }, ctx));
        if (!r.ok) failed = stages[i].name;
      }
      check({ reproduce: `inLib: prepareFixture, ${scenario}.damage, runActStage over stagesFor("${scenario}")` }, { scenario, stage: mod.failStage, kind: failed === null ? "fail-replay-passed" : "fail-replay-wrong-stage", suspect: "replay" }, () => {
        expect(failed, "the damaged fixture passed every stage").not.toBeNull();
        expect(failed).toBe(mod.failStage);
      });
    });
  }
});

describe("E05 the Stop gate blocks a red session end", () => {
  it.skipIf(!built)("E05 hand build-red fails by SIGTERM and logs the Stop reason", async () => {
    const res = await cliRun("hand", "build-red");
    check(res, { scenario: "hand", stage: "build", kind: "fail-replay-wrong-stage", suspect: "replay" }, () => {
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(1);
      expect(res.stdout).toContain("failed at build: claude was killed by signal SIGTERM");
      expect(existsSync(res.replayLog), "no Stop block was logged").toBe(true);
      expect(readFileSync(res.replayLog, "utf8").trim().length).toBeGreaterThan(0);
    });
  });

  it.skipIf(!built)("E05 hand pass replay logs no block", async () => {
    const res = await cliRun("hand");
    check(res, { scenario: "hand", stage: "build", kind: "replay-failed" }, () => {
      expect(existsSync(res.replayLog) ? readFileSync(res.replayLog, "utf8").trim() : "").toBe("");
    });
  });
});

describe("E06 no run reaches a real model or Codex", () => {
  it.skipIf(!built)("E06 trip.log is absent after every E01, E02 and E04 run", async () => {
    const all = [];
    for (const s of ALL) all.push(cliRun(s));
    for (const s of FAKED) all.push(loadScenario(s).then((m) => cliRun(s, m.failStage)));
    const results = await Promise.all(all);
    for (const res of results) {
      check(res, { scenario: res.scenario, stage: "run", kind: "replay-failed" }, () => {
        expect(existsSync(res.tripLog), `${res.scenario} called a shimmed claude, codex or codex-review: ${existsSync(res.tripLog) ? readFileSync(res.tripLog, "utf8") : ""}`).toBe(false);
      });
    }
  });
});

describe("E07 the pinned skills and workflow scripts have not drifted", () => {
  const pins = JSON.parse(readFileSync(join(REPLAY_DIR, "skill-hashes.json"), "utf8"));
  it("E07 skill-hashes.json covers exactly the scenarios", () => {
    expect(Object.keys(pins).sort()).toEqual([...ALL].sort());
    expect(HARD_BASES.length).toBe(HARD_SCENARIOS.length);
  });
  for (const scenario of ALL) {
    it(`E07 ${scenario} skills equal the pin keys and each hash matches`, async () => {
      const mod = await loadScenario(scenario);
      const pin = pins[scenario] || {};
      expect([...mod.skills].sort(), `${scenario}: skills in ${replayFile(scenario)} differ from the keys of skill-hashes.json`).toEqual(Object.keys(pin).sort());
      for (const [path, want] of Object.entries(pin)) {
        const got = createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
        expect(got, `${path} changed: pinned ${want}, now ${got}; review ${replayFile(scenario)} and update tests/replay/skill-hashes.json in the same commit`).toBe(want);
      }
    });
  }
});
