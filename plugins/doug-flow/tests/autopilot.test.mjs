import { describe, it, expect, vi, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, lstatSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAutopilot, autopilotView, autopilotLines, parseAutopilot } from "../lib/autopilot-view.mjs";
import * as core from "../lib/autopilot-core.mjs";
import { initialState, currentAction } from "../lib/card-loop.mjs";

// Card autopilot-live-queue: the lead's autopilot state file (.doug/.state/autopilot.json), its writer script, and
// the shared pure view the pane and the board page both render. Test names carry the contract's mutation ids.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "autopilot.mjs");

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "doug-autopilot-")));
const BOARD = {
  version: 1,
  columns: [{ id: "ready", title: "Ready" }],
  cards: [
    { id: "alpha", column: "ready", title: "Alpha title", size: "M", class: "code", goal: "g" },
    { id: "beta", column: "ready", title: "Beta title", size: "S", class: "prose", goal: "g" },
    { id: "bare", column: "ready", goal: "g" },
  ],
};

function project({ config } = {}) {
  const dir = tmp();
  mkdirSync(join(dir, ".doug/.state"), { recursive: true });
  writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(BOARD));
  if (config) writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(config));
  return dir;
}
const statePath = (dir) => join(dir, ".doug/.state/autopilot.json");
const state = (dir) => JSON.parse(readFileSync(statePath(dir), "utf8"));
// plan.mjs:298 resolves CLAUDE_PROJECT_DIR before --dir/cwd, so pin it to the fixture: a parent session's value must never aim a run at another repo.
const ap = (dir, ...args) => spawnSync(process.execPath, [script, ...args, "--dir", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const started = (dir) => ap(dir, "start", "--cards", "alpha,beta", "--usd-cap", "96.78", "--wall-cap", "1054");

describe("autopilot writer", () => {
  it("start writes the documented shape, with titles/size/class read from the board (A1)", () => {
    const dir = project();
    const r = started(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^autopilot: .+/);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const s = state(dir);
    expect(s.version).toBe(1);
    expect(s.status).toBe("running");
    expect(s.endedAt ?? null).toBeNull();
    expect(Number.isNaN(Date.parse(s.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(s.updatedAt))).toBe(false);
    expect(s.caps).toEqual({ usd: 96.78, wallMin: 1054, contextPct: 60 });
    expect(s.cards).toEqual([
      { id: "alpha", title: "Alpha title", size: "M", class: "code", state: "queued" },
      { id: "beta", title: "Beta title", size: "S", class: "prose", state: "queued" },
    ]);
    expect(s.filed ?? []).toEqual([]);
  });

  it("start leaves out board fields a card lacks, and takes the context threshold from config or the flag", () => {
    const dir = project({ config: { autopilot: { contextThreshold: 45 } } });
    expect(ap(dir, "start", "--cards", "bare", "--usd-cap", "1", "--wall-cap", "2").status).toBe(0);
    expect(state(dir).cards).toEqual([{ id: "bare", state: "queued" }]);
    expect(state(dir).caps.contextPct).toBe(45);
    expect(ap(dir, "start", "--cards", "bare", "--usd-cap", "1", "--wall-cap", "2", "--context-threshold", "70").status).toBe(0);
    expect(state(dir).caps.contextPct).toBe(70);
  });

  it("start replaces a previous run", () => {
    const dir = project();
    started(dir);
    ap(dir, "card", "alpha");
    ap(dir, "start", "--cards", "beta", "--usd-cap", "5", "--wall-cap", "6");
    expect(state(dir).cards.map((c) => [c.id, c.state])).toEqual([["beta", "queued"]]);
  });

  it("start without its required flags is bad usage, exit 2", () => {
    const dir = project();
    expect(ap(dir, "start", "--cards", "alpha").status).toBe(2);
    expect(ap(dir, "nonsense").status).toBe(2);
  });

  it("add appends a queued card and replaces caps only when given", () => {
    const dir = project();
    started(dir);
    expect(ap(dir, "add", "bare").status).toBe(0);
    expect(state(dir).cards.map((c) => c.id)).toEqual(["alpha", "beta", "bare"]);
    expect(state(dir).cards[2].state).toBe("queued");
    expect(state(dir).caps.usd).toBe(96.78);
    expect(ap(dir, "add", "alpha", "--usd-cap", "120.5", "--wall-cap", "1200").status).toBe(0);
    expect(state(dir).caps).toMatchObject({ usd: 120.5, wallMin: 1200 });
  });

  it("add for an id already in the run appends no duplicate: exit 0, 'already queued' (F4)", () => {
    const dir = project();
    started(dir);
    const r = ap(dir, "add", "alpha");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("autopilot: alpha already queued");
    expect(state(dir).cards.map((c) => c.id)).toEqual(["alpha", "beta"]);
    ap(dir, "add", "bare");
    const again = ap(dir, "add", "bare");
    expect(again.stdout).toContain("already queued");
    expect(state(dir).cards.filter((c) => c.id === "bare")).toHaveLength(1);
  });

  it("add with a cap flag on a file without a caps object creates caps, never a stack trace (F5)", () => {
    const dir = project();
    started(dir);
    const s = state(dir);
    delete s.caps;
    write(dir, s);
    const r = ap(dir, "add", "bare", "--usd-cap", "5", "--wall-cap", "7");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/\bat .*\.mjs:\d+|TypeError/);
    expect(state(dir).caps).toMatchObject({ usd: 5, wallMin: 7 });
    expect(state(dir).cards.map((c) => c.id)).toContain("bare");
    delete s.caps;
    write(dir, s);
    expect(ap(dir, "add", "bare", "--usd-cap", "9").status).toBe(0);
    expect(state(dir).caps.usd).toBe(9);
  });

  it("card marks the card running, step sets step and stepStartedAt", () => {
    const dir = project();
    started(dir);
    const before = Date.now();
    expect(ap(dir, "card", "alpha").status).toBe(0);
    expect(state(dir).cards[0].state).toBe("running");
    expect(state(dir).cards[0].step).toBeUndefined();
    for (const step of ["research", "tester", "coder", "reviewer", "gate", "commit", "record"]) {
      expect(ap(dir, "step", "alpha", step).status).toBe(0);
      const c = state(dir).cards[0];
      expect(c.step).toBe(step);
      expect(Date.parse(c.stepStartedAt)).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it("step rejects a step name outside the seven, exit 2, leaving the file unchanged (A2)", () => {
    const dir = project();
    started(dir);
    ap(dir, "card", "alpha");
    ap(dir, "step", "alpha", "coder");
    const r = ap(dir, "step", "alpha", "daydream");
    expect(r.status).toBe(2);
    expect(state(dir).cards[0].step).toBe("coder");
  });

  it("land sets landed and the commit and clears the step (A3)", () => {
    const dir = project();
    started(dir);
    ap(dir, "card", "alpha");
    ap(dir, "step", "alpha", "record");
    expect(ap(dir, "land", "alpha", "--commit", "abc1234").status).toBe(0);
    const c = state(dir).cards[0];
    expect(c.state).toBe("landed");
    expect(c.commit).toBe("abc1234");
    expect(c.step).toBeUndefined();
  });

  it("stop sets stopped with the reason", () => {
    const dir = project();
    started(dir);
    ap(dir, "card", "alpha");
    expect(ap(dir, "stop", "alpha", "--reason", "gate red twice").status).toBe(0);
    expect(state(dir).cards[0]).toMatchObject({ state: "stopped", reason: "gate red twice" });
  });

  it("card, step, land, and stop on an unknown id exit 1 naming it", () => {
    const dir = project();
    started(dir);
    for (const args of [["card", "ghost"], ["step", "ghost", "coder"], ["land", "ghost", "--commit", "abc"], ["stop", "ghost", "--reason", "x"]]) {
      const r = ap(dir, ...args);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toContain("ghost");
    }
  });

  it("filed records a follow-up or user card with its position; a bad kind is exit 2", () => {
    const dir = project();
    started(dir);
    expect(ap(dir, "filed", "newcard", "--kind", "follow-up", "--from", "alpha", "--position", "backlog bottom").status).toBe(0);
    expect(ap(dir, "filed", "usercard", "--kind", "user", "--position", "backlog bottom").status).toBe(0);
    expect(state(dir).filed).toEqual([
      { id: "newcard", kind: "follow-up", from: "alpha", position: "backlog bottom" },
      { id: "usercard", kind: "user", position: "backlog bottom" },
    ]);
    expect(ap(dir, "filed", "z", "--kind", "bogus", "--position", "p").status).toBe(2);
  });

  it("caps records used and checkedAt; end sets ended and endedAt", () => {
    const dir = project();
    started(dir);
    expect(ap(dir, "caps", "--usd", "12.5", "--wall", "80", "--context", "21").status).toBe(0);
    expect(state(dir).used).toMatchObject({ usd: 12.5, wallMin: 80, contextPct: 21 });
    expect(Number.isNaN(Date.parse(state(dir).used.checkedAt))).toBe(false);
    expect(ap(dir, "end").status).toBe(0);
    expect(state(dir).status).toBe("ended");
    expect(Number.isNaN(Date.parse(state(dir).endedAt))).toBe(false);
  });

  it("every write moves updatedAt forward", async () => {
    const dir = project();
    started(dir);
    const first = state(dir).updatedAt;
    await new Promise((r) => setTimeout(r, 15));
    ap(dir, "card", "alpha");
    expect(Date.parse(state(dir).updatedAt)).toBeGreaterThan(Date.parse(first));
  });

  it("a write leaves no tmp file behind (A4)", () => {
    const dir = project();
    started(dir);
    ap(dir, "card", "alpha");
    ap(dir, "step", "alpha", "tester");
    ap(dir, "caps", "--usd", "1", "--wall", "2", "--context", "3");
    ap(dir, "end");
    expect(readdirSync(join(dir, ".doug/.state"))).toEqual(["autopilot.json"]);
  });

  it("any subcommand but start on a missing or unparseable file exits 1 with the start hint, no stack", () => {
    const dir = project();
    const calls = [["card", "alpha"], ["step", "alpha", "coder"], ["land", "alpha", "--commit", "a"], ["stop", "alpha", "--reason", "r"], ["add", "alpha"], ["end"], ["caps", "--usd", "1", "--wall", "1", "--context", "1"], ["filed", "n", "--kind", "user", "--position", "p"]];
    for (const garbage of [null, "{ not json"]) {
      if (garbage !== null) writeFileSync(statePath(dir), garbage);
      for (const args of calls) {
        const r = ap(dir, ...args);
        expect(r.status).toBe(1);
        expect(r.stdout + r.stderr).toContain("no autopilot run; run autopilot.mjs start first");
        expect(r.stderr).not.toMatch(/\bat .*\.mjs:\d+/);
      }
    }
  });

  it("dir defaults to the working directory", () => {
    const dir = project();
    const r = spawnSync(process.execPath, [script, "start", "--cards", "alpha", "--usd-cap", "1", "--wall-cap", "2"], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    expect(r.status).toBe(0);
    expect(existsSync(statePath(dir))).toBe(true);
  });
});

const NOW = new Date("2026-10-11T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function runState(over = {}) {
  return {
    version: 1,
    status: "running",
    startedAt: iso(-90 * MIN),
    updatedAt: iso(-1 * MIN),
    endedAt: null,
    caps: { usd: 96.78, wallMin: 1054, contextPct: 60 },
    used: { usd: 12.5, wallMin: 80, contextPct: 21, checkedAt: iso(-5 * MIN) },
    cards: [
      { id: "done1", title: "Done one", size: "S", class: "docs", state: "landed", commit: "abc1234" },
      { id: "cur", title: "Current", size: "M", class: "code", state: "running", step: "coder", stepStartedAt: iso(-10 * MIN) },
      { id: "bad", title: "Bad", size: "L", class: "code", state: "stopped", reason: "gate red twice" },
      { id: "next", title: "Next", size: "S", class: "prose", state: "queued" },
    ],
    filed: [{ id: "fu1", kind: "follow-up", from: "cur", position: "backlog bottom" }],
    ...over,
  };
}
const write = (dir, content) => writeFileSync(statePath(dir), typeof content === "string" ? content : JSON.stringify(content));

describe("readAutopilot", () => {
  it("returns the parsed state for a valid file", () => {
    const dir = project();
    write(dir, runState());
    expect(readAutopilot(dir)).toEqual(runState());
  });

  it("returns null, never throws, for a missing file, garbage, a wrong version, or a non-object (A5)", () => {
    const dir = project();
    expect(readAutopilot(dir)).toBeNull();
    for (const bad of ["{ not json", "", "null", "[1,2]", '"str"', "42", JSON.stringify(runState({ version: 2 })), JSON.stringify({ status: "running" })]) {
      write(dir, bad);
      expect(readAutopilot(dir)).toBeNull();
    }
    expect(readAutopilot(join(dir, "does", "not", "exist"))).toBeNull();
  });
});

describe("autopilotView", () => {
  it("is null for null state", () => {
    expect(autopilotView(null, NOW)).toBeNull();
  });

  it("running: cards with detail per state, the current step, and caps strings (A8)", () => {
    const v = autopilotView(runState(), NOW);
    expect(v.mode).toBe("running");
    expect(typeof v.header).toBe("string");
    expect(v.cards.map((c) => [c.id, c.state])).toEqual([["done1", "landed"], ["cur", "running"], ["bad", "stopped"], ["next", "queued"]]);
    expect(v.cards[0]).toMatchObject({ title: "Done one", size: "S", class: "docs" });
    expect(v.cards[0].detail).toContain("abc1234");
    expect(v.cards[1].detail).toMatch(/^coder since \d\d:\d\d$/);
    expect(v.cards[2].detail).toContain("gate red twice");
    expect(v.current).toMatchObject({ id: "cur", step: "coder" });
    expect(v.current.since).toBeTruthy();
    expect(v.caps).toEqual({ usd: "$12.50 / $96.78", wall: "80 / 1054 min", context: "21% / 60%" });
    expect(v.filed).toHaveLength(1);
    expect(JSON.stringify(v.filed)).toContain("fu1");
    expect(JSON.stringify(v.filed)).toContain("backlog bottom");
  });

  it("caps strings keep every cap even before any check (A8)", () => {
    const v = autopilotView(runState({ used: undefined }), NOW);
    expect(v.caps.usd).toContain("$96.78");
    expect(v.caps.wall).toContain("1054");
    expect(v.caps.context).toContain("60%");
  });

  it("ended: the last run's summary, header counts landed and stopped, no card shown running (A7)", () => {
    const s = runState({ status: "ended", endedAt: iso(-3 * MIN) });
    const v = autopilotView(s, NOW);
    expect(v.mode).toBe("ended");
    expect(v.header).toMatch(/1 landed/);
    expect(v.header).toMatch(/1 stopped/);
    expect(v.cards.some((c) => c.state === "running")).toBe(false);
    expect(v.current).toBeNull();
  });

  it("ended is ended however old the file is", () => {
    const v = autopilotView(runState({ status: "ended", endedAt: iso(-40 * HOUR), updatedAt: iso(-40 * HOUR) }), NOW);
    expect(v.mode).toBe("ended");
  });

  it("a running file not updated for 2 h + 1 min is inactive: header says since, no card running (A6)", () => {
    const updatedAt = iso(-(2 * HOUR + MIN));
    const v = autopilotView(runState({ updatedAt }), NOW);
    expect(v.mode).toBe("inactive");
    expect(v.header).toMatch(/^Autopilot inactive since \d\d:\d\d$/);
    expect(v.current).toBeNull();
    expect(v.cards.some((c) => c.state === "running")).toBe(false);
    expect(JSON.stringify(v.cards.find((c) => c.id === "cur"))).toContain("interrupted");
  });

  it("a running file updated 2 h - 1 min ago is still running (A6)", () => {
    const v = autopilotView(runState({ updatedAt: iso(-(2 * HOUR - MIN)) }), NOW);
    expect(v.mode).toBe("running");
    expect(v.current).toMatchObject({ id: "cur" });
  });
});

describe("parseAutopilot (F3)", () => {
  it("returns null, never throws, for garbage called directly (F3)", () => {
    const bad = ["{ not json", "", null, undefined, 42, true, [1, 2], ["x"], { version: 1 }, { version: 2 }, '{"version":1,"cards":5}', '{"version":1,"cards":"x"}', '{"version":1,"cards":{}}', '{"version":2}', "[]", "null"];
    for (const input of bad) {
      let out;
      expect(() => (out = parseAutopilot(input))).not.toThrow();
      if (typeof input === "object" && input !== null && !Array.isArray(input) && input.version === 1) continue;
      expect(out).toBeNull();
    }
  });

  it("returns the state for valid text", () => {
    expect(parseAutopilot(JSON.stringify(runState()))).toEqual(runState());
  });
});

describe("autopilotLines short lines (F1)", () => {
  it("a card line is mark, id and status only: no title, no size/class (M7)", () => {
    const s = runState({
      cards: [
        { id: "titled", title: "A real title", size: "M", class: "code", state: "queued" },
        { id: "shipped", title: "Shipped title", size: "M", class: "code", state: "landed", commit: "0123456789abcdef" },
        { id: "bare", state: "queued" },
      ],
    });
    const lines = autopilotLines(autopilotView(s, NOW));
    expect(lines).toContain("  · titled");
    expect(lines).toContain("  · bare");
    expect(lines).toContain("  ✓ shipped 0123456");
    const text = lines.join("\n");
    expect(text).not.toMatch(/A real title|Shipped title|\(M\/code\)|undefined|null/);
  });
});

describe("autopilot header times (F7)", () => {
  it("ended header shows local HH:MM, no ISO date or Z (F7)", () => {
    const v = autopilotView(runState({ status: "ended", endedAt: iso(-3 * MIN) }), NOW);
    expect(v.header).toMatch(/^Autopilot ended \d\d:\d\d: 1 landed, 1 stopped$/);
    expect(v.header).not.toMatch(/\d{4}-\d\d-\d\d|\dT\d|Z/);
  });

  it("ended header with no endedAt still has no ISO text (F7)", () => {
    const v = autopilotView(runState({ status: "ended", endedAt: null }), NOW);
    expect(v.header).not.toMatch(/\d{4}-\d\d-\d\d|\dT\d|Z/);
  });

  it("inactive header shows local HH:MM, no ISO date or Z (F7)", () => {
    const v = autopilotView(runState({ updatedAt: iso(-3 * HOUR) }), NOW);
    expect(v.header).toMatch(/^Autopilot inactive since \d\d:\d\d$/);
    expect(v.header).not.toMatch(/\d{4}-\d\d-\d\d|\dT\d|Z/);
  });
});

describe("autopilotLines", () => {
  it("running: header, then Running/Queued/Landed/Stopped blocks, the spend line, then filed lines (M5, M7, M15)", () => {
    const st = runState({
      cards: [
        { id: "done1", title: "Done one", size: "S", class: "docs", state: "landed", commit: "abc1234def" },
        { id: "next", title: "Next", size: "S", class: "prose", state: "queued" },
        { id: "cur", title: "Current", size: "M", class: "code", state: "running", step: "coder", stepStartedAt: iso(-10 * MIN),
          seats: [{ step: "research", startedAt: iso(-30 * MIN) }, { step: "tester", startedAt: iso(-20 * MIN) }, { step: "coder", startedAt: iso(-10 * MIN) }] },
        { id: "bad", title: "Bad", size: "L", class: "code", state: "stopped", reason: "gate red twice, then a long reason that must stay whole" },
        { id: "next2", state: "queued" },
      ],
    });
    const lines = autopilotLines(autopilotView(st, NOW));
    expect(lines[0]).toMatch(/^Autopilot running since \d\d:\d\d$/);
    expect(lines.slice(1)).toEqual([
      "Running",
      "  ▶ cur research ✓ tester ✓ coder ▶ 10m",
      "Queued",
      "  · next",
      "  · next2",
      "Landed",
      "  ✓ done1 abc1234",
      "Stopped",
      "  ✗ bad gate red twice, then a long reason that must stay whole",
      "$12.50 / $96.78, 80 / 1054 min, ctx 21%",
      "+ fu1 (follow-up from cur) backlog bottom",
    ]);
    expect(lines.join("\n")).not.toMatch(/caps:/);
  });

  it("an empty section is omitted (M5)", () => {
    const st = runState({ cards: [{ id: "a", state: "queued" }, { id: "b", state: "landed", commit: "1234567" }], filed: [] });
    const lines = autopilotLines(autopilotView(st, NOW));
    expect(lines).toContain("Queued");
    expect(lines).toContain("Landed");
    expect(lines).not.toContain("Running");
    expect(lines).not.toContain("Stopped");
    expect(lines.indexOf("Queued")).toBeLessThan(lines.indexOf("Landed"));
  });

  it("in an inactive run the formerly running card is listed under Stopped as interrupted (M6)", () => {
    const st = runState({ updatedAt: iso(-3 * HOUR) });
    const lines = autopilotLines(autopilotView(st, NOW));
    expect(lines).not.toContain("Running");
    const stopped = lines.indexOf("Stopped");
    expect(stopped).toBeGreaterThan(-1);
    const idx = lines.findIndex((l) => /^ {2}\S cur interrupted$/.test(l));
    expect(idx).toBeGreaterThan(stopped);
  });

  it("an ended run lists a still-running card under Stopped as interrupted (M6)", () => {
    const lines = autopilotLines(autopilotView(runState({ status: "ended", endedAt: iso(-MIN) }), NOW));
    expect(lines).not.toContain("Running");
    expect(lines.findIndex((l) => /^ {2}\S cur interrupted$/.test(l))).toBeGreaterThan(lines.indexOf("Stopped"));
  });

  it("view exposes the same groups and the spend line for the board (M15, M17)", () => {
    const v = autopilotView(runState(), NOW);
    expect(v.spend).toBe("$12.50 / $96.78, 80 / 1054 min, ctx 21%");
    expect(v.groups.map((g) => g.title)).toEqual(["Running", "Queued", "Landed", "Stopped"]);
    const cur = v.groups[0].cards[0];
    expect(cur).toMatchObject({ id: "cur", state: "running" });
    expect(typeof cur.status).toBe("string");
    expect(typeof cur.mark).toBe("string");
    expect(v.groups[2].cards[0]).toMatchObject({ id: "done1", status: "abc1234" });
    expect(v.groups[3].cards[0]).toMatchObject({ id: "bad", status: "gate red twice" });
  });

  it("spend line: exactly '$12.40 / $35.66, 94 / 564 min, ctx 31%' for those values (M15)", () => {
    const st = runState({ caps: { usd: 35.66, wallMin: 564, contextPct: 60 }, used: { usd: 12.4, wallMin: 94, contextPct: 31 } });
    expect(autopilotLines(autopilotView(st, NOW))).toContain("$12.40 / $35.66, 94 / 564 min, ctx 31%");
  });

  it("spend line rounds wall minutes to whole minutes (M15)", () => {
    const st = runState({ caps: { usd: 35.66, wallMin: 564, contextPct: 60 }, used: { usd: 1, wallMin: 93.6, contextPct: 31 } });
    expect(autopilotView(st, NOW).spend).toBe("$1.00 / $35.66, 94 / 564 min, ctx 31%");
  });

  it("spend line before any cap check shows dashes, never undefined (M16)", () => {
    const st = runState({ caps: { usd: 35.66, wallMin: 564, contextPct: 60 }, used: undefined });
    const lines = autopilotLines(autopilotView(st, NOW));
    expect(lines).toContain("- / $35.66, - / 564 min, ctx -");
    expect(lines.join("\n")).not.toMatch(/undefined|NaN/);
  });

  it("renders each filed card (A9)", () => {
    const s = runState({
      filed: [
        { id: "fu1", kind: "follow-up", from: "cur", position: "backlog bottom" },
        { id: "usr1", kind: "user", position: "backlog bottom" },
      ],
    });
    const lines = autopilotLines(autopilotView(s, NOW));
    const fu = lines.find((l) => l.includes("fu1"));
    const usr = lines.find((l) => l.includes("usr1"));
    expect(fu).toBeTruthy();
    expect(usr).toBeTruthy();
    expect(fu).toContain("follow-up");
    expect(fu).toContain("backlog bottom");
    expect(usr).toContain("user");
  });

  it("ended: header and cards, nothing running", () => {
    const lines = autopilotLines(autopilotView(runState({ status: "ended", endedAt: iso(-MIN) }), NOW));
    expect(lines[0]).toMatch(/1 landed/);
    expect(lines.join("\n")).not.toMatch(/coder since/);
  });

  it("inactive: header says inactive since, nothing running", () => {
    const updatedAt = iso(-3 * HOUR);
    const lines = autopilotLines(autopilotView(runState({ updatedAt }), NOW));
    expect(lines[0]).toMatch(/^Autopilot inactive since \d\d:\d\d$/);
    expect(lines.join("\n")).not.toMatch(/coder since/);
  });
});

describe("card autopilot-pane-auto-open", () => {
  const NOW = new Date("2026-10-11T12:00:00.000Z");
  const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
  const RUN = "2026-10-11T10:00:00.000Z";
  const running = (over = {}) => ({ version: 1, status: "running", startedAt: RUN, updatedAt: ago(60 * 1000), cards: [], ...over });
  const open = (...args) => core.shouldOpenPane(...args);

  it("a new run (nothing opened yet) opens the pane (a)", () => {
    expect(open(running(), null, true, NOW)).toBe(true);
  });

  it("a later run (startedAt differs from the last opened) opens the pane again (b)", () => {
    expect(open(running(), "2026-10-11T08:00:00.000Z", true, NOW)).toBe(true);
  });

  it("the same run (startedAt equals the last opened) does not reopen a closed pane (c)", () => {
    expect(open(running(), RUN, true, NOW)).toBe(false);
  });

  it("an ended run does not open (d)", () => {
    expect(open(running({ status: "ended", endedAt: ago(1000) }), null, true, NOW)).toBe(false);
  });

  it("an inactive run (running, last write older than INACTIVE_MS) does not open (e)", () => {
    expect(open(running({ updatedAt: ago(core.INACTIVE_MS + 1000) }), null, true, NOW)).toBe(false);
    expect(open(running({ updatedAt: ago(core.INACTIVE_MS - 1000) }), null, true, NOW)).toBe(true);
  });

  it("no file (null state) does not open and does not throw (f)", () => {
    expect(open(null, null, true, NOW)).toBe(false);
    expect(open(parseAutopilot("not json"), null, true, NOW)).toBe(false);
  });

  it("the flag off never opens, even for a new run (g); the flag defaults to on", () => {
    expect(open(running(), null, false, NOW)).toBe(false);
    expect(open(running(), null, undefined, NOW)).toBe(true);
  });

  it("a running state with no startedAt does not open (h)", () => {
    const noStart = running();
    delete noStart.startedAt;
    expect(open(noStart, null, true, NOW)).toBe(false);
    expect(open(running({ startedAt: "" }), null, true, NOW)).toBe(false);
  });

  it("a fresh state with a non-running status (paused) does not open (i)", () => {
    expect(open(running({ status: "paused" }), null, true, NOW)).toBe(false);
  });
});

// Card parallel-card-queens, brief B11: the queen subcommands (pick, launched, report, resumed, lock-wait) and the
// view's running list. Test names carry the design's ids (A01-A09).
describe("card parallel-card-queens autopilot subcommands", () => {
  const CARDS = [
    { id: "h1", column: "ready", track: "hand", component: "flow", title: "H1", size: "S", class: "code", goal: "Change plugins/doug-flow/lib/a.mjs." },
    { id: "h2", column: "ready", track: "hand", component: "flow", title: "H2", size: "S", class: "code", goal: "Change plugins/doug-flow/lib/b.mjs." },
    { id: "h3", column: "ready", track: "hand", component: "cli", title: "H3", size: "S", class: "code", goal: "Change packages/doug-cli/src/c.ts." },
  ];
  function queenProject({ cards = CARDS, config, plans = {}, milestones } = {}) {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }, { id: "done", title: "Done" }], components: ["flow", "cli", "gates"], ...(milestones ? { milestones } : {}), cards }));
    if (config) writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(config));
    for (const [id, p] of Object.entries(plans)) {
      mkdirSync(join(dir, ".doug/plans"), { recursive: true });
      writeFileSync(join(dir, `.doug/plans/${id}.json`), JSON.stringify(p));
    }
    ap(dir, "start", "--cards", cards.map((c) => c.id).join(","), "--usd-cap", "10", "--wall-cap", "100");
    return dir;
  }
  const launch = (dir, id, run, kind = "hand") => {
    const argsFile = join(dir, `${id}-args.json`);
    writeFileSync(argsFile, JSON.stringify({ card: id, seed: `args-of-${id}` }));
    return ap(dir, "launched", id, "--run", run, "--kind", kind, "--worktree", join(dir, `wt-${id}`), "--args-file", argsFile);
  };
  const resultFile = (dir, name, value) => {
    const f = join(dir, name);
    writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value));
    return f;
  };

  it("A01 pick reads workers.max from config, prints JSON on stdout and one held line per held card on stderr", () => {
    const dir = queenProject({ config: { workers: { max: 2 } } });
    const r = ap(dir, "pick");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.launch).toEqual(["h1", "h3"]);
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({ id: "h2", with: "h1" });
    expect(out.needsPlan).toEqual([]);
    expect(out.alone).toEqual([]);
    expect(r.stderr).toMatch(/^held h2: overlaps h1 \(.+\)$/m);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("held "))).toHaveLength(1);
  });

  it("A01 pick --max overrides the slots, and the default is 3 when config has no workers.max", () => {
    const dir = queenProject({ config: { workers: { max: 3 } } });
    expect(JSON.parse(ap(dir, "pick", "--max", "1").stdout).launch).toEqual(["h1"]);
    const plain = queenProject();
    expect(JSON.parse(ap(plain, "pick").stdout).launch).toEqual(["h1", "h3"]);
  });

  it("A01 pick counts an in-flight card from the state file: it is not launched again and it holds an overlapping card", () => {
    const dir = queenProject({ config: { workers: { max: 3 } } });
    expect(launch(dir, "h1", "wf_one").status).toBe(0);
    const r = ap(dir, "pick");
    const out = JSON.parse(r.stdout);
    expect(out.launch).toEqual(["h3"]);
    expect(out.held[0]).toMatchObject({ id: "h2", with: "h1" });
    // the slot taken by the in-flight card counts against workers.max
    const capped = queenProject({ config: { workers: { max: 1 } } });
    launch(capped, "h1", "wf_one");
    expect(JSON.parse(ap(capped, "pick").stdout).launch).toEqual([]);
  });

  it("A01 pick sends a card whose goal asks for a swarm to alone, not launch", () => {
    const cards = [{ ...CARDS[0], id: "sw", goal: "Run it as a swarm: change plugins/doug-flow/lib/a.mjs." }, CARDS[2]];
    const dir = queenProject({ cards });
    const out = JSON.parse(ap(dir, "pick").stdout);
    expect(out.launch).not.toContain("sw");
    expect(out.launch).toEqual([]);
    expect(out.alone).toEqual(["sw"]);
  });

  it("A01 swarm detection is conservative: a tag, swarm: true or an explicit request make a swarm card; the word swarm in a goal does not", () => {
    const prose = [
      "Measure whether the semantic index helps a swarm worker find files.",
      "Pre-register the eval; the swarm arm and the plain arm are compared.",
      "The crew tester seat is reused by a swarm lead when it splits a task.",
      "Codex implementer seats; swarm workers stay on the worker row.",
      "Fork workers headless for research, as the swarm does today.",
      "Benchmark doug against plain Claude, swarm off.",
    ];
    const cards = [
      ...prose.map((g, i) => ({ ...CARDS[0], id: `p${i}`, component: `c${i}`, goal: `${g} Touch dir${i}/f${i}.mjs.` })),
      { ...CARDS[0], id: "tg", component: "ct", tags: ["swarm"], goal: "Touch dirt/ft.mjs." },
      { ...CARDS[0], id: "fl", component: "cf", swarm: true, goal: "Touch dirf/ff.mjs." },
      { ...CARDS[0], id: "rq", component: "cr", goal: "Run it as a swarm. Touch dirr/fr.mjs." },
    ];
    const dir = queenProject({ cards, config: { workers: { max: 16 } } });
    const out = JSON.parse(ap(dir, "pick").stdout);
    expect(out.launch).toEqual(prose.map((_, i) => `p${i}`));
    expect(out.alone).toEqual([]);
    const only = queenProject({ cards: cards.slice(6) });
    expect(JSON.parse(ap(only, "pick").stdout).alone).toEqual(["tg", "fl", "rq"]);
  });

  it("A01 pick passes the repository's top-level directories as roots: a prose path under no root is not a path", () => {
    const cards = [
      { ...CARDS[0], id: "r1", component: "flow", goal: "Mention notes/ideas somewhere in prose." },
      { ...CARDS[0], id: "r2", component: "cli", goal: "Also mention notes/ideas in prose." },
    ];
    const dir = queenProject({ cards });
    const out = JSON.parse(ap(dir, "pick").stdout);
    expect(out.launch).toEqual(["r1", "r2"]);
    expect(out.held).toEqual([]);
  });

  describe("pick --milestone (ADR 0016)", () => {
    const MS = [
      { id: "m1", title: "M1", goal: "First.", status: "active" },
      { id: "m2", title: "M2", goal: "Second.", status: "planned" },
    ];
    const msCards = [{ ...CARDS[0], milestone: "m1" }, { ...CARDS[2], milestone: "m2" }, { ...CARDS[1], id: "h4", component: "gates", goal: "Change plugins/doug-gates/lib/z.mjs." }];

    it("limits the launch list to that milestone's Ready cards; the outside cards appear nowhere", () => {
      const dir = queenProject({ cards: msCards, milestones: MS, config: { workers: { max: 5 } } });
      const r = ap(dir, "pick", "--milestone", "m1");
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.launch).toEqual(["h1"]);
      for (const k of ["needsPlan", "held", "alone"]) expect(JSON.stringify(out[k])).not.toMatch(/h3|h4/);
    });

    it("without --milestone every Ready card is picked, in board order", () => {
      const dir = queenProject({ cards: msCards, milestones: MS, config: { workers: { max: 5 } } });
      const r = ap(dir, "pick");
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).launch).toEqual(["h1", "h3", "h4"]);
    });

    it("an unknown milestone exits 1 with a one-line autopilot error, no stack and no JSON", () => {
      const dir = queenProject({ cards: msCards, milestones: MS });
      const r = ap(dir, "pick", "--milestone", "nope");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^autopilot: unknown milestone "nope"/m);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.stdout.trim()).toBe("");
    });
  });

  it("A02/A03 error paths: a missing --args-file or --file exits 1 with a message and no stack; an unwritable report still prints the verdict", () => {
    const dir = queenProject();
    const noArgs = ap(dir, "launched", "h1", "--run", "wf_x", "--kind", "hand", "--worktree", "/w", "--args-file", join(dir, "absent.json"));
    expect(noArgs.status).toBe(1);
    expect(noArgs.stderr).toMatch(/^autopilot: /);
    expect(noArgs.stderr).not.toMatch(/\n\s+at /);
    launch(dir, "h1", "wf_h1");
    const noFile = ap(dir, "report", "--run", "wf_h1", "--file", join(dir, "absent.json"));
    expect(noFile.status).toBe(1);
    expect(noFile.stderr).toMatch(/^autopilot: /);
    expect(noFile.stderr).not.toMatch(/\n\s+at /);
    // the report path is a directory, so the report cannot be written
    mkdirSync(join(dir, ".doug/.state/reports/h1/card-report.json"), { recursive: true });
    const r = ap(dir, "report", "--run", "wf_h1", "--file", resultFile(dir, "ok.json", { kind: "done", report: {} }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^autopilot: warning: /m);
    expect(r.stdout).toMatch(/^autopilot: h1 land/m);
  });

  it("A08 pick prints needsPlan for a flow card with no plan, and launches it once its per-card plan exists", () => {
    const flowCard = { id: "f1", column: "ready", component: "gates", title: "F1", size: "M", class: "code", goal: "Flow goal for f1." };
    const dir = queenProject({ cards: [flowCard], config: { workers: { max: 3 } } });
    const out = JSON.parse(ap(dir, "pick").stdout);
    expect(out.needsPlan).toEqual(["f1"]);
    expect(out.launch).toEqual([]);
    const planned = queenProject({ cards: [flowCard], config: { workers: { max: 3 } }, plans: { f1: { tasks: [{ id: "f1-t1", files: ["plugins/doug-gates/lib/x.mjs"] }] } } });
    const out2 = JSON.parse(ap(planned, "pick").stdout);
    expect(out2.needsPlan).toEqual([]);
    expect(out2.launch).toEqual(["f1"]);
  });

  it("A02 launched sets the card running, records the run id, kind and worktree, and saves the exact args", () => {
    const dir = queenProject();
    const r = launch(dir, "h1", "wf_abc");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^autopilot: .+/);
    const c = state(dir).cards.find((x) => x.id === "h1");
    expect(c).toMatchObject({ state: "running", runId: "wf_abc", kind: "hand", worktree: join(dir, "wt-h1") });
    const saved = JSON.parse(readFileSync(join(dir, ".doug/.state/reports/h1/queen-args.json"), "utf8"));
    expect(saved).toEqual({ card: "h1", seed: "args-of-h1" });
    expect(launch(dir, "nope", "wf_x").status).toBe(1);
  });

  it("A03 report maps the run id to its card, writes card-report.json for a hand card (never last-report.json), and prints land", () => {
    const dir = queenProject();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h3", "wf_h3");
    const f = resultFile(dir, "res.json", { kind: "done", report: { marker: "HAND-MARK-H3" } });
    const r = ap(dir, "report", "--run", "wf_h3", "--file", f);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^autopilot: h3 land/m);
    expect(readFileSync(join(dir, ".doug/.state/reports/h3/card-report.json"), "utf8")).toContain("HAND-MARK-H3");
    expect(existsSync(join(dir, ".doug/.state/reports/h3/last-report.json"))).toBe(false);
    expect(existsSync(join(dir, ".doug/.state/last-report.json"))).toBe(false);
    expect(existsSync(join(dir, ".doug/.state/reports/h1/card-report.json"))).toBe(false);
  });

  it("A03b report with the queen's real result shape (outcome, no wrapper) prints land and saves it as card-report.json", () => {
    const dir = queenProject();
    launch(dir, "h3", "wf_h3");
    const r = ap(dir, "report", "--run", "wf_h3", "--file", resultFile(dir, "real.json", { outcome: "done", reason: null, commit: "d2953b2", history: [] }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("h3 land");
    expect(JSON.parse(readFileSync(join(dir, ".doug/.state/reports/h3/card-report.json"), "utf8")).commit).toBe("d2953b2");
  });

  it("A03 report prints resume for an agent-null stop and ask with the reason for another stop", () => {
    const dir = queenProject();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h3", "wf_h3");
    const nullStop = ap(dir, "report", "--run", "wf_h1", "--file", resultFile(dir, "a.json", { kind: "stopped", reason: "agent-null", report: {} }));
    expect(nullStop.stdout).toMatch(/^autopilot: h1 resume/m);
    const other = ap(dir, "report", "--run", "wf_h3", "--file", resultFile(dir, "b.json", { kind: "stopped", reason: "gate-red-twice", report: {} }));
    expect(other.stdout).toMatch(/^autopilot: h3 ask .*gate-red-twice/m);
    const garbage = ap(dir, "report", "--run", "wf_h1", "--file", resultFile(dir, "c.json", "{not json"));
    expect(garbage.stdout).toMatch(/^autopilot: h1 resume/m);
  });

  it("A04 report for an unknown run id exits 1 and writes no report", () => {
    const dir = queenProject();
    launch(dir, "h1", "wf_h1");
    const r = ap(dir, "report", "--run", "wf_nope", "--file", resultFile(dir, "res.json", { kind: "done", report: {} }));
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, ".doug/.state/reports/h1/card-report.json"))).toBe(false);
    expect(existsSync(join(dir, ".doug/.state/reports/wf_nope"))).toBe(false);
  });

  it("A09 report for a flow run writes reportPathFor(id) (last-report.json under the card's reports dir), not card-report.json", () => {
    const flowCard = { id: "f1", column: "ready", component: "gates", title: "F1", size: "M", class: "code", goal: "Flow goal for f1." };
    const dir = queenProject({ cards: [flowCard] });
    launch(dir, "f1", "wf_f1", "flow");
    const r = ap(dir, "report", "--run", "wf_f1", "--file", resultFile(dir, "res.json", { ok: true, levels: [], marker: "FLOW-MARK" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^autopilot: f1 land/m);
    expect(readFileSync(join(dir, ".doug/.state/reports/f1/last-report.json"), "utf8")).toContain("FLOW-MARK");
    expect(existsSync(join(dir, ".doug/.state/reports/f1/card-report.json"))).toBe(false);
    expect(existsSync(join(dir, ".doug/.state/last-report.json"))).toBe(false);
    const stopped = ap(dir, "report", "--run", "wf_f1", "--file", resultFile(dir, "res2.json", { ok: false, stoppedAtLevel: 1 }));
    expect(stopped.stdout).toMatch(/^autopilot: f1 ask/m);
  });

  it("A09b report unwraps a flow queen result saved with its task-output wrapper", () => {
    const flowCard = { id: "f1", column: "ready", component: "gates", title: "F1", size: "M", class: "code", goal: "Flow goal for f1." };
    const dir = queenProject({ cards: [flowCard] });
    launch(dir, "f1", "wf_f1", "flow");
    const wrapped = { summary: "done", agentCount: 3, logs: [], result: { ok: true, levels: [], marker: "FLOW-WRAP" } };
    const r = ap(dir, "report", "--run", "wf_f1", "--file", resultFile(dir, "wrapped.json", wrapped));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^autopilot: f1 land/m);
    const saved = JSON.parse(readFileSync(join(dir, ".doug/.state/reports/f1/last-report.json"), "utf8"));
    expect(saved.marker).toBe("FLOW-WRAP");
    expect("summary" in saved).toBe(false);
  });

  it("A09c a flow result with top-level ok or paused is never unwrapped", () => {
    const flowCard = { id: "f1", column: "ready", component: "gates", title: "F1", size: "M", class: "code", goal: "Flow goal for f1." };
    const dir = queenProject({ cards: [flowCard] });
    launch(dir, "f1", "wf_f1", "flow");
    const okTop = ap(dir, "report", "--run", "wf_f1", "--file", resultFile(dir, "ok.json", { ok: true, levels: [], result: { ok: false, stoppedAtLevel: 2 } }));
    expect(okTop.stdout).toMatch(/^autopilot: f1 land/m);
    const pausedTop = ap(dir, "report", "--run", "wf_f1", "--file", resultFile(dir, "paused.json", { paused: { gate: "human", level: 1 }, result: { ok: true, levels: [] } }));
    expect(pausedTop.stdout).toMatch(/^autopilot: f1 ask paused at a human gate/m);
  });

  it("A03c report unwraps a hand queen result saved with its task-output wrapper", () => {
    const dir = queenProject();
    launch(dir, "h3", "wf_h3");
    const wrapped = { summary: "stopped", agentCount: 4, logs: [], result: { card: { id: "h3" }, outcome: "stopped", reason: "reviewer-major-open", stoppedAt: "reviewer", detail: "R1 open", history: [] } };
    const r = ap(dir, "report", "--run", "wf_h3", "--file", resultFile(dir, "wrapped.json", wrapped));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^autopilot: h3 ask reviewer-major-open/m);
    const saved = JSON.parse(readFileSync(join(dir, ".doug/.state/reports/h3/card-report.json"), "utf8"));
    expect(saved.reason).toBe("reviewer-major-open");
    expect("summary" in saved).toBe(false);
  });

  it("A03d a hand result with top-level card or outcome is never unwrapped", () => {
    const dir = queenProject();
    launch(dir, "h3", "wf_h3");
    const outcomeTop = ap(dir, "report", "--run", "wf_h3", "--file", resultFile(dir, "o.json", { outcome: "done", commit: "abc", history: [], result: { outcome: "stopped", reason: "gate-red-twice" } }));
    expect(outcomeTop.stdout).toMatch(/^autopilot: h3 land/m);
    const cardTop = ap(dir, "report", "--run", "wf_h3", "--file", resultFile(dir, "c.json", { card: { id: "h3" }, kind: "done", report: {}, result: { outcome: "stopped", reason: "gate-red-twice" } }));
    expect(cardTop.stdout).toMatch(/^autopilot: h3 land/m);
  });

  it("A05 lock-wait adds to the card's lockWaitMs; an unknown card exits 1", () => {
    const dir = queenProject();
    expect(ap(dir, "lock-wait", "h1", "--ms", "300").status).toBe(0);
    expect(state(dir).cards.find((c) => c.id === "h1").lockWaitMs).toBe(300);
    expect(ap(dir, "lock-wait", "h1", "--ms", "450").status).toBe(0);
    expect(state(dir).cards.find((c) => c.id === "h1").lockWaitMs).toBe(750);
    expect(state(dir).cards.find((c) => c.id === "h3").lockWaitMs ?? 0).toBe(0);
    expect(ap(dir, "lock-wait", "nope", "--ms", "5").status).toBe(1);
    expect(ap(dir, "lock-wait", "h1", "--ms", "x").status).toBe(2);
  });

  it("A07 queen-args hand writes the card, options, models, repoRoot and worktreePath, and prints the file path", () => {
    const dir = queenProject({ config: { commands: { install: "pnpm install" } } });
    const r = ap(dir, "queen-args", "h1", "--kind", "hand");
    expect(r.status, r.stderr).toBe(0);
    const file = join(dir, ".doug/.state/reports/h1/queen-args.json");
    expect(r.stdout.trim().split("\n")[0]).toBe(file);
    const a = JSON.parse(readFileSync(file, "utf8"));
    expect(a.card).toEqual({ id: "h1", title: "H1", size: "S", class: "code", goal: "Change plugins/doug-flow/lib/a.mjs." });
    expect(a.options).toEqual({ testerAgent: true, research: false, install: "pnpm install", gateCommand: "node .doug/hooks/scripts/verify.mjs", branch: "card/h1", base: "main" });
    expect(a.repoRoot).toBe(dir);
    expect(a.worktreePath).toBe(join(dir, ".claude/worktrees/card-h1"));
    expect(a.models).toBeTruthy();
    expect(Array.isArray(a.models.errors)).toBe(true);
    const bare = queenProject();
    ap(bare, "queen-args", "h1", "--kind", "hand");
    expect(JSON.parse(readFileSync(join(bare, ".doug/.state/reports/h1/queen-args.json"), "utf8")).options.install).toBe(null);
  });

  it("agent-types hand prints the distinct AGENT_TYPES of card-queen.js, one per line (queen-agent-preflight)", () => {
    const dir = queenProject();
    const r = ap(dir, "agent-types", "--kind", "hand");
    expect(r.status, r.stderr).toBe(0);
    const src = readFileSync(join(here, "..", "workflows", "card-queen.js"), "utf8");
    const block = src.match(/const AGENT_TYPES = \{([^}]*)\}/)[1];
    const want = [...new Set([...block.matchAll(/'(doug-flow:[a-z-]+)'/g)].map((m) => m[1]))];
    expect(want.length).toBeGreaterThanOrEqual(6);
    expect(r.stdout.trim().split("\n").sort()).toEqual(want.sort());
    expect(r.stdout.trim().split("\n").sort()).toEqual(["doug-flow:coder", "doug-flow:implementer", "doug-flow:lead", "doug-flow:researcher", "doug-flow:reviewer", "doug-flow:tester"]);
  });

  it("agent-types flow prints the distinct agentType literals of doug-implement.js; bad kind exits 2", () => {
    const dir = queenProject();
    const r = ap(dir, "agent-types", "--kind", "flow");
    expect(r.status, r.stderr).toBe(0);
    const src = readFileSync(join(here, "..", "workflows", "doug-implement.js"), "utf8");
    const want = [...new Set([...src.matchAll(/agentType: '([^']+)'/g)].map((m) => m[1]))];
    expect(want).toContain("doug-flow:verifier");
    expect(r.stdout.trim().split("\n").sort()).toEqual(want.sort());
    expect(ap(dir, "agent-types", "--kind", "other").status).toBe(2);
    expect(ap(dir, "agent-types").status).toBe(2);
  });

  it("A08 queen-args flow writes the plan.mjs json --card object; unknown card exits 1, bad kind exits 2", () => {
    const plan = { version: 1, goal: "G", status: "approved", card: "f1", tasks: [{ id: "t1", title: "T", spec: "s", files: ["a.txt"], acceptance: [{ text: "x", command: "true" }] }] };
    const dir = queenProject({ plans: { f1: plan } });
    const r = ap(dir, "queen-args", "f1", "--kind", "flow");
    expect(r.status, r.stderr).toBe(0);
    const a = JSON.parse(readFileSync(r.stdout.trim().split("\n")[0], "utf8"));
    expect(a.card).toBe("f1");
    expect(a.tasks[0].id).toBe("t1");
    expect(ap(dir, "queen-args", "nope", "--kind", "hand").status).toBe(1);
    expect(ap(dir, "queen-args", "nope", "--kind", "flow").status).toBe(1);
    expect(ap(dir, "queen-args", "h1", "--kind", "other").status).toBe(2);
  });

  it("A06 resumed increments resumes and records the new run id, which report then resolves", () => {
    const dir = queenProject();
    launch(dir, "h1", "wf_old");
    expect(ap(dir, "resumed", "h1", "--run", "wf_new1").status).toBe(0);
    let c = state(dir).cards.find((x) => x.id === "h1");
    expect(c.resumes).toBe(1);
    expect(c.runId).toBe("wf_new1");
    ap(dir, "resumed", "h1", "--run", "wf_new2");
    c = state(dir).cards.find((x) => x.id === "h1");
    expect(c.resumes).toBe(2);
    expect(c.runId).toBe("wf_new2");
    expect(ap(dir, "report", "--run", "wf_new2", "--file", resultFile(dir, "r.json", { kind: "done", report: {} })).stdout).toMatch(/^autopilot: h1 land/m);
    expect(ap(dir, "report", "--run", "wf_old", "--file", resultFile(dir, "r2.json", { kind: "done", report: {} })).status).toBe(1);
  });

  it("A07 the view with two running cards lists both in running, with their run ids; current stays the first", () => {
    const s = runState({
      cards: [
        { id: "a", state: "running", runId: "wf_a" },
        { id: "b", state: "running", runId: "wf_b" },
        { id: "c", state: "queued" },
      ],
    });
    const v = autopilotView(s, NOW);
    expect(v.running).toEqual([{ id: "a", runId: "wf_a" }, { id: "b", runId: "wf_b" }]);
    expect(v.current).toMatchObject({ id: "a" });
    expect(autopilotView(runState(), NOW).running.map((x) => x.id)).toEqual(["cur"]);
  });
});

