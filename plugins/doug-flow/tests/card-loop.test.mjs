import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEATS,
  STOP_REASONS,
  SEAT_ROWS,
  BRIEF_RULES,
  HAND_BACK_SCHEMAS,
  laneFor,
  initialState,
  currentAction,
  next,
  validateHandBack,
  briefPrompt,
} from "../lib/card-loop.mjs";

// Card card-loop-contract: the hand card loop as a host-neutral contract. next(state, handBack) is pure;
// these tests drive it with fake hand-backs, no host. Design: .doug/.state/reports/card-loop-contract/design.md.

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib", "card-loop.mjs");
const CONTRACT_DOC = join(HERE, "..", "..", "..", "docs", "worker-contract.md");

const CARD = { id: "c1", title: "A card", size: "M", class: "code", goal: "Do the thing exactly." };
const LESSONS = "LESSONS BLOCK verbatim\nline two";
const FACTS = [{ text: "the fact", source: "docs/x.md:3" }];
const MUT = [{ id: "M1", case: "case one", mutation: "remove the check", test: "T01" }];
const WT = "/abs/worktree/c1";
const NOTE = "/abs/note.md";

const seenReasons = new Set();

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const blocker = (over = {}) => ({
  id: "F1",
  severity: "blocker",
  file: "a.mjs",
  description: "it is broken",
  evidence: "ran the test, saw it fail",
  ...over,
});

// A valid hand-back for a seat, given the state it answers. `over` is merged on top; an undefined value deletes the key.
function okHB(seat, state, over = {}) {
  const lean = state.lane === "lean";
  const base = {
    setup: {
      worktree: WT,
      branch: "card/c1",
      install: state.install ? { command: state.install, exitCode: 0 } : null,
    },
    research: { note: NOTE },
    lead: { lessons: LESSONS, facts: FACTS, unverified: [], testFiles: ["a.test.mjs"], mutations: MUT },
    tester: {
      files: ["a.test.mjs"],
      tests_red_by_design: ["a.test.mjs"],
      mutationResults: [{ id: "M1", failed: true, test: "T01", assertion: "expected x" }],
    },
    coder: {
      filesChanged: ["a.mjs"],
      commandsRun: [{ command: "pnpm exec vitest run a.test.mjs", exitCode: 0 }],
      testsEdited: [],
      ...(lean ? {} : { mutationResults: [{ id: "M1", failed: true, test: "T01", assertion: "expected x" }] }),
    },
    reviewer: {
      verdict: "pass",
      findings: [],
      commandsRun: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }],
      mutationResults: lean ? [] : [{ id: "M1", failed: true, test: "T01" }],
    },
    gate: {
      commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }],
      gateLine: "typecheck ok; test:unit ok 100 passed",
    },
    commit: { sha: "abc1234", branch: "card/c1" },
  }[seat];
  const hb = { seat, ...base, ...over };
  for (const k of Object.keys(hb)) if (hb[k] === undefined) delete hb[k];
  return hb;
}

function go(state, hb) {
  const r = next(state, hb);
  if (r.action.kind === "stopped") seenReasons.add(r.action.reason);
  return r;
}

function ok(state, over = {}) {
  return go(state, okHB(state.pending, state, over));
}

// Drive the happy path until `seat` is pending.
function stateAt(seat, card = CARD, options = {}) {
  let state = initialState(card, options);
  let guard = 0;
  while (state.pending !== seat) {
    if (guard++ > 40) throw new Error("never reached " + seat);
    state = ok(state).state;
  }
  return state;
}

// Walk to the end with the happy path; `overrides` maps "<seat>#<n>" (n-th run, from 1) to an override object.
function walk(card = CARD, options = {}, overrides = {}) {
  let state = initialState(card, options);
  const seats = [];
  const actions = [currentAction(state)];
  const runs = {};
  let guard = 0;
  while (state.pending) {
    if (guard++ > 40) throw new Error("walk did not terminate");
    const seat = state.pending;
    seats.push(seat);
    runs[seat] = (runs[seat] || 0) + 1;
    const r = ok(state, overrides[seat + "#" + runs[seat]] || {});
    state = r.state;
    actions.push(r.action);
  }
  return { state, seats, actions, last: actions[actions.length - 1] };
}

