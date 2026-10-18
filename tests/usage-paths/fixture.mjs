// Shared helpers for the usage-path scenario suite (card usage-path-scenarios). No model runs anywhere here:
// every scenario drives a real script against a temp project with canned inputs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const FLOW = join(ROOT, "plugins", "doug-flow");
export const SCRIPTS = join(FLOW, "scripts");
export const NOTE_PATH = join(ROOT, "docs", "research", "usage-path-scenarios.md");

export const tmp = (prefix = "doug-up-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
export const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};

// CLAUDE_PROJECT_DIR is pinned so a parent session's value never aims a script at another repo.
function cli(script) {
  return (dir, ...args) =>
    spawnSync(process.execPath, [join(SCRIPTS, script), ...args, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, DOUG_OLLAMA_BASE_URL: "http://127.0.0.1:1" },
    });
}
export const autopilot = cli("autopilot.mjs");
// board.mjs and plan.mjs take the project dir as a positional argument.
function positional(script) {
  return (dir, ...args) =>
    spawnSync(process.execPath, [join(SCRIPTS, script), ...args, dir], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "", DOUG_OLLAMA_BASE_URL: "http://127.0.0.1:1" },
    });
}
export const boardCli = positional("board.mjs");
export const planCli = positional("plan.mjs");
export const memoryCli = positional("memory.mjs");

export function boardOf() {
  return {
    version: 1,
    updated: "2026-10-01",
    columns: [{ id: "backlog", title: "Backlog" }, { id: "ready", title: "Ready" }, { id: "flow", title: "In flow" }, { id: "done", title: "Done" }],
    components: ["flow"],
    cards: [
      { id: "base", column: "done", component: "flow", title: "Base", size: "S", source: "commit 1111111", goal: "done already" },
      { id: "waits", column: "ready", component: "flow", title: "Waits", size: "S", deps: ["later"], goal: "waits on a card that is not done" },
      { id: "hand-one", column: "ready", component: "flow", title: "Hand one", size: "S", track: "hand", deps: ["base"], goal: "the first hand card" },
      { id: "flow-one", column: "ready", component: "flow", title: "Flow one", size: "M", deps: [], goal: "the first flow card" },
      { id: "flow-two", column: "ready", component: "flow", title: "Flow two", size: "M", deps: [], goal: "the second flow card" },
      { id: "flow-three", column: "ready", component: "flow", title: "Flow three", size: "M", deps: [], goal: "the third flow card" },
      { id: "later", column: "backlog", component: "flow", title: "Later", size: "L", goal: "not ready" },
    ],
  };
}

export function boardProject(board = boardOf()) {
  const dir = tmp("doug-up-board-");
  writeJson(join(dir, ".doug/board.json"), board);
  return dir;
}

// A minimal valid plan; `over` is merged on top.
export function planOf(over = {}) {
  const task = (id) => ({ id, title: id.toUpperCase(), spec: `Do the thing for ${id} with a test.`, files: [`src/${id}.ts`] });
  return {
    version: 1,
    title: "Scenario plan",
    goal: "A goal that explains the change in enough words.",
    status: "draft",
    acceptance: ["ok"],
    verify: ["true"],
    tasks: [task("a"), task("b")],
    ...over,
  };
}
export function planProject(over = {}) {
  const dir = tmp("doug-up-plan-");
  writeJson(join(dir, ".doug/plan.json"), planOf(over));
  return dir;
}
