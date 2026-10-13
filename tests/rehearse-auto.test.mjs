// The rehearsal runner's autopilot (auto) and swarm scenarios, split from tests/rehearse.test.mjs (card
// split-git-hooks-rehearse-tests) to balance runtime: the implement-stage prompts, the auto scenario's registry,
// fixture, gate stage, build assertion and end-to-end pass with a fake claude, and the swarm scenario's splittable
// task and held-out land test. Never spawns the real claude binary; every temp directory is removed in afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { writeFileSync, readFileSync, chmodSync, rmSync, existsSync, readdirSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ESTIMATES, SCENARIOS, CLI, BOARD_MJS, TASKS_FILE, scenarioTotal, estimateLines, prepareFixture, runSessionStage, runActStage, SCENARIO_STAGES, rehearsalNote, cleanEnv, rehearsalGate, runScenario } from "../scripts/rehearse-lib.mjs";
import { newBoard, addCard, saveBoard } from "../plugins/doug-flow/lib/board.mjs";
import { here, cli, TEST_PREFIX, trackedTempDir, makeFakeClaude, cannedStream, run, git, spawnScript, inLib, fixDurationBug, tempDirs } from "./rehearse-fixtures.mjs";

// Every temp directory this file creates is removed here, whether the test that made it passed or not.
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// Per-test timeout ceiling for a hung child, not a performance pin (see rehearse-fixtures.mjs).
vi.setConfig({ testTimeout: 600_000 });

// Card report-save-wrapper, MP: the flow and swarm "implement" stage prompts must say the saved file is the
// `result` object of the Workflow tool's output, not just "the report it returned".
describe("card report-save-wrapper: the implement-stage prompts name the result object", () => {
  it("SCENARIO_STAGES.flow's implement prompt says to write the `result` object of the Workflow tool's output", () => {
    const implement = SCENARIO_STAGES.flow.find((s) => s.name === "implement");
    expect(implement.prompt()).toContain("the `result` object of the Workflow");
  });

  it("SCENARIO_STAGES.swarm's implement prompt says to write the `result` object of the Workflow tool's output", () => {
    const implement = SCENARIO_STAGES.swarm.find((s) => s.name === "implement");
    expect(implement.prompt()).toContain("the `result` object of the Workflow");
  });
});

// Card autopilot part D: the `auto` scenario runs a bare `/doug-next --auto` (unlimited, card autopilot-unlimited) over
// two Ready hand cards with no gate prompt between them, and leaves one Backlog card untouched. Everything here uses fixtures and the fake claude; nothing spawns the real binary.
describe("card autopilot: the auto scenario's registry entries", () => {
  it("SCENARIOS includes auto, and ESTIMATES.auto has gate 0.5 and build 8.0 with a source saying two hand builds, unmeasured", () => {
    expect(SCENARIOS).toContain("auto");
    expect(ESTIMATES.auto.stages).toEqual({ gate: 0.5, build: 8.0 });
    expect(scenarioTotal("auto")).toBeCloseTo(8.5, 10);
    expect(ESTIMATES.auto.source).toContain("two hand builds");
    expect(ESTIMATES.auto.source).toContain("unmeasured");
  });
  it("SCENARIO_STAGES.auto is a gate session then a build session, both on a bare /doug-next --auto (unlimited)", () => {
    const [gate, build] = SCENARIO_STAGES.auto;
    expect(SCENARIO_STAGES.auto.length).toBe(2);
    expect([gate.kind, gate.name]).toEqual(["session", "gate"]);
    expect([build.kind, build.name]).toEqual(["session", "build"]);
    expect(gate.prompt({ card: { id: "fix-hours" } })).toBe("/doug-next --auto");
    const prompt = build.prompt({ card: { id: "fix-hours" } });
    expect(prompt.startsWith("/doug-next --auto\n")).toBe(true);
    expect(prompt).not.toContain("--auto 2");
    expect(prompt).toContain("I approved the queue as shown, with the caps you proposed.");
    expect(prompt).toContain("Do not invoke the doug-board skill at any step: this checkout publishes nothing.");
    expect(prompt).not.toContain("core-next");
    expect(build.maxTurns).toBeGreaterThanOrEqual(100);
    expect(build.maxTurns).toBeLessThanOrEqual(200);
  });
  it("rehearse.mjs auto without --spend prints the auto estimate and spawns nothing", async () => {
    const marker = join(trackedTempDir("rehearse-marker-"), "spawned");
    const claudeBin = makeFakeClaude("", { marker });
    const r = await run(process.execPath, [cli, "auto"], { env: { ...process.env, DOUG_REHEARSE_CLAUDE: claudeBin } });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("$8.50");
    expect(existsSync(marker)).toBe(false);
  });
  it("rehearsalNote has an auto wording that starts with 'Rehearsal auto'", () => {
    const note = rehearsalNote({ scenario: "auto", outcome: "passed", stages: [{ name: "gate", wallClock: "1 min" }, { name: "build", wallClock: "9 min" }], cost: 7.5 });
    expect(note.startsWith("Rehearsal auto on the ts-basic fixture: passed")).toBe(true);
    expect(note).toContain("cost $7.50");
  });
});

describe("card autopilot: prepareFixture for auto", () => {
  it.skipIf(!existsSync(CLI))("has two Ready S hand cards of class code, fix-hours then add-truncate, with add-truncate's goal from ts-basic.json, one Backlog card, and one commit", async () => {
    const fx = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(fx.dir);
    const board = JSON.parse(readFileSync(join(fx.dir, ".doug/board.json"), "utf8"));
    const ready = board.cards.filter((c) => c.column === "ready");
    expect(ready.map((c) => c.id)).toEqual(["fix-hours", "add-truncate"]);
    for (const c of ready) expect([c.column, c.size, c.track, c.class], c.id).toEqual(["ready", "S", "hand", "code"]);
    const tasks = JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks;
    const truncate = tasks.find((t) => t.id === "add-truncate");
    expect(ready[1].goal).toBe(truncate.prompt);
    expect(ready[1].title).toBeTruthy();
    const backlog = board.cards.filter((c) => c.column === "backlog");
    expect(backlog, "exactly one Backlog card, which autopilot must leave alone").toHaveLength(1);
    expect(["fix-hours", "add-truncate"]).not.toContain(backlog[0].id);
    expect(backlog[0].title).toBeTruthy();
    expect(backlog[0].goal).toBeTruthy();
    expect(board.cards).toHaveLength(3);
    expect(fx.card.id).toBe("fix-hours");
    expect((await git(fx.dir, "log", "--oneline")).split("\n").filter(Boolean).length).toBe(1);
    expect(fx.baseline).toBe(await git(fx.dir, "rev-parse", "HEAD"));
    expect(existsSync(join(fx.dir, ".doug/plan.json"))).toBe(false);
  });
  it.skipIf(!existsSync(CLI))("leaves the hand fixture with only fix-hours (no Backlog card outside the auto scenario)", async () => {
    const hand = await inLib("prepareFixture", { scenario: "hand", tempPrefix: TEST_PREFIX });
    tempDirs.push(hand.dir);
    const board = JSON.parse(readFileSync(join(hand.dir, ".doug/board.json"), "utf8"));
    expect(board.cards.map((c) => c.id)).toEqual(["fix-hours"]);
  });
});

describe("card autopilot: the auto gate stage", () => {
  it.skipIf(!existsSync(CLI))("passes on an untouched fixture, and fails when a card left Ready or a commit appeared", async () => {
    const { dir, card } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    const goodBin = makeFakeClaude(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }));
    const good = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.auto[0]" }, { dir, card, claudeBin: goodBin });
    expect(good.ok, good.message).toBe(true);

    const board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
    board.cards.find((c) => c.id === "add-truncate").column = "flow";
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2));
    const moved = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.auto[0]" }, { dir, card, claudeBin: goodBin });
    expect(moved.ok).toBe(false);
    expect(moved.message).toContain("add-truncate");
    board.cards.find((c) => c.id === "add-truncate").column = "ready";
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2));

    writeFileSync(join(dir, "src/duration.ts"), readFileSync(join(dir, "src/duration.ts"), "utf8") + "\n// touched\n");
    const touched = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.auto[0]" }, { dir, card, claudeBin: goodBin });
    expect(touched.ok).toBe(false);
  });
  it.skipIf(!existsSync(CLI))("fails when the plugin is not loaded", async () => {
    const { dir, card } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    const badBin = makeFakeClaude(cannedStream({ plugins: ["some-other-plugin"], commands: ["doug-flow:doug-next"] }));
    const bad = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.auto[0]" }, { dir, card, claudeBin: badBin });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("doug-flow");
  });
});

