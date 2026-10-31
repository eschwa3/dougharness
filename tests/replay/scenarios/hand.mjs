// Replay script for the hand scenario (the ci-e2e spec 4.2): the gate session stops at the
// gate, the build session fixes the card, commits, records the hand landing and moves the card to Done. Written
// by hand per stage after makeHandScenarioFake (tests/rehearse.test.mjs); no archived stream is copied.
//
// The helpers below are shared by auto, hard-hand and hard-auto, which import this file.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../../../scripts/rehearse-lib.mjs";
import { boardCli, commit, edit, writeFile } from "../lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const failStage = "gate";
export const skills = ["plugins/doug-flow/skills/doug-next/SKILL.md", "plugins/doug-flow/skills/doug-hand/SKILL.md"];
export const writesWorkflowOutput = false;

// ---- Shared helpers ----------------------------------------------------------------------------------------

// The init event the assertions read is the first line of the stream, and the fake writes it before a step runs
// with no slash commands. Rewrite that line so the session offers the commands it was started with.
export function offer(stream, ...commands) {
  const init = JSON.parse(stream.lines[0]);
  init.slash_commands = commands;
  stream.lines[0] = JSON.stringify(init);
  writeFileSync(stream.path, stream.text());
}

// A Bash command the session ran itself: the tool_use line, the fixture's PreToolUse hooks for Bash (guard-bash
// records the command, which the Stop gate's evidence check reads; "replay" is the session id the fake's Stop
// payload carries), then the command for real. A hook that denies it, or a command that fails, throws.
export function ran(dir, stream, command) {
  stream.toolUse("Bash", { command });
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  } catch {
    settings = {};
  }
  const payload = JSON.stringify({ session_id: "replay", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, transcript_path: stream.path });
  for (const entry of (settings.hooks && settings.hooks.PreToolUse) || []) {
    if (entry.matcher && !new RegExp(`^(?:${entry.matcher})$`).test("Bash")) continue;
    for (const h of entry.hooks || []) {
      const r = spawnSync("sh", ["-c", h.command], { cwd: dir, env: cleanEnv({ CLAUDE_PROJECT_DIR: dir }), input: payload, encoding: "utf8" });
      if (r.status === 2 || /"permissionDecision"\s*:\s*"deny"/.test(r.stdout || "")) throw new Error(`replay: a PreToolUse hook denied "${command}": ${(r.stderr || r.stdout).trim()}`);
    }
  }
  const r = spawnSync("sh", ["-c", command], { cwd: dir, env: cleanEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`replay: "${command}" exited ${r.status}: ${(r.stdout + r.stderr).slice(-400)}`);
  return r.stdout;
}

export function boardCards(dir) {
  return JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8")).cards || [];
}

