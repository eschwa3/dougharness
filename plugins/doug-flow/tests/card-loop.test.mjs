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
  handBackSchema,
  laneFor,
  initialState,
  currentAction,
  next,
  validateHandBack,
  briefPrompt,
  ownedWithPins,
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
const INLINE_NOTE = "Fact: X holds\nSource: https://example.test/a line 3\nunverified: Y";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);

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
      tree: TREE_A,
    },
    commit: { sha: "abc1234", branch: "card/c1", tree: TREE_A },
  }[seat];
  const hb = { seat, ...base, ...over };
  for (const k of Object.keys(hb)) if (hb[k] === undefined) delete hb[k];
  return hb;
}

// A hand-back that carries a hook block and no result (commit without sha; other seats seat + hookBlocked only).
function noResultHB(seat, state, hookBlocked) {
  if (seat === "commit") return okHB(seat, state, { sha: undefined, hookBlocked });
  return { seat, hookBlocked };
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

  it("T10a no-trailers reaches the commit seat only; tester, coder (fix pass included), reviewer and every other seat get none", () => {
    const TEXT = "Commit without Co-Authored-By or Claude-Session trailers.";
    expect(BRIEF_RULES["no-trailers"].text).toBe(TEXT);
    const { actions } = walk({ ...CARD }, { research: true });
    const rulesOf = (a) => a.brief.rules.filter((r) => r.id === "no-trailers");
    const seatActions = (seat) => actions.filter((x) => x.kind === "seat" && x.seat === seat);
    {
      const a = seatActions("commit")[0];
      expect(a, "commit").toBeTruthy();
      expect(rulesOf(a), "commit").toEqual([{ id: "no-trailers", text: TEXT }]);
    }
    for (const seat of ["tester", "coder", "reviewer", "setup", "research", "lead", "gate"]) {
      const a = seatActions(seat)[0];
      expect(a, seat).toBeTruthy();
      expect(rulesOf(a), seat).toEqual([]);
    }
    const fix = walk(CARD, {}, { "reviewer#1": { verdict: "fail", findings: [blocker()] } });
    const coders = fix.actions.filter((x) => x.kind === "seat" && x.seat === "coder");
    expect(coders.length).toBeGreaterThanOrEqual(2);
    expect(coders[1].brief.round).toBe(2);
    expect(rulesOf(coders[1])).toEqual([]);
  });

  it("T10b the lead is told to fetch the full text of each indexed lesson it needs, right after the verbatim rule; no other seat carries it", () => {
    const { actions } = walk();
    const rules = (seat) => actions.find((x) => x.kind === "seat" && x.seat === seat).brief.rules;
    const lead = rules("lead");
    const at = lead.findIndex((r) => r.id === "lessons-fetch");
    expect(at, "lessons-fetch in the lead brief").toBeGreaterThan(-1);
    expect(lead[at].text).toBe(
      "For each indexed lesson the card needs, run memory.mjs lesson show <id> <repo-root> --card <card-id>, passing the REPO ROOT named in this brief as [dir], and append its output verbatim to lessons below the brief-lessons block; never cut or paraphrase a fetched lesson."
    );
    expect(lead[at - 1].id).toBe("lessons-verbatim");
    expect(lead[at - 1].text).toBe("Run memory.mjs brief-lessons <card-id> <repo-root>, passing the REPO ROOT named in this brief as [dir], and return its block for this card verbatim in lessons; never paraphrase it.");
    expect(BRIEF_RULES["lessons-fetch"].seats).toEqual(["lead"]);
    for (const seat of ["setup", "research", "tester", "coder", "reviewer", "gate", "commit"]) {
      const a = actions.find((x) => x.kind === "seat" && x.seat === seat);
      if (a) expect(a.brief.rules.map((r) => r.id), seat).not.toContain("lessons-fetch");
    }
  });

  it("T10c the lead prompt names the queen's repo root right after the worktree line; no other seat prints it; a missing root prints nothing", () => {
    const RR = "/abs/main-repo";
    const WTX = "/abs/main-repo/.claude/worktrees/card-c1";
    const lead = briefPrompt(currentAction(stateAt("lead")).brief, { repoRoot: RR, worktreePath: WTX });
    expect(lead).toContain("REPO ROOT: " + RR);
    expect(lead).not.toContain("REPO ROOT: " + WTX);
    expect(lead.indexOf("REPO ROOT: " + RR)).toBeGreaterThan(lead.indexOf("WORKTREE: " + WTX));
    for (const seat of ["setup", "research", "tester", "coder", "reviewer", "gate", "commit"]) {
      const st = stateAt(seat, CARD, seat === "research" ? { research: true } : {});
      const t = briefPrompt(currentAction(st).brief, { repoRoot: RR, worktreePath: WTX });
      expect(t, seat).not.toContain("REPO ROOT:");
    }
    const none = briefPrompt(currentAction(stateAt("lead")).brief, { worktreePath: WTX });
    expect(none).not.toContain("REPO ROOT:");
    const empty = briefPrompt(currentAction(stateAt("lead")).brief, { repoRoot: "", worktreePath: WTX });
    expect(empty).not.toContain("REPO ROOT:");
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

  it("T14 a claim of [''] or [] without mutationResults counts as missing", () => {
    const s = stateAt("tester");
    for (const over of [{ tests_red_by_design: [""] }, { tests_red_by_design: [], mutationResults: undefined }]) {
      const r = go(s, okHB("tester", s, over));
      expect(r.action.kind).toBe("stopped");
      expect(r.action.reason).toBe("tester-red-claim-missing");
    }
  });

  // Walk the happy path to the tester with the lead listing `muts` (default MUT).
  const testerWith = (muts) => {
    let state = initialState(CARD, {});
    let guard = 0;
    while (state.pending !== "tester") {
      if (guard++ > 40) throw new Error("never reached tester");
      state = ok(state, state.pending === "lead" ? { mutations: muts } : {}).state;
    }
    return state;
  };
  const M2 = { id: "M2", case: "case two", mutation: "drop the other check", test: "T02" };
  const res = (id, failed) => ({ id, failed, test: "T0" + id.slice(1), assertion: "expected x" });

  it("T14a pin-only claim [] with every listed mutation failed advances to coder with redTests []", () => {
    const s = testerWith([...MUT, M2]);
    const r = go(s, okHB("tester", s, { tests_red_by_design: [], mutationResults: [res("M1", true), res("M2", true)] }));
    expect(r.action.reason).toBeUndefined();
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.action.brief.redTests).toEqual([]);
  });

  it("T14b pin-only claim [] with a listed mutation missing from mutationResults stops", () => {
    const s = testerWith([...MUT, M2]);
    const r = go(s, okHB("tester", s, { tests_red_by_design: [], mutationResults: [res("M1", true)] }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("tester-red-claim-missing");
  });

  it("T14c pin-only claim [] with a listed mutation that survived stops", () => {
    const s = testerWith([...MUT, M2]);
    const r = go(s, okHB("tester", s, { tests_red_by_design: [], mutationResults: [res("M1", true), res("M2", false)] }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("tester-red-claim-missing");
  });

  it("T14d pin-only claim [] with no listed mutations stops", () => {
    const s = testerWith([]);
    const r = go(s, okHB("tester", s, { tests_red_by_design: [], mutationResults: [] }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("tester-red-claim-missing");
  });

  it("T14f pin-only claim [] with split ids where one part survived stops", () => {
    const s = testerWith(MUT);
    const r = go(s, okHB("tester", s, { tests_red_by_design: [], mutationResults: [res("M1a", true), res("M1b", false)] }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("tester-red-claim-missing");
  });

  it("T14g pin-only claim [] with split ids all failed advances to coder with redTests []", () => {
    const s = testerWith(MUT);
    const r = go(s, okHB("tester", s, { tests_red_by_design: [], mutationResults: [res("M1a", true), res("M1b", true)] }));
    expect(r.action.reason).toBeUndefined();
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.action.brief.redTests).toEqual([]);
  });

  it("T14h the contract doc names the pin-only exception to tester-red-claim-missing", () => {
    const doc = readFileSync(CONTRACT_DOC, "utf8");
    const line = doc.split("\n").find((l) => l.startsWith("Stop reasons:"));
    expect(line).toMatch(/`tester-red-claim-missing` \(pin-only exception[^)]*every listed mutation[^)]*failed/);
  });

  it("T14e the full-lane tester brief names the pin-only path in the red-claim rule", () => {
    const s = stateAt("tester");
    const rule = currentAction(s).brief.rules.find((x) => x.id === "red-claim").text;
    expect(rule).toContain("tests_red_by_design");
    expect(rule).toContain("[]");
    expect(rule).toContain("mutationResults");
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
      const r = go(s, noResultHB(seat, s, { message: "protect-paths refused the edit" }));
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
    const r = go(s, noResultHB("coder", s, { message: "guard-bash denied it" }));
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

describe("coder and tester seats write no git", () => {
  const RULE = "Never run git add, git commit, or any other command that writes to the card branch or its index (git stash, git reset, git checkout -- <file>); the commit seat is the only seat that commits. A scratch copy or git worktree under .doug/.state for mutations is allowed.";
  const CODER_ERR = "coder seat must not run git add or git commit";
  const TESTER_ERR = "tester seat must not run git add or git commit";
  const CMDS = [
    ["git commit", 'git commit -m "x"'],
    ["git add", "git add a b"],
    ["a compound command", 'cd /p && git commit -m "x"'],
    ["git -C <path>", "git -C /p commit -m x"],
  ];
  const ruleOf = (action) => action.brief.rules.find((r) => r.id === "no-git-writes");

  it("T53 the coder brief carries no-git-writes with the exact text, on the first round and a fix pass", () => {
    const first = ruleOf(currentAction(stateAt("coder")));
    expect(first && first.text).toBe(RULE);
    const s = stateAt("reviewer");
    const r = go(s, okHB("reviewer", s, { verdict: "fail", findings: [blocker()] }));
    expect(r.action.seat).toBe("coder");
    const fix = ruleOf(r.action);
    expect(fix && fix.text).toBe(RULE);
  });

  it("T54 the tester brief carries no-git-writes with the exact text, on the full and tests-only lane", () => {
    const full = ruleOf(currentAction(stateAt("tester")));
    expect(full && full.text).toBe(RULE);
    const only = ruleOf(currentAction(stateAt("tester", { ...CARD, class: "tests-only" })));
    expect(only && only.text).toBe(RULE);
  });

  it("T55 no other seat's brief carries no-git-writes", () => {
    for (const seat of ["setup", "research", "lead", "reviewer", "gate", "commit"]) {
      const s = stateAt(seat, CARD, { research: true });
      expect(currentAction(s).brief.rules.map((r) => r.id), seat).not.toContain("no-git-writes");
    }
  });

  it.each(CMDS)("T56 a coder hand-back with %s is invalid and stops at coder", (_n, command) => {
    const s = stateAt("coder");
    const hb = okHB("coder", s, { commandsRun: [{ command: "pnpm exec vitest run a.test.mjs", exitCode: 0 }, { command, exitCode: 0 }] });
    expect(validateHandBack(s, hb).join("; ")).toContain(CODER_ERR);
    const r = go(s, hb);
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
    expect(r.action.report.stoppedAt).toBe("coder");
  });

  it.each(CMDS)("T57 a tester hand-back with %s in commandsRun is invalid and stops at tester", (_n, command) => {
    const s = stateAt("tester");
    const hb = okHB("tester", s, { commandsRun: [{ command, exitCode: 0 }] });
    expect(validateHandBack(s, hb).join("; ")).toContain(TESTER_ERR);
    const r = go(s, hb);
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
    expect(r.action.report.stoppedAt).toBe("tester");
  });

  it("T58 read-only git and scratch worktree commands pass for coder and tester", () => {
    const commands = ["git status --short", "git diff --stat", "git log --oneline -3", "git worktree add .doug/.state/scratch/w HEAD", "pnpm exec vitest run a.test.mjs"].map((command) => ({ command, exitCode: 0 }));
    const c = stateAt("coder");
    expect(validateHandBack(c, okHB("coder", c, { commandsRun: commands }))).toEqual([]);
    const t = stateAt("tester");
    expect(validateHandBack(t, okHB("tester", t, { commandsRun: commands }))).toEqual([]);
  });

  it("T59 the tester hand-back schema takes an optional commandsRun array", () => {
    const sch = handBackSchema("tester", stateAt("tester"));
    expect(sch.properties.commandsRun).toBeTruthy();
    expect(sch.properties.commandsRun.type).toBe("array");
    expect(sch.required).not.toContain("commandsRun");
  });
});

describe("unrunnable mutations", () => {
  const REASON = "CLI test outside the scratch copy";
  const notRunHB = (s, over = {}) =>
    okHB("coder", s, { mutationResults: [{ id: "M1", notRun: REASON }], ...over });
  const atReviewer = () => ok(stateAt("coder"), { mutationResults: [{ id: "M1", notRun: REASON }] });

  it("T53 a coder notRun entry in place of failed/test is accepted and advances to the reviewer", () => {
    const s = stateAt("coder");
    expect(validateHandBack(s, notRunHB(s))).toEqual([]);
    const r = go(s, notRunHB(s));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("reviewer");
  });

  it("T54 a coder notRun with a blank or non-string reason is refused", () => {
    const s = stateAt("coder");
    for (const notRun of ["", "   ", 5, null]) {
      const hb = okHB("coder", s, { mutationResults: [{ id: "M1", notRun }] });
      expect(validateHandBack(s, hb).length).toBeGreaterThan(0);
    }
  });

  it("T55 the coder output schema admits notRun; the reviewer's does not", () => {
    const item = (seat) => HAND_BACK_SCHEMAS[seat].properties.mutationResults.items;
    expect(item("coder").required).toEqual(["id"]);
    expect(item("coder").properties.notRun).toBeTruthy();
    expect(item("reviewer").required).toEqual(["id", "failed", "test"]);
    expect(item("reviewer").properties.notRun).toBeUndefined();
  });

  it("T55b the tests-only tester's brief schema admits notRun with only id required", () => {
    const s = stateAt("tester", { ...CARD, class: "tests-only" });
    const item = currentAction(s).brief.handBack.properties.mutationResults.items;
    expect(item.required).toEqual(["id"]);
    expect(item.properties.notRun).toBeTruthy();
    expect(handBackSchema("tester", "tests-only")).toEqual(currentAction(s).brief.handBack);
  });

  it("T55c the full-lane tester's brief schema requires id, failed and test and has no notRun", () => {
    const s = stateAt("tester");
    const item = currentAction(s).brief.handBack.properties.mutationResults.items;
    expect(item.required).toEqual(["id", "failed", "test"]);
    expect(item.properties.notRun).toBeUndefined();
    expect(handBackSchema("tester", "full")).toEqual(currentAction(s).brief.handBack);
  });

  it("T55d a full-lane tester hand-back its brief schema admits is accepted by validateHandBack", () => {
    const s = stateAt("tester");
    const hb = okHB("tester", s, { mutationResults: [{ id: "M1", failed: true, test: "T01" }] });
    expect(validateHandBack(s, hb)).toEqual([]);
    expect(go(s, hb).action.seat).toBe("coder");
  });

  it("T55e handBackSchema keeps every other seat's schema as HAND_BACK_SCHEMAS has it, on every lane", () => {
    for (const lane of ["full", "lean", "tests-only"]) {
      for (const seat of SEATS) {
        if (seat === "tester") continue;
        expect(handBackSchema(seat, lane), `${seat}/${lane}`).toEqual(HAND_BACK_SCHEMAS[seat]);
      }
    }
  });

  it("T55f for every seat and lane, each notRun shape the brief's schema admits is accepted by the validator", () => {
    const MUTS = [
      { id: "M1", case: "case one", mutation: "remove the check", test: "T01" },
      { id: "M2", case: "case two", mutation: "drop the guard", test: "T02" },
    ];
    const lanes = {
      full: CARD,
      lean: { ...CARD, size: "S", class: "docs" },
      "tests-only": { ...CARD, class: "tests-only" },
    };
    let checked = 0;
    const seen = [];
    for (const [lane, card] of Object.entries(lanes)) {
      let st = initialState(card, {});
      let guard = 0;
      while (st.pending && st.pending !== "reviewer") {
        if (guard++ > 40) throw new Error("walk did not terminate");
        const seat = st.pending;
        const brief = currentAction(st).brief;
        const item = brief.handBack.properties.mutationResults?.items;
        if (item?.properties?.notRun && brief.mutations.length > 0) {
          const entries = brief.mutations.map((m) => ({ id: m.id, notRun: "could not run it here" }));
          const hb = okHB(seat, st, { mutationResults: entries });
          expect(validateHandBack(st, hb), `${seat}/${lane} notRun`).toEqual([]);
          checked++;
          seen.push(`${seat}/${lane}`);
        }
        st = ok(st, seat === "lead" ? { mutations: MUTS } : {}).state;
      }
    }
    expect(seen.sort()).toEqual(["coder/full", "tester/tests-only"]);
    expect(checked).toBe(2);
  });

  it("T56 every coder notRun id and reason is carried to the reviewer brief and prompt", () => {
    const r = atReviewer();
    expect(r.action.seat).toBe("reviewer");
    expect(r.action.brief.notRun).toEqual([{ id: "M1", reason: REASON }]);
    const text = briefPrompt(r.action.brief);
    expect(text).toContain("NOT RUN BY THE CODER");
    expect(text).toContain("M1: " + REASON);
    expect(currentAction(stateAt("coder")).brief.notRun).toEqual([]);
  });

  it("T57 a reviewer that omits a carried notRun id is refused and the card stops", () => {
    const s = atReviewer().state;
    const hb = okHB("reviewer", s, { mutationResults: [] });
    const errors = validateHandBack(s, hb);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("; ")).toContain("M1");
    const r = go(s, hb);
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
  });

  it("T58 a reviewer notRun entry is refused, with or without failed and test", () => {
    const s = atReviewer().state;
    for (const entry of [
      { id: "M1", notRun: "x" },
      { id: "M1", failed: true, test: "T01", notRun: "x" },
    ]) {
      const hb = okHB("reviewer", s, { mutationResults: [entry] });
      expect(validateHandBack(s, hb).length).toBeGreaterThan(0);
    }
    expect(validateHandBack(s, okHB("reviewer", s, { mutationResults: [{ id: "M1", failed: false, test: "T01" }] }))).toEqual([]);
  });

  it("T59 the lead brief says what a mutation is", () => {
    const brief = currentAction(stateAt("lead")).brief;
    const rule = brief.rules.find((r) => r.id === "mutation-is-code-change");
    expect(rule).toBeTruthy();
    expect(rule.text).toContain("A mutation is a code change");
    expect(rule.text).toContain("(a git diff, a file-absence check) goes in reviewerChecks");
    expect(briefPrompt(brief)).toContain(rule.text);
    expect(currentAction(stateAt("coder")).brief.rules.map((r) => r.id)).not.toContain("mutation-is-code-change");
  });

  it("T60 lead reviewerChecks reach the reviewer brief only", () => {
    const checks = ["git diff shows no production file"];
    const s = stateAt("lead");
    expect(validateHandBack(s, okHB("lead", s, { reviewerChecks: checks }))).toEqual([]);
    expect(validateHandBack(s, okHB("lead", s, { reviewerChecks: "nope" })).length).toBeGreaterThan(0);
    let st = ok(s, { reviewerChecks: checks }).state;
    while (st.pending !== "coder") st = ok(st).state;
    expect(currentAction(st).brief.reviewerChecks).toEqual([]);
    while (st.pending !== "reviewer") st = ok(st).state;
    const brief = currentAction(st).brief;
    expect(brief.reviewerChecks).toEqual(checks);
    expect(briefPrompt(brief)).toContain("REVIEWER CHECKS:");
    expect(briefPrompt(brief)).toContain(checks[0]);
  });
});

// Card queen-resume-with-answer: the user's answer to a design question rides in options.answers and reaches only the asking seat.
describe("card queen-resume-with-answer: options.answers", () => {
  const ANS = { seat: "tester", question: "Q?", answer: "A." };

  it("T61 an answer reaches the asking seat's brief as { question, answer } and no other seat's", () => {
    const opts = { answers: [ANS] };
    expect(currentAction(stateAt("tester", CARD, opts)).brief.answers).toEqual([{ question: "Q?", answer: "A." }]);
    expect(currentAction(stateAt("lead", CARD, opts)).brief.answers).toEqual([]);
    expect(currentAction(stateAt("coder", CARD, opts)).brief.answers).toEqual([]);
    expect(currentAction(initialState(CARD, {})).brief.answers).toEqual([]);
  });

  it("T62 the prompt carries an ANSWERS FROM THE USER block right after GOAL, only for the answered seat", () => {
    const withAns = briefPrompt(currentAction(stateAt("tester", CARD, { answers: [ANS] })).brief, { worktreePath: WT });
    expect(withAns).toContain(
      "GOAL:\n" + CARD.goal + "\n\nANSWERS FROM THE USER (to your design questions; build on them):\n- Q: Q? A: A.\n\nWORKTREE:",
    );
    const without = briefPrompt(currentAction(stateAt("tester", CARD, {})).brief, { worktreePath: WT });
    expect(without).not.toContain("ANSWERS FROM THE USER");
    const other = briefPrompt(currentAction(stateAt("lead", CARD, { answers: [ANS] })).brief, { worktreePath: WT });
    expect(other).not.toContain("ANSWERS FROM THE USER");
    // a seat's prompt without an answer is byte-identical with and without answers for other seats
    const lead = (o) => briefPrompt(currentAction(stateAt("lead", CARD, o)).brief, { worktreePath: WT });
    expect(lead({ answers: [ANS] })).toBe(lead({}));
  });

  it("T63 an answer with a round applies only from that round on; one without a round applies to every round", () => {
    const toCoderRound2 = (opts) => {
      let st = stateAt("coder", CARD, opts);
      const round1 = currentAction(st).brief;
      st = ok(st).state; // coder
      st = go(st, okHB("reviewer", st, { verdict: "fail", findings: [blocker()] })).state;
      expect(st.pending).toBe("coder");
      return { round1, round2: currentAction(st).brief };
    };
    const late = toCoderRound2({ answers: [{ seat: "coder", question: "Q?", answer: "A.", round: 2 }] });
    expect(late.round1.round).toBe(1);
    expect(late.round2.round).toBe(2);
    expect(late.round1.answers).toEqual([]);
    expect(late.round2.answers).toEqual([{ question: "Q?", answer: "A." }]);
    const any = toCoderRound2({ answers: [{ seat: "coder", question: "Q?", answer: "A." }] });
    expect(any.round1.answers).toEqual([{ question: "Q?", answer: "A." }]);
    expect(any.round2.answers).toEqual([{ question: "Q?", answer: "A." }]);
  });

  it("T64 a second designQuestion from the answered seat stops design-decision again", () => {
    const s = stateAt("tester", CARD, { answers: [ANS] });
    const r = go(s, { seat: "tester", designQuestion: "A new question?" });
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("design-decision");
    expect(r.action.report.stoppedAt).toBe("tester");
    expect(r.action.report.detail).toContain("A new question?");
    expect(r.state.pending).not.toBe("coder");
  });

  it("T65 malformed options.answers make initialState throw a TypeError naming options.answers", () => {
    const bad = [
      "nope",
      {},
      [null],
      ["str"],
      [{ seat: "nobody", question: "Q?", answer: "A." }],
      [{ question: "Q?", answer: "A." }],
      [{ seat: "tester", question: 5, answer: "A." }],
      [{ seat: "tester", question: "Q?", answer: "  " }],
      [{ seat: "tester", question: "Q?" }],
      [{ seat: "tester", question: "Q?", answer: "A.", round: 0 }],
      [{ seat: "tester", question: "Q?", answer: "A.", round: 1.5 }],
      [{ seat: "tester", question: "Q?", answer: "A.", round: "1" }],
    ];
    for (const answers of bad) {
      expect(() => initialState(CARD, { answers }), JSON.stringify(answers)).toThrow(TypeError);
      expect(() => initialState(CARD, { answers }), JSON.stringify(answers)).toThrow(/options\.answers/);
    }
    expect(() => initialState(CARD, { answers: [{ ...ANS, round: 2, run: "wf_x" }] })).not.toThrow();
    expect(initialState(CARD, {}).answers).toEqual([]);
    expect(initialState(CARD, { answers: [ANS] }).answers).toEqual([ANS]);
  });
});

// Card card-loop-notrun-gaps: notRun on the tests-only tester, across coder rounds, unlisted ids; split mutation ids.
describe("notRun gaps", () => {
  const REASON = "CLI test outside the scratch copy";
  const TO = { ...CARD, class: "tests-only" };
  const MUT2 = [
    { id: "M1", case: "case one", mutation: "remove the check", test: "T01" },
    { id: "M2", case: "case two", mutation: "drop the guard", test: "T02" },
  ];
  const withMuts = (seat, card, muts) => {
    let st = initialState(card, {});
    let guard = 0;
    while (st.pending !== seat) {
      if (guard++ > 40) throw new Error("never reached " + seat);
      st = ok(st, st.pending === "lead" ? { mutations: muts } : {}).state;
    }
    return st;
  };
  const passed = (id) => ({ id, failed: true, test: "T0" + id.slice(1), assertion: "x" });

  it("T66 a tests-only tester notRun entry in place of failed/test is accepted and advances to the reviewer", () => {
    const s = stateAt("tester", TO);
    const hb = okHB("tester", s, { mutationResults: [{ id: "M1", notRun: REASON }] });
    expect(validateHandBack(s, hb)).toEqual([]);
    const r = go(s, hb);
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("reviewer");
    const blank = okHB("tester", s, { mutationResults: [{ id: "M1", notRun: "  " }] });
    expect(validateHandBack(s, blank).length).toBeGreaterThan(0);
  });

  it("T67 a tests-only tester notRun id and reason reach the reviewer brief and prompt; a reviewer that omits it is refused", () => {
    const s = stateAt("tester", TO);
    const r = go(s, okHB("tester", s, { mutationResults: [{ id: "M1", notRun: REASON }] }));
    expect(r.action.brief.notRun).toEqual([{ id: "M1", reason: REASON }]);
    expect(briefPrompt(r.action.brief)).toContain("M1: " + REASON);
    const hb = okHB("reviewer", r.state, { mutationResults: [] });
    expect(validateHandBack(r.state, hb).join("; ")).toContain("M1");
    expect(go(r.state, hb).action.reason).toBe("hand-back-invalid");
  });

  it("T67b a tests-only tester notRun id reported twice reaches the reviewer brief once, first reason wins", () => {
    const s = stateAt("tester", TO);
    const hb = okHB("tester", s, { mutationResults: [{ id: "M1", notRun: "reason one" }, { id: "M1", notRun: "reason two" }] });
    const r = go(s, hb);
    expect(r.action.seat).toBe("reviewer");
    expect(r.action.brief.notRun).toEqual([{ id: "M1", reason: "reason one" }]);
  });

  it("T67c a full-lane tester refuses a notRun entry", () => {
    const s = stateAt("tester");
    const hb = okHB("tester", s, { mutationResults: [{ id: "M1", notRun: REASON }] });
    expect(validateHandBack(s, hb).length).toBeGreaterThan(0);
  });

  it("T66b a tests-only tester notRun on an unlisted or split id is refused naming it, and the card stops", () => {
    const s = stateAt("tester", TO);
    for (const id of ["M9", "M1a"]) {
      const hb = okHB("tester", s, { mutationResults: [passed("M1"), { id, notRun: REASON }] });
      expect(validateHandBack(s, hb).join("; ")).toContain(id);
      expect(go(s, hb).action.reason).toBe("hand-back-invalid");
    }
  });

  it("T68 notRun builds up across two coder rounds: deduped by id, first reason wins", () => {
    const s0 = withMuts("coder", CARD, MUT2);
    const r1 = go(s0, okHB("coder", s0, { mutationResults: [{ id: "M1", notRun: "reason one" }, passed("M2")] }));
    expect(r1.action.seat).toBe("reviewer");
    const rv = go(r1.state, okHB("reviewer", r1.state, {
      verdict: "fail",
      findings: [blocker()],
      mutationResults: [passed("M1"), passed("M2")],
    }));
    expect(rv.state.pending).toBe("coder");
    const r2 = go(rv.state, okHB("coder", rv.state, { mutationResults: [{ id: "M1", notRun: "reason two" }, { id: "M2", notRun: "reason three" }] }));
    expect(r2.action.seat).toBe("reviewer");
    expect(r2.action.brief.notRun).toEqual([
      { id: "M1", reason: "reason one" },
      { id: "M2", reason: "reason three" },
    ]);
  });

  it("T69 a coder notRun on an unlisted id is refused naming it, and the card stops", () => {
    const s = stateAt("coder");
    const hb = okHB("coder", s, { mutationResults: [passed("M1"), { id: "M9", notRun: REASON }] });
    expect(validateHandBack(s, hb).join("; ")).toContain("M9");
    const r = go(s, hb);
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
  });

  it("T70 a reviewer reporting listed M1 as M1a and M1b without own is accepted", () => {
    const s = stateAt("reviewer");
    const hb = okHB("reviewer", s, { mutationResults: [{ id: "M1a", failed: true, test: "T01" }, { id: "M1b", failed: true, test: "T01" }] });
    expect(validateHandBack(s, hb)).toEqual([]);
    expect(go(s, hb).action.seat).toBe("gate");
  });

  it("T71 M10 and M1-x do not cover M1", () => {
    const s = stateAt("reviewer");
    for (const id of ["M10", "M1-x"]) {
      const hb = okHB("reviewer", s, { mutationResults: [{ id, failed: true, test: "T01" }] });
      const msg = validateHandBack(s, hb).join("; ");
      expect(msg, id).toContain("missing listed mutation M1");
      expect(msg, id).toContain(id + " is not listed and not marked own");
    }
  });
});

// Card autopilot-no-stuck-in-flow: a gate command that hit the verify timeout is load, not a red and not a block.
describe("gate timeout", () => {
  const LINE = "gate: typecheck 0; test:unit 1 (exit timeout at 301.0 s)";
  const timedOut = (over = {}) => ({
    commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 1, timedOut: true }],
    gateLine: LINE,
    ...over,
  });
  const RULE_TEXT =
    "When verify.mjs prints `exit timeout` for a command, report that command with timedOut: true; a timeout is load, not a red or a block, so leave blocked unset.";

  it("T70 a gate hand-back with a timedOut command stops gate-timeout with the gate line, no red counted, no coder round", () => {
    const s = stateAt("gate");
    const r = go(s, okHB("gate", s, timedOut()));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("gate-timeout");
    expect(r.action.report.detail).toBe(LINE);
    expect(r.state.counters.redGates).toBe(0);
    expect(r.state.fixFor ?? null).toBeNull();
    expect(r.action.report?.stoppedAt ?? "gate").toBe("gate");
  });

  it("T71 the timeout wins over a blocked string (the 2026-10-17 hand-back shape)", () => {
    const s = stateAt("gate");
    const r = go(s, okHB("gate", s, timedOut({ blocked: "Gate red, not green. The test:unit step hit the gate's 301 s timeout" })));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("gate-timeout");
  });

  it("T72 a red without timedOut keeps the red path, and a blocked gate without timedOut stays seat-blocked", () => {
    const s = stateAt("gate");
    const red = go(s, okHB("gate", s, { commands: [{ command: "c", exitCode: 1, timedOut: false }], gateLine: "red" }));
    expect(red.action.kind).toBe("seat");
    expect(red.action.seat).toBe("coder");
    expect(red.state.counters.redGates).toBe(1);
    const blocked = go(s, okHB("gate", s, { blocked: "cannot run" }));
    expect(blocked.action.reason).toBe("seat-blocked");
  });

  it("T70b a gate-timeout stop records lastGate with the timed-out commands and the gate line", () => {
    const s = stateAt("gate");
    const hb = timedOut();
    const r = go(s, okHB("gate", s, hb));
    expect(r.action.reason).toBe("gate-timeout");
    expect(r.state.lastGate).toEqual({ commands: hb.commands, gateLine: LINE });
  });

  it("T70c a timedOut command on a non-gate hand-back does not stop gate-timeout", () => {
    const s = stateAt("reviewer");
    const r = go(
      s,
      okHB("reviewer", s, {
        commandsRun: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }],
        commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 1, timedOut: true }],
      }),
    );
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("gate");
  });

  it("T73 only the gate brief carries gate-timeout-is-load, with the exact text", () => {
    expect(BRIEF_RULES["gate-timeout-is-load"].text).toBe(RULE_TEXT);
    for (const seat of SEATS.filter((x) => x !== "research")) {
      const rules = currentAction(stateAt(seat)).brief.rules.map((r) => r.id);
      if (seat === "gate") expect(rules, seat).toContain("gate-timeout-is-load");
      else expect(rules, seat).not.toContain("gate-timeout-is-load");
    }
  });

  it("T74 docs/worker-contract.md names gate-timeout", () => {
    expect(readFileSync(CONTRACT_DOC, "utf8")).toContain("gate-timeout");
    expect(STOP_REASONS).toContain("gate-timeout");
  });
});

// Card queen-seats-relayed-user-message: Claude Code relays the user's mid-turn message to every seat of a Workflow
// run ("[Workflow harness — user request]"); a seat once stopped because that message was about other work.
describe("relayed user message", () => {
  const RULE_ID = "relayed-message-outside-card";
  const RULE_TEXT =
    "Your task is the card in this brief. A relayed user message about other work is outside this seat's card: note it in leftOut and carry on; it is never a reason to stop or to ask a designQuestion.";
  const lanes = {
    full: [CARD, { research: true }],
    lean: [{ ...CARD, size: "S", class: "prose" }, { research: true }],
    "tests-only": [{ ...CARD, class: "tests-only" }, { research: true }],
  };

  it("T60 every seat of every lane carries the relayed-message rule, research included", () => {
    for (const [lane, [card, opts]] of Object.entries(lanes)) {
      const { actions } = walk(card, opts);
      const seatActions = actions.filter((a) => a.kind === "seat");
      expect(seatActions.length, lane).toBeGreaterThan(0);
      if (lane === "full") expect(new Set(seatActions.map((a) => a.seat))).toEqual(new Set(SEATS));
      for (const a of seatActions) {
        const rule = a.brief.rules.find((r) => r.id === RULE_ID);
        expect(rule, `${lane}/${a.seat}`).toBeDefined();
        expect(rule.text, `${lane}/${a.seat}`).toBe(RULE_TEXT);
      }
    }
  });

  it("T61 the rule text frames a relayed message as outside the card, noted in leftOut, never a reason to stop", () => {
    expect(BRIEF_RULES[RULE_ID].text).toBe(RULE_TEXT);
    expect(RULE_TEXT).toContain("leftOut");
    expect(RULE_TEXT).toContain("outside this seat's card");
    expect(RULE_TEXT).toContain("never a reason to stop");
  });

  it("T62 briefPrompt renders the sentence into every seat's prompt", () => {
    const { actions } = walk(CARD, { research: true });
    for (const a of actions.filter((x) => x.kind === "seat")) {
      expect(briefPrompt(a.brief, { repoRoot: "/r", worktreePath: "/w" }), a.seat).toContain(RULE_TEXT);
    }
  });
});

describe("mutation ids echo", () => {
  const RULE_ID = "mutation-ids-verbatim";
  const RULE_TEXT =
    "Report each listed mutation in mutationResults under its exact listed id from MUTATION IDS; never renumber, shorten, or rename an id (a split mutation adds one letter: M8a, M8b).";
  const LINE = "MUTATION IDS (report each verbatim in mutationResults): M1, M2";
  const MUT2 = [
    { id: "M1", case: "case one", mutation: "remove the check", test: "T01" },
    { id: "M2", case: "case two", mutation: "drop the guard", test: "T02" },
  ];
  const res = [
    { id: "M1", failed: true, test: "T01", assertion: "x" },
    { id: "M2", failed: true, test: "T02", assertion: "x" },
  ];
  const overrides = {
    "lead#1": { mutations: MUT2 },
    "tester#1": { mutationResults: res },
    "coder#1": { mutationResults: res },
    "reviewer#1": { mutationResults: res.map(({ id, failed, test }) => ({ id, failed, test })) },
  };
  const brief = (actions, seat) => actions.find((a) => a.kind === "seat" && a.seat === seat).brief;
  const has = (b) => b.rules.some((r) => r.id === RULE_ID);

  it("T72 the verbatim-id rule is in the tests-only tester, coder and reviewer briefs, not the full-lane tester or lean briefs", () => {
    expect(BRIEF_RULES[RULE_ID].text).toBe(RULE_TEXT);
    const full = walk(CARD, {}, overrides).actions;
    const only = walk({ ...CARD, class: "tests-only" }, {}, overrides).actions;
    const lean = walk({ ...CARD, size: "S", class: "docs" }).actions;
    for (const [name, b] of [
      ["only tester", brief(only, "tester")],
      ["only reviewer", brief(only, "reviewer")],
      ["full coder", brief(full, "coder")],
      ["full reviewer", brief(full, "reviewer")],
    ]) {
      expect(b.rules.find((r) => r.id === RULE_ID), name).toBeDefined();
      expect(b.rules.find((r) => r.id === RULE_ID).text, name).toBe(RULE_TEXT);
    }
    expect(has(brief(full, "tester"))).toBe(false);
    for (const a of lean.filter((x) => x.kind === "seat")) expect(has(a.brief), a.seat).toBe(false);
  });

  it("T73 the coder, reviewer and tests-only tester prompts list the exact ids; the full-lane tester prompt does not", () => {
    const full = walk(CARD, {}, overrides).actions;
    const only = walk({ ...CARD, class: "tests-only" }, {}, overrides).actions;
    expect(briefPrompt(brief(full, "coder"))).toContain(LINE);
    expect(briefPrompt(brief(full, "reviewer"))).toContain(LINE);
    expect(briefPrompt(brief(only, "tester"))).toContain(LINE);
    expect(briefPrompt(brief(only, "reviewer"))).toContain(LINE);
    expect(briefPrompt(brief(full, "tester"))).not.toContain("MUTATION IDS (");
  });

  it("T74 the lead schema restricts mutation ids to M<n>", () => {
    const pattern = HAND_BACK_SCHEMAS.lead.properties.mutations.items.properties.id.pattern;
    expect(pattern).toBe("^M[1-9][0-9]*$");
    const re = new RegExp(pattern);
    for (const good of ["M1", "M18"]) expect(re.test(good), good).toBe(true);
    for (const bad of ["M1-clear-ended", "M0", "m1", "M1a"]) expect(re.test(bad), bad).toBe(false);
  });

  it("T75 a lead hand-back with a descriptive mutation id is refused and stops the card; M18 is accepted", () => {
    const s = stateAt("lead");
    const bad = okHB("lead", s, { mutations: [{ ...MUT[0], id: "M1-clear-ended" }] });
    const errs = validateHandBack(s, bad);
    expect(errs.some((e) => e.includes("M1-clear-ended") && e.includes("M<n>"))).toBe(true);
    const r = go(s, bad);
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
    expect(validateHandBack(s, okHB("lead", s, { mutations: [{ ...MUT[0], id: "M18" }] }))).toEqual([]);
  });

  it("T76 the lead brief tells the lead the M<n> id form", () => {
    const text = "List one mutation per case the goal names, each with a unique id of the form M<n> (M1, M2, ...) and the test that must fail.";
    expect(BRIEF_RULES["mutation-per-case"].text).toBe(text);
    expect(currentAction(stateAt("lead")).brief.rules.find((r) => r.id === "mutation-per-case").text).toBe(text);
  });

  it("T77 an inline multi-line research note is accepted and the loop advances to the lead seat", () => {
    const s = stateAt("research", CARD, { research: true });
    const hb = okHB("research", s, { note: INLINE_NOTE });
    expect(validateHandBack(s, hb)).toEqual([]);
    const r = go(s, hb);
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("lead");
  });

  it("T78 the whole inline note reaches the lead brief and its rendered prompt", () => {
    const s = stateAt("research", CARD, { research: true });
    const r = go(s, okHB("research", s, { note: INLINE_NOTE }));
    expect(r.action.brief.seat).toBe("lead");
    expect(r.action.brief.researchNote).toBe(INLINE_NOTE);
    const prompt = briefPrompt(r.action.brief, { repoRoot: "/abs/repo", worktreePath: WT });
    for (const line of INLINE_NOTE.split("\n")) expect(prompt).toContain(line);
  });

  it("T79 a blank or whitespace-only research note still stops hand-back-invalid naming note", () => {
    for (const note of ["", "   ", "\n\t "]) {
      const s = stateAt("research", CARD, { research: true });
      const hb = okHB("research", s, { note });
      expect(validateHandBack(s, hb).join(" ")).toContain("note");
      const r = go(s, hb);
      expect(r.action.kind).toBe("stopped");
      expect(r.action.reason).toBe("hand-back-invalid");
      expect(r.action.report.detail).toContain("note");
    }
  });

  it("T80 worker-contract.md names the M<n> mutation id form and the verbatim-echo rule", () => {
    const doc = readFileSync(CONTRACT_DOC, "utf8");
    const lead = doc.split("\n").find((l) => l.startsWith("- `lead`:"));
    expect(lead).toContain("M<n>");
    expect(lead).toContain("M1, M2");
    expect(doc).toContain("verbatim");
    expect(doc).toContain("M8a");
  });

  it("T81 the done report carries the research seat's inline note; null when no research seat ran", () => {
    const withR = walk(CARD, { research: true }, { "research#1": { note: INLINE_NOTE } });
    expect(withR.last.kind).toBe("done");
    expect(withR.last.report.researchNote).toBe(INLINE_NOTE);
    const without = walk(CARD, {});
    expect(without.last.kind).toBe("done");
    expect(without.last.report.researchNote).toBeNull();
  });
});

// Card seat-no-cpu-burners: a seat's loaded-run proof once started unbounded `yes` burners on a shared machine.
describe("no cpu burners", () => {
  const RULE_ID = "no-cpu-burners";
  const RULE_TEXT =
    "A burner is any process started only to load the machine (yes > /dev/null, stress, a busy loop), bounded or not; concurrent pnpm test:unit runs are not burners. Never start a burner without the user's yes: a seat that wants one stops and returns a designQuestion naming the load it would start (the process, how many, the timeout, and why), and starts it only after an answer from the user says yes. Before hand-back, confirm with ps that no load process you started survives, orphans reparented to PID 1 included, and kill any that does.";
  const WORKING = ["tester", "coder", "reviewer"];
  const lanes = {
    full: [CARD, { research: true }],
    lean: [{ ...CARD, size: "S", class: "prose" }, { research: true }],
    "tests-only": [{ ...CARD, class: "tests-only" }, { research: true }],
  };

  const SKILL = readFileSync(join(HERE, "..", "skills", "doug-hand", "SKILL.md"), "utf8");
  const SKILL_RULE = BRIEF_RULES[RULE_ID].text.replace(
    "concurrent pnpm test:unit runs",
    "concurrent runs of the project's test command (the commands in `stopGate.commands`)",
  );

  it("T88 the doug-hand skill carries the rule derived from the contract text, with no pnpm command", () => {
    expect(SKILL_RULE).not.toBe(BRIEF_RULES[RULE_ID].text);
    expect(SKILL_RULE).not.toContain("pnpm");
    expect(SKILL).toContain(SKILL_RULE);
  });

  it("T89 the skill states the rule once, and that the lead asks the user and resumes the seat", () => {
    const lines = SKILL.split("\n").filter((l) => l.includes(SKILL_RULE));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/Every tester, coder, and reviewer brief carries the no-CPU-burners rule verbatim/);
    expect(SKILL).toContain(
      "When a seat returns a question asking to start a burner, the lead asks the user and resumes the seat with the answer; no burner starts before a yes.",
    );
  });

  it("T70 the rule text is pinned", () => {
    expect(BRIEF_RULES[RULE_ID].text).toBe(RULE_TEXT);
  });

  it("T71 tester, coder and reviewer briefs carry the exact text on every lane they run on", () => {
    const seen = new Set();
    for (const [lane, [card, opts]] of Object.entries(lanes)) {
      const { actions } = walk(card, opts);
      for (const a of actions.filter((x) => x.kind === "seat" && WORKING.includes(x.seat))) {
        seen.add(lane + "/" + a.seat);
        const rule = a.brief.rules.find((r) => r.id === RULE_ID);
        expect(rule, `${lane}/${a.seat}`).toBeDefined();
        expect(rule.text, `${lane}/${a.seat}`).toBe(RULE_TEXT);
      }
    }
    for (const k of ["full/tester", "full/coder", "full/reviewer", "lean/coder", "lean/reviewer", "tests-only/tester", "tests-only/reviewer"]) {
      expect(seen.has(k), k).toBe(true);
    }
  });

  it("T72 setup, research, lead, gate and commit briefs do not carry the rule", () => {
    for (const [lane, [card, opts]] of Object.entries(lanes)) {
      const { actions } = walk(card, opts);
      for (const a of actions.filter((x) => x.kind === "seat" && !WORKING.includes(x.seat))) {
        expect(a.brief.rules.some((r) => r.id === RULE_ID), `${lane}/${a.seat}`).toBe(false);
      }
    }
  });

  it("T73 briefPrompt renders the rule into the tester, coder and reviewer prompts", () => {
    const { actions } = walk(CARD, { research: true });
    const seen = new Set();
    for (const a of actions.filter((x) => x.kind === "seat" && WORKING.includes(x.seat))) {
      seen.add(a.seat);
      expect(briefPrompt(a.brief, { repoRoot: "/r", worktreePath: "/w" }), a.seat).toContain(RULE_TEXT);
    }
    expect(seen.size).toBe(3);
  });
});

// Card commit-seat-no-file-edits: the commit seat commits exactly the tree the gate passed.
describe("commit seat tree", () => {
  const NO_EDIT =
    "Never edit, create, delete, or format a file: commit exactly the tree the gate seat passed (GATED TREE). A change the commit seems to need goes in blocked, never into the tree.";
  const COMMIT_TREE =
    "After git commit returns, run node .doug/hooks/lib/verified-tree.mjs commit-tree HEAD with the card worktree path as its second argument and report its output as tree: it hashes HEAD's tree without verified-tree's EXCLUDED paths, the same measure as GATED TREE; a tree that differs from GATED TREE stops the card. Never compare GATED TREE with git rev-parse HEAD^{tree}, which keeps .doug/anchor.md.";
  const GATE_TREE =
    "After the gate commands, run node .doug/hooks/lib/verified-tree.mjs tree with the card worktree path as its argument and report its output as tree.";
  const ruleOf = (a, id) => a.brief.rules.find((r) => r.id === id);

  function toCommit(gateTree = TREE_A) {
    let s = stateAt("gate");
    s = go(s, okHB("gate", s, { tree: gateTree })).state;
    expect(s.pending).toBe("commit");
    return s;
  }

  it("T82 only the commit brief carries commit-no-file-edits with the pinned text", () => {
    expect(BRIEF_RULES["commit-no-file-edits"].text).toBe(NO_EDIT);
    const { actions } = walk(CARD, { research: true });
    const seats = actions.filter((x) => x.kind === "seat");
    for (const a of seats) {
      const r = ruleOf(a, "commit-no-file-edits");
      if (a.seat === "commit") expect(r?.text).toBe(NO_EDIT);
      else expect(r, a.seat).toBeUndefined();
    }
  });

  it("T83 a commit tree differing from the gated tree stops commit-tree-mismatch", () => {
    const s = toCommit(TREE_A);
    const r = go(s, okHB("commit", s, { tree: TREE_B }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("commit-tree-mismatch");
    expect(r.action.report.stoppedAt).toBe("commit");
    expect(r.action.report.detail).toContain("abc1234");
    expect(r.action.report.detail).toContain(TREE_A);
    expect(r.action.report.detail).toContain(TREE_B);
    expect(r.action.report.commit).toBeNull();
    const good = go(s, okHB("commit", s, { tree: TREE_A }));
    expect(good.action.kind).toBe("done");
  });

  it("T84 the gated tree is the latest green gate's tree", () => {
    let s = stateAt("gate");
    const red = go(s, okHB("gate", s, { tree: TREE_A, commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 1 }] }));
    expect(red.action.kind).toBe("seat");
    s = red.state;
    let guard = 0;
    while (s.pending !== "gate") {
      if (guard++ > 20) throw new Error("never reached gate again");
      s = go(s, okHB(s.pending, s)).state;
    }
    s = go(s, okHB("gate", s, { tree: TREE_B })).state;
    expect(s.pending).toBe("commit");
    const r = go(s, okHB("commit", s, { tree: TREE_B }));
    expect(r.action.kind).toBe("done");
    expect(r.action.report.commit).toBe("abc1234");
  });

  it("T85 a gate hand-back without a valid tree stops hand-back-invalid naming tree", () => {
    const s = stateAt("gate");
    for (const tree of [undefined, "xyz"]) {
      const r = go(s, okHB("gate", s, { tree }));
      expect(r.action.reason, String(tree)).toBe("hand-back-invalid");
      expect(r.action.report.detail).toContain("tree");
    }
  });

  it("T85b a commit hand-back without a valid tree stops hand-back-invalid naming tree", () => {
    const s = toCommit();
    for (const tree of [undefined, "xyz"]) {
      const r = go(s, okHB("commit", s, { tree }));
      expect(r.action.reason, String(tree)).toBe("hand-back-invalid");
      expect(r.action.report.detail).toContain("tree");
    }
  });

  it("T86 the commit brief names the gated tree; other prompts carry no GATED TREE line", () => {
    const s = toCommit(TREE_A);
    const a = currentAction(s);
    expect(a.brief.gateTree).toBe(TREE_A);
    expect(briefPrompt(a.brief, { repoRoot: "/r", worktreePath: "/w" })).toContain("GATED TREE: " + TREE_A);
    const { actions } = walk(CARD, { research: true });
    for (const x of actions.filter((y) => y.kind === "seat" && y.seat !== "commit")) {
      expect(briefPrompt(x.brief, { repoRoot: "/r", worktreePath: "/w" }), x.seat).not.toContain("GATED TREE:");
    }
  });

  it("T88 only the commit brief carries commit-reword-tree-equal, naming the amend and no stop", () => {
    const rule = BRIEF_RULES["commit-reword-tree-equal"];
    expect(rule?.seats).toEqual(["commit"]);
    expect(rule.text).toContain("git commit --amend --only -m");
    expect(rule.text).toContain("do not stop or set blocked");
    expect(rule.text).toContain("commit-tree HEAD");
    expect(rule.text).toContain("git merge-base --is-ancestor HEAD");
    const { actions } = walk(CARD, { research: true });
    for (const a of actions.filter((x) => x.kind === "seat")) {
      expect(!!ruleOf(a, "commit-reword-tree-equal"), a.seat).toBe(a.seat === "commit");
    }
  });

  it("T89 the commit prompt carries BASE: <base>; other seats' prompts carry no BASE: line", () => {
    const opts = { repoRoot: "/r", worktreePath: "/w" };
    const def = currentAction(toCommit());
    expect(briefPrompt(def.brief, opts)).toContain("BASE: main");
    let s = stateAt("gate", CARD, { base: "dev" });
    s = go(s, okHB("gate", s, { tree: TREE_A })).state;
    expect(briefPrompt(currentAction(s).brief, opts)).toContain("BASE: dev");
    const { actions } = walk(CARD, { research: true });
    for (const x of actions.filter((y) => y.kind === "seat" && y.seat !== "commit")) {
      expect(briefPrompt(x.brief, opts), x.seat).not.toMatch(/^BASE:/m);
    }
  });

  it("T87 the gate and commit briefs say how to report the tree", () => {
    expect(BRIEF_RULES["gate-reports-tree"].text).toBe(GATE_TREE);
    expect(BRIEF_RULES["commit-reports-tree"].text).toBe(COMMIT_TREE);
    const { actions } = walk(CARD, { research: true });
    for (const a of actions.filter((x) => x.kind === "seat")) {
      expect(!!ruleOf(a, "gate-reports-tree"), a.seat).toBe(a.seat === "gate");
      expect(!!ruleOf(a, "commit-reports-tree"), a.seat).toBe(a.seat === "commit");
    }
  });
});

// Card card-loop-reviewer-answer-reaches-coder: an answer to a reviewer stop that orders a fix reaches a coder round.
describe("card card-loop-reviewer-answer-reaches-coder: reviewer answers", () => {
  const major = (over = {}) => ({ id: "F2", severity: "major", file: "b.mjs", description: "meh", evidence: "ran X, saw Y", ...over });
  const QUESTION = "major with evidence still open after one fix pass: F2";
  const ANSWER = "Fix F2.";
  const withAnswer = (answer = ANSWER) => ({ answers: [{ seat: "reviewer", question: QUESTION, answer, round: 2 }] });
  const fail = (s, findings) => go(s, okHB("reviewer", s, { verdict: "fail", findings }));

  // reviewer 1 fails, fix-pass coder 2, reviewer 2 (carries the answer): returns the result of reviewer 2.
  function toReviewer2(options, findings2) {
    const s = stateAt("reviewer", CARD, options);
    const r1 = fail(s, [major()]);
    expect(r1.state.pending).toBe("coder");
    const fixPass = currentAction(r1.state).brief;
    const r2 = ok(r1.state);
    expect(r2.state.pending).toBe("reviewer");
    return { fixPass, r3: findings2 ? fail(r2.state, findings2) : go(r2.state, okHB("reviewer", r2.state)) };
  }

  it("T90 a reviewer answer reaches the next coder brief, not the fix-pass coder before it", () => {
    const { fixPass, r3 } = toReviewer2(withAnswer(), [major()]);
    expect(fixPass.round).toBe(2);
    expect(fixPass.answers).toEqual([]);
    expect(r3.action.kind).toBe("seat");
    expect(r3.state.pending).toBe("coder");
    const brief = r3.action.brief;
    expect(brief.round).toBe(3);
    expect(brief.answers).toEqual([{ question: QUESTION, answer: ANSWER }]);
    expect(brief.findings.map((f) => f.id)).toEqual(["F2"]);
    expect(briefPrompt(brief, { worktreePath: WT })).toContain("Q: " + QUESTION + " A: " + ANSWER);
    expect(briefPrompt(fixPass, { worktreePath: WT })).not.toContain("ANSWERS FROM THE USER");
  });

  it("T91 the answer-driven coder round is followed by the reviewer, which can pass to the gate", () => {
    const { r3 } = toReviewer2(withAnswer(), [major()]);
    const r4 = ok(r3.state);
    expect(r4.state.pending).toBe("reviewer");
    const r5 = go(r4.state, okHB("reviewer", r4.state));
    expect(r5.state.pending).toBe("gate");
  });

  it("T92 an accept-only answer adds no coder round: a passing reviewer goes straight to the gate", () => {
    const { r3 } = toReviewer2(withAnswer("Accept F2 as minor."));
    expect(r3.action.kind).toBe("seat");
    expect(r3.state.pending).toBe("gate");
    expect(r3.state.counters.coderRounds).toBe(2);
  });

  it("T93 the answer-driven coder round happens once: a major still open after it stops reviewer-major-open", () => {
    const { r3 } = toReviewer2(withAnswer(), [major()]);
    expect(r3.state.pending).toBe("coder");
    const r4 = ok(r3.state);
    const r5 = fail(r4.state, [major()]);
    expect(r5.action.kind).toBe("stopped");
    expect(r5.action.reason).toBe("reviewer-major-open");
  });

  it("T94 the answer-driven coder round happens once: a blocker still open after it stops reviewer-blocker-open", () => {
    const { r3 } = toReviewer2(withAnswer(), [major()]);
    expect(r3.state.pending).toBe("coder");
    const r4 = ok(r3.state);
    const r5 = fail(r4.state, [blocker()]);
    expect(r5.action.kind).toBe("stopped");
    expect(r5.action.reason).toBe("reviewer-blocker-open");
  });
});

// Card card-loop-later-answer-reaches-coder: every user answer to a reviewer stop runs one coder round.
describe("card card-loop-later-answer-reaches-coder: second reviewer answer", () => {
  const major = (over = {}) => ({ id: "F2", severity: "major", file: "b.mjs", description: "meh", evidence: "ran X, saw Y", ...over });
  const Q2 = "major with evidence still open after one fix pass: F2";
  const A1 = "Fix F2.";
  const A2 = "Fix F2 properly, the first attempt missed it.";
  const twoAnswers = () => ({
    answers: [
      { seat: "reviewer", question: Q2, answer: A1, round: 2 },
      { seat: "reviewer", question: Q2, answer: A2, round: 3 },
    ],
  });
  const fail = (s, findings) => go(s, okHB("reviewer", s, { verdict: "fail", findings }));

  // reviewer 1 fails, coder 2 (fix pass), reviewer 2 fails, coder 3 (answer 1), reviewer 3 fails: returns that result.
  function toReviewer3() {
    const s = stateAt("reviewer", CARD, twoAnswers());
    const r1 = fail(s, [major()]);
    const c2 = ok(r1.state);
    const r2 = fail(c2.state, [major()]);
    expect(r2.state.pending).toBe("coder");
    expect(r2.action.brief.round).toBe(3);
    const c3 = ok(r2.state);
    expect(c3.state.pending).toBe("reviewer");
    return { r2, r3: (findings) => fail(c3.state, findings) };
  }

  it("T100 a second answer to a later reviewer stop runs one more coder round, not a stop", () => {
    const { r3 } = toReviewer3();
    const r = r3([major()]);
    expect(r.action.kind).toBe("seat");
    expect(r.state.pending).toBe("coder");
    expect(r.action.brief.round).toBe(4);
    expect(r.action.brief.findings.map((f) => f.id)).toEqual(["F2"]);
  });

  it("T101 the coder round driven by the second answer carries both answers; coder 3 stays without the second", () => {
    const { r2, r3 } = toReviewer3();
    expect(r2.action.brief.answers).toEqual([{ question: Q2, answer: A1 }]);
    const brief = r3([major()]).action.brief;
    expect(brief.answers).toEqual([
      { question: Q2, answer: A1 },
      { question: Q2, answer: A2 },
    ]);
    expect(briefPrompt(brief, { worktreePath: WT })).toContain("A: " + A2);
    expect(briefPrompt(r2.action.brief, { worktreePath: WT })).not.toContain(A2);
  });

  it("T102 each answer gives one coder round: a major open after the second one stops reviewer-major-open", () => {
    const { r3 } = toReviewer3();
    const c4 = ok(r3([major()]).state);
    const r4 = fail(c4.state, [major()]);
    expect(r4.action.kind).toBe("stopped");
    expect(r4.action.reason).toBe("reviewer-major-open");
  });

  it("T103 each answer gives one coder round: a blocker open after the second one stops reviewer-blocker-open", () => {
    const { r3 } = toReviewer3();
    const c4 = ok(r3([major()]).state);
    const r4 = fail(c4.state, [blocker()]);
    expect(r4.action.kind).toBe("stopped");
    expect(r4.action.reason).toBe("reviewer-blocker-open");
  });
});

describe("card card-worktree-deps-survive-seats: install runs in the worktree and the gate reinstalls", () => {
  const REPO = "/abs/repo";
  const WTP = REPO + "/.claude/worktrees/card-c1";
  const INSTALL = "pnpm install --frozen-lockfile";
  const VERIFY = "node .doug/hooks/scripts/verify.mjs";
  const CDI = `cd ${WTP} && ${INSTALL}`;
  const gateAt = (install = INSTALL) => stateAt("gate", CARD, { install });
  const gateHB2 = (s, commands) => okHB("gate", s, { commands });

  it("T90 the setup prompt renders the install as one literal cd <worktree> && <install> after the worktree add", () => {
    const s = initialState(CARD, { install: INSTALL });
    const t = briefPrompt(currentAction(s).brief, { repoRoot: REPO, worktreePath: WTP });
    const add = `git -C ${REPO} worktree add -b card/c1 ${WTP} main`;
    expect(t).toContain(CDI);
    expect(t.indexOf(CDI)).toBeGreaterThan(t.indexOf(add));
  });

  it("T91 the gate brief carries the install command and renders it as cd <worktree> && <install>; none when install is null", () => {
    const b = currentAction(gateAt()).brief;
    expect(b.install).toBe(INSTALL);
    const t = briefPrompt(b, { repoRoot: REPO, worktreePath: WTP });
    expect(t).toContain("INSTALL COMMAND");
    expect(t).toContain(CDI);
    const n = currentAction(gateAt(null)).brief;
    expect(briefPrompt(n, { repoRoot: REPO, worktreePath: WTP })).not.toContain("INSTALL COMMAND");
  });

  it("T92 only the gate brief carries gate-reinstall-missing-deps, and only when install is set", () => {
    const ids = (seat, install) => currentAction(stateAt(seat, CARD, { install })).brief.rules.map((r) => r.id);
    expect(ids("gate", INSTALL)).toContain("gate-reinstall-missing-deps");
    for (const seat of ["commit", "coder", "reviewer", "tester"]) {
      expect(ids(seat, INSTALL)).not.toContain("gate-reinstall-missing-deps");
    }
    expect(ids("gate", null)).not.toContain("gate-reinstall-missing-deps");
    const rule = currentAction(gateAt()).brief.rules.find((r) => r.id === "gate-reinstall-missing-deps");
    const text = rule.text.toLowerCase();
    expect(text).toContain("node_modules");
    expect(text).toContain("only when");
    expect(text).toContain("missing");
    expect(text).toContain("first commands item");
  });

  it("T93 a green reinstall followed by a green gate goes to commit with no red counted", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [{ command: `cd ${s.worktree} && ${INSTALL}`, exitCode: 0 }, { command: VERIFY, exitCode: 0 }]));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("commit");
    expect(r.state.counters.redGates).toBe(0);
  });

  it("T94 a failed reinstall stops setup-failed at once: no red counted, no coder seat", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [{ command: `cd ${s.worktree} && ${INSTALL}`, exitCode: 1 }]));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("setup-failed");
    expect(r.state.counters.redGates).toBe(0);
    expect(r.action.seat).toBeUndefined();
  });

  it("T95 a green reinstall followed by a red gate keeps the red path", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [{ command: `cd ${s.worktree} && ${INSTALL}`, exitCode: 0 }, { command: VERIFY, exitCode: 1 }]));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.state.counters.redGates).toBe(1);
  });

  it("T96 with install set and node_modules present, a red verify goes to the coder, then gate-red-twice", () => {
    const s = gateAt();
    const red = [{ command: VERIFY, exitCode: 1 }];
    const r1 = go(s, gateHB2(s, red));
    expect(r1.action.seat).toBe("coder");
    expect(r1.state.fixFor).toBe("gate");
    expect(r1.state.counters.redGates).toBe(1);
    const r2 = ok(ok(r1.state).state);
    expect(r2.action.seat).toBe("gate");
    const r3 = go(r2.state, gateHB2(r2.state, red));
    expect(r3.action.kind).toBe("stopped");
    expect(r3.action.reason).toBe("gate-red-twice");
  });

  it("T97 a hand-back holding only a green reinstall does not reach commit: hand-back-invalid naming the gate command, no red counted", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [{ command: `cd ${s.worktree} && ${INSTALL}`, exitCode: 0 }]));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
    expect(r.state.counters.redGates).toBe(0);
    expect(JSON.stringify(r.action)).toContain(VERIFY);
  });

  it("T97b a green hand-back with only git status and no gate command run stops hand-back-invalid", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [{ command: "git status", exitCode: 0 }]));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hand-back-invalid");
    expect(r.state.counters.redGates).toBe(0);
  });

  it("T98 a gate command containing the install text is not a reinstall: it takes the red path", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [{ command: `cd ${s.worktree} && ${INSTALL} && ${VERIFY}`, exitCode: 1 }]));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("coder");
    expect(r.state.fixFor).toBe("gate");
    expect(r.state.counters.redGates).toBe(1);
  });

  it("T99 the gate command run as cd <worktree> && <gate> after a green reinstall still counts and reaches commit", () => {
    const s = gateAt();
    const r = go(s, gateHB2(s, [
      { command: `cd ${s.worktree} && ${INSTALL}`, exitCode: 0 },
      { command: `cd ${s.worktree} && ${VERIFY}`, exitCode: 0 },
    ]));
    expect(r.action.kind).toBe("seat");
    expect(r.action.seat).toBe("commit");
  });
});

