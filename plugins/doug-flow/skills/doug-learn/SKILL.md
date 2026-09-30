---
name: doug-learn
description: Log-then-propose harness self-improvement (card learn-signals). Counts signals from the outcomes/lessons store and the run trace, renders each candidate change - demote a violated prose rule to a hook, delete a rule nothing references, promote a repeated lesson, tighten a skill description - as a diff, and asks the user to approve each one before applying it. Only the user invokes this; it never applies a change on its own.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Bash(node *learn.mjs *), Bash(git *)
---

# doug-learn

This skill never changes a tracked file on its own initiative. `learn.mjs propose` only ever writes under `.doug/.state/learn/` (never a tracked file); `learn.mjs apply` is the only command that ever touches the checkout, and this skill calls it only after the user says yes to that one proposal. It never applies without asking, and it never runs unless the user invoked `/doug-learn`.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn.mjs" signals` and put the summary (outcomes, lessons, trace counts) in the chat.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn.mjs" propose`. It collects signals, writes one diff per candidate change under `.doug/.state/learn/<timestamp>/`, and prints one line per proposal (`<NN> <kind> <target>: <reason>`), or `no proposals` when there is nothing to propose - stop here if so.
3. Put every proposal line in the chat.
4. For each proposal, in order:
   - a proposal with `diff: null`, or whose target is a protected path (`.doug/config.json` for a `demote` proposal, always) - read `proposals.json` in the written directory for its `reason`, tell the user what it found and what they would do by hand, and do not ask a question for it: there is nothing to apply.
   - a proposal with a real diff - show the diff (`Read` the `NN-<kind>.diff` file), then ask with `AskUserQuestion` whether to apply it (apply / skip). Never batch several proposals into one question; one proposal, one question.
5. Apply only the proposals the user approved, one at a time: `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn.mjs" apply <proposal-file>`. It exits 1 with the refusal reason when a diff no longer applies cleanly - report that instead of retrying on your own. Say what was applied (the target file) after each one, and what was skipped.

Never call `apply` for a proposal the user has not been asked about, and never call it before step 4's question for that proposal has been answered.
