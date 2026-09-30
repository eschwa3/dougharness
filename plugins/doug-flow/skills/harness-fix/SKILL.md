---
name: harness-fix
description: The by-hand procedure for changing Doug's own harness code (plugins/doug-flow, plugins/doug-gates, packages/doug-codex, packages/doug-cli, evals) without running it through the flow (decision 0005). Which test file covers which module, a single test file while iterating, the full gate before a commit, gate scripts copied into .doug/hooks/scripts, no attribution trailers, and a docs/live-runs.md line when a measurement changes. Use it for any edit under those directories, and from /core-next.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# harness-fix

Harness code is built directly in the checkout: tests first, the full gate, a plain commit. This is the procedure; `/core-next` follows it for every hand-track card, and it applies just as well to a one-line fix made outside a card.

## 0. Who does the work

The lead briefs and gates; it never implements, verifies, or reviews the change itself. Before the coder, the `tester` agent (`.claude/agents/tester.md`), spawned with the Agent tool on the `implement` row of the CLAUDE.md Models table, writes or extends the test file first, from the goal; the coder implements against it. A tester that leaves tests red by design ends with its tests_red_by_design claim, in its final plain-text message or its hand-back call; the SubagentStop gate reads both. The `coder` agent, on the same row, may not edit a test except with a stated reason in its report. The `reviewer` agent, on the `review` row, reviews, and checks that rule. Verification on the hand track is the gate itself (`pnpm typecheck` and `pnpm test:unit`), which the reviewer runs and the lead re-runs before the commit. This holds on both tracks, swarm or not; a hand-track lead is the session model. For a card whose acceptance is that a mechanism exists, the reviewer is expected to mutate the mechanism and rerun the test rather than only read the diff (rule 7), rerunning the brief's mutation list and adding its own; the flow track's `plugins/doug-flow/agents/reviewer.md` does not carry this instruction — it is read-only by tool policy, and its verifier and adversary stages run the code afterward instead. On a tests-only card (the goal says tests only, no production change) there is no coder: the tester runs the brief's mutation list itself in a scratch copy or git worktree under `.doug/.state`, never editing a production file in the live checkout, and reports each result.

## 1. Find the test that covers the module

Under a card, the tester writes or extends the test before the change, in the file that already covers the module, and the coder runs only that file while iterating: `pnpm exec vitest run <path/to/file.test>`. For a one-line fix outside a card there is no tester: its author writes the test first, in the same file, and runs only that file.

