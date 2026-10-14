// Card parallel-card-queens, brief B1: the coordinator (lib/coordinator.mjs), a pure library. The contract pinned here:
//
//   card      { id, goal, component?, track: "hand"|"flow", class?, swarm?: true }
//   plan      { tasks: [{ id, files: [string] }] }   (a flow card's owned files, from its per-card plan)
//   cardConflict(a, b)  -> null when the two may run together, else { with: b.id, why: <string> }. A flow card is
//                          passed with its plan as `a.plan` / `b.plan`.
//   pickCards({ ready, inFlight, slots, plans })  plans: { [cardId]: plan }; the plan of an in-flight flow card is
//                          looked up there too. -> { launch: [id], needsPlan: [id], held: [{ id, with, why }], alone: [id] }
//   classifyNotification(kind, { status, result })  result is JSON text or an already parsed object
//                          -> { action: "land"|"resume"|"ask", reason? }
//   landQueue(state)    state.cards[]: { id, state: "done"|"landing"|..., doneAt }
//                          -> { next: id|null, queue: [id] }  (done cards first-in first-out, one at a time)
//   capsReached(caps, used)  caps { usd, wallMin, contextPct }, used { usd, wallMin, contextPct }
//                          -> array of the cap names whose used value is at or over the cap (unset caps ignored)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WORKERS_MAX_DEFAULT,
  workersMax,
  goalPaths,
  cardConflict,
  queenKind,
  pickCards,
  classifyNotification,
  landQueue,
  capsReached,
  queenLabel,
  renameQueenMeta,
} from "../lib/coordinator.mjs";
import { STOP_REASONS } from "../lib/card-loop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib", "coordinator.mjs");

const hand = (id, goal, component = id + "-comp", extra = {}) => ({ id, goal, component, track: "hand", ...extra });
const flow = (id, component = id + "-comp", extra = {}) => ({ id, goal: "flow goal for " + id, component, track: "flow", ...extra });
const plan = (...tasks) => ({ tasks: tasks.map(([id, ...files]) => ({ id, files })) });
const withPlan = (card, p) => ({ ...card, plan: p });

