// The rehearsal runner's autopilot (auto) and swarm scenarios, split from tests/rehearse.test.mjs (card
// split-git-hooks-rehearse-tests) to balance runtime: the implement-stage prompts, the auto scenario's registry,
// fixture, gate stage, build assertion and end-to-end pass with a fake claude, and the swarm scenario's splittable
// task and held-out land test. Never spawns the real claude binary; every temp directory is removed in afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { writeFileSync, readFileSync, chmodSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ESTIMATES, SCENARIOS, CLI, BOARD_MJS, TASKS_FILE, scenarioTotal, prepareFixture, runSessionStage, runActStage, SCENARIO_STAGES, rehearsalNote } from "../scripts/rehearse-lib.mjs";
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