describe("lanes", () => {
  it("T01 laneFor picks the lane from class and size", () => {
    expect(laneFor({ ...CARD, class: "tests-only" })).toBe("tests-only");
    expect(laneFor({ ...CARD, size: "S", class: "prose" })).toBe("lean");
    expect(laneFor({ ...CARD, size: "S", class: "docs" })).toBe("lean");
    expect(laneFor({ ...CARD, size: "M", class: "prose" })).toBe("full");
    expect(laneFor({ ...CARD, size: "S", class: "code" })).toBe("full");
    expect(laneFor({ id: "x", goal: "g" })).toBe("full");
    expect(laneFor({ id: "x", goal: "g", size: "S" })).toBe("full");
    expect(laneFor({ id: "x", goal: "g", class: "docs" })).toBe("full");
  });

  it("T02 full lane happy path runs setup, lead, tester, coder, reviewer, gate, commit, then done", () => {
    const { seats, last, state } = walk();
    expect(seats).toEqual(["setup", "lead", "tester", "coder", "reviewer", "gate", "commit"]);
    expect(last.kind).toBe("done");
    expect(state.pending).toBeNull();
    expect(state.counters).toEqual({ coderRounds: 1, fixPasses: 0, redGates: 0 });
  });

  it("T03 lean lane has no tester; the coder writes tests first; no mutations", () => {
    const lean = { ...CARD, size: "S", class: "docs" };
    const { seats, actions, last } = walk(lean);
    expect(seats).toEqual(["setup", "lead", "coder", "reviewer", "gate", "commit"]);
    expect(last.kind).toBe("done");
    const coder = actions.find((a) => a.kind === "seat" && a.seat === "coder");
    const reviewer = actions.find((a) => a.kind === "seat" && a.seat === "reviewer");
    expect(coder.brief.writeTestsFirst).toBe(true);
    expect(coder.brief.mutations).toEqual([]);
    expect(reviewer.brief.mutations).toEqual([]);
  });

  it("T04 tests-only lane runs tester then reviewer and never the coder", () => {
    const t = { ...CARD, class: "tests-only" };
    const { seats, last } = walk(t);
    expect(seats).toEqual(["setup", "lead", "tester", "reviewer", "gate", "commit"]);
    expect(seats).not.toContain("coder");
    expect(last.kind).toBe("done");
  });

  it("T05 testerAgent false: full gives the coder with writeTestsFirst; tests-only gives coder then reviewer", () => {
    const noMut = { lead: { mutations: [] } };
    const full = walk(CARD, { testerAgent: false }, { "lead#1": noMut.lead, "reviewer#1": { mutationResults: [] }, "coder#1": { mutationResults: undefined } });
    expect(full.seats).toEqual(["setup", "lead", "coder", "reviewer", "gate", "commit"]);
    const coder = full.actions.find((a) => a.kind === "seat" && a.seat === "coder");
    expect(coder.brief.writeTestsFirst).toBe(true);

    const t = { ...CARD, class: "tests-only" };
    const only = walk(t, { testerAgent: false }, { "lead#1": noMut.lead, "reviewer#1": { mutationResults: [] }, "coder#1": { mutationResults: undefined } });
    expect(only.seats).toEqual(["setup", "lead", "coder", "reviewer", "gate", "commit"]);
    expect(only.seats).not.toContain("tester");
  });

  it("T06 research true runs setup, research, lead, and the note path reaches later briefs", () => {
    const { seats, actions } = walk(CARD, { research: true });
    expect(seats.slice(0, 3)).toEqual(["setup", "research", "lead"]);
    const tester = actions.find((a) => a.kind === "seat" && a.seat === "tester");
    const reviewer = actions.find((a) => a.kind === "seat" && a.seat === "reviewer");
    expect(tester.brief.researchNote).toBe(NOTE);
    expect(reviewer.brief.researchNote).toBe(NOTE);
  });
});

describe("briefs", () => {
  it("T07 the first action is setup with install, branch, base and a null worktree", () => {
    const s = initialState(CARD, { install: "pnpm install --frozen-lockfile" });
    const a = currentAction(s);
    expect(a.kind).toBe("seat");
    expect(a.seat).toBe("setup");
    expect(a.brief.install).toBe("pnpm install --frozen-lockfile");
    expect(a.brief.branch).toBe("card/c1");
    expect(a.brief.base).toBe("main");
    expect(a.brief.worktree).toBeNull();
    expect(a.brief.card.goal).toBe(CARD.goal);
    const d = currentAction(initialState(CARD));
    expect(d.brief.install).toBeNull();
  });

  it("T08 every brief after setup carries the setup's absolute worktree and branch", () => {
    const { actions } = walk();
    const seatActions = actions.filter((a) => a.kind === "seat" && a.seat !== "setup");
    expect(seatActions.length).toBeGreaterThan(4);
    for (const a of seatActions) {
      expect(a.brief.worktree).toBe(WT);
      expect(a.brief.branch).toBe("card/c1");
    }
  });

  it("T09 tester, coder and reviewer briefs carry the lead's lessons verbatim and the facts with sources", () => {
    const { actions } = walk();
    for (const seat of ["tester", "coder", "reviewer"]) {
      const a = actions.find((x) => x.kind === "seat" && x.seat === seat);
      expect(a.brief.lessons).toBe(LESSONS);
      expect(a.brief.facts).toEqual(FACTS);
      expect(a.brief.testFiles).toEqual(["a.test.mjs"]);
    }
    const coder = actions.find((x) => x.kind === "seat" && x.seat === "coder");
    expect(coder.brief.mutations).toEqual(MUT);
  });

  it("T10 rule ids per seat match the BRIEF_RULES table", () => {
    const { actions } = walk();
    const ids = (seat) => actions.find((x) => x.kind === "seat" && x.seat === seat).brief.rules.map((r) => r.id);
    for (const seat of ["setup", "lead", "tester", "coder", "reviewer", "gate", "commit"]) {
      expect(ids(seat)).toEqual(expect.arrayContaining(["absolute-paths", "git-alone", "hook-block-report"]));
    }
    for (const seat of ["tester", "coder", "reviewer"]) expect(ids(seat)).toContain("stay-in-goal");
    expect(ids("lead")).toEqual(expect.arrayContaining(["lessons-verbatim", "facts-cited", "mutation-per-case"]));
    expect(ids("tester")).toContain("red-claim");
    expect(ids("coder")).toContain("no-test-edit-without-reason");
    expect(ids("coder")).toContain("mutations-in-scratch");
    expect(ids("reviewer")).toEqual(expect.arrayContaining(["mutations-in-scratch", "reviewer-reruns-mutations"]));
    expect(ids("commit")).toEqual(expect.arrayContaining(["no-trailers", "leave-plan-anchor-out"]));
    expect(ids("commit")).toEqual(expect.arrayContaining(["commit-foreground", "commit-no-background", "commit-sha-from-git-log"]));
    {
      const commit = actions.find((x) => x.kind === "seat" && x.seat === "commit").brief.rules;
      const text = (id) => commit.find((r) => r.id === id).text;
      expect(text("commit-foreground")).toContain("Run git commit in the foreground with the Bash tool timeout set to 600000 ms");
      expect(text("commit-no-background")).toContain("Never use run_in_background, a Monitor, or a sleep loop for git commit");
      expect(text("commit-sha-from-git-log")).toContain("Report the sha only from git log -1 --format=%H after git commit has returned");
    }
    for (const id of ["commit-foreground", "commit-no-background", "commit-sha-from-git-log"]) expect(ids("coder")).not.toContain(id);
    expect(ids("coder")).not.toContain("red-claim");
    expect(ids("reviewer")).not.toContain("no-test-edit-without-reason");
    expect(ids("tester")).not.toContain("no-trailers");
    expect(ids("lead")).not.toContain("stay-in-goal");
    expect(ids("tester")).not.toContain("tests-only-no-production-edit");
    for (const r of Object.values(BRIEF_RULES)) {
      expect(typeof r.text).toBe("string");
      expect(r.text.length).toBeGreaterThan(0);
    }
    const t = walk({ ...CARD, class: "tests-only" });
    const tester = t.actions.find((x) => x.kind === "seat" && x.seat === "tester");
    const tids = tester.brief.rules.map((r) => r.id);
    expect(tids).toContain("tests-only-no-production-edit");
    expect(tids).not.toContain("red-claim");
  });

  it("T11 each brief's row and handBack come from SEAT_ROWS and HAND_BACK_SCHEMAS", () => {
    const { actions } = walk(CARD, { research: true });
    const seatActions = actions.filter((a) => a.kind === "seat");
    expect(new Set(seatActions.map((a) => a.seat))).toEqual(new Set(SEATS));
    for (const a of seatActions) {
      expect(a.brief.seat).toBe(a.seat);
      expect(a.brief.row).toBe(SEAT_ROWS[a.seat]);
      expect(a.brief.handBack).toEqual(HAND_BACK_SCHEMAS[a.seat]);
    }
    expect(SEAT_ROWS.tester).toBe("implement");
    expect(SEAT_ROWS.coder).toBe("implement");
    expect(SEAT_ROWS.reviewer).toBe("review");
    expect(SEAT_ROWS.research).toBe("plan");
    expect(SEAT_ROWS.lead).toBe("lead");
  });

  it("T12 the coder brief on the full lane carries redTests from the tester's claim", () => {
    const { actions } = walk(CARD, {}, { "tester#1": { tests_red_by_design: ["a.test.mjs", "b.test.mjs"] } });
    const coder = actions.find((x) => x.kind === "seat" && x.seat === "coder");
    expect(coder.brief.redTests).toEqual(["a.test.mjs", "b.test.mjs"]);
  });
});

