# Memory: lessons, recall, and embeddings

Reference for `plugins/doug-flow/scripts/memory.mjs` and `lib/memory.mjs`/`lib/embeddings.mjs`: the outcomes and
lessons store, hybrid recall, and the optional local embedding provider (card `memory-recall`). Product first:
the store works with nothing installed (keyword-only over FTS5), and embeddings are an optional accelerator,
never a requirement. `doug init` never adds a provider on its own.

See also [docs/learn.md](learn.md): `learn.mjs` counts signals from this store and the run trace, and proposes
changes as diffs the user approves before anything is applied.

## Outcome conditions: `condition open` / `condition backfill`

Card `outcomes-condition-columns`: an
outcomes row carries no column naming the harness version it ran under, which is the single prerequisite for any
before-and-after comparison across harness changes. Schema v7 adds seven columns to `outcomes`, additive (a
guarded `ALTER TABLE ... ADD COLUMN` per column, in every migration chain that leads to v7, the same shape as
`partial`'s v4->v5 step):

| Column                | Type    | Meaning |
|------------------------|---------|---------|
| `harness_commit`       | TEXT    | the harness's git HEAD when the row's condition was opened (or, for a backfilled row, the last commit at or before the row's `recorded` timestamp) |
| `config_hash`          | TEXT    | `conditionConfigHash(dir)` (below) at that same moment; `null` on a backfilled row |
| `class`                | TEXT    | the card's class (`board.mjs`'s `card.class`) the row ran under |
| `arm`                  | TEXT    | the experimental arm, `<class>/default` until exploration exists |
| `assigned_by`          | TEXT    | `'policy'` or `'explore'` |
| `explore_probability`  | REAL    | the explore arm's assignment probability; `null` on a policy assignment |
| `backfilled`           | INTEGER | `1` only for a row `condition backfill` stamped after the fact, `0` for every other row (including an unstamped hand row) |

Outcome measurement starts from rows stamped at schema v7. Rows from before it get no hand classification and no class-only backfill command, so they keep whatever class `condition backfill` gave them (usually none).

Schema v8 (card `run-report-codex-cost`) adds one more column, the same additive shape: `codex_usd REAL`, the
Codex adversary's own cost, priced separately from Claude's `usd` and never folded into it; null on a hand row,
and on a flow row whenever no usage was present, the price is unknown, or a level adversary's cost is shared by
more than one task (never split, never double-counted).

On the flow track these seven columns are always null today: a flow row is never stamped by `condition
open`/`record --hand` — wiring that in is a later card (`core-next-hand-report`). `recordOutcomes`'s upsert
treats the seven columns as one atomic stamp, keyed on whether the *new* row carries a `harness_commit`: when it
doesn't (the row carries no condition), all seven columns keep the existing row's values untouched; when it
does, all seven take the new row's values, `backfilled` included. This is column-wise-mixing-proof by
construction — a plain per-column `COALESCE(excluded.c, outcomes.c)` let a re-record with no condition zero out
an existing stamp's `backfilled` flag (it defaults to `0`, not `null`) while keeping its old `harness_commit`,
half of one stamp mixed with half of another; the atomic, all-seven-or-none rule never does that.

**`conditionConfigHash(dir)`** (`lib/memory.mjs`, exported): hex sha256 of `.doug/config.json`'s utf8 bytes (or
`""` when the file is absent) plus `"\n"` plus "the Models table text" — the contiguous lines starting with `|`
in the first table after the `## Models` heading in `<dir>/CLAUDE.md` (`""` when CLAUDE.md or that heading is
absent), joined with `"\n"`. `.doug/config.json` is hashed whole (its full utf8 bytes), so any change anywhere in
that file changes the hash; CLAUDE.md, in contrast, is scoped to just the Models table — editing a table cell
changes the hash, editing any other CLAUDE.md prose does not.

```
memory.mjs condition open <card-id> [dir] [--json]
```

Writes `<dir>/.doug/.state/reports/<card-id>/condition.json`, pretty-printed, with exactly these keys:
`harnessCommit` (git HEAD, full sha), `configHash` (`conditionConfigHash(dir)`), `class` (the card's class from
the board), `arm` (`<class>/default`), `assignedBy` (`"policy"`), `exploreProbability` (`null`), `openedAt` (an
ISO timestamp). Refuses, exit 1, nothing written, in each of these cases: the file already exists (named in the
message; the existing file is left byte-identical); the card is missing from the board, or has no `class` (both
name the card); the directory is not a git repository, or has no commits yet (no HEAD). `condition open` with no
card id is a usage error, exit 2.

```
memory.mjs condition backfill [dir] [--json]
```

First checks once, up front, that `main` resolves (`git rev-parse --verify --quiet main^{commit}` in `dir`); when
it doesn't (no `main` ref, or `dir` is not a git repository at all), nothing is scanned, the row count stays 0,
and exactly one stderr line names `main` — still exit 0. Otherwise, for every `outcomes` row with
`harness_commit IS NULL`: runs `git log -1 --first-parent --format=%H --before=<row.recorded> main --` in `dir`.
When it prints a sha, the row is stamped — `harness_commit` set to that sha, `class` set to the row's `card`'s
class on the board when the board has that card and it carries a class (otherwise `class` is left as it was),
`backfilled` set to `1`, `config_hash` left `null` (there is nothing to recompute it from after the fact) — and
counted. When git finds no such commit, the row is left untouched and not counted. A missing board is not an
error (`class` stays whatever it was, usually `null`). Idempotent: once every row's `harness_commit` is
non-null, a second run finds nothing to stamp. Prints `Backfilled <n> outcomes rows with a harness commit.`
(`--json`: `{"backfilled": n}`).

