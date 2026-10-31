// Helpers for the hand-written replay fake tests/replay/claude (the ci-e2e spec 4.1,
// pseudocode 1 and 2). A scenario file builds one stream per session with Stream, makes its edits, commits and
// Doug CLI calls through the helpers here (each also writes the matching tool_use line), and the fake then runs
// the fixture's Stop hooks. Nothing here calls a model.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../../scripts/rehearse-lib.mjs";
import { integrationBranchFor, integrationWorktreeFor, planPathFor } from "../../plugins/doug-flow/lib/plan.mjs";

export const REPLAY_DIR = dirname(fileURLToPath(import.meta.url));
export const FAKE = join(REPLAY_DIR, "claude");
const REPO = resolve(REPLAY_DIR, "..", "..");
const PLAN_MJS = join(REPO, "plugins/doug-flow/scripts/plan.mjs");
const BOARD_MJS = join(REPO, "plugins/doug-flow/scripts/board.mjs");
const DOUG_BIN = join(REPO, "packages/doug-cli/dist/bin.js");

// ---- Invocation -------------------------------------------------------------------------------------------

// A session stage passes the prompt as the token after -p. A command stage (memory.mjs) passes -p followed by
// flags and writes the prompt to stdin, so mode is "command" when that token is absent or starts with "--".
export function readInvocation(argv, stdin) {
  const i = argv.indexOf("-p");
  const next = i >= 0 ? argv[i + 1] : undefined;
  const mode = next === undefined || next.startsWith("--") ? "command" : "session";
  const flag = (name) => {
    const j = argv.indexOf(name);
    return j >= 0 && j + 1 < argv.length ? argv[j + 1] : null;
  };
  let schema = null;
  const rawSchema = flag("--json-schema");
  if (rawSchema !== null) {
    try {
      schema = JSON.parse(rawSchema);
    } catch {
      schema = null;
    }
  }
  const rawTurns = flag("--max-turns");
  const turns = Number(rawTurns);
  return {
    mode,
    prompt: mode === "command" ? String(stdin ?? "") : next,
    schema,
    maxTurns: rawTurns !== null && Number.isFinite(turns) ? turns : null,
  };
}

// Exactly one step whose match hits the prompt (string: includes; RegExp: test), else an error object.
export function pickStep(steps, prompt) {
  const text = String(prompt);
  const hits = steps.filter((s) => (s.match instanceof RegExp ? s.match.test(text) : typeof s.match === "string" && text.includes(s.match)));
  if (hits.length !== 1) return { error: "replay: no unique step for prompt" };
  return hits[0];
}

// A copy of steps with the one entry whose stage matches merged with patch.
export function withStage(steps, stage, patch) {
  if (!steps.some((s) => s.stage === stage)) throw new Error(`withStage: no step has stage "${stage}"`);
  return steps.map((s) => (s.stage === stage ? { ...s, ...patch } : s));
}

// ---- Stream -----------------------------------------------------------------------------------------------

export class Stream {
  // Every line is also appended to `path`, which becomes the Stop payload's transcript_path. The default lives
  // under os.tmpdir(), never inside the fixture tree (the stop gate scans the tree).
  constructor(path) {
    this.path = path || join(mkdtempSync(join(tmpdir(), "replay-stream-")), "stream.jsonl");
    this.lines = [];
    this.n = 0;
    writeFileSync(this.path, "");
  }
  push(obj) {
    const line = JSON.stringify(obj);
    this.lines.push(line);
    appendFileSync(this.path, `${line}\n`);
  }
  init({ plugins = ["doug-flow", "doug-gates"], slashCommands = [] } = {}) {
    this.push({
      type: "system",
      subtype: "init",
      plugins: plugins.map((name) => ({ name, path: "/x", source: `${name}@inline` })),
      slash_commands: slashCommands,
    });
  }
  toolUse(name, input, { parent = null } = {}) {
    const id = `toolu_replay_${++this.n}`;
    this.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: parent });
    return id;
  }
  toolResult(id, content, { parent = null } = {}) {
    this.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: parent });
  }
  agent(subagentType, { parent = null } = {}) {
    return this.toolUse("Agent", { subagent_type: subagentType, description: `replay ${subagentType}`, prompt: "replay" }, { parent });
  }
  result({ cost = 0, text = "done" } = {}) {
    this.push({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: cost, num_turns: 1 });
  }
  text() {
    return this.lines.length ? `${this.lines.join("\n")}\n` : "";
  }
}

// ---- Actions that also write their tool_use line ----------------------------------------------------------

const abs = (dir, rel) => (isAbsolute(rel) ? rel : join(dir, rel));
const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

export function edit(dir, stream, rel, from, to) {
  const file = abs(dir, rel);
  const body = readFileSync(file, "utf8");
  if (!body.includes(from)) throw new Error(`edit: ${rel} does not contain the text to replace`);
  writeFileSync(file, body.replace(from, () => to));
  stream.toolUse("Edit", { file_path: file, old_string: from, new_string: to });
}

export function writeFile(dir, stream, rel, body) {
  const file = abs(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  stream.toolUse("Write", { file_path: file, content: body });
}

function sh(cmd, args, dir) {
  const r = spawnSync(cmd, args, { cwd: dir, env: cleanEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error.message) : "") };
}