describe("transitions", () => {
  it("T13 a missing tester red claim stops with tester-red-claim-missing", () => {
    const s = stateAt("tester");
    const r = go(s, okHB("tester", s, { tests_red_by_design: undefined }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("tester-red-claim-missing");
  });

  it("T14 a claim of [] or [''] also counts as missing", () => {
    const s = stateAt("tester");
    for (const claim of [[], [""]]) {
      const r = go(s, okHB("tester", s, { tests_red_by_design: claim }));
      expect(r.action.kind).toBe("stopped");
      expect(r.action.reason).toBe("tester-red-claim-missing");
    }
  });

  it("T15 a reviewer blocker on the first review sends one fix pass to the coder, then back to the reviewer", () => {
    const s = stateAt("reviewer");
    const r = go(s, okHB("reviewer", s, { verdict: "fail", findings: [blocker()] }));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.action.brief.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(r.state.counters.fixPasses).toBe(1);
    expect(r.state.fixFor).toBe("review");
    const c = ok(r.state);
    expect(c.action.kind).toBe("seat");
    expect(c.action.seat).toBe("reviewer");
  });

  it("T16 a blocker still open after one fix pass stops with reviewer-blocker-open", () => {
    const s = stateAt("reviewer");
    const r1 = go(s, okHB("reviewer", s, { verdict: "fail", findings: [blocker()] }));
    const r2 = ok(r1.state);
    const r3 = go(r2.state, okHB("reviewer", r2.state, { verdict: "fail", findings: [blocker({ id: "F2" })] }));
    expect(r3.action.kind).toBe("stopped");
    expect(r3.action.reason).toBe("reviewer-blocker-open");
    expect(r3.state.counters.fixPasses).toBe(1);
  });

  it("T17 minors and majors only proceed to the gate and are recorded in the report", () => {
    const major = { id: "F2", severity: "major", file: "b.mjs", description: "meh" };
    const minor = { id: "F3", severity: "minor", file: "c.mjs", description: "nit" };
    const { last, seats } = walk(CARD, {}, { "reviewer#1": { findings: [major, minor] } });
    expect(seats).toEqual(["setup", "lead", "tester", "coder", "reviewer", "gate", "commit"]);
    expect(last.kind).toBe("done");
    const got = last.report.review.findings;
    expect(got.map((f) => f.id)).toEqual(["F2", "F3"]);
    expect(got.map((f) => f.severity)).toEqual(["major", "minor"]);
    expect(got[0].round).toBe(1);
  });

  it("T18 a blocker with blank evidence is downgraded to major and the card proceeds", () => {
    for (const evidence of ["", "   ", undefined]) {
      const { seats, last } = walk(CARD, {}, {
        "reviewer#1": { verdict: "fail", findings: [blocker({ evidence })] },
      });
      expect(seats).toEqual(["setup", "lead", "tester", "coder", "reviewer", "gate", "commit"]);
      expect(last.kind).toBe("done");
      expect(last.report.review.downgraded.map((d) => d.id)).toEqual(["F1"]);
      expect(last.report.review.findings.find((f) => f.id === "F1").severity).toBe("major");
    }
  });

  it("T19 a fail verdict with no blocker proceeds to the gate", () => {
    const minor = { id: "F3", severity: "minor", file: "c.mjs", description: "nit" };
    const s = stateAt("reviewer");
    const r = go(s, okHB("reviewer", s, { verdict: "fail", findings: [minor] }));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("gate");
  });

  it("T20 the first red gate goes to the coder with the gate output, then reviewer, then gate", () => {
    const s = stateAt("gate");
    const red = { commands: [{ command: "pnpm typecheck", exitCode: 2 }], gateLine: "typecheck failed" };
    const r = go(s, okHB("gate", s, red));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.action.brief.gate).toBeTruthy();
    expect(r.state.fixFor).toBe("gate");
    expect(r.state.counters.redGates).toBe(1);
    const c = ok(r.state);
    expect(c.action.seat).toBe("reviewer");
    const v = ok(c.state);
    expect(v.action.seat).toBe("gate");
  });

  it("T21 the second red gate stops with gate-red-twice", () => {
    const s = stateAt("gate");
    const red = { commands: [{ command: "pnpm typecheck", exitCode: 2 }], gateLine: "typecheck failed" };
    const r1 = go(s, okHB("gate", s, red));
    const r2 = ok(ok(r1.state).state);
    expect(r2.action.seat).toBe("gate");
    const r3 = go(r2.state, okHB("gate", r2.state, red));
    expect(r3.action.kind).toBe("stopped");
    expect(r3.action.reason).toBe("gate-red-twice");
    expect(r3.state.counters.redGates).toBe(2);
  });

  it("T22 a null exit code counts as red", () => {
    const s = stateAt("gate");
    const r = go(s, okHB("gate", s, { commands: [{ command: "pnpm test:unit", exitCode: null }] }));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.state.counters.redGates).toBe(1);
  });

  it("T23 on the tests-only lane a fix pass after a review blocker goes to the tester", () => {
    const s = stateAt("reviewer", { ...CARD, class: "tests-only" });
    const r = go(s, okHB("reviewer", s, { verdict: "fail", findings: [blocker()] }));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("tester");
    expect(r.action.brief.findings.map((f) => f.id)).toEqual(["F1"]);
    const back = ok(r.state);
    expect(back.action.seat).toBe("reviewer");
  });

  it("T24 after a gate fix a reviewer blocker still gets one review fix pass", () => {
    const s = stateAt("gate");
    const r1 = go(s, okHB("gate", s, { commands: [{ command: "c", exitCode: 1 }], gateLine: "red" }));
    const r2 = ok(r1.state);
    expect(r2.action.seat).toBe("reviewer");
    const r3 = go(r2.state, okHB("reviewer", r2.state, { verdict: "fail", findings: [blocker()] }));
    expect(r3.action.kind).toBe("seat");
    expect(r3.action.seat).toBe("coder");
    expect(r3.state.counters.fixPasses).toBe(1);
    expect(r3.state.counters.redGates).toBe(1);
    expect(r3.state.fixFor).toBe("review");
  });
});

