---
name: doug-next
description: Take the next board card (.doug/board.json), or several cards in one plan, through the whole flow in one command (a hand-track card goes to the by-hand loop, the `doug-hand` skill; `--auto [n]` runs the queue of Ready cards on one approval): plan it, stop for the user's approval, implement with the doug-implement workflow, replan a blocked run keeping the tasks that passed, land the integration branch, move the card to Done, log the run, and offer the next card. Only the user invokes this.
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Workflow, Read, Bash(node *plan.mjs *), Bash(node *board.mjs *), Bash(node *cost.mjs *), Bash(git *), Bash(doug board *), Bash(node *bin.js board *)
---

# doug-next

One card, start to finish, with two human gates. Nothing is implemented before the user approves the plan, and the loop never continues to another card without being asked (except under autopilot, below).

`/doug-next` takes the first Ready card whose dependencies are Done. `/doug-next <card-id>` takes that card.

**Several cards in one plan.** `/doug-next <id> <id>...` takes those cards together, and `/doug-next --batch <n>` the first n runnable Ready cards (`board.mjs next --batch <n>`, board order). One planner per card runs in parallel, `plan.mjs merge` joins the drafts into one plan whose tasks carry their card, and the batch then goes through one approval, one run, and one land; each card gets its own Done move and its own run entry. Where the text below says "the card", read "each card of the batch" and follow the batch paragraphs marked as such.

## Who does the work

The session model is the lead only, on both tracks (a hand-track card runs the by-hand loop, `doug-hand`, with the same rule). In this loop it picks the card, asks the human gates, launches the workflow, reads the report, replans, lands, and records; it never plans, researches, implements, verifies, reviews, or classifies itself. Planning and research run on the `plan` row (the `doug-plan` and `research` skills), the workflow's stages on the `implement`, `verify`, `review`, `adversary`, and `integrate` rows and a swarm's on the `lead` and `worker` rows, and adversary-block classification on the `review` row (`run-report`). A row that says `inherit` is the session model by the user's choice in the table.

## 1. Pick the card

Start from a clean working tree on the base branch (`git status --porcelain` empty apart from `.doug/` and `.claude/worktrees/`); land refuses otherwise, and the scope gate blocks uncommitted files the plan does not own.

- With an id: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" card <id>`. If the card carries `"track": "hand"`, it is a gated by-hand change, not a flow run: invoke the `doug-hand` skill with the card id and end this loop; doug-hand asks its own start gate before anything moves.
- Without: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" next --track any`. A plain /doug-next takes the next runnable Ready card of either track; a hand-track card goes to the doug-hand skill. Show any "skipping" lines it prints; those Ready cards are waiting on a dependency.
- Batch: with several ids, `board.mjs card <id>` for each (a hand-track card among them stops the run, saying `/doug-next <id>` takes it alone); with `--batch <n>`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" next --batch <n>` prints the cards as a JSON array in board order (fewer than n when fewer are runnable; one card is a plain single-card run). Show the "skipping" lines. Keep the ids in board order from here on: the merge sequences overlapping files by it.

Move it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" move <id> flow` prints `Moved <id> to flow in <record>.` (normally `<record>` is `.doug/board.json`; a repository that has not migrated prints its fallback). Batch: one move per card. Leave the move uncommitted: it is working state, the scope gate allows an uncommitted `.doug/board.json`, and land ignores `.doug/` changes; the served page (`doug board serve`, `--detach` to keep it running) shows the card In flow live. The record change lands in section 5's landing commit together with `docs/live-runs.md`.

## 2. Plan

If `.doug/plan.json` is already a draft whose `card` is this id (or whose `cards` are this batch) and any task carries `reuse`, it is the second pass of a blocked run (section 4 made it): do not spawn the planner; skip to the `plan.mjs show` paragraph below.

If the card's goal depends on a fact outside the repository (a Claude Code hook contract, a CLI's output format, a third-party API), invoke the `research` skill first and add `Research note: <path>` to the planner's prompt; the planner writes the facts it relied on into the plan's goal with their sources.

