// The contract between Doug and any worker: spec in, diff plus evidence out.
// This file defines the "out" side for the review role. The JSON Schema is handed to
// `codex exec --output-schema` so the model's final message is constrained to it, and the
// parser validates it again because a schema on the way out is not a guarantee on the way in.

export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ["pass", "fail", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewIssue {
  severity: Severity;
  file: string;
  line?: number;
  description: string;
  /** What the reviewer ran or read that shows the problem. */
  evidence?: string;
}

/** What the model is asked to return. Everything else in ReviewResult is measured by the adapter. */
export interface ModelReview {
  verdict: Verdict;
  summary: string;
  issues: ReviewIssue[];
}

/** What a worker (or reviewer) hands back when it stops partway through, at the harness's direction. */
export interface Handoff {
  completed: string[];
  remaining: string[];
  next: string;
  verify: string;
}

export interface CommandRun {
  command: string;
  /** Exit status as reported by the Codex event stream. null if it never completed. */
  exitCode: number | null;
  ok: boolean;
  outputTail?: string;
}

export interface ReviewResult {
  /**
   * Same as the model's verdict when the review ran; "inconclusive" for every failure mode. The adapter
   * turns a `fail` into `pass` when every blocker was downgraded under R12 (see `downgraded`); a `fail`
   * with nothing downgraded is left alone.
   */
  verdict: Verdict;
  summary: string;
  issues: ReviewIssue[];
  /** Commands Codex actually executed, with the exit codes it observed. Never from the model's prose. */
  commandsRun: CommandRun[];
  /** Files in base...head as computed by git, so the reviewer's scope claims can be checked. */
  changedFiles: string[];
  base: string;
  head: string;
  dir: string;
  reviewer: "codex";
  model: string | null;
  sandbox: Sandbox;
  /** null when the review completed; otherwise why it did not. */
  error: ReviewError | null;
  codexExitCode: number | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  /**
   * The nesting guard: `name` is the environment variable the adapter sets on the worker it spawns
   * (`DOUG_CODEX_REVIEW`); `passed` is true once the adapter attempted to spawn codex with the marker
   * in its environment; `inherited` is true when the adapter's own process environment already had
   * the variable set to a non-empty value (this review is running inside another codex-review).
   */
  marker: { name: string; passed: boolean; inherited: boolean };
  /** True when the worker stopped at a boundary rather than finishing (R13); absent or false otherwise. */
  partial?: boolean;
  /** Present when partial is true: what a fresh worker needs to pick the remaining work up (R13). */
  handoff?: Handoff;
  /**
   * Present only when `enforceBlockerEvidence` (contract.ts) downgraded at least one blocker for lacking
   * R12 evidence: `index` into `issues` (now `major`) and the reason it was downgraded.
   */
  downgraded?: { index: number; reason: string }[];
}

export type ReviewError =
  | { kind: "codex-not-found"; message: string }
  | { kind: "codex-failed"; message: string; stderrTail: string }
  | { kind: "timeout"; message: string }
  | { kind: "no-final-message"; message: string }
  | { kind: "unparseable"; message: string; raw: string }
  | { kind: "git"; message: string }
  /** The reviewer changed the working tree it was reviewing; its verdict cannot be trusted. */
  | { kind: "worktree-modified"; message: string; changes: string[] };

export const SANDBOXES = ["read-only", "workspace-write"] as const;
export type Sandbox = (typeof SANDBOXES)[number];

/**
 * Codex 0.155.1 accepts `-c model_reasoning_effort=<level>` on `codex exec` at argv-parse time but does not
 * validate the value itself (an unknown level loads fine), so codex-review rejects one that is not one of
 * these five documented levels. The binary's own model catalog lists no `minimal` and adds `max`/`ultra` for
 * some models; neither is verified for use here, so this stays the documented set.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * JSON Schema for the model's final message. Codex passes it to the API in strict mode, which requires
 * every property to be listed in `required`; optional fields are therefore nullable rather than absent.
 */
export const MODEL_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "issues"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "description", "evidence"],
        properties: {
          severity: { type: "string", enum: [...SEVERITIES] },
          file: { type: "string" },
          line: { type: ["integer", "null"], description: "1-based line in file, or null" },
          description: { type: "string" },
          evidence: { type: ["string", "null"], description: "the command or observation that demonstrates the issue, or null" },
        },
      },
    },
  },
} as const;

/** Validates a parsed final message. Returns the normalized review or an error string. */
export function validateModelReview(value: unknown): { review: ModelReview } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "final message is not a JSON object" };
  const v = value as Record<string, unknown>;
  if (!VERDICTS.includes(v.verdict as Verdict)) return { error: `verdict must be one of ${VERDICTS.join(", ")}` };
  if (typeof v.summary !== "string") return { error: "summary must be a string" };
  if (!Array.isArray(v.issues)) return { error: "issues must be an array" };
  const issues: ReviewIssue[] = [];
  for (const [i, raw] of v.issues.entries()) {
    if (!raw || typeof raw !== "object") return { error: `issues[${i}] must be an object` };
    const it = raw as Record<string, unknown>;
    if (!SEVERITIES.includes(it.severity as Severity)) return { error: `issues[${i}].severity must be one of ${SEVERITIES.join(", ")}` };
    if (typeof it.file !== "string") return { error: `issues[${i}].file must be a string` };
    if (typeof it.description !== "string" || !it.description.trim()) return { error: `issues[${i}].description must be a non-empty string` };
    const issue: ReviewIssue = { severity: it.severity as Severity, file: it.file, description: it.description };
    if (typeof it.line === "number" && Number.isInteger(it.line)) issue.line = it.line;
    if (typeof it.evidence === "string" && it.evidence) issue.evidence = it.evidence;
    issues.push(issue);
  }
  return { review: { verdict: v.verdict as Verdict, summary: v.summary, issues } };
}

/** Exit code for the CLI: 0 no blockers, 1 blockers or a fail verdict, 2 could not review. */
export function exitCodeFor(result: ReviewResult): number {
  if (result.error) return 2;
  if (result.verdict === "inconclusive") return 2;
  if (result.verdict === "fail" || result.issues.some((i) => i.severity === "blocker")) return 1;
  return 0;
}
