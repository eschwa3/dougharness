import { describe, it, expect, vi, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAutopilot, autopilotView, autopilotLines, parseAutopilot } from "../lib/autopilot-view.mjs";
import * as core from "../lib/autopilot-core.mjs";

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

describe("autopilotLines titles (F1)", () => {
  it("prints the title between id and size/class, and no title text when a card has none (F1)", () => {
    const s = runState({
      cards: [
        { id: "titled", title: "A real title", size: "M", class: "code", state: "queued" },
        { id: "untitled", size: "S", class: "prose", state: "queued" },
        { id: "bare", state: "queued" },
      ],
    });
    const lines = autopilotLines(autopilotView(s, NOW));
    expect(lines).toContain("· titled A real title (M/code)");
    expect(lines).toContain("· untitled (S/prose)");
    expect(lines).toContain("· bare");
    expect(lines.join("\n")).not.toMatch(/undefined|null/);
  });

  it("a running titled card keeps its detail after the shape (F1)", () => {
    const lines = autopilotLines(autopilotView(runState(), NOW));
    expect(lines.find((l) => l.includes("cur "))).toMatch(/^▶ cur Current \(M\/code\) coder since \d\d:\d\d$/);
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
  it("running: header, one line per card with mark/id/size-class/detail, a caps line, a filed line", () => {
    const lines = autopilotLines(autopilotView(runState(), NOW));
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l) => typeof l === "string")).toBe(true);
    const text = lines.join("\n");
    expect(lines.find((l) => l.includes("done1"))).toMatch(/done1 Done one \(S\/docs\).*abc1234/);
    expect(lines.find((l) => l.includes("cur"))).toMatch(/cur Current \(M\/code\) coder since \d\d:\d\d/);
    expect(lines.find((l) => l.includes("bad"))).toMatch(/bad Bad \(L\/code\).*gate red twice/);
    expect(lines.find((l) => l.includes("next"))).toMatch(/next Next \(S\/prose\)/);
    expect(text).toContain("$12.50 / $96.78");
    expect(text).toContain("80 / 1054 min");
    expect(text).toContain("21% / 60%");
    // the four states carry distinct marks
    const marks = ["done1", "cur", "bad", "next"].map((id) => lines.find((l) => l.includes(id)).split(" ")[0]);
    expect(new Set(marks).size).toBe(4);
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
  function queenProject({ cards = CARDS, config, plans = {} } = {}) {
    const dir = tmp();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify({ version: 1, columns: [{ id: "ready", title: "Ready" }, { id: "done", title: "Done" }], components: ["flow", "cli", "gates"], cards }));
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
      fs: { read: async (p) => readFileSync(p, "utf8") },
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
});
