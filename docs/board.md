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
| `version` | number | The record format version. Currently `1`. |
| `updated` | string | The date of the last change, `YYYY-MM-DD`. Set by every move and add. |
| `columns` | array | The columns, in display order. Each is an object with `id` and `title` (non-empty strings) and an optional `hint` string. Ids are unique. |
| `components` | array of strings | The component names a card may carry. A new board starts with `[]`; add names to the file by hand. |
| `tags` | array of strings | Optional. The closed vocabulary a card's `tags` come from. A record without this field, or a new board, uses `bug`, `feature`, `chore`, `docs`, `refactor`, `spike`. |
| `cards` | array | The cards, in board order. Order matters: `next` picks the first runnable Ready card, so reordering Ready is how the owner sets what `/doug-next` picks next. A move to Done appends the card, so Done is chronological and the page lists it newest first. |

## Card fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | A unique, non-empty string. Other cards name it in `deps`. |
| `column` | yes | The `id` of one of the board's `columns`. |
| `component` | no | One of the board's `components`. |
| `title` | yes | A short, non-empty title. |
| `size` | no | `S`, `M`, or `L`. |
| `track` | no | `flow` (default) or `hand`, picked by the change's size and risk, not by the directory it touches: `hand` is a gated by-hand change (tests first, the project's own gate from `stopGate.commands`, one commit) for a size S card or a tests-only, prose, or docs change; `flow` plans, approves, and runs the workflow for size M or L code that spans modules or needs an approvable plan; a change to a file the running workflow or hooks execute (the workflow file, `.doug/hooks/scripts/`, the plugin's own agents) stays `hand` whatever its size. `/doug-next <id>` routes a hand card to the `doug-hand` loop; `next` without `--track hand` skips it. Decision 0005. |
| `tags` | no | Zero or more tags, each one of the board's `tags` vocabulary. A card may carry several; absent or `[]` means none. Not editable on a done card. |
| `deps` | no | Card ids this card waits on. Every one must exist on the board. Defaults to `[]` when added through the CLI. |
| `goal` | yes | A non-empty statement of what done looks like; `/doug-next` hands it to the planner as the goal. |
| `source` | no | Free text on where the card came from or where it landed: a proposal section, a decision, or the landing commit. Moving a card with `--source` replaces it. |

Cards written by the CLI carry their keys in the order `id`, `column`, `component`, `title`, `size`, `track`, `tags`, `deps`, `goal`; `component`, `size`, `track`, and `tags` are omitted when not given.

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

- **Ready** (`ready`): `next` scans this column in board order and picks the first card whose `deps` are all in Done. Ready cards that are still waiting on a dependency are skipped and reported, and so are cards on the hand track (`skipping <id>: hand track (a by-hand card; /doug-next <id> takes it)`). Reordering the column (`reorder`, or a drag on the page) sets what `/doug-next` picks next.
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

- `doug board init | add | list | next | reorder | move | record | build | serve` in `packages/doug-cli`: create a board, add a card, list cards, pick the next runnable Ready card, move a card, append a run entry to the live-run log, render the page, and serve it locally.
- The doug-flow plugin's `scripts/board.mjs next | card | reorder | move | record`: mostly the same operations for a repository that has only the plugin installed; `/doug-next` calls it. `next --track hand` picks the first Ready hand-track card whose deps are Done (flow cards are reported as skipped), `next --batch <n>` prints the first n runnable Ready cards as a JSON array in board order (the cards `/doug-next`, or `/doug-hand` with `--track hand`, plans together in one plan), and `record <id> --hand --commit <sha> --wall <text> --gate <text> [--note <text>] [--rehearsal <scenario>]` appends a hand-track entry to `docs/live-runs.md` without a workflow report; `/doug-hand` calls both. `record ... --cost <usd>` takes the run's measured cost, which `scripts/cost.mjs <run-id>` sums from the local Claude Code transcripts and prices from its dated table; `/run-report` runs it first. `record ... --adversary "<id>=<class>[: <reason>]"`, once per block, classifies every adversary block the report records as `real` (a defect a user would hit), `marginal` (true to the spec, no user impact), or `false` (wrong); the entry carries a precision line (n real / n marginal / n false, plus any left unclassified) and one line per block, an id the report does not have is refused, and a block from before the finding ledger is named `pass-<n>`. When `.doug/plan.json` lists the card among its `cards` (a batch, `plan.mjs merge`), `record` writes that card's entry of the batch run: only its tasks and the integration rows of their levels, `--cost` as its tasks' measured cost, and `--shared-cost <usd>` the shared integration agents' cost, counted once under the batch's first card; `summary --card <id>` filters the same way, and its "Acceptance not met" line also reads only that card's own tasks by their `[<card>] ` tag, or the final integration level's acceptance when the report carries it, naming which source it used. The CLI's `record` does not implement its own version of this: both command layers call `lib/board.mjs`'s `recordLanding` for the record step (promote the card's research note from `.doug/.state/research/` to `docs/research/`, then append the run entry), so that part cannot drift between them again. What the CLI's `record` lacks is flags: `--rehearsal <scenario>` on both forms, and, on the run form only, `--note <text>`.
- `doug board remove <id> [--force]` and `board.mjs remove` delete a card from the record. A card another card lists in `deps` is refused always, `--force` included, because the board would then fail to load. A card in `done`, a card in `flow`, or a card named by `.doug/plan.json` is refused without `--force` and removed with a warning when `--force` is given. Either way, the removed card is printed as JSON after the confirmation line, so a mistake can be re-added by hand.
- `--tag <name>` on `add`, `edit`, `list`, and `next` sets or filters by a card's tag from the board's `tags` vocabulary; `list --tag` and `next --tag` each take exactly one tag, and `next --tag` filters silently, printing no "skipping" line for cards it excludes.
- `reorder <id> [dir] --before <other> | --after <other> | --top | --bottom` (both CLIs) moves a card within its column; the order is the card's position in `cards`, no field is added; a target in another column is refused, and cards of other columns keep their places.
- Both are built on `plugins/doug-flow/lib/board.mjs`, which owns path resolution, validation, `newBoard`, `addCard`, `nextReadyCard`, `moveCard`, and `reorderCard`.
- `doug board build [dir] [--out <file>]` renders the board page from the record, to stdout or to `--out`.
- `doug board serve [dir] [--port <n>] [--open] [--detach] [--stop]` is the board people use day to day: it serves the live page on 127.0.0.1 only, writes a drag straight to the record through `PUT /api/cards/<id>` with `{"column": "<id>"}`, or `{"column": "<id>", "before": "<other>"}` (or `"after"`) to place the card, the column unchanged when it only reorders, validated like `doug board move`. Opened without the server, the page is read-only and says so.
  - `GET /api/events` is a server-sent-events route: the server watches the record's directory (not the file, since writes are atomic — temp file then rename) and pushes a `board` event carrying the whole record on connect and again on every change. The page holds this connection open, re-renders on each event with no reload, shows a banner when the connection drops, and reconnects.
  - Without a flag, `serve` runs in the foreground until Ctrl-C. `--open` also opens the page in a browser (`$BROWSER` if set, otherwise the platform opener). `--detach` starts the server in the background, logging to `.doug/.state/board-serve.log`, and returns once it is up. `--stop` stops a detached server.
  - A pidfile at `.doug/.state/board-serve.json` records the running server's port and pid; a `serve` call with no `--stop` reuses a server already running for the same directory instead of starting a second one.
  - Still 127.0.0.1 only, no auth, nothing reported anywhere off the machine (decision 0003).