// Card queen-resume-with-answer: `answer` records the user's answer to a design-decision stop in queen-args.json,
// and `report` then says to resume with it.
describe("card queen-resume-with-answer: autopilot answer", () => {
  const CARDS = [
    { id: "h1", column: "ready", track: "hand", component: "flow", title: "H1", size: "S", class: "code", goal: "Change plugins/doug-flow/lib/a.mjs." },
    { id: "h2", column: "ready", track: "hand", component: "cli", title: "H2", size: "S", class: "code", goal: "Change packages/doug-cli/src/c.ts." },
  ];
  function setup() {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }], components: ["flow", "cli"], cards: CARDS }));
    ap(dir, "start", "--cards", "h1,h2", "--usd-cap", "10", "--wall-cap", "100");
    return dir;
  }
  const launchWith = (dir, id, run) => {
    const argsFile = join(dir, `${id}-args.json`);
    writeFileSync(argsFile, JSON.stringify({ card: { id }, options: { research: false } }));
    return ap(dir, "launched", id, "--run", run, "--kind", "hand", "--worktree", join(dir, `wt-${id}`), "--args-file", argsFile);
  };
  const result = (dir, name, value) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(value));
    return f;
  };
  const stopResult = (over = {}) => ({
    outcome: "stopped",
    reason: "design-decision",
    stoppedAt: "tester",
    detail: "Q?",
    history: [
      { seat: "setup", round: 1, result: "ok" },
      { seat: "tester", round: 1, result: "stopped", note: "design-decision" },
    ],
    ...over,
  });
  const queenArgs = (dir, id) => JSON.parse(readFileSync(join(dir, ".doug/.state/reports", id, "queen-args.json"), "utf8"));

  it("A10 answer appends { seat, question, answer, round, run } to options.answers from the saved stop", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stopResult()));
    const r = ap(dir, "answer", "h1", "--answer", "A.");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("autopilot: h1 answer recorded for tester");
    const saved = queenArgs(dir, "h1");
    expect(saved.options.answers).toEqual([{ seat: "tester", question: "Q?", answer: "A.", round: 1, run: "wf_h1" }]);
    expect(saved.options.research).toBe(false);
    expect(saved.card).toEqual({ id: "h1" });
    // a second answer appends
    ap(dir, "answer", "h1", "--answer", "B.");
    expect(queenArgs(dir, "h1").options.answers.map((a) => a.answer)).toEqual(["A.", "B."]);
  });

  it("A10b answer refuses an agent-null stop (a resume, not an ask), a blank answer, a missing report, a missing args file and an unknown card", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    launchWith(dir, "h2", "wf_h2");
    // no report saved yet
    expect(ap(dir, "answer", "h1", "--answer", "A.").status).toBe(1);
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stopResult({ reason: "agent-null" })));
    const notDesign = ap(dir, "answer", "h1", "--answer", "A.");
    expect(notDesign.status).toBe(1);
    expect(queenArgs(dir, "h1").options.answers).toBeUndefined();
    ap(dir, "report", "--run", "wf_h2", "--file", result(dir, "r2.json", stopResult()));
    expect(ap(dir, "answer", "h2", "--answer", "   ").status).toBe(2);
    expect(ap(dir, "answer", "h2").status).toBe(2);
    expect(ap(dir, "answer", "nope", "--answer", "A.").status).toBe(1);
    rmSync(join(dir, ".doug/.state/reports/h2/queen-args.json"));
    expect(ap(dir, "answer", "h2", "--answer", "A.").status).toBe(1);
  });

  it("A11 report prints ask design-decision before the answer and resume with the answer after it", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const f = result(dir, "r.json", stopResult());
    expect(ap(dir, "report", "--run", "wf_h1", "--file", f).stdout).toMatch(/^autopilot: h1 ask design-decision/m);
    ap(dir, "answer", "h1", "--answer", "A.");
    const after = ap(dir, "report", "--run", "wf_h1", "--file", f);
    expect(after.status).toBe(0);
    expect(after.stdout).toMatch(/^autopilot: h1 resume with the answer/m);
    expect(after.stdout).not.toContain("ask design-decision");
  });

  it("A12 a repeat design-decision stop under the resumed run id is ask again", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stopResult()));
    ap(dir, "answer", "h1", "--answer", "A.");
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    const again = ap(dir, "report", "--run", "wf_h1b", "--file", result(dir, "r2.json", stopResult({ detail: "Q2?" })));
    expect(again.stdout).toMatch(/^autopilot: h1 ask design-decision/m);
    expect(again.stdout).not.toContain("resume with the answer");
  });

  it("A12c an identical repeat stop under the resumed run id is ask again, not resume with the answer", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const f = result(dir, "r.json", stopResult());
    ap(dir, "report", "--run", "wf_h1", "--file", f);
    ap(dir, "answer", "h1", "--answer", "A.");
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    const again = ap(dir, "report", "--run", "wf_h1b", "--file", f);
    expect(again.stdout).toMatch(/^autopilot: h1 ask design-decision/m);
    expect(again.stdout).not.toContain("resume with the answer");
  });

  it("A13 resumed after a resume with the answer counts it against the single plain resume", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const f = result(dir, "r.json", stopResult());
    ap(dir, "report", "--run", "wf_h1", "--file", f);
    ap(dir, "answer", "h1", "--answer", "A.");
    expect(ap(dir, "report", "--run", "wf_h1", "--file", f).stdout).toMatch(/^autopilot: h1 resume with the answer/m);
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    const c = state(dir).cards.find((x) => x.id === "h1");
    expect(c.resumes).toBe(1);
    expect(c.runId).toBe("wf_h1b");
  });

  it("A14 an answer for the lead does not cover a reviewer design-decision stop under the same run, round and question", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stopResult({ stoppedAt: "lead", history: [{ seat: "lead", round: 1, result: "stopped", note: "design-decision" }] })));
    ap(dir, "answer", "h1", "--answer", "A.");
    const rev = result(dir, "r2.json", stopResult({ stoppedAt: "reviewer", history: [{ seat: "reviewer", round: 1, result: "stopped", note: "design-decision" }] }));
    const out = ap(dir, "report", "--run", "wf_h1", "--file", rev);
    expect(out.stdout).toMatch(/^autopilot: h1 ask design-decision/m);
    expect(out.stdout).not.toContain("resume with the answer");
  });

  it("A15 an answer for reviewer round 1 does not cover a reviewer stop at round 2 with the same run and question", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const stop = (round) => stopResult({ stoppedAt: "reviewer", history: [{ seat: "reviewer", round, result: "stopped", note: "design-decision" }] });
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stop(1)));
    ap(dir, "answer", "h1", "--answer", "A.");
    const out = ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r2.json", stop(2)));
    expect(out.stdout).toMatch(/^autopilot: h1 ask design-decision/m);
    expect(out.stdout).not.toContain("resume with the answer");
  });

  it("A16 an answer to Q? does not cover a tester round 1 stop under the same run asking Q2?", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stopResult()));
    ap(dir, "answer", "h1", "--answer", "A.");
    const out = ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r2.json", stopResult({ detail: "Q2?" })));
    expect(out.stdout).toMatch(/^autopilot: h1 ask design-decision/m);
    expect(out.stdout).not.toContain("resume with the answer");
  });

  // Card autopilot-answer-any-stop: answer records an answer for any ask stop with a stoppedAt seat.
  const briefFor = (dir, id, seat, seatRuns) => {
    const answers = queenArgs(dir, id).options.answers;
    const st = { ...initialState({ id, goal: "g" }, { answers }), pending: seat, seatRuns };
    return currentAction(st).brief;
  };
  const reviewerMajor = () =>
    stopResult({
      reason: "reviewer-major-open",
      stoppedAt: "reviewer",
      detail: "major with evidence still open after one fix pass: R1",
      history: [
        { seat: "reviewer", round: 1, result: "ok" },
        { seat: "reviewer", round: 2, result: "stopped", note: "reviewer-major-open" },
      ],
    });
  const gateBlocked = () =>
    stopResult({
      reason: "seat-blocked",
      stoppedAt: "gate",
      detail: "gate cannot run",
      history: [{ seat: "gate", round: 1, result: "stopped", note: "seat-blocked" }],
    });

  it("A17 answer records a reviewer-major-open stop and it reaches the reviewer round-2 brief", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const rep = reviewerMajor();
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", rep));
    const r = ap(dir, "answer", "h1", "--answer", "Accept and resume.");
    expect(r.status, r.stderr).toBe(0);
    expect(queenArgs(dir, "h1").options.answers).toEqual([
      { seat: "reviewer", question: rep.detail, answer: "Accept and resume.", round: 2, run: "wf_h1" },
    ]);
    expect(briefFor(dir, "h1", "reviewer", { reviewer: 1 }).answers).toEqual([{ question: rep.detail, answer: "Accept and resume." }]);
    expect(briefFor(dir, "h1", "tester", {}).answers).toEqual([]);
  });

  it("A18 answer records a seat-blocked gate stop and it reaches the gate round-1 brief", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", gateBlocked()));
    const r = ap(dir, "answer", "h1", "--answer", "Use the other gate.");
    expect(r.status, r.stderr).toBe(0);
    const [e] = queenArgs(dir, "h1").options.answers;
    expect(e).toMatchObject({ seat: "gate", round: 1, question: "gate cannot run", answer: "Use the other gate.", run: "wf_h1" });
    expect(briefFor(dir, "h1", "gate", {}).answers).toEqual([{ question: "gate cannot run", answer: "Use the other gate." }]);
    expect(briefFor(dir, "h1", "tester", {}).answers).toEqual([]);
  });

  it("A19 report prints ask reviewer-major-open before the answer and resume with the answer after it", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const f = result(dir, "r.json", reviewerMajor());
    expect(ap(dir, "report", "--run", "wf_h1", "--file", f).stdout).toMatch(/^autopilot: h1 ask reviewer-major-open/m);
    ap(dir, "answer", "h1", "--answer", "A.");
    const after = ap(dir, "report", "--run", "wf_h1", "--file", f);
    expect(after.stdout).toMatch(/^autopilot: h1 resume with the answer/m);
    expect(after.stdout).not.toContain("ask reviewer-major-open");
  });

  it("A20 an identical reviewer-major-open stop under the resumed run id is ask again and resumes stays 1", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    const f = result(dir, "r.json", reviewerMajor());
    ap(dir, "report", "--run", "wf_h1", "--file", f);
    ap(dir, "answer", "h1", "--answer", "A.");
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    const again = ap(dir, "report", "--run", "wf_h1b", "--file", f);
    expect(again.stdout).toMatch(/^autopilot: h1 ask reviewer-major-open/m);
    expect(again.stdout).not.toContain("resume with the answer");
    expect(state(dir).cards.find((x) => x.id === "h1").resumes).toBe(1);
  });

  it("A21 answer refuses a stopped report with no stoppedAt seat and writes nothing", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", stopResult({ reason: "seat-blocked", stoppedAt: null, detail: "x" })));
    expect(ap(dir, "answer", "h1", "--answer", "A.").status).toBe(1);
    expect(queenArgs(dir, "h1").options.answers).toBeUndefined();
  });

  it("A21b answer refuses a report that is not a stop and writes nothing", () => {
    const dir = setup();
    launchWith(dir, "h1", "wf_h1");
    ap(dir, "report", "--run", "wf_h1", "--file", result(dir, "r.json", { outcome: "done", history: [] }));
    expect(ap(dir, "answer", "h1", "--answer", "A.").status).toBe(1);
    expect(queenArgs(dir, "h1").options.answers).toBeUndefined();
  });

  it("A12b the unknown-subcommand message and the usage header name answer", () => {
    const dir = setup();
    const r = ap(dir, "bogus-subcommand");
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("answer");
    expect(readFileSync(script, "utf8").split("\n").slice(0, 40).join("\n")).toContain("autopilot.mjs answer <id>");
  });
});