The planner runs on the `plan` row (see "Who does the work" above): read it with the `plan.mjs models` command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" models` (`roles.plan.model`, `roles.plan.effort`), and pass that row's model on every planner spawn below (omit `model` when the row says `inherit`).

Spawn the planner with the card's goal text verbatim as the request:
`Agent({ subagent_type: "doug-flow:planner", model: "<the plan row's model>", prompt: "Board card <id>, title \"<card.title>\": <card.goal>. Write .doug/plan.json and return the rendered plan." })`

Then record the card on the plan: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" set card <id>` (the planner also writes it; setting it here is what guarantees the plan file carries the id even if the planner forgot).

Batch: spawn one planner per card in the same message so they run in parallel, each told where its draft goes, each carrying the same plan row's model:
`Agent({ subagent_type: "doug-flow:planner", model: "<the plan row's model>", prompt: "Board card <id>, title \"<card.title>\": <card.goal>. Write the plan to .doug/.state/drafts/<id>.json (a draft for a batch; not .doug/plan.json), validate it with plan.mjs validate --file .doug/.state/drafts/<id>.json, and return the rendered plan." })`
When all have returned, `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" merge <id> <id>...` joins the drafts into `.doug/plan.json`: one draft plan, `cards` listing the batch in board order, every task carrying its `card`, level k of the batch being the union of each card's level k. A file two cards own is not refused: the later card's task (board order) gets a dependency edge to the earlier card's, so the file is edited in sequence and each card keeps its own spec, verify, and acceptance; merge prints each such edge (`<file>: <card>/<task> runs after <card>/<task>`), any task id it had to rename, and any plan-level setting the drafts disagreed on. Only a dependency cycle across cards is refused, by card name; then edit the drafts (or drop a card from the batch) and merge again. Put merge's output in the chat verbatim. Do not run `plan.mjs set card` for a batch; `plan.mjs show` prints `Cards:` and each task's card.

Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" show` and put its complete output in the chat, verbatim, in a fenced code block, before anything else: the title and goal, every acceptance line, the verify commands, every level with each task's owned files and verify command, and the models table. The approval prompt that follows is a small dialog and hides the plan, so the user must be able to read the whole plan in the conversation above it. After the block, add at most a few lines of your own: any assumption the planner stated, any task that owns many files, and any task whose implementer is not on the implement row (a `tier`, `model`, or `effort` on the task): the planner sets none on its own, so one that is there came from the plan file and the user decides whether it stays. Do not summarize the plan instead of showing it.

## 3. Human gate: approval

Ask with `AskUserQuestion`, only after the full plan is in the chat: approve as written, edit first, or stop. Keep the question short; the plan is above it. Approval is never automatic and never inferred, except that under autopilot the queue approval stands for it.