**`record <card-id> --hand`** reads `<dir>/.doug/.state/reports/<card-id>/condition.json` when `condition open`
wrote one before the brief, and fills the seven condition columns from it via `handOutcomeRow`'s `condition`
argument (mapping `harnessCommit`->`harness_commit`, `configHash`->`config_hash`, `class`, `arm`,
`assignedBy`->`assigned_by`, `exploreProbability`->`explore_probability`; `backfilled` is always `0` from this
path — only `condition backfill` ever sets it to `1`). Without a `condition.json`, the landing still records
(exit 0) with all seven columns null, and prints one extra stdout line with the card id in both positions:
`No condition.json for <card-id>: this landing is unstamped (memory.mjs condition open <card-id> writes
one before the brief).` `--json` carries `"stamped": true|false` on the result object instead of that line.

## `memory.mjs recall`

```
memory.mjs recall <query> [dir] [--files <glob,glob>] [--k <n>] [--json]
```

Fuses BM25 over FTS5 with cosine similarity over stored vectors by reciprocal rank fusion (`1/(60+rank)` per
side) when an embedding provider is configured and vectors exist for it, recency-weights the result (age
measured from `confirmed` or `created`), and boosts a lesson whose `scope` matches `--files` (a comma-separated
list of globs; `**`, `*`, `?` supported, `**/` also matching zero directories). Text output starts with one
header line — `recall: hybrid via <provider> <model>/<dims>` or `recall: keyword-only (<reason>)` — followed by
one line per lesson (`id  score  kind  text`); `--json` returns the full `{ mode, reason, provider, checked,
lessons }` shape. Returned lessons never carry the embedding blob or its model/dims columns (multi-KB per
lesson) — only `hasVector: boolean`, whether one is stored.

**Citation re-check.** Each returned lesson's citation (a `path:line` or `path:line "quoted text"` form) is
re-checked against `[dir]`, but only when `[dir]` is a real project root — it exists and contains a `.doug`
directory. When it is not (a wrong path, a partial checkout, or `[dir]` omitted), the check is skipped entirely
and the result says so (`checked: false`): nothing is marked stale, nothing is confirmed, and every candidate is
returned as-is. This is deliberate — a wrong or partial checkout must never poison the store by marking every
candidate stale with no way back. Against a real project root (`checked: true`), a citation whose file or line
is missing, or whose quoted text no longer matches, marks that lesson `stale` and drops it from the result,
backfilling from the next candidate so `k` are still returned when enough exist; a citation that holds sets
`confirmed`. A lesson marked stale by mistake (the checkout was momentarily wrong, or the citation was hand-
fixed) is un-marked with `memory.mjs lesson unstale <id>` below — recall never reaches it again until then.

A lesson unconfirmed for more than `memory.staleDays` (`.doug/config.json`, 30 by default) since it was last
created or confirmed is excluded from candidates outright, regardless of citation. Read by both `memory.mjs
recall` and `plan.mjs json`'s per-task recall. A value that is not a positive finite number is never used: one
stderr line (`[doug] .doug/config.json memory.staleDays is not a positive number; using 30`) and 30 is used —
this never throws or exits nonzero.

## `memory.mjs reflect`

```
memory.mjs reflect <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>]
                    [--adversary "<id>=<class>[: <reason>]"]... [--claude-bin <path>] [--claude-dir <path>]
                    [--model <name>] [--max-usd <n>] [--dry-run] [--json]
```

Runs after `record` in `run-report` (card `memory-reflect`): report/dir/adversary parsing is the same as
`record`'s, and an `--adversary` id the report doesn't have fails the same way. `--hand` is refused — a hand
landing has no report to reflect on.

**Counters (deterministic, no LLM, always runs first).** For each task in the report with a non-empty
`memoryUsed`: a block classed `real` on that task bumps `harmful + 1` on every used lesson that exists (real wins
even when the task also verified); otherwise a task that `verified === true` bumps `helpful + 1` on every used
lesson that exists; a task that is neither real nor verified touches nothing. An id in `memoryUsed` that names no
lesson is reported in the result's `counters.unknown`, never an error. (The report also carries `indexUsed`, the
code-index chunk ids an implementer saw — see "In the flow" above; these counters read only `memoryUsed`.) These
counters, and a `reflections` row
keyed by the report's sha256, are committed in one transaction *before* the LLM pass runs, so a crash mid-reflect
never double-bumps and a failed LLM pass never loses the counters.

**The cheap-row pass.** A `claude -p --output-format json --json-schema <schema> --model <model> --max-budget-usd
<n>` call (model: `--model`, else the CLAUDE.md Models table's `cheap` tier, else `haiku`; `--max-usd` default
0.50; a 180s timeout) reads a prompt built from the report — the rules below in plain words, every task's owned
files (from the plan), verified/passes/stopReason/partial, review and verifier findings, its adversary blocks with
class and reason, and `memoryUsed`; and the id and text of the most recently created/confirmed `REFLECT_PROMPT_LESSON_CAP`
(200) existing lessons, so the model does not re-propose one, with the prompt saying so when the store holds more
than that — and proposes at most 3 lessons as `{ kind, text, citation, task, scope?, notDerivableBecause }`. The
cap only bounds what the model sees; the near-duplicate filter below still checks a proposal against the full,
uncapped set of existing lessons, never just the capped prompt list.