describe("coverage", () => {
  it("T32 every STOP_REASONS entry is produced by at least one test", () => {
    expect([...seenReasons].sort()).toEqual([...STOP_REASONS].sort());
    expect(STOP_REASONS.length).toBe(12);
  });
});

// Card seat-test-runs-take-gate-lock: seats' own suite runs queue behind gate.lock instead of overlapping a gate.
describe("seat test runs take gate.lock", () => {
  const RULES = {
    "suites-through-verify": {
      seats: ["tester", "coder", "reviewer", "gate"],
      text: "Run a full test suite only through `node .doug/hooks/scripts/verify.mjs`, never the gate's commands (the commands in `stopGate.commands`) directly, with or without CI=1: verify.mjs takes gate.lock, so your suite queues behind a running gate instead of overlapping it.",
    },
    "tests-take-gate-lock": {
      seats: ["tester", "coder", "reviewer"],
      text: "Run every other test command, a single test file or a mutation's test run in a scratch copy included, as `node <card worktree>/.doug/hooks/lib/gate-lock.mjs run -- <command>` with the Bash timeout set to 600000, so it waits on gate.lock instead of overlapping a gate; never wrap verify.mjs in gate-lock.mjs, since verify.mjs takes the lock itself. Put env vars right after `--` (`-- CI=1 pnpm exec vitest run <file>`) and quote a compound command as one argument (`-- 'cd dir && vitest run x'`).",
    },
  };
  const lanes = {
    full: [CARD, { research: true }],
    lean: [{ ...CARD, size: "S", class: "prose" }, { research: true }],
    "tests-only": [{ ...CARD, class: "tests-only" }, { research: true }],
  };

  for (const [id, { seats, text }] of Object.entries(RULES)) {
    it(`${id} text is pinned and has no mutations condition`, () => {
      expect(BRIEF_RULES[id].text).toBe(text);
      expect(BRIEF_RULES[id].when).toBeUndefined();
    });

    it(`${id} reaches exactly its seats on every lane, and renders in the prompt`, () => {
      const seen = new Set();
      for (const [lane, [card, opts]] of Object.entries(lanes)) {
        const { actions } = walk(card, opts);
        for (const a of actions.filter((x) => x.kind === "seat")) {
          const rule = a.brief.rules.find((r) => r.id === id);
          if (seats.includes(a.seat)) {
            seen.add(lane + "/" + a.seat);
            expect(rule, `${lane}/${a.seat}`).toBeDefined();
            expect(rule.text).toBe(text);
            expect(briefPrompt(a.brief, { repoRoot: "/r", worktreePath: "/w" }), `${lane}/${a.seat}`).toContain(text);
          } else {
            expect(rule, `${lane}/${a.seat}`).toBeUndefined();
          }
        }
      }
      expect(seen.has("lean/coder")).toBe(true);
      expect(seen.has("lean/reviewer")).toBe(true);
    });
  }

  it("the plugin seat agents carry both sentences", () => {
    for (const f of ["tester", "coder", "reviewer", "implementer"]) {
      const prose = readFileSync(join(HERE, "..", "agents", f + ".md"), "utf8");
      expect(prose, f).toContain("Run a full test suite only through `node .doug/hooks/scripts/verify.mjs`");
      expect(prose, f).toContain("never wrap verify.mjs in gate-lock.mjs, since verify.mjs takes the lock itself");
      expect(prose, f).toContain("gate-lock.mjs run -- <command>");
    }
  });
});