describe("card autopilot: assertAutoBuilt", () => {
  const askStream = () =>
    cannedStream() + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [] } }] } }) + "\n";
  // What doug-hand leaves for one card: a code commit, then a board commit (record --hand, move to done).
  async function landCard(dir, id, edit, message, { record = true, move = true, source = null } = {}) {
    edit(dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", message);
    const sha = await git(dir, "rev-parse", "HEAD");
    if (record) {
      const rec = await spawnScript(BOARD_MJS, ["record", id, "--hand", "--commit", sha, "--gate", "typecheck 0; unit 3 passed", dir, "--summary", "Test summary."]);
      expect(rec.status, rec.stderr).toBe(0);
    }
    if (move) {
      const mv = await spawnScript(BOARD_MJS, ["move", id, "done", "--source", source || `commit ${sha}`, dir]);
      expect(mv.status, mv.stderr).toBe(0);
    }
    if (record || move) {
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", `Board: ${id} done as ${sha.slice(0, 7)}`);
    }
    return sha;
  }
  const addTruncate = (dir) => {
    writeFileSync(join(dir, "src/strings.ts"), readFileSync(join(dir, "src/strings.ts"), "utf8") + '\nexport function truncate(input: string, max: number): string {\n  return input.length <= max ? input : input.slice(0, max - 1) + "\\u2026";\n}\n');
    writeFileSync(join(dir, "tests/strings.test.ts"), readFileSync(join(dir, "tests/strings.test.ts"), "utf8").replace('import { slugify }', 'import { slugify, truncate }') + '\ndescribe("truncate", () => {\n  it("cuts", () => {\n    expect(truncate("hello world", 5)).toBe("hell\\u2026");\n  });\n});\n');
  };
  const cleanStream = () => cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] });

  it.skipIf(!existsSync(CLI))("passes when both cards are built and Done, with no AskUserQuestion in the stream", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    await landCard(dir, "add-truncate", addTruncate, "feat: truncate");
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok, result.message).toBe(true);
    expect(existsSync(join(dir, "tests/heldout-add-truncate.test.ts"))).toBe(false);
    expect(existsSync(join(dir, "tests/heldout-fix-hours.test.ts"))).toBe(false);
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });
  it.skipIf(!existsSync(CLI))("fails naming AskUserQuestion when the build stream carries one, even though both cards are built", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    await landCard(dir, "add-truncate", addTruncate, "feat: truncate");
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: askStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("AskUserQuestion");
  });
  it.skipIf(!existsSync(CLI))("fails naming add-truncate when only the first card is Done", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
  });
  it.skipIf(!existsSync(CLI))("fails naming fix-hours when only the second card is Done", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "add-truncate", addTruncate, "feat: truncate");
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fix-hours");
  });

  it.skipIf(!existsSync(CLI))("fails naming AskUserQuestion when it appears in a LATER assistant message, after earlier ones without it", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    await landCard(dir, "add-truncate", addTruncate, "feat: truncate");
    const assistant = (content) => JSON.stringify({ type: "assistant", message: { content } }) + "\n";
    const stream =
      cannedStream() +
      assistant([{ type: "text", text: "building card one" }]) +
      assistant([{ type: "tool_use", id: "t0", name: "Bash", input: { command: "true" } }]) +
      assistant([{ type: "text", text: "now card two" }, { type: "tool_use", id: "t9", name: "AskUserQuestion", input: { questions: [] } }]);
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("AskUserQuestion");
  });
  it.skipIf(!existsSync(CLI))("fails naming add-truncate when it is committed and Done with its live-runs entry but its held-out test fails", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    // a wrong truncate (no ellipsis): both owned files change, the card is Done and recorded, the held-out test fails
    await landCard(dir, "add-truncate", (d) => {
      writeFileSync(join(d, "src/strings.ts"), readFileSync(join(d, "src/strings.ts"), "utf8") + "\nexport function truncate(input: string, max: number): string {\n  return input.slice(0, max);\n}\n");
      writeFileSync(join(d, "tests/strings.test.ts"), readFileSync(join(d, "tests/strings.test.ts"), "utf8").replace("import { slugify }", "import { slugify, truncate }") + '\ndescribe("truncate", () => {\n  it("cuts", () => {\n    expect(truncate("hello world", 5)).toBe("hello");\n  });\n});\n');
    }, "feat: truncate");
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, "tests/heldout-add-truncate.test.ts"))).toBe(false);
  });

  // Isolation of the Backlog clause: both Ready cards are landed correctly, so only the Backlog card's state can fail.
  const editBacklog = async (dir, edit) => {
    const file = join(dir, ".doug/board.json");
    const board = JSON.parse(readFileSync(file, "utf8"));
    const card = board.cards.find((c) => c.column === "backlog");
    expect(card, "the fixture must carry a Backlog card").toBeTruthy();
    const id = card.id;
    edit(card);
    writeFileSync(file, JSON.stringify(board, null, 2) + "\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "board: touch backlog card");
    return id;
  };
  it.skipIf(!existsSync(CLI))("passes with the Backlog card untouched while both Ready cards land", async () => {
    const { dir, baseline } = await buildBothThen({});
    const board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
    expect(board.cards.filter((c) => c.column === "backlog")).toHaveLength(1);
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok, result.message).toBe(true);
  });
  it.skipIf(!existsSync(CLI))("fails naming the Backlog card when autopilot moved it out of Backlog", async () => {
    const { dir, baseline } = await buildBothThen({});
    const id = await editBacklog(dir, (c) => {
      c.column = "ready";
    });
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(id);
  });
  it.skipIf(!existsSync(CLI))("fails naming the Backlog card when its goal changed", async () => {
    const { dir, baseline } = await buildBothThen({});
    const id = await editBacklog(dir, (c) => {
      c.goal = c.goal + " (edited by the run)";
    });
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(id);
  });

  // Isolation of the per-card clause: in each case add-truncate's code is in place and its held-out test passes
  // (the tree is clean), so only the Done/commit/live-runs check can name the failure.
  const buildBothThen = async (truncateOpts, truncateEdit = addTruncate) => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    await landCard(dir, "add-truncate", truncateEdit, "feat: truncate", truncateOpts);
    return { dir, baseline };
  };
  it.skipIf(!existsSync(CLI))("fails naming add-truncate and 'done' when its code is committed and passes the held-out test but the board never moved it to Done", async () => {
    const { dir, baseline } = await buildBothThen({ record: false, move: false });
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
    expect(result.message).toContain("done");
  });
  it.skipIf(!existsSync(CLI))("fails naming add-truncate and its source when Done's source names a different commit", async () => {
    const { dir, baseline } = await buildBothThen({ source: `commit ${"0".repeat(40)}` });
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
    expect(result.message).toContain("source");
  });
  it.skipIf(!existsSync(CLI))("fails naming add-truncate and docs/live-runs.md when it is Done but has no hand-track entry", async () => {
    const { dir, baseline } = await buildBothThen({ record: false });
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
    expect(result.message).toContain("live-runs");
  });
  it.skipIf(!existsSync(CLI))("fails naming add-truncate when no single commit changes both its source and test files", async () => {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "auto", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    await landCard(dir, "fix-hours", fixDurationBug, "fix: hours multiplier");
    // src in one commit, tests in another: the held-out test passes, but no commit owns both files
    await landCard(dir, "add-truncate", (d) => {
      writeFileSync(join(d, "src/strings.ts"), readFileSync(join(d, "src/strings.ts"), "utf8") + '\nexport function truncate(input: string, max: number): string {\n  return input.length <= max ? input : input.slice(0, max - 1) + "\\u2026";\n}\n');
    }, "feat: truncate src", { record: false, move: false });
    await landCard(dir, "add-truncate", (d) => {
      writeFileSync(join(d, "tests/strings.test.ts"), readFileSync(join(d, "tests/strings.test.ts"), "utf8") + "\n// truncate tests\n");
    }, "test: truncate");
    const result = await inLib("assertAutoBuilt", { dir, baseline, stream: cleanStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
  });
});

