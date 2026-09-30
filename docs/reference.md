# Reference

Detail moved out of README.md so the top screen stays scannable ([why](../README.md#why-doug), [quickstart](../README.md#quickstart)).

## Overview

- **Nothing lands without your yes.** A change becomes a written plan first; `plugins/doug-flow/workflows/doug-implement.js` refuses to run an unapproved plan, and `/doug-approve` (`plan.mjs approve`) is what approves one.
- **A turn blocks on broken or untested work, up to a cap.** The stop gate runs typecheck and tests before Claude's turn finishes and blocks it while they fail, or while the session never ran a check itself, for up to 3 blocks in a row (each subagent counted separately; the count resets on a green gate); past that, or on the gate's own crash or timeout, it stands down and fails open (`plugins/doug-gates/scripts/stop-gate.mjs`).
- **The model can't edit its way around the rules.** `.env` files, the lockfile, migrations, and anything outside the project are denied at the edit itself (`plugins/doug-gates/scripts/protect-paths.mjs`).
- **A second, different model argues against the first.** After review, `codex-review` re-reads the diff on Codex and tries to refute it; a blocker keeps the change out (`packages/doug-codex`). Codex is optional: without `@dougharness/codex` and the Codex CLI installed, the Claude `adversary-claude` agent stands in instead.
- **It remembers what went wrong before.** Past lessons are recalled by keyword (semantic recall with `memory.embeddings` set) and put in front of the next task before it starts (`plugins/doug-flow/lib/memory.mjs`).
- **You can see the queue and the receipts.** A live board tracks every card, and `cost.mjs <run-id>` prices a workflow run on demand from its local transcripts and a price table (`doug board serve`, `plugins/doug-flow/scripts/cost.mjs`).

### Key features

- Plan-approve-run: a JSON plan you review before code changes (`plugins/doug-flow/lib/plan.mjs`)
- Stop gate: blocks a turn or subagent from ending while typecheck or tests fail, up to a cap (`plugins/doug-gates/scripts/stop-gate.mjs`)
- Guard rails on edits and commands: protected paths, a bash command guard, a secret scan (`plugins/doug-gates/scripts/protect-paths.mjs`, `plugins/doug-gates/scripts/guard-bash.mjs`, `plugins/doug-gates/scripts/secret-scan.mjs`)
- Cross-model adversary review via Codex, with a Claude fallback (`packages/doug-codex`)
- Lesson recall and an opt-in code index feeding each task (`plugins/doug-flow/lib/memory.mjs`, [docs/memory.md](memory.md))
- A live board and a per-run cost report (`doug board serve`, `plugins/doug-flow/scripts/cost.mjs`)

## Install from a clone

For contributing, use the from-a-clone path:

```sh
pnpm bootstrap                                                                  # one-command setup
pnpm install --frozen-lockfile
pnpm build
node packages/doug-cli/dist/bin.js init <path-to-a-typescript-repo> --dry-run
node packages/doug-cli/dist/bin.js init <path-to-a-typescript-repo>             # writes after approval
```

`doug init` detects the project's tooling deterministically and proposes: `.doug/config.json`; the vendored hook scripts and their `lib/` under `.doug/hooks/`; the merged `.claude/settings.json` (hooks, a command allowlist, and the status line); a short `CLAUDE.md` only when none exists; the standard subagents under `.claude/agents/`; the generated project skills under .claude/skills/; and, when the project has no board yet, an empty `.doug/board.json`. Nothing is written before the diff is approved.

`config.subagents.maxSpawnDepth` (`doug init` proposes `1`) is merged into `.claude/settings.json` as `env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, Claude Code's own per-project subagent nesting limit: `1` means only the session lead orchestrates agents; no subagent can spawn one.

The gate is `pnpm typecheck` and `pnpm test:unit`. `pnpm test` additionally runs `packages/doug-codex/tests/codex-live.test.ts`, which spawns Codex and costs usage.

Every test file's temp files live under one `doug-tests-*` directory in the OS temp dir (`tests/setup/tmpdir.mjs`, a Vitest setup file that scopes `TMPDIR` per test file), removed in that file's `afterAll` when it finishes. If the OS temp dir fills with `doug-*`, `ts-app-*`, or `codex-review-*` directories, they are from runs before 2026-09-13 or from a killed worker; delete them once no test run is active (a `doug-tests-*` root belonging to a run still in flight is live, not leaked).

## Onboarding

`pnpm bootstrap` takes a fresh clone to a working Doug: it also reports whether `codex` is on `PATH` and, when there is no pnpm global bin dir, prints the node fallback command instead of linking `doug`.

Then, in a target repository:

```sh
doug init <repo>
doug board init <repo>                      # or: doug board add <id> --title <t> --goal <g>
claude --plugin-dir plugins/doug-gates --plugin-dir plugins/doug-flow
/doug-next
```

See [docs/onboarding.md](onboarding.md) for what each step writes and never does.

## Gates

| Hook | Event | Behavior |
|---|---|---|
| protect-paths | PreToolUse Edit/Write | Denies edits to `.env*`, the lockfile, migrations, generated dirs, and anything outside the project. |
| guard-bash | PreToolUse Bash | Denies `--no-verify`, force-push to protected branches, a catalogue of destructive commands, and the wrong package manager. |
| secret-scan | PreToolUse Edit/Write, Bash | Denies writing text or running a command that carries a credential: AWS access key ids, PEM private-key headers, GitHub and Slack tokens, and inline password/secret/api_key/token assignments with a literal value. Placeholder prefixes are exempt; only new text is scanned, so removing a secret is never blocked. |
| format-on-edit | PostToolUse Edit/Write | Runs the detected formatter on the edited file. Reports parse failures back to Claude. |
| edit-loop | PostToolUse Edit/Write | Counts edits per file per session and nudges after the threshold. |
| stop-gate | Stop, SubagentStop | Runs typecheck, lint, and tests when anything changed. Blocks the turn from ending while they fail, up to a cap, and while the session itself has run no test or verify command. Also blocks if a protected file changed through Bash, or if a changed file is outside an approved plan's scope. On green, records a checkpoint if `checkpoint.enabled` is set. On timeout, a command's whole process group is killed, not just its direct child. A green gate records the verified tree in session state, so a later Stop/SubagentStop whose tree still matches skips re-running the commands. Only one gate runs the commands at a time per project; a concurrent gate waits on `.doug/.state/gate.lock`, bounded by `stopGate.timeoutMs` times the number of configured commands, and a waiter that outlives that bound runs its own commands rather than waiting forever. The wait is also bounded by `stopGate.hookTimeoutSec` (default 600, must equal the stop-gate hook's own `timeout`); past that budget a waiter blocks instead of running, and a command that cannot fit before the budget is not run and is named in the block message. |
| reanchor | SessionStart compact/resume, PostCompact, PreCompact | On SessionStart compact/resume, re-injects tooling facts, commands, and `.doug/anchor.md` (a compaction snapshot in it goes first). Before compaction (PreCompact) it snapshots the plan, task ownership, the decision files, and the session's edited files and recent commands into the anchor between marker lines; PostCompact does nothing further. |
| session-start-baseline | SessionStart, every source | Captures the dirty-tree baseline as early as the event allows, so a tree the session never touches can skip verification at Stop. Idempotent (only writes when no baseline is recorded yet); labels the capture `session-start` only when the session has not acted yet and the source is `startup`, otherwise `stop`. Never blocks. |
| trace | SubagentStart, SubagentStop, PreToolUse, PostToolUse (every tool) | Appends one JSON line per event to `.doug/.state/trace/<session>.jsonl`; `doug trace` replays it and attributes tool calls, wall time, and tokens per agent. Observation only. |
| statusline / stop-gate | (statusline command), Stop | With `contextWindow.enabled`, records the context-window percentage and, at a green Stop past the threshold with no subagent running, tells the user to `/compact` and refreshes `.doug/anchor.md` with a handoff block. Off by default; advises only, never compacts. |

Every hook is a plain ESM script with zero dependencies, fails open with a visible message on its own bugs, and is tested by spawning it with real hook JSON.

**Git pre-commit gate.** `.githooks/pre-commit` is a checked-in plain sh script activated by `core.hooksPath` (set on `pnpm install`, no husky). It runs `pnpm typecheck` and `pnpm test:unit` on every commit from any tool and refuses the commit with the failing output; `--no-verify` is denied by guard-bash.

**Secret scan configuration.** When secret-scan denies a write or a command, the reason names the rule and the file or the command but never echoes the matched text, so the secret itself never lands in the transcript. It is configured under `secrets` in `.doug/config.json`: `secrets.enabled` turns the whole gate off, `secrets.rules.<awsKeyId|pemPrivateKey|githubToken|slackToken|inlineAssignment>: false` turns off one rule at a time, `secrets.placeholders` lists value prefixes compared case-insensitively against the assigned value, and `secrets.ignorePaths` lists globs matched against the project-relative file path.

**Plan-versus-diff scope.** While `.doug/plan.json` is `approved` or `done`, the stop gate computes the union of the files the plan's tasks own and compares it with `git status`. Any changed file outside that union blocks the turn, naming each file and the nearest owning task; the fix is to revert or to widen the owning task and re-approve, never to work around the gate. `stopGate.planScope: false` turns it off.

**Verification evidence.** With `stopGate.requireEvidence` on (the default), a turn that changed files is blocked while none of the Bash commands the session ran is a gate command, a configured project command, a known test runner, or a match for `stopGate.evidencePatterns`. The message distinguishes a green gate the session never ran itself from a failed gate the session never looked at.

**Subagents go through the same gate.** The stop gate also runs on SubagentStop: the same commands, protected-path scan, plan scope, and verification evidence, with the block message naming the subagent. A subagent's green gate records no checkpoint, since that belongs to the session's own Stop. A timed-out command's process group is killed so it cannot leave orphaned processes behind (e.g. a background test worker a command spawned). Concurrent Stops and SubagentStops of the same session share one verification run instead of each starting its own: a gate holds `.doug/.state/gate.lock` while its commands run, and a second gate that finds it live waits (reloading session state once it clears) rather than also running the full suite.

**Checkpoint on green.** With `"checkpoint": { "enabled": true }` in `.doug/config.json`, the stop gate records the working tree every time it passes with changes present, so a regression can be undone with git instead of by memory. `mode: "commit"` stages every change except Claude Code's worktrees and commits `doug: checkpoint` on the current branch, with the gate results in the body. `mode: "tag"` builds the same commit off a temporary index and tags it `doug/checkpoint/<utc time>`, leaving the branch, the index, and the working tree exactly as they were. It never runs while a protected path is dirty, and it skips on a detached HEAD. Off by default.

**Run trace.** With `"trace": { "enabled": true }` (the default) the trace hook writes one line per subagent start and stop and per tool call to `.doug/.state/trace/<session>.jsonl` (gitignored, local): the time, the event, the agent id and type when inside a subagent, the tool, a one-line detail, whether the call failed, and tokens where Claude Code reports them. `doug trace [dir] [--session <id>] [--json]` replays the newest session and prints a per-agent table of events, tool calls, failed calls, wall time, and tokens.

**Context-window handoff.** With `"contextWindow": { "enabled": true, "threshold": 80, "repeatAfter": 5 }` in `.doug/config.json`, the status line records `context_window.used_percentage` into session state and marks its segment (`ctx 85% compact?`) once it reaches the threshold. `enabled` turns the feature on (default false, so an existing project is unchanged), `threshold` is the used_percentage that triggers the notice (default 80), and `repeatAfter` is how many more points of growth pass before the notice repeats (default 5); `doug init` proposes the status line that reports the percentage, and `trace.enabled` must stay on (the default), since the "no subagent running" check reads the run trace. At the next Stop of the main session, if verification passed or nothing changed, and no subagent is still running, the Stop gate refreshes `.doug/anchor.md` with a handoff block: the boundary, the gate result where the boundary ran one, HEAD, and the context percentage, and prints a message asking the user to run `/compact`. It never blocks a Stop and never touches the stop gate's block counters, and PostCompact clears the reading.

After `/compact`, the PreCompact snapshot and the SessionStart re-injection carry the plan, task ownership, the decision files, this session's edited files, and recent commands into the compacted context; the snapshot itself also carries the last gate result when one was recorded, HEAD, and the context percentage when one was recorded, under a Handoff boundary block, so the next context starts from those too. This applies to the main session that runs `/core-next` or `/doug-next`, the lead. It never fires while any subagent is in flight, including a workflow's stage agents, since the check reads the run trace; a run itself is not tracked, only its agents, so during a `doug-implement` run the notice waits until the run returns and the lead's turn ends green. Subagents have no status line and no handoff of their own (card `worker-context-handoff`). No hook can trigger or schedule a compaction, and the model cannot run `/compact` itself, so the harness only advises; if the user does not run it, the runtime compacts on its own at its token threshold, exactly as before.

## The flow

`plugins/doug-flow` turns a request into a plan file, waits for approval, and then executes it with Claude Code's Workflow tool.

```
/doug-plan <request>     planner subagent writes .doug/plan.json and shows it
/doug-approve            validates the plan, marks it approved, writes .doug/anchor.md
/doug-implement          runs the doug-implement workflow on the approved plan
/doug-swarm <card-id | goal>   plans and runs a plan with the swarm opted in
/core-next               hand-track loop: harness work built directly, outside the flow
/doug-next [card-id]     the loop: next board card -> plan -> approval -> implement -> land -> next?
/run-report              appends a docs/live-runs.md entry and prints the run summary
```

The plan file is the contract. Each task names the files it owns, a verification command, and its dependencies. The validator rejects duplicate ids, unknown or cyclic dependencies, absolute or escaping paths, and two independent tasks owning the same file. An acceptance entry is either a prose string or `{ text, command }`, where `command` is one shell line that exits 0 when the criterion holds; the validator rejects an object missing either field.

**Pipeline shape by size.** A task carries `size`: `S`, `M`, or `L`. A size-S task runs the implementer and then one focused check (verify, scope, commit messages, and review together), with no adversary of its own; the adversary reviews a level's S tasks together, once, on the integration branch after the merge. M, L, and unsized tasks keep the full shape: implementer, verifier, reviewer, and their own adversary, each in its own worktree.

**Human gates between levels.** A task may carry `gate: human` (default `auto`). After that task's level has integrated, the workflow writes its report with `paused: { level, gate, next }` and stops before the next level. `plan.mjs gate open <level>` opens the gate and resumes the run.

**Crew per task.** A task or the plan may carry `crew: { researchers, reviewers, adversaries }`, one each by default. Extra reviewers and adversaries run in parallel and every seat's findings enter a finding ledger, where a fingerprint collapses a duplicate to one id.

**The swarm inside a task.** A plan opts in with `plan.mjs set swarm on`. Every full-shape task then runs as a swarm instead of one implementer: the `lead` agent creates the task branch, splits the task into worker briefs each owning a disjoint subset of the task's files, and the `implementer` agents on the `worker` row implement them in their own worktrees before the lead merges the branches back and runs the task's verify command. Verify, review, the adversary, the ledger, and integration then run unchanged on the merged branch. `swarm-launch` is the launch step `/doug-implement` and `/doug-swarm` share; `/doug-swarm <card-id | goal>` plans on the `plan` row with swarm on and runs the same launch step. A deterministic shape gate keeps a task that owns one source file and its tests off the lead entirely (a single implementer runs it instead), and every split the lead does make carries a required `splitReason` so the report can tell an unsplittable task from one nobody tried to split. A worker that blocks (not still-partial) gets the lead back once, in its own worktree, to re-brief the unfinished pieces from the blocked briefs' own files before the task blocks; a second block ends it. `plan.mjs set workerCheck on` (default off) adds a deterministic check before the merge - a worker whose filesTouched strayed outside its brief, or who never committed, is blocked the same way and follows the same one-re-brief-then-block path. The swarm pays on a task with independent deliverables that share no new symbol; a plan of small coupled tasks runs as the pipeline (decision 0001, Amendment 2026-09-20: one brief per task at +2.67 USD and +6.1 min against the pipeline on 2026-09-11; five briefs, 8/8 hidden tests, 8.31 USD, 8.5 min on 2026-09-19).

**The fix loop.** After the implementer, verifier, reviewer, and adversary have run, a task that is not ready for integration is retried when the block is retriable (every finding that names a file names one of the task's owned files, the implementer did not report itself blocked, the checking stages ran, and no finding is a spec contradiction). A fix pass relaunches the same implementer in the same worktree and branch, then reruns the blocking stage; once it passes, a focused check replaces the full verifier and reviewer reruns before the adversary confirms. Findings live in a finding ledger with stable ids, fingerprinted by stage, file, and text, and recorded per task in the report.

**Re-planning after a blocked pass.** `plan.mjs replan` sets the plan back to draft and marks every task that passed all stages with `"reuse": "<branch>"`. On the next run the workflow skips the implementer for a reused task and puts its branch in a fresh worktree, then reruns verify, review, and the adversary on it.

**Landing.** `plan.mjs done` records the decision and `plan.mjs land` merges the integration branch into the base branch: it checks out the branch in a worktree, runs the plan's install and verify commands there, then every acceptance command, and only then merges with `--no-ff`. It refuses, with a reason and no partial state, when the plan is not done, the branch is missing or already merged, the base branch is not the one checked out, a tracked file outside `.doug/` is modified, a verify or acceptance command fails, a commit on the branch carries a `Co-Authored-By` or `Claude-Session` line, or the merge conflicts. `plan.mjs land --delete-branches` deletes the plan's task branches after the merge.

**Cost per run.** `plugins/doug-flow/scripts/cost.mjs <run-id>` measures a run's cost after the fact from the local Claude Code transcripts, turning recorded token usage into dollars per agent, per task, per stage, and per run.

**Models.** CLAUDE.md's `## Models` table names a model and effort per role, parsed by `plugins/doug-flow/lib/models.mjs`:

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

**The adversary.** After review, an adversary stage runs `codex-review`: a different model reviews the branch read-only and is prompted to refute it. A `fail` verdict or any `blocker` issue keeps the task out of integration. When Codex cannot review, the `adversary-claude` agent stands in on the plan's `adversary.fallback` row (default Opus, high effort). See The worker contract below for the adapter's interface.

**The research step.** A card whose goal depends on a fact outside the repository (a Claude Code hook contract, a CLI's output format, a third-party API) gets a named research step before its plan, run by `/core-next`, `/doug-plan`, and `/doug-next` when the goal calls for it. Claude Code questions go to the `claude-code-guide` agent, anything else to the plugin's read-only `researcher` agent, which reads primary sources, quotes each with its source, and never installs or writes; the answers merge into one cited note the planner reads before writing the plan, plans on the `plan` row like every other planner spawn.

**Memory in the flow.** `plan.mjs json` attaches the top lessons the memory store recalls for each task's spec and owned files, capped at 2000 characters, to the plan JSON it emits; the workflow puts a task's lessons in front of its implementer, and the report records `memoryUsed`, the ids of the lessons an implementer actually saw (empty for a reused task, which carries no lessons, or one for which no implementer ran — a dependency that never integrated is one such case). The planner runs a recall before it decides tasks and treats each returned lesson as a constraint. Recall is keyword-only unless `memory.embeddings` is configured — see [docs/memory.md](memory.md). An opt-in semantic index of the repository's own code (`memory.mjs index build`/`status`/`search`) is documented there too; only with `memory.index.enabled` does the flow attach a task's top code chunks the same way, put them in front of its implementer, have the planner search the index before deciding tasks, and record `indexUsed` in the report beside `memoryUsed`. `doug-learn` counts signals from that same store and the run trace and proposes changes as diffs the user approves — see [docs/learn.md](learn.md). `docs/decisions/` ADRs and Claude Code rules conventions are writable only the same way, through `/doug-decide`'s proposal diffs — see [docs/memory.md](memory.md#decisions-and-rules-the-proposal-path).

## The board

`.doug/board.json` is the development board's record, a queue of scoped cards with column, component, size, dependencies, and the goal text a doug flow runs; its schema is in [`docs/board.md`](board.md).

**Viewing the board.** The board is the page `doug board serve` serves on 127.0.0.1; it is started by hand, not at login. From the repository root:

```sh
doug board serve --detach --open   # start it in the background and open it in the browser
doug board serve --open            # already running: prints its URL and opens it, no second server
doug board serve --stop            # stop it
```

The page updates itself whenever the record changes, whether from a Claude session, the CLI, or a drag on the page, and shows "Lost the connection to doug board serve; reconnecting…" while the server is down. It listens on port 8787 unless `--port <n>` says otherwise, so http://127.0.0.1:8787/ can be bookmarked. A reboot ends the server, so start it again after one. If `doug` is not on your PATH, run `pnpm build` and link `packages/doug-cli/dist/bin.js` into a directory on your PATH as `doug`, or run it with `node packages/doug-cli/dist/bin.js`.

```sh
doug board init    # writes the default columns, no cards
doug board add     # appends a card
doug board list    # lists cards
doug board next    # prints the first Ready card whose dependencies are Done
doug board reorder # moves a card within its column
doug board move    # changes a card's column and optionally its source
doug board remove  # deletes a card from the record (--force for a done, in-flow, or planned card); prints the removed card as JSON
doug board edit    # changes a card's fields through the record's validation (never the id or the column)
doug board record  # appends a run entry to docs/live-runs.md
doug board build   # renders the page to stdout or --out
doug board serve   # the live board page: --open opens a browser, --detach backgrounds it, --stop ends it
```

`add`, `edit`, `list`, and `next` take `--tag <name>` to set or filter by a card's tag from the board's closed vocabulary; `list --tag` and `next --tag` filter to cards carrying that tag, and `next --tag` does it silently, with no "skipping" line.

`plugins/doug-flow/scripts/board.mjs` is the plugin-only equivalent for sessions that have only the plugin, not the CLI: `next`, `card`, `move`, `edit`, `remove`, `reorder`, `record`, and `summary`, matching the CLI's subcommands of the same names (it has no `init`, `add`, `list`, `build`, or `serve` — those stay CLI-only). It and the CLI share `plugins/doug-flow/lib/board.mjs`, which validates the file (unique ids, known columns and components, dependencies that exist); the two `record` command layers do not otherwise share an implementation, but both call `lib/board.mjs`'s `recordLanding` for the record step itself — promoting a card's research note from `.doug/.state/research/` to `docs/research/` before appending the run entry — so that step cannot drift between them again. The CLI's `record` still lacks the plugin's `--rehearsal <scenario>` flag (both forms) and, on the run form (report-driven) only, `--note <text>`. A static snapshot is `doug board build --out <file>`. `/doug-next` and `/core-next` no longer invoke it after a board change: the loops leave a card's move uncommitted, the page served by `doug board serve` shows it live, and the record lands in the card's landing commit.

`/doug-next [card-id]` chains plan, approval, implement, land, and the board move for one card at a time, stopping at approval and again to ask before taking the next card. A card with `track: "hand"` is skipped by `board next` and refused by `/doug-next`; `/core-next` takes it instead, doing the work directly without the workflow. `/doug-next <id> <id>...` or `/doug-next --batch <n>` plans several cards together into one merged plan, one approval, and one land; `/core-next <id> <id>...` or `/core-next --batch <n>` does the same for hand-track cards, swarm-only.

## Status line

`doug init` proposes `"statusLine": { "type": "command", "command": "node .doug/hooks/scripts/statusline.mjs" }` in `.claude/settings.json`. The script reads the status-line JSON on stdin and prints one line, e.g.:

```
Doug 1.0.2 · Opus · main · ctx 8%
```

The segments are the product name from `.doug/config.json`, the installed `doug-gates` version (`.doug/hooks/VERSION`, falling back to config `doug.version`), `model.display_name`, the current git branch, and the used context-window percentage. Fallbacks: `ctx --` before the first API call or after `/compact`, no branch segment outside a git repo, and the bare line `Doug` on any error. Always exits 0. Tests in `plugins/doug-gates/tests/statusline.test.mjs`.

## The worker contract

[`docs/worker-contract.md`](worker-contract.md) defines what every worker must return: spec in, diff plus evidence out, the same gates for any adapter. `packages/doug-codex` is the first worker adapter, implementing only the review role. `checkReviewResult()` in `packages/doug-codex/src/contract.ts` returns the violated rules by id, and `packages/doug-codex/tests/contract.test.ts` runs the adapter through every outcome it can produce (pass, blocker, non-zero exit, prose, no final message, wrong shape, working-tree mutation, binary missing, timeout) and asserts none.

```sh
pnpm build
node packages/doug-codex/dist/bin.js --base main --head doug/task-x --dir /path/to/worktree \
  --spec-file spec.md --verify "pnpm test" --verify "pnpm typecheck"
```

`codex-review`, deterministically:

- computes the changed files and the unified diff for `base...head` with git and embeds the diff (up to 60 KB) in a refutation-oriented prompt; refuses to run if `head` is not the commit checked out in `--dir`
- runs `codex exec --json --ephemeral --sandbox workspace-write` (or `read-only` with `--sandbox read-only`) inside the worktree with `--output-schema` constraining the final message to `{ verdict, summary, issues[] }`; MCP servers from `~/.codex/config.toml` are disabled by default (`-c mcp_servers={}`), kept only with `--keep-mcp`
- snapshots `git status` before and after: if the reviewer changed the working tree at all, the result is `inconclusive` with error kind `worktree-modified`
- sets `DOUG_CODEX_REVIEW=1` in the spawned `codex exec` environment and records it in the result as `marker`, so a nested review is visible in the output
- takes `commandsRun` and their exit codes from Codex's own event stream, never from the model's prose
- validates the final message against the schema again on the way in; a vague or malformed answer is `inconclusive`, not a pass

Output is one JSON object: `verdict` (`pass` | `fail` | `inconclusive`), `summary`, `issues[{severity, file, line?, description, evidence?}]`, `commandsRun[{command, exitCode, ok, outputTail?}]`, `changedFiles`, `usage`, `durationMs`, and `error` when the review could not run (`codex-not-found`, `timeout`, `codex-failed`, `no-final-message`, `unparseable`, `git`, `worktree-modified`). Exit code 0 means no blockers, 1 a fail verdict or blocker, 2 could not review, 64 usage.

## Layout

- `.claude-plugin/marketplace.json` — the Claude Code marketplace manifest listing `doug-gates` and `doug-flow` for `/plugin marketplace add`.
- `scripts/release.mjs` — the release check and stage script: version consistency across the seven manifests, and staging the cli and codex npm packages.
- `.githooks/` — the checked-in git hook directory; `pre-commit` runs typecheck and the unit tests on every commit once `core.hooksPath` points at it.
- `.github/workflows/ci.yml` — GitHub Actions: on push to main and on pull requests it installs with pnpm and Node 22, then runs typecheck, build, and test.
- `plugins/doug-gates` — the hook pack. Plain ESM scripts, zero runtime dependencies, each with tests.
- `plugins/doug-flow` — plan, approve, implement, verify, review, adversary, integrate: `plugins/doug-flow/skills/`, `plugins/doug-flow/agents/`, `plugins/doug-flow/scripts/`, `plugins/doug-flow/lib/`, and `plugins/doug-flow/workflows/`.
- `packages/doug-cli` — the `doug` command: `init`, `board`, `ablate`, `trace`.
- `packages/doug-codex` — `codex-review`, the Codex CLI as a read-only adversarial reviewer with structured output and real command evidence.
- `evals/` — a fixture repo and task set used to measure whether the gates and the install help: landed, hidden pass rate, post-landing defects, scope, cost, and wall clock, mean and spread over `--runs`.
- `docs/` — [`docs/worker-contract.md`](worker-contract.md) and [`docs/board.md`](board.md) (the board's schema).

## Measured

Every number below is from the project's run log.

| Run | Result |
|---|---|
| 2026-09-04, run 1: three tasks, two levels, no adversary | $4.11, 10.5 min |
| 2026-09-04, run 2: one task with the Codex adversary stage | $1.78 (Claude) plus one Codex review, 4.2 min |
| 2026-09-04, run 3: one task with the implementer on a cheaper tier | $1.40 total, 2.9 min, the implementer 6% of the cost |
| 2026-09-19, swarm-split-probe: five briefs, 8/8 hidden | $8.31, 8.5 min |

Whether parallel workers beat one implementer on cost, wall clock, or
defects is unmeasured: this is one swarm run with no pipeline pair, and a
single run is never a difference.