**The `partial` outcome column (schema v5, card `worker-context-handoff`).** A task's own outcome can end
`partial` instead of pass or fail: the harness measured a worker's context nearing its window, told it to stop at
a boundary and hand off, and the workflow's one resume attempt was itself still partial. The outcomes row carries
`partial` (1, 0, or `null` on a hand row, which has no such concept) next to `verified`; a partial task's
`verified` still reads whatever the report says — usually `0`, since the checks never ran on it — so read
`partial` before treating that `0` as a defect. The reflect prompt's per-task line above carries
`partial=<true|false>`, with a rule telling the model a partial task ran out of context, not verification: it
must propose no lesson that blames the task's code or its tests for that.

**Four filters, in code, never trusted to the model; a rejection carries a reason and never throws:**
1. A `pitfall` is valid only for a task with a block classed `real`; a `pattern` only for a task that verified
   `true` on its first pass (`passes === 1`).
2. The citation must be checkable: `report:<task>/<block-id>` naming a block of that task in this report,
   `report:<task>` naming a task in this report, or a `path:line` / `path:line "quoted text"` citation that
   passes `checkCitation` against `dir`. Free text, an empty string, or a malformed `report:` citation is
   rejected outright. These two `report:` forms — `report:<task>` and `report:<task>/<block-id>` — are the only
   ones implemented; neither ever carries a run segment. The earlier `report:<run>/<task>/<ledger id>` wording
   from the memory-outcomes card is history, not the current contract.
3. `notDerivableBecause` must be non-empty, and the lesson text (whitespace-normalised, case-folded) must not
   already sit verbatim in the cited file or in `CLAUDE.md` — a fact already in the checkout is not a lesson.
4. **Near-duplicate.** Jaccard similarity over lower-cased word tokens (length >= 3) at or above
   `REFLECT_DUPLICATE_JACCARD` (0.6) against every non-superseded existing lesson and every lesson already
   appended earlier in the same pass bumps the matched lesson's `helpful + 1` (recorded in `bumped`) instead of
   appending. An `addLesson` id collision (same kind+citation+text hash) is checked against the store directly,
   superseded rows included: a collision with a *live* lesson bumps it the same way; a collision with a
   *superseded* lesson is rejected with a reason — there is nothing live to bump, and appending would throw (the
   id is already taken) — so a stale duplicate never gets stuck holding the reflections row at `proposed: null`
   forever, unretryable.

At most 3 lessons are appended per reflection. The cap limits appends, not evaluation: a proposal past the cap
that turns out to be a near-duplicate still bumps the lesson it matches; only a proposal that would otherwise be
a genuine new append past the cap is rejected, naming the limit. A surviving lesson is appended with `addLesson`
(`source: { agent: "reflect", model }`, `task`, `card`/`commit` from the flag or else the task's own, `scope`
from the proposal), then best-effort embedded the same way `lesson add` embeds a row it just wrote.

**Idempotency.** A `reflections` table (schema v4) keyed `report_hash TEXT PRIMARY KEY` records `recorded`, `run`,
`card`, `commit_sha`, `model`, `counters` (JSON `{ helpful, harmful, unknown }`), `proposed`, `appended`,
`bumped`, `rejected` (JSON `{ text, reason }[]`), `usd`, `usd_source`, `session_id`. A second `reflect` on a
report with the same sha256 does nothing and prints that it was already reflected on `<recorded>`, exit 0;
`--json` returns the stored row. Lessons stay add-only throughout: nothing here ever `UPDATE`s or `DELETE`s a
lesson's text/kind/citation — only `helpful`/`harmful` and the `reflections` table change.

**Cost**, measured the same way as `record`'s: the real per-message transcript at
`<claudeDir>/projects/<projectSlug(dir)>/<session_id>.jsonl` when it exists and prices (`usd_source: "transcript"`),
else the envelope's own `total_cost_usd` (`usd_source: "claude"`), else `null`/`null`. The CLI prints it to four
decimal places (`$0.0043 (transcript)`), not two — a cheap-row pass is often a fraction of a cent, which two
decimals would round to a misleading `$0.00` — and prints `cost not measured` instead of a dollar figure when
`usd` is `null`.

**Failure handling.** If the spawn fails, times out, prints no parseable JSON, reports `is_error`, or lacks
`structured_output.lessons`: the counters (already committed) stand, the `reflections` row is updated with
`proposed: null` and the failure as one `rejected` entry, one line goes to stderr, exit 1. "No parseable JSON"
tolerates a stray notice or warning line printed on stdout before or after the JSON envelope — the CLI parses the
last balanced top-level `{...}` object on stdout, not the whole buffer with a single `JSON.parse`.

**`--dry-run`** applies nothing at all — no counters, no `reflections` row, no lessons appended — but still runs
the LLM pass and prints what would happen, cost included.

## `memory.mjs doctor`

```
memory.mjs doctor [dir] [--json]
```

