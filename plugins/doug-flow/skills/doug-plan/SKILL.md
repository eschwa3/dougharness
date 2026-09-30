---
name: doug-plan
description: Write an approvable implementation plan (.doug/plan.json) for a feature, fix, or refactor before any code is written. Use when the user asks to plan, scope, break down, or "make a plan for" work that touches more than one file, or says "doug plan".
when_to_use: The user wants a plan, task breakdown, or scoped spec before implementation; or the request is a multi-file feature and no .doug/plan.json exists yet.
allowed-tools: Agent, Bash(node *plan.mjs *), Read
---

# doug-plan

Produce a plan file the user can approve. No code is written by this skill.

1. If the request depends on a fact outside the repository (a Claude Code hook contract, a CLI's output format, a third-party API), invoke the `research` skill first: it writes one cited note to `.doug/.state/research/<id>.md` (one researcher, or several in parallel with distinct questions).

   The planner runs on the `plan` row: read it with the `plan.mjs models` command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" models`, which prints the parsed table as JSON (`roles.plan.model`, `roles.plan.effort`). Spawn the planner subagent with the user's request verbatim plus any constraints they gave, and the note's path when there is one, passing that row's model (omit `model` when the row says `inherit`):
   `Agent({ subagent_type: "doug-flow:planner", model: "<the plan row's model>", prompt: "<request and constraints>. Research note: <path>. Write .doug/plan.json and return the rendered plan." })`
   The Agent tool carries no effort parameter; the row's effort applies through the planner agent's own frontmatter (`effort: high`). The session model never plans itself: it hands the request over and shows the plan.
2. When it returns, validate and render the plan:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" show`
3. Show the rendered plan to the user. Point out any assumption the planner stated and any task that owns many files.
4. Tell the user how to proceed: `/doug-approve` to approve it as written, edit `.doug/plan.json` by hand and then approve, or ask for changes and run `/doug-plan` again.

Do not implement anything. Do not approve the plan yourself.
