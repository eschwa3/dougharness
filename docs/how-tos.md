# How-tos

Four walkthroughs for a Claude Code user new to Doug. Install first: [getting-started.md](getting-started.md).

## Your first card

1. In your project, run `doug init` and answer its prompts; it writes the hooks and the board, and never edits your source.
2. File a card in the Ready column with `doug board add`, for example `doug board add my-first-card --title "Add a health check" --goal "GET /health returns 200" --column ready`. `doug board list` shows it.
3. Start `claude` and run `/doug-next`. It plans the card and stops for your approval.
4. Read the plan, then approve it. The implement workflow runs verify, review and an adversary pass.
5. When the gate is green the card is landed: `plan.mjs land` re-runs verify and acceptance, merges only if all pass, moves the card to Done and logs the run.

A hand-track card goes to the doug-hand loop instead, which asks before it starts. Watch the board with `doug board serve`.

## Autopilot

`/doug-next --auto` takes the first n runnable Ready cards when given a number n; without n it is unlimited and re-reads Ready.

- It shows the queue once with caps on cards, wall clock and USD, taken from measured size and class tables, and asks one approval.
- Up to `workers.max` cards (default 3) run at once, each under its own queen in its own worktree.
- A live pane opens when the run starts; `/doug-autopilot` reopens it. The same run shows on the served board.
- It stops and asks on a design decision, a cap, a repeated red gate or a hook block.

## Gates and hooks

Hooks are small scripts Claude Code runs around every action, outside the model.

- protect-paths denies edits to `.env` files, the lockfile, migrations, generated directories and anything outside the project.
- guard-bash denies `--no-verify`, force-push to protected branches, destructive commands and the wrong package manager.
- secret-scan denies writing or running a credential.
- stop-gate blocks a turn while typecheck, lint or tests fail (up to a cap), while the session ran no test, after a protected file changed through Bash, or on a file outside an approved plan's scope.
- In your project the stop gate is what runs typecheck and tests. The `.githooks/pre-commit` hook that runs them on every commit belongs to a clone of the Doug repo; `doug init` does not install one.

If a hook blocks, report it rather than working around it. Every hook and its config: [reference.md#gates](reference.md#gates).

## Memory

Lessons from past runs are recalled at session start and carried into each brief.

1. Run `doug memory setup`. It finds a local embedding server, verifies it and enables semantic recall; without it recall is keyword-only.
2. After a run, reflect records the lessons it learned. In 1.3 it also offers a CLAUDE.md candidate when a lesson has no home; it never writes CLAUDE.md itself.
3. Recall is cached in process, so warm lookups are fast.

Details: [memory.md](memory.md).
