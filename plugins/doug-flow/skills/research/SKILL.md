---
name: research
description: The research step before a plan, for a card whose goal depends on facts outside the repository (a Claude Code hook contract, a CLI's output format, a third-party API). One researcher, or several in parallel with distinct questions, write one cited note the planner and the builder work from; uncertainty is stated, never guessed. Invoked by /core-next, /doug-plan, and /doug-next before planning, or on its own.
allowed-tools: Agent, Read, Write, Bash(mkdir *), Bash(cat *), Bash(node *plan.mjs *)
---

# research

Facts first. A plan built on a guessed contract becomes a task the verifier cannot pass and an adversary blocker nobody can fix; on 2026-09-06 the run-trace and precompact-anchor cards each needed the claude-code-guide agent ad hoc before their plans were right. This is the procedure that was missing.

## When to take it

Take the step when the card's goal (or the request) depends on a fact that is not in the repository and not in the conversation: the exact shape of a Claude Code hook input, the fields of a CLI's JSON output, a third-party API's behavior, a package's version constraints. Skip it when every fact the plan needs can be read from the checkout. When in doubt, take it: one researcher costs less than one blocked pass.

## Who runs it

- Questions about Claude Code itself (hooks, skills, agents, the Workflow tool, the SDK, the API): `Agent({ subagent_type: "claude-code-guide", prompt: "<the question>" })`. Reuse a guide agent already running in the session with SendMessage rather than spawning another. The fetch budget (research.maxFetches) counts per agent, so a reused guide shares one budget across every question sent to it; when a question needs its own budget, spawn a fresh guide instead. This agent keeps its own model.
- Anything else: the plugin's `researcher` agent, read-only with WebFetch and WebSearch, which answers one question from primary sources, quotes each source with its URL or the command and its output, never installs or writes, and marks what it could not confirm. It runs on the `plan` row, the same row the planner uses: read it with the `plan.mjs models` command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" models`, which prints the parsed table as JSON (`roles.plan.model`), and pass that row's model (omit `model` when the row says `inherit`): `Agent({ subagent_type: "doug-flow:researcher", model: "<the plan row's model>", prompt: "<the question>. Other researchers are answering: <their questions, if any>." })`. It returns findings, not a file; this skill writes the note. The Agent tool carries no effort parameter, so the row's effort applies through the researcher agent's own frontmatter (`effort: high`, the plan row's default); a repository whose plan row sets another effort changes that frontmatter line.

The session model never researches itself; it asks the questions and writes the note from the answers.

## One researcher or several

One question, one researcher. Several independent questions get several researchers in the same message, in parallel, each with one distinct question and told not to answer the others'; their answers merge into one note. A request or card that names a crew of researchers (`crew: { "researchers": 2 }` in the plan's terms) gets that many, each with its own question. Do not give two researchers the same question: a disagreement between two guesses is not a check. Each question names the budget (at most 6 WebSearch plus WebFetch calls, research.maxFetches) and lists the raw URLs to try, in priority order.

## The note

Write the findings to `.doug/.state/research/<card-id>.md` (session state, ignored by git; `mkdir -p` the directory first), one section per question:

- the fact, in one or two sentences, as the plan will use it;
- the sources: a URL, a file path with a line, or a command and its output, one per fact;
- what stayed unverified, marked `unverified`, with what was tried. Never guess a fact into the note; an unverified line is what keeps the planner from building on it.

The note is written under the card's id, not the question's, because the id is also the promotion key: a note for a card that lands is promoted to `docs/research/<card-id>.md`, `board.mjs record` copying it there when it records the landing so a commit that cites the note has something to read afterward. A note for a card that never lands (dropped, replanned under another id) stays in state and is eventually swept with the rest of `.doug/.state/`.

Then hand it on:

- Flow track (`/doug-plan`, `/doug-next`): give the planner the note's path in its prompt. The planner writes the facts it relied on into the plan's goal with their sources and marks any unverified one.
- Hand track (`/core-next`): the builder reads the note before the test, cites the sources in the commit message where a fact decided the design, and names the note in the landing's `--note`.

The step spends agents only when invoked and publishes nothing.