// Card gate-lock-run-shell-forms: the lock-runner rule names the forms that work, and implementer.md agrees with
// the flow's implement prompt.
describe("gate-lock run shell forms prose", () => {
  const agent = (f) => readFileSync(join(HERE, "..", "agents", f + ".md"), "utf8");

  it("tests-take-gate-lock tells seats the env-prefix form and to quote a compound command as one argument", () => {
    const t = BRIEF_RULES["tests-take-gate-lock"].text;
    expect(t).toMatch(/CI=1/);
    expect(t).toMatch(/quot|sh -c/);
  });

  it("the plugin seat agents carry the env-prefix and compound-command clause", () => {
    for (const f of ["tester", "coder", "reviewer", "implementer"]) {
      const line = agent(f).split("\n").find((l) => l.includes("gate-lock.mjs run -- <command>")) ?? "";
      expect(line, f).toMatch(/CI=1/);
      expect(line, f).toMatch(/quot|sh -c/);
    }
  });

  it("implementer.md rule 8 allows the task's verification command as written", () => {
    const rule8 = agent("implementer").split("\n").find((l) => l.startsWith("8. ")) ?? "";
    expect(rule8).toMatch(/verification command/);
    const impl = readFileSync(join(HERE, "..", "workflows", "doug-implement.js"), "utf8");
    expect(impl).toContain("Run the verification command before finishing");
  });

  it("implementer.md rules 8 and 9 sit above the closing line, which is the last non-empty line", () => {
    const prose = agent("implementer");
    const closing = "Your final output is the structured result, not a message to a person.";
    const at = prose.indexOf(closing);
    expect(at).toBeGreaterThan(-1);
    expect(prose.indexOf("8. Run a full test suite")).toBeGreaterThan(-1);
    expect(prose.indexOf("8. Run a full test suite")).toBeLessThan(at);
    expect(prose.indexOf("9. Run every other test command")).toBeLessThan(at);
    expect(prose.trim().split("\n").pop()).toBe(closing);
  });
});

