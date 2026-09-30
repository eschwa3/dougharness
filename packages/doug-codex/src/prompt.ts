// Builds the refutation-oriented review prompt. Pure; no I/O.
// The diff is embedded when small so the reviewer starts from evidence, not from a description of it.

export interface PromptInput {
  spec: string;
  base: string;
  head: string;
  changedFiles: string[];
  /** Full unified diff base...head, or null if it was too large to embed. */
  diff: string | null;
  /** Bytes of the diff when it was not embedded. */
  diffBytes?: number;
  /** Commands the reviewer is encouraged to run (the task's verify command, the project's test command). */
  verifyCommands?: string[];
}

export const MAX_EMBEDDED_DIFF_BYTES = 60_000;

export function buildPrompt(input: PromptInput): string {
  const lines: string[] = [];
  lines.push("You are an adversarial code reviewer. Your job is to REFUTE the claim that this change correctly and completely implements the spec below.");
  lines.push("You did not write this code and you have no stake in it passing. Assume it is wrong until the evidence says otherwise.");
  lines.push("Run tests, type checks, scripts, and git commands freely, but never edit, create, or delete files in the repository and never commit, checkout, or reset. Put scratch scripts in the system temp directory. The working tree is compared before and after your run; any change voids your review.");
  lines.push("");
  lines.push("## Spec the change claims to implement");
  lines.push("");
  lines.push(input.spec.trim());
  lines.push("");
  lines.push("## Change under review");
  lines.push("");
  lines.push(`Base ref: ${input.base}`);
  lines.push(`Head ref: ${input.head}`);
  lines.push(`Changed files (from git diff --name-only ${input.base}...${input.head}):`);
  if (input.changedFiles.length === 0) lines.push("  (none: the diff is empty)");
  for (const f of input.changedFiles) lines.push(`  - ${f}`);
  lines.push("");
  if (input.diff !== null) {
    lines.push("Unified diff:");
    lines.push("");
    lines.push("```diff");
    lines.push(input.diff.replace(/```/g, "` ` `"));
    lines.push("```");
  } else {
    lines.push(`The diff is ${input.diffBytes ?? "?"} bytes, too large to embed. Read it with: git diff ${input.base}...${input.head}`);
  }
  lines.push("");
  lines.push("## How to review");
  lines.push("");
  lines.push("1. For each requirement in the spec, find the line in the diff that satisfies it or record that nothing does.");
  lines.push("2. Try to break it: run the tests, then write and run a quick script or test invocation that exercises an edge the spec implies (empty input, boundary values, unicode, errors). A requirement with no failing-before test is unverified, not verified.");
  lines.push("3. Look for changes the spec did not ask for: extra files, renamed symbols, weakened or skipped tests, changed defaults, formatting churn.");
  lines.push("4. Check for the classic false pass: tests that assert nothing, `skip`/`only`, a command that succeeded because it ran zero tests.");
  if (input.verifyCommands && input.verifyCommands.length) {
    lines.push(`5. Run these commands and treat a non-zero exit as a blocker: ${input.verifyCommands.map((c) => `\`${c}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("## What counts as a blocker");
  lines.push("");
  lines.push("A blocker must demonstrate either a failure of a spec sentence or acceptance criterion, which you quote, or a violation of a repository invariant: safety, security, data integrity, public compatibility, or required verification (a verify or acceptance command that exits non-zero). It must be caused by this diff, on a supported or reasonably foreseeable input, and carry a reproduction: a command you ran (an entry in commandsRun) whose exit code or quoted output shows the failure; a finding from static inspection alone, with no command that demonstrates it, is major at most. A test-coverage gap against the spec (a requirement without a test, an assertion missing) is major and never a blocker: the reviewer owns spec compliance, so say so in the issue. An input the spec names as unsupported, or a pathological input no supported caller produces, is at most minor. This is not a downgrade of destructive behavior: a change that deletes, overwrites, or corrupts data the spec did not name is a blocker under data integrity even when no spec sentence forbids it. A `fail` verdict requires at least one `blocker` issue: an issue that is only `major` or `minor` is reported with a `pass` verdict, and a review whose findings are all advisory passes with notes.");
  lines.push("");
  lines.push("## Verdict rules");
  lines.push("");
  lines.push("- `fail` only when at least one issue is a `blocker`: a requirement unmet, a test or verify command failing, or behavior the spec did not ask for, that meets the blocker gate above with a demonstrated failure. An issue that is only `major` or `minor` — a coverage gap, a style nit, a pathological input — is reported with a `pass` verdict, and a review whose findings are all advisory passes with notes.");
  lines.push("- `pass` only if you tried to break it and could not: every command listed under \"Run these commands\" exited 0, and no command you cite as evidence shows a failure this change caused.");
  lines.push("- A probe of your own that could not run for a reason unrelated to the change (a missing tool, a wrong path, a sandbox limit) is not a failure of the change: name it in the summary with its exit code and leave the verdict alone.");
  lines.push("- `inconclusive` only when a command listed under \"Run these commands\" itself could not run (missing dependencies, sandbox limits), or when there were none and you could not run the code at all. Say what you could not run.");
  lines.push("- Severity: `blocker` = a defect that meets the gate above, citing the commandsRun entry that shows it; `major` = a correctness risk or a spec requirement without a demonstrated failure (static inspection, a missing test, a coverage gap); `minor` = advisory, including unsupported or pathological inputs.");
  lines.push("- Every issue names a file and, when possible, the command or observation that demonstrates it in `evidence`. Do not report issues you did not confirm. In `evidence`, quote the command string exactly as it appears in commandsRun, or quote a line of its output verbatim (16 characters or more); a prose description of what a probe did cites nothing, and the adapter downgrades such a blocker to major.");
  lines.push("- Do not pad. No issues and a `pass` verdict is a valid, good answer when the evidence supports it.");
  lines.push("");
  lines.push("Your final message must be only the JSON object described by the output schema: { verdict, summary, issues[] }.");
  return lines.join("\n");
}