| Module | Test file |
|---|---|
| `plugins/doug-flow/workflows/doug-implement.js` (the loop, the ledger, the prompts), `agents/*.md`, `skills/*/SKILL.md`, the plugin manifest | `plugins/doug-flow/tests/template.test.mjs` |
| `plugins/doug-flow/lib/board.mjs`, `scripts/board.mjs` | `plugins/doug-flow/tests/board.test.mjs` |
| `plugins/doug-flow/lib/plan.mjs` validation, levels, rendering, `mergePlans` | `plugins/doug-flow/tests/plan.test.mjs` |
| `scripts/plan.mjs set`, `plan.mjs merge` (several cards in one plan) and `--file`, config defaults for install and adversary | `plugins/doug-flow/tests/plan-set.test.mjs` |
| `lib/plan.mjs` specHash, reusePlan, `plan.mjs replan` | `plugins/doug-flow/tests/replan.test.mjs` |
| `plugins/doug-flow/lib/land.mjs`, `plan.mjs land`, worktree pruning | `plugins/doug-flow/tests/land.test.mjs` |
| `plugins/doug-flow/lib/worktrees.mjs` (worktree removal, used by `land.mjs`; branch retirement, used by `scripts/plan.mjs`) | `plugins/doug-flow/tests/land.test.mjs` (removal), `plugins/doug-flow/tests/replan.test.mjs` (retirement) |
| `plugins/doug-flow/lib/models.mjs` (the CLAUDE.md Models table) | `plugins/doug-flow/tests/models.test.mjs` |
| `plugins/doug-flow/lib/cost.mjs`, `scripts/cost.mjs` (a run's cost from local transcripts; the price table) | `plugins/doug-flow/tests/cost.test.mjs` |
| `plugins/doug-flow/lib/embeddings.mjs` (the embedding provider layer: openai-compatible and voyage adapters, probeProvider, doctorReport) | `plugins/doug-flow/tests/embeddings.test.mjs` |
| `plugins/doug-flow/lib/code-index.mjs` (the opt-in semantic code index: file listing, chunking, incremental build, status, search) | `plugins/doug-flow/tests/code-index.test.mjs` |
| `plugins/doug-flow/lib/learn.mjs`, `scripts/learn.mjs` (deterministic proposals from outcomes/lessons signals and the run trace; card learn-signals) | `plugins/doug-flow/tests/learn.test.mjs` |
| `plugins/doug-flow/lib/decisions.mjs` (proposal diffs for docs/decisions/ ADRs and .claude/rules/ conventions; card memory-decisions), `scripts/memory.mjs`'s `decision`/`rule` cases | `plugins/doug-flow/tests/decisions.test.mjs` |
| `plugins/doug-flow/lib/memory.mjs`, `scripts/memory.mjs` (the outcome log and lesson store: recall, the outcome record, reflect, and the memory.mjs CLI's index dispatch; card memory-lib) | `plugins/doug-flow/tests/memory.test.mjs`, `plugins/doug-flow/tests/memory-cli.test.mjs` |
| `plugins/doug-flow/lib/memory-import.mjs` (the `memory.mjs import` command; card memory-import) | `plugins/doug-flow/tests/memory-import.test.mjs` |
| `plugins/doug-gates/scripts/*.mjs` end to end (protect-paths, guard-bash, format-on-edit, edit-loop, stop-gate, reanchor, checkpoint) | `plugins/doug-gates/tests/hooks.test.mjs` |
| `plugins/doug-gates/lib/bash-rules.mjs` | `plugins/doug-gates/tests/bash-rules.test.mjs` |
| `plugins/doug-gates/lib/scope.mjs` (plan scope) | `plugins/doug-gates/tests/scope.test.mjs` |
| `plugins/doug-gates/lib/secret-rules.mjs`, `scripts/secret-scan.mjs` | `plugins/doug-gates/tests/secret-scan.test.mjs` |
| `plugins/doug-gates/lib/checkpoint.mjs` | `plugins/doug-gates/tests/checkpoint.test.mjs` |
| `plugins/doug-gates/lib/config.mjs`, state and paths | `plugins/doug-gates/tests/config-state.test.mjs` |
| `plugins/doug-gates/lib/proposals.mjs` (the applied-proposal ledger reader; card memory-decisions) | `plugins/doug-gates/tests/hooks.test.mjs` (protect-paths/stop-gate proposal-path blocks) |
| `plugins/doug-gates/lib/glob.mjs` | `plugins/doug-gates/tests/glob.test.mjs` |
| `plugins/doug-gates/lib/anchor.mjs` (the PreCompact snapshot in the anchor) | `plugins/doug-gates/tests/hooks.test.mjs` (reanchor on PreCompact) |
| `plugins/doug-gates/lib/evidence.mjs` (verification evidence: which recorded commands count) | `plugins/doug-gates/tests/evidence.test.mjs`; the stop-gate and guard-bash sides in `hooks.test.mjs` |
| `plugins/doug-gates/lib/trace.mjs` (the run trace: line shape, transcript usage, replay, attribution) | `plugins/doug-gates/tests/trace.test.mjs`; the `trace` script end to end in `hooks.test.mjs` |
| `plugins/doug-gates/scripts/statusline.mjs` | `plugins/doug-gates/tests/statusline.test.mjs` |
| the checked-in pre-commit hook | `plugins/doug-gates/tests/git-hooks.test.mjs` |
| `packages/doug-cli/src/board.ts` (`doug board`) | `packages/doug-cli/tests/board.test.ts` |
| `packages/doug-cli/src/board-page.ts`, `board-serve.ts`, `templates/board-app.js` | `packages/doug-cli/tests/board-page.test.ts` (serve tests skip with a reason where a local listener is denied: `board-page-skip.test.ts`) |
| `packages/doug-cli/src/detect/*` | `packages/doug-cli/tests/detect.test.ts` |
| `packages/doug-cli/src/generate/*` (config, CLAUDE.md, settings, proposal, apply) | `packages/doug-cli/tests/proposal.test.ts` |
| `packages/doug-cli/src/diff.ts` | `packages/doug-cli/tests/diff.test.ts` |
| `packages/doug-cli/src/ablate.ts` (`doug ablate`: eval results per condition, the runner pass-through) | `packages/doug-cli/tests/ablate.test.ts` |
| `packages/doug-cli/src/trace.ts` (`doug trace`: replay and per-agent attribution of a run trace) | `packages/doug-cli/tests/trace.test.ts` |
| `packages/doug-codex/src/prompt.ts` | `packages/doug-codex/tests/prompt.test.ts` |
| `packages/doug-codex/src/parse.ts` (Codex JSONL, verdict, exit codes) | `packages/doug-codex/tests/parse.test.ts` |
| `packages/doug-codex/src/run.ts` (spawning codex, timeout, worktree check) | `packages/doug-codex/tests/run.test.ts` |
| `packages/doug-codex/src/contract.ts` and `docs/worker-contract.md` | `packages/doug-codex/tests/contract.test.ts` |
| `packages/doug-codex/src/bin.ts` (`codex-review`) | `packages/doug-codex/tests/cli.test.ts` |
| `evals/run.mjs` (the scorer: tool calls from stream-json, leaks, must-run commands) and `evals/tasks/*.json` | `evals/tests/run.test.mjs` |
| `plugins/doug-flow/scripts/rehearse.mjs`, `lib/rehearse.mjs` (the on-demand live rehearsal runner: estimates, fixture, stream assertions, recording) | `plugins/doug-flow/tests/rehearse.test.mjs` |
| the `reviewIssues` report key (doug-implement.js) round-tripping into `lib/memory.mjs`'s `review_issue_count`/`review_issues`, through `board.mjs record`, `board.mjs summary`, and `plan.mjs replan` (card seam-contracts) | `plugins/doug-flow/tests/seams.test.mjs` |
| every `board.mjs`/`plan.mjs`/`memory.mjs` subcommand a `skills/*/SKILL.md`, `CLAUDE.md`, or `docs/worker-contract.md` names being a real dispatch case (card seam-contracts) | `plugins/doug-flow/tests/seams.test.mjs` |
| `claude plugin validate` actually catching a broken plugin manifest (card seam-contracts) | `plugins/doug-flow/tests/seams.test.mjs` |
| `doug init`'s PreToolUse wiring firing for real (protect-paths.mjs deny/allow, not just a string comparison of the wiring) (card seam-contracts) | `packages/doug-cli/tests/init-hooks.test.ts` |

`packages/doug-codex/tests/codex-live.test.ts` spawns the real Codex and is excluded from the gate; leave it out of iteration.

## 2. Rules while changing harness code

1. The workflow file `doug-implement.js` may not import, call `Date.now` or `Math.random`, or name a model; its template tests assert that, and it must parse when wrapped the way the Workflow runtime wraps it. A top-level `return` in it is expected, so `node --check` fails on it by design.
2. The Workflow tool runs the plugin copy loaded at session start. An edited workflow is launched with `scriptPath` pointing at the file, or the session is restarted.
3. After editing a gate script under `plugins/doug-gates/scripts/`, copy it to `.doug/hooks/scripts/` too: this repository has Doug installed on itself and its hooks run from there.
4. A change to `plugins/doug-flow/lib/board.mjs` or `lib/plan.mjs` reaches `packages/doug-cli` through the `@dougharness/flow` workspace dependency; the CLI's `src/flow-board.d.ts` declares the shapes, so a new field or option is added there as well or `pnpm typecheck` fails.
5. Keep the change to what the card or fix asks. A defect found on the way becomes its own hand-track card.
6. If a hook blocks a step, report it; do not work around it.
7. When the card's acceptance is that a mechanism exists, prove it before reporting done: mutate or remove the mechanism, run the new test file, confirm it fails, then revert the mutation and report which assertion failed. That is the line: a card whose acceptance is that a mechanism exists needs it; a card that only changes prose, a message, or a docs line does not. To prove it, the brief lists one mutation per case the card's goal names, each with the test that must fail; the coder runs every listed mutation and reports each result; the reviewer reruns the list and adds its own. Apply each mutation in a scratch copy or git worktree under `.doug/.state`, run the one test file there, and remove the copy.
8. A card that changes a workflow's or a skill's user-visible behaviour runs the live scenario that covers it before landing: `node plugins/doug-flow/scripts/rehearse.mjs <flow|swarm|hand> --card <id> --spend`, and its landing note quotes the outcome. The swarm scenario is the one that proves plugin loading and agent-name resolution in the real runtime.

## 3. The gate, the commit, the record

1. Before the commit run the full gate: `pnpm typecheck` and `pnpm test:unit`. Never `pnpm test`, which spawns Codex. Say what ran and the counts.
2. Commit without attribution trailers, one commit per coherent change, with a message that says what changed and why. Leave `.doug/plan.json` and `.doug/anchor.md` out unless the change is about them.
3. When the change alters a measurement (a run's cost, wall clock, pass count, or what a stage does), add a line to `docs/live-runs.md`; a change to the board record shows on the served page (`doug board serve`).