function gitApply(dir, stream, patchFile, extra = []) {
  stream.toolUse("Bash", { command: `git apply ${[...extra, patchFile].join(" ")}` });
  const r = spawnSync("git", ["apply", ...extra, patchFile], { cwd: dir, env: cleanEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`replay: git apply ${patchFile} failed: ${r.stderr}`);
}

// ts-basic cards, edited by hand the way the live sessions edit them. Any other card is fixed from
// evals/solutions/<fixture>/<card>.patch (the hard tier's ts-rentals), applied inside the fixture.
const BASIC_FIXES = {
  "fix-hours": (dir, stream) => {
    edit(dir, stream, "src/duration.ts", "return n * 60_000; // bug: should be 3_600_000", "return n * 3_600_000;");
    edit(dir, stream, "tests/duration.test.ts", '  it("rejects garbage"', '  it("parses hours", () => {\n    expect(parseDuration("2h")).toBe(7_200_000);\n  });\n  it("rejects garbage"');
  },
  "add-truncate": (dir, stream) => {
    edit(dir, stream, "src/strings.ts", "/** Converts a string to a URL-safe slug. */", '/** Cuts a string to at most max characters, ending in an ellipsis when it was cut. */\nexport function truncate(input: string, max: number): string {\n  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;\n}\n\n/** Converts a string to a URL-safe slug. */');
    edit(dir, stream, "tests/strings.test.ts", 'import { slugify } from "../src/strings.js";', 'import { slugify, truncate } from "../src/strings.js";');
    edit(dir, stream, "tests/strings.test.ts", '  it("strips accents and punctuation"', '  it("truncates with an ellipsis", () => {\n    expect(truncate("hello world", 5)).toBe("hell…");\n  });\n  it("strips accents and punctuation"');
  },
};

BASIC_FIXES["fix-tax-rounding"] = (dir, stream) => {
  edit(dir, stream, "src/billing/tax.ts", '/** The tax on a subtotal', 'import { roundCents } from "../util/money.js";\n\n/** The tax on a subtotal');
  edit(dir, stream, "src/billing/tax.ts", "return Math.floor(subtotalCents * rate);", "return roundCents(subtotalCents * rate);");
  edit(dir, stream, "tests/billing.test.ts", '  it("takes a percent off"', '  it("rounds a fractional cent half up", () => {\n    expect(taxFor(1005, 0.15)).toBe(151);\n  });\n  it("takes a percent off"');
};
BASIC_FIXES["fix-catalog-search"] = (dir, stream) => {
  edit(dir, stream, "src/catalog/catalog.ts", "p.name.includes(query)", "p.name.toLowerCase().includes(query.toLowerCase())");
  edit(dir, stream, "tests/catalog.test.ts", '    expect(searchProducts(catalog, "zzz")).toEqual([]);', '    expect(searchProducts(catalog, "WID")).toEqual([widget]);\n    expect(searchProducts(catalog, "zzz")).toEqual([]);');
};

export function solutionPatch(id) {
  for (const fixture of ["ts-rentals"]) {
    const file = join(REPO, "evals/solutions", fixture, `${id}.patch`);
    if (existsSync(file)) return file;
  }
  return null;
}

export function applyFix(dir, stream, id) {
  if (BASIC_FIXES[id]) return BASIC_FIXES[id](dir, stream);
  const patch = solutionPatch(id);
  if (!patch) throw new Error(`replay: no fix for card ${id}`);
  gitApply(dir, stream, patch);
}

export function must(r, what) {
  if (!r.ok) throw new Error(`replay: ${what} failed: ${r.stderr || r.stdout}`);
  return r;
}

// node plugins/doug-flow/scripts/memory.mjs <args...> (lib.mjs has no helper for it), with its tool_use line.
export function memoryCli(dir, stream, args) {
  const script = join(REPO, "plugins/doug-flow/scripts/memory.mjs");
  stream.toolUse("Bash", { command: ["node", script, ...args].join(" ") });
  const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, env: cleanEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// doug-hand's landing for one card: the code commit, the hand-track record, the move to Done naming the code
// commit as its source, and the board commit after it. `fix` defaults to applyFix; `source` overrides the text of
// the Done move's source (a failing replay points two cards at one commit).
export function landCard(dir, stream, id, { fix = applyFix, source = null } = {}) {
  fix(dir, stream, id);
  const code = commit(dir, stream, `fix: ${id}`);
  if (!code.ok) throw new Error(`replay: the code commit for ${id} was refused: ${code.stderr}`);
  must(boardCli(dir, stream, ["record", id, "--hand", "--commit", code.sha, "--gate", "typecheck 0; unit 1 passed", "--summary", "Replay landing."]), `board record ${id}`);
  must(boardCli(dir, stream, ["move", id, "done", "--source", source || `commit ${code.sha}`]), `board move ${id} done`);
  const board = commit(dir, stream, `Board: ${id} done as ${code.sha.slice(0, 7)}`);
  if (!board.ok) throw new Error(`replay: the board commit for ${id} was refused: ${board.stderr}`);
  return code.sha;
}

// ---- Steps -------------------------------------------------------------------------------------------------

export const steps = [
  {
    stage: "gate",
    match: /^\/doug-next \S+$/,
    run({ stream }) {
      offer(stream, "doug-flow:doug-next");
      stream.toolUse("Read", { file_path: "plugins/doug-flow/skills/doug-next/SKILL.md" });
    },
    // The gate session commits: the held-at-gate assert counts commits.
    fail({ dir, stream }) {
      offer(stream, "doug-flow:doug-next");
      writeFile(dir, stream, "NOTES.md", "the gate session should not have written this\n");
      const c = commit(dir, stream, "gate: went past the gate");
      if (!c.ok) throw new Error(`replay: commit refused: ${c.stderr}`);
    },
  },
  {
    stage: "build",
    match: "I answered Start",
    run({ dir, stream }) {
      offer(stream, "doug-flow:doug-next");
      const card = boardCards(dir).find((c) => c.column === "flow");
      if (!card) throw new Error("replay: no card is in flow");
      landCard(dir, stream, card.id);
      // DOUG_REPLAY_FAIL=build-red (the Stop probe): the session ends with a red test left uncommitted, so the
      // Stop gate blocks and the stage fails by signal.
      if (process.env.DOUG_REPLAY_FAIL === "build-red") {
        const file = existsSync(join(dir, "tests/duration.test.ts")) ? "tests/duration.test.ts" : null;
        if (!file) throw new Error("replay: build-red needs tests/duration.test.ts (the ts-basic fixture)");
        edit(dir, stream, file, '  it("rejects garbage"', '  it("is red", () => {\n    expect(parseDuration("1h")).toBe(0);\n  });\n  it("rejects garbage"');
      }
    },
  },
];
