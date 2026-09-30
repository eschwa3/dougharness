# Onboarding

This walkthrough takes a fresh clone of this repo to a working Doug, then to a
first card running in a target repository. Nothing in it publishes anything,
starts background work, or reaches the network except the package registry
during `pnpm install`.

## Set this repo up

```sh
pnpm bootstrap
```

The name is `bootstrap`, not `setup`: `pnpm setup` runs pnpm's own builtin
setup command, which edits the user's shell rc (appends `PNPM_HOME`/`PATH`
lines) - not this repo's script. `pnpm bootstrap` runs
[`scripts/setup.sh`](../scripts/setup.sh).

It checks:

- Node `>=22.16`
- pnpm matches the version named in `package.json`'s `packageManager` field
  (a mismatch is a warning, not a failure)
- whether `codex` is on `PATH` - reported, not required; without it the
  Codex adversary falls back to the Claude adversary

It runs:

- `pnpm install --frozen-lockfile`
- `pnpm build`

- Writes: only the built output under each package's `dist/`, the
  installed `node_modules`, and, when it links, the `doug` entry in the
  pnpm global bin dir.
- Never: edits a shell rc file; never publishes anything; never starts
  background work.

Then it either links `doug` onto `PATH` with
`pnpm --dir packages/doug-cli link --global`, or, when `pnpm bin -g` prints an
empty string (no global bin dir configured), prints the exact fallback
command to use instead:

```sh
node <repo>/packages/doug-cli/dist/bin.js
```

`pnpm link --global` exists in pnpm 9 and 10 and is removed in pnpm 11 (see
<https://pnpm.io/cli/link>).

## Onboard a target repository

1. `doug init <repo>`
   - Writes: `.doug/config.json`; the vendored hooks under `.doug/hooks/`; a
     merged `.claude/settings.json`; the standard subagents and generated
     skills; `CLAUDE.md` only when none exists; an empty `.doug/board.json`
     when the project has no board.
   - Never: writes anything before the diff is approved (`--dry-run` shows
     the diff only); never touches the network; never publishes anything.

2. `doug board init <repo>` and `doug board add <id> --title <t> --goal <g>`
   - Writes: `.doug/board.json` only.
   - Never: publishes a board page.

3. Start Claude Code with
   `claude --plugin-dir plugins/doug-gates --plugin-dir plugins/doug-flow`
   from this (the doug) clone.
   - Writes: nothing to any settings file. The flag is repeatable, loads
     each plugin directory for that session only, and leaves the plugins'
     hooks active for the session.
   - Never: needs a marketplace; never touches the network.

4. `/doug-next`
   - Writes: picks the next Ready card, plans it into `.doug/plan.json`,
     and, once the user approves it, runs the flow and lands the result.
   - Never: lands or spends in the background without the user's approval.

## What this never does

- Never writes anything before a diff is approved (`doug init`).
- Never touches the network beyond the package registry during
  `pnpm install`, and never during `doug init` or `doug board`.
- Never publishes a board page from `doug board init`/`add`.
- Never writes to any settings file from `claude --plugin-dir`.
- Never lands or spends in the background without the user's approval
  (`/doug-next`).
