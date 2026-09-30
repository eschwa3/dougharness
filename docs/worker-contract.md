# The worker contract

Spec in, diff plus evidence out. Every worker that does a job for Doug, whatever model or vendor runs it, follows this contract, and the same gates judge the result. Codex as an adversarial reviewer (`packages/doug-codex`) is the first implementation. Codex as an implementer, OpenRouter workers, and local models are planned and will be held to the same rules by the same test.

The contract is checked in code, not just described here: `packages/doug-codex/src/contract.ts` exports `checkReviewResult(result)`, which returns the list of violated rules, and `packages/doug-codex/tests/contract.test.ts` runs the Codex adapter through every outcome it can produce and asserts that list is empty. A new adapter conforms when its results pass the same function. Rule ids below match the ids the checker reports.

## Roles

| Role | Status | In | Out |
|---|---|---|---|
| review | shipped (`codex-review`) | spec, `base`, `head`, `dir`, verify commands | verdict, issues, commands run with exit codes, changed files, typed error |
| implement | planned (v2) | spec, owned files, verify command, worktree | branch and commit, commands run with exit codes, changed files, typed error |
| supervise | shipped (`doug-implement.js`, card fix-loop-supervisor) | the task's passes so far (findings each targeted, commands with exit codes, verdicts), the ledger, the stall signals the loop detected | a brief: what was tried, what failed each time, two or three alternative directions; never a verdict, never an edit |

The supervise role runs on the `cheap` tier of the Models table (haiku at low effort when the table has none) before a fix pass after the first, only when the loop's stall signals fire: the same finding blocked twice, or a fix pass that re-attacked a file an earlier pass had already cleared. Its brief goes into the next fix prompt; a task that stalls a second time stops with `stopReason` starting `stalled` and `supervisor.stop = { kind: 'stalled', attempts, findings }` instead of spending the remaining fix budget. It cannot soften a verdict: the stages' findings and the ledger are unchanged by it, and it edits nothing (read-only agent, no worktree). Source: NVIDIA AVO's self-supervision loop (paper §3.3), whose trigger it leaves unspecified; Doug's triggers are the two above.

The review role's output object is `ReviewResult` in `packages/doug-codex/src/schema.ts`. The implement role will reuse `commandsRun`, `changedFiles`, `error`, `durationMs`, and `usage` unchanged and add the branch and commit it produced. Both roles can stop partway through and return `partial` with a `handoff` instead of finishing (R13) — see "Diff plus evidence out" below.

## Spec in

The worker receives, and must not be able to do without:

- **spec**: the task text and acceptance criteria, exactly as the plan states them. For review, the reviewer is asked to refute the change against this spec.
- **base** and **head**: the two commits that bound the change. The adapter computes the diff and the changed files itself with git; the model is never asked what changed.
- **dir**: the checkout the worker runs in. For review the adapter refuses to run when `head` is not the commit checked out in `dir`, because every command the reviewer runs would test the wrong code.
- **verify commands**: what the project runs to check itself. The worker is told to run them and the runtime records whether it did.

A verify command must be one the worker can execute in its sandbox. A check that spawns codex-review cannot run inside codex-review, and a check that binds a network listener, 127.0.0.1 included, cannot run in a sandbox that denies listeners. A suite containing either must skip it with a reason that names the denial (`DOUG_CODEX_REVIEW` set, `EPERM` on listen), and the plan author must not hand the worker a check it cannot execute in its sandbox and that has no such skip.
- **timeout** and **model** are optional; the defaults are the adapter's.

## Diff plus evidence out

One JSON object. The fields of `ReviewResult`, and the rules the checker enforces:

| Field | Rule | Meaning |
|---|---|---|
| `verdict` | R1 | `pass`, `fail`, or `inconclusive`. Every failure of the worker itself is reported as `inconclusive`, never as `pass`. |
| `summary` | R1 | The model's one-paragraph summary. Prose, carries no authority. |
| `issues` | R2, R12 | Array. Each has `severity` of `blocker`, `major`, or `minor`; `file`; non-empty `description`; optional integer `line`; optional `evidence`, the command or observation that demonstrates the issue. A `blocker` must cite, in `evidence`, a command in `commandsRun` that shows the failure (R12); the adapter downgrades one that does not to `major`, prefixes its `description`, and lists it in `downgraded` rather than trusting or dropping it. |
| `commandsRun` | R3 | Array of every command the runtime actually executed: `command`, `exitCode` as the runtime observed it (`null` if it never completed), `ok` true only for exit 0, optional `outputTail`. Taken from the runtime's event stream, never from the model's prose. |
| `changedFiles` | R4 | Array of files in `base...head` as computed by git: relative paths, unique, sorted. |
| `base`, `head`, `dir` | R5 | Echoed back so a result is self-describing. `dir` is absolute. |
| `reviewer`, `model`, `sandbox` | R6 | Which worker produced this, on which model (or `null` when the runtime chose), in which sandbox. |
| `error` | R7 | `null` when the review completed. Otherwise a typed failure: `kind` from the list below and a non-empty `message`, plus the kind's own evidence. |
| `codexExitCode`, `durationMs`, `usage` | R8 | Measured, or `null`. Never estimated. |
| `marker` | R11 | The nesting guard: `name` is the environment variable the adapter sets on the worker it spawns (`DOUG_CODEX_REVIEW`), `passed` is true once the worker was spawned with it, `inherited` is true when the adapter itself ran under it. |
| `partial` | R13 | Optional. `true` when the worker stopped at a boundary rather than finishing the task, after the harness's measured context notice; absent or `false` for an ordinary result. |
| `handoff` | R13 | Present when `partial` is `true`: `completed` (array of strings), `remaining` (non-empty array of non-empty strings), `next` (non-empty string), and `verify` (non-empty string, the command that would verify the remaining work). |

