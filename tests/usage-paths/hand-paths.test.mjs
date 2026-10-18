// Usage-path scenarios P05 P11 M01 R01: the hand track. The queen workflow runs with canned seat hand-backs (no model),
// land-card runs on a real temp repo with a fake vendored verify.mjs, and the landing records run through board.mjs
// and memory.mjs. Scenario M01 is mined: queens stopped hand-back-invalid at the coder on an unrunnable mutation.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { initialState, currentAction, next } from "../../plugins/doug-flow/lib/card-loop.mjs";
import { openMemory, addLesson } from "../../plugins/doug-flow/lib/memory.mjs";
import { FLOW, SCRIPTS, boardCli, boardOf, git, memoryCli, tmp, writeJson } from "./fixture.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const BEGIN = "// ---- BEGIN card-loop.mjs (inlined by pnpm workflows:sync; do not edit) ----";
const QUEEN = join(FLOW, "workflows", "card-queen.js");
const CARD = { id: "c1", title: "A card", size: "M", class: "code", goal: "Do the thing exactly." };
const REPO = "/abs/repo";
const WT = "/abs/repo/.claude/worktrees/card-c1";
const MODELS = { roles: {}, tiers: {} };
const ARGS = { card: CARD, options: { research: true }, repoRoot: REPO, worktreePath: WT, models: MODELS };

// Run the queen workflow body the way the runtime does, against a fake agent that mirrors the contract's state.
function runQueen(respond) {
  const src = readFileSync(QUEEN, "utf8");
  const body = src.slice(src.indexOf(BEGIN));
  let mirror = initialState(CARD, { research: true });
  const seats = [];
  const agent = async () => {
    const action = currentAction(mirror);
    seats.push(action.seat);
    const hb = respond(action.seat);
    mirror = next(mirror, hb).state;
    return hb;
  };
  const run = new AsyncFunction("args", "agent", "phase", "log", body)(ARGS, agent, () => {}, () => {});
  return run.then((report) => ({ report, seats }));
}

// A valid hand-back per seat; `lead` and `coder` take overrides.
function hb(seat, { mutations = [], coder = {}, sha = "abc1234" } = {}) {
  const base = {
    setup: { worktree: WT, branch: "card/c1", install: null },
    research: { note: "/abs/note.md" },
    lead: { lessons: "L", facts: [{ text: "a fact", source: "docs/x.md:1" }], unverified: [], testFiles: ["a.test.mjs"], mutations },
    tester: { files: ["a.test.mjs"], tests_red_by_design: ["a.test.mjs"] },
    coder: { filesChanged: ["a.mjs"], commandsRun: [{ command: "pnpm exec vitest run a.test.mjs", exitCode: 0 }], testsEdited: [], ...coder },
    reviewer: { verdict: "pass", findings: [], commandsRun: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }], mutationResults: coder.mutationResults ?? [] },
    gate: { commands: [{ command: "node .doug/hooks/scripts/verify.mjs", exitCode: 0 }], gateLine: "typecheck ok; test:unit ok", tree: "a".repeat(40) },
    commit: { sha, branch: "card/c1", tree: "a".repeat(40) },
  }[seat];
  return { seat, ...base };
}

// A fake vendored verify.mjs: red when the tree holds red.flag.
const FAKE_VERIFY = `import fs from "node:fs";
import path from "node:path";
const red = fs.existsSync(path.join(process.cwd(), "red.flag"));
console.log(JSON.stringify({ ok: !red, credited: null, results: [{ command: "gate", ok: !red, status: red ? 1 : 0, durationMs: 1, outputTail: red ? "boom" : "" }], lockWaitMs: 5 }));
process.exit(red ? 1 : 0);
`;
const BRANCH = "card/land-x";
const WT_REL = ".claude/worktrees/card-land-x";

// main holds the fake verify; the card branch lives in a worktree and carries one commit. Main does not move.
function landProject({ commitMessage = "card work" } = {}) {
  const dir = tmp("doug-up-land-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# fx\n");
  writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n.claude/worktrees/\n");
  mkdirSync(join(dir, ".doug/hooks/scripts"), { recursive: true });
  writeFileSync(join(dir, ".doug/board.json"), "{}\n");
  writeFileSync(join(dir, ".doug/hooks/scripts/verify.mjs"), FAKE_VERIFY);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  mkdirSync(join(dir, ".claude/worktrees"), { recursive: true });
  git(dir, "worktree", "add", "-q", "-b", BRANCH, WT_REL, "main");
  const wt = join(dir, WT_REL);
  writeFileSync(join(wt, "card.txt"), "card\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", commitMessage);
  return { dir, wt, tip: git(wt, "rev-parse", "HEAD") };
}
const landCli = (dir, wt) =>
  spawnSync(process.execPath, [join(SCRIPTS, "plan.mjs"), "land-card", "x", "--branch", BRANCH, "--worktree", wt, "--base", "main"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });

describe("hand track usage paths", () => {
  it("P05 hand track: a canned queen run returns done and land-card fast-forwards main to the card commit", async () => {
    const { dir, wt, tip } = landProject();
    const { report, seats } = await runQueen((seat) => hb(seat, { sha: tip }));
    expect(seats).toEqual(["setup", "research", "lead", "tester", "coder", "reviewer", "gate", "commit"]);
    expect(report.outcome).toBe("done");
    expect(report.commit).toBe(tip);
    const mainBefore = git(dir, "rev-parse", "main");
    expect(mainBefore).not.toBe(tip);
    const r = landCli(dir, wt);
    expect(r.status, r.stderr).toBe(0);
    expect(git(dir, "rev-parse", "main")).toBe(tip);
    expect(git(dir, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(2); // a fast-forward, no merge commit
    expect(existsSync(join(dir, "card.txt"))).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it("P05 a red gate on the rebased tree refuses the landing and main stays put", () => {
    const { dir, wt } = landProject();
    writeFileSync(join(wt, "red.flag"), "1\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "make it red");
    const mainBefore = git(dir, "rev-parse", "main");
    const r = landCli(dir, wt);
    expect(r.status).not.toBe(0);
    expect(git(dir, "rev-parse", "main")).toBe(mainBefore);
  });

  it("P11 land refusal: land-card on a branch with a Co-Authored-By commit exits 1 and main is unchanged", () => {
    const { dir, wt } = landProject({ commitMessage: "card work\n\nCo-Authored-By: Someone <s@example.com>" });
    const mainBefore = git(dir, "rev-parse", "main");
    const r = landCli(dir, wt);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Co-Authored-By/);
    expect(git(dir, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(wt)).toBe(true);
  });

  it("M01 mined: a coder hand-back missing a listed mutation stops the queen hand-back-invalid at the coder, naming the id", async () => {
    const muts = [{ id: "M1", case: "c1", mutation: "delete the guard", test: "a.test.mjs" }];
    const { report, seats } = await runQueen((seat) => hb(seat, { mutations: muts, coder: { mutationResults: [] } }));
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("hand-back-invalid");
    expect(report.stoppedAt).toBe("coder");
    expect(report.detail).toContain("M1");
    expect(seats).not.toContain("reviewer");
  });

  it("M01 a coder hand-back that covers the listed mutation passes the check and the run reaches the reviewer", async () => {
    const muts = [{ id: "M1", case: "c1", mutation: "delete the guard", test: "a.test.mjs" }];
    const cover = [{ id: "M1", failed: true, test: "a.test.mjs" }];
    const { report, seats } = await runQueen((seat) => hb(seat, { mutations: muts, coder: { mutationResults: cover } }));
    expect(seats).toContain("reviewer");
    expect(report.reason).not.toBe("hand-back-invalid");
  });

  it("R01 landing records: board.mjs record --hand --commit writes a landed outcome, no commit writes not landed", () => {
    const dir = tmp("doug-up-record-");
    writeJson(join(dir, ".doug/board.json"), boardOf());
    const landed = boardCli(dir, "record", "flow-one", "--hand", "--summary", "Scenario landing.", "--commit", "abc1234");
    expect(landed.status, landed.stderr).toBe(0);
    const runs = readFileSync(join(dir, "docs/live-runs.md"), "utf8");
    expect(runs).toContain("flow-one");
    expect(runs).toContain("| Outcome | landed |");
    const open = boardCli(dir, "record", "flow-two", "--hand", "--summary", "Scenario without a commit.");
    expect(open.status, open.stderr).toBe(0);
    expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).toContain("| Outcome | not landed |");
  });

  it("R01 landing records (memory): brief-lessons on a seeded store prints memoryUsed with the recalled ids", () => {
    const dir = tmp("doug-up-memory-");
    writeJson(join(dir, ".doug/board.json"), {
      version: 1,
      updated: "2026-10-07",
      columns: [{ id: "ready", title: "Ready" }, { id: "flow", title: "In flow" }],
      components: [],
      tags: [],
      cards: [{ id: "c1", title: "Retry flaky uploads", goal: "make upload retries robust against flaky networks", column: "ready" }],
    });
    const m = openMemory(dir);
    const row = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "upload retries need exponential backoff on flaky networks" });
    m.close();
    const r = memoryCli(dir, "brief-lessons", "c1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`- [${row.id}]`);
    expect(r.stdout).toMatch(new RegExp(`^memoryUsed: ${row.id}$`, "m"));
    expect(existsSync(join(dir, ".doug/.state/reports/c1/lessons.json"))).toBe(true);
  });
});
