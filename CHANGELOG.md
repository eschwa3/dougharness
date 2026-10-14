# Changelog

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
