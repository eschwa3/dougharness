#!/usr/bin/env node
// CLI for the outcome log and lessons store (card memory-lib), on top of lib/memory.mjs. node:sqlite is loaded
// lazily, only once a subcommand needs it, so a Node without it (<22.16) prints the lib's one clear error and
// exits 1 instead of a stack trace.
//   memory.mjs record <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>]
//                      [--adversary "<id>=<class>[: <reason>]"]... [--claude-dir <path>] [--json]
//                                                 append one outcomes row per task in the report (upsert on
//                                                 run+task); with --run, per-task tokens and USD come from the
//                                                 same local transcripts lib/cost.mjs reads (null, with a note on
//                                                 stderr, when the run's journal cannot be found)
//   memory.mjs record <card-id> --hand [dir] --commit <sha> [--wall <text>] [--gate <text>] [--note <text>] [--cost <usd>] [--json]
//                                                 record a hand-track landing (card id, commit, wall clock, gate
//                                                 line, note; nothing else is invented) as one outcomes row keyed
//                                                 hand:<commit> (upsert on the same commit); --commit is required;
//                                                 --run, --adversary, --claude-dir, and a report path are not
//                                                 accepted with --hand. Reads
//                                                 .doug/.state/reports/<card-id>/condition.json (card
//                                                 outcomes-condition-columns) when present and fills the seven
//                                                 condition columns from it; without one the row still records
//                                                 (exit 0) and an extra stdout line says the landing is
//                                                 unstamped (--json: "stamped": true|false instead)
//   memory.mjs record <card-id> --hand --stop <reason> [dir] [--detail <text>] [--json]
//                                                 record a stopped by-hand run as exactly one stop row (run
//                                                 stop:<12 hex>, commit null, stop_class <reason>, stop_reason
//                                                 --detail or the reason); the same stop recorded again updates
//                                                 that row. Condition columns and memory_config come from
//                                                 condition.json when present, else the row is unstamped (extra
//                                                 stdout line; --json: "stamped": false). --stop with no value
//                                                 or with --commit exits 2 and writes nothing
//   memory.mjs condition open <card-id> [dir] [--json]
//                                                 (card outcomes-condition-columns) writes
//                                                 .doug/.state/reports/<card-id>/condition.json: harnessCommit
//                                                 (git HEAD), configHash (conditionConfigHash: .doug/config.json
//                                                 plus the CLAUDE.md Models table text), class and arm
//                                                 (<class>/default) from the card's board record, assignedBy
//                                                 "policy", exploreProbability null, openedAt, memoryConfig (card
//                                                 memory-outcome-arms: memoryConfig() from the project's
//                                                 embeddings config and staleDays, track "hand": delivery
//                                                 index+fetch; a flow row from `record <report.json>` is
//                                                 stamped with track "flow": delivery index+fetch, fetch top-k,
//                                                 fetchTokens 4000). Refuses (exit 1,
//                                                 nothing written) when the file already exists, the card is
//                                                 missing or has no class, or there is no git HEAD
//   memory.mjs condition backfill [dir] [--json]
//                                                 (card outcomes-condition-columns) for every outcomes row with
//                                                 harness_commit null: sets harness_commit to the last commit at
//                                                 or before the row's recorded timestamp (git log --before,
//                                                 first-parent on main), class from the row's card on the board
//                                                 when it has one, backfilled 1; leaves a row untouched (and
//                                                 uncounted) when git finds no such commit; idempotent (a second
//                                                 run finds nothing left to stamp). Prints "Backfilled <n>
//                                                 outcomes rows with a harness commit." (--json: {"backfilled": n})
//   memory.mjs outcomes [dir] [--run <id>] [--task <id>] [--json]
//                                                 list recorded outcomes, filtered by run and/or task
//   memory.mjs arms [dir] [--min <n>] [--json]
//                                                 (card memory-outcome-arms) compares outcome arms by the memory
//                                                 configuration stamped on each row (outcomes.memory_config):
//                                                 landings, stops, then stop-or-land rate, fix rounds, harmful
//                                                 marks per landing and cost per landing once an arm has --min
//                                                 landings (default 12; an integer >= 1), else "not compared: <n>
//                                                 of <min> landings"; a last line says whether two arms are
//                                                 comparable. Reads existing rows only: no database -> "No
//                                                 outcomes recorded." (exit 0, database not created); no claude
//                                                 call, no network request
//   memory.mjs lessons [dir] [--search <text>] [--k <n>] [--all] [--json]
//                                                 list lessons, or full-text search them (--search); --all
//                                                 includes superseded rows
//   memory.mjs lessons --unconfirmed [dir] [--json]
//                                                 read-only review list: live lessons with helpful 0, harmful 0
//                                                 and no `lesson show --card` fetch; id, kind, created, title
//   memory.mjs lesson add --text <text> --kind <feedback|project|pitfall|pattern> [dir]
//                          [--scope <glob,glob>] [--citation <text>] [--card <id>]
//                          [--commit <sha>] [--source-agent <name>] [--source-model <name>] [--json]
//                                                 add a lesson directly (card out-of-workflow-access): the
//                                                 markdown auto-memory roundtrip can only produce kind feedback
//                                                 or project, never pitfall or pattern. --source-agent defaults
//                                                 to "lead" and REFUSES "auto-memory", which is the import's own
//                                                 namespace (memory-import.mjs looks up the file name under the
//                                                 auto-memory dir plus source_agent "auto-memory" to decide what
//                                                 to supersede); a hand-authored lesson must never claim it. Not
//                                                 the "lessons" listing subcommand above.
//   memory.mjs import [dir] [--claude-dir <path>] [--json]
//                                                 read Claude Code auto memory (~/.claude/projects/<slug>/memory)
//                                                 idempotently into lessons (source auto-memory); never writes
//                                                 anything under the auto-memory directory
//   memory.mjs lesson unstale <id> [dir] [--json]
//                                                 clear a lesson's stale mark (set by recall's citation
//                                                 re-check) so it is a candidate again; refuses on an unknown id
//   memory.mjs lesson unarchive <id> [dir] [--json]
//                                                 restore an archived lesson (clears archived and
//                                                 archived_reason); refuses on an unknown or non-archived id
//   memory.mjs lesson show <id> [dir] [--card <card-id>] [--json]
//                                                 (card memory-progressive-access) one lesson in full: cost
//                                                 line, citation line, superseded/stale status when set, a
//                                                 blank line, then the whole text, never cut. Read-only unless
//                                                 --card <card-id> (a plain id, else exit 2): then, after the
//                                                 lesson is found and printed, one JSON line {id, at} is
//                                                 appended to .doug/.state/reports/<card-id>/fetched.jsonl
//                                                 (reflect --hand credits only those). No
//                                                 store or unknown id -> one stderr line, exit 1 (nothing
//                                                 created); no id -> usage, exit 2. --json: the row with
//                                                 hasVector and tokens instead of the embedding blob
//   memory.mjs history show <ref> [dir] [--json]
//                                                 (card memory-progressive-access) fetch run history (L0) by
//                                                 id: <card> lists its runs, <card>/<run> lists the run's
//                                                 entries with token costs, <card>/<run>:<line> prints one
//                                                 entry whole (a leading history: and a .jsonl suffix are
//                                                 accepted). Needs no memory database; bad id -> exit 2,
//                                                 missing -> one stderr line, exit 1
//   memory.mjs brief-lessons <card-id> [dir] [--k <n>] [--json]
//                                                 (card memory-every-session) recall for a hand-track card's
//                                                 briefs: query = the card's title and goal, k 8. Prints the
//                                                 workflow's lessons header, the index `- [id] title (kind,
//                                                 ~n tokens)` lines (capped at 2000 chars; the lead fetches
//                                                 full text with `lesson show`), an `index: omitted` line
//                                                 naming lessons the cap dropped, then the window line
//                                                 when lessons were hidden, then `memoryUsed: <ids>`;
//                                                 writes .doug/.state/reports/<card-id>/lessons.json. No database
//                                                 -> "No lessons recalled for <id>." (database not created);
//                                                 a database or provider error -> one stderr line, exit 0;
//                                                 unknown card -> exit 1
//   memory.mjs recall <query> [dir] [--files <glob,glob>] [--k <n>] [--json]
//                                                 dense recall (card memory-recall): with a provider and
//                                                 stored vectors, every live lesson is ranked by cosine x
//                                                 recency weight x scope boost (--files), ties by lesson id,
//                                                 then BM25 hits with no vector are appended in BM25 order;
//                                                 without a provider or vectors the ranking is BM25 x recency
//                                                 x scope, a keyword-only fallback that says so. Each returned
//                                                 lesson's citation is re-checked against [dir] only when
//                                                 [dir] is a real project root (contains .doug)
//   memory.mjs reflect <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>]
//                       [--adversary "<id>=<class>[: <reason>]"]... [--harmful <id>]... [--claude-bin <path>] [--claude-dir <path>]
//                       [--model <name>] [--max-usd <n>] [--dry-run] [--json]
//                                                 runs after record: applies deterministic helpful/harmful
//                                                 counters to lessons named in each task's memoryUsed (committed
//                                                 even if the LLM pass below fails; a real block alone bumps no
//                                                 harmful: each --harmful <id>, a recalled lesson that misled the
//                                                 work, gets harmful +1 and no helpful; an id outside every
//                                                 task's memoryUsed exits 1 before any write), then a cheap-row `claude -p
//                                                 --json-schema` pass proposes at most 3 lessons from the report,
//                                                 filtered in code (a pitfall needs a block classed real, a
//                                                 pattern needs a first-pass verified task, the citation must be
//                                                 checkable, the text must not already be derivable from the
//                                                 checkout, and a proposal may name one listed lesson
//                                                 it repeats (that lesson's seen rises, nothing is appended) or
//                                                 supersedes (the new lesson is written and the old retired); a
//                                                 near-duplicate with neither is rejected); idempotent on the report's
//                                                 sha256 (a second reflect on the same report is a no-op, exit
//                                                 0); --dry-run applies nothing, makes no model call, and
//                                                 prints the counters it would credit and the prompt it would send. Cost is measured from the same local
//                                                 transcripts cost.mjs reads, falling back to the CLI's own
//                                                 cost estimate. For each appended lesson with no CLAUDE.md home
//                                                 it prints `claude-md candidate for lesson <id>: <command>`
//                                                 (edits file under .doug/.state/learn/claude-md-candidates/,
//                                                 nothing under --dry-run) or `... dropped: <reason>`; --json
//                                                 carries claudeMd and claudeMdDropped. Needs Node >=22.16 (node:sqlite).
//   memory.mjs reflect --hand <card-id> [dir] --commit <sha> [--rounds <n>] [--review "<R<n> or <card-id>/R<n>>=<class>[: <reason>]"]...
//                       [--harmful <id>]... [--note <text>] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--dry-run] [--json]
//                                                 (card memory-every-session) the same pass for a hand landing:
//                                                 assembles .doug/.state/reports/<card-id>/hand-report.json from
//                                                 the saved briefs/, reviews/ and lessons.json (memoryUsed = its
//                                                 ids that the card's fetched.jsonl lists; verified true; passes = --rounds, default 1; one fixed
//                                                 blocker ledger entry per --review id), then reflects on it
//                                                 exactly as above. --commit is required (exit 2). No schema change.
//   memory.mjs reflect --failures <card-id> [dir] [--session <id>] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--detach] [--dry-run] [--json]
//                                                 (card memory-failure-lessons) the failure pass: reads the card's
//                                                 run history for stopped reports, blocks classed real and
//                                                 denials, prints the item count with the blocks it hid by class
//                                                 and the entries it could not read, then a cheap-row pass proposes
//                                                 pitfall lessons citing a history ref of one item; a proposal's
//                                                 `repeats` names a live pitfall and records an occurrence in
//                                                 .doug/.state/memory/pitfalls.jsonl (no new lesson, no helpful).
//                                                 Exclusive with --hand and a report path (exit 2); idempotent on
//                                                 the slice; --dry-run makes no model call and prints the prompt it would send;
//                                                 --detach runs it as job failures-<card>; autopilot and doug-hand start it
//                                                 so when a card stops, --max-usd 0.5 on the cheap row (user, 2026-10-28).
//                                                 A real block with the same class on a file a live pitfall's recorded
//                                                 occurrence names is a code-side repeat (via 'file'); empty files never match
//   memory.mjs ideas [dir] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--cap <n>] [--dry-run] [--json]
//                                                 (card memory-idea-proposals, ADR 0019 L3) one cheap-row `claude
//                                                 -p --json-schema` call (--max-usd default 0.5) over the live
//                                                 lessons, run history, pitfall occurrences and the Backlog and
//                                                 Ready cards files at most --cap (default 3) idea cards to
//                                                 Backlog only, source `memory-proposed: <citations>`, and appends
//                                                 priority reviews naming Backlog cards to
//                                                 .doug/.state/memory/priority-reviews.jsonl. An item with an
//                                                 unresolved citation is dropped; a duplicate or invalid idea is
//                                                 skipped. Never touches Ready. No store or no board exits 1 with
//                                                 no call; a failed call exits 1 and writes nothing. --dry-run
//                                                 makes no model call, writes neither file and prints the prompt
//                                                 it would send and the files it would write
//   memory.mjs model regen [dir] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--dry-run] [--json]
//                                                 (card memory-project-model, ADR 0019 L2) one cheap-row `claude
//                                                 -p --json-schema` call (--max-usd default 0.5) over the live
//                                                 lessons and the run-history index writes .doug/project-model.md:
//                                                 failure patterns, conventions and open risks, at most 2000
//                                                 characters in all. A statement with any citation that does not
//                                                 resolve in code (a live lesson id, or a run-history ref whose
//                                                 file and line exist) is dropped whole; over the cap the most
//                                                 cited statements stay. Prints one line with the counts, the
//                                                 drops and the cost. A failed call or zero surviving statements
//                                                 exits 1 and leaves an existing file untouched; no store exits 1
//                                                 with no call. --dry-run makes no model call, writes nothing and prints the prompt
//   memory.mjs model show [dir]
//                                                 prints .doug/project-model.md verbatim, read-only; missing ->
//                                                 one stderr line, exit 1
//   memory.mjs doctor [dir] [--json]
//                                                 probe the configured embedding provider (memory.embeddings in
//                                                 .doug/config.json), or a local Ollama at localhost:11434 when
//                                                 nothing is configured; print what was found, the model it
//                                                 would use, and the one command to install what is missing
//   memory.mjs reembed [dir] [--batch <n>] [--check] [--no-check] [--pairs <file>] [--json]
//                                                 (re)embed every lesson not yet embedded under the configured
//                                                 provider's model/dims, in batches (progress on stderr);
//                                                 refuses with a clear line when no provider is configured or
//                                                 when --batch is not an integer >= 1. Runs the embed-check
//                                                 cosine sanity check first whenever the store holds no lesson
//                                                 embedded under the configured model/dims while at least one
//                                                 lesson exists (a model/dims change, including the first embed
//                                                 ever); on a failed check it embeds nothing and exits 1.
//                                                 --check forces the check on any reembed; --no-check skips it
//                                                 (prints one stderr line) for a deliberately non-semantic test
//                                                 double
//   memory.mjs index build  [dir] [--batch <n>] [--check] [--no-check] [--pairs <file>] [--json]
//                                                 (card semantic-index) incrementally (re)build the opt-in
//                                                 semantic code index: hash every git-tracked, indexable file,
//                                                 re-chunk and re-embed only what changed, drop rows for files no
//                                                 longer indexable. With a provider configured, embeds pending
//                                                 chunks in batches (progress on stderr like reembed), running
//                                                 the embed-check cosine sanity check first on a model/dims pair
//                                                 the index has never used (--check/--no-check/--pairs identical
//                                                 to reembed); unlike reembed, a down provider or a failed check
//                                                 never makes build exit nonzero (exit 0, keyword-only, reason in
//                                                 the line) - only a non-git dir or a database problem does
//   memory.mjs index status [dir] [--json]
//                                                 the index's size (files, chunks, text bytes, database bytes,
//                                                 how many chunks are embedded under the configured provider) and
//                                                 its refresh cost (files added/changed/removed and exactly how
//                                                 many chunks the next build would embed, estimated seconds from
//                                                 the last build's measured rate); never built is not an error
//   memory.mjs index search <query> [dir] [--files <glob,glob>] [--k <n>] [--json]
//                                                 hybrid search over the code index (card semantic-index): BM25
//                                                 over FTS5 fused by reciprocal rank fusion with cosine over
//                                                 stored vectors when a provider is configured and vectors exist
//                                                 for it; --files (comma-separated globs) restricts candidates by
//                                                 path; keyword-only, and says so, with no provider or no vectors
//   memory.mjs embed-check [dir] [--pairs <file>] [--json]
//                                                 cosine sanity check (card memory-measure): embeds the dozen
//                                                 paraphrase and dozen unrelated lesson pairs in
//                                                 plugins/doug-flow/lib/data/pairs.json (or --pairs) against the
//                                                 configured provider and
//                                                 confirms paraphrases score higher than unrelated pairs by the
//                                                 file's stated margin; exit 0 ok, 1 on a failed check or an
//                                                 unreachable/unconfigured provider, 2 on usage; refuses when
//                                                 the pairs file is missing
//   memory.mjs decision propose --title <text> --file <path> [--date YYYY-MM-DD] [dir] [--json]
//                                                 (card memory-decisions) proposes a new ADR at
//                                                 docs/decisions/<NNNN>-<slug>.md as a diff under
//                                                 .doug/.state/learn/ (never a tracked file); refuses when the
//                                                 target already exists or --title/--file is empty. --file -
//                                                 reads the body from stdin. Approve and write it with
//                                                 `learn.mjs apply <diff>` - docs/decisions/ is a proposal-only
//                                                 path (proposalPaths in .doug/config.json), refused by every
//                                                 other tool
//   memory.mjs decision amend <NNNN> (--text <text> | --file <path>) [--date YYYY-MM-DD] [dir] [--json]
//                                                 proposes appending a dated "## Amendment" section to the one
//                                                 existing docs/decisions/<NNNN>-*.md; refuses when none or
//                                                 several ADRs match <NNNN>, or the text is empty
//   memory.mjs rule propose <name> --file <path> [--paths <glob,glob>] [dir] [--json]
//                                                 proposes creating or replacing .claude/rules/<name>.md (also
//                                                 proposal-only); with --paths the rule's frontmatter scopes it
//                                                 to those globs (loads only when a matching file is read), with
//                                                 none it loads unconditionally at session start (Claude Code's
//                                                 own `paths:` contract - see docs/memory.md)
//   memory.mjs claude-md propose --file <path|-> [dir] [--json]
//                                                 proposes a diff to CLAUDE.md from an edits JSON file/stdin of
//                                                 source-cited adds/removes ({ add: [{heading,line,source}],
//                                                 remove: [{line,enforcedBy,source}], note }); writes only a diff
//                                                 under .doug/.state/learn/, never CLAUDE.md itself; refuses when
//                                                 an edit would touch the Models section or the fenced Commands
//                                                 block, or would push CLAUDE.md over 200 lines. Approve and write
//                                                 it with `learn.mjs apply <diff>`
// lesson add and import embed only the row(s) they just wrote, best-effort, when a provider is configured: a
// provider failure prints one stderr line and never turns into a nonzero exit for that add/import. A pending
// row from an earlier add is left alone until `reembed` (or a later add/import) picks it up.
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, appendFileSync, statSync, openSync, closeSync, renameSync, linkSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { parseAdversaryClasses, loadBoard, saveBoard, findCard } from "../lib/board.mjs";
import { planFor, unwrapReport } from "../lib/plan.mjs";
import { costRun } from "../lib/cost.mjs";
import { loadModels } from "../lib/models.mjs";
import {
  readMemoryConfig,
  readMemoryStaleDays,
  readIndexConfig,
  createProvider,
  probeProvider,
  doctorReport,
  checkEmbeddingSanity,
  loadSanityPairs,
  DEFAULT_SANITY_PAIRS,
} from "../lib/embeddings.mjs";