// A fake `claude` that carries the whole auto scenario through the real CLI: the build prompt (told apart by "I
// approved the queue") fixes both cards and lands each as doug-hand does (code commit, record --hand, move to done,
// board commit).
function makeAutoScenarioFake() {
  const dir = trackedTempDir("fake-claude-autoscenario-");
  const bin = join(dir, "claude");
  const truncSrc = '\nexport function truncate(input: string, max: number): string {\n  return input.length <= max ? input : input.slice(0, max - 1) + "\\u2026";\n}\n';
  const script = [
    "#!/usr/bin/env node",
    "const { execFileSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';",
    `const sh = (args) => execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(BOARD_MJS)}, ...args]);`,
    "const land = (id, msg) => {",
    "  execFileSync('git', ['add', '-A']);",
    "  execFileSync('git', ['commit', '-q', '-m', msg]);",
    "  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
    "  sh(['record', id, '--hand', '--commit', sha, '--gate', 'typecheck 0; unit 1 passed', '--summary', 'Test summary.']);",
    "  sh(['move', id, 'done', '--source', 'commit ' + sha]);",
    "  execFileSync('git', ['add', '-A']);",
    "  execFileSync('git', ['commit', '-q', '-m', 'Board: ' + id + ' done as ' + sha.slice(0, 7)]);",
    "};",
    "if (prompt.includes('I approved the queue')) {",
    `  fs.writeFileSync('src/duration.ts', fs.readFileSync('src/duration.ts', 'utf8').replace(${JSON.stringify("return n * 60_000; // bug: should be 3_600_000")}, ${JSON.stringify("return n * 3_600_000;")}));`,
    `  fs.writeFileSync('tests/duration.test.ts', fs.readFileSync('tests/duration.test.ts', 'utf8').replace(${JSON.stringify('  it("rejects garbage"')}, ${JSON.stringify('  it("parses hours", () => {\n    expect(parseDuration("2h")).toBe(7_200_000);\n  });\n  it("rejects garbage"')}));`,
    "  land('fix-hours', 'fix: hours multiplier');",
    `  fs.appendFileSync('src/strings.ts', ${JSON.stringify(truncSrc)});`,
    `  fs.writeFileSync('tests/strings.test.ts', fs.readFileSync('tests/strings.test.ts', 'utf8').replace('import { slugify }', 'import { slugify, truncate }') + ${JSON.stringify('\ndescribe("truncate", () => {\n  it("cuts", () => {\n    expect(truncate("hello world", 5)).toBe("hell\\u2026");\n  });\n});\n')});`,
    "  land('add-truncate', 'feat: truncate');",
    "}",
    `process.stdout.write(${JSON.stringify(cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }))});`,
    "process.exit(0);",
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

describe("card autopilot: scripts/rehearse.mjs auto --spend end to end with a fake claude", () => {
  it.skipIf(!existsSync(CLI))("passes and records through the hand path: a hand-track entry in the target's docs/live-runs.md, no synthetic or flow report", async () => {
    const targetDir = trackedTempDir("rehearse-auto-target-");
    let board = { ...newBoard(), components: ["flow"] };
    board = addCard(board, { id: "fix-hours", title: "Fix hours", goal: "g", component: "flow", size: "S", track: "hand", column: "ready" });
    saveBoard(targetDir, board);
    const r = await run(process.execPath, [cli, "auto", "--spend", "--card", "fix-hours", targetDir], { env: { ...process.env, DOUG_REHEARSE_CLAUDE: makeAutoScenarioFake() } });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain("auto: passed");
    expect(r.stdout).not.toContain("recording failed");
    const text = readFileSync(join(targetDir, "docs/live-runs.md"), "utf8");
    expect(text).toContain("Rehearsal auto for card `fix-hours` on the ts-basic fixture");
    expect(text).not.toContain("Built by hand through doug-hand");
    // no workflow report was written or synthesised for the hand path
    const found = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/synthetic-report\.json$|last-report\.json$/.test(e.name)) found.push(join(d, e.name));
      }
    };
    walk(targetDir);
    expect(found).toEqual([]);
  });
});

