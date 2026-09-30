---
name: doug-swarm
description: A swarm from a board card or a goal, outside /doug-implement: the planner plans on the plan row with swarm on, you approve at the same gate /doug-next uses, the swarm-launch skill runs the plan through the workflow (a lead splits each task into worker briefs, workers implement in parallel, the lead merges), and land, the board move, and the run entry follow /doug-next's steps. Only the user invokes this; no swarm runs without an approved plan.
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Workflow, Read, Bash(node *plan.mjs *), Bash(node *board.mjs *), Bash(node *cost.mjs *), Bash(git *), Bash(doug board *), Bash(node *bin.js board *)
---

# doug-swarm

`/doug-swarm <card-id>` runs a board card as a swarm; `/doug-swarm <goal text>` runs a goal that has no card. Either way the plan is the contract: nothing runs before you approve it, the lead may split a task but never widen it, and the same verify, review, adversary, and land read the result. The user invoking this command is the opt-in for multi-agent orchestration; no swarm runs in the background or on a schedule.

The swarm pays on a task with independent deliverables that share no new symbol; a plan of small coupled tasks runs as the pipeline (decision 0001, Amendment 2026-09-20: one brief per task at +2.67 USD and +6.1 min against the pipeline on 2026-09-11; five briefs, 8/8 hidden tests, 8.31 USD, 8.5 min on 2026-09-19).

## 1. Pick the work

Start from a clean working tree on the base branch (`git status --porcelain` empty apart from `.doug/` and `.claude/worktrees/`).

- A card id: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" card <id>`. A card with `"track": "hand"` is harness work built in the checkout (decision 0005), not a swarm; say so and end. Move the card to In flow exactly as `/doug-next` step 1 does (`board.mjs move <id> flow`), leaving the move uncommitted working state that the served page (`doug board serve`) shows live.
- A goal: no board record changes; the plan carries no `card`.

Put the card's title and goal (or the goal text) in the chat verbatim, in a fenced code block. If it depends on a fact outside the repository, invoke the `research` skill first.

## 2. Plan on the plan row

The planner runs on the `plan` row, the same row `doug-plan` uses, not the `lead` row (the `lead` row is the swarm's own lead agent inside the workflow, a different job). Read it with the `plan.mjs models` command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" models` (`roles.plan.model`, `roles.plan.effort`). Spawn the planner on it: `Agent({ subagent_type: "doug-flow:planner", model: "<the plan row's model>", prompt: "Board card <id>, title \"<title>\": <goal>. This plan runs as a swarm: set \"swarm\": true in the plan file, and size every task M or L unless it is truly one bounded change (a size-S task keeps a single implementer). Write .doug/plan.json and return the rendered plan." })` (for a goal, the prompt is the goal text with the same swarm sentence); omit `model` when the row says `inherit`. The planner's rules apply unchanged: disjoint file ownership per task, a verify command per task, acceptance criteria with commands, no tier set on its own.

Then guarantee the opt-in and the card (`plan.mjs set swarm on`): `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" set swarm on`, and `plan.mjs set card <id>` for a card. `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" show` and put its complete output in the chat verbatim, in a fenced code block, before anything else; it prints `Swarm: on`. Name any task the planner sized S (it will not swarm) and any assumption it stated.

## 3. Human gate: approval

Ask with `AskUserQuestion`, only after the full plan is in the chat: approve as written, edit first, or stop. Approval is never automatic and never inferred. Approve, edit, and stop mean what they mean in `/doug-next` step 3 (fill `install` and `adversary.command` from `.doug/config.json` when the plan has none; then `plan.mjs approve` and `plan.mjs anchor`; edit stops here; stop moves a card back to Ready).

## 4. Run

Invoke the `swarm-launch` skill: it checks the plan is approved with swarm on and launches the workflow with `plan.mjs json` as the args. Note the wall clock. Save the `result` object of the Workflow tool's output to `.doug/.state/last-report.json` and read it as `/doug-next` step 4 does, plus the swarm's own rows: each task's `workers` (brief, files, branch, commit, and a block with its reason), and a lead block that says `lead brief <id> names a file the task does not own`, which means the split tried to widen and the fix is a wider task at approval, never a wider brief. A paused run, a blocked run, and `plan.mjs replan` work exactly as in `/doug-next` step 4; reused tasks skip the lead and the workers alike.

## 5. Land and record

`/doug-next` step 5 verbatim: `plan.mjs done`, `plan.mjs land`, the card's move to Done with the merge commit, the `run-report` skill (its cost table lists every worker by label), and one commit for the record and the log. A goal without a card lands the same way and skips the board steps; its run entry is not written, since the log is per card.

## 6. Follow-up cards

`/doug-next` step 6 verbatim: gather the run's follow-up candidates, ask once with `AskUserQuestion` when there are any, and add accepted ones with `doug board add`, then one commit.

Before the continue gate, gather the follow-up candidates this landing produced: the report's review issues, the adversary blocks classified marginal or false whose reason names a hole, the integrate stage's conflicts and failed verify tails, and the landing summary. Suggestions come only from what the run actually reported, never invented; each carries the one-line reason and cites the pass that found it. A reviewer's out-of-scope finding is offered only when it is realistic drift (a form a model or a person would plausibly write) or when one card would close the whole class; otherwise it goes in the landing note and the lead recommends none. The suggestion's goal text carries both: the goal names the pass that found it (the reviewer's finding, the implementer's blockedReason or handoff, the verifier's findings, the adversary block id) and the landed commit.

A landing with no candidates skips the question. Otherwise ask once with `AskUserQuestion`, `multiSelect: true`, one option per suggestion with a proposed id, title, column, size, class, track, and deps on the landed card, plus a "none" option.

Each accepted suggestion is added with `doug board add` (never a script that edits the record): `doug board add <id> --title "<title>" --goal "<goal>" --component <c> --size <S|M|L> --class <tests-only|prose|gate-script|code|docs|eval|decision> --track <hand|flow> --deps <landed-id> --column <ready|decide>` (or `node packages/doug-cli/dist/bin.js board add ...` when `doug` is not on PATH; build the CLI first if `dist/` is missing). An S hand card goes to the top of Ready (`doug board reorder <id> --top`) when it is mechanical and to Decide when it needs a decision. Then one commit `"Board: <id> follow-ups added: <new-id>, <new-id>"`, whatever the count; the served page (`doug board serve`) shows the new cards without a republish. Batch: each suggestion's deps name the card of the batch it came from; still one question and one commit for the whole batch.

A goal without a card (section 1's second bullet) skips this step, the way section 5 says such a run skips the board steps.

## 7. Human gate: continue

Ask with `AskUserQuestion` whether to swarm the next Ready card (`board.mjs next`). Yes: step 1 with that id. No: end.