describe("hookBlocked placeholder message", () => {
  const stopsOrAdvances = (seat, message) => {
    const s = stateAt(seat);
    return go(s, okHB(seat, s, { hookBlocked: { message } }));
  };

  it("T104 hookBlocked with a placeholder message (none) does not stop: commit lands done, coder goes on to the reviewer", () => {
    const commit = stopsOrAdvances("commit", "none");
    expect(commit.action.kind).toBe("done");
    expect(commit.action.report.commit?.sha ?? "abc1234").toContain("abc1234");
    const coder = stopsOrAdvances("coder", "none");
    expect(coder.action.kind).toBe("seat");
    expect(coder.action.seat).toBe("reviewer");
  });

  it("T105 placeholder match ignores case and surrounding space for none, n/a and null", () => {
    for (const m of ["None", "NONE", " none ", "N/A", "n/a", "Null", "NULL", "\tnull\n"]) {
      const r = stopsOrAdvances("commit", m);
      expect(r.action.kind, JSON.stringify(m)).toBe("done");
    }
  });

  it("T106 a blank hookBlocked message is no block and passes validation", () => {
    for (const m of ["", "   ", "\n"]) {
      const r = stopsOrAdvances("commit", m);
      expect(r.action.kind, JSON.stringify(m)).toBe("done");
      const c = stopsOrAdvances("coder", m);
      expect(c.action.kind, JSON.stringify(m)).toBe("seat");
    }
  });

  it("T107 a real hookBlocked message stops with hook-blocked even when it starts with none", () => {
    for (const m of ["protect-paths refused the edit", "none of the paths were writable: protect-paths refused", "n/a: guard-bash denied it", "nullified by hook"]) {
      for (const seat of ["coder", "commit"]) {
        const s = stateAt(seat);
        const r = go(s, noResultHB(seat, s, { message: m }));
        expect(r.action.kind, m).toBe("stopped");
        expect(r.action.reason, m).toBe("hook-blocked");
        expect(r.action.report.detail).toContain(m);
      }
    }
  });
});