describe("the swarm scenario runs a splittable task (card rehearsal-swarm-splittable)", () => {
  const NEW_ID = "swarm-split-planned";
  const isTestFile = (f) => /(^|\/)tests\//.test(f) || /\.(test|spec)\./.test(f);
  const suite = JSON.parse(readFileSync(join(here, "..", "evals", "tasks", "ts-basic.json"), "utf8"));
  const newTask = suite.tasks.find((t) => t.id === NEW_ID);

  it("T3: ts-basic carries the task, its plan owns src/duration.ts and src/strings.ts, and its held-out files exist", () => {
    expect(newTask, `${NEW_ID} task`).toBeDefined();
    const files = newTask.plan.tasks.flatMap((t) => t.files);
    expect(files).toContain("src/duration.ts");
    expect(files).toContain("src/strings.ts");
    expect(newTask.heldOut.length).toBeGreaterThan(0);
    for (const h of newTask.heldOut) expect(existsSync(join(here, "..", "evals", "heldout", h.from)), h.from).toBe(true);
  });

  it.skipIf(!existsSync(CLI))(
    "T1/T2: swarm installs an approved swarm plan with a splittable, non-S task and the new card; hand and flow stay on fix-hours",
    async () => {
      const swarm = await inLib("prepareFixture", { scenario: "swarm", tempPrefix: TEST_PREFIX });
      tempDirs.push(swarm.dir);
      const plan = JSON.parse(readFileSync(join(swarm.dir, ".doug/plan.json"), "utf8"));
      expect(plan.status).toBe("approved");
      expect(plan.swarm).toBe(true);
      const splittable = plan.tasks.filter((t) => t.size !== "S" && t.files.filter((f) => !isTestFile(f)).length >= 2);
      expect(splittable.length).toBeGreaterThanOrEqual(1);
      expect(plan.card).toBe(NEW_ID);
      expect(plan.card).not.toBe("fix-hours");
      expect(swarm.card.id).toBe(plan.card);
      const board = JSON.parse(readFileSync(join(swarm.dir, ".doug/board.json"), "utf8"));
      expect(board.cards.find((c) => c.id === plan.card)).toBeDefined();

      for (const scenario of ["hand", "flow"]) {
        const f = await inLib("prepareFixture", { scenario, tempPrefix: TEST_PREFIX });
        tempDirs.push(f.dir);
        expect(f.card.id).toBe("fix-hours");
        expect(f.card.title).toBe("Fix hours in parseDuration");
        const b = JSON.parse(readFileSync(join(f.dir, ".doug/board.json"), "utf8"));
        expect(b.cards.find((c) => c.id === "fix-hours")).toBeDefined();
        expect(b.cards.find((c) => c.id === NEW_ID)).toBeUndefined();
      }
    },
  );

  it("T5: the swarm estimate source no longer says it fails at implement, and the page names the new task without the until-lands phrasing", () => {
    expect(ESTIMATES.swarm.source).not.toContain("fails at implement");
    expect(ESTIMATES.swarm.source).toContain(NEW_ID);
    const lib = readFileSync(join(here, "..", "scripts", "rehearse-lib.mjs"), "utf8");
    expect(lib).not.toMatch(/until (card )?`?rehearsal-swarm-splittable/);
  });

  // The public snapshot leaves out docs/rehearsals.md; scripts/export-public.mjs is itself excluded, so its absence
  // marks a snapshot. In dev a missing page must fail, not skip.
  const IS_SNAPSHOT = !existsSync(join(here, "..", "scripts/export-public.mjs"));
  it.skipIf(IS_SNAPSHOT)("T5: docs/rehearsals.md names the new task without the until-lands phrasing", () => {
    const page = readFileSync(join(here, "..", "docs", "rehearsals.md"), "utf8");
    expect(page).not.toContain("until `rehearsal-swarm-splittable`");
    expect(page).not.toContain("until card `rehearsal-swarm-splittable`");
    expect(page).not.toContain("until card rehearsal-swarm-splittable");
    expect(page).toContain(NEW_ID);
  });
});

describe("the swarm scenario's land stage uses the swarm held-out test (card rehearsal-swarm-splittable)", () => {
  // A reference implementation of swarm-split-planned on the integration branch plan.mjs land merges: the swarm
  // held-out test passes on it, and fix-hours' default held-out test (parseDuration('2h')) fails on it.
  const REF_DURATION = "\nexport function toSeconds(text: string): number {\n  return parseDuration(text) / 1000;\n}\n";
  const REF_STRINGS =
    "\nexport function titleCase(input: string): string {\n  return input\n    .trim()\n    .split(/\\s+/)\n    .filter(Boolean)\n    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())\n    .join(\" \");\n}\n";

  it.skipIf(!existsSync(CLI))("lands the split-helpers branch and runs evals/heldout/swarm-split-planned.test.ts, leaving no held-out file behind", async () => {
    const fx = await inLib("prepareFixture", { scenario: "swarm", tempPrefix: TEST_PREFIX });
    tempDirs.push(fx.dir);
    const landStage = SCENARIO_STAGES.swarm.find((st) => st.name === "land");
    expect(landStage).toBeDefined();
    await git(fx.dir, "checkout", "-q", "-b", "doug/split-helpers");
    writeFileSync(join(fx.dir, "src/duration.ts"), readFileSync(join(fx.dir, "src/duration.ts"), "utf8") + REF_DURATION);
    writeFileSync(join(fx.dir, "src/strings.ts"), readFileSync(join(fx.dir, "src/strings.ts"), "utf8") + REF_STRINGS);
    await git(fx.dir, "add", "-A");
    await git(fx.dir, "commit", "-q", "-m", "reference split-helpers");
    await git(fx.dir, "checkout", "-q", "main");
    const result = await inLib("runActStage", { $expr: "lib.SCENARIO_STAGES.swarm.find((st) => st.name === 'land')" }, { dir: fx.dir, card: fx.card, baseline: fx.baseline });
    expect(result.message, result.message).toContain("landed as");
    expect(result.ok).toBe(true);
    expect(existsSync(join(fx.dir, "tests/heldout-swarm-split-planned.test.ts"))).toBe(false);
    expect(existsSync(join(fx.dir, "tests/heldout-fix-hours.test.ts"))).toBe(false);
  }, 240000);
});

// Card doug-start-skill: the `start` (project mode from an empty git repo) and `start-feature` (feature mode on the
// ts-basic fixture's fix-hours card) scenarios. Nothing here spawns the real claude binary.
//
// Assumptions the coder must match (the tests pin only these, not prompt prose):
//  - `start`'s fixture is a git repo on main with exactly one empty initial commit (baseline = its sha) and no tracked file.
//  - `start`'s stages are four [session, act] pairs; the sessions are named idea, architecture, skeleton, scope, in that order.
//  - `start-feature`'s stages are [session, act, session, act, session]; the sessions are named spec, architecture, plan.
//  - every session's prompt starts with a first line of exactly "/doug-start" (start) or "/doug-start fix-hours" (start-feature).
//  - every session stage name is a key of ESTIMATES[scenario].stages (capFor needs it).
//  - the LAST stage of each scenario carries the end assertions and reads only files (it is called with stream "" and
//    baseline null): start needs a board with cards and a non-empty .doug/config.json stopGate.commands; start-feature needs
//    docs/specs/fix-hours/spec.md, docs/specs/fix-hours/architecture.md, and a draft .doug/plan.json.
// ---- Review round 1: stub streams ----
// Which agents each session must spawn, by subagent_type, and the stream pieces a real `claude -p` session leaves.
const EXPECTED_AGENTS = {
  start: { idea: ["doug-flow:spec-writer"], architecture: ["doug-flow:researcher", "architect"], skeleton: ["tester", "coder", "reviewer"], scope: ["doug-flow:spec-writer"] },
  "start-feature": { spec: ["doug-flow:spec-writer"], architecture: ["architect"], plan: ["doug-flow:planner"] },
};
const toolUse = (name, input = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input }] } });
// AskUserQuestion is absent from the -p tool list (measured, Claude Code 2.1.296), so a real stream carries no such
// tool_use; `ask: true` only exists to show that one in the stream is harmless.
function stubStream({ plugins = ["doug-flow"], commands = ["doug-flow:doug-start"], agents = [], ask = false } = {}) {
  const lines = [cannedStream({ plugins, commands }).split("\n")[0]];
  for (const a of agents) lines.push(toolUse("Agent", { subagent_type: a, prompt: "p" }));
  if (ask) lines.push(toolUse("AskUserQuestion", { questions: [] }));
  lines.push(JSON.stringify({ type: "result", total_cost_usd: 0.01, num_turns: 1 }));
  return lines.join("\n") + "\n";
}
const provingStream = (scenario, session, over = {}) => stubStream({ agents: EXPECTED_AGENTS[scenario][session], ...over });

describe("card doug-start-skill review: every session assert proves the skill ran", () => {
  const RAN = /^the skill did not run/;
  for (const [scenario, sessions] of Object.entries(EXPECTED_AGENTS)) {
    for (const [name, agents] of Object.entries(sessions)) {
      const stage = () => SCENARIO_STAGES[scenario].find((s) => s.kind === "session" && s.name === name);
      const ctx = (stream) => ({ dir: trackedTempDir("start-ran-"), card: { id: "fix-hours" }, baseline: null, stream });
      it(`${scenario}/${name}: a full stream gets past the stream checks (it then fails only on the missing files)`, () => {
        const r = stage().assert(ctx(provingStream(scenario, name)));
        expect(r.ok).toBe(false);
        expect(r.message).not.toMatch(RAN);
      });
      it(`${scenario}/${name}: fails when the plugin is not loaded or /doug-start is absent`, () => {
        for (const over of [{ plugins: [] }, { commands: [] }]) {
          const r = stage().assert(ctx(provingStream(scenario, name, over)));
          expect(r.ok, JSON.stringify(over)).toBe(false);
          expect(r.message, JSON.stringify(over)).toMatch(RAN);
        }
      });
      for (const missing of agents) {
        it(`${scenario}/${name}: fails naming ${missing} when it was never spawned`, () => {
          const r = stage().assert(ctx(stubStream({ agents: agents.filter((a) => a !== missing) })));
          expect(r.ok).toBe(false);
          expect(r.message).toMatch(RAN);
          expect(r.message).toContain(missing);
        });
      }
    }
  }
  it("a stream with no AskUserQuestion passes the stream proof, and one with it passes too", () => {
    for (const ask of [false, true]) {
      const stage = SCENARIO_STAGES.start.find((s) => s.name === "idea");
      const dir = trackedTempDir("start-ran-");
      mkdirSync(join(dir, "docs/product"), { recursive: true });
      writeFileSync(join(dir, "docs/product/idea.md"), "# idea\n");
      const r = stage.assert({ dir, card: {}, baseline: null, stream: stubStream({ agents: ["doug-flow:spec-writer"], ask }) });
      expect(r.ok, r.message).toBe(true);
    }
  });
  it("an empty stream fails every session", () => {
    for (const [scenario, sessions] of Object.entries(EXPECTED_AGENTS)) {
      for (const name of Object.keys(sessions)) {
        const stage = SCENARIO_STAGES[scenario].find((s) => s.kind === "session" && s.name === name);
        expect(stage.assert({ dir: trackedTempDir("start-ran-"), card: {}, baseline: null, stream: "" }).ok).toBe(false);
      }
    }
  });
});

describe("card doug-start-skill: a session is held at its gate (no later phase file, no commit, no approved plan)", () => {
  // Files each session leaves, and the files of the phases after it, which a session that ran past its gate would write.
  // Card doug-start-skill: docs/decisions/** is proposal-only, so the architecture session leaves a pending decision
  // proposal (a diff under .doug/.state/learn/) and must not write or apply the ADR itself.
  const PROPOSAL = ".doug/.state/learn/2026-10-11T000000000/01-decision.diff";
  const OWN = { "start/idea": ["docs/product/idea.md"], "start/architecture": ["docs/product/architecture.md", PROPOSAL], "start-feature/spec": ["docs/specs/fix-hours/spec.md"], "start-feature/architecture": ["docs/specs/fix-hours/architecture.md"] };
  const LATER = {
    "start/idea": ["docs/product/architecture.md", "docs/decisions/0001-stack.md", "package.json", "docs/product/scope.md"],
    "start/architecture": ["docs/decisions/0001-stack.md", "package.json", "docs/product/scope.md"],
    "start/skeleton": ["docs/product/scope.md"],
    "start-feature/spec": ["docs/specs/fix-hours/pseudocode.md", "docs/specs/fix-hours/architecture.md", ".doug/plan.json"],
    "start-feature/architecture": [".doug/plan.json"],
  };
  const repo = async () => {
    const dir = trackedTempDir("start-held-");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", "t");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
    return { dir, head: await git(dir, "rev-parse", "HEAD") };
  };
  const put = (dir, rels) => {
    for (const rel of rels) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), rel.endsWith(".json") ? "{}\n" : "# x\n");
    }
  };
  const stage = (key) => {
    const [scenario, name] = key.split("/");
    return { scenario, name, s: SCENARIO_STAGES[scenario].find((x) => x.kind === "session" && x.name === name) };
  };
  for (const key of Object.keys(OWN)) {
    const { scenario, name, s } = stage(key);
    const stream = () => provingStream(scenario, name);
    it(`${key}: passes when held (its own files, nothing later, HEAD unchanged)`, async () => {
      const { dir, head } = await repo();
      put(dir, OWN[key]);
      const r = s.assert({ dir, card: {}, baseline: null, head, stream: stream() });
      expect(r.ok, r.message).toBe(true);
    });
    it(`${key}: fails when the session also committed`, async () => {
      const { dir, head } = await repo();
      put(dir, OWN[key]);
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "ran past the gate");
      const r = s.assert({ dir, card: {}, baseline: null, head, stream: stream() });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/commit/);
    });
  }
  for (const [key, later] of Object.entries(LATER)) {
    const { scenario, name, s } = stage(key);
    for (const rel of later) {
      it(`${key}: fails when the next phase's ${rel} was also written`, async () => {
        const { dir, head } = await repo();
        put(dir, [...(OWN[key] || []), rel]);
        const r = s.assert({ dir, card: {}, baseline: null, head, stream: provingStream(scenario, name) });
        expect(r.ok).toBe(false);
        expect(r.message).toContain(rel);
      });
    }
  }
  it("start/architecture: fails when the session left no pending decision proposal (it wrote or skipped the ADR)", async () => {
    const { dir, head } = await repo();
    put(dir, ["docs/product/architecture.md"]);
    const r = stage("start/architecture").s.assert({ dir, card: {}, baseline: null, head, stream: provingStream("start", "architecture") });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/proposal/);
  });
  it("start-feature/plan: fails when the plan is already approved", async () => {
    const { dir, head } = await repo();
    put(dir, ["docs/specs/fix-hours/spec.md", "docs/specs/fix-hours/architecture.md"]);
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks.find((t) => t.id === "fix-hours-planned").plan, status: "approved", card: "fix-hours" }));
    const r = stage("start-feature/plan").s.assert({ dir, card: {}, baseline: null, head, stream: provingStream("start-feature", "plan") });
    expect(r.ok).toBe(false);
  });
});

