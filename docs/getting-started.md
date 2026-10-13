# Getting started

To contribute, or to run Doug from a clone, see
[docs/onboarding.md](onboarding.md) (`--plugin-dir` from a clone).

## Requirements

- Node `>=22.16`
- Claude Code
- git
- Codex CLI, optional: without it the adversary falls back to the Claude
  adversary (see docs/onboarding.md).

## Install the plugins

```
/plugin marketplace add eschwa3/dougharness
/plugin install doug-gates@dougharness
/plugin install doug-flow@dougharness
```

Or from a shell:

```sh
claude plugin marketplace add eschwa3/dougharness
claude plugin install doug-gates@dougharness
claude plugin install doug-flow@dougharness
```

`/plugin` handles updates.

## Install the CLIs

```sh
npx @dougharness/cli init <repo> --dry-run
npx @dougharness/cli init <repo>             # writes after approval
```

Or install `@dougharness/cli` globally with npm. `@dougharness/codex`
provides `codex-review`, the adversary: the adversarial reviewer the flow
calls. Without `codex-review` or the Codex CLI, the adversary falls back to
the Claude adversary.

## Run doug init

`doug init <repo>` is one guided flow. In order, it:

1. Detects the project: stack, test and build commands, existing settings.
2. Shows the diff and waits for your approval (`--dry-run` stops here).
3. Writes `.doug/config.json`, the vendored hooks, and `.claude/settings.json`
   with the hooks, the status line, the 1h subagent prompt cache, 16 concurrent
   workflow agents and spawn depth 1; an empty board; the agents and skills;
   and `CLAUDE.md` when absent.
4. Offers `doug memory setup` (semantic memory; opt-in, probes local servers only).
5. Runs the setup check, printing each result with its fix line.
6. Ends with the final screen.

### The setup check

Each check prints ok, warn, fail, or skip, and one fix line when not ok.
`doug doctor` runs the same list any time, read-only and offline. A warn
never fails init.

- `node`: Node `>=22.16` with SQLite FTS5.
- `config`: `.doug/config.json` exists and parses.
- `hooks-vendored`: the hook scripts are vendored under `.doug/hooks`.
- `hooks-registered`: the hooks are registered in `.claude/settings.json`.
- `statusline`: the status line points at the vendored statusline script.
- `subagent-settings`: the 1h subagent prompt cache, concurrent agents and spawn depth.
- `board`: `.doug/board.json` exists and parses (`doug board serve` shows it).
- `codex`: the Codex CLI is on PATH.
- `adversary`: `codex-review` is on PATH, else the Claude adversary is the fallback.
- `memory`: the memory store opens.
- `embeddings`: semantic memory embeddings are configured.
- `plugins`: `doug-gates` and `doug-flow` are installed.
- `plugin-versions`: the installed plugins match the CLI's version.

### The final screen

```
You're ready. Next:
  1. claude                  open Claude Code here; the hooks are active immediately
  2. doug board add <id> --title <t> --goal <g>   queue a card; doug board serve --open shows the board
  3. /doug-next             in Claude Code: plan, approve, and run the next Ready card
  Re-check any time: doug doctor
```

## One version

The plugins and the CLIs are released together under one version, and
`doug init` vendors the hook scripts of the CLI's release. Install the
plugins and the CLI of the same release.

## Start a new project

The manual recipe for a new project. `/doug-start` automates it: with no
argument in an empty repo it walks the same phases (idea, architecture, walking
skeleton, scope), one committed file and one gate each.

1. Create the repository and its package manager file: `git init`, then for
   example `pnpm init`.
2. Install the plugins and the CLI as above ([Install the plugins](#install-the-plugins),
   [Install the CLIs](#install-the-clis)).
3. Run `doug init`. It writes the hooks and an empty board; the gates stay empty
   until a test exists.
4. Write the idea and the architecture as `docs/product/idea.md` and
   `docs/product/architecture.md`: in Claude Code, ask Claude for the idea, then
   ask the `architect` agent for the architecture.
5. Build a walking skeleton: a build, a typecheck, a test runner, and one
   passing test, built by the tester, then the coder, then the reviewer.
6. Re-run `doug init` so `stopGate.commands` are detected; `doug doctor` checks
   the result.
7. File the cards, one per slice, into Ready (`/doug-next` takes only a Ready card; the default column is Backlog):
   `doug board add <id> --title <t> --goal <g> --column ready`
   (`--size` and `--deps` are optional); `doug board list` shows them.
8. In Claude Code, run `/doug-next` to plan, approve, and run the next Ready card.

## Starting from an empty repository

Until a project has a test and a build, the gates check nothing. For the exact
commands see [Start a new project](#start-a-new-project).

1. Write the first card: a walking skeleton, the smallest end-to-end slice with one test.
2. Build it with the tester, then the coder, then the reviewer.
3. Re-run `doug init` so `stopGate.commands` are detected.
4. Start no feature card before then.

## Next

See [docs/onboarding.md](onboarding.md) for the first card.
