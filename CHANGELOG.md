# Changelog

## 1.6.0

- Stop gate: suites serialise on `gate.lock`, a seat's single-file test runs take the lock too (`gate-lock.mjs run`, including shell forms), a takeover of a stale lock is exclusive, and concurrent gates no longer time out under load.
- Stop gate: the queen's seat stop gates run in the card worktree.
- Stop gate: the verified-tree record is the only gate credit; the pre-commit credit (`preCommitCredit`, `last-run.json`) is removed.
- Stop gate: count-check, budget not-run and missing-evidence reason lines redact secrets in the configured commands they name; the secret-scan timing budget no longer flakes.
- Memory: `reflect --detach` runs the report as a detached `memory.mjs job`, and `reflect --failures` runs detached on a stop under a 0.5 cap; the failures match lists a pitfall as repeated only when its occurrence was written.
- Memory: `memory.db` waits on a busy lock with a timeout, and writers open with `BEGIN IMMEDIATE`.
- Scripts: `memory.mjs`, `board.mjs` and `learn.mjs` refuse a directory with no `.doug/`.
- Tests: SSE tests wait on events instead of fixed delays, the W14 lock-wait flake is fixed, and a stale replay skill-hash pin fails `test:unit`.
- Card loop: a reviewer-seat answer reaches a coder round.
- Card loop: `pick` holds a card behind an unplanned flow card.
- Docs: `learn` and decisions share one 200-line `CLAUDE.md` limit, and `scripts/mine-transcripts.mjs` reports seat wall time, re-runs and waste.
- Rehearsals: `rehearse --auto` build names the queue, and the 1.6 sweep passes all 18 scenarios on main.

## 1.5.0

- Memory: lessons are fetched on demand. `memory.mjs` prints a lesson index with token costs, `lesson show` and a history fetch return full text, and the lead fetches full lesson text into its briefs; flow tasks get the index plus fetch in place of the 400-char cut, and each outcome row records the delivery its track got.
- Memory: `reflect --hand` credits only lessons fetched into a brief, reads the failure slice, and can name a lesson a proposal repeats or supersedes; `learn` counts pitfall cards and sessions for path-scoped rules.
- Memory: recall scoring takes `harmful` and the evidence class into account, with an archive rule (store schema v12); `lesson unarchive` restores a lesson, and every reader uses one shared live-lesson predicate.
- Memory: an on-demand, cited project model (L2) with its own bench arm; `bench-memory` adds a delivery metric, multi-answer queries and a heading-split store arm.
- Memory: each card keeps an append-only run-history file, and a stopped by-hand or flow run records one stop row (`memory.mjs record --hand --stop`); a re-record keeps measured passes and fix passes.
- Memory: outcome rows stamp the memory configuration, and an arms report compares them; `memory.mjs lessons --unconfirmed` lists live lessons no run has confirmed, and `memory.mjs ideas` files cited idea cards to Backlog and records priority reviews.
- Memory: every `memory.mjs --dry-run` makes no paid model call, and `reflect --dry-run` still prints what it would credit.
- Card loop: a reviewer-seat answer reaches one coder fix round on resume, and every seat that may commit is told not to add trailers.
- Card loop: setup installs dependencies in the card worktree, the gate seat reinstalls a missing `node_modules`, and a gate hand-back must carry the gate command (the install match is exact).
- Card loop: a reused branch is rebuilt on the current base, and a minor re-report no longer reopens a ledger finding.
- Stop gate: verified-tree records stamp where they ran and the gate uses totals only from the run dir that wrote them; exit codes are credited across checkouts only when nothing was skipped, and `verify.mjs` refuses a foreign skipped record in main.
- Stop gate: the block reason redacts the failing command and its output, and the ratchet credit reads the record's baseline.
- A worktree agent's read-only skip compares against `origin/HEAD` as recorded at start.
- A plan landed after `done --force` is recorded as landed with its acceptance, and the summary and batch record count a forced landing as landed, with a per-card acceptance count.
- Planner: a signature the request states reaches the plan verbatim, and the swarm planner is told the shape gate.
- Gates show the phase or plan file in chat before asking for approval; the L-card offer says a `/doug-start` card is dropped from a batch.
- Detached eval and rehearsal runs post one completion line to the launching session; the lead launches them with `run_in_background`, since a bypass-mode lead holds `nohup`.
- Rehearsals: a `ts-orders` fixture with a scenario for every Doug command path, and a harder tier (`rehearse.mjs --tier hard`) on a `ts-rentals` fixture with cross-module tasks and longer queues; a stage that ends on a turn or budget cap is judged by its assert, and a session that exits non-zero fails its stage.
- CI: end-to-end replay tests of every scenario and a command journey run with no live model, and `test:e2e` is split out of `test:unit`; failing replays file Backlog cards through the `doug board` CLI.
- `doug ablate` and the evals docs know the testers arm.