describe("card doug-start-skill: runSessionStage records HEAD before the session and passes it to the assert", () => {
  // A fake claude that does what a session past its gate does: writes the idea file and, when asked, commits it in
  // its cwd (the fixture), then prints a stream that proves the skill ran.
  const fakeSession = (commit) => {
    const stream = [cannedStream({ commands: ["doug-flow:doug-start"] }).split("\n")[0], toolUse("Agent", { subagent_type: "doug-flow:spec-writer", prompt: "p" }), JSON.stringify({ type: "result", total_cost_usd: 0.01 })];
    const dir = trackedTempDir("fake-session-");
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs"); const { execFileSync } = require("node:child_process");',
        'fs.mkdirSync("docs/product", { recursive: true }); fs.writeFileSync("docs/product/idea.md", "# idea\\n");',
        commit ? 'execFileSync("git", ["add", "-A"]); execFileSync("git", ["commit", "-q", "-m", "ran past the gate"]);' : "",
        ...stream.map((l) => `process.stdout.write(${JSON.stringify(l)} + "\\n");`),
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  };
  const fixture = async () => {
    const dir = trackedTempDir("start-session-");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", "t");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
    return dir;
  };
  const runIdea = (dir, claudeBin) => inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.start[0]" }, { dir, card: {}, baseline: null, claudeBin });
  it("a session that only writes its file passes (the control)", async () => {
    const r = await runIdea(await fixture(), fakeSession(false));
    expect(r.ok, r.message).toBe(true);
  });
  it("a session that also committed fails the stage on the in-session commit", async () => {
    const r = await runIdea(await fixture(), fakeSession(true));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/commit/);
  });
});

describe("card doug-start-skill: the skeleton session and its approve act", () => {
  const skeleton = () => SCENARIO_STAGES.start.find((x) => x.name === "skeleton");
  const sdir = async ({ column = "backlog", commands = [PASS_CMD], pkg = true } = {}) => {
    const dir = trackedTempDir("start-skeleton-");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", "t");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
    const head = await git(dir, "rev-parse", "HEAD");
    if (pkg) writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ stopGate: { commands } }));
    saveBoard(dir, addCard(newBoard(), { id: "walking-skeleton", title: "Walking skeleton", goal: "g", size: "S", column }));
    return { dir, head };
  };
  const PASS_CMD = "test";
  const assertIt = ({ dir, head }) => skeleton().assert({ dir, card: {}, baseline: null, head, stream: provingStream("start", "skeleton") });
  it("passes when built, gate commands detected, walking-skeleton present and NOT yet Done, nothing committed", async () => {
    const r = assertIt(await sdir());
    expect(r.ok, r.message).toBe(true);
  });
  it("fails without package.json, with empty stopGate.commands, with the card missing, and with the card already Done (it ran past the gate)", async () => {
    expect(assertIt(await sdir({ pkg: false })).ok).toBe(false);
    expect(assertIt(await sdir({ commands: [] })).ok).toBe(false);
    const gone = await sdir();
    saveBoard(gone.dir, newBoard());
    expect(assertIt(gone).ok).toBe(false);
    const done = assertIt(await sdir({ column: "done" }));
    expect(done.ok).toBe(false);
    expect(done.message).toMatch(/Done|done/);
  });
  it("fails when the session committed", async () => {
    const d = await sdir();
    await git(d.dir, "add", "-A");
    await git(d.dir, "commit", "-q", "-m", "ran past the gate");
    const r = assertIt(d);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/commit/);
  });
  it("approve-skeleton moves walking-skeleton to Done and commits everything", async () => {
    const { dir } = await sdir();
    const r = SCENARIO_STAGES.start.find((x) => x.name === "approve-skeleton").run({ dir, card: {}, baseline: null });
    expect(r.ok, r.message).toBe(true);
    expect(JSON.parse(await git(dir, "show", "HEAD:.doug/board.json")).cards.find((c) => c.id === "walking-skeleton").column).toBe("done");
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });
  it("approve-skeleton fails when the card is missing", async () => {
    const { dir } = await sdir();
    saveBoard(dir, newBoard());
    expect(SCENARIO_STAGES.start.find((x) => x.name === "approve-skeleton").run({ dir, card: {}, baseline: null }).ok).toBe(false);
  });
});

describe("card doug-start-skill review: the approve acts commit everything the session left", () => {
  // A no-op act, or one whose `git add` is narrowed to a path, leaves something uncommitted: each fails here.
  const prep = async () => {
    const dir = trackedTempDir("start-act-");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", "t");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
    mkdirSync(join(dir, "docs/product"), { recursive: true });
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, "docs/product/idea.md"), "# idea\n");
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, ".doug/board.json"), "{}\n");
    return dir;
  };
  const MEMORY = join(here, "..", "plugins/doug-flow/scripts/memory.mjs");
  const propose = (dir) => {
    writeFileSync(join(dir, "body.md"), "We use Node.\n");
    const r = spawnSync(process.execPath, [MEMORY, "decision", "propose", "--title", "Stack", "--file", join(dir, "body.md"), dir], { encoding: "utf8", env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    rmSync(join(dir, "body.md"));
  };
  it("start/approve-architecture applies the pending decision proposal (docs/decisions/0001-stack.md) and commits it", async () => {
    const dir = await prep();
    propose(dir);
    const r = SCENARIO_STAGES.start.find((x) => x.name === "approve-architecture").run({ dir, card: {}, baseline: null });
    expect(r.ok, r.message).toBe(true);
    expect(await git(dir, "show", "HEAD:docs/decisions/0001-stack.md")).toContain("We use Node.");
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });
  it("start/approve-architecture fails when there is no pending proposal to apply", async () => {
    const r = SCENARIO_STAGES.start.find((x) => x.name === "approve-architecture").run({ dir: await prep(), card: {}, baseline: null });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/proposal/);
  });
  for (const scenario of ["start", "start-feature"]) {
    for (const stage of SCENARIO_STAGES[scenario].filter((s) => s.kind === "act")) {
      if (stage.name === "approve-architecture" && scenario === "start") continue; // needs a proposal; covered above
      if (stage.name === "approve-skeleton") continue; // needs the walking-skeleton card; covered in the skeleton describe
      it(`${scenario}/${stage.name}: leaves a clean tree with docs, root, and .doug files all in HEAD`, async () => {
        const dir = await prep();
        stage.run({ dir, card: { id: "fix-hours" }, baseline: null }); // the last start act also asserts the end state, which a bare dir fails; only the commit matters here
        expect(await git(dir, "status", "--porcelain")).toBe("");
        const tracked = (await git(dir, "ls-files")).split("\n");
        expect(tracked).toEqual(expect.arrayContaining(["docs/product/idea.md", "package.json", ".doug/board.json"]));
        expect(await git(dir, "rev-list", "--count", "HEAD")).toBe("2");
      });
    }
  }
});

describe("card doug-start-skill: the start and start-feature registry entries", () => {
  for (const name of ["start", "start-feature"]) {
    it(`SCENARIOS includes ${name}; ESTIMATES.${name} has positive per-stage figures and a source; estimateLines lists it`, () => {
      expect(SCENARIOS).toContain(name);
      const est = ESTIMATES[name];
      expect(est).toBeDefined();
      const figures = Object.values(est.stages);
      expect(figures.length).toBeGreaterThan(0);
      for (const usd of figures) expect(usd).toBeGreaterThan(0);
      expect(typeof est.source).toBe("string");
      expect(est.source.length).toBeGreaterThan(20);
      expect(estimateLines().some((l) => l.includes(name) && l.includes(`$${scenarioTotal(name).toFixed(2)}`))).toBe(true);
    });
    it(`rehearse.mjs ${name} without --spend prints its estimate and spawns nothing`, async () => {
      const marker = join(trackedTempDir("rehearse-marker-"), "spawned");
      const claudeBin = makeFakeClaude("", { marker });
      const r = await run(process.execPath, [cli, name], { env: { ...process.env, DOUG_REHEARSE_CLAUDE: claudeBin } });
      expect(r.status).toBe(2);
      expect(r.stdout).toContain(`$${scenarioTotal(name).toFixed(2)}`);
      expect(existsSync(marker)).toBe(false);
    });
  }
});

