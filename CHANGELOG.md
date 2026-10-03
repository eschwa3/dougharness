# Changelog

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
