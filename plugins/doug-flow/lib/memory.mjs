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
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { classifyBlocks, adversaryBlocks } from "./board.mjs";
import { transcriptUsage, priceUsage, projectSlug, CODEX_PRICES, CODEX_DEFAULT_MODEL } from "./cost.mjs";
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
// fix_passes, stop_reason, in_scope, budget_spent, tokens, usd, codex_usd, report_hash, report_path, partial. In particular
// verified is null on a hand row even though the gate passed: no independent verifier ran on that track, and
// the gate's own text lives in the `gate` column instead. A consumer that averages fix_passes or counts
// blocks across both tracks must filter on track. wall_clock, gate, and note only exist on a hand row; they
// are null on a flow row.
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
// hand row, which has never been touched by either path). On today's flow track these seven columns are always
// null: a flow row is never stamped by `condition open`/`record --hand` — that wiring is a later card.
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
  stale TEXT
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

export function openMemory(dir) {
  const file = memoryPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version === 0) {
    db.exec(SCHEMA_SQL);
    db.exec("PRAGMA user_version = 8");
  } else if (version === 1) {
    migrateV1ToV2(db);
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
  } else if (version === 2) {
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
  } else if (version === 3) {
    migrateV3ToV4(db);
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
  } else if (version === 4) {
    migrateV4ToV5(db);
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
  } else if (version === 5) {
    migrateV5ToV6(db);
    migrateV6ToV7(db);
    migrateV7ToV8(db);
  } else if (version === 6) {
    migrateV6ToV7(db);
    migrateV7ToV8(db);
  } else if (version === 7) {
    migrateV7ToV8(db);
  } else if (version !== 8) {
    db.close();
    throw new Error(`memory store ${file} is user_version ${version}; this code understands up to version 8`);
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
  const out = { file, exists: false, userVersion: null, maxUserVersion: 8, quickCheck: null, error: null };
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
       WHERE superseded_by IS NULL AND stale IS NULL
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
    const found = adversaryBlocks(report).some((b) => b.task === taskId && b.id === blockId);
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
export async function recallLessons(m, query, opts = {}) {
  const { files = [], k = 8, now = new Date(), provider = null, checkoutDir = null, staleDays = 30 } = opts;
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIsoStr = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const checked = isProjectRoot(checkoutDir);

  // (a) candidates: not superseded, not stale, and confirmed-or-created within staleDays.
  const allRows = m.prepare("SELECT * FROM lessons WHERE superseded_by IS NULL AND stale IS NULL").all().map(lessonRowToObject);
  const freshRows = allRows.filter((l) => ageDaysOf(l.confirmed || l.created, nowMs) <= staleDays);
  const byId = new Map(freshRows.map((l) => [l.id, l]));

  // (b) BM25 side, top 50.
  const match = ftsMatchQuery(query);
  let bm25Ranked = [];
  if (match) {
    const rows = m
      .prepare(
        `SELECT l.id FROM lessons_fts f JOIN lessons l ON l.id = f.id
         WHERE lessons_fts MATCH ? AND l.superseded_by IS NULL AND l.stale IS NULL
         ORDER BY bm25(lessons_fts) LIMIT 50`
      )
      .all(match);
    bm25Ranked = rows.map((r) => r.id).filter((id) => byId.has(id));
  }

  // (c) dense side, only with a provider and rows stored under the same model+dims: cosine (dot of the stored
  // vectors) for every such row, not only BM25 hits.
  let mode = "keyword-only";
  let reason = "no provider configured";
  let providerName = null;
  const cosine = new Map();
  if (provider) {
    providerName = provider.name;
    const vectorRows = freshRows.filter(
      (l) => l.embedding && l.embedding_model === provider.model && l.embedding_dims === provider.dims
    );
    if (!vectorRows.length) {
      reason = `no vectors stored for ${provider.model}/${provider.dims}`;
    } else {
      const embedResult = await provider.embed([String(query || "")], { inputType: "query" });
      if (!embedResult.ok) {
        reason = embedResult.reason;
      } else {
        const qVec = embedResult.vectors[0];
        for (const l of vectorRows) {
          const vec = blobToFloats(l.embedding);
          let dot = 0;
          for (let i = 0; i < qVec.length && i < vec.length; i++) dot += qVec[i] * vec[i];
          cosine.set(l.id, dot);
        }
        mode = "hybrid";
        reason = null;
      }
    }
  }

  // (d) scores: recency weight, then scope boost. Dense mode scores cosine; the BM25 order scores 1/(60+rank).
  const bm25Rank = new Map(bm25Ranked.map((id, idx) => [id, idx]));
  const weigh = (lesson, base) => {
    const ageDays = ageDaysOf(lesson.confirmed || lesson.created, nowMs);
    let score = base * (0.5 + 0.5 * Math.exp(-ageDays / 90));
    if (files.length && (lesson.scope.length === 0 || scopeMatchesFiles(lesson.scope, files))) score *= 1.5;
    return score;
  };
  const byScoreThenId = (a, b) => b.score - a.score || (a.lesson.id < b.lesson.id ? -1 : a.lesson.id > b.lesson.id ? 1 : 0);
  const sidesOf = (id) => {
    const sides = [];
    if (bm25Rank.has(id)) sides.push("bm25");
    if (cosine.has(id)) sides.push("vector");
    return sides;
  };
  let candidates;
  if (mode === "hybrid") {
    // (e) vectored lessons by cosine x recency x scope, then BM25 hits with no vector, in BM25 order.
    const dense = [...cosine.entries()].map(([id, dot]) => {
      const lesson = byId.get(id);
      return { lesson, score: weigh(lesson, dot), sides: sidesOf(id) };
    });
    dense.sort(byScoreThenId);
    const appended = bm25Ranked
      .filter((id) => !cosine.has(id))
      .map((id) => ({ lesson: byId.get(id), score: weigh(byId.get(id), 1 / (60 + bm25Rank.get(id) + 1)), sides: sidesOf(id) }));
    candidates = [...dense, ...appended];
  } else {
    candidates = bm25Ranked.map((id) => ({ lesson: byId.get(id), score: weigh(byId.get(id), 1 / (60 + bm25Rank.get(id) + 1)), sides: sidesOf(id) }));
    candidates.sort(byScoreThenId);
  }

  // (g) top k. With a real project root, each candidate's citation is re-checked: a failure marks the row
  // stale and drops it, backfilling from the next candidate so k are returned when enough candidates exist,
  // and a pass sets confirmed. Without one (checked: false), candidates are taken as-is — nothing is marked
  // stale or confirmed, since there is nothing trustworthy to check them against.
  const result = [];
  let idx = 0;
  while (result.length < k && idx < candidates.length) {
    const cand = candidates[idx++];
    if (!checked) {
      result.push(toRecallLesson(cand.lesson, { score: cand.score, sides: cand.sides }));
      continue;
    }
    const check = checkCitation(cand.lesson, checkoutDir);
    if (!check.ok) {
      m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(nowIsoStr, cand.lesson.id);
      continue;
    }
    m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(nowIsoStr, cand.lesson.id);
    result.push(toRecallLesson({ ...cand.lesson, confirmed: nowIsoStr }, { score: cand.score, sides: cand.sides }));
  }

  return { mode, reason: mode === "hybrid" ? null : reason, provider: providerName, checked, lessons: result };
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
  const { plan = null, classes = [], run = null, reportHash, reportPath = null, card = null, commit = null, cost = null, now = nowIso() } = opts || {};
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
        // The seven condition columns (card outcomes-condition-columns) are always null on a flow row today —
        // see the comment above OUTCOMES_COLUMNS_SQL. backfilled is 0, never null: it is NOT NULL DEFAULT 0.
        harness_commit: null,
        config_hash: null,
        class: null,
        arm: null,
        assigned_by: null,
        explore_probability: null,
        backfilled: 0,
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
export function handOutcomeRow({ card, commit, wallClock = null, gate = null, note = null, now = nowIso(), condition = null } = {}) {
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
    in_scope: null,
    budget_spent: null,
    tokens: null,
    usd: null,
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
  };
}

const OUTCOME_COLUMNS = [
  "recorded", "run", "run_id", "report_hash", "report_path", "card", "task", "spec_hash", "files", "size", "shape",
  "models", "implemented", "verified", "reviewed", "review_issues", "review_issue_count", "adversary_verdict",
  "adversary_blocked", "adversary_source", "blocks", "passes", "fix_passes", "stop_reason", "in_scope",
  "budget_spent", "tokens", "usd", "codex_usd", "commit_sha", "track", "wall_clock", "gate", "note", "partial",
  "harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability", "backfilled",
];

const JSON_COLUMNS = new Set(["files", "models", "review_issues", "blocks", "budget_spent", "tokens"]);

// The seven condition columns (card outcomes-condition-columns) upsert atomically, all seven together, keyed on
// whether the *new* row carries a harness_commit — never column-by-column (a plain per-column COALESCE let a
// re-record with no condition zero out an existing stamp's `backfilled` flag while keeping its old
// harness_commit, mixing half of one stamp with half of another, since `backfilled` defaults to 0, not null,
// when a caller omits it). When `excluded.harness_commit` is null (this row carries no condition), every one of
// the seven columns keeps the existing row's value untouched; otherwise every one of the seven takes the new
// row's value, including `backfilled` (a fresh `condition open`/`record --hand` stamp legitimately replaces an
// older backfilled placeholder with backfilled 0). This is what keeps a `condition backfill` stamp — or any
// other already-recorded stamp — intact across a later re-record for the same run+task that carries none.
const CONDITION_COLUMNS = new Set(["harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability", "backfilled"]);

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

// Deterministic, no LLM: for each task whose memoryUsed is non-empty, a real block bumps harmful on every used
// lesson that exists (real wins even when the task also verified), else a first-verified task bumps helpful;
// neither verified nor real does nothing. An id naming no lesson is reported in `unknown`, never an error.
// apply:false (a dry run's preview) computes the same result without writing anything.
function computeReflectCounters(m, blocks, report, { apply }) {
  const helpful = [];
  const harmful = [];
  const unknown = [];
  for (const level of report.levels || []) {
    for (const task of level.tasks || []) {
      const used = Array.isArray(task.memoryUsed) ? task.memoryUsed : [];
      if (!used.length) continue;
      const real = blocks.some((b) => b.task === task.id && b.class === "real");
      if (real) {
        for (const id of used) {
          if (getLesson(m, id)) {
            if (apply) m.prepare("UPDATE lessons SET harmful = harmful + 1 WHERE id = ?").run(id);
            harmful.push(id);
          } else {
            unknown.push(id);
          }
        }
      } else if (task.verified === true) {
        for (const id of used) {
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

// The prompt for the cheap-row pass: the rules in plain words, every task's facts (owned files from the plan when
// it names the task, verified/passes/stopReason, review and verifier findings, its blocks with class and reason,
// memoryUsed), the id and text of the most recently created/confirmed existing lessons (so the model avoids
// re-proposing them; capped at REFLECT_PROMPT_LESSON_CAP, said so in the prompt when it is), and the citation
// forms it may use. Filter C.4's duplicate check still runs against the full, uncapped set of existing lessons —
// this cap only bounds what the model itself sees.
export function buildReflectPrompt(report, { blocks = [], plan = null, existingLessons = [] } = {}) {
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
  lines.push("- propose at most 3 lessons; an empty list is a perfectly good answer when nothing here is worth remembering.");
  lines.push("- a task marked partial=true below ran out of context, not verification; propose no lesson that blames its code or its tests for that.");
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
        for (const b of taskBlocks) lines.push(`    - report:${task.id}/${b.id} class=${b.class || "unclassified"} reason=${b.reason || "none"}`);
      }
      lines.push(`  memoryUsed: ${used.length ? used.join(", ") : "none"}`);
    }
  }
  lines.push("");
  lines.push("Existing lessons (never propose a near-duplicate of one of these):");
  const shownLessons = mostRecentLessons(existingLessons, REFLECT_PROMPT_LESSON_CAP);
  if (existingLessons.length > REFLECT_PROMPT_LESSON_CAP) {
    lines.push(`(showing the ${REFLECT_PROMPT_LESSON_CAP} most recently created/confirmed of ${existingLessons.length} total; older lessons are not shown)`);
  }
  if (shownLessons.length) {
    for (const l of shownLessons) lines.push(`- ${l.id} (${l.kind}): ${l.text}`);
  } else {
    lines.push("(none yet)");
  }
  return lines.join("\n") + "\n";
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
// Returns { duplicate: <live lesson row> } (bump), { rejected: <superseded lesson row> }, or null (not a dup).
function findReflectDuplicate(m, proposal, { existingLessons, appendedRows }) {
  const proposalId = computeLessonId({ kind: proposal.kind, citation: proposal.citation || null, text: proposal.text });
  const collision = getLesson(m, proposalId);
  if (collision) return collision.superseded_by ? { rejected: collision } : { duplicate: collision };
  for (const row of appendedRows) {
    if (row.id === proposalId) return { duplicate: row };
  }
  const tokens = reflectTokens(proposal.text);
  for (const lesson of [...existingLessons, ...appendedRows]) {
    if (jaccard(tokens, reflectTokens(lesson.text)) >= REFLECT_DUPLICATE_JACCARD) return { duplicate: lesson };
  }
  return null;
}

// Filters C.1-C.4, in order. C.5 (at most 3 appended) is enforced by the caller, but only against a proposal
// this function has already said ok:true and not a duplicate — a would-be duplicate past the cap still bumps.
// Returns { ok:true }, { ok:true, duplicate:<lesson row> } (bump instead of append), or { ok:false, reason }.
function evaluateReflectProposal(m, report, blocks, proposal, { dir, existingLessons, appendedRows }) {
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
  const dup = findReflectDuplicate(m, proposal, { existingLessons, appendedRows });
  if (dup && dup.rejected) return { ok: false, reason: `addLesson id collision with a superseded lesson ${dup.rejected.id}` };
  if (dup && dup.duplicate) return { ok: true, duplicate: dup.duplicate };
  return { ok: true };
}

// Cost (D): prefer the real per-message transcript at <claudeDir>/projects/<projectSlug(dir)>/<sessionId>.jsonl,
// same as cost.mjs prices every other agent; fall back to the envelope's own total_cost_usd (a client-side
// estimate) when the transcript is missing or its model is unpriced; null with no source when neither is usable.
function computeReflectCost({ dir, claudeDir, sessionId, totalCostUsd }) {
  const resolvedClaudeDir = claudeDir || join(homedir(), ".claude");
  if (sessionId) {
    const file = join(resolvedClaudeDir, "projects", projectSlug(dir), `${sessionId}.jsonl`);
    if (existsSync(file)) {
      try {
        const t = transcriptUsage(file);
        const usd = t.model ? priceUsage(t.usage, t.model) : null;
        if (usd !== null) return { usd, usdSource: "transcript" };
      } catch {
        // fall through to the envelope's own number
      }
    }
  }
  if (typeof totalCostUsd === "number") return { usd: totalCostUsd, usdSource: "claude" };
  return { usd: null, usdSource: null };
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
    propose,
    now = nowIso(),
  } = opts;
  if (!reportHash) throw new Error("runReflect requires a reportHash");
  if (typeof propose !== "function") throw new Error("runReflect requires a propose function");

  const existing = m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get(reportHash);
  if (existing) return { alreadyReflected: true, row: reflectionRowToObject(existing) };

  // classifyBlocks throws on an --adversary id the report does not have, the same way record fails; this must
  // happen before any write, so it is the very first thing after the idempotency check.
  const blocks = classifyBlocks(report, classes);

  let counters;
  if (dryRun) {
    counters = computeReflectCounters(m, blocks, report, { apply: false });
  } else {
    m.exec("BEGIN");
    try {
      counters = computeReflectCounters(m, blocks, report, { apply: true });
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
  const prompt = buildReflectPrompt(report, { blocks, plan, existingLessons });

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
      proposed: null,
      appended: [],
      bumped: [],
      rejected,
      usd: null,
      usdSource: null,
      model,
      sessionId: null,
      reason: proposeError.message,
    };
  }

  const proposals = proposeResult.lessons;
  const sessionId = proposeResult.sessionId || null;
  const totalCostUsd = typeof proposeResult.totalCostUsd === "number" ? proposeResult.totalCostUsd : null;

  const appendedRows = [];
  const bumped = [];
  const rejected = [];
  for (const proposal of proposals) {
    const verdict = evaluateReflectProposal(m, report, blocks, proposal, { dir, existingLessons, appendedRows });
    if (verdict.duplicate) {
      // The 3-item cap (C.5) limits appends, never evaluation: a near-duplicate found past the cap still bumps
      // the lesson it matches, it is just never counted against the 3.
      if (!dryRun) m.prepare("UPDATE lessons SET helpful = helpful + 1 WHERE id = ?").run(verdict.duplicate.id);
      bumped.push(verdict.duplicate.id);
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
      appendedRows.push({ id: computeLessonId({ kind: proposal.kind, citation: proposal.citation || null, text: proposal.text }), text: proposal.text, kind: proposal.kind });
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
    proposed: proposals.length,
    appended: appendedRows.map((r) => r.id),
    bumped,
    rejected,
    usd: cost.usd,
    usdSource: cost.usdSource,
    model,
    sessionId,
  };
}
