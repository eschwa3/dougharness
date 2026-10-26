// Outcome log and lessons store for Doug (card memory-lib). The only module in the repository that loads
// node:sqlite or names DatabaseSync; every other module reaches this store through the functions exported here.
// Requires Node >=22.16 (node:sqlite with FTS5 built in, nodejs PR 57621); a wrong Node throws one clear error
// at load time rather than failing silently later.
//
// node:sqlite is experimental on this Node and logs an ExperimentalWarning on first load; we wrap
// process.emitWarning around the require so that one specific warning never reaches stderr, and restore the
// original emitWarning immediately after, so no other warning in the process is ever swallowed.
//
// `lessons` is add-only by design: rows are memory the harness has already staked decisions on, so a later card
// can supersede a lesson (superseded_by) but never delete or rewrite its text — two triggers on the table enforce
// that in the database itself, not just in this module's API.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, existsSync, readFileSync, statSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { classifyBlocks, adversaryBlocks, addCard } from "./board.mjs";
import { initialState, currentAction, next as cardLoopNext, briefPrompt } from "./card-loop.mjs";
import { transcriptUsage, projectSlug, CODEX_PRICES, CODEX_DEFAULT_MODEL } from "./cost.mjs";
import { MODELS_HEADING } from "./models.mjs";

