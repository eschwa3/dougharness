import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyNotification } from "../lib/coordinator.mjs";
import { initialState, currentAction, next, briefPrompt, HAND_BACK_SCHEMAS, handBackSchema, SEAT_ROWS } from "../lib/card-loop.mjs";

// Card parallel-card-queens, brief B10: the hand-card queen workflow (card-queen.js) is a thin adapter over
// card-loop.mjs. The contract is inlined into the workflow file at sync time (scripts/sync-card-loop.mjs,
// `pnpm workflows:sync`) because a workflow containing import() fails before the run starts
// (workflows.md:362). These tests drive the workflow with a fake `agent`, no host.
// Precedent: template.test.mjs:46-60 (workflow-file rules), :278-300 (evaluating a workflow body),
// plugins/doug-gates/tests/vendored-copies.test.mjs (drift failure messages).

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOW = join(HERE, "..");
const ROOT = join(FLOW, "..", "..");
const LIB = join(FLOW, "lib", "card-loop.mjs");
const QUEEN = join(FLOW, "workflows", "card-queen.js");
const SYNC = join(ROOT, "scripts", "sync-card-loop.mjs");

const BEGIN = "// ---- BEGIN card-loop.mjs (inlined by pnpm workflows:sync; do not edit) ----";
const END = "// ---- END card-loop.mjs ----";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CARD = { id: "c1", title: "A card", size: "M", class: "code", goal: "Do the thing exactly." };
const REPO = "/abs/repo";
const WT = "/abs/repo/.claude/worktrees/card-c1";
const NOTE = "/abs/note.md";
const INLINE_NOTE = "Fact: X holds\nSource: https://example.test/a line 3\nunverified: Y";
const SEATS_IN_ORDER = ["setup", "research", "lead", "tester", "coder", "reviewer", "gate", "commit"];

// Distinct values per row, so a seat that resolves the wrong row cannot pass by coincidence.
const MODELS = {
  roles: {
    plan: { model: "m-plan", effort: "e-plan" },
    lead: { model: "inherit", effort: "e-lead" },
    implement: { model: "m-impl", effort: "e-impl" },
    review: { model: "m-review", effort: "e-review" },
  },
  tiers: { cheap: { model: "m-cheap", effort: "e-cheap" } },
};
const EXPECT_BY_ROW = {
  cheap: { model: "m-cheap", effort: "e-cheap" },
  plan: { model: "m-plan", effort: "e-plan" },
  lead: { model: undefined, effort: "e-lead" },
  implement: { model: "m-impl", effort: "e-impl" },
  review: { model: "m-review", effort: "e-review" },
};
const AGENT_TYPES = {
  setup: "doug-flow:implementer",
  research: "doug-flow:researcher",
  lead: "doug-flow:lead",
  tester: "doug-flow:tester",
  coder: "doug-flow:coder",
  reviewer: "doug-flow:reviewer",
  gate: "doug-flow:implementer",
  commit: "doug-flow:implementer",
};

function loadSource() {
  return readFileSync(QUEEN, "utf8");
}
// The head is everything before the BEGIN marker (the meta export); the body is the rest.
function split(source) {
  const at = source.indexOf(BEGIN);
  if (at < 0) throw new Error("card-queen.js has no BEGIN marker line: " + BEGIN);
  return { head: source.slice(0, at), body: source.slice(at) };
}
function loadMeta(source = loadSource()) {
  const { head } = split(source);
  expect(head.startsWith("export const meta = ")).toBe(true);
  return new Function(head.replace("export const meta = ", "return ") + "\n")();
}
// Run the workflow body the way the runtime does: an async function of (args, agent, phase, log).
function runQueen(args, agent, phases = [], logs = []) {
  const { body } = split(loadSource());
  const fn = new AsyncFunction("args", "agent", "phase", "log", body);
  return fn(args, agent, (t) => phases.push(t), (m) => logs.push(m));
}
function blockOf(source) {
  const a = source.indexOf(BEGIN);
  const b = source.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error("card-queen.js needs the BEGIN and END marker lines, in that order");
  return source.slice(a + BEGIN.length, b);
}
// inlineCardLoop may return the bare block or the block with its markers; compare on the bare block either way.
function bare(text) {
  return text.replace(BEGIN, "").replace(END, "").trim();
}
async function loadSync() {
  return import(pathToFileURL(SYNC).href);
}