// Card queen-run-name: queen-args writes a per-card copy of the queen script whose run name carries the short card id.
describe("card queen-run-name: autopilot queen-args per-card copy", () => {
  it("the usage header names --with and both printed paths", () => {
    const line = readFileSync(script, "utf8").split("\n").find((l) => l.includes("autopilot.mjs queen-args <id>"));
    expect(line).toContain("[--with <id,id,...>]");
    expect(line).toContain("queen.js");
    expect(line).toContain("prints both paths");
  });
  const mk = (id) => ({ id, column: "ready", track: "hand", component: "flow", title: id, size: "S", class: "code", goal: `Change plugins/doug-flow/lib/${id}.mjs.` });
  const CARDS = ["research-cap-loopback-post", "stop-gate-alpha", "stop-gate-beta", "statusline"].map(mk);
  const FLOW_PLAN = { version: 1, goal: "G", status: "approved", card: "alpha-beta-gamma", tasks: [{ id: "t1", title: "T", spec: "s", files: ["a.txt"], acceptance: [{ text: "x", command: "true" }] }] };
  function proj(plans = {}) {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, ".doug/plans"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "packages"), { recursive: true });
    const cards = [...CARDS, { ...mk("alpha-beta-gamma"), track: "flow" }];
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }], components: ["flow"], cards }));
    for (const [id, pl] of Object.entries(plans)) writeFileSync(join(dir, `.doug/plans/${id}.json`), JSON.stringify(pl));
    ap(dir, "start", "--cards", cards.map((c) => c.id).join(","), "--usd-cap", "10", "--wall-cap", "100");
    return dir;
  }
  const setState = (dir, id, st) => {
    const f = join(dir, ".doug/.state/autopilot.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.cards.find((c) => c.id === id).state = st;
    writeFileSync(f, JSON.stringify(j));
  };
  const queenJs = (dir, id) => join(dir, ".doug/.state/reports", id, "queen.js");
  const nameOf = (dir, id) => readFileSync(queenJs(dir, id), "utf8").match(/^\s*name: '([^']*)',/m)[1];
  const run = (dir, id, ...rest) => ap(dir, "queen-args", id, "--kind", "hand", ...rest);
  const afterMeta = (t) => t.slice(t.indexOf("phases:"));

  it("N01 hand: writes reports/<id>/queen.js named '<short id> card-queen' and prints the args path then the script path", () => {
    const dir = proj();
    const r = run(dir, "research-cap-loopback-post");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      join(dir, ".doug/.state/reports/research-cap-loopback-post/queen-args.json"),
      queenJs(dir, "research-cap-loopback-post"),
    ]);
    expect(nameOf(dir, "research-cap-loopback-post")).toBe("research-cap card-queen");
    const src = readFileSync(join(here, "..", "workflows", "card-queen.js"), "utf8");
    const out = readFileSync(queenJs(dir, "research-cap-loopback-post"), "utf8");
    expect(out).toContain("description: 'research-cap: The queen of one hand-track card:");
    expect(afterMeta(out)).toBe(afterMeta(src));
  });

  it("N02 an id with one segment is named as is", () => {
    const dir = proj();
    expect(run(dir, "statusline").status).toBe(0);
    expect(nameOf(dir, "statusline")).toBe("statusline card-queen");
  });

  it("N03 flow: writes a per-card copy of doug-implement.js named '<short id> flow-queen'", () => {
    const dir = proj({ "alpha-beta-gamma": FLOW_PLAN });
    const r = ap(dir, "queen-args", "alpha-beta-gamma", "--kind", "flow");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      join(dir, ".doug/.state/reports/alpha-beta-gamma/queen-args.json"),
      queenJs(dir, "alpha-beta-gamma"),
    ]);
    expect(nameOf(dir, "alpha-beta-gamma")).toBe("alpha-beta flow-queen");
    const src = readFileSync(join(here, "..", "workflows", "doug-implement.js"), "utf8");
    const out = readFileSync(queenJs(dir, "alpha-beta-gamma"), "utf8");
    expect(out).toContain("description: 'alpha-beta: Implement an approved Doug plan");
    expect(afterMeta(out)).toBe(afterMeta(src));
  });

  it("N04 a card whose short form matches an in-flight card (running, done, landing) gets its full id", () => {
    for (const st of ["running", "done", "landing"]) {
      const dir = proj();
      setState(dir, "stop-gate-beta", st);
      expect(run(dir, "stop-gate-alpha").status).toBe(0);
      expect(nameOf(dir, "stop-gate-alpha"), st).toBe("stop-gate-alpha card-queen");
    }
  });

  it("N05 a card in another state (queued, landed, stopped) is not a collision", () => {
    for (const st of ["queued", "landed", "stopped"]) {
      const dir = proj();
      setState(dir, "stop-gate-beta", st);
      expect(run(dir, "stop-gate-alpha").status).toBe(0);
      expect(nameOf(dir, "stop-gate-alpha"), st).toBe("stop-gate card-queen");
    }
  });

  it("N06 --with ids of the same launch batch count as collisions; the card's own id in --with does not", () => {
    const dir = proj();
    expect(run(dir, "stop-gate-alpha", "--with", "research-cap-loopback-post,stop-gate-beta").status).toBe(0);
    expect(nameOf(dir, "stop-gate-alpha")).toBe("stop-gate-alpha card-queen");
    expect(run(dir, "stop-gate-beta", "--with", "stop-gate-beta,research-cap-loopback-post").status).toBe(0);
    expect(nameOf(dir, "stop-gate-beta")).toBe("stop-gate card-queen");
  });

  it("N07 two cards launched together with a shared short form both get their full ids", () => {
    const dir = proj();
    run(dir, "stop-gate-alpha", "--with", "stop-gate-beta");
    run(dir, "stop-gate-beta", "--with", "stop-gate-alpha");
    expect(nameOf(dir, "stop-gate-alpha")).toBe("stop-gate-alpha card-queen");
    expect(nameOf(dir, "stop-gate-beta")).toBe("stop-gate-beta card-queen");
  });

  it("N08 without autopilot.json queen-args still succeeds and uses the short form", () => {
    const dir = proj();
    rmSync(join(dir, ".doug/.state/autopilot.json"));
    const r = run(dir, "stop-gate-alpha");
    expect(r.status, r.stderr).toBe(0);
    expect(nameOf(dir, "stop-gate-alpha")).toBe("stop-gate card-queen");
  });

  it("N09 the per-card copy is a regular file with one link, not a symlink or hard link to the plugin script", () => {
    const dir = proj();
    run(dir, "research-cap-loopback-post");
    const st = lstatSync(queenJs(dir, "research-cap-loopback-post"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(st.nlink).toBe(1);
  });

  it("N10 a rerun overwrites the copy and keeps queen-args.json", () => {
    const dir = proj();
    run(dir, "stop-gate-alpha");
    expect(nameOf(dir, "stop-gate-alpha")).toBe("stop-gate card-queen");
    run(dir, "stop-gate-alpha", "--with", "stop-gate-beta");
    expect(nameOf(dir, "stop-gate-alpha")).toBe("stop-gate-alpha card-queen");
    expect(existsSync(join(dir, ".doug/.state/reports/stop-gate-alpha/queen-args.json"))).toBe(true);
  });
});

