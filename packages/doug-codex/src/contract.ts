// The worker contract as code: every rule in docs/worker-contract.md that can be checked on a result
// object is checked here, so any adapter (Codex today; Codex-as-implementer, OpenRouter, local models
// later) is held to the same definition of "diff plus evidence out". The document explains the rules;
// this file is the test oracle. Keep the rule ids in sync with the document.

import { SANDBOXES, SEVERITIES, VERDICTS, exitCodeFor, type ReviewResult } from "./schema.js";

export const ERROR_KINDS = ["codex-not-found", "codex-failed", "timeout", "no-final-message", "unparseable", "git", "worktree-modified"] as const;

/** Rule ids, in the order the document lists them. */
export const CONTRACT_RULES = {
  R1: "verdict is pass | fail | inconclusive; every error is reported as inconclusive",
  R2: "issues are typed: severity in blocker | major | minor, file, non-empty description, optional integer line and string evidence",
  R3: "commandsRun is evidence: each entry has the command, the exit code the runtime observed (or null), and ok that is true only for exit 0",
  R4: "changedFiles is what git computed for base...head: unique, sorted, relative paths",
  R5: "base, head, and dir are non-empty; dir is absolute",
  R6: "the worker names itself: reviewer non-empty, model a string or null, sandbox one of the declared sandboxes",
  R7: "error is null or a typed failure with a kind from the declared list and a non-empty message, plus the kind's own evidence field",
  R8: "measurements are real numbers or null: exit code of the runtime, non-negative duration, token usage",
  R9: "exit codes: 0 no blockers, 1 fail verdict or a blocker issue, 2 could not review (error or inconclusive)",
  R10: "a review that changed the working tree it was reviewing is void: error kind worktree-modified and verdict inconclusive",
  R11: "marker records the nesting guard: name is DOUG_CODEX_REVIEW, passed and inherited are booleans",
  R12: "a blocker cites a command in commandsRun that shows the failure: its evidence names a command that ran, or quotes a line of that command's output (16+ characters), and that command exited non-zero or the evidence quotes a line of its output",
  R13: "partial is absent or a boolean; when true, handoff is an object with completed (array of strings), remaining (non-empty array of non-empty strings), next (non-empty string), and verify (non-empty string), and the result is not a pass (verdict is inconclusive)",
} as const;

export type RuleId = keyof typeof CONTRACT_RULES;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