## 1.4.0

- Board v2: the record is version 2 with epics, milestones, label groups and a priority order. `doug board labels init` migrates a v1 board (`type` holds its tags, `priority` is added), and `epic` and `milestone` take `add|edit|list` in both board CLIs.
- `doug board rollup` reports progress per epic and per milestone, and `labels --check` flags cards whose labels break the groups.
- The served board page shows coloured label chips, a milestone strip, epic, milestone and label-group filters, a priority-sorted Ready column, and a Done column that shows the latest 20 cards with a show all button.
- Ready reorders only within a priority band, with a hint when a move would cross one.
- `--milestone` on `autopilot.mjs pick` and `/doug-next` limits a run to one milestone.
- `autopilot.mjs answer` records an answer for any stop that asks, and `report` prints the resume with that answer; a stopped design-decision queen resumes with the answer.
- A gate seat that times out under load stops as `gate-timeout` and reruns alone; `autopilot.mjs end` refuses while a card is In flow and not resumed.
- The autopilot pane clears at a new `--auto`, groups short lines, shows each card's seat history, and shows spend against the caps.
- `queen-args` takes `--research on|off` and uses the project's current branch as base; `autopilot.mjs report` accepts a queen result saved with its task-output wrapper, and a queen's inline research note is written to `.doug/.state/research/<card id>.md` so `record` promotes it.
- Card loop: mutation ids are `M<n>` and seats echo the listed ids verbatim; each seat gets the hand-back schema its lane's validator accepts; the full lane accepts an empty `tests_red_by_design` when every listed mutation fails; unrunnable mutations, including a tests-only tester's, carry to the reviewer; a mutation id the lead did not list is refused, split ids `<id>a` and `<id>b` cover the listed id, and `autopilot.mjs report` prints the resume with an answer only when the answer is for the stopping seat.
- Card loop: the commit seat commits only the gated tree and stops on a commit-tree mismatch; a relayed user message about other work stays outside the seat's card.
- Card seats may not start a CPU burner for a loaded proof without human approval.
- Stop gate: the main checkout's test-count baseline is the last green record, and read-only seats are not blocked by count changes; a turn that only commits non-test paths counts as read-only; a doc named only by its basename in a comment in non-test code no longer forces the full unit suite on a docs-only Stop or pre-commit.
- The block ledger records the failing command, exit code, output tail, cwd and tree of a blocked stop, and gains a test-count class.
- `recall`, `brief-lessons` and the SessionStart line report what the stale window hid.
- `doug cost` attaches a report's Codex line only to the run it belongs to.

## 1.3.0

- Crew testers: `plan.mjs set crew.testers <n>` (default 1) runs that many verifier agents in parallel per full-shape task; seats 2 and up probe edge cases and error paths, a criterion any seat fails fails, and size S keeps one check.
- `memory.mjs reflect` offers a CLAUDE.md candidate when a new lesson has no home, written to `.doug/.state/learn/claude-md-candidates/<lesson id>.json` with the `claude-md propose` command printed; it never writes CLAUDE.md.
- Faster lesson recall: recall caches decoded vectors in process, so warm hybrid recall at 100,000 lessons drops from 1159 ms to 212 ms p50 (embeddinggemma); a fresh process is still 665-716 ms.
- `autopilot.mjs agent-types` prints a queen's agent types, and `/doug-next` launches no queen when one is missing (run `/reload-plugins` or restart).
- Each card queen's run name carries its short card id (`<label> card-queen`, `<label> flow-queen`).
- A seat agent that throws becomes a stopped report, not a run with no report; commit seats run `git commit` in the foreground with a 600000 ms timeout.
- Research: one question per researcher, each brief names where to read and a turn budget; researcher and reviewer maxTurns go from 30 to 40.
- The research cap lets loopback fetches piped to head, tail or `python -m json.tool`, with `2>&1`, escaped JSON bodies and line continuations through, and its counter lines carry the URL hosts.
- The stop gate keys the test-count baseline per worktree.
- In the card loop, a reviewer major that carries evidence gets one fix pass, as a blocker does; one still open stops the card (`reviewer-major-open`) and autopilot asks.
- The gate seat never runs `git add` or `git commit`; a gate hand-back that does is invalid and stops the card.
- The autopilot pane also refreshes on prompt submit, turn end, and after each Bash call, so a new run shows after a reload drops the pane's timer.
- `/doug-next` names each per-card `queen.js` by `scriptPath`, and the `autopilot.mjs` usage names `--with` and both written paths.