let DatabaseSync;
{
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function (warning, type, ...rest) {
    const name = warning && warning.name ? warning.name : typeof type === "string" ? type : type && type.type;
    const message = warning && warning.message ? warning.message : String(warning);
    if (name === "ExperimentalWarning" && /SQLite/.test(message)) return;
    return originalEmitWarning.call(process, warning, type, ...rest);
  };
  try {
    const require = createRequire(import.meta.url);
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("memory needs Node >=22.16 for node:sqlite; this is Node " + process.versions.node);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

export const MEMORY_DB_RELPATH = ".doug/.state/memory/memory.db";

export function memoryPath(dir) {
  return `${dir}/${MEMORY_DB_RELPATH}`;
}

const LESSON_KINDS = ["feedback", "project", "pitfall", "pattern"];

// outcomes is one row per (run, task), UNIQUE(run, task). A flow row (track = 'flow') comes from a workflow
// report via outcomeRows/recordOutcomes, run keyed by the workflow run id or report:<hash>. A hand row
// (track = 'hand') comes from a hand-track landing via handOutcomeRow, run keyed 'hand:<commit>' so recording
// the same commit again updates the same row (idempotent) and a card landing in a second commit gets a second
// row. On a hand row the following columns are NULL because they do not exist on that track — never because
// they measured zero: run_id, spec_hash, files, size, shape, models, implemented, verified, reviewed,
// review_issues, review_issue_count, adversary_verdict, adversary_blocked, adversary_source, blocks, passes,
// fix_passes, stop_reason, stop_class, in_scope, budget_spent, tokens, codex_usd, report_hash, report_path, partial (usd too,
// except that a hand landing recorded with --cost carries its measured session cost there; card usd-budget-size-class). In particular
// verified is null on a hand row even though the gate passed: no independent verifier ran on that track, and
// the gate's own text lives in the `gate` column instead. A consumer that averages fix_passes or counts
// blocks across both tracks must filter on track. wall_clock, gate, and note only exist on a hand row; they
// are null on a flow row. Exception (card memory-outcome-arms): `reflect --hand --rounds <n>` (not a dry run)
// writes passes n and fix_passes n - 1 onto the landing's hand row; without --rounds both stay null, since the
// default of 1 round is not a measurement. A later `record --hand` of the same commit keeps those values (the
// upsert only replaces passes and fix_passes when the new row carries passes).
//
// memory_config (v10, card memory-outcome-arms): the canonical JSON (keys sorted) of the memoryConfig() the row
// ran under, copied from condition.json; null on an unstamped row. It travels with the condition columns. A flow
// row is stamped with memoryConfig({ track: "flow" }) (delivery "index+fetch" with fetchTokens, cards memory-flow-index-fetch, memory-atomic-lessons) when recorded
// through `memory.mjs record <report.json>`; a hand row carries the hand stamp (delivery "index+fetch").
//
// partial (v5, card worker-context-handoff): 1 when the task's own outcome was still partial after its one
// resume (graceful degradation on a context limit, never a verification failure), 0 when it was not, null on a
// hand row. A partial task's `verified` still reads whatever the report says (usually 0, since the checks never
// ran); read `partial` alongside it before treating a 0 there as a defect.
//
// harness_commit, config_hash, class, arm, assigned_by, explore_probability, backfilled (v7, card
// outcomes-condition-columns): which harness version and which experimental condition a row ran under, the
// prerequisite for any before-and-after comparison across harness changes. harness_commit is the HEAD sha at the
// moment the condition was opened (or, for a backfilled row, the last commit at or before the row's `recorded`
// timestamp); config_hash is conditionConfigHash(dir) (below) at that same moment, null on a backfilled row
// (there is nothing to recompute it from after the fact); class and arm name the card's class and the arm it
// ran under (`<class>/default` until exploration exists); assigned_by is `'policy'` or `'explore'`;
// explore_probability is the explore arm's assignment probability, null otherwise. backfilled is 1 only for a
// row `memory.mjs condition backfill` stamped after the fact, 0 for every other row (including an unstamped
// hand row, which has never been touched by either path).
// A stopped hand card report yields a stop row (stopOutcomeRow below): track 'hand', run 'stop:<report hash>', stop_class and
// stop_reason from the report, commit_sha null. On the flow track these seven columns are null: a flow
// row is never stamped by `condition open`/`record --hand` (its memory_config alone is stamped, see above).
const OUTCOMES_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY,
  recorded TEXT NOT NULL,
  run TEXT NOT NULL,
  run_id TEXT,
  report_hash TEXT,
  report_path TEXT,
  card TEXT,
  task TEXT NOT NULL,
  spec_hash TEXT,
  files TEXT,
  size TEXT,
  shape TEXT,
  models TEXT,
  implemented INTEGER,
  verified INTEGER,
  reviewed INTEGER,
  review_issues TEXT,
  review_issue_count INTEGER,
  adversary_verdict TEXT,
  adversary_blocked INTEGER,
  adversary_source TEXT,
  blocks TEXT NOT NULL DEFAULT '[]',
  passes INTEGER,
  fix_passes INTEGER,
  stop_reason TEXT,
  in_scope INTEGER,
  budget_spent TEXT,
  tokens TEXT,
  usd REAL,
  codex_usd REAL,
  stop_class TEXT,
  commit_sha TEXT,
  track TEXT NOT NULL DEFAULT 'flow',
  wall_clock TEXT,
  gate TEXT,
  note TEXT,
  partial INTEGER,
  harness_commit TEXT,
  config_hash TEXT,
  class TEXT,
  arm TEXT,
  assigned_by TEXT,
  explore_probability REAL,
  backfilled INTEGER NOT NULL DEFAULT 0,
  memory_config TEXT,
  UNIQUE(run, task)
`;

// stale (v3): an ISO date set when recallLessons's citation re-check fails against a checkout; a stale row is
// excluded from recall until a new lesson supersedes it. It is not in the no-rewrite trigger's column list
// below, same as confirmed/helpful/harmful/superseded_by/embedding*: those columns record the store learning
// about a lesson, never the lesson's own claim, which stays add-only.
const LESSONS_COLUMNS_SQL = `
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feedback','project','pitfall','pattern')),
  scope TEXT NOT NULL DEFAULT '[]',
  citation TEXT,
  source_agent TEXT NOT NULL,
  source_model TEXT,
  task TEXT,
  card TEXT,
  commit_sha TEXT,
  created TEXT NOT NULL,
  confirmed TEXT,
  helpful INTEGER NOT NULL DEFAULT 0,
  harmful INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT REFERENCES lessons(id),
  embedding_model TEXT,
  embedding_dims INTEGER,
  embedding BLOB,
  stale TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  archived TEXT,
  archived_reason TEXT
`;

const LESSONS_TRIGGERS_SQL = `
CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons
BEGIN
  SELECT RAISE(ABORT, 'lessons are add-only; supersede instead');
END;
CREATE TRIGGER lessons_no_rewrite BEFORE UPDATE OF text, kind, scope, citation, source_agent, source_model, task, card, commit_sha, created ON lessons
BEGIN
  SELECT RAISE(ABORT, 'lessons are never rewritten; supersede instead');
END;
`;

// reflections (v4): one row per report reflected on, keyed by the report's sha256 so a second `memory.mjs
// reflect` on the same report is a no-op (see runReflect). counters/appended/bumped/rejected are JSON columns
// (never denormalized into their own tables — this is a small append log, not a query surface). proposed is the
// LLM pass's raw proposal count before filtering; null on proposed means the LLM pass never completed (the row
// was inserted with the counters already applied, before the pass ran, and never updated after a crash).
const REFLECTIONS_COLUMNS_SQL = `
  report_hash TEXT PRIMARY KEY,
  recorded TEXT NOT NULL,
  run TEXT,
  card TEXT,
  commit_sha TEXT,
  model TEXT,
  counters TEXT NOT NULL,
  proposed INTEGER,
  appended TEXT,
  bumped TEXT,
  rejected TEXT,
  usd REAL,
  usd_source TEXT,
  session_id TEXT
`;

// code_files/code_chunks/code_chunks_fts/code_index_builds (v6, card semantic-index): the opt-in semantic code
// index lib/code-index.mjs builds and reads. Unlike lessons, this is a cache, not a record: buildIndex freely
// deletes and rewrites a chunk's row when its text changes, and no add-only trigger protects any of these four
// tables. A chunk's id is the first 16 hex of sha256(`${path}\n${content_hash}`), so a chunk whose text does not
// move keeps its row and its embedding across rebuilds even as its line range shifts. Vectors are stored exactly
// as lesson vectors are (see "Embeddings on lesson rows" below): Float32Array bytes, embedding_model/dims
// travelling with them, a query only ever comparing rows sharing the same pair. code_index_builds is one row per
// `memory.mjs index build`, the record indexStatus's refresh-cost estimate reads (embed_seconds and
// chunks_embedded on the most recent row with embed_seconds > 0 give the chunks/second rate).
const CODE_FILES_COLUMNS_SQL = `
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  indexed TEXT NOT NULL
`;

const CODE_CHUNKS_COLUMNS_SQL = `
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  indexed TEXT NOT NULL,
  embedding_model TEXT,
  embedding_dims INTEGER,
  embedding BLOB
`;

const CODE_INDEX_BUILDS_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY,
  started TEXT NOT NULL,
  finished TEXT NOT NULL,
  head_sha TEXT,
  files INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  files_changed INTEGER NOT NULL,
  chunks_embedded INTEGER NOT NULL,
  chunks_failed INTEGER NOT NULL,
  embed_seconds REAL,
  provider TEXT,
  model TEXT,
  dims INTEGER,
  reason TEXT
`;

const CODE_INDEX_SCHEMA_SQL = `
CREATE TABLE code_files (${CODE_FILES_COLUMNS_SQL});
CREATE TABLE code_chunks (${CODE_CHUNKS_COLUMNS_SQL});
CREATE VIRTUAL TABLE code_chunks_fts USING fts5(id UNINDEXED, path, text);
CREATE TABLE code_index_builds (${CODE_INDEX_BUILDS_COLUMNS_SQL});
`;

const SCHEMA_SQL = `
CREATE TABLE outcomes (${OUTCOMES_COLUMNS_SQL});
CREATE TABLE lessons (${LESSONS_COLUMNS_SQL});
CREATE VIRTUAL TABLE lessons_fts USING fts5(id UNINDEXED, text);
${LESSONS_TRIGGERS_SQL}
CREATE TABLE reflections (${REFLECTIONS_COLUMNS_SQL});
${CODE_INDEX_SCHEMA_SQL}
`;

// v1 had no track/wall_clock/gate/note columns and NOT NULL report_hash / review_issue_count. Migrating rebuilds
// the outcomes table under a temp name inside a transaction, carries the v1 columns across (the four new columns
// take their defaults, so every migrated row reads track = 'flow'), then drops the old table and renames.
const V1_OUTCOME_COLUMNS = [
  "id", "recorded", "run", "run_id", "report_hash", "report_path", "card", "task", "spec_hash", "files", "size",
  "shape", "models", "implemented", "verified", "reviewed", "review_issues", "review_issue_count",
  "adversary_verdict", "adversary_blocked", "adversary_source", "blocks", "passes", "fix_passes", "stop_reason",
  "in_scope", "budget_spent", "tokens", "usd", "commit_sha",
];

function migrateV1ToV2(db) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE outcomes_v2 (${OUTCOMES_COLUMNS_SQL});`);
    db.exec(
      `INSERT INTO outcomes_v2 (${V1_OUTCOME_COLUMNS.join(", ")}) SELECT ${V1_OUTCOME_COLUMNS.join(", ")} FROM outcomes;`
    );
    db.exec("DROP TABLE outcomes;");
    db.exec("ALTER TABLE outcomes_v2 RENAME TO outcomes;");
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v2 lessons had no `stale` column. Same transactional rebuild pattern as v1->v2; unlike outcomes, lessons
// carries two triggers, and SQLite drops a table's triggers when the table is dropped, so they are recreated
// against the renamed table before commit.
const V2_LESSON_COLUMNS = [
  "id", "text", "kind", "scope", "citation", "source_agent", "source_model", "task", "card", "commit_sha",
  "created", "confirmed", "helpful", "harmful", "superseded_by", "embedding_model", "embedding_dims", "embedding",
];

function migrateV2ToV3(db) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE lessons_v3 (${LESSONS_COLUMNS_SQL});`);
    db.exec(
      `INSERT INTO lessons_v3 (${V2_LESSON_COLUMNS.join(", ")}) SELECT ${V2_LESSON_COLUMNS.join(", ")} FROM lessons;`
    );
    db.exec("DROP TABLE lessons;");
    db.exec("ALTER TABLE lessons_v3 RENAME TO lessons;");
    db.exec(LESSONS_TRIGGERS_SQL);
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v3 had no reflections table. Unlike v1->v2 and v2->v3, nothing existing is rebuilt: adding a table needs no
// rebuild-under-a-temp-name dance, just the CREATE plus the version bump, in the same transactional pattern.
function migrateV3ToV4(db) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE reflections (${REFLECTIONS_COLUMNS_SQL});`);
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v4 had no `partial` column on outcomes (card worker-context-handoff). Additive like v3->v4: no rebuild under a
// temp name, just the ALTER and the version bump. Existing rows read partial = NULL (they predate the concept).
// The column may already be there: OUTCOMES_COLUMNS_SQL is the one shared "current schema" constant, so a v1
// store's rebuild in migrateV1ToV2 (which uses it) already carries every column added since, partial included;
// this guard makes the step a no-op there instead of a duplicate-column error, while still doing the ALTER for a
// genuine v4 store that only ever had the v4 columns.
function migrateV4ToV5(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    if (!cols.includes("partial")) db.exec("ALTER TABLE outcomes ADD COLUMN partial INTEGER;");
    db.exec("PRAGMA user_version = 5");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v5 had no code index tables (card semantic-index). Additive like v3->v4: no rebuild under a temp name, just
// the four CREATEs and the version bump. No add-only trigger is added for these tables — the code index is a
// cache, never add-only.
function migrateV5ToV6(db) {
  db.exec("BEGIN");
  try {
    db.exec(CODE_INDEX_SCHEMA_SQL);
    db.exec("PRAGMA user_version = 6");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v6 had none of the seven condition columns on outcomes (card outcomes-condition-columns). Additive like
// v4->v5: no rebuild under a temp name, just the guarded ALTERs and the version bump. Each column's guard mirrors
// migrateV4ToV5's: OUTCOMES_COLUMNS_SQL already carries every column added since for a v1 store's rebuild in
// migrateV1ToV2, so this step must be a no-op there instead of a duplicate-column error, while still doing the
// ALTERs for a genuine v6 store.
const V7_CONDITION_COLUMNS = [
  ["harness_commit", "TEXT"],
  ["config_hash", "TEXT"],
  ["class", "TEXT"],
  ["arm", "TEXT"],
  ["assigned_by", "TEXT"],
  ["explore_probability", "REAL"],
  ["backfilled", "INTEGER NOT NULL DEFAULT 0"],
];

function migrateV6ToV7(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    for (const [name, type] of V7_CONDITION_COLUMNS) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE outcomes ADD COLUMN ${name} ${type};`);
    }
    db.exec("PRAGMA user_version = 7");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v7 had no codex_usd column on outcomes (card run-report-codex-cost): the Codex adversary's own cost, priced
// separately from Claude's usd and never folded into it. Additive like v6->v7: one guarded ALTER, then the
// version bump. The guard mirrors migrateV6ToV7's: OUTCOMES_COLUMNS_SQL already carries codex_usd for a v1
// store's rebuild in migrateV1ToV2, so this step must be a no-op there instead of a duplicate-column error,
// while still doing the ALTER for a genuine v7 store.
const V8_CODEX_COLUMNS = [["codex_usd", "REAL"]];

function migrateV7ToV8(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    for (const [name, type] of V8_CODEX_COLUMNS) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE outcomes ADD COLUMN ${name} ${type};`);
    }
    db.exec("PRAGMA user_version = 8");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v8 had no stop_class column on outcomes (card memory-stop-class): the typed cause of a stop, from
// task.stopClass, so stops can be counted by cause across runs. Additive like v7->v8: one guarded ALTER, then
// the version bump; old rows stay null. OUTCOMES_COLUMNS_SQL carries stop_class for a v1 store's rebuild, so
// this step is a no-op there instead of a duplicate-column error.
const V9_STOP_COLUMNS = [["stop_class", "TEXT"]];

function migrateV8ToV9(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    for (const [name, type] of V9_STOP_COLUMNS) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE outcomes ADD COLUMN ${name} ${type};`);
    }
    db.exec("PRAGMA user_version = 9");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v9 had no memory_config column on outcomes (card memory-outcome-arms): the canonical JSON of the memory
// configuration a row ran under, copied from condition.json's memoryConfig. Additive like v8->v9: one guarded
// ALTER, then the version bump; old rows stay null. OUTCOMES_COLUMNS_SQL carries memory_config for a v1 store's
// rebuild, so this step is a no-op there instead of a duplicate-column error.
const V10_MEMORY_COLUMNS = [["memory_config", "TEXT"]];

function migrateV9ToV10(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    for (const [name, type] of V10_MEMORY_COLUMNS) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE outcomes ADD COLUMN ${name} ${type};`);
    }
    db.exec("PRAGMA user_version = 10");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v10 had no seen column on lessons (card memory-reflect-supersede): how many times a reflect pass judged a
// proposal a repeat of the lesson. One guarded ALTER (LESSONS_COLUMNS_SQL already carries seen for a rebuilt
// store), then the version bump. seen is not in the no-rewrite trigger's column list.
function migrateV10ToV11(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(lessons)").all().map((c) => c.name);
    if (!cols.includes("seen")) db.exec("ALTER TABLE lessons ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;");
    db.exec("PRAGMA user_version = 11");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v11 had no archived status on lessons (card memory-feedback-rank): archived is an ISO time (NULL = live) and
// archived_reason names the counters that met the archive rule. Two guarded ALTERs (LESSONS_COLUMNS_SQL already
// carries both for a rebuilt store), then the version bump. Neither is in the no-rewrite trigger's column list,
// and the no-delete trigger is unchanged: an archived row is kept.
function migrateV11ToV12(db) {
  db.exec("BEGIN");
  try {
    const cols = db.prepare("PRAGMA table_info(lessons)").all().map((c) => c.name);
    if (!cols.includes("archived")) db.exec("ALTER TABLE lessons ADD COLUMN archived TEXT;");
    if (!cols.includes("archived_reason")) db.exec("ALTER TABLE lessons ADD COLUMN archived_reason TEXT;");
    db.exec("PRAGMA user_version = 12");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function openMemory(dir) {
  const file = memoryPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version === 0) {
    db.exec(SCHEMA_SQL);
    db.exec("PRAGMA user_version = 12");
  } else if (version === 1) {
    migrateV1ToV2(db);
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 2) {
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 3) {
    migrateV3ToV4(db);
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 4) {
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 5) {
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 6) {
    migrateV6ToV7(db);
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 7) {
    migrateV7ToV8(db);
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 8) {
    migrateV8ToV9(db);
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 9) {
    migrateV9ToV10(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 10) {
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  } else if (version === 11) {
    migrateV11ToV12(db);
  } else if (version !== 12) {
    db.close();
    throw new Error(`memory store ${file} is user_version ${version}; this code understands up to version 12`);
  }
  return {
    file,
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      return db.prepare(sql);
    },
    close() {
      db.close();
    },
  };
}

// Read-only probe for `doug doctor`: can this Node build an FTS5 table in memory? Never throws.
export function probeSqliteFts5() {
  try {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)");
    } finally {
      db.close();
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

// Read-only look at the store for `doug doctor`: creates nothing, migrates nothing, never throws.
export function inspectMemory(dir) {
  const file = memoryPath(dir);
  const out = { file, exists: false, userVersion: null, maxUserVersion: 12, quickCheck: null, error: null };
  if (!existsSync(file)) return out;
  out.exists = true;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    out.userVersion = db.prepare("PRAGMA user_version").get().user_version;
    out.quickCheck = String(db.prepare("PRAGMA quick_check").get().quick_check);
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  } finally {
    try {
      if (db) db.close();
    } catch {
      // already unusable
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function asJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toIntOrNull(value) {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function lessonRowToObject(row) {
  if (!row) return null;
  return { ...row, scope: parseJsonColumn(row.scope, []) };
}

function computeLessonId({ kind, citation, text }) {
  const hash = createHash("sha256").update(`${kind}\n${citation || ""}\n${text}`).digest("hex");
  return hash.slice(0, 16);
}

export function addLesson(m, opts) {
  const { text, kind, scope = [], citation = null, source, task = null, card = null, commit = null, created = nowIso(), id } = opts || {};
  if (typeof text !== "string" || !text.trim()) throw new Error("addLesson requires non-empty text");
  if (!LESSON_KINDS.includes(kind)) throw new Error(`addLesson kind must be one of ${LESSON_KINDS.join(", ")}, got ${kind}`);
  if (!Array.isArray(scope) || scope.some((s) => typeof s !== "string")) throw new Error("addLesson scope must be an array of strings");
  if (!source || typeof source.agent !== "string" || !source.agent.trim()) throw new Error("addLesson requires source.agent");
  const lessonId = id || computeLessonId({ kind, citation, text });
  const existing = getLesson(m, lessonId);
  if (existing) throw new Error(`lesson ${lessonId} already exists`);
  const row = {
    id: lessonId,
    text,
    kind,
    scope: asJson(scope, []),
    citation,
    source_agent: source.agent,
    source_model: source.model ?? null,
    task,
    card,
    commit_sha: commit,
    created,
  };
  m.exec("BEGIN");
  try {
    m.prepare(
      `INSERT INTO lessons (id, text, kind, scope, citation, source_agent, source_model, task, card, commit_sha, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.text, row.kind, row.scope, row.citation, row.source_agent, row.source_model, row.task, row.card, row.commit_sha, row.created);
    m.prepare(`INSERT INTO lessons_fts (id, text) VALUES (?, ?)`).run(row.id, row.text);
    m.exec("COMMIT");
  } catch (err) {
    m.exec("ROLLBACK");
    throw err;
  }
  return getLesson(m, lessonId);
}

export function getLesson(m, id) {
  const row = m.prepare("SELECT * FROM lessons WHERE id = ?").get(id);
  return lessonRowToObject(row);
}

export function supersedeLesson(m, oldId, newId) {
  if (oldId === newId) throw new Error("supersedeLesson requires two different lesson ids");
  const oldRow = getLesson(m, oldId);
  if (!oldRow) throw new Error(`lesson ${oldId} does not exist`);
  const newRow = getLesson(m, newId);
  if (!newRow) throw new Error(`lesson ${newId} does not exist`);
  if (oldRow.superseded_by) throw new Error(`lesson ${oldId} is already superseded by ${oldRow.superseded_by}`);
  m.prepare("UPDATE lessons SET superseded_by = ? WHERE id = ?").run(newId, oldId);
  return getLesson(m, oldId);
}

// The one live-lesson predicate: not superseded, not stale, not archived. Every reader of "live" lessons uses it.
export const LIVE_LESSON_SQL = "superseded_by IS NULL AND stale IS NULL AND archived IS NULL";
export const isLiveLesson = (row) => !row.superseded_by && !row.stale && !row.archived;

// Restores an archived lesson (card memory-archived-readers): clears archived and archived_reason, the way back
// from reflect --harmful's archive. Neither column is protected by lessons_no_rewrite; nothing is deleted.
export function unarchiveLesson(m, id) {
  const row = getLesson(m, id);
  if (!row) throw new Error(`lesson ${id} does not exist`);
  if (!row.archived) throw new Error(`lesson ${id} is not archived`);
  m.prepare("UPDATE lessons SET archived = NULL, archived_reason = NULL WHERE id = ?").run(id);
  return getLesson(m, id);
}

// Clears a stale mark (set by recallLessons's citation re-check) so the lesson is a candidate again — the way
// back once a checkout is fixed up or the mark turns out to be wrong. `stale` is not one of the columns the
// lessons_no_rewrite trigger protects, so this is an ordinary UPDATE, not a special case.
export function unstaleLesson(m, id) {
  const row = getLesson(m, id);
  if (!row) throw new Error(`lesson ${id} does not exist`);
  m.prepare("UPDATE lessons SET stale = NULL WHERE id = ?").run(id);
  return getLesson(m, id);
}

export function listLessons(m, { includeSuperseded = false } = {}) {
  const rows = includeSuperseded
    ? m.prepare("SELECT * FROM lessons ORDER BY created ASC, id ASC").all()
    : m.prepare("SELECT * FROM lessons WHERE superseded_by IS NULL ORDER BY created ASC, id ASC").all();
  return rows.map(lessonRowToObject);
}

// Ids of every lesson fetched with `lesson show --card`: the {"id": ...} lines of every
// <dir>/.doug/.state/reports/*/fetched.jsonl. Never throws; unreadable files and bad lines are skipped.
export function readFetchedLessonIds(dir) {
  const ids = new Set();
  let cards = [];
  try {
    cards = readdirSync(join(dir, ".doug", ".state", "reports"));
  } catch {
    return ids;
  }
  for (const card of cards) {
    let text;
    try {
      text = readFileSync(join(dir, ".doug", ".state", "reports", card, "fetched.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const id = JSON.parse(line)?.id;
        if (typeof id === "string") ids.add(id);
      } catch {}
    }
  }
  return ids;
}

// Live lessons no run has confirmed (ADR 0019): helpful = 0 and harmful = 0 and never fetched. Read-only.
export function listUnconfirmedLessons(m, { fetchedIds = new Set() } = {}) {
  return m
    .prepare(`SELECT id, kind, created, text FROM lessons WHERE ${LIVE_LESSON_SQL} AND helpful = 0 AND harmful = 0 ORDER BY created ASC, id ASC`)
    .all()
    .filter((r) => !fetchedIds.has(r.id))
    .map((r) => ({ id: r.id, kind: r.kind, created: r.created, title: lessonTitle(r.text) }));
}

// Whitespace-split tokens, each quoted for FTS5 MATCH and OR'd together; shared by searchLessons and
// recallLessons's BM25 side, and by lib/code-index.mjs's searchIndex (same FTS5 dialect, one code_chunks_fts
// table instead of lessons_fts). Returns null for an empty/whitespace-only query (nothing to match).
export function ftsMatchQuery(query) {
  const tokens = String(query || "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function searchLessons(m, query, { k = 8, includeSuperseded = false } = {}) {
  const match = ftsMatchQuery(query);
  if (!match) return [];
  const rows = m
    .prepare(
      `SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.id
       WHERE lessons_fts MATCH ? AND (? OR l.superseded_by IS NULL)
       ORDER BY bm25(lessons_fts) LIMIT ?`
    )
    .all(match, includeSuperseded ? 1 : 0, k);
  return rows.map(lessonRowToObject);
}

// --- Embeddings on lesson rows -------------------------------------------------------------------------------
// A vector is stored as the raw bytes of a Float32Array (native-endian; store and load run on the same machine,
// this database is never copied cross-architecture). embedding_model/embedding_dims travel with it so a query
// only ever compares vectors from the same model+dims pair (memory-recall design #2).

function floatsToBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToFloats(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // A 4-aligned view over the row's own buffer needs no copy; any other offset or length keeps the copy (a
  // misaligned Float32Array view throws, and so does a length that is not a multiple of 4, as before).
  if (bytes.byteOffset % 4 === 0 && bytes.byteLength % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function setLessonEmbedding(m, id, { model, dims, vector }) {
  if (!model || !dims) throw new Error("setLessonEmbedding requires model and dims");
  if (!(vector instanceof Float32Array)) throw new Error("setLessonEmbedding requires vector to be a Float32Array");
  m.prepare("UPDATE lessons SET embedding_model = ?, embedding_dims = ?, embedding = ? WHERE id = ?").run(
    model,
    dims,
    floatsToBlob(vector),
    id
  );
  return getLesson(m, id);
}

// Rows still needing an embedding for this model+dims pair: not superseded, not stale, and either never
// embedded or embedded under a different model or dims (a space from another model is not comparable).
export function lessonsNeedingEmbedding(m, { model, dims }) {
  const rows = m
    .prepare(
      `SELECT * FROM lessons
       WHERE ${LIVE_LESSON_SQL}
         AND (embedding IS NULL OR embedding_model IS NOT ? OR embedding_dims IS NOT ?)
       ORDER BY created ASC, id ASC`
    )
    .all(model, dims);
  return rows.map(lessonRowToObject);
}

// Embeds every row lessonsNeedingEmbedding finds for provider.model/provider.dims, batch texts at a time. A
// batch the provider fails to embed is counted in `failed` and left unembedded (never thrown); the next batch
// still runs. onProgress, when given, is called after each batch with the running totals.
export async function embedLessons(m, provider, { batch = 32, onProgress } = {}) {
  if (!provider) throw new Error("embedLessons requires a provider");
  const todo = lessonsNeedingEmbedding(m, { model: provider.model, dims: provider.dims });
  let embedded = 0;
  let failed = 0;
  let reason = null;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const result = await provider.embed(
      chunk.map((l) => l.text),
      { inputType: "document" }
    );
    if (!result.ok) {
      failed += chunk.length;
      reason = result.reason;
    } else {
      for (let j = 0; j < chunk.length; j++) {
        setLessonEmbedding(m, chunk[j].id, { model: provider.model, dims: provider.dims, vector: result.vectors[j] });
        embedded++;
      }
    }
    if (onProgress) onProgress({ embedded, total: todo.length, failed, reason });
  }
  return { total: todo.length, embedded, failed, reason };
}

// --- Citation re-check -----------------------------------------------------------------------------------------
// A citation of the form "path:line" or 'path:line "quoted text"' is checked against a checkout: the file
// exists, the line exists, and when quoted text is present the line still contains it. A "report:" citation or
// any free text that doesn't match the path:line shape passes untouched when no `report` is given — there is
// nothing to re-check it against. With a `report` (card memory-reflect), a "report:<task>" citation is checked
// against that report's tasks and "report:<task>/<block-id>" against its adversary blocks; that is stricter than
// the pass-through above, so callers that want it must opt in by passing `{ report }`.
const CITATION_RE = /^(?<path>[^:\s]+):(?<line>\d+)(?:\s+"(?<text>.+)")?$/;

export function checkCitation(lesson, checkoutDir, { report } = {}) {
  const citation = lesson && lesson.citation;
  if (!citation || typeof citation !== "string") return { ok: true, reason: "no citation" };
  if (citation.startsWith("report:")) {
    if (!report) return { ok: true, reason: "report citation" };
    const rest = citation.slice("report:".length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const found = (report.levels || []).some((l) => (l.tasks || []).some((t) => t.id === rest));
      return found ? { ok: true, reason: "task holds" } : { ok: false, reason: `no task "${rest}" in this report` };
    }
    const taskId = rest.slice(0, slash);
    const blockId = rest.slice(slash + 1);
    const found = adversaryBlocks(report).some((b) => b.task === taskId && (b.id === blockId || b.id === `${taskId}/${blockId}`));
    return found ? { ok: true, reason: "block holds" } : { ok: false, reason: `no block "${blockId}" of task "${taskId}" in this report` };
  }
  const match = citation.match(CITATION_RE);
  if (!match) return { ok: true, reason: "free text citation" };
  const { path: relPath, line: lineStr, text } = match.groups;
  const lineNum = Number(lineStr);
  const filePath = resolve(checkoutDir, relPath);
  if (!existsSync(filePath)) return { ok: false, reason: `file not found: ${relPath}` };
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read ${relPath}: ${err.message}` };
  }
  const lines = content.split(/\r?\n/);
  const lineContent = lines[lineNum - 1];
  if (lineContent === undefined) return { ok: false, reason: `line ${lineNum} does not exist in ${relPath}` };
  if (text && !lineContent.includes(text)) {
    return { ok: false, reason: `line ${lineNum} of ${relPath} no longer contains the cited text` };
  }
  return { ok: true, reason: "citation holds" };
}

// --- Minimal glob matcher for scope boost -----------------------------------------------------------------
// Supports **, *, ? only (no {a,b}, no negation); a scope/files entry with none of those characters is an
// exact-string match, never treated as a pattern.
// Exported so lib/code-index.mjs's own path-glob matching (cfg.include/exclude, --files) reuses this exact
// dialect instead of a second one (card semantic-index): both live in this plugin's lib/, so there is no
// cross-plugin boundary excusing a duplicate the way learn.mjs's local copy of doug-gates/lib/glob.mjs is.
export function isGlobPattern(s) {
  return /[*?]/.test(s);
}

export function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" also matches zero directories (embeddings.mjs-style, matching doug-gates/lib/glob.mjs); a
        // trailing "**" with nothing after it matches everything, directories included.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += ".";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

// A scope entry that is a glob is tested against each file; a file entry that is a glob is tested against each
// scope literal; equal strings match either way.
function scopeMatchesFiles(scope, files) {
  for (const s of scope) {
    for (const f of files) {
      if (s === f) return true;
      if (isGlobPattern(s) && globToRegExp(s).test(f)) return true;
      if (isGlobPattern(f) && globToRegExp(f).test(s)) return true;
    }
  }
  return false;
}

// An unparseable created/confirmed value must never silently drop a lesson from recall (a NaN age compares
// false against every staleDays bound): treat it as fresh, age 0, rather than excluding the row.
function ageDaysOf(anchor, nowMs) {
  const t = new Date(anchor).getTime();
  return Number.isFinite(t) ? (nowMs - t) / 86400000 : 0;
}

// checkoutDir is a real project root only when it exists and contains a .doug directory — a wrong or partial
// checkout (or none given) must never be trusted to mark every candidate stale. isProjectRoot gates whether
// recallLessons re-checks citations at all; when it doesn't, lessons are returned unchecked (checked: false).
function isProjectRoot(checkoutDir) {
  if (!checkoutDir) return false;
  try {
    return statSync(resolve(checkoutDir, ".doug")).isDirectory();
  } catch {
    return false;
  }
}

// Strips the embedding BLOB and its model/dims off a lesson before it leaves the module (recall's JSON output
// would otherwise carry a multi-KB blob per lesson): hasVector says whether one is stored, without saying what
// it is.
function toRecallLesson(lesson, extra) {
  const { embedding, embedding_model, embedding_dims, ...rest } = lesson;
  return { ...rest, hasVector: !!embedding, ...extra };
}

// --- Recall row cache (card recall-hybrid-scale) ----------------------------------------------------------------
// The dense side of recallLessons needs every live lesson's recency anchor, scope and (under the provider's
// model/dims) vector. Decoding them is the cost of a hybrid recall at scale, so the decoded rows are kept in
// module scope per database file, model and dims, and reused while the database is unchanged. "Unchanged" is
// PRAGMA data_version (moves when ANOTHER connection commits) together with total_changes() (this connection's own
// row changes); both are per connection, so an entry belongs to the connection that built it and any other
// connection rebuilds. Bounded: RECALL_CACHE_MAX_ENTRIES entries and RECALL_CACHE_MAX_BYTES of vectors in all,
// oldest evicted first, an entry larger than the byte bound never stored (100,000 x 768 floats is about 300 MB).
const RECALL_CACHE_MAX_ENTRIES = 3;
const RECALL_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const RECALL_WINDOW_MARGIN_DAYS = 2;
const recallCache = new Map();

export function clearRecallCache() {
  recallCache.clear();
}

function recallSignature(m) {
  return {
    dv: m.prepare("PRAGMA data_version").get().data_version,
    tc: m.prepare("SELECT total_changes() AS c").get().c,
  };
}

// SQL for "this row is certainly outside the window" (1) or "keep it" (0, also for NULL): the anchor is JS's
// `confirmed || created` (NULLIF drops the empty string), it must be a whole ISO form both SQLite and JS read
// (date, date-time, optional .mmm, optional Z; real calendar date, hour < 24, minute and second < 60; checked by
// a fuzz of 60,000 odd strings against ageDaysOf) and older than the cutoff. The first term is a cheap string
// comparison that every such row passes (ISO text sorts as time), so the costly date functions run only on rows
// that look old; its parameter is the day after the cutoff's date.
const SQL_ANCHOR = "COALESCE(NULLIF(confirmed, ''), created)";
const SQL_ISO_FORMS = (() => {
  const d = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
  const t = "T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]";
  return [d, d + t, d + t + "Z", d + t + ".[0-9][0-9][0-9]", d + t + ".[0-9][0-9][0-9]Z"]
    .map((f) => `${SQL_ANCHOR} GLOB '${f}'`)
    .join(" OR ");
})();
const SQL_OUTSIDE_WINDOW = `IFNULL(${SQL_ANCHOR} < ?
  AND (${SQL_ISO_FORMS})
  AND date(${SQL_ANCHOR}) = substr(${SQL_ANCHOR}, 1, 10)
  AND (length(${SQL_ANCHOR}) = 10 OR (substr(${SQL_ANCHOR}, 12, 2) < '24' AND substr(${SQL_ANCHOR}, 15, 2) < '60' AND substr(${SQL_ANCHOR}, 18, 2) < '60'))
  AND julianday(${SQL_ANCHOR}) < ?, 0)`;

// The julian-day cutoff below which recallRows may drop a row in SQL. Margin: SQLite reads a zone-less
// date-time as UTC and JS as local time, so a row is only dropped when it is clearly outside the window.
function recallCutoffJd(nowMs, staleDays) {
  const jd = nowMs / 86400000 + 2440587.5 - staleDays - RECALL_WINDOW_MARGIN_DAYS;
  return Number.isFinite(jd) ? jd : -1e18;
}

// Live rows with decoded vectors for provider.model/provider.dims. The SQL window drops only a row whose
// confirmed-or-created is a plain ISO date SQLite and JS agree on and that is older than the cutoff; every other
// row (unparseable text, forms only JS parses, a date within the margin) is kept and the JS rule in recallLessons
// decides, so the window is exactly ageDaysOf's.
function recallRows(m, provider, nowMs, staleDays, sig) {
  const cutoffJd = recallCutoffJd(nowMs, staleDays);
  const key = m.file ? `${m.file}\u0000${provider.model}\u0000${provider.dims}` : null;
  const hit = key ? recallCache.get(key) : null;
  if (hit && hit.owner === m && hit.sig.dv === sig.dv && hit.sig.tc === sig.tc && !Number.isNaN(staleDays) && hit.cutoffJd <= cutoffJd) return hit;
  if (hit) recallCache.delete(key);

  // No live row holds a vector under this model/dims: nothing to decode, and no blob is read.
  const any = m
    .prepare(
      `SELECT 1 AS x FROM lessons WHERE ${LIVE_LESSON_SQL} AND embedding IS NOT NULL AND embedding_model = ? AND embedding_dims = ? LIMIT 1`
    )
    .get(provider.model, provider.dims);
  if (!any) return null;

  const stmt = m.prepare(
    `SELECT id, created, confirmed, scope, harmful, helpful, citation,
            CASE WHEN embedding_model = ? AND embedding_dims = ? THEN embedding END AS emb
     FROM lessons
     WHERE ${LIVE_LESSON_SQL} AND ${SQL_OUTSIDE_WINDOW} = 0`
  );
  const ids = [];
  const anchorMs = [];
  const scopeRaw = [];
  const fbInfo = [];
  const vecs = [];
  let bytes = 0;
  const cutoffMs = (cutoffJd - 2440587.5) * 86400000;
  const looksOld = Number.isFinite(cutoffMs) && cutoffMs > -6e13 && cutoffMs < 8e15 ? new Date(cutoffMs + 86400000).toISOString().slice(0, 10) : "0000-00-00";
  for (const r of stmt.iterate(provider.model, provider.dims, looksOld, cutoffJd)) {
    ids.push(r.id);
    anchorMs.push(new Date(r.confirmed || r.created).getTime());
    scopeRaw.push(r.scope);
    fbInfo.push({ harmful: r.harmful, helpful: r.helpful, citation: r.citation });
    const vec = blobToFloats(r.emb);
    vecs.push(vec);
    if (vec) bytes += vec.byteLength;
  }
  const entry = {
    owner: m,
    sig,
    cutoffJd,
    n: ids.length,
    ids,
    anchorMs: Float64Array.from(anchorMs),
    scopeRaw,
    fbInfo,
    vecs,
    live: new Uint8Array(ids.length).fill(1),
    bytes,
  };
  if (key && bytes <= RECALL_CACHE_MAX_BYTES) {
    recallCache.set(key, entry);
    let total = 0;
    for (const e of recallCache.values()) total += e.bytes;
    for (const [k2, e] of recallCache) {
      if (recallCache.size <= RECALL_CACHE_MAX_ENTRIES && total <= RECALL_CACHE_MAX_BYTES) break;
      if (e === entry) continue;
      recallCache.delete(k2);
      total -= e.bytes;
    }
  }
  return entry;
}

// recallLessons's own citation writes (stale mark, confirmed stamp) are applied to the entry it just used, and
// the entry takes the new signature, so a recall with a checkout does not throw its own cache away. If anything
// else changed the database meanwhile (data_version moved, or total_changes moved by more than these writes) the
// entry is dropped instead.
function followOwnWrites(m, entry, written, confirmedIso, sigBefore) {
  const sigAfter = recallSignature(m);
  const ours = written.reduce((n, w) => n + w.changes, 0);
  if (sigAfter.dv !== sigBefore.dv || sigAfter.tc !== sigBefore.tc + ours || entry.owner !== m) {
    for (const [k, e] of recallCache) if (e === entry) recallCache.delete(k);
    return;
  }
  const confirmedMs = new Date(confirmedIso).getTime();
  for (const w of written) {
    const i = entry.ids.indexOf(w.id);
    if (i < 0) continue;
    if (w.stale) entry.live[i] = 0;
    else entry.anchorMs[i] = confirmedMs;
  }
  entry.sig = sigAfter;
}

// What the stale window hides (card recall-window-report): over live rows (not superseded, not stale), the
// count outside the window by exactly ageDaysOf's rule, the live total, and the oldest hidden age in whole days.
export function windowHidden(m, { staleDays = 30, now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const rows = m.prepare(`SELECT created, confirmed FROM lessons WHERE ${LIVE_LESSON_SQL}`).all();
  let count = 0;
  let oldest = -Infinity;
  for (const r of rows) {
    const age = ageDaysOf(r.confirmed || r.created, nowMs);
    if (age <= staleDays) continue;
    count++;
    if (age > oldest) oldest = age;
  }
  return { count, total: rows.length, oldestDays: count ? Math.floor(oldest) : null };
}

// The one line that says so; null when the window hid nothing.
export function windowNote(hidden, staleDays = 30) {
  if (!hidden || !hidden.count) return null;
  return `window: hid ${hidden.count} of ${hidden.total} live lessons older than ${staleDays} days (oldest ${hidden.oldestDays} days)`;
}

// --- Dense-ranked recall -----------------------------------------------------------------------------------
// With a provider and vectors stored under its model/dims, every vectored live in-window lesson is ranked by
// cosine similarity x recency weight x scope boost (memory-benchmark section 9: cosine x recency beat the old
// 50+50 reciprocal rank fusion); BM25 hits that have no such vector are appended after all vectored lessons, in
// BM25 order. Without a provider or vectors, BM25 x recency x scope is the ranking (mode keyword-only). Ties
// break by lesson id ascending. Results are then citation-rechecked against checkoutDir before anything is
// returned — only when checkoutDir is a real project root (isProjectRoot); otherwise every candidate is
// returned unchecked (checked: false in the result) rather than either throwing (no checkoutDir given) or
// marking every row stale forever (a wrong one given). Never throws for a provider or checkout problem (a
// database problem may still throw, same as every other export here). See design #2 in the memory-recall card.
// Feedback in recall scoring (card memory-feedback-rank, ADR 0019). harmful (the lead's explicit mark) and the
// lesson's evidence class (by citation) multiply the score; helpful enters only as a capped, optionally decayed
// term that ships off (helpfulCap 0), because it rises on every verified use and would feed itself. harmful 0,
// weight 1 and helpfulCap 0 leave the score exactly as before. The multiplier is applied to the score's
// magnitude (score + |score| * (factor - 1)) so a negative cosine is lowered by a factor under 1, not raised.
export const RECALL_FEEDBACK = {
  harmfulPenalty: 0.01,
  helpfulCap: 0,
  helpfulStep: 0.05,
  helpfulDecay: 0,
  evidenceWeights: { report: 1, history: 1, file: 1, none: 1 },
};

export function evidenceClassOf(lesson) {
  const c = lesson && typeof lesson.citation === "string" ? lesson.citation : "";
  if (!c) return "none";
  if (c.startsWith("report:")) return "report";
  if (c.startsWith("history:")) return "history";
  return "file";
}

function mergeFeedback(over) {
  const o = over || {};
  return { ...RECALL_FEEDBACK, ...o, evidenceWeights: { ...RECALL_FEEDBACK.evidenceWeights, ...(o.evidenceWeights || {}) } };
}

function feedbackScore(score, info, fb) {
  if (!info) return score;
  const harmful = Number(info.harmful) || 0;
  let factor = 1;
  if (harmful > 0) factor *= 1 / (1 + fb.harmfulPenalty * harmful);
  const w = fb.evidenceWeights[evidenceClassOf(info)];
  if (w !== undefined && w !== 1) factor *= w;
  if (fb.helpfulCap > 0) {
    const h = Math.max(0, Number(info.helpful) || 0);
    const d = fb.helpfulDecay;
    const eff = d > 0 && d < 1 ? (1 - Math.pow(d, h)) / (1 - d) : h;
    factor *= 1 + fb.helpfulStep * Math.min(eff, fb.helpfulCap);
  }
  return factor === 1 ? score : score + Math.abs(score) * (factor - 1);
}

export async function recallLessons(m, query, opts = {}) {
  const { files = [], k = 8, now = new Date(), provider = null, checkoutDir = null, staleDays = 30, detectedProvider = null } = opts;
  const fb = mergeFeedback(opts.feedback);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIsoStr = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const checked = isProjectRoot(checkoutDir);

  // (a)+(b) BM25 side, top 50: live (not superseded, not stale) hits, kept when confirmed-or-created is within
  // staleDays. The whole-table work below (the dense side) runs only with a provider (card recall-hybrid-scale).
  const match = ftsMatchQuery(query);
  let bm25Ranked = [];
  const bm25Info = new Map();
  if (match) {
    const rows = m
      .prepare(
        `SELECT l.id, l.created, l.confirmed, l.scope, l.harmful, l.helpful, l.citation,
                (l.embedding IS NOT NULL AND l.embedding_model = ? AND l.embedding_dims = ?) AS has_match
         FROM lessons_fts f JOIN lessons l ON l.id = f.id
         WHERE lessons_fts MATCH ? AND ${LIVE_LESSON_SQL}
         ORDER BY bm25(lessons_fts) LIMIT 50`
      )
      .all(provider ? provider.model : null, provider ? provider.dims : null, match);
    for (const r of rows) {
      const age = ageDaysOf(r.confirmed || r.created, nowMs);
      if (!(age <= staleDays)) continue;
      bm25Ranked.push(r.id);
      bm25Info.set(r.id, { scope: r.scope, hasMatch: !!r.has_match, age, fb: { harmful: r.harmful, helpful: r.helpful, citation: r.citation } });
    }
  }

  // (c) dense side, only with a provider and rows stored under the same model+dims: cosine (dot of the stored
  // vectors) for every such row, not only BM25 hits. The rows come from recallRows: decoded once per database,
  // model and dims and reused until a write (this connection's or another's) changes the database.
  let mode = "keyword-only";
  let reason = "no provider configured";
  let providerName = null;
  let rows = null;
  let ages = null;
  let cosine = null;
  let cosineScores = null;
  let freshTotal = 0;
  let freshVectored = 0;
  let sigBefore = null;
  if (provider) {
    providerName = provider.name;
    sigBefore = recallSignature(m);
    rows = recallRows(m, provider, nowMs, staleDays, sigBefore);
    ages = new Float64Array(rows ? rows.n : 0);
    for (let i = 0; rows && i < rows.n; i++) {
      if (!rows.live[i]) continue;
      const t = rows.anchorMs[i];
      const age = Number.isFinite(t) ? (nowMs - t) / 86400000 : 0;
      ages[i] = age;
      if (age <= staleDays) {
        freshTotal++;
        if (rows.vecs[i]) freshVectored++;
      } else {
        ages[i] = Infinity; // out of the window; never a candidate
      }
    }
    if (!freshVectored) {
      reason = `no vectors stored for ${provider.model}/${provider.dims}`;
    } else {
      const embedResult = await provider.embed([String(query || "")], { inputType: "query" });
      if (!embedResult.ok) {
        reason = embedResult.reason;
      } else {
        const qVec = embedResult.vectors[0];
        cosine = [];
        cosineScores = new Float64Array(rows.n);
        for (let r = 0; r < rows.n; r++) {
          const vec = rows.vecs[r];
          if (!vec || ages[r] === Infinity || !rows.live[r]) continue;
          let dot = 0;
          for (let i = 0; i < qVec.length && i < vec.length; i++) dot += qVec[i] * vec[i];
          cosineScores[r] = dot;
          cosine.push(r);
        }
        mode = "hybrid";
        reason = null;
      }
    }
  }

  // card recall-fallback-warning: keyword-only is degraded when a provider was given, vectors exist for any
  // model, or the caller detected a usable provider; hybrid reports how many live in-window rows lack a vector.
  // The existence check is bounded and only runs when no other term already decided it.
  const hasAnyVector = (db) =>
    !!db.prepare(`SELECT 1 AS x FROM lessons WHERE ${LIVE_LESSON_SQL} AND embedding IS NOT NULL LIMIT 1`).get();
  const degraded = mode === "keyword-only" && (!!provider || hasAnyVector(m) || !!detectedProvider);
  const coverage = {};
  if (mode === "hybrid") {
    coverage.total = freshTotal;
    coverage.unvectored = freshTotal - freshVectored;
  }

  // (d) scores: recency weight, then scope boost. Dense mode scores cosine; the BM25 order scores 1/(60+rank).
  const bm25Rank = new Map(bm25Ranked.map((id, idx) => [id, idx]));
  const weigh = (ageDays, scopeRaw, base) => {
    let score = base * (0.5 + 0.5 * Math.exp(-ageDays / 90));
    if (files.length) {
      const scope = parseJsonColumn(scopeRaw, []);
      if (scope.length === 0 || scopeMatchesFiles(scope, files)) score *= 1.5;
    }
    return score;
  };
  const idCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byScoreThenId = (a, b) => b.score - a.score || idCmp(a.id, b.id);
  // Candidates in rank order, each { id, score, sides }, read through at(j) so the dense side never builds one
  // object per stored vector.
  const bm25Only = (id) => {
    const info = bm25Info.get(id);
    return { id, score: feedbackScore(weigh(info.age, info.scope, 1 / (60 + bm25Rank.get(id) + 1)), info.fb, fb), sides: ["bm25"] };
  };
  let candidates;
  if (mode === "hybrid") {
    // (e) vectored lessons by cosine x recency x scope, then BM25 hits with no vector, in BM25 order.
    const order = Int32Array.from(cosine);
    const scores = new Float64Array(rows.n);
    for (const r of cosine) scores[r] = feedbackScore(weigh(ages[r], rows.scopeRaw[r], cosineScores[r]), rows.fbInfo[r], fb);
    order.sort((x, y) => scores[y] - scores[x] || idCmp(rows.ids[x], rows.ids[y]));
    const dense = { length: order.length, at: (j) => {
      const r = order[j];
      const id = rows.ids[r];
      return { id, score: scores[r], sides: bm25Rank.has(id) ? ["bm25", "vector"] : ["vector"] };
    } };
    // The tail keeps BM25 order (not the recency-weighted score), reordered only by the feedback factor: the sort
    // key is the rank score 1/(60+rank) through feedbackScore, so a harmful twin falls below its harmful-0 twin.
    const appended = bm25Ranked
      .filter((id) => !bm25Info.get(id).hasMatch)
      .map((id, pos) => ({ cand: bm25Only(id), pos, key: feedbackScore(1 / (60 + bm25Rank.get(id) + 1), bm25Info.get(id).fb, fb) }))
      .sort((a, b) => b.key - a.key || a.pos - b.pos)
      .map((x) => x.cand);
    candidates = {
      length: dense.length + appended.length,
      at: (j) => (j < dense.length ? dense.at(j) : appended[j - dense.length]),
    };
  } else {
    const list = bm25Ranked.map(bm25Only);
    list.sort(byScoreThenId);
    candidates = { length: list.length, at: (j) => list[j] };
  }

  // (g) top k. With a real project root, each candidate's citation is re-checked: a failure marks the row
  // stale and drops it, backfilling from the next candidate so k are returned when enough candidates exist,
  // and a pass sets confirmed. Without one (checked: false), candidates are taken as-is — nothing is marked
  // stale or confirmed, since there is nothing trustworthy to check them against.
  // Every lessons column except the blob, derived from the live schema so a later column cannot drop out.
  const loadCols = m
    .prepare("PRAGMA table_info(lessons)")
    .all()
    .map((c) => c.name)
    .filter((n) => n !== "embedding")
    .join(", ");
  const loadById = m.prepare(`SELECT ${loadCols}, embedding IS NOT NULL AS has_vec FROM lessons WHERE id = ?`);
  const result = [];
  const written = []; // each write below, so the cached rows can follow them
  let idx = 0;
  while (result.length < k && idx < candidates.length) {
    const cand = candidates.at(idx++);
    // Every column except the blob (and the model/dims toRecallLesson strips anyway); hasVector comes from has_vec.
    const { has_vec, ...full } = loadById.get(cand.id);
    cand.lesson = lessonRowToObject({ ...full, embedding: has_vec ? true : null });
    if (!checked) {
      result.push(toRecallLesson(cand.lesson, { score: cand.score, sides: cand.sides }));
      continue;
    }
    const check = checkCitation(cand.lesson, checkoutDir);
    if (!check.ok) {
      const res = m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(nowIsoStr, cand.lesson.id);
      written.push({ id: cand.lesson.id, stale: true, changes: Number(res.changes) });
      continue;
    }
    const res = m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(nowIsoStr, cand.lesson.id);
    written.push({ id: cand.lesson.id, stale: false, changes: Number(res.changes) });
    result.push(toRecallLesson({ ...cand.lesson, confirmed: nowIsoStr }, { score: cand.score, sides: cand.sides }));
  }
  if (rows && written.length) followOwnWrites(m, rows, written, nowIsoStr, sigBefore);

  const hidden = windowHidden(m, { staleDays, now: nowDate });
  return { mode, reason: mode === "hybrid" ? null : reason, provider: providerName, checked, degraded, ...coverage, hidden, lessons: result };
}

// Renders recalled lessons as one line per lesson, in rank order. Each lesson's own text gets a fixed budget
// (LESSON_CHAR_BUDGET): text over budget is cut at the last sentence boundary (". ", "! ", "? ", or a newline)
// within it, falling back to the last word boundary, then a hard cut, with an ellipsis ("…") appended; the
// citation (or kind, when there is none) stays on the line either way. A sentence/newline boundary this close
// to the start (MIN_CUT_KEPT) keeps too little to be worth it — a lesson opening with a heading-then-newline,
// or a stray early period, would otherwise collapse to almost nothing — so that case falls through to the word
// boundary (then the hard cut) instead, same as when no such boundary exists at all. That keeps any one lesson
// — the memory store holds whole files up to ~12k characters, not just short summaries — from ever crowding
// out the rest: the running total is kept under LESSONS_CHAR_CAP by skipping (not stopping at) a line that
// would overflow it, so a later, shorter lesson still renders even after an earlier one didn't fit. lessonIds
// carries exactly the ids of the lines rendered. { text: null, ids: [] } when nothing rendered, the caller's
// cue to omit the fields entirely.
const LESSONS_CHAR_CAP = 2000;
const LESSON_CHAR_BUDGET = 400;
const MIN_CUT_KEPT = 40;
function cutLessonText(text, budget) {
  if (text.length <= budget) return text;
  const slice = text.slice(0, budget);
  let cut = -1;
  for (const sep of [". ", "! ", "? "]) {
    const idx = slice.lastIndexOf(sep);
    if (idx !== -1) cut = Math.max(cut, idx + sep.length - 1);
  }
  const nl = slice.lastIndexOf("\n");
  if (nl !== -1) cut = Math.max(cut, nl);
  if (cut < MIN_CUT_KEPT) cut = -1;
  if (cut === -1) {
    const sp = slice.lastIndexOf(" ");
    cut = sp !== -1 ? sp : budget;
  }
  return text.slice(0, cut).trimEnd() + "…";
}
export function renderLessons(lessons) {
  const text = [];
  const ids = [];
  let length = 0;
  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    const line = `- [${lesson.id}] ${cutLessonText(lesson.text, LESSON_CHAR_BUDGET)} (${lesson.citation || lesson.kind})`;
    const nextLength = length + (text.length ? 1 : 0) + line.length;
    if (nextLength > LESSONS_CHAR_CAP) continue;
    text.push(line);
    ids.push(lesson.id);
    length = nextLength;
  }
  return text.length ? { text: text.join("\n"), ids } : { text: null, ids: [] };
}

// The lesson index (card memory-progressive-access, ADR 0019 retrieval): one line per lesson in rank order carrying
// the id, a one-line title, the kind and the token cost of the WHOLE text (chars / 4, the repo's rule), so the lead
// can fetch the full text of the lessons a card needs with `memory.mjs lesson show <id>`. A line that would push the
// running total past `cap` is skipped (not stopped at) and its id is reported in `omitted`: no silent filter.
const INDEX_TITLE_CHARS = 100;
export const lessonTokens = (text) => Math.ceil(String(text).length / 4);
export function lessonTitle(text) {
  const first = String(text).split("\n").find((l) => l.trim() !== "") ?? "";
  const line = first.trim().replace(/\s+/g, " ");
  if (line.length <= INDEX_TITLE_CHARS) return line;
  const slice = line.slice(0, INDEX_TITLE_CHARS);
  const sp = slice.lastIndexOf(" ");
  return (sp > 0 ? slice.slice(0, sp) : slice).trimEnd() + "…";
}
export function renderLessonIndex(lessons, { cap = LESSONS_CHAR_CAP } = {}) {
  const text = [];
  const ids = [];
  const omitted = [];
  let length = 0;
  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    const line = `- [${lesson.id}] ${lessonTitle(lesson.text)} (${lesson.kind}, ~${lessonTokens(lesson.text)} tokens)`;
    const nextLength = length + (text.length ? 1 : 0) + line.length;
    if (nextLength > cap) {
      omitted.push(lesson.id);
      continue;
    }
    text.push(line);
    ids.push(lesson.id);
    length = nextLength;
  }
  return { text: text.length ? text.join("\n") : null, ids, omitted };
}

// The flow track's delivery (card memory-atomic-lessons): the index, then the full text of the top lessons in
// rank order up to FLOW_FETCH_TOKENS (chars / 4, rounded up, per lesson). A lesson whose full text would pass the
// remaining budget is skipped (not stopped at), stays in the index, is named on a `not fetched` line and is never
// cut. Fetched lessons use the `lesson show` form. `ids` are the FETCHED ids in rank order (what the run credits as
// used), `indexIds` every indexed id, `omitted` the ids the index cap dropped, `unfetched` the indexed ids over budget.
export const FLOW_FETCH_TOKENS = 4000;
export function renderFlowLessons(lessons, { indexCap = LESSONS_CHAR_CAP, fetchTokens = FLOW_FETCH_TOKENS } = {}) {
  const index = renderLessonIndex(lessons, { cap: indexCap });
  if (index.text === null) return { text: null, ids: [], indexIds: [], omitted: index.omitted, unfetched: [] };
  const byId = new Map((Array.isArray(lessons) ? lessons : []).map((l) => [l.id, l]));
  const fetched = [];
  const unfetched = [];
  let used = 0;
  for (const id of index.ids) {
    const lesson = byId.get(id);
    const tokens = lessonTokens(lesson.text);
    if (used + tokens > fetchTokens) {
      unfetched.push(id);
      continue;
    }
    used += tokens;
    fetched.push(lesson);
  }
  const parts = [index.text];
  if (index.omitted.length) parts.push(`index: omitted ${index.omitted.length} lessons over the ${indexCap}-character index budget: ${index.omitted.join(", ")}`);
  if (unfetched.length) parts.push(`not fetched (over the ~${fetchTokens}-token fetch budget): ${unfetched.join(", ")}`);
  let text = parts.join("\n");
  if (fetched.length) {
    text += "\n\n" + fetched.map((l) => `lesson ${l.id} (${l.kind}, ~${lessonTokens(l.text)} tokens)\ncitation: ${l.citation || "none"}\n\n${l.text}`).join("\n\n");
  }
  return { text, ids: fetched.map((l) => l.id), indexIds: index.ids, omitted: index.omitted, unfetched };
}

// The lessons a session starts with when no card query exists (card memory-every-session): live, non-stale
// lessons confirmed-or-created within staleDays, ordered by helpful minus harmful desc, then confirmed-or-created
// desc, then id ascending. No provider, no citation re-check, nothing written.
export function topLessons(m, { k = 5, staleDays = 30, now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const rows = m
    .prepare(
      `SELECT id, text, kind, scope, citation, source_agent, source_model, task, card, commit_sha, created, confirmed,
              helpful, harmful, superseded_by, stale
       FROM lessons WHERE ${LIVE_LESSON_SQL}`
    )
    .all()
    .map(lessonRowToObject)
    .filter((l) => ageDaysOf(l.confirmed || l.created, nowMs) <= staleDays);
  const stamp = (l) => new Date(l.confirmed || l.created).getTime() || 0;
  rows.sort((a, b) => b.helpful - b.harmful - (a.helpful - a.harmful) || stamp(b) - stamp(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.slice(0, k);
}

// --- Degraded-recall warnings (card recall-fallback-warning) ------------------------------------------------
// The one place that words a degraded recall, for memory.mjs recall / index search and plan.mjs json alike.
// `result` is a recallLessons or searchIndex result; `what` is "memory recall" or "code index search"; `code`
// picks the chunk wording and the `index build` fix. Returns the stderr line (no newline) or null.
export function degradedWarning(result, { what = "memory recall", code = false, detectedProvider = null } = {}) {
  const noun = code ? "chunks" : "lessons";
  const rebuild = code ? "run memory.mjs index build" : "run memory.mjs reembed";
  if (result.mode === "hybrid") {
    if (result.unvectored > 0) return `WARNING: ${result.unvectored} of ${result.total} ${noun} have no vector; ${rebuild}`;
    return null;
  }
  if (!result.degraded) return null;
  const reason = result.reason;
  let fix;
  let shown = reason;
  if (reason === "no provider configured") {
    if (detectedProvider) {
      shown = `no provider configured, but ${detectedProvider} is available`;
      fix = "run memory.mjs doctor to enable it";
    } else {
      fix = "configure memory.embeddings (memory.mjs doctor)";
    }
  } else if (typeof reason === "string" && reason.startsWith("no vectors stored for ")) {
    fix = rebuild;
  } else if (reason === "timeout") {
    fix = "run memory.mjs doctor (a cold model can time out on first use; retry)";
  } else {
    fix = "run memory.mjs doctor";
  }
  return `WARNING: ${what} degraded to keyword-only: ${shown}; ${fix}`;
}

// The reason shown in a task prompt block when a recall was degraded: the same wording as the warning's reason
// part, including the detected-provider form.
export function degradedReason(result, detectedProvider = null) {
  if (result.reason === "no provider configured" && detectedProvider) return `no provider configured, but ${detectedProvider} is available`;
  return result.reason;
}

// One probe for a usable local embedding provider, for a caller whose config has none. DOUG_OLLAMA_BASE_URL
// overrides the default base URL (http://localhost:11434). Returns a short description ("ollama embeddinggemma
// at <url>") or null: a failed or negative probe is "not detected", never an error. Ollama only, GET only:
// /api/version then /api/tags under ONE shared 1500 ms deadline (never an embed call, never a POST). The model
// name matching mirrors embeddings.mjs's modelNameMatches (exact, or the part before ":" on either side); that
// helper is not exported and this card may not edit embeddings.mjs, so the rule is repeated here.
export async function detectLocalProvider(opts = {}) {
  try {
    const baseUrl = process.env.DOUG_OLLAMA_BASE_URL || "http://localhost:11434";
    const root = baseUrl.replace(/\/$/, "");
    const want = "embeddinggemma";
    const base = (n) => String(n ?? "").split(":")[0];
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 1500);
    const get = opts.fetch ? (url) => fetchGet(opts.fetch, url, signal) : (url) => httpGet(url, signal);
    const version = await get(`${root}/api/version`);
    if (!version.ok) return null;
    const tags = await get(`${root}/api/tags`);
    if (!tags.ok) return null;
    const json = JSON.parse(tags.body);
    const models = Array.isArray(json && json.models) ? json.models : [];
    const present = models.some((mo) => mo && [mo.name, mo.model].some((n) => n !== undefined && n !== null && (n === want || base(n) === want)));
    return present ? `ollama ${want} at ${baseUrl}` : null;
  } catch {
    return null;
  }
}

async function fetchGet(fetchImpl, url, signal) {
  const res = await fetchImpl(url, { signal, headers: { Connection: "close" } });
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    return { ok: false, body: "" };
  }
  return { ok: true, body: await res.text() };
}

// node:http rather than fetch: aborting a fetch whose TCP connect is still pending leaves the connect attempt
// (and so the process) alive for ~10 s against an unroutable host; destroying a node:http request tears the
// socket down at once, so the CLI exits right after the deadline.
function httpGet(url, signal) {
  return new Promise((resolveP, rejectP) => {
    const mod = url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = mod(url, { method: "GET", headers: { Connection: "close" } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        resolveP({ ok: false, body: "" });
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveP({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", rejectP);
    });
    const onAbort = () => {
      req.destroy();
      rejectP(new Error("timeout"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", rejectP);
    req.end();
  });
}

function taskAdversary(task, level) {
  if (task.adversary && typeof task.adversary === "object" && task.adversary.ran) {
    return { verdict: task.adversary.verdict ?? null, blocked: toIntOrNull(task.adversary.blocked), source: "task" };
  }
  const la = level && level.levelAdversary;
  if (la && la.ran && Array.isArray(la.tasks) && la.tasks.includes(task.id)) {
    return { verdict: la.verdict ?? null, blocked: toIntOrNull(la.blocked), source: "level" };
  }
  return { verdict: null, blocked: null, source: null };
}

// Prices one adversary entry's usage ({inputTokens, outputTokens}, the shape ReviewResult.usage carries into a
// report) at the CODEX_DEFAULT_MODEL row of CODEX_PRICES (card run-report-codex-cost). Null, never estimated,
// when the usage is missing or malformed or the model has no priced row.
function priceAdversaryUsage(usage) {
  if (!usage || typeof usage !== "object" || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return null;
  const p = CODEX_PRICES[CODEX_DEFAULT_MODEL];
  if (!p) return null;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1e6;
}

// codex_usd for one outcome row (card run-report-codex-cost): the task's own adversary usage when it has one
// (adv.source === "task"); the level adversary's usage only when the level has exactly one task, since a shared
// level adversary's cost cannot be split across tasks without double-counting it; null otherwise (never split,
// never counted twice).
function taskCodexUsd(task, level, adv) {
  if (adv.source === "task") return priceAdversaryUsage(task.adversary && task.adversary.usage);
  if (adv.source === "level") {
    const la = level && level.levelAdversary;
    if (la && Array.isArray(la.tasks) && la.tasks.length === 1 && la.tasks[0] === task.id) {
      return priceAdversaryUsage(la.usage);
    }
  }
  return null;
}

function findPlanTask(plan, id) {
  if (!plan) return null;
  const list = Array.isArray(plan.tasks) ? plan.tasks : [];
  return list.find((t) => t.id === id) || null;
}

export function outcomeRows(report, opts) {
  const { plan = null, classes = [], run = null, reportHash, reportPath = null, card = null, commit = null, cost = null, now = nowIso(), memoryConfig: flowMemoryConfig = null } = opts || {};
  const allBlocks = classifyBlocks(report, classes).map((b) => ({
    id: b.id,
    pass: b.pass,
    status: b.status,
    description: b.description,
    class: b.class,
    reason: b.reason,
    task: b.task,
  }));
  const rows = [];
  for (const level of report.levels || []) {
    for (const task of level.tasks || []) {
      const runValue = run || `report:${String(reportHash).slice(0, 12)}`;
      const planTask = findPlanTask(plan, task.id);
      const adv = taskAdversary(task, level);
      const attempts = Array.isArray(task.attempts) ? task.attempts : [];
      const passes = task.passes ?? attempts.length ?? null;
      const fixPasses = passes === null ? null : Math.max(0, passes - 1);
      const blocks = allBlocks.filter((b) => b.task === task.id).map(({ task: _t, ...rest }) => rest);
      let tokens = null;
      let usd = null;
      if (cost && cost.tasks) {
        const match = cost.tasks.find((t) => t.name === task.id);
        if (match) {
          tokens = { ...match.usage, agents: match.agents, source: "transcripts" };
          usd = match.unpriced === 0 ? match.usd : null;
        }
      }
      if (tokens === null) {
        const wfTokens = task.budget && task.budget.spent && typeof task.budget.spent.tokens === "number" ? task.budget.spent.tokens : null;
        tokens = wfTokens === null ? null : { total: wfTokens, source: "workflow" };
      }
      rows.push({
        recorded: now,
        run: runValue,
        run_id: run || null,
        report_hash: reportHash,
        report_path: reportPath,
        card: task.card ?? card ?? (plan && plan.card) ?? null,
        task: task.id,
        spec_hash: task.specHash ?? null,
        files: planTask && planTask.files ? planTask.files : null,
        size: task.size ?? null,
        shape: task.shape ?? null,
        models: task.models ?? null,
        implemented: toIntOrNull(task.implemented),
        verified: toIntOrNull(task.verified),
        reviewed: toIntOrNull(task.reviewed),
        review_issues: Array.isArray(task.reviewIssues) ? task.reviewIssues : [],
        review_issue_count: Array.isArray(task.reviewIssues) ? task.reviewIssues.length : 0,
        adversary_verdict: adv.verdict,
        adversary_blocked: adv.blocked,
        adversary_source: adv.source,
        blocks,
        passes,
        fix_passes: fixPasses,
        stop_reason: task.stopReason ?? null,
        stop_class: task.stopClass ?? null,
        in_scope: toIntOrNull(task.inScope),
        budget_spent: (task.budget && task.budget.spent) || null,
        tokens,
        usd,
        codex_usd: taskCodexUsd(task, level, adv),
        commit_sha: commit ?? task.commit ?? null,
        track: "flow",
        wall_clock: null,
        gate: null,
        note: null,
        partial: toIntOrNull(task.partial),
        // The seven condition columns (card outcomes-condition-columns) are null on a flow row — see the comment
        // above OUTCOMES_COLUMNS_SQL; memory_config is the flow stamp when the caller passes one (card
        // memory-flow-index-fetch). backfilled is 0, never null: it is NOT NULL DEFAULT 0.
        harness_commit: null,
        config_hash: null,
        class: null,
        arm: null,
        assigned_by: null,
        explore_probability: null,
        backfilled: 0,
        memory_config: flowMemoryConfig ? JSON.stringify(sortKeysDeep(flowMemoryConfig)) : null,
      });
    }
  }
  return rows;
}

// --- Condition hashing (card outcomes-condition-columns) --------------------------------------------------
// "The Models table text": the contiguous lines starting with "|" in the first table after the "## Models"
// heading in a CLAUDE.md's markdown, joined with "\n" — empty string when there is no heading (or no markdown
// at all). Reuses MODELS_HEADING from lib/models.mjs so this reads the same heading parseModelsSection does,
// rather than a second regex that could drift from it.
function modelsTableText(markdown) {
  if (typeof markdown !== "string") return "";
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => MODELS_HEADING.test(l.trim()));
  if (start < 0) return "";
  const tableLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (line.trim().startsWith("|")) tableLines.push(line);
    else if (tableLines.length) break;
  }
  return tableLines.join("\n");
}

// The condition's configHash (card outcomes-condition-columns, brief F8): hex sha256 of `.doug/config.json`'s
// utf8 bytes (or "" when the file is absent) plus "\n" plus the Models table text (above, "" when CLAUDE.md or
// its Models heading is absent). Deterministic and side-effect-free — a table cell edit changes it, prose
// anywhere else in CLAUDE.md (outside the table) does not; `.doug/config.json` is hashed whole (its full utf8
// bytes), so any change anywhere in that file changes the hash, and a config.json edit changes it with CLAUDE.md
// held fixed.
export function conditionConfigHash(dir) {
  const configPath = join(dir, ".doug", "config.json");
  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const claudeMdPath = join(dir, "CLAUDE.md");
  const markdown = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
  return createHash("sha256").update(`${configText}\n${modelsTableText(markdown)}`).digest("hex");
}

// One hand-track landing, one row: run = 'hand:<commit>' (re-recording the same commit updates the same row;
// a card that lands in two commits gets two rows), task = card. It does not read the board, a plan, or a
// report — it records only the values it is given. See the comment above OUTCOMES_COLUMNS_SQL for which
// columns are null on this track and why.
//
// `condition` (card outcomes-condition-columns) is the parsed condition.json a caller read from
// .doug/.state/reports/<card>/condition.json (see conditionConfigHash below and the CLI's `condition open`), or
// null when none was found: null fills every one of the seven condition columns with null, exactly like a row
// that has never been stamped. `backfilled` is always 0 here — only `memory.mjs condition backfill`, which never
// goes through this function, ever sets it to 1.
export function handOutcomeRow({ card, commit, wallClock = null, gate = null, note = null, now = nowIso(), condition = null, cost = null } = {}) {
  if (!card) throw new Error("handOutcomeRow requires card");
  if (!commit) throw new Error("handOutcomeRow requires commit");
  return {
    recorded: now,
    run: `hand:${commit}`,
    run_id: null,
    report_hash: null,
    report_path: null,
    card,
    task: card,
    spec_hash: null,
    files: null,
    size: null,
    shape: null,
    models: null,
    implemented: null,
    verified: null,
    reviewed: null,
    review_issues: null,
    review_issue_count: null,
    adversary_verdict: null,
    adversary_blocked: null,
    adversary_source: null,
    blocks: null,
    passes: null,
    fix_passes: null,
    stop_reason: null,
    stop_class: null,
    in_scope: null,
    budget_spent: null,
    tokens: null,
    usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    codex_usd: null,
    commit_sha: commit,
    track: "hand",
    wall_clock: wallClock,
    gate,
    note,
    partial: null,
    harness_commit: condition ? condition.harnessCommit ?? null : null,
    config_hash: condition ? condition.configHash ?? null : null,
    class: condition ? condition.class ?? null : null,
    arm: condition ? condition.arm ?? null : null,
    assigned_by: condition ? condition.assignedBy ?? null : null,
    explore_probability: condition ? condition.exploreProbability ?? null : null,
    backfilled: 0,
    memory_config: condition && condition.memoryConfig ? JSON.stringify(sortKeysDeep(condition.memoryConfig)) : null,
  };
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  return v;
}

// The memory configuration an outcome row is stamped with (card memory-outcome-arms, ADR 0019 Measurement), so
// outcomes can be compared per configuration. Pure: the caller reads the project config. Excludes baseUrl and
// apiKeyEnv (where the provider lives, not what it computes). MEMORY_STAGE names the recall/ranking/delivery
// generation: a card that changes recall or ranking for every track bumps it, which starts a new arm. A change to one
// track's delivery alone (card memory-atomic-lessons: the flow track) changes that track's stamp fields instead.
export const MEMORY_STAGE = "progressive-access";

// `track` names the delivery the row's briefs actually got (card memory-flow-index-fetch): a hand card's briefs
// carry the index plus a lead fetch; a flow task's briefs (plan.mjs) carry the index plus the full text of the top
// lessons up to FLOW_FETCH_TOKENS (card memory-atomic-lessons), told apart from the hand stamp by fetch/fetchTokens. Any other track throws
// rather than claiming a delivery.
export function memoryConfig({ embeddings = null, staleDays = 30, track = "hand" } = {}) {
  if (track !== "hand" && track !== "flow") throw new Error(`memoryConfig: unknown track ${JSON.stringify(track)}`);
  const emb = embeddings ? { provider: embeddings.provider ?? null, model: embeddings.model ?? null, dims: embeddings.dims ?? null } : null;
  if (track === "flow") {
    return { stage: MEMORY_STAGE, embeddings: emb, staleDays, k: 8, delivery: "index+fetch", indexChars: LESSONS_CHAR_CAP, fetch: "top-k", fetchTokens: FLOW_FETCH_TOKENS };
  }
  return {
    stage: MEMORY_STAGE,
    embeddings: emb,
    staleDays,
    k: 8,
    delivery: "index+fetch",
    indexChars: LESSONS_CHAR_CAP,
  };
}

// One stopped hand card report, one row (card memory-record-stops, ADR 0019 gap 3): run = 'stop:<first 12 hex of
// the report hash>', so recording the same report again updates the same row, a different stop of the card adds
// a row, and a later landing ('hand:<commit>') sits beside it. stop_class is the report's typed `reason` and
// stop_reason its prose `detail` (the reason when detail is blank). `blocks` are the blocks.jsonl lines
// attributed to the run, kept as {at, hook, agent, class, reason}. Every other column is null as on handOutcomeRow.
export function stopOutcomeRow({ card, report, reportHash, reportPath = null, run = null, blocks = [], now = nowIso(), condition = null, memoryConfig: stamp = null } = {}) {
  if (!card) throw new Error("stopOutcomeRow requires card");
  if (!report || report.outcome !== "stopped") throw new Error("stopOutcomeRow requires a stopped report");
  if (!reportHash) throw new Error("stopOutcomeRow requires reportHash");
  const detail = typeof report.detail === "string" && report.detail.trim() !== "" ? report.detail : null;
  return {
    ...handOutcomeRow({ card, commit: "x", now, condition }),
    ...(!(condition && condition.memoryConfig) && stamp ? { memory_config: JSON.stringify(sortKeysDeep(stamp)) } : {}),
    run: `stop:${String(reportHash).slice(0, 12)}`,
    run_id: run ?? null,
    report_hash: reportHash,
    report_path: reportPath,
    commit_sha: null,
    stop_class: report.reason ?? null,
    stop_reason: detail ?? report.reason ?? null,
    blocks: blocks.map((b) => ({ at: b.at ?? null, hook: b.hook ?? null, agent: b.agent ?? null, class: b.class ?? null, reason: b.reason ?? null })),
  };
}

// The agent id a blocks.jsonl line belongs to: a string `agentId` field, else the id in a subagent-stop reason.
export function blockAgentId(line) {
  if (!line || typeof line !== "object") return null;
  if (typeof line.agentId === "string" && line.agentId !== "") return line.agentId;
  const m = typeof line.reason === "string" ? /Subagent \S+ \(([^)\s]+)\)/.exec(line.reason) : null;
  return m ? m[1] : null;
}

function parseJsonLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const v = JSON.parse(raw);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      // malformed line: skipped
    }
  }
  return out;
}

// Every agentId on any parseable line of the given queen journal texts.
export function runAgentIds(journalTexts) {
  const ids = new Set();
  for (const t of journalTexts ?? []) for (const v of parseJsonLines(t)) if (typeof v.agentId === "string" && v.agentId !== "") ids.add(v.agentId);
  return ids;
}

// The parsed blocks.jsonl lines whose agent id is one of the run's, in file order. A main-session line has none.
export function attributeBlocks(ledgerText, agentIds) {
  return parseJsonLines(ledgerText).filter((v) => {
    const id = blockAgentId(v);
    return id !== null && agentIds.has(id);
  });
}

// Run history (card memory-run-history, ADR 0019 L0): an append-only file per card run under
// .doug/.state/history/<card>/<run>.jsonl. Capture depth (ADR 0019 line 30, Open there, decided here for the artifact
// slice): copy the text of Doug's own run artifacts (card report, attributed gate blocks and trace denials, each
// seat's hand-back from the queen journal, each seat's brief re-rendered by replaying lib/card-loop.mjs); never copy
// Claude Code transcripts and never reference into the Claude Code store. Each entry is secret-scanned on its WHOLE
// text first (a hit replaces the entire entry), then capped at HISTORY_ENTRY_MAX_BYTES keeping the head; each run
// file is capped at HISTORY_RUN_MAX_BYTES with a final 'cap' line counting the dropped entries (no silent filter).
// No age bound: files are never deleted or rewritten.
export const HISTORY_DIR_RELPATH = ".doug/.state/history";
export const HISTORY_ENTRY_MAX_BYTES = 65536;
export const HISTORY_RUN_MAX_BYTES = 1048576;

export function historyEntry({ kind, seat = null, round = null, source, value }, { scan, maxBytes = HISTORY_ENTRY_MAX_BYTES } = {}) {
  const text0 = typeof value === "string" ? value : String(JSON.stringify(value === undefined ? null : value, null, 2));
  const bytes = Buffer.byteLength(text0, "utf8");
  const base = { kind, seat, round, source, bytes };
  let redacted = null;
  if (typeof scan !== "function") redacted = "no-scanner";
  else {
    try {
      const hit = scan(text0);
      if (hit) redacted = typeof hit.rule === "string" && hit.rule !== "" ? hit.rule : "secret";
    } catch {
      redacted = "scan-error";
    }
  }
  if (redacted !== null) return { ...base, truncated: false, redacted, text: `[redacted: ${redacted}]` };
  if (bytes <= maxBytes) return { ...base, truncated: false, redacted: null, text: text0 };
  const buf = Buffer.from(text0, "utf8");
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { ...base, truncated: true, redacted: null, text: buf.subarray(0, cut).toString("utf8") };
}

// Seat runs of a queen Workflow journal, in started-line order: {seat, round, agentId, result}.
export function journalSeatRuns(journalText) {
  try {
    const started = [];
    const results = new Map();
    for (const v of parseJsonLines(journalText)) {
      if (v.type === "started" && typeof v.key === "string") started.push(v);
      else if (v.type === "result" && typeof v.key === "string") results.set(v.key, v.result);
    }
    return started.map((v) => {
      const parts = String(v.label ?? "").split(":");
      const last = parts[parts.length - 1];
      const round = /^\d+$/.test(last) ? Number(last) : null;
      return { seat: parts[0], round, agentId: v.agentId ?? null, result: results.has(v.key) ? results.get(v.key) ?? null : null };
    });
  } catch {
    return [];
  }
}

// Each seat run's brief, re-rendered by replaying the card-loop contract over the runs' hand-backs; null from the
// first seat that does not match the contract's next seat (or on any error).
export function replayBriefs(queenArgs, seatRuns) {
  const runs = Array.isArray(seatRuns) ? seatRuns : [];
  const out = runs.map(() => null);
  try {
    if (queenArgs === null || typeof queenArgs !== "object" || queenArgs.card === null || typeof queenArgs.card !== "object") return out;
    let s = initialState(queenArgs.card, queenArgs.options);
    for (let i = 0; i < runs.length; i++) {
      const a = currentAction(s);
      if (a.kind !== "seat" || a.seat !== runs[i].seat) break;
      out[i] = briefPrompt(a.brief, { repoRoot: queenArgs.repoRoot, worktreePath: queenArgs.worktreePath });
      s = cardLoopNext(s, runs[i].result).state;
    }
  } catch {
    // out keeps null from the failing seat on
  }
  return out;
}

// The parsed trace lines that are PermissionDenied events of one of the run's agents, in file order.
export function attributeDenials(traceText, agentIds) {
  try {
    return parseJsonLines(traceText).filter((v) => v.event === "PermissionDenied" && typeof v.agent === "string" && agentIds.has(v.agent));
  } catch {
    return [];
  }
}

const historySafe = (x) => String(x).replace(/[^A-Za-z0-9_.-]/g, "_").replace(/\.{2,}/g, "_").slice(0, 120) || "_";

// Writes <dir>/.doug/.state/history/<card>/<run>.jsonl once; an existing file is never touched.
export function writeRunHistory(dir, { card, run, entries, scan, maxEntryBytes = HISTORY_ENTRY_MAX_BYTES, maxRunBytes = HISTORY_RUN_MAX_BYTES }) {
  const path = join(dir, HISTORY_DIR_RELPATH, historySafe(card), historySafe(run) + ".jsonl");
  const lines = [];
  let used = 0;
  let truncated = 0;
  let dropped = 0;
  for (const e of entries) {
    const h = historyEntry(e, { scan, maxBytes: maxEntryBytes });
    const line = JSON.stringify({ kind: h.kind, card, run, seat: h.seat, round: h.round, source: h.source, bytes: h.bytes, truncated: h.truncated, redacted: h.redacted, text: h.text });
    const size = Buffer.byteLength(line) + 1;
    if (dropped === 0 && used + size <= maxRunBytes) {
      lines.push(line);
      used += size;
      if (h.truncated) truncated++;
    } else dropped++;
  }
  if (dropped > 0) lines.push(JSON.stringify({ kind: "cap", card, run, dropped, maxRunBytes }));
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, lines.map((l) => l + "\n").join(""), { flag: "wx" });
  } catch (e) {
    if (e && e.code === "EEXIST") return { path, written: false, lines: 0, truncated: 0, dropped: 0 };
    throw e;
  }
  return { path, written: true, lines: lines.length - (dropped > 0 ? 1 : 0), truncated, dropped };
}

// The run-history secret scanner both writers use (autopilot report, reflect --hand), so redaction cannot drift:
// .doug/config.json `secrets`; enabled === false scans nothing; otherwise the vendored secret-rules scanner. An
// import failure returns undefined, which reads every entry as redacted 'no-scanner'.
export async function historyScanner(dir) {
  let secrets = {};
  try {
    secrets = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8")).secrets ?? {};
  } catch {
    // no config: defaults
  }
  if (secrets && secrets.enabled === false) return () => null;
  try {
    const sr = await import(pathToFileURL(join(dir, ".doug/hooks/lib/secret-rules.mjs")).href);
    return (t) => sr.scanText(t, secrets ?? {});
  } catch {
    return undefined;
  }
}

// History fetch (card memory-progressive-access, ADR 0019 L0 citation form history:<card>/<file>:<line>).
// <ref> = [history:]<card>[/<run>[.jsonl]][:<line>]; ids are limited to safe name characters so a ref can never leave
// the history directory.
export function parseHistoryRef(ref) {
  const bad = () => new Error(`bad history id: ${JSON.stringify(ref)}`);
  if (typeof ref !== "string") throw bad();
  let rest = ref.startsWith("history:") ? ref.slice("history:".length) : ref;
  let line = null;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const n = rest.slice(colon + 1);
    if (!/^[0-9]+$/.test(n) || Number(n) < 1) throw bad();
    line = Number(n);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/");
  if (parts.length > 2) throw bad();
  const [card, runRaw] = parts;
  const run = runRaw === undefined ? null : runRaw.replace(/\.jsonl$/, "");
  for (const part of [card, run]) {
    if (part === null) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(part) || part.includes("..")) throw bad();
  }
  if (line !== null && run === null) throw bad();
  return { card, run, line };
}

export function readRunHistory(dir, { card, run = null, line = null }) {
  const root = join(dir, HISTORY_DIR_RELPATH);
  const cardDir = join(root, card);
  const parseLines = (path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
  if (run === null) {
    if (!existsSync(cardDir)) throw new Error(`no history for card ${card}`);
    const runs = readdirSync(cardDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort()
      .map((r) => {
        const entries = parseLines(join(cardDir, r + ".jsonl")).filter((e) => e.kind !== "cap");
        return { run: r, entries: entries.length, tokens: entries.reduce((n, e) => n + lessonTokens(e.text ?? ""), 0) };
      });
    return { card, runs };
  }
  const file = join(cardDir, run + ".jsonl");
  if (!existsSync(file)) throw new Error(`no history for ${card}/${run}`);
  const lines = parseLines(file);
  if (line !== null) {
    if (line > lines.length) throw new Error(`no line ${line} in ${card}/${run} (${lines.length} lines)`);
    const e = lines[line - 1];
    return { ...e, line, tokens: lessonTokens(e.text ?? "") };
  }
  const entries = lines.map((e, i) => {
    if (e.kind === "cap") return { line: i + 1, kind: "cap", dropped: e.dropped, maxRunBytes: e.maxRunBytes };
    return { line: i + 1, kind: e.kind, seat: e.seat, round: e.round, source: e.source, bytes: e.bytes, truncated: e.truncated, redacted: e.redacted, tokens: lessonTokens(e.text ?? "") };
  });
  return { card, run, tokens: entries.reduce((n, e) => n + (e.tokens ?? 0), 0), entries };
}

const OUTCOME_COLUMNS = [
  "recorded", "run", "run_id", "report_hash", "report_path", "card", "task", "spec_hash", "files", "size", "shape",
  "models", "implemented", "verified", "reviewed", "review_issues", "review_issue_count", "adversary_verdict",
  "adversary_blocked", "adversary_source", "blocks", "passes", "fix_passes", "stop_reason", "stop_class", "in_scope",
  "budget_spent", "tokens", "usd", "codex_usd", "commit_sha", "track", "wall_clock", "gate", "note", "partial",
  "harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability", "backfilled", "memory_config",
];

const JSON_COLUMNS = new Set(["files", "models", "review_issues", "blocks", "budget_spent", "tokens"]);

// The eight condition columns (seven from card outcomes-condition-columns, plus memory_config) upsert atomically, all eight together, keyed on
// whether the *new* row carries a harness_commit — never column-by-column (a plain per-column COALESCE let a
// re-record with no condition zero out an existing stamp's `backfilled` flag while keeping its old
// harness_commit, mixing half of one stamp with half of another, since `backfilled` defaults to 0, not null,
// when a caller omits it). When `excluded.harness_commit` is null (this row carries no condition), every one of
// the eight columns keeps the existing row's value untouched; otherwise every one of the eight takes the new
// row's value, including `backfilled` (a fresh `condition open`/`record --hand` stamp legitimately replaces an
// older backfilled placeholder with backfilled 0). This is what keeps a `condition backfill` stamp — or any
// other already-recorded stamp — intact across a later re-record for the same run+task that carries none.
const CONDITION_COLUMNS = new Set(["harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability", "backfilled", "memory_config"]);

// passes and fix_passes upsert as a pair keyed on the new row's passes (card memory-record-keeps-rounds): a
// re-record whose row carries no passes (a hand row) keeps the measured pair `reflect --hand --rounds` wrote.
const ROUND_COLUMNS = new Set(["passes", "fix_passes"]);

export function recordOutcomes(m, rows) {
  let inserted = 0;
  let updated = 0;
  m.exec("BEGIN");
  try {
    for (const row of rows) {
      const existing = m.prepare("SELECT id FROM outcomes WHERE run = ? AND task = ?").get(row.run, row.task);
      // `backfilled` is NOT NULL DEFAULT 0 (v7): a caller built before this column existed (a row object that
      // simply doesn't mention it) must default to 0, its own column default, not null — every other column
      // still defaults to null.
      const values = OUTCOME_COLUMNS.map((c) =>
        JSON_COLUMNS.has(c) ? asJson(row[c], c === "blocks" ? [] : null) : c === "backfilled" ? row[c] ?? 0 : row[c] ?? null
      );
      const placeholders = OUTCOME_COLUMNS.map(() => "?").join(", ");
      const updateSet = OUTCOME_COLUMNS.filter((c) => c !== "run" && c !== "task")
        .map((c) =>
          CONDITION_COLUMNS.has(c)
            ? `${c} = CASE WHEN excluded.harness_commit IS NULL THEN outcomes.${c} ELSE excluded.${c} END`
            : ROUND_COLUMNS.has(c)
              ? `${c} = CASE WHEN excluded.passes IS NULL THEN outcomes.${c} ELSE excluded.${c} END`
              : `${c} = excluded.${c}`
        )
        .join(", ");
      m.prepare(
        `INSERT INTO outcomes (${OUTCOME_COLUMNS.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(run, task) DO UPDATE SET ${updateSet}`
      ).run(...values);
      if (existing) updated++;
      else inserted++;
    }
    m.exec("COMMIT");
  } catch (err) {
    m.exec("ROLLBACK");
    throw err;
  }
  return { inserted, updated };
}

export function listOutcomes(m, { run = null, task = null } = {}) {
  const clauses = [];
  const args = [];
  if (run !== null) {
    clauses.push("run = ?");
    args.push(run);
  }
  if (task !== null) {
    clauses.push("task = ?");
    args.push(task);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = m.prepare(`SELECT * FROM outcomes ${where} ORDER BY recorded ASC, task ASC`).all(...args);
  return rows.map((row) => {
    const out = { ...row };
    for (const c of JSON_COLUMNS) out[c] = parseJsonColumn(row[c], c === "blocks" ? [] : null);
    return out;
  });
}

// Compare outcome arms by memory configuration (card memory-outcome-arms, ADR 0019 Measurement). Reads outcomes and
// reflections only. One arm per distinct memory_config, ordered by the arm's earliest recorded row; rows with no
// memory_config are counted in `unstamped` and belong to no arm. landings are rows with a commit, stops rows with
// no commit and either a stop_class or a `stop:` run (a stop row with no typed cause). An arm is compared (`ready`) once it has `min` landings; until then its four metrics
// are null: landRate = landings / (landings + stops); fixRounds = mean fix_passes over landings that have one
// (n of them; mean null when n is 0); harmfulPerLanding = harmful marks of the reflections joined to a landing
// by card and commit_sha, per landing; costPerLanding = mean usd over priced landings (null when none).
export function compareMemoryArms(m, { min = 12 } = {}) {
  const rows = m.prepare("SELECT * FROM outcomes ORDER BY recorded ASC, id ASC").all();
  const byConfig = new Map();
  let unstamped = 0;
  for (const row of rows) {
    if (row.memory_config === null || row.memory_config === undefined) {
      unstamped++;
      continue;
    }
    if (!byConfig.has(row.memory_config)) byConfig.set(row.memory_config, []);
    byConfig.get(row.memory_config).push(row);
  }
  const reflections = m.prepare("SELECT card, commit_sha, counters FROM reflections WHERE card IS NOT NULL AND commit_sha IS NOT NULL").all();
  const harmfulOf = (r) => {
    try {
      const h = JSON.parse(r.counters).harmful;
      return Array.isArray(h) ? h.length : 0;
    } catch {
      return 0;
    }
  };
  const arms = [];
  for (const [config, armRows] of byConfig) {
    const landed = armRows.filter((r) => r.commit_sha !== null && r.commit_sha !== undefined);
    const stops = armRows.filter((r) => (r.commit_sha === null || r.commit_sha === undefined) && ((r.stop_class !== null && r.stop_class !== undefined) || (typeof r.run === "string" && r.run.startsWith("stop:")))).length;
    const landings = landed.length;
    const ready = landings >= min;
    const arm = { config, landings, stops, ready, landRate: null, fixRounds: null, harmfulPerLanding: null, costPerLanding: null, priced: null };
    if (ready) {
      arm.landRate = landings / (landings + stops);
      const fixes = landed.map((r) => r.fix_passes).filter((v) => typeof v === "number");
      arm.fixRounds = { mean: fixes.length ? fixes.reduce((a, b) => a + b, 0) / fixes.length : null, n: fixes.length };
      const keys = new Set(landed.map((r) => `${r.task}\u0000${r.commit_sha}`));
      let harmful = 0;
      for (const r of reflections) if (keys.has(`${r.card}\u0000${r.commit_sha}`)) harmful += harmfulOf(r);
      arm.harmfulPerLanding = harmful / landings;
      const usds = landed.map((r) => r.usd).filter((v) => typeof v === "number");
      arm.priced = usds.length;
      arm.costPerLanding = usds.length ? usds.reduce((a, b) => a + b, 0) / usds.length : null;
    }
    arms.push(arm);
  }
  return { min, unstamped, arms, comparable: arms.filter((a) => a.ready).length >= 2 };
}

// --- reflect (card memory-reflect) ------------------------------------------------------------------------------
// A cheap-row LLM pass, run after `memory.mjs record`, that proposes at most 3 lessons from one report and bumps
// helpful/harmful counters on lessons the report's tasks used. Everything here is pure and unit-testable except
// the spawn itself, which the caller supplies as `propose` (scripts/memory.mjs's thin CLI wrapper spawns the real
// `claude` binary; a test passes a fake). Lessons stay add-only: nothing here ever rewrites or deletes a row.

export const REFLECT_DUPLICATE_JACCARD = 0.6;

export const REFLECT_SCHEMA = {
  type: "object",
  required: ["lessons"],
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "text", "citation", "task", "notDerivableBecause"],
        properties: {
          kind: { enum: ["pitfall", "pattern"] },
          text: { type: "string" },
          citation: { type: "string" },
          task: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          notDerivableBecause: { type: "string" },
          // Optional (card memory-reflect-supersede, ADR 0019 card 8): the id of one existing lesson listed in the
          // prompt that this proposal repeats (nothing new is written, that lesson's seen count rises) or
          // supersedes (it contradicts or corrects it). Never both; code checks the id is live and listed.
          repeats: { type: "string" },
          supersedes: { type: "string" },
          // Optional (card reflect-offers-claude-md): the CLAUDE.md bullet this lesson would be, only when it is a
          // rule a future session should follow.
          claudeMd: {
            type: "object",
            required: ["heading", "line"],
            properties: { heading: { type: "string" }, line: { type: "string" } },
          },
        },
      },
    },
  },
};

function findReportTask(report, taskId) {
  for (const level of report.levels || []) {
    const found = (level.tasks || []).find((t) => t.id === taskId);
    if (found) return found;
  }
  return null;
}

function reflectionRowToObject(row) {
  if (!row) return null;
  return {
    ...row,
    counters: parseJsonColumn(row.counters, { helpful: [], harmful: [], unknown: [] }),
    appended: parseJsonColumn(row.appended, []),
    bumped: parseJsonColumn(row.bumped, []),
    rejected: parseJsonColumn(row.rejected, []),
  };
}

// The archive rule (card memory-feedback-rank, ADR 0019): harmful at least min and at least helpful. Archived
// rows are kept (never deleted) and hidden from recall; ARCHIVE_HARMFUL_MIN is the bench-checked threshold.
export const ARCHIVE_HARMFUL_MIN = 2;
export function meetsArchiveRule({ harmful, helpful }, min = ARCHIVE_HARMFUL_MIN) {
  return harmful >= min && harmful >= helpful;
}

// Deterministic, no LLM. harmful is an explicit mark (card reflect-harmful-irrelevant-lessons): only an id in
// `harmfulIds` (the lead's judgement that the lesson misled the work) gets harmful +1, once however often it is
// named or used; a real block alone bumps nothing. For each task whose memoryUsed is non-empty, a real block earns
// no helpful (real wins even when the task also verified; except on the hand track, whose reviewer blocks never withhold it), else a first-verified task bumps helpful on every used
// lesson not named harmful; neither verified nor real does nothing. An id naming no lesson is reported in
// `unknown`, never an error. apply:false (a dry run's preview) computes the same result without writing anything.
function computeReflectCounters(m, blocks, report, { apply, harmfulIds = [] }) {
  const helpful = [];
  const harmful = [];
  const unknown = [];
  const named = new Set(harmfulIds);
  for (const id of named) {
    if (getLesson(m, id)) {
      if (apply) m.prepare("UPDATE lessons SET harmful = harmful + 1 WHERE id = ?").run(id);
      harmful.push(id);
    } else {
      unknown.push(id);
    }
  }
  for (const level of report.levels || []) {
    for (const task of level.tasks || []) {
      const used = Array.isArray(task.memoryUsed) ? task.memoryUsed : [];
      if (!used.length) continue;
      // A hand report's blocks are reviewer blockers a later round fixed (card reflect-review-key-text): they are no
      // evidence the lesson misled, so they never withhold helpful; only --harmful marks that.
      const real = report.track !== "hand" && blocks.some((b) => b.task === task.id && b.class === "real");
      if (real) {
        for (const id of used) {
          if (!getLesson(m, id) && !named.has(id)) unknown.push(id);
        }
      } else if (task.verified === true) {
        for (const id of used) {
          if (named.has(id)) continue;
          if (getLesson(m, id)) {
            if (apply) m.prepare("UPDATE lessons SET helpful = helpful + 1 WHERE id = ?").run(id);
            helpful.push(id);
          } else {
            unknown.push(id);
          }
        }
      }
    }
  }
  return { helpful, harmful, unknown };
}

// The store can grow past what a cheap-row prompt should carry; buildReflectPrompt shows only the most recently
// created/confirmed REFLECT_PROMPT_LESSON_CAP of them (recency is what a fresh proposal is most likely to
// collide with) and says so in the prompt, rather than growing the prompt — and the pass's price — unbounded.
export const REFLECT_PROMPT_LESSON_CAP = 200;

function mostRecentLessons(lessons, limit) {
  const withTime = lessons.map((l) => {
    const t = new Date(l.confirmed || l.created).getTime();
    return { lesson: l, t: Number.isFinite(t) ? t : 0 };
  });
  withTime.sort((a, b) => b.t - a.t);
  return withTime.slice(0, limit).map((x) => x.lesson);
}

// The `## ` headings of CLAUDE.md at dir ([] when it is missing or unreadable).
function claudeMdHeadings(dir) {
  try {
    return readFileSync(join(dir, "CLAUDE.md"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.trim());
  } catch {
    return [];
  }
}

// The prompt for the cheap-row pass: the rules in plain words, every task's facts (owned files from the plan when
// it names the task, verified/passes/stopReason, review and verifier findings, its blocks with class and reason,
// memoryUsed), the id and text of the most recently created/confirmed existing lessons (so the model avoids
// re-proposing them; capped at REFLECT_PROMPT_LESSON_CAP, said so in the prompt when it is), and the citation
// forms it may use. Filter C.4's duplicate check still runs against the full, uncapped set of existing lessons —
// this cap only bounds what the model itself sees.
export function buildReflectPrompt(report, { blocks = [], plan = null, existingLessons = [], dir = null } = {}) {
  const lines = [];
  lines.push("You are proposing at most 3 lessons for a coding harness's memory store, from one workflow report.");
  lines.push("Every rule below is enforced again in code after you answer, so follow it exactly:");
  lines.push('- kind "pitfall" is valid only for a task that has at least one block classed real below.');
  lines.push('- kind "pattern" is valid only for a task that verified true on its first pass (passes 1).');
  lines.push(
    '- citation must be exactly one of: "report:<task>/<block-id>" naming a block below, "report:<task>" naming a task below, or "path:line" / \'path:line "quoted text"\' naming a real line in this checkout.'
  );
  lines.push("- notDerivableBecause must say why the lesson is not something a reader could already get by reading the code; never restate a fact already sitting verbatim in a file.");
  lines.push("- never propose a lesson whose text is already covered by one of the existing lessons listed below.");
  lines.push(
    "- supersedes is optional: set it to the id of one existing lesson listed below when your new lesson contradicts or corrects that lesson. The old lesson is then retired in favour of yours."
  );
  lines.push(
    "- repeats is optional: set it to the id of one existing lesson listed below when your lesson says the same thing as that lesson. Nothing new is written and that lesson's seen count rises. Never set both repeats and supersedes."
  );
  lines.push("- propose at most 3 lessons; an empty list is a perfectly good answer when nothing here is worth remembering.");
  lines.push("- a task marked partial=true below ran out of context, not verification; propose no lesson that blames its code or its tests for that.");
  const headings = dir ? claudeMdHeadings(dir) : [];
  if (headings.length) {
    lines.push(
      "- claudeMd is optional: add { heading, line } to a lesson only when it is a rule a future session should follow. line is exactly one bullet starting with \"- \", heading is one of the existing CLAUDE.md headings below, and never ## Models or ## Commands. Omit it otherwise."
    );
    lines.push(`  CLAUDE.md headings: ${headings.join(" | ")}`);
  }
  lines.push("");
  lines.push("Tasks in this report:");
  for (const level of report.levels || []) {
    for (const task of level.tasks || []) {
      const planTask = plan && Array.isArray(plan.tasks) ? plan.tasks.find((t) => t.id === task.id) : null;
      const ownedFiles = planTask && Array.isArray(planTask.files) ? planTask.files : [];
      const taskBlocks = blocks.filter((b) => b.task === task.id);
      const used = Array.isArray(task.memoryUsed) ? task.memoryUsed : [];
      lines.push(`- ${task.id}: verified=${task.verified === true} passes=${task.passes ?? "null"} stopReason=${task.stopReason ?? "null"} partial=${task.partial === true}`);
      if (ownedFiles.length) lines.push(`  owned files: ${ownedFiles.join(", ")}`);
      if (Array.isArray(task.reviewIssues) && task.reviewIssues.length) lines.push(`  review issues: ${JSON.stringify(task.reviewIssues)}`);
      if (Array.isArray(task.verifierFindings) && task.verifierFindings.length) lines.push(`  verifier findings: ${JSON.stringify(task.verifierFindings)}`);
      if (taskBlocks.length) {
        lines.push("  blocks:");
        for (const b of taskBlocks) lines.push(`    - report:${b.id.startsWith(`${task.id}/`) ? b.id : `${task.id}/${b.id}`} class=${b.class || "unclassified"} reason=${b.reason || "none"}`);
      }
      lines.push(`  memoryUsed: ${used.length ? used.join(", ") : "none"}`);
    }
  }
  lines.push("");
  lines.push("Existing lessons (never propose a near-duplicate of one of these; name one in repeats or supersedes when it applies):");
  const shownLessons = mostRecentLessons(existingLessons, REFLECT_PROMPT_LESSON_CAP);
  if (existingLessons.length > REFLECT_PROMPT_LESSON_CAP) {
    lines.push(`(showing the ${REFLECT_PROMPT_LESSON_CAP} most recently created/confirmed of ${existingLessons.length} total; older lessons are not shown)`);
  }
  if (shownLessons.length) {
    for (const l of shownLessons) lines.push(`- ${l.id} (${l.kind}): ${l.text}`);
  } else {
    lines.push("(none yet)");
  }
  if (report.hand && typeof report.hand === "object") appendHandMaterial(lines, report.hand);
  return lines.join("\n") + "\n";
}

// A hand landing's saved material (card memory-every-session): each file capped at HAND_FILE_CHAR_CAP, all of it at
// HAND_TOTAL_CHAR_CAP, the landing note last so a budget spent on files still leaves the note.
const HAND_FILE_CHAR_CAP = 4000;
const HAND_TOTAL_CHAR_CAP = 16000;
const HAND_TRUNCATED = "\u2026[truncated]";

function appendHandMaterial(lines, hand) {
  lines.push("");
  lines.push("Hand-track material (briefs, reviewer reports, landing note; the rules above still apply, cite report:<card> or report:<card>/R<n>):");
  const note = typeof hand.note === "string" && hand.note.trim() ? hand.note : null;
  const cutNote = note && note.length > HAND_FILE_CHAR_CAP ? note.slice(0, HAND_FILE_CHAR_CAP) + HAND_TRUNCATED : note;
  let budget = HAND_TOTAL_CHAR_CAP - (cutNote ? cutNote.length : 0);
  const add = (label, files) => {
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || typeof f.text !== "string") continue;
      if (budget <= 0) break;
      let text = f.text.length > HAND_FILE_CHAR_CAP ? f.text.slice(0, HAND_FILE_CHAR_CAP) + HAND_TRUNCATED : f.text;
      if (text.length > budget) text = text.slice(0, budget) + HAND_TRUNCATED;
      budget -= text.length;
      lines.push(`--- ${label} ${f.name || ""} ---`);
      lines.push(text);
    }
  };
  add("brief", hand.briefs);
  add("reviewer report", hand.reviews);
  if (cutNote) {
    lines.push("--- landing note ---");
    lines.push(cutNote);
  }
}

// Citation filter (C.2): a "report:" citation is checked against `report` (never unchecked here, unlike
// checkCitation's default), a path:line citation against `dir` via checkCitation; anything else — free text, an
// empty string, a report: citation shaped wrong — is rejected outright.
function checkReflectCitation(citation, { dir, report }) {
  if (typeof citation !== "string" || !citation.trim()) return { ok: false, reason: "citation is empty" };
  if (citation.startsWith("report:")) return checkCitation({ citation }, dir, { report });
  if (CITATION_RE.test(citation)) return checkCitation({ citation }, dir);
  return { ok: false, reason: "citation is neither a report: form nor a path:line form" };
}

function normalizeReflectText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Not-derivable filter (C.3): the lesson text must not already sit verbatim (whitespace-normalised, case-folded)
// in the cited file (for a path:line citation) or in CLAUDE.md at dir — a fact already in the checkout is not a
// lesson worth remembering.
function checkReflectDerivable(proposal, dir) {
  const normalizedText = normalizeReflectText(proposal.text);
  const candidates = [];
  const match = typeof proposal.citation === "string" ? proposal.citation.match(CITATION_RE) : null;
  if (match) candidates.push(match.groups.path);
  candidates.push("CLAUDE.md");
  for (const relPath of candidates) {
    const filePath = resolve(dir, relPath);
    if (!existsSync(filePath)) continue;
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (normalizedText && normalizeReflectText(content).includes(normalizedText)) {
      return { ok: false, reason: `the lesson text appears verbatim in ${relPath}` };
    }
  }
  return { ok: true, reason: "not derivable" };
}

export function reflectTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
  );
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Near-duplicate filter (C.4). Two ways a proposal is a duplicate:
//  - an addLesson id collision (same kind+citation+text hash as a row that already exists in the store, live or
//    superseded) — checked against the store directly with getLesson, not just the live candidate list, so a
//    collision with an old superseded lesson is never missed. A collision with a *superseded* row cannot be
//    bumped (there is nothing live to bump) and cannot be appended either (addLesson would throw: the id is
//    already taken), so it is rejected with a reason instead — never left to throw out of runReflect.
//  - Jaccard similarity over lower-cased word tokens (length >= 3) at or above REFLECT_DUPLICATE_JACCARD against
//    every non-superseded existing lesson or a row appended earlier in this same pass (`existingLessons` and
//    `appendedRows`), so two near-identical proposals in one pass only ever add the first.
// Returns { duplicate: <live lesson row> } (an identical hash: a repeat), { similar: <lesson row> } (word overlap,
// never merged), { rejected: <superseded lesson row> }, or null (not a dup). skipSimilarity: a model judgement
// (supersedes) was given, so word overlap is not consulted.
function findReflectDuplicate(m, proposal, { existingLessons, appendedRows, skipSimilarity = false }) {
  const proposalId = computeLessonId({ kind: proposal.kind, citation: proposal.citation || null, text: proposal.text });
  const collision = getLesson(m, proposalId);
  if (collision) return collision.superseded_by ? { rejected: collision } : { duplicate: collision };
  for (const row of appendedRows) {
    if (row.id === proposalId) return { duplicate: row };
  }
  if (skipSimilarity) return null;
  const tokens = reflectTokens(proposal.text);
  for (const lesson of [...existingLessons, ...appendedRows]) {
    if (jaccard(tokens, reflectTokens(lesson.text)) >= REFLECT_DUPLICATE_JACCARD) return { similar: lesson };
  }
  return null;
}

// Filters C.1-C.4, in order. C.5 (at most 3 appended) is enforced by the caller, but only against a proposal
// this function has already said ok:true and not a duplicate — a would-be duplicate past the cap still bumps.
// Returns { ok:true }, { ok:true, duplicate:<lesson row> } (bump instead of append), or { ok:false, reason }.
function evaluateReflectProposal(m, report, blocks, proposal, { dir, existingLessons, appendedRows, judgement = null }) {
  if (!proposal || typeof proposal !== "object") return { ok: false, reason: "proposal is not an object" };
  const { kind, text, citation, task, notDerivableBecause } = proposal;
  if (kind !== "pitfall" && kind !== "pattern") return { ok: false, reason: `kind must be "pitfall" or "pattern", got ${JSON.stringify(kind)}` };
  if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "text is empty" };
  const reportTask = typeof task === "string" ? findReportTask(report, task) : null;
  if (!reportTask) return { ok: false, reason: `no task "${task}" in this report` };
  if (kind === "pitfall") {
    if (!blocks.some((b) => b.task === task && b.class === "real")) return { ok: false, reason: `task "${task}" has no block classed real` };
  } else if (reportTask.verified !== true || reportTask.passes !== 1) {
    return { ok: false, reason: `task "${task}" did not verify on its first pass` };
  }
  const citationCheck = checkReflectCitation(citation, { dir, report });
  if (!citationCheck.ok) return { ok: false, reason: `citation: ${citationCheck.reason}` };
  if (typeof notDerivableBecause !== "string" || !notDerivableBecause.trim()) return { ok: false, reason: "notDerivableBecause is empty" };
  const derivableCheck = checkReflectDerivable(proposal, dir);
  if (!derivableCheck.ok) return derivableCheck;
  // A valid repeats judgement: nothing new is written, the named lesson's seen count rises.
  if (judgement && judgement.kind === "repeats") return { ok: true, duplicate: judgement.target };
  const dup = findReflectDuplicate(m, proposal, { existingLessons, appendedRows, skipSimilarity: Boolean(judgement) });
  if (dup && dup.rejected) return { ok: false, reason: `addLesson id collision with a superseded lesson ${dup.rejected.id}` };
  // An identical hash is a code fact, not a similarity score: a repeat of the colliding lesson.
  if (dup && dup.duplicate) return { ok: true, duplicate: dup.duplicate };
  // The similarity score never merges (ADR 0019 card 8): with no judgement a near-duplicate is dropped.
  if (dup && dup.similar) {
    return { ok: false, reason: `near-duplicate of ${dup.similar.id} (word overlap >= ${REFLECT_DUPLICATE_JACCARD}); no repeats or supersedes judgement` };
  }
  if (judgement && judgement.kind === "supersedes") return { ok: true, supersedes: judgement.target };
  return { ok: true };
}