Probes the configured embedding provider (`memory.embeddings` in `.doug/config.json`), or a local Ollama at
`http://localhost:11434` when nothing is configured, and prints what it found, the model it would use — there is
no `--model` flag; the model always comes from `memory.embeddings.model` (or the `embeddinggemma` default when
nothing is configured) — and the one command to install what is missing. The probe tries `GET /api/version`
(then `/api/tags`) first; only when that succeeds is it treated as Ollama, with a model list to check the
configured model's presence against (matched on the exact name or the part before `:`, since Ollama lists a
pulled model as `<name>:latest`). When `/api/version` fails — a working llama-server, vLLM, LM Studio, or hosted
key never serves it — the probe falls back to one embed call and reports reachability from that instead; install
instructions are printed for that case only when the configured `baseUrl` is itself the Ollama preset host:port
(`localhost`/`127.0.0.1:11434`) — a down local Ollama, the one case `doctor` exists to catch — never for a real,
reachable non-Ollama provider that simply lacks that one endpoint.

## `memory.mjs reembed`

```
memory.mjs reembed [dir] [--batch <n>] [--check] [--no-check] [--pairs <file>] [--json]
```

(Re)embeds every lesson not yet embedded under the configured provider's model/dims, `--batch` lessons (default
32, must be a positive integer) at a time, printing `embedded <n>/<total>` on stderr as it goes. Refuses with a
usage line when no provider is configured or `--batch` is not an integer >= 1.