- **Approve**: first make the plan file complete, because the workflow and `plan.mjs land` both read the file, never the launch arguments: `install` and `adversary.command` are filled from `.doug/config.json` (`commands.install` and `commands.adversary`, where `{root}` stands for the project directory) when the plan has none; check with `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" json | grep -o '"adversary":{[^}]*}'` and, only if the config lacks one, set it with `plan.mjs set adversary.command "<command>"` (or `plan.mjs set install "<command>"`). `plan.mjs show` prints `Fix attempts per blocked task`; change it only if the user asks, with `plan.mjs set fixAttempts <n>` (0 disables the in-run fix loop). When the user asked for a swarm, `plan.mjs set swarm on` (a lead splits each full-shape task into worker briefs; `plan.mjs show` prints `Swarm: on`); `/doug-swarm` is the command that does this from the start. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" approve` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" anchor`.
- **Edit**: stop here. Tell the user to edit `.doug/plan.json` and run `/doug-next <id>` again; the planner will not overwrite an edited draft unless asked.
- **Stop**: move the card back with `board.mjs move <id> ready` (each card of a batch) and end.

## 4. Implement

`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" json` and pass its output verbatim as the args (do not add fields at launch): `Workflow({ name: "doug-flow:doug-implement", args: <plan object> })`; the registered name carries the plugin prefix. If it is not found, use `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/doug-implement.js"`. Note the wall clock when it starts and ends. When it returns, save the `result` object of the Workflow tool's output to `.doug/.state/last-report.json` with the Write tool (that directory is ignored by git and always allowed by the scope gate; anything else under `.doug/` would block the turn) and summarize it as `/doug-implement` does: per level, what was implemented, verified, reviewed, adversarially reviewed, and integrated, with the integration verify results. A task whose `attempts` array has more than one entry was fixed in the run: say how many passes it took and quote the `retriable.reason` of each blocked pass; a task with a `stopReason` gets it quoted verbatim.

If the report carries `paused` (`{ level, gate: "human", next }`), the run stopped on purpose at a human gate after that level integrated: nothing failed, and the levels after it have not run. Summarize the levels that ran as above, name the tasks in `next`, and ask with `AskUserQuestion` whether to open the gate. Yes: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" gate open <level>`, then relaunch the same run with the plan file's fresh JSON: `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/doug-implement.js", resumeFromRunId: "<the wf_ id>", args: <plan.mjs json> })`; the levels already run replay from the runtime's cache and the run continues with the next level; then read the new report from the top of this section. No: leave the card In flow and the plan approved and stop; `plan.mjs done` refuses while the last report is paused, and also refuses a report that is not ok (naming the stopped level and each task's `stopReason`, overridable with `--force`), so a paused or failed run cannot be skipped by landing.

If `ok` is not true: the workflow has already relaunched the implementer for every retriable block up to `fixAttempts` times (default 5), so what stopped it is either not retriable (a finding on a file outside the task's owned files, an implementer that reported itself blocked, a verifier or reviewer that returned nothing, an adversary that did not run, or a finding marked `SPEC CONTRADICTS ACCEPTANCE`) or survived every attempt; each task's `stopReason` says which. Leave the card In flow and print the report summary. Each task's `acceptance` array is the verifier's per-criterion result (text, command, exit code); list any entry with ok=false. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" replan`: it reads `.doug/.state/last-report.json`, sets the plan back to draft, marks every task that passed verify, review, and the adversary with `reuse: <branch>`, and prints why each other task is fresh (its stage failed, its spec changed since the recorded pass, or it depends on a task that is not reused). Replan also prints the task worktrees it removed and any it kept, to be included in the chat verbatim. Put that output in the chat verbatim, then go back to the `plan.mjs show` paragraph of section 2 and the approval gate of section 3 with the same three options. Say which tasks will be reused and that the usual fix is to edit the fresh task's spec in `.doug/plan.json` before approving (a `SPEC CONTRADICTS ACCEPTANCE` finding means the spec or the acceptance line must change); editing a reused task's spec makes `plan.mjs approve` refuse until `replan` runs again. Do not spawn the planner again unless the user asks for a fresh plan, and do not fix things by hand. On approve, this section runs the workflow again: reused tasks skip the implementer, start from their recorded branch, and are verified, reviewed, and adversarially reviewed again before integration; a reused task that blocks is retried in place like any other.

## 5. Land

`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" done` (it refuses when the last report is not ok, naming the stopped level and each task's `stopReason`; `--force` overrides with a printed warning) then read `.doug/config.json` and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" land` or `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" land --delete-branches` depending on whether the config sets `land.deleteBranches` to true (land reads the key itself too, so the flag only makes the choice visible in the command). Land re-runs the plan's verify commands and then every acceptance command on the integration branch and merges only if they all pass; a refusal names the failing criterion and shows the output tail. If it refuses, print its reason, leave the card In flow, and stop. Include land's `removed worktree`, `kept worktree`, and `deleted branch` lines in what is reported.

Then, with the merge commit it printed:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" move <id> done --source "commit <sha>"`
2. Invoke the `run-report` skill for the card with `.doug/.state/last-report.json`, the run id the Workflow tool printed (`wf_...`), the wall clock, and the merge commit: it measures the run's cost with `cost.mjs` from the local transcripts (the workflow does not report cost; never estimate one), passes `cost.mjs`'s Codex line, when present, as `--codex-cost` to `board.mjs record` and `board.mjs summary` (never folded into `--cost`), appends the run entry to `docs/live-runs.md` with `board.mjs record`, and prints the three-line summary with `board.mjs summary`; put those three lines in the chat verbatim.
3. `git add <record> docs/live-runs.md .doug/plan.json && git commit -m "Board: <id> landed as <sha>"`, with `<record>` the path `board.mjs move` printed in item 1; when item 2's `run-report` invocation printed that it promoted a research note, add `docs/research/<id>.md` too. No trailers.

Batch: every card of the batch moves to Done with the same `--source "commit <sha>"` (item 1, once per card), the `run-report` skill's batch section records one entry per card (that card's tasks only, its own measured cost, the shared integration agents counted once) and prints one summary per card, and item 3 is one commit: `"Board: <id>, <id> landed as <sha>"`.

## 6. Follow-up cards

Before the continue gate, gather the follow-up candidates this landing produced: the report's review issues, the adversary blocks classified marginal or false whose reason names a hole, the integrate stage's conflicts and failed verify tails, and the landing summary. Suggestions come only from what the run actually reported, never invented; each carries the one-line reason and cites the pass that found it. A reviewer's out-of-scope finding is filed only when it is realistic drift (a form a model or a person would plausibly write) or when one card would close the whole class; otherwise it goes in the landing note and is not filed. The card's goal text carries both: the goal names the pass that found it (the reviewer's finding, the implementer's blockedReason or handoff, the verifier's findings, the adversary block id) and the landed commit.

Follow-ups are filed without a question. A landing with no candidates files nothing. Each realistic candidate goes straight to Backlog with `doug board add` (never a script that edits the record): `doug board add <id> --title "<title>" --goal "<goal>" --component <c> --size <S|M|L> --class <tests-only|prose|gate-script|code|docs|eval|decision> --track <hand|flow> --deps <landed-id> --column backlog`. Then the lead places it in Backlog by priority with `doug board reorder`: `--top` for a defect that blocks a commit, a gate, or a user; `--after <id>` of the last such card for drift a user would hit; `--bottom` otherwise. Only the user promotes a card to Ready; the lead never files a follow-up to Ready or Decide.

The lead says in the chat what it filed and where: each new card's id, title, and its Backlog position with the reason. Then one commit `"Board: <id> follow-ups added: <new-id>, <new-id>"`, whatever the count; the served page (`doug board serve`) shows the new cards without a republish. Batch: each card's deps name the card of the batch it came from; still one commit for the whole batch.

## Cards the user asks for

A card the user asks for is a mini ADR, not a one-line goal. Before filing it, the lead asks the scoping questions in one `AskUserQuestion` of up to 4 questions, each with a Recommended option, and writes the answers into the goal. The goal carries the fixed headings Context / Decision / Options / Questions; `docs/decisions` stays for real ADRs. Only a user-requested card takes this form: a follow-up the lead files keeps section 6's lighter form, so autopilot follow-ups stay question-free.

## 7. Human gate: continue

Ask with `AskUserQuestion` whether to take the next Ready card. Yes: go to step 1 with no id. No: end. Each card is a fresh plan and a fresh set of worktrees; nothing carries over between cards except the board and the log. Between passes of the same card, `plan.mjs replan` carries the task branches that passed.

## Autopilot (--auto)

`/doug-next --auto [n]` takes the first n runnable Ready cards of either track in board order (`board.mjs next --batch <n> --track any`). With n, the queue is fixed at the approval. Without n, autopilot is unlimited: before each card it re-reads Ready with `board.mjs next --track any` and takes the next runnable Ready card in board order. It never takes a Backlog card: follow-ups still go to Backlog, and a card the user promotes to Ready during the run is picked up. It shows the queue once, each card's id, size, track, and class, with the caps: cards, wall clock, and USD. The caps default to the queue's length in cards, the wall cap that board.mjs next --batch prints (the sum of each card's budget from the size x class wall budget table in board.mjs, at the p80 of measured landings: a size/class cell with fewer than 5 landings falls back to its size's all-class figure, a card with no class uses its size's all-class figure, and a card with no size counts as M), and $40, and the user may change them at the approval. Unlimited autopilot shows the runnable Ready cards at the approval, and the approval covers every card it later takes from Ready. Unlimited autopilot has no card cap: its USD cap defaults to $40, and its wall cap grows as each card is taken, by that card's budget from the same size x class table (`board.mjs budgets` prints it); only the totals are checked between cards. When the measured walls drift, the lead reruns `board.mjs budgets --from docs/live-runs.md`, which recomputes the table and prints each cell's n, and replaces the table in the `board.mjs` source with the printed one. Autopilot asks one approval, for the whole queue, and no other gate: no start gate, no shape question, and no continue gate.

Each card still runs its track unchanged (research when needed, tester, coder, reviewer, mutations, gate, commit, record, Done; a lean-lane card has no tester and no mutation list). A hand card follows doug-hand from step 3 when it runs by hand, with step 2's start gate question, 2b's question, and step 6's continue gate skipped; a hand card that asks for a swarm takes 2b's swarm branch instead of step 3, as below. A flow card follows sections 2 to 6 above, with section 3's approval replaced as below and section 7 skipped. Only the questions are skipped, not the actions behind them. Under autopilot a card still gets everything the skipped gates' Start or Approve branches do: a hand card gets doug-hand step 2's class, move to flow, and condition open, and the wall clock is noted when the card starts; a flow card gets section 1's move and section 3's Approve steps.

The queue approval stands for each flow-track card's plan approval: the lead puts plan.mjs show in the chat and runs plan.mjs approve itself. A card runs by hand unless its goal asks for a swarm. A hand card whose goal asks for a swarm follows doug-hand's 2b swarm branch, with the queue approval standing for its plan approval. Follow-ups are filed to Backlog as section 6 says, without a question. Between cards the lead measures the session's cost with cost.mjs --session latest and checks every cap.

Stop conditions, one per line:

- It stops and asks when a card needs a design decision its goal does not answer.
- It stops and asks when the gate is red twice on one card.
- It stops and asks when a hook blocks a step.
- It stops and asks when a reviewer blocker stays open after one fix pass.
- It stops and asks when a cap is reached.
- It stops and asks when a workflow run's report is not ok, on either track.
- It stops and asks when a workflow run pauses at a human gate, on either track.
- It stops and asks when cost.mjs reports an unpriced transcript, because the USD cap cannot be checked.

It ends with the summary below, one condition per line:

- It ends when Ready has no runnable card, under unlimited autopilot.
- It ends when the user says stop: the current card is finished or left In flow.
- It ends when the lead's context is at or above autopilot.contextThreshold in .doug/config.json (default 60): between cards the lead runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/context.mjs"`, which prints the context percentage of the lead's own session transcript, and treats a run that prints no reading as at the threshold.
- Before that summary it refreshes the anchor handoff: a `## Autopilot handoff` section in .doug/anchor.md naming the landed cards, any card left In flow, and that a new session resumes with /doug-next --auto.

An edge case or input the goal does not name is not a design decision: the lead takes the conservative behaviour, rejecting the input or, where rejecting is not possible, preserving it, never guessing, has whoever writes the test pin it, and names it in the card's landing note and the closing summary. A design decision is a choice, for inputs the goal names, between behaviours the goal's acceptance would both satisfy and a user would notice, or one that changes another card's or module's contract.

It waits for the answer, then resumes the queue at the card it stopped on. It ends with one summary: each landed card's commit, wall clock, and gate line; each stopped card and why; each edge case taken conservatively; and the follow-ups filed.
