# The development board

The board is a JSON record of the work a repository has decided on, is doing, and has done. It is a Doug feature (decision 0003): the CLI and the doug-flow plugin read and write it, and a page can be rendered from it.

## Where the record lives

- `.doug/board.json` is the canonical location.
- `docs/board.json` is read as a fallback when `.doug/board.json` does not exist.
- Whichever of the two exists is the one written back. A repository with only `docs/board.json` keeps writing `docs/board.json` until it moves the file.
- When neither exists, a new board is written to `.doug/board.json`.
- Writes are atomic (temp file then rename), so a crash mid-write never leaves a half-written record.

## Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `version` | number | The record format version: `1` or `2` (a record with no `version` counts as `1`). A new board is written as `2`. A version 1 record loads unchanged and becomes `2` only on the first write that adds an epic, a milestone, or a label group (`addEpic`, `addMilestone`, `addLabelGroup` in `lib/board.mjs`); a move, edit, or reorder never changes it. Decision 0016. |
| `updated` | string | The date of the last change, `YYYY-MM-DD`. Set by every move and add. |
| `columns` | array | The columns, in display order. Each is an object with `id` and `title` (non-empty strings) and an optional `hint` string. Ids are unique. |
| `components` | array of strings | The component names a card may carry. A new board starts with `[]`; add names to the file by hand. |
| `tags` | array of strings | Optional. The closed vocabulary a card's `tags` come from. A version 1 record without this field uses `bug`, `feature`, `chore`, `docs`, `refactor`, `spike`. With `labelGroups` (version 2) it is the label names of the groups, in group then label order, and must equal them. |
| `labelGroups` | array | Version 2, optional. Label groups, each `{ id, title, exclusive, labels }` with `labels` an array of `{ name, color, description? }`; `color` is `#rrggbb`. Label names are unique across groups, and when the key is present they are the tag vocabulary. A card may carry at most one label of an `exclusive` group. A new board gets the `type` group (`bug`, `feature`, `chore`, `docs`, `refactor`, `spike`) and the fixed `priority` group (`urgent`, `high`, `medium`, `low`), both exclusive. |
| `epics` | array | Version 2, optional. Each `{ id, title, goal, target?, status }`: `status` is `planned`, `active`, or `done`; `target` is `{ version?, date? }` with `date` a real `YYYY-MM-DD` date. List order is display order. A missing list counts as empty. |
| `milestones` | array | Version 2, optional. Same shape as `epics`. A card names one epic and one milestone, independently. |
| `cards` | array | The cards, in board order. Order matters: `next` picks the runnable Ready card with the highest priority, and board order breaks ties, so reordering Ready sets what `/doug-next` picks next among cards of one priority. A move to Done appends the card, so Done is chronological and the page lists it newest first. |

