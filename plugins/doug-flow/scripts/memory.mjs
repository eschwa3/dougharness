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
//   memory.mjs record <card-id> --hand [dir] --commit <sha> [--wall <text>] [--gate <text>] [--note <text>] [--json]
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
//   memory.mjs condition open <card-id> [dir] [--json]
//                                                 (card outcomes-condition-columns) writes
//                                                 .doug/.state/reports/<card-id>/condition.json: harnessCommit
//                                                 (git HEAD), configHash (conditionConfigHash: .doug/config.json
//                                                 plus the CLAUDE.md Models table text), class and arm
//                                                 (<class>/default) from the card's board record, assignedBy
//                                                 "policy", exploreProbability null, openedAt. Refuses (exit 1,
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
//   memory.mjs lessons [dir] [--search <text>] [--k <n>] [--all] [--json]
//                                                 list lessons, or full-text search them (--search); --all
//                                                 includes superseded rows
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
//   memory.mjs recall <query> [dir] [--files <glob,glob>] [--k <n>] [--json]
//                                                 hybrid recall (card memory-recall): BM25 over FTS5 fused by
//                                                 reciprocal rank fusion with cosine over stored vectors when a
//                                                 provider is configured and vectors exist for it, recency-
//                                                 weighted, scope-boosted by --files, each returned lesson's
//                                                 citation re-checked against [dir] only when [dir] is a real
//                                                 project root (contains .doug); keyword-only, and says so, when
//                                                 no provider is configured or no vectors match it
//   memory.mjs reflect <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>]
//                       [--adversary "<id>=<class>[: <reason>]"]... [--claude-bin <path>] [--claude-dir <path>]
//                       [--model <name>] [--max-usd <n>] [--dry-run] [--json]
//                                                 runs after record: applies deterministic helpful/harmful
//                                                 counters to lessons named in each task's memoryUsed (committed
//                                                 even if the LLM pass below fails), then a cheap-row `claude -p
//                                                 --json-schema` pass proposes at most 3 lessons from the report,
//                                                 filtered in code (a pitfall needs a block classed real, a
//                                                 pattern needs a first-pass verified task, the citation must be
//                                                 checkable, the text must not already be derivable from the
//                                                 checkout, and a near-duplicate bumps the existing lesson's
//                                                 helpful instead of appending); idempotent on the report's
//                                                 sha256 (a second reflect on the same report is a no-op, exit
//                                                 0); --dry-run applies nothing but still runs the LLM pass and
//                                                 prints what would happen; --hand is refused, since a hand
//                                                 landing has no report. Cost is measured from the same local
//                                                 transcripts cost.mjs reads, falling back to the CLI's own
//                                                 cost estimate. Needs Node >=22.16 (node:sqlite).
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
//                                                 block, or would push CLAUDE.md over 60 lines. Approve and write
//                                                 it with `learn.mjs apply <diff>`
// lesson add and import embed only the row(s) they just wrote, best-effort, when a provider is configured: a
// provider failure prints one stderr line and never turns into a nonzero exit for that add/import. A pending
// row from an earlier add is left alone until `reembed` (or a later add/import) picks it up.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseAdversaryClasses, loadBoard, findCard } from "../lib/board.mjs";
import { loadPlan, unwrapReport } from "../lib/plan.mjs";
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
const FLAGS = new Set(["json", "all", "hand", "dry-run", "check", "no-check"]);
const REPEATABLE = new Set(["adversary"]);
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