const argv = process.argv.slice(2);
const FLAGS = new Set(["json", "all", "hand", "dry-run", "check", "no-check", "unconfirmed", "detach", "earlier"]);
const REPEATABLE = new Set(["adversary", "review", "harmful"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) {
    positional.push(argv[i]);
    continue;
  }
  const name = argv[i].slice(2);
  if (FLAGS.has(name)) {
    opts[name] = true;
    continue;
  }
  if (REPEATABLE.has(name)) (opts[name] ||= []).push(argv[i + 1] ?? "");
  else opts[name] = argv[i + 1] ?? "";
  i++;
}
const [cmd, ...rest] = positional;

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

// Card detach-background-chores: start `reflect` (or any command) as a detached job and read it later with
// `memory.mjs job <name>`. State lives in <dir>/.doug/.state/jobs/<name>.json (pid, argv, startedAt, and on exit
// exitCode/signal/endedAt, written by the runner); stdout and stderr go to <name>.log, never to the caller's
// pipes, so the caller returns at once.
function jobPaths(dir, name) {
  const jobs = join(dir, ".doug", ".state", "jobs");
  return { jobs, file: join(jobs, `${name}.json`), log: join(jobs, `${name}.log`) };
}

function readJobFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")) || {};
  } catch {
    return null;
  }
}