Before embedding, `reembed` runs the [cosine sanity check](#embedding-sanity-check) whenever the store is about
to start using a model/dims pair it hasn't before: no active lesson is embedded under the configured
model/dims while at least one lesson exists (the very first embed under any model counts as a change from
"none"). A failed check embeds nothing and exits 1. `--check` forces the check on every reembed regardless of
that rule; `--no-check` skips it entirely, printing one line on stderr, for a deliberately non-semantic test
double; `--pairs` is accepted here too, to point the check at a different pairs file. `--json`'s object carries
`check: "ok" | "skipped" | "not-needed"` alongside `total`/`embedded`/`failed`/`reason`, saying which of the
three happened.

## `memory.mjs index`

```
memory.mjs index build  [dir] [--batch <n>] [--check] [--no-check] [--pairs <file>] [--json]
memory.mjs index status [dir] [--json]
memory.mjs index search <query> [dir] [--files <glob,glob>] [--k <n>] [--json]
```

Card `semantic-index`: an opt-in semantic index of the repository's own tracked, non-binary code — a cache of
chunked file text in the same node:sqlite store as outcomes and lessons (schema v6: `code_files`, `code_chunks`,
`code_chunks_fts`, `code_index_builds`), never an add-only record the way lessons are. Keyword-only over FTS5
with nothing installed; hybrid, fusing BM25 with cosine over stored vectors, once `memory.embeddings` (above) is
configured — the same provider layer and the same embed-check sanity gate as lessons. Running one of these three
commands is itself the opt-in: they work regardless of `memory.index.enabled` (below), so a build and a search
can be tried before turning the index on for the flow.

**`index build`** hashes every indexable file (tracked by git, under 256KB, not binary, not a lockfile, not under
`node_modules/`/`dist/`/`.git/`, not `*.min.*`, further narrowed by `memory.index.include`/`exclude` globs),
re-chunks and re-embeds only the files whose hash changed since the last build, and drops rows for files no
longer indexable (removed or renamed away — a rename re-indexes fresh under the new path). A chunk's id is
derived from its path, its own content hash, and its occurrence index among same-hash chunks earlier in that
same file (0 for the first) — the last part matters when a file repeats an identical block more than once, so
two (or more) duplicate blocks each keep their own row instead of colliding into one while `code_files.chunks`
still counts every occurrence. A chunk whose text did not move keeps its row and its embedding across rebuilds.
With a provider configured, pending chunks embed in batches (`indexed <n>/<total>` on stderr, like `reembed`),
running the [cosine sanity check](#embedding-sanity-check) first the same way `reembed` does — on a model/dims
pair the code index has never used before — with identical `--check`/`--no-check`/`--pairs` flags. Unlike
`reembed`, a down provider or a failed sanity check never makes `build` exit nonzero: it always completes,
reporting keyword-only with the reason, exit 0; only a non-git `dir` or a database problem is a real failure
(exit 1, naming it — the same as any other thrown error in this CLI). One line summarizes each run, its
embedded-seconds rounded to one decimal, a partial embedding failure named alongside the reason rather than
hidden behind a successful-looking count:

```
index: 41 files, 318 chunks (3 changed, 0 removed); embedded 12 of 12 under embeddinggemma/512 in 0.8s
index: 41 files, 318 chunks (0 changed, 0 removed); keyword-only (no provider configured)
index: 41 files, 318 chunks (3 changed, 0 removed); embedded 9 of 12 under embeddinggemma/512 in 0.8s; 3 failed (HTTP 500)
```

`--json` prints the `buildIndex` result object (`files`, `chunks`, `filesChanged`, `filesRemoved`,
`chunksEmbedded`, `chunksFailed`, `embedSeconds`, `check`, `reason`).

**`index status`** reports the index's size and its refresh cost without writing anything, in four lines:

```
index: 41 files, 318 chunks, 812004 bytes of text, 946176 bytes on disk
embedded: 318/318 under embeddinggemma/512
built: 2026-09-12T18:04:11.000Z at a1b2c3d (current)
refresh: 2 added, 1 changed, 0 removed; 9 chunks to embed, about 0.6s at 15.0 chunks/s
```

Size: file and chunk counts, total chunk text bytes, the database file's own size on disk, and how many chunks
are embedded under the configured provider's model/dims versus the total (`embedded: none (no provider
configured)` with nothing configured). Refresh cost re-lists and re-hashes every indexable file (no writes),
counts files added/changed/removed since the last build, and chunks the added/changed files in memory to count
exactly the chunk ids not yet stored — the same number the next `index build` would embed. With nothing pending,
the line reads `0 chunks to embed` and stops there, no time clause at all. Otherwise its time estimate divides
that count by the rate (chunks/second) of the most recent build that actually measured one — the most recent
`code_index_builds` row with both `embed_seconds > 0` and `chunks_embedded > 0`, not necessarily the *last*
build: a no-op rebuild or a keyword-only build writes a row with both at 0, and must never be read as if it
measured a rate of zero in place of an earlier real embed pass. With no row having ever measured one, the line
reads `time unmeasured (no measured build)` instead of a number. The last line also names the last build's
`finished` timestamp and `head_sha`, and whether that sha still matches the checkout's current `HEAD` (`current`
/ `behind HEAD`) — this always reflects the single most recent build, unlike the rate above. An index that has
never been built is not an error: every size count is 0, `built: never`, and the refresh line counts every
indexable file as added. `--json` prints the `indexStatus` object.

**`index search`** is hybrid search in the shape of `recall`'s: BM25 over `code_chunks_fts` fused with cosine
over stored vectors by reciprocal rank fusion, restricted to files matching `--files` (comma-separated globs) on
both sides — no recency term, code has none. A header line names the mode:

```
index: hybrid via openai-compatible embeddinggemma/512
index: keyword-only (no provider configured)
```

followed by one line per chunk — `<path>:<start>-<end>  <score to 4 places>  <first non-blank line, trimmed to 80
chars>`. `--k` (default 8) must be an integer >= 1, exit 2 with usage otherwise, as `recall` does; no query is
also exit 2 with usage. `--json` prints the `searchIndex` result (`mode`, `reason`, `provider`, `chunks: [{ id,
path, startLine, endLine, score, sides, text }]`).

**The `memory.index` config key.** `.doug/config.json`, read the same tolerant way `memory.embeddings` is — an
absent key, an unreadable config, or an invalid shape are all silently the off shape (an invalid shape also warns
once on stderr):

```json
"memory": { "index": { "enabled": true, "include": ["src/**"], "exclude": ["**/*.test.*"], "chunkLines": 60 } }
```

`enabled` (default `false`) is the only field the flow itself reads, and only the flow: it gates whether the flow
consults the index at all (below; the three CLI commands above ignore it entirely, since running one is the
opt-in). `include`/`exclude` (default `[]`, the same glob dialect as `recall`'s `--files`) and `chunkLines`
(default 60, the target chunk size `chunkText` merges blocks up to, capped at 2000 characters either way) tune
what `index build` covers and how finely it splits it.

**In the flow (card semantic-index, brief B).** With `memory.index.enabled` true, the memory database present, and
`code_chunks` holding at least one row, `plan.mjs json` runs `searchIndex(m, "<task title>\n<task spec>", { k: 6,
provider })` per task and attaches the result as `codeContext` (a string) and `codeContextIds` (the chunk ids kept,
in rank order) on that task only — never a plan-level field, never written to `.doug/plan.json` itself. Each
matching chunk renders one line, `- <path>:<start>-<end>  <first non-blank line of the chunk, trimmed to 120
chars>`, under a running 2000-character cap that skips an overflowing line rather than stopping (the same rule
`lessons` uses); a task with no match carries neither field. Any failure past that point (a broken database,
`node:sqlite` missing) prints one `[doug] code index skipped: <message>` line and the plan comes back without the
fields, never a nonzero exit; when the index is off, absent, or empty, nothing is attached and nothing is printed.
The embeddings provider is shared with the lessons attach step (the same `cachingProvider` wrapper), so a down or
slow endpoint is still probed only once per `plan.mjs json` run, not once per attach step.

The workflow puts a task's `codeContext` (capped again at 2000 characters, belt to `plan.mjs json`'s own cap) in
front of its implementer, lead, each swarm worker, and every fix pass, right after that task's lessons, headed
"Code the semantic index found relevant to this task (path:lines; read these first, they are not the files you
own):" — a reused task's `reusePrompt` carries neither lessons nor code context. The run report records
`indexUsed`, the ids of the chunks an implementer actually saw: empty for a reused task, or one for which no
implementer ran (a dependency that never integrated is one such case).

The planner also searches the index before deciding tasks: when `.doug/config.json` has `memory.index.enabled`
true, it runs `memory.mjs index search "<the request in one line>" --k 8` alongside its lesson recall and reads
the files the result names; when the index is off, prints a keyword-only header with no chunks, or prints nothing,
the planner says nothing and goes on.

## Embedding sanity check

```
memory.mjs embed-check [dir] [--pairs <file>] [--json]
```

Card `memory-measure`, from ruvLLM issue #655: a non-semantic embedder (one that ignores the text and returns
essentially the same vector for everything) scored known paraphrase pairs and known-unrelated pairs both
91-100% similar — retrieval built on it is worse than keyword-only, silently. `embed-check` catches that before
it happens: `plugins/doug-flow/lib/data/pairs.json` holds a dozen paraphrase pairs (the same lesson said two different ways)
and a dozen unrelated pairs (two lessons about different things), plus a `margin` (`0.15` by default). The
check embeds every sentence from both lists in one call against the configured provider, scores each pair by
cosine (vectors are L2-normalized, so cosine is the dot product), and passes only when **both** hold:

- the mean paraphrase cosine clears the mean unrelated cosine by at least `margin`;
- no single paraphrase pair scores below the unrelated mean (a good average hiding one dead pair is still a
  real problem).

Text output is one line — `embed-check: ok (gap 0.42 >= margin 0.15; paraphrase mean 0.81, unrelated mean
0.39)` — or `embed-check: FAILED (<reason>)` followed by one line per paraphrase pair that fell below the
unrelated mean (a failure on the margin alone, with every individual pair still above the unrelated mean, lists
no pairs — the reason names the margin instead). `--json` prints the full `{ ok, margin, gap, paraphrase: {
mean, min }, unrelated: { mean, max }, failures, reason }` object. Exit 0 on ok, 1 on a failed check, an
unreachable provider, or none configured, 2 on usage; refuses (exit 1, naming the path and `--pairs`) when the
pairs file is missing.

`reembed` runs this check automatically on a model/dims change (see above); use `--no-check` there for a test
double that is deliberately not semantic (e.g. a fixed-vector fake), and `embed-check` directly to check a
real provider on demand, independent of reembedding anything.

**Best-effort add/import never embeds a new model/dims pair either.** `lesson add` and `import`'s best-effort
embedding (below) shares `reembed`'s own "is this model/dims new to the store" test: if it is, they leave the
row(s) pending and print a stderr note instead of embedding, so a plain add can never quietly establish a bad
model/dims pair as already-in-use and cause a later `reembed` to skip the check (it only sees "no change" once
something is actually embedded under that pair — which only `reembed`, past its check, may do first).

## `memory.mjs import`

The auto-memory roundtrip: rolls every memory file (`*.md` other than `MEMORY.md`, the index) with a non-empty
body into the lessons store, embedding only the row(s) it just wrote (see `lesson add` below). It is idempotent, and a rewritten auto-memory file
supersedes the row it wrote before; it never writes under the auto-memory directory itself. `run-report` runs it
before `memory.mjs record` on every landing, on both tracks, so lessons written since the last import reach the
store.

A file is identified by its name, not its path: the same file name seen from a second auto-memory directory (a
moved home, or a different project slug) supersedes the row the earlier import wrote for it rather than adding a
second one. This holds because the importer reads one flat auto-memory directory per run, where names are
already unique.

## `memory.mjs lesson add` / `lesson unstale`

```
memory.mjs lesson add --text <text> --kind <feedback|project|pitfall|pattern> [dir]
                 [--scope <glob,glob>] [--citation <text>] [--card <id>]
                 [--commit <sha>] [--source-agent <name>] [--source-model <name>] [--json]
memory.mjs lesson unstale <id> [dir] [--json]
```

`lesson add` (and `import`, the auto-memory roundtrip) embeds only the row(s) it just wrote, best-effort, when a
provider is configured — never the whole backlog; a pending row from an earlier add is left alone until
`reembed` (or a later add/import of its own) picks it up. A provider failure prints one stderr line and never
turns into a nonzero exit — and neither does the one case that isn't a failure: when the configured model/dims
pair is new to the store (no active lesson is embedded under it yet), the row is left pending and one stderr
line says so, pointing at `memory.mjs reembed` (see [Embedding sanity check](#embedding-sanity-check) above) —
best-effort add/import must never be the thing that quietly puts a new, unchecked model/dims pair into use.
`lesson unstale <id>` clears a lesson's `stale` mark — `stale` is not one of the columns the lessons table's
no-rewrite trigger protects, so this is an ordinary update, not a special case.

## The `memory.embeddings` config key

`.doug/config.json`: `null` (the default) or:

```json
"memory": { "embeddings": { "provider": "openai-compatible", "baseUrl": "http://localhost:11434", "model": "embeddinggemma", "dims": 512 } }
```

`provider` is `"openai-compatible"` (Ollama, llama-server, vLLM, LM Studio, or a hosted OpenAI-shaped key — all
the same adapter, POSTing `<baseUrl>/v1/embeddings`) or `"voyage"` (Voyage AI's own endpoint). `apiKeyEnv`
(optional) names the environment variable holding the key (`OPENAI_API_KEY` / `VOYAGE_API_KEY` by default for
each provider). The two providers differ when it is unset: `openai-compatible` sends the request unauthenticated
(fine for a local server with no key); `voyage` refuses outright with `missing API key: set VOYAGE_API_KEY` (or
the configured `apiKeyEnv` name), since Voyage's endpoint always requires one. Every stored vector carries its
`model` and `dims`; a query only ever compares against rows with the same pair.
A provider that is down, slow (2s timeout), or returns the wrong dims never blocks a run — recall falls back to
keyword-only and says why, and an embed that comes back the wrong size is truncated and re-normalized when it is
longer than `dims`, or reported `ok: false` when it is still the wrong size after that.

**The recommended preset** is Ollama with `embeddinggemma`, the JSON snippet above. Any OpenAI-compatible base
URL uses the same adapter. Install it with `brew install ollama` (macOS), `curl -fsSL
https://ollama.com/install.sh | sh` (Linux), or `winget install Ollama.Ollama` (Windows); then `ollama pull
embeddinggemma`.

**Task prefixes.** Two model families need a prefix the provider layer adds automatically (the server never adds
it): `embeddinggemma` gets `task: search result | query: ` for a query and `title: none | text: ` for a
document; `nomic-embed-text` gets `search_query: ` / `search_document: `. Every other model gets none.

**Measured speeds** (Apple silicon laptop, 2026-09-07): Ollama 0.30.10 ~91ms per single query; llama-server on the same GGUF
~9ms per single query — both fast enough that recall never needs to be skipped for latency; quoted here so a
user can pick a backend informed.

## Decisions and rules: the proposal path

`docs/decisions/` ADRs and `.claude/rules/` conventions are written only through an approved proposal diff (card
`memory-decisions`) — the same log-then-propose shape `learn.mjs` uses (see [docs/learn.md](learn.md)), built on
the same `writeProposals`/`applyProposal` under `.doug/.state/learn/`. `lib/decisions.mjs` renders each proposal
as a diff; nothing in this module ever writes `docs/decisions/` or `.claude/rules/` directly.

```
memory.mjs decision propose --title <text> --file <path> [--date YYYY-MM-DD] [dir] [--json]
memory.mjs decision amend <NNNN> (--text <text> | --file <path>) [--date YYYY-MM-DD] [dir] [--json]
memory.mjs rule propose <name> --file <path> [--paths <glob,glob>] [dir] [--json]
```

`decision propose` writes a new ADR at `docs/decisions/<NNNN>-<slug>.md` — `<NNNN>` is one past the highest
number already under `docs/decisions/`, `<slug>` from the title — in the repo's existing shape: `# NNNN.
<title>`, a `Date: YYYY-MM-DD. Status: accepted.` line, then the body verbatim. Refuses when the target already
exists or the title/body is empty. `decision amend <NNNN>` appends a dated `## Amendment YYYY-MM-DD` section to
the one ADR matching `<NNNN>` (a number, or a `NNNN-slug.md` basename/path); refuses when none or several match.
An existing card note, "docs/decisions/0001 gets a dated amendment", means `/doug-decide amend 0001` — the
proposal path is how that happens, not a hand edit. `rule propose <name>` writes (or replaces)
`.claude/rules/<name>.md`; `--paths <glob,glob>` gives it a `paths:` frontmatter block, so it loads only when
Claude Code reads a matching file — Claude Code's own contract, not this project's: every `*.md` under
`.claude/rules/` loads recursively, the frontmatter key is `paths:` (a YAML list of globs), and a rule with no
`paths` loads unconditionally for every file at session start
([code.claude.com/docs/en/memory.md#path-specific-rules](https://code.claude.com/docs/en/memory.md#path-specific-rules)).
`--file -` reads the body/text from stdin on every form. Every command prints the proposal line, the diff path,
and `apply with: learn.mjs apply <path>` — nothing is written until that command is run and approved.

**The gate.** `proposalPaths` in `.doug/config.json` defaults to `["docs/decisions/**", ".claude/rules/**"]`.
`protect-paths.mjs` refuses an Edit/Write/MultiEdit/NotebookEdit on a match outright — decision 0006's lesson is
that a rule which stops the honest path but not a Bash workaround is worse than none, so the Stop gate also
scans changed files under these paths and blocks when one's current content is not recorded in the
applied-proposal ledger, `.doug/.state/proposals/applied.jsonl` (one JSON line per successful `learn.mjs apply`:
`{ target, sha256, diffSha256, at, proposal }`, appended by `applyProposal` itself — `proposal` is the diff
file's path relative to the project, and `diffSha256` is that diff file's own sha256). A line counts at Stop
only when the diff it names still exists under `.doug/.state/learn/` with that exact `diffSha256`, and —
applied onto the target's committed base in a scratch directory (`git show HEAD:<target>`, then `git apply`) —
reproduces the target's current bytes exactly (card `proposal-ledger-forgeable`). A hand-written line carrying
only a matching `sha256`, the pre-hardening line shape, or a diff that does not survive that replay never
satisfies this, so a hand-written `docs/decisions/0001-forged.md` plus one hand-written ledger line no longer
unlocks it. Set `proposalPaths` to `[]` to turn this off. The `/doug-decide` skill is the user-facing front end
for all three forms: it runs the matching command, shows the diff, asks with `AskUserQuestion`, and applies
only on yes.

This raises the cost of a forgery by one file, it does not make the ledger unforgeable: nothing here stops an
agent from writing all three files by hand — the forged content, a diff under `.doug/.state/learn/` that
genuinely re-derives it, and a ledger line naming that diff — and that still passes every check above. Decided
2026-09-13 (decision 0006, amendment 2026-09-13, card `d-proposal-authorization`): the ledger, the diff, and
the Stop gate's step 1b are an honest-path record, not proof of the user's yes. The three-write forgery above,
and the deleted-state-file baseline re-capture below, stay open by decision — no further hardening cards are
written for the ledger. Two alternatives were considered and not taken: having the user run the apply
themselves (option b) gains nothing the Stop gate can see, because hook input carries no field that identifies
the caller and a command the user runs locally produces no PreToolUse event (verified for a slash command; a
`!` command specifically was never observed), so a user-typed `learn.mjs apply` is indistinguishable from a
model-issued one; and moving the authorization record outside agent-writable state
(option c) has nowhere to go, because no place in Claude Code's contract records the user's yes outside
Bash-writable state — the AskUserQuestion answer is user-supplied at the moment it happens, but it lands only
in the transcript or a hook-written file, both ordinary files a Bash call can also write.

The Stop gate now also scans commits made since the session's baseline HEAD (`git diff --name-only <baseline
HEAD>..HEAD`, card `stop-scan-committed-changes`) and walks `docs/decisions/` and `.claude/rules/` directly on
disk, so a hand-written ADR or rule the session commits before Stop, or writes under a directory the project's
own `.gitignore` hides from `git status` entirely, is caught the same way an uncommitted, git-visible one is.
The one caveat: when the baseline itself is captured by the Stop gate's own fallback rather than by
`SessionStart`, a commit made before that very first Stop predates the baseline and is not scanned. The walk
itself sits out entirely for a session whose baseline predates it (an old state file, or a mid-session redeploy
of the vendored hooks) until the one-time repair described in lib/state.mjs's `baselineWalked` runs on that
session's next Stop; from the Stop after that, the walk is live.

Two more limits, documented rather than closed. The committed scan is a plain tree diff from the baseline
HEAD, with no notion of where the commits came from — a merge or a `git pull` that brings in a hand-written ADR
from somewhere else entirely trips it exactly like a hand-written one the session authored itself, so the right
response to a block from this scan is to ask the user what happened, never to revert on the gate's say-so alone.
And both new scans read entirely from the session state file under `.doug/.state/` (`baseline`, `baselineHead`,
`baselineWalked`) — deleting that file and letting the Stop gate's fallback re-capture at whatever the tree
looks like afterward forges a fresh, clean baseline and defeats both scans outright. This is the same
agent-writable-state hole card `d-proposal-authorization` decided (decision 0006, amendment 2026-09-13) to
leave open, not a new one.

## CLAUDE.md: the proposal path

`CLAUDE.md` is the third proposal-only target, alongside `docs/decisions/` and `.claude/rules/` (card
`claude-md-from-lessons`). `lib/decisions.mjs`'s `proposeClaudeMd` turns an authored, source-cited edits file
into ONE unified diff to `CLAUDE.md`; nothing in the module ever writes `CLAUDE.md` itself.

```
memory.mjs claude-md propose --file <path|-> [dir] [--json]
```

`--file -` reads the edits JSON from stdin instead of a path. `[dir]` resolves the way every other `memory.mjs`
command does — `CLAUDE_PROJECT_DIR` wins over the positional argument. Bad usage exits 2. When `--file` does not
parse as JSON, the command exits 1 naming the file and the parse error. A refusal from `proposeClaudeMd` exits 1
with the reason on stderr. On success it exits 0, printing the proposal line, the diff path, and
`apply with: learn.mjs apply <diff>`.

**The edits file.** A JSON object of this shape:

```json
{
  "note": "why this pass touched CLAUDE.md",
  "add": [
    { "heading": "## Gotchas", "line": "- new gotcha text", "source": "lesson 1ee7d426432aca82" }
  ],
  "remove": [
    { "line": "- old gotcha text", "enforcedBy": "protect-paths.mjs", "source": "lesson 57e95459558cbc76" }
  ]
}
```

`heading` names a `## ` line of `CLAUDE.md`, matched by its trimmed text; an added `line` must start with `- `
and is appended after that section's last bullet. A removed `line` must match one line of `CLAUDE.md` verbatim,
and exactly once. `enforcedBy` names what now enforces the rule the removed line used to state in prose, instead
of prose itself — when it ends in `.mjs` that file must exist under `.doug/hooks/scripts/`. `source`
cites where the change was learned: a lesson id, a `docs/live-runs.md` date, or a research note.

**Refusals**, checked in this order, nothing written on any of them:

- CLAUDE.md missing under `dir`.
- `edits` is not an object with `add`/`remove` arrays (any value `JSON.parse` can produce — `null`, an array, a
  string, a number, entries that are numbers or nested objects — is refused, never thrown on).
- `add` and `remove` both empty or absent — nothing to add or remove.
- Per remove: the entry is not an object; the line is not found; the line occurs more than once (named with the
  count); `source` is empty; `enforcedBy` is empty; the named `enforcedBy` hook file does not exist under
  `.doug/hooks/scripts/`.
- Per add: the entry is not an object; the line does not start with `- `; `source` is empty; the named heading
  is not found in CLAUDE.md.
- After applying every remove and add: the text from the `## Models` line to end of file changed (the section
  `plugins/doug-flow/lib/models.mjs` parses); the fenced ```sh Commands block changed; the result is over 60
  lines (CLAUDE.md's own cap, counted `wc -l` style, named with the resulting count).
- The new text equals the old text — the existing "already has exactly this content" refusal.

**Output and apply.** A successful run writes `.doug/.state/learn/<timestamp>/proposals.json` (the whole
proposal, including the rationale with every add's source and every remove's `enforcedBy`) and
`01-claude-md.diff`. `.doug/.state/` is gitignored, so a task worktree never carries a generated proposal —
only the edits file and this doc are tracked. `CLAUDE.md` changes only when the user runs
`learn.mjs apply <diff>`, which also appends the applied-proposal ledger line described above. `CLAUDE.md` is
in neither `proposalPaths` nor `protectedPaths`, so `learn.mjs apply` accepts the diff and no hook blocks it;
this command adds no new config surface.