function dirFrom(args, n) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || args[n] || process.cwd());
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
  if (embeddingChangeDetected(m, provider)) {
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
function makePropose({ claudeBin, model, maxUsd, dir }) {
  return async (prompt) => {
    const { REFLECT_SCHEMA } = await import("../lib/memory.mjs");
    const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(REFLECT_SCHEMA), "--model", model, "--max-budget-usd", String(maxUsd)];
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
    const lessons = envelope.structured_output && envelope.structured_output.lessons;
    if (!Array.isArray(lessons)) throw new Error("claude's structured_output.lessons is missing");
    return {
      lessons,
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
    `adversary ${adv} (${blocksText(row.blocks)} block(s))`,
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
function embeddingChangeDetected(m, provider) {
  const total = m.prepare("SELECT COUNT(*) AS n FROM lessons WHERE superseded_by IS NULL AND stale IS NULL").get().n;
  if (total === 0) return false;
  const matching = m
    .prepare("SELECT COUNT(*) AS n FROM lessons WHERE superseded_by IS NULL AND stale IS NULL AND embedding_model = ? AND embedding_dims = ?")
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
          'usage: memory.mjs record <card-id> --hand [dir] --commit <sha> [--wall <text>] [--gate <text>] [--note <text>] [--json]';
        const [id, ...extra] = rest;
        if (!id || !opts.commit) fail(handUsage, 2);
        if (id.endsWith(".json") || existsSync(resolve(id))) {
          fail(`${handUsage}\n--hand takes a card id, not a report.`, 2);
        }
        if (opts.run !== undefined || opts.adversary !== undefined || opts["claude-dir"] !== undefined || extra.length > 1) {
          fail(handUsage, 2);
        }
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
        const row = handOutcomeRow({ card: id, commit: opts.commit, wallClock: textOrNull(opts.wall), gate: textOrNull(opts.gate), note: textOrNull(opts.note), condition });
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
      const plan = loadPlan(dir);
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
      const { openMemory, recordOutcomes, outcomeRows } = await import("../lib/memory.mjs");
      const rows = outcomeRows(report, { plan, classes, run, reportHash, reportPath, card: opts.card ?? null, commit: opts.commit ?? null, cost });
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
        'usage: memory.mjs reflect <report.json> [dir] [--run <wf-id>] [--card <id>] [--commit <sha>] [--adversary "<id>=<class>[: <reason>]"]... [--claude-bin <path>] [--claude-dir <path>] [--model <name>] [--max-usd <n>] [--dry-run] [--json]';
      if (opts.hand) fail(`${usage}\n--hand is not accepted: a hand landing has no report.`, 2);
      const [reportFile] = rest;
      if (!reportFile) fail(usage, 2);
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
      const plan = loadPlan(dir);
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
      const propose = makePropose({ claudeBin, model, maxUsd, dir });
      const m = openMemory(dir);
      let result;
      try {
        result = await runReflect(m, report, {
          reportHash,
          dir,
          classes,
          plan,
          run: opts.run ?? null,
          card: opts.card ?? null,
          commit: opts.commit ?? null,
          model,
          claudeDir,
          dryRun,
          propose,
        });
        if (!dryRun && result.ok && result.appended && result.appended.length) {
          await bestEffortEmbed(m, dir, result.appended);
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
        process.stdout.write(
          `${prefix}Reflected on ${runLabel}: counters helpful +${c.helpful.length} (${idsList(c.helpful)}) harmful +${c.harmful.length} (${idsList(c.harmful)}); ` +
            `proposed ${result.proposed}, appended ${result.appended.length} (${idsList(result.appended)}), bumped ${result.bumped.length} (${idsList(result.bumped)}), ` +
            `rejected ${result.rejected.length}; model ${result.model}; ${costLine(result.usd, result.usdSource)}\n`
        );
        for (const r of result.rejected) {
          process.stdout.write(`  rejected ${r.text ? JSON.stringify(r.text) : "(no text)"}: ${r.reason}\n`);
        }
      }
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
    case "lessons": {
      const dir = dirFrom(rest, 0);
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
        "       memory.mjs lesson unstale <id> [dir] [--json]";
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
      const { openMemory, recallLessons } = await import("../lib/memory.mjs");
      const m = openMemory(dir);
      let result;
      try {
        result = await recallLessons(m, query, { files, k, provider, checkoutDir: dir, staleDays });
      } finally {
        m.close();
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const header =
          result.mode === "hybrid"
            ? `recall: hybrid via ${result.provider} ${provider.model}/${provider.dims}`
            : `recall: keyword-only (${result.reason})`;
        const lines = [header, ...result.lessons.map((l) => `${l.id}  ${l.score.toFixed(4)}  ${l.kind}  ${l.text}`)];
        process.stdout.write(lines.join("\n") + "\n");
      }
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
      const { openMemory, embedLessons } = await import("../lib/memory.mjs");
      const m = openMemory(dir);
      let result;
      let checkStatus;
      try {
        if (opts["no-check"]) {
          process.stderr.write("embed-check: skipped (--no-check)\n");
          checkStatus = "skipped";
        } else if (opts.check || embeddingChangeDetected(m, provider)) {
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
        const { openMemory } = await import("../lib/memory.mjs");
        const { searchIndex } = await import("../lib/code-index.mjs");
        const m = openMemory(dir);
        let result;
        try {
          result = await searchIndex(m, query, { k, files, provider });
        } finally {
          m.close();
        }
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
        const { conditionConfigHash } = await import("../lib/memory.mjs");
        const written = {
          harnessCommit: headRes.stdout.trim(),
          configHash: conditionConfigHash(dir),
          class: card.class,
          arm: `${card.class}/default`,
          assignedBy: "policy",
          exploreProbability: null,
          openedAt: new Date().toISOString(),
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
      fail("usage: memory.mjs <record|reflect|outcomes|lessons|lesson|import|recall|doctor|reembed|embed-check|index|condition|decision|rule|claude-md> ...", 2);
  }
} catch (err) {
  fail(err.message);
}