// A valid hand-back for the seat the mirror state is waiting on. `over` is merged on top.
function okHB(seat, over = {}) {
  const base = {
    setup: { worktree: WT, branch: "card/c1", install: null },
    research: { note: NOTE },
    lead: { lessons: "LESSONS", facts: [{ text: "a fact", source: "docs/x.md:1" }], unverified: [], testFiles: ["a.test.mjs"], mutations: [] },
    tester: { files: ["a.test.mjs"], tests_red_by_design: ["a.test.mjs"] },
    coder: { filesChanged: ["a.mjs"], commandsRun: [{ command: "pnpm exec vitest run a.test.mjs", exitCode: 0 }], testsEdited: [] },
    reviewer: { verdict: "pass", findings: [], commandsRun: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }], mutationResults: [] },
    gate: { commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }], gateLine: "typecheck ok; test:unit ok", tree: "a".repeat(40) },
    commit: { sha: "abc1234", branch: "card/c1", tree: "a".repeat(40) },
  }[seat];
  return { seat, ...base, ...over };
}

// A fake host agent. It mirrors the contract's state beside the workflow, records each call, and answers with
// `respond(seat, call)`: a hand-back, or null.
function fakeAgent(respond = (seat) => okHB(seat), card = CARD) {
  let mirror = initialState(card, { research: true });
  const calls = [];
  const agent = async (prompt, opts) => {
    const action = currentAction(mirror);
    const seat = action.kind === "seat" ? action.seat : null;
    const call = { prompt, opts, seat, brief: action.brief, round: action.brief ? action.brief.round : null };
    calls.push(call);
    const hb = respond(seat, call);
    if (action.kind === "seat") mirror = next(mirror, hb).state;
    return hb;
  };
  return { agent, calls };
}

const ARGS = { card: CARD, options: { research: true }, repoRoot: REPO, worktreePath: WT, models: MODELS };

