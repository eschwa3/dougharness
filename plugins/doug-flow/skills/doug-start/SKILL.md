---
name: doug-start
description: Start a new project or a large feature one phase at a time, each phase a committed file behind a human gate. With no argument in a repo with no docs/product/idea.md it walks Idea, Architecture, Walking skeleton, and Scope; with a card id or a goal it walks Specification, optional Pseudocode, Architecture, and Refinement into an approvable plan.
when_to_use: The user runs /doug-start, wants to begin a project from an idea, or wants a large card specified and designed before it is planned.
allowed-tools: Agent, AskUserQuestion, Read, Write, Edit, Bash(doug board *), Bash(node *bin.js board *), Bash(node *bin.js init *), Bash(doug init *), Bash(node *plan.mjs *), Bash(node *memory.mjs *), Bash(node *learn.mjs *), Bash(node *board.mjs *), Bash(git *)
---

# doug-start

One skill, two modes, no MCP server and no daemon. Each phase writes one committed file and stops at a human gate (AskUserQuestion). A rerun of a phase shows the diff and asks; it never overwrites silently.

Mode and resume are derived from disk, with no state file: a card id or goal argument picks feature mode; no argument and no `docs/product/idea.md` picks project mode; a run resumes at the first missing phase file.

An argument that is not a card id on the board, in a repo with no `docs/product/idea.md`, is ambiguous (an idea or a goal): ask at an AskUserQuestion gate (project / feature) unless the conversation already says `project mode` or `feature mode`. Once the mode is project, text the user gave is the idea, not a feature goal. A card id on the board, or any goal once `docs/product/idea.md` exists, picks feature mode.

The Walking skeleton writes no phase file; it is done when the `walking-skeleton` card is in Done on the board and `stopGate.commands` in `.doug/config.json` is non-empty, and a run resumes at it until both hold.

## Phase rules (both modes)

- Only a committed phase file counts as done: a phase file that exists but is uncommitted means that phase is still waiting at its gate, so the next run re-asks that gate, showing the file, and does not move on.
- A phase file is written by the lead (this session). The spec-writer and researcher agents return text and write nothing.
- Before writing a phase, check whether its file exists. If it does, write the new text to `.doug/.state/scratch/<name>.new`, show `git diff --no-index` of the two, and ask (AskUserQuestion: replace / keep / revise). Never overwrite a phase file without that answer.
- The gate after each phase asks AskUserQuestion with the options approve / revise / stop. Approve: commit the phase file (a plain message, no trailers) and go to the next phase. Revise: take the user's note, redraft, show the diff, ask again. Stop: leave the file uncommitted and end; a later `/doug-start` resumes at the first missing phase file.
- At every gate the lead calls AskUserQuestion, even when the session looks non-interactive; a denied or unanswered call ends the phase there, and the lead does nothing past it (it names the phase that is waiting).

## Project mode

Start here: if `.doug/config.json` is missing, run `doug init --yes` first. It writes the project's `architect`, `tester`, `coder`, and `reviewer` agents into `.claude/agents/`, which the phases below spawn.

### 1. Idea

Writes `docs/product/idea.md` (problem, users, success, non-goals). Spawn the spec-writer with the user's idea and ask it for those four sections:
`Agent({ subagent_type: "doug-flow:spec-writer", prompt: "<the user's idea verbatim>. Draft docs/product/idea.md with sections: problem, users, success, non-goals. Return the file text." })`
Write the file, then ask at the AskUserQuestion gate (approve / revise / stop).

### 2. Architecture