describe("coordinator", () => {
  it("C01 workersMax: absent gives 3; 1, 2 and 16 are kept; 0, 17, 2.5, a string and null give 3 with a warning", () => {
    expect(WORKERS_MAX_DEFAULT).toBe(3);
    const w = [];
    const warn = (m) => w.push(m);
    expect(workersMax(undefined, warn)).toBe(3);
    expect(workersMax({}, warn)).toBe(3);
    expect(workersMax({ workers: {} }, warn)).toBe(3);
    expect(w).toEqual([]);
    for (const v of [1, 2, 16]) expect(workersMax({ workers: { max: v } }, warn)).toBe(v);
    expect(w).toEqual([]);
    for (const v of [0, 17, 2.5, "3", -1, null, NaN]) {
      const before = w.length;
      expect(workersMax({ workers: { max: v } }, warn), String(v)).toBe(3);
      expect(w.length, "warning for " + String(v)).toBe(before + 1);
      expect(w[w.length - 1]).toContain("workers.max");
    }
  });

  it("C01 workersMax needs no warn callback", () => {
    expect(workersMax({ workers: { max: 99 } })).toBe(3);
  });

  it("C02 goalPaths extracts file and directory paths and ignores prose", () => {
    const paths = goalPaths("Edit plugins/x/y.mjs, then docs/ and foo.ts (e.g. the thing, i.e. that one). Done.");
    expect(paths).toEqual(expect.arrayContaining(["plugins/x/y.mjs", "docs/", "foo.ts"]));
    expect(paths.some((p) => /^(e\.g\.|i\.e\.?)$/.test(p))).toBe(false);
    expect(paths.some((p) => /[,;:)(]$/.test(p))).toBe(false);
    expect(paths).toHaveLength(3);
    expect(goalPaths("")).toEqual([]);
    expect(goalPaths("no paths in this sentence at all.")).toEqual([]);
  });

  it("C03 hand with hand: the same path, a directory prefix and the same basename conflict", () => {
    const base = hand("a", "Change plugins/doug-flow/lib/board.mjs only.", "flow");
    const same = hand("b", "Also touches plugins/doug-flow/lib/board.mjs.", "gates");
    const dir = hand("c", "Rework everything under plugins/doug-flow/lib/.", "cli");
    const baseName = hand("d", "Edit packages/other/board.mjs.", "codex");
    const apart = hand("e", "Edit docs/guide.md.", "evals");
    for (const other of [same, dir, baseName]) {
      const c = cardConflict(base, other);
      expect(c, other.id).not.toBeNull();
      expect(c.with).toBe(other.id);
      expect(typeof c.why).toBe("string");
      expect(c.why.length).toBeGreaterThan(0);
      expect(cardConflict(other, base), other.id + " reversed").not.toBeNull();
    }
    expect(cardConflict(base, apart)).toBeNull();
    expect(cardConflict(apart, base)).toBeNull();
  });

  it("C04 hand with hand: the same component conflicts with disjoint paths; different components do not", () => {
    const a = hand("a", "Change lib/one.mjs.", "flow");
    const sameComp = hand("b", "Change scripts/two.mjs.", "flow");
    const otherComp = hand("c", "Change scripts/two.mjs.", "gates");
    const c = cardConflict(a, sameComp);
    expect(c).not.toBeNull();
    expect(c.why).toMatch(/component/i);
    expect(cardConflict(a, otherComp)).toBeNull();
  });

  it("C05 hand with hand: a goal naming package.json, a lockfile, CLAUDE.md or .doug/config.json conflicts with everything; board.json and live-runs.md are ignored", () => {
    const other = hand("z", "Change src/z.ts.", "cli");
    for (const f of ["package.json", "pnpm-lock.yaml", "CLAUDE.md", ".doug/config.json"]) {
      const solo = hand("s", `Bump a dependency in ${f} too.`, "gates");
      expect(cardConflict(solo, other), f).not.toBeNull();
      expect(cardConflict(other, solo), f + " reversed").not.toBeNull();
    }
    const quiet = hand("q", "Record the landing in .doug/board.json and docs/live-runs.md.", "evals");
    expect(cardConflict(quiet, other)).toBeNull();
    const quiet2 = hand("q2", "Also record in .doug/board.json and docs/live-runs.md.", "codex");
    expect(cardConflict(quiet, quiet2)).toBeNull();
  });

  it("C05 hand with hand: a card with no component conflicts with everything", () => {
    const none = { id: "n", goal: "Change a/one.mjs.", track: "hand" };
    const other = hand("o", "Change b/two.mjs.", "cli");
    expect(cardConflict(none, other)).not.toBeNull();
    expect(cardConflict(other, none)).not.toBeNull();
  });

  it("C13 flow with flow: overlapping owned entries (exact, directory, glob) conflict; disjoint plans do not", () => {
    const base = withPlan(flow("a"), plan(["a1", "plugins/doug-flow/lib/board.mjs", "docs/a.md"]));
    const exact = withPlan(flow("b"), plan(["b1", "plugins/doug-flow/lib/board.mjs"]));
    const inside = withPlan(flow("c"), plan(["c1", "plugins/doug-flow/lib/"]));
    const under = withPlan(flow("d"), plan(["d1", "plugins/doug-flow"]));
    const globber = withPlan(flow("e"), plan(["e1", "plugins/**/*.mjs"]));
    const apart = withPlan(flow("f"), plan(["f1", "packages/doug-cli/src/board.ts"]));
    for (const other of [exact, inside, under, globber]) {
      const c = cardConflict(base, other);
      expect(c, other.id).not.toBeNull();
      expect(c.with).toBe(other.id);
      expect(cardConflict(other, base), other.id + " reversed").not.toBeNull();
    }
    expect(cardConflict(base, apart)).toBeNull();
    expect(cardConflict(apart, base)).toBeNull();
  });

  it("C13 flow with flow: compares by ownsPath, not by basename, and the same component alone is no conflict", () => {
    const a = withPlan(flow("a", "flow"), plan(["a1", "README.md"]));
    const b = withPlan(flow("b", "flow"), plan(["b1", "docs/README.md"]));
    expect(cardConflict(a, b)).toBeNull();
    expect(cardConflict(b, a)).toBeNull();
    const c = withPlan(flow("c", "flow"), plan(["c1", "src/c.ts"]));
    const d = withPlan(flow("d", "flow"), plan(["d1", "src/d.ts"]));
    expect(cardConflict(c, d)).toBeNull();
  });

  it("C14 flow with flow: a shared task id conflicts although the files are disjoint", () => {
    const a = withPlan(flow("a"), plan(["t1", "src/a.ts"]));
    const b = withPlan(flow("b"), plan(["t1", "src/b.ts"]));
    const c = cardConflict(a, b);
    expect(c).not.toBeNull();
    expect(c.why).toContain("t1");
    expect(cardConflict(a, withPlan(flow("c"), plan(["t2", "src/c.ts"])))).toBeNull();
  });

  it("C15 flow with hand: an owned file the hand goal names conflicts, either way round", () => {
    const f = withPlan(flow("f", "flow"), plan(["f1", "plugins/doug-flow/lib/land.mjs"]));
    const h = hand("h", "Fix plugins/doug-flow/lib/land.mjs when main moves.", "gates");
    expect(cardConflict(f, h)).not.toBeNull();
    expect(cardConflict(h, f)).not.toBeNull();
    const underDir = hand("d", "Fix plugins/doug-flow/lib/land.mjs/inner.mjs.", "gates");
    expect(cardConflict(f, underDir)).not.toBeNull();
  });

  it("C15 flow with hand: the same component conflicts; disjoint paths with different components do not", () => {
    const f = withPlan(flow("f", "flow"), plan(["f1", "src/f.ts"]));
    const sameComp = hand("h", "Change docs/x.md.", "flow");
    const c = cardConflict(f, sameComp);
    expect(c).not.toBeNull();
    expect(c.why).toMatch(/component/i);
    expect(cardConflict(sameComp, f)).not.toBeNull();
    const other = hand("o", "Change docs/x.md.", "gates");
    expect(cardConflict(f, other)).toBeNull();
    expect(cardConflict(other, f)).toBeNull();
  });

  it("C16 pickCards: a flow card without a plan comes back as needsPlan, at most `slots`", () => {
    const ready = [flow("f1"), flow("f2"), flow("f3"), flow("f4")];
    const r = pickCards({ ready, inFlight: [], slots: 2, plans: {} });
    expect(r.needsPlan).toEqual(["f1", "f2"]);
    expect(r.launch).toEqual([]);
    expect(r.held).toEqual([]);
    expect(r.alone).toEqual([]);
    const none = pickCards({ ready, inFlight: [], slots: 0, plans: {} });
    expect(none.needsPlan).toEqual([]);
    expect(none.launch).toEqual([]);
  });

  it("C16 pickCards: a flow card with its plan is launched; a planned flow card does not take a needsPlan slot", () => {
    const ready = [flow("f1"), flow("f2")];
    const plans = { f1: plan(["f1a", "src/one.ts"]) };
    const r = pickCards({ ready, inFlight: [], slots: 2, plans });
    expect(r.launch).toEqual(["f1"]);
    expect(r.needsPlan).toEqual(["f2"]);
  });

  it("C17 pickCards: three cards where two conflict launch two in board order and hold the third with with and why", () => {
    const ready = [
      hand("a", "Change lib/a.mjs.", "flow"),
      hand("b", "Change lib/b.mjs.", "flow"),
      hand("c", "Change lib/c.mjs.", "gates"),
    ];
    const r = pickCards({ ready, inFlight: [], slots: 3, plans: {} });
    expect(r.launch).toEqual(["a", "c"]);
    expect(r.held).toHaveLength(1);
    expect(r.held[0].id).toBe("b");
    expect(r.held[0].with).toBe("a");
    expect(typeof r.held[0].why).toBe("string");
    expect(r.held[0].why.length).toBeGreaterThan(0);
    expect(r.needsPlan).toEqual([]);
    expect(r.alone).toEqual([]);
  });

  it("C17 pickCards: a card conflicting with one already in flight is held against it; slots caps the launch", () => {
    const inFlight = [hand("x", "Change lib/x.mjs.", "flow")];
    const ready = [
      hand("a", "Change lib/a.mjs.", "flow"),
      hand("b", "Change lib/b.mjs.", "gates"),
      hand("c", "Change lib/c.mjs.", "cli"),
      hand("d", "Change lib/d.mjs.", "codex"),
    ];
    const r = pickCards({ ready, inFlight, slots: 2, plans: {} });
    expect(r.held.map((h) => h.id)).toEqual(["a"]);
    expect(r.held[0].with).toBe("x");
    expect(r.launch).toEqual(["b", "c"]);
    expect(r.launch).not.toContain("d");
    expect(r.held.map((h) => h.id)).not.toContain("d");
  });

  it("C17 pickCards: a flow plan in flight conflicts with a ready hand card", () => {
    const inFlight = [flow("f", "flow")];
    const plans = { f: plan(["f1", "src/f.ts"]) };
    const r = pickCards({ ready: [hand("h", "Edit src/f.ts.", "gates")], inFlight, slots: 2, plans });
    expect(r.launch).toEqual([]);
    expect(r.held).toEqual([expect.objectContaining({ id: "h", with: "f" })]);
  });

  it("C17 pickCards: swarm and decision cards come back as alone, never launched", () => {
    const ready = [
      hand("a", "Change lib/a.mjs.", "flow"),
      hand("s", "Do it as a swarm.", "gates", { swarm: true }),
      hand("d", "Decide.", "cli", { class: "decision" }),
    ];
    const r = pickCards({ ready, inFlight: [], slots: 3, plans: {} });
    // an alone card runs after in-flight queens finish (design-r2:181): not while a card launches in this pick
    expect(r.launch).toEqual(["a"]);
    expect(r.alone).toEqual([]);
    expect(r.held).toEqual([]);
    const idle = pickCards({ ready: ready.slice(1), inFlight: [], slots: 3, plans: {} });
    expect(idle.launch).toEqual([]);
    expect(idle.alone).toEqual(["s", "d"]);
  });

  it("C17 pickCards: an alone card is not returned while an earlier flow card waits for its plan", () => {
    const f = { id: "f", goal: "Flow.", component: "x", track: "flow" };
    const s = hand("s", "Run it as a swarm.", "gates", { swarm: true });
    const r = pickCards({ ready: [f, s], inFlight: [], slots: 3, plans: {} });
    expect(r.needsPlan).toEqual(["f"]);
    expect(r.alone).toEqual([]);
  });

  it("B11 the held reason does not repeat a path both goals name", () => {
    const m = cardConflict(hand("a", "Change lib/a.mjs.", "x"), hand("b", "Also lib/a.mjs.", "y"));
    expect(m.why).toBe("both goals name lib/a.mjs");
  });

  it("C18 classifyNotification flow: ok means land, paused means ask, ok false means ask, a failed status means resume", () => {
    expect(classifyNotification("flow", { status: "completed", result: JSON.stringify({ ok: true, levels: [] }) }).action).toBe("land");
    expect(classifyNotification("flow", { status: "completed", result: { ok: true } }).action).toBe("land");
    const paused = classifyNotification("flow", {
      status: "completed",
      result: JSON.stringify({ ok: false, paused: { level: 0, gate: "human", next: ["t2"] } }),
    });
    expect(paused.action).toBe("ask");
    expect(paused.reason).toMatch(/pause|human|gate/i);
    expect(classifyNotification("flow", { status: "completed", result: JSON.stringify({ ok: false, stoppedAtLevel: 1 }) }).action).toBe("ask");
    expect(classifyNotification("flow", { status: "failed", result: "" }).action).toBe("resume");
    expect(classifyNotification("flow", { status: "failed", result: JSON.stringify({ ok: true }) }).action).toBe("resume");
    expect(classifyNotification("flow", { status: "completed", result: "{not json" }).action).toBe("resume");
    expect(classifyNotification("flow", { status: "completed", result: undefined }).action).toBe("resume");
  });

  it("C18 classifyNotification hand: done means land; agent-null resumes; every other stop reason asks with that reason", () => {
    expect(classifyNotification("hand", { status: "completed", result: JSON.stringify({ kind: "done", report: {} }) }).action).toBe("land");
    expect(classifyNotification("hand", { status: "completed", result: { kind: "done", report: {} } }).action).toBe("land");
    // the real queen result (card-queen.js returns { ...report, history }) carries outcome, not kind (live rehearsal, B14)
    expect(classifyNotification("hand", { status: "completed", result: JSON.stringify({ outcome: "done", reason: null, history: [] }) }).action).toBe("land");
    expect(classifyNotification("hand", { status: "completed", result: { outcome: "stopped", reason: "agent-null" } }).action).toBe("resume");
    expect(classifyNotification("hand", { status: "completed", result: { outcome: "stopped", reason: "gate-red-twice" } })).toEqual({ action: "ask", reason: "gate-red-twice" });
    for (const reason of STOP_REASONS) {
      const r = classifyNotification("hand", { status: "completed", result: JSON.stringify({ kind: "stopped", reason, report: {} }) });
      if (reason === "agent-null") {
        expect(r.action, reason).toBe("resume");
      } else {
        expect(r.action, reason).toBe("ask");
        expect(r.reason, reason).toBe(reason);
      }
    }
    expect(classifyNotification("hand", { status: "failed", result: JSON.stringify({ kind: "done", report: {} }) }).action).toBe("resume");
    expect(classifyNotification("hand", { status: "completed", result: "<<garbage" }).action).toBe("resume");
    expect(classifyNotification("hand", { status: "completed", result: JSON.stringify({ kind: "weird" }) }).action).not.toBe("land");
  });

  it("C19 queenKind: hand, flow, alone for swarm or decision, whatever the track", () => {
    expect(queenKind(hand("h", "g"))).toBe("hand");
    expect(queenKind(flow("f"))).toBe("flow");
    expect(queenKind(flow("f", "c", { swarm: true }))).toBe("alone");
    expect(queenKind(hand("h", "g", "c", { swarm: true }))).toBe("alone");
    expect(queenKind(hand("h", "g", "c", { class: "decision" }))).toBe("alone");
    expect(queenKind(flow("f", "c", { class: "decision" }))).toBe("alone");
    expect(queenKind(hand("h", "g", "c", { class: "code" }))).toBe("hand");
  });

  it("F1 goalPaths strips :line suffixes, a possessive and surrounding punctuation, and expands brace lists", () => {
    expect(goalPaths("See plugins/doug-flow/lib/land.mjs:231 for it.")).toEqual(["plugins/doug-flow/lib/land.mjs"]);
    expect(goalPaths("Per CLAUDE.md's rules.")).toEqual(["CLAUDE.md"]);
    expect(goalPaths("At package.json:15-28 only.")).toEqual(["package.json"]);
    expect(goalPaths("Set it (.doug/config.json:61) now.")).toEqual([".doug/config.json"]);
    expect(goalPaths("Edit lib/{a,b}.mjs and src/{x,y}/z.ts.")).toEqual(["lib/a.mjs", "lib/b.mjs", "src/x/z.ts", "src/y/z.ts"]);
    const solo = (g) => cardConflict(hand("s", g, "gates"), hand("o", "Change src/o.ts.", "cli"));
    expect(solo("Per CLAUDE.md's rules.")).not.toBeNull();
    expect(solo("Bump package.json:15-28.")).not.toBeNull();
    expect(solo("Edit (.doug/config.json:61).")).not.toBeNull();
  });

  it("F2 goalPaths drops prose: and/or, slash commands, @scopes, Date.now, claude.ai; bare board.json and live-runs.md are ignored", () => {
    expect(goalPaths("Use and/or run /doug-next and /core-next on @dougharness/flow with Date.now at claude.ai.")).toEqual([]);
    const a = hand("a", "Record in board.json and live-runs.md.", "evals");
    const b = hand("b", "Record in board.json and live-runs.md.", "codex");
    expect(cardConflict(a, b)).toBeNull();
  });

  it("F2 goalPaths roots: an extensionless a/b counts only under a listed root; without roots it is kept", () => {
    expect(goalPaths("Touch plugins/doug-flow and foo/bar here.")).toEqual(["plugins/doug-flow", "foo/bar"]);
    expect(goalPaths("Touch plugins/doug-flow and foo/bar here.", { roots: ["plugins"] })).toEqual(["plugins/doug-flow"]);
    const a = hand("a", "Rework plugins/doug-flow.", "x");
    const b = hand("b", "Rework plugins/doug-flow/lib.", "y");
    expect(cardConflict(a, b, { roots: ["plugins"] })).not.toBeNull();
    expect(cardConflict(a, hand("c", "Rework foo/bar.", "z"), { roots: ["plugins"] })).toBeNull();
    const r = pickCards({ ready: [a, b], inFlight: [], slots: 2, plans: {}, roots: ["plugins"] });
    expect(r.launch).toEqual(["a"]);
    const free = pickCards({ ready: [hand("a", "Rework foo/bar.", "x"), hand("b", "Rework foo/bar.", "y")], inFlight: [], slots: 2, plans: {}, roots: ["plugins"] });
    expect(free.launch).toEqual(["a", "b"]);
  });

  it("F3 nothing throws on null input; a null card side conflicts; an unclosed brace glob reads literal; plans use own keys only", () => {
    expect(cardConflict(null, hand("b", "x.ts"))).not.toBeNull();
    expect(cardConflict(hand("a", "x.ts"), undefined)).not.toBeNull();
    expect(queenKind(null)).toBe("alone");
    const r = pickCards({ ready: [null, hand("a", "Change lib/a.mjs.", "flow"), undefined], inFlight: [null], slots: 2, plans: {} });
    expect(r.launch).toEqual(["a"]);
    expect(() => pickCards({ ready: null, inFlight: null, slots: 1, plans: null })).not.toThrow();
    expect(() => classifyNotification("flow", null)).not.toThrow();
    expect(classifyNotification("hand", { status: "completed", result: null }).action).toBe("resume");
    expect(() => landQueue({ cards: [null, { id: "x", state: "done" }] })).not.toThrow();
    expect(landQueue({ cards: [null, { id: "x", state: "done" }] }).next).toBe("x");
    const g = withPlan(flow("g"), plan(["g1", "src/{a.ts"]));
    const h = withPlan(flow("h"), plan(["h1", "docs/h.md"]));
    expect(() => cardConflict(g, h)).not.toThrow();
    expect(cardConflict(g, h)).toBeNull();
    const own = pickCards({ ready: [flow("toString")], inFlight: [], slots: 1, plans: {} });
    expect(own.needsPlan).toEqual(["toString"]);
  });

  it("F4 flow with hand: a hand goal naming a solo file conflicts; a card with no component conflicts", () => {
    const f = withPlan(flow("f", "flow"), plan(["f1", "src/f.ts"]));
    const solo = hand("h", "Bump package.json.", "gates");
    const c = cardConflict(f, solo);
    expect(c).not.toBeNull();
    expect(c.why).toMatch(/alone/);
    expect(cardConflict(solo, f)).not.toBeNull();
    const noComp = { id: "n", goal: "Change docs/x.md.", track: "hand" };
    expect(cardConflict(f, noComp)).not.toBeNull();
    expect(cardConflict(noComp, f)).not.toBeNull();
    const noFlowComp = withPlan({ id: "g", goal: "g", track: "flow" }, plan(["g1", "src/g.ts"]));
    expect(cardConflict(noFlowComp, hand("o", "Change docs/x.md.", "gates"))).not.toBeNull();
  });

  it("C10 landQueue: done cards first-in first-out, one at a time", () => {
    const state = {
      cards: [
        { id: "late", state: "done", doneAt: "2026-10-12T10:05:00.000Z" },
        { id: "running", state: "running" },
        { id: "early", state: "done", doneAt: "2026-10-12T10:01:00.000Z" },
        { id: "mid", state: "done", doneAt: "2026-10-12T10:03:00.000Z" },
        { id: "gone", state: "landed", doneAt: "2026-10-12T09:00:00.000Z" },
      ],
    };
    const q = landQueue(state);
    expect(q.next).toBe("early");
    expect(q.queue).toEqual(["early", "mid", "late"]);
    expect(landQueue({ cards: [{ id: "x", state: "running" }] })).toEqual({ next: null, queue: [] });
    expect(landQueue({}).next).toBeNull();
  });

  it("C10 landQueue: while a card is landing nothing else is next", () => {
    const q = landQueue({
      cards: [
        { id: "busy", state: "landing", doneAt: "2026-10-12T10:00:00.000Z" },
        { id: "wait", state: "done", doneAt: "2026-10-12T10:01:00.000Z" },
      ],
    });
    expect(q.next).toBeNull();
    expect(q.queue).toEqual(["wait"]);
  });

  it("C11 capsReached names every cap at or over its limit and ignores unset caps", () => {
    const caps = { usd: 10, wallMin: 60, contextPct: 60 };
    expect(capsReached(caps, { usd: 3, wallMin: 20, contextPct: 10 })).toEqual([]);
    expect(capsReached(caps, { usd: 10, wallMin: 20, contextPct: 10 })).toEqual(["usd"]);
    expect(capsReached(caps, { usd: 11, wallMin: 61, contextPct: 59 }).sort()).toEqual(["usd", "wallMin"]);
    expect(capsReached(caps, { usd: 1, wallMin: 1, contextPct: 60 })).toEqual(["contextPct"]);
    expect(capsReached({ usd: 5 }, { usd: 1, wallMin: 9999, contextPct: 99 })).toEqual([]);
    expect(capsReached({}, { usd: 1 })).toEqual([]);
  });

  it("C12 the source imports nothing and uses no clock, random, process or globalThis", () => {
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
});

// Card parallel-card-queens, brief B11: follow-ups from B1's review.
describe("coordinator B11 follow-ups", () => {
  it("F5 goalPaths knows jsonl, py, db, html and css files", () => {
    const got = goalPaths("Edit data/rows.jsonl, tools/run.py, state/x.db, web/index.html and web/site.css.");
    expect(got).toEqual(["data/rows.jsonl", "tools/run.py", "state/x.db", "web/index.html", "web/site.css"]);
    expect(goalPaths("Fix run.py and notes.db.")).toEqual(["run.py", "notes.db"]);
    const a = hand("a", "Change web/site.css.", "x");
    const b = hand("b", "Change web/site.css again.", "y");
    expect(cardConflict(a, b)).not.toBeNull();
  });

  it("F5 a dot-directory such as .doug/.state is a directory path, not a file named .state", () => {
    expect(goalPaths("Clear .doug/.state now.")).toEqual([".doug/.state"]);
    const a = hand("a", "Clear a/.state now.", "x");
    const b = hand("b", "Clear b/.state now.", "y");
    expect(goalPaths(a.goal, { roots: ["a", "b"] })).toEqual(["a/.state"]);
    expect(cardConflict(a, b, { roots: ["a", "b"] })).toBeNull();
    const inside = hand("c", "Change .doug/.state/reports/x.json.", "z");
    expect(cardConflict(hand("d", "Clear .doug/.state now.", "w"), inside)).not.toBeNull();
  });

  it("F5 pickCards(null) and pickCards() do not throw and return the empty shape", () => {
    const empty = { launch: [], needsPlan: [], held: [], alone: [] };
    expect(() => pickCards(null)).not.toThrow();
    expect(pickCards(null)).toEqual(empty);
    expect(pickCards()).toEqual(empty);
  });

  it("F6 an alone card does not starve: first runnable with queens in flight, nothing new launches; with none in flight it is returned in alone", () => {
    const sw = hand("sw", "Swarm card.", "gates", { swarm: true });
    const h1 = hand("h1", "Change lib/a.mjs.", "evals");
    const h2 = hand("h2", "Change lib/b.mjs.", "codex");
    const busy = pickCards({ ready: [sw, h1, h2], inFlight: [hand("h0", "Change lib/z.mjs.", "cli")], slots: 3, plans: {} });
    expect(busy.launch).toEqual([]);
    expect(busy.needsPlan).toEqual([]);
    expect(busy.alone).toEqual([]);
    const idle = pickCards({ ready: [sw, h1, h2], inFlight: [], slots: 3, plans: {} });
    expect(idle.alone).toEqual(["sw"]);
    expect(idle.launch).toEqual([]);
    // an earlier runnable card still launches before the alone card; the alone card waits behind it
    const before = pickCards({ ready: [h1, sw, h2], inFlight: [hand("h0", "Change lib/z.mjs.", "cli")], slots: 3, plans: {} });
    expect(before.launch).toEqual(["h1"]);
    expect(before.alone).toEqual([]);
  });

  it("F6 a decision card is alone too and does not starve", () => {
    const d = hand("d", "Decide something.", "gates", { class: "decision" });
    const h1 = hand("h1", "Change lib/a.mjs.", "evals");
    const busy = pickCards({ ready: [d, h1], inFlight: [hand("h0", "Change lib/z.mjs.", "cli")], slots: 3, plans: {} });
    expect(busy.launch).toEqual([]);
  });
});

// Card queen-run-name: the per-card queen run name (shortened id, collision fallback, meta rewrite).
describe("coordinator queen run name", () => {
  const SRC = [
    "export const meta = {",
    "  name: 'card-queen',",
    "  description: 'The queen of one hand-track card: runs the loop.',",
    "  phases: [{ title: 'Setup' }],",
    "}",
    "const other = { name: 'card-queen' }",
    "log('description: x')",
    "",
  ].join("\n");
  const bodyOf = (s) => s.slice(s.indexOf("}\n", s.indexOf("phases")) + 2);

  it("Q01 queenLabel shortens to the first two hyphen segments; fewer segments stay as is", () => {
    expect(queenLabel("research-cap-loopback-post", [])).toBe("research-cap");
    expect(queenLabel("queen-run-name", [])).toBe("queen-run");
    expect(queenLabel("two-parts", [])).toBe("two-parts");
    expect(queenLabel("statusline", [])).toBe("statusline");
    expect(queenLabel("onboarding", ["autopilot"])).toBe("onboarding");
  });

  it("Q02 queenLabel uses the full id when another id shares the short form", () => {
    expect(queenLabel("research-cap-loopback-post", ["research-cap-other"])).toBe("research-cap-loopback-post");
    expect(queenLabel("research-cap-other", ["research-cap-loopback-post"])).toBe("research-cap-other");
    expect(queenLabel("stop-gate-a", ["x-y", "stop-gate-b", "z"])).toBe("stop-gate-a");
    expect(queenLabel("research-cap-loopback-post", ["research-other", "stop-gate-x"])).toBe("research-cap");
  });

  it("Q03 queenLabel does not count the card's own id as a collision", () => {
    expect(queenLabel("research-cap-loopback-post", ["research-cap-loopback-post"])).toBe("research-cap");
    expect(queenLabel("research-cap-loopback-post", ["research-cap-loopback-post", "stop-gate-x"])).toBe("research-cap");
    expect(queenLabel("statusline", ["statusline"])).toBe("statusline");
  });

  it("Q04 renameQueenMeta names a hand queen '<label> card-queen' and a flow queen '<label> flow-queen'", () => {
    const hand = renameQueenMeta(SRC, { kind: "hand", label: "research-cap" });
    expect(hand).toContain("name: 'research-cap card-queen',");
    const flowSrc = SRC.replace("'card-queen',\n  desc", "'doug-implement',\n  desc");
    const f = renameQueenMeta(flowSrc, { kind: "flow", label: "research-cap" });
    expect(f).toContain("name: 'research-cap flow-queen',");
    expect(f).not.toContain("name: 'doug-implement'");
  });

  it("Q05 renameQueenMeta prefixes the description with '<label>: ' and keeps the rest of it", () => {
    const out = renameQueenMeta(SRC, { kind: "hand", label: "research-cap" });
    expect(out).toContain("description: 'research-cap: The queen of one hand-track card: runs the loop.',");
  });

  it("Q06 renameQueenMeta changes only the meta literal: everything after it is byte-identical", () => {
    const out = renameQueenMeta(SRC, { kind: "hand", label: "x-y" });
    expect(bodyOf(out)).toBe(bodyOf(SRC));
    expect(out).toContain("const other = { name: 'card-queen' }");
    expect(out).toContain("log('description: x')");
    expect(out).toContain("phases: [{ title: 'Setup' }],");
  });

  it("Q07 renameQueenMeta throws when the meta name or description is missing", () => {
    expect(() => renameQueenMeta(SRC, { kind: "hand", label: "a-b" })).not.toThrow();
    expect(() => renameQueenMeta("const a = 1\n", { kind: "hand", label: "a-b" })).toThrow();
    expect(() => renameQueenMeta("export const meta = {\n  description: 'd',\n}\n", { kind: "hand", label: "a-b" })).toThrow();
    expect(() => renameQueenMeta("export const meta = {\n  name: 'n',\n}\n", { kind: "hand", label: "a-b" })).toThrow();
  });

  it("Q08 renameQueenMeta works on both shipped sources and leaves everything after the meta block untouched", () => {
    const wf = join(HERE, "..", "workflows");
    for (const [file, kind, suffix] of [["card-queen.js", "hand", "card-queen"], ["doug-implement.js", "flow", "flow-queen"]]) {
      const src = readFileSync(join(wf, file), "utf8");
      const out = renameQueenMeta(src, { kind, label: "research-cap" });
      expect(out).toContain(`name: 'research-cap ${suffix}',`);
      expect(out).toMatch(/description: 'research-cap: /);
      const cut = (t) => t.slice(t.indexOf("phases:"));
      expect(cut(out)).toBe(cut(src));
    }
  });
});