describe("card-queen workflow (parallel-card-queens B10)", () => {
  it("Q01 runs the eight seats in order and returns a done report with the commit", async () => {
    const { agent, calls } = fakeAgent();
    const phases = [];
    const report = await runQueen(ARGS, agent, phases);
    expect(calls.map((c) => c.seat)).toEqual(SEATS_IN_ORDER);
    expect(report.outcome).toBe("done");
    expect(report.reason).toBeNull();
    expect(report.commit).toBe("abc1234");
    expect(report.card.id).toBe("c1");
    expect(report.history.map((h) => h.seat)).toEqual(SEATS_IN_ORDER);
    expect(phases.length).toBe(8);
    // labels are '<seat>:<id>:<round>'
    for (const c of calls) expect(c.opts.label).toBe(`${c.seat}:c1:${c.round}`);
  });

  it("Q02 each call carries its seat's schema, its row's model and effort, and its agentType", async () => {
    const { agent, calls } = fakeAgent();
    await runQueen(ARGS, agent);
    expect(calls.length).toBe(8);
    for (const c of calls) {
      expect(c.opts.schema).toEqual(handBackSchema(c.seat, "full"));
      const want = EXPECT_BY_ROW[SEAT_ROWS[c.seat]];
      expect(c.opts.model, `${c.seat} model`).toBe(want.model);
      expect(c.opts.effort, `${c.seat} effort`).toBe(want.effort);
      expect(c.opts.agentType, `${c.seat} agentType`).toBe(AGENT_TYPES[c.seat]);
    }
  });

  it("Q02c the agent call gets the lane's schema: the full tester has no notRun, the tests-only tester admits it", async () => {
    const full = fakeAgent();
    await runQueen(ARGS, full.agent);
    const ft = full.calls.find((c) => c.seat === "tester");
    expect(ft.opts.schema.properties.mutationResults.items.properties.notRun).toBeUndefined();
    expect(ft.opts.schema).toEqual(ft.brief.handBack);

    const TO = { ...CARD, class: "tests-only" };
    const to = fakeAgent((seat) => okHB(seat), TO);
    await runQueen({ ...ARGS, card: TO }, to.agent);
    const tt = to.calls.find((c) => c.seat === "tester");
    expect(tt.opts.schema.properties.mutationResults.items.properties.notRun).toBeTruthy();
    expect(tt.opts.schema).toEqual(handBackSchema("tester", "tests-only"));
    expect(tt.opts.schema).toEqual(tt.brief.handBack);
  });

  it("Q02b inherit omits model and effort; a missing cheap tier omits them too", async () => {
    const models = { roles: { implement: { model: "inherit", effort: "inherit" } }, tiers: {} };
    const { agent, calls } = fakeAgent();
    await runQueen({ ...ARGS, models }, agent);
    for (const c of calls.filter((x) => x.seat === "tester" || x.seat === "coder")) {
      expect(c.opts.model).toBeUndefined();
      expect(c.opts.effort).toBeUndefined();
    }
    for (const c of calls.filter((x) => x.seat === "gate")) {
      expect(c.opts.model).toBeUndefined();
      expect(c.opts.effort).toBeUndefined();
    }
  });

  it("Q03 no call carries an isolation key", async () => {
    const { agent, calls } = fakeAgent();
    await runQueen(ARGS, agent);
    for (const c of calls) expect("isolation" in c.opts, c.seat).toBe(false);
  });

  it("Q04 a null from the agent stops with agent-null, with no retry", async () => {
    const { agent, calls } = fakeAgent((seat) => (seat === "coder" ? null : okHB(seat)));
    const report = await runQueen(ARGS, agent);
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("agent-null");
    expect(report.stoppedAt).toBe("coder");
    expect(calls.filter((c) => c.seat === "coder").length).toBe(1);
    expect(calls.map((c) => c.seat)).toEqual(["setup", "research", "lead", "tester", "coder"]);
    // the same at the first seat
    const first = fakeAgent(() => null);
    const r2 = await runQueen(ARGS, first.agent);
    expect(r2.reason).toBe("agent-null");
    expect(first.calls.length).toBe(1);
  });

  it("Q04b seam: the queen's returned object, as the run's <result>, classifies as land (done) and resume (agent-null)", async () => {
    const done = await runQueen(ARGS, fakeAgent().agent);
    expect(classifyNotification("hand", { status: "completed", result: JSON.stringify(done) }).action).toBe("land");
    const stopped = await runQueen(ARGS, fakeAgent((seat) => (seat === "coder" ? null : okHB(seat))).agent);
    const v = classifyNotification("hand", { status: "completed", result: JSON.stringify(stopped) });
    expect(v.action).toBe("resume");
    expect(v.reason).toBe("agent-null");
  });

  const BOOM = "structured output failed validation after 5 attempts";

  it("Q13 a throwing agent() at the coder seat yields a stopped agent-null report, no retry, error logged", async () => {
    const { agent, calls } = fakeAgent((seat) => {
      if (seat === "coder") throw new Error(BOOM);
      return okHB(seat);
    });
    const logs = [];
    const report = await runQueen(ARGS, agent, [], logs);
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("agent-null");
    expect(report.stoppedAt).toBe("coder");
    expect(calls.filter((c) => c.seat === "coder").length).toBe(1);
    expect(calls.map((c) => c.seat)).toEqual(["setup", "research", "lead", "tester", "coder"]);
    expect(logs.some((l) => l.includes("coder") && l.includes(BOOM))).toBe(true);
  });

  it("Q13b a throw at the first seat also yields a stopped report after one call", async () => {
    const { agent, calls } = fakeAgent(() => {
      throw new Error(BOOM);
    });
    const report = await runQueen(ARGS, agent);
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("agent-null");
    expect(report.stoppedAt).toBe("setup");
    expect(calls.length).toBe(1);
  });

  it("Q13c seam: a throwing run's report classifies as resume (agent-null)", async () => {
    const { agent } = fakeAgent((seat) => {
      if (seat === "coder") throw new Error(BOOM);
      return okHB(seat);
    });
    const report = await runQueen(ARGS, agent);
    const v = classifyNotification("hand", { status: "completed", result: JSON.stringify(report) });
    expect(v.action).toBe("resume");
    expect(v.reason).toBe("agent-null");
  });

  it("Q05 a designQuestion stops with design-decision and carries the question", async () => {
    const { agent, calls } = fakeAgent((seat) => (seat === "lead" ? okHB(seat, { designQuestion: "Which of the two shapes?" }) : okHB(seat)));
    const report = await runQueen(ARGS, agent);
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("design-decision");
    expect(report.detail).toBe("Which of the two shapes?");
    expect(calls.map((c) => c.seat)).toEqual(["setup", "research", "lead"]);
  });

  it("Q06 adversarial fakes still end within 20 calls", async () => {
    const blockerHB = (seat) =>
      seat === "reviewer"
        ? okHB(seat, { verdict: "fail", findings: [{ id: "F1", severity: "blocker", file: "a.mjs", description: "broken", evidence: "ran it, saw it fail" }] })
        : seat === "gate"
          ? okHB(seat, { commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 1 }], gateLine: "red" })
          : okHB(seat);
    const fakes = [
      blockerHB,
      (seat) => (seat === "gate" ? okHB(seat, { commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 1 }], gateLine: "red" }) : okHB(seat)),
      () => ({}),
      (seat) => okHB(seat === "setup" ? "gate" : "setup"),
      (seat) => okHB(seat, { blocked: "cannot go on" }),
    ];
    for (const respond of fakes) {
      const { agent, calls } = fakeAgent(respond);
      const report = await runQueen(ARGS, agent);
      expect(calls.length).toBeLessThanOrEqual(20);
      expect(report.outcome).toBe("stopped");
    }
  });

  it("Q07 the prompt is exactly briefPrompt(brief, { repoRoot, worktreePath })", async () => {
    const { agent, calls } = fakeAgent();
    await runQueen(ARGS, agent);
    for (const c of calls) expect(c.prompt, c.seat).toBe(briefPrompt(c.brief, { repoRoot: REPO, worktreePath: WT }));
  });

  it("Q08 every phase() title is one of meta.phases", async () => {
    const meta = loadMeta();
    expect(meta.name).toBe("card-queen");
    expect(typeof meta.description).toBe("string");
    expect(meta.phases.map((p) => p.title)).toEqual(["Setup", "Research", "Lead", "Tester", "Coder", "Reviewer", "Gate", "Commit"]);
    const phases = [];
    const { agent } = fakeAgent();
    await runQueen(ARGS, agent, phases);
    expect(phases.length).toBeGreaterThan(0);
    for (const t of phases) expect(meta.phases.map((p) => p.title)).toContain(t);
    // a phase() call written in the source names a title too
    for (const m of loadSource().matchAll(/phase\(\s*'([^']+)'/g)) expect(meta.phases.map((p) => p.title)).toContain(m[1]);
  });

  it("Q09 drift: the marker block equals inlineCardLoop(card-loop.mjs)", async () => {
    const { inlineCardLoop } = await loadSync();
    const lib = readFileSync(LIB, "utf8");
    const have = bare(blockOf(loadSource()));
    const want = bare(inlineCardLoop(lib));
    if (have !== want) {
      const a = have.split("\n");
      const b = want.split("\n");
      let i = 0;
      while (a[i] === b[i]) i++;
      throw new Error(`card-queen.js drifted from card-loop.mjs at block line ${i + 1}:\n  workflow: ${JSON.stringify(a[i])}\n  lib: ${JSON.stringify(b[i])}\n  fix: pnpm workflows:sync`);
    }
    expect(have).toBe(want);
    // the inlined body is the lib's, export keywords gone
    expect(want).not.toMatch(/^export\s/m);
    expect(want).toContain("function next(");
    expect(want).toContain("function briefPrompt(");
    expect(want).toContain("const SEAT_ROWS = {");
  });

  it("Q10 drift sensitivity: a one-character edit to the lib changes the inlined block", async () => {
    const { inlineCardLoop } = await loadSync();
    const lib = readFileSync(LIB, "utf8");
    const at = lib.indexOf("function next(");
    expect(at).toBeGreaterThan(0);
    const edited = lib.slice(0, at) + "function nexT(" + lib.slice(at + "function next(".length);
    expect(bare(inlineCardLoop(edited))).not.toBe(bare(inlineCardLoop(lib)));
    expect(bare(blockOf(loadSource()))).not.toBe(bare(inlineCardLoop(edited)));
  });

  it("Q10b syncCardLoop rewrites only the marker block, and is idempotent", async () => {
    const { inlineCardLoop, syncCardLoop } = await loadSync();
    const dir = mkdtempSync(join(tmpdir(), "doug-queen-"));
    const lib = join(dir, "card-loop.mjs");
    const workflow = join(dir, "card-queen.js");
    copyFileSync(LIB, lib);
    const head = "export const meta = { name: 'card-queen', description: 'x', phases: [{ title: 'Setup' }] }\n\n";
    const tail = "\n\nreturn { tail: true }\n";
    writeFileSync(workflow, `${head}${BEGIN}\nSTALE LINE\n${END}${tail}`);
    syncCardLoop({ lib, workflow });
    const once = readFileSync(workflow, "utf8");
    expect(once.startsWith(head + BEGIN)).toBe(true);
    expect(once.endsWith(END + tail)).toBe(true);
    expect(once).not.toContain("STALE LINE");
    expect(bare(blockOf(once))).toBe(bare(inlineCardLoop(readFileSync(lib, "utf8"))));
    syncCardLoop({ lib, workflow });
    expect(readFileSync(workflow, "utf8")).toBe(once);
  });

  it("Q11 the file has no import, Date, Math.random, process or model literal, and parses once wrapped", () => {
    const source = loadSource();
    expect(source.startsWith("export const meta = ")).toBe(true);
    expect(source).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(\)/);
    expect(source).not.toMatch(/^\s*import\s|\bimport\s*\(|\brequire\(|\bprocess\.\w|\bfs\.\w/m);
    expect(source).not.toMatch(/['"`](opus|sonnet|haiku|fable|codex)['"`]/);
    // only the meta export survives; every inlined `export ` is stripped
    expect(source.match(/^export\s/gm)).toEqual(["export "]);
    const { head, body } = split(source);
    const wrapped = head + "\nexport default async function run(args, agent, phase, log) {\n" + body + "\n}\n";
    const dir = mkdtempSync(join(tmpdir(), "doug-queen-wf-"));
    const file = join(dir, "wf.mjs");
    writeFileSync(file, wrapped);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("Q12 every agentType starts with doug-flow:, and the source names no other", async () => {
    const { agent, calls } = fakeAgent();
    await runQueen(ARGS, agent);
    for (const c of calls) expect(c.opts.agentType.startsWith("doug-flow:"), c.seat).toBe(true);
    const named = [...loadSource().matchAll(/['"`]([A-Za-z0-9_-]+:[a-z-]+)['"`]/g)].map((m) => m[1]).filter((n) => /^[a-z-]+:[a-z-]+$/.test(n) && !n.startsWith("doug-flow:"));
    // a '<x>:<y>' string that is not a doug-flow agent name may only be a label template, never an agentType
    for (const n of named) expect(source_hasAgentType(n), n).toBe(false);
  });
});

// Card queen-resume-with-answer: a Workflow resume replays every agent whose (prompt, opts) is unchanged. This fake keys a
// cache on prompt + JSON opts, shared across the first run and the resumed run.
describe("card queen-resume-with-answer: resume with the user's answer", () => {
  const QUESTION = "Which of the two shapes?";
  const ANSWER = "Use the flat shape.";
  const ANS = { seat: "tester", question: QUESTION, answer: ANSWER, round: 1, run: "wf_one" };

  function cachingAgent(cache, options, respond) {
    let mirror = initialState(CARD, options);
    const calls = [];
    const agent = async (prompt, opts) => {
      const action = currentAction(mirror);
      const seat = action.kind === "seat" ? action.seat : null;
      const key = prompt + "\u0000" + JSON.stringify(opts);
      const hit = cache.has(key);
      let hb;
      if (hit) hb = cache.get(key);
      else {
        hb = respond(seat, action.brief);
        cache.set(key, hb);
      }
      calls.push({ seat, prompt, opts, hit });
      if (action.kind === "seat") mirror = next(mirror, hb).state;
      return hb;
    };
    return { agent, calls };
  }
  const asks = (seat) => (seat === "tester" ? okHB(seat, { designQuestion: QUESTION }) : okHB(seat));
  const answersArgs = (answers) => ({ ...ARGS, options: { research: true, answers } });

  async function firstRun(cache) {
    const first = cachingAgent(cache, { research: true }, asks);
    const report = await runQueen(ARGS, first.agent);
    return { report, calls: first.calls };
  }

  it("Q14 a resume with the answer reaches the asking seat's prompt and the run continues to done", async () => {
    const cache = new Map();
    const { report: stopped } = await firstRun(cache);
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.reason).toBe("design-decision");
    expect(stopped.stoppedAt).toBe("tester");
    expect(stopped.detail).toBe(QUESTION);
    const resumed = cachingAgent(cache, { research: true, answers: [ANS] }, (seat) => okHB(seat));
    const report = await runQueen(answersArgs([ANS]), resumed.agent);
    expect(report.outcome).toBe("done");
    expect(report.commit).toBe("abc1234");
    expect(resumed.calls.map((c) => c.seat)).toEqual(SEATS_IN_ORDER);
    const tester = resumed.calls.find((c) => c.seat === "tester");
    expect(tester.prompt).toContain("ANSWERS FROM THE USER");
    expect(tester.prompt).toContain(`Q: ${QUESTION} A: ${ANSWER}`);
    expect(tester.hit).toBe(false);
    for (const c of resumed.calls.filter((x) => x.seat !== "tester")) expect(c.prompt, c.seat).not.toContain("ANSWERS FROM THE USER");
  });

  it("Q15 the seats before the asking seat replay from the cache with byte-identical prompts", async () => {
    const cache = new Map();
    const { calls: before } = await firstRun(cache);
    const resumed = cachingAgent(cache, { research: true, answers: [ANS] }, (seat) => okHB(seat));
    await runQueen(answersArgs([ANS]), resumed.agent);
    const misses = resumed.calls.filter((c) => !c.hit).map((c) => c.seat);
    expect(misses).toEqual(["tester", "coder", "reviewer", "gate", "commit"]);
    for (const seat of ["setup", "research", "lead"]) {
      const was = before.find((c) => c.seat === seat);
      const now = resumed.calls.find((c) => c.seat === seat);
      expect(now.hit, seat).toBe(true);
      expect(now.prompt, seat).toBe(was.prompt);
      expect(JSON.stringify(now.opts), seat).toBe(JSON.stringify(was.opts));
    }
  });

  it("Q16 a second question from the answered seat stops design-decision again, with no later seat called", async () => {
    const cache = new Map();
    await firstRun(cache);
    const again = cachingAgent(cache, { research: true, answers: [ANS] }, (seat) =>
      seat === "tester" ? okHB(seat, { designQuestion: "A different question?" }) : okHB(seat),
    );
    const report = await runQueen(answersArgs([ANS]), again.agent);
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("design-decision");
    expect(report.stoppedAt).toBe("tester");
    expect(report.detail).toBe("A different question?");
    expect(again.calls.map((c) => c.seat)).toEqual(["setup", "research", "lead", "tester"]);
    expect(again.calls.filter((c) => !c.hit).map((c) => c.seat)).toEqual(["tester"]);
  });
});

function source_hasAgentType(name) {
  return new RegExp(`agentType[^\\n]*['"\`]${name}['"\`]`).test(loadSource());
}

describe("card-queen inline research note", () => {
  it("Q17 a researcher's inline multi-line note reaches the lead seat and its prompt", async () => {
    const { agent, calls } = fakeAgent((seat) => (seat === "research" ? okHB(seat, { note: INLINE_NOTE }) : okHB(seat)));
    const report = await runQueen(ARGS, agent);
    expect(calls.map((c) => c.seat)).toEqual(SEATS_IN_ORDER);
    expect(report.outcome).toBe("done");
    const lead = calls.find((c) => c.seat === "lead");
    for (const line of INLINE_NOTE.split("\n")) expect(lead.prompt).toContain(line);
  });
});

// Card autopilot-no-stuck-in-flow: the inlined contract carries the gate-timeout stop and the gate brief rule.
describe("card-queen inlined gate-timeout", () => {
  it("the inlined copy names the gate-timeout stop reason and the gate-timeout-is-load rule", () => {
    const src = readFileSync(QUEEN, "utf8");
    expect(src).toContain('"gate-timeout"');
    expect(src).toContain("gate-timeout-is-load");
    expect(src).toContain("timedOut");
  });
});

// Card commit-seat-no-file-edits: the inlined contract stops a commit whose tree differs from the gated tree.
describe("card-queen commit tree", () => {
  it("Q18 a commit hand-back tree differing from the gate's stops commit-tree-mismatch at commit", async () => {
    const { agent, calls } = fakeAgent((seat) => (seat === "commit" ? okHB(seat, { tree: "b".repeat(40) }) : okHB(seat)));
    const report = await runQueen(ARGS, agent);
    expect(calls.map((c) => c.seat)).toEqual(SEATS_IN_ORDER);
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("commit-tree-mismatch");
    expect(report.stoppedAt).toBe("commit");
  });
});
