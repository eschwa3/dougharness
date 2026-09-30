// Runs `codex exec` read-only against a worktree and turns its event stream into a ReviewResult.
// Every failure mode yields verdict "inconclusive" with a typed error; nothing here ever reports a pass
// it did not observe.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPrompt, MAX_EMBEDDED_DIFF_BYTES } from "./prompt.js";
import { parseEvents, extractJsonObject } from "./parse.js";
import { changeFacts, statusSnapshot, checkedOutMismatch } from "./git.js";
import { MODEL_REVIEW_SCHEMA, validateModelReview } from "./schema.js";
import type { ReviewResult, ReviewError, CommandRun, Sandbox, ReasoningEffort } from "./schema.js";
import { enforceBlockerEvidence } from "./contract.js";

export interface ReviewOptions {
  spec: string;
  base: string;
  /** Repository or worktree directory. Codex runs read-only inside it. */
  dir: string;
  head?: string;
  model?: string;
  timeoutMs?: number;
  verifyCommands?: string[];
  /** Executable name or path. Default "codex". Tests point this at a fake. */
  codexBin?: string;
  /** Keep the user's MCP servers from ~/.codex/config.toml. Default false: a reviewer needs none and they cost startup time. */
  keepMcpServers?: boolean;
  /** Extra `-c key=value` overrides passed through to codex. */
  configOverrides?: string[];
  /**
   * Codex sandbox. Default "workspace-write": test runners need scratch files (Vitest bundles its config next to it,
   * which fails with EPERM under "read-only"). Codex keeps .git read-only in both modes, and the adapter compares
   * `git status` before and after: any change to the working tree makes the result "inconclusive" with kind
   * "worktree-modified". Pass "read-only" for projects whose checks never write.
   */
  sandbox?: Sandbox;
  /**
   * Whether to pass `-c sandbox_workspace_write.network_access=true`, which lets a verify command bind a
   * localhost port under the workspace-write sandbox. An explicit true/false wins; undefined applies the
   * default rule in {@link resolveNetworkAccess}. Codex ignores the override under "read-only".
   */
  networkAccess?: boolean;
  /** Reasoning effort override, passed as `-c model_reasoning_effort=<level>`. Default: whatever the model normally uses. */
  effort?: ReasoningEffort;
}

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SANDBOX: Sandbox = "workspace-write";

/** Environment variable the adapter sets on every codex it spawns, so a check that suite spawns can detect nesting and skip. */
export const REVIEW_MARKER = "DOUG_CODEX_REVIEW";

/** The `-c` override that lets a verify command bind a localhost port under the workspace-write sandbox. */
export const NETWORK_ACCESS_OVERRIDE = "sandbox_workspace_write.network_access=true";

/**
 * Whether codexArgs should pass NETWORK_ACCESS_OVERRIDE: false whenever the effective sandbox is not
 * "workspace-write" (Codex ignores the override under read-only, so it is never passed); otherwise an
 * explicit `networkAccess` boolean wins; otherwise on when at least one verify command is given.
 */
export function resolveNetworkAccess(opts: { sandbox?: Sandbox; verifyCommands?: string[]; networkAccess?: boolean }): boolean {
  const sandbox = opts.sandbox || DEFAULT_SANDBOX;
  if (sandbox !== "workspace-write") return false;
  if (typeof opts.networkAccess === "boolean") return opts.networkAccess;
  return (opts.verifyCommands || []).length > 0;
}

/** The `-c` override for a reasoning-effort level, e.g. `model_reasoning_effort=low`. */
export function reasoningEffortOverride(level: ReasoningEffort): string {
  return `model_reasoning_effort=${level}`;
}

/** The argv for `codex exec`, exposed so tests can assert the sandbox and schema are always present. */
export function codexArgs(opts: {
  schemaFile: string;
  lastMessageFile: string;
  dir: string;
  model?: string;
  keepMcpServers?: boolean;
  configOverrides?: string[];
  sandbox?: Sandbox;
  networkAccess?: boolean;
  effort?: ReasoningEffort;
}): string[] {
  const args = ["exec", "--json", "--ephemeral", "--sandbox", opts.sandbox || DEFAULT_SANDBOX, "--skip-git-repo-check", "--color", "never", "-C", opts.dir, "--output-schema", opts.schemaFile, "-o", opts.lastMessageFile];
  if (opts.model) args.push("-m", opts.model);
  if (!opts.keepMcpServers) args.push("-c", "mcp_servers={}");
  // Pushed before the caller's configOverrides, so an explicit caller override for the same key comes later.
  // That a later -c wins for a repeated key in codex is assumed, unverified against codex-cli 0.155.1.
  if (opts.networkAccess) args.push("-c", NETWORK_ACCESS_OVERRIDE);
  if (opts.effort) args.push("-c", reasoningEffortOverride(opts.effort));
  for (const o of opts.configOverrides || []) args.push("-c", o);
  args.push("-"); // prompt on stdin: no argv length limit, no shell quoting
  return args;
}