describe("stop reasons", () => {
  it("T25 a null or undefined hand-back stops with agent-null at each of the eight seats", () => {
    const stateFor = (seat) => stateAt(seat, CARD, { research: true });
    for (const seat of SEATS) {
      const s = stateFor(seat);
      for (const hb of [null, undefined]) {
        const r = go(s, hb);
        expect(r.action.kind).toBe("stopped");
        expect(r.action.reason).toBe("agent-null");
        expect(r.action.report.stoppedAt).toBe(seat);
      }
    }
  });

  it("T26 hookBlocked stops with hook-blocked at the coder and at commit; detail is the message", () => {
    for (const seat of ["coder", "commit"]) {
      const s = stateAt(seat);
      const r = go(s, okHB(seat, s, { hookBlocked: { message: "protect-paths refused the edit" } }));
      expect(r.action.kind).toBe("stopped");
      expect(r.action.reason).toBe("hook-blocked");
      expect(r.action.report.detail).toContain("protect-paths refused the edit");
      expect(r.action.report.stoppedAt).toBe(seat);
    }
  });

  it("T27 designQuestion at the lead stops with design-decision; detail is the question", () => {
    const s = stateAt("lead");
    const r = go(s, { seat: "lead", designQuestion: "Which of the two shapes?" });
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("design-decision");
    expect(r.action.report.detail).toContain("Which of the two shapes?");
  });

  it("T28 a coder with blocked stops with seat-blocked", () => {
    const s = stateAt("coder");
    const r = go(s, { seat: "coder", blocked: "cannot install the dependency" });
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("seat-blocked");
    expect(r.action.report.detail).toContain("cannot install the dependency");
  });

  it("T29 an install exit 1 at setup stops with setup-failed", () => {
    const s = initialState(CARD, { install: "pnpm install" });
    const r = go(s, okHB("setup", s, { install: { command: "pnpm install", exitCode: 1 } }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("setup-failed");
  });

  it("T30 precedence: hookBlocked beats designQuestion, designQuestion beats blocked", () => {
    const s = stateAt("coder");
    const a = go(s, okHB("coder", s, { hookBlocked: { message: "m" }, designQuestion: "q?" }));
    expect(a.action.reason).toBe("hook-blocked");
    const b = go(s, okHB("coder", s, { designQuestion: "q?", blocked: "b" }));
    expect(b.action.reason).toBe("design-decision");
    const c = go(s, okHB("coder", s, { hookBlocked: { message: "m" }, designQuestion: "q?", blocked: "b" }));
    expect(c.action.reason).toBe("hook-blocked");
  });

  it("T31 a seat mismatch or a non-object hand-back stops with hand-back-invalid", () => {
    const s = initialState(CARD);
    const wrongSeat = go(s, okHB("lead", stateAt("lead")));
    expect(wrongSeat.action.kind).toBe("stopped");
    expect(wrongSeat.action.reason).toBe("hand-back-invalid");
    const notObject = go(s, 42);
    expect(notObject.action.reason).toBe("hand-back-invalid");
    const schemaBad = go(stateAt("commit"), { seat: "commit", sha: "not-a-sha", branch: "b" });
    expect(schemaBad.action.reason).toBe("hand-back-invalid");
  });
});

describe("validator", () => {
  it("T33 a valid hand-back for each seat returns no errors", () => {
    for (const seat of SEATS) {
      const s = stateAt(seat, CARD, { research: true });
      expect(validateHandBack(s, okHB(seat, s))).toEqual([]);
    }
    const s = stateAt("reviewer");
    const own = okHB("reviewer", s, {
      mutationResults: [
        { id: "M1", failed: true, test: "T01" },
        { id: "X", failed: true, test: "T02", own: true },
      ],
    });
    expect(validateHandBack(s, own)).toEqual([]);
  });

  const cases = [
    ["a relative worktree", "setup", (s) => okHB("setup", s, { worktree: "rel/path" })],
    ["a test edit without a reason", "coder", (s) => okHB("coder", s, { testsEdited: [{ file: "a.test.mjs", reason: "" }] })],
    ["a test edit with no reason key", "coder", (s) => okHB("coder", s, { testsEdited: [{ file: "a.test.mjs" }] })],
    ["a fact without a source", "lead", (s) => okHB("lead", s, { facts: [{ text: "f" }] })],
    ["a duplicate mutation id", "lead", (s) => okHB("lead", s, { mutations: [...MUT, { ...MUT[0] }] })],
    ["a non-integer exitCode", "coder", (s) => okHB("coder", s, { commandsRun: [{ command: "c", exitCode: "0" }] })],
    ["a fractional exitCode", "gate", (s) => okHB("gate", s, { commands: [{ command: "c", exitCode: 1.5 }] })],
    ["a severity of critical", "reviewer", (s) => okHB("reviewer", s, { verdict: "fail", findings: [blocker({ severity: "critical" })] })],
    ["a verdict of PASS", "reviewer", (s) => okHB("reviewer", s, { verdict: "PASS" })],
    ["a bad sha", "commit", (s) => okHB("commit", s, { sha: "xyz" })],
    ["an empty gateLine", "gate", (s) => okHB("gate", s, { gateLine: "" })],
    ["an empty gate command list", "gate", (s) => okHB("gate", s, { commands: [] })],
    ["a first-round coder missing a listed mutation", "coder", (s) => okHB("coder", s, { mutationResults: [] })],
    ["a reviewer missing a listed mutation id", "reviewer", (s) => okHB("reviewer", s, { mutationResults: [] })],
    ["an extra reviewer mutation id without own", "reviewer", (s) =>
      okHB("reviewer", s, {
        mutationResults: [
          { id: "M1", failed: true, test: "T01" },
          { id: "X", failed: true, test: "T02" },
        ],
      })],
    ["a pass verdict with an evidenced blocker", "reviewer", (s) => okHB("reviewer", s, { verdict: "pass", findings: [blocker()] })],
    ["a tester with no files", "tester", (s) => okHB("tester", s, { files: [] })],
    ["a seat that is not the pending one", "coder", (s) => okHB("tester", s)],
  ];
  it.each(cases)("T34 rejects %s", (_name, seat, make) => {
    const s = stateAt(seat);
    const errors = validateHandBack(s, make(s));
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(typeof e).toBe("string");
  });

  it("T34 the tests-only tester's first run must cover every listed mutation", () => {
    const s = stateAt("tester", { ...CARD, class: "tests-only" });
    const errors = validateHandBack(s, okHB("tester", s, { mutationResults: [] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("T35 the validator never throws on odd input", () => {
    const s = stateAt("coder");
    for (const bad of [42, "x", [], {}, { seat: {} }, { seat: "coder", testsEdited: 5 }, true]) {
      let out;
      expect(() => {
        out = validateHandBack(s, bad);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("report and purity", () => {
  it("T36 the done report carries commit, branch, gate line, rounds, counters, every round's findings, followUps and cost null", () => {
    const major = { id: "F2", severity: "major", file: "b.mjs", description: "meh" };
    const { last } = walk(CARD, {}, {
      "coder#1": { leftOut: ["fu1"] },
      "reviewer#1": { verdict: "fail", findings: [blocker()], leftOut: ["fu1", "fu2"] },
      "reviewer#2": { findings: [major] },
      "commit#1": { sha: "def5678abc", branch: "card/c1" },
    });
    expect(last.kind).toBe("done");
    const r = last.report;
    expect(r.outcome).toBe("done");
    expect(r.reason).toBeNull();
    expect(r.card.id).toBe("c1");
    expect(r.lane).toBe("full");
    expect(r.commit).toBe("def5678abc");
    expect(r.branch).toBe("card/c1");
    expect(r.worktree).toBe(WT);
    expect(r.gateLine).toBe("typecheck ok; test:unit ok 100 passed");
    expect(r.rounds).toBe(2);
    expect(r.counters).toEqual({ coderRounds: 2, fixPasses: 1, redGates: 0 });
    expect(r.review.findings.map((f) => [f.round, f.id, f.severity])).toEqual([
      [1, "F1", "blocker"],
      [2, "F2", "major"],
    ]);
    expect(r.followUps).toEqual(["fu1", "fu2"]);
    expect(r.cost).toBeNull();
    expect(r.mutations.map((m) => m.id)).toEqual(["M1"]);
  });

  it("T37 the stopped report carries reason, stoppedAt, detail and a null commit", () => {
    const s = stateAt("coder");
    const r = go(s, okHB("coder", s, { hookBlocked: { message: "guard-bash denied it" } }));
    const rep = r.action.report;
    expect(rep.outcome).toBe("stopped");
    expect(rep.reason).toBe("hook-blocked");
    expect(rep.stoppedAt).toBe("coder");
    expect(rep.detail).toContain("guard-bash denied it");
    expect(rep.commit).toBeNull();
    expect(rep.branch).toBe("card/c1");
    const g = stateAt("gate");
    const red = { commands: [{ command: "c", exitCode: 1 }], gateLine: "red" };
    const r1 = go(g, okHB("gate", g, red));
    const r2 = ok(ok(r1.state).state);
    const r3 = go(r2.state, okHB("gate", r2.state, red));
    expect(r3.action.report.reason).toBe("gate-red-twice");
    expect(r3.action.report.stoppedAt).toBe("gate");
    expect(r3.action.report.commit).toBeNull();
  });

  it("T38 next is pure: frozen inputs, deterministic, JSON-safe, idempotent on a terminal state", () => {
    const s = stateAt("reviewer");
    const hb = okHB("reviewer", s, { verdict: "fail", findings: [blocker()] });
    const before = JSON.stringify({ s, hb });
    const frozenState = deepFreeze(JSON.parse(JSON.stringify(s)));
    const frozenHb = deepFreeze(JSON.parse(JSON.stringify(hb)));
    let a;
    expect(() => {
      a = next(frozenState, frozenHb);
    }).not.toThrow();
    expect(JSON.stringify({ s: frozenState, hb: frozenHb })).toBe(before);
    expect(JSON.stringify({ s, hb })).toBe(before);
    expect(next(s, hb)).toEqual(a);
    expect(next(s, hb)).toEqual(next(s, hb));
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
    expect(next(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(hb)))).toEqual(a);

    const { state: term, last } = walk();
    expect(last.kind).toBe("done");
    const again = next(term, okHB("commit", term));
    expect(again.action).toEqual(last);
    expect(again.state).toEqual(term);
    expect(currentAction(term)).toEqual(last);
    const stoppedState = go(stateAt("coder"), null);
    const stoppedAgain = next(stoppedState.state, { seat: "coder" });
    expect(stoppedAgain.action).toEqual(stoppedState.action);
    expect(stoppedAgain.state).toEqual(stoppedState.state);
  });

  it("T39 the source imports nothing and uses no clock, random, process or globalThis", () => {
    const raw = readFileSync(LIB, "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bDate\b/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\bprocess\./);
    expect(src).not.toMatch(/\bglobalThis\b/);
  });

  it("T40 docs/worker-contract.md names every seat and stop reason", () => {
    const doc = readFileSync(CONTRACT_DOC, "utf8");
    expect(doc).toContain("Card seats (card-loop.mjs)");
    for (const seat of SEATS) expect(doc, "seat " + seat).toContain(seat);
    for (const reason of STOP_REASONS) expect(doc, "reason " + reason).toContain(reason);
  });
});

describe("fix-pass review follow-ups", () => {
  it("T41 a fix pass carries blockers and majors but not minors", () => {
    const major = { id: "F2", severity: "major", file: "b.mjs", description: "meh" };
    const minor = { id: "F3", severity: "minor", file: "c.mjs", description: "nit" };
    const s = stateAt("reviewer");
    const r = go(s, okHB("reviewer", s, { verdict: "fail", findings: [blocker(), major, minor] }));
    expect(r.state.lastFindings.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(r.action.brief.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
  });

  it("T42 each seat's schema allows only that seat", () => {
    for (const seat of SEATS) expect(HAND_BACK_SCHEMAS[seat].properties.seat.enum).toEqual([seat]);
  });

  it("T43 the reviewer schema allows null evidence, as the validator does (missing or blank evidence is a downgrade, not an error)", () => {
    const ev = HAND_BACK_SCHEMAS.reviewer.properties.findings.items.properties.evidence;
    expect(ev.type).toEqual(["string", "null"]);
    const s = stateAt("reviewer");
    expect(validateHandBack(s, okHB("reviewer", s, { verdict: "fail", findings: [blocker({ evidence: null })] }))).toEqual([]);
  });

  it("T44 tests-only lane without a tester agent: the coder takes the tester's role", () => {
    const t = { ...CARD, class: "tests-only" };
    const s = stateAt("coder", t, { testerAgent: false });
    const brief = currentAction(s).brief;
    const ids = brief.rules.map((r) => r.id);
    expect(ids).toContain("tests-only-no-production-edit");
    expect(ids).toContain("mutations-in-scratch");
    expect(validateHandBack(s, okHB("coder", s, { mutationResults: [] })).length).toBeGreaterThan(0);
    expect(validateHandBack(s, okHB("coder", s))).toEqual([]);
    const full = stateAt("coder");
    expect(currentAction(full).brief.rules.map((r) => r.id)).not.toContain("tests-only-no-production-edit");
  });
});

describe("B8 lock wait and briefPrompt", () => {
  const REPO = "/abs/repo";
  const WTP = REPO + "/.claude/worktrees/card-c1";
  const hasJson = (text, v) => text.includes(JSON.stringify(v)) || text.includes(JSON.stringify(v, null, 2));

  it("T46 lockWaitMs is an optional integer-or-null gate field, summed into the report (absent counts 0)", () => {
    const prop = HAND_BACK_SCHEMAS.gate.properties.lockWaitMs;
    expect(prop).toBeTruthy();
    expect(prop.type).toEqual(["integer", "null"]);
    expect(HAND_BACK_SCHEMAS.gate.required).not.toContain("lockWaitMs");
    const g = stateAt("gate");
    expect(validateHandBack(g, okHB("gate", g))).toEqual([]);
    expect(validateHandBack(g, okHB("gate", g, { lockWaitMs: null }))).toEqual([]);
    expect(validateHandBack(g, okHB("gate", g, { lockWaitMs: 1200 }))).toEqual([]);
    // red then green: 1200 + 800
    const red = { commands: [{ command: "c", exitCode: 1 }], gateLine: "red", lockWaitMs: 1200 };
    const r1 = go(g, okHB("gate", g, red));
    const r2 = ok(ok(r1.state).state);
    const done = go(r2.state, okHB("gate", r2.state, { lockWaitMs: 800 }));
    const g3 = ok(done.state);
    expect(g3.action.kind).toBe("done");
    expect(g3.action.report.lockWaitMs).toBe(2000);
    // absent and null count 0
    const none = ok(ok(stateAt("gate")).state);
    expect(none.action.report.lockWaitMs).toBe(0);
    const nul = ok(ok(stateAt("gate"), { lockWaitMs: null }).state);
    expect(nul.action.report.lockWaitMs).toBe(0);
    // a stopped report carries the sum too
    const s = stateAt("gate");
    const a = go(s, okHB("gate", s, { ...red, lockWaitMs: 500 }));
    const b = ok(ok(a.state).state);
    const c = go(b.state, okHB("gate", b.state, { ...red, lockWaitMs: 700 }));
    expect(c.action.kind).toBe("stopped");
    expect(c.action.report.lockWaitMs).toBe(1200);
  });

  it("T47 briefPrompt is deterministic and carries the worktree path, every rule, the material and the hand-back schema", () => {
    expect(typeof briefPrompt).toBe("function");
    const opts = { repoRoot: REPO, worktreePath: WTP };
    for (const seat of SEATS) {
      const s = stateAt(seat, CARD, seat === "research" ? { research: true } : {});
      const brief = deepFreeze(currentAction(s).brief);
      const a = briefPrompt(brief, opts);
      expect(typeof a).toBe("string");
      expect(a).toBe(briefPrompt(brief, { ...opts }));
      expect(a).toContain(WTP);
      for (const r of brief.rules) expect(a).toContain(r.text);
      expect(hasJson(a, brief.handBack)).toBe(true);
      expect(a).toContain(brief.card.goal);
    }
    // lessons, facts with sources, mutation list reach a seat that works from them
    const co = currentAction(stateAt("coder")).brief;
    const t = briefPrompt(co, opts);
    expect(t).toContain("LESSONS BLOCK verbatim");
    expect(t).toContain("the fact");
    expect(t).toContain("docs/x.md:3");
    expect(t).toContain("M1");
    expect(t).toContain("remove the check");
    expect(t).toContain("T01");
  });

  it("T47 the setup seat's text names git worktree add with the repo root, branch, worktree path and base, then the install command", () => {
    const s = initialState(CARD, { install: "pnpm install --frozen-lockfile" });
    const brief = currentAction(s).brief;
    const t = briefPrompt(brief, { repoRoot: REPO, worktreePath: WTP });
    const add = `git -C ${REPO} worktree add -b card/c1 ${WTP} main`;
    expect(t).toContain(add);
    expect(t.indexOf("pnpm install --frozen-lockfile")).toBeGreaterThan(t.indexOf(add));
    const other = briefPrompt(brief, { repoRoot: "/other", worktreePath: "/other/.claude/worktrees/card-c1" });
    expect(other).toContain("git -C /other worktree add -b card/c1 /other/.claude/worktrees/card-c1 main");
    expect(other).not.toContain(WTP);
  });

  it("T47 a fix pass shows the findings and the red gate in the text", () => {
    const rv = stateAt("reviewer");
    const f = go(rv, okHB("reviewer", rv, { verdict: "fail", findings: [blocker({ id: "FINDME", description: "unique finding text" })] }));
    const t = briefPrompt(currentAction(f.state).brief, { repoRoot: REPO, worktreePath: WTP });
    expect(t).toContain("FINDME");
    expect(t).toContain("unique finding text");
    const g = stateAt("gate");
    const red = { commands: [{ command: "pnpm typecheck", exitCode: 2 }], gateLine: "typecheck REDLINE" };
    const r = go(g, okHB("gate", g, red));
    const t2 = briefPrompt(currentAction(r.state).brief, { repoRoot: REPO, worktreePath: WTP });
    expect(t2).toContain("typecheck REDLINE");
  });
});

describe("evidenced majors", () => {
  const major = (over = {}) => ({ id: "F2", severity: "major", file: "b.mjs", description: "meh", evidence: "ran X, saw Y", ...over });
  const GATE_WALK = ["setup", "lead", "tester", "coder", "reviewer", "gate", "commit"];

  it("T44 an evidenced major on the first review gets one fix pass", () => {
    const s = stateAt("reviewer");
    const r = go(s, okHB("reviewer", s, { verdict: "fail", findings: [major()] }));
    expect(r.action.kind).toBe("seat");
    expect(r.state.pending).toBe("coder");
    expect(r.state.counters.fixPasses).toBe(1);
    expect(r.action.brief.findings.map((f) => f.id)).toEqual(["F2"]);
  });

  it("T45 an evidenced major still open after the fix pass stops with reviewer-major-open", () => {
    const s = stateAt("reviewer");
    const r1 = go(s, okHB("reviewer", s, { verdict: "fail", findings: [major()] }));
    const r2 = ok(r1.state);
    const r3 = go(r2.state, okHB("reviewer", r2.state, { verdict: "fail", findings: [major({ id: "F3" })] }));
    expect(r3.action.kind).toBe("stopped");
    expect(r3.action.reason).toBe("reviewer-major-open");
    expect(r3.state.counters.fixPasses).toBe(1);
  });

  it("T46 a major without evidence goes to the gate", () => {
    for (const evidence of [undefined, null, "", "   "]) {
      const { seats, last } = walk(CARD, {}, { "reviewer#1": { verdict: "fail", findings: [major({ evidence })] } });
      expect(seats).toEqual(GATE_WALK);
      expect(last.kind).toBe("done");
    }
  });

  it("T47 a minor, even with evidence, goes to the gate", () => {
    const minor = { id: "F3", severity: "minor", file: "c.mjs", description: "nit", evidence: "ran X, saw Y" };
    const { seats, last } = walk(CARD, {}, { "reviewer#1": { verdict: "fail", findings: [minor] } });
    expect(seats).toEqual(GATE_WALK);
    expect(last.kind).toBe("done");
  });

  it("T48 a blocker open with an evidenced major after the fix pass keeps reviewer-blocker-open", () => {
    const s = stateAt("reviewer");
    const r1 = go(s, okHB("reviewer", s, { verdict: "fail", findings: [major()] }));
    const r2 = ok(r1.state);
    const r3 = go(r2.state, okHB("reviewer", r2.state, { verdict: "fail", findings: [major({ id: "F3" }), blocker({ id: "F4" })] }));
    expect(r3.action.kind).toBe("stopped");
    expect(r3.action.reason).toBe("reviewer-blocker-open");
  });
});

describe("gate seat writes no git", () => {
  const GATE_RULE = "Run the gate commands only. Never run git add, git commit, or any other command that writes to git; the commit seat is the only seat that commits.";
  const ERR = "gate seat must not run git add or git commit";
  const gateHB = (s, command) => okHB("gate", s, { commands: [{ command, exitCode: 0 }] });

  it("T49 only the gate brief carries gate-no-git-writes, with the exact text", () => {
    const rules = (seat) => currentAction(stateAt(seat)).brief.rules;
    const gate = rules("gate").find((r) => r.id === "gate-no-git-writes");
    expect(gate).toBeTruthy();
    expect(gate.text).toBe(GATE_RULE);
    for (const seat of ["commit", "coder", "reviewer", "tester"]) {
      expect(rules(seat).map((r) => r.id)).not.toContain("gate-no-git-writes");
    }
  });

  it.each([
    ["git commit", 'git commit -m "x"'],
    ["git add", "git add a b"],
    ["a compound command", 'cd /some/path && git commit -m "x"'],
    ["git -C <path>", "git -C /some/path commit -m x"],
  ])("T50 a gate hand-back with %s is invalid and stops the card", (_n, command) => {
    const s = stateAt("gate");
    const errors = validateHandBack(s, gateHB(s, command));
    expect(errors.join("; ")).toContain(ERR);
    const r = go(s, gateHB(s, command));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
    expect(r.action.report.stoppedAt).toBe("gate");
  });

  it("T50b a gate hand-back whose second command commits is invalid", () => {
    const s = stateAt("gate");
    const hb = okHB("gate", s, { commands: [
      { command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 },
      { command: 'git commit -m "x"', exitCode: 0 },
    ] });
    expect(validateHandBack(s, hb).join("; ")).toContain(ERR);
    const r = go(s, hb);
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
  });

  it("T52 implementer.md tells non-commit seats never to run git add or git commit", () => {
    const doc = readFileSync(join(HERE, "..", "agents", "implementer.md"), "utf8");
    expect(doc).toContain("In a card loop, only the commit seat commits: when your brief names you the gate seat or any seat other than commit, never run git add or git commit.");
  });

  it("T51 read-only git and non-git commands that mention a word pass to the commit seat", () => {
    const s = stateAt("gate");
    const commands = [
      "git status --short",
      "git diff --stat",
      "git log --oneline -3",
      "node .doug/hooks/scripts/verify.mjs",
      "pnpm exec vitest run tests/commit.test.mjs",
    ].map((command) => ({ command, exitCode: 0 }));
    const hb = okHB("gate", s, { commands });
    expect(validateHandBack(s, hb)).toEqual([]);
    const r = go(s, hb);
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("commit");
  });
});

describe("coverage", () => {
  it("T32 every STOP_REASONS entry is produced by at least one test", () => {
    expect([...seenReasons].sort()).toEqual([...STOP_REASONS].sort());
    expect(STOP_REASONS.length).toBe(10);
  });
});