// Card autopilot-pane-current: the pane shows the newest run. register.tsx is driven with a faked claude-code
// module and a recording `on`; the poll is fired by hand, and the event hooks (prompt.submit, turn.complete,
// tool.call Bash) must refresh the same drawing without the timer.
vi.mock("claude-code", () => ({
  atom: (ref, initial) => ({ ref, initial }),
  read: async ($, a) => {
    const k = `${a.ref.plugin}/${a.ref.key}`;
    return $.state.has(k) ? $.state.get(k) : a.initial;
  },
  update: async ($, a, fn) => {
    const k = `${a.ref.plugin}/${a.ref.key}`;
    $.state.set(k, fn($.state.has(k) ? $.state.get(k) : a.initial));
  },
}));

describe("card autopilot-pane-current", () => {
  let register;
  beforeAll(async () => {
    ({ register } = await import("../hooks/register.tsx"));
  });

  const LINES = "doug-flow/autopilot";
  const nowIso = () => new Date().toISOString();
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const RUN1 = iso(120000);
  const RUN2 = iso(60000);
  const run = (startedAt, cardId, over = {}) => ({
    version: 1,
    status: "running",
    startedAt,
    updatedAt: nowIso(),
    endedAt: null,
    caps: { usd: 10, wallMin: 60, contextPct: 60 },
    cards: [{ id: cardId, title: `${cardId} title`, size: "S", class: "code", state: "running" }],
    filed: [],
    ...over,
  });
  const ended = (startedAt, cardId) =>
    run(startedAt, cardId, { status: "ended", endedAt: nowIso(), cards: [{ id: cardId, title: `${cardId} title`, size: "S", class: "code", state: "landed" }] });

  function rig({ config, state = new Map(), dir, registerFn = register } = {}) {
    dir ??= tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    if (config) writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(config));
    const handlers = {};
    const matchers = {};
    const on = (event, a, b) => {
      (handlers[event] ??= []).push(typeof a === "function" ? a : b);
      (matchers[event] ??= []).push(typeof a === "function" ? undefined : a);
    };
    const timers = [];
    const opens = [];
    const $ = {
      state,
      session: { root: async () => dir },
      fs: {
        read: async (p) => readFileSync(p, "utf8"),
        list: async (p) => readdirSync(p).map((name) => ({ name, kind: "file", size: 0, mtimeMs: statSync(join(p, name)).mtimeMs, isLink: false })),
      },
      command: { register: async () => {} },
      ui: { open: async (o) => void opens.push(o) },
      clock: { every: (ms, fn) => void timers.push(fn) },
    };
    registerFn(on);
    const write = (s) => writeFileSync(statePath(dir), typeof s === "string" ? s : JSON.stringify(s));
    const shown = () => (state.has(LINES) ? state.get(LINES) : []);
    const start = async () => handlers["session.start"][0]($, { isInteractive: true }, async (e) => e);
    const fire = (event, next) => handlers[event][0]($, { tool: "Bash", input: {} }, next);
    return { dir, $, state, handlers, matchers, timers, opens, write, shown, start, fire };
  }
  const SENT = { sentinel: true };
  const passthrough = async () => SENT;

  it("P1: the timer poll follows a run, its end, and a second start (new startedAt)", async () => {
    const r = rig();
    r.write(run(RUN1, "card-one"));
    await r.start();
    expect(r.timers).toHaveLength(1);
    expect(r.shown()[0]).toMatch(/^Autopilot running since /);
    expect(r.shown().join("\n")).toContain("card-one");

    r.write(ended(RUN1, "card-one"));
    await r.timers[0]();
    expect(r.shown()[0]).toMatch(/^Autopilot ended /);

    r.write(run(RUN2, "card-two"));
    await r.timers[0]();
    const text = r.shown().join("\n");
    expect(r.shown()[0]).toMatch(/^Autopilot running since /);
    expect(text).toContain("card-two");
    expect(text).not.toContain("card-one");
    expect(text).not.toMatch(/ended/);
  });

  // The timer is treated as dropped after this: the tests below never fire it again.
  async function drawnEnded(r) {
    r.write(run(RUN1, "card-one"));
    await r.start();
    r.write(ended(RUN1, "card-one"));
    await r.timers[0]();
    expect(r.shown()[0]).toMatch(/^Autopilot ended /);
  }
  function expectRun2(r) {
    const text = r.shown().join("\n");
    expect(text).toContain("card-two");
    expect(text).not.toContain("card-one");
    expect(r.shown()[0]).toMatch(/^Autopilot running since /);
  }
  const hook = (r, event) => {
    if (!r.handlers[event]) throw new Error(`register.tsx registered no ${event} hook`);
  };

  it("P2: the Bash tool.call hook refreshes after the tool ran and returns next's result unchanged", async () => {
    const r = rig();
    await drawnEnded(r);
    hook(r, "tool.call");
    const next = vi.fn(async () => {
      r.write(run(RUN2, "card-two")); // the Bash call itself starts run 2
      return SENT;
    });
    const out = await r.fire("tool.call", next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toBe(SENT);
    expectRun2(r);
  });

  it("P3: prompt.submit refreshes and returns next(e)'s value", async () => {
    const r = rig();
    await drawnEnded(r);
    hook(r, "prompt.submit");
    r.write(run(RUN2, "card-two"));
    const next = vi.fn(passthrough);
    const out = await r.fire("prompt.submit", next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toBe(SENT);
    expectRun2(r);
  });

  it("P4: turn.complete refreshes and returns next(e)'s value", async () => {
    const r = rig();
    await drawnEnded(r);
    hook(r, "turn.complete");
    r.write(run(RUN2, "card-two"));
    const next = vi.fn(passthrough);
    const out = await r.fire("turn.complete", next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toBe(SENT);
    expectRun2(r);
  });

  it("P5: after a reload (register again, session.start not fired) the new prompt.submit hook refreshes", async () => {
    const first = rig();
    await drawnEnded(first);
    // A real reload is a fresh module: module-level variables of the first load must not carry over.
    vi.resetModules();
    const { register: reloaded } = await import("../hooks/register.tsx");
    const second = rig({ state: first.state, dir: first.dir, registerFn: reloaded });
    hook(second, "prompt.submit");
    second.write(run(RUN2, "card-two"));
    const out = await second.fire("prompt.submit", passthrough);
    expect(out).toBe(SENT);
    expectRun2(second);
  });

  it("P8: the tool.call hook is registered with exactly the Bash matcher", () => {
    const r = rig();
    hook(r, "tool.call");
    expect(r.matchers["tool.call"]).toEqual([{ tool: "Bash" }]);
  });

  it("P6: a missing or unparsable autopilot file never throws from a hook and next's result still returns", async () => {
    for (const content of [null, "not json"]) {
      for (const event of ["prompt.submit", "turn.complete", "tool.call"]) {
        const r = rig();
        if (content !== null) r.write(content);
        await r.start();
        hook(r, event);
        const before = JSON.stringify(r.shown());
        const next = vi.fn(passthrough);
        const out = await r.fire(event, next);
        expect(next, `${event} ${content}`).toHaveBeenCalledTimes(1);
        expect(out, `${event} ${content}`).toBe(SENT);
        expect(JSON.stringify(r.shown())).toBe(before);
      }
    }
  });

  it("P7: a new run seen through the tool.call hook opens the pane unless autoOpenPane is false", async () => {
    for (const [config, expected] of [[undefined, 1], [{ autopilot: { autoOpenPane: false } }, 0]]) {
      const r = rig({ config });
      await drawnEnded(r);
      hook(r, "tool.call");
      const base = r.opens.length;
      await r.fire("tool.call", async () => {
        r.write(run(RUN2, "card-two"));
        return SENT;
      });
      expect(r.opens.length - base).toBe(expected);
      if (expected) expect(r.opens[base].id).toBe("doug-autopilot");
    }
  });
  it("M14: a running queen card's pane line shows its seats from the journal file", async () => {
    const r = rig();
    const wf = join(r.dir, "claude-home", "wf_pane");
    mkdirSync(wf, { recursive: true });
    const jl = (o) => JSON.stringify(o);
    writeFileSync(
      join(wf, "journal.jsonl"),
      [
        jl({ type: "launched" }),
        jl({ type: "started", key: "k1", agentId: "A1", label: "setup:q1:1", phase: "Setup" }),
        jl({ type: "result", key: "k1", agentId: "A1", result: { seat: "setup" } }),
        jl({ type: "started", key: "k2", agentId: "A2", label: "tester:q1:1", phase: "Tester" }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(wf, "agent-A1.meta.json"), "{}");
    writeFileSync(join(wf, "agent-A2.meta.json"), "{}");
    const t = (Date.now() - 270000) / 1000;
    utimesSync(join(wf, "agent-A2.meta.json"), t, t);
    r.write(run(RUN1, "q1", { cards: [{ id: "q1", state: "running", runId: "wf_pane", kind: "hand", journals: [join(wf, "journal.jsonl")] }] }));
    await r.start();
    expect(r.shown()).toContain("  ▶ q1 setup ✓ tester ▶ 4m");
  });

  it("a journal that cannot be read leaves the card line at 'started', never throws", async () => {
    const r = rig();
    r.write(run(RUN1, "q1", { cards: [{ id: "q1", state: "running", runId: "wf_x", kind: "hand", journals: [join(r.dir, "nope", "journal.jsonl")] }] }));
    await r.start();
    expect(r.shown()).toContain("  ▶ q1 started");
  });
});

// Card autopilot-pane-redesign: clear an ended run, seat history for main-run and queen cards, the journal path a
// launched queen records. Test names carry the mutation ids of the brief.
describe("card autopilot-pane-redesign: clear", () => {
  const fresh = () => {
    const dir = project();
    started(dir);
    return dir;
  };

  it("M1: clear on an ended run removes the file, prints 'autopilot: cleared', exit 0", () => {
    const dir = fresh();
    ap(dir, "end");
    const r = ap(dir, "clear");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("autopilot: cleared");
    expect(existsSync(statePath(dir))).toBe(false);
  });

  it("M2: clear on a fresh running run keeps the file byte for byte and says so", () => {
    const dir = fresh();
    ap(dir, "card", "alpha");
    const before = readFileSync(statePath(dir), "utf8");
    const r = ap(dir, "clear");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("autopilot: kept the running run");
    expect(readFileSync(statePath(dir), "utf8")).toBe(before);
  });

  it("M3: clear on a running file updated 2 h + 1 min ago removes it", () => {
    const dir = fresh();
    const s = state(dir);
    s.updatedAt = new Date(Date.now() - (2 * HOUR + MIN)).toISOString();
    write(dir, s);
    const r = ap(dir, "clear");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("autopilot: cleared");
    expect(existsSync(statePath(dir))).toBe(false);
  });

  it("a running file updated 2 h - 1 min ago is kept", () => {
    const dir = fresh();
    const s = state(dir);
    s.updatedAt = new Date(Date.now() - (2 * HOUR - MIN)).toISOString();
    write(dir, s);
    expect(ap(dir, "clear").stdout.trim()).toBe("autopilot: kept the running run");
    expect(existsSync(statePath(dir))).toBe(true);
  });

  it("no file: 'autopilot: nothing to clear', exit 0", () => {
    const dir = project();
    const r = ap(dir, "clear");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("autopilot: nothing to clear");
  });

  it("an unparseable file is preserved, exit 0, no stack", () => {
    const dir = project();
    writeFileSync(statePath(dir), "{ not json");
    const r = ap(dir, "clear");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/\bat .*\.mjs:\d+/);
    expect(readFileSync(statePath(dir), "utf8")).toBe("{ not json");
  });

  it("clear leaves no tmp file and a later start works", () => {
    const dir = fresh();
    ap(dir, "end");
    ap(dir, "clear");
    expect(readdirSync(join(dir, ".doug/.state"))).toEqual([]);
    expect(started(dir).status).toBe(0);
  });

  it("core.clearable: ended and inactive true, running and null false (M1-M3)", () => {
    const base = { version: 1, startedAt: iso(-HOUR), cards: [] };
    expect(core.clearable(null, NOW)).toBe(false);
    expect(core.clearable({ ...base, status: "ended", updatedAt: iso(-MIN) }, NOW)).toBe(true);
    expect(core.clearable({ ...base, status: "running", updatedAt: iso(-(2 * HOUR + MIN)) }, NOW)).toBe(true);
    expect(core.clearable({ ...base, status: "running", updatedAt: iso(-MIN) }, NOW)).toBe(false);
  });
});

describe("card autopilot-pane-redesign: main-run seat history", () => {
  it("M13: card, step research, step tester gives two seats and the line 'research ✓ tester ▶ 0m'", () => {
    const dir = project();
    started(dir);
    ap(dir, "card", "alpha");
    ap(dir, "step", "alpha", "research");
    ap(dir, "step", "alpha", "tester");
    const c = state(dir).cards[0];
    expect(c.seats.map((x) => x.step)).toEqual(["research", "tester"]);
    expect(c.seats.every((x) => !Number.isNaN(Date.parse(x.startedAt)))).toBe(true);
    expect(c.step).toBe("tester");
    const now = new Date(Date.parse(c.seats[1].startedAt) + 5000);
    const lines = autopilotLines(autopilotView(state(dir), now));
    expect(lines).toContain("  ▶ alpha research ✓ tester ▶ 0m");
  });

  it("the running seat shows whole minutes elapsed, floored", () => {
    const st = runState({ cards: [{ id: "m", state: "running", seats: [{ step: "research", startedAt: iso(-20 * MIN) }, { step: "coder", startedAt: iso(-(4 * MIN + 30000)) }] }] });
    expect(autopilotLines(autopilotView(st, NOW))).toContain("  ▶ m research ✓ coder ▶ 4m");
  });
});

describe("card autopilot-pane-redesign: launched records the journal", () => {
  const launchedIn = (dir, home, sid, run, id = "alpha") => {
    const argsFile = join(dir, "args.json");
    writeFileSync(argsFile, JSON.stringify({ card: { id } }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home };
    if (sid === undefined) delete env.CLAUDE_CODE_SESSION_ID;
    else env.CLAUDE_CODE_SESSION_ID = sid;
    return spawnSync(process.execPath, [script, "launched", id, "--run", run, "--kind", "hand", "--worktree", join(dir, "wt"), "--args-file", argsFile, "--dir", dir], { encoding: "utf8", env });
  };
  const slugOf = (d) => d.replace(/[^A-Za-z0-9]/g, "-");

  it("M12: launched records the journal path, and resumed appends the new run's", () => {
    const dir = project();
    started(dir);
    const home = tmp();
    expect(launchedIn(dir, home, "sess1", "wf_one").status).toBe(0);
    const j1 = join(home, ".claude", "projects", slugOf(dir), "sess1", "subagents", "workflows", "wf_one", "journal.jsonl");
    expect(state(dir).cards[0].journals).toEqual([j1]);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home, CLAUDE_CODE_SESSION_ID: "sess1" };
    const r = spawnSync(process.execPath, [script, "resumed", "alpha", "--run", "wf_two", "--dir", dir], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    const j2 = join(home, ".claude", "projects", slugOf(dir), "sess1", "subagents", "workflows", "wf_two", "journal.jsonl");
    expect(state(dir).cards[0].journals).toEqual([j1, j2]);
  });

  it("without CLAUDE_CODE_SESSION_ID launched records no journals and still succeeds", () => {
    const dir = project();
    started(dir);
    const r = launchedIn(dir, tmp(), undefined, "wf_one");
    expect(r.status).toBe(0);
    expect(state(dir).cards[0].journals ?? []).toEqual([]);
    expect(state(dir).cards[0].runId).toBe("wf_one");
  });
});

describe("card autopilot-pane-redesign: queen seat history from the journal", () => {
  const J = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  const st = (key, agentId, label, phase) => ({ type: "started", key, agentId, label, phase });
  const res = (key, agentId) => ({ type: "result", key, agentId, result: { seat: "x" } });
  const fail = (key, agentId) => ({ type: "failed", key, agentId });
  const queenState = (extra = {}) =>
    runState({ cards: [{ id: "q1", title: "Queen card", size: "M", class: "code", state: "running", runId: "wf_1", kind: "hand", journals: ["/j/wf_1/journal.jsonl"], ...extra }], filed: [] });
  const line = (journals, startedMs = {}, extra) => {
    const run = { q1: { journals: Array.isArray(journals) ? journals : [journals], startedMs } };
    const lines = autopilotLines(autopilotView(queenState(extra), NOW, run));
    return lines.find((l) => /^ {2}\S q1\b/.test(l));
  };
  const T = NOW.getTime();

  it("M8, M10: setup and lead done, tester running 4m30s shows 'setup ✓ lead ✓ tester ▶ 4m'", () => {
    const j = J({ type: "launched" }, st("k1", "A1", "setup:q1:1", "Setup"), res("k1", "A1"), st("k2", "A2", "lead:q1:1", "Lead"), res("k2", "A2"), st("k3", "A3", "tester:q1:1", "Tester"));
    expect(line(j, { A3: T - (4 * MIN + 30000) })).toBe("  ▶ q1 setup ✓ lead ✓ tester ▶ 4m");
  });

  it("M10: under a minute reads 0m; an unknown start time shows the seat with no elapsed text", () => {
    const j = J(st("k1", "A1", "setup:q1:1", "Setup"));
    expect(line(j, { A1: T - 20000 })).toBe("  ▶ q1 setup ▶ 0m");
    expect(line(j, {})).toBe("  ▶ q1 setup ▶");
  });

  it("M9: a failed seat that was retried with the same key shows once, done", () => {
    const j = J(st("k1", "A1", "lead:q1:1", "Lead"), fail("k1", "A1"), st("k1", "A2", "lead:q1:1", "Lead"), res("k1", "A2"), st("k2", "A3", "tester:q1:1", "Tester"));
    const l = line(j, { A3: T - 10000 });
    expect(l).toBe("  ▶ q1 lead ✓ tester ▶ 0m");
    expect(l).not.toContain("✗");
  });

  it("a failed seat with no retry shows ✗", () => {
    const j = J(st("k1", "A1", "setup:q1:1", "Setup"), res("k1", "A1"), st("k2", "A2", "coder:q1:1", "Coder"), fail("k2", "A2"));
    expect(line(j)).toBe("  ▶ q1 setup ✓ coder ✗");
  });

  it("a repeated round is its own seat, in order (real wf_dc6f309e shape)", () => {
    const j = J(
      st("k1", "A1", "setup:q1:1", "Setup"), res("k1", "A1"),
      st("k2", "A2", "lead:q1:1", "Lead"), fail("k2", "A2"), st("k2", "A3", "lead:q1:1", "Lead"), res("k2", "A3"),
      st("k3", "A4", "tester:q1:1", "Tester"), res("k3", "A4"),
      st("k4", "A5", "coder:q1:1", "Coder"), res("k4", "A5"),
      st("k5", "A6", "reviewer:q1:1", "Reviewer"), res("k5", "A6"),
      st("k6", "A7", "coder:q1:2", "Coder"), res("k6", "A7"),
      st("k7", "A8", "reviewer:q1:2", "Reviewer"),
    );
    expect(line(j, { A8: T - 2 * MIN })).toBe("  ▶ q1 setup ✓ lead ✓ tester ✓ coder ✓ reviewer ✓ coder ✓ reviewer ▶ 2m");
  });

  it("M11: parallel flow agents of one phase are one seat; the seat name is the phase, not the label", () => {
    const j = J(
      st("k1", "A1", "implement:a", "Implement"), st("k2", "A2", "worker:b:1", "Implement"), res("k1", "A1"), res("k2", "A2"),
      st("k3", "A3", "verify:a", "Verify"),
    );
    expect(line(j, { A3: T - 2 * MIN })).toBe("  ▶ q1 implement ✓ verify ▶ 2m");
  });

  it("M11: a parallel seat with one agent still running is running, elapsed from its earliest running agent", () => {
    const j = J(st("k1", "A1", "implement:a", "Implement"), res("k1", "A1"), st("k2", "A2", "implement:b", "Implement"), st("k3", "A3", "implement:c", "Implement"));
    expect(line(j, { A1: T - 20 * MIN, A2: T - (3 * MIN + 30000), A3: T - 90000 })).toBe("  ▶ q1 implement ▶ 3m");
  });

  it("a resumed run merges the old and new journals by key: a replayed seat shows once", () => {
    const old = J(st("k1", "A1", "setup:q1:1", "Setup"), res("k1", "A1"), st("k2", "A2", "lead:q1:1", "Lead"), res("k2", "A2"));
    const next = J(st("k1", "B1", "setup:q1:1", "Setup"), res("k1", "B1"), st("k3", "B2", "tester:q1:1", "Tester"));
    expect(line([old, next], { B2: T - MIN })).toBe("  ▶ q1 setup ✓ lead ✓ tester ▶ 1m");
  });

  it("garbage lines and an empty journal never throw; an empty journal reads 'started'", () => {
    expect(() => line("{ nope\n\nnull\n42\n")).not.toThrow();
    expect(line("")).toBe("  ▶ q1 started");
    expect(line("{ nope\n")).toBe("  ▶ q1 started");
  });

  it("a queen card with no journal data shows 'started'", () => {
    const lines = autopilotLines(autopilotView(queenState(), NOW));
    expect(lines).toContain("  ▶ q1 started");
  });

  it("the seat name comes from the phase, lowercased, not the label", () => {
    const j = J(st("k1", "A1", "x:q1:1", "Review"), res("k1", "A1"), st("k2", "A2", "adversary:q1", "Adversary"));
    expect(line(j, { A2: T - MIN })).toBe("  ▶ q1 review ✓ adversary ▶ 1m");
  });
});

describe("card autopilot-pane-redesign: fix pass pins", () => {
  const jl = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

  it("G1: readRuns reads a running queen card's journal and agent meta mtimes, and the view shows its seats", async () => {
    const { readRuns } = await import("../lib/autopilot-view.mjs");
    const d = tmp();
    const wf = join(d, "wf_r");
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      join(wf, "journal.jsonl"),
      jl(
        { type: "started", key: "k1", agentId: "A1", label: "setup:q1:1", phase: "Setup" },
        { type: "result", key: "k1", agentId: "A1", result: {} },
        { type: "started", key: "k2", agentId: "A2", label: "tester:q1:1", phase: "Tester" },
      ),
    );
    writeFileSync(join(wf, "agent-A2.meta.json"), "{}");
    const t = (NOW.getTime() - 4 * MIN) / 1000;
    utimesSync(join(wf, "agent-A2.meta.json"), t, t);
    const s = runState({
      cards: [
        { id: "q1", title: "Q", size: "M", class: "code", state: "running", runId: "wf_r", kind: "hand", journals: [join(wf, "journal.jsonl")] },
        { id: "q2", title: "Q2", size: "M", class: "code", state: "queued", journals: [join(wf, "journal.jsonl")] },
      ],
      filed: [],
    });
    const runs = readRuns(s);
    expect(Object.keys(runs)).toEqual(["q1"]);
    expect(runs.q1.journals).toHaveLength(1);
    expect(typeof runs.q1.startedMs.A2).toBe("number");
    const l = autopilotLines(autopilotView(s, NOW, runs)).find((x) => /^ {2}\S q1\b/.test(x));
    expect(l).toBe("  ▶ q1 setup ✓ tester ▶ 4m");
  });

  it("G2: a replayed started line for a finished seat does not reopen it", () => {
    const seats = core.journalSeats([
      jl(
        { type: "started", key: "k1", agentId: "A1", label: "setup:q1:1", phase: "Setup" },
        { type: "result", key: "k1", agentId: "A1", result: {} },
        { type: "started", key: "k1", agentId: "A9", label: "setup:q1:1", phase: "Setup" },
      ),
    ]);
    expect(seats).toEqual([{ name: "setup", status: "done", elapsed: "" }]);
  });

  it("G3: re-running a card after steps clears its seat history", () => {
    const dir = project();
    expect(started(dir).status).toBe(0);
    expect(ap(dir, "card", "alpha").status).toBe(0);
    expect(ap(dir, "step", "alpha", "tester").status).toBe(0);
    expect(ap(dir, "step", "alpha", "coder").status).toBe(0);
    expect(state(dir).cards[0].seats).toHaveLength(2);
    expect(ap(dir, "card", "alpha").status).toBe(0);
    const c = state(dir).cards[0];
    expect(c.seats).toBeUndefined();
    expect(c.step).toBeUndefined();
  });
});

// Card queen-args-research: queen-args takes --research on|off and the project's current branch as base.
describe("card queen-args-research: queen-args research flag and base branch", () => {
  const card = (id, track) => ({ id, column: "ready", track, component: "flow", title: id, size: "S", class: "code", goal: `Change plugins/doug-flow/lib/${id}.mjs.` });
  function proj(setup) {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, ".doug/plans"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const cards = [card("h1", "hand"), card("f1", "flow")];
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }], components: ["flow"], cards }));
    writeFileSync(join(dir, ".doug/plans/f1.json"), JSON.stringify({ version: 1, goal: "G", status: "approved", card: "f1", tasks: [{ id: "t1", title: "T", spec: "s", files: ["a.txt"], acceptance: [{ text: "x", command: "true" }] }] }));
    if (setup) setup(dir);
    ap(dir, "start", "--cards", "h1,f1", "--usd-cap", "10", "--wall-cap", "100");
    return dir;
  }
  const git = (dir, ...a) => {
    const env = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
    const r = spawnSync("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=a", ...a], { encoding: "utf8", env });
    expect(r.status, r.stderr).toBe(0);
  };
  const argsOf = (dir, id = "h1") => JSON.parse(readFileSync(join(dir, `.doug/.state/reports/${id}/queen-args.json`), "utf8"));
  const hand = (dir, ...rest) => ap(dir, "queen-args", "h1", "--kind", "hand", ...rest);

  it("--research on writes options.research true; absent and off write false", () => {
    const dir = proj();
    expect(hand(dir, "--research", "on").status).toBe(0);
    expect(argsOf(dir).options.research).toBe(true);
    expect(hand(dir).status).toBe(0);
    expect(argsOf(dir).options.research).toBe(false);
    expect(hand(dir, "--research", "off").status).toBe(0);
    expect(argsOf(dir).options.research).toBe(false);
  });

  it("a --research value other than on|off (or none) exits 2 and writes no queen-args.json", () => {
    for (const rest of [["--research", "yes"], ["--research", "true"], ["--research"]]) {
      const dir = proj();
      const r = hand(dir, ...rest);
      expect(r.status, rest.join(" ")).toBe(2);
      expect(existsSync(join(dir, ".doug/.state/reports/h1/queen-args.json")), rest.join(" ")).toBe(false);
    }
  });

  it("--research with --kind flow exits 2 and writes nothing", () => {
    const dir = proj();
    const r = ap(dir, "queen-args", "f1", "--kind", "flow", "--research", "on");
    expect(r.status).toBe(2);
    expect(existsSync(join(dir, ".doug/.state/reports/f1/queen-args.json"))).toBe(false);
  });

  it("base is the --dir project's current branch, not the process cwd's", () => {
    const dir = proj((d) => git(d, "init", "-q", "-b", "trunk"));
    expect(hand(dir).status).toBe(0);
    expect(argsOf(dir).options.base).toBe("trunk");
  });

  it("base falls back to main on a detached HEAD and outside a git repo", () => {
    const detached = proj((d) => {
      git(d, "init", "-q", "-b", "trunk");
      git(d, "commit", "-q", "--allow-empty", "-m", "x");
      git(d, "checkout", "-q", "--detach");
    });
    expect(hand(detached).status).toBe(0);
    expect(argsOf(detached).options.base).toBe("main");
    const plain = proj();
    expect(hand(plain).status).toBe(0);
    expect(argsOf(plain).options.base).toBe("main");
  });

  it("the usage header documents [--research on|off]", () => {
    const line = readFileSync(script, "utf8").split("\n").find((l) => l.includes("autopilot.mjs queen-args <id>"));
    expect(line).toContain("[--research on|off]");
  });
});