## 1.2.0

- Parallel cards (ADR 0015): `/doug-next --auto` runs disjoint cards at once in one session, a Workflow queen per card; a hand card's queen runs the host-neutral card loop, a flow card's queen runs doug-implement on its own per-card plan (`plan.mjs --card`).
- Cards land one at a time: `plan.mjs land-card` for hand cards, and a flow card landing on a moved main rebases, gates the rebased tree, then merges.
- `gate.lock` lives in the git common dir, shared by every worktree; `verify.mjs` and `land` report how long they waited on it.
- Each doug-implement run gets its own integration worktree.
- Plugin agents `doug-flow:tester` and `doug-flow:coder`.
- `/doug-start`: a project mode (Idea, Architecture, Walking skeleton, Scope) and a feature mode (Specification, Pseudocode, Architecture, Refinement), each phase behind a human gate; `/doug-next` and `doug-hand` offer it for an L card with no spec, and `doug init` names it in an empty repo.
- The autopilot queue shows live in a Claude Code pane that opens when a run starts, and on the served board.
- Autopilot's USD cap comes from a measured size x class table; hand landings record their cost.
- Every card landing and the autopilot close print a per-card recap; the landing block (Changed / Outcome / Learned) is enforced by the Stop gate.
- `doug memory setup` offers a bundled embedding model when no server runs.
- The outcome log records each task's stop class (schema v9).
- User-asked cards quote the request and mark where each decision came from; scoping questions target the broadest word.
- `doug-hand` says when the lead should recommend a swarm.
- The wall budget table skips rehearsal entries and sums a card's repeated entries; rehearsal records say "rehearsal <scenario> passed|failed", never landed.
- Stop gate fixes: per-card plans are read; a shown landing block is consumed on a deferral or stand-down; ledger rows re-derive onto parents of in-session commits; the SubagentStop read-only skip compares a worktree agent with its own base.
- `bash-rules`: the pnpm-only rule ignores package-manager words in heredoc data.
- `reflect --hand` accepts `R<n>` or `<card>/R<n>`.

## 1.1.1

- Every landing starts with a one-sentence summary: `board.mjs record` and `summary`, and `doug board record` and `summary`, require `--summary "<one sentence>"` and print it first; the docs show the flag on every form.
- `doug --version` and `-v` print the cli version.
- `doug board move`, `board.mjs move`, and a drag on the served board warn when a move fills Ready past the cap.
- A card the user asks for during autopilot is scoped at once and filed to Backlog, and the queue resumes.
- A hand-track landing whose wall clock exceeds its size x class budget is flagged.
- Flow verify, check, review, and adversary prompts carry the recalled lessons, marked as context, not spec.
- Reflect bumps a lesson's harmful count only when the lead names it with `--harmful`.
- `context.mjs` reads the lead's own session by default, via `CLAUDE_CODE_SESSION_ID`.
- `cost.mjs` prices claude-haiku-5-5 per request by prompt-length tier.
- `verify.mjs` takes `gate.lock` like the Stop gate and waits on it for the gate's bound; `plan.mjs land`'s timeout covers the wait.
- The stop gate adds no main-checkout run for a write under `.doug/.state`.
- The default agent budget is 26, so the default fix attempts stay reachable.
- The Claude fallback adversary runs only the task's own verify, like Codex.
- Swarm runs: the lead's merge and re-brief work from their own worktree and the repository root, not the lead's removed worktree.
- `plan.mjs json` fills a missing `baseBranch` from the checked-out branch, and the planner gets the absolute scripts path in its prompt.
- `doug memory setup` probes a `--url` equal to a default endpoint once.
- `guard-bash`'s `env -S` handling is linear, so a deeply nested payload cannot outrun the hook.
- Published bin paths are in npm's normal form, and `release:check` flags every bin form `npm publish` would rewrite.

