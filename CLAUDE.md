# Project instructions

Guardrails are enforced by hooks configured in `.doug/config.json`; this file carries only what hooks cannot. Keep it under 60 lines.

## Commands

```sh
pnpm install --frozen-lockfile              # install
pnpm typecheck                              # typecheck
pnpm test:unit                              # tests, minus the live Codex test
pnpm exec vitest run <path/to/file.test.ts> # single test file
pnpm test                                   # full suite; codex-live.test.ts calls Codex and fails on a usage limit
pnpm build                                  # build
```

All commands run from the repo root. Iterate on a single test file. The gate is typecheck plus test:unit; run it before finishing. Run `pnpm test` only when you mean to exercise Codex.

## Tooling facts

- Package manager is **pnpm** (package.json packageManager field). Do not use another one. Node >=22.16 (node:sqlite with FTS5 is built in from there; no native SQLite dependency).

## Layout

- `packages/doug-cli`: the `doug` CLI (init, board, ablate). `packages/doug-codex`: the Codex adapter, `codex-review`. `plugins/doug-flow`: skills, agents, workflows, and the plan, board, and models libraries. `plugins/doug-gates`: the hooks.
- `docs/worker-contract.md`: what every worker must return. `.doug/`: plan, board, anchor, config.

## Working agreement

- Do what was asked. Do not refactor, rename, or add files beyond the request.
- Do not claim work is done until the gate passed in this session. Say what you ran.
- If a hook blocks an action, do not work around it. Report it. Scratch files go under `.doug/.state/scratch`; protect-paths keeps refusing the Claude Code session scratchpad, which is outside the project.
- While `.doug/plan.json` is approved, change only files its tasks own. The stop gate blocks anything else; widen the plan and have it re-approved instead.
- Do not add `Co-Authored-By` or `Claude-Session` trailers to commit messages.
- Two tracks: a card's track is picked by size and risk (docs/board.md `track`); `/doug-next <id>` routes a hand card to doug-hand. In this repo a hand card follows `.claude/skills/harness-fix/SKILL.md`.
- Be terse: use the fewest words and tokens that carry the point. No preamble, no recap, no restating the question.

## Gotchas

- The Models table below is parsed by plugins/doug-flow/lib/models.mjs. Keep the heading and columns; the prose around it is free.
- Plan verify commands use `pnpm test:unit`, never `pnpm test`.
- A vendored hook file changed mid-session leaves the running state file stale until it self-repairs on the next Stop.
- A hook reader must never throw: `runHook` fails open on any exception, logging the error and letting the gate pass instead of blocking.

## Models

Which model does which work when a Doug plan runs. `inherit` = the session model or the role's default effort. Rows that are not roles are named tiers a task can pick with `"tier": "<name>"` in the plan.

| Work      | Model   | Effort  |
|-----------|---------|---------|
| plan      | opus    | high    |
| lead      | inherit | high    |
| worker    | sonnet  | medium  |
| implement | sonnet  | medium  |
| verify    | opus    | high    |
| review    | opus    | high    |
| adversary | codex   | low     |
| integrate | sonnet  | medium  |
| cheap     | haiku   | medium  |

The `lead` and `worker` rows are the swarm's (a plan with `swarm` on): the lead splits a task into worker briefs and merges them. The adversary runs on Codex via `codex-review`, relayed unchanged by a haiku agent. When Codex cannot run, the workflow falls back to `adversary-claude` on the plan's `adversary.fallback` (default Opus, high). Details: docs/worker-contract.md. The `plan` row is the planner's and the research step's researchers'. The rows route work by type on both tracks: the session model is the lead only (it briefs, gates, and records) and never does implement, verify, or review work itself: implement work runs on the `implement` row, review on the `review` row, a swarm's workers on the `worker` row; `doug-hand` spawns those through the Agent tool, and the workflow does the same in the flow.