// git add -A; git commit -m. The repository's hooks always run: the commit passes no flag that skips them.
export function commit(dir, stream, message) {
  stream.toolUse("Bash", { command: `git add -A && git commit -m ${shq(message)}` });
  const add = sh("git", ["add", "-A"], dir);
  if (!add.ok) return { ok: false, sha: null, stderr: add.stderr };
  const c = sh("git", ["commit", "-q", "-m", message], dir);
  if (!c.ok) return { ok: false, sha: null, stderr: c.stderr || c.stdout };
  return { ok: true, sha: sh("git", ["rev-parse", "HEAD"], dir).stdout.trim(), stderr: c.stderr };
}

function nodeCli(script, dir, stream, args) {
  stream.toolUse("Bash", { command: ["node", script, ...args].map(shq).join(" ") });
  return sh(process.execPath, [script, ...args], dir);
}
export const planCli = (dir, stream, args) => nodeCli(PLAN_MJS, dir, stream, args);
export const boardCli = (dir, stream, args) => nodeCli(BOARD_MJS, dir, stream, args);
export const dougCli = (dir, stream, args) => nodeCli(DOUG_BIN, dir, stream, args);

// ---- Workflow output --------------------------------------------------------------------------------------

const SCRIPTS = {
  implement: () => join(REPO, "plugins/doug-flow/workflows/doug-implement.js"),
  "card-queen": () => join(REPO, "plugins/doug-flow/workflows/card-queen.js"),
};

function git(dir, args) {
  const r = sh("git", args, dir);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// What the workflow would have written (spec decision 3): the task branches and worktrees, a fix per task, the
// integration branch with every task merged, the report, and the Workflow and Write tool_use lines.
// `fix(worktreeDir, task, stream)` edits and may commit; a left-over dirty tree is committed here.
// `report` is an object, or a function of (plan, { branch }) returning one.
export function writeWorkflowOutput(dir, stream, { kind, cardId, fix, report }) {
  if (!SCRIPTS[kind] && kind !== "queen") throw new Error(`writeWorkflowOutput: unknown kind "${kind}"`);
  const perCard = cardId ? join(dir, ".doug/.state/reports", cardId) : null;
  const cardPlan = cardId ? join(dir, planPathFor(cardId)) : null;
  const planFile = cardPlan && existsSync(cardPlan) ? cardPlan : join(dir, ".doug/plan.json");
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const branch = integrationBranchFor(plan);

  const merged = [];
  for (const task of plan.tasks) {
    const wt = join(dir, ".claude/worktrees", task.id);
    git(dir, ["worktree", "add", "-q", "-B", `doug/task-${task.id}`, wt, "HEAD"]);
    if (fix) fix(wt, task, stream);
    if (sh("git", ["status", "--porcelain"], wt).stdout.trim()) {
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-q", "-m", `${task.id}: replay fix`]);
    }
    merged.push(`doug/task-${task.id}`);
  }
  const integration = join(dir, integrationWorktreeFor(plan));
  if (existsSync(integration)) {
    const have = sh("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], dir).ok;
    git(integration, have ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch, "HEAD"]);
  }
  else git(dir, ["worktree", "add", "-q", "-B", branch, integration, "HEAD"]);
  for (const b of merged) git(integration, ["merge", "-q", "--no-ff", "-m", `Merge ${b}`, b]);

  const body = typeof report === "function" ? report(plan, { branch }) : report;
  const reportPath = kind === "implement" ? join(dir, ".doug/.state/last-report.json") : join(perCard || join(dir, ".doug/.state"), kind === "card-queen" ? "card-report.json" : "last-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  const text = JSON.stringify(body ?? {}, null, 2);
  const scriptPath = kind === "queen" ? join(dir, ".doug/.state/reports", String(cardId), "queen.js") : SCRIPTS[kind]();
  stream.toolUse("Workflow", { scriptPath });
  writeFileSync(reportPath, text);
  stream.toolUse("Write", { file_path: reportPath, content: text });
  return { branch, reportPath };
}

// ---- Stop hooks -------------------------------------------------------------------------------------------

export function runStopHooks(dir, { sessionId = "replay", transcriptPath = null } = {}) {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  } catch {
    return { blocked: false, reason: null, ran: 0 };
  }
  const commands = [];
  for (const entry of (settings.hooks && settings.hooks.Stop) || []) {
    for (const h of (entry && entry.hooks) || []) if (h && typeof h.command === "string") commands.push(h.command);
  }
  const payload = JSON.stringify({ session_id: sessionId, cwd: dir, hook_event_name: "Stop", stop_hook_active: false, transcript_path: transcriptPath });
  let ran = 0;
  for (const command of commands) {
    const r = spawnSync("sh", ["-c", command], { cwd: dir, env: cleanEnv({ CLAUDE_PROJECT_DIR: dir }), input: payload, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    ran++;
    const out = r.stdout || "";
    const last = out.trim().split("\n").filter(Boolean).pop() || "";
    let parsed = null;
    try {
      parsed = JSON.parse(last);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.decision === "block") return { blocked: true, reason: String(parsed.reason || "blocked"), ran };
    if (r.status === 2) return { blocked: true, reason: (r.stderr || out).trim() || "blocked (exit 2)", ran };
  }
  return { blocked: false, reason: null, ran };
}

// ---- Command-stage envelope -------------------------------------------------------------------------------

export function envelope(resultKey, items, extra = {}) {
  return JSON.stringify({ type: "result", is_error: false, structured_output: { [resultKey]: items, ...extra }, total_cost_usd: 0, session_id: "replay" });
}
