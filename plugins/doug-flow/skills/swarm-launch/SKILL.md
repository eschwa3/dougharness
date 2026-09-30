---
name: swarm-launch
description: Run an approved plan that opts into the swarm (plan.mjs set swarm on) through the doug-implement workflow, where a lead agent splits each full-shape task into worker briefs, workers implement them in parallel on the worker row, and the lead merges before the usual verify, review, adversary, and integrate stages. The launch step /doug-implement and /doug-swarm share; a swarm never runs without an approved plan.
allowed-tools: Bash(node *plan.mjs *), Workflow, Read
---

# swarm-launch

The swarm lives inside a plan task (decision 0001 as amended 2026-09-06): the plan is the contract, the task's owned files are the workers' boundary, and the same gates read the merged result. This skill is the one launch step every caller shares, so the rules live in one place.

## Preconditions

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" validate`: the plan must be `approved`. Nothing runs on a draft; approval is the user's act (`/doug-approve`), never this skill's.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" show` prints `Swarm: on` when the plan opted in with `plan.mjs set swarm on`. Without it the same workflow runs the fixed pipeline; do not set it here on your own, because the opt-in is the user's (each swarm task spends a lead, N workers, and a merge instead of one implementer). The swarm pays on a task with independent deliverables that share no new symbol; a plan of small coupled tasks runs as the pipeline (decision 0001, Amendment 2026-09-20: one brief per task at +2.67 USD and +6.1 min against the pipeline on 2026-09-11; five briefs, 8/8 hidden tests, 8.31 USD, 8.5 min on 2026-09-19).
3. The caller is a user-invoked skill or command (`/doug-implement`, `/doug-next`, `/doug-swarm`, `/core-next` for a size M or L hand-track card the user chose to swarm): that invocation is the opt-in the Workflow tool requires. No swarm runs in the background or on a schedule.

## Launch

`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" json`, then `Workflow({ name: "doug-flow:doug-implement", args: <plan object> })` (or `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/doug-implement.js"` when the name is not found). The plan object is passed verbatim; `swarm` travels in it.

## What happens per task

A size-S task keeps its single implementer. For every other task: the `lead` agent (the `lead` row of the Models table) creates the task branch and splits the task into briefs, each owning a disjoint subset of the task's files; a brief that names any other file blocks the task before a worker runs. The workers (`implementer` agents on the `worker` row, one worktree each, labels `worker:<task>:<n>`) implement their briefs in parallel and commit on `doug/task-<id>-w<n>`. The lead merges the branches into `doug/task-<id>`, runs the task's verify command, and returns an implementer result; verify, review, the adversary, the ledger, the budget, and integration run on it unchanged, and a fix pass is one implementer in the lead's worktree. The report records `workers` per task (brief, files, branch, commit, block) and the lead and worker tiers under `models`; `cost.mjs` shows each worker's cost. A deterministic shape gate keeps a full-shape task whose owned files are one source file plus its tests off the lead as well, and the lead's split always carries a required `splitReason` the report can read to tell an unsplittable task from one nobody tried to split. A worker that blocks gets the lead back once to re-brief the unfinished pieces (label `lead-rebrief:<task>`) before the task blocks; a worker still partial after its resume, or a second block, ends the task as before. `plan.mjs set workerCheck on` (off by default) adds a deterministic check after each round, before the merge: a worker whose filesTouched strayed outside its brief, or who never committed, is blocked the same way, with `checkFailed: true`.

## Report

Read the report as `/doug-implement` does. Name each task's briefs and which worker blocked when one did; a lead block says `lead brief <id> names a file the task does not own` when the split tried to widen, and the fix is a wider task at approval, never a wider brief.