Error kinds (R7): `codex-not-found`, `codex-failed` (with `stderrTail`), `timeout`, `no-final-message`, `unparseable` (with the `raw` text), `git`, `worktree-modified` (with the list of `changes`). A new adapter may add kinds by adding them to the checker's list; it may not report a failure without a kind.

## Evidence rules

These are the rules that make the output trustworthy. The checker enforces the ones that are visible on the result object; the adapter's tests enforce the rest against a fake runtime.

1. **Commands are evidence, prose is not.** `commandsRun` comes from the runtime's own record of what executed (for Codex, the `command_execution` items in the JSONL stream). A model claiming "I ran the tests" without a matching entry has run nothing.
2. **A schema on the way out is not a guarantee on the way in.** The model's final message is constrained by a JSON Schema and validated again by the adapter. Prose, a wrong shape, or a missing final message is `inconclusive` with a typed error, not a pass. The same holds for an implementer in Doug's flow: a fix pass that ends without a structured result is a blocked pass with the reason `implementer returned no structured result`, retriable, and the workflow keeps the branch and worktree it already knew (`plugins/doug-flow/workflows/doug-implement.js`), so the loop retries in place or stops there and the report still names the branch for replan. Before this (board-reorder, 2026-09-07) such a pass threw the task's pipeline stage and the report carried no branch at all.
3. **A reviewer that edits the code it reviews has reviewed nothing** (R10). The adapter snapshots `git status` before and after; any change makes the result `inconclusive` with kind `worktree-modified` and the changes listed, whatever the model claimed.
4. **The diff is computed, not reported.** `changedFiles` and the embedded diff come from git, so the reviewer's scope claims can be checked against them.
5. **Numbers are measured or absent.** Token usage comes from the runtime's `turn.completed` event or is `null`. Duration is wall clock. Nothing is estimated.
6. **The worker runs sandboxed** and without the user's MCP servers unless asked, and `.git` stays read-only in every sandbox.
8. **A blocker is a demonstrated failure** (R12). Its `evidence` must name a command the runtime recorded in `commandsRun` (the whole recorded command, or the command inside its shell wrapper), or quote a line of at least 16 characters of its recorded output; either way, that command must have exited non-zero, or the evidence quotes a line of its recorded output. This is the fix for the 2026-09-17 recipe-skills run (card `codex-review-r12-prose-evidence`), where three exit-1 probes were downgraded because their evidence described the probe in prose and quoted only its output, never the (unpasteable, double-quoted-wrapper) command itself. A finding from static inspection alone is `major` at most, and a test-coverage gap against the spec is `major`, never a blocker: the reviewer owns spec compliance. The prompt states the same gate (`packages/doug-codex/src/prompt.ts`, the two adversary agents, and the workflow's `BLOCKER_GATE` carry one text), and the checker enforces it on the result, so a blocker raised from reading alone is a contract violation whatever the model claimed. `runCodexReview` (`packages/doug-codex/src/run.ts`) applies the same rule to its own success-path result via `enforceBlockerEvidence`: an evidence-free blocker is downgraded to `major`, never silently dropped, so the model's own claim cannot bypass R12 the way an unenforced checker could. A `fail` verdict whose blockers were all downgraded this way becomes `pass`; a `fail` with nothing downgraded is left alone, whether or not any blocker remains. Before this, on the five runs of 2026-09-06, four of five adversary blocks were spec-true test or reporting gaps found by inspection, each costing a fix pass. When codex-review cannot run, `plugins/doug-flow/workflows/doug-implement.js`'s `enforceFallbackEvidence` applies the same check inline to the fallback adversary's result before `runAdversary` returns it, with its description prefix naming `adversary-claude` in place of `codex-review`. That check reads a `commandsRun` (and `outputTail`, when given) that is self-reported by the fallback agent, not the runtime's own record, so it is weaker than the Codex-side check above.
7. **A worker is never asked to run a check it cannot execute in its sandbox.** The adapter sets `DOUG_CODEX_REVIEW=1` in the environment of the Codex it spawns and records it in `marker` (R11); checks that would spawn codex-review (this repository's live Codex test) skip under that variable with a reason that names it. The same holds for network listeners: this repository's `doug board serve` tests (packages/doug-cli/tests/board-page.test.ts) skip when listening on 127.0.0.1 fails with EPERM, with a reason that names it, and packages/doug-cli/tests/board-page-skip.test.ts proves the skip fires. Since card codex-review-network-access, codex-review passes `-c sandbox_workspace_write.network_access=true` when its sandbox is workspace-write and at least one `--verify` command is given (`--no-network-access` turns it off; under read-only the override is never passed, since Codex ignores it there), so a verify command such as the board-serve tests can bind 127.0.0.1 inside the review; the EPERM skip stays as the fallback for a review that turned it off. The workflow's adversary prompt tells the reviewer that such a skip is expected and that an environment denial is inconclusive, not a blocker. Without this, the nested run and the listener both failed inside the sandbox and the reviewer reported a false blocker, which happened on dogfood day (2026-09-04) twice.
9. **A partial is graceful degradation, never an escape hatch** (R13). It is accepted only after the harness's measured context notice — the SubagentStop gate refuses a `partial: true` claim from a worker with no recorded context reading at or above the threshold, so a worker cannot declare itself partial on its own judgement. Doug's workflow resumes a usable partial exactly once, with a fresh worker briefed on the handoff; a worker still partial after that resume stops the task as a block, not a retry.

## Exit codes (R9)

| Code | Meaning | When |
|---|---|---|
| 0 | no blockers | `error` is null, verdict `pass`, no `blocker` issue |
| 1 | blocked | verdict `fail`, or any issue with severity `blocker` |
| 2 | could not review | `error` is set, or verdict `inconclusive` |
| 64 | usage | bad arguments; no result object is printed |

The doug-flow adversary stage reads the verdict, not just the exit code (card fix-loop-minor-verdict): exit 1 keeps the task out of integration only when at least one issue is `blocker`, or the issues array is empty (the one case that leaves the fix loop nothing else to point at, so the workflow synthesizes a finding from `summary`). Before this, exit 1 from a `fail` verdict whose issues were only `major` or `minor` synthesized that same summary-only finding too, so the fix pass was briefed with one un-actionable finding - the reviewer's prose, naming no file or line - not zero, could not act on it, made no commit, and stalled the task forever (three runs on card memory-outcomes, 2026-09-07); such a fail is now pass-with-notes and does not block. Exit 2 reports `inconclusive` and does not block either. So a missing or broken worker never silently passes a change, a real defect never silently passes, and a nit never silently vetoes one.

## Conformance

`packages/doug-codex/tests/contract.test.ts`:

- runs the Codex adapter against a fake `codex` in every mode it has (pass, fail with a blocker, non-zero exit, prose instead of JSON, no final message, wrong shape, working-tree mutation, binary not found, timeout) and asserts `checkReviewResult` returns no violations and the exit code follows R9;
- runs the real `codex-review` binary and checks the JSON it prints the same way;
- feeds the checker deliberately broken results and asserts each rule is reported by id;
- reads this document and asserts every `ReviewResult` field and every error kind is named in it, so the document cannot drift from the code without a test failing.

A future adapter adds one test: produce a result in each of its outcomes and call `checkReviewResult`. If the list is empty, the gates that read the Codex adapter's output can read its output too.

## The adversary in Doug's own flow

`codex` on the adversary row of CLAUDE.md's Models table means the adversarial review runs on Codex: `codex-review` (`packages/doug-codex`) spawns `codex exec` in the task's worktree, named by the plan's `adversary.command` (the doug-next skill sets it to the local adapter before approval when `codex-review` is not on PATH). The Claude agent that launches it and relays the verdict unchanged runs on haiku; the adversary row's effort is passed to `codex-review --effort <level>`, which maps it to `-c model_reasoning_effort=<level>`, and the haiku relay runs at that effort too. When codex-review cannot run at all (Codex missing, `codex exec` failed such as on a usage limit, a timeout), the workflow falls back to the `adversary-claude` agent on the plan's `adversary.fallback`, default Opus at high effort; `plan.mjs set adversary.fallback off` restores the strict block. The relay also copies `ReviewResult.usage` and `durationMs` into its structured result unchanged, so the report carries them per task and per level and `cost.mjs` can price Codex's own tokens as a line separate from the Claude run total (card adversary-usage-in-report).

The final level's integrate stage also runs every plan acceptance command on the integration branch after the merge, the same way the verifier runs them per task, and records `integration.acceptance: [{ text, command, ok, exitCode }]` in the report; a non-zero exit fails the integration, with the failing entry named in `integration.reason`. Earlier levels record nothing there, since the plan is not complete at an earlier level. A plan command the integrate stage does not report is recorded as `{ text, command, ok: false, exitCode: null, reported: false }` and likewise fails the integration, named in `integration.reason` as `acceptance command not reported: <text> ($ <command>)`, distinct from a command that ran and failed. `board.mjs summary` reads `integration.acceptance` first only when it is a non-empty array; a plan with no acceptance commands, or a report without the field, falls back to reconciling each task's own per-task acceptance entries (card integration-acceptance-recorded).