// The shell wrapper the runtime records around a command (`/bin/zsh -lc '<inner>'`), so evidence that names the
// inner command still matches the entry.
function innerCommand(command: string): string {
  const m = /^\/bin\/(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(command.trim());
  return (m ? m[1] : command).trim();
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// The recorded command a reviewer runs can be an unpasteable, hundreds-of-characters shell wrapper (a
// double-quoted `/bin/zsh -lc "..."` probe, which innerCommand() cannot unwrap); the printed output it
// produced is what a reviewer actually quotes. quotesOutput's 4-char floor is fine once a command is
// already named, but as the sole link between evidence and command a 4-char line ("ok 1", "done") would
// let any blocker cite almost any command, so citing a command by its output alone needs a higher floor.
export const OUTPUT_CITATION_MIN_CHARS = 16;

/** The commandsRun entries a piece of evidence names: the whole recorded command, the command inside its
 * shell wrapper, or (at OUTPUT_CITATION_MIN_CHARS or more) a quoted line of its recorded output. */
export function citedCommands(evidence: string, commandsRun: { command: string; exitCode: number | null; outputTail?: string }[]): typeof commandsRun {
  const ev = squash(evidence);
  return commandsRun.filter((c) => {
    const whole = squash(c.command);
    const inner = squash(innerCommand(c.command));
    return (whole.length > 0 && ev.includes(whole)) || (inner.length >= 4 && ev.includes(inner)) || quotesOutput(evidence, c.outputTail, OUTPUT_CITATION_MIN_CHARS);
  });
}

/** True when the evidence quotes a line of the command's recorded output at least minChars long (squashed). */
export function quotesOutput(evidence: string, outputTail: string | undefined, minChars = 4): boolean {
  if (!outputTail) return false;
  const ev = squash(evidence);
  return outputTail.split("\n").map((l) => squash(l)).some((l) => l.length >= minChars && ev.includes(l));
}

/**
 * R12 for one issue, assumed already known to be a blocker: null when its evidence names a command in
 * commandsRun that exited non-zero or whose output it quotes; otherwise the reason it fails (no index,
 * so a caller wanting "issues[i] <reason>" prepends that itself). Shared by checkReviewResult and
 * enforceBlockerEvidence so the two never drift on what counts as evidence.
 */
export function blockerEvidenceProblem(
  issue: { evidence?: unknown },
  commandsRun: { command: string; exitCode: number | null; outputTail?: string }[],
): string | null {
  const evidence = typeof issue.evidence === "string" ? issue.evidence.trim() : "";
  if (!evidence) return "is a blocker with no evidence; a blocker cites a command in commandsRun that shows the failure";
  const cited = citedCommands(evidence, commandsRun);
  if (!cited.length) return "is a blocker whose evidence names no command in commandsRun and quotes no line of any command's output; static inspection alone is major at most";
  if (!cited.some((c) => (c.exitCode !== null && c.exitCode !== 0) || quotesOutput(evidence, c.outputTail))) {
    const named = cited.map((c) => `${JSON.stringify(innerCommand(c.command))}, which ${c.exitCode === null ? "did not complete" : "exited 0"}`).join(", ");
    return `cites ${named}, and quotes none of its output`;
  }
  return null;
}

/**
 * R12 enforcement: a blocker whose evidence does not meet blockerEvidenceProblem's bar is downgraded to
 * major rather than silently dropped, its description prefixed so the workflow report carries why, and
 * recorded in the returned result's `downgraded`. A `fail` verdict with no blocker left becomes `pass`
 * (the prompt's own rule); `inconclusive` is never changed. Pure: does not mutate `result`.
 */
export function enforceBlockerEvidence(result: ReviewResult): ReviewResult {
  const downgraded: { index: number; reason: string }[] = [];
  const issues = result.issues.map((issue, index) => {
    if (issue.severity !== "blocker") return issue;
    const reason = blockerEvidenceProblem(issue, result.commandsRun);
    if (!reason) return issue;
    downgraded.push({ index, reason });
    return { ...issue, severity: "major" as const, description: `[codex-review: downgraded from blocker, R12: ${reason}] ${issue.description}` };
  });
  const stillBlocked = issues.some((it) => it.severity === "blocker");
  const verdict = result.verdict === "fail" && downgraded.length > 0 && !stillBlocked ? "pass" : result.verdict;
  return { ...result, issues, verdict, ...(downgraded.length ? { downgraded } : {}) };
}

function relPath(p: unknown): boolean {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes("..");
}

/**
 * Returns every violated rule as "R<n>: <detail>". Empty means the result conforms.
 * Accepts unknown so a raw JSON object from a future adapter can be checked without a cast.
 */
export function checkReviewResult(value: unknown): string[] {
  const out: string[] = [];
  const bad = (rule: RuleId, detail: string) => out.push(`${rule}: ${detail}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["R1: result is not an object"];
  const r = value as Record<string, unknown>;

  // R1
  if (!VERDICTS.includes(r.verdict as never)) bad("R1", `verdict ${JSON.stringify(r.verdict)} is not one of ${VERDICTS.join(", ")}`);
  if (r.error !== null && r.verdict !== "inconclusive") bad("R1", `error is set but verdict is ${JSON.stringify(r.verdict)}, not inconclusive`);
  if (typeof r.summary !== "string") bad("R1", "summary must be a string");

  // R2
  if (!Array.isArray(r.issues)) bad("R2", "issues must be an array");
  else {
    r.issues.forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return bad("R2", `issues[${i}] is not an object`);
      const it = raw as Record<string, unknown>;
      if (!SEVERITIES.includes(it.severity as never)) bad("R2", `issues[${i}].severity ${JSON.stringify(it.severity)} is not one of ${SEVERITIES.join(", ")}`);
      if (typeof it.file !== "string") bad("R2", `issues[${i}].file must be a string`);
      if (typeof it.description !== "string" || !it.description.trim()) bad("R2", `issues[${i}].description must be a non-empty string`);
      if (it.line !== undefined && !isInt(it.line)) bad("R2", `issues[${i}].line must be an integer when present`);
      if (it.evidence !== undefined && typeof it.evidence !== "string") bad("R2", `issues[${i}].evidence must be a string when present`);
    });
  }

  // R3
  if (!Array.isArray(r.commandsRun)) bad("R3", "commandsRun must be an array");
  else {
    r.commandsRun.forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return bad("R3", `commandsRun[${i}] is not an object`);
      const c = raw as Record<string, unknown>;
      if (typeof c.command !== "string" || !c.command) bad("R3", `commandsRun[${i}].command must be a non-empty string`);
      if (c.exitCode !== null && !isInt(c.exitCode)) bad("R3", `commandsRun[${i}].exitCode must be an integer or null`);
      if (typeof c.ok !== "boolean") bad("R3", `commandsRun[${i}].ok must be a boolean`);
      else if (c.ok !== (c.exitCode === 0)) bad("R3", `commandsRun[${i}].ok is ${c.ok} but exitCode is ${JSON.stringify(c.exitCode)}`);
      if (c.outputTail !== undefined && typeof c.outputTail !== "string") bad("R3", `commandsRun[${i}].outputTail must be a string when present`);
    });
  }

  // R4
  if (!Array.isArray(r.changedFiles)) bad("R4", "changedFiles must be an array");
  else {
    const files = r.changedFiles as unknown[];
    files.forEach((f, i) => {
      if (!relPath(f)) bad("R4", `changedFiles[${i}] ${JSON.stringify(f)} is not a relative path`);
    });
    const strs = files.filter((f): f is string => typeof f === "string");
    if (new Set(strs).size !== strs.length) bad("R4", "changedFiles has duplicates");
    if (strs.some((f, i) => i > 0 && f < strs[i - 1])) bad("R4", "changedFiles is not sorted");
  }

  // R5
  for (const k of ["base", "head", "dir"]) if (typeof r[k] !== "string" || !(r[k] as string).trim()) bad("R5", `${k} must be a non-empty string`);
  if (typeof r.dir === "string" && !(r.dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(r.dir))) bad("R5", "dir must be absolute");

  // R6
  if (typeof r.reviewer !== "string" || !r.reviewer) bad("R6", "reviewer must be a non-empty string");
  if (r.model !== null && typeof r.model !== "string") bad("R6", "model must be a string or null");
  if (!SANDBOXES.includes(r.sandbox as never)) bad("R6", `sandbox ${JSON.stringify(r.sandbox)} is not one of ${SANDBOXES.join(", ")}`);

  // R7
  if (r.error !== null) {
    if (!r.error || typeof r.error !== "object") bad("R7", "error must be null or an object");
    else {
      const e = r.error as Record<string, unknown>;
      if (!ERROR_KINDS.includes(e.kind as never)) bad("R7", `error.kind ${JSON.stringify(e.kind)} is not one of ${ERROR_KINDS.join(", ")}`);
      if (typeof e.message !== "string" || !e.message.trim()) bad("R7", "error.message must be a non-empty string");
      if (e.kind === "codex-failed" && typeof e.stderrTail !== "string") bad("R7", "error.stderrTail must be a string for kind codex-failed");
      if (e.kind === "unparseable" && typeof e.raw !== "string") bad("R7", "error.raw must be a string for kind unparseable");
      if (e.kind === "worktree-modified" && (!Array.isArray(e.changes) || e.changes.length === 0)) bad("R7", "error.changes must be a non-empty array for kind worktree-modified");
    }
  }

  // R8
  if (r.codexExitCode !== null && !isInt(r.codexExitCode)) bad("R8", "codexExitCode must be an integer or null");
  if (!isInt(r.durationMs) || (r.durationMs as number) < 0) bad("R8", "durationMs must be a non-negative integer");
  if (r.usage !== null) {
    const u = r.usage as Record<string, unknown> | null;
    if (!u || typeof u !== "object" || !isInt(u.inputTokens) || u.inputTokens < 0 || !isInt(u.outputTokens) || u.outputTokens < 0) bad("R8", "usage must be null or { inputTokens, outputTokens } with non-negative integers");
  }

  // R12: a blocker is a demonstrated failure. Its evidence names a command the runtime recorded, or quotes a line
  // of that command's output of OUTPUT_CITATION_MIN_CHARS or more, and that command either exited non-zero or the
  // evidence quotes a line of its output. Static inspection alone is major at most.
  if (Array.isArray(r.issues) && Array.isArray(r.commandsRun)) {
    const runs = (r.commandsRun as unknown[]).filter((c): c is { command: string; exitCode: number | null; outputTail?: string } => !!c && typeof c === "object" && typeof (c as { command?: unknown }).command === "string");
    (r.issues as unknown[]).forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return;
      const it = raw as Record<string, unknown>;
      if (it.severity !== "blocker") return;
      const reason = blockerEvidenceProblem(it, runs);
      if (reason) bad("R12", `issues[${i}] ${reason}`);
    });
  }

  // R12 (downgraded): when present, every entry is an integer index into issues that points at a major
  // issue, with a non-empty reason. enforceBlockerEvidence (contract.ts) is what produces this field.
  if (r.downgraded !== undefined) {
    if (!Array.isArray(r.downgraded)) bad("R12", "downgraded must be an array when present");
    else {
      const issues = Array.isArray(r.issues) ? (r.issues as unknown[]) : [];
      (r.downgraded as unknown[]).forEach((raw, i) => {
        if (!raw || typeof raw !== "object") return bad("R12", `downgraded[${i}] is not an object`);
        const d = raw as Record<string, unknown>;
        if (!isInt(d.index)) {
          bad("R12", `downgraded[${i}].index must be an integer`);
        } else {
          const target = issues[d.index as number] as Record<string, unknown> | undefined;
          if (!target || typeof target !== "object" || target.severity !== "major") bad("R12", `downgraded[${i}].index must point at a major issue`);
        }
        if (typeof d.reason !== "string" || !d.reason.trim()) bad("R12", `downgraded[${i}].reason must be a non-empty string`);
      });
    }
  }

  // R13: partial is graceful degradation, not a pass. A worker (or reviewer) that claims it stopped
  // partway must hand off enough for a fresh worker to pick the remaining work up.
  if (r.partial !== undefined && typeof r.partial !== "boolean") bad("R13", "partial must be a boolean when present");
  if (r.partial === true) {
    const h = r.handoff;
    if (!h || typeof h !== "object" || Array.isArray(h)) {
      bad("R13", "handoff must be an object when partial is true");
    } else {
      const ho = h as Record<string, unknown>;
      if (!Array.isArray(ho.completed) || ho.completed.some((c) => typeof c !== "string")) bad("R13", "handoff.completed must be an array of strings");
      if (!Array.isArray(ho.remaining) || ho.remaining.length === 0 || ho.remaining.some((c) => typeof c !== "string" || !c.trim())) bad("R13", "handoff.remaining must be a non-empty array of non-empty strings");
      if (typeof ho.next !== "string" || !ho.next.trim()) bad("R13", "handoff.next must be a non-empty string");
      if (typeof ho.verify !== "string" || !ho.verify.trim()) bad("R13", "handoff.verify must be a non-empty string");
    }
    if (r.verdict !== "inconclusive") bad("R13", "a partial result is not a pass: verdict must be inconclusive");
  }

  // R9 (only meaningful once the shape checks above pass)
  if (out.length === 0) {
    const rr = r as unknown as ReviewResult;
    const code = exitCodeFor(rr);
    const blocker = rr.issues.some((i) => i.severity === "blocker");
    const expected = rr.error || rr.verdict === "inconclusive" ? 2 : rr.verdict === "fail" || blocker ? 1 : 0;
    if (code !== expected) bad("R9", `exit code ${code} for verdict ${rr.verdict}, error ${rr.error ? rr.error.kind : "null"}, blocker ${blocker}; expected ${expected}`);
  }

  // R10
  if (r.error && typeof r.error === "object" && (r.error as Record<string, unknown>).kind === "worktree-modified" && r.verdict !== "inconclusive") {
    bad("R10", "a worktree-modified review must be inconclusive");
  }

  // R11
  if (!r.marker || typeof r.marker !== "object" || Array.isArray(r.marker)) {
    bad("R11", "marker must be an object");
  } else {
    const m = r.marker as Record<string, unknown>;
    if (m.name !== "DOUG_CODEX_REVIEW") bad("R11", "marker.name must be DOUG_CODEX_REVIEW");
    if (typeof m.passed !== "boolean") bad("R11", "marker.passed must be a boolean");
    if (typeof m.inherited !== "boolean") bad("R11", "marker.inherited must be a boolean");
  }
  return out;
}