// A job file is replaced whole (write a temp file, rename it over), so a concurrent reader never sees a truncated
// file. `ifAbsent` links the temp file in instead, so the start command never overwrites a result the runner wrote
// (startDetachedJob removes an ended job's old file first, so the new start record is linked in fresh).
function writeJobFile(file, state, ifAbsent = false) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    if (ifAbsent) linkSync(tmp, file);
    else renameSync(tmp, file);
  } catch (err) {
    if (!ifAbsent || !err || err.code !== "EEXIST") throw err;
  } finally {
    if (ifAbsent) {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
}

function startDetachedJob(dir, name, command) {
  const { jobs, file, log } = jobPaths(dir, name);
  mkdirSync(jobs, { recursive: true });
  // A name is reusable once its job ended or its process is gone; a live job holding it is never touched.
  const held = readJobFile(file);
  if (held && held.endedAt === undefined && held.exitCode === undefined && !held.signal && pidAlive(held.pid)) {
    fail(`job ${name} is already running (pid ${held.pid}); read it with: memory.mjs job ${name}`, 1);
  }
  try {
    unlinkSync(file);
  } catch {}
  const fd = openSync(log, "w");
  const startedAt = new Date().toISOString();
  let child;
  try {
    child = spawn(process.execPath, [process.argv[1], "__jobrun", dir, name, "--", ...command], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  writeJobFile(file, { name, argv: command, pid: child.pid, startedAt }, true);
  return { name, pid: child.pid };
}

// The detached runner: runs `command` with the log as its stdout/stderr, then records how it ended.
async function runJob(dir, name, command) {
  const { file } = jobPaths(dir, name);
  // Only this runner's own start record (same pid) lends startedAt and argv; nothing else carries over.
  const prior = readJobFile(file) || {};
  const own = prior.pid === process.pid;
  const state = { name, argv: own && prior.argv ? prior.argv : command, startedAt: own && prior.startedAt ? prior.startedAt : new Date().toISOString(), pid: process.pid };
  writeJobFile(file, state);
  const end = await new Promise((resolveEnd) => {
    const c = spawn(command[0], command.slice(1), { stdio: "inherit", cwd: process.cwd(), env: process.env });
    c.on("error", (err) => {
      process.stderr.write(`job: cannot start ${command[0]}: ${err.message}\n`);
      resolveEnd({ exitCode: 127, signal: null });
    });
    c.on("close", (code, signal) => resolveEnd({ exitCode: code, signal }));
  });
  const done = { ...state, exitCode: end.exitCode, signal: end.signal, endedAt: new Date().toISOString() };
  writeJobFile(file, done);
}

// One job's state as { state: "pending"|"done"|"failed", line, st }; null when there is no job file.
function jobStatus(dir, name) {
  const { file, log } = jobPaths(dir, name);
  const st = readJobFile(file);
  if (!st) return null;
  let lines = [];
  try {
    lines = readFileSync(log, "utf8").split("\n");
  } catch {
    lines = [];
  }
  const ended = st.endedAt !== undefined || st.exitCode !== undefined || st.signal;
  const lastLine = () => lines.map((l) => l.trim()).filter(Boolean).slice(-1)[0] || "";
  if (!ended) {
    if (pidAlive(st.pid)) return { state: "pending", line: `${name}: pending (started ${st.startedAt}, pid ${st.pid})`, st };
    return { state: "failed", line: `${name}: failed (the job process ${st.pid} is gone and wrote no result)${lastLine() ? `; last output: ${lastLine()}` : ""}`, st };
  }
  if (st.exitCode === 0 && !st.signal) {
    const secs = st.endedAt && st.startedAt ? Math.max(0, Math.round((Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000)) : null;
    return { state: "done", line: `${jobSummaryLine(lines)}${secs === null ? "" : ` (job ${name}, ${secs} s)`}`, st };
  }
  return { state: "failed", line: `${name}: failed (${st.signal ? `signal ${st.signal}` : `exit ${st.exitCode}`})${lastLine() ? `: ${lastLine()}` : ""}`, st };
}

// Mark a finished job as read, so a later landing's `job --earlier` does not report it again.
function markJobReported(dir, name, st) {
  try {
    writeJobFile(jobPaths(dir, name).file, { ...st, reportedAt: new Date().toISOString() });
  } catch {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === "EPERM";
  }
}

function jobSummaryLine(lines) {
  const nonEmpty = lines.filter((l) => l.trim());
  const reflected = nonEmpty.filter((l) => /(?:^|\) )(?:Reflected on |Already reflected on )/.test(l));
  if (reflected.length) return reflected[reflected.length - 1];
  const flush = nonEmpty.filter((l) => !/^\s/.test(l));
  return (flush.length ? flush : nonEmpty).slice(-1)[0] || "";
}

function dirFrom(args, n) {
  const d = resolve(process.env.CLAUDE_PROJECT_DIR || args[n] || process.cwd());
  if (!existsSync(join(d, ".doug"))) fail(`not a Doug project: ${d} has no .doug/`, 1);
  return d;
}

function verifiedWord(v) {
  return v === 1 ? "yes" : v === 0 ? "no" : "?";
}

function partialWord(v) {
  return v === 1 ? "yes" : "no";
}

function tokensText(tokens) {
  if (tokens === null || tokens === undefined) return "null";
  if (typeof tokens.input === "number" && typeof tokens.output === "number") return `${tokens.input}/${tokens.output}`;
  if (typeof tokens.total === "number") return `${tokens.total}`;
  return "null";
}

function usdText(usd) {
  return typeof usd === "number" ? usd.toFixed(2) : "null";
}

function commitText(sha) {
  return sha ? String(sha).slice(0, 7) : "none";
}

// An empty or whitespace-only flag value (a flag given with no following value parses as "") is not text; store
// null instead of the empty string.
function textOrNull(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() ? value : null;
}

// Embeds exactly the given lesson ids (the row(s) this add/import just wrote), best-effort: no provider
// configured is silent; a provider failure is one stderr line. Deliberately scoped to `ids`, not the whole
// backlog — `reembed` is the command for catching up rows an earlier add/import left pending.
//
// (reviewer MAJOR 1, card memory-measure) Never the first commit to a new model/dims pair: when the store has
// no active lesson embedded under the configured model/dims yet (embeddingChangeDetected — the same rule
// `reembed` uses to decide whether to run its cosine sanity check), this leaves the row(s) pending instead of
// embedding them, so a plain `lesson add`/`import` can never quietly establish a bad model/dims pair as
// "already in use" and skip `reembed`'s check on the next run — only `reembed`, past that check, may commit a
// store to a model/dims it has never used before.
async function bestEffortEmbed(m, dir, ids) {
  if (!ids || !ids.length) return;
  const provider = createProvider(readMemoryConfig(dir));
  if (!provider) return;
  const { LIVE_LESSON_SQL } = await import("../lib/memory.mjs");
  if (embeddingChangeDetected(m, provider, LIVE_LESSON_SQL)) {
    process.stderr.write(
      `Note: ${provider.model}/${provider.dims} is new to this store; leaving ${ids.length} lesson(s) pending. Run \`memory.mjs reembed\` first — it runs the cosine sanity check before this store commits to a new model.\n`
    );
    return;
  }
  const { getLesson, setLessonEmbedding } = await import("../lib/memory.mjs");
  const rows = ids.map((id) => getLesson(m, id)).filter(Boolean);
  if (!rows.length) return;
  const result = await provider.embed(
    rows.map((r) => r.text),
    { inputType: "document" }
  );
  if (!result.ok) {
    process.stderr.write(`Note: embedding with ${provider.model}/${provider.dims} failed for ${rows.length} lesson(s): ${result.reason}\n`);
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    setLessonEmbedding(m, rows[i].id, { model: provider.model, dims: provider.dims, vector: result.vectors[i] });
  }
}

// `claude -p --output-format json` is documented to print one JSON object, but in practice a notice or warning
// line can land before or after it on stdout. Scans for every top-level {...} object (brace-balanced, respecting
// quoted strings and escapes) and parses the LAST one — the one line among many that matters is the JSON
// envelope, and it is always the outermost/last such object claude prints. Throws when none is found or the last
// candidate does not parse.
function parseLastJsonObject(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  if (!candidates.length) throw new Error("no JSON object found in the output");
  return JSON.parse(candidates[candidates.length - 1]);
}

// The real spawn behind reflect's injectable `propose(prompt)`: `claude -p` with the reflect schema, prompt on
// stdin, a 180s timeout, and a 64MB stdout buffer (a report's prompt plus a model's proposals can run long).
// Throws on any failure the spec names (spawn error, timeout, unparseable stdout, is_error, a missing
// structured_output.lessons array) so runReflect's single catch handles every case uniformly.
function makePropose({ claudeBin, model, maxUsd, dir, schema = null, resultKey = "lessons", extraKeys = [] }) {
  return async (prompt) => {
    const { REFLECT_SCHEMA } = await import("../lib/memory.mjs");
    const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema ?? REFLECT_SCHEMA), "--model", model, "--max-budget-usd", String(maxUsd)];
    const res = spawnSync(claudeBin, args, { input: prompt, encoding: "utf8", cwd: dir, timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
    if (res.error) throw new Error(`claude spawn failed: ${res.error.message}`);
    if (res.signal) throw new Error(`claude was killed by signal ${res.signal} (likely the 180s timeout)`);
    if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${(res.stderr || "").trim().slice(0, 500)}`);
    let envelope;
    try {
      envelope = parseLastJsonObject(res.stdout);
    } catch (err) {
      throw new Error(`claude printed no parseable JSON: ${err.message}`);
    }
    if (envelope.is_error) throw new Error(`claude reported is_error${envelope.result ? `: ${envelope.result}` : ""}`);
    const items = envelope.structured_output && envelope.structured_output[resultKey];
    if (!Array.isArray(items)) throw new Error(`claude's structured_output.${resultKey} is missing`);
    return {
      [resultKey]: items,
      ...Object.fromEntries(extraKeys.map((k) => [k, Array.isArray(envelope.structured_output[k]) ? envelope.structured_output[k] : []])),
      sessionId: envelope.session_id || null,
      totalCostUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    };
  };
}

// Four decimals so a cheap-row (haiku) pass, typically a fraction of a cent, never reads as a misleading $0.00.
function costLine(usd, source) {
  return typeof usd === "number" ? `$${usd.toFixed(4)} (${source ?? "none"})` : "cost not measured";
}

function idsList(ids) {
  return ids.length ? ids.join(", ") : "none";
}

function supersededList(pairs) {
  return pairs.length ? pairs.map((p) => `${p.old}->${p.new}`).join(", ") : "none";
}

function reviewIssueCountText(count) {
  return count === null || count === undefined ? "null" : count;
}

function blocksText(blocks) {
  return Array.isArray(blocks) ? blocks.length : "null";
}

// A flow row has no track-specific handling below, so its line is unchanged. A hand row has no review, adversary
// blocks, or verifier (track === "hand"), so those columns print "null" rather than a false zero, and the row
// gains the columns a flow row has no equivalent for: hand (from track), wall <wall_clock>, gate <gate>.
// partial (card worker-context-handoff) prints only when set (1 or 0), right after verified: without this, a
// partial task's "verified no" reads as a verification failure, which the card's goal forbids.
function outcomeLine(row) {
  const adv = row.adversary_verdict ?? "none";
  const parts = [
    row.run,
    row.task,
    `verified ${verifiedWord(row.verified)}`,
    ...(row.partial === 1 || row.partial === 0 ? [`partial ${partialWord(row.partial)}`] : []),
    `review ${reviewIssueCountText(row.review_issue_count)} issue(s)`,
    String(row.run).startsWith("stop:") ? `gate blocks ${blocksText(row.blocks)}` : `adversary ${adv} (${blocksText(row.blocks)} block(s))`,
    `passes ${row.passes ?? "null"}`,
    `tokens ${tokensText(row.tokens)}`,
    `usd ${usdText(row.usd)}`,
    `commit ${commitText(row.commit_sha)}`,
  ];
  if (row.track === "hand") {
    parts.splice(2, 0, "hand");
    parts.push(`wall ${row.wall_clock ?? "null"}`);
    parts.push(`gate ${row.gate ?? "null"}`);
  }
  return parts.join("  ");
}

function lessonLine(row) {
  const suffix = row.superseded_by ? ` (superseded by ${row.superseded_by})` : "";
  return `${row.id}  ${row.kind}  ${row.text}${suffix}`;
}

// One-line (ok) or multi-line (FAILED, one offending pair per line) rendering of a checkEmbeddingSanity()
// result, shared by `embed-check` and `reembed`'s pre-check.
function sanityLine(result) {
  if (result.ok) {
    return (
      `embed-check: ok (gap ${result.gap.toFixed(2)} >= margin ${result.margin}; ` +
      `paraphrase mean ${result.paraphrase.mean.toFixed(2)}, unrelated mean ${result.unrelated.mean.toFixed(2)})`
    );
  }
  const lines = [`embed-check: FAILED (${result.reason})`];
  for (const f of result.failures || []) {
    lines.push(`  ${JSON.stringify(f.pair)}  cosine ${f.cosine.toFixed(4)}`);
  }
  return lines.join("\n");
}

// True when the store holds at least one active (not superseded, not stale) lesson but none of them are
// embedded under provider.model/provider.dims — a model or dims change, including the very first embed ever
// under any model. Mirrors lessonsNeedingEmbedding's WHERE clause in lib/memory.mjs so "no lesson matches"
// means the same thing here as it does there.
function embeddingChangeDetected(m, provider, LIVE_LESSON_SQL) {
  const total = m.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE ${LIVE_LESSON_SQL}`).get().n;
  if (total === 0) return false;
  const matching = m
    .prepare(`SELECT COUNT(*) AS n FROM lessons WHERE ${LIVE_LESSON_SQL} AND embedding_model = ? AND embedding_dims = ?`)
    .get(provider.model, provider.dims).n;
  return matching === 0;
}

// Loads the sanity pairs file for `embed-check`/`reembed`, refusing (never throwing past the outer catch) when
// it is missing so the message always names the path and --pairs.
function loadPairsOrFail(opts) {
  const pairsPath = opts.pairs ? resolve(opts.pairs) : DEFAULT_SANITY_PAIRS;
  if (!existsSync(pairsPath)) {
    fail(`no sanity pairs file at ${pairsPath}; pass --pairs <file> to point at a different one.`, 1);
  }
  return loadSanityPairs(pairsPath);
}

// Today's local date as YYYY-MM-DD, the default `--date` for `decision propose`/`decision amend` (card
// memory-decisions).
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Reads a --file argument's text: "-" reads stdin (fd 0), anything else a real file path.
function readTextArg(path) {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(path), "utf8");
}

// Shared printer for decisions.mjs's propose*() results (card memory-decisions): refused -> the reason on
// stderr, exit 1 (plus the result as --json on stdout, mirroring `apply`'s own refusal shape); ok -> the
// proposal line in learn.mjs's own shape, the diff path, and how to apply it - the user approves before
// anything is written to docs/decisions/ or .claude/rules/, exactly like `learn.mjs propose`/`apply`.
function printProposalResult(result, jsonOut) {
  if (!result.ok) {
    if (jsonOut) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const { proposal, diffPath } = result;
  process.stdout.write(`${proposal.id} ${proposal.kind} ${proposal.target}: ${proposal.reason}\n`);
  process.stdout.write(`diff: ${diffPath}\n`);
  process.stdout.write(`apply with: learn.mjs apply ${diffPath}\n`);
}

// `index build`'s own pairs loader: an explicit --pairs that is missing fails clearly (same as loadPairsOrFail,
// same exit code), but with no --pairs given at all, a missing default file (DEFAULT_SANITY_PAIRS lives inside
// plugins/doug-flow/lib/data, so this only happens if that file was removed) is not a hard failure: build
// still runs, and buildIndex itself reports a check failure only if a model/dims pair actually new to the code
// index shows up needing one.
function loadIndexPairs(opts) {
  const pairsPath = opts.pairs ? resolve(opts.pairs) : DEFAULT_SANITY_PAIRS;
  if (!existsSync(pairsPath)) {
    if (opts.pairs) fail(`no sanity pairs file at ${pairsPath}; pass --pairs <file> to point at a different one.`, 1);
    return null;
  }
  return loadSanityPairs(pairsPath);
}

try {
  switch (cmd) {
    case "record": {
      if (opts.hand) {
        const handUsage =
          'usage: memory.mjs record <card-id> --hand [dir] --commit <sha> [--wall <text>] [--gate <text>] [--note <text>] [--cost <usd>] [--json]';
        const [id, ...extra] = rest;
        if (opts.stop !== undefined) {
          // Card memory-hand-stop-rows: a stopped by-hand run records exactly one stop row.
          const stopUsage =
            'usage: memory.mjs record <card-id> --hand --stop <reason> [dir] [--detail <text>] [--json]';
          if (!id || String(opts.stop).trim() === "" || opts.commit !== undefined) fail(stopUsage, 2);
          if (id.endsWith(".json") || existsSync(resolve(id))) fail(`${stopUsage}\n--hand takes a card id, not a report.`, 2);
          if (opts.run !== undefined || opts.adversary !== undefined || opts["claude-dir"] !== undefined || extra.length > 1) {
            fail(stopUsage, 2);
          }
          const dir = dirFrom(rest, 1);
          const conditionFile = join(dir, ".doug", ".state", "reports", id, "condition.json");
          let condition = null;
          if (existsSync(conditionFile)) {
            try {
              condition = JSON.parse(readFileSync(conditionFile, "utf8"));
            } catch (err) {
              fail(`cannot read ${conditionFile}: ${err.message}`);
            }
          }
          const reason = String(opts.stop).trim();
          const detail = textOrNull(opts.detail);
          const reportHash = createHash("sha256")
            .update(JSON.stringify({ card: id, reason, detail, openedAt: condition?.openedAt ?? null }))
            .digest("hex");
          const { openMemory, recordOutcomes, stopOutcomeRow } = await import("../lib/memory.mjs");
          const row = stopOutcomeRow({ card: id, report: { outcome: "stopped", reason, detail }, reportHash, blocks: [], condition });
          const m = openMemory(dir);
          let result;
          try {
            result = recordOutcomes(m, [row]);
          } finally {
            m.close();
          }
          const stamped = !!condition;
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ run: row.run, card: id, inserted: result.inserted, updated: result.updated, stamped }, null, 2) + "\n"
            );
          } else {
            process.stdout.write(
              `Recorded a hand-track stop for ${id} (${reason}) in .doug/.state/memory/memory.db (${result.inserted} new, ${result.updated} updated).\n`
            );
            if (!stamped) {
              process.stdout.write(
                `No condition.json for ${id}: this stop is unstamped (memory.mjs condition open ${id} writes one before the brief).\n`
              );
            }
          }
          break;
        }
        if (!id || !opts.commit) fail(handUsage, 2);
        if (id.endsWith(".json") || existsSync(resolve(id))) {
          fail(`${handUsage}\n--hand takes a card id, not a report.`, 2);
        }
        if (opts.run !== undefined || opts.adversary !== undefined || opts["claude-dir"] !== undefined || extra.length > 1) {
          fail(handUsage, 2);
        }
        if (opts.cost !== undefined && !/^\d+(\.\d+)?$/.test(opts.cost)) fail(`${handUsage}\n--cost takes a non-negative number of dollars, got ${JSON.stringify(opts.cost)}.`, 2);
        const dir = dirFrom(rest, 1);
        // condition.json (card outcomes-condition-columns): read when `condition open` wrote one before the
        // brief; a stamp missing entirely (the common case until core-next-hand-report wires this in) is not a
        // parse error, only a JSON.parse failure on a file that does exist is.
        const conditionFile = join(dir, ".doug", ".state", "reports", id, "condition.json");
        let condition = null;
        if (existsSync(conditionFile)) {
          try {
            condition = JSON.parse(readFileSync(conditionFile, "utf8"));
          } catch (err) {
            fail(`cannot read ${conditionFile}: ${err.message}`);
          }
        }
        const { openMemory, recordOutcomes, handOutcomeRow } = await import("../lib/memory.mjs");
        const row = handOutcomeRow({ card: id, commit: opts.commit, wallClock: textOrNull(opts.wall), gate: textOrNull(opts.gate), note: textOrNull(opts.note), condition, cost: opts.cost !== undefined ? Number(opts.cost) : null });
        const m = openMemory(dir);
        let result;
        try {
          result = recordOutcomes(m, [row]);
        } finally {
          m.close();
        }
        const stamped = !!condition;
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ run: row.run, card: id, commit: opts.commit, inserted: result.inserted, updated: result.updated, stamped }, null, 2) + "\n"
          );
        } else {
          process.stdout.write(
            `Recorded a hand-track landing for ${id} at ${opts.commit} in .doug/.state/memory/memory.db (${result.inserted} new, ${result.updated} updated).\n`
          );
          if (!stamped) {
            process.stdout.write(
              `No condition.json for ${id}: this landing is unstamped (memory.mjs condition open ${id} writes one before the brief).\n`
            );
          }
        }
        break;
      }
      const [reportFile] = rest;
      if (!reportFile) {
        fail(
          'usage: memory.mjs record <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]... [--claude-dir <path>] [--json]',
          2
        );
      }
      const dir = dirFrom(rest, 1);
      const reportPath = resolve(reportFile);
      if (!existsSync(reportPath)) fail(`no such report file: ${reportPath}`);
      let reportText;
      try {
        reportText = readFileSync(reportPath, "utf8");
      } catch (err) {
        fail(`cannot read report file ${reportPath}: ${err.message}`);
      }
      let report;
      try {
        report = unwrapReport(JSON.parse(reportText));
      } catch (err) {
        fail(`cannot parse report file ${reportPath} as JSON: ${err.message}`);
      }
      const reportHash = createHash("sha256").update(reportText).digest("hex");
      const classes = parseAdversaryClasses(opts.adversary || []);
      const plan = planFor(dir, opts.card);
      const run = opts.run || null;
      const runLabel = run || `report:${reportHash.slice(0, 12)}`;
      let cost = null;
      if (run) {
        try {
          cost = costRun({ runId: run, projectDir: dir, claudeDir: opts["claude-dir"] ? resolve(opts["claude-dir"]) : undefined });
        } catch (err) {
          if (!/^no journal for run /.test(err.message)) throw err;
          process.stderr.write(`Note: no journal for run ${run}; tokens and USD recorded as null.\n`);
          cost = null;
        }
      }
      // Lazy: a Node without node:sqlite must fail loudly here, not with a stack trace, and never before this point.
      const { openMemory, recordOutcomes, outcomeRows, memoryConfig } = await import("../lib/memory.mjs");
      const flowConfig = memoryConfig({ embeddings: readMemoryConfig(dir).embeddings, staleDays: readMemoryStaleDays(dir), track: "flow" });
      const rows = outcomeRows(report, { plan, classes, run, reportHash, reportPath, card: opts.card ?? null, commit: opts.commit ?? null, cost, memoryConfig: flowConfig });
      const m = openMemory(dir);
      let result;
      try {
        result = recordOutcomes(m, rows);
      } finally {
        m.close();
      }
      const tasks = rows.map((r) => r.task);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ run: runLabel, inserted: result.inserted, updated: result.updated, tasks }, null, 2) + "\n");
      } else {
        process.stdout.write(
          `Recorded ${rows.length} outcome(s) for ${runLabel} in .doug/.state/memory/memory.db (${result.inserted} new, ${result.updated} updated).\n`
        );
      }
      break;
    }
    case "reflect": {
      const usage =
        'usage: memory.mjs reflect <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]... [--harmful <id>]... [--claude-bin <path>] [--claude-dir <path>] [--model <name>] [--max-usd <n>] [--dry-run] [--json]';
      if (opts.failures !== undefined) {
        const failuresUsage =
          "usage: memory.mjs reflect --failures <card-id> [dir] [--session <id>] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--detach] [--dry-run] [--json]";
        const card = textOrNull(opts.failures);
        if (!card || opts.hand) fail(`${failuresUsage}\n--failures takes a card id and is exclusive with --hand and a report path.`, 2);
        if (rest.length > 1) fail(failuresUsage, 2);
        if (rest.length === 1) {
          // A lone positional that is a file, or names a .json report, is a report path, not a dir.
          let isFile = /\.json$/i.test(rest[0]);
          try {
            if (statSync(resolve(rest[0])).isFile()) isFile = true;
          } catch {
            // missing path: judged by its name above
          }
          if (isFile) fail(`${failuresUsage}\n--failures takes a card id and is exclusive with --hand and a report path.`, 2);
        }
        const fdir = dirFrom(rest, 0);
        if (opts.detach) {
          const started = startDetachedJob(fdir, `failures-${card}`, [process.execPath, process.argv[1], ...argv.filter((a) => a !== "--detach")]);
          process.stdout.write(`${started.name}: started detached (pid ${started.pid}); read it with: memory.mjs job ${started.name}\n`);
          break;
        }
        const fmodels = loadModels(fdir);
        const fmodel = textOrNull(opts.model) || (fmodels.tiers.cheap && fmodels.tiers.cheap.model) || "haiku";
        let fmaxUsd = 0.5;
        if (opts["max-usd"] !== undefined) {
          fmaxUsd = Number(opts["max-usd"]);
          if (!Number.isFinite(fmaxUsd) || fmaxUsd <= 0) fail(`${failuresUsage}\n--max-usd must be a positive number, got ${JSON.stringify(opts["max-usd"])}.`, 2);
        }
        const fClaudeBin = textOrNull(opts["claude-bin"]) || process.env.DOUG_CLAUDE_BIN || "claude";
        const fDry = !!opts["dry-run"];
        const { openMemory, runFailureReflect, FAILURE_REFLECT_SCHEMA } = await import("../lib/memory.mjs");
        const m = openMemory(fdir);
        let fres;
        try {
          fres = await runFailureReflect(m, {
            dir: fdir,
            card,
            session: textOrNull(opts.session),
            model: fmodel,
            claudeDir: opts["claude-dir"] ? resolve(opts["claude-dir"]) : undefined,
            dryRun: fDry,
            propose: fDry ? null : makePropose({ claudeBin: fClaudeBin, model: fmodel, maxUsd: fmaxUsd, dir: fdir, schema: FAILURE_REFLECT_SCHEMA }),
          });
          if (!fDry && fres.ok && fres.appended && fres.appended.length) await bestEffortEmbed(m, fdir, fres.appended);
        } finally {
          m.close();
        }
        if (fres.alreadyReflected) {
          if (opts.json) process.stdout.write(JSON.stringify(fres.row, null, 2) + "\n");
          else process.stdout.write(`Already reflected on ${fres.row.recorded} for the failures of ${card}; nothing to do.\n`);
          break;
        }
        if (fres.ok === false) {
          process.stderr.write(`reflect: the failure pass failed for ${card}: ${fres.reason}\n`);
          if (opts.json) process.stdout.write(JSON.stringify(fres, null, 2) + "\n");
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(fres, null, 2) + "\n");
          break;
        }
        const hiddenText = Object.entries(fres.hidden).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
        const prefix = fDry ? "(dry run) " : "";
        process.stdout.write(`${prefix}Failures of ${card}: ${fres.items} item(s); hidden blocks: ${hiddenText}; unreadable: ${fres.unreadable}\n`);
        if (fres.items === 0) break;
        if (fDry && fres.proposed === null) {
          process.stdout.write(`${prefix}no model call; the prompt that would be sent:\n${fres.prompt}\n`);
          process.stdout.write(`${prefix}Would append pitfall lessons to the memory store, .doug/.state/memory/pitfalls.jsonl and a reflections row; ${costLine(fres.usd, fres.usdSource)}\n`);
          break;
        }
        process.stdout.write(
          `${prefix}Reflected: proposed ${fres.proposed}, ${fDry ? "would append" : "appended"} ${fres.appended.length} (${idsList(fres.appended)}), repeated ${fres.repeated.length} (${idsList(fres.repeated)}), rejected ${fres.rejected.length}; model ${fres.model}; ${costLine(fres.usd, fres.usdSource)}\n`
        );
        for (const r of fres.rejected) process.stdout.write(`  rejected ${r.text ? JSON.stringify(r.text) : "(no text)"}: ${r.reason}\n`);
        break;
      }
      let dir;
      let reportPath;
      let reportText;
      let report;
      let classes;
      let handCard = null;
      let rounds = 1;
      if (opts.hand) {
        const handUsage =
          'usage: memory.mjs reflect --hand <card-id> [dir] --commit <sha> [--rounds <n>] [--review "<R<n> or <card-id>/R<n>>=<real|marginal|false>[: <reason>]"]... [--harmful <id>]... [--note <text>] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--dry-run] [--json]';
        const [id] = rest;
        if (!id || !opts.commit) fail(handUsage, 2);
        handCard = id;
        dir = dirFrom(rest, 1);
        if (opts.rounds !== undefined) {
          rounds = Number(opts.rounds);
          if (!Number.isInteger(rounds) || rounds < 1) fail(`${handUsage}\n--rounds must be a positive integer, got ${JSON.stringify(opts.rounds)}.`, 2);
        }
        try {
          const byKey = new Map();
          for (const c of parseAdversaryClasses(opts.review || [])) {
            let key = c.id;
            const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (/^R\d+$/.test(key)) key = `${id}/${key}`;
            else if (!new RegExp(`^${escaped}/R\\d+$`).test(key)) throw new Error(`--review key ${JSON.stringify(c.id)} must be R<n> or ${id}/R<n>`);
            const prev = byKey.get(key);
            if (prev && prev.class !== c.class) throw new Error(`--review names ${key} twice with different classes (${prev.class}, ${c.class})`);
            if (!prev) byKey.set(key, { ...c, id: key });
          }
          classes = [...byKey.values()];
        } catch (err) {
          fail(`${handUsage}\n${err.message}`, 2);
        }
        if (opts.detach) {
          const started = startDetachedJob(dir, `reflect-${id}`, [process.execPath, process.argv[1], ...argv.filter((a) => a !== "--detach")]);
          process.stdout.write(`${started.name}: started detached (pid ${started.pid}); read it with: memory.mjs job ${started.name}\n`);
          break;
        }
        const base = join(dir, ".doug", ".state", "reports", id);
        const readDirFiles = (sub) => {
          const d = join(base, sub);
          if (!existsSync(d)) return [];
          return readdirSync(d)
            .filter((n) => !n.startsWith("."))
            .sort()
            .map((name) => {
              try {
                return { name, text: readFileSync(join(d, name), "utf8") };
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        };
        let memoryUsed = [];
        try {
          const saved = JSON.parse(readFileSync(join(base, "lessons.json"), "utf8"));
          if (saved && Array.isArray(saved.ids)) memoryUsed = saved.ids.filter((x) => typeof x === "string");
        } catch {
          memoryUsed = [];
        }
        const fetched = new Set();
        try {
          for (const line of readFileSync(join(base, "fetched.jsonl"), "utf8").split("\n")) {
            try {
              const rec = JSON.parse(line);
              if (rec && typeof rec.id === "string") fetched.add(rec.id);
            } catch {}
          }
        } catch {}
        memoryUsed = [...new Set(memoryUsed.filter((x) => fetched.has(x)))];
        const ledger = classes.map((c) => {
          return { id: c.id, stage: "adversary", seat: "reviewer", severity: "blocker", status: "fixed", description: c.reason || `reviewer finding ${c.id}` };
        });
        const sortKeys = (v) =>
          Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
        const handReport = sortKeys({
          track: "hand",
          card: id,
          commit: opts.commit,
          levels: [{ index: 0, tasks: [{ id, card: id, commit: opts.commit, verified: true, passes: rounds, stopReason: null, memoryUsed, ledger }] }],
          hand: { briefs: readDirFiles("briefs"), reviews: readDirFiles("reviews"), note: textOrNull(opts.note) },
        });
        reportText = JSON.stringify(handReport, null, 2) + "\n";
        reportPath = join(base, "hand-report.json");
        mkdirSync(base, { recursive: true });
        writeFileSync(reportPath, reportText, "utf8");
        report = handReport;
        if (!opts["dry-run"]) {
          try {
            const { historyScanner, writeRunHistory } = await import("../lib/memory.mjs");
            const entries = [{ kind: "report", source: "hand-report.json", value: handReport }];
            for (const f of readDirFiles("briefs")) {
              const mm = /^(\d+)-(.+)\.md$/.exec(f.name);
              entries.push({ kind: "brief", seat: mm ? mm[2] : null, round: mm ? Number(mm[1]) : null, source: `briefs/${f.name}`, value: f.text });
            }
            for (const f of readDirFiles("reviews")) {
              const mm = /^(\d+)\.md$/.exec(f.name);
              entries.push({ kind: "review", seat: "reviewer", round: mm ? Number(mm[1]) : null, source: `reviews/${f.name}`, value: f.text });
            }
            writeRunHistory(dir, { card: id, run: `hand:${opts.commit}`, entries, scan: await historyScanner(dir) });
          } catch (err) {
            process.stderr.write(`reflect: warning: cannot write the run history for ${id}: ${err.message || err}\n`);
          }
        }
      } else {
        const [reportFile] = rest;
        if (!reportFile) fail(usage, 2);
        dir = dirFrom(rest, 1);
        reportPath = resolve(reportFile);
        if (!existsSync(reportPath)) fail(`no such report file: ${reportPath}`);
        try {
          reportText = readFileSync(reportPath, "utf8");
        } catch (err) {
          fail(`cannot read report file ${reportPath}: ${err.message}`);
        }
        try {
          report = unwrapReport(JSON.parse(reportText));
        } catch (err) {
          fail(`cannot parse report file ${reportPath} as JSON: ${err.message}`);
        }
        classes = parseAdversaryClasses(opts.adversary || []);
        if (opts.detach) {
          const tag = textOrNull(opts.card) || textOrNull(opts.run) || createHash("sha256").update(reportText).digest("hex").slice(0, 12);
          const started = startDetachedJob(dir, `reflect-${tag}`, [process.execPath, process.argv[1], ...argv.filter((a) => a !== "--detach")]);
          process.stdout.write(`${started.name}: started detached (pid ${started.pid}); read it with: memory.mjs job ${started.name}\n`);
          break;
        }
      }
      const reportHash = createHash("sha256").update(reportText).digest("hex");
      const plan = planFor(dir, opts.card);
      const models = loadModels(dir);
      const model = textOrNull(opts.model) || (models.tiers.cheap && models.tiers.cheap.model) || "haiku";
      let maxUsd = 0.5;
      if (opts["max-usd"] !== undefined) {
        maxUsd = Number(opts["max-usd"]);
        if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail(`${usage}\n--max-usd must be a positive number, got ${JSON.stringify(opts["max-usd"])}.`, 2);
      }
      const claudeBin = textOrNull(opts["claude-bin"]) || process.env.DOUG_CLAUDE_BIN || "claude";
      const claudeDir = opts["claude-dir"] ? resolve(opts["claude-dir"]) : undefined;
      const dryRun = !!opts["dry-run"];
      const runLabel = opts.run || `report:${reportHash.slice(0, 12)}`;

      const { openMemory, runReflect } = await import("../lib/memory.mjs");
      const propose = dryRun ? null : makePropose({ claudeBin, model, maxUsd, dir });
      const m = openMemory(dir);
      let result;
      try {
        result = await runReflect(m, report, {
          reportHash,
          dir,
          classes,
          plan,
          run: opts.run ?? null,
          card: handCard ?? opts.card ?? null,
          commit: opts.commit ?? null,
          model,
          claudeDir,
          dryRun,
          harmful: opts.harmful || [],
          propose,
        });
        if (!dryRun && result.ok && result.appended && result.appended.length) {
          await bestEffortEmbed(m, dir, result.appended);
        }
        // Card memory-outcome-arms: only an explicit --rounds is a measurement; the default of 1 is never written.
        if (handCard && !dryRun && opts.rounds !== undefined && (result.ok || result.alreadyReflected)) {
          m.prepare("UPDATE outcomes SET passes = ?, fix_passes = ? WHERE run = ? AND task = ?").run(rounds, rounds - 1, `hand:${opts.commit}`, handCard);
        }
      } finally {
        m.close();
      }

      if (result.alreadyReflected) {
        if (opts.json) {
          process.stdout.write(JSON.stringify(result.row, null, 2) + "\n");
        } else {
          process.stdout.write(`Already reflected on ${result.row.recorded} for ${runLabel}; nothing to do.\n`);
        }
        break;
      }

      if (!result.ok) {
        process.stderr.write(`reflect: the cheap-row pass failed for ${runLabel}: ${result.reason}\n`);
        if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        process.exit(1);
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const c = result.counters;
        const prefix = result.dryRun ? "(dry run) " : "";
        if (result.dryRun && result.proposed === null) {
          process.stdout.write(
            `${prefix}Reflected on ${runLabel}: counters helpful +${c.helpful.length} (${idsList(c.helpful)}) harmful +${c.harmful.length} (${idsList(c.harmful)}); ` +
              `cheap-row pass not run (dry run, no model call); ${costLine(result.usd, result.usdSource)}\n`
          );
          process.stdout.write(`${prefix}the prompt that would be sent:\n${result.prompt}\n`);
          break;
        }
        process.stdout.write(
          `${prefix}Reflected on ${runLabel}: counters helpful +${c.helpful.length} (${idsList(c.helpful)}) harmful +${c.harmful.length} (${idsList(c.harmful)}); ` +
            `proposed ${result.proposed}, appended ${result.appended.length} (${idsList(result.appended)}), bumped ${result.bumped.length} (${idsList(result.bumped)}), ` +
            `superseded ${result.superseded.length} (${supersededList(result.superseded)}), rejected ${result.rejected.length}; model ${result.model}; ${costLine(result.usd, result.usdSource)}\n`
        );
        for (const n of result.notes || []) process.stdout.write(`  note: ${n}\n`);
        for (const r of result.rejected) {
          process.stdout.write(`  rejected ${r.text ? JSON.stringify(r.text) : "(no text)"}: ${r.reason}\n`);
        }
        for (const c of result.claudeMd || []) {
          process.stdout.write(
            result.dryRun
              ? `claude-md candidate for lesson ${c.lessonId} (dry run, not written)\n`
              : `claude-md candidate for lesson ${c.lessonId}: ${c.command}\n`
          );
        }
        for (const d of result.claudeMdDropped || []) process.stdout.write(`claude-md candidate for lesson ${d.lessonId} dropped: ${d.reason}\n`);
      }
      break;
    }
    case "__jobrun": {
      const raw = process.argv.slice(2);
      const sep = raw.indexOf("--");
      if (sep < 3 || sep === raw.length - 1) fail("usage: memory.mjs __jobrun <dir> <name> -- <command> [args...]", 2);
      await runJob(raw[1], raw[2], raw.slice(sep + 1));
      break;
    }
    case "job": {
      const usage = "usage: memory.mjs job <name> [dir] [--wait <seconds>] | memory.mjs job --earlier [dir]";
      if (opts.earlier) {
        // Earlier landings' jobs nobody has read yet: pending, failed, or finished with the summary never printed.
        const edir = dirFrom(rest, 0);
        const { jobs } = jobPaths(edir, "x");
        let names = [];
        try {
          names = readdirSync(jobs).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
        } catch {
          names = [];
        }
        let failed = false;
        let any = false;
        for (const n of names.sort()) {
          const js = jobStatus(edir, n);
          if (!js || js.st.reportedAt) continue;
          any = true;
          process.stdout.write(`earlier job ${js.line}\n`);
          if (js.state === "failed") failed = true;
          if (js.state !== "pending") markJobReported(edir, n, js.st);
        }
        if (!any) process.stdout.write("no earlier jobs unread\n");
        if (failed) process.exit(1);
        break;
      }
      const [name] = rest;
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) fail(usage, 2);
      let waitSec = 0;
      if (opts.wait !== undefined) {
        waitSec = /^\d+$/.test(String(opts.wait)) ? Number(opts.wait) : NaN;
        if (!Number.isInteger(waitSec)) fail(`${usage}\n--wait must be a whole number of seconds, got ${JSON.stringify(opts.wait)}.`, 2);
      }
      const jdir = dirFrom(rest, 1);
      const deadline = Date.now() + waitSec * 1000;
      let js = jobStatus(jdir, name);
      if (!js) fail(`${name}: no such job in ${jdir}`, 1);
      while (js.state === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));
        js = jobStatus(jdir, name) || js;
      }
      process.stdout.write(`${js.line}\n`);
      if (js.state !== "pending") markJobReported(jdir, name, js.st);
      if (js.state === "failed") process.exit(1);
      break;
    }
    case "outcomes": {
      const dir = dirFrom(rest, 0);
      const { openMemory, listOutcomes } = await import("../lib/memory.mjs");
      const m = openMemory(dir);
      let rows;
      try {
        rows = listOutcomes(m, { run: opts.run ?? null, task: opts.task ?? null });
      } finally {
        m.close();
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } else if (!rows.length) {
        process.stdout.write("no outcomes recorded\n");
      } else {
        process.stdout.write(rows.map(outcomeLine).join("\n") + "\n");
      }
      break;
    }
    case "arms": {
      const armsUsage = "usage: memory.mjs arms [dir] [--min <n>] [--json]";
      let min = 12;
      if (opts.min !== undefined) {
        min = /^\d+$/.test(String(opts.min)) ? Number(opts.min) : NaN;
        if (!Number.isInteger(min) || min < 1) fail(`${armsUsage}\n--min must be an integer >= 1, got ${JSON.stringify(opts.min)}.`, 2);
      }
      const dir = dirFrom(rest, 0);
      const { memoryPath, openMemory, compareMemoryArms } = await import("../lib/memory.mjs");
      if (!existsSync(memoryPath(dir))) {
        process.stdout.write("No outcomes recorded.\n");
        break;
      }
      const m = openMemory(dir);
      let res;
      try {
        res = compareMemoryArms(m, { min });
      } finally {
        m.close();
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }
      const num = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "n/a");
      const label = (cfg) => {
        try {
          const c = JSON.parse(cfg);
          const e = c.embeddings ? `${c.embeddings.provider}/${c.embeddings.model}/${c.embeddings.dims}` : "keyword-only";
          return `${c.stage} ${e} staleDays ${c.staleDays}`;
        } catch {
          return cfg;
        }
      };
      const lines = res.arms.map((a) => {
        const head = `${label(a.config)}: ${a.landings} landings, ${a.stops} stops`;
        if (!a.ready) return `${head}; not compared: ${a.landings} of ${res.min} landings`;
        const fix = a.fixRounds.n ? `${num(a.fixRounds.mean)} (n ${a.fixRounds.n})` : "n/a (none measured)";
        return `${head}; land rate ${num(a.landRate)}; fix rounds ${fix}; harmful per landing ${num(a.harmfulPerLanding)}; cost per landing ${typeof a.costPerLanding === "number" ? `$${a.costPerLanding.toFixed(2)}` : "n/a"} (${a.priced} priced)`;
      });
      if (res.unstamped) lines.push(`${res.unstamped} rows carry no memory configuration and are in no arm.`);
      lines.push(res.comparable ? "Two or more arms are comparable." : "Not comparable yet: fewer than two arms have enough landings.");
      process.stdout.write(lines.join("\n") + "\n");
      break;
    }
    case "lessons": {
      const dir = dirFrom(rest, 0);
      if (opts.unconfirmed) {
        if (opts.search !== undefined || opts.all) fail("usage: memory.mjs lessons --unconfirmed [dir] [--json] (not with --search or --all)", 2);
        let list = [];
        if (existsSync(join(dir, ".doug", ".state", "memory", "memory.db"))) {
          const { openMemory, listUnconfirmedLessons, readFetchedLessonIds } = await import("../lib/memory.mjs");
          const m = openMemory(dir);
          try {
            list = listUnconfirmedLessons(m, { fetchedIds: readFetchedLessonIds(dir) });
          } finally {
            m.close();
          }
        }
        if (opts.json) process.stdout.write(JSON.stringify(list, null, 2) + "\n");
        else if (!list.length) process.stdout.write("no unconfirmed lessons\n");
        else process.stdout.write(list.map((r) => `${r.id}  ${r.kind}  ${r.created}  ${r.title}`).join("\n") + "\n");
        break;
      }
      const { openMemory, listLessons, searchLessons } = await import("../lib/memory.mjs");
      const m = openMemory(dir);
      let rows;
      try {
        const includeSuperseded = !!opts.all;
        rows =
          opts.search !== undefined
            ? searchLessons(m, opts.search, { k: opts.k !== undefined ? Number(opts.k) : undefined, includeSuperseded })
            : listLessons(m, { includeSuperseded });
      } finally {
        m.close();
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } else if (!rows.length) {
        process.stdout.write("no lessons\n");
      } else {
        process.stdout.write(rows.map(lessonLine).join("\n") + "\n");
      }
      break;
    }
    case "lesson": {
      const usage =
        "usage: memory.mjs lesson add --text <text> --kind <feedback|project|pitfall|pattern> [dir]\n" +
        "                      [--scope <glob,glob>] [--citation <text>] [--card <id>]\n" +
        "                      [--commit <sha>] [--source-agent <name>] [--source-model <name>] [--json]\n" +
        "       memory.mjs lesson unstale <id> [dir] [--json]\n" +
        "       memory.mjs lesson unarchive <id> [dir] [--json]\n" +
        "       memory.mjs lesson show <id> [dir] [--card <card-id>] [--json]";
      const [sub, ...subrest] = rest;
      if (sub === "unstale") {
        const [id] = subrest;
        if (!id) fail(usage, 2);
        const dir = dirFrom(subrest, 1);
        const { openMemory, unstaleLesson } = await import("../lib/memory.mjs");
        const m = openMemory(dir);
        let row;
        try {
          row = unstaleLesson(m, id);
        } finally {
          m.close();
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(row, null, 2) + "\n");
        } else {
          process.stdout.write(`Cleared the stale mark on lesson ${row.id}.\n`);
        }
        break;
      }
      if (sub === "unarchive") {
        const [id] = subrest;
        if (!id) fail(usage, 2);
        const dir = dirFrom(subrest, 1);
        const { openMemory, unarchiveLesson } = await import("../lib/memory.mjs");
        const m = openMemory(dir);
        let row;
        try {
          row = unarchiveLesson(m, id);
        } finally {
          m.close();
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(row, null, 2) + "\n");
        } else {
          process.stdout.write(`Restored archived lesson ${row.id}.\n`);
        }
        break;
      }
      if (sub === "show") {
        const [id] = subrest;
        if (!id) fail(usage, 2);
        if (opts.card !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(opts.card))) fail(usage, 2);
        const dir = dirFrom(subrest, 1);
        if (!existsSync(join(dir, ".doug", ".state", "memory", "memory.db"))) fail(`no lesson ${id}: no memory store`);
        const { openMemory, getLesson, lessonTokens } = await import("../lib/memory.mjs");
        const m = openMemory(dir);
        let row;
        try {
          row = getLesson(m, id);
        } finally {
          m.close();
        }
        if (!row) fail(`no lesson ${id}`);
        const tokens = lessonTokens(row.text);
        if (opts.json) {
          const { embedding, ...rest2 } = row;
          process.stdout.write(JSON.stringify({ ...rest2, hasVector: embedding != null, tokens }, null, 2) + "\n");
        } else {
          const head = [`lesson ${row.id} (${row.kind}, ~${tokens} tokens)`, `citation: ${row.citation || "none"}`];
          if (row.superseded_by) head.push(`superseded by ${row.superseded_by}`);
          if (row.stale) head.push(`stale since ${row.stale}`);
          process.stdout.write(head.join("\n") + "\n\n" + row.text + "\n");
        }
        if (opts.card !== undefined) {
          const fdir = join(dir, ".doug", ".state", "reports", String(opts.card));
          mkdirSync(fdir, { recursive: true });
          appendFileSync(join(fdir, "fetched.jsonl"), JSON.stringify({ id: row.id, at: new Date().toISOString() }) + "\n");
        }
        break;
      }
      if (sub !== "add") fail(usage, 2);
      const dir = dirFrom(subrest, 0);
      const sourceAgent = String(opts["source-agent"] !== undefined ? opts["source-agent"] : "lead").trim();
      if (sourceAgent.toLowerCase() === "auto-memory") {
        fail(
          '--source-agent auto-memory is refused: "auto-memory" is the namespace memory-import.mjs uses to find ' +
            'the row it may supersede (file name under the auto-memory dir + source_agent "auto-memory"); a ' +
            "hand-authored lesson must not claim it. " +
            'Use a different --source-agent (default "lead").',
          2
        );
      }
      const scope = opts.scope
        ? String(opts.scope)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const { openMemory, addLesson, getLesson } = await import("../lib/memory.mjs");
      const m = openMemory(dir);
      let row;
      try {
        row = addLesson(m, {
          text: opts.text,
          kind: opts.kind,
          scope,
          citation: textOrNull(opts.citation),
          source: { agent: sourceAgent, model: textOrNull(opts["source-model"]) },
          card: textOrNull(opts.card),
          commit: textOrNull(opts.commit),
        });
        await bestEffortEmbed(m, dir, [row.id]);
        row = getLesson(m, row.id);
      } finally {
        m.close();
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(row, null, 2) + "\n");
      } else {
        process.stdout.write(`Added lesson ${row.id} (${row.kind}) in .doug/.state/memory/memory.db.\n`);
      }
      break;
    }
    case "import": {
      const dir = dirFrom(rest, 0);
      const claudeDir = opts["claude-dir"] ? resolve(opts["claude-dir"]) : undefined;
      const { openMemory } = await import("../lib/memory.mjs");
      const { importAutoMemory } = await import("../lib/memory-import.mjs");
      const m = openMemory(dir);
      let result;
      try {
        result = importAutoMemory(m, { projectDir: dir, claudeDir });
        const newIds = result.files.filter((f) => f.action === "added" || f.action === "updated").map((f) => f.id);
        await bestEffortEmbed(m, dir, newIds);
      } finally {
        m.close();
      }
      if (!result.found) {
        process.stdout.write(`no auto memory at ${result.dir}\n`);
        break;
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(
          `Imported ${result.added + result.updated} lesson(s) from ${result.dir}: ${result.added} added, ${result.updated} updated (old row superseded), ${result.unchanged} unchanged, ${result.skipped} skipped (empty), ${result.retired} retired (file deleted).\n`
        );
      }
      break;
    }
    case "recall": {
      const usage = "usage: memory.mjs recall <query> [dir] [--files <glob,glob>] [--k <n>] [--json]";
      const [query, ...extra] = rest;
      if (!query) fail(usage, 2);
      const dir = dirFrom(extra, 0);
      const files = opts.files
        ? String(opts.files)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      let k;
      if (opts.k !== undefined) {
        k = Number(opts.k);
        if (!Number.isInteger(k) || k < 1) {
          fail(`${usage}\n--k must be an integer >= 1, got ${JSON.stringify(opts.k)}.`, 2);
        }
      }
      const provider = createProvider(readMemoryConfig(dir));
      const staleDays = readMemoryStaleDays(dir);
      const { openMemory, recallLessons, degradedWarning, detectLocalProvider, windowNote } = await import("../lib/memory.mjs");
      // Probed once, and only when no provider is configured; a failed probe is just "not detected".
      const detectedProvider = provider ? null : await detectLocalProvider();
      const m = openMemory(dir);
      let result;
      try {
        result = await recallLessons(m, query, { files, k, provider, checkoutDir: dir, staleDays, detectedProvider });
      } finally {
        m.close();
      }
      const recallWarning = degradedWarning(result, { what: "memory recall", detectedProvider });
      if (recallWarning) process.stderr.write(recallWarning + "\n");
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const header =
          result.mode === "hybrid"
            ? `recall: hybrid via ${result.provider} ${provider.model}/${provider.dims}`
            : `recall: keyword-only (${result.reason})`;
        const note = windowNote(result.hidden, staleDays);
        const lines = [header, ...(note ? [note] : []), ...result.lessons.map((l) => `${l.id}  ${l.score.toFixed(4)}  ${l.kind}  ${l.text}`)];
        process.stdout.write(lines.join("\n") + "\n");
      }
      break;
    }
    case "brief-lessons": {
      const usage = "usage: memory.mjs brief-lessons <card-id> [dir] [--k <n>] [--json]";
      const [id, ...extra] = rest;
      if (!id) fail(usage, 2);
      const dir = dirFrom(extra, 0);
      let k = 8;
      if (opts.k !== undefined) {
        k = Number(opts.k);
        if (!Number.isInteger(k) || k < 1) fail(`${usage}\n--k must be an integer >= 1, got ${JSON.stringify(opts.k)}.`, 2);
      }
      let card;
      try {
        card = findCard(loadBoard(dir), id);
      } catch (err) {
        fail(`no card ${id}: ${err.message}`);
      }
      const query = `${card.title}\n${card.goal ?? ""}`;
      const header = "Lessons from earlier runs on this repository (memory; each cites where it was learned):";
      const saved = { card: id, query, mode: null, reason: null, ids: [], text: null, omitted: [], recalledAt: new Date().toISOString(), hidden: null };
      let note = null;
      let error = null;
      if (existsSync(join(dir, ".doug", ".state", "memory", "memory.db"))) {
        try {
          const provider = createProvider(readMemoryConfig(dir));
          const staleDays = readMemoryStaleDays(dir);
          const { openMemory, recallLessons, degradedWarning, degradedReason, detectLocalProvider, renderLessonIndex, windowNote } = await import("../lib/memory.mjs");
          const detectedProvider = provider ? null : await detectLocalProvider();
          const m = openMemory(dir);
          try {
            const result = await recallLessons(m, query, { k, checkoutDir: dir, provider, staleDays, detectedProvider });
            const warning = degradedWarning(result, { what: "memory recall", detectedProvider });
            if (warning) process.stderr.write(warning + "\n");
            const rendered = renderLessonIndex(result.lessons);
            saved.omitted = rendered.omitted;
            saved.mode = result.mode;
            saved.hidden = result.hidden ?? null;
            note = windowNote(result.hidden, staleDays);
            saved.reason = result.degraded ? degradedReason(result, detectedProvider) : null;
            saved.ids = rendered.ids;
            saved.text = rendered.text === null ? null : result.degraded ? `(recall was keyword-only: ${saved.reason})\n${rendered.text}` : rendered.text;
          } finally {
            m.close();
          }
        } catch (err) {
          error = err.message;
          saved.mode = null;
          saved.reason = null;
          saved.ids = [];
          saved.text = null;
          saved.omitted = [];
          saved.hidden = null;
          note = null;
          saved.error = error;
          process.stderr.write(`[doug] memory recall skipped: ${error}\n`);
        }
      }
      const reportDir = join(dir, ".doug", ".state", "reports", id);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, "lessons.json"), JSON.stringify(saved, null, 2) + "\n", "utf8");
      if (opts.json) {
        process.stdout.write(JSON.stringify(saved, null, 2) + "\n");
      } else if (saved.ids.length) {
        const omittedLine = saved.omitted.length
          ? [`index: omitted ${saved.omitted.length} lessons over the 2000-character index budget: ${saved.omitted.join(", ")}`]
          : [];
        process.stdout.write([header, saved.text, ...omittedLine, ...(note ? [note] : []), `memoryUsed: ${saved.ids.join(", ")}`].join("\n") + "\n");
      } else {
        process.stdout.write(`No lessons recalled for ${id}.\n${note ? note + "\n" : ""}`);
      }
      break;
    }
    case "history": {
      const usage = "usage: memory.mjs history show <card>[/<run>[:<line>]] [dir] [--json]";
      const [sub, ref, ...extra] = rest;
      if (sub !== "show" || !ref) fail(usage, 2);
      const dir = dirFrom(extra, 0);
      const { parseHistoryRef, readRunHistory } = await import("../lib/memory.mjs");
      let parsed;
      try {
        parsed = parseHistoryRef(ref);
      } catch (err) {
        fail(`${err.message}\n${usage}`, 2);
      }
      let data;
      try {
        data = readRunHistory(dir, parsed);
      } catch (err) {
        fail(err.message);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } else if (parsed.line !== null) {
        const e = data;
        const out = [`history ${parsed.card}/${parsed.run}:${parsed.line} (${e.kind}, seat ${e.seat ?? "-"}, round ${e.round ?? "-"}, ${e.source}, ~${e.tokens} tokens)`];
        if (e.truncated) out.push(`truncated at capture: ${e.bytes} bytes, head kept`);
        if (e.redacted) out.push(`redacted: ${e.redacted}`);
        process.stdout.write(out.join("\n") + "\n\n" + (e.text ?? "") + "\n");
      } else if (parsed.run !== null) {
        const out = [`history ${data.card}/${data.run}: ${data.entries.length} entries, ~${data.tokens} tokens`];
        for (const e of data.entries) {
          if (e.kind === "cap") {
            out.push(`${e.line}  cap  dropped ${e.dropped} entries over ${e.maxRunBytes} bytes`);
            continue;
          }
          out.push(
            `${e.line}  ${e.kind}  ${e.seat ?? "-"}  ${e.round ?? "-"}  ${e.source}  ~${e.tokens} tokens` +
              (e.truncated ? ` truncated from ${e.bytes} bytes` : "") +
              (e.redacted ? ` redacted: ${e.redacted}` : "")
          );
        }
        process.stdout.write(out.join("\n") + "\n");
      } else {
        const out = [`history ${data.card}: ${data.runs.length} runs`];
        for (const r of data.runs) out.push(`${data.card}/${r.run}  ${r.entries} entries  ~${r.tokens} tokens`);
        process.stdout.write(out.join("\n") + "\n");
      }
      break;
    }
    case "ideas": {
      const usage = "usage: memory.mjs ideas [dir] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--cap <n>] [--dry-run] [--json]";
      const dir = dirFrom(rest, 0);
      const lib = await import("../lib/memory.mjs");
      const models = loadModels(dir);
      const model = textOrNull(opts.model) || (models.tiers.cheap && models.tiers.cheap.model) || "haiku";
      let maxUsd = 0.5;
      if (opts["max-usd"] !== undefined) {
        maxUsd = Number(opts["max-usd"]);
        if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail(`${usage}\n--max-usd must be a positive number, got ${JSON.stringify(opts["max-usd"])}.`, 2);
      }
      let cap = lib.IDEA_CAP;
      if (opts.cap !== undefined) {
        cap = Number(opts.cap);
        if (!Number.isInteger(cap) || cap < 1) fail(`${usage}\n--cap must be an integer of at least 1, got ${JSON.stringify(opts.cap)}.`, 2);
      }
      const claudeBin = textOrNull(opts["claude-bin"]) || process.env.DOUG_CLAUDE_BIN || "claude";
      const dryRun = !!opts["dry-run"];
      if (!existsSync(lib.memoryPath(dir))) fail("no memory store: nothing to propose ideas from");
      let board;
      try {
        board = loadBoard(dir);
      } catch (err) {
        fail(`ideas: ${err.message}`);
      }
      const m = lib.openMemory(dir);
      let call;
      let ideaCheck;
      let reviewCheck;
      let dryPrompt = null;
      try {
        const prompt = lib.buildIdeasPrompt({
          lessons: lib.listLessons(m),
          runs: lib.listRunHistoryRefs(dir),
          pitfalls: lib.readPitfallOccurrences(dir),
          cards: board.cards.filter((c) => c.column === "backlog" || c.column === "ready"),
        });
        if (dryRun) {
          dryPrompt = prompt;
        } else {
          try {
            call = await makePropose({ claudeBin, model, maxUsd, dir, schema: lib.IDEAS_SCHEMA, resultKey: "ideas", extraKeys: ["reviews"] })(prompt);
          } catch (err) {
            fail(`ideas: the model call failed: ${err.message}`);
          }
          ideaCheck = lib.checkIdeaCitations(m, dir, call.ideas);
          reviewCheck = lib.checkIdeaCitations(m, dir, call.reviews);
        }
      } finally {
        m.close();
      }
      if (dryRun) {
        const writes = [".doug/board.json", lib.PRIORITY_REVIEWS_RELPATH];
        if (opts.json) {
          process.stdout.write(JSON.stringify({ dryRun: true, prompt: dryPrompt, wouldWrite: writes, usd: 0, usdSource: "none" }, null, 2) + "\n");
        } else {
          process.stdout.write(`(dry run) no model call; the prompt that would be sent:\n${dryPrompt}\n`);
          for (const w of writes) process.stdout.write(`Would write ${w}\n`);
          process.stdout.write(`(dry run) Would file idea cards and reviews from the model's proposals; ${costLine(0, "none")}\n`);
        }
        break;
      }
      const cost = lib.computeReflectCost({ dir, sessionId: call.sessionId, totalCostUsd: call.totalCostUsd });
      const date = new Date().toISOString().slice(0, 10);
      try {
        board = loadBoard(dir);
      } catch (err) {
        fail(`ideas: ${err.message}`);
      }
      const filed = lib.fileIdeaCards(board, ideaCheck.kept, { cap, date });
      const reviewsChecked = lib.checkPriorityReviews(board, reviewCheck.kept, { cap, recorded: lib.readPriorityReviews(dir) });
      const at = new Date().toISOString();
      const reviewLines = reviewsChecked.kept.map((r) => ({ at, text: r.text, cards: r.cards, citations: r.citations }));
      const droppedReviews = [...reviewCheck.dropped, ...reviewsChecked.dropped];
      if (!dryRun) {
        if (filed.filed.length) saveBoard(dir, filed.board);
        if (reviewLines.length) {
          const file = join(dir, lib.PRIORITY_REVIEWS_RELPATH);
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, reviewLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
        }
      }
      const filedCards = filed.filed.map((id) => {
        const c = filed.board.cards.find((x) => x.id === id);
        return { id, title: c.title };
      });
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            { filed: filedCards, skipped: filed.skipped, reviews: reviewLines, droppedReviews, unresolved: ideaCheck.dropped, usd: cost.usd, usdSource: cost.usdSource, dryRun },
            null,
            2
          ) + "\n"
        );
        break;
      }
      const out = [];
      for (const c of filedCards) out.push(`${dryRun ? "would file" : "filed"} ${c.id}: ${c.title}`);
      for (const s2 of filed.skipped) out.push(`skipped ${s2.id}: ${s2.reason}`);
      for (const u of ideaCheck.dropped) out.push(`skipped ${u.id}: unresolved citation`);
      for (const r of reviewLines) out.push(`${dryRun ? "would record" : "recorded"} review: ${r.text} (${r.cards.join(", ")})`);
      out.push(
        `${dryRun ? "Would file" : "Filed"} ${filedCards.length} idea cards to Backlog, ${filed.skipped.length + ideaCheck.dropped.length} skipped, ${reviewLines.length} reviews kept, ${droppedReviews.length} dropped; ${costLine(cost.usd, cost.usdSource)}`
      );
      process.stdout.write(out.join("\n") + "\n");
      break;
    }
    case "model": {
      const usage = "usage: memory.mjs model regen [dir] [--claude-bin <path>] [--model <name>] [--max-usd <n>] [--dry-run] [--json] | memory.mjs model show [dir]";
      const [sub, ...subrest] = rest;
      if (sub !== "regen" && sub !== "show") fail(usage, 2);
      const dir = dirFrom(subrest, 0);
      const lib = await import("../lib/memory.mjs");
      const modelPath = join(dir, lib.PROJECT_MODEL_RELPATH);
      if (sub === "show") {
        if (!existsSync(modelPath)) fail(`no project model at ${lib.PROJECT_MODEL_RELPATH}: run \`memory.mjs model regen\``);
        process.stdout.write(readFileSync(modelPath, "utf8"));
        break;
      }
      const models = loadModels(dir);
      const model = textOrNull(opts.model) || (models.tiers.cheap && models.tiers.cheap.model) || "haiku";
      let maxUsd = 0.5;
      if (opts["max-usd"] !== undefined) {
        maxUsd = Number(opts["max-usd"]);
        if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail(`${usage}\n--max-usd must be a positive number, got ${JSON.stringify(opts["max-usd"])}.`, 2);
      }
      const claudeBin = textOrNull(opts["claude-bin"]) || process.env.DOUG_CLAUDE_BIN || "claude";
      const dryRun = !!opts["dry-run"];
      if (!existsSync(lib.memoryPath(dir))) fail("no memory store: nothing to build a project model from");
      const m = lib.openMemory(dir);
      let call;
      let checked;
      let dryPrompt = null;
      try {
        const lessons = lib.listLessons(m);
        const prompt = lib.buildProjectModelPrompt({ lessons, runs: lib.listRunHistoryRefs(dir) });
        if (dryRun) {
          dryPrompt = prompt;
        } else {
          try {
            call = await makePropose({ claudeBin, model, maxUsd, dir, schema: lib.PROJECT_MODEL_SCHEMA, resultKey: "statements" })(prompt);
          } catch (err) {
            fail(`model regen: the model call failed: ${err.message}`);
          }
          checked = lib.checkProjectModelCitations(m, dir, call.statements);
        }
      } finally {
        m.close();
      }
      if (dryRun) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ path: modelPath, dryRun: true, prompt: dryPrompt, usd: 0, usdSource: "none" }, null, 2) + "\n");
        } else {
          process.stdout.write(`(dry run) no model call; the prompt that would be sent:\n${dryPrompt}\n`);
          process.stdout.write(`Would write ${lib.PROJECT_MODEL_RELPATH} from the model's statements; ${costLine(0, "none")}\n`);
        }
        break;
      }
      const cost = lib.computeReflectCost({ dir, sessionId: call.sessionId, totalCostUsd: call.totalCostUsd });
      const rendered = lib.renderProjectModel(checked.kept);
      const counts = `dropped ${checked.dropped.length} unresolved, ${rendered.overCap.length} over cap`;
      if (!rendered.kept.length) {
        fail(`model regen: nothing was written: no statement survived (${call.statements.length} proposed; ${counts}); ${costLine(cost.usd, cost.usdSource)}`);
      }
      if (!dryRun) {
        mkdirSync(dirname(modelPath), { recursive: true });
        writeFileSync(modelPath, rendered.text, "utf8");
      }
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              path: modelPath,
              statements: rendered.kept.length,
              chars: rendered.chars,
              cap: lib.PROJECT_MODEL_CHAR_CAP,
              unresolved: checked.dropped.length,
              overCap: rendered.overCap.length,
              dropped: checked.dropped,
              usd: cost.usd,
              usdSource: cost.usdSource,
              dryRun,
            },
            null,
            2
          ) + "\n"
        );
        break;
      }
      if (dryRun) process.stdout.write(rendered.text + "\n");
      process.stdout.write(
        `${dryRun ? "Would write" : "Wrote"} ${lib.PROJECT_MODEL_RELPATH}: ${rendered.kept.length} statements, ${rendered.chars} characters (cap ${lib.PROJECT_MODEL_CHAR_CAP}); ${counts}; ${costLine(cost.usd, cost.usdSource)}\n`
      );
      break;
    }
    case "doctor": {
      const dir = dirFrom(rest, 0);
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ embeddings: cfg.embeddings, probe }, null, 2) + "\n");
      } else {
        process.stdout.write(doctorReport(cfg, probe) + "\n");
      }
      break;
    }
    case "embed-check": {
      const usage = "usage: memory.mjs embed-check [dir] [--pairs <file>] [--json]";
      // Validated before the provider check below (card memory-docs-drift #1): a usage error must exit 2 with
      // no provider needed, never surface as the provider's own exit-1 "not configured" message.
      for (const key of Object.keys(opts)) {
        if (key !== "pairs" && key !== "json") fail(`${usage}\n--${key} is not a recognized flag.`, 2);
      }
      if (opts.pairs !== undefined && (opts.pairs === "" || String(opts.pairs).startsWith("--"))) {
        fail(`${usage}\n--pairs requires a value.`, 2);
      }
      if (rest.length > 1) {
        fail(`${usage}\nexpected at most one positional argument (dir), got ${rest.length}.`, 2);
      }
      const dir = dirFrom(rest, 0);
      const provider = createProvider(readMemoryConfig(dir));
      if (!provider) {
        fail("no embedding provider configured (memory.embeddings in .doug/config.json is unset); nothing to check. Run `memory.mjs doctor` for how to enable one.", 1);
      }
      const pairs = loadPairsOrFail(opts);
      const result = await checkEmbeddingSanity(provider, pairs);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(sanityLine(result) + "\n");
      }
      if (!result.ok) process.exit(1);
      break;
    }
    case "reembed": {
      const usage = "usage: memory.mjs reembed [dir] [--batch <n>] [--check] [--no-check] [--pairs <file>] [--json]";
      const dir = dirFrom(rest, 0);
      const provider = createProvider(readMemoryConfig(dir));
      if (!provider) {
        fail("no embedding provider configured (memory.embeddings in .doug/config.json is unset); nothing to reembed. Run `memory.mjs doctor` for how to enable one.", 1);
      }
      let batch;
      if (opts.batch !== undefined) {
        batch = Number(opts.batch);
        if (!Number.isInteger(batch) || batch < 1) {
          fail(`${usage}\n--batch must be an integer >= 1, got ${JSON.stringify(opts.batch)}.`, 2);
        }
      }
      if (opts.check && opts["no-check"]) {
        fail(`${usage}\n--check and --no-check are mutually exclusive.`, 2);
      }
      const { openMemory, embedLessons, lessonsNeedingEmbedding, LIVE_LESSON_SQL } = await import("../lib/memory.mjs");
      const m = openMemory(dir);
      let result;
      let checkStatus;
      let stillMissing = 0;
      let liveTotal = 0;
      try {
        if (opts["no-check"]) {
          process.stderr.write("embed-check: skipped (--no-check)\n");
          checkStatus = "skipped";
        } else if (opts.check || embeddingChangeDetected(m, provider, LIVE_LESSON_SQL)) {
          const pairs = loadPairsOrFail(opts);
          const check = await checkEmbeddingSanity(provider, pairs);
          if (!check.ok) {
            process.stdout.write(sanityLine(check) + "\n");
            throw new Error(
              "embed-check failed; refusing to reembed. Pass --no-check to skip (see docs/memory.md), or --pairs to point at a different pairs file."
            );
          }
          checkStatus = "ok";
        } else {
          checkStatus = "not-needed";
        }
        result = await embedLessons(m, provider, {
          batch,
          onProgress: ({ embedded, total }) => process.stderr.write(`embedded ${embedded}/${total}\n`),
        });
        stillMissing = lessonsNeedingEmbedding(m, { model: provider.model, dims: provider.dims }).length;
        liveTotal = m.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE ${LIVE_LESSON_SQL}`).get().n;
      } finally {
        m.close();
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ...result, check: checkStatus }, null, 2) + "\n");
      } else {
        process.stdout.write(
          `Embedded ${result.embedded}/${result.total} lesson(s) with ${provider.model}/${provider.dims} (${result.failed} failed).\n`
        );
      }
      if (stillMissing > 0) {
        process.stderr.write(
          `WARNING: ${stillMissing} of ${liveTotal} lessons still have no vector for ${provider.model}/${provider.dims}; retry with memory.mjs reembed --batch 4\n`
        );
      }
      break;
    }
    case "index": {
      const [sub, ...subrest] = rest;
      if (sub === "build") {
        const usage = "usage: memory.mjs index build [dir] [--batch <n>] [--check] [--no-check] [--pairs <file>] [--json]";
        if (opts.check && opts["no-check"]) {
          fail(`${usage}\n--check and --no-check are mutually exclusive.`, 2);
        }
        let batch;
        if (opts.batch !== undefined) {
          batch = Number(opts.batch);
          if (!Number.isInteger(batch) || batch < 1) {
            fail(`${usage}\n--batch must be an integer >= 1, got ${JSON.stringify(opts.batch)}.`, 2);
          }
        }
        const dir = dirFrom(subrest, 0);
        const cfg = readIndexConfig(dir);
        const provider = createProvider(readMemoryConfig(dir));
        // Tri-state: false skips the sanity gate entirely (--no-check); "force" runs it on this build regardless
        // of whether the model/dims pair is new (--check); true (default) leaves buildIndex's own auto-detect in
        // charge, the same "new to this store" gate reembed applies to lessons.
        const check = opts["no-check"] ? false : opts.check ? "force" : true;
        const pairs = check === false ? null : loadIndexPairs(opts);
        const { openMemory } = await import("../lib/memory.mjs");
        const { buildIndex } = await import("../lib/code-index.mjs");
        const m = openMemory(dir);
        let result;
        try {
          result = await buildIndex(m, dir, {
            cfg,
            provider,
            batch,
            check,
            pairs,
            onProgress: ({ embedded, total }) => process.stderr.write(`indexed ${embedded}/${total}\n`),
          });
        } finally {
          m.close();
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          const pending = result.chunksEmbedded + result.chunksFailed;
          const keywordOnly = !provider || result.check === "failed" || (pending > 0 && result.chunksEmbedded === 0);
          const base = `index: ${result.files} files, ${result.chunks} chunks (${result.filesChanged} changed, ${result.filesRemoved} removed)`;
          if (keywordOnly) {
            process.stdout.write(`${base}; keyword-only (${result.reason})\n`);
          } else {
            // review MINOR 2: print embedSeconds to one decimal, the same way `status` prints its own seconds.
            // review MINOR 3: a partial failure (some batches embedded, some failed) must never hide the
            // provider's reason - it stays out of `reason` only when nothing at all embedded (the keyword-only
            // branch above already reports it there).
            let line = `${base}; embedded ${result.chunksEmbedded} of ${pending} under ${provider.model}/${provider.dims} in ${result.embedSeconds.toFixed(1)}s`;
            if (result.chunksFailed > 0) line += `; ${result.chunksFailed} failed (${result.reason})`;
            process.stdout.write(line + "\n");
          }
        }
        break;
      }
      if (sub === "status") {
        const dir = dirFrom(subrest, 0);
        const cfg = readIndexConfig(dir);
        const provider = createProvider(readMemoryConfig(dir));
        const { openMemory } = await import("../lib/memory.mjs");
        const { indexStatus } = await import("../lib/code-index.mjs");
        const m = openMemory(dir);
        let result;
        try {
          result = indexStatus(m, dir, { cfg, provider });
        } finally {
          m.close();
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          const lines = [
            `index: ${result.files} files, ${result.chunks} chunks, ${result.textBytes} bytes of text, ${result.dbBytes} bytes on disk`,
            provider
              ? `embedded: ${result.embedded}/${result.chunks} under ${provider.model}/${provider.dims}`
              : "embedded: none (no provider configured)",
            result.built
              ? `built: ${result.built.finished} at ${result.built.headSha ?? "unknown"} (${result.built.current ? "current" : "behind HEAD"})`
              : "built: never",
          ];
          // review MINOR 1: use indexStatus's own carried `rate` rather than recomputing chunksToEmbed/seconds
          // (which is meaningless, and prints "about 0.0s at 0.0 chunks/s", when nothing is pending at all); with
          // nothing pending, print "0 chunks to embed" and skip the time clause entirely.
          const r = result.refresh;
          const prefix = `refresh: ${r.added} added, ${r.changed} changed, ${r.removed} removed; `;
          let refreshLine;
          if (r.chunksToEmbed === 0) {
            refreshLine = `${prefix}0 chunks to embed`;
          } else if (r.seconds !== null) {
            refreshLine = `${prefix}${r.chunksToEmbed} chunks to embed, about ${r.seconds.toFixed(1)}s at ${r.rate.toFixed(1)} chunks/s`;
          } else {
            refreshLine = `${prefix}${r.chunksToEmbed} chunks to embed, time unmeasured (${r.rateReason})`;
          }
          lines.push(refreshLine);
          process.stdout.write(lines.join("\n") + "\n");
        }
        break;
      }
      if (sub === "search") {
        const usage = "usage: memory.mjs index search <query> [dir] [--files <glob,glob>] [--k <n>] [--json]";
        const [query, ...extra] = subrest;
        if (!query) fail(usage, 2);
        const dir = dirFrom(extra, 0);
        const files = opts.files
          ? String(opts.files)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        let k;
        if (opts.k !== undefined) {
          k = Number(opts.k);
          if (!Number.isInteger(k) || k < 1) {
            fail(`${usage}\n--k must be an integer >= 1, got ${JSON.stringify(opts.k)}.`, 2);
          }
        }
        const provider = createProvider(readMemoryConfig(dir));
        const { openMemory, degradedWarning, detectLocalProvider } = await import("../lib/memory.mjs");
        const { searchIndex } = await import("../lib/code-index.mjs");
        const detectedProvider = provider ? null : await detectLocalProvider();
        const m = openMemory(dir);
        let result;
        try {
          result = await searchIndex(m, query, { k, files, provider, detectedProvider });
        } finally {
          m.close();
        }
        const searchWarning = degradedWarning(result, { what: "code index search", code: true, detectedProvider });
        if (searchWarning) process.stderr.write(searchWarning + "\n");
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          const header =
            result.mode === "hybrid"
              ? `index: hybrid via ${result.provider} ${provider.model}/${provider.dims}`
              : `index: keyword-only (${result.reason})`;
          const lines = [
            header,
            ...result.chunks.map((c) => {
              const firstLine = c.text.split("\n").find((l) => l.trim()) || "";
              const snippet = firstLine.trim().slice(0, 80);
              return `${c.path}:${c.startLine}-${c.endLine}  ${c.score.toFixed(4)}  ${snippet}`;
            }),
          ];
          process.stdout.write(lines.join("\n") + "\n");
        }
        break;
      }
      fail("usage: memory.mjs index <build|status|search> ...", 2);
      break;
    }
    case "decision": {
      const usage =
        "usage: memory.mjs decision propose --title <text> --file <path> [--date YYYY-MM-DD] [dir] [--json]\n" +
        "       memory.mjs decision amend <NNNN> (--text <text> | --file <path>) [--date YYYY-MM-DD] [dir] [--json]";
      const [sub, ...subrest] = rest;
      const { proposeDecision, proposeAmendment } = await import("../lib/decisions.mjs");
      if (sub === "propose") {
        if (!opts.title || !opts.file) fail(usage, 2);
        const dir = dirFrom(subrest, 0);
        const result = proposeDecision({ dir, title: opts.title, body: readTextArg(opts.file), date: textOrNull(opts.date) || today() });
        printProposalResult(result, opts.json);
        break;
      }
      if (sub === "amend") {
        const [id, ...idRest] = subrest;
        if (!id || (!opts.text && !opts.file)) fail(usage, 2);
        const dir = dirFrom(idRest, 0);
        const text = opts.file ? readTextArg(opts.file) : opts.text;
        const result = proposeAmendment({ dir, id, text, date: textOrNull(opts.date) || today() });
        printProposalResult(result, opts.json);
        break;
      }
      fail(usage, 2);
      break;
    }
    case "rule": {
      const usage = "usage: memory.mjs rule propose <name> --file <path> [--paths <glob,glob>] [dir] [--json]";
      const [sub, ...subrest] = rest;
      if (sub !== "propose") fail(usage, 2);
      const [name, ...nameRest] = subrest;
      if (!name || !opts.file) fail(usage, 2);
      const dir = dirFrom(nameRest, 0);
      const paths = opts.paths
        ? String(opts.paths)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const { proposeRule } = await import("../lib/decisions.mjs");
      const result = proposeRule({ dir, name, paths, body: readTextArg(opts.file) });
      printProposalResult(result, opts.json);
      break;
    }
    case "condition": {
      const usage = "usage: memory.mjs condition open <card-id> [dir] [--json]\n       memory.mjs condition backfill [dir] [--json]";
      const [sub, ...subrest] = rest;
      if (sub === "open") {
        const [id, ...idRest] = subrest;
        if (!id) fail(usage, 2);
        const dir = dirFrom(idRest, 0);
        let card;
        try {
          const board = loadBoard(dir);
          card = findCard(board, id);
        } catch (err) {
          fail(`cannot open condition for "${id}": ${err.message}`);
        }
        if (!card.class) {
          fail(`cannot open condition for "${id}": the card has no class; give it one on the board first.`);
        }
        const relFile = `.doug/.state/reports/${id}/condition.json`;
        const file = join(dir, relFile);
        if (existsSync(file)) {
          fail(`${relFile} already exists; refusing to overwrite. Remove it first if you mean to reopen this landing's condition.`);
        }
        const headRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
        if (headRes.status !== 0 || !headRes.stdout.trim()) {
          fail(`cannot open condition for "${id}": no git HEAD in ${dir}${headRes.stderr && headRes.stderr.trim() ? ` (${headRes.stderr.trim()})` : " (not a git repository, or no commits yet)"}.`);
        }
        const { conditionConfigHash, memoryConfig } = await import("../lib/memory.mjs");
        const written = {
          harnessCommit: headRes.stdout.trim(),
          configHash: conditionConfigHash(dir),
          class: card.class,
          arm: `${card.class}/default`,
          assignedBy: "policy",
          exploreProbability: null,
          openedAt: new Date().toISOString(),
          memoryConfig: memoryConfig({ embeddings: readMemoryConfig(dir).embeddings, staleDays: readMemoryStaleDays(dir), track: "hand" }),
        };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(written, null, 2) + "\n");
        if (opts.json) {
          process.stdout.write(JSON.stringify(written, null, 2) + "\n");
        } else {
          process.stdout.write(`Wrote ${relFile}\n`);
        }
        break;
      }
      if (sub === "backfill") {
        const dir = dirFrom(subrest, 0);
        let board = null;
        try {
          board = loadBoard(dir);
        } catch {
          board = null;
        }
        // `main` must resolve before the per-row loop: without this, a missing repo or a missing `main` ref
        // makes every `git log` call below fail the same way an honest "no commit at or before this row's
        // timestamp" does (empty stdout), so every row would be silently, wrongly left uncounted with no word
        // said about why. Checked once, not once per row.
        const mainRes = spawnSync("git", ["rev-parse", "--verify", "--quiet", "main^{commit}"], { cwd: dir, encoding: "utf8" });
        const hasMain = mainRes.status === 0;
        if (!hasMain) {
          process.stderr.write(`no "main" ref in ${dir}; nothing to backfill against.\n`);
        }
        const { openMemory } = await import("../lib/memory.mjs");
        const m = openMemory(dir);
        let backfilled = 0;
        try {
          if (hasMain) {
            const rows = m.prepare("SELECT id, recorded, card FROM outcomes WHERE harness_commit IS NULL").all();
            for (const row of rows) {
              const gitRes = spawnSync(
                "git",
                ["log", "-1", "--first-parent", "--format=%H", `--before=${row.recorded}`, "main", "--"],
                { cwd: dir, encoding: "utf8" }
              );
              const sha = gitRes.status === 0 ? gitRes.stdout.trim() : "";
              if (!sha) continue;
              let cardClass = null;
              if (board && row.card) {
                try {
                  cardClass = findCard(board, row.card).class ?? null;
                } catch {
                  cardClass = null;
                }
              }
              m.prepare("UPDATE outcomes SET harness_commit = ?, backfilled = 1, class = COALESCE(?, class) WHERE id = ?").run(sha, cardClass, row.id);
              backfilled++;
            }
          }
        } finally {
          m.close();
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify({ backfilled }, null, 2) + "\n");
        } else {
          process.stdout.write(`Backfilled ${backfilled} outcomes rows with a harness commit.\n`);
        }
        break;
      }
      fail(usage, 2);
      break;
    }
    case "claude-md": {
      const usage = "usage: memory.mjs claude-md propose --file <path|-> [dir] [--json]";
      const [sub, ...subrest] = rest;
      if (sub !== "propose" || !opts.file) fail(usage, 2);
      const dir = dirFrom(subrest, 0);
      let edits;
      try {
        edits = JSON.parse(readTextArg(opts.file));
      } catch (err) {
        fail(`${opts.file} is not valid JSON: ${err.message}`, 1);
      }
      const { proposeClaudeMd } = await import("../lib/decisions.mjs");
      const result = proposeClaudeMd({ dir, edits });
      printProposalResult(result, opts.json);
      break;
    }
    default:
      fail("usage: memory.mjs <record|reflect|job|outcomes|arms|lessons|lesson|history|model|import|recall|brief-lessons|doctor|reembed|embed-check|index|condition|decision|rule|claude-md> ...", 2);
  }
} catch (err) {
  fail(err.message);
}