// Card autopilot-no-stuck-in-flow: a gate timeout under load is rerun alone, and end refuses while a card is In flow.
describe("card autopilot-no-stuck-in-flow", () => {
  const CARDS = ["h1", "h2", "h3"].map((id) => ({ id, column: "ready", track: "hand", component: "flow", title: id, size: "S", class: "code", goal: "Change plugins/doug-flow/lib/a.mjs." }));
  const ALONE = "Rerun alone: no other queen is in flight now.";
  const boardPath = (dir) => join(dir, ".doug/.state/../board.json");
  function setup() {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(boardPath(dir), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }, { id: "flow", title: "In flow" }], components: ["flow", "cli"], cards: CARDS }));
    ap(dir, "start", "--cards", "h1,h2,h3", "--usd-cap", "10", "--wall-cap", "100");
    return dir;
  }
  const inFlow = (dir, ...ids) => {
    const b = JSON.parse(readFileSync(boardPath(dir), "utf8"));
    for (const c of b.cards) if (ids.includes(c.id)) c.column = "flow";
    writeFileSync(boardPath(dir), JSON.stringify(b));
  };
  const launch = (dir, id, run) => {
    const argsFile = join(dir, `${id}-args.json`);
    writeFileSync(argsFile, JSON.stringify({ card: { id }, options: { research: false } }));
    return ap(dir, "launched", id, "--run", run, "--kind", "hand", "--worktree", join(dir, `wt-${id}`), "--args-file", argsFile);
  };
  const result = (dir, name, value) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(value));
    return f;
  };
  const timeoutStop = (over = {}) => ({
    outcome: "stopped",
    reason: "gate-timeout",
    stoppedAt: "gate",
    detail: "gate: typecheck 0; test:unit 1 (exit timeout at 301.0 s)",
    history: [
      { seat: "reviewer", round: 1, result: "ok" },
      { seat: "gate", round: 1, result: "stopped", note: "gate-timeout" },
    ],
    ...over,
  });
  const report = (dir, run, value = timeoutStop(), name = `r-${run}.json`) => ap(dir, "report", "--run", run, "--file", result(dir, name, value));
  const card = (dir, id) => state(dir).cards.find((c) => c.id === id);
  const queenArgs = (dir, id) => JSON.parse(readFileSync(join(dir, ".doug/.state/reports", id, "queen-args.json"), "utf8"));
  const briefFor = (dir, id, seat, seatRuns) => {
    const answers = queenArgs(dir, id).options.answers;
    const st = { ...initialState({ id, goal: "g" }, { answers }), pending: seat, seatRuns };
    return currentAction(st).brief;
  };

  it("N1 a gate timeout with another queen in flight prints rerun alone and marks the card stopped", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    const r = report(dir, "wf_h1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^autopilot: h1 rerun alone gate-timeout/m);
    expect(card(dir, "h1").state).toBe("stopped");
    expect(card(dir, "h1").reason).toBe("gate-timeout: rerun alone pending");
  });

  it("N2 a gate timeout with no other queen in flight asks (unsure means a normal stop)", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    ap(dir, "land", "h2", "--commit", "abc1234");
    const r = report(dir, "wf_h1");
    expect(r.stdout).toMatch(/^autopilot: h1 ask gate-timeout/m);
    expect(r.stdout).not.toContain("rerun alone");
    expect(card(dir, "h1").state).toBe("running");
    // a queued card is not in flight either
    const lone = setup();
    launch(lone, "h1", "wf_h1");
    expect(report(lone, "wf_h1").stdout).toMatch(/^autopilot: h1 ask gate-timeout/m);
  });

  it("N3 a seat-blocked gate stop stays ask even with another queen in flight", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    const r = report(dir, "wf_h1", timeoutStop({ reason: "seat-blocked", history: [{ seat: "gate", round: 1, result: "stopped", note: "seat-blocked" }] }));
    expect(r.stdout).toMatch(/^autopilot: h1 ask seat-blocked/m);
  });

  it("N4 a second gate timeout asks: the rerun alone is the card's one resume", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    expect(report(dir, "wf_h1").stdout).toContain("rerun alone");
    ap(dir, "land", "h2", "--commit", "abc1234");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(0);
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    launch(dir, "h3", "wf_h3");
    const again = report(dir, "wf_h1b");
    expect(again.stdout).toMatch(/^autopilot: h1 ask gate-timeout/m);
    expect(again.stdout).not.toContain("rerun alone");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(1);
  });

  it("N4b rerun-alone refuses a card already resumed once, with no other queen in flight, and writes nothing", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    expect(report(dir, "wf_h1").stdout).toContain("rerun alone");
    ap(dir, "land", "h2", "--commit", "abc1234");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(0);
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    expect(report(dir, "wf_h1b").stdout).toMatch(/^autopilot: h1 ask gate-timeout/m);
    const again = ap(dir, "rerun-alone", "h1");
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already resumed once");
    expect(queenArgs(dir, "h1").options.answers).toHaveLength(1);
  });

  it("N5 rerun-alone refuses while another queen is in flight, naming it, and writes nothing; after it lands it succeeds", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    report(dir, "wf_h1");
    const refused = ap(dir, "rerun-alone", "h1");
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("h2");
    expect(queenArgs(dir, "h1").options.answers).toBeUndefined();
    ap(dir, "land", "h2", "--commit", "abc1234");
    const r = ap(dir, "rerun-alone", "h1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("autopilot: h1 rerun alone recorded for gate");
  });

  it("N6 rerun-alone records a gate answer that reaches the gate brief, and report then says resume with the answer", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    const rep = timeoutStop();
    report(dir, "wf_h1", rep);
    ap(dir, "land", "h2", "--commit", "abc1234");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(0);
    expect(queenArgs(dir, "h1").options.answers).toEqual([{ seat: "gate", question: rep.detail, answer: ALONE, round: 1, run: "wf_h1" }]);
    expect(briefFor(dir, "h1", "gate", {}).answers).toEqual([{ question: rep.detail, answer: ALONE }]);
    expect(briefFor(dir, "h1", "tester", {}).answers).toEqual([]);
    expect(report(dir, "wf_h1", rep).stdout).toMatch(/^autopilot: h1 resume with the answer/m);
  });

  it("N7 rerun-alone refuses a missing report, a non-stop, an agent-null stop and a stop with no seat; an unknown card is exit 1", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(1);
    report(dir, "wf_h1", { outcome: "done", history: [] });
    expect(ap(dir, "rerun-alone", "h1").status).toBe(1);
    report(dir, "wf_h1", timeoutStop({ reason: "agent-null" }), "n.json");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(1);
    report(dir, "wf_h1", timeoutStop({ stoppedAt: null }), "m.json");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(1);
    expect(queenArgs(dir, "h1").options.answers).toBeUndefined();
    expect(ap(dir, "rerun-alone", "ghost").status).toBe(1);
  });

  it("N8 waiting cards rerun one at a time: resumed marks the card in flight again", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    launch(dir, "h3", "wf_h3");
    expect(report(dir, "wf_h1").stdout).toContain("h1 rerun alone");
    expect(report(dir, "wf_h2", timeoutStop(), "r2.json").stdout).toContain("h2 rerun alone");
    ap(dir, "land", "h3", "--commit", "abc1234");
    expect(ap(dir, "rerun-alone", "h1").status).toBe(0);
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    expect(card(dir, "h1").state).toBe("running");
    const second = ap(dir, "rerun-alone", "h2");
    expect(second.status).toBe(1);
    expect(second.stdout + second.stderr).toContain("h1");
    ap(dir, "land", "h1", "--commit", "def5678");
    expect(ap(dir, "rerun-alone", "h2").status).toBe(0);
  });

  it("N9 end refuses with an In flow card that was never resumed, naming it, and leaves the run running", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    ap(dir, "land", "h2", "--commit", "abc1234");
    inFlow(dir, "h1");
    const r = ap(dir, "end");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("h1");
    expect(r.stdout + r.stderr).not.toContain("h2");
    expect(state(dir).status).toBe("running");
    expect(state(dir).endedAt ?? null).toBeNull();
  });

  it("N10 end names every In flow card that is neither resumed nor answered", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    inFlow(dir, "h1", "h2");
    const r = ap(dir, "end");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("h1");
    expect(r.stdout + r.stderr).toContain("h2");
  });

  it("N11 end allows an In flow card that was resumed once", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    inFlow(dir, "h1");
    expect(ap(dir, "resumed", "h1", "--run", "wf_h1b").status).toBe(0);
    expect(ap(dir, "end").status).toBe(0);
    expect(state(dir).status).toBe("ended");
  });

  it("N12 end allows an In flow card the user chose to leave, recorded by leave; a pending rerun-alone answer alone does not", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    launch(dir, "h2", "wf_h2");
    report(dir, "wf_h1");
    ap(dir, "land", "h2", "--commit", "abc1234");
    ap(dir, "rerun-alone", "h1");
    inFlow(dir, "h1");
    expect(ap(dir, "end").status).toBe(1);
    expect(state(dir).status).toBe("running");
    const left = ap(dir, "leave", "h1", "--reason", "Leave In flow");
    expect(left.status, left.stderr).toBe(0);
    expect(card(dir, "h1").left).toBe("Leave In flow");
    expect(ap(dir, "end").status).toBe(0);
    expect(state(dir).status).toBe("ended");
  });

  it("N13 end allows an In flow card with a user answer for its run", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    report(dir, "wf_h1", { outcome: "stopped", reason: "design-decision", stoppedAt: "tester", detail: "Q?", history: [{ seat: "tester", round: 1, result: "stopped", note: "design-decision" }] });
    inFlow(dir, "h1");
    expect(ap(dir, "end").status).toBe(1);
    expect(ap(dir, "answer", "h1", "--answer", "A.").status).toBe(0);
    expect(ap(dir, "end").status).toBe(0);
  });

  it("N14 end ignores cards not In flow, and refuses when the board cannot be read", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    const bad = setup();
    writeFileSync(boardPath(bad), "{ not json");
    const r = ap(bad, "end");
    expect(r.status).toBe(1);
    expect(state(bad).status).toBe("running");
    expect(ap(dir, "end").status).toBe(0);
  });

  it("N15 leave with a blank or missing reason is exit 2 and an unknown card is exit 1", () => {
    const dir = setup();
    launch(dir, "h1", "wf_h1");
    expect(ap(dir, "leave", "h1", "--reason", "  ").status).toBe(2);
    expect(ap(dir, "leave", "h1").status).toBe(2);
    expect(card(dir, "h1").left).toBeUndefined();
    expect(ap(dir, "leave", "ghost", "--reason", "x").status).toBe(1);
  });

  it("N16 the unknown-subcommand message and the usage header name rerun-alone and leave", () => {
    const dir = setup();
    const r = ap(dir, "bogus-subcommand");
    expect(r.stderr + r.stdout).toContain("rerun-alone");
    expect(r.stderr + r.stdout).toContain("leave");
    const head = readFileSync(script, "utf8").split("\n").slice(0, 40).join("\n");
    expect(head).toContain("autopilot.mjs rerun-alone <id>");
    expect(head).toContain("autopilot.mjs leave <id>");
  });
});