// Card gate-answer-reaches-coder: an answer to a gate stop runs one build-seat round, then reviewer, gate.
describe("card gate-answer-reaches-coder: gate answers", () => {
  const QUESTION = "gate red: the test needs a fix";
  const ANSWER = "Fix the test first.";
  const RERUN = "Rerun alone: no other queen is in flight now.";
  const gateAns = (answer = ANSWER) => ({ answers: [{ seat: "gate", question: QUESTION, answer, round: 1 }] });
  const TESTS_ONLY = { ...CARD, class: "tests-only" };
  const reviewerPass = (s) => go(s, okHB("reviewer", s));

  it("G01 a passing reviewer with a gate answer goes to the coder, not the gate", () => {
    const s = stateAt("reviewer", CARD, gateAns());
    const r = reviewerPass(s);
    expect(r.action.kind).toBe("seat");
    expect(r.state.pending).toBe("coder");
    expect(r.action.brief.round).toBe(2);
  });

  it("G02 the answer-driven coder brief carries the gate answer", () => {
    const s = stateAt("reviewer", CARD, gateAns());
    const brief = reviewerPass(s).action.brief;
    expect(brief.answers).toEqual([{ question: QUESTION, answer: ANSWER }]);
    expect(briefPrompt(brief, { worktreePath: WT })).toContain("Q: " + QUESTION + " A: " + ANSWER);
  });

  it("G03 the extra round runs once: coder, reviewer, gate, then done with two coder rounds", () => {
    const s = stateAt("reviewer", CARD, gateAns());
    const r1 = reviewerPass(s);
    const r2 = ok(r1.state);
    expect(r2.state.pending).toBe("reviewer");
    const r3 = reviewerPass(r2.state);
    expect(r3.state.pending).toBe("gate");
    expect(r3.state.counters.coderRounds).toBe(2);
    const r4 = ok(r3.state);
    expect(r4.state.pending).toBe("commit");
    const r5 = ok(r4.state);
    expect(r5.action.kind).toBe("done");
    expect(r5.state.counters.coderRounds).toBe(2);
  });

  it("G04 a gate answer leaves the round-1 coder and reviewer briefs unchanged (resume replay)", () => {
    const plain = initialState(CARD, {});
    const withAns = initialState(CARD, gateAns());
    let a = plain;
    let b = withAns;
    while (a.pending !== "coder") {
      a = ok(a).state;
      b = ok(b).state;
    }
    expect(currentAction(b).brief).toEqual(currentAction(a).brief);
    expect(briefPrompt(currentAction(b).brief, { worktreePath: WT })).toBe(briefPrompt(currentAction(a).brief, { worktreePath: WT }));
    a = ok(a).state;
    b = ok(b).state;
    expect(b.pending).toBe("reviewer");
    expect(currentAction(b).brief).toEqual(currentAction(a).brief);
    expect(briefPrompt(currentAction(b).brief, { worktreePath: WT })).toBe(briefPrompt(currentAction(a).brief, { worktreePath: WT }));
  });

  it("G05 a rerun-alone gate answer reaches only the gate: reviewer pass goes straight to the gate", () => {
    const s = stateAt("reviewer", CARD, gateAns(RERUN));
    const r = reviewerPass(s);
    expect(r.state.pending).toBe("gate");
    expect(r.state.counters.coderRounds).toBe(1);
    expect(r.action.brief.answers).toEqual([{ question: QUESTION, answer: RERUN }]);
  });

  it("G06 the gate seat's own brief still carries its answer", () => {
    const s = stateAt("gate", CARD, gateAns());
    expect(currentAction(s).brief.answers).toEqual([{ question: QUESTION, answer: ANSWER }]);
  });

  it("G07 tests-only lane routes the gate answer to the tester", () => {
    const s = stateAt("reviewer", TESTS_ONLY, gateAns());
    const r = reviewerPass(s);
    expect(r.action.kind).toBe("seat");
    expect(r.state.pending).toBe("tester");
    expect(r.action.brief.answers).toEqual([{ question: QUESTION, answer: ANSWER }]);
  });

  it("G08 with no gate answer a passing reviewer goes to the gate", () => {
    const s = stateAt("reviewer", CARD, {});
    expect(reviewerPass(s).state.pending).toBe("gate");
  });
});