## 1.1.0

- `doug init` is guided: it runs the doctor checks at the end, prints each warning with its fix line, and finishes with a "You're ready. Next:" screen.
- `doug doctor` also checks the statusline, subagent settings, board, adversary, embeddings, and plugins, and stays read-only.
- `doug memory setup` finds the embedding servers running on your machine (Ollama, Unsloth Studio), verifies each, lets you choose which to enable, and re-embeds your lessons; `doug init` offers it.
- Embedding presets (`ollama`, `unsloth`, `openai`, `voyage`, `custom`) fill in the provider details; a local server never needs an API key.
- Memory recall and code search print a warning when they fall back to keyword-only matching, with the fix.
- Every session consults memory: a SessionStart hook surfaces the lessons relevant to the card in flow, and `doug-hand` briefs carry them.
- `/doug-next --auto` runs an approved queue of cards with one approval up front, and stops and asks on a design decision, a repeated red gate, a hook block, or a spent cap.
- Autopilot without a card count re-reads Ready between cards and stops when the lead's context reaches `autopilot.contextThreshold` (default 60); `node plugins/doug-flow/scripts/context.mjs` prints that percentage.
- Autopilot's wall budget per card comes from a size x class table at the measured p80, and `board.mjs budgets` recomputes it from `docs/live-runs.md`.
- The lean lane: a size S `prose` or `docs` card in `doug-hand` runs one coder then the reviewer, with no tester seat; `doug init` always writes the tester agent.
- Flow runs the full suite at most once per tree and stage, and the adversary runs alongside verify and review instead of after them.
- The flow run flags tasks, passes, and stages that exceed their wall budget, and `board.mjs summary` shows a stage wall row.
- `node .doug/hooks/scripts/verify.mjs` writes a verified-tree record that the Stop gate, the SubagentStop gate, and `plan.mjs land` credit, so a tree already verified is not re-run.
- The stop gate verifies only when the finishing turn changed code, and skips when only paths with no tests changed or a docs-only change names no test.
- The stop gate verifies a worktree agent in its own worktree, and every tree an agent edited.
- The stop gate no longer defers for read-only agents in flight, and a repeated deferral is silent.
- The stop gate reruns a command killed by a signal instead of reusing its result, and the test-count ratchet compares the number of test summaries.
- `doug board add` and `doug board next` warn on stderr when Ready holds more than 7 cards; follow-up cards from a landing go to Backlog at a ranked position.
- `doug init` keeps your `memory` settings on a re-run, writes the workflow concurrency cap as 16, and names your project's own test command in the generated agents' rules.
- The research cap lets a lone `curl` or `wget` to `localhost` through, so local model probes are not counted as web fetches.
- `docs/getting-started.md` has a "Start a new project" recipe: eight steps from `git init` to `/doug-next`, with the board cards added via `doug board add --column ready`.

## 1.0.3

- `doug doctor` runs read-only install checks and prints one fix line for each problem.
- `doug init` writes a one-hour subagent prompt cache and a workflow concurrency cap into the settings it generates.
- `doug init` keeps a `skills:` block you add to a generated role agent when it refreshes the agents.
- The by-hand loop is now `doug-hand`: `/doug-next <id>` routes hand-track cards to it, and `/core-next` is retired.
- Flow reports carry a typed `stopClass` beside the prose stop reason.
- The stop gate reuses its last failure once when the tree has not changed, instead of rerunning the commands.
- The run trace redacts credentials in tool details and in permission-denied reasons.
- The stop gate refuses a drop in test count or a rise in skipped tests, and the pre-commit hook skips the gate when only paths with no tests are staged.
- Memory recall ranks lessons by cosine similarity times recency when embedding vectors exist, and gives mxbai and qwen3 models their query prefixes.
- `doug board serve` polls alongside `fs.watch`, so a dropped file-change event is still pushed to the page.
- Research steps mark a design-deciding fact as verified only when it appears in the raw page text, with its line number.
- The README opens with a scannable top screen; reference detail moved to `docs/reference.md`.

## 1.0.2

- The status line shows the installed doug-gates version.