## Card fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | A unique, non-empty string. Other cards name it in `deps`. |
| `column` | yes | The `id` of one of the board's `columns`. |
| `component` | no | One of the board's `components`. |
| `title` | yes | A short, non-empty title. |
| `size` | no | `S`, `M`, or `L`. |
| `track` | no | `flow` (default) or `hand`, picked by the change's size and risk, not by the directory it touches: `hand` is a gated by-hand change (tests first, the project's own gate from `stopGate.commands`, one commit) for a size S card or a tests-only, prose, or docs change; `flow` plans, approves, and runs the workflow for size M or L code that spans modules or needs an approvable plan; a change to a file the running workflow or hooks execute (the workflow file, `.doug/hooks/scripts/`, the plugin's own agents) stays `hand` whatever its size. `/doug-next <id>` routes a hand card to the `doug-hand` loop; `next` without `--track hand` skips it. Decision 0005. A size S hand card whose class is `prose` or `docs` takes the lean lane: one coder writes the test and the change, with no tester seat and no mutation list (doug-hand step 3). |
| `class` | no | One of `tests-only`, `prose`, `gate-script`, `code`, `docs`, `eval`, `decision`. Read by the lean lane (a size S hand card of class `prose` or `docs`, see the `track` row), by the size x class wall budget in `board.mjs`, and by `memory.mjs condition open`, which refuses a card without one (doug-hand step 2). Set with `doug board add/edit --class` or `board.mjs edit --class`. |
| `tags` | no | Zero or more tags, each one of the board's `tags` vocabulary. A card may carry several; absent or `[]` means none. Not editable on a done card. |
| `epic` | no | Version 2. The `id` of one of the board's `epics`. Editable on a done card without `--force`; `null` in `editCard` removes it. |
| `milestone` | no | Version 2. The `id` of one of the board's `milestones`. Same rules as `epic`. |
| `deps` | no | Card ids this card waits on. Every one must exist on the board. Defaults to `[]` when added through the CLI. |
| `goal` | yes | A non-empty statement of what done looks like; `/doug-next` hands it to the planner as the goal. |
| `source` | no | Free text on where the card came from or where it landed: a proposal section, a decision, or the landing commit. Moving a card with `--source` replaces it. |

Cards written by the CLI carry their keys in the order `id`, `column`, `component`, `title`, `size`, `track`, `tags`, `epic`, `milestone`, `deps`, `goal`; `component`, `size`, `track`, `tags`, `epic`, and `milestone` are omitted when not given.

## Default columns

A new board gets these five columns.

| `id` | `title` | `hint` |
|---|---|---|
| `decide` | Decide | needs a decision from the owner before it can be planned |
| `backlog` | Backlog | planned work, not yet specced tightly enough for a plan |
| `ready` | Ready | has a /goal statement; a doug flow can start it |
| `flow` | In flow | plan approved, doug-implement running or awaiting integration; keep to two at a time |
| `done` | Done | merged, gate green, documented |

For `/doug-next`, three columns carry meaning:

- **Ready** (`ready`): `next` picks the card with the highest priority whose `deps` are all in Done: `urgent`, `high`, `medium`, `low`, then a card with no priority label, board order breaking ties (decision 0016). A board with no `priority` label group keeps pure board order. A blocked urgent card is skipped, not picked. `next` and `next --batch` also take silent `epic` and `milestone` filters like `tag`; an id the board does not have is refused (`unknown epic "y"; epics are a, b`, or `unknown epic "y"; no epics are defined`, and the same for milestones). Ready cards that are still waiting on a dependency are skipped and reported, and so are cards on the hand track (`skipping <id>: hand track (a by-hand card; /doug-next <id> takes it)`). Reordering the column (`reorder`, or a drag on the page) sets what `/doug-next` picks next.
- **In flow** (`flow`): the card `/doug-next` is working on. It is moved here when its plan is approved.
- **Done** (`done`): the card landed. A card in Done satisfies the `deps` of the cards that name it. Moving a card here with `--source "commit <sha>"` records the landing commit.

## Validation

The record is validated whenever it is loaded and after every add. Every problem is reported, not only the first. Loading a broken file fails with `<relpath> is not a valid board:` followed by one line per problem, prefixed `- `; adding a bad card fails with `cannot add card "<id>":` followed by the same lines.

| Rule | Message |
|---|---|
| The record is a JSON object | `board is not an object` |
| `columns` is a non-empty array | `columns must be a non-empty array` |
| Each column is an object with non-empty `id` and `title`; `hint`, when present, is a string | `column at index N: not an object`, `column at index N: missing id`, `column at index N: missing title`, `column at index N: hint must be a string` |
| Column ids are unique | `duplicate column "x"` |
| `components` is an array of strings | `components must be an array of strings` |
| `tags`, when present, is an array of strings with no duplicates | `tags must be an array of strings when present`, `duplicate tag "x"` |
| `version`, when present, is `1` or `2` | `version must be 1 or 2` |
| Version 2 keys need a version 2 record (a version 1 record's contents are not checked further) | `epics is a version 2 field; this record is version 1` (also `milestones`, `labelGroups`), `card "x": epic is a version 2 field; this record is version 1` (also `milestone`) |
| `epics` and `milestones` are arrays of objects with a unique non-empty `id`, a `title`, a `goal`, and a `status` | `epics must be an array`, `milestones must be an array`, `epic at index N: not an object`, `epic at index N: missing id`, `duplicate epic "x"`, `epic "x": missing title`, `epic "x": missing goal`, `epic "x": status must be planned, active, or done` (the same with `milestone`) |
| `target`, when present, is an object whose `version` is a non-empty string and whose `date` is a real `YYYY-MM-DD` date | `epic "x": target must be an object`, `epic "x": target version must be a non-empty string`, `epic "x": target date must be YYYY-MM-DD` (the same with `milestone`) |
| `labelGroups` is an array of objects with a unique non-empty `id`, a `title`, a boolean `exclusive`, and a `labels` array | `labelGroups must be an array`, `label group at index N: not an object`, `label group at index N: missing id`, `duplicate label group "x"`, `label group "x": missing title`, `label group "x": exclusive must be true or false`, `label group "x": labels must be an array` |
| Each label has a name unique across all groups, a `#rrggbb` colour (either case), and a string `description` when present | `label group "x": label at index N: missing name`, `duplicate label "y"`, `label "y": color must be #rrggbb`, `label "y": description must be a string` |
| With `labelGroups`, `tags` equals the label names in group then label order | `tags must equal the label names: a, b, c` |
| A card's `epic` and `milestone` name an existing epic or milestone | `card "x": unknown epic "y"`, `card "x": unknown milestone "y"` |
| A card has at most one label of an exclusive group | `card "x": tags "a" and "b" are both in exclusive group "g"` |
| `cards` is an array | `cards must be an array` |
| Each card is an object with a non-empty `id` | `card at index N: not an object`, `card at index N: missing id` |
| Card ids are unique | `duplicate id "x"` |
| `column` names one of the board's columns | `card "x": unknown column "y"; columns are a, b, c` |
| `component`, when present, names one of the board's components | `card "x": unknown component "y"; components are a, b`, or `card "x": unknown component "y"; no components are defined` when the list is empty |
| `title` and `goal` are non-empty strings | `card "x": missing title`, `card "x": missing goal` |
| `size`, when present, is `S`, `M`, or `L` | `card "x": size must be S, M, or L` |
| `tags`, when present, is an array of strings, each one of the board's `tags`, with no duplicates | `card "x": tags must be an array of strings`, `card "x": unknown tag "y"; tags are ...`, `card "x": duplicate tag "y"` |
| `deps`, when present, is an array of strings naming existing cards | `card "x": deps must be an array of strings`, `card "x": unknown dep "y"` |
| `source`, when present, is a string | `card "x": source must be a string` |

## Example

A complete board with one component and one card:

```json
{
  "version": 1,
  "updated": "2026-09-04",
  "columns": [
    { "id": "decide", "title": "Decide", "hint": "needs a decision from the owner before it can be planned" },
    { "id": "backlog", "title": "Backlog", "hint": "planned work, not yet specced tightly enough for a plan" },
    { "id": "ready", "title": "Ready", "hint": "has a /goal statement; a doug flow can start it" },
    { "id": "flow", "title": "In flow", "hint": "plan approved, doug-implement running or awaiting integration; keep to two at a time" },
    { "id": "done", "title": "Done", "hint": "merged, gate green, documented" }
  ],
  "components": ["gates"],
  "cards": [
    {
      "id": "stop-gate",
      "column": "ready",
      "component": "gates",
      "title": "Stop gate blocks files outside the approved plan",
      "size": "S",
      "deps": [],
      "goal": "A Stop hook reads .doug/plan.json and blocks the turn when a changed file is not owned by any task.",
      "source": "proposal section 3"
    }
  ]
}
```

## What operates on the file

- `doug board init | add | list | next | reorder | move | record | build | serve | epic | milestone | labels init` in `packages/doug-cli`: create a board, add a card, list cards, pick the next runnable Ready card, move a card, append a run entry to the live-run log, render the page, and serve it locally.
- The doug-flow plugin's `scripts/board.mjs next | card | reorder | move | record`: mostly the same operations for a repository that has only the plugin installed; `/doug-next` calls it. `next --track hand` picks the first Ready hand-track card whose deps are Done (flow cards are reported as skipped), `next --batch <n>` prints the first n runnable Ready cards as a JSON array in priority order (board order within a priority) (the cards `/doug-next`, or `/doug-hand` with `--track hand`, plans together in one plan), and `record <id> --hand --summary "<one sentence>" --commit <sha> --wall <text> --gate <text> [--note <text>] [--rehearsal <scenario> --rehearsal-outcome <passed|failed>]` appends a hand-track entry to `docs/live-runs.md` without a workflow report; `/doug-hand` calls both. `record ... --summary "<one sentence>" --cost <usd>` takes the run's measured cost, which `scripts/cost.mjs <run-id>` sums from the local Claude Code transcripts and prices from its dated table; `/run-report` runs it first. `record ... --summary "<one sentence>" --adversary "<id>=<class>[: <reason>]"`, once per block, classifies every adversary block the report records as `real` (a defect a user would hit), `marginal` (true to the spec, no user impact), or `false` (wrong); the entry carries a precision line (n real / n marginal / n false, plus any left unclassified) and one line per block, an id the report does not have is refused, and a block from before the finding ledger is named `pass-<n>`. When `.doug/plan.json` lists the card among its `cards` (a batch, `plan.mjs merge`), `record` writes that card's entry of the batch run: only its tasks and the integration rows of their levels, `--cost` as its tasks' measured cost, and `--shared-cost <usd>` the shared integration agents' cost, counted once under the batch's first card; `summary --card <id> --summary "<one sentence>"` filters the same way, and its "Acceptance not met" line also reads only that card's own tasks by their `[<card>] ` tag, or the final integration level's acceptance when the report carries it, naming which source it used. The CLI's `record` does not implement its own version of this: both command layers call `lib/board.mjs`'s `recordLanding` for the record step (promote the card's research note from `.doug/.state/research/` to `docs/research/`, then append the run entry), so that part cannot drift between them again. What the CLI's `record` lacks is flags: `--rehearsal <scenario>` (with `--rehearsal-outcome`) on both forms, and, on the run form only, `--note <text>`.
- `doug board remove <id> [--force]` and `board.mjs remove` delete a card from the record. A card another card lists in `deps` is refused always, `--force` included, because the board would then fail to load. A card in `done`, a card in `flow`, or a card named by `.doug/plan.json` is refused without `--force` and removed with a warning when `--force` is given. Either way, the removed card is printed as JSON after the confirmation line, so a mistake can be re-added by hand.
- `--tag <name>` on `add`, `edit`, `list`, and `next` sets or filters by a card's tag from the board's `tags` vocabulary; `list --tag` and `next --tag` each take exactly one tag, and `next --tag` filters silently, printing no "skipping" line for cards it excludes.
- `epic add`, `epic edit`, `epic list`, `milestone add`, `milestone edit` and `milestone list` (both CLIs; ADR 0016): `epic add <id> --title <t> --goal <g> [--version <v>] [--date YYYY-MM-DD]` appends an epic with status `planned` and moves a version 1 record to version 2; `epic edit <id> [--title] [--goal] [--version] [--date] [--status planned|active|done] [--force]` changes it (an empty `--version` or `--date` clears that part of the target); `epic list` prints the epics (`board.mjs` as a JSON array, `doug board` one line each, or the array with `--json`). `milestone add`, `milestone edit` and `milestone list` take the same flags. Setting `--status done` is refused while a card of that epic or milestone is not Done, naming those cards; `--force` sets it and prints a warning. `--epic <id>` and `--milestone <id>` on `add` and `edit` set a card's epic or milestone (an empty value clears it; `add` and `list` are `doug board` only), and on `list` and `next` (including `next --batch`) they filter, silently like `--tag`; an unknown id is refused.
- `rollup [dir] [--epic <id> | --milestone <id>] [--from <live-runs>]` (both CLIs; ADR 0016) prints JSON `{epics, milestones}`; each entry has `id`, `title`, `status`, `target`, `columns` (every board column, zeros included), `done`, `total`, `progress` (a 0..1 fraction weighted by each card's wall budget, `cardBudgetMinutes`; no partial credit for In flow), `measured` (`usd`, `usdCards`, `wallMinutes`, `wallCards`, `doneCards`: Done cards only, with coverage) `cards` (the member ids, record order) and `budget` (`wallMinutes`, `usd` of the not-Done cards: a budget, not a forecast). `--from` defaults to `docs/live-runs.md` when it exists; without live-runs the measured fields are `null`. `--epic` or `--milestone` prints that one entry; in `board.mjs` an unknown id, both flags, or an unreadable `--from` exits 2; `doug board` exits 2 for both flags and 1 for an unknown id or unreadable `--from`. A version 1 board gives empty lists.
- `labels --check [dir]` (both CLIs) prints one line per label colour below 3:1 contrast (WCAG 2.2 SC 1.4.11) against the card surfaces `#ffffff` and `#1c2022`, and nothing when all pass. It exits 0 either way.
- `labels init [dir]` (both CLIs) migrates a board with no label groups: the `type` group holds the board's existing tags, the fixed `priority` group is added, and the record becomes version 2, in one write. A board that already has label groups is refused. It prints `Added label groups type and priority to <path>.`
- `reorder <id> [dir] --before <other> | --after <other> | --top | --bottom` (both CLIs) moves a card within its column; the order is the card's position in `cards`, no field is added; a target in another column is refused, and cards of other columns keep their places.
- Both are built on `plugins/doug-flow/lib/board.mjs`, which owns path resolution, validation, `newBoard`, `addCard`, `nextReadyCard`, `moveCard`, `reorderCard`, `editEpic`, `editMilestone`, and `initLabelGroups`.
- `doug board build [dir] [--out <file>]` renders the board page from the record, to stdout or to `--out`.
- `doug board serve [dir] [--port <n>] [--open] [--detach] [--stop]` is the board people use day to day: it serves the live page on 127.0.0.1 only, writes a drag straight to the record through `PUT /api/cards/<id>` with `{"column": "<id>"}`, or `{"column": "<id>", "before": "<other>"}` (or `"after"`) to place the card, the column unchanged when it only reorders, validated like `doug board move`. Opened without the server, the page is read-only and says so.
  - `GET /api/events` is a server-sent-events route: the server watches the record's directory (not the file, since writes are atomic — temp file then rename) and pushes a `board` event carrying the whole record on connect and again on every change. The page holds this connection open, re-renders on each event with no reload, shows a banner when the connection drops, and reconnects.
  - `GET /api/autopilot` answers the autopilot run's view (`plugins/doug-flow/lib/autopilot-view.mjs`, from the uncommitted state file `.doug/.state/autopilot.json` that `/doug-next --auto` keeps through `plugins/doug-flow/scripts/autopilot.mjs`), or `null` with no file, a file that does not parse, or a wrong version; never a server error. The same view is pushed as an `autopilot` event on `/api/events` when the file changes. The page shows it as an Autopilot panel above the columns: the queue with each card's state (queued, running with its step and start time, landed with its commit, stopped with why), caps used against caps (USD, wall clock, lead context), and the follow-ups and user cards filed. With no run the panel is hidden; a finished run shows its summary; a run whose file has not been written for 2 hours shows as inactive, with no card running.
  - Without a flag, `serve` runs in the foreground until Ctrl-C. `--open` also opens the page in a browser (`$BROWSER` if set, otherwise the platform opener). `--detach` starts the server in the background, logging to `.doug/.state/board-serve.log`, and returns once it is up. `--stop` stops a detached server.
  - A pidfile at `.doug/.state/board-serve.json` records the running server's port and pid; a `serve` call with no `--stop` reuses a server already running for the same directory instead of starting a second one.
  - Still 127.0.0.1 only, no auth, nothing reported anywhere off the machine (decision 0003).