describe("card doug-start-skill: stage lists", () => {
  const SHAPES = {
    start: { kinds: ["session", "act", "session", "act", "session", "act", "session", "act"], sessions: ["idea", "architecture", "skeleton", "scope"], firstLine: "/doug-start" },
    "start-feature": { kinds: ["session", "act", "session", "act", "session"], sessions: ["spec", "architecture", "plan"], firstLine: "/doug-start fix-hours" },
  };
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`${name}: stage kinds alternate session and act, sessions named ${shape.sessions.join(", ")}`, () => {
      const stages = SCENARIO_STAGES[name];
      expect(stages.map((s) => s.kind)).toEqual(shape.kinds);
      expect(stages.filter((s) => s.kind === "session").map((s) => s.name)).toEqual(shape.sessions);
    });
    it(`${name}: every session starts with ${shape.firstLine} and has an estimate and a turn cap; every act has a run function`, () => {
      for (const s of SCENARIO_STAGES[name]) {
        if (s.kind === "session") {
          expect(s.prompt({ card: { id: "fix-hours" } }).split("\n")[0], s.name).toBe(shape.firstLine);
          expect(ESTIMATES[name].stages[s.name], `ESTIMATES.${name}.stages.${s.name}`).toBeGreaterThan(0);
          expect(s.maxTurns, s.name).toBeGreaterThan(0);
          expect(typeof s.assert).toBe("function");
        } else {
          expect(typeof s.run, s.name).toBe("function");
        }
      }
    });
  }
});

describe("card doug-start-skill: prepareFixture", () => {
  it.skipIf(!existsSync(CLI))("start is an empty git repo: one empty initial commit, no tracked file, no package.json, no docs/product", async () => {
    const fx = await inLib("prepareFixture", { scenario: "start", tempPrefix: TEST_PREFIX });
    tempDirs.push(fx.dir);
    expect(existsSync(join(fx.dir, ".git"))).toBe(true);
    expect((await git(fx.dir, "rev-list", "--count", "HEAD"))).toBe("1");
    expect((await git(fx.dir, "ls-files"))).toBe("");
    expect(fx.baseline).toBe(await git(fx.dir, "rev-parse", "HEAD"));
    expect(existsSync(join(fx.dir, "package.json"))).toBe(false);
    expect(existsSync(join(fx.dir, "src"))).toBe(false);
    expect(existsSync(join(fx.dir, "docs/product"))).toBe(false);
    expect(existsSync(join(fx.dir, ".doug/plan.json"))).toBe(false);
  });
  it.skipIf(!existsSync(CLI))("start-feature is the ts-basic fixture with fix-hours Ready, no docs/specs, no plan, one commit", async () => {
    const fx = await inLib("prepareFixture", { scenario: "start-feature", tempPrefix: TEST_PREFIX });
    tempDirs.push(fx.dir);
    expect(fx.card.id).toBe("fix-hours");
    const board = JSON.parse(readFileSync(join(fx.dir, ".doug/board.json"), "utf8"));
    expect(board.cards.map((c) => c.id)).toContain("fix-hours");
    expect(existsSync(join(fx.dir, "src/duration.ts"))).toBe(true);
    expect(existsSync(join(fx.dir, "docs/specs"))).toBe(false);
    expect(existsSync(join(fx.dir, ".doug/plan.json"))).toBe(false);
    expect((await git(fx.dir, "log", "--oneline")).split("\n").filter(Boolean).length).toBe(1);
    expect(fx.baseline).toBe(await git(fx.dir, "rev-parse", "HEAD"));
  });
});

