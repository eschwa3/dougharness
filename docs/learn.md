# Learn: proposals from outcomes and lessons

Reference for `plugins/doug-flow/scripts/learn.mjs` and `lib/learn.mjs` (card `learn-signals`): deterministic,
log-then-propose harness self-improvement. Nothing here calls an LLM or the network, and nothing here ever
changes a tracked file on its own - `learn.mjs propose` only ever writes under `.doug/.state/learn/`;
`learn.mjs apply` is the one command that ever touches the checkout, and only for one proposal the caller
names. The `doug-learn` skill is the only caller that ever runs `apply`, and only after asking the user.

## Signals

`learn.mjs signals [dir] [--json]` collects three groups, each counted from what already happened - nothing is
estimated or inferred:

**outcomes** (`plugins/doug-flow/lib/memory.mjs`'s outcomes table, both tracks):
- `gateFailures`: a flow-track row with `verified === 0`, or a hand-track row whose `gate` text does not start
  with `"typecheck 0"`.
- `blocksByClass`: every row's `blocks[].class` (`real`/`marginal`/`false`) tallied across all rows.
- `fixPasses`: `{ sum, max }` over every row's `fix_passes` (flow-track only; null on hand rows).
- `usd`: `{ sum, n }` over every row's `usd` that is a number (`n` is the row count, so `sum / n` is the mean).
- `byCard`: `{ rows, gateFailures, usd }` per card, for a human reading the summary.

**lessons** (the lessons table): `total` (every row, superseded included), `live` (not superseded), `helpful`
(live rows with `helpful > 0`), `harmful` (live rows with `harmful > 0`), `stale` (live rows with `stale` set),
and `repeated`: live lessons grouped by near-duplicate text (`memory.mjs`'s own `jaccard` and
`REFLECT_DUPLICATE_JACCARD` = 0.6 - the same threshold `memory.mjs reflect` uses to bump a lesson instead of
appending one) into clusters of >= 2, plus any lesson on its own with `helpful >= 3`. Both paths report a
`count` of at least 2, so a proposal can treat `count >= 2` as one test regardless of which path produced it.

**trace** (every `.jsonl` file under `.doug/.state/trace/`, or `traceDir` when given): `files` (the file list),
`denials`, `unmatched`, `skills` (skill invocations - a `PreToolUse` line whose `tool` is `Skill`, counted by
its `detail`, which is the skill name since card `learn-signals` added `skill` to `detailOf`'s key list), and
`instructionsLoaded` (see below).

**Denials** are the actual denial signal, and the only trace signal `demote` reads: an explicit
`PermissionDenied` trace line, grouped by `(tool, detail)` into `{ tool, detail, reason, count }`. A denied
call's `PreToolUse` line (denied calls never run, so it never gets a matching `PostToolUse`) is never
double-counted here - see `unmatched` below, and review card `learn-signals` review round 2, MAJOR 1, which
found a single denied Bash call reading as 2 and tripping `demote` on its own before this was fixed.

**Unmatched** (`{ tool, detail, count }`, no `reason`) is a separate, weaker signal: a `PreToolUse` line whose
`toolUseId` never gets a matching `PostToolUse` in the same file, excluding one that the file's own
`PermissionDenied` line already accounts for (that call is in `denials`, not here too), `Agent`/
`AskUserQuestion`/`Skill` calls (they route through their own gates, not a plain allow/deny), and the very last
line of a file (that call may simply still be in flight when the trace stopped). **This is reported for a human
reader only and never drives a proposal** - `demote` reads `denials`, never `unmatched`. Review round 2, MINOR
1: on this repository's 36 real trace files, the gap heuristic alone produced 246 "denials" that were
`Artifact`, `StructuredOutput`, and ordinary successful `grep`/`ls`/`cat` calls - a hook timeout, an interrupted
call, a session ending mid-call, or simply a tool whose `PostToolUse` never fires are all real, non-denial
reasons a `PreToolUse` line can go unmatched, which is why this can only ever be shown to a person, never acted
on automatically.

**InstructionsLoaded** is recorded path-only: `detail` is the loaded file's path, `reason` its `load_reason`
(`session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`) - `file_content` is never read
off the hook input, so it can never reach the trace line or this signal. The event and its payload are
documented at
[code.claude.com/docs/en/hooks-guide.md](https://code.claude.com/docs/en/hooks-guide.md) (lifecycle table) and
[code.claude.com/docs/en/hooks.md](https://code.claude.com/docs/en/hooks.md) (input schema); the Claude Code
version that introduced it is not documented, so the trace hook registers the event and tolerates its absence
rather than checking a version (`.doug/.state/research/learn-signals.md`). `PermissionDenied`'s documented
payload (`tool_name`, `tool_input`, `tool_use_id`, `denial_reason`) is fired by auto mode; **whether a manual
deny in the permission prompt, or a hook's own deny, also fires `PermissionDenied` is unverified** - the
research note (`.doug/.state/research/learn-signals.md`) marks it explicitly, which is why `unmatched` exists
alongside `denials` rather than folded into it: a real denial this repository's `PermissionDenied` payload
happens not to cover would otherwise go uncounted rather than merely unproposed.

## Proposals

`learn.mjs propose [dir] [--json]` collects signals, then renders each candidate change as
`{ id, kind, target, reason, evidence, diff }`, `diff` a unified diff against the target file's current
content (or `null` when there is nothing to diff - a limit hit, or a text-only finding). Every proposal's
`evidence` carries the concrete numbers it was derived from. Four kinds:

- **promote**: a repeated lesson (`count >= 2`) of kind `feedback` or `pitfall`, whose text is not already in
  CLAUDE.md (whitespace-normalised, case-folded substring match), becomes one `- ` bullet added under
  `## Working agreement` (feedback) or `## Gotchas` (pitfall). Refused with `diff: null` when the result would
  put CLAUDE.md at or over its own 60-line limit (the file's header already asks for under 60).
- **demote**: a Bash denial repeated `count >= 2` whose `detail` matches one of a small fixed table of known
  CLAUDE.md rules (see `DEMOTE_RULES` in `lib/learn.mjs`: the branch `-D` rule, the raw `pnpm test` rule, the
  commit-trailer rule) becomes a diff to `.doug/config.json` enabling that rule's config key, when the exact
  phrase is really present in CLAUDE.md and the key is not already set. `.doug/config.json` is a protected
  path, so this diff can never be applied by `learn.mjs apply` - the proposal says so, and applying it is
  always a by-hand edit.
- **delete**: a CLAUDE.md `- ` rule line under Working agreement or Gotchas that no denial's `detail`, no
  repeated lesson's text, and no adversary block's `description` shares a key phrase with (the rule's
  backticked tokens, plus its first 4 significant words - a documented heuristic, not a semantic match: a rule
  paraphrased with none of those tokens is missed, which only ever makes `delete` too cautious, never too
  eager) becomes a diff removing that line. Only proposed once there are at least 10 outcome rows and at least
  5 trace files to trust the absence.
- **tighten**: a skill (every `plugins/doug-flow/skills/*/SKILL.md` `learn.mjs`'s own `readOwnSkills` reads)
  invoked 0 times across the trace while another skill was invoked >= 5 times, whose frontmatter `description`
  is longer than 400 characters, surfaces as a `diff: null` proposal naming the skill and the counts - writing
  a tighter description is judgment work for the user or a later card, not this one. `target` is the real path
  `readOwnSkills` read that skill from, made relative to `dir` when it is really inside `dir` and left absolute
  otherwise - never a hardcoded `plugins/doug-flow/skills/<name>/SKILL.md` guess (review round 2, MINOR 7).

## The state directory and apply

`learn.mjs propose` writes `.doug/.state/learn/<YYYY-MM-DDTHHMMSSmmm>/proposals.json` (millisecond resolution,
review round 2 MINOR 5 - two runs inside the same second used to collide and overwrite each other's proposals;
a folder name already on disk, millisecond collision included, gets `-2`, `-3`, ... appended until one is
free) - every proposal, including `diff: null` ones, plus one `NN-<kind>.diff` per proposal that carries a
diff - never a tracked file. `learn.mjs apply <proposal-file> [dir]` is the only command that ever runs
`git apply`, and only for the one file named: it parses every `+++ b/` and `--- a/` header in the diff (review
round 2 MINOR 2 - reading only the first header let a hand-built two-file diff carry an unrefused second target
past the check, writing straight into the protected `.doug/config.json`) and refuses (`{ ok: false, reason }`,
exit 1) when the diff names more than one file (a proposal is single-file, refused outright before any target
is even checked), when its one target resolves outside the repository, when that target is under
`.doug/config.json`'s `protectedPaths`, or when `git apply --check` fails (the diff no longer applies cleanly -
the target changed since `propose` ran). It is never called by `propose`, and the `doug-learn` skill is the
only thing that calls it, one proposal at a time, only after `AskUserQuestion` says yes to that proposal.

`learn.mjs apply` is also how `lib/decisions.mjs`'s decision/rule proposals (card `memory-decisions`, see
[docs/memory.md](memory.md#decisions-and-rules-the-proposal-path)) are applied — `docs/decisions/` and
`.claude/rules/` are proposal-only paths for the same reason `learn.mjs propose`'s own targets are never applied
automatically. Every successful apply, from either source, appends one line to the applied-proposal ledger,
`.doug/.state/proposals/applied.jsonl` (`{ target, sha256, diffSha256, at, proposal }`, where `proposal` is the
diff file's path relative to the project, under `.doug/.state/learn/`), which the Stop gate reads to tell an
approved write to a proposal-only path from a hand edit.

## Out of scope

Before/after evals per proposal (card `learn-proposal-evals`); any LLM-written proposal text; scheduling;
changing `doug init`'s generated settings.

See also [docs/memory.md](memory.md) for the outcomes and lessons store `learn.mjs` reads from.
