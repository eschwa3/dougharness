// scripts/e2e-cards.mjs (docs/specs/ci-e2e architecture 4.4): findings become Backlog cards through the doug board CLI.
// Every case works in a temp dir made with `doug board init`, never the repository's board, and always passes --dir.
import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { here, trackedTempDir, run, tempDirs } from "./rehearse-fixtures.mjs";
import { loadBoard } from "../plugins/doug-flow/lib/board.mjs";
import { cardIdFor, goalFor, planCards } from "../scripts/e2e-cards.mjs";

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const script = join(here, "..", "scripts", "e2e-cards.mjs");
const bin = join(here, "..", "packages", "doug-cli", "dist", "bin.js");
const built = existsSync(bin);

const finding = (scenario, stage, extra = {}) => ({
  key: `${scenario}/${stage}/m`,
  scenario,
  stage,
  assertion: "a",
  message: "it broke",
  commit: "abc1234",
  kind: "stage",
  suspect: "harness",
  replayFile: "tests/replay/scenarios/x.mjs",
  reproduce: `node scripts/rehearse.mjs ${scenario}`,
  source: "replay",
  at: "2026-10-24T00:00:00Z",
  ...extra,
});

async function makeDir() {
  const dir = trackedTempDir("e2e-cards-test-");
  const r = await run(process.execPath, [bin, "board", "init", dir]);
  if (r.status !== 0) throw new Error(`board init failed: ${r.stderr}`);
  return dir;
}
function writeFindings(dir, findings) {
  const file = join(dir, "findings.json");
  writeFileSync(file, JSON.stringify(findings));
  return file;
}
const cards = (dir) => loadBoard(dir).cards;

describe("cardIdFor and goalFor", () => {
  it("slugs the stage and names the journey", () => {
    expect(cardIdFor(finding("hand", "Land Step!"))).toBe("e2e-hand-land-step");
    expect(cardIdFor(finding("journey", "step-3"))).toBe("e2e-journey-step-3");
  });
});

describe("e2e-cards", () => {
  it.skipIf(!built)("C01 two findings with distinct ids are filed as the top two Backlog cards", async () => {
    const dir = await makeDir();
    const file = writeFindings(dir, [finding("a", "one"), finding("b", "two")]);
    const r = await run(process.execPath, [script, file, "--dir", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("filed e2e-a-one");
    expect(r.stdout).toContain("filed e2e-b-two");
    const backlog = cards(dir).filter((c) => c.column === "backlog");
    expect(backlog.slice(0, 2).map((c) => c.id).sort()).toEqual(["e2e-a-one", "e2e-b-two"]);
    expect(backlog[0].id).toBe("e2e-b-two");
  });

  it.skipIf(!built)("C02 a second run prints two skipped lines and adds no card", async () => {
    const dir = await makeDir();
    const file = writeFindings(dir, [finding("a", "one"), finding("b", "two")]);
    await run(process.execPath, [script, file, "--dir", dir]);
    const before = cards(dir).length;
    const r = await run(process.execPath, [script, file, "--dir", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skipped e2e-a-one: card exists");
    expect(r.stdout).toContain("skipped e2e-b-two: card exists");
    expect(cards(dir).length).toBe(before);
  });

  it.skipIf(!built)("C03 a third finding with an existing id prints folded into", async () => {
    const dir = await makeDir();
    const file = writeFindings(dir, [finding("a", "one"), finding("b", "two"), finding("a", "one", { key: "a/one/other" })]);
    const r = await run(process.execPath, [script, file, "--dir", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("folded into e2e-a-one: a/one/other");
    expect(cards(dir).filter((c) => c.id.startsWith("e2e-")).length).toBe(2);
  });

  it.skipIf(!built)("C04 a Done e2e-x-y makes e2e-x-y-1 with a goal saying regression of e2e-x-y", async () => {
    const dir = await makeDir();
    const file = writeFindings(dir, [finding("x", "y")]);
    await run(process.execPath, [script, file, "--dir", dir]);
    const mv = await run(process.execPath, [bin, "board", "move", "e2e-x-y", "done", dir]);
    expect(mv.status).toBe(0);
    const r = await run(process.execPath, [script, file, "--dir", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("filed e2e-x-y-1");
    const card = cards(dir).find((c) => c.id === "e2e-x-y-1");
    expect(card.column).toBe("backlog");
    expect(card.goal).toContain("regression of e2e-x-y");
  });

  it.skipIf(!built)("C05 a suspect replay goal names replayFile", async () => {
    const dir = await makeDir();
    const file = writeFindings(dir, [finding("a", "one", { suspect: "replay", replayFile: "tests/replay/scenarios/a.mjs" })]);
    const r = await run(process.execPath, [script, file, "--dir", dir]);
    expect(r.status).toBe(0);
    const card = cards(dir).find((c) => c.id === "e2e-a-one");
    expect(card.goal).toContain("the replay may be wrong: tests/replay/scenarios/a.mjs");
    expect(goalFor(finding("a", "one"))).not.toContain("the replay may be wrong");
  });

  it.skipIf(!built)("C06 a missing file prints no findings and exits 0", async () => {
    const dir = await makeDir();
    const r = await run(process.execPath, [script, join(dir, "nope.json"), "--dir", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("no findings");
  });

  it("C04b a duplicate of a regression-filed id folds into the suffixed card", () => {
    const board = { cards: [{ id: "e2e-x-y", column: "done" }] };
    const steps = planCards([finding("x", "y"), finding("x", "y", { key: "x/y/second" })], board);
    expect(steps.map((s) => [s.action, s.id])).toEqual([["add", "e2e-x-y-1"], ["fold", "e2e-x-y-1"]]);
  });

  it("C07 the script source contains no writeFileSync", () => {
    expect(readFileSync(script, "utf8")).not.toContain("writeFileSync");
  });
});
