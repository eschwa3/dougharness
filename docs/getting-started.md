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
provides `codex-review`, the adversarial reviewer the flow calls.

## One version

The plugins and the CLIs are released together under one version, and
`doug init` vendors the hook scripts of the CLI's release. Install the
plugins and the CLI of the same release.

## Next

See [docs/onboarding.md](onboarding.md) for the first card.