describe("card doug-start-skill: the last stage's end assertions", () => {
  const card = { id: "fix-hours", title: "Fix hours", goal: "g" };
  const check = (scenario, dir) => {
    const last = SCENARIO_STAGES[scenario].at(-1);
    try {
      // The last start-feature stage is a session whose assert also requires proof the skill ran (review round 1), so
      // it gets the full stub stream; the file checks are what these tests vary.
      return last.kind === "act" ? last.run({ dir, card, baseline: null }) : last.assert({ dir, card, baseline: null, stream: provingStream(scenario, last.name) });
    } catch (err) {
      return { ok: false, message: `threw: ${err.message}` };
    }
  };
  const write = (dir, rel, text) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const commitAll = async (dir) => {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", "t");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "x");
  };
  // Review round 1: the end state RUNS every stopGate command (exit 0 required), so the default commands are real ones
  // that pass in a bare temp dir; and the board needs a card besides walking-skeleton, with walking-skeleton Done.
  // The end state runs the project's own vendored verify.mjs, which resolves a stopGate entry that names a package
  // script ("test") the way the Stop gate does; a bare "test" run as a shell command is the `test` builtin and exits 1.
  const PASS = "test";
  const FAIL = "bad";
  const startDir = async ({ cards = true, other = true, skeletonColumn = "done", commands = [PASS] } = {}) => {
    const dir = trackedTempDir("start-end-");
    let board = newBoard();
    if (cards) board = addCard(board, { id: "walking-skeleton", title: "Walking skeleton", goal: "g", size: "S", column: skeletonColumn });
    if (cards && other) board = addCard(board, { id: "first-feature", title: "First feature", goal: "g", size: "S", column: "ready" });
    saveBoard(dir, board);
    write(dir, "package.json", JSON.stringify({ name: "p", private: true, scripts: { test: 'node -e "console.log(1)"', bad: 'node -e "console.error(\'boom\');process.exit(1)"' } }));
    write(dir, ".doug/config.json", JSON.stringify({ commands: { test: "npm test", bad: "npm run bad" }, stopGate: { commands } }, null, 2));
    // What `doug init` vendors into a project (pnpm hooks:sync does the same here).
    cpSync(join(here, "..", "plugins/doug-gates/scripts"), join(dir, ".doug/hooks/scripts"), { recursive: true });
    cpSync(join(here, "..", "plugins/doug-gates/lib"), join(dir, ".doug/hooks/lib"), { recursive: true });
    for (const f of ["docs/product/idea.md", "docs/product/architecture.md", "docs/product/scope.md", "docs/decisions/0001-stack.md"]) write(dir, f, "# x\n");
    await commitAll(dir);
    return dir;
  };
  it("start passes on a board with cards and non-empty stopGate.commands", async () => {
    const r = check("start", await startDir());
    expect(r.ok, r.message).toBe(true);
  });
  it("start fails on an empty board", async () => {
    expect(check("start", await startDir({ cards: false })).ok).toBe(false);
  });
  it("start fails when stopGate.commands is empty", async () => {
    expect(check("start", await startDir({ commands: [] })).ok).toBe(false);
  });
  it("start fails when a stopGate command exits non-zero, naming it, even if another passes", async () => {
    const r = check("start", await startDir({ commands: [PASS, FAIL] }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("boom"); // the failing command's output tail is in the message
  });
  it("start runs the project's verify.mjs with --no-credit (a credited record must not stand in for a real run)", async () => {
    const dir = await startDir();
    const argvFile = join(dir, "verify-argv.json");
    writeFileSync(join(dir, ".doug/hooks/scripts/verify.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`);
    expect(check("start", dir).ok).toBe(true);
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toContain("--no-credit");
  });
  it("start's end assert carries verify.mjs's last \"gate: \" line, without the prefix, as the result's gate (card rehearsal-record-start-labels)", async () => {
    const dir = await startDir();
    writeFileSync(join(dir, ".doug/hooks/scripts/verify.mjs"), 'console.log("running typecheck");\nconsole.log("gate: typecheck 0; test:unit 0 (12 passed)");\n');
    const r = check("start", dir);
    expect(r.ok, r.message).toBe(true);
    expect(r.gate).toBe("typecheck 0; test:unit 0 (12 passed)");
  });
  it("start's gate is the last gate line when verify.mjs prints several, and the real vendored verify.mjs yields one", async () => {
    const dir = await startDir();
    writeFileSync(join(dir, ".doug/hooks/scripts/verify.mjs"), 'console.log("gate: first 0");\nconsole.log("gate: second 0; third 0");\n');
    expect(check("start", dir).gate).toBe("second 0; third 0");
    const real = check("start", await startDir());
    expect(real.ok, real.message).toBe(true);
    expect(real.gate).toMatch(/\S/);
    expect(real.gate).not.toMatch(/^gate:/);
  });
  it("runActStage keeps the gate the act returned, as it does the commit", () => {
    const r = runActStage({ run: () => ({ ok: true, message: "m", gate: "typecheck 0" }) }, { dir: ".", card: {}, baseline: null });
    expect(r.gate).toBe("typecheck 0");
  });
  it.skipIf(!existsSync(CLI))("runScenario carries a stage's gate into the scenario result, as it does the commit (test added by the coder: nothing else covered runScenario)", () => {
    const saved = SCENARIO_STAGES.start;
    SCENARIO_STAGES.start = [{ kind: "act", name: "end", run: () => ({ ok: true, message: "m", gate: "typecheck 0; test:unit 0 (3 passed)" }) }];
    try {
      const r = runScenario("start", { tempPrefix: TEST_PREFIX });
      rmSync(r.fixtureDir, { recursive: true, force: true });
      expect(r.outcome).toBe("passed");
      expect(r.gate).toBe("typecheck 0; test:unit 0 (3 passed)");
    } finally {
      SCENARIO_STAGES.start = saved;
    }
  });
  it("rehearsalGate picks result.gate, then the fixture's recorded Gate row, then \"not observed\"", () => {
    const dir = trackedTempDir("gate-pick-");
    expect(rehearsalGate({ gate: null }, dir)).toBe("not observed");
    expect(rehearsalGate({}, dir)).toBe("not observed");
    write(dir, "docs/live-runs.md", "| Gate | typecheck 0; unit 12 passed |\n");
    expect(rehearsalGate({}, dir)).toBe("typecheck 0; unit 12 passed");
    expect(rehearsalGate({ gate: null }, dir)).toBe("typecheck 0; unit 12 passed");
    expect(rehearsalGate({ gate: "typecheck 0; test:unit 0 (4 passed)" }, dir)).toBe("typecheck 0; test:unit 0 (4 passed)");
    expect(rehearsalGate({ gate: "typecheck 0; test:unit 0 (4 passed)" }, trackedTempDir("gate-pick-empty-"))).toBe("typecheck 0; test:unit 0 (4 passed)");
  });
  it("start fails when the board has only walking-skeleton (no other card)", async () => {
    expect(check("start", await startDir({ other: false })).ok).toBe(false);
  });
  it("start fails when walking-skeleton is not in Done", async () => {
    expect(check("start", await startDir({ skeletonColumn: "ready" })).ok).toBe(false);
  });

  // Review round 1: the plan must validate (plan.mjs validate) and carry card fix-hours, so the fixture plan is the
  // ts-basic fix-hours-planned plan, which validates. A stream that proves the skill ran is passed too (see below).
  const goodPlan = (over = {}) => ({ ...JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks.find((t) => t.id === "fix-hours-planned").plan, status: "draft", card: "fix-hours", ...over });
  const featureDir = async ({ omit = null, planStatus = "draft", plan = {} } = {}) => {
    const dir = trackedTempDir("start-feature-end-");
    const files = {
      "docs/specs/fix-hours/spec.md": "# spec\n",
      "docs/specs/fix-hours/architecture.md": "# architecture\n",
      ".doug/plan.json": JSON.stringify(goodPlan({ status: planStatus, ...plan })),
    };
    for (const [rel, text] of Object.entries(files)) if (rel !== omit) write(dir, rel, text);
    await commitAll(dir);
    return dir;
  };
  it("start-feature passes with spec.md, architecture.md, and a draft plan", async () => {
    const r = check("start-feature", await featureDir());
    expect(r.ok, r.message).toBe(true);
  });
  for (const omit of ["docs/specs/fix-hours/spec.md", "docs/specs/fix-hours/architecture.md", ".doug/plan.json"]) {
    it(`start-feature fails without ${omit}`, async () => {
      expect(check("start-feature", await featureDir({ omit })).ok).toBe(false);
    });
  }
  it("start-feature fails when the plan does not validate (plan.mjs validate)", async () => {
    const r = check("start-feature", await featureDir({ plan: { tasks: [] } }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/validate/);
  });
  it("start-feature fails when the plan's card is not fix-hours", async () => {
    expect(check("start-feature", await featureDir({ plan: { card: "other" } })).ok).toBe(false);
    expect(check("start-feature", await featureDir({ plan: { card: undefined } })).ok).toBe(false);
  });
  it("start-feature fails when the plan is already approved (the human gate is /doug-approve, not the skill)", async () => {
    expect(check("start-feature", await featureDir({ planStatus: "approved" })).ok).toBe(false);
  });
});

// Card parallel-card-queens, brief B13: the `parallel` rehearsal scenario (design-r2 section 1.M). One flow card
// (fix-hours, component duration) and one hand card (add-truncate, component strings) run at once under
// workers.max 2. Fakes only: nothing here spawns the real claude, and the live run waits for the user's approval.
describe("card parallel-card-queens: the parallel scenario's registry entries (R01)", () => {
  it("SCENARIOS includes parallel; ESTIMATES.parallel is gate 0.5 and build 9.0, with an unmeasured source", () => {
    expect(SCENARIOS).toContain("parallel");
    expect(ESTIMATES.parallel.stages).toEqual({ gate: 0.5, build: 9.0 });
    expect(scenarioTotal("parallel")).toBeCloseTo(9.5, 10);
    expect(ESTIMATES.parallel.source).toContain("unmeasured");
    expect(ESTIMATES.parallel.source).toContain("$4.15");
    expect(ESTIMATES.parallel.source).toContain("$2.16");
    expect(estimateLines().some((l) => l.includes("parallel") && l.includes("$9.50"))).toBe(true);
  });
  it("SCENARIO_STAGES.parallel is a gate session then a build session on a bare /doug-next --auto", () => {
    const stages = SCENARIO_STAGES.parallel;
    expect(stages.length).toBe(2);
    const [gate, build] = stages;
    expect([gate.kind, gate.name]).toEqual(["session", "gate"]);
    expect([build.kind, build.name]).toEqual(["session", "build"]);
    expect(gate.prompt({ card: { id: "fix-hours" } })).toBe("/doug-next --auto");
    const prompt = build.prompt({ card: { id: "fix-hours" } });
    expect(prompt.startsWith("/doug-next --auto\n")).toBe(true);
    expect(prompt).toContain("I approved the queue");
    expect(prompt).toContain("Do not invoke the doug-board skill at any step: this checkout publishes nothing.");
    expect(build.maxTurns).toBeGreaterThanOrEqual(100);
  });
  it("rehearse.mjs parallel without --spend prints the parallel estimate and spawns nothing", async () => {
    const marker = join(trackedTempDir("rehearse-marker-"), "spawned");
    const claudeBin = makeFakeClaude("", { marker });
    const r = await run(process.execPath, [cli, "parallel"], { env: { ...process.env, DOUG_REHEARSE_CLAUDE: claudeBin } });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("$9.50");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("card parallel-card-queens: prepareFixture for parallel (R02)", () => {
  it.skipIf(!existsSync(CLI))("has fix-hours as a flow card in component duration, add-truncate as a hand card in component strings, workers.max 2, one commit, no plan", async () => {
    const fx = await inLib("prepareFixture", { scenario: "parallel", tempPrefix: TEST_PREFIX });
    tempDirs.push(fx.dir);
    const board = JSON.parse(readFileSync(join(fx.dir, ".doug/board.json"), "utf8"));
    const ready = board.cards.filter((c) => c.column === "ready");
    expect(ready.map((c) => c.id)).toEqual(["fix-hours", "add-truncate"]);
    const [flow, hand] = ready;
    expect(flow.track).not.toBe("hand");
    expect(hand.track).toBe("hand");
    expect([flow.component, hand.component]).toEqual(["duration", "strings"]);
    expect(board.components).toEqual(expect.arrayContaining(["duration", "strings"]));
    for (const c of ready) expect([c.size, c.class], c.id).toEqual(["S", "code"]);
    const tasks = JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks;
    expect(hand.goal).toBe(tasks.find((t) => t.id === "add-truncate").prompt);
    const config = JSON.parse(readFileSync(join(fx.dir, ".doug/config.json"), "utf8"));
    expect(config.workers.max).toBe(2);
    expect(existsSync(join(fx.dir, ".doug/plan.json"))).toBe(false);
    expect((await git(fx.dir, "log", "--oneline")).split("\n").filter(Boolean).length).toBe(1);
    expect(fx.baseline).toBe(await git(fx.dir, "rev-parse", "HEAD"));
    expect(fx.card.id).toBe("fix-hours");
  });
});

describe("card parallel-card-queens: the parallel gate stage (R03)", () => {
  const assistantLine = (content) => JSON.stringify({ type: "assistant", message: { content } }) + "\n";
  it.skipIf(!existsSync(CLI))("passes on an untouched fixture, fails when a card moved, and fails on any Workflow tool_use", async () => {
    const { dir, card } = await inLib("prepareFixture", { scenario: "parallel", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    const base = cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] });
    const good = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.parallel[0]" }, { dir, card, claudeBin: makeFakeClaude(base) });
    expect(good.ok, good.message).toBe(true);

    const launched = base + assistantLine([{ type: "tool_use", id: "w1", name: "Workflow", input: { name: "doug-flow:doug-implement", args: {} } }]);
    const bad = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.parallel[0]" }, { dir, card, claudeBin: makeFakeClaude(launched) });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("Workflow");

    const board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
    board.cards.find((c) => c.id === "add-truncate").column = "flow";
    writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2));
    const moved = await inLib("runSessionStage", { $expr: "lib.SCENARIO_STAGES.parallel[0]" }, { dir, card, claudeBin: makeFakeClaude(base) });
    expect(moved.ok).toBe(false);
    expect(moved.message).toContain("add-truncate");
  });
});

describe("card parallel-card-queens: assertParallelBuilt (R04)", () => {
  const assistant = (content) => JSON.stringify({ type: "assistant", message: { content } }) + "\n";
  const toolUse = (name, input) => assistant([{ type: "tool_use", id: `t-${Math.random().toString(36).slice(2)}`, name, input }]);
  const implementLaunch = () => toolUse("Workflow", { name: "doug-flow:doug-implement", args: { card: "fix-hours" } });
  const queenLaunch = () => toolUse("Workflow", { scriptPath: "/plugin/workflows/card-queen.js", args: { card: "add-truncate" } });
  const flowLand = () => toolUse("Bash", { command: 'node "/plugin/scripts/plan.mjs" land --card fix-hours' });
  const handLand = () => toolUse("Bash", { command: 'node "/plugin/scripts/plan.mjs" land-card add-truncate --branch card/add-truncate --worktree /x' });
  const goodStream = () =>
    cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }) +
    toolUse("Bash", { command: "node autopilot.mjs pick" }) +
    // a Write under .doug is main's own bookkeeping, not a source edit
    toolUse("Write", { file_path: "/fixture/.doug/.state/briefs/fix-hours-result.json", content: "{}" }) +
    implementLaunch() +
    queenLaunch() +
    handLand() +
    flowLand();
  const addTruncate = (dir) => {
    writeFileSync(join(dir, "src/strings.ts"), readFileSync(join(dir, "src/strings.ts"), "utf8") + '\nexport function truncate(input: string, max: number): string {\n  return input.length <= max ? input : input.slice(0, max - 1) + "\\u2026";\n}\n');
    writeFileSync(join(dir, "tests/strings.test.ts"), readFileSync(join(dir, "tests/strings.test.ts"), "utf8").replace("import { slugify }", "import { slugify, truncate }") + '\ndescribe("truncate", () => {\n  it("cuts", () => {\n    expect(truncate("hello world", 5)).toBe("hell\\u2026");\n  });\n});\n');
  };
  async function boardCommit(dir, id, source, message) {
    const mv = await spawnScript(BOARD_MJS, ["move", id, "done", "--source", source, dir]);
    expect(mv.status, mv.stderr).toBe(0);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", message);
  }
  // The hand card lands first (code commit, record --hand, move to done), then the flow card, either as a --no-ff merge
  // of its integration branch (a real flow landing) or, with `linear`, straight onto main (no merge commit).
  async function buildBoth({ linear = false, reports = true } = {}) {
    const { dir, baseline } = await inLib("prepareFixture", { scenario: "parallel", tempPrefix: TEST_PREFIX });
    tempDirs.push(dir);
    addTruncate(dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "feat: truncate");
    const handSha = await git(dir, "rev-parse", "HEAD");
    const rec = await spawnScript(BOARD_MJS, ["record", "add-truncate", "--hand", "--commit", handSha, "--gate", "typecheck 0; unit 3 passed", dir, "--summary", "Test summary."]);
    expect(rec.status, rec.stderr).toBe(0);
    await boardCommit(dir, "add-truncate", `commit ${handSha}`, `Board: add-truncate done as ${handSha.slice(0, 7)}`);
    if (linear) {
      fixDurationBug(dir);
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "fix: hours multiplier");
      const sha = await git(dir, "rev-parse", "HEAD");
      await boardCommit(dir, "fix-hours", `commit ${sha}`, `Board: fix-hours done as ${sha.slice(0, 7)}`);
    } else {
      await git(dir, "checkout", "-q", "-b", "doug/fix-hours", baseline);
      fixDurationBug(dir);
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "fix: hours multiplier");
      const codeSha = await git(dir, "rev-parse", "HEAD");
      await git(dir, "checkout", "-q", "main");
      await git(dir, "merge", "--no-ff", "-q", "-m", "Merge doug/fix-hours", "doug/fix-hours");
      const mergeSha = await git(dir, "rev-parse", "HEAD");
      await boardCommit(dir, "fix-hours", `merge ${mergeSha} (${codeSha})`, `Board: fix-hours done as ${mergeSha.slice(0, 7)}`);
    }
    if (reports) {
      mkdirSync(join(dir, ".doug/.state/reports/fix-hours"), { recursive: true });
      mkdirSync(join(dir, ".doug/.state/reports/add-truncate"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/reports/fix-hours/last-report.json"), JSON.stringify({ ok: true, tasks: [] }));
      writeFileSync(join(dir, ".doug/.state/reports/add-truncate/card-report.json"), JSON.stringify({ ok: true }));
    }
    return { dir, baseline };
  }

  it.skipIf(!existsSync(CLI))("passes a good fake stream: both launches before the first land, the flow card merged with two parents, the hand card landed, per-card reports present", async () => {
    const { dir, baseline } = await buildBoth();
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream: goodStream() });
    expect(result.ok, result.message).toBe(true);
    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, "tests/heldout-fix-hours.test.ts"))).toBe(false);
    expect(existsSync(join(dir, "tests/heldout-add-truncate.test.ts"))).toBe(false);
  });
  it.skipIf(!existsSync(CLI))("fails when the card-queen launch comes after the first land call, even though every card is built", async () => {
    const { dir, baseline } = await buildBoth();
    const stream =
      cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }) + implementLaunch() + flowLand() + queenLaunch() + handLand();
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/card-queen|before|land/i);
  });
  it.skipIf(!existsSync(CLI))("fails when the doug-implement launch comes after the first land-card call", async () => {
    const { dir, baseline } = await buildBoth();
    const stream =
      cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }) + queenLaunch() + handLand() + implementLaunch() + flowLand();
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/doug-implement|before|land/i);
  });
  it.skipIf(!existsSync(CLI))("fails when no queen was launched at all", async () => {
    const { dir, baseline } = await buildBoth();
    const stream = cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }) + handLand() + flowLand();
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
  });
  it.skipIf(!existsSync(CLI))("fails naming fix-hours when its per-card report is missing", async () => {
    const { dir, baseline } = await buildBoth();
    // Changed (coordinator fix pass): delete only the named report and leave queen-args.json behind, as a real run does.
    rmSync(join(dir, ".doug/.state/reports/fix-hours/last-report.json"), { force: true });
    writeFileSync(join(dir, ".doug/.state/reports/fix-hours/queen-args.json"), "{}");
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream: goodStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fix-hours");
  });
  it.skipIf(!existsSync(CLI))("fails naming add-truncate when its per-card report is missing", async () => {
    const { dir, baseline } = await buildBoth();
    // Changed (coordinator fix pass): delete only the named report and leave queen-args.json behind.
    rmSync(join(dir, ".doug/.state/reports/add-truncate/card-report.json"), { force: true });
    writeFileSync(join(dir, ".doug/.state/reports/add-truncate/queen-args.json"), "{}");
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream: goodStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("add-truncate");
  });
  it.skipIf(!existsSync(CLI))("fails naming src/ when main itself edited a source file", async () => {
    const { dir, baseline } = await buildBoth();
    const stream = goodStream() + toolUse("Edit", { file_path: join(dir, "src/duration.ts"), old_string: "a", new_string: "b" });
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("src/");
  });
  it.skipIf(!existsSync(CLI))("fails naming src/ when main wrote a source file with Write", async () => {
    const { dir, baseline } = await buildBoth();
    const stream = goodStream() + toolUse("Write", { file_path: join(dir, "src/strings.ts"), content: "x" });
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("src/");
  });
  // Added (coordinator fix pass): a subagent's calls appear in main's stream with a parent_tool_use_id; they are not main's edits.
  it.skipIf(!existsSync(CLI))("passes when an Edit on src/ carries a parent_tool_use_id (a subagent's call, not main's)", async () => {
    const { dir, baseline } = await buildBoth();
    const sub = JSON.stringify({ type: "assistant", parent_tool_use_id: "agent-1", message: { content: [{ type: "tool_use", id: "s1", name: "Edit", input: { file_path: join(dir, "src/duration.ts"), old_string: "a", new_string: "b" } }] } }) + "\n";
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream: goodStream() + sub });
    expect(result.ok, result.message).toBe(true);
  });
  // Added: launch detection reads the Workflow input's name or scriptPath only, not other fields such as args.
  it.skipIf(!existsSync(CLI))("fails when card-queen appears only in a launch's args, not its name or scriptPath", async () => {
    const { dir, baseline } = await buildBoth();
    const sneaky = toolUse("Workflow", { name: "doug-flow:other", args: { note: "card-queen" } });
    const stream = cannedStream({ plugins: ["doug-flow"], commands: ["doug-flow:doug-next"] }) + implementLaunch() + sneaky + handLand() + flowLand();
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/card-queen/);
  });
  it.skipIf(!existsSync(CLI))("fails naming AskUserQuestion when the stream carries one", async () => {
    const { dir, baseline } = await buildBoth();
    const stream = goodStream() + toolUse("AskUserQuestion", { questions: [] });
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("AskUserQuestion");
  });
  it.skipIf(!existsSync(CLI))("fails naming parents when the flow card landed as a plain commit, not a merge with two parents", async () => {
    const { dir, baseline } = await buildBoth({ linear: true });
    const result = await inLib("assertParallelBuilt", { dir, baseline, stream: goodStream() });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/parent/i);
  });
});