// Card queen-research-note-promotion: a queen report's inline research note is written to .doug/.state/research/<card id>.md
// by `autopilot.mjs report`, so board.mjs record promotes it to docs/research/<card id>.md.
describe("card queen-research-note-promotion", () => {
  const boardScript = join(here, "..", "scripts", "board.mjs");
  const NOTE = "Fact: X holds\nSource: https://example.test/a line 3\nunverified: Y\n";
  const CARD = { id: "h3", column: "ready", track: "hand", component: "cli", title: "H3", size: "S", class: "code", goal: "Change packages/doug-cli/src/c.ts." };
  function proj() {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }, { id: "done", title: "Done" }], components: ["cli"], cards: [CARD] }));
    ap(dir, "start", "--cards", "h3", "--usd-cap", "10", "--wall-cap", "100");
    const argsFile = join(dir, "h3-args.json");
    writeFileSync(argsFile, JSON.stringify({ card: "h3", seed: "s" }));
    ap(dir, "launched", "h3", "--run", "wf_h3", "--kind", "hand", "--worktree", join(dir, "wt-h3"), "--args-file", argsFile);
    return dir;
  }
  const rep = (dir, value) => {
    const f = join(dir, "res.json");
    writeFileSync(f, JSON.stringify(value));
    return ap(dir, "report", "--run", "wf_h3", "--file", f);
  };
  const record = (dir) => spawnSync(process.execPath, [boardScript, "record", "h3", "--hand", dir, "--summary", "x"], { encoding: "utf8", cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const noteFile = (dir) => join(dir, ".doug/.state/research/h3.md");
  const docFile = (dir) => join(dir, "docs/research/h3.md");
  const flat = (extra) => ({ card: { id: "h3" }, outcome: "done", history: [], ...extra });

  it("A22 a flat queen report with an inline note yields docs/research/h3.md at record", () => {
    const dir = proj();
    rep(dir, flat({ researchNote: NOTE }));
    expect(readFileSync(noteFile(dir), "utf8")).toBe(NOTE);
    const r = record(dir);
    expect(r.stdout).toContain("Promoted the research note for h3");
    expect(readFileSync(docFile(dir), "utf8")).toBe(NOTE);
    expect(existsSync(join(dir, ".doug/.state/research/wf_h3.md"))).toBe(false);
  });

  it("A23 an absent or null note writes no note and record promotes nothing", () => {
    for (const extra of [{}, { researchNote: null }]) {
      const dir = proj();
      rep(dir, flat(extra));
      expect(existsSync(noteFile(dir))).toBe(false);
      const r = record(dir);
      expect(r.stdout).not.toContain("Promoted the research note");
      expect(existsSync(docFile(dir))).toBe(false);
    }
  });

  it("A24 a note inside the task-output wrapper is persisted", () => {
    const dir = proj();
    rep(dir, { summary: "s", agentCount: 7, logs: [], result: flat({ researchNote: NOTE }) });
    expect(readFileSync(noteFile(dir), "utf8")).toBe(NOTE);
  });

  it("A25 a path-form note is copied from that file; a path equal to the destination is left alone", () => {
    const dir = proj();
    const src = join(dir, "elsewhere-note.md");
    writeFileSync(src, NOTE);
    rep(dir, flat({ researchNote: src }));
    expect(readFileSync(noteFile(dir), "utf8")).toBe(NOTE);
    const dir2 = proj();
    mkdirSync(join(dir2, ".doug/.state/research"), { recursive: true });
    writeFileSync(noteFile(dir2), NOTE);
    rep(dir2, flat({ researchNote: noteFile(dir2) }));
    expect(readFileSync(noteFile(dir2), "utf8")).toBe(NOTE);
  });
});