Writes `docs/product/architecture.md` plus the ADR `docs/decisions/0001-stack.md` (through the proposal path, below), from the project's `architect` agent, never drafted by the lead: the stack, the modules, the commands that build and test it, and the one decision the stack rests on. Spawn a researcher for any stack fact that lives outside the repository (a tool version, a package's constraint):
`Agent({ subagent_type: "doug-flow:researcher", prompt: "<one stack question>. Cite each fact with its source." })`
Then spawn the architect on the `plan` row's model (`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" models`; omit `model` when it says `inherit`):
`Agent({ subagent_type: "architect", model: "<the plan row's model>", prompt: "<the approved idea and the research>. Return the text of docs/product/architecture.md and, separately, the body of the stack ADR without its title line." })`
Write `docs/product/architecture.md` from its returned text. `docs/decisions/` is proposal-only, so the lead never Writes it directly. Save the ADR body under `.doug/.state/scratch/` and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.mjs" decision propose --title "Stack" --file <body>`, which renders the diff for `docs/decisions/0001-stack.md` under `.doug/.state/learn/` and writes nothing else. Then ask at the AskUserQuestion gate (approve / revise / stop). On approve, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn.mjs" apply <proposal-file>`, which writes the ADR, and commit. Unapproved, the proposal stays pending and the ADR does not exist.

### 3. Walking skeleton

Writes the first card with `doug board add` (id `walking-skeleton`, size S, class code) and builds it: the thinnest program that runs and has one passing test, built tester, then coder, then reviewer (the project's `tester` and `coder` agents on the implement row, the tester first writing the test; the project's `reviewer` agent on the review row). Mandatory: no feature card starts before it, because until then the gates check nothing. When it is built and its tests pass, leave it uncommitted (approval at the gate commits it); then `doug init` re-runs so `stopGate.commands` are detected; confirm `.doug/config.json` lists at least one command. Leave the work uncommitted and the card out of Done until the gate. Ask at the AskUserQuestion gate (approve / revise / stop) with the commands shown. On approve, run `doug board move walking-skeleton done` and commit.

### 4. Scope

Writes `docs/product/scope.md` (v1 in one paragraph, then one line per card) and the board cards. Spawn the spec-writer with the approved idea and architecture; it returns the text of `scope.md` and the card list as one line per card (id, title, goal, size, class, column):
`Agent({ subagent_type: "doug-flow:spec-writer", prompt: "<idea and architecture paths>. Draft docs/product/scope.md and its card list: id, title, goal, size, class, column. Return the file text." })`
The lead never drafts the scope; it writes the returned `scope.md` and runs `doug board add` only for each card the user approved. A card counts as approved at the gate, or in advance in the conversation. Cards are written with `doug board add`, never by a script editing `.doug/board.json`. Put at most 7 to Ready for v1 and the rest to Backlog, each with a size; a large card then goes through feature mode (`/doug-start <card-id>`). Show the board (`doug board list`) and ask at the AskUserQuestion gate (approve / revise / stop).

## Feature mode

Files live under `docs/specs/<card-id>/`. A goal with no card id gets a short kebab-case id from the lead, confirmed in the first gate. Read the card first (`doug board list --json`) when one exists.

### 1. Specification

Writes `spec.md`: what must be true when the work is done, as outcomes a command can check, plus non-goals and open questions.
`Agent({ subagent_type: "doug-flow:spec-writer", prompt: "<card goal or the user's goal verbatim>. Draft docs/specs/<card-id>/spec.md: outcomes, non-goals, open questions. Return the file text." })`
Write the file, then ask at the AskUserQuestion gate (approve / revise / stop).

### 2. Pseudocode (optional)

Writes `pseudocode.md`, only when the user asks for it at this gate (AskUserQuestion: write it / skip). Skip leaves no file and goes to Architecture; a missing `pseudocode.md` counts as skipped once `architecture.md` exists, or when the user said they skipped it; resuming with only `spec.md` asks write / skip once. When written, spawn the spec-writer again for the algorithm in plain steps, and gate it as above.

### 3. Architecture

Writes `architecture.md` in the shape of the architect agent: modules, files, interfaces, the test for each. Every file it names will be owned by a plan task, so name each exactly. Spawn the project's `architect` agent on the `plan` row's model with `spec.md` (and `pseudocode.md` if present) and the code it touches: `Agent({ subagent_type: "architect", model: "<the plan row's model>", prompt: "<the spec path>. Return the text of docs/specs/<card-id>/architecture.md." })`. The lead writes its returned text to the file and never drafts it. Then ask at the AskUserQuestion gate (approve / revise / stop).

### 4. Refinement

The planner writes an approvable plan whose tasks own the files `architecture.md` names. Read the `plan` row with `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" models` and pass its model (omit `model` when it says `inherit`):
`Agent({ subagent_type: "doug-flow:planner", model: "<the plan row's model>", prompt: "<card goal>. Spec: docs/specs/<card-id>/spec.md. Architecture: docs/specs/<card-id>/architecture.md. Scripts: ${CLAUDE_PLUGIN_ROOT}/scripts. Write .doug/plan.json as a draft and return the rendered plan." })`
Set the card when the argument was a board card id (`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" set card <card-id>`), render it (`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" show`) and ask at the AskUserQuestion gate (approve / revise / stop). The plan is approved with `/doug-approve`, by the user; this skill never approves it.

### 5. Completion

`/doug-implement` and land, unchanged. Tell the user to run `/doug-approve`, then `/doug-implement`.