// Card commit-seat-retry-not-blocked: a hook block a seat recovered from, with a complete valid result, is not a stop.
describe("card commit-seat-retry-not-blocked: recovered hook blocks", () => {
  const MSG = "First git commit attempt exited 1 (pre-commit hook). The retry passed and the commit landed";

  it("R01 a commit hand-back with sha, matching tree and a real hookBlocked is done with the sha", () => {
    const s = stateAt("commit");
    const r = go(s, okHB("commit", s, { hookBlocked: { message: MSG } }));
    expect(r.action.kind).toBe("done");
    expect(r.action.report.commit).toBe("abc1234");
  });

  it("R02 a hookBlocked with no result still stops hook-blocked with the message as detail", () => {
    for (const seat of ["commit", "coder", "reviewer"]) {
      const s = stateAt(seat);
      const r = go(s, noResultHB(seat, s, { message: MSG }));
      expect(r.action.kind, seat).toBe("stopped");
      expect(r.action.reason, seat).toBe("hook-blocked");
      expect(r.action.report.detail, seat).toContain(MSG);
    }
  });

  it("R03 a commit with sha, a tree differing from the gated tree and hookBlocked stops hook-blocked", () => {
    const s = stateAt("commit");
    const r = go(s, okHB("commit", s, { tree: TREE_B, hookBlocked: { message: MSG } }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("hook-blocked");
  });

  it("R04 the rule is per seat: reviewer pass with mutationResults and hookBlocked goes to the gate; coder to the reviewer", () => {
    const rs = stateAt("reviewer");
    const rr = go(rs, okHB("reviewer", rs, { hookBlocked: { message: "git commit --no-verify refused in scratch clone" } }));
    expect(rr.action.kind).toBe("seat");
    expect(rr.action.seat).toBe("gate");
    const cs = stateAt("coder");
    const cr = go(cs, okHB("coder", cs, { hookBlocked: { message: "a side step was refused, recovered" } }));
    expect(cr.action.kind).toBe("seat");
    expect(cr.action.seat).toBe("reviewer");
  });

  it("R05 a recovered hook message is recorded in the final report followUps", () => {
    const s = stateAt("commit");
    const r = go(s, okHB("commit", s, { hookBlocked: { message: MSG } }));
    expect(r.action.report.followUps.some((f) => String(f).includes(MSG))).toBe(true);
    const rs = stateAt("reviewer");
    let st = go(rs, okHB("reviewer", rs, { hookBlocked: { message: MSG } })).state;
    let guard = 0;
    let last;
    while (st.pending) {
      if (guard++ > 20) throw new Error("no end");
      last = go(st, okHB(st.pending, st));
      st = last.state;
    }
    expect(last.action.kind).toBe("done");
    expect(last.action.report.followUps.some((f) => String(f).includes(MSG))).toBe(true);
  });

  it("R06 the hook-block-report rule tells seats to report hookBlocked only when the step finally failed", () => {
    expect(BRIEF_RULES["hook-block-report"].text).toMatch(/finally failed/i);
    const s = stateAt("coder");
    const a = currentAction(s);
    expect(briefPrompt(a.brief, { repoRoot: "/r", worktreePath: "/w" })).toMatch(/finally failed/i);
  });
});

// Card skill-hashes-pin-owned: a card that changes a pinned file owns its pin file.
describe("card skill-hashes-pin-owned: owned list carries the pin file", () => {
  const PIN = "tests/replay/skill-hashes.json";
  const QUEEN = "plugins/doug-flow/workflows/card-queen.js";
  const PINS = { [PIN]: [QUEEN, "plugins/doug-flow/workflows/doug-implement.js"] };
  const toReviewer = (owned, pins = PINS, extra = {}) => {
    let st = ok(stateAt("lead", CARD, { pins }), { ownedFiles: owned, ...extra }).state;
    while (st.pending !== "reviewer") st = ok(st).state;
    return currentAction(st).brief;
  };

  it("P01 a lead owning card-queen.js yields an owned list with the pin file", () => {
    expect(toReviewer([QUEEN]).ownedFiles).toEqual([QUEEN, PIN]);
  });

  it("P02 a lead owning no pinned file yields exactly its own list", () => {
    expect(toReviewer(["plugins/doug-flow/lib/a.mjs"]).ownedFiles).toEqual(["plugins/doug-flow/lib/a.mjs"]);
  });

  it("P03 the owned list reaches the reviewer's brief text as OWNED FILES", () => {
    const text = briefPrompt(toReviewer([QUEEN]));
    expect(text).toContain("OWNED FILES:");
    expect(text).toContain("- " + PIN);
    expect(briefPrompt(toReviewer([]))).not.toContain("OWNED FILES:");
  });

  it("P04 an absolute owned path still pulls in the pin file", () => {
    expect(toReviewer(["/abs/worktree/c1/" + QUEEN]).ownedFiles).toContain(PIN);
  });

  it("P05 ownedWithPins dedupes, keeps order, never duplicates an owned pin file", () => {
    expect(ownedWithPins([QUEEN, QUEEN], PINS)).toEqual([QUEEN, PIN]);
    expect(ownedWithPins([PIN, QUEEN], PINS)).toEqual([PIN, QUEEN]);
    expect(ownedWithPins([QUEEN], {})).toEqual([QUEEN]);
  });

  it("P06 a malformed options.pins throws TypeError naming options.pins", () => {
    expect(() => initialState(CARD, { pins: { [PIN]: "not-an-array" } })).toThrow(TypeError);
    expect(() => initialState(CARD, { pins: { [PIN]: "not-an-array" } })).toThrow(/options\.pins/);
  });

  it("P07 lead ownedFiles must be an array of strings; absent stays valid; owned-files rule is lead-only", () => {
    const s = stateAt("lead");
    expect(validateHandBack(s, okHB("lead", s))).toEqual([]);
    expect(validateHandBack(s, okHB("lead", s, { ownedFiles: ["a"] }))).toEqual([]);
    expect(validateHandBack(s, okHB("lead", s, { ownedFiles: "a" })).join(" ")).toContain("ownedFiles must be an array of strings");
    expect(currentAction(s).brief.rules.map((r) => r.id)).toContain("owned-files");
    expect(currentAction(stateAt("coder")).brief.rules.map((r) => r.id)).not.toContain("owned-files");
  });
});

// Card commit-seat-precommit-flake: the commit seat logs each git commit under .doug/.state and reports a failed
// attempt's test names (precommitFailures), so a first-attempt pre-commit failure is never lost to truncation.
describe("card commit-seat-precommit-flake: commit seat pre-commit log", () => {
  const PF = [{ attempt: 1, exitCode: 1, log: "/w/.doug/.state/commit/attempt-1.log", tests: ["a.test.mjs > s > t"] }];
  const toCommit = () => stateAt("commit");

  it("P01 the commit brief carries commit-precommit-log naming the log path and the failing-tests command; no other seat does", () => {
    const { actions } = walk(CARD, { research: true });
    let seen = false;
    for (const a of actions.filter((x) => x.kind === "seat")) {
      const r = a.brief.rules.find((x) => x.id === "commit-precommit-log");
      if (a.seat === "commit") {
        seen = true;
        expect(r, "commit").toBeDefined();
        expect(r.text).toContain(".doug/.state/commit/attempt-");
        expect(r.text).toContain("run.mjs failing-tests");
        expect(r.text).toContain("precommitFailures");
      } else expect(r, a.seat).toBeUndefined();
    }
    expect(seen).toBe(true);
    expect(BRIEF_RULES["commit-precommit-log"].seats).toEqual(["commit"]);
  });

  it("P02 the commit schema declares precommitFailures as optional", () => {
    expect(HAND_BACK_SCHEMAS.commit.properties.precommitFailures).toBeDefined();
    expect(HAND_BACK_SCHEMAS.commit.required).not.toContain("precommitFailures");
  });

  it("P03 a commit hand-back with precommitFailures reports them and adds a followUps line naming tests and log", () => {
    const s = toCommit();
    const r = go(s, okHB("commit", s, { precommitFailures: PF }));
    expect(r.action.kind).toBe("done");
    expect(r.action.report.precommitFailures).toEqual(PF);
    const fu = r.action.report.followUps.filter((f) => String(f).includes("a.test.mjs > s > t"));
    expect(fu).toHaveLength(1);
    expect(fu[0]).toContain("/w/.doug/.state/commit/attempt-1.log");
    expect(fu[0]).toContain("attempt 1");
  });

  it("P04 an empty tests list reads 'no failing test named'; a null exitCode is accepted", () => {
    const s = toCommit();
    const pf = [{ attempt: 2, exitCode: null, log: "/w/l.log", tests: [] }];
    const r = go(s, okHB("commit", s, { precommitFailures: pf }));
    expect(r.action.kind).toBe("done");
    expect(r.action.report.followUps.some((f) => String(f).includes("no failing test named"))).toBe(true);
  });

  it("P05 a report without precommitFailures carries an empty array", () => {
    const s = toCommit();
    const r = go(s, okHB("commit", s));
    expect(r.action.report.precommitFailures).toEqual([]);
  });

  it("P06 a stopping commit seat (blocked) still reports its precommitFailures", () => {
    const s = toCommit();
    const r = go(s, okHB("commit", s, { blocked: "cannot commit", precommitFailures: PF }));
    expect(r.action.kind).toBe("stopped");
    expect(r.action.reason).toBe("seat-blocked");
    expect(r.action.report.precommitFailures).toEqual(PF);
    expect(r.action.report.followUps.some((f) => String(f).includes("a.test.mjs > s > t"))).toBe(true);
  });

  it("P07 malformed precommitFailures stop hand-back-invalid", () => {
    const s = toCommit();
    const good = PF[0];
    const bad = [
      "x",
      [null],
      [{ ...good, attempt: 0 }],
      [{ ...good, attempt: 1.5 }],
      [{ ...good, tests: "a" }],
      [{ ...good, tests: [1] }],
      [{ ...good, log: "" }],
      [{ ...good, exitCode: "1" }],
      [{ attempt: 1, exitCode: 1, tests: [] }],
      [{ attempt: 1, exitCode: 1, log: "/l" }],
    ];
    for (const precommitFailures of bad) {
      const r = go(s, okHB("commit", s, { precommitFailures }));
      expect(r.action.kind, JSON.stringify(precommitFailures)).toBe("stopped");
      expect(r.action.reason, JSON.stringify(precommitFailures)).toBe("hand-back-invalid");
    }
  });

  it("P08 worker-contract.md names precommitFailures", () => {
    expect(readFileSync(CONTRACT_DOC, "utf8")).toContain("precommitFailures");
  });
});