// Cost (D): prefer the real per-message transcript at <claudeDir>/projects/<projectSlug(dir)>/<sessionId>.jsonl,
// same as cost.mjs prices every other agent; fall back to the envelope's own total_cost_usd (a client-side
// estimate) when the transcript is missing or its model is unpriced; null with no source when neither is usable.
export function computeReflectCost({ dir, claudeDir, sessionId, totalCostUsd }) {
  const resolvedClaudeDir = claudeDir || join(homedir(), ".claude");
  if (sessionId) {
    const file = join(resolvedClaudeDir, "projects", projectSlug(dir), `${sessionId}.jsonl`);
    if (existsSync(file)) {
      try {
        const t = transcriptUsage(file);
        const usd = t.usd;
        if (usd !== null) return { usd, usdSource: "transcript" };
      } catch {
        // fall through to the envelope's own number
      }
    }
  }
  if (typeof totalCostUsd === "number") return { usd: totalCostUsd, usdSource: "claude" };
  return { usd: null, usdSource: null };
}

// Does a lesson already have a home (card reflect-offers-claude-md)? home:true when the cheap pass gave no usable
// CLAUDE.md suggestion, when a hook under .doug/hooks/scripts already enforces it (the lesson text or the
// suggestion names a script as a whole word, with or without .mjs), or when an existing CLAUDE.md bullet already
// contains at least 60% of the suggestion line's tokens (containment over the suggestion's tokens, reflectTokens;
// a line with no tokens counts as covered). { home:false } means: offer a candidate.
export const CLAUDE_MD_COVERED_CONTAINMENT = 0.6;

