---
name: doug-decide
description: Propose a new ADR, an ADR amendment, or a rules file under docs/decisions/ or .claude/rules/ as an approvable diff (card memory-decisions). Those paths are writable only through this proposal path - protect-paths.mjs refuses an Edit/Write there. Only the user invokes this, and it never applies a change without asking.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Bash(node *memory.mjs *), Bash(node *learn.mjs *), Bash(git *)
---

# doug-decide

`docs/decisions/**` and `.claude/rules/**` are proposal-only paths (`proposalPaths` in `.doug/config.json`): `protect-paths.mjs` refuses an Edit/Write/MultiEdit/NotebookEdit there, and the Stop gate flags a Bash-written change to them that is not recorded in the applied-proposal ledger. This skill is the one honest way to change them: render a diff under `.doug/.state/learn/`, show it, ask, then apply it with `learn.mjs apply` - never Edit or Write either path directly, even after the diff exists.

## Forms

- `/doug-decide decision "<title>" --file <body.md>` - a new ADR. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.mjs" decision propose --title "<title>" --file <body.md>`. Refuses when the target ADR already exists, or the title/body is empty.
- `/doug-decide amend <NNNN> --file <text.md>` - a dated amendment to the one existing ADR matching `<NNNN>`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.mjs" decision amend <NNNN> --file <text.md>`. Refuses when none or several ADRs match `<NNNN>`.
- `/doug-decide rule <name> --paths <globs> --file <body.md>` - a rules file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.mjs" rule propose <name> --file <body.md> [--paths <glob,glob>]`. With `--paths`, the rule loads only when a matching file is read; with none, it loads unconditionally for every file at session start.

## Steps

1. Run the matching command above.
2. On a refusal, put the reason in the chat - there is nothing to apply.
3. On success, `Read` the printed diff file and show it to the user.
4. Ask with `AskUserQuestion` whether to apply it (apply / skip) - one proposal, one question, never batched.
5. On apply, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn.mjs" apply <diff>` and report the target file it wrote. On skip, say so and stop.

This skill never commits (the caller does) and never applies a proposal the user has not been asked about.
