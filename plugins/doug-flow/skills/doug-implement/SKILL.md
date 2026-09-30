---
name: doug-implement
description: Execute the approved .doug/plan.json with the doug-implement workflow: one implementer per task in its own worktree, independent verification, two-stage review, and integration per dependency level. Only the user invokes this.
disable-model-invocation: true
allowed-tools: Bash(node *plan.mjs *), Workflow, Read
---

# doug-implement

Runs the deterministic workflow on an approved plan. The user invoking this skill is the opt-in for multi-agent orchestration.

A plan that carries `swarm` on (`plan.mjs set swarm on`, printed by `plan.mjs show` as `Swarm: on`) runs each full-shape task as a swarm: a lead splits it into worker briefs, workers implement them in parallel on the `worker` row, and the lead merges before the checks. The launch is the same; the `swarm-launch` skill describes what the run does per task and how to read its report, and is the step `/doug-swarm` shares.

1. Check the plan: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" validate`
   If the status is not `approved`, stop and tell the user to run `/doug-approve`.
2. Load it as JSON: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" json`
   This resolves the CLAUDE.md `## Models` table into per-task model and effort; do not hand-edit the result.
3. Launch the workflow with the plan object as `args` (an object, not a string):
   `Workflow({ name: "doug-flow:doug-implement", args: <plan object> })`; the registered name carries the plugin prefix.
   If the named workflow is not found, use `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/doug-implement.js", args: <plan object> })`.
4. When the run completes, read its report. For each level, state which tasks were implemented, verified, reviewed, adversarially reviewed (the `adversary` field: verdict, blockers, or why it did not run), and integrated, and quote the integration verify results. Name the integration branch. The per-task `acceptance` array holds the verifier's per-criterion exit codes and any ok=false entry is to be listed. A task whose fix loop stalled carries `supervisor` (`ran`, `stalled`, `brief`, and `stop` when it stopped): the supervisor step on the cheap tier ran before a fix pass after the first, because the same finding blocked twice or a fix pass re-attacked a file an earlier pass had cleared, and its brief was put in front of the next fix; say so, and quote the brief's directions when the task stopped as `stalled`.
5. If the report carries `paused`, the run stopped at a human gate after that level integrated (a task there carries `gate: human`): say which tasks wait in `next`, and that the user continues with `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" gate open <level>` followed by a relaunch of the same run id (`Workflow` with `resumeFromRunId` and the plan's fresh JSON); `plan.mjs done` refuses while the last report is paused. If `ok` is true, tell the user the branch is ready to merge and offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" done` followed by `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" land`. `land` re-runs the plan's verify commands and then every acceptance command on the integration branch and merges it into the base branch with a merge commit only if they pass; it refuses otherwise and says why. If `ok` is not true, list what failed and stop; `plan.mjs done` also refuses a report that is not ok, naming the stopped level and each task's `stopReason`, overridable with `--force`. Do not fix things outside the workflow; re-plan instead.