export function claudeMdHome({ dir, lesson, suggestion } = {}) {
  if (!suggestion || typeof suggestion !== "object" || typeof suggestion.heading !== "string" || typeof suggestion.line !== "string") {
    return { home: true, why: "no suggestion" };
  }
  const haystack = `${lesson && typeof lesson.text === "string" ? lesson.text : ""}\n${suggestion.line}`;
  let scripts = [];
  try {
    scripts = readdirSync(join(dir, ".doug", "hooks", "scripts"))
      .filter((n) => n.endsWith(".mjs"))
      .map((n) => n.slice(0, -4));
  } catch {
    scripts = [];
  }
  for (const name of scripts) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\w-])${escaped}(?:\\.mjs)?(?![\\w-])`).test(haystack)) {
      return { home: true, why: `enforced by the ${name} gate script` };
    }
  }
  const tokens = reflectTokens(suggestion.line);
  if (tokens.size === 0) return { home: true, why: "the suggestion line has no content words" };
  let text = "";
  try {
    text = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  } catch {
    return { home: false };
  }
  let inFence = false;
  for (const existing of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(existing)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !existing.startsWith("- ")) continue;
    const have = reflectTokens(existing);
    let shared = 0;
    for (const t of tokens) if (have.has(t)) shared++;
    if (shared / tokens.size >= CLAUDE_MD_COVERED_CONTAINMENT) return { home: true, why: `already covered by CLAUDE.md line: ${existing}` };
  }
  return { home: false };
}

// A standing CLAUDE.md offer for each APPENDED lesson with no home (card reflect-offers-claude-md). Runs for the
// report form and the --hand form alike (the hand CLI assembles a report and calls runReflect). The edits file is
// checked with proposeClaudeMd in dryRun, written only when ok (and never under --dry-run) to
// .doug/.state/learn/claude-md-candidates/<lesson id>.json; a refusal is dropped with its reason. CLAUDE.md is never
// written and learn.mjs apply never runs: the printed command only makes a diff.
async function offerClaudeMdCandidates({ dir, dryRun, reportHash, card, appendedRows, suggestions }) {
  const claudeMd = [];
  const claudeMdDropped = [];
  const { proposeClaudeMd } = await import("./decisions.mjs");
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/memory.mjs");
  for (const row of appendedRows) {
    const s = suggestions.get(row.id);
    if (!s || claudeMdHome({ dir, lesson: { text: s.text }, suggestion: s.claudeMd }).home) continue;
    const edits = {
      note: `reflect ${card || reportHash.slice(0, 12)}: lesson ${row.id}`,
      add: [{ heading: s.claudeMd.heading, line: s.claudeMd.line, source: `lesson ${row.id}` }],
    };
    const checked = proposeClaudeMd({ dir, edits, dryRun: true });
    if (!checked.ok) {
      claudeMdDropped.push({ lessonId: row.id, reason: checked.reason });
      continue;
    }
    const file = join(dir, ".doug/.state/learn/claude-md-candidates", `${row.id}.json`);
    if (!dryRun) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(edits, null, 2) + "\n", "utf8");
    }
    claudeMd.push({ lessonId: row.id, file, command: `node ${script} claude-md propose --file ${file}` });
  }
  return { claudeMd, claudeMdDropped };
}

// The whole reflect pass (card memory-reflect): counters first (committed even if the LLM pass fails), then the
// cheap-row pass via `propose`, then the filters in C, then cost. Idempotent on report_hash: a second call on the
// same report does nothing and returns { alreadyReflected: true, row }. `propose(prompt)` resolves to
// { lessons, sessionId, totalCostUsd } or throws/rejects on any failure (a spawn error, a timeout, unparseable
// output, is_error, or a missing structured_output.lessons array) — this function never spawns anything itself,
// so a test's fake `propose` never touches a real `claude` binary.
export async function runReflect(m, report, opts = {}) {
  const {
    reportHash,
    dir = process.cwd(),
    classes = [],
    plan = null,
    run = null,
    card = null,
    commit = null,
    model = null,
    claudeDir,
    dryRun = false,
    harmful = [],
    propose,
    now = nowIso(),
  } = opts;
  if (!reportHash) throw new Error("runReflect requires a reportHash");
  if (typeof propose !== "function" && !dryRun) throw new Error("runReflect requires a propose function");

  const existing = m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get(reportHash);
  if (existing) return { alreadyReflected: true, row: reflectionRowToObject(existing) };

  // classifyBlocks throws on an --adversary id the report does not have, the same way record fails; this must
  // happen before any write, so it is the very first thing after the idempotency check.
  const blocks = classifyBlocks(report, classes);

  // A harmful id must be one a task recalled; refused before any write, naming it and the recalled ids.
  const harmfulIds = [...new Set(harmful)];
  if (harmfulIds.length) {
    const recalled = new Set();
    for (const level of report.levels || []) {
      for (const task of level.tasks || []) {
        if (Array.isArray(task.memoryUsed)) for (const id of task.memoryUsed) recalled.add(id);
      }
    }
    const outside = harmfulIds.filter((id) => !recalled.has(id));
    if (outside.length) {
      throw new Error(
        `--harmful id(s) not in any task's memoryUsed: ${outside.join(", ")}. memoryUsed ids: ${recalled.size ? [...recalled].join(", ") : "(none)"}.`
      );
    }
  }

  let counters;
  const archived = [];
  if (dryRun) {
    counters = computeReflectCounters(m, blocks, report, { apply: false, harmfulIds });
  } else {
    m.exec("BEGIN");
    try {
      counters = computeReflectCounters(m, blocks, report, { apply: true, harmfulIds });
      for (const id of counters.harmful) {
        const row = getLesson(m, id);
        if (!row || row.archived || !meetsArchiveRule(row)) continue;
        m.prepare("UPDATE lessons SET archived = ?, archived_reason = ? WHERE id = ?").run(
          now,
          `harmful ${row.harmful}, helpful ${row.helpful}`,
          id
        );
        archived.push(id);
      }
      m.prepare(
        `INSERT INTO reflections (report_hash, recorded, run, card, commit_sha, model, counters, proposed, appended, bumped, rejected, usd, usd_source, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run(reportHash, now, run, card, commit, model, JSON.stringify(counters));
      m.exec("COMMIT");
    } catch (err) {
      m.exec("ROLLBACK");
      throw err;
    }
  }

  const existingLessons = listLessons(m);
  const prompt = buildReflectPrompt(report, { blocks, plan, existingLessons, dir });

  // A dry run with no propose makes no model call: it reports the counters it would credit and the prompt it would send, and spends nothing.
  if (dryRun && typeof propose !== "function") {
    return {
      ok: true,
      dryRun: true,
      reportHash,
      prompt,
      counters,
      archived: [],
      proposed: null,
      appended: [],
      bumped: [],
      rejected: [],
      claudeMd: [],
      claudeMdDropped: [],
      notes: [],
      superseded: [],
      usd: 0,
      usdSource: "none",
      model,
      sessionId: null,
    };
  }

  let proposeResult = null;
  let proposeError = null;
  try {
    proposeResult = await propose(prompt);
    if (!proposeResult || !Array.isArray(proposeResult.lessons)) throw new Error("the cheap-row pass returned no lessons array");
  } catch (err) {
    proposeError = err;
  }

  if (proposeError) {
    const rejected = [{ text: null, reason: proposeError.message }];
    if (!dryRun) {
      m.prepare(`UPDATE reflections SET proposed = ?, appended = ?, bumped = ?, rejected = ? WHERE report_hash = ?`).run(
        null,
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify(rejected),
        reportHash
      );
    }
    return {
      ok: false,
      dryRun,
      reportHash,
      counters,
      archived,
      proposed: null,
      appended: [],
      bumped: [],
      rejected,
      usd: null,
      usdSource: null,
      claudeMd: [],
      claudeMdDropped: [],
      notes: [],
      superseded: [],
      model,
      sessionId: null,
      reason: proposeError.message,
    };
  }

  const proposals = proposeResult.lessons;
  const sessionId = proposeResult.sessionId || null;
  const totalCostUsd = typeof proposeResult.totalCostUsd === "number" ? proposeResult.totalCostUsd : null;

  const appendedRows = [];
  const suggestions = new Map(); // lesson id -> { lesson text, claudeMd suggestion } for appended lessons only
  const bumped = [];
  const rejected = [];
  const notes = [];
  const superseded = [];
  const shownIds = new Set(mostRecentLessons(existingLessons, REFLECT_PROMPT_LESSON_CAP).map((l) => l.id));
  const supersededThisPass = new Set();
  for (const proposal of proposals) {
    const judged = judgeReflectProposal(m, proposal, { shownIds, supersededThisPass, notes });
    if (judged.reject) {
      rejected.push({ text: proposal && typeof proposal.text === "string" ? proposal.text : null, reason: judged.reject });
      continue;
    }
    const verdict = evaluateReflectProposal(m, report, blocks, proposal, { dir, existingLessons, appendedRows, judgement: judged.judgement });
    if (verdict.duplicate) {
      // The 3-item cap (C.5) limits appends, never evaluation: a repeat found past the cap still bumps seen on
      // the lesson it names, it is just never counted against the 3. A repeat bumps seen, never helpful.
      if (!dryRun) m.prepare("UPDATE lessons SET seen = seen + 1 WHERE id = ?").run(verdict.duplicate.id);
      bumped.push(verdict.duplicate.id);
      if (judged.judgement && judged.judgement.kind === "supersedes") {
        notes.push(`supersedes ${judged.judgement.target.id} ignored: the proposal is an exact repeat of ${verdict.duplicate.id}`);
      }
      continue;
    }
    if (!verdict.ok) {
      rejected.push({ text: proposal && typeof proposal.text === "string" ? proposal.text : null, reason: verdict.reason });
      continue;
    }
    if (appendedRows.length >= 3) {
      rejected.push({ text: proposal && typeof proposal.text === "string" ? proposal.text : null, reason: "at most 3 lessons appended per reflection" });
      continue;
    }
    if (dryRun) {
      const dryId = computeLessonId({ kind: proposal.kind, citation: proposal.citation || null, text: proposal.text });
      appendedRows.push({ id: dryId, text: proposal.text, kind: proposal.kind });
      suggestions.set(dryId, { text: proposal.text, claudeMd: proposal.claudeMd });
      if (verdict.supersedes) {
        superseded.push({ old: verdict.supersedes.id, new: dryId });
        supersededThisPass.add(verdict.supersedes.id);
      }
      continue;
    }
    const reportTask = findReportTask(report, proposal.task);
    const row = addLesson(m, {
      text: proposal.text,
      kind: proposal.kind,
      scope: Array.isArray(proposal.scope) ? proposal.scope : [],
      citation: proposal.citation || null,
      source: { agent: "reflect", model },
      task: proposal.task,
      card: card != null ? card : (reportTask && reportTask.card) || null,
      commit: commit != null ? commit : (reportTask && reportTask.commit) || null,
    });
    appendedRows.push(row);
    suggestions.set(row.id, { text: proposal.text, claudeMd: proposal.claudeMd });
    if (verdict.supersedes) {
      try {
        supersedeLesson(m, verdict.supersedes.id, row.id);
        superseded.push({ old: verdict.supersedes.id, new: row.id });
        supersededThisPass.add(verdict.supersedes.id);
      } catch (err) {
        notes.push(`supersedes ${verdict.supersedes.id} not applied: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  let claudeMd = [];
  let claudeMdDropped = [];
  try {
    ({ claudeMd, claudeMdDropped } = await offerClaudeMdCandidates({ dir, dryRun, reportHash, card, appendedRows, suggestions }));
  } catch (err) {
    // Fail open: the offer is advisory, so an error never leaves the reflection half-written.
    const message = err && err.message ? err.message : String(err);
    claudeMd = [];
    claudeMdDropped = appendedRows.map((r) => ({ lessonId: r.id, reason: `claude-md offer failed: ${message}` }));
  }

  const cost = computeReflectCost({ dir, claudeDir, sessionId, totalCostUsd });

  if (!dryRun) {
    m.prepare(
      `UPDATE reflections SET proposed = ?, appended = ?, bumped = ?, rejected = ?, usd = ?, usd_source = ?, session_id = ? WHERE report_hash = ?`
    ).run(
      proposals.length,
      JSON.stringify(appendedRows.map((r) => r.id)),
      JSON.stringify(bumped),
      JSON.stringify(rejected),
      cost.usd,
      cost.usdSource,
      sessionId,
      reportHash
    );
  }

  return {
    ok: true,
    dryRun,
    reportHash,
    counters,
    archived,
    proposed: proposals.length,
    appended: appendedRows.map((r) => r.id),
    bumped,
    rejected,
    claudeMd,
    claudeMdDropped,
    notes,
    superseded,
    usd: cost.usd,
    usdSource: cost.usdSource,
    model,
    sessionId,
  };
}

// The judgement fields of one reflect proposal (card memory-reflect-supersede). A target is valid only when it is
// one of the lessons the prompt listed, is live, and was not superseded earlier in this pass. An invalid id is
// ignored with a note and the proposal goes on as if the field were absent. Both fields set is a rejection.
function judgeReflectProposal(m, proposal, { shownIds, supersededThisPass, notes }) {
  const field = (name) => (proposal && typeof proposal[name] === "string" && proposal[name].trim() ? proposal[name].trim() : null);
  const repeatsId = field("repeats");
  const supersedesId = field("supersedes");
  if (repeatsId && supersedesId) return { reject: "repeats and supersedes are both set; name one lesson in one field" };
  const check = (name, id) => {
    const row = getLesson(m, id);
    let why = null;
    if (!row) why = "no such lesson";
    else if (row.superseded_by || supersededThisPass.has(id)) why = "already superseded";
    else if (!shownIds.has(id)) why = "not listed in the prompt";
    if (why) {
      notes.push(`${name} ${id} ignored: ${why}`);
      return null;
    }
    return row;
  };
  if (repeatsId) {
    const target = check("repeats", repeatsId);
    return { judgement: target ? { kind: "repeats", target } : null };
  }
  if (supersedesId) {
    const target = check("supersedes", supersedesId);
    return { judgement: target ? { kind: "supersedes", target } : null };
  }
  return { judgement: null };
}

// --- failure lessons (card memory-failure-lessons, ADR 0019 lines 39-41 and 60) -------------------------------------
// Reflection over the failure slice of the run history: stopped reports, blocks classed `real`, and denials. A
// pitfall cites the exact history line (history:<card>/<run>:<line>); a repeat of a pitfall is the model's `repeats`
// judgement and lands in an append-only occurrence ledger (never in helpful, never from word similarity), which
// learn.mjs counts by distinct cards and sessions.

export const PITFALL_LEDGER_RELPATH = ".doug/.state/memory/pitfalls.jsonl";

const FAILURE_ITEM_TEXT_MAX = 4000;
const FAILURE_PROMPT_MAX = 16000;
const FAILURE_TAIL_MAX = 1000;
const FAILURE_APPEND_MAX = 3;

function parseJsonObject(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function failureItemText(kind, v, raw) {
  const parts = [];
  if (kind === "stop") {
    for (const k of ["reason", "stoppedAt", "detail", "error"]) if (typeof v[k] === "string" && v[k]) parts.push(`${k}: ${v[k]}`);
    if (!parts.length) parts.push(`report: ${raw}`);
  } else if (kind === "block") {
    if (typeof v.reason === "string") parts.push(`reason: ${v.reason}`);
    for (const f of Array.isArray(v.failures) ? v.failures : []) {
      if (!f || typeof f !== "object") continue;
      const tail = typeof f.tail === "string" ? f.tail.slice(-FAILURE_TAIL_MAX) : "";
      parts.push(`command: ${f.command ?? ""} (exit ${f.exit ?? "?"}${f.timedOut ? ", timed out" : ""})${tail ? `\n${tail}` : ""}`);
    }
  } else {
    parts.push(`tool: ${v.tool ?? ""}`);
    if (v.detail !== undefined) parts.push(`detail: ${typeof v.detail === "string" ? v.detail : JSON.stringify(v.detail)}`);
  }
  return parts.join("\n");
}

// The failure slice of one card's run history; never throws. See ADR 0019 lines 40 and 50: a block that is not
// `real` is counted in `hidden` by class, and an entry that cannot be parsed in `unreadable`.
export function failureSlice(dir, card, { session = null } = {}) {
  const out = { items: [], hidden: {}, unreadable: 0 };
  try {
    const cardName = historySafe(card);
    const cardDir = join(dir, HISTORY_DIR_RELPATH, cardName);
    if (!existsSync(cardDir)) return out;
    const files = readdirSync(cardDir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const run = file.slice(0, -".jsonl".length);
      let text;
      try {
        text = readFileSync(join(cardDir, file), "utf8");
      } catch {
        continue;
      }
      const entries = [];
      for (const raw of text.split("\n")) {
        if (raw === "") continue;
        const e = parseJsonObject(raw);
        entries.push(e && typeof e.kind === "string" ? { kind: e.kind, text: typeof e.text === "string" ? e.text : "" } : null);
      }
      const parsed = entries.map((e) => (e && (e.kind === "report" || e.kind === "block" || e.kind === "denial") ? parseJsonObject(e.text) : null));
      const sessionOf = (v) => (v && typeof v.session === "string" && v.session !== "" ? v.session : null);
      const runSession = parsed.map(sessionOf).find((s) => s !== null) ?? null;
      entries.forEach((e, i) => {
        if (!e) return;
        const v = parsed[i];
        let kind = null;
        if (e.kind === "report") {
          if (!v) return void out.unreadable++;
          if (v.outcome === "stopped" || (v.ok === false && !v.paused)) kind = "stop";
        } else if (e.kind === "block") {
          if (!v) return void out.unreadable++;
          if (v.class === "real") kind = "block";
          else {
            const cls = typeof v.class === "string" && v.class ? v.class : "unclassified";
            out.hidden[cls] = (out.hidden[cls] ?? 0) + 1;
          }
        } else if (e.kind === "denial") kind = "denial";
        if (!kind) return;
        const body = v ?? {};
        out.items.push({
          ref: `history:${cardName}/${run}:${i + 1}`,
          kind,
          card: cardName,
          run,
          line: i + 1,
          session: sessionOf(v) ?? runSession ?? (typeof session === "string" && session !== "" ? session : null),
          text: failureItemText(kind, body, e.text),
        });
      });
    }
  } catch {
    // fail open: whatever was read so far
  }
  return out;
}

// Occurrence ledger: one JSON line per {lesson, citation} (de-duplicated), append-only.
export function readPitfallOccurrences(dir) {
  let text;
  try {
    text = readFileSync(join(dir, PITFALL_LEDGER_RELPATH), "utf8");
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const v of parseJsonLines(text)) {
    if (typeof v.lesson !== "string" || typeof v.citation !== "string") continue;
    const key = `${v.lesson}\u0000${v.citation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function recordPitfallOccurrence(dir, occ) {
  const { lesson, citation, card = null, run = null, session = null, at = nowIso() } = occ ?? {};
  if (typeof lesson !== "string" || typeof citation !== "string") throw new Error("recordPitfallOccurrence needs a lesson and a citation");
  if (readPitfallOccurrences(dir).some((o) => o.lesson === lesson && o.citation === citation)) return { written: false };
  const path = join(dir, PITFALL_LEDGER_RELPATH);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ lesson, citation, card, run, session, at }) + "\n", "utf8");
  return { written: true };
}

export const FAILURE_REFLECT_SCHEMA = {
  type: "object",
  required: ["lessons"],
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "text", "citation", "notDerivableBecause"],
        properties: {
          kind: { enum: ["pitfall"] },
          text: { type: "string" },
          citation: { type: "string" },
          notDerivableBecause: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          repeats: { type: "string" },
        },
      },
    },
  },
};

export function buildFailureReflectPrompt(slice, { existingLessons = [] } = {}) {
  const lines = [
    "You are the reflection pass of a coding harness, reading the FAILURES of one card: stopped runs, gate blocks classed real, and permission denials.",
    "Propose at most 3 lessons of kind \"pitfall\": a short, specific rule that would have prevented the failure. Each lesson's `citation` must be exactly the ref of one item below (a history:<card>/<run>:<line> string). Do not cite anything else.",
    "`notDerivableBecause` says why the rule cannot be read from the repository's code or docs. Skip failures that are plain test failures with no transferable lesson.",
    "When an item is a repeat of an existing pitfall listed below, set `repeats` to that pitfall's id instead of inventing a new rule; do not reword an existing pitfall as a new one.",
    "",
  ];
  const items = slice.items ?? [];
  lines.push(`Failure items (${items.length}):`);
  let used = 0;
  let shown = 0;
  for (const item of items) {
    let t = String(item.text ?? "");
    if (t.length > FAILURE_ITEM_TEXT_MAX) t = t.slice(0, FAILURE_ITEM_TEXT_MAX) + " [cut]";
    const block = `\n[${item.ref}] kind: ${item.kind}\n${t}`;
    if (used + block.length > FAILURE_PROMPT_MAX) break;
    lines.push(block);
    used += block.length;
    shown++;
  }
  if (shown < items.length) lines.push(`\n(${items.length - shown} more item(s) left out by the ${FAILURE_PROMPT_MAX}-character cap)`);
  const hidden = Object.entries(slice.hidden ?? {});
  if (hidden.length) lines.push(`\nBlocks not shown (not real): ${hidden.map(([k, n]) => `${k} ${n}`).join(", ")}.`);
  const pitfalls = existingLessons.filter((l) => l.kind === "pitfall" && !l.superseded_by);
  lines.push("", `Existing pitfalls (${pitfalls.length}), which \`repeats\` may name:`);
  for (const l of pitfalls) lines.push(`${l.id}: ${l.text}`);
  return lines.join("\n");
}

export async function runFailureReflect(m, opts = {}) {
  const { dir = process.cwd(), card, session = null, propose, dryRun = false, model = null, claudeDir, now = nowIso() } = opts;
  if (typeof card !== "string" || !card) throw new Error("runFailureReflect requires a card");
  if (typeof propose !== "function" && !dryRun) throw new Error("runFailureReflect requires a propose function");
  const slice = failureSlice(dir, card, { session });
  const base = { items: slice.items.length, hidden: slice.hidden, unreadable: slice.unreadable };
  if (!slice.items.length) return { ok: true, dryRun, ...base, appended: [], repeated: [], rejected: [] };

  const key = "failures:" + createHash("sha256").update(slice.items.map((i) => i.ref).sort().join("\n")).digest("hex");
  const existing = m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get(key);
  if (existing) return { alreadyReflected: true, ...base, row: reflectionRowToObject(existing) };

  const prompt = buildFailureReflectPrompt(slice, { existingLessons: listLessons(m) });
  // A dry run with no propose makes no model call: it returns the prompt it would send and spends nothing.
  if (dryRun && typeof propose !== "function") {
    return { ok: true, dryRun: true, ...base, prompt, proposed: null, appended: [], repeated: [], rejected: [], usd: 0, usdSource: "none", model };
  }
  let result;
  try {
    result = await propose(prompt);
    if (!result || !Array.isArray(result.lessons)) throw new Error("the failure pass returned no lessons array");
  } catch (err) {
    return { ok: false, dryRun, ...base, appended: [], repeated: [], rejected: [{ text: null, reason: err.message }], reason: err.message };
  }

  const byRef = new Map(slice.items.map((i) => [i.ref, i]));
  const appended = [];
  const appendedIds = new Set();
  const repeated = [];
  const rejected = [];
  const occur = (lesson, item) => {
    if (!dryRun) recordPitfallOccurrence(dir, { lesson, citation: item.ref, card: item.card, run: item.run, session: item.session, at: now });
    if (!repeated.includes(lesson)) repeated.push(lesson);
  };
  for (const p of result.lessons) {
    const text = p && typeof p.text === "string" ? p.text : null;
    const reject = (reason) => rejected.push({ text, reason });
    if (!p || typeof p !== "object") {
      reject("proposal is not an object");
      continue;
    }
    if (p.kind !== "pitfall") {
      reject(`kind must be "pitfall", got ${JSON.stringify(p.kind)}`);
      continue;
    }
    if (!text || !text.trim()) {
      reject("text is empty");
      continue;
    }
    if (typeof p.notDerivableBecause !== "string" || !p.notDerivableBecause.trim()) {
      reject("notDerivableBecause is empty");
      continue;
    }
    const item = typeof p.citation === "string" ? byRef.get(p.citation) : undefined;
    if (!item) {
      reject(`citation ${JSON.stringify(p.citation)} is not a failure item of this card's history`);
      continue;
    }
    const derivable = checkReflectDerivable(p, dir);
    if (!derivable.ok) {
      reject(derivable.reason);
      continue;
    }
    if (p.repeats !== undefined && p.repeats !== null && p.repeats !== "") {
      const target = typeof p.repeats === "string" ? getLesson(m, p.repeats) : null;
      if (!target || target.kind !== "pitfall" || target.superseded_by) {
        reject(`repeats ${JSON.stringify(p.repeats)} is not a live pitfall lesson`);
        continue;
      }
      occur(target.id, item);
      continue;
    }
    const id = computeLessonId({ kind: "pitfall", citation: item.ref, text });
    const collision = getLesson(m, id);
    if (collision || appendedIds.has(id)) {
      if (collision && collision.superseded_by) reject(`addLesson id collision with a superseded lesson ${id}`);
      else occur(id, item);
      continue;
    }
    if (appended.length >= FAILURE_APPEND_MAX) {
      reject(`at most ${FAILURE_APPEND_MAX} lessons appended per reflection`);
      continue;
    }
    if (dryRun) {
      appended.push(id);
      appendedIds.add(id);
      continue;
    }
    const row = addLesson(m, {
      text,
      kind: "pitfall",
      scope: Array.isArray(p.scope) ? p.scope : [],
      citation: item.ref,
      source: { agent: "reflect", model },
      card: item.card,
    });
    appended.push(row.id);
    appendedIds.add(row.id);
    recordPitfallOccurrence(dir, { lesson: row.id, citation: item.ref, card: item.card, run: item.run, session: item.session, at: now });
  }

  const sessionId = result.sessionId || null;
  const cost = computeReflectCost({ dir, claudeDir, sessionId, totalCostUsd: typeof result.totalCostUsd === "number" ? result.totalCostUsd : null });
  if (!dryRun) {
    m.prepare(
      `INSERT INTO reflections (report_hash, recorded, run, card, commit_sha, model, counters, proposed, appended, bumped, rejected, usd, usd_source, session_id)
       VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(key, now, card, model, JSON.stringify({ helpful: [], harmful: [], unknown: [] }), result.lessons.length, JSON.stringify(appended), JSON.stringify(repeated), JSON.stringify(rejected), cost.usd, cost.usdSource, sessionId);
  }
  return { ok: true, dryRun, ...base, proposed: result.lessons.length, appended, repeated, rejected, usd: cost.usd, usdSource: cost.usdSource, model, sessionId, key };
}

// The on-demand cited project model (card memory-project-model, ADR 0019 L2): `memory.mjs model regen` asks one
// cheap-row model call for statements about this project learned from runs, each citing live lessons or run
// history, and keeps only statements whose every citation resolves in code. The whole file stays under the cap.
export const PROJECT_MODEL_CHAR_CAP = 2000;
export const PROJECT_MODEL_RELPATH = ".doug/project-model.md";
const PROJECT_MODEL_SECTIONS = [
  ["failure-patterns", "Failure patterns"],
  ["conventions", "Conventions"],
  ["open-risks", "Open risks"],
];
const PROJECT_MODEL_LESSON_TEXT_MAX = 500;

export const PROJECT_MODEL_SCHEMA = {
  type: "object",
  required: ["statements"],
  properties: {
    statements: {
      type: "array",
      items: {
        type: "object",
        required: ["section", "text", "citations"],
        properties: {
          section: { enum: PROJECT_MODEL_SECTIONS.map(([key]) => key) },
          text: { type: "string" },
          citations: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  },
};

// Every run-history ref `<card>/<run>` under .doug/.state/history, in directory order.
export function listRunHistoryRefs(dir) {
  const root = join(dir, HISTORY_DIR_RELPATH);
  const refs = [];
  try {
    for (const card of readdirSync(root).sort()) {
      let files = [];
      try {
        files = readdirSync(join(root, card)).filter((f) => f.endsWith(".jsonl")).sort();
      } catch {
        continue;
      }
      for (const f of files) refs.push(`${card}/${f.slice(0, -".jsonl".length)}`);
    }
  } catch {
    return [];
  }
  return refs;
}

export function buildProjectModelPrompt({ lessons = [], runs = [] } = {}) {
  const lines = [
    "You write the project model of a coding harness: what is true about THIS project now, learned from its runs only. Three sections: failure-patterns (what keeps going wrong), conventions (conventions learned from runs), open-risks (what is still unresolved or fragile).",
    "Write short factual statements. Each statement has a `section` (failure-patterns, conventions or open-risks), a `text`, and `citations`: one or more lesson ids (the 16 hex characters in brackets below) or run-history refs (`<card>/<run>` or `<card>/<run>:<line>`, exactly as listed below). You must cite; a statement whose every citation is not exactly one of the ids or refs below is dropped by code.",
    "Do not restate CLAUDE.md, the ADRs or board cards: link to them by path or card id instead. A statement that should become a rule is not written here; rules go through the proposal path.",
    `Keep the whole document under ${PROJECT_MODEL_CHAR_CAP} characters, header included: a handful of dense statements, each worth its line. Prefer statements that cite several lessons.`,
    "",
    `Live lessons (${lessons.length}):`,
  ];
  for (const l of lessons) {
    const text = String(l.text ?? "").replace(/\s+/g, " ").trim();
    const shown = text.length > PROJECT_MODEL_LESSON_TEXT_MAX ? text.slice(0, PROJECT_MODEL_LESSON_TEXT_MAX) + "..." : text;
    lines.push(`- [${l.id}] (${l.kind}) ${shown}`);
  }
  lines.push("", `Run history refs (${runs.length}):`);
  for (const r of runs) lines.push(`- ${r}`);
  return lines.join("\n") + "\n";
}

// A citation resolves when it is the id of a live (not superseded) lesson, or a history ref with a run whose file
// (and line, when named) exists. Anything else, including a thrown parse or read, is unresolved. A statement with
// any unresolved citation is dropped whole.
function citationResolver(m, dir) {
  return (c) => {
    if (typeof c !== "string") return false;
    if (/^[0-9a-f]{16}$/.test(c)) {
      const row = getLesson(m, c);
      return !!row && !row.superseded_by;
    }
    try {
      const ref = parseHistoryRef(c);
      if (ref.run === null) return false;
      readRunHistory(dir, ref);
      return true;
    } catch {
      return false;
    }
  };
}

export function checkProjectModelCitations(m, dir, statements) {
  const resolves = citationResolver(m, dir);
  const kept = [];
  const dropped = [];
  for (const s of statements) {
    const cites = Array.isArray(s && s.citations) ? s.citations : [];
    if (cites.length > 0 && cites.every(resolves)) kept.push(s);
    else dropped.push({ text: s && s.text, reason: "unresolved", citations: cites });
  }
  return { kept, dropped };
}

// The on-demand idea pass (card memory-idea-proposals, ADR 0019 L3): `memory.mjs ideas` asks one cheap-row model
// call over live lessons, run history and pitfall occurrences for idea cards and priority reviews. Ideas are
// filed to Backlog only, cited, capped per pass; reviews go to a jsonl file for the user. Never Ready.
export const IDEA_CAP = 3;
export const PRIORITY_REVIEWS_RELPATH = ".doug/.state/memory/priority-reviews.jsonl";
const IDEAS_LESSON_TEXT_MAX = 500;

export const IDEAS_SCHEMA = {
  type: "object",
  required: ["ideas", "reviews"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "goal", "component", "size", "citations"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          goal: { type: "string" },
          component: { type: "string" },
          size: { type: "string" },
          citations: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
    reviews: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "cards", "citations"],
        properties: {
          text: { type: "string" },
          cards: { type: "array", items: { type: "string" }, minItems: 1 },
          citations: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  },
};

export function buildIdeasPrompt({ lessons = [], runs = [], pitfalls = [], cards = [] } = {}) {
  const lines = [
    "You look over the lessons and run history of a coding harness and propose follow-up work for its user: idea cards and priority reviews.",
    "Look for recurring failures, repeated manual steps and unfinished follow-ups. An idea is filed only when it is realistic drift (a form a model or a person would plausibly write) or when one card would close the whole class; otherwise propose nothing.",
    "Each idea has an `id` (kebab-case, not any card id listed below), `title`, `goal` (name the defect or gap plainly), `component`, `size` and `citations`. Do not duplicate a card listed below.",
    "Each review (`text`, `cards`, `citations`) groups Backlog cards for the user to look at, for example Backlog cards that share a recurring pitfall. `cards` may name Backlog cards only. Never propose a change to Ready.",
    "You must cite: `citations` are lesson ids (the 16 hex characters in brackets below) or run-history refs (`<card>/<run>` or `<card>/<run>:<line>`), exactly as listed below. An item with any citation not exactly one of them, or with none, is dropped by code.",
    "",
    `Live lessons (${lessons.length}):`,
  ];
  for (const l of lessons) {
    const text = String(l.text ?? "").replace(/\s+/g, " ").trim();
    const shown = text.length > IDEAS_LESSON_TEXT_MAX ? text.slice(0, IDEAS_LESSON_TEXT_MAX) + "..." : text;
    lines.push(`- [${l.id}] (${l.kind}) ${shown}`);
  }
  lines.push("", `Run history refs (${runs.length}):`);
  for (const r of runs) lines.push(`- ${r}`);
  lines.push("", `Pitfall occurrences (${pitfalls.length}):`);
  for (const p of pitfalls) lines.push(`- lesson ${p.lesson} (card ${p.card ?? "?"}, run ${p.run ?? "?"}): ${p.citation ?? ""}`);
  lines.push("", `Existing Backlog and Ready cards (${cards.length}):`);
  for (const c of cards) lines.push(`- ${c.id} (${c.column}): ${c.title}`);
  return lines.join("\n") + "\n";
}

export function checkIdeaCitations(m, dir, items) {
  const resolves = citationResolver(m, dir);
  const kept = [];
  const dropped = [];
  for (const it of items) {
    const cites = Array.isArray(it && it.citations) ? it.citations : [];
    if (cites.length > 0 && cites.every(resolves)) kept.push(it);
    else dropped.push({ id: it && it.id, text: it && it.text, reason: "unresolved", citations: cites });
  }
  return { kept, dropped };
}

export const IDEA_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Pure: files up to `cap` ideas as new Backlog cards appended after every existing card.
export function fileIdeaCards(board, ideas, { cap = IDEA_CAP, date } = {}) {
  let next = board;
  const filed = [];
  const skipped = [];
  for (const it of ideas) {
    if (typeof it.id !== "string" || !IDEA_ID_RE.test(it.id)) {
      skipped.push({ id: it.id, reason: "id is not kebab-case" });
      continue;
    }
    if (filed.length >= cap) {
      skipped.push({ id: it.id, reason: "over cap" });
      continue;
    }
    const cites = Array.isArray(it.citations) ? it.citations.join(", ") : "";
    try {
      const added = addCard(
        next,
        {
          id: it.id,
          title: it.title,
          component: it.component,
          size: it.size,
          track: "hand",
          deps: [],
          column: "backlog",
          goal: `Memory-proposed (memory.mjs ideas, ${date}): ${it.goal} Evidence: ${cites}.`,
        },
        { date }
      );
      const cards = added.cards.slice();
      cards[cards.length - 1] = { ...cards[cards.length - 1], source: `memory-proposed: ${cites}` };
      next = { ...added, cards };
      filed.push(it.id);
    } catch (err) {
      skipped.push({ id: it.id, reason: String(err && err.message ? err.message : err).split("\n").slice(0, 2).join(" ") });
    }
  }
  return { board: next, filed, skipped };
}

export function readPriorityReviews(dir) {
  const file = join(dir, PRIORITY_REVIEWS_RELPATH);
  if (!existsSync(file)) return [];
  const out = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r === "object") out.push(r);
      } catch {
        // malformed line: skip
      }
    }
  } catch {
    return [];
  }
  return out;
}

function reviewKey(r) {
  const cards = Array.isArray(r && r.cards) ? r.cards : [];
  return JSON.stringify([[...new Set(cards)].sort(), String((r && r.text) ?? "").replace(/\s+/g, " ").trim()]);
}

export function checkPriorityReviews(board, reviews, { cap = IDEA_CAP, recorded = [] } = {}) {
  const backlog = new Set(board.cards.filter((c) => c.column === "backlog").map((c) => c.id));
  const seen = new Set(recorded.map(reviewKey));
  const kept = [];
  const dropped = [];
  for (const r of reviews) {
    const key = reviewKey(r);
    if (seen.has(key)) {
      dropped.push({ text: r && r.text, reason: "already recorded" });
      continue;
    }
    const cards = Array.isArray(r && r.cards) ? r.cards : [];
    if (cards.length > 0 && cards.every((id) => backlog.has(id)) && kept.length < cap) {
      kept.push(r);
      seen.add(key);
    } else dropped.push({ text: r && r.text, reason: kept.length >= cap && cards.every((id) => backlog.has(id)) ? "over cap" : "not all backlog cards" });
  }
  return { kept, dropped };
}

export function renderProjectModel(statements, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const header =
    `Generated by \`memory.mjs model regen\` on ${date}; do not edit by hand. Each statement cites a lesson (\`memory.mjs lesson show <id>\`) or a run record (\`memory.mjs history show <ref>\`).`;
  const build = (list) => {
    const out = ["# Project model", "", header, ""];
    for (const [key, title] of PROJECT_MODEL_SECTIONS) {
      const inSection = list.filter((s) => s.section === key);
      if (!inSection.length) continue;
      out.push(`## ${title}`);
      for (const s of inSection) out.push(`- ${s.text} [${s.citations.join(", ")}]`);
    }
    return out.join("\n") + "\n";
  };
  const known = statements.filter((s) => PROJECT_MODEL_SECTIONS.some(([key]) => key === s.section));
  const priority = known.map((s, i) => ({ s, i })).sort((a, b) => b.s.citations.length - a.s.citations.length || a.i - b.i);
  const chosen = new Set();
  for (const { s } of priority) {
    const trial = known.filter((x) => chosen.has(x) || x === s);
    if (build(trial).length > PROJECT_MODEL_CHAR_CAP) break;
    chosen.add(s);
  }
  const kept = known.filter((s) => chosen.has(s));
  const overCap = statements.filter((s) => !chosen.has(s));
  const text = build(kept);
  return { text, chars: text.length, kept, overCap };
}
