# Changelog

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