export async function runCodexReview(opts: ReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const dir = resolve(opts.dir);
  const head = opts.head || "HEAD";
  const inherited = !!process.env[REVIEW_MARKER];
  const base: Omit<ReviewResult, "verdict" | "summary" | "issues" | "commandsRun" | "error" | "codexExitCode" | "durationMs" | "usage" | "changedFiles"> = {
    base: opts.base,
    head,
    dir,
    reviewer: "codex",
    model: opts.model || null,
    sandbox: opts.sandbox || DEFAULT_SANDBOX,
    marker: { name: REVIEW_MARKER, passed: false, inherited },
  };
  const fail = (error: ReviewError, extra: Partial<ReviewResult> = {}): ReviewResult => ({
    ...base,
    verdict: "inconclusive",
    summary: error.message,
    issues: [],
    commandsRun: [],
    changedFiles: [],
    error,
    codexExitCode: null,
    usage: null,
    ...extra,
    durationMs: Date.now() - started,
  });

  let facts;
  let before: string[];
  let mismatch: string | null;
  try {
    facts = changeFacts(dir, opts.base, head);
    mismatch = checkedOutMismatch(dir, head);
    before = statusSnapshot(dir);
  } catch (e: any) {
    const msg = String(e && e.stderr ? e.stderr : e && e.message ? e.message : e).trim();
    return fail({ kind: "git", message: `git diff ${opts.base}...${head} failed in ${dir}: ${msg}` });
  }
  if (mismatch) return fail({ kind: "git", message: mismatch }, { changedFiles: facts.changedFiles });

  const prompt = buildPrompt({
    spec: opts.spec,
    base: opts.base,
    head,
    changedFiles: facts.changedFiles,
    diff: facts.diffBytes <= MAX_EMBEDDED_DIFF_BYTES ? facts.diff : null,
    diffBytes: facts.diffBytes,
    verifyCommands: opts.verifyCommands,
  });

  const tmp = mkdtempSync(join(tmpdir(), "codex-review-"));
  const schemaFile = join(tmp, "schema.json");
  const lastMessageFile = join(tmp, "last.txt");
  writeFileSync(schemaFile, JSON.stringify(MODEL_REVIEW_SCHEMA));
  const networkAccess = resolveNetworkAccess({ sandbox: opts.sandbox, verifyCommands: opts.verifyCommands, networkAccess: opts.networkAccess });
  const args = codexArgs({ schemaFile, lastMessageFile, dir, model: opts.model, keepMcpServers: opts.keepMcpServers, configOverrides: opts.configOverrides, sandbox: opts.sandbox, networkAccess, effort: opts.effort });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const spawned = await spawnCollect(opts.codexBin || "codex", args, prompt, dir, timeoutMs);
  rmSync(tmp, { recursive: true, force: true });
  const parsed = parseEvents(spawned.stdout);
  const withEvidence: Partial<ReviewResult> = { commandsRun: parsed.commandsRun, changedFiles: facts.changedFiles, usage: parsed.usage, codexExitCode: spawned.exitCode, marker: { name: REVIEW_MARKER, passed: true, inherited } };

  if (spawned.notFound) return fail({ kind: "codex-not-found", message: `${opts.codexBin || "codex"} is not installed or not on PATH` }, { changedFiles: facts.changedFiles, marker: { name: REVIEW_MARKER, passed: true, inherited } });

  // A reviewer that changed what it reviewed has no verdict worth reading, whatever it says.
  let after: string[] = [];
  try {
    after = statusSnapshot(dir);
  } catch {
    after = before;
  }
  const changes = [...after.filter((l) => !before.includes(l)).map((l) => `+ ${l}`), ...before.filter((l) => !after.includes(l)).map((l) => `- ${l}`)];
  if (changes.length) {
    return fail({ kind: "worktree-modified", message: `the reviewer changed the working tree in ${dir}: ${changes.join("; ")}`, changes }, withEvidence);
  }
  if (spawned.timedOut) return fail({ kind: "timeout", message: `codex exec exceeded ${timeoutMs} ms and was killed` }, withEvidence);
  if (spawned.exitCode !== 0) {
    // Codex reports API errors as JSONL `error` events on stdout; stderr is usually empty.
    const detail = parsed.errors.length ? parsed.errors.join("\n") : spawned.stderr;
    return fail({ kind: "codex-failed", message: `codex exec exited ${spawned.exitCode}${parsed.errors.length ? `: ${parsed.errors[0].slice(0, 300)}` : ""}`, stderrTail: detail.slice(-2000) }, withEvidence);
  }
  if (parsed.finalMessage === null) return fail({ kind: "no-final-message", message: "codex produced no final agent message" }, withEvidence);
  const obj = extractJsonObject(parsed.finalMessage);
  if (obj === null) return fail({ kind: "unparseable", message: "final message is not JSON", raw: parsed.finalMessage.slice(0, 4000) }, withEvidence);
  const validated = validateModelReview(obj);
  if ("error" in validated) return fail({ kind: "unparseable", message: validated.error, raw: parsed.finalMessage.slice(0, 4000) }, withEvidence);

  // R12 is enforced here, on the runtime's own commandsRun, never the model's claims: an evidence-free
  // blocker is downgraded to major rather than trusted or silently dropped (docs/worker-contract.md rule 8).
  return enforceBlockerEvidence({
    ...base,
    ...validated.review,
    commandsRun: parsed.commandsRun,
    changedFiles: facts.changedFiles,
    error: null,
    codexExitCode: spawned.exitCode,
    usage: parsed.usage,
    durationMs: Date.now() - started,
    marker: { name: REVIEW_MARKER, passed: true, inherited },
  });
}

interface Spawned {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  notFound: boolean;
  timedOut: boolean;
}

function spawnCollect(bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<Spawned> {
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let notFound = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", [REVIEW_MARKER]: "1" } });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ stdout, stderr, exitCode, notFound, timedOut });
    };
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") notFound = true;
      else stderr += String(err.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** Convenience for callers that only want the CommandRun list from a raw event log. */
export function commandsFromEvents(jsonl: string): CommandRun[] {
  return parseEvents(jsonl).commandsRun;
}
