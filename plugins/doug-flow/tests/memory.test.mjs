import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, statSync, chmodSync, copyFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { classifyBlocks } from "../lib/board.mjs";
import { proposeClaudeMd } from "../lib/decisions.mjs";
import { CODEX_PRICES } from "../lib/cost.mjs";
import {
  isLiveLesson,
  MEMORY_DB_RELPATH,
  memoryPath,
  openMemory,
  inspectMemory,
  probeSqliteFts5,
  addLesson,
  getLesson,
  supersedeLesson,
  listLessons,
  searchLessons,
  outcomeRows,
  recordOutcomes,
  listOutcomes,
  handOutcomeRow,
  stopOutcomeRow,
  blockAgentId,
  runAgentIds,
  attributeBlocks,
  conditionConfigHash,
  setLessonEmbedding,
  lessonsNeedingEmbedding,
  embedLessons,
  checkCitation,
  recallLessons,
  windowHidden,
  windowNote,
  clearRecallCache,
  topLessons,
  renderLessons,
  lessonTokens,
  lessonTitle,
  renderLessonIndex,
  parseHistoryRef,
  readRunHistory,
  unstaleLesson,
  unarchiveLesson,
  runReflect,
  claudeMdHome,
  buildReflectPrompt,
  REFLECT_SCHEMA,
  REFLECT_DUPLICATE_JACCARD,
  REFLECT_PROMPT_LESSON_CAP,
  HISTORY_DIR_RELPATH,
  HISTORY_ENTRY_MAX_BYTES,
  HISTORY_RUN_MAX_BYTES,
  historyEntry,
  journalSeatRuns,
  replayBriefs,
  attributeDenials,
  writeRunHistory,
  failureSlice,
  recordPitfallOccurrence,
  readPitfallOccurrences,
  PITFALL_LEDGER_RELPATH,
  runFailureReflect,
  FAILURE_REFLECT_SCHEMA,
  buildFailureReflectPrompt,
  jaccard,
  reflectTokens,
  memoryConfig,
  MEMORY_STAGE,
  compareMemoryArms,
  evidenceClassOf,
  RECALL_FEEDBACK,
  ARCHIVE_HARMFUL_MIN,
  meetsArchiveRule,
  PROJECT_MODEL_SCHEMA,
  PROJECT_MODEL_CHAR_CAP,
  buildProjectModelPrompt,
  checkProjectModelCitations,
  renderProjectModel,
  MEMORY_BUSY_TIMEOUT_MS,
} from "../lib/memory.mjs";
import { initialState, currentAction, next as loopNext, briefPrompt } from "../lib/card-loop.mjs";
import { scanText } from "../../doug-gates/lib/secret-rules.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

let dir;
let m;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doug-memory-"));
});

afterEach(() => {
  if (m) {
    try {
      m.close();
    } catch {
      // already closed
    }
    m = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("openMemory", () => {
  it("creates the v6 schema and user_version on open, and reopening keeps the rows", () => {
    m = openMemory(dir);
    expect(existsSync(memoryPath(dir))).toBe(true);
    expect(memoryPath(dir).endsWith(MEMORY_DB_RELPATH)).toBe(true);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const rows = listLessons(m);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("keep the gate green");
    expect(rows[0].stale).toBeNull();
  });

  it("creates the code index tables (card semantic-index) empty and usable on a fresh store", () => {
    m = openMemory(dir);
    for (const table of ["code_files", "code_chunks", "code_index_builds"]) {
      expect(m.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    }
    m.prepare("INSERT INTO code_files (path, hash, bytes, chunks, indexed) VALUES (?, ?, ?, ?, ?)").run(
      "a.mjs",
      "h1",
      10,
      1,
      "2026-09-12T00:00:00.000Z"
    );
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks_fts").get().n).toBe(0);
  });

  it("loads with no ExperimentalWarning printed on stderr", () => {
    const href = new URL("../lib/memory.mjs", import.meta.url).href;
    const script = `import(${JSON.stringify(href)}).then(() => {}).catch((e) => { console.error("IMPORT_FAILED", e); process.exit(1); });`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(res.stderr).not.toContain("ExperimentalWarning");
    expect(res.status).toBe(0);
  });

  it("creates the seven condition columns on a fresh v7 store, defaulting backfilled to 0 (card outcomes-condition-columns)", () => {
    m = openMemory(dir);
    const cols = m.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    for (const c of ["harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability", "backfilled"]) {
      expect(cols).toContain(c);
    }
  });

  it("M1 (card run-report-codex-cost): a fresh store is at user_version 12 with a codex_usd column on outcomes", () => {
    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const cols = m.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    expect(cols).toContain("codex_usd");
  });

  it("S7 (card memory-stop-class): a fresh store is at user_version 12 with a nullable stop_class column on outcomes", () => {
    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const col = m.prepare("PRAGMA table_info(outcomes)").all().find((c) => c.name === "stop_class");
    expect(col).toBeTruthy();
    expect(col.notnull).toBe(0);
  });
});

describe("openMemory: a store from a future schema version", () => {
  it("throws one clear error naming the store's version and the version this code understands, rather than opening it silently", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE outcomes (id INTEGER PRIMARY KEY);");
    raw.exec("PRAGMA user_version = 13");
    raw.close();

    expect(() => openMemory(dir)).toThrow(/user_version 13/);
    expect(() => openMemory(dir)).toThrow(/understands up to version 12/);
  });
});

// Card doug-doctor: a read-only look at the store for `doug doctor`. openMemory creates the directory and the
// file and migrates; inspectMemory must do none of that.
describe("inspectMemory (read-only)", () => {
  const listing = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        out.push(p);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(root);
    return out.sort();
  };

  it("an absent store reports exists:false and creates no file or directory", () => {
    const r = inspectMemory(dir);
    expect(r.exists).toBe(false);
    expect(r.file).toBe(memoryPath(dir));
    expect(r.error).toBeNull();
    expect(existsSync(join(dir, ".doug"))).toBe(false);
    expect(listing(dir)).toEqual([]);
  });

  it("a seeded store reports user_version 12, the max, and quick_check ok, leaving mtime, size and the directory listing unchanged", () => {
    m = openMemory(dir);
    addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    m.close();
    m = null;
    const file = memoryPath(dir);
    const before = statSync(file);
    const listed = listing(dir);
    const r = inspectMemory(dir);
    expect(r).toMatchObject({ file, exists: true, userVersion: 12, maxUserVersion: 12, quickCheck: "ok", error: null });
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(listing(dir)).toEqual(listed);
  });

  it("opens the store read-only: a store whose file is not writable is still inspected without error", () => {
    m = openMemory(dir);
    m.close();
    m = null;
    const file = memoryPath(dir);
    chmodSync(file, 0o444);
    try {
      const r = inspectMemory(dir);
      expect(r.error).toBeNull();
      expect(r.quickCheck).toBe("ok");
      expect(r.userVersion).toBe(12);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("leaves the main db file byte-identical when an uncheckpointed WAL exists: a read-write open would fold the WAL into it and delete the -wal", () => {
    // Behavioural pin on `{ readOnly: true }`. A read-write open + close of a WAL store with committed frames
    // checkpoints them into the main file and removes the -wal; a read-only open does neither. Observed on this Node.
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    const live = new DatabaseSync(join(srcDir, "memory.db"));
    try {
      live.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); PRAGMA user_version = 9;");
      live.exec("INSERT INTO t VALUES (1)");
      const file = memoryPath(dir);
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(join(srcDir, "memory.db"), file);
      copyFileSync(join(srcDir, "memory.db-wal"), `${file}-wal`);
      const before = readFileSync(file);
      const r = inspectMemory(dir);
      expect(r.error).toBeNull();
      expect(r.userVersion).toBe(9);
      expect(Buffer.compare(readFileSync(file), before)).toBe(0);
      expect(existsSync(`${file}-wal`)).toBe(true);
    } finally {
      live.close();
    }
  });

  it("a file that is not a database reports an error and does not throw", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "this is not a sqlite database, just text padding ".repeat(40));
    let r;
    expect(() => {
      r = inspectMemory(dir);
    }).not.toThrow();
    expect(r.exists).toBe(true);
    expect(typeof r.error === "string" || (r.quickCheck !== null && r.quickCheck !== "ok")).toBe(true);
  });

  it("a store from a future schema (user_version 13) reports userVersion 13 above maxUserVersion 12, unmigrated", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE outcomes (id INTEGER PRIMARY KEY);");
    raw.exec("PRAGMA user_version = 13");
    raw.close();
    const r = inspectMemory(dir);
    expect(r.userVersion).toBe(13);
    expect(r.maxUserVersion).toBe(12);
    expect(r.error).toBeNull();
    const check = new DatabaseSync(file);
    expect(check.prepare("PRAGMA user_version").get().user_version).toBe(13);
    check.close();
  });

  it("an old store (user_version 1) is reported as is, not migrated", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE lessons (id INTEGER PRIMARY KEY);");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    expect(inspectMemory(dir).userVersion).toBe(1);
    const check = new DatabaseSync(file);
    expect(check.prepare("PRAGMA user_version").get().user_version).toBe(1);
    check.close();
  });
});

describe("probeSqliteFts5", () => {
  it("reports ok on this Node and never throws", () => {
    let r;
    expect(() => {
      r = probeSqliteFts5();
    }).not.toThrow();
    expect(r.ok).toBe(true);
  });
});

describe("openMemory: v1 to v6 migration", () => {
  it("preserves an existing v1 row, defaulting it to track 'flow' with the new columns null, chaining through v2, v3, v4, v5, to v6", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE outcomes (
        id INTEGER PRIMARY KEY,
        recorded TEXT NOT NULL,
        run TEXT NOT NULL,
        run_id TEXT,
        report_hash TEXT NOT NULL,
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
        review_issue_count INTEGER NOT NULL DEFAULT 0,
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
        commit_sha TEXT,
        UNIQUE(run, task)
      );
      CREATE TABLE lessons (
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
        embedding BLOB
      );
      CREATE VIRTUAL TABLE lessons_fts USING fts5(id UNINDEXED, text);
      CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons
      BEGIN
        SELECT RAISE(ABORT, 'lessons are add-only; supersede instead');
      END;
      CREATE TRIGGER lessons_no_rewrite BEFORE UPDATE OF text, kind, scope, citation, source_agent, source_model, task, card, commit_sha, created ON lessons
      BEGIN
        SELECT RAISE(ABORT, 'lessons are never rewritten; supersede instead');
      END;
    `);
    raw
      .prepare(
        `INSERT INTO outcomes (recorded, run, run_id, report_hash, report_path, card, task, spec_hash, files, size,
           shape, models, implemented, verified, reviewed, review_issues, review_issue_count, adversary_verdict,
           adversary_blocked, adversary_source, blocks, passes, fix_passes, stop_reason, in_scope, budget_spent,
           tokens, usd, commit_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "2026-09-08T00:00:00.000Z",
        "wf_v1",
        "wf_v1",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "/tmp/report.json",
        "card-1",
        "task-1",
        "spec1",
        "[\"a.mjs\"]",
        "M",
        "full",
        "{\"implement\":\"sonnet\"}",
        1,
        1,
        1,
        "[]",
        0,
        "pass",
        0,
        "task",
        "[]",
        1,
        0,
        null,
        1,
        null,
        null,
        1.5,
        "deadbeef"
      );
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const rows = listOutcomes(m);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.run).toBe("wf_v1");
    expect(row.task).toBe("task-1");
    expect(row.report_hash).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(row.commit_sha).toBe("deadbeef");
    expect(row.usd).toBe(1.5);
    expect(row.review_issue_count).toBe(0);
    expect(row.track).toBe("flow");
    expect(row.wall_clock).toBeNull();
    expect(row.gate).toBeNull();
    expect(row.note).toBeNull();
    expect(row.partial).toBeNull();
    // S8 (card memory-stop-class): the v1 rebuild chain reaches v9 with exactly one nullable stop_class column.
    const cols = m.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    expect(cols.filter((c) => c === "stop_class")).toHaveLength(1);
    expect(row.stop_class).toBeNull();
  });
});

describe("openMemory: v2 to v6 migration", () => {
  it("keeps existing lesson rows, adds a null stale column, and the add-only triggers still fire on the migrated table", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE outcomes (${"id INTEGER PRIMARY KEY, recorded TEXT NOT NULL, run TEXT NOT NULL, run_id TEXT, report_hash TEXT, report_path TEXT, card TEXT, task TEXT NOT NULL, spec_hash TEXT, files TEXT, size TEXT, shape TEXT, models TEXT, implemented INTEGER, verified INTEGER, reviewed INTEGER, review_issues TEXT, review_issue_count INTEGER, adversary_verdict TEXT, adversary_blocked INTEGER, adversary_source TEXT, blocks TEXT NOT NULL DEFAULT '[]', passes INTEGER, fix_passes INTEGER, stop_reason TEXT, in_scope INTEGER, budget_spent TEXT, tokens TEXT, usd REAL, commit_sha TEXT, track TEXT NOT NULL DEFAULT 'flow', wall_clock TEXT, gate TEXT, note TEXT, UNIQUE(run, task)"});
      CREATE TABLE lessons (
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
        embedding BLOB
      );
      CREATE VIRTUAL TABLE lessons_fts USING fts5(id UNINDEXED, text);
      CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons
      BEGIN
        SELECT RAISE(ABORT, 'lessons are add-only; supersede instead');
      END;
      CREATE TRIGGER lessons_no_rewrite BEFORE UPDATE OF text, kind, scope, citation, source_agent, source_model, task, card, commit_sha, created ON lessons
      BEGIN
        SELECT RAISE(ABORT, 'lessons are never rewritten; supersede instead');
      END;
    `);
    raw
      .prepare(
        `INSERT INTO lessons (id, text, kind, scope, citation, source_agent, source_model, task, card, commit_sha, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("v2lesson1", "keep the gate green", "pattern", "[]", null, "worker", null, null, null, null, "2026-09-01T00:00:00.000Z");
    raw.prepare(`INSERT INTO lessons_fts (id, text) VALUES (?, ?)`).run("v2lesson1", "keep the gate green");
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const rows = listLessons(m);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("v2lesson1");
    expect(rows[0].text).toBe("keep the gate green");
    expect(rows[0].stale).toBeNull();

    // add-only triggers survive the table rebuild
    expect(() => m.exec(`DELETE FROM lessons WHERE id = 'v2lesson1'`)).toThrow(/add-only/);
    expect(() => m.exec(`UPDATE lessons SET text = 'changed' WHERE id = 'v2lesson1'`)).toThrow(/never rewritten/);
    // stale is updatable (not covered by the no-rewrite trigger)
    m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run("2026-09-10T00:00:00.000Z", "v2lesson1");
    expect(getLesson(m, "v2lesson1").stale).toBe("2026-09-10T00:00:00.000Z");
  });
});

describe("openMemory: v3 to v6 migration", () => {
  it("adds the reflections table and keeps existing lessons, outcomes, triggers, and FTS intact", () => {
    // Build a real v5 store, then downgrade it to v3 (drop reflections, roll back user_version) so this test
    // never has to duplicate the schema SQL — it only needs a store that openMemory (v3) would have produced.
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const rows = outcomeRows(buildReport(), { reportHash: "cccccccccccccccccccccccccccccccc", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    m.exec(`
      DROP TABLE reflections;
      DROP TABLE code_index_builds;
      DROP TABLE code_chunks_fts;
      DROP TABLE code_chunks;
      DROP TABLE code_files;
      PRAGMA user_version = 3;
    `);
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(listLessons(m).map((r) => r.id)).toEqual([lesson.id]);
    expect(listOutcomes(m)).toHaveLength(2);
    expect(searchLessons(m, "gate").map((r) => r.id)).toEqual([lesson.id]);
    // add-only triggers survive: reflections is new, but lessons' triggers must still be attached.
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${lesson.id}'`)).toThrow(/add-only/);
    expect(() => m.prepare("UPDATE lessons SET text = ? WHERE id = ?").run("changed", lesson.id)).toThrow(/never rewritten/);
    // the reflections table exists and is usable.
    m.prepare(
      `INSERT INTO reflections (report_hash, recorded, run, card, commit_sha, model, counters) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("deadbeef", "2026-09-10T00:00:00.000Z", "wf_1", "card-1", "sha1", "haiku", "{}");
    expect(m.prepare("SELECT report_hash FROM reflections").get().report_hash).toBe("deadbeef");
  });
});

describe("openMemory: v4 to v6 migration", () => {
  it("adds a null partial column to outcomes and keeps existing rows, lessons, and reflections intact", () => {
    // Build a real v5 store, then downgrade it to v4 (drop the partial column via rebuild, roll back
    // user_version) so this test only needs a store that openMemory (v4) would have produced.
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const rows = outcomeRows(buildReport(), { reportHash: "dddddddddddddddddddddddddddddddd", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    m.exec(`
      CREATE TABLE outcomes_v4 (${"id INTEGER PRIMARY KEY, recorded TEXT NOT NULL, run TEXT NOT NULL, run_id TEXT, report_hash TEXT, report_path TEXT, card TEXT, task TEXT NOT NULL, spec_hash TEXT, files TEXT, size TEXT, shape TEXT, models TEXT, implemented INTEGER, verified INTEGER, reviewed INTEGER, review_issues TEXT, review_issue_count INTEGER, adversary_verdict TEXT, adversary_blocked INTEGER, adversary_source TEXT, blocks TEXT NOT NULL DEFAULT '[]', passes INTEGER, fix_passes INTEGER, stop_reason TEXT, in_scope INTEGER, budget_spent TEXT, tokens TEXT, usd REAL, commit_sha TEXT, track TEXT NOT NULL DEFAULT 'flow', wall_clock TEXT, gate TEXT, note TEXT, UNIQUE(run, task)"});
      INSERT INTO outcomes_v4 SELECT id, recorded, run, run_id, report_hash, report_path, card, task, spec_hash, files, size, shape, models, implemented, verified, reviewed, review_issues, review_issue_count, adversary_verdict, adversary_blocked, adversary_source, blocks, passes, fix_passes, stop_reason, in_scope, budget_spent, tokens, usd, commit_sha, track, wall_clock, gate, note FROM outcomes;
      DROP TABLE outcomes;
      ALTER TABLE outcomes_v4 RENAME TO outcomes;
      DROP TABLE code_index_builds;
      DROP TABLE code_chunks_fts;
      DROP TABLE code_chunks;
      DROP TABLE code_files;
      PRAGMA user_version = 4;
    `);
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(listLessons(m).map((r) => r.id)).toEqual([lesson.id]);
    const outcomeRowsAfter = listOutcomes(m);
    expect(outcomeRowsAfter).toHaveLength(2);
    for (const row of outcomeRowsAfter) expect(row.partial).toBeNull();
  });
});

describe("openMemory: v5 to v6 migration (card semantic-index)", () => {
  it("adds the code index tables and keeps existing lessons, outcomes, and reflections intact", () => {
    // Build a real v6 store, then downgrade it to v5 (drop the four code index tables, roll back user_version)
    // so this test only needs a store that openMemory (v5) would have produced.
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const rows = outcomeRows(buildReport(), { reportHash: "33333333333333333333333333333333", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    m.exec(`
      DROP TABLE code_index_builds;
      DROP TABLE code_chunks_fts;
      DROP TABLE code_chunks;
      DROP TABLE code_files;
      PRAGMA user_version = 5;
    `);
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(listLessons(m).map((r) => r.id)).toEqual([lesson.id]);
    expect(listOutcomes(m)).toHaveLength(2);
    for (const table of ["code_files", "code_chunks", "code_index_builds"]) {
      expect(m.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    }
    // the fts5 virtual table is usable, not just present.
    m.prepare("INSERT INTO code_chunks_fts (id, path, text) VALUES (?, ?, ?)").run("c1", "a.mjs", "hello world");
    expect(m.prepare("SELECT id FROM code_chunks_fts WHERE code_chunks_fts MATCH ?").get('"hello"').id).toBe("c1");
    // add-only triggers on lessons survive: unrelated to this migration, but worth pinning alongside it.
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${lesson.id}'`)).toThrow(/add-only/);
  });
});

describe("openMemory: v6 to v7 migration (card outcomes-condition-columns)", () => {
  it("adds the seven condition columns to outcomes, defaulting backfilled to 0, and keeps existing rows, lessons, and reflections intact", () => {
    // Build a real v7 store, then downgrade it to v6 (drop the seven condition columns via rebuild, roll back
    // user_version) so this test only needs a store that openMemory (v6) would have produced.
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const rows = outcomeRows(buildReport(), { reportHash: "44444444444444444444444444444444", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    m.exec(`
      CREATE TABLE outcomes_v6 (
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
        commit_sha TEXT,
        track TEXT NOT NULL DEFAULT 'flow',
        wall_clock TEXT,
        gate TEXT,
        note TEXT,
        partial INTEGER,
        UNIQUE(run, task)
      );
      INSERT INTO outcomes_v6 SELECT id, recorded, run, run_id, report_hash, report_path, card, task, spec_hash, files, size, shape, models, implemented, verified, reviewed, review_issues, review_issue_count, adversary_verdict, adversary_blocked, adversary_source, blocks, passes, fix_passes, stop_reason, in_scope, budget_spent, tokens, usd, commit_sha, track, wall_clock, gate, note, partial FROM outcomes;
      DROP TABLE outcomes;
      ALTER TABLE outcomes_v6 RENAME TO outcomes;
      PRAGMA user_version = 6;
    `);
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(listLessons(m).map((r) => r.id)).toEqual([lesson.id]);
    const after = listOutcomes(m);
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.harness_commit).toBeNull();
      expect(row.config_hash).toBeNull();
      expect(row.class).toBeNull();
      expect(row.arm).toBeNull();
      expect(row.assigned_by).toBeNull();
      expect(row.explore_probability).toBeNull();
      expect(row.backfilled).toBe(0);
    }
    // add-only triggers on lessons survive: unrelated to this migration, but worth pinning alongside it.
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${lesson.id}'`)).toThrow(/add-only/);
  });
});

describe("openMemory: v7 to v8 migration (card run-report-codex-cost)", () => {
  it("M2: adds a null codex_usd column to outcomes, bumps user_version to 8, and keeps existing rows, lessons, and reflections intact", () => {
    // Build a real v8 store, then downgrade it to v7 (rebuild outcomes without codex_usd, roll back
    // user_version) so this test only needs a store that openMemory (v7) would have produced.
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const rows = outcomeRows(buildReport(), { reportHash: "66666666666666666666666666666666", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    const v7Columns = "id INTEGER PRIMARY KEY, recorded TEXT NOT NULL, run TEXT NOT NULL, run_id TEXT, report_hash TEXT, report_path TEXT, card TEXT, task TEXT NOT NULL, spec_hash TEXT, files TEXT, size TEXT, shape TEXT, models TEXT, implemented INTEGER, verified INTEGER, reviewed INTEGER, review_issues TEXT, review_issue_count INTEGER, adversary_verdict TEXT, adversary_blocked INTEGER, adversary_source TEXT, blocks TEXT NOT NULL DEFAULT '[]', passes INTEGER, fix_passes INTEGER, stop_reason TEXT, in_scope INTEGER, budget_spent TEXT, tokens TEXT, usd REAL, commit_sha TEXT, track TEXT NOT NULL DEFAULT 'flow', wall_clock TEXT, gate TEXT, note TEXT, partial INTEGER, harness_commit TEXT, config_hash TEXT, class TEXT, arm TEXT, assigned_by TEXT, explore_probability REAL, backfilled INTEGER NOT NULL DEFAULT 0, UNIQUE(run, task)";
    const v7ColumnNames = "id, recorded, run, run_id, report_hash, report_path, card, task, spec_hash, files, size, shape, models, implemented, verified, reviewed, review_issues, review_issue_count, adversary_verdict, adversary_blocked, adversary_source, blocks, passes, fix_passes, stop_reason, in_scope, budget_spent, tokens, usd, commit_sha, track, wall_clock, gate, note, partial, harness_commit, config_hash, class, arm, assigned_by, explore_probability, backfilled";
    m.exec("CREATE TABLE outcomes_v7 (" + v7Columns + ");");
    m.exec("INSERT INTO outcomes_v7 SELECT " + v7ColumnNames + " FROM outcomes;");
    m.exec('DROP TABLE outcomes;');
    m.exec("ALTER TABLE outcomes_v7 RENAME TO outcomes;");
    m.exec("PRAGMA user_version = 7;");
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(listLessons(m).map((r) => r.id)).toEqual([lesson.id]);
    const after = listOutcomes(m);
    expect(after).toHaveLength(2);
    for (const row of after) expect(row.codex_usd).toBeNull();
    const cols = m.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    expect(cols).toContain("codex_usd");
    // add-only triggers on lessons survive.
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${lesson.id}'`)).toThrow(/add-only/);
  });
});

describe("openMemory: v8 to v9 migration (card memory-stop-class)", () => {
  it("S1/S2/S3: adds a nullable stop_class column, bumps user_version to 9, and leaves old rows null with every other column, lessons, and triggers intact", () => {
    // Build a real store with rows from the real recorder, then downgrade it to v8 (drop stop_class,
    // roll user_version back) so this test needs only a store that openMemory (v8) would have produced.
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "a", implemented: true, verified: false, reviewed: false, stopReason: "implementer blocked on the sandbox" },
        { id: "b", implemented: true, verified: true, reviewed: true },
      ] }],
    };
    recordOutcomes(m, outcomeRows(report, { run: "wf_s1", reportHash: "99999999999999999999999999999999", now: "2026-10-01T00:00:00.000Z" }));
    const before = listOutcomes(m, { run: "wf_s1" });
    expect(before).toHaveLength(2);
    if (m.prepare("PRAGMA table_info(outcomes)").all().some((c) => c.name === "stop_class")) {
      m.exec("ALTER TABLE outcomes DROP COLUMN stop_class;");
    }
    m.exec("PRAGMA user_version = 8;");
    m.close();

    const v8 = new DatabaseSync(memoryPath(dir));
    expect(v8.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name)).not.toContain("stop_class");
    expect(v8.prepare("PRAGMA user_version").get().user_version).toBe(8);
    v8.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const cols = m.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    expect(cols.filter((c) => c === "stop_class")).toHaveLength(1);
    expect(listLessons(m).map((r) => r.id)).toEqual([lesson.id]);
    const after = listOutcomes(m, { run: "wf_s1" });
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.stop_class).toBeNull();
      const old = before.find((r) => r.task === row.task);
      const { stop_class: _drop, ...rest } = row;
      const { stop_class: _drop2, ...oldRest } = old;
      expect(rest).toEqual(oldRest);
    }
    expect(after.find((r) => r.task === "a").stop_reason).toBe("implementer blocked on the sandbox");
    // the migrated store accepts a stop_class on a new row.
    recordOutcomes(m, outcomeRows(
      { levels: [{ index: 0, tasks: [{ id: "c", implemented: false, verified: false, reviewed: false, stopReason: "r", stopClass: "environment" }] }] },
      { run: "wf_s1b", reportHash: "88888888888888888888888888888888", now: "2026-10-02T00:00:00.000Z" }
    ));
    expect(listOutcomes(m, { run: "wf_s1b" })[0].stop_class).toBe("environment");
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${lesson.id}'`)).toThrow(/add-only/);
  });
});

describe("outcomeRows: stop_class (card memory-stop-class)", () => {
  it("S4: a report with stopClass records that string, distinct from stopReason, through recordOutcomes/listOutcomes", () => {
    m = openMemory(dir);
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "x", implemented: false, verified: false, reviewed: false, stopReason: "free text reason", stopClass: "spec-contradiction" },
        { id: "y", implemented: false, verified: false, reviewed: false, stopReason: "other text", stopClass: "some-unlisted-class" },
      ] }],
    };
    const rows = outcomeRows(report, { run: "wf_s4", reportHash: "77777777777777777777777777777777", now: "2026-10-01T00:00:00.000Z" });
    expect(rows.find((r) => r.task === "x").stop_class).toBe("spec-contradiction");
    recordOutcomes(m, rows);
    const stored = listOutcomes(m, { run: "wf_s4" });
    const x = stored.find((r) => r.task === "x");
    expect(x.stop_class).toBe("spec-contradiction");
    expect(x.stop_reason).toBe("free text reason");
    expect(stored.find((r) => r.task === "y").stop_class).toBe("some-unlisted-class");
  });

  it("S5: a report without stopClass records null, not an empty string, in the row and in the store", () => {
    m = openMemory(dir);
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "old1", implemented: false, verified: false, reviewed: false, stopReason: "legacy reason" },
        { id: "old2", implemented: true, verified: true, reviewed: true },
      ] }],
    };
    const rows = outcomeRows(report, { run: "wf_s5", reportHash: "66666666666666666666666666666667", now: "2026-10-01T00:00:00.000Z" });
    for (const r of rows) {
      expect(r).toHaveProperty("stop_class");
      expect(r.stop_class).toBeNull();
    }
    recordOutcomes(m, rows);
    for (const r of listOutcomes(m, { run: "wf_s5" })) expect(r.stop_class).toBeNull();
    const raw = m.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE stop_class IS NOT NULL").get();
    expect(raw.n).toBe(0);
  });

  it("S6: a hand-track row leaves stop_class null in the row and in the store", () => {
    m = openMemory(dir);
    const row = handOutcomeRow({ card: "c-s6", commit: "sha6", now: "2026-10-01T00:00:00.000Z" });
    expect(row).toHaveProperty("stop_class");
    expect(row.stop_class).toBeNull();
    recordOutcomes(m, [row]);
    expect(listOutcomes(m, { track: "hand" })[0].stop_class).toBeNull();
  });

  it("memory-record-keeps-rounds: a re-record with a numeric passes replaces the stored passes and fix_passes", () => {
    m = openMemory(dir);
    const base = handOutcomeRow({ card: "c-rk", commit: "shark", now: "2026-10-01T00:00:00.000Z" });
    recordOutcomes(m, [{ ...base, passes: 1, fix_passes: 0 }]);
    recordOutcomes(m, [{ ...base, passes: 3, fix_passes: 2 }]);
    const [row] = listOutcomes(m, { track: "hand" });
    expect(row.passes).toBe(3);
    expect(row.fix_passes).toBe(2);
  });
});

describe("addLesson / getLesson", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("fills defaults and computes a deterministic id from kind, citation, and text", () => {
    const row = addLesson(m, { text: "always run typecheck first", kind: "pitfall", source: { agent: "reviewer" } });
    expect(row.kind).toBe("pitfall");
    expect(row.scope).toEqual([]);
    expect(row.citation).toBeNull();
    expect(row.source_model).toBeNull();
    expect(row.helpful).toBe(0);
    expect(row.harmful).toBe(0);
    expect(row.superseded_by).toBeNull();
    expect(typeof row.id).toBe("string");
    expect(row.id).toMatch(/^[0-9a-f]{16}$/);

    const expectedId = createHash("sha256").update("pitfall\n\nalways run typecheck first").digest("hex").slice(0, 16);
    expect(row.id).toBe(expectedId);
  });

  it("refuses a duplicate id", () => {
    addLesson(m, { text: "same text", kind: "project", source: { agent: "a" }, id: "dupe0000dupe0000" });
    expect(() => addLesson(m, { text: "different text", kind: "project", source: { agent: "a" }, id: "dupe0000dupe0000" })).toThrow(
      /lesson dupe0000dupe0000 already exists/
    );
  });

  it("validates kind, text, scope, and source.agent", () => {
    expect(() => addLesson(m, { text: "x", kind: "nope", source: { agent: "a" } })).toThrow(/kind/);
    expect(() => addLesson(m, { text: "", kind: "project", source: { agent: "a" } })).toThrow(/text/);
    expect(() => addLesson(m, { text: "   ", kind: "project", source: { agent: "a" } })).toThrow(/text/);
    expect(() => addLesson(m, { text: "x", kind: "project", scope: "not-an-array", source: { agent: "a" } })).toThrow(/scope/);
    expect(() => addLesson(m, { text: "x", kind: "project", scope: [1, 2], source: { agent: "a" } })).toThrow(/scope/);
    expect(() => addLesson(m, { text: "x", kind: "project", source: {} })).toThrow(/source.agent/);
    expect(() => addLesson(m, { text: "x", kind: "project" })).toThrow(/source.agent/);
  });

  it("getLesson returns null for a missing id and parses scope back to an array", () => {
    expect(getLesson(m, "missing")).toBeNull();
    const row = addLesson(m, { text: "scoped lesson", kind: "project", scope: ["a", "b"], source: { agent: "x" } });
    expect(getLesson(m, row.id).scope).toEqual(["a", "b"]);
  });
});

describe("add-only triggers", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("refuses delete and refuses rewriting text, but allows updating helpful/confirmed", () => {
    const row = addLesson(m, { text: "immutable text", kind: "pattern", source: { agent: "a" } });
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${row.id}'`)).toThrow(/add-only/);
    expect(() => m.prepare("UPDATE lessons SET text = ? WHERE id = ?").run("changed", row.id)).toThrow(/never rewritten/);
    expect(() => m.prepare("UPDATE lessons SET kind = ? WHERE id = ?").run("project", row.id)).toThrow(/never rewritten/);

    m.prepare("UPDATE lessons SET helpful = helpful + 1 WHERE id = ?").run(row.id);
    m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run("2026-09-08T00:00:00.000Z", row.id);
    const after = getLesson(m, row.id);
    expect(after.helpful).toBe(1);
    expect(after.confirmed).toBe("2026-09-08T00:00:00.000Z");
    expect(after.text).toBe("immutable text");
  });
});

describe("supersedeLesson", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("sets superseded_by when both rows exist and differ, and refuses a double supersede", () => {
    const oldRow = addLesson(m, { text: "old advice", kind: "pattern", source: { agent: "a" } });
    const newRow = addLesson(m, { text: "new advice", kind: "pattern", source: { agent: "a" } });
    const updated = supersedeLesson(m, oldRow.id, newRow.id);
    expect(updated.superseded_by).toBe(newRow.id);

    expect(() => supersedeLesson(m, oldRow.id, newRow.id)).toThrow(new RegExp(`already superseded by ${newRow.id}`));
    expect(() => supersedeLesson(m, oldRow.id, oldRow.id)).toThrow(/two different lesson ids/);
    expect(() => supersedeLesson(m, "missing", newRow.id)).toThrow(/does not exist/);
    expect(() => supersedeLesson(m, newRow.id, "missing")).toThrow(/does not exist/);
  });
});

describe("listLessons", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("orders by created then id and excludes superseded rows unless asked", () => {
    const a = addLesson(m, { text: "first", kind: "pattern", source: { agent: "a" }, created: "2026-01-01T00:00:00.000Z" });
    const b = addLesson(m, { text: "second", kind: "pattern", source: { agent: "a" }, created: "2026-01-02T00:00:00.000Z" });
    supersedeLesson(m, a.id, b.id);
    expect(listLessons(m).map((r) => r.id)).toEqual([b.id]);
    expect(listLessons(m, { includeSuperseded: true }).map((r) => r.id)).toEqual([a.id, b.id]);
  });
});

describe("searchLessons", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("ranks a query word to the lesson containing it, matches either word of a two-word query, and never throws on punctuation", () => {
    const gate = addLesson(m, { text: "run pnpm test:unit before finishing the gate", kind: "pattern", source: { agent: "a" } });
    const branch = addLesson(m, { text: "never delete a branch with -D", kind: "pitfall", source: { agent: "a" } });

    const hits = searchLessons(m, "gate");
    expect(hits[0].id).toBe(gate.id);

    const both = searchLessons(m, "gate branch");
    const ids = both.map((r) => r.id);
    expect(ids).toContain(gate.id);
    expect(ids).toContain(branch.id);

    expect(() => searchLessons(m, "test:unit")).not.toThrow();
    expect(searchLessons(m, "test:unit").length).toBeGreaterThan(0);

    expect(searchLessons(m, "")).toEqual([]);
    expect(searchLessons(m, "   ")).toEqual([]);
  });

  it("excludes superseded lessons unless includeSuperseded is set", () => {
    const a = addLesson(m, { text: "unique-word-alpha lesson", kind: "pattern", source: { agent: "a" } });
    const b = addLesson(m, { text: "unique-word-alpha replacement", kind: "pattern", source: { agent: "a" } });
    supersedeLesson(m, a.id, b.id);
    const hidden = searchLessons(m, "unique-word-alpha");
    expect(hidden.map((r) => r.id)).toEqual([b.id]);
    const shown = searchLessons(m, "unique-word-alpha", { includeSuperseded: true });
    expect(shown.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});

function buildReport() {
  return {
    plan: "p1",
    ok: true,
    levels: [
      {
        index: 0,
        levelAdversary: {
          ran: true,
          verdict: "fail",
          blocked: false,
          tasks: ["small-task"],
        },
        tasks: [
          {
            id: "ledger-task",
            card: "card-1",
            implemented: true,
            verified: true,
            reviewed: true,
            reviewIssues: ["nit: rename x"],
            inScope: true,
            specHash: "abc123",
            passes: 2,
            attempts: [{ pass: 1 }, { pass: 2, newFindings: ["f1"] }],
            stopReason: null,
            size: "M",
            shape: "full",
            models: { implement: "sonnet" },
            commit: "deadbeef",
            budget: { spent: { tokens: 5000 } },
            adversary: { ran: true, verdict: "fail", blocked: true, summary: "found it", issues: [{ severity: "blocker", description: "real bug" }] },
            ledger: [
              { id: "f1", stage: "adversary", severity: "blocker", status: "open", description: "real bug" },
            ],
          },
          {
            id: "small-task",
            card: "card-1",
            implemented: true,
            verified: true,
            reviewed: true,
            reviewIssues: [],
            inScope: true,
            specHash: "def456",
            passes: 1,
            attempts: [{ pass: 1 }],
            stopReason: null,
            size: "S",
            shape: "reuse",
            models: { implement: "sonnet" },
            commit: "cafef00d",
          },
        ],
      },
    ],
  };
}

describe("outcomeRows", () => {
  it("builds one row per task, attaching level-adversary source and blocks, files from the plan, and passes/fix_passes", () => {
    const report = buildReport();
    const plan = { card: "card-1", tasks: [{ id: "ledger-task", files: ["a.mjs", "b.mjs"] }, { id: "small-task", files: ["c.mjs"] }] };
    const rows = outcomeRows(report, { plan, reportHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now: "2026-09-08T00:00:00.000Z" });
    expect(rows).toHaveLength(2);

    const ledgerRow = rows.find((r) => r.task === "ledger-task");
    expect(ledgerRow.run).toBe("report:aaaaaaaaaaaa");
    expect(ledgerRow.run_id).toBeNull();
    expect(ledgerRow.card).toBe("card-1");
    expect(ledgerRow.files).toEqual(["a.mjs", "b.mjs"]);
    expect(ledgerRow.passes).toBe(2);
    expect(ledgerRow.fix_passes).toBe(1);
    expect(ledgerRow.adversary_source).toBe("task");
    expect(ledgerRow.adversary_verdict).toBe("fail");
    expect(ledgerRow.adversary_blocked).toBe(1);
    expect(ledgerRow.blocks).toHaveLength(1);
    expect(ledgerRow.blocks[0].id).toBe("f1");
    expect(ledgerRow.review_issue_count).toBe(1);
    expect(ledgerRow.tokens).toEqual({ total: 5000, source: "workflow" });
    expect(ledgerRow.usd).toBeNull();
    expect(ledgerRow.commit_sha).toBe("deadbeef");

    const smallRow = rows.find((r) => r.task === "small-task");
    expect(smallRow.adversary_source).toBe("level");
    expect(smallRow.adversary_verdict).toBe("fail");
    expect(smallRow.adversary_blocked).toBe(0);
    expect(smallRow.files).toEqual(["c.mjs"]);
    expect(smallRow.passes).toBe(1);
    expect(smallRow.fix_passes).toBe(0);
    expect(smallRow.tokens).toBeNull();
    expect(smallRow.usd).toBeNull();
  });

  it("prefers transcript tokens/usd from a costRun-shaped object, nulling usd when anything is unpriced", () => {
    const report = buildReport();
    const cost = {
      tasks: [
        { name: "ledger-task", agents: 3, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, usd: 1.23, unpriced: 0 },
        { name: "small-task", agents: 1, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, usd: 0.5, unpriced: 1 },
      ],
    };
    const rows = outcomeRows(report, { reportHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", cost, now: "2026-09-08T00:00:00.000Z" });
    const ledgerRow = rows.find((r) => r.task === "ledger-task");
    expect(ledgerRow.tokens).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, agents: 3, source: "transcripts" });
    expect(ledgerRow.usd).toBe(1.23);

    const smallRow = rows.find((r) => r.task === "small-task");
    expect(smallRow.tokens).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, agents: 1, source: "transcripts" });
    expect(smallRow.usd).toBeNull();
  });

  it("marks every row track 'flow' and leaves the hand-only columns null", () => {
    const report = buildReport();
    const rows = outcomeRows(report, { reportHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", now: "2026-09-08T00:00:00.000Z" });
    for (const row of rows) {
      expect(row.track).toBe("flow");
      expect(row.wall_clock).toBeNull();
      expect(row.gate).toBeNull();
      expect(row.note).toBeNull();
    }
  });

  it("writes partial as 0/1 from task.partial, null when the task carries no such field (card worker-context-handoff)", () => {
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "a", implemented: true, verified: false, reviewed: false, partial: true, stopReason: "partial after resume: still broken" },
        { id: "b", implemented: true, verified: true, reviewed: true, partial: false },
        { id: "c", implemented: true, verified: true, reviewed: true },
      ] }],
    };
    const rows = outcomeRows(report, { reportHash: "11111111111111111111111111111111", now: "2026-09-08T00:00:00.000Z" });
    expect(rows.find((r) => r.task === "a").partial).toBe(1);
    expect(rows.find((r) => r.task === "b").partial).toBe(0);
    expect(rows.find((r) => r.task === "c").partial).toBeNull();
  });

  it("M3 (card run-report-codex-cost): a task's own adversary usage prices codex_usd at the gpt-5.6-sol input rate, read from CODEX_PRICES, never hard-coded", () => {
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false, usage: { inputTokens: 1000000, outputTokens: 0 } } },
      ] }],
    };
    const rows = outcomeRows(report, { reportHash: "77777777777777777777777777777777", now: "2026-09-08T00:00:00.000Z" });
    const p = CODEX_PRICES["gpt-5.6-sol"];
    const expected = (1000000 * p.input + 0 * p.output) / 1e6;
    expect(rows[0].codex_usd).toBeCloseTo(expected, 10);

    // M-1 (review round 1): the priced value must also round-trip through the real store, not just outcomeRows'
    // in-memory row. Deleting codex_usd from OUTCOME_COLUMNS must fail this half of the test.
    m = openMemory(dir);
    recordOutcomes(m, rows);
    const stored = listOutcomes(m);
    expect(stored[0].codex_usd).toBeCloseTo(expected, 10);
  });

  it("R10 (card run-report-codex-cost, review round 1): a level with two tasks, one with its own adversary that ran but carries no usage, the other falling back to a levelAdversary shared by both — both rows are null", () => {
    m = openMemory(dir);
    const report = {
      levels: [{
        index: 0,
        levelAdversary: { ran: true, verdict: "pass", blocked: false, tasks: ["a", "b"], usage: { inputTokens: 500000, outputTokens: 500000 } },
        tasks: [
          { id: "a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false } },
          { id: "b", implemented: true, verified: true, reviewed: true },
        ],
      }],
    };
    const rows = outcomeRows(report, { reportHash: "22222222222222222222222222222222", now: "2026-09-08T00:00:00.000Z" });
    expect(rows.find((r) => r.task === "a").adversary_source).toBe("task");
    expect(rows.find((r) => r.task === "a").codex_usd).toBeNull();
    expect(rows.find((r) => r.task === "b").adversary_source).toBe("level");
    expect(rows.find((r) => r.task === "b").codex_usd).toBeNull();
  });

  it("m-5 (card run-report-codex-cost, review round 1): the level adversary's own task list decides sharing, not the level's full task list — an S task it lists alone is priced even though the level also holds an M task with its own adversary", () => {
    const report = {
      levels: [{
        index: 0,
        levelAdversary: { ran: true, verdict: "pass", blocked: false, tasks: ["s1"], usage: { inputTokens: 500000, outputTokens: 500000 } },
        tasks: [
          { id: "m1", shape: "M", implemented: true, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false, usage: { inputTokens: 1000000, outputTokens: 0 } } },
          { id: "s1", shape: "S", implemented: true, verified: true, reviewed: true },
        ],
      }],
    };
    const rows = outcomeRows(report, { reportHash: "33333333333333333333333333333333", now: "2026-09-08T00:00:00.000Z" });
    const p = CODEX_PRICES["gpt-5.6-sol"];
    const mExpected = (1000000 * p.input + 0 * p.output) / 1e6;
    const sExpected = (500000 * p.input + 500000 * p.output) / 1e6;
    expect(rows.find((r) => r.task === "m1").adversary_source).toBe("task");
    expect(rows.find((r) => r.task === "m1").codex_usd).toBeCloseTo(mExpected, 10);
    expect(rows.find((r) => r.task === "s1").adversary_source).toBe("level");
    expect(rows.find((r) => r.task === "s1").codex_usd).toBeCloseTo(sExpected, 10);
  });

  it("M4 (card run-report-codex-cost): a level adversary shared by two tasks leaves codex_usd null on both (never split, never double-counted); with only one task sharing it, that row is priced", () => {
    const sharedByTwo = {
      levels: [{
        index: 0,
        levelAdversary: { ran: true, verdict: "pass", blocked: false, tasks: ["s1", "s2"], usage: { inputTokens: 500000, outputTokens: 500000 } },
        tasks: [
          { id: "s1", shape: "S", implemented: true, verified: true, reviewed: true },
          { id: "s2", shape: "S", implemented: true, verified: true, reviewed: true },
        ],
      }],
    };
    const twoRows = outcomeRows(sharedByTwo, { reportHash: "88888888888888888888888888888888", now: "2026-09-08T00:00:00.000Z" });
    expect(twoRows.find((r) => r.task === "s1").adversary_source).toBe("level");
    expect(twoRows.find((r) => r.task === "s1").codex_usd).toBeNull();
    expect(twoRows.find((r) => r.task === "s2").codex_usd).toBeNull();

    const sharedByOne = {
      levels: [{
        index: 0,
        levelAdversary: { ran: true, verdict: "pass", blocked: false, tasks: ["s1"], usage: { inputTokens: 500000, outputTokens: 500000 } },
        tasks: [
          { id: "s1", shape: "S", implemented: true, verified: true, reviewed: true },
        ],
      }],
    };
    const oneRow = outcomeRows(sharedByOne, { reportHash: "99999999999999999999999999999999", now: "2026-09-08T00:00:00.000Z" });
    const p = CODEX_PRICES["gpt-5.6-sol"];
    const expected = (500000 * p.input + 500000 * p.output) / 1e6;
    expect(oneRow.find((r) => r.task === "s1").adversary_source).toBe("level");
    expect(oneRow.find((r) => r.task === "s1").codex_usd).toBeCloseTo(expected, 10);
  });
});

describe("handOutcomeRow", () => {
  it("builds a hand-track row keyed hand:<commit>, with the workflow-only columns null", () => {
    const row = handOutcomeRow({ card: "hand-track-outcomes", commit: "deadbeef1234", wallClock: "34 min", gate: "typecheck 0; unit 639 passed", note: "note text", now: "2026-09-08T00:00:00.000Z" });
    expect(row.run).toBe("hand:deadbeef1234");
    expect(row.task).toBe("hand-track-outcomes");
    expect(row.card).toBe("hand-track-outcomes");
    expect(row.commit_sha).toBe("deadbeef1234");
    expect(row.track).toBe("hand");
    expect(row.wall_clock).toBe("34 min");
    expect(row.gate).toBe("typecheck 0; unit 639 passed");
    expect(row.note).toBe("note text");
    expect(row.recorded).toBe("2026-09-08T00:00:00.000Z");
    for (const c of [
      "run_id", "report_hash", "report_path", "spec_hash", "files", "size", "shape", "models", "implemented",
      "verified", "reviewed", "review_issues", "review_issue_count", "adversary_verdict", "adversary_blocked",
      "adversary_source", "blocks", "passes", "fix_passes", "stop_reason", "in_scope", "budget_spent", "tokens", "usd", "partial",
    ]) {
      expect(row[c]).toBeNull();
    }
  });

  it("defaults wallClock/gate/note to null and throws on a missing card or commit", () => {
    const row = handOutcomeRow({ card: "c1", commit: "sha1" });
    expect(row.wall_clock).toBeNull();
    expect(row.gate).toBeNull();
    expect(row.note).toBeNull();
    expect(() => handOutcomeRow({ commit: "sha1" })).toThrow(/card/);
    expect(() => handOutcomeRow({ card: "c1" })).toThrow(/commit/);
  });

  it("M5 (card run-report-codex-cost): a hand-track row leaves codex_usd null", () => {
    const row = handOutcomeRow({ card: "c1", commit: "sha1" });
    expect(row.codex_usd).toBeNull();
  });

  it("U1 (card usd-budget-size-class): cost fills the usd column; without it usd stays null, never 0", () => {
    expect(handOutcomeRow({ card: "c1", commit: "sha1", cost: 3.21 }).usd).toBe(3.21);
    expect(handOutcomeRow({ card: "c1", commit: "sha1", cost: 0.5 }).usd).toBe(0.5);
    expect(handOutcomeRow({ card: "c1", commit: "sha1" }).usd).toBeNull();
    expect(handOutcomeRow({ card: "c1", commit: "sha1", cost: null }).usd).toBeNull();
  });

  it("leaves the seven condition columns null and backfilled 0 when no condition is given (card outcomes-condition-columns)", () => {
    const row = handOutcomeRow({ card: "c1", commit: "sha1" });
    for (const c of ["harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability"]) {
      expect(row[c]).toBeNull();
    }
    expect(row.backfilled).toBe(0);
  });

  it("fills the condition columns from a parsed condition.json, defaulting backfilled to 0 (card outcomes-condition-columns)", () => {
    const condition = {
      harnessCommit: "abc123def4560000000000000000000000000000",
      configHash: "deadbeefcafedeadbeefcafedeadbeefcafedead",
      class: "code",
      arm: "code/default",
      assignedBy: "policy",
      exploreProbability: null,
    };
    const row = handOutcomeRow({ card: "c1", commit: "sha1", condition });
    expect(row.harness_commit).toBe(condition.harnessCommit);
    expect(row.config_hash).toBe(condition.configHash);
    expect(row.class).toBe("code");
    expect(row.arm).toBe("code/default");
    expect(row.assigned_by).toBe("policy");
    expect(row.explore_probability).toBeNull();
    expect(row.backfilled).toBe(0);
  });

  it("carries a numeric exploreProbability through when assignedBy is 'explore' (card outcomes-condition-columns)", () => {
    const condition = {
      harnessCommit: "abc123",
      configHash: "cafe",
      class: "code",
      arm: "code/explore",
      assignedBy: "explore",
      exploreProbability: 0.2,
    };
    const row = handOutcomeRow({ card: "c1", commit: "sha1", condition });
    expect(row.assigned_by).toBe("explore");
    expect(row.explore_probability).toBe(0.2);
  });
});

describe("recordOutcomes / listOutcomes", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("upserts rows, reporting inserted vs updated, keeping the row count stable", () => {
    const report = buildReport();
    const rows = outcomeRows(report, { run: "wf_1", reportHash: "cccccccccccccccccccccccccccccccc", now: "2026-09-08T00:00:00.000Z" });
    const first = recordOutcomes(m, rows);
    expect(first).toEqual({ inserted: 2, updated: 0 });
    expect(listOutcomes(m)).toHaveLength(2);

    const second = recordOutcomes(m, rows);
    expect(second).toEqual({ inserted: 0, updated: 2 });
    expect(listOutcomes(m)).toHaveLength(2);
  });

  it("listOutcomes filters by run and task and parses JSON columns back", () => {
    const report = buildReport();
    const rows = outcomeRows(report, { run: "wf_2", reportHash: "dddddddddddddddddddddddddddddddd", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    const byRun = listOutcomes(m, { run: "wf_2" });
    expect(byRun).toHaveLength(2);
    const byTask = listOutcomes(m, { task: "ledger-task" });
    expect(byTask).toHaveLength(1);
    expect(Array.isArray(byTask[0].review_issues)).toBe(true);
    expect(byTask[0].review_issues).toEqual(["nit: rename x"]);
    expect(Array.isArray(byTask[0].blocks)).toBe(true);
  });

  it("round-trips partial through recordOutcomes/listOutcomes, alongside verified (card worker-context-handoff)", () => {
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "a", implemented: true, verified: false, reviewed: false, partial: true, stopReason: "partial after resume: still broken" },
        { id: "b", implemented: true, verified: true, reviewed: true, partial: false },
      ] }],
    };
    const rows = outcomeRows(report, { run: "wf_partial", reportHash: "22222222222222222222222222222222", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, rows);
    const stored = listOutcomes(m, { run: "wf_partial" });
    const a = stored.find((r) => r.task === "a");
    const b = stored.find((r) => r.task === "b");
    expect(a.partial).toBe(1);
    expect(a.verified).toBe(0);
    expect(a.stop_reason).toBe("partial after resume: still broken");
    expect(b.partial).toBe(0);
    expect(b.verified).toBe(1);
  });

  it("records a hand row whose JSON columns round-trip null, not [] or a default", () => {
    const row = handOutcomeRow({ card: "hand-card", commit: "cafefeed", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, [row]);
    const [stored] = listOutcomes(m, { run: "hand:cafefeed" });
    expect(stored.track).toBe("hand");
    expect(stored.files).toBeNull();
    expect(stored.models).toBeNull();
    expect(stored.review_issues).toBeNull();
    expect(stored.blocks).toBeNull();
    expect(stored.budget_spent).toBeNull();
    expect(stored.tokens).toBeNull();
  });

  it("recording a hand row does not disturb an existing flow row for the same task id", () => {
    const report = buildReport();
    const flowRows = outcomeRows(report, { run: "wf_3", reportHash: "ffffffffffffffffffffffffffffffff", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, flowRows);
    const handRow = handOutcomeRow({ card: "ledger-task", commit: "1234567", now: "2026-09-08T00:00:01.000Z" });
    recordOutcomes(m, [handRow]);
    const all = listOutcomes(m);
    expect(all).toHaveLength(3);
    const flowRow = all.find((r) => r.run === "wf_3" && r.task === "ledger-task");
    expect(flowRow.track).toBe("flow");
    expect(flowRow.fix_passes).toBe(1);
    expect(typeof flowRow.review_issue_count).toBe("number");
    expect(Array.isArray(flowRow.blocks)).toBe(true);
  });

  it("keeps an existing condition stamp when a later upsert for the same run+task carries a null condition (card outcomes-condition-columns)", () => {
    const condition = {
      harnessCommit: "hc-original",
      configHash: "cfg-original",
      class: "code",
      arm: "code/default",
      assignedBy: "policy",
      exploreProbability: null,
    };
    const stamped = handOutcomeRow({ card: "stamp-card", commit: "sha1", now: "2026-09-08T00:00:00.000Z", condition });
    recordOutcomes(m, [stamped]);
    const unstamped = handOutcomeRow({ card: "stamp-card", commit: "sha1", now: "2026-09-08T00:00:01.000Z" });
    recordOutcomes(m, [unstamped]);
    const [stored] = listOutcomes(m, { run: "hand:sha1" });
    expect(stored.harness_commit).toBe("hc-original");
    expect(stored.config_hash).toBe("cfg-original");
    expect(stored.class).toBe("code");
    expect(stored.arm).toBe("code/default");
    expect(stored.assigned_by).toBe("policy");
    // the row's own recorded time still moves forward: this is a real re-record, not a no-op.
    expect(stored.recorded).toBe("2026-09-08T00:00:01.000Z");
  });

  it("(review, blocker) a hand row already marked backfilled keeps harness_commit and backfilled=1 when re-recorded with no condition", () => {
    const row = handOutcomeRow({ card: "backfill-hand-card", commit: "sha1", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, [row]);
    // Simulate what `memory.mjs condition backfill` does to a row: stamp harness_commit and mark backfilled,
    // outside of handOutcomeRow/recordOutcomes (that CLI command writes straight to the table).
    m.exec(`UPDATE outcomes SET harness_commit = 'deadbeef00', backfilled = 1 WHERE run = 'hand:sha1'`);

    // An ordinary later re-record of the same landing, carrying no condition at all (the common case: nobody
    // ran `condition open` for it, same as the very first record above).
    const reRecord = handOutcomeRow({ card: "backfill-hand-card", commit: "sha1", now: "2026-09-08T00:00:01.000Z" });
    recordOutcomes(m, [reRecord]);

    const [stored] = listOutcomes(m, { run: "hand:sha1" });
    expect(stored.harness_commit).toBe("deadbeef00");
    expect(stored.backfilled).toBe(1);
  });

  it("(review, blocker) a flow row already marked backfilled keeps harness_commit and backfilled=1 when re-recorded via outcomeRows/recordOutcomes", () => {
    const report = buildReport();
    const firstRows = outcomeRows(report, { run: "wf_backfill", reportHash: "55555555555555555555555555555555", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, firstRows);
    m.exec(`UPDATE outcomes SET harness_commit = 'deadbeef11', backfilled = 1 WHERE run = 'wf_backfill' AND task = 'ledger-task'`);

    const secondRows = outcomeRows(report, { run: "wf_backfill", reportHash: "55555555555555555555555555555555", now: "2026-09-08T00:00:01.000Z" });
    recordOutcomes(m, secondRows);

    const [stored] = listOutcomes(m, { run: "wf_backfill", task: "ledger-task" });
    expect(stored.harness_commit).toBe("deadbeef11");
    expect(stored.backfilled).toBe(1);
  });

  it("(review) re-recording a backfilled row WITH a real condition overwrites the backfilled stamp: the real condition is written and backfilled becomes 0", () => {
    const row = handOutcomeRow({ card: "backfill-then-real-card", commit: "sha2", now: "2026-09-08T00:00:00.000Z" });
    recordOutcomes(m, [row]);
    m.exec(`UPDATE outcomes SET harness_commit = 'deadbeef22', backfilled = 1 WHERE run = 'hand:sha2'`);

    const condition = {
      harnessCommit: "realcommit123",
      configHash: "realcfg",
      class: "code",
      arm: "code/default",
      assignedBy: "policy",
      exploreProbability: null,
    };
    const reRecord = handOutcomeRow({ card: "backfill-then-real-card", commit: "sha2", now: "2026-09-08T00:00:01.000Z", condition });
    recordOutcomes(m, [reRecord]);

    const [stored] = listOutcomes(m, { run: "hand:sha2" });
    expect(stored.harness_commit).toBe("realcommit123");
    expect(stored.config_hash).toBe("realcfg");
    expect(stored.backfilled).toBe(0);
  });
});

describe("conditionConfigHash (card outcomes-condition-columns)", () => {
  let configDir;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "doug-memory-confighash-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeClaudeMd(modelCell, prose) {
    writeFileSync(
      join(configDir, "CLAUDE.md"),
      [
        "# Project instructions",
        "",
        prose,
        "",
        "## Models",
        "",
        "| Work | Model | Effort |",
        "|------|-------|--------|",
        `| plan | ${modelCell} | high |`,
        "",
        "More prose after the table, also free to change.",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  it("changes when a Models table cell changes, but not when prose outside the table changes", () => {
    mkdirSync(join(configDir, ".doug"), { recursive: true });
    writeFileSync(join(configDir, ".doug", "config.json"), JSON.stringify({ a: 1 }), "utf8");
    writeClaudeMd("opus", "Some prose here that changes freely.");
    const base = conditionConfigHash(configDir);
    expect(typeof base).toBe("string");
    expect(base.length).toBeGreaterThan(0);

    writeClaudeMd("opus", "Totally different prose, same table.");
    expect(conditionConfigHash(configDir)).toBe(base);

    writeClaudeMd("sonnet", "Some prose here that changes freely.");
    expect(conditionConfigHash(configDir)).not.toBe(base);
  });

  it("changes when .doug/config.json changes, with CLAUDE.md held fixed", () => {
    writeClaudeMd("opus", "fixed prose");
    mkdirSync(join(configDir, ".doug"), { recursive: true });
    writeFileSync(join(configDir, ".doug", "config.json"), JSON.stringify({ a: 1 }), "utf8");
    const base = conditionConfigHash(configDir);
    writeFileSync(join(configDir, ".doug", "config.json"), JSON.stringify({ a: 2 }), "utf8");
    expect(conditionConfigHash(configDir)).not.toBe(base);
  });

  it("is deterministic and does not throw with no .doug/config.json and no CLAUDE.md at all", () => {
    const a = conditionConfigHash(configDir);
    const b = conditionConfigHash(configDir);
    expect(typeof a).toBe("string");
    expect(a).toBe(b);
  });

  it("(review) does not change when a second markdown table later in CLAUDE.md, after the Models table, is edited", () => {
    mkdirSync(join(configDir, ".doug"), { recursive: true });
    writeFileSync(join(configDir, ".doug", "config.json"), JSON.stringify({ a: 1 }), "utf8");
    const claudeMd = (secondTableCell) =>
      [
        "# Project instructions",
        "",
        "## Models",
        "",
        "| Work | Model | Effort |",
        "|------|-------|--------|",
        "| plan | opus | high |",
        "",
        "Prose between the Models table and a second, unrelated table.",
        "",
        "| Other | Table |",
        "|-------|-------|",
        `| a | ${secondTableCell} |`,
        "",
      ].join("\n");
    writeFileSync(join(configDir, "CLAUDE.md"), claudeMd("one"), "utf8");
    const base = conditionConfigHash(configDir);
    writeFileSync(join(configDir, "CLAUDE.md"), claudeMd("two"), "utf8");
    expect(conditionConfigHash(configDir)).toBe(base);
  });
});

function fakeProvider({ name = "fake", model = "fake-model", dims = 3, vectorFor = () => [1, 0, 0] } = {}) {
  return {
    name,
    model,
    dims,
    async embed(texts) {
      return { ok: true, vectors: texts.map((t) => Float32Array.from(vectorFor(t))) };
    },
  };
}

describe("setLessonEmbedding / lessonsNeedingEmbedding / embedLessons", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("setLessonEmbedding stores a vector that round-trips through getLesson's embedding columns", () => {
    const row = addLesson(m, { text: "keep vectors normalized", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, row.id, { model: "fake-model", dims: 3, vector: Float32Array.from([0.6, 0.8, 0]) });
    const stored = getLesson(m, row.id);
    expect(stored.embedding_model).toBe("fake-model");
    expect(stored.embedding_dims).toBe(3);
    expect(stored.embedding).toBeTruthy();
  });

  it("lessonsNeedingEmbedding finds rows with no embedding or a different model/dims, and skips superseded and stale rows", () => {
    const a = addLesson(m, { text: "a", kind: "pattern", source: { agent: "worker" } });
    const b = addLesson(m, { text: "b", kind: "pattern", source: { agent: "worker" } });
    const c = addLesson(m, { text: "c", kind: "pattern", source: { agent: "worker" } });
    const d = addLesson(m, { text: "d", kind: "pattern", source: { agent: "worker" } });
    const e = addLesson(m, { text: "e", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, a.id, { model: "fake-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    setLessonEmbedding(m, b.id, { model: "other-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run("2026-09-10T00:00:00.000Z", c.id);
    supersedeLesson(m, d.id, e.id);
    const need = lessonsNeedingEmbedding(m, { model: "fake-model", dims: 3 });
    const ids = need.map((l) => l.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(c.id);
    expect(ids).not.toContain(d.id);
  });

  it("embeds every row needing it in batches", async () => {
    const a = addLesson(m, { text: "alpha", kind: "pattern", source: { agent: "worker" } });
    const b = addLesson(m, { text: "beta", kind: "pattern", source: { agent: "worker" } });
    const seenBatches = [];
    const provider = {
      name: "fake",
      model: "fake-model",
      dims: 3,
      embed: async (texts) => {
        seenBatches.push(texts.length);
        return { ok: true, vectors: texts.map(() => Float32Array.from([1, 0, 0])) };
      },
    };
    const result = await embedLessons(m, provider, { batch: 1 });
    expect(result).toEqual({ total: 2, embedded: 2, failed: 0, reason: null });
    expect(seenBatches).toEqual([1, 1]);
    expect(getLesson(m, a.id).embedding_model).toBe("fake-model");
    expect(getLesson(m, b.id).embedding_model).toBe("fake-model");
  });

  it("counts a failed batch and reports the reason, without throwing", async () => {
    addLesson(m, { text: "gamma", kind: "pattern", source: { agent: "worker" } });
    const provider = { name: "fake", model: "fake-model", dims: 3, embed: async () => ({ ok: false, reason: "server down" }) };
    const result = await embedLessons(m, provider);
    expect(result).toEqual({ total: 1, embedded: 0, failed: 1, reason: "server down" });
  });
});

describe("checkCitation", () => {
  let checkoutDir;

  beforeEach(() => {
    checkoutDir = mkdtempSync(join(tmpdir(), "doug-memory-citation-"));
  });

  afterEach(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  it("passes a report: citation, free text, and a missing citation untouched", () => {
    expect(checkCitation({ citation: "report:abc123" }, checkoutDir)).toEqual({ ok: true, reason: "report citation" });
    expect(checkCitation({ citation: "some free-form note, not a path:line" }, checkoutDir)).toEqual({ ok: true, reason: "free text citation" });
    expect(checkCitation({ citation: null }, checkoutDir)).toEqual({ ok: true, reason: "no citation" });
  });

  it("checks a path:line citation against the checkout, and quoted text against that line", () => {
    mkdirSync(join(checkoutDir, "src"), { recursive: true });
    writeFileSync(join(checkoutDir, "src", "a.mjs"), "one\ntwo\nthree\n", "utf8");
    expect(checkCitation({ citation: "src/a.mjs:2" }, checkoutDir).ok).toBe(true);
    expect(checkCitation({ citation: 'src/a.mjs:2 "two"' }, checkoutDir).ok).toBe(true);
    expect(checkCitation({ citation: 'src/a.mjs:2 "moved"' }, checkoutDir).ok).toBe(false);
    expect(checkCitation({ citation: "src/a.mjs:99" }, checkoutDir).ok).toBe(false);
    expect(checkCitation({ citation: "src/missing.mjs:1" }, checkoutDir).ok).toBe(false);
  });

  it("with a report passed, checks a report: citation against it; without one, passes it through unchanged (card memory-reflect)", () => {
    const report = {
      levels: [{ index: 0, tasks: [{ id: "t1" }] }],
    };
    // report:<task>/<block-id>: only checkable with adversary blocks present, so build one with a ledger entry.
    const reportWithBlock = {
      levels: [{ index: 0, tasks: [{ id: "t1", ledger: [{ id: "F1", stage: "adversary", severity: "blocker", description: "x" }], attempts: [{ pass: 1, newFindings: ["F1"] }] }] }],
    };
    expect(checkCitation({ citation: "report:t1" }, checkoutDir, { report })).toEqual({ ok: true, reason: "task holds" });
    expect(checkCitation({ citation: "report:nope" }, checkoutDir, { report }).ok).toBe(false);
    expect(checkCitation({ citation: "report:t1/F1" }, checkoutDir, { report: reportWithBlock })).toEqual({ ok: true, reason: "block holds" });
    expect(checkCitation({ citation: "report:t1/F9" }, checkoutDir, { report: reportWithBlock }).ok).toBe(false);
    // no report given: behaves exactly as today, unchecked.
    expect(checkCitation({ citation: "report:t1" }, checkoutDir)).toEqual({ ok: true, reason: "report citation" });
    expect(checkCitation({ citation: "report:nope" }, checkoutDir)).toEqual({ ok: true, reason: "report citation" });
  });
});

describe("recallLessons", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("is keyword-only when no provider is given, and says why", async () => {
    addLesson(m, { text: "flaky test needs a retry policy", kind: "pattern", source: { agent: "worker" } });
    const result = await recallLessons(m, "flaky test retry", { checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no provider configured");
    expect(result.provider).toBeNull();
    expect(result.lessons).toHaveLength(1);
  });

  it("returns every lessons column (except the embedding trio) on a recalled lesson, derived from the live schema", async () => {
    // The by-id load in recallLessons (the only place text, kind, citation, source_*, task, card, commit_sha,
    // helpful, harmful and superseded_by are read) names its columns; a column added to the schema but missing
    // there would silently vanish from recall output. The expected list comes from PRAGMA table_info.
    addLesson(m, { text: "flaky test needs a retry policy", kind: "pattern", source: { agent: "worker" } });
    const result = await recallLessons(m, "flaky test retry", { checkoutDir: dir });
    expect(result.lessons).toHaveLength(1);
    const returned = result.lessons[0];
    const omitted = new Set(["embedding", "embedding_model", "embedding_dims"]);
    const columns = m.prepare("PRAGMA table_info(lessons)").all().map((c) => c.name);
    expect(columns.length).toBeGreaterThan(omitted.size);
    const missing = columns.filter((c) => !omitted.has(c) && !(c in returned));
    expect(missing).toEqual([]);
    expect(returned.hasVector).toBe(false);
  });

  it("ranks the high-cosine weak keyword match ahead of the strong keyword match, with sides naming bm25 and vector", async () => {
    const l1 = addLesson(m, { text: "flaky test needs a retry policy", kind: "pattern", source: { agent: "worker" } });
    const l2 = addLesson(m, { text: "the test suite", kind: "pattern", source: { agent: "worker" } });
    // l1 matches all three query tokens (bm25 rank 1); l2 matches only "test" (bm25 rank 2) but carries a
    // vector identical to the query's, so it wins the fused ranking.
    setLessonEmbedding(m, l2.id, { model: "fake-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const result = await recallLessons(m, "flaky test retry", { provider, checkoutDir: dir });
    expect(result.mode).toBe("hybrid");
    expect(result.provider).toBe("fake");
    expect(result.lessons.map((l) => l.id)).toEqual([l2.id, l1.id]);
    expect(result.lessons[0].sides.sort()).toEqual(["bm25", "vector"]);
    expect(result.lessons[1].sides).toEqual(["bm25"]);
  });

  it("stays keyword-only, naming the model/dims pair, when stored vectors are under a different model", async () => {
    const l1 = addLesson(m, { text: "flaky test needs a retry policy", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, l1.id, { model: "other-model", dims: 8, vector: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]) });
    const provider = fakeProvider({ model: "fake-model", dims: 3 });
    const result = await recallLessons(m, "flaky", { provider, checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no vectors stored for fake-model/3");
  });

  it("weights recency: a recently created lesson outscores an older, similarly-matching one", async () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    const recent = addLesson(m, {
      text: "retry flaky network calls",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(now.getTime() - 2 * 86400000).toISOString(),
    });
    const old = addLesson(m, {
      text: "retry flaky network calls again",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(now.getTime() - 25 * 86400000).toISOString(),
    });
    const result = await recallLessons(m, "retry flaky network", { checkoutDir: dir, now });
    const scores = Object.fromEntries(result.lessons.map((l) => [l.id, l.score]));
    expect(scores[recent.id]).toBeGreaterThan(scores[old.id]);
  });

  it("excludes a lesson unconfirmed for over staleDays, and keeps one recently confirmed despite being older", async () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    const excluded = addLesson(m, {
      text: "old retry flaky lesson",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(now.getTime() - 40 * 86400000).toISOString(),
    });
    const included = addLesson(m, {
      text: "confirmed retry flaky lesson",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(now.getTime() - 200 * 86400000).toISOString(),
    });
    m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(new Date(now.getTime() - 10 * 86400000).toISOString(), included.id);
    const result = await recallLessons(m, "retry flaky", { checkoutDir: dir, now, staleDays: 30 });
    const ids = result.lessons.map((l) => l.id);
    expect(ids).not.toContain(excluded.id);
    expect(ids).toContain(included.id);
  });

  it("boosts a lesson whose scope matches a given file over one whose scope does not", async () => {
    const inScope = addLesson(m, { text: "retry flaky uploads", kind: "pattern", scope: ["src/upload/**"], source: { agent: "worker" } });
    const outScope = addLesson(m, { text: "retry flaky uploads too", kind: "pattern", scope: ["src/other/**"], source: { agent: "worker" } });
    const result = await recallLessons(m, "retry flaky uploads", { checkoutDir: dir, files: ["src/upload/client.mjs"] });
    const scores = Object.fromEntries(result.lessons.map((l) => [l.id, l.score]));
    expect(scores[inScope.id]).toBeGreaterThan(scores[outScope.id]);
  });

  it("re-checks each returned lesson's citation: a moved line is marked stale and dropped, a good one is confirmed", async () => {
    const checkoutDir = mkdtempSync(join(tmpdir(), "doug-memory-recall-checkout-"));
    mkdirSync(join(checkoutDir, ".doug"), { recursive: true });
    mkdirSync(join(checkoutDir, "src"), { recursive: true });
    writeFileSync(join(checkoutDir, "src", "a.mjs"), "line one\nline two\nline three\n", "utf8");
    const good = addLesson(m, { text: "retry flaky calls", kind: "pattern", citation: 'src/a.mjs:2 "line two"', source: { agent: "worker" } });
    const bad = addLesson(m, { text: "retry flaky calls too", kind: "pattern", citation: 'src/a.mjs:2 "line moved"', source: { agent: "worker" } });
    try {
      const result = await recallLessons(m, "retry flaky", { checkoutDir });
      expect(result.checked).toBe(true);
      const ids = result.lessons.map((l) => l.id);
      expect(ids).toContain(good.id);
      expect(ids).not.toContain(bad.id);
      expect(getLesson(m, bad.id).stale).not.toBeNull();
      expect(getLesson(m, good.id).confirmed).not.toBeNull();
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("excludes a superseded lesson", async () => {
    const old = addLesson(m, { text: "retry flaky calls old", kind: "pattern", source: { agent: "worker" } });
    const replacement = addLesson(m, { text: "retry flaky calls new", kind: "pattern", source: { agent: "worker" } });
    supersedeLesson(m, old.id, replacement.id);
    const result = await recallLessons(m, "retry flaky", { checkoutDir: dir });
    expect(result.lessons.map((l) => l.id)).not.toContain(old.id);
    expect(result.lessons.map((l) => l.id)).toContain(replacement.id);
  });

  it("(MAJOR 3) does not throw when checkoutDir is omitted, returning lessons unchecked", async () => {
    const row = addLesson(m, { text: "retry flaky calls", kind: "pattern", citation: "some/file.mjs:1", source: { agent: "worker" } });
    const result = await recallLessons(m, "retry flaky");
    expect(result.checked).toBe(false);
    expect(result.lessons.map((l) => l.id)).toContain(row.id);
    expect(getLesson(m, row.id).stale).toBeNull();
  });

  it("(MAJOR 4a) a wrong or partial checkout (no .doug) never poisons the store: the citation is left unchecked, not marked stale", async () => {
    const wrongDir = mkdtempSync(join(tmpdir(), "doug-memory-wrong-checkout-"));
    try {
      const row = addLesson(m, { text: "retry flaky calls", kind: "pattern", citation: "src/does-not-exist.mjs:1", source: { agent: "worker" } });
      const result = await recallLessons(m, "retry flaky", { checkoutDir: wrongDir });
      expect(result.checked).toBe(false);
      expect(result.lessons.map((l) => l.id)).toContain(row.id);
      expect(getLesson(m, row.id).stale).toBeNull();
      expect(getLesson(m, row.id).confirmed).toBeNull();
    } finally {
      rmSync(wrongDir, { recursive: true, force: true });
    }
  });

  it("(MAJOR 4c) a citation whose file is missing under a VALID project root still marks the lesson stale", async () => {
    const checkoutDir = mkdtempSync(join(tmpdir(), "doug-memory-valid-checkout-"));
    mkdirSync(join(checkoutDir, ".doug"), { recursive: true });
    try {
      const row = addLesson(m, { text: "retry flaky calls", kind: "pattern", citation: "src/does-not-exist.mjs:1", source: { agent: "worker" } });
      const result = await recallLessons(m, "retry flaky", { checkoutDir });
      expect(result.checked).toBe(true);
      expect(result.lessons.map((l) => l.id)).not.toContain(row.id);
      expect(getLesson(m, row.id).stale).not.toBeNull();
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("(MAJOR 5) strips the embedding blob and model/dims off returned lessons, keeping only hasVector", async () => {
    const row = addLesson(m, { text: "retry flaky uploads", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, row.id, { model: "fake-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    const result = await recallLessons(m, "retry flaky uploads", { checkoutDir: dir });
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].hasVector).toBe(true);
    expect(result.lessons[0]).not.toHaveProperty("embedding");
    expect(result.lessons[0]).not.toHaveProperty("embedding_model");
    expect(result.lessons[0]).not.toHaveProperty("embedding_dims");
  });

  it("(MINOR 9) treats an unparseable created date as fresh (age 0) rather than silently dropping the lesson", async () => {
    const row = addLesson(m, { text: "retry flaky garbled date", kind: "pattern", source: { agent: "worker" }, created: "not-a-date" });
    const result = await recallLessons(m, "retry flaky garbled", { checkoutDir: dir });
    expect(result.lessons.map((l) => l.id)).toContain(row.id);
  });

  it("(MINOR 10) a **/ glob in scope also matches zero directories", async () => {
    const inScope = addLesson(m, { text: "retry flaky config here", kind: "pattern", scope: ["**/*.mjs"], source: { agent: "worker" } });
    const outScope = addLesson(m, { text: "retry flaky config there", kind: "pattern", scope: ["src/**/*.mjs"], source: { agent: "worker" } });
    const result = await recallLessons(m, "retry flaky config", { checkoutDir: dir, files: ["ab.mjs"] });
    const scores = Object.fromEntries(result.lessons.map((l) => [l.id, l.score]));
    expect(scores[inScope.id]).toBeGreaterThan(scores[outScope.id]);
  });

  it("(MINOR 12) falls back to keyword-only, naming the failure, when the provider is down at query time; the lesson is still returned", async () => {
    const row = addLesson(m, { text: "retry flaky uploads", kind: "pattern", source: { agent: "worker" } });
    setLessonEmbedding(m, row.id, { model: "fake-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    const downProvider = { name: "fake", model: "fake-model", dims: 3, embed: async () => ({ ok: false, reason: "connection refused" }) };
    const result = await recallLessons(m, "retry flaky uploads", { provider: downProvider, checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("connection refused");
    expect(result.lessons.map((l) => l.id)).toContain(row.id);
  });

  it("(MINOR 12) empty and punctuation-only queries return no lessons without throwing", async () => {
    addLesson(m, { text: "retry flaky uploads", kind: "pattern", source: { agent: "worker" } });
    const empty = await recallLessons(m, "", { checkoutDir: dir });
    expect(empty.lessons).toEqual([]);
    const punctuation = await recallLessons(m, "!!! ??? ...", { checkoutDir: dir });
    expect(punctuation.lessons).toEqual([]);
  });

  it("(MINOR 12) truncates to k, backfilling from candidates beyond the initial window after a citation drops one", async () => {
    const checkoutDir = mkdtempSync(join(tmpdir(), "doug-memory-backfill-checkout-"));
    mkdirSync(join(checkoutDir, ".doug"), { recursive: true });
    mkdirSync(join(checkoutDir, "src"), { recursive: true });
    writeFileSync(join(checkoutDir, "src", "a.mjs"), "line one\nline two\nline three\n", "utf8");
    try {
      const bad = addLesson(m, { text: "retry flaky calls alpha", kind: "pattern", citation: 'src/a.mjs:2 "line moved"', source: { agent: "worker" } });
      const good1 = addLesson(m, { text: "retry flaky calls beta", kind: "pattern", source: { agent: "worker" } });
      const good2 = addLesson(m, { text: "retry flaky calls gamma", kind: "pattern", source: { agent: "worker" } });
      const good3 = addLesson(m, { text: "retry flaky calls delta", kind: "pattern", source: { agent: "worker" } });
      const result = await recallLessons(m, "retry flaky calls", { checkoutDir, k: 2 });
      expect(result.lessons).toHaveLength(2);
      const ids = result.lessons.map((l) => l.id);
      expect(ids).not.toContain(bad.id);
      for (const id of ids) expect([good1.id, good2.id, good3.id]).toContain(id);
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });
});

// card recall-fallback-warning (D1/D6): recallLessons returns degraded, plus unvectored/total in hybrid mode.
describe("recallLessons: degraded (card recall-fallback-warning)", () => {
  const vec = (v) => Float32Array.from(v);
  const seed = (text, model = null, dims = 3, extra = {}) => {
    const row = addLesson(m, { text, kind: "pattern", source: { agent: "worker" }, ...extra });
    if (model) setLessonEmbedding(m, row.id, { model, dims, vector: vec(Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0))) });
    return row;
  };
  const failing = (reason, model = "fake-model", dims = 3) => ({ name: "fake", model, dims, embed: async () => ({ ok: false, reason }) });

  beforeEach(() => {
    m = openMemory(dir);
  });

  it("(a) a query-time embed timeout is degraded, with reason 'timeout'", async () => {
    seed("retry flaky uploads", "fake-model");
    const result = await recallLessons(m, "retry flaky uploads", { provider: failing("timeout"), checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("timeout");
    expect(result.degraded).toBe(true);
  });

  it("(b) an unreachable provider is degraded, naming the 'request failed' reason", async () => {
    seed("retry flaky uploads", "fake-model");
    const reason = "request failed: connect ECONNREFUSED 127.0.0.1:1";
    const result = await recallLessons(m, "retry flaky uploads", { provider: failing(reason), checkoutDir: dir });
    expect(result.reason).toBe(reason);
    expect(result.degraded).toBe(true);
  });

  it("(c) provider given, vectors only under another model/dims: degraded, reason names the configured pair", async () => {
    seed("retry flaky uploads", "other-model", 8);
    const result = await recallLessons(m, "retry flaky", { provider: fakeProvider({ model: "fake-model", dims: 3 }), checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no vectors stored for fake-model/3");
    expect(result.degraded).toBe(true);
  });

  it("(d) provider given, no vectors stored at all: degraded", async () => {
    seed("retry flaky uploads");
    const result = await recallLessons(m, "retry flaky", { provider: fakeProvider(), checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no vectors stored for fake-model/3");
    expect(result.degraded).toBe(true);
  });

  it("(e) no provider, but vectors are stored for some model: degraded", async () => {
    seed("retry flaky uploads", "other-model", 8);
    const result = await recallLessons(m, "retry flaky", { checkoutDir: dir });
    expect(result.reason).toBe("no provider configured");
    expect(result.degraded).toBe(true);
  });

  it("(f) no provider, but opts.detectedProvider is given: degraded", async () => {
    seed("retry flaky uploads");
    const result = await recallLessons(m, "retry flaky", { checkoutDir: dir, detectedProvider: "ollama embeddinggemma at http://localhost:11434" });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no provider configured");
    expect(result.degraded).toBe(true);
  });

  it("(g) no provider, nothing detected, no vectors stored: a choice, not degraded", async () => {
    seed("retry flaky uploads");
    const result = await recallLessons(m, "retry flaky", { checkoutDir: dir });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no provider configured");
    expect(result.degraded).toBe(false);
  });

  it("a healthy hybrid recall with every lesson vectored is not degraded and has unvectored 0", async () => {
    seed("retry flaky uploads", "fake-model");
    const result = await recallLessons(m, "retry flaky", { provider: fakeProvider(), checkoutDir: dir });
    expect(result.mode).toBe("hybrid");
    expect(result.degraded).toBe(false);
    expect(result.unvectored).toBe(0);
    expect(result.total).toBe(1);
  });

  it("(h) hybrid with 2 of 5 live lessons unvectored: degraded false, unvectored 2, total 5; stale and superseded rows are not counted", async () => {
    const now = new Date();
    seed("alpha one", "fake-model");
    seed("alpha two", "fake-model");
    seed("alpha three", "fake-model");
    seed("alpha four");
    seed("alpha five");
    // Outside the 30-day window and superseded: neither is a live in-window row.
    seed("alpha ancient", null, 3, { created: new Date(now.getTime() - 90 * 86400000).toISOString() });
    const old = seed("alpha replaced");
    // superseded_by has a foreign key: point at an existing lesson (the first, already counted live).
    const first = m.prepare("SELECT id FROM lessons WHERE text = 'alpha one'").get();
    m.prepare("UPDATE lessons SET superseded_by = ? WHERE id = ?").run(first.id, old.id);
    const result = await recallLessons(m, "alpha", { provider: fakeProvider(), checkoutDir: dir, now });
    expect(result.mode).toBe("hybrid");
    expect(result.degraded).toBe(false);
    expect(result.unvectored).toBe(2);
    expect(result.total).toBe(5);
  });
});

describe("recallLessons: dense ranking (card recall-dense-ranking)", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  const recencyOf = (n) => 0.5 + 0.5 * Math.exp(-n / 90);
  const MODEL = { model: "fake-model", dims: 3 };
  const mk = (id, text, created, vector) => {
    addLesson(m, { id, text, kind: "pattern", source: { agent: "worker" }, created });
    if (vector) setLessonEmbedding(m, id, { ...MODEL, vector: Float32Array.from(vector) });
    return id;
  };
  const recallIds = async (query, opts = {}) => (await recallLessons(m, query, { checkoutDir: dir, now, ...opts })).lessons.map((l) => l.id);

  beforeEach(() => {
    m = openMemory(dir);
  });

  it("A: ranks by cosine x recency, not by RRF fusion, where the two disagree", async () => {
    // Query vector [1,0,0]; all three lessons are 10 days old, so recency is a common factor.
    // a1 "alpha beta gamma": bm25 rank 1, cosine 0.6 (vector rank 3)
    // a2 "alpha delta":      bm25 rank 2, cosine 0.8 (vector rank 2)
    // a3 "unrelated zzz":    no bm25 hit,  cosine 1.0 (vector rank 1)
    // RRF (1/(60+rank) per side): a1 = 1/61 + 1/63 = 0.0323, a2 = 1/62 + 1/62 = 0.0323, a3 = 1/61 = 0.0164;
    //   the keyword hits a1/a2 both outrank a3, so RRF never puts a3 first.
    // cosine x recency: a3 (1.0) > a2 (0.8) > a1 (0.6), so the order is [a3, a2, a1].
    const created = daysAgo(10);
    const a1 = mk("a1", "alpha beta gamma", created, [0.6, 0.8, 0]);
    const a2 = mk("a2", "alpha delta", created, [0.8, 0.6, 0]);
    const a3 = mk("a3", "unrelated zzz", created, [1, 0, 0]);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const result = await recallLessons(m, "alpha beta", { provider, checkoutDir: dir, now });
    expect(result.lessons.map((l) => l.id)).toEqual([a3, a2, a1]);
    const r = recencyOf(10);
    expect(result.lessons[0].score).toBeCloseTo(1.0 * r, 5);
    expect(result.lessons[1].score).toBeCloseTo(0.8 * r, 5);
    expect(result.lessons[2].score).toBeCloseTo(0.6 * r, 5);
  });

  it("B: recency can reorder lessons that cosine alone would order the other way", async () => {
    // old: cosine 0.95, 29 days old -> 0.95 * (0.5 + 0.5*exp(-29/90)) = 0.95 * 0.8623 = 0.819
    // new: cosine 0.90, 0 days old  -> 0.90 * 1.0 = 0.900
    // cosine alone: old first; cosine x recency: new first. (old is also the only bm25 hit for "zzz", so RRF x
    // recency = (1/61 + 1/61) * 0.8623 = 0.0283 vs fresh 1/62 = 0.0161 keeps old first: fusion disagrees too.)
    const old = mk("old", "zzz one", daysAgo(29), [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]);
    const fresh = mk("fresh", "other two", daysAgo(0), [0.9, Math.sqrt(1 - 0.81), 0]);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const ids = await recallIds("zzz", { provider });
    expect(ids).toEqual([fresh, old]);
  });

  it("C: breaks an exact score tie by lesson id ascending, whatever the insertion order", async () => {
    const created = daysAgo(5);
    const v = [1, 0, 0];
    mk("t-c", "tie one", created, v);
    mk("t-a", "tie two", created, v);
    mk("t-b", "tie three", created, v);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    expect(await recallIds("qqq", { provider })).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("D: with no provider, the order is BM25 x recency; with a provider but no vectors for its model/dims, it is keyword-only in the same order", async () => {
    const created = daysAgo(3);
    const l1 = mk("d1", "flaky test needs a retry policy", created);
    const l2 = mk("d2", "the test suite", created);
    const none = await recallLessons(m, "flaky test retry", { checkoutDir: dir, now });
    expect(none.mode).toBe("keyword-only");
    expect(none.lessons.map((l) => l.id)).toEqual([l1, l2]);

    // vectors exist, but under another model: the unmatched lesson stays out, BM25 order stays.
    setLessonEmbedding(m, l1, { model: "other-model", dims: 3, vector: Float32Array.from([0, 1, 0]) });
    setLessonEmbedding(m, l2, { model: "other-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    mk("d3", "unrelated zzz", created, null);
    setLessonEmbedding(m, "d3", { model: "other-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const other = await recallLessons(m, "flaky test retry", { provider, checkoutDir: dir, now });
    expect(other.mode).toBe("keyword-only");
    expect(other.reason).toBe("no vectors stored for fake-model/3");
    expect(other.lessons.map((l) => l.id)).toEqual([l1, l2]);
  });

  it("E: ranks every vectored live lesson by cosine (BM25 hit or not), then appends BM25 hits with no vector in BM25 order, even after a negative-cosine vectored lesson", async () => {
    // Query "flaky retry". Vectored lessons: v1 (no keyword match, cosine 0.9), v2 (keyword match, cosine 0.2),
    // v3 (no keyword match, cosine -0.5). Unvectored BM25 hits: u1 (both tokens) then u2 (one token), both brand new.
    // Scores (recency of 25 days = 0.878, of 0 days = 1): v1 = 0.9 * 0.878 = 0.79, v2 = 0.2 * 0.878 = 0.18,
    // v3 = -0.5 * 0.878 = -0.44; u1 = 1/61 * 1 = 0.0164, u2 = 1/62 * 1 = 0.0161. A merged sort by score would
    // put v3 (negative) after u1/u2; "append after" keeps it ahead of them.
    const v1 = mk("v1", "unrelated cache note", daysAgo(25), [0.9, Math.sqrt(1 - 0.81), 0]);
    const v2 = mk("v2", "flaky retry policy", daysAgo(25), [0.2, Math.sqrt(1 - 0.04), 0]);
    const v3 = mk("v3", "unrelated queue note", daysAgo(25), [-0.5, Math.sqrt(1 - 0.25), 0]);
    const u1 = mk("u1", "flaky retry", daysAgo(0), null);
    const u2 = mk("u2", "flaky handling only", daysAgo(0), null);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const ids = await recallIds("flaky retry", { provider });
    expect(ids).toEqual([v1, v2, v3, u1, u2]);
  });

  it("F: orders the appended unvectored tail by BM25 rank, not by weighted score", async () => {
    // u1 matches both tokens (BM25 rank 1) but is 29 days old: 1/61 * 0.862 = 0.0141. u2 matches one token
    // (rank 2) and is new: 1/62 * 1 = 0.0161. A weighted-score sort of the tail gives [u2, u1]; BM25 order is [u1, u2].
    const v1 = mk("v1", "unrelated cache note", daysAgo(5), [0.9, Math.sqrt(1 - 0.81), 0]);
    const u1 = mk("u1", "flaky retry", daysAgo(29), null);
    const u2 = mk("u2", "flaky handling only", daysAgo(0), null);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    expect(await recallIds("flaky retry", { provider })).toEqual([v1, u1, u2]);
  });

  it("G: dense mode applies the x1.5 scope boost when files match a lesson's scope, flipping the order", async () => {
    // Same age. s-hit scope matches the file, cosine 0.6 -> 0.6 * 1.5 = 0.9 (x recency). s-miss scope does not,
    // cosine 0.8 -> 0.8. Without the boost s-miss would be first.
    const created = daysAgo(10);
    addLesson(m, { id: "s-hit", text: "alpha one", kind: "pattern", scope: ["src/a.mjs"], source: { agent: "worker" }, created });
    setLessonEmbedding(m, "s-hit", { ...MODEL, vector: Float32Array.from([0.6, 0.8, 0]) });
    addLesson(m, { id: "s-miss", text: "beta two", kind: "pattern", scope: ["docs/x.md"], source: { agent: "worker" }, created });
    setLessonEmbedding(m, "s-miss", { ...MODEL, vector: Float32Array.from([0.8, 0.6, 0]) });
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    expect(await recallIds("zzz", { provider, files: ["src/a.mjs"] })).toEqual(["s-hit", "s-miss"]);
    expect(await recallIds("zzz", { provider })).toEqual(["s-miss", "s-hit"]);
  });

  it("H: dense recency takes its age from confirmed when set, else created", async () => {
    // h1 was created 200 days ago but confirmed today: recency 1.0, score 0.8. h2 was created 20 days ago, never
    // confirmed: recency 0.90, score 0.85 * 0.90 = 0.765. Aging h1 from created (recency 0.555 -> 0.444) puts h2 first.
    mk("h1", "alpha one", daysAgo(200), [0.8, 0.6, 0]);
    m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(daysAgo(0), "h1");
    mk("h2", "beta two", daysAgo(20), [0.85, Math.sqrt(1 - 0.7225), 0]);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    expect(await recallIds("zzz", { provider })).toEqual(["h1", "h2"]);
  });
});

describe("topLessons (card memory-every-session)", () => {
  const NOW = new Date("2026-10-07T12:00:00.000Z");
  const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
  const add = (text, extra = {}) => {
    const { helpful = 0, harmful = 0, ...opts } = extra;
    const row = addLesson(m, { text, kind: "pattern", source: { agent: "worker" }, created: daysAgo(2), ...opts });
    m.prepare("UPDATE lessons SET helpful = ?, harmful = ? WHERE id = ?").run(helpful, harmful, row.id);
    return row;
  };
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("orders by helpful minus harmful desc, then confirmed-or-created desc, then id", () => {
    const low = add("low score lesson", { helpful: 1 });
    const net = add("net two lesson", { helpful: 5, harmful: 3 });
    const top = add("top score lesson", { helpful: 4 });
    const older = add("tie older lesson", { created: daysAgo(10) });
    const newer = add("tie newer lesson", { created: daysAgo(1) });
    const confirmed = add("tie confirmed lesson", { created: daysAgo(20) });
    m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(daysAgo(0), confirmed.id);
    const ids = topLessons(m, { k: 10, now: NOW }).map((l) => l.id);
    expect(ids.slice(0, 3)).toEqual([top.id, net.id, low.id]);
    expect(ids.slice(3)).toEqual([confirmed.id, newer.id, older.id]);
  });

  it("breaks a full tie by id ascending", () => {
    const a = add("alpha tie lesson", { id: "lesson-b" });
    const b = add("beta tie lesson", { id: "lesson-a" });
    expect(topLessons(m, { now: NOW }).map((l) => l.id)).toEqual([b.id, a.id]);
  });

  it("honours k (default 5) and returns [] on an empty store", () => {
    expect(topLessons(m, { now: NOW })).toEqual([]);
    for (let i = 0; i < 8; i++) add(`lesson number ${i}`, { helpful: i });
    expect(topLessons(m, { now: NOW })).toHaveLength(5);
    expect(topLessons(m, { k: 2, now: NOW })).toHaveLength(2);
  });

  it("excludes stale, superseded, and out-of-window lessons", () => {
    const keep = add("the one live lesson", { helpful: 0 });
    const stale = add("stale lesson", { helpful: 9 });
    m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(daysAgo(0), stale.id);
    const old = add("superseded lesson", { helpful: 9 });
    const replacement = add("its replacement", { helpful: 0 });
    supersedeLesson(m, old.id, replacement.id);
    const outOfWindow = add("ancient lesson", { helpful: 9, created: daysAgo(90) });
    const ids = topLessons(m, { k: 10, now: NOW }).map((l) => l.id);
    expect(ids).toContain(keep.id);
    expect(ids).toContain(replacement.id);
    for (const gone of [stale.id, old.id, outOfWindow.id]) expect(ids).not.toContain(gone);
    // a confirmed date inside the window brings an old lesson back
    m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(daysAgo(1), outOfWindow.id);
    expect(topLessons(m, { k: 10, now: NOW }).map((l) => l.id)).toContain(outOfWindow.id);
  });
});

describe("renderLessons (card memory-every-session: moved to lib/memory.mjs)", () => {
  it("renders `- [id] text (citation|kind)` lines and returns the rendered ids", () => {
    const r = renderLessons([
      { id: "L1", text: "first lesson", citation: "path:1", kind: "pattern" },
      { id: "L2", text: "second lesson", citation: null, kind: "pitfall" },
    ]);
    expect(r.text).toBe("- [L1] first lesson (path:1)\n- [L2] second lesson (pitfall)");
    expect(r.ids).toEqual(["L1", "L2"]);
  });

  it("returns { text: null, ids: [] } for nothing and for a non-array", () => {
    expect(renderLessons([])).toEqual({ text: null, ids: [] });
    expect(renderLessons(undefined)).toEqual({ text: null, ids: [] });
  });

  it("cuts a long lesson near 400 chars with an ellipsis, and skips (not stops at) a line that would overflow 2000", () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const r = renderLessons([{ id: "L1", text: long, citation: null, kind: "pattern" }]);
    expect(r.text).toContain("…");
    expect(r.text.length).toBeLessThan(450);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `M${i}`, text: long, citation: null, kind: "pattern" }));
    many.push({ id: "short", text: "tiny", citation: null, kind: "pattern" });
    const capped = renderLessons(many);
    expect(capped.text.length).toBeLessThanOrEqual(2000);
    expect(capped.ids.length).toBeLessThan(12);
    expect(capped.ids).toContain("short");
    expect(capped.text.split("\n")).toHaveLength(capped.ids.length);
  });
});

describe("unstaleLesson", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  it("(MAJOR 4b) clears stale — allowed by the trigger since stale is not a protected column", () => {
    const row = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run("2026-09-10T00:00:00.000Z", row.id);
    expect(getLesson(m, row.id).stale).not.toBeNull();
    const updated = unstaleLesson(m, row.id);
    expect(updated.stale).toBeNull();
    expect(getLesson(m, row.id).stale).toBeNull();
  });

  it("throws naming the id when the lesson does not exist", () => {
    expect(() => unstaleLesson(m, "does-not-exist")).toThrow(/does-not-exist/);
  });
});

// A report shaped for runReflect: "clean-task" verified true on its first pass (a valid pattern task), "blocked-
// task" carries a ledger block "F1" that the tests classify real (a valid pitfall task), "neither-task" verified
// false with no real block (memoryUsed on it must never be touched at all).
function buildReflectReport() {
  return {
    plan: "reflect-fixture",
    ok: true,
    levels: [
      {
        index: 0,
        tasks: [
          {
            id: "clean-task",
            verified: true,
            passes: 1,
            stopReason: null,
            card: "card-1",
            commit: "c1c1c1c",
            reviewIssues: [],
            verifierFindings: [],
            memoryUsed: [],
          },
          {
            id: "blocked-task",
            verified: true,
            passes: 2,
            stopReason: null,
            card: "card-1",
            commit: "c2c2c2c",
            reviewIssues: [],
            verifierFindings: [],
            memoryUsed: [],
            attempts: [{ pass: 1, newFindings: ["F1"] }, { pass: 2 }],
            ledger: [{ id: "F1", stage: "adversary", severity: "blocker", status: "fixed", description: "a real defect a user would hit" }],
          },
          {
            id: "neither-task",
            verified: false,
            passes: 2,
            stopReason: "budget",
            card: "card-1",
            commit: "c3c3c3c",
            reviewIssues: [],
            verifierFindings: [],
            memoryUsed: ["lesson-untouched"],
          },
        ],
      },
    ],
  };
}

const REFLECT_CLASSES = [{ id: "F1", class: "real", reason: "confirmed by fix" }];
const noopPropose = async () => ({ lessons: [], sessionId: null, totalCostUsd: null });

describe("buildReflectPrompt", () => {
  it("includes the rules, per-task facts and blocks, memoryUsed, and existing lessons", () => {
    const report = buildReflectReport();
    const blocks = classifyBlocks(report, REFLECT_CLASSES);
    const existing = [{ id: "abc123", kind: "pattern", text: "an existing lesson nobody should re-propose" }];
    const prompt = buildReflectPrompt(report, { blocks, plan: { tasks: [{ id: "clean-task", files: ["a.mjs"] }] }, existingLessons: existing });
    expect(prompt).toContain('kind "pitfall" is valid only for a task that has at least one block classed real');
    expect(prompt).toContain('kind "pattern" is valid only for a task that verified true on its first pass');
    expect(prompt).toContain("clean-task");
    expect(prompt).toContain("owned files: a.mjs");
    expect(prompt).toContain("report:blocked-task/F1 class=real");
    expect(prompt).toContain("memoryUsed: none");
    expect(prompt).toContain("an existing lesson nobody should re-propose");
  });

  it("carries partial=<true|false> per task and the no-blame rule for a partial task (card worker-context-handoff)", () => {
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "partial-task", verified: false, passes: 1, stopReason: "partial after resume: still broken", partial: true, reviewIssues: [], verifierFindings: [], memoryUsed: [] },
        { id: "done-task", verified: true, passes: 1, stopReason: null, reviewIssues: [], verifierFindings: [], memoryUsed: [] },
      ] }],
    };
    const prompt = buildReflectPrompt(report, { blocks: [], plan: null, existingLessons: [] });
    expect(prompt).toContain("partial-task: verified=false passes=1 stopReason=partial after resume: still broken partial=true");
    expect(prompt).toContain("done-task: verified=true passes=1 stopReason=null partial=false");
    expect(prompt).toContain("a task marked partial=true below ran out of context, not verification; propose no lesson that blames its code or its tests for that");
  });

  it("without report.hand the prompt is byte-identical to the pre-hand output (card memory-every-session)", () => {
    const report = { levels: [{ index: 0, tasks: [{ id: "t1", verified: true, passes: 1, stopReason: null, reviewIssues: [], verifierFindings: [], memoryUsed: ["abc"] }] }] };
    const prompt = buildReflectPrompt(report, { blocks: [], plan: null, existingLessons: [{ id: "abc", kind: "pattern", text: "a lesson", created: "2026-01-01T00:00:00.000Z" }] });
    const legacy = "You are proposing at most 3 lessons for a coding harness's memory store, from one workflow report.\nEvery rule below is enforced again in code after you answer, so follow it exactly:\n- kind \"pitfall\" is valid only for a task that has at least one block classed real below.\n- kind \"pattern\" is valid only for a task that verified true on its first pass (passes 1).\n- citation must be exactly one of: \"report:<task>/<block-id>\" naming a block below, \"report:<task>\" naming a task below, or \"path:line\" / 'path:line \"quoted text\"' naming a real line in this checkout.\n- notDerivableBecause must say why the lesson is not something a reader could already get by reading the code; never restate a fact already sitting verbatim in a file.\n- never propose a lesson whose text is already covered by one of the existing lessons listed below.\n- supersedes is optional: set it to the id of one existing lesson listed below when your new lesson contradicts or corrects that lesson. The old lesson is then retired in favour of yours.\n- repeats is optional: set it to the id of one existing lesson listed below when your lesson says the same thing as that lesson. Nothing new is written and that lesson's seen count rises. Never set both repeats and supersedes.\n- propose at most 3 lessons; an empty list is a perfectly good answer when nothing here is worth remembering.\n- a task marked partial=true below ran out of context, not verification; propose no lesson that blames its code or its tests for that.\n\nTasks in this report:\n- t1: verified=true passes=1 stopReason=null partial=false\n  memoryUsed: abc\n\nExisting lessons (never propose a near-duplicate of one of these; name one in repeats or supersedes when it applies):\n- abc (pattern): a lesson\n";
    expect(prompt).toBe(legacy);
    expect(prompt).not.toContain("Hand-track material");
  });

  it("with report.hand it appends the hand section: files capped at 4000 chars with a truncation marker, 16000 in total, the note last (card memory-every-session)", () => {
    const S = "\u00a7";
    const handReport = (hand) => ({
      track: "hand",
      levels: [{ index: 0, tasks: [{ id: "c1", verified: true, passes: 1, stopReason: null, reviewIssues: [], verifierFindings: [], memoryUsed: [] }] }],
      hand,
    });
    const opts = { blocks: [], plan: null, existingLessons: [] };
    const base = buildReflectPrompt({ levels: handReport({}).levels }, opts);

    const small = buildReflectPrompt(handReport({ briefs: [{ name: "1-coder.md", text: "BRIEF-TEXT" }], reviews: [{ name: "1.md", text: "REVIEW-TEXT" }], note: "NOTE-TEXT" }), opts);
    const header = "Hand-track material (briefs, reviewer reports, landing note; the rules above still apply, cite report:<card> or report:<card>/R<n>):";
    expect(small.startsWith(base)).toBe(true);
    expect(small).toContain(header);
    expect(small.indexOf(header)).toBeGreaterThanOrEqual(base.length - 1);
    expect(small).toContain("BRIEF-TEXT");
    expect(small).toContain("REVIEW-TEXT");
    expect(small.indexOf("NOTE-TEXT")).toBeGreaterThan(small.indexOf("REVIEW-TEXT"));
    expect(small.indexOf("NOTE-TEXT")).toBeGreaterThan(small.indexOf("BRIEF-TEXT"));
    expect(small).not.toContain("\u2026[truncated]");

    const exactly = buildReflectPrompt(handReport({ briefs: [{ name: "b.md", text: S.repeat(4000) }] }), opts);
    expect(exactly).toContain(S.repeat(4000));
    expect(exactly).not.toContain("\u2026[truncated]");

    const cut = buildReflectPrompt(handReport({ briefs: [{ name: "b.md", text: S.repeat(4001) }] }), opts);
    expect(cut).toContain(S.repeat(4000) + "\u2026[truncated]");
    expect(cut).not.toContain(S.repeat(4001));

    const many = buildReflectPrompt(
      handReport({
        briefs: [1, 2, 3].map((n) => ({ name: `${n}-coder.md`, text: S.repeat(4000) })),
        reviews: [1, 2, 3].map((n) => ({ name: `${n}.md`, text: S.repeat(4000) })),
        note: "TAIL-NOTE",
      }),
      opts
    );
    expect(many.split(S).length - 1).toBeLessThanOrEqual(16000);
    expect(many.split(S).length - 1).toBeGreaterThanOrEqual(12000);
    expect(many.endsWith("TAIL-NOTE\n") || many.trimEnd().endsWith("TAIL-NOTE")).toBe(true);
  });

  it("REFLECT_SCHEMA requires lessons and REFLECT_DUPLICATE_JACCARD is 0.6", () => {
    expect(REFLECT_SCHEMA.required).toEqual(["lessons"]);
    expect(REFLECT_SCHEMA.properties.lessons.items.required).toEqual(["kind", "text", "citation", "task", "notDerivableBecause"]);
    expect(REFLECT_DUPLICATE_JACCARD).toBe(0.6);
  });

  it("M13 (card memory-reflect-supersede): the schema offers optional string fields repeats and supersedes, and the prompt carries a rule line for each", () => {
    const items = REFLECT_SCHEMA.properties.lessons.items;
    expect(items.properties.repeats.type).toBe("string");
    expect(items.properties.supersedes.type).toBe("string");
    expect(items.required).not.toContain("repeats");
    expect(items.required).not.toContain("supersedes");
    const report = buildReflectReport();
    const prompt = buildReflectPrompt(report, { blocks: classifyBlocks(report, REFLECT_CLASSES), plan: null, existingLessons: [{ id: "abc123", kind: "pattern", text: "x" }] });
    const lines = prompt.split("\n");
    expect(lines.some((l) => l.includes("supersedes") && /contradict|correct/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("repeats") && /same/.test(l))).toBe(true);
  });

  it("(minor 9) caps the shown existing lessons at REFLECT_PROMPT_LESSON_CAP, keeping the most recently created/confirmed and saying the list is capped", () => {
    expect(REFLECT_PROMPT_LESSON_CAP).toBe(200);
    const report = buildReflectReport();
    const blocks = classifyBlocks(report, REFLECT_CLASSES);
    const total = REFLECT_PROMPT_LESSON_CAP + 5;
    // Oldest first: index 0 is the oldest (created day 0), the last is the most recent (created day `total`).
    const existing = Array.from({ length: total }, (_, i) => ({
      id: `lesson-${String(i).padStart(4, "0")}`,
      kind: "pattern",
      text: `synthetic lesson number ${i}`,
      created: new Date(2026, 0, 1 + i).toISOString(),
      confirmed: null,
    }));
    const prompt = buildReflectPrompt(report, { blocks, plan: null, existingLessons: existing });
    expect(prompt).toContain(`showing the ${REFLECT_PROMPT_LESSON_CAP} most recently created/confirmed of ${total} total`);
    // The 5 oldest (indices 0-4) are dropped; the most recent one (index total-1) and the cutoff (index 5, the
    // 200th most recent) are both kept.
    expect(prompt).not.toContain("synthetic lesson number 0\n");
    expect(prompt).not.toContain("synthetic lesson number 4\n");
    expect(prompt).toContain(`synthetic lesson number ${total - 1}`);
    expect(prompt).toContain("synthetic lesson number 5");
    // Count by the fixed-width padded id (`- lesson-0005 `), never by the bare number text: a bare number like
    // "number 1" is a substring prefix of "number 10", "number 100", etc., which would over-count.
    const shownCount = existing.filter((l) => prompt.includes(`- ${l.id} (`)).length;
    expect(shownCount).toBe(REFLECT_PROMPT_LESSON_CAP);
  });

  it("does not print a cap note when existing lessons are at or under the cap", () => {
    const report = buildReflectReport();
    const blocks = classifyBlocks(report, REFLECT_CLASSES);
    const existing = [{ id: "one", kind: "pattern", text: "a single existing lesson", created: "2026-01-01T00:00:00.000Z" }];
    const prompt = buildReflectPrompt(report, { blocks, plan: null, existingLessons: existing });
    expect(prompt).not.toContain("most recently created/confirmed");
    expect(prompt).toContain("a single existing lesson");
  });
});

describe("runReflect: counters (A)", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  // Changed (card reflect-harmful-irrelevant-lessons): this test pinned "a real block bumps harmful on every used
  // lesson". A real block alone now bumps nothing, and still earns no helpful (C1, "real wins"); only an explicit
  // `harmful` id bumps harmful. The assertions on harmfulLesson changed from harmful 1 to harmful 0.
  it("a real block alone bumps nothing and earns no helpful (real wins), a first-verified task's used lessons get helpful, an unknown id is reported not thrown, and a task with neither touches nothing", async () => {
    const helpfulLesson = addLesson(m, { text: "a pattern worth keeping around", kind: "pattern", source: { agent: "worker" } });
    const harmfulLesson = addLesson(m, { text: "a pitfall that bit us badly", kind: "pitfall", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[0].memoryUsed = [helpfulLesson.id, "lesson-missing"];
    report.levels[0].tasks[1].memoryUsed = [harmfulLesson.id];

    const result = await runReflect(m, report, { reportHash: "hash-counters-1", dir, classes: REFLECT_CLASSES, propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.counters.helpful).toEqual([helpfulLesson.id]);
    expect(result.counters.harmful).toEqual([]);
    expect(result.counters.unknown).toEqual(["lesson-missing"]);
    expect(getLesson(m, helpfulLesson.id).helpful).toBe(1);
    expect(getLesson(m, helpfulLesson.id).harmful).toBe(0);
    expect(getLesson(m, harmfulLesson.id).harmful).toBe(0);
    expect(getLesson(m, harmfulLesson.id).helpful).toBe(0);
    // neither-task's memoryUsed (an id naming no lesson) never shows up anywhere: nothing bumped, nothing unknown.
    expect(result.counters.helpful).not.toContain("lesson-untouched");
    expect(result.counters.harmful).not.toContain("lesson-untouched");
    expect(result.counters.unknown).not.toContain("lesson-untouched");
  });

  // Card reflect-harmful-irrelevant-lessons: harmful is an explicit mark, never inferred from a real block.
  it("T1: a real block unrelated to a recalled lesson leaves its harmful and helpful counts unchanged", async () => {
    const L = addLesson(m, { text: "an unrelated recalled lesson about releases", kind: "pattern", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[1].memoryUsed = [L.id];
    const result = await runReflect(m, report, { reportHash: "hash-harm-t1", dir, classes: REFLECT_CLASSES, propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.counters.harmful).toEqual([]);
    expect(result.counters.helpful).toEqual([]);
    expect(getLesson(m, L.id).harmful).toBe(0);
    expect(getLesson(m, L.id).helpful).toBe(0);
  });

  it("T2: harmful [L] bumps L once and leaves a second used lesson K that is not named unchanged", async () => {
    const L = addLesson(m, { text: "the lesson that misled the agent", kind: "pitfall", source: { agent: "worker" } });
    const K = addLesson(m, { text: "a lesson that was merely recalled", kind: "pattern", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[1].memoryUsed = [L.id, K.id];
    const result = await runReflect(m, report, { reportHash: "hash-harm-t2", dir, classes: REFLECT_CLASSES, harmful: [L.id], propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.counters.harmful).toEqual([L.id]);
    expect(getLesson(m, L.id).harmful).toBe(1);
    expect(getLesson(m, L.id).helpful).toBe(0);
    expect(getLesson(m, K.id).harmful).toBe(0);
    expect(getLesson(m, K.id).helpful).toBe(0);
  });

  it("T3: a harmful id that is in no task's memoryUsed refuses before any write, naming the id and the memoryUsed ids", async () => {
    const L = addLesson(m, { text: "a recalled lesson", kind: "pattern", source: { agent: "worker" } });
    const other = addLesson(m, { text: "a lesson nobody recalled", kind: "pattern", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[0].memoryUsed = [L.id];
    report.levels[0].tasks[1].memoryUsed = [L.id];
    let err;
    try {
      await runReflect(m, report, { reportHash: "hash-harm-t3", dir, classes: REFLECT_CLASSES, harmful: [L.id, other.id], propose: noopPropose });
    } catch (e) {
      err = e;
    }
    expect(err, "runReflect must throw").toBeTruthy();
    expect(err.message).toContain(other.id);
    expect(err.message).toContain(L.id);
    expect(m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-harm-t3")).toBeUndefined();
    expect(getLesson(m, L.id).harmful).toBe(0);
    expect(getLesson(m, L.id).helpful).toBe(0);
    expect(getLesson(m, other.id).harmful).toBe(0);
  });

  it("T4: an id named twice bumps once; a named id on a verified task gets harmful and no helpful while its unnamed sibling gets helpful", async () => {
    const L = addLesson(m, { text: "the lesson that misled the agent", kind: "pitfall", source: { agent: "worker" } });
    const K = addLesson(m, { text: "a lesson that helped", kind: "pattern", source: { agent: "worker" } });
    const twice = buildReflectReport();
    twice.levels[0].tasks[1].memoryUsed = [L.id];
    await runReflect(m, twice, { reportHash: "hash-harm-t4a", dir, classes: REFLECT_CLASSES, harmful: [L.id, L.id], propose: noopPropose });
    expect(getLesson(m, L.id).harmful).toBe(1);

    const verified = buildReflectReport();
    verified.levels[0].tasks[0].memoryUsed = [L.id, K.id];
    const result = await runReflect(m, verified, { reportHash: "hash-harm-t4b", dir, classes: [], harmful: [L.id], propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.counters.harmful).toEqual([L.id]);
    expect(result.counters.helpful).toEqual([K.id]);
    expect(getLesson(m, L.id).harmful).toBe(2);
    expect(getLesson(m, L.id).helpful).toBe(0);
    expect(getLesson(m, K.id).helpful).toBe(1);
    expect(getLesson(m, K.id).harmful).toBe(0);
  });

  it("is idempotent on report_hash: a second reflect on the same report does nothing and returns the stored row", async () => {
    const report = buildReflectReport();
    const first = await runReflect(m, report, { reportHash: "hash-idem-1", dir, classes: REFLECT_CLASSES, propose: noopPropose });
    expect(first.ok).toBe(true);
    const second = await runReflect(m, report, {
      reportHash: "hash-idem-1",
      dir,
      classes: REFLECT_CLASSES,
      propose: async () => {
        throw new Error("must not be called on an already-reflected report");
      },
    });
    expect(second.alreadyReflected).toBe(true);
    expect(second.row.report_hash).toBe("hash-idem-1");
    expect(second.row.counters).toEqual(first.counters);
  });

  it("on a propose failure, still applies and commits the counters, records the rejection, and never throws", async () => {
    const harmfulLesson = addLesson(m, { text: "a pitfall that bit us badly", kind: "pitfall", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[1].memoryUsed = [harmfulLesson.id];
    // Changed (card reflect-harmful-irrelevant-lessons): the counter now needs an explicit harmful id, not a bare real block.
    const result = await runReflect(m, report, {
      reportHash: "hash-fail-1",
      dir,
      classes: REFLECT_CLASSES,
      harmful: [harmfulLesson.id],
      propose: async () => {
        throw new Error("claude printed no parseable JSON: boom");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/boom/);
    expect(result.rejected).toEqual([{ text: null, reason: expect.stringContaining("boom") }]);
    expect(getLesson(m, harmfulLesson.id).harmful).toBe(1);
    const stored = m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-fail-1");
    expect(stored).toBeTruthy();
    expect(stored.proposed).toBeNull();
  });

  it("--dry-run applies nothing (no counters, no reflections row, no appends) but still runs the LLM pass and reports what would happen", async () => {
    const helpfulLesson = addLesson(m, { text: "a pattern worth keeping around", kind: "pattern", source: { agent: "worker" } });
    const report = buildReflectReport();
    const misled = addLesson(m, { text: "a lesson named harmful in a dry run", kind: "pitfall", source: { agent: "worker" } });
    report.levels[0].tasks[0].memoryUsed = [helpfulLesson.id, misled.id];
    const result = await runReflect(m, report, { reportHash: "hash-dry-1", dir, classes: REFLECT_CLASSES, dryRun: true, harmful: [misled.id], propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.counters.helpful).toEqual([helpfulLesson.id]);
    expect(result.counters.harmful).toEqual([misled.id]);
    expect(getLesson(m, helpfulLesson.id).helpful).toBe(0);
    expect(getLesson(m, misled.id).harmful).toBe(0);
    expect(m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-dry-1")).toBeUndefined();
    expect(listLessons(m)).toHaveLength(2);
  });

  it("dryRun with no propose returns ok with proposed null, usd 0 and the counters, writing nothing; a non-dry call with no propose still rejects", async () => {
    const helpfulLesson = addLesson(m, { text: "a pattern worth keeping around", kind: "pattern", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[0].memoryUsed = [helpfulLesson.id];
    const result = await runReflect(m, report, { reportHash: "hash-dry-nopropose", dir, classes: REFLECT_CLASSES, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.proposed).toBeNull();
    expect(result.usd).toBe(0);
    expect(result.appended).toEqual([]);
    expect(result.counters.helpful).toEqual([helpfulLesson.id]);
    expect(getLesson(m, helpfulLesson.id).helpful).toBe(0);
    expect(m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-dry-nopropose")).toBeUndefined();
    expect(listLessons(m)).toHaveLength(1);
    await expect(runReflect(m, report, { reportHash: "hash-nodry-nopropose", dir, classes: REFLECT_CLASSES })).rejects.toThrow(/requires a propose function/);
  });

  // Added for reviewer gaps (card reflect-harmful-irrelevant-lessons): the recalled-ids check is a union over levels.
  it("accepts a harmful id that is in a level-1 task's memoryUsed only", async () => {
    const L = addLesson(m, { text: "a lesson recalled only in the second level", kind: "pitfall", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels.push({
      index: 1,
      tasks: [{ id: "later-task", verified: true, passes: 1, stopReason: null, reviewIssues: [], verifierFindings: [], memoryUsed: [L.id] }],
    });
    const result = await runReflect(m, report, { reportHash: "hash-harm-lv2", dir, classes: REFLECT_CLASSES, harmful: [L.id], propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.counters.harmful).toEqual([L.id]);
    expect(getLesson(m, L.id).harmful).toBe(1);
  });

  it("throws on an --adversary id the report lacks, the same way record fails, before any write", async () => {
    const report = buildReflectReport();
    await expect(
      runReflect(m, report, { reportHash: "hash-badadv-1", dir, classes: [{ id: "NOPE", class: "real", reason: "x" }], propose: noopPropose })
    ).rejects.toThrow(/no adversary block named NOPE/);
    expect(m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-badadv-1")).toBeUndefined();
  });

  it("D: falls back to the envelope's total_cost_usd (usd_source 'claude') with no transcript, and null/null with neither", async () => {
    const report = buildReflectReport();
    const noSuchClaudeDir = join(dir, "no-such-claude-dir");
    const withEnvelopeCost = await runReflect(m, report, {
      reportHash: "hash-cost-1",
      dir,
      classes: REFLECT_CLASSES,
      claudeDir: noSuchClaudeDir,
      propose: async () => ({ lessons: [], sessionId: "sess-nope", totalCostUsd: 0.1234 }),
    });
    expect(withEnvelopeCost.usd).toBeCloseTo(0.1234, 6);
    expect(withEnvelopeCost.usdSource).toBe("claude");

    const withNothing = await runReflect(m, report, {
      reportHash: "hash-cost-2",
      dir,
      classes: REFLECT_CLASSES,
      claudeDir: noSuchClaudeDir,
      propose: async () => ({ lessons: [], sessionId: null, totalCostUsd: null }),
    });
    expect(withNothing.usd).toBeNull();
    expect(withNothing.usdSource).toBeNull();
  });
});

describe("runReflect: proposal filters (C)", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  function reflectWithProposals(proposals, reportHash) {
    const report = buildReflectReport();
    return runReflect(m, report, {
      reportHash,
      dir,
      classes: REFLECT_CLASSES,
      propose: async () => ({ lessons: proposals, sessionId: null, totalCostUsd: null }),
    });
  }

  it("C.1: a pitfall needs a real-classed block on its task; a pattern needs a first-pass verified task", async () => {
    const badPitfall = { kind: "pitfall", text: "Never merge without running the full test suite first", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not in the code" };
    const goodPitfall = { kind: "pitfall", text: "The adversary needs owned files listed exactly or retriable checks fail silently", citation: "report:blocked-task/F1", task: "blocked-task", notDerivableBecause: "not in the code" };
    const badPattern = { kind: "pattern", text: "Retries do not help flaky network mocks in this harness at all", citation: "report:blocked-task", task: "blocked-task", notDerivableBecause: "not in the code" };
    const goodPattern = { kind: "pattern", text: "A clean single pass task confirms the spec hash before verifying", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not in the code" };

    const result = await reflectWithProposals([badPitfall, goodPitfall, badPattern, goodPattern], "hash-filter-c1");
    const badPitfallRejection = result.rejected.find((r) => r.text === badPitfall.text);
    expect(badPitfallRejection).toBeDefined();
    expect(badPitfallRejection.reason).toMatch(/no block classed real/);
    const badPatternRejection = result.rejected.find((r) => r.text === badPattern.text);
    expect(badPatternRejection).toBeDefined();
    expect(badPatternRejection.reason).toMatch(/did not verify on its first pass/);
    expect(result.appended).toHaveLength(2);
  });

  it("C.2: citation must be report:<task>/<block-id>, report:<task>, or a checkable path:line — anything else is rejected", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.mjs"), "one\ntwo\nthree\n", "utf8");
    const proposals = [
      { kind: "pitfall", text: "citing a block that does not exist on this task at all", citation: "report:blocked-task/F9", task: "blocked-task", notDerivableBecause: "n/a" },
      { kind: "pattern", text: "citing a task that this report does not even contain", citation: "report:no-such-task", task: "clean-task", notDerivableBecause: "n/a" },
      { kind: "pitfall", text: "citing a real path and line that holds up fine right here", citation: 'src/a.mjs:2 "two"', task: "blocked-task", notDerivableBecause: "n/a" },
      { kind: "pattern", text: "citing free text that is not any recognized citation form", citation: "somewhere, vaguely, in the code", task: "clean-task", notDerivableBecause: "n/a" },
      { kind: "pattern", text: "citing an empty string which cannot ever be checked at all", citation: "", task: "clean-task", notDerivableBecause: "n/a" },
      // (card memory-docs-drift #5) only report:<task> and report:<task>/<block-id> are implemented — no run
      // segment. A three-segment report:<task>/<block-id>/<extra> is rejected the same as any other malformed
      // report: citation.
      { kind: "pitfall", text: "citing a three-segment report form with a run segment that was never implemented", citation: "report:blocked-task/F1/extra", task: "blocked-task", notDerivableBecause: "n/a" },
    ];
    const result = await reflectWithProposals(proposals, "hash-filter-c2");
    expect(result.rejected.find((r) => r.text === proposals[0].text).reason).toMatch(/citation/);
    expect(result.rejected.find((r) => r.text === proposals[1].text).reason).toMatch(/citation/);
    expect(result.rejected.find((r) => r.text === proposals[3].text).reason).toMatch(/citation/);
    expect(result.rejected.find((r) => r.text === proposals[4].text).reason).toMatch(/citation/);
    expect(result.rejected.find((r) => r.text === proposals[5].text).reason).toMatch(/citation/);
    expect(result.appended).toHaveLength(1);
  });

  it("C.3: notDerivableBecause must be non-empty, and the text must not already sit verbatim in the cited file or CLAUDE.md", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "Always run pnpm typecheck before committing any change.\n", "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "b.mjs"), "// keep retries capped at three attempts\nconst x = 1;\n", "utf8");
    const proposals = [
      { kind: "pattern", text: "a fine new lesson about something not written anywhere yet", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "" },
      { kind: "pattern", text: "Always run pnpm typecheck before committing any change.", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "already in CLAUDE.md" },
      { kind: "pitfall", text: "keep retries capped at three attempts", citation: "src/b.mjs:1", task: "blocked-task", notDerivableBecause: "already in the cited file" },
      { kind: "pattern", text: "a genuinely distinct new lesson worth keeping around here", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere" },
    ];
    const result = await reflectWithProposals(proposals, "hash-filter-c3");
    expect(result.rejected.find((r) => r.text === proposals[0].text).reason).toMatch(/notDerivableBecause/);
    expect(result.rejected.find((r) => r.text === proposals[1].text).reason).toMatch(/verbatim/);
    expect(result.rejected.find((r) => r.text === proposals[2].text).reason).toMatch(/verbatim/);
    expect(result.appended).toHaveLength(1);
  });

  it("C.4 (ADR 0019 card 8): a near-duplicate (Jaccard >= REFLECT_DUPLICATE_JACCARD) with no judgement is rejected and bumps nothing; an exact id collision is a repeat that bumps seen, never helpful", async () => {
    const existing = addLesson(m, { text: "always run pnpm typecheck before every commit to the repo", kind: "pattern", citation: "report:clean-task", source: { agent: "worker" } });
    const near = { kind: "pattern", text: "always run pnpm typecheck before every commit made to the repo", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "distinct enough" };
    const idCollision = { kind: existing.kind, text: existing.text, citation: existing.citation, task: "clean-task", notDerivableBecause: "same exact text and kind" };
    const result = await reflectWithProposals([near, idCollision], "hash-filter-c4");
    expect(result.appended).toHaveLength(0);
    // the similarity score never merges: the near-duplicate is rejected naming the match, no counter moves for it.
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].text).toBe(near.text);
    expect(result.rejected[0].reason).toMatch(/near-duplicate/);
    expect(result.rejected[0].reason).toContain(existing.id);
    // the exact id collision (same hash) is a repeat: seen rises, helpful does not.
    expect(result.bumped).toEqual([existing.id]);
    expect(getLesson(m, existing.id).seen).toBe(1);
    expect(getLesson(m, existing.id).helpful).toBe(0);
  });

  it("C.4 (major 2): an addLesson id collision with a SUPERSEDED lesson is rejected with a reason, not bumped or thrown, and the report hash can be retried again later", async () => {
    const superseded = addLesson(m, { text: "an old lesson that later got superseded", kind: "pattern", citation: "report:clean-task", source: { agent: "worker" } });
    const replacement = addLesson(m, { text: "a newer replacement lesson entirely", kind: "pattern", source: { agent: "worker" } });
    supersedeLesson(m, superseded.id, replacement.id);
    // Same kind+citation+text as the now-superseded row: computeLessonId collides with it exactly.
    const idCollisionWithSuperseded = { kind: superseded.kind, text: superseded.text, citation: superseded.citation, task: "clean-task", notDerivableBecause: "reproposing the old text" };
    const result = await reflectWithProposals([idCollisionWithSuperseded], "hash-filter-c4-superseded");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(0);
    expect(result.bumped).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/superseded/);
    expect(result.rejected[0].reason).toContain(superseded.id);
    // helpful/harmful on the superseded row and its replacement are both untouched.
    expect(getLesson(m, superseded.id).helpful).toBe(0);
    expect(getLesson(m, replacement.id).helpful).toBe(0);
  });

  it("C.5 (minor 4): the 3-item cap limits appends, not evaluation — a near-duplicate found past the cap is still evaluated (rejected as a near-duplicate, not for the cap); only a genuinely new proposal past the cap is rejected naming the limit", async () => {
    const p1 = { kind: "pattern", text: "Owned files listed in the plan must match exactly what the implementer touches", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere" };
    const p2 = { kind: "pattern", text: "A confirmed adversary block should always cite the exact ledger id in its reason", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere" };
    const p3 = { kind: "pattern", text: "Verifier findings that are informational only should never block a first pass", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere" };
    // A near-duplicate of p1 (one word changed), proposed after the cap of 3 is already reached by p1-p3.
    const p4NearDuplicateOfP1 = { kind: "pattern", text: "Owned files listed in the plan must match exactly what the implementer touched", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere" };
    // A genuinely new, distinct proposal past the cap: this one must be rejected naming the cap.
    const p5GenuinelyNew = { kind: "pattern", text: "Reused branches skip the implementer but still need verify and review to run", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere" };

    const result = await reflectWithProposals([p1, p2, p3, p4NearDuplicateOfP1, p5GenuinelyNew], "hash-filter-c5");
    expect(result.appended).toHaveLength(3);
    const p1Id = result.appended[0];
    // p4 is a near-duplicate of the already-appended p1 with no judgement: rejected as such (ADR 0019 card 8),
    // nothing bumped, and not rejected for the cap.
    expect(result.bumped).toEqual([]);
    expect(getLesson(m, p1Id).helpful).toBe(0);
    expect(getLesson(m, p1Id).seen).toBe(0);
    const p4Rejection = result.rejected.find((r) => r.text === p4NearDuplicateOfP1.text);
    expect(p4Rejection).toBeDefined();
    expect(p4Rejection.reason).toMatch(/near-duplicate/);
    expect(p4Rejection.reason).toContain(p1Id);
    expect(p4Rejection.reason).not.toMatch(/at most 3/);
    // p5 is genuinely new and only rejected because the cap of 3 appends is already spent.
    expect(result.rejected).toHaveLength(2);
    const p5Rejection = result.rejected.find((r) => r.text === p5GenuinelyNew.text);
    expect(p5Rejection).toBeDefined();
    expect(p5Rejection.reason).toMatch(/at most 3/);
  });

  it("(minor 8) an appended lesson carries source_agent 'reflect' and source_model = the model, with card/commit falling back to the task's own values when the flags are absent", async () => {
    const report = buildReflectReport();
    const proposal = {
      kind: "pattern",
      text: "A clean single pass task confirms the spec hash before verifying",
      citation: "report:clean-task",
      task: "clean-task",
      notDerivableBecause: "not written anywhere",
    };
    const result = await runReflect(m, report, {
      reportHash: "hash-provenance-1",
      dir,
      classes: REFLECT_CLASSES,
      model: "haiku-test-model",
      // card and commit flags deliberately absent: the appended lesson must fall back to clean-task's own values.
      propose: async () => ({ lessons: [proposal], sessionId: null, totalCostUsd: null }),
    });
    expect(result.appended).toHaveLength(1);
    const row = getLesson(m, result.appended[0]);
    expect(row.source_agent).toBe("reflect");
    expect(row.source_model).toBe("haiku-test-model");
    expect(row.card).toBe("card-1");
    expect(row.commit_sha).toBe("c1c1c1c");
  });
});

// card reflect-offers-claude-md: after reflect appends a lesson, decide in code whether CLAUDE.md has a home
// for it and, when it does not, write a candidate edits file (never CLAUDE.md, never learn.mjs apply).
const GOTCHA_EXISTING = "- Vendored hook files changed mid session leave stale state until the next repair.";

describe("runReflect: repeats and supersedes (card memory-reflect-supersede)", () => {
  beforeEach(() => {
    m = openMemory(dir);
  });

  const OLD_X = "Recall in this repo is keyword only because the embedding server returns three hundred eighty four dimensions";
  const OLD_Y = "Gate timeouts are best handled by waiting a minute and rerunning the whole suite once more";
  const NEW_N = "Embedding recall works now since reembed rewrote every vector at seven hundred sixty eight dimensions through ollama";
  const NEW_M = "Concurrent stop gates orphan vitest workers so a rerun after a timeout is unsafe without a group kill";

  const lessonProposal = (text, extra = {}) => ({ kind: "pattern", text, citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere", ...extra });
  const seed = (text, extra = {}) => addLesson(m, { text, kind: "pattern", citation: "report:clean-task", source: { agent: "worker" }, ...extra });

  function reflect(proposals, reportHash, extra = {}) {
    return runReflect(m, buildReflectReport(), {
      reportHash,
      dir,
      classes: REFLECT_CLASSES,
      propose: async () => ({ lessons: proposals, sessionId: null, totalCostUsd: null }),
      ...extra,
    });
  }

  it("M1: a supersedes naming a live listed lesson appends the new lesson and supersedes the old one", async () => {
    const x = seed(OLD_X);
    const result = await reflect([lessonProposal(NEW_N, { supersedes: x.id })], "hash-sup-1");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(1);
    const n = result.appended[0];
    expect(getLesson(m, x.id).superseded_by).toBe(n);
    expect(result.superseded).toEqual([{ old: x.id, new: n }]);
    expect(result.notes).toEqual([]);
    expect(listLessons(m).map((l) => l.id)).not.toContain(x.id);
    expect(listLessons(m).map((l) => l.id)).toContain(n);
    // add-only: the old row still exists, and nothing is deleted.
    expect(getLesson(m, x.id)).not.toBeNull();
    expect(getLesson(m, x.id).seen).toBe(0);
    expect(getLesson(m, x.id).helpful).toBe(0);
  });

  it("M2: a supersedes naming a live lesson that the prompt did not list (past the cap) is ignored with a note and the proposal is appended", async () => {
    const base = Date.UTC(2026, 0, 1);
    const oldest = seed(OLD_X, { created: new Date(base).toISOString() });
    for (let i = 1; i <= REFLECT_PROMPT_LESSON_CAP; i++) {
      seed(`filler lesson number ${i} about unrelated zebra topics ${i * 7919}`, { created: new Date(base + i * 86400000).toISOString() });
    }
    expect(listLessons(m)).toHaveLength(REFLECT_PROMPT_LESSON_CAP + 1);
    const result = await reflect([lessonProposal(NEW_N, { supersedes: oldest.id })], "hash-sup-2");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(1);
    expect(result.superseded).toEqual([]);
    expect(getLesson(m, oldest.id).superseded_by).toBeNull();
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain(oldest.id);
    expect(result.notes[0]).toContain("supersedes");
    expect(result.notes[0]).toMatch(/not listed/);
  });

  it("M3: a supersedes naming an unknown id is ignored with a note naming the field and the id; the proposal is appended", async () => {
    const result = await reflect([lessonProposal(NEW_N, { supersedes: "ffffffffffffffff" })], "hash-sup-3");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(1);
    expect(result.superseded).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("ffffffffffffffff");
    expect(result.notes[0]).toContain("supersedes");
  });

  it("M4: a supersedes naming an already-superseded lesson is ignored with a note, never thrown; its superseded_by is unchanged", async () => {
    const x = seed(OLD_X);
    const first = seed(NEW_M);
    supersedeLesson(m, x.id, first.id);
    const result = await reflect([lessonProposal(NEW_N, { supersedes: x.id })], "hash-sup-4");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(1);
    expect(result.superseded).toEqual([]);
    expect(getLesson(m, x.id).superseded_by).toBe(first.id);
    expect(getLesson(m, result.appended[0]).superseded_by).toBeNull();
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain(x.id);
    expect(result.notes[0]).toMatch(/already superseded/);
  });

  it("M5: two proposals in one pass superseding the same lesson: the second is ignored with a note, on a real run and on a dry run", async () => {
    const x = seed(OLD_X);
    const real = await reflect([lessonProposal(NEW_N, { supersedes: x.id }), lessonProposal(NEW_M, { supersedes: x.id })], "hash-sup-5a");
    expect(real.appended).toHaveLength(2);
    expect(real.superseded).toHaveLength(1);
    expect(real.superseded[0].old).toBe(x.id);
    expect(real.notes).toHaveLength(1);
    expect(real.notes[0]).toMatch(/already superseded/);
    expect(real.notes[0]).toContain(x.id);

    const y = seed(OLD_Y);
    const dry = await reflect(
      [lessonProposal("Dry run lesson one about quartz widgets and polishing cycles", { supersedes: y.id }), lessonProposal("Dry run lesson two about zebra crossings and fencing rules", { supersedes: y.id })],
      "hash-sup-5b",
      { dryRun: true }
    );
    expect(dry.superseded).toHaveLength(1);
    expect(dry.superseded[0].old).toBe(y.id);
    expect(dry.notes).toHaveLength(1);
    expect(dry.notes[0]).toMatch(/already superseded/);
    // a dry run writes nothing.
    expect(getLesson(m, y.id).superseded_by).toBeNull();
    expect(listLessons(m).filter((l) => l.source_agent === "reflect").map((l) => l.text)).not.toContain("Dry run lesson one about quartz widgets and polishing cycles");
  });

  it("M6: a non-duplicate proposal with neither field behaves as today: appended, no notes, no superseded, no counter moves", async () => {
    const x = seed(OLD_X);
    const y = seed(OLD_Y);
    const result = await reflect([lessonProposal(NEW_N)], "hash-sup-6");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(1);
    expect(getLesson(m, result.appended[0]).source_agent).toBe("reflect");
    expect(result.notes).toEqual([]);
    expect(result.superseded).toEqual([]);
    expect(result.bumped).toEqual([]);
    expect(result.rejected).toEqual([]);
    for (const l of [x, y]) {
      expect(getLesson(m, l.id).seen).toBe(0);
      expect(getLesson(m, l.id).helpful).toBe(0);
      expect(getLesson(m, l.id).superseded_by).toBeNull();
    }
  });

  it("M7: a valid repeats appends nothing, bumps seen (not helpful) on the target and lists it in bumped", async () => {
    const x = seed(OLD_X);
    const result = await reflect([lessonProposal("Keyword only recall happens here since the server answers with the wrong vector size", { repeats: x.id })], "hash-sup-7");
    expect(result.ok).toBe(true);
    expect(result.appended).toEqual([]);
    expect(result.bumped).toEqual([x.id]);
    expect(result.notes).toEqual([]);
    expect(getLesson(m, x.id).seen).toBe(1);
    expect(getLesson(m, x.id).helpful).toBe(0);
    expect(getLesson(m, x.id).superseded_by).toBeNull();
  });

  it("M7b: a repeats on a dry run does not write seen", async () => {
    const x = seed(OLD_X);
    const result = await reflect([lessonProposal("Keyword only recall happens here since the server answers with the wrong vector size", { repeats: x.id })], "hash-sup-7b", { dryRun: true });
    expect(result.bumped).toEqual([x.id]);
    expect(getLesson(m, x.id).seen).toBe(0);
  });

  it("an invalid repeats id (unknown) is ignored with a note naming the field and the id, then the proposal continues as if the field were absent", async () => {
    const result = await reflect([lessonProposal(NEW_N, { repeats: "eeeeeeeeeeeeeeee" })], "hash-sup-7c");
    expect(result.appended).toHaveLength(1);
    expect(result.bumped).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("eeeeeeeeeeeeeeee");
    expect(result.notes[0]).toContain("repeats");
  });

  it("M8: the similarity score never merges: a Jaccard near-duplicate with no judgement is rejected naming the match, bumps nothing, appends nothing", async () => {
    const x = seed("always run pnpm typecheck before every commit to the repo");
    const near = lessonProposal("always run pnpm typecheck before every commit made to the repo");
    expect(jaccard(reflectTokens(near.text), reflectTokens(x.text))).toBeGreaterThanOrEqual(REFLECT_DUPLICATE_JACCARD);
    const result = await reflect([near], "hash-sup-8");
    expect(result.appended).toEqual([]);
    expect(result.bumped).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/near-duplicate/);
    expect(result.rejected[0].reason).toContain(x.id);
    expect(getLesson(m, x.id).helpful).toBe(0);
    expect(getLesson(m, x.id).seen).toBe(0);
  });

  it("M9: a supersede that shares words with its target is kept (judgement beats the Jaccard score)", async () => {
    const x = seed("always run pnpm typecheck before every commit to the repo");
    const near = lessonProposal("always run pnpm typecheck before every commit made to the repo", { supersedes: x.id });
    expect(jaccard(reflectTokens(near.text), reflectTokens(x.text))).toBeGreaterThanOrEqual(REFLECT_DUPLICATE_JACCARD);
    const result = await reflect([near], "hash-sup-9");
    expect(result.rejected).toEqual([]);
    expect(result.appended).toHaveLength(1);
    expect(getLesson(m, x.id).superseded_by).toBe(result.appended[0]);
    expect(result.superseded).toEqual([{ old: x.id, new: result.appended[0] }]);
  });

  it("M10: a live id collision (same kind, citation and text) is a repeat that bumps seen, never helpful", async () => {
    const x = seed(OLD_X);
    const result = await reflect([lessonProposal(OLD_X)], "hash-sup-10");
    expect(result.appended).toEqual([]);
    expect(result.bumped).toEqual([x.id]);
    expect(getLesson(m, x.id).seen).toBe(1);
    expect(getLesson(m, x.id).helpful).toBe(0);
    expect(result.rejected).toEqual([]);
  });

  it("a live id collision that also carries supersedes is treated as a repeat of the colliding lesson, with a note that supersedes was ignored", async () => {
    const x = seed(OLD_X);
    const y = seed(OLD_Y);
    const result = await reflect([lessonProposal(OLD_X, { supersedes: y.id })], "hash-sup-10b");
    expect(result.appended).toEqual([]);
    expect(result.bumped).toEqual([x.id]);
    expect(getLesson(m, x.id).seen).toBe(1);
    expect(getLesson(m, y.id).superseded_by).toBeNull();
    expect(result.superseded).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("supersedes");
  });

  it("M11: repeats and supersedes both set is rejected naming both fields; nothing is bumped, superseded or appended", async () => {
    const x = seed(OLD_X);
    const y = seed(OLD_Y);
    const result = await reflect([lessonProposal(NEW_N, { repeats: x.id, supersedes: y.id })], "hash-sup-11");
    expect(result.appended).toEqual([]);
    expect(result.bumped).toEqual([]);
    expect(result.superseded).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("repeats");
    expect(result.rejected[0].reason).toContain("supersedes");
    expect(getLesson(m, x.id).seen).toBe(0);
    expect(getLesson(m, y.id).superseded_by).toBeNull();
  });

  it("a supersedes proposal still goes through the other filters: a pitfall on a task with no real block is rejected and the target stays live", async () => {
    const x = seed(OLD_X);
    const result = await reflect([lessonProposal(NEW_N, { kind: "pitfall", supersedes: x.id })], "hash-sup-filters");
    expect(result.appended).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/no block classed real/);
    expect(result.superseded).toEqual([]);
    expect(getLesson(m, x.id).superseded_by).toBeNull();
  });

  it("propose is still called exactly once per reflection", async () => {
    const x = seed(OLD_X);
    let calls = 0;
    await reflect([lessonProposal(NEW_N, { supersedes: x.id })], "hash-sup-once", {
      propose: async () => {
        calls++;
        return { lessons: [lessonProposal(NEW_N, { supersedes: x.id })], sessionId: null, totalCostUsd: null };
      },
    });
    expect(calls).toBe(1);
  });

  it("the add-only triggers stay: a delete of the superseded row is still refused", async () => {
    const x = seed(OLD_X);
    await reflect([lessonProposal(NEW_N, { supersedes: x.id })], "hash-sup-trig");
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${x.id}'`)).toThrow(/add-only/);
  });
});

describe("openMemory: v10 to v11 migration (card memory-reflect-supersede)", () => {
  it("M12: a fresh store has lessons.seen INTEGER NOT NULL DEFAULT 0; a v10 store reopens at v11 with seen added once and old rows reading 0", () => {
    m = openMemory(dir);
    const col = m.prepare("PRAGMA table_info(lessons)").all().find((c) => c.name === "seen");
    expect(col).toBeTruthy();
    expect(col.notnull).toBe(1);
    expect(Number(col.dflt_value)).toBe(0);

    const lesson = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    m.exec("ALTER TABLE lessons DROP COLUMN seen;");
    m.exec("PRAGMA user_version = 10;");
    m.close();
    const v10 = new DatabaseSync(memoryPath(dir));
    expect(v10.prepare("PRAGMA table_info(lessons)").all().map((c) => c.name)).not.toContain("seen");
    v10.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(m.prepare("PRAGMA table_info(lessons)").all().filter((c) => c.name === "seen")).toHaveLength(1);
    expect(getLesson(m, lesson.id).seen).toBe(0);
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${lesson.id}'`)).toThrow(/add-only/);
    m.close();
    // reopening an already-v11 store is a no-op (the ALTER is guarded).
    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
  });
});

// A small CLAUDE.md: Commands block, a Gotchas section with one bullet, a Models table. `padTo` pads Gotchas
// with distinct filler bullets until the file is exactly that many lines (the 200-line limit case).
function claudeMdFixture(padTo = 0) {
  const build = (filler) => [
    "# Project instructions",
    "",
    "## Commands",
    "",
    "```sh",
    "pnpm build",
    "```",
    "",
    "## Gotchas",
    "",
    GOTCHA_EXISTING,
    ...filler,
    "",
    "## Models",
    "",
    "| Work | Model | Effort |",
    "|------|-------|--------|",
    "| plan | opus  | high   |",
  ];
  let filler = [];
  if (padTo) {
    const base = build([]).length;
    filler = Array.from({ length: padTo - base }, (_, i) => `- Filler bullet number ${i} about unrelated topics.`);
  }
  return build(filler).join("\n") + "\n";
}

function setupClaudeMdProject(projDir, claudeMd = claudeMdFixture()) {
  writeFileSync(join(projDir, "CLAUDE.md"), claudeMd, "utf8");
  // The vendored copies the running gates are (decisions.mjs HOOK_SCRIPTS_RELDIR), not plugins/doug-gates/scripts.
  mkdirSync(join(projDir, ".doug/hooks/scripts"), { recursive: true });
  writeFileSync(join(projDir, ".doug/hooks/scripts/stop-gate.mjs"), "// fixture gate\n", "utf8");
  return claudeMd;
}

describe("claudeMdHome (card reflect-offers-claude-md)", () => {
  const lesson = { text: "A lesson text that names nothing in particular here", kind: "pattern" };

  it("a missing suggestion means no candidate: home true, why 'no suggestion'", () => {
    setupClaudeMdProject(dir);
    const r = claudeMdHome({ dir, lesson, suggestion: undefined });
    expect(r.home).toBe(true);
    expect(r.why).toBe("no suggestion");
  });

  it("containment exactly 0.6 is covered, naming the existing line; the denominator is the suggestion's tokens", () => {
    // Suggestion has 5 content tokens, the existing line shares 3 of them (3/5 = 0.6) and has 7 tokens in all
    // (3/7 < 0.6, so a denominator on the existing line's count would call it not covered).
    setupClaudeMdProject(dir, claudeMdFixture().replace(GOTCHA_EXISTING, "- alpha bravo charlie foxtrot golf hotel india"));
    const r = claudeMdHome({ dir, lesson, suggestion: { heading: "## Gotchas", line: "- alpha bravo charlie delta echo" } });
    expect(r.home).toBe(true);
    expect(r.why).toContain("alpha bravo charlie foxtrot golf hotel india");
  });

  it("containment just under 0.6 (4 of 7) is not covered", () => {
    setupClaudeMdProject(dir, claudeMdFixture().replace(GOTCHA_EXISTING, "- alpha bravo charlie delta"));
    const r = claudeMdHome({ dir, lesson, suggestion: { heading: "## Gotchas", line: "- alpha bravo charlie delta echo foxtrot golf" } });
    expect(r).toEqual({ home: false });
  });

  it("a gate script named in the lesson text, with or without .mjs, is enforced (home true, why names the script)", () => {
    setupClaudeMdProject(dir);
    const novel = { heading: "## Gotchas", line: "- Quartz widgets need fencing before polishing." };
    const withExt = claudeMdHome({ dir, lesson: { text: "The stop-gate.mjs hook blocks a Stop without evidence" }, suggestion: novel });
    expect(withExt.home).toBe(true);
    expect(withExt.why).toContain("stop-gate");
    const bare = claudeMdHome({ dir, lesson: { text: "The stop-gate hook blocks a Stop without evidence" }, suggestion: novel });
    expect(bare.home).toBe(true);
    expect(bare.why).toContain("stop-gate");
  });

  it("a gate script named only in the suggestion line is enforced too", () => {
    setupClaudeMdProject(dir);
    const r = claudeMdHome({ dir, lesson, suggestion: { heading: "## Gotchas", line: "- Quartz widgets must pass stop-gate before polishing." } });
    expect(r.home).toBe(true);
    expect(r.why).toContain("stop-gate");
  });

  it("matches a script as a whole word: stop-gate-x and prestop-gate are not stop-gate", () => {
    setupClaudeMdProject(dir);
    const novel = { heading: "## Gotchas", line: "- Quartz widgets need fencing before polishing." };
    expect(claudeMdHome({ dir, lesson: { text: "The stop-gate-x helper is unrelated to any gate" }, suggestion: novel })).toEqual({ home: false });
    expect(claudeMdHome({ dir, lesson: { text: "The prestop-gate helper is unrelated to any gate" }, suggestion: novel })).toEqual({ home: false });
  });

  it("mutation: enforced check reads plugins/doug-gates/scripts instead of .doug/hooks/scripts. A script ONLY under plugins/doug-gates/scripts is not consulted: a candidate", () => {
    writeFileSync(join(dir, "CLAUDE.md"), claudeMdFixture(), "utf8");
    mkdirSync(join(dir, "plugins/doug-gates/scripts"), { recursive: true });
    writeFileSync(join(dir, "plugins/doug-gates/scripts/stop-gate.mjs"), "// plugin-only gate\n", "utf8");
    expect(existsSync(join(dir, ".doug/hooks/scripts"))).toBe(false);
    const novel = { heading: "## Gotchas", line: "- Quartz widgets need fencing before polishing." };
    expect(claudeMdHome({ dir, lesson: { text: "The stop-gate.mjs hook blocks a Stop without evidence" }, suggestion: novel })).toEqual({ home: false });
  });

  // R6: only a top-level `- ` bullet outside a fenced block counts as an existing home.
  it("R6: a suggestion 60%+ contained only in a heading, a table row, or a line inside the Commands block is not covered", () => {
    const md = claudeMdFixture();
    setupClaudeMdProject(dir, md);
    const cases = [
      "- Project instructions", // the `# Project instructions` heading
      "- Gotchas Commands", // `## ` headings
      "- Opus plan high", // the Models table row `| plan | opus  | high   |`
      "- Pnpm build", // the Commands block line `pnpm build`
    ];
    for (const line of cases) {
      expect(claudeMdHome({ dir, lesson, suggestion: { heading: "## Gotchas", line } }), line).toEqual({ home: false });
    }
  });

  it("R6: a `- ` line inside the fenced Commands block is not an existing bullet", () => {
    const md = claudeMdFixture().replace("pnpm build\n", "pnpm build\n- quartz widgets need fencing\n");
    setupClaudeMdProject(dir, md);
    expect(claudeMdHome({ dir, lesson, suggestion: { heading: "## Gotchas", line: "- Quartz widgets need fencing." } })).toEqual({ home: false });
  });

  it("a suggestion line with no content tokens is treated as covered (conservative)", () => {
    setupClaudeMdProject(dir);
    const r = claudeMdHome({ dir, lesson, suggestion: { heading: "## Gotchas", line: "- a to of" } });
    expect(r.home).toBe(true);
  });
});

describe("runReflect: CLAUDE.md candidates (card reflect-offers-claude-md)", () => {
  const CANDIDATES = () => join(dir, ".doug/.state/learn/claude-md-candidates");
  const NOVEL = { heading: "## Gotchas", line: "- Quartz widgets need fencing before any polishing starts." };
  let claudeMdBefore;

  beforeEach(() => {
    m = openMemory(dir);
    claudeMdBefore = setupClaudeMdProject(dir);
  });

  function lessonProposal(text, claudeMd, extra = {}) {
    const p = { kind: "pattern", text, citation: "report:clean-task", task: "clean-task", notDerivableBecause: "not written anywhere", ...extra };
    if (claudeMd) p.claudeMd = claudeMd;
    return p;
  }

  async function reflect(proposals, reportHash, extra = {}) {
    const result = await runReflect(m, buildReflectReport(), {
      reportHash,
      dir,
      classes: REFLECT_CLASSES,
      propose: async () => ({ lessons: proposals, sessionId: null, totalCostUsd: null }),
      ...extra,
    });
    // (i) CLAUDE.md is never modified, in every case.
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(claudeMdBefore);
    return result;
  }

  it("a: an appended lesson with a novel suggestion writes the exact edits candidate, returns the command, and the file passes proposeClaudeMd", async () => {
    const result = await reflect([lessonProposal("A clean single pass task confirms the spec hash before verifying", NOVEL)], "hash-cm-a");
    expect(result.appended).toHaveLength(1);
    const id = result.appended[0];
    expect(result.claudeMd).toHaveLength(1);
    const [cand] = result.claudeMd;
    expect(cand.lessonId).toBe(id);
    expect(cand.file).toBe(join(CANDIDATES(), `${id}.json`));
    expect(cand.command).toMatch(/^node .*memory\.mjs claude-md propose --file /);
    expect(cand.command).toContain(cand.file);
    expect(result.claudeMdDropped ?? []).toEqual([]);

    const edits = JSON.parse(readFileSync(cand.file, "utf8"));
    expect(edits).toEqual({
      note: expect.stringMatching(new RegExp(`^reflect .+: lesson ${id}$`)),
      add: [{ heading: "## Gotchas", line: NOVEL.line, source: `lesson ${id}` }],
    });

    const proposed = proposeClaudeMd({ dir, edits });
    expect(proposed.ok, proposed.reason).toBe(true);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(claudeMdBefore);
  });

  it("b: a suggestion 60%+ contained in an existing CLAUDE.md bullet makes no candidate and no file", async () => {
    const covered = { heading: "## Gotchas", line: "- Vendored hook files changed mid session leave stale." };
    const result = await reflect([lessonProposal("A clean single pass task confirms the spec hash before verifying", covered)], "hash-cm-b");
    expect(result.appended).toHaveLength(1);
    expect(result.claudeMd ?? []).toEqual([]);
    expect(result.claudeMdDropped ?? []).toEqual([]);
    expect(existsSync(CANDIDATES())).toBe(false);
  });

  it("c: a lesson text naming a gate script (stop-gate.mjs, or bare stop-gate) makes no candidate", async () => {
    const result = await reflect(
      [
        lessonProposal("The stop-gate.mjs hook reuses the last red when nothing changed since the previous Stop", NOVEL),
        lessonProposal("Retries inside the stop-gate hook never reset the recorded deferral counter between turns", { heading: "## Gotchas", line: "- Zebra crossings pause every polishing cycle." }),
      ],
      "hash-cm-c",
    );
    expect(result.appended).toHaveLength(2);
    expect(result.claudeMd ?? []).toEqual([]);
    expect(existsSync(CANDIDATES())).toBe(false);
  });

  it("d: a suggestion under ## Models, or under a heading that does not exist, is dropped with proposeClaudeMd's reason and no file", async () => {
    const result = await reflect(
      [
        lessonProposal("A clean single pass task confirms the spec hash before verifying", { heading: "## Models", line: "- Quartz widgets need fencing before any polishing starts." }),
        lessonProposal("Verifier findings that are informational only should never block a first pass", { heading: "## Nowhere", line: "- Zebra crossings pause every polishing cycle." }),
      ],
      "hash-cm-d",
    );
    expect(result.appended).toHaveLength(2);
    expect(result.claudeMd ?? []).toEqual([]);
    expect(result.claudeMdDropped).toHaveLength(2);
    const [first, second] = result.claudeMdDropped;
    expect(first.lessonId).toBe(result.appended[0]);
    expect(first.reason).toContain("Models");
    expect(second.lessonId).toBe(result.appended[1]);
    expect(second.reason).toContain("## Nowhere");
    expect(existsSync(CANDIDATES())).toBe(false);
  });

  it("e: a suggestion that would push CLAUDE.md past 200 lines is dropped with the 200-line reason", async () => {
    const full = claudeMdFixture(200);
    expect(full.split("\n").length - 1).toBe(200);
    claudeMdBefore = setupClaudeMdProject(dir, full);
    const result = await reflect([lessonProposal("A clean single pass task confirms the spec hash before verifying", NOVEL)], "hash-cm-e");
    expect(result.claudeMd ?? []).toEqual([]);
    expect(result.claudeMdDropped).toHaveLength(1);
    expect(result.claudeMdDropped[0].reason).toContain("200");
    expect(existsSync(CANDIDATES())).toBe(false);
  });

  it("f: a rejected or bumped proposal carrying a suggestion makes no candidate", async () => {
    addLesson(m, { text: "always run pnpm typecheck before every commit to the repo", kind: "pattern", citation: "report:clean-task", source: { agent: "worker" } });
    const result = await reflect(
      [
        // rejected (near-duplicate of the existing lesson, no judgement)
        lessonProposal("always run pnpm typecheck before every commit made to the repo", NOVEL),
        // rejected (a pitfall needs a real-classed block on its task)
        lessonProposal("Never merge without running the full test suite first", { heading: "## Gotchas", line: "- Zebra crossings pause every polishing cycle." }, { kind: "pitfall" }),
      ],
      "hash-cm-f",
    );
    expect(result.appended).toHaveLength(0);
    expect(result.bumped).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.claudeMd ?? []).toEqual([]);
    expect(result.claudeMdDropped ?? []).toEqual([]);
    expect(existsSync(CANDIDATES())).toBe(false);
  });

  it("g: an appended lesson with no suggestion makes no candidate", async () => {
    const result = await reflect([lessonProposal("A clean single pass task confirms the spec hash before verifying", null)], "hash-cm-g");
    expect(result.appended).toHaveLength(1);
    expect(result.claudeMd ?? []).toEqual([]);
    expect(result.claudeMdDropped ?? []).toEqual([]);
    expect(existsSync(CANDIDATES())).toBe(false);
  });

  it("h: --dry-run reports the candidate but writes nothing", async () => {
    const result = await reflect([lessonProposal("A clean single pass task confirms the spec hash before verifying", NOVEL)], "hash-cm-h", { dryRun: true });
    expect(result.claudeMd).toHaveLength(1);
    expect(result.claudeMd[0].command).toMatch(/claude-md propose --file /);
    expect(existsSync(CANDIDATES())).toBe(false);
    expect(existsSync(join(dir, ".doug/.state/learn"))).toBe(false);
  });

  it("fail-open: a claude-md-candidates path that is a plain file does not throw; the lesson and a complete reflections row are written, claudeMd is [], the drop carries the error", async () => {
    mkdirSync(join(dir, ".doug/.state/learn"), { recursive: true });
    writeFileSync(CANDIDATES(), "not a directory\n", "utf8");
    const result = await reflect([lessonProposal("A clean single pass task confirms the spec hash before verifying", NOVEL)], "hash-cm-failopen");
    expect(result.ok).toBe(true);
    expect(result.appended).toHaveLength(1);
    const id = result.appended[0];
    expect(result.claudeMd).toEqual([]);
    expect(result.claudeMdDropped).toHaveLength(1);
    expect(result.claudeMdDropped[0].lessonId).toBe(id);
    expect(result.claudeMdDropped[0].reason).toMatch(/EEXIST|ENOTDIR|exists|not a directory/i);
    expect(listLessons(m).map((l) => l.id)).toContain(id);
    const row = m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-cm-failopen");
    expect(row.proposed).toBe(1);
    expect(JSON.parse(row.appended)).toEqual([id]);
    expect(row.rejected).not.toBeNull();
    expect(row.bumped).not.toBeNull();
  });

  it("a cheap pass that fails still returns claudeMd: [] and claudeMdDropped: []", async () => {
    const result = await runReflect(m, buildReflectReport(), {
      reportHash: "hash-cm-passfail",
      dir,
      classes: REFLECT_CLASSES,
      propose: async () => {
        throw new Error("claude printed no parseable JSON: boom");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.claudeMd).toEqual([]);
    expect(result.claudeMdDropped).toEqual([]);
  });

  it("the cheap pass's schema carries an optional claudeMd { heading, line } on each lesson", () => {
    const item = REFLECT_SCHEMA.properties.lessons.items;
    expect(item.properties.claudeMd).toBeDefined();
    expect(item.properties.claudeMd.properties.heading).toBeDefined();
    expect(item.properties.claudeMd.properties.line).toBeDefined();
    expect(item.properties.claudeMd.required).toEqual(expect.arrayContaining(["heading", "line"]));
    expect(item.required).not.toContain("claudeMd");
  });
});

// card recall-scale-row-load: recallLessons must load only the rows the ranking needs, with output unchanged.
// The golden file was generated from the pre-change code (UPDATE_RECALL_GOLDEN=1 rewrites it; never do that
// after the change, it would bless whatever the new code returns).
describe("recallLessons: golden equivalence and row load (card recall-scale-row-load)", () => {
  const GOLDEN = join(dirname(new URL(import.meta.url).pathname), "fixtures", "recall-golden.json");
  const NOW = new Date("2026-09-30T00:00:00.000Z");
  const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
  const MODEL = { model: "fake-model", dims: 3 };
  let checkoutDir;
  let storeDirs;

  beforeEach(() => {
    storeDirs = [];
    checkoutDir = mkdtempSync(join(tmpdir(), "doug-recall-golden-checkout-"));
    mkdirSync(join(checkoutDir, ".doug"), { recursive: true });
    mkdirSync(join(checkoutDir, "src"), { recursive: true });
    writeFileSync(join(checkoutDir, "src", "a.mjs"), "line one\nline two\nline three\n", "utf8");
  });

  afterEach(() => {
    for (const d of storeDirs) rmSync(d, { recursive: true, force: true });
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  const openStore = (build) => {
    const d = mkdtempSync(join(tmpdir(), "doug-recall-golden-store-"));
    storeDirs.push(d);
    const db = openMemory(d);
    build(db);
    return db;
  };

  const mk = (db, id, text, { created = daysAgo(5), scope, citation, vec, model = MODEL.model, dims = MODEL.dims } = {}) => {
    addLesson(db, { id, text, kind: "pattern", source: { agent: "worker" }, created, scope, citation });
    if (vec) setLessonEmbedding(db, id, { model, dims, vector: Float32Array.from(vec) });
  };

  // The main store: every shape the card's goal names.
  const buildMain = (db) => {
    mk(db, "r-good", "retry flaky calls good", { citation: 'src/a.mjs:2 "line two"', vec: [0.5, 0.5, 0.7] });
    mk(db, "r-bad1", "retry flaky calls bad one", { citation: 'src/a.mjs:2 "line moved"', vec: [1, 0, 0] });
    mk(db, "r-bad2", "retry flaky calls bad two", { citation: "src/missing.mjs:1" });
    mk(db, "r-scoped", "retry flaky uploads scoped", { scope: ["src/**/*.mjs"], vec: [0.9, 0.1, 0] });
    mk(db, "r-unscoped", "retry flaky uploads unscoped", { vec: [0.8, 0.2, 0.1] });
    mk(db, "r-elsewhere", "retry flaky uploads elsewhere", { scope: ["docs/**/*.md"], vec: [0.85, 0.15, 0] });
    mk(db, "r-novec", "retry flaky calls without vector", { created: daysAgo(12) });
    mk(db, "r-novec2", "flaky retry novec second", { created: daysAgo(3), scope: ["src/a.mjs"] });
    mk(db, "r-other", "retry flaky calls other model", { vec: [1, 0, 0], model: "other-model", dims: 3 });
    mk(db, "r-otherdims", "retry flaky calls other dims", { vec: [1, 0, 0, 0], model: "fake-model", dims: 4 });
    mk(db, "r-veconly", "unrelated zzz vector only", { vec: [0.95, 0.05, 0] });
    mk(db, "r-veconly-old", "unrelated qqq old vector", { created: daysAgo(40), vec: [1, 0, 0] });
    mk(db, "r-garbled", "retry flaky garbled date", { created: "not-a-date", vec: [0.6, 0.4, 0] });
    mk(db, "r-confirmed", "retry flaky confirmed lately", { created: daysAgo(200), vec: [0.7, 0.3, 0] });
    mk(db, "r-ancient", "retry flaky ancient", { created: daysAgo(90), vec: [1, 0, 0] });
    mk(db, "r-stale", "retry flaky stale already", { vec: [1, 0, 0] });
    mk(db, "r-superseded", "retry flaky superseded", { vec: [1, 0, 0] });
    db.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(daysAgo(2), "r-confirmed");
    db.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(daysAgo(1), "r-stale");
    db.prepare("UPDATE lessons SET superseded_by = ? WHERE id = ?").run("r-good", "r-superseded");
  };

  // Degraded store: the only vector sits on an out-of-window row, so degraded rests on a row recall never ranks.
  const buildOnlyOldVector = (db) => {
    mk(db, "o-fresh1", "retry flaky fresh one");
    mk(db, "o-fresh2", "retry flaky fresh two");
    mk(db, "o-old", "retry flaky old vectored", { created: daysAgo(90), vec: [1, 0, 0] });
  };

  // Vectors only on a superseded row and a stale row: neither is live, so keyword recall is not degraded.
  const buildDeadVectors = (db) => {
    mk(db, "d-live1", "retry flaky live one");
    mk(db, "d-live2", "retry flaky live two");
    mk(db, "d-superseded", "retry flaky superseded vectored", { vec: [1, 0, 0] });
    mk(db, "d-stale", "retry flaky stale vectored", { vec: [1, 0, 0] });
    db.prepare("UPDATE lessons SET superseded_by = ? WHERE id = ?").run("d-live1", "d-superseded");
    db.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(daysAgo(1), "d-stale");
  };

  // A store with no vectors anywhere.
  const buildNoVectors = (db) => {
    mk(db, "n-1", "retry flaky plain one");
    mk(db, "n-2", "retry flaky plain two");
  };

  const failing = (reason) => ({ name: "fake", ...MODEL, embed: async () => ({ ok: false, reason }) });
  const qvec = () => fakeProvider({ vectorFor: () => [1, 0, 0] });
  const mismatched = () => fakeProvider({ model: "nomatch-model", dims: 3 });

  const MATRIX = [
    ["main", buildMain, "keyword, no checkout", () => ({ query: "retry flaky" })],
    ["main", buildMain, "keyword, checkout", () => ({ query: "retry flaky", checkoutDir })],
    ["main", buildMain, "keyword, checkout, files, k=3", () => ({ query: "retry flaky uploads", checkoutDir, files: ["src/a.mjs"], k: 3 })],
    ["main", buildMain, "keyword, narrow staleDays", () => ({ query: "retry flaky", checkoutDir, staleDays: 10 })],
    ["main", buildMain, "keyword, empty query", () => ({ query: "" })],
    ["main", buildMain, "hybrid, no checkout", () => ({ query: "retry flaky", provider: qvec() })],
    ["main", buildMain, "hybrid, checkout (stale drop, confirm)", () => ({ query: "retry flaky", provider: qvec(), checkoutDir })],
    ["main", buildMain, "hybrid, checkout, k=2 (backfill)", () => ({ query: "retry flaky", provider: qvec(), checkoutDir, k: 2 })],
    ["main", buildMain, "hybrid, checkout, k=1 (backfill past the dropped top hit)", () => ({ query: "retry flaky", provider: qvec(), checkoutDir, k: 1 })],
    ["main", buildMain, "hybrid, files, k=20", () => ({ query: "retry flaky uploads", provider: qvec(), files: ["src/a.mjs"], k: 20 })],
    ["main", buildMain, "hybrid, checkout, files, k=5", () => ({ query: "retry flaky uploads", provider: qvec(), checkoutDir, files: ["src/a.mjs"], k: 5 })],
    ["main", buildMain, "hybrid, a different query vector", () => ({ query: "retry flaky", provider: fakeProvider({ vectorFor: () => [0, 1, 0] }), k: 20 })],
    ["main", buildMain, "hybrid, narrow staleDays", () => ({ query: "retry flaky", provider: qvec(), staleDays: 10, k: 20 })],
    ["main", buildMain, "hybrid, query matching nothing (vector-only candidates)", () => ({ query: "zzzznomatch", provider: qvec(), k: 20 })],
    ["main", buildMain, "provider with no matching vectors", () => ({ query: "retry flaky", provider: mismatched(), checkoutDir })],
    ["main", buildMain, "provider whose embed fails", () => ({ query: "retry flaky", provider: failing("timeout"), checkoutDir })],
    ["main", buildMain, "detectedProvider only", () => ({ query: "retry flaky", detectedProvider: "ollama x", checkoutDir })],
    ["only-old-vector", buildOnlyOldVector, "degraded: keyword, no provider", () => ({ query: "retry flaky", checkoutDir })],
    ["only-old-vector", buildOnlyOldVector, "degraded: provider, no matching vectors", () => ({ query: "retry flaky", provider: qvec(), checkoutDir })],
    ["only-old-vector", buildOnlyOldVector, "degraded: embed fails", () => ({ query: "retry flaky", provider: failing("connection refused"), checkoutDir })],
    ["no-vectors", buildNoVectors, "no vectors: keyword, no provider (not degraded)", () => ({ query: "retry flaky", checkoutDir })],
    ["no-vectors", buildNoVectors, "no vectors: provider", () => ({ query: "retry flaky", provider: qvec(), checkoutDir })],
    ["dead-vectors", buildDeadVectors, "dead vectors: keyword, no provider (not degraded)", () => ({ query: "retry flaky", checkoutDir })],
    ["dead-vectors", buildDeadVectors, "dead vectors: keyword, no checkout", () => ({ query: "retry flaky" })],
    ["dead-vectors", buildDeadVectors, "dead vectors: provider (degraded, no live vectors)", () => ({ query: "retry flaky", provider: qvec(), checkoutDir })],
  ];

  const run = async () => {
    const out = {};
    for (const [store, build, label, optsFor] of MATRIX) {
      const db = openStore(build);
      try {
        const { query, ...opts } = optsFor();
        const result = await recallLessons(db, query, { now: NOW, ...opts });
        const table = db.prepare("SELECT id, stale, confirmed FROM lessons ORDER BY id").all().map((r) => ({ ...r }));
        out[`${store} | ${label}`] = JSON.parse(JSON.stringify({ result, table }));
      } finally {
        db.close();
      }
    }
    return out;
  };

  it("recall output and the stale/confirmed side effects match the golden file, over the whole matrix", async () => {
    const actual = await run();
    if (process.env.UPDATE_RECALL_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n", "utf8");
      throw new Error("golden regenerated; rerun without UPDATE_RECALL_GOLDEN");
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(actual)).toEqual(Object.keys(golden));
    for (const key of Object.keys(golden)) expect(actual[key], key).toEqual(golden[key]);
  });

  // card recall-hybrid-scale: the in-process vector cache must not change any result.
  it("running the whole matrix twice in one process, cache never cleared, matches the golden file both times", async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    const first = await run();
    const second = await run();
    expect(Object.keys(first)).toEqual(Object.keys(golden));
    expect(Object.keys(second)).toEqual(Object.keys(golden));
    for (const key of Object.keys(golden)) {
      expect(first[key], `first: ${key}`).toEqual(golden[key]);
      expect(second[key], `second: ${key}`).toEqual(golden[key]);
    }
  });

  it("repeated hybrid recalls on one open store give identical results (a warm cache changes nothing)", async () => {
    const db = openStore(buildMain);
    const opts = () => ({ now: NOW, provider: qvec(), files: ["src/a.mjs"], k: 20 });
    const cold = JSON.parse(JSON.stringify(await recallLessons(db, "retry flaky uploads", opts())));
    const warm = JSON.parse(JSON.stringify(await recallLessons(db, "retry flaky uploads", opts())));
    const warm2 = JSON.parse(JSON.stringify(await recallLessons(db, "retry flaky uploads", opts())));
    db.close();
    expect(cold.mode).toBe("hybrid");
    expect(warm).toEqual(cold);
    expect(warm2).toEqual(cold);
  });

  it("the golden file covers the shapes the card names (a guard against a vacuous fixture)", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    const g = (k) => golden[k];
    expect(g("main | hybrid, checkout (stale drop, confirm)").result.mode).toBe("hybrid");
    const hy = g("main | hybrid, checkout (stale drop, confirm)");
    expect(hy.table.find((r) => r.id === "r-bad1").stale).not.toBeNull();
    expect(hy.table.find((r) => r.id === "r-good").confirmed).not.toBeNull();
    expect(g("main | hybrid, files, k=20").result.lessons.some((l) => l.id === "r-novec" && l.hasVector === false)).toBe(true);
    expect(g("main | hybrid, checkout, k=2 (backfill)").result.lessons).toHaveLength(2);
    expect(g("main | hybrid, no checkout").result.lessons.some((l) => l.id === "r-garbled")).toBe(true);
    expect(g("main | provider with no matching vectors").result.degraded).toBe(true);
    const old = g("only-old-vector | degraded: keyword, no provider").result;
    expect(old.mode).toBe("keyword-only");
    expect(old.degraded).toBe(true);
    expect(g("dead-vectors | dead vectors: keyword, no provider (not degraded)").result.degraded).toBe(false);
    expect(g("dead-vectors | dead vectors: provider (degraded, no live vectors)").result.degraded).toBe(true);
    expect(g("no-vectors | no vectors: keyword, no provider (not degraded)").result.degraded).toBe(false);
  });

  // Statements recallLessons runs, recorded by wrapping prepare/exec on the open store.
  const recordSql = async (build, opts, query = "retry flaky") => {
    const db = openStore(build);
    const seen = [];
    const prepare = db.prepare.bind(db);
    const exec = db.exec.bind(db);
    db.prepare = (sql) => (seen.push(String(sql)), prepare(sql));
    db.exec = (sql) => (seen.push(String(sql)), exec(sql));
    try {
      await recallLessons(db, query, { now: NOW, ...opts });
    } finally {
      db.prepare = prepare;
      db.exec = exec;
      db.close();
    }
    return seen.map((s) => s.replace(/\s+/g, " ").trim());
  };

  // A `*` anywhere in a select list over lessons, by-id loads included (count(*) is not a row load).
  const selectsStar = (sql) => /\bselect\b[^;]*?\*[^;]*?\bfrom\s+lessons\b/i.test(sql.replace(/count\(\s*\*\s*\)/gi, "count(1)"));
  const readsEmbeddingBlob = (sql) => /\bembedding\b/i.test(sql.replace(/\bembedding\s+is\s+(not\s+)?null\b/gi, ""));

  it("hybrid recall never selects * from lessons, by-id loads included", async () => {
    const sqls = await recordSql(buildMain, { provider: qvec(), checkoutDir, files: ["src/a.mjs"] });
    expect(sqls.filter(selectsStar)).toEqual([]);
  });

  it("keyword recall never selects * from lessons, by-id loads included", async () => {
    const sqls = await recordSql(buildMain, { checkoutDir });
    expect(sqls.filter(selectsStar)).toEqual([]);
  });

  it("every statement that reads the embedding column filters on embedding_model and embedding_dims", async () => {
    const sqls = await recordSql(buildMain, { provider: qvec(), checkoutDir });
    const reads = sqls.filter(readsEmbeddingBlob);
    expect(reads.filter((s) => !(/embedding_model\s*=/i.test(s) && /embedding_dims\s*=/i.test(s)))).toEqual([]);
  });

  it("keyword mode reads no embedding blobs", async () => {
    const sqls = await recordSql(buildMain, { checkoutDir });
    expect(sqls.filter(readsEmbeddingBlob)).toEqual([]);
  });

  it("a provider with no matching vectors reads no embedding blobs either", async () => {
    const sqls = await recordSql(buildMain, { provider: mismatched(), checkoutDir });
    expect(sqls.filter(readsEmbeddingBlob)).toEqual([]);
  });
});

// card recall-hybrid-scale: freshness semantics pinned, then the in-process decoded-vector cache.
const clearCache = () => {
  if (typeof clearRecallCache === "function") clearRecallCache();
};

describe("recallLessons: freshness window semantics (card recall-hybrid-scale)", () => {
  const NOW = new Date("2026-09-30T00:00:00.000Z");
  const DAY = 86400000;
  const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString();

  beforeEach(() => {
    clearCache();
    m = openMemory(dir);
  });

  const build = () => {
    const mk = (id, created, confirmed) => {
      addLesson(m, { id, text: `freshword ${id}`, kind: "pattern", source: { agent: "worker" }, created });
      setLessonEmbedding(m, id, { model: "fake-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
      if (confirmed !== undefined) m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(confirmed, id);
    };
    mk("f-garbled", "not-a-date");
    mk("f-js-old", "Aug 1 2026"); // JS parses it (60 days old); SQLite date functions do not
    mk("f-js-new", "Sep 25 2026"); // JS parses it (5 days old); SQLite date functions do not
    mk("f-slash-old", "2026/08/01");
    mk("f-exact", daysAgo(30));
    mk("f-over", new Date(NOW.getTime() - 30 * DAY - 60000).toISOString());
    mk("f-conf-fresh", daysAgo(200), daysAgo(1));
    mk("f-conf-old", daysAgo(1), daysAgo(200));
    mk("f-conf-garbled", daysAgo(200), "garbage");
    mk("f-conf-empty", daysAgo(200), "");
    mk("f-created-empty", "");
    mk("f-future", daysAgo(-5));
  };

  const EXPECTED = ["f-conf-fresh", "f-conf-garbled", "f-created-empty", "f-exact", "f-future", "f-garbled", "f-js-new"];

  it("keyword mode: JS-parse age semantics, unparseable counts as fresh, exactly staleDays is kept, confirmed wins over created", async () => {
    build();
    const result = await recallLessons(m, "freshword", { now: NOW, staleDays: 30, k: 50 });
    expect(result.mode).toBe("keyword-only");
    expect(result.lessons.map((l) => l.id).sort()).toEqual(EXPECTED);
  });

  it("hybrid mode: the same lessons, by the same rules", async () => {
    build();
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const result = await recallLessons(m, "freshword", { provider, now: NOW, staleDays: 30, k: 50 });
    expect(result.mode).toBe("hybrid");
    expect(result.lessons.map((l) => l.id).sort()).toEqual(EXPECTED);
    expect(result.total).toBe(EXPECTED.length);
    expect(result.unvectored).toBe(0);
  });

  it("hybrid mode, vector-only (query matches no text): the same lessons", async () => {
    build();
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const result = await recallLessons(m, "zzznomatch", { provider, now: NOW, staleDays: 30, k: 50 });
    expect(result.mode).toBe("hybrid");
    expect(result.lessons.map((l) => l.id).sort()).toEqual(EXPECTED);
  });
});

describe("recallLessons: in-process vector cache (card recall-hybrid-scale)", () => {
  const NOW = new Date("2026-09-30T00:00:00.000Z");
  const created = new Date(NOW.getTime() - 5 * 86400000).toISOString();
  const MODEL = { model: "fake-model", dims: 3 };
  const qprov = (over = {}) => fakeProvider({ vectorFor: () => [1, 0, 0], ...over });
  const put = (db, id, vec, model = MODEL) => {
    if (!getLesson(db, id)) addLesson(db, { id, text: `cachetext ${id}`, kind: "pattern", source: { agent: "worker" }, created });
    setLessonEmbedding(db, id, { ...model, vector: Float32Array.from(vec) });
  };
  const ids = async (db, provider = qprov()) =>
    (await recallLessons(db, "nomatchquery", { provider, now: NOW, k: 20 })).lessons.map((l) => l.id);
  let m2;

  beforeEach(() => {
    clearCache();
    m = openMemory(dir);
    m2 = null;
    put(m, "ca", [0.9, 0.1, 0]);
    put(m, "cb", [0.5, 0.5, 0]);
    put(m, "cc", [0.1, 0.9, 0]);
  });

  afterEach(() => {
    if (m2) {
      try {
        m2.close();
      } catch {
        // already closed
      }
    }
  });

  it("exports clearRecallCache as a function", () => {
    expect(typeof clearRecallCache).toBe("function");
    expect(() => clearRecallCache()).not.toThrow();
  });

  it("baseline order, and a repeat call gives the same order", async () => {
    expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
    expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
  });

  describe("same connection", () => {
    it("a new embedding on an existing lesson shows on the next recall", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      setLessonEmbedding(m, "cc", { ...MODEL, vector: Float32Array.from([1, 0, 0]) });
      expect(await ids(m)).toEqual(["cc", "ca", "cb"]);
    });

    it("a raw UPDATE of the embedding column shows on the next recall", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      m.prepare("UPDATE lessons SET embedding = ? WHERE id = ?").run(Buffer.from(Float32Array.from([1, 0, 0]).buffer), "cc");
      expect(await ids(m)).toEqual(["cc", "ca", "cb"]);
    });

    it("superseding the top lesson drops it from the next recall", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      supersedeLesson(m, "ca", "cb");
      expect(await ids(m)).toEqual(["cb", "cc"]);
    });

    it("marking a lesson stale drops it, and unstaling brings it back", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(NOW.toISOString(), "ca");
      expect(await ids(m)).toEqual(["cb", "cc"]);
      unstaleLesson(m, "ca");
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
    });

    it("a new embedded lesson shows on the next recall", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      put(m, "cd", [1, 0, 0]);
      expect(await ids(m)).toEqual(["cd", "ca", "cb", "cc"]);
    });

    it("re-embedding a lesson under another model removes it from this model's results", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      setLessonEmbedding(m, "ca", { model: "other-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
      expect(await ids(m)).toEqual(["cb", "cc"]);
    });
  });

  describe("a second connection on the same file", () => {
    beforeEach(() => {
      m2 = openMemory(dir);
    });

    it("a changed embedding written there shows on the first connection", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      setLessonEmbedding(m2, "cc", { ...MODEL, vector: Float32Array.from([1, 0, 0]) });
      expect(await ids(m)).toEqual(["cc", "ca", "cb"]);
    });

    it("a supersede written there shows on the first connection", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      supersedeLesson(m2, "ca", "cb");
      expect(await ids(m)).toEqual(["cb", "cc"]);
    });

    it("a stale mark written there shows on the first connection", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      m2.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run(NOW.toISOString(), "cb");
      expect(await ids(m)).toEqual(["ca", "cc"]);
    });

    it("a new embedded lesson written there shows on the first connection", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      put(m2, "cd", [1, 0, 0]);
      expect(await ids(m)).toEqual(["cd", "ca", "cb", "cc"]);
    });

    it("a raw DatabaseSync handle on the file is seen too", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      const raw = new DatabaseSync(memoryPath(dir));
      try {
        raw.prepare("UPDATE lessons SET embedding = ? WHERE id = ?").run(Buffer.from(Float32Array.from([1, 0, 0]).buffer), "cc");
      } finally {
        raw.close();
      }
      expect(await ids(m)).toEqual(["cc", "ca", "cb"]);
    });

    it("both connections warm: each sees a write made through the other", async () => {
      expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      expect(await ids(m2)).toEqual(["ca", "cb", "cc"]);
      setLessonEmbedding(m, "cc", { ...MODEL, vector: Float32Array.from([1, 0, 0]) });
      expect(await ids(m2)).toEqual(["cc", "ca", "cb"]);
      supersedeLesson(m2, "cc", "ca");
      expect(await ids(m)).toEqual(["ca", "cb"]);
    });
  });

  describe("keyed by model and dims", () => {
    it("two models over one database each see only their own vectors, in either call order", async () => {
      put(m, "xo", [1, 0, 0], { model: "other-model", dims: 3 });
      const a = qprov();
      const b = qprov({ model: "other-model" });
      expect(await ids(m, a)).toEqual(["ca", "cb", "cc"]);
      expect(await ids(m, b)).toEqual(["xo"]);
      expect(await ids(m, a)).toEqual(["ca", "cb", "cc"]);
      expect(await ids(m, b)).toEqual(["xo"]);
    });

    it("the same model at two dims over one database each see only their own vectors", async () => {
      put(m, "x4", [1, 0, 0, 0], { model: "fake-model", dims: 4 });
      const d3 = qprov();
      const d4 = fakeProvider({ dims: 4, vectorFor: () => [1, 0, 0, 0] });
      expect(await ids(m, d3)).toEqual(["ca", "cb", "cc"]);
      expect(await ids(m, d4)).toEqual(["x4"]);
      expect(await ids(m, d3)).toEqual(["ca", "cb", "cc"]);
      expect(await ids(m, d4)).toEqual(["x4"]);
    });

    it("two databases in one process do not share cached vectors", async () => {
      const dirB = mkdtempSync(join(tmpdir(), "doug-memory-b-"));
      const mb = openMemory(dirB);
      try {
        put(mb, "ca", [0.1, 0.9, 0]);
        put(mb, "zz", [1, 0, 0]);
        expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
        expect(await ids(mb)).toEqual(["zz", "ca"]);
        expect(await ids(m)).toEqual(["ca", "cb", "cc"]);
      } finally {
        mb.close();
        rmSync(dirB, { recursive: true, force: true });
      }
    });
  });

  describe("blob decode", () => {
    it("scores identically when the driver hands back blobs at an odd byte offset inside a larger buffer", async () => {
      const direct = (await recallLessons(m, "nomatchquery", { provider: qprov(), now: NOW, k: 20 })).lessons.map((l) => [l.id, l.score]);
      clearCache();
      const prepare = m.prepare.bind(m);
      const shift = (row) => {
        if (!row || !row.embedding || typeof row.embedding === "boolean") return row;
        const bytes = Uint8Array.from(row.embedding);
        const big = Buffer.alloc(bytes.length + 3);
        big.set(bytes, 1); // odd offset: a Float32Array view straight onto it would throw
        return { ...row, embedding: big.subarray(1, 1 + bytes.length) };
      };
      m.prepare = (sql) => {
        const st = prepare(sql);
        return new Proxy(st, {
          get(target, prop) {
            if (prop === "all") return (...a) => target.all(...a).map(shift);
            if (prop === "get") return (...a) => shift(target.get(...a));
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      };
      try {
        const shifted = (await recallLessons(m, "nomatchquery", { provider: qprov(), now: NOW, k: 20 })).lessons.map((l) => [l.id, l.score]);
        expect(shifted).toEqual(direct);
        expect(shifted.length).toBe(3);
      } finally {
        m.prepare = prepare;
      }
    });
  });
});

// card recall-hybrid-scale, seat 4: pins for the cache's own-write patching, the earlier-now reuse guard, the
// SQL freshness margin (needs a zone behind UTC, so a child process) and a NaN staleDays.
describe("recallLessons: cache pins (card recall-hybrid-scale)", () => {
  const NOW = new Date("2026-09-30T00:00:00.000Z");
  const DAY = 86400000;
  const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * DAY).toISOString();
  const MODEL = { model: "fake-model", dims: 3 };
  const qprov = () => fakeProvider({ vectorFor: () => [1, 0, 0] });
  const put = (db, id, vec, created, citation) => {
    addLesson(db, { id, text: `pintext ${id}`, kind: "pattern", citation, source: { agent: "worker" }, created });
    setLessonEmbedding(db, id, { ...MODEL, vector: Float32Array.from(vec) });
  };
  const run = (db, opts = {}) => recallLessons(db, "nomatchquery", { provider: qprov(), now: NOW, k: 20, ...opts });

  beforeEach(() => {
    clearRecallCache();
    m = openMemory(dir);
  });

  it("a lesson recall marks stale (failed citation) is gone from the next recall served by the cache", async () => {
    const checkoutDir = mkdtempSync(join(tmpdir(), "doug-memory-pin-"));
    mkdirSync(join(checkoutDir, ".doug"), { recursive: true });
    mkdirSync(join(checkoutDir, "src"), { recursive: true });
    writeFileSync(join(checkoutDir, "src", "a.mjs"), "line one\nline two\n", "utf8");
    try {
      put(m, "pa", [1, 0, 0], daysAgo(5), 'src/a.mjs:2 "line moved"'); // fails its citation, ranks first
      put(m, "pb", [0.5, 0.5, 0], daysAgo(5));
      const first = await run(m, { checkoutDir });
      expect(first.checked).toBe(true);
      expect(first.lessons.map((l) => l.id)).toEqual(["pb"]);
      expect(getLesson(m, "pa").stale).not.toBeNull();
      // No checkoutDir: nothing re-checks, so only the cached rows can still hold pa.
      const second = await run(m);
      expect(second.lessons.map((l) => l.id)).toEqual(["pb"]);
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("a lesson recall confirms is scored with its new confirmed date on the next cached recall", async () => {
    const checkoutDir = mkdtempSync(join(tmpdir(), "doug-memory-pin-"));
    mkdirSync(join(checkoutDir, ".doug"), { recursive: true });
    mkdirSync(join(checkoutDir, "src"), { recursive: true });
    writeFileSync(join(checkoutDir, "src", "a.mjs"), "line one\nline two\n", "utf8");
    try {
      put(m, "pc", [1, 0, 0], daysAgo(80), 'src/a.mjs:2 "line two"');
      const first = await run(m, { checkoutDir, staleDays: 120 });
      expect(first.lessons.map((l) => l.id)).toEqual(["pc"]);
      expect(getLesson(m, "pc").confirmed).toBe(NOW.toISOString());
      const cached = await run(m, { staleDays: 120 });
      clearRecallCache();
      const fresh = await run(m, { staleDays: 120 });
      expect(fresh.lessons[0].score).toBeGreaterThan(0.99); // age 0 now: recency weight 1
      expect(cached.lessons.map((l) => [l.id, l.score])).toEqual(fresh.lessons.map((l) => [l.id, l.score]));
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  it("rows dropped as too old at a later now come back for a call with an earlier now", async () => {
    put(m, "pd", [1, 0, 0], daysAgo(35));
    put(m, "pe", [0.5, 0.5, 0], daysAgo(2));
    const later = await run(m, { staleDays: 30 });
    expect(later.lessons.map((l) => l.id)).toEqual(["pe"]);
    const earlierNow = new Date(NOW.getTime() - 10 * DAY); // pd is 25 days old then
    const earlier = await run(m, { staleDays: 30, now: earlierNow });
    // pe was created after the earlier now: its age is negative, still fresh.
    expect(earlier.lessons.map((l) => l.id).sort()).toEqual(["pd", "pe"]);
  });

  it("the SQL freshness margin keeps a zone-less date-time JS reads as fresh (child process, TZ=Etc/GMT+12)", () => {
    const memUrl = new URL("../lib/memory.mjs", import.meta.url).href;
    const script = `
      import { openMemory, addLesson, setLessonEmbedding, recallLessons } from ${JSON.stringify(memUrl)};
      const m = openMemory(process.argv[1]);
      addLesson(m, { id: "tz1", text: "tz", kind: "pattern", source: { agent: "worker" }, created: "2026-08-31T00:00:00" });
      setLessonEmbedding(m, "tz1", { model: "fake-model", dims: 3, vector: Float32Array.from([1, 0, 0]) });
      const provider = { name: "fake", model: "fake-model", dims: 3, async embed(t) { return { ok: true, vectors: t.map(() => Float32Array.from([1, 0, 0])) }; } };
      const now = new Date("2026-09-30T06:00:00.000Z");
      const r = await recallLessons(m, "nomatchquery", { provider, now, staleDays: 30, k: 5 });
      console.log(JSON.stringify({ anchorIso: new Date("2026-08-31T00:00:00").toISOString(), mode: r.mode, ids: r.lessons.map((l) => l.id) }));
      m.close();
    `;
    const tzDir = mkdtempSync(join(tmpdir(), "doug-memory-tz-"));
    try {
      const res = spawnSync(process.execPath, ["--input-type=module", "-e", script, tzDir], {
        encoding: "utf8",
        env: { ...process.env, TZ: "Etc/GMT+12" },
      });
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout.trim().split("\n").pop());
      expect(out.anchorIso).toBe("2026-08-31T12:00:00.000Z"); // the premise: JS reads it 12 hours after SQLite
      expect(out.mode).toBe("hybrid");
      expect(out.ids).toEqual(["tz1"]);
    } finally {
      rmSync(tzDir, { recursive: true, force: true });
    }
  });

  describe("staleDays: NaN keeps nothing, as before the cache", () => {
    beforeEach(() => {
      addLesson(m, { id: "nk", text: "nanword alpha", kind: "pattern", source: { agent: "worker" }, created: daysAgo(1) });
      setLessonEmbedding(m, "nk", { ...MODEL, vector: Float32Array.from([1, 0, 0]) });
    });

    it("keyword-only mode", async () => {
      const result = await recallLessons(m, "nanword", { now: NOW, staleDays: NaN });
      expect(result.mode).toBe("keyword-only");
      expect(result.lessons).toEqual([]);
    });

    it("hybrid mode", async () => {
      const result = await recallLessons(m, "nanword", { provider: qprov(), now: NOW, staleDays: NaN });
      expect(result.lessons).toEqual([]);
    });
  });
});

describe("windowHidden / windowNote (card recall-window-report)", () => {
  const NOW = new Date("2026-09-30T00:00:00.000Z");
  const DAY = 86400000;
  const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString();

  beforeEach(() => {
    m = openMemory(dir);
  });

  const build = () => {
    const mk = (id, created, confirmed) => {
      addLesson(m, { id, text: `freshword ${id}`, kind: "pattern", source: { agent: "worker" }, created });
      if (confirmed !== undefined) m.prepare("UPDATE lessons SET confirmed = ? WHERE id = ?").run(confirmed, id);
    };
    mk("f-garbled", "not-a-date");
    mk("f-js-old", "Aug 1 2026");
    mk("f-js-new", "Sep 25 2026");
    mk("f-slash-old", "2026/08/01");
    mk("f-exact", daysAgo(30));
    mk("f-over", new Date(NOW.getTime() - 30 * DAY - 60000).toISOString());
    mk("f-conf-fresh", daysAgo(200), daysAgo(1));
    mk("f-conf-old", daysAgo(1), daysAgo(200));
    mk("f-conf-garbled", daysAgo(200), "garbage");
    mk("f-conf-empty", daysAgo(200), "");
    mk("f-created-empty", "");
    mk("f-future", daysAgo(-5));
  };

  it("windowHidden over the freshness fixture returns count 5, total 12", () => {
    build();
    const h = windowHidden(m, { staleDays: 30, now: NOW });
    expect(h.count).toBe(5);
    expect(h.total).toBe(12);
  });

  it("windowHidden over the freshness fixture returns oldestDays 200", () => {
    build();
    expect(windowHidden(m, { staleDays: 30, now: NOW }).oldestDays).toBe(200);
  });

  it("recallLessons carries hidden, and kept plus hidden equals total", async () => {
    build();
    const r = await recallLessons(m, "freshword", { now: NOW, staleDays: 30, k: 50 });
    expect(r.hidden).toEqual({ count: 5, total: 12, oldestDays: 200 });
    expect(r.lessons.length + r.hidden.count).toBe(r.hidden.total);
  });

  it("windowHidden ignores superseded and stale rows", () => {
    addLesson(m, { id: "live", text: "live one", kind: "pattern", source: { agent: "worker" }, created: daysAgo(1) });
    addLesson(m, { id: "old-live", text: "old live", kind: "pattern", source: { agent: "worker" }, created: daysAgo(100) });
    addLesson(m, { id: "old-sup", text: "old sup", kind: "pattern", source: { agent: "worker" }, created: daysAgo(300) });
    addLesson(m, { id: "old-stale", text: "old stale", kind: "pattern", source: { agent: "worker" }, created: daysAgo(400) });
    m.prepare("UPDATE lessons SET superseded_by = 'live' WHERE id = 'old-sup'").run();
    m.prepare("UPDATE lessons SET stale = ? WHERE id = 'old-stale'").run(daysAgo(1));
    expect(windowHidden(m, { staleDays: 30, now: NOW })).toEqual({ count: 1, total: 2, oldestDays: 100 });
  });

  it("windowHidden honours staleDays", () => {
    addLesson(m, { id: "a", text: "fresh", kind: "pattern", source: { agent: "worker" }, created: daysAgo(1) });
    addLesson(m, { id: "b", text: "twenty", kind: "pattern", source: { agent: "worker" }, created: daysAgo(20) });
    expect(windowHidden(m, { staleDays: 30, now: NOW }).count).toBe(0);
    expect(windowHidden(m, { staleDays: 10, now: NOW })).toEqual({ count: 1, total: 2, oldestDays: 20 });
  });

  it("windowHidden with nothing hidden has count 0 and oldestDays null", () => {
    addLesson(m, { id: "a", text: "fresh", kind: "pattern", source: { agent: "worker" }, created: daysAgo(1) });
    expect(windowHidden(m, { staleDays: 30, now: NOW })).toEqual({ count: 0, total: 1, oldestDays: null });
  });

  it("windowNote is exact when something is hidden and null when nothing is", () => {
    expect(windowNote({ count: 5, total: 12, oldestDays: 200 }, 30)).toBe("window: hid 5 of 12 live lessons older than 30 days (oldest 200 days)");
    expect(windowNote({ count: 0, total: 12, oldestDays: null }, 30)).toBeNull();
  });
});

// Card memory-record-stops: a stopped hand card report yields one outcome row; blocks.jsonl lines are attributed to the run by agent id.
describe("card memory-record-stops: stop rows", () => {
  const NOW = "2026-10-18T00:00:00.000Z";
  const H1 = "aaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const H2 = "cccccccccccceeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const rep = (extra = {}) => ({ outcome: "stopped", reason: "hook-blocked", stoppedAt: "reviewer", detail: "protect-paths refused X", card: { id: "c1" }, history: [], ...extra });
  const L = (o) => JSON.stringify(o);

  it("M1: stopOutcomeRow maps reason to stop_class and detail to stop_reason, on the hand track with no commit", () => {
    const row = stopOutcomeRow({ card: "c1", report: rep(), reportHash: H1, reportPath: "/p/card-report.json", run: "wf_1", now: NOW });
    expect(row.stop_class).toBe("hook-blocked");
    expect(row.stop_reason).toBe("protect-paths refused X");
    expect(row.track).toBe("hand");
    expect(row.task).toBe("c1");
    expect(row.card).toBe("c1");
    expect(row.commit_sha).toBeNull();
    expect(row.run).toBe("stop:aaaaaaaaaaaa");
    expect(row.run_id).toBe("wf_1");
    expect(row.report_hash).toBe(H1);
    expect(row.report_path).toBe("/p/card-report.json");
    expect(row.recorded).toBe(NOW);
  });

  it("stop_reason falls back to reason when detail is null or blank; run_id defaults to null", () => {
    for (const detail of [null, "", "   "]) {
      const row = stopOutcomeRow({ card: "c1", report: rep({ detail }), reportHash: H1, now: NOW });
      expect(row.stop_reason).toBe("hook-blocked");
      expect(row.stop_class).toBe("hook-blocked");
      expect(row.run_id).toBeNull();
    }
  });

  it("throws unless card is non-empty and the report is stopped", () => {
    expect(() => stopOutcomeRow({ card: "", report: rep(), reportHash: H1, now: NOW })).toThrow();
    expect(() => stopOutcomeRow({ report: rep(), reportHash: H1, now: NOW })).toThrow();
    expect(() => stopOutcomeRow({ card: "c1", report: rep({ outcome: "done" }), reportHash: H1, now: NOW })).toThrow();
  });

  it("M2/M3: the same report hash is one row, a different report of the same card adds a row", () => {
    m = openMemory(dir);
    const a = stopOutcomeRow({ card: "c1", report: rep(), reportHash: H1, now: NOW });
    recordOutcomes(m, [a]);
    recordOutcomes(m, [stopOutcomeRow({ card: "c1", report: rep(), reportHash: H1, now: "2026-10-19T00:00:00.000Z" })]);
    expect(listOutcomes(m, { task: "c1" })).toHaveLength(1);
    recordOutcomes(m, [stopOutcomeRow({ card: "c1", report: rep({ reason: "design-decision", detail: "which?" }), reportHash: H2, now: NOW })]);
    const rows = listOutcomes(m, { task: "c1" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.stop_class).sort()).toEqual(["design-decision", "hook-blocked"]);
  });

  it("M4: a landing row for the same card sits beside the stop row without touching it", () => {
    m = openMemory(dir);
    recordOutcomes(m, [stopOutcomeRow({ card: "c1", report: rep(), reportHash: H1, now: NOW })]);
    recordOutcomes(m, [handOutcomeRow({ card: "c1", commit: "sha9", now: NOW })]);
    const rows = listOutcomes(m, { task: "c1" });
    expect(rows).toHaveLength(2);
    const stop = rows.find((r) => r.run.startsWith("stop:"));
    expect(stop.stop_class).toBe("hook-blocked");
    expect(stop.stop_reason).toBe("protect-paths refused X");
    expect(stop.commit_sha).toBeNull();
    expect(rows.find((r) => r.run === "hand:sha9").stop_class).toBeNull();
  });

  it("blockAgentId reads agentId when a string, else the id in a subagent-stop reason, else null", () => {
    expect(blockAgentId({ agentId: "a123" , reason: "x"})).toBe("a123");
    expect(blockAgentId({ reason: "[doug] Subagent doug-flow:coder (a1111111111111111) cannot report done: x" })).toBe("a1111111111111111");
    expect(blockAgentId({ reason: "[doug] main session cannot stop" })).toBeNull();
    expect(blockAgentId({ agentId: 5, reason: "plain" })).toBeNull();
  });

  it("runAgentIds collects every agentId and skips malformed lines", () => {
    const t1 = [L({ type: "started", agentId: "a1" }), "{not json", L({ type: "result", agentId: "a2" }), L({ type: "launched" })].join("\n");
    const t2 = L({ type: "started", agentId: "a3" }) + "\n";
    const ids = runAgentIds([t1, t2]);
    expect([...ids].sort()).toEqual(["a1", "a2", "a3"]);
    expect(runAgentIds([]).size).toBe(0);
  });

  it("M5: attributeBlocks keeps only lines of the run's agents, in file order; main-session and malformed lines are dropped", () => {
    const mine = { hook: "subagent-stop", at: "t1", agent: "doug-flow:coder", class: "real", reason: "[doug] Subagent doug-flow:coder (a1111111111111111) cannot report done: x" };
    const other = { hook: "subagent-stop", at: "t2", agent: "doug-flow:coder", class: "real", reason: "[doug] Subagent doug-flow:coder (a2222222222222222) cannot report done: y" };
    const main = { hook: "stop-gate", at: "t3", agent: null, class: "real", reason: "gate red" };
    const mine2 = { hook: "subagent-stop", at: "t4", agent: "doug-flow:tester", class: "expected-red", reason: "[doug] Subagent doug-flow:tester (a1111111111111111) cannot report done: z" };
    const text = [L(mine), L(other), "garbage", L(main), L(mine2)].join("\n") + "\n";
    const got = attributeBlocks(text, new Set(["a1111111111111111"]));
    expect(got.map((b) => b.at)).toEqual(["t1", "t4"]);
    expect(attributeBlocks(text, new Set())).toEqual([]);
  });

  it("M6: the stop row stores the attributed blocks as {at, hook, agent, class, reason}", () => {
    m = openMemory(dir);
    const line = { hook: "subagent-stop", at: "t1", agent: "doug-flow:coder", class: "real", reason: "[doug] Subagent doug-flow:coder (a1) cannot report done", cwd: "/x", failures: [1] };
    const row = stopOutcomeRow({ card: "c1", report: rep(), reportHash: H1, blocks: [line], now: NOW });
    expect(row.blocks).toEqual([{ at: "t1", hook: "subagent-stop", agent: "doug-flow:coder", class: "real", reason: line.reason }]);
    recordOutcomes(m, [row]);
    expect(listOutcomes(m, { task: "c1" })[0].blocks).toEqual(row.blocks);
    expect(stopOutcomeRow({ card: "c1", report: rep(), reportHash: H1, now: NOW }).blocks ?? []).toEqual([]);
  });
});

// Card memory-run-history (ADR 0019 L0): append-only run-history files per card, with whole-entry redaction and size caps.
describe("card memory-run-history: history lib", () => {
  const scan = (t) => scanText(t, {});
  // Secret fixtures are built at runtime so the secret-scan hook does not refuse this file.
  const PEM_HEAD = "-----BEGIN " + "RSA PRIVATE" + " KEY-----";
  const GH = "gh" + "p_" + "A1b2C3d4".repeat(5);
  const CARD = { id: "c1", title: "A card", size: "M", class: "code", goal: "Do the thing exactly." };
  const WT = "/abs/worktree/c1";
  const QA = (over = {}) => ({ card: CARD, options: {}, repoRoot: "/abs/repo", worktreePath: WT, ...over });
  const MUT = [{ id: "M1", case: "case one", mutation: "remove the check", test: "T01" }];
  const HBS = [
    { seat: "setup", worktree: WT, branch: "card/c1", install: null },
    { seat: "lead", lessons: "LESSON-ONE", facts: [{ text: "the fact", source: "docs/x.md:3" }], unverified: [], testFiles: ["a.test.mjs"], mutations: MUT },
    { seat: "tester", files: ["a.test.mjs"], tests_red_by_design: ["a.test.mjs"], mutationResults: [{ id: "M1", failed: true, test: "T01", assertion: "expected x" }] },
  ];
  // Drives the real card-loop with the three hand-backs; the expected brief is the test's own briefPrompt output.
  function drive() {
    let s = initialState(CARD, {});
    const briefs = [];
    for (const hb of HBS) {
      const a = currentAction(s);
      expect(a.kind).toBe("seat");
      expect(a.seat).toBe(hb.seat);
      briefs.push(briefPrompt(a.brief, { repoRoot: "/abs/repo", worktreePath: WT }));
      s = loopNext(s, hb).state;
    }
    expect(currentAction(s).seat).toBe("coder");
    return briefs;
  }
  const runs = () => HBS.map((hb, i) => ({ seat: hb.seat, round: 1, agentId: "agent" + i, result: hb }));
  const L = (o) => JSON.stringify(o);

  it("exports the directory and the two caps", () => {
    expect(HISTORY_DIR_RELPATH).toBe(".doug/.state/history");
    expect(HISTORY_ENTRY_MAX_BYTES).toBe(65536);
    expect(HISTORY_RUN_MAX_BYTES).toBe(1048576);
  });

  describe("historyEntry", () => {
    it("a clean string keeps its text and records kind, seat, round, source, bytes", () => {
      const e = historyEntry({ kind: "brief", seat: "lead", round: 2, source: "replay", value: "hello \u00e9" }, { scan });
      expect(e).toEqual({ kind: "brief", seat: "lead", round: 2, source: "replay", bytes: 8, truncated: false, redacted: null, text: "hello \u00e9" });
      const d = historyEntry({ kind: "report", source: "card-report.json", value: "x" }, { scan });
      expect(d.seat).toBeNull();
      expect(d.round).toBeNull();
    });

    it("an object value is stored as pretty JSON and null as the text 'null'", () => {
      const v = { a: 1, b: ["x"] };
      expect(historyEntry({ kind: "k", source: "s", value: v }, { scan }).text).toBe(JSON.stringify(v, null, 2));
      expect(historyEntry({ kind: "k", source: "s", value: null }, { scan }).text).toBe("null");
    });

    it("M9: a PEM header followed by body lines redacts the whole entry, not just the header line", () => {
      const value = ["before", PEM_HEAD, "BODYLINE-SECRET-ONE", "BODYLINE-SECRET-TWO", "-----END " + "RSA PRIVATE" + " KEY-----"].join("\n");
      const e = historyEntry({ kind: "hand-back", source: "s", value }, { scan });
      expect(e.redacted).toBe("pemPrivateKey");
      expect(e.text).toBe("[redacted: pemPrivateKey]");
      expect(e.text).not.toContain("BODYLINE");
      expect(e.text).not.toContain("before");
    });

    it("a secret inside an object value redacts the whole serialized entry", () => {
      const e = historyEntry({ kind: "report", source: "s", value: { detail: "token " + GH, other: "keep-me-not" } }, { scan });
      expect(e.redacted).toBe("githubToken");
      expect(e.text).toBe("[redacted: githubToken]");
    });

    it("M10: redaction runs on the whole text before the cap (a secret past the cap is still found)", () => {
      const value = "x".repeat(66000) + " " + GH + " " + "y".repeat(4000);
      expect(Buffer.byteLength(value)).toBeGreaterThan(70000);
      const e = historyEntry({ kind: "k", source: "s", value }, { scan });
      expect(e.redacted).toBe("githubToken");
      expect(e.text).toBe("[redacted: githubToken]");
      expect(e.truncated).toBe(false);
    });

    it("M11: no scanner and a throwing scanner both fail closed", () => {
      const a = historyEntry({ kind: "k", source: "s", value: "plain text" }, {});
      expect(a.redacted).toBe("no-scanner");
      expect(a.text).toBe("[redacted: no-scanner]");
      const b = historyEntry({ kind: "k", source: "s", value: "plain text" }, { scan: "not a function" });
      expect(b.text).toBe("[redacted: no-scanner]");
      const c = historyEntry({ kind: "k", source: "s", value: "plain text" }, { scan: () => { throw new Error("boom"); } });
      expect(c.redacted).toBe("scan-error");
      expect(c.text).toBe("[redacted: scan-error]");
      expect(historyEntry({ kind: "k", source: "s", value: "plain" }).text).toBe("[redacted: no-scanner]");
    });

    it("the scanner is called once with the whole untruncated text", () => {
      const seen = [];
      const value = "z".repeat(70000);
      historyEntry({ kind: "k", source: "s", value }, { scan: (t) => (seen.push(t), null) });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(value);
    });

    it("M12: an over-long value is cut to the byte cap, keeping the head, with bytes the full size", () => {
      const e = historyEntry({ kind: "k", source: "s", value: "a".repeat(70000) }, { scan });
      expect(e.truncated).toBe(true);
      expect(e.redacted).toBeNull();
      expect(e.bytes).toBe(70000);
      expect(Buffer.byteLength(e.text)).toBe(65536);
      expect(e.text).toBe("a".repeat(65536));
      const two = historyEntry({ kind: "k", source: "s", value: "\u00e9".repeat(40000) }, { scan });
      expect(two.bytes).toBe(80000);
      expect(Buffer.byteLength(two.text)).toBeLessThanOrEqual(65536);
      expect(two.text).toBe("\u00e9".repeat(32768));
    });

    it("M12: a multi-byte character straddling the cap is dropped whole, never split", () => {
      const e = historyEntry({ kind: "k", source: "s", value: "a".repeat(65535) + "\u00e9" + "bbbb" }, { scan });
      expect(e.truncated).toBe(true);
      expect(e.text).not.toContain("\ufffd");
      expect(e.text).toBe("a".repeat(65535));
      const f = historyEntry({ kind: "k", source: "s", value: "a".repeat(65534) + "\u{1F600}" + "c" }, { scan });
      expect(f.text).not.toContain("\ufffd");
      expect(f.text).toBe("a".repeat(65534));
    });

    it("maxBytes is honoured, and a value exactly at the cap is not truncated", () => {
      expect(historyEntry({ kind: "k", source: "s", value: "abcdefghij" }, { scan, maxBytes: 4 }).text).toBe("abcd");
      const at = historyEntry({ kind: "k", source: "s", value: "abcd" }, { scan, maxBytes: 4 });
      expect(at.truncated).toBe(false);
      expect(at.text).toBe("abcd");
    });
  });

  describe("journalSeatRuns", () => {
    it("M4: pairs started and result lines by key into seat runs, in started-line order", () => {
      const lines = [
        L({ type: "started", key: "k0", agentId: "agent0", label: "setup:c1:1", phase: "x" }),
        L({ type: "started", key: "k1", agentId: "agent1", label: "lead:c1:1" }),
        "{broken",
        L({ type: "result", key: "k1", agentId: "agent1", result: HBS[1] }),
        L({ type: "started", key: "k2", agentId: "agent2", label: "tester:c1:3" }),
        L({ type: "result", key: "k0", agentId: "agent0", result: HBS[0] }),
        L({ type: "result", key: "k2", agentId: "agent2", result: HBS[2] }),
      ];
      expect(journalSeatRuns(lines.join("\n") + "\n")).toEqual([
        { seat: "setup", round: 1, agentId: "agent0", result: HBS[0] },
        { seat: "lead", round: 1, agentId: "agent1", result: HBS[1] },
        { seat: "tester", round: 3, agentId: "agent2", result: HBS[2] },
      ]);
    });

    it("a started line with no result gives result null; a result with no started line is ignored; a non-integer round is null", () => {
      const lines = [
        L({ type: "started", key: "k0", agentId: "agent0", label: "setup:c1:1" }),
        L({ type: "result", key: "k0", agentId: "agent0", result: HBS[0] }),
        L({ type: "started", key: "k1", agentId: "agent1", label: "lead:c1:abc" }),
        L({ type: "started", key: "k2", agentId: "agent2", label: "tester:c1:2" }),
        L({ type: "result", key: "orphan", agentId: "agentX", result: { seat: "coder" } }),
        L({ type: "result", key: "k2", agentId: "agent2", result: HBS[2] }),
      ];
      expect(journalSeatRuns(lines.join("\n"))).toEqual([
        { seat: "setup", round: 1, agentId: "agent0", result: HBS[0] },
        { seat: "lead", round: null, agentId: "agent1", result: null },
        { seat: "tester", round: 2, agentId: "agent2", result: HBS[2] },
      ]);
    });

    it("never throws on empty or odd input", () => {
      expect(journalSeatRuns("")).toEqual([]);
      expect(journalSeatRuns(undefined)).toEqual([]);
      expect(journalSeatRuns("not json\n[1,2]\n")).toEqual([]);
    });
  });

  describe("replayBriefs", () => {
    it("M5: a three-seat run replays to exactly the briefPrompt text of each seat", () => {
      const expected = drive();
      const got = replayBriefs(QA(), runs());
      expect(got).toEqual(expected);
      expect(new Set(got).size).toBe(3);
      expect(got[1]).toContain("SEAT: lead");
      expect(got[2]).toContain("SEAT: tester");
    });

    it("M6: a seat that does not match the contract's next seat yields null for it and every later entry", () => {
      const expected = drive();
      const r = runs();
      const got = replayBriefs(QA(), [r[0], r[2], r[1]]);
      expect(got).toEqual([expected[0], null, null]);
    });

    it("M6: a malformed queenArgs or card gives all null without throwing", () => {
      const r = runs();
      expect(replayBriefs(QA({ card: "h3" }), r)).toEqual([null, null, null]);
      expect(replayBriefs(null, r)).toEqual([null, null, null]);
      expect(replayBriefs("x", r)).toEqual([null, null, null]);
      expect(replayBriefs(QA({ card: { id: "c1" } }), r)).toEqual([null, null, null]);
      expect(replayBriefs(QA(), [])).toEqual([]);
    });

    it("a seat whose agent threw (result null) still gets its brief; later seats are null", () => {
      const expected = drive();
      const r = runs();
      const got = replayBriefs(QA(), [r[0], { ...r[1], result: null }, r[2]]);
      expect(got).toEqual([expected[0], expected[1], null]);
    });
  });

  describe("attributeDenials", () => {
    it("M8: returns only this run's PermissionDenied lines, in file order", () => {
      const mine1 = { t: 1, event: "PermissionDenied", agent: "agent0", tool: "Bash", detail: "d1", ok: false };
      const mine2 = { t: 4, event: "PermissionDenied", agent: "agent1", tool: "Write", detail: "d2", ok: false };
      const lines = [
        L(mine1),
        L({ t: 2, event: "PreToolUse", agent: "agent0", tool: "Bash" }),
        L({ t: 3, event: "PermissionDenied", agent: "other", tool: "Bash" }),
        "{broken",
        L({ t: 3.5, event: "PermissionDenied", agent: null, tool: "Bash" }),
        L(mine2),
      ];
      expect(attributeDenials(lines.join("\n") + "\n", new Set(["agent0", "agent1"]))).toEqual([mine1, mine2]);
      expect(attributeDenials("", new Set(["agent0"]))).toEqual([]);
      expect(attributeDenials(undefined, new Set())).toEqual([]);
    });
  });

  describe("writeRunHistory", () => {
    const entry = (n, text = "text " + n) => ({ kind: "hand-back", seat: "lead", round: n, source: "journal.jsonl", value: text });
    const read = (p) => readFileSync(p, "utf8").split("\n").filter((x) => x !== "").map((x) => JSON.parse(x));

    it("writes one JSON line per entry under <dir>/.doug/.state/history/<card>/<run>.jsonl", () => {
      const r = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3)], scan });
      expect(r.path).toBe(join(dir, ".doug/.state/history", "c1", "wf_1.jsonl"));
      expect(r.written).toBe(true);
      expect(r.lines).toBe(3);
      expect(r.truncated).toBe(0);
      expect(r.dropped).toBe(0);
      const rows = read(r.path);
      expect(rows).toHaveLength(3);
      expect(rows[1]).toEqual({ kind: "hand-back", card: "c1", run: "wf_1", seat: "lead", round: 2, source: "journal.jsonl", bytes: 6, truncated: false, redacted: null, text: "text 2" });
      expect(rows.map((x) => x.kind)).not.toContain("cap");
    });

    it("M1: an existing run file is never rewritten", () => {
      const first = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2)], scan });
      const before = readFileSync(first.path);
      const second = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(7), entry(8), entry(9)], scan });
      expect(second.path).toBe(first.path);
      expect(second.written).toBe(false);
      expect(second.lines).toBe(0);
      expect(readFileSync(first.path).equals(before)).toBe(true);
    });

    it("different runs of one card get their own files", () => {
      const a = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1)], scan });
      const b = writeRunHistory(dir, { card: "c1", run: "wf_2", entries: [entry(2)], scan });
      expect(a.written).toBe(true);
      expect(b.written).toBe(true);
      expect(a.path).not.toBe(b.path);
    });

    it("redacts each entry on write and counts truncated entries; the secret body appears nowhere in the file", () => {
      const pem = [PEM_HEAD, "BODYLINE-IN-THE-KEY", "more"].join("\n");
      const r = writeRunHistory(dir, {
        card: "c1",
        run: "wf_1",
        entries: [entry(1, pem), entry(2, "q".repeat(300)), entry(3, "fine")],
        scan,
        maxEntryBytes: 100,
      });
      const rows = read(r.path);
      expect(rows[0].redacted).toBe("pemPrivateKey");
      expect(rows[0].text).toBe("[redacted: pemPrivateKey]");
      expect(rows[1].truncated).toBe(true);
      expect(rows[1].text).toBe("q".repeat(100));
      expect(rows[2].text).toBe("fine");
      expect(r.truncated).toBe(1);
      expect(readFileSync(r.path, "utf8")).not.toContain("BODYLINE");
    });

    it("M13: a small run cap keeps the lines that fit, drops the rest, and ends with a cap line naming the count", () => {
      const probe = writeRunHistory(join(dir, "probe"), { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3), entry(4), entry(5)], scan });
      const lens = readFileSync(probe.path, "utf8").split("\n").filter((x) => x !== "").map((x) => Buffer.byteLength(x) + 1);
      const cap = lens[0] + lens[1] + 3;
      const r = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3), entry(4), entry(5)], scan, maxRunBytes: cap });
      expect(r.written).toBe(true);
      expect(r.dropped).toBe(3);
      const rows = read(r.path);
      expect(rows).toHaveLength(3);
      expect(rows.slice(0, 2).map((x) => x.round)).toEqual([1, 2]);
      expect(rows[2]).toEqual({ kind: "cap", card: "c1", run: "wf_1", dropped: 3, maxRunBytes: cap });
      const kept = rows.slice(0, 2).reduce((n, _, i) => n + lens[i], 0);
      expect(kept).toBeLessThanOrEqual(cap);
    });

    it("memory-pin-gaps: a smaller entry after one that overflows the run cap is dropped too, and the cap line counts both", () => {
      const set = [entry(1, "s"), entry(2, "B".repeat(300)), entry(3, "s")];
      const probe = writeRunHistory(join(dir, "probe"), { card: "c1", run: "wf_1", entries: [set[0], set[2]], scan });
      const cap = Buffer.byteLength(readFileSync(probe.path, "utf8")) + 5;
      const r = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: set, scan, maxRunBytes: cap });
      expect(r.dropped).toBe(2);
      const rows = read(r.path);
      expect(rows.map((x) => x.kind)).toEqual(["hand-back", "cap"]);
      expect(rows[0].round).toBe(1);
      expect(rows[1].dropped).toBe(2);
      expect(rows.some((x) => x.round === 3)).toBe(false);
    });

    it("an entry that fits exactly is kept; with no overflow there is no cap line", () => {
      const probe = writeRunHistory(join(dir, "probe"), { card: "c1", run: "wf_1", entries: [entry(1), entry(2)], scan });
      const total = Buffer.byteLength(readFileSync(probe.path, "utf8"));
      const r = writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2)], scan, maxRunBytes: total });
      expect(r.dropped).toBe(0);
      expect(read(r.path).map((x) => x.kind)).toEqual(["hand-back", "hand-back"]);
    });

    it("M14: card and run names cannot escape the history directory", () => {
      const r = writeRunHistory(dir, { card: "../evil", run: "a/b", entries: [entry(1)], scan });
      const root = join(dir, ".doug/.state/history");
      expect(resolve(r.path).startsWith(root + sep)).toBe(true);
      expect(existsSync(r.path)).toBe(true);
      expect(existsSync(join(dir, "evil"))).toBe(false);
      expect(existsSync(join(dir, ".doug/.state/evil"))).toBe(false);
      expect(read(r.path)[0].card).toBe("../evil");
    });
  });
});

// Card memory-outcome-arms (ADR 0019): the memory configuration stamped into the outcome condition, and the arm report.
describe("memoryConfig (card memory-outcome-arms)", () => {
  it("M2: carries embeddings provider, model and dims only (no baseUrl, apiKeyEnv or preset); null stays null", () => {
    const dense = memoryConfig({
      embeddings: { preset: "p", provider: "openai-compatible", baseUrl: "http://x/v1", model: "embeddinggemma", dims: 768, apiKeyEnv: "KEY" },
      staleDays: 30,
    });
    expect(dense.embeddings).toEqual({ provider: "openai-compatible", model: "embeddinggemma", dims: 768 });
    expect(memoryConfig({ embeddings: null, staleDays: 30 }).embeddings).toBeNull();
  });

  it("M3: carries staleDays from the argument", () => {
    expect(memoryConfig({ embeddings: null, staleDays: 14 }).staleDays).toBe(14);
    expect(memoryConfig({ embeddings: null, staleDays: 7 }).staleDays).toBe(7);
  });

  it("has the stage, the recall size and the char budgets, and is pure", () => {
    // Card memory-progressive-access: delivery changed from the 400-character cut to index plus fetch, so the stage
    // is bumped (a new outcome arm) and the hand track no longer reports per-lesson or total character cuts.
    expect(MEMORY_STAGE).toBe("progressive-access");
    const a = memoryConfig({ embeddings: null, staleDays: 30 });
    expect(a).toEqual({ stage: "progressive-access", embeddings: null, staleDays: 30, k: 8, delivery: "index+fetch", indexChars: 2000 });
    expect(memoryConfig({ embeddings: null, staleDays: 30 })).toEqual(a);
  });
});

describe("memoryConfig track (card memory-flow-index-fetch)", () => {
  const HAND = { stage: "progressive-access", embeddings: null, staleDays: 30, k: 8, delivery: "index+fetch", indexChars: 2000 };
  const FLOW = { stage: "progressive-access", embeddings: null, staleDays: 30, k: 8, delivery: "index+fetch", indexChars: 2000, fetch: "top-k", fetchTokens: 4000 };
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

  it("M1: the hand track is index+fetch, explicitly or by default", () => {
    expect(memoryConfig({ embeddings: null, staleDays: 30, track: "hand" })).toEqual(HAND);
    expect(memoryConfig({ embeddings: null, staleDays: 30 })).toEqual(HAND);
  });

  it("M2: the flow track records index+fetch with a top-k fetch of 4000 tokens, not the cut", () => {
    const c = memoryConfig({ embeddings: null, staleDays: 30, track: "flow" });
    expect(c).toEqual(FLOW);
    expect(c.delivery).toBe("index+fetch");
    expect(c.fetch).toBe("top-k");
    expect(c.fetchTokens).toBe(4000);
    expect(c.lessonChars).toBeUndefined();
    expect(c.totalChars).toBeUndefined();
  });

  it("M8: the flow stamp differs from the hand stamp, so flow and hand rows stay separate arms; the hand stamp has no fetch fields", () => {
    const flow = memoryConfig({ embeddings: null, staleDays: 30, track: "flow" });
    const hand = memoryConfig({ embeddings: null, staleDays: 30, track: "hand" });
    expect(JSON.stringify(canon(flow))).not.toBe(JSON.stringify(canon(hand)));
    expect(hand.fetchTokens).toBeUndefined();
    expect(hand.fetch).toBeUndefined();
  });

  it("M2: the flow stamp still carries embeddings and staleDays", () => {
    const c = memoryConfig({ embeddings: { provider: "p", model: "m", dims: 4, baseUrl: "x" }, staleDays: 14, track: "flow" });
    expect(c.embeddings).toEqual({ provider: "p", model: "m", dims: 4 });
    expect(c.staleDays).toBe(14);
  });

  it("M7: an unknown track throws instead of claiming a delivery", () => {
    expect(() => memoryConfig({ embeddings: null, staleDays: 30, track: "swarm" })).toThrow();
    expect(() => memoryConfig({ embeddings: null, staleDays: 30, track: "" })).toThrow();
  });

  it("M3: outcomeRows stamps every flow row with the canonical sorted-key JSON; null without the opt", () => {
    const shuffled = { fetchTokens: 4000, fetch: "top-k", indexChars: 2000, k: 8, staleDays: 30, embeddings: null, delivery: "index+fetch", stage: "progressive-access" };
    const rows = outcomeRows(buildReport(), { reportHash: "ab".repeat(16), now: "2026-10-20T00:00:00.000Z", memoryConfig: shuffled });
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(r.track).toBe("flow");
      expect(r.memory_config).toBe(JSON.stringify(canon(shuffled)));
      expect(r.memory_config).toBe(JSON.stringify(canon(FLOW)));
    }
    for (const r of outcomeRows(buildReport(), { reportHash: "cd".repeat(16), now: "2026-10-20T00:00:00.000Z" })) expect(r.memory_config).toBeNull();
    for (const r of outcomeRows(buildReport(), { reportHash: "ef".repeat(16), now: "2026-10-20T00:00:00.000Z", memoryConfig: null })) expect(r.memory_config).toBeNull();
  });
});

describe("memory_config on outcome rows (card memory-outcome-arms)", () => {
  const CFG = { stage: "baseline", embeddings: { provider: "ollama", model: "m", dims: 4 }, staleDays: 30, k: 8, lessonChars: 400, totalChars: 2000 };
  const CANON = '{"embeddings":{"dims":4,"model":"m","provider":"ollama"},"k":8,"lessonChars":400,"stage":"baseline","staleDays":30,"totalChars":2000}';
  const cond = (memoryConfigValue) => ({ harnessCommit: "h1", configHash: "c1", class: "code", arm: "code/default", assignedBy: "policy", exploreProbability: null, ...(memoryConfigValue === undefined ? {} : { memoryConfig: memoryConfigValue }) });

  it("M4: handOutcomeRow copies condition.memoryConfig as sorted-key JSON", () => {
    expect(handOutcomeRow({ card: "c", commit: "s1", condition: cond(CFG) }).memory_config).toBe(CANON);
  });

  it("M5: equal configurations with different key order (nested too) give identical strings", () => {
    const shuffled = { totalChars: 2000, lessonChars: 400, k: 8, staleDays: 30, embeddings: { dims: 4, provider: "ollama", model: "m" }, stage: "baseline" };
    const a = handOutcomeRow({ card: "c", commit: "s1", condition: cond(CFG) }).memory_config;
    const b = handOutcomeRow({ card: "c", commit: "s1", condition: cond(shuffled) }).memory_config;
    expect(b).toBe(a);
    expect(b).toBe(CANON);
  });

  it("is null without a condition, or when the condition has no memoryConfig", () => {
    expect(handOutcomeRow({ card: "c", commit: "s1" }).memory_config).toBeNull();
    expect(handOutcomeRow({ card: "c", commit: "s1", condition: cond() }).memory_config).toBeNull();
  });

  it("stopOutcomeRow passes the condition through; without one every condition column is null", () => {
    const report = { outcome: "stopped", reason: "hook-blocked", detail: "d" };
    const stamped = stopOutcomeRow({ card: "c", report, reportHash: "ab".repeat(16), condition: cond(CFG) });
    expect(stamped.memory_config).toBe(CANON);
    expect(stamped.harness_commit).toBe("h1");
    expect(stamped.arm).toBe("code/default");
    expect(stamped.commit_sha).toBeNull();
    const bare = stopOutcomeRow({ card: "c", report, reportHash: "ab".repeat(16) });
    expect(bare.memory_config).toBeNull();
    expect(bare.harness_commit).toBeNull();
  });

  it("M7: a later re-record of the same run and task without a condition keeps the memory stamp; a new stamp replaces it", () => {
    m = openMemory(dir);
    recordOutcomes(m, [handOutcomeRow({ card: "c", commit: "s1", condition: cond(CFG) })]);
    recordOutcomes(m, [handOutcomeRow({ card: "c", commit: "s1" })]);
    expect(listOutcomes(m, { task: "c" })[0].memory_config).toBe(CANON);
    const other = { ...CFG, staleDays: 7 };
    recordOutcomes(m, [handOutcomeRow({ card: "c", commit: "s1", condition: cond(other) })]);
    expect(JSON.parse(listOutcomes(m, { task: "c" })[0].memory_config).staleDays).toBe(7);
  });

  it("M6: a v9 store opens at v11 with a nullable memory_config column and old rows null", () => {
    m = openMemory(dir);
    recordOutcomes(m, [handOutcomeRow({ card: "old", commit: "s0", condition: cond(CFG) })]);
    if (m.prepare("PRAGMA table_info(outcomes)").all().some((c) => c.name === "memory_config")) {
      m.exec("ALTER TABLE outcomes DROP COLUMN memory_config;");
    }
    m.exec("PRAGMA user_version = 9;");
    m.close();
    const v9 = new DatabaseSync(memoryPath(dir));
    expect(v9.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name)).not.toContain("memory_config");
    v9.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    const col = m.prepare("PRAGMA table_info(outcomes)").all().filter((c) => c.name === "memory_config");
    expect(col).toHaveLength(1);
    expect(col[0].notnull).toBe(0);
    const old = listOutcomes(m, { task: "old" });
    expect(old).toHaveLength(1);
    expect(old[0].memory_config).toBeNull();
    recordOutcomes(m, [handOutcomeRow({ card: "new", commit: "s9", condition: cond(CFG) })]);
    expect(listOutcomes(m, { task: "new" })[0].memory_config).toBe(CANON);
  });
});

describe("compareMemoryArms (card memory-outcome-arms)", () => {
  const cond = (cfg) => ({ harnessCommit: "h1", configHash: "c1", class: "code", arm: "code/default", assignedBy: "policy", exploreProbability: null, memoryConfig: cfg });
  // Built in beforeEach, not at collection time, so a missing memoryConfig fails these tests only.
  let CFG_X;
  let CFG_Y;
  let CFG_Z;
  let tick = 0;
  const when = () => `2026-10-${String(1 + Math.floor(tick / 50)).padStart(2, "0")}T00:${String(tick++ % 50).padStart(2, "0")}:00.000Z`;
  const land = (card, commit, cfg, { usd = null, fix = null } = {}) => {
    const row = handOutcomeRow({ card, commit, now: when(), condition: cfg ? cond(cfg) : null, cost: usd });
    if (fix !== null) Object.assign(row, { passes: fix + 1, fix_passes: fix });
    recordOutcomes(m, [row]);
  };
  const stop = (card, cfg, n = 0) =>
    recordOutcomes(m, [stopOutcomeRow({ card, report: { outcome: "stopped", reason: "hook-blocked", detail: `d${n}` }, reportHash: `${card}${n}`.padEnd(32, "0"), now: when(), condition: cfg ? cond(cfg) : null })]);
  let rh = 0;
  const reflection = (card, commit, harmful, helpful = []) =>
    m
      .prepare("INSERT INTO reflections (report_hash, recorded, run, card, commit_sha, counters) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`rh${rh++}`, when(), null, card, commit, JSON.stringify({ helpful, harmful, unknown: [] }));

  beforeEach(() => {
    tick = 0;
    rh = 0;
    CFG_X = memoryConfig({ embeddings: null, staleDays: 30 });
    CFG_Y = memoryConfig({ embeddings: null, staleDays: 14 });
    CFG_Z = memoryConfig({ embeddings: null, staleDays: 7 });
    m = openMemory(dir);
  });

  it("an empty store has no arms and nothing to compare", () => {
    expect(compareMemoryArms(m)).toEqual({ min: 12, unstamped: 0, arms: [], comparable: false });
  });

  it("M11/M12: one arm per distinct memory_config in earliest-recorded order, each with its own counts; unstamped rows are counted apart", () => {
    // X's last row lands after Y's first, so the order is by earliest recorded row, not latest.
    land("x1", "sx1", CFG_X);
    land("y1", "sy1", CFG_Y);
    land("x2", "sx2", CFG_X);
    stop("x3", CFG_X);
    land("y2", "sy2", CFG_Y);
    land("y3", "sy3", CFG_Y);
    stop("y4", CFG_Y);
    stop("y5", CFG_Y, 1);
    land("z1", "sz1", CFG_Z);
    land("u1", "su1", null);
    land("u2", "su2", null);
    stop("u3", null);
    const res = compareMemoryArms(m);
    expect(res.min).toBe(12);
    expect(res.unstamped).toBe(3);
    expect(res.arms).toHaveLength(3);
    expect(res.arms.map((a) => a.landings)).toEqual([2, 3, 1]);
    expect(res.arms.map((a) => a.stops)).toEqual([1, 2, 0]);
    expect(res.arms.map((a) => a.ready)).toEqual([false, false, false]);
    expect(res.comparable).toBe(false);
  });

  it("M18: an arm is ready at exactly min landings and not at min - 1; the four metrics are null until ready; comparable needs two ready arms", () => {
    for (let i = 0; i < 12; i++) land(`a${i}`, `sa${i}`, CFG_X, { usd: 1, fix: 0 });
    for (let i = 0; i < 11; i++) land(`b${i}`, `sb${i}`, CFG_Y, { usd: 1, fix: 0 });
    const res = compareMemoryArms(m);
    expect(res.arms.map((a) => a.landings)).toEqual([12, 11]);
    expect(res.arms[0].ready).toBe(true);
    expect(res.arms[0].landRate).not.toBeNull();
    expect(res.arms[0].fixRounds).not.toBeNull();
    expect(res.arms[0].harmfulPerLanding).not.toBeNull();
    expect(res.arms[0].costPerLanding).not.toBeNull();
    expect(res.arms[1].ready).toBe(false);
    expect(res.arms[1].landRate).toBeNull();
    expect(res.arms[1].fixRounds).toBeNull();
    expect(res.arms[1].harmfulPerLanding).toBeNull();
    expect(res.arms[1].costPerLanding).toBeNull();
    expect(res.comparable).toBe(false);
    land("b11", "sb11", CFG_Y, { usd: 1, fix: 0 });
    const both = compareMemoryArms(m);
    expect(both.arms.map((a) => a.ready)).toEqual([true, true]);
    expect(both.comparable).toBe(true);
  });

  it("the min option sets the threshold", () => {
    land("a1", "sa1", CFG_X);
    land("a2", "sa2", CFG_X);
    land("b1", "sb1", CFG_Y);
    land("b2", "sb2", CFG_Y);
    const res = compareMemoryArms(m, { min: 2 });
    expect(res.min).toBe(2);
    expect(res.arms.map((a) => a.ready)).toEqual([true, true]);
    expect(res.comparable).toBe(true);
  });

  it("M13/M14/M15/M16/M17: land rate, measured fix rounds, harmful marks per own landing, cost per priced landing", () => {
    // 12 landings in X: "twice" lands twice (own reflection each), 10 others a0..a9.
    // fix_passes: 8 measured [0,1,2,0,1,2,0,1] (mean 0.875), 4 null.
    const fixes = [0, 1, 2, 0, 1, 2, 0, 1, null, null, null, null];
    // usd: 9 priced [1,2,3,1,2,3,1,2,3] (sum 18, mean 2), 3 null.
    const usds = [1, 2, 3, 1, 2, 3, 1, 2, 3, null, null, null];
    const cards = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "twice", "twice"];
    cards.forEach((card, i) => land(card, `sx${i}`, CFG_X, { usd: usds[i], fix: fixes[i] }));
    for (let i = 0; i < 4; i++) stop(`s${i}`, CFG_X);
    // harmful marks: a0 has 2 harmful + 5 helpful, a1 has 1 harmful + 0 helpful, twice@10 has 3, twice@11 has 1.
    reflection("a0", "sx0", ["l1", "l2"], ["h1", "h2", "h3", "h4", "h5"]);
    reflection("a1", "sx1", ["l3"], []);
    reflection("twice", "sx10", ["l4", "l5", "l6"], ["h1"]);
    reflection("twice", "sx11", ["l7"], ["h1", "h2"]);
    // A reflection for the same card at a commit that is not one of the arm's landings, and one for a stop-only card.
    reflection("twice", "elsewhere", ["l8", "l9", "l10", "l11", "l12", "l13", "l14", "l15", "l16", "l17"], []);
    reflection("s0", "none", ["l18"], []);
    const [arm] = compareMemoryArms(m).arms;
    expect(arm.landings).toBe(12);
    expect(arm.stops).toBe(4);
    expect(arm.ready).toBe(true);
    expect(arm.landRate).toBeCloseTo(0.75, 10);
    expect(arm.fixRounds.n).toBe(8);
    expect(arm.fixRounds.mean).toBeCloseTo(0.875, 10);
    expect(arm.harmfulPerLanding).toBeCloseTo(7 / 12, 10);
    expect(arm.priced).toBe(9);
    expect(arm.costPerLanding).toBeCloseTo(2, 10);
  });

  it("M17: a ready arm with no priced landing has a null costPerLanding and priced 0; a ready arm with no measured fix rounds has fixRounds.n 0", () => {
    for (let i = 0; i < 12; i++) land(`a${i}`, `sa${i}`, CFG_X);
    const [arm] = compareMemoryArms(m).arms;
    expect(arm.ready).toBe(true);
    expect(arm.costPerLanding).toBeNull();
    expect(arm.priced).toBe(0);
    expect(arm.fixRounds.n).toBe(0);
    expect(arm.harmfulPerLanding).toBe(0);
    expect(arm.landRate).toBe(1);
  });

  it("a stop row with no stop_class (a flow stop with no stopped task) counts as a stop", () => {
    for (let i = 0; i < 12; i++) land(`a${i}`, `sa${i}`, CFG_X);
    recordOutcomes(m, [stopOutcomeRow({ card: "nc", report: { outcome: "stopped", reason: null, detail: "the run stopped at level 2" }, reportHash: "nc".padEnd(32, "0"), now: when(), condition: cond(CFG_X) })]);
    const [arm] = compareMemoryArms(m).arms;
    expect(arm.stops).toBe(1);
    expect(arm.landRate).toBeCloseTo(12 / 13, 10);
  });

  it("a commit-null row that is not a stop row (flow task row, run not stop:, stop_class null) is not counted as a stop", () => {
    for (let i = 0; i < 12; i++) land(`a${i}`, `sa${i}`, CFG_X);
    const row = handOutcomeRow({ card: "flowtask", commit: "x", now: when(), condition: cond(CFG_X) });
    Object.assign(row, { commit_sha: null, run: "wf-run-1", stop_class: null });
    recordOutcomes(m, [row]);
    const [arm] = compareMemoryArms(m).arms;
    expect(arm.stops).toBe(0);
    expect(arm.landRate).toBe(1);
  });

  it("reads only: comparing creates no rows", () => {
    land("a1", "sa1", CFG_X);
    const before = m.prepare("SELECT COUNT(*) AS n FROM outcomes").get().n;
    compareMemoryArms(m);
    expect(m.prepare("SELECT COUNT(*) AS n FROM outcomes").get().n).toBe(before);
  });
});

// Card memory-progressive-access (ADR 0019 retrieval): the lesson index with token costs, and the run-history reader.
describe("lessonTokens and lessonTitle (card memory-progressive-access)", () => {
  it("lessonTokens is chars divided by four, rounded up", () => {
    expect(lessonTokens("abcde")).toBe(2);
    expect(lessonTokens("abcd")).toBe(1);
    expect(lessonTokens("x".repeat(1201))).toBe(301);
  });

  it("M3: the title is the first non-blank line, trimmed, with whitespace runs collapsed", () => {
    expect(lessonTitle("\n\nFirst line here\nSecond line secret")).toBe("First line here");
    expect(lessonTitle("   \n  spaced    out \t title  \nrest")).toBe("spaced out title");
  });

  it("M3: a first line over 100 characters is cut at the last space within 100 and ends with an ellipsis", () => {
    const first = "word ".repeat(60).trim();
    expect(first.length).toBeGreaterThan(100);
    const t = lessonTitle(first + "\nsecond");
    expect(t.endsWith("…")).toBe(true);
    const body = t.slice(0, -1);
    expect(body.length).toBeLessThanOrEqual(100);
    expect(body.endsWith(" ")).toBe(false);
    expect(first.startsWith(body)).toBe(true);
    expect(first[body.length]).toBe(" ");
    expect(t).not.toContain("second");
  });

  it("M3: with no space within 100 characters the cut is hard at 100; a 100-character line is left whole", () => {
    expect(lessonTitle("x".repeat(300))).toBe("x".repeat(100) + "…");
    expect(lessonTitle("y".repeat(100))).toBe("y".repeat(100));
  });
});

describe("renderLessonIndex (card memory-progressive-access)", () => {
  const les = (id, text, extra = {}) => ({ id, kind: "pattern", citation: null, text, ...extra });

  it("M1, M2: one line per lesson in rank order carrying the kind and the token cost of the whole text", () => {
    const thousand = "First line title\n" + "z".repeat(1000 - "First line title\n".length);
    expect(thousand.length).toBe(1000);
    const one = renderLessonIndex([les("L1", thousand)]);
    expect(one).toEqual({ text: "- [L1] First line title (pattern, ~250 tokens)", ids: ["L1"], omitted: [] });

    const body = "twenty chars title!!\n" + "q".repeat(1201 - 21);
    expect(body.length).toBe(1201);
    const two = renderLessonIndex([les("A", body, { kind: "pitfall" }), les("B", "tiny")]);
    expect(two.text.split("\n")).toEqual(["- [A] twenty chars title!! (pitfall, ~301 tokens)", "- [B] tiny (pattern, ~1 tokens)"]);
    expect(two.ids).toEqual(["A", "B"]);
  });

  it("M3: the index line holds the title only, not the rest of the lesson, and no citation", () => {
    const r = renderLessonIndex([les("L1", "\n\nFirst line here\nSecond line secret", { citation: "docs/x.md:3" })]);
    expect(r.text).toContain("First line here");
    expect(r.text).not.toContain("Second line secret");
    expect(r.text).not.toContain("docs/x.md");
    expect(r.text.split("\n")).toHaveLength(1);
  });

  it("M4: a line that would pass the cap is skipped and its id reported in rank order; a later short line still renders", () => {
    const long = "t".repeat(100);
    const lessons = [les("i1", long), les("i2", long), les("i3", long), les("i4", "s")];
    const r = renderLessonIndex(lessons, { cap: 300 });
    expect(r.ids).toEqual(["i1", "i2", "i4"]);
    expect(r.omitted).toEqual(["i3"]);
    expect(r.text.length).toBeLessThanOrEqual(300);
    expect(r.text.split("\n").map((l) => /^- \[([^\]]+)\]/.exec(l)[1])).toEqual(["i1", "i2", "i4"]);
    const two = renderLessonIndex([les("i1", long), les("i2", long), les("i3", long)], { cap: 300 });
    expect(two.ids).toEqual(["i1", "i2"]);
    expect(two.omitted).toEqual(["i3"]);
  });

  it("the default cap is 2000 characters", () => {
    const lessons = Array.from({ length: 30 }, (_, i) => les(`n${String(i).padStart(2, "0")}`, "u".repeat(100)));
    const r = renderLessonIndex(lessons);
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.ids.length).toBeGreaterThan(5);
    expect(r.ids.length).toBeLessThan(30);
    expect([...r.ids, ...r.omitted].sort()).toEqual(lessons.map((l) => l.id).sort());
  });

  it("nothing rendered gives text null, no ids and no omissions; when every line overflows all are omitted", () => {
    expect(renderLessonIndex([])).toEqual({ text: null, ids: [], omitted: [] });
    expect(renderLessonIndex(undefined)).toEqual({ text: null, ids: [], omitted: [] });
    expect(renderLessonIndex([les("a", "t".repeat(100)), les("b", "t".repeat(100))], { cap: 20 })).toEqual({ text: null, ids: [], omitted: ["a", "b"] });
  });

  it("renderFlowLessons (card memory-atomic-lessons): index first, then each fetched lesson whole in lesson show form, ids in rank order", async () => {
    const { renderFlowLessons } = await import("../lib/memory.mjs");
    const body = (c) => "Title line\n" + c.repeat(1500);
    const lessons = [les("f1", body("a"), { citation: "src/one.md" }), les("f2", body("b")), les("f3", "short one")];
    const r = renderFlowLessons(lessons);
    expect(r.ids).toEqual(["f1", "f2", "f3"]);
    expect(r.indexIds).toEqual(["f1", "f2", "f3"]);
    expect(r.omitted).toEqual([]);
    expect(r.unfetched).toEqual([]);
    const idx = renderLessonIndex(lessons).text;
    expect(r.text.startsWith(idx)).toBe(true);
    expect(r.text).toContain(body("a"));
    expect(r.text).toContain(body("b"));
    expect(r.text).not.toContain("…");
    expect(r.text).toContain(`lesson f1 (pattern, ~${lessonTokens(body("a"))} tokens)\ncitation: src/one.md\n\n${body("a")}`);
    expect(r.text).toContain("lesson f3 (pattern, ~3 tokens)\ncitation: none\n\nshort one");
    expect(r.text.indexOf("lesson f1")).toBeLessThan(r.text.indexOf("lesson f2"));
    expect(r.text.indexOf("lesson f2")).toBeLessThan(r.text.indexOf("lesson f3"));
    expect(r.text).not.toContain("not fetched");
  });

  it("M5: renderFlowLessons stays inside the 4000-token fetch budget, skip-not-stop: an over-budget top lesson stays in the index, is named on a not-fetched line and is never cut", async () => {
    const { renderFlowLessons } = await import("../lib/memory.mjs");
    const bigText = "Big title\n" + "B".repeat(20000);
    const lessons = [les("big", bigText), les("s1", "Short one\nSENTINEL_ONE"), les("s2", "Short two\nSENTINEL_TWO")];
    const r = renderFlowLessons(lessons);
    expect(r.ids).toEqual(["s1", "s2"]);
    expect(r.indexIds).toEqual(["big", "s1", "s2"]);
    expect(r.unfetched).toEqual(["big"]);
    expect(r.text).toContain("SENTINEL_ONE");
    expect(r.text).toContain("SENTINEL_TWO");
    expect(r.text).not.toContain("BBBBBBBBBB");
    expect(r.text).toContain("- [big] Big title (pattern, ~5003 tokens)");
    const line = r.text.split("\n").find((l) => l.startsWith("not fetched"));
    expect(line).toContain("~4000-token");
    expect(line).toContain("big");
    expect(r.text).not.toContain("lesson big");
  });

  it("renderFlowLessons: the budget is the sum over fetched lessons, in tokens (chars / 4 rounded up), and fetchTokens is an option", async () => {
    const { renderFlowLessons } = await import("../lib/memory.mjs");
    const t = (c) => "T\n" + c.repeat(6000); // 6002 chars = 1501 tokens
    const lessons = [les("a", t("a")), les("b", t("b")), les("c", t("c"))];
    expect(renderFlowLessons(lessons).ids).toEqual(["a", "b"]); // 3002 fits 4000, a third (4503) does not
    expect(renderFlowLessons(lessons).unfetched).toEqual(["c"]);
    expect(renderFlowLessons(lessons, { fetchTokens: 1600 }).ids).toEqual(["a"]);
    expect(renderFlowLessons(lessons, { fetchTokens: 100000 }).ids).toEqual(["a", "b", "c"]);
  });

  it("renderFlowLessons: an index line dropped by the index cap is named on an index: omitted line and its text is not fetched; nothing renders as text null", async () => {
    const { renderFlowLessons } = await import("../lib/memory.mjs");
    const many = Array.from({ length: 30 }, (_, i) => les(`n${String(i).padStart(2, "0")}`, "u".repeat(100)));
    const r = renderFlowLessons(many);
    expect(r.omitted.length).toBeGreaterThan(0);
    expect(r.text).toContain("index: omitted");
    for (const id of r.omitted) expect(r.ids).not.toContain(id);
    const empty = renderFlowLessons([]);
    expect(empty.text).toBeNull();
    expect(empty.ids).toEqual([]);
  });

  it("renderLessons keeps its 400-character cut for its other callers", () => {
    const r = renderLessons([les("c", "k".repeat(1000), { citation: "src" })]);
    expect(r.text).toContain("(src)");
    expect(r.text.length).toBeLessThan(500);
  });
});

describe("parseHistoryRef (card memory-progressive-access)", () => {
  it("M15: accepts the citation form with the history: prefix, a .jsonl suffix and a line", () => {
    expect(parseHistoryRef("history:c1/wf_1.jsonl:3")).toEqual({ card: "c1", run: "wf_1", line: 3 });
    expect(parseHistoryRef("c1/wf_1:12")).toEqual({ card: "c1", run: "wf_1", line: 12 });
  });

  it("M15: the shorter forms leave run and line null", () => {
    expect(parseHistoryRef("c1")).toEqual({ card: "c1", run: null, line: null });
    expect(parseHistoryRef("history:c1")).toEqual({ card: "c1", run: null, line: null });
    expect(parseHistoryRef("c1/wf_1")).toEqual({ card: "c1", run: "wf_1", line: null });
    expect(parseHistoryRef("c1/wf_1.jsonl")).toEqual({ card: "c1", run: "wf_1", line: null });
  });

  it("M15: traversal, odd characters, bad lines and empty ids throw `bad history id`", () => {
    for (const bad of ["../etc/r", "c1/..:1", "..", "c1/..", "c1/a..b", "a b/x", "c1/wf:0", "c1/wf:-1", "c1/wf:x", "c1/wf:1.5", "", "c1/a/b", "history:"]) {
      expect(() => parseHistoryRef(bad), JSON.stringify(bad)).toThrow(/^bad history id/);
    }
  });
});

describe("readRunHistory (card memory-progressive-access)", () => {
  const scan = (t) => scanText(t, {});
  const entry = (n, text = "text " + n) => ({ kind: "hand-back", seat: "lead", round: n, source: "journal.jsonl", value: text });
  const PEM = "-----BEGIN " + "RSA PRIVATE" + " KEY-----";

  it("M12: a line is returned by its 1-based number, with its cost; a line past the end throws naming the count", () => {
    writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3)], scan });
    const two = readRunHistory(dir, { card: "c1", run: "wf_1", line: 2 });
    expect(two).toMatchObject({ line: 2, kind: "hand-back", seat: "lead", round: 2, source: "journal.jsonl", text: "text 2", tokens: 2 });
    expect(readRunHistory(dir, { card: "c1", run: "wf_1", line: 1 }).text).toBe("text 1");
    expect(readRunHistory(dir, { card: "c1", run: "wf_1", line: 3 }).text).toBe("text 3");
    expect(() => readRunHistory(dir, { card: "c1", run: "wf_1", line: 4 })).toThrow("no line 4 in c1/wf_1 (3 lines)");
  });

  it("M13: the run form lists every entry with its number and token cost, and a total", () => {
    const big = "g".repeat(1000);
    writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2, big), entry(3, "abcde")], scan });
    const r = readRunHistory(dir, { card: "c1", run: "wf_1" });
    expect(r.card).toBe("c1");
    expect(r.run).toBe("wf_1");
    expect(r.entries.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(r.entries.map((e) => e.tokens)).toEqual([2, 250, 2]);
    expect(r.entries[1]).toMatchObject({ kind: "hand-back", seat: "lead", round: 2, source: "journal.jsonl", bytes: 1000, truncated: false, redacted: null });
    expect(r.entries[1]).not.toHaveProperty("text");
    expect(r.tokens).toBe(254);
  });

  it("M14: a run cut by the cap ends with a cap entry naming what was dropped; truncated and redacted entries say so", () => {
    const probe = writeRunHistory(join(dir, "probe"), { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3), entry(4), entry(5)], scan });
    const lens = readFileSync(probe.path, "utf8").split("\n").filter((x) => x !== "").map((x) => Buffer.byteLength(x) + 1);
    const cap = lens[0] + lens[1] + 3;
    writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3), entry(4), entry(5)], scan, maxRunBytes: cap });
    const r = readRunHistory(dir, { card: "c1", run: "wf_1" });
    expect(r.entries).toHaveLength(3);
    expect(r.entries[2]).toMatchObject({ line: 3, kind: "cap", dropped: 3, maxRunBytes: cap });

    const pem = [PEM, "BODYLINE", "more"].join("\n");
    writeRunHistory(dir, { card: "c2", run: "wf_1", entries: [entry(1, pem), entry(2, "q".repeat(300)), entry(3, "fine")], scan, maxEntryBytes: 100 });
    const e = readRunHistory(dir, { card: "c2", run: "wf_1" }).entries;
    expect(e[0].redacted).toBe("pemPrivateKey");
    expect(e[1]).toMatchObject({ truncated: true, bytes: 300 });
    expect(e[2]).toMatchObject({ truncated: false, redacted: null });
  });

  it("M16: the card form lists every run sorted, counting entries without the cap line", () => {
    writeRunHistory(dir, { card: "c1", run: "wf_b", entries: [entry(1), entry(2), entry(3), entry(4)], scan, maxRunBytes: 1 });
    writeRunHistory(dir, { card: "c1", run: "wf_a", entries: [entry(1, "abcdefgh"), entry(2, "abcd")], scan });
    const r = readRunHistory(dir, { card: "c1" });
    expect(r.card).toBe("c1");
    expect(r.runs.map((x) => x.run)).toEqual(["wf_a", "wf_b"]);
    expect(r.runs[0]).toEqual({ run: "wf_a", entries: 2, tokens: 3 });
    expect(r.runs[1].entries).toBe(0);
  });

  it("M16: the card form counts entries for a run with several lines and a cap line", () => {
    const probe = writeRunHistory(join(dir, "probe"), { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3)], scan });
    const lens = readFileSync(probe.path, "utf8").split("\n").filter((x) => x !== "").map((x) => Buffer.byteLength(x) + 1);
    writeRunHistory(dir, { card: "c1", run: "wf_a", entries: [entry(1), entry(2), entry(3)], scan, maxRunBytes: lens[0] + lens[1] + 3 });
    writeRunHistory(dir, { card: "c1", run: "wf_b", entries: [entry(1)], scan });
    const r = readRunHistory(dir, { card: "c1" });
    expect(r.runs).toEqual([{ run: "wf_a", entries: 2, tokens: 4 }, { run: "wf_b", entries: 1, tokens: 2 }]);
  });

  it("M16: a missing card, run or file throws `no history`", () => {
    expect(() => readRunHistory(dir, { card: "nope" })).toThrow(/^no history/);
    writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1)], scan });
    expect(() => readRunHistory(dir, { card: "c1", run: "wf_9" })).toThrow(/^no history/);
    expect(() => readRunHistory(dir, { card: "c1", run: "wf_9", line: 1 })).toThrow(/^no history/);
  });
});

// --- card memory-failure-lessons: the failure slice of the run history, pitfall lessons, the occurrence ledger ---

describe("card memory-failure-lessons", () => {
  const scan = (t) => (t.includes("SECRETMARK") ? { rule: "fixture-secret" } : null);
  const J = (o) => JSON.stringify(o);
  const STOP = { outcome: "stopped", reason: "gate", stoppedAt: "coder", detail: "typecheck failed twice in the coder seat", worktree: "/wt/c1", filesChanged: ["/wt/c1/src/a.mjs"] };
  const blockOf = (cls, over = {}) => ({ hook: "stop-gate", at: "2026-10-20T00:00:00.000Z", agent: null, reason: `reason of the ${cls} block`, class: cls, session: "s-block", failures: [{ command: "pnpm test:unit", exit: 1, timedOut: false, tail: `tail of ${cls}` }], ...over });
  const hist = (card, run, entries) => writeRunHistory(dir, { card, run, entries, scan });
  const brief = { kind: "brief", seat: "coder", round: 1, source: "replay:card-loop.mjs", value: "the coder brief" };
  const rep = (v) => ({ kind: "report", source: "card-report.json", value: J(v) });
  const blk = (v) => ({ kind: "block", source: "blocks.jsonl", value: J(v) });
  const den = (v) => ({ kind: "denial", source: "trace", value: J(v) });
  const ledger = () => join(dir, PITFALL_LEDGER_RELPATH);

  describe("failureSlice", () => {
    it("a card with no history gives an empty slice and never throws", () => {
      expect(failureSlice(dir, "nope")).toEqual({ items: [], hidden: {}, unreadable: 0 });
    });

    it("a stopped card report is a stop item with ref history:<card>/<run>:<line>", () => {
      hist("c1", "wf_1", [brief, rep(STOP)]);
      hist("c1", "wf_2", [brief, rep({ outcome: "done", worktree: "/wt/c1", filesChanged: [] })]);
      const s = failureSlice(dir, "c1");
      expect(s.items).toHaveLength(1);
      expect(s.items[0]).toMatchObject({ ref: "history:c1/wf_1:2", kind: "stop", card: "c1", run: "wf_1", line: 2 });
      expect(s.items[0].text).toContain("typecheck failed twice in the coder seat");
    });

    it("a flow report with ok false is a stop item; a paused one and a done report are not", () => {
      hist("c1", "wf_a", [rep({ ok: false, plan: "p" })]);
      hist("c1", "wf_b", [rep({ ok: false, paused: true, plan: "p" })]);
      hist("c1", "wf_c", [rep({ ok: true, plan: "p" })]);
      const s = failureSlice(dir, "c1");
      expect(s.items.map((i) => [i.run, i.kind, i.ref])).toEqual([["wf_a", "stop", "history:c1/wf_a:1"]]);
    });

    it("only a block classed real is an item; the other five classes are not", () => {
      const classes = ["real", "race", "load-timeout", "expected-red", "stood-down", "test-count"];
      hist("c1", "wf_1", [brief, ...classes.map((c) => blk(blockOf(c)))]);
      const s = failureSlice(dir, "c1");
      expect(s.items).toHaveLength(1);
      expect(s.items[0]).toMatchObject({ kind: "block", ref: "history:c1/wf_1:2", line: 2 });
      expect(s.items[0].text).toContain("reason of the real block");
    });

    it("hidden counts each excluded block class and unreadable counts a redacted block and a torn report", () => {
      hist("c1", "wf_1", [
        brief,
        blk(blockOf("real")),
        blk(blockOf("race")),
        blk(blockOf("race")),
        blk(blockOf("load-timeout")),
        blk(blockOf("expected-red")),
        blk(blockOf("stood-down")),
        blk(blockOf("test-count")),
        blk(blockOf("real", { reason: "SECRETMARK leaked here" })),
        { kind: "report", source: "card-report.json", value: "{ not json" },
      ]);
      const s = failureSlice(dir, "c1");
      expect(s.items).toHaveLength(1);
      expect(s.hidden).toEqual({ race: 2, "load-timeout": 1, "expected-red": 1, "stood-down": 1, "test-count": 1 });
      expect(s.unreadable).toBe(2);
    });

    it("a denial entry is a denial item", () => {
      hist("c1", "wf_1", [brief, den({ session: "s-d", agent: "a1", tool: "Bash", detail: "git branch -D x" })]);
      const s = failureSlice(dir, "c1");
      expect(s.items).toHaveLength(1);
      expect(s.items[0]).toMatchObject({ kind: "denial", ref: "history:c1/wf_1:2", session: "s-d" });
      expect(s.items[0].text).toContain("git branch -D x");
    });

    it("items come in sorted file order then line order, and a torn line in a run file never throws", () => {
      hist("c1", "wf_2", [brief, den({ session: "s", tool: "Bash", detail: "two" })]);
      hist("c1", "wf_1", [brief, den({ session: "s", tool: "Bash", detail: "one" })]);
      const torn = join(dir, ".doug/.state/history/c1/wf_0.jsonl");
      writeFileSync(torn, '{"kind":"brief","tor\n' + J({ kind: "denial", card: "c1", run: "wf_0", seat: null, round: null, source: "trace", bytes: 1, truncated: false, redacted: null, text: J({ session: "s", tool: "Bash", detail: "zero" }) }) + "\n");
      const s = failureSlice(dir, "c1");
      expect(s.items.map((i) => i.run)).toEqual(["wf_0", "wf_1", "wf_2"]);
    });

    it("each item's ref round-trips through parseHistoryRef and readRunHistory to the same entry", () => {
      hist("c1", "wf_1", [brief, rep(STOP), blk(blockOf("race")), blk(blockOf("real")), den({ session: "s", tool: "Bash", detail: "d" })]);
      const s = failureSlice(dir, "c1");
      expect(s.items.map((i) => i.kind)).toEqual(["stop", "block", "denial"]);
      expect(s.items.map((i) => i.line)).toEqual([2, 4, 5]);
      const want = { stop: "report", block: "block", denial: "denial" };
      for (const item of s.items) {
        const e = readRunHistory(dir, parseHistoryRef(item.ref));
        expect(e.kind).toBe(want[item.kind]);
        expect(e.run).toBe("wf_1");
      }
    });

    it("a block keeps its own session, a stop takes the run's block session, and with none it takes the option", () => {
      hist("c1", "wf_1", [brief, rep(STOP), blk(blockOf("real", { session: "s-own" })), den({ session: "s-other", tool: "Bash", detail: "d" })]);
      hist("c1", "wf_2", [brief, rep(STOP)]);
      const s = failureSlice(dir, "c1", { session: "s-opt" });
      const by = Object.fromEntries(s.items.map((i) => [`${i.run}:${i.kind}`, i.session]));
      expect(by["wf_1:block"]).toBe("s-own");
      expect(by["wf_1:denial"]).toBe("s-other");
      expect(by["wf_1:stop"]).toBe("s-own");
      expect(by["wf_2:stop"]).toBe("s-opt");
      expect(failureSlice(dir, "c1").items.find((i) => i.run === "wf_2").session).toBeNull();
    });
  });

  describe("recordPitfallOccurrence / readPitfallOccurrences", () => {
    it("the ledger lives at .doug/.state/memory/pitfalls.jsonl and reads [] when missing", () => {
      expect(PITFALL_LEDGER_RELPATH).toBe(".doug/.state/memory/pitfalls.jsonl");
      expect(readPitfallOccurrences(dir)).toEqual([]);
    });

    it("the same lesson and citation twice writes one line and returns written false the second time", () => {
      const occ = { lesson: "l1", citation: "history:c1/wf_1:3", card: "c1", run: "wf_1", session: "s1", at: "2026-10-20T00:00:00.000Z" };
      expect(recordPitfallOccurrence(dir, occ)).toMatchObject({ written: true });
      expect(recordPitfallOccurrence(dir, { ...occ, at: "2026-10-21T00:00:00.000Z" })).toMatchObject({ written: false });
      expect(readFileSync(ledger(), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
      expect(recordPitfallOccurrence(dir, { ...occ, citation: "history:c1/wf_1:4" })).toMatchObject({ written: true });
      expect(recordPitfallOccurrence(dir, { ...occ, lesson: "l2" })).toMatchObject({ written: true });
      expect(readPitfallOccurrences(dir)).toHaveLength(3);
    });

    it("a torn line is skipped on read", () => {
      recordPitfallOccurrence(dir, { lesson: "l1", citation: "c", card: "c1", run: "r", session: "s", at: "2026-10-20T00:00:00.000Z" });
      writeFileSync(ledger(), readFileSync(ledger(), "utf8") + "{torn\n");
      expect(readPitfallOccurrences(dir)).toHaveLength(1);
    });
  });

  describe("buildFailureReflectPrompt", () => {
    it("lists each item's ref, a block's failure command and tail, a stop's detail, and live pitfall ids", () => {
      hist("c1", "wf_1", [brief, rep(STOP), blk(blockOf("real", { failures: [{ command: "pnpm typecheck", exit: 2, timedOut: false, tail: "error TS2304: Cannot find name zzz" }] })), den({ session: "s", tool: "Bash", detail: "rm -rf build" })]);
      m = openMemory(dir);
      const live = addLesson(m, { kind: "pitfall", text: "an existing pitfall about gates", source: { agent: "reflect" }, citation: "history:c0/wf_0:2" });
      const slice = failureSlice(dir, "c1");
      const prompt = buildFailureReflectPrompt(slice, { existingLessons: listLessons(m) });
      for (const item of slice.items) expect(prompt).toContain(item.ref);
      expect(prompt).toContain("pnpm typecheck");
      expect(prompt).toContain("error TS2304: Cannot find name zzz");
      expect(prompt).toContain("typecheck failed twice in the coder seat");
      expect(prompt).toContain("rm -rf build");
      expect(prompt).toContain(live.id);
    });
  });

  describe("runFailureReflect", () => {
    const REAL_REF = "history:c1/wf_1:3";
    const proposal = (over = {}) => ({ kind: "pitfall", text: "Never run the gate while the tester files are red because the stop hook blocks the whole turn", citation: REAL_REF, notDerivableBecause: "learned only from this stopped run", ...over });
    const seed = () => hist("c1", "wf_1", [brief, rep(STOP), blk(blockOf("real", { session: "s1" })), blk(blockOf("race", { session: "s1" }))]);
    const fake = (lessons) => {
      const calls = [];
      return { calls, propose: async (prompt) => (calls.push(prompt), { lessons, sessionId: null, totalCostUsd: null }) };
    };
    const run = (f, over = {}) => runFailureReflect(m, { dir, card: "c1", session: "s-opt", propose: f.propose, claudeDir: join(dir, "no-claude"), ...over });
    const pitfalls = () => listLessons(m).filter((l) => l.kind === "pitfall");

    beforeEach(() => {
      m = openMemory(dir);
      seed();
    });

    it("exports a schema whose lessons items have a pitfall kind, citation and repeats", () => {
      const item = FAILURE_REFLECT_SCHEMA.properties.lessons.items;
      expect(item.required).toEqual(expect.arrayContaining(["kind", "text", "citation", "notDerivableBecause"]));
      expect(Object.keys(item.properties)).toEqual(expect.arrayContaining(["kind", "text", "citation", "notDerivableBecause", "repeats"]));
    });

    it("an appended pitfall cites its ref, carries the card, and writes one occurrence line {lesson, citation, card, run, session}", async () => {
      const f = fake([proposal()]);
      const r = await run(f);
      expect(r.ok).toBe(true);
      expect(r.appended).toHaveLength(1);
      expect(r.rejected).toEqual([]);
      const row = getLesson(m, r.appended[0]);
      expect(row).toMatchObject({ kind: "pitfall", citation: REAL_REF, card: "c1", source_agent: "reflect" });
      const occ = readPitfallOccurrences(dir);
      expect(occ).toHaveLength(1);
      expect(occ[0]).toMatchObject({ lesson: r.appended[0], citation: REAL_REF, card: "c1", run: "wf_1", session: "s1" });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toContain(REAL_REF);
    });

    it("a history ref to a race block line or a brief line, and a report: or path:line citation, is rejected and adds no lesson", async () => {
      const bad = [
        proposal({ citation: "history:c1/wf_1:4", text: "cites the race block line of the slice which is not an item" }),
        proposal({ citation: "history:c1/wf_1:1", text: "cites the brief line of the run which is not an item" }),
        proposal({ citation: "report:c1", text: "cites a report form instead of a history ref entirely" }),
        proposal({ citation: "plugins/doug-flow/lib/memory.mjs:10", text: "cites a path and line instead of a history ref entirely" }),
      ];
      const r = await run(fake(bad));
      expect(r.appended).toEqual([]);
      expect(r.rejected).toHaveLength(4);
      for (const x of r.rejected) expect(x.reason).toBeTruthy();
      expect(pitfalls()).toHaveLength(0);
      expect(readPitfallOccurrences(dir)).toEqual([]);
    });

    it("a pattern proposal is rejected, and so are an empty text and an empty notDerivableBecause", async () => {
      const r = await run(fake([proposal({ kind: "pattern" }), proposal({ text: "  " }), proposal({ notDerivableBecause: "" })]));
      expect(r.appended).toEqual([]);
      expect(r.rejected).toHaveLength(3);
      expect(listLessons(m)).toHaveLength(0);
    });

    it("repeats adds no lesson, leaves helpful at its old value, and records an occurrence for the named id", async () => {
      const L = addLesson(m, { kind: "pitfall", text: "the older pitfall the model recognises again", source: { agent: "reflect" }, citation: "history:c0/wf_0:2", card: "c0" });
      m.prepare("UPDATE lessons SET helpful = 2 WHERE id = ?").run(L.id);
      const r = await run(fake([proposal({ repeats: L.id })]));
      expect(r.appended).toEqual([]);
      expect(r.repeated).toEqual([L.id]);
      expect(listLessons(m)).toHaveLength(1);
      expect(getLesson(m, L.id).helpful).toBe(2);
      const occ = readPitfallOccurrences(dir);
      expect(occ).toHaveLength(1);
      expect(occ[0]).toMatchObject({ lesson: L.id, citation: REAL_REF, card: "c1", run: "wf_1", session: "s1" });
    });

    it("repeats naming a feedback lesson, a superseded pitfall or an unknown id is rejected", async () => {
      const fb = addLesson(m, { kind: "feedback", text: "a user feedback lesson that is not a pitfall", source: { agent: "lead" } });
      const old = addLesson(m, { kind: "pitfall", text: "an old pitfall that was superseded", source: { agent: "reflect" }, citation: "history:c0/wf_0:2" });
      const fresh = addLesson(m, { kind: "pitfall", text: "the replacement pitfall for the old one", source: { agent: "reflect" }, citation: "history:c0/wf_0:3" });
      supersedeLesson(m, old.id, fresh.id);
      const r = await run(fake([proposal({ repeats: fb.id }), proposal({ repeats: old.id }), proposal({ repeats: "lxunknown" })]));
      expect(r.appended).toEqual([]);
      expect(r.repeated).toEqual([]);
      expect(r.rejected).toHaveLength(3);
      expect(readPitfallOccurrences(dir)).toEqual([]);
      expect(m.prepare("SELECT COUNT(*) AS c FROM lessons").get().c).toBe(3);
    });

    it("a proposal sharing >= 0.6 Jaccard with a live pitfall but no repeats is appended as its own lesson", async () => {
      const base = "Never run the gate while the tester files are red because the stop hook blocks the whole turn";
      const near = `${base} immediately`;
      expect(jaccard(reflectTokens(base), reflectTokens(near))).toBeGreaterThanOrEqual(0.6);
      const L = addLesson(m, { kind: "pitfall", text: base, source: { agent: "reflect" }, citation: "history:c0/wf_0:2" });
      const r = await run(fake([proposal({ text: near })]));
      expect(r.appended).toHaveLength(1);
      expect(r.appended[0]).not.toBe(L.id);
      expect(getLesson(m, L.id).helpful).toBe(0);
      expect(readPitfallOccurrences(dir)).toHaveLength(1);
    });

    it("at most 3 pitfalls are appended per pass", async () => {
      const texts = ["alpha pitfall about gate ordering that the coder keeps hitting", "bravo pitfall about stale worktrees under the card directory", "charlie pitfall about hooks failing open on a thrown reader", "delta pitfall about brief files placed outside the checkout"];
      const r = await run(fake(texts.map((text) => proposal({ text }))));
      expect(r.appended).toHaveLength(3);
      expect(r.rejected).toHaveLength(1);
    });

    it("a second call on the same slice returns alreadyReflected and does not call propose", async () => {
      const f = fake([proposal()]);
      await run(f);
      const second = await run(f);
      expect(second.alreadyReflected).toBe(true);
      expect(f.calls).toHaveLength(1);
      const rows = m.prepare("SELECT report_hash, card FROM reflections").all();
      expect(rows).toHaveLength(1);
      expect(rows[0].report_hash.startsWith("failures:")).toBe(true);
      expect(rows[0].card).toBe("c1");
    });

    it("a changed slice (a new run file) is reflected again", async () => {
      const f = fake([]);
      await run(f);
      hist("c1", "wf_2", [brief, rep(STOP)]);
      const again = await run(f);
      expect(again.alreadyReflected).toBeUndefined();
      expect(f.calls).toHaveLength(2);
    });

    it("dryRun writes no lesson, no occurrence and no reflections row", async () => {
      const f = fake([proposal()]);
      const r = await run(f, { dryRun: true });
      expect(r.appended).toHaveLength(1);
      expect(listLessons(m)).toHaveLength(0);
      expect(existsSync(ledger())).toBe(false);
      expect(m.prepare("SELECT * FROM reflections").all()).toHaveLength(0);
      const real = await run(f);
      expect(real.alreadyReflected).toBeUndefined();
      expect(real.appended).toHaveLength(1);
    });

    it("a card with no failure items returns items 0 and never calls propose", async () => {
      const f = fake([proposal()]);
      const r = await runFailureReflect(m, { dir, card: "quiet", propose: f.propose });
      expect(r).toMatchObject({ ok: true, items: 0, appended: [], repeated: [], rejected: [] });
      expect(f.calls).toHaveLength(0);
      expect(m.prepare("SELECT * FROM reflections").all()).toHaveLength(0);
    });
  });

  // card memory-failures-wiring: failure items carry the block's class and files; a pitfall's repeat is counted in
  // code when a later real block has the same class and shares a file with a recorded occurrence (ADR 0019 line 60).
  describe("card memory-failures-wiring", () => {
    const AT = "2026-10-20T00:00:00.000Z";
    const C1REF = "history:c1/wf_1:2";
    const C2REF = "history:c2/wf_9:2";
    const mkPitfall = () => addLesson(m, { text: "Never commit generated files because the stop hook rebuilds them", kind: "pitfall", citation: C1REF, card: "c1", source: { agent: "reflect" } });
    const writeOcc = (o) => {
      mkdirSync(dirname(ledger()), { recursive: true });
      appendFileSync(ledger(), J({ citation: C1REF, card: "c1", run: "wf_1", session: "s1", at: AT, ...o }) + "\n");
    };
    const noModel = { propose: async () => ({ lessons: [], sessionId: null, totalCostUsd: null }) };
    const runC2 = (over = {}) => runFailureReflect(m, { dir, card: "c2", propose: noModel.propose, claudeDir: join(dir, "no-claude"), ...over });
    const c2Occ = (id) => readPitfallOccurrences(dir).filter((o) => o.lesson === id && o.card === "c2");

    beforeEach(() => {
      m = openMemory(dir);
    });

    it("a real block with files gives an item with class 'real' and those files; a stop item has class null and files []", () => {
      hist("c1", "wf_1", [brief, blk(blockOf("real", { files: ["src/a.mjs"] })), rep(STOP)]);
      const s = failureSlice(dir, "c1");
      const block = s.items.find((i) => i.kind === "block");
      const stop = s.items.find((i) => i.kind === "stop");
      expect(block).toMatchObject({ class: "real", files: ["src/a.mjs"] });
      expect(stop.class).toBeNull();
      expect(stop.files).toEqual([]);
    });

    it("an old real block line with no files field gives files []", () => {
      hist("c1", "wf_1", [brief, blk(blockOf("real"))]);
      expect(failureSlice(dir, "c1").items[0]).toMatchObject({ class: "real", files: [] });
    });

    it("an appended pitfall writes an occurrence line carrying the cited block's class and files", async () => {
      hist("c1", "wf_1", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      const f = {
        propose: async () => ({ lessons: [{ kind: "pitfall", text: "Never run the gate while the tester files are red because the stop hook blocks the whole turn", citation: C1REF, notDerivableBecause: "learned only from this run" }], sessionId: null, totalCostUsd: null }),
      };
      const r = await runFailureReflect(m, { dir, card: "c1", propose: f.propose, claudeDir: join(dir, "no-claude") });
      expect(r.appended).toHaveLength(1);
      expect(readPitfallOccurrences(dir)[0]).toMatchObject({ lesson: r.appended[0], citation: C1REF, class: "real", files: ["src/a.mjs"] });
    });

    it("a real block with the same class on a shared file is an occurrence of the pitfall with no model repeats, tagged via 'file'", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs", "src/z.mjs"] }))]);
      const r = await runC2();
      expect(r.repeated).toContain(P.id);
      expect(c2Occ(P.id)).toEqual([expect.objectContaining({ lesson: P.id, citation: C2REF, card: "c2", run: "wf_9", via: "file" })]);
    });

    it("the model's repeats and the code-side match on the same item write one occurrence line", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      const propose = async () => ({ lessons: [{ kind: "pitfall", text: "Repeat of the generated files pitfall", citation: C2REF, notDerivableBecause: "learned only from this run", repeats: P.id }], sessionId: null, totalCostUsd: null });
      await runC2({ propose });
      expect(c2Occ(P.id)).toHaveLength(1);
    });

    it("no file in common is no match", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/b.mjs"] }))]);
      await runC2();
      expect(c2Occ(P.id)).toEqual([]);
    });

    it("empty files never match, on the block side or the occurrence side", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: [] }))]);
      await runC2();
      expect(c2Occ(P.id)).toEqual([]);
      const Q = addLesson(m, { text: "Another pitfall about lockfiles because pnpm rewrites them", kind: "pitfall", citation: "history:c3/wf_1:2", card: "c3", source: { agent: "reflect" } });
      writeOcc({ lesson: Q.id, class: "real", files: [] });
      hist("c2", "wf_10", [brief, blk(blockOf("real", { files: [] }))]);
      await runC2();
      expect(c2Occ(Q.id)).toEqual([]);
    });

    it("an occurrence of another block class does not match", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "race", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      await runC2();
      expect(c2Occ(P.id)).toEqual([]);
    });

    it("a stop item never matches by file", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, rep({ ...STOP, filesChanged: ["/wt/c1/src/a.mjs"] })]);
      await runC2();
      expect(c2Occ(P.id)).toEqual([]);
    });

    it("a dry run writes no occurrence", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      await runC2({ dryRun: true });
      expect(c2Occ(P.id)).toEqual([]);
    });

    it("a dry run previews what a real run would write: it lists the pitfall on a first match and still writes nothing", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      const r = await runC2({ dryRun: true });
      expect(r.repeated).toContain(P.id);
      expect(c2Occ(P.id)).toEqual([]);
    });

    it("a second stop that re-matches an already recorded block does not list the pitfall as repeated", async () => {
      const P = mkPitfall();
      writeOcc({ lesson: P.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] })), rep(STOP)]);
      const first = await runC2();
      expect(first.repeated).toContain(P.id);
      hist("c2", "wf_10", [brief, rep(STOP)]);
      const second = await runC2();
      expect(second.alreadyReflected).toBeFalsy();
      expect(second.repeated).not.toContain(P.id);
      const row = m.prepare("SELECT bumped FROM reflections WHERE card = ? ORDER BY recorded DESC, rowid DESC").get("c2");
      expect(JSON.parse(row.bumped)).not.toContain(P.id);
      expect(c2Occ(P.id)).toHaveLength(1);
      // a dry run of a third stop (a new slice, so not alreadyReflected) previews nothing new either
      hist("c2", "wf_11", [brief, rep(STOP)]);
      const dry = await runC2({ dryRun: true });
      expect(dry.repeated).not.toContain(P.id);
    });

    it("a superseded pitfall is never matched by file", async () => {
      const oldP = mkPitfall();
      const fresh = addLesson(m, { text: "Never commit generated files; the stop hook rebuilds them on every turn", kind: "pitfall", citation: "history:c3/wf_1:2", card: "c3", source: { agent: "reflect" } });
      supersedeLesson(m, oldP.id, fresh.id);
      writeOcc({ lesson: oldP.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      const r = await runC2();
      expect(c2Occ(oldP.id)).toEqual([]);
      expect(r.repeated).not.toContain(oldP.id);
    });

    it("a lesson of another kind named in the ledger is never matched by file", async () => {
      const F = addLesson(m, { text: "Prefer small commits because the reviewer reads the whole diff at once", kind: "feedback", citation: "history:c3/wf_1:2", card: "c3", source: { agent: "reflect" } });
      writeOcc({ lesson: F.id, class: "real", files: ["src/a.mjs"] });
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      const r = await runC2();
      expect(c2Occ(F.id)).toEqual([]);
      expect(r.repeated).not.toContain(F.id);
    });

    it("an occurrence written through the model's repeats path carries the block's class and files and no via", async () => {
      const P = mkPitfall();
      hist("c2", "wf_9", [brief, blk(blockOf("real", { files: ["src/a.mjs"] }))]);
      const propose = async () => ({ lessons: [{ kind: "pitfall", text: "Repeat of the generated files pitfall", citation: C2REF, notDerivableBecause: "learned only from this run", repeats: P.id }], sessionId: null, totalCostUsd: null });
      const r = await runC2({ propose });
      expect(r.repeated).toContain(P.id);
      const occ = c2Occ(P.id);
      expect(occ).toHaveLength(1);
      expect(occ[0]).toMatchObject({ lesson: P.id, citation: C2REF, class: "real", files: ["src/a.mjs"] });
      expect(occ[0].via).toBeUndefined();
    });
  });
});

// Card memory-feedback-rank: harmful and evidence class enter recall scoring, helpful does not, and a lesson with
// harmful >= ARCHIVE_HARMFUL_MIN and harmful >= helpful is archived by runReflect (never deleted).
describe("recallLessons feedback rank (card memory-feedback-rank)", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  const recencyOf = (n) => 0.5 + 0.5 * Math.exp(-n / 90);
  const MODEL = { model: "fake-model", dims: 3 };
  const mk = (id, text, { vector, citation = null, harmful = 0, helpful = 0, created = daysAgo(10) } = {}) => {
    addLesson(m, { id, text, kind: "pattern", citation, source: { agent: "worker" }, created });
    if (harmful || helpful) m.prepare("UPDATE lessons SET harmful = ?, helpful = ? WHERE id = ?").run(harmful, helpful, id);
    if (vector) setLessonEmbedding(m, id, { ...MODEL, vector: Float32Array.from(vector) });
    return id;
  };
  const recall = (query, opts = {}) => recallLessons(m, query, { now, ...opts });
  const ids = async (query, opts) => (await recall(query, opts)).lessons.map((l) => l.id);

  beforeEach(() => {
    m = openMemory(dir);
    clearRecallCache();
  });

  it("RECALL_FEEDBACK ships a positive harmful penalty, a helpful cap and four evidence weights", () => {
    expect(RECALL_FEEDBACK.harmfulPenalty).toBeGreaterThan(0);
    expect(typeof RECALL_FEEDBACK.helpfulCap).toBe("number");
    expect(Object.keys(RECALL_FEEDBACK.evidenceWeights).sort()).toEqual(["file", "history", "none", "report"]);
    for (const w of Object.values(RECALL_FEEDBACK.evidenceWeights)) expect(w).toBeGreaterThan(0);
  });

  // The BM25 score is 1/(60 + rank): twins with identical text differ by about 1.6% only through their rank, so the
  // keyword cases use harmful 5 (a penalty monotone in the count must clear a one-rank gap by then), and insert the
  // harmful twin first so the baseline (rank, then id) puts it first in both assignments that matter.
  it("M1: keyword-only: a harmful twin ranks below its harmful-0 twin, whichever twin is harmful", async () => {
    mk("t-a", "quokka migration notes for the zebra pipeline", { harmful: 5 });
    mk("t-b", "quokka migration notes for the zebra pipeline");
    expect(await ids("quokka migration")).toEqual(["t-b", "t-a"]);
    m.close();
    rmSync(join(dir, ".doug"), { recursive: true, force: true });
    m = openMemory(dir);
    clearRecallCache();
    mk("t-a", "quokka migration notes for the zebra pipeline");
    mk("t-b", "quokka migration notes for the zebra pipeline", { harmful: 5 });
    expect(await ids("quokka migration")).toEqual(["t-a", "t-b"]);
  });

  it("M2: hybrid: vectored twins with identical vectors, the harmful one ranks below, whichever twin is harmful", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("t-a", "alpha one", { vector: [1, 0, 0], harmful: 1 });
    mk("t-b", "alpha two", { vector: [1, 0, 0] });
    expect(await ids("zzz", { provider })).toEqual(["t-b", "t-a"]);
    m.prepare("UPDATE lessons SET harmful = 0 WHERE id = 't-a'").run();
    m.prepare("UPDATE lessons SET harmful = 1 WHERE id = 't-b'").run();
    clearRecallCache();
    expect(await ids("zzz", { provider })).toEqual(["t-a", "t-b"]);
  });

  it("M2: hybrid: the penalty is monotone, harmful 0 above 1 above 3", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("t-a", "alpha", { vector: [1, 0, 0], harmful: 3 });
    mk("t-b", "alpha", { vector: [1, 0, 0], harmful: 1 });
    mk("t-c", "alpha", { vector: [1, 0, 0] });
    expect(await ids("zzz", { provider })).toEqual(["t-c", "t-b", "t-a"]);
  });

  it("M3: hybrid: harmful applies to the unvectored BM25 tail, which is ordered by score", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("v-one", "unrelated vectored lesson", { vector: [1, 0, 0] });
    mk("t-a", "quokka migration notes for the zebra pipeline", { harmful: 5 });
    mk("t-b", "quokka migration notes for the zebra pipeline");
    const out = await ids("quokka migration", { provider });
    expect(out[0]).toBe("v-one");
    expect(out.indexOf("t-b")).toBeGreaterThan(0);
    expect(out.indexOf("t-b")).toBeLessThan(out.indexOf("t-a"));
  });

  it("M4: a harmful twin whose cosine is negative still ranks below its harmful-0 twin", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("t-a", "alpha", { vector: [-1, 0, 0], harmful: 1 });
    mk("t-b", "alpha", { vector: [-1, 0, 0] });
    const result = await recall("zzz", { provider });
    expect(result.lessons.map((l) => l.id)).toEqual(["t-b", "t-a"]);
    expect(result.lessons[0].score).toBeLessThan(0);
  });

  it("M5: a harmful-0 lesson keeps the shipped score (keyword and dense)", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("only", "quokka migration", { vector: [0.6, 0.8, 0] });
    const kw = await recall("quokka");
    expect(kw.mode).toBe("keyword-only");
    expect(kw.lessons[0].score).toBeCloseTo((1 / 61) * recencyOf(10), 8);
    clearRecallCache();
    const hy = await recall("quokka", { provider });
    expect(hy.mode).toBe("hybrid");
    expect(hy.lessons[0].score).toBeCloseTo(0.6 * recencyOf(10), 6);
  });

  it("M6: evidenceClassOf classes a lesson by its citation", () => {
    expect(evidenceClassOf({ citation: "report:t1/b2" })).toBe("report");
    expect(evidenceClassOf({ citation: "report:t1" })).toBe("report");
    expect(evidenceClassOf({ citation: "history:card/run:3" })).toBe("history");
    expect(evidenceClassOf({ citation: "/abs/file.md" })).toBe("file");
    expect(evidenceClassOf({ citation: "docs/x.md:12" })).toBe("file");
    expect(evidenceClassOf({ citation: null })).toBe("none");
    expect(evidenceClassOf({ citation: "" })).toBe("none");
  });

  it("M7: an evidence-class weight orders twins identical except citation, keyword-only and hybrid", async () => {
    const weights = { report: 2, file: 1, history: 1, none: 1 };
    const feedback = { evidenceWeights: weights };
    // the report-cited twin has the larger id and is inserted second, so rank and id tiebreak both favour the file twin
    mk("t-a", "quokka migration notes", { citation: "docs/x.md:12" });
    mk("t-z", "quokka migration notes", { citation: "report:t1/b2" });
    expect(await ids("quokka migration", { feedback })).toEqual(["t-z", "t-a"]);
    m.close();
    rmSync(join(dir, ".doug"), { recursive: true, force: true });
    m = openMemory(dir);
    clearRecallCache();
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("t-a", "alpha", { citation: "docs/x.md:12", vector: [1, 0, 0] });
    mk("t-z", "alpha", { citation: "report:t1/b2", vector: [1, 0, 0] });
    expect(await ids("zzz", { provider, feedback })).toEqual(["t-z", "t-a"]);
  });

  it("M8: helpful does not change the shipped score (keyword and dense)", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("only", "quokka migration", { vector: [0.6, 0.8, 0] });
    const kw0 = (await recall("quokka")).lessons[0].score;
    clearRecallCache();
    const hy0 = (await recall("quokka", { provider })).lessons[0].score;
    m.prepare("UPDATE lessons SET helpful = 50 WHERE id = 'only'").run();
    clearRecallCache();
    expect((await recall("quokka")).lessons[0].score).toBe(kw0);
    expect((await recall("quokka", { provider })).lessons[0].score).toBe(hy0);
  });
});

describe("runReflect archive rule (card memory-feedback-rank)", () => {
  const NOW_ISO = "2026-10-21T00:00:00.000Z";
  beforeEach(() => {
    m = openMemory(dir);
  });
  const setup = (counts, hash) => {
    const L = addLesson(m, { text: `a lesson marked harmful ${hash}`, kind: "pitfall", source: { agent: "worker" } });
    m.prepare("UPDATE lessons SET harmful = ?, helpful = ? WHERE id = ?").run(counts.harmful, counts.helpful, L.id);
    const report = buildReflectReport();
    report.levels[0].tasks[1].memoryUsed = [L.id];
    return { L, report };
  };
  const reflect = (report, hash, extra = {}) =>
    runReflect(m, report, { reportHash: hash, dir, classes: REFLECT_CLASSES, propose: noopPropose, now: NOW_ISO, ...extra });

  it("meetsArchiveRule: harmful >= min and harmful >= helpful; ARCHIVE_HARMFUL_MIN is 2", () => {
    expect(ARCHIVE_HARMFUL_MIN).toBe(2);
    expect(meetsArchiveRule({ harmful: 2, helpful: 2 })).toBe(true);
    expect(meetsArchiveRule({ harmful: 3, helpful: 1 })).toBe(true);
    expect(meetsArchiveRule({ harmful: 2, helpful: 3 })).toBe(false);
    expect(meetsArchiveRule({ harmful: 1, helpful: 0 })).toBe(false);
    expect(meetsArchiveRule({ harmful: 1, helpful: 0 }, 1)).toBe(true);
    expect(meetsArchiveRule({ harmful: 2, helpful: 0 }, 3)).toBe(false);
  });

  it("M9: harmful 2 equal to helpful 2 archives: archived set, reason names the counts, id in result.archived", async () => {
    const { L, report } = setup({ harmful: 1, helpful: 2 }, "m9");
    const result = await reflect(report, "hash-arch-m9", { harmful: [L.id] });
    expect(result.ok).toBe(true);
    expect(result.archived).toEqual([L.id]);
    const row = getLesson(m, L.id);
    expect(row.harmful).toBe(2);
    expect(row.helpful).toBe(2);
    expect(row.archived).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.archived_reason).toMatch(/harmful/);
    expect(row.archived_reason).toMatch(/helpful/);
    expect(row.archived_reason).toMatch(/2/);
    const stored = JSON.parse(m.prepare("SELECT counters FROM reflections WHERE report_hash = ?").get("hash-arch-m9").counters);
    expect(Object.keys(stored)).not.toContain("archived");
  });

  it("M10: harmful 2 below helpful 3 stays live", async () => {
    const { L, report } = setup({ harmful: 1, helpful: 3 }, "m10");
    const result = await reflect(report, "hash-arch-m10", { harmful: [L.id] });
    expect(result.archived).toEqual([]);
    expect(getLesson(m, L.id).harmful).toBe(2);
    expect(getLesson(m, L.id).archived).toBeNull();
  });

  it("M11: one harmful mark (harmful 1) does not archive", async () => {
    const { L, report } = setup({ harmful: 0, helpful: 0 }, "m11");
    const result = await reflect(report, "hash-arch-m11", { harmful: [L.id] });
    expect(result.archived).toEqual([]);
    expect(getLesson(m, L.id).harmful).toBe(1);
    expect(getLesson(m, L.id).archived).toBeNull();
  });

  it("M12: a dry run archives nothing", async () => {
    // already at harmful 2, so the rule is met on the stored counters even though a dry run bumps nothing
    const { L, report } = setup({ harmful: 2, helpful: 0 }, "m12");
    const result = await reflect(report, "hash-arch-m12", { harmful: [L.id], dryRun: true });
    expect(result.ok).toBe(true);
    expect(getLesson(m, L.id).archived).toBeNull();
    expect(getLesson(m, L.id).archived_reason).toBeNull();
    expect(getLesson(m, L.id).harmful).toBe(2);
  });
});

describe("archived lessons (card memory-feedback-rank)", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  const MODEL = { model: "fake-model", dims: 3 };
  const mk = (id, text, { vector, created = daysAgo(10) } = {}) => {
    addLesson(m, { id, text, kind: "pattern", source: { agent: "worker" }, created });
    if (vector) setLessonEmbedding(m, id, { ...MODEL, vector: Float32Array.from(vector) });
    return id;
  };
  const archive = (id) => m.prepare("UPDATE lessons SET archived = ?, archived_reason = ? WHERE id = ?").run("2026-09-29T00:00:00.000Z", "harmful 2, helpful 0", id);

  beforeEach(() => {
    m = openMemory(dir);
    clearRecallCache();
  });

  it("M13: keyword recall skips an archived lesson even when its text matches best", async () => {
    mk("best", "quokka migration quokka migration notes");
    mk("weak", "quokka other");
    archive("best");
    const out = (await recallLessons(m, "quokka migration", { now })).lessons.map((l) => l.id);
    expect(out).toEqual(["weak"]);
  });

  it("M14: hybrid recall skips an archived vectored lesson", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    mk("best", "alpha", { vector: [1, 0, 0] });
    mk("other", "beta", { vector: [0.6, 0.8, 0] });
    archive("best");
    const result = await recallLessons(m, "zzz", { now, provider });
    expect(result.mode).toBe("hybrid");
    expect(result.lessons.map((l) => l.id)).toEqual(["other"]);
  });

  it("M15: topLessons and windowHidden skip an archived lesson", () => {
    mk("keep", "kept lesson");
    mk("top", "top helpful lesson");
    mk("old", "old lesson", { created: daysAgo(100) });
    m.prepare("UPDATE lessons SET helpful = 9 WHERE id = 'top'").run();
    expect(topLessons(m, { k: 5, now })[0].id).toBe("top");
    expect(windowHidden(m, { staleDays: 30, now })).toMatchObject({ count: 1, total: 3 });
    archive("top");
    archive("old");
    expect(topLessons(m, { k: 5, now }).map((l) => l.id)).toEqual(["keep"]);
    expect(windowHidden(m, { staleDays: 30, now })).toMatchObject({ count: 0, total: 1 });
  });

  it("M17: isLiveLesson is false for an archived row and true for the same row unarchived", () => {
    const base = { superseded_by: null, stale: null, archived: null };
    expect(isLiveLesson(base)).toBe(true);
    expect(isLiveLesson({ ...base, archived: "2020-01-05T00:00:00.000Z" })).toBe(false);
    expect(isLiveLesson({ ...base, stale: "x" })).toBe(false);
    expect(isLiveLesson({ ...base, superseded_by: "y" })).toBe(false);
  });

  it("M17: no reader in lib/memory.mjs keeps an inline three-term live predicate; only LIVE_LESSON_SQL spells archived IS NULL", () => {
    const src = readFileSync(new URL("../lib/memory.mjs", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const hits = code.filter((l) => /archived\s+IS\s+NULL/i.test(l));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("LIVE_LESSON_SQL =");
  });

  it("M16: a lesson archived by runReflect stays readable with archived set, counters and text unchanged, and cannot be deleted", async () => {
    const L = addLesson(m, { text: "text of an archived lesson", kind: "pitfall", source: { agent: "worker" } });
    m.prepare("UPDATE lessons SET harmful = 1, helpful = 1 WHERE id = ?").run(L.id);
    const report = buildReflectReport();
    report.levels[0].tasks[1].memoryUsed = [L.id];
    const result = await runReflect(m, report, { reportHash: "hash-arch-m16", dir, classes: REFLECT_CLASSES, harmful: [L.id], propose: noopPropose });
    expect(result.archived).toEqual([L.id]);
    const row = getLesson(m, L.id);
    expect(row.text).toBe("text of an archived lesson");
    expect(row.harmful).toBe(2);
    expect(row.helpful).toBe(1);
    expect(row.archived).toBeTruthy();
    expect(row.archived_reason).toMatch(/harmful/);
    expect(row.stale).toBeNull();
    expect(row.superseded_by).toBeNull();
    expect(listLessons(m).map((l) => l.id)).toContain(L.id);
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${L.id}'`)).toThrow(/add-only/);
    expect(m.prepare("SELECT COUNT(*) AS n FROM lessons").get().n).toBe(1);
  });
});

describe("archived readers and unarchive (card memory-archived-readers)", () => {
  const archive = (id) => m.prepare("UPDATE lessons SET archived = ?, archived_reason = ? WHERE id = ?").run("2026-09-29T00:00:00.000Z", "harmful 2, helpful 0", id);

  beforeEach(() => {
    m = openMemory(dir);
    clearRecallCache();
  });

  it("M1: lessonsNeedingEmbedding and embedLessons skip an archived lesson and embed a live sibling", async () => {
    addLesson(m, { id: "arch", text: "archived unembedded lesson", kind: "pattern", source: { agent: "worker" } });
    addLesson(m, { id: "live", text: "live unembedded lesson", kind: "pattern", source: { agent: "worker" } });
    archive("arch");
    expect(lessonsNeedingEmbedding(m, { model: "fake-model", dims: 3 }).map((l) => l.id)).toEqual(["live"]);
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    const res = await embedLessons(m, { ...provider, model: "fake-model", dims: 3 });
    expect(res.total).toBe(1);
    expect(getLesson(m, "arch").embedding).toBeNull();
    expect(getLesson(m, "live").embedding).not.toBeNull();
  });

  it("M7: unarchiveLesson clears archived and archived_reason, keeps text and counters, and puts the lesson back in recall", async () => {
    addLesson(m, { id: "back", text: "quokka migration notes", kind: "pattern", source: { agent: "worker" } });
    m.prepare("UPDATE lessons SET harmful = 2, helpful = 1 WHERE id = 'back'").run();
    archive("back");
    const now = new Date();
    expect((await recallLessons(m, "quokka migration", { now })).lessons).toEqual([]);
    const row = unarchiveLesson(m, "back");
    expect(row.archived).toBeNull();
    const after = getLesson(m, "back");
    expect(after.archived).toBeNull();
    expect(after.archived_reason).toBeNull();
    expect(after.text).toBe("quokka migration notes");
    expect(after.harmful).toBe(2);
    expect(after.helpful).toBe(1);
    clearRecallCache();
    expect((await recallLessons(m, "quokka migration", { now })).lessons.map((l) => l.id)).toEqual(["back"]);
    expect(m.prepare("SELECT COUNT(*) AS n FROM lessons").get().n).toBe(1);
  });

  it("M8: unarchiveLesson throws naming the id on a live lesson", () => {
    addLesson(m, { id: "livelesson", text: "live", kind: "pattern", source: { agent: "worker" } });
    expect(() => unarchiveLesson(m, "livelesson")).toThrow(/livelesson/);
  });

  it("M9: unarchiveLesson throws naming the id on an unknown id", () => {
    expect(() => unarchiveLesson(m, "does-not-exist")).toThrow(/does-not-exist/);
  });
});

describe("openMemory: v11 to v12 migration (card memory-feedback-rank)", () => {
  it("M17: a fresh store is at v12 with archived and archived_reason; a v11 store reopens at v12 with both NULL and the rows kept", () => {
    m = openMemory(dir);
    const cols = m.prepare("PRAGMA table_info(lessons)").all();
    for (const name of ["archived", "archived_reason"]) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeTruthy();
      expect(col.type).toBe("TEXT");
      expect(col.notnull).toBe(0);
    }
    const a = addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    const b = addLesson(m, { text: "keep the tests fast", kind: "pattern", source: { agent: "worker" } });
    m.exec("ALTER TABLE lessons DROP COLUMN archived;");
    m.exec("ALTER TABLE lessons DROP COLUMN archived_reason;");
    m.exec("PRAGMA user_version = 11;");
    m.close();
    const v11 = new DatabaseSync(memoryPath(dir));
    expect(v11.prepare("PRAGMA table_info(lessons)").all().map((c) => c.name)).not.toContain("archived");
    v11.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
    expect(m.prepare("PRAGMA table_info(lessons)").all().filter((c) => c.name === "archived")).toHaveLength(1);
    expect(m.prepare("PRAGMA table_info(lessons)").all().filter((c) => c.name === "archived_reason")).toHaveLength(1);
    expect(m.prepare("SELECT COUNT(*) AS n FROM lessons").get().n).toBe(2);
    for (const id of [a.id, b.id]) {
      expect(getLesson(m, id).archived).toBeNull();
      expect(getLesson(m, id).archived_reason).toBeNull();
    }
    expect(() => m.exec(`DELETE FROM lessons WHERE id = '${a.id}'`)).toThrow(/add-only/);
    m.close();
    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
  });
});

// Card memory-project-model (ADR 0019 L2): the cited project model's lib pieces. Exports assumed by these tests:
//   PROJECT_MODEL_SCHEMA, PROJECT_MODEL_CHAR_CAP (2000)
//   buildProjectModelPrompt({ lessons, runs }) -> string; lessons = live lesson rows, runs = ["<card>/<run>", ...]
//   checkProjectModelCitations(m, dir, statements) -> { kept: [statement...], dropped: [{ text, reason: "unresolved", citations }] }
//   renderProjectModel(statements, { date }) -> { text, chars, kept: [statement...], overCap: [statement...] }
describe("card memory-project-model: schema, cap and prompt", () => {
  it("PROJECT_MODEL_CHAR_CAP is 2000", () => {
    expect(PROJECT_MODEL_CHAR_CAP).toBe(2000);
  });

  it("PROJECT_MODEL_SCHEMA is { statements: [{ section (three values), text, citations (string, minItems 1) }] }", () => {
    const item = PROJECT_MODEL_SCHEMA.properties.statements.items;
    expect(PROJECT_MODEL_SCHEMA.properties.statements.type).toBe("array");
    expect(PROJECT_MODEL_SCHEMA.required).toContain("statements");
    expect([...item.properties.section.enum].sort()).toEqual(["conventions", "failure-patterns", "open-risks"]);
    expect(item.properties.text.type).toBe("string");
    expect(item.properties.citations.type).toBe("array");
    expect(item.properties.citations.items.type).toBe("string");
    expect(item.properties.citations.minItems).toBe(1);
    expect(item.required).toEqual(expect.arrayContaining(["section", "text", "citations"]));
  });

  it("the prompt lists every live lesson id and text and every run ref, names the sections, the cap, the citation forms, and points at CLAUDE.md instead of restating it", () => {
    const lessons = [
      { id: "0123456789abcdef", kind: "pitfall", text: "Orphaned vitest workers hang the stop gate", citation: "a.md" },
      { id: "fedcba9876543210", kind: "pattern", text: "Seed mutation fixtures from a real record", citation: "b.md" },
    ];
    const p = buildProjectModelPrompt({ lessons, runs: ["c1/wf_1", "c2/hand_abc1234"] });
    expect(typeof p).toBe("string");
    for (const l of lessons) {
      expect(p).toContain(l.id);
      expect(p).toContain(l.text);
    }
    expect(p).toContain("c1/wf_1");
    expect(p).toContain("c2/hand_abc1234");
    for (const s of ["failure-patterns", "conventions", "open-risks"]) expect(p).toContain(s);
    expect(p).toContain("2000");
    expect(p).toContain("CLAUDE.md");
    expect(p).toMatch(/cite/i);
    expect(p).toMatch(/rule/i);
  });
});

describe("card memory-project-model: checkProjectModelCitations", () => {
  const scan = () => null;
  const stmt = (text, citations, section = "conventions") => ({ section, text, citations });
  function seed() {
    m = openMemory(dir);
    const live = addLesson(m, { text: "Live lesson about the gate", kind: "pattern", citation: "live.md", source: { agent: "t" } });
    const old = addLesson(m, { text: "Old lesson about the gate", kind: "pattern", citation: "old.md", source: { agent: "t" } });
    const fresh = addLesson(m, { text: "Fresh lesson replacing the old one", kind: "pattern", citation: "fresh.md", source: { agent: "t" } });
    supersedeLesson(m, old.id, fresh.id);
    writeRunHistory(dir, {
      card: "c1",
      run: "wf_1",
      scan,
      entries: [1, 2, 3].map((n) => ({ kind: "hand-back", seat: "lead", round: n, source: "journal.jsonl", value: `entry ${n}` })),
    });
    return { live, old, fresh };
  }
  const check = (statements) => checkProjectModelCitations(m, dir, statements);
  const keptTexts = (r) => r.kept.map((s) => s.text);

  it("M1: a live lesson id resolves, and a well-formed 16-hex id that is not in the store does not", () => {
    const { live } = seed();
    const r = check([stmt("good", [live.id]), stmt("ghost", ["0123456789abcdef"])]);
    expect(keptTexts(r)).toEqual(["good"]);
    expect(r.dropped).toEqual([{ text: "ghost", reason: "unresolved", citations: ["0123456789abcdef"] }]);
  });

  it("M2: a superseded lesson id is unresolved while its successor resolves", () => {
    const { old, fresh } = seed();
    const r = check([stmt("cites old", [old.id]), stmt("cites fresh", [fresh.id])]);
    expect(keptTexts(r)).toEqual(["cites fresh"]);
    expect(r.dropped.map((d) => d.text)).toEqual(["cites old"]);
  });

  it("M3: a history ref resolves only with a run whose file exists (and a line that exists)", () => {
    seed();
    const ok = ["c1/wf_1", "history:c1/wf_1", "c1/wf_1:1", "history:c1/wf_1:3", "c1/wf_1.jsonl:2"];
    const r1 = check(ok.map((c, i) => stmt(`ok ${i}`, [c])));
    expect(r1.kept).toHaveLength(ok.length);
    expect(r1.dropped).toEqual([]);
  });

  it("M3: a missing run file, a missing line, and a bare <card> ref (even for a card that has history) are unresolved", () => {
    seed();
    const bad = ["c1/wf_9", "c1/wf_1:4", "history:c1/wf_1:99", "c1", "history:c1", "nocard/wf_1", "c1/wf_1:0"];
    const r = check(bad.map((c, i) => stmt(`bad ${i}`, [c])));
    expect(r.kept).toEqual([]);
    expect(r.dropped.map((d) => d.citations[0])).toEqual(bad);
  });

  it("any other string is unresolved without throwing: traversal, free text, a wrong-case id, a truncated id, an empty string", () => {
    const { live } = seed();
    const bad = ["../../etc/passwd", "see the ADR", "lesson:" + live.id, live.id.toUpperCase(), live.id.slice(0, 15), "", "c1/wf_1/extra"];
    const r = check(bad.map((c, i) => stmt(`odd ${i}`, [c])));
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(bad.length);
  });

  it("a statement with an empty citations array is dropped as unresolved (reviewer finding R2)", () => {
    seed();
    const r = check([stmt("no citations", [])]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{ text: "no citations", reason: "unresolved", citations: [] }]);
  });

  it("M4: a statement with one good and one bad citation is dropped whole, with all its citations listed; order and fields of kept statements are preserved", () => {
    const { live } = seed();
    const mixed = stmt("half good", [live.id, "0123456789abcdef"], "open-risks");
    const goodA = stmt("good a", [live.id, "c1/wf_1:2"], "failure-patterns");
    const goodB = stmt("good b", ["c1/wf_1"], "conventions");
    const r = check([goodA, mixed, goodB]);
    expect(r.kept).toEqual([goodA, goodB]);
    expect(r.dropped).toEqual([{ text: "half good", reason: "unresolved", citations: [live.id, "0123456789abcdef"] }]);
  });

  it("M5: every unresolved statement is reported once in dropped (the count the CLI prints)", () => {
    const { live } = seed();
    const r = check([stmt("a", ["0123456789abcdef"]), stmt("b", [live.id]), stmt("c", ["c1/wf_9"]), stmt("d", [live.id, "nope"])]);
    expect(r.dropped.map((d) => d.text)).toEqual(["a", "c", "d"]);
    expect(r.kept).toHaveLength(1);
  });
});

describe("card memory-project-model: renderProjectModel", () => {
  const stmt = (text, citations, section) => ({ section, text, citations });
  const nonBlank = (t) => t.split("\n").filter((l) => l.trim() !== "");
  const HEADER =
    "Generated by `memory.mjs model regen` on 2026-10-21; do not edit by hand. Each statement cites a lesson (`memory.mjs lesson show <id>`) or a run record (`memory.mjs history show <ref>`).";
  const ID = "aaaaaaaaaaaaaaaa";

  it("renders the header, then sections in fixed order with the model's order inside a section and `- text [c1, c2]` lines", () => {
    const r = renderProjectModel(
      [
        stmt("conv one", [ID], "conventions"),
        stmt("risk one", ["c1/wf_1:2"], "open-risks"),
        stmt("fail one", [ID, "c1/wf_1"], "failure-patterns"),
        stmt("conv two", ["history:c1/wf_1:3"], "conventions"),
        stmt("fail two", [ID], "failure-patterns"),
      ],
      { date: "2026-10-21" }
    );
    expect(nonBlank(r.text)).toEqual([
      "# Project model",
      HEADER,
      "## Failure patterns",
      `- fail one [${ID}, c1/wf_1]`,
      `- fail two [${ID}]`,
      "## Conventions",
      `- conv one [${ID}]`,
      "- conv two [history:c1/wf_1:3]",
      "## Open risks",
      "- risk one [c1/wf_1:2]",
    ]);
    expect(r.text.startsWith("# Project model\n")).toBe(true);
    expect(r.chars).toBe(r.text.length);
    expect(r.kept).toHaveLength(5);
    expect(r.overCap).toEqual([]);
  });

  it("leaves out a section with no statements", () => {
    const r = renderProjectModel([stmt("only conv", [ID], "conventions")], { date: "2026-10-21" });
    expect(r.text).toContain("## Conventions");
    expect(r.text).not.toContain("## Failure patterns");
    expect(r.text).not.toContain("## Open risks");
  });

  // A line is "- " + text + " [" + citations joined by ", " + "]": 99 characters, so 100 with its newline.
  const one = (n, extra = 0) => stmt(`S${String(n).padStart(2, "0")} `.padEnd(78 - extra * 36, "x"), [ID, ...Array.from({ length: extra * 2 }, (_, i) => String(i + 1).repeat(16))], "failure-patterns");

  it("M6: with the header counted, the whole file is at most 2000 characters even when the statements alone fit in it", () => {
    const input = Array.from({ length: 19 }, (_, i) => one(i + 1));
    const bodyOnly = input.reduce((n, s) => n + `- ${s.text} [${s.citations.join(", ")}]`.length + 1, 0);
    expect(bodyOnly).toBeLessThanOrEqual(2000 - 80); // the statements alone fit: only the header pushes the file over
    const r = renderProjectModel(input, { date: "2026-10-21" });
    expect(r.text.length).toBeLessThanOrEqual(PROJECT_MODEL_CHAR_CAP);
    expect(r.chars).toBe(r.text.length);
    expect(r.kept.length).toBeGreaterThanOrEqual(15); // adds statements while the file still fits, not fewer
    expect(r.kept.length).toBeLessThan(19);
  });

  it("M8: every statement left out is counted in overCap, and kept plus overCap is the input", () => {
    const input = Array.from({ length: 19 }, (_, i) => one(i + 1));
    const r = renderProjectModel(input, { date: "2026-10-21" });
    expect(r.overCap.length).toBeGreaterThanOrEqual(1);
    expect(r.kept.length + r.overCap.length).toBe(19);
    expect(new Set([...r.kept, ...r.overCap].map((s) => s.text)).size).toBe(19);
  });

  it("M7: over the cap the most-cited statements stay (ties keep the model's order), and the render keeps the model's order", () => {
    // 17 one-citation statements, then two three-citation statements last; every line is the same length.
    const input = [...Array.from({ length: 17 }, (_, i) => one(i + 1)), one(18, 1), one(19, 1)];
    expect(input.map((s) => `- ${s.text} [${s.citations.join(", ")}]`.length)).toEqual(Array(19).fill(99));
    const r = renderProjectModel(input, { date: "2026-10-21" });
    const keptTexts = r.kept.map((s) => s.text);
    expect(keptTexts).toContain(input[17].text);
    expect(keptTexts).toContain(input[18].text);
    expect(r.overCap.map((s) => s.text)).not.toContain(input[17].text);
    expect(r.overCap.map((s) => s.text)).not.toContain(input[18].text);
    // the one-citation statements that survive are the earliest ones, in order
    const ones = keptTexts.filter((t) => t !== input[17].text && t !== input[18].text);
    expect(ones).toEqual(input.slice(0, ones.length).map((s) => s.text));
    expect(r.overCap.map((s) => s.text)).toEqual(input.slice(ones.length, 17).map((s) => s.text));
    // rendered order is the model's order (the highly cited ones come last)
    const lines = nonBlank(r.text).filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(r.kept.length);
    expect(lines[lines.length - 2]).toContain(input[17].text);
    expect(lines[lines.length - 1]).toContain(input[18].text);
    expect(r.text.length).toBeLessThanOrEqual(PROJECT_MODEL_CHAR_CAP);
  });
});

// --- busy timeout (card memory-db-busy-timeout) -------------------------------------------------------------------
// A second process holds BEGIN EXCLUSIVE on memory.db; the synchronous lib call runs in this process while the holder
// releases from its own process, so the parent's blocked event loop does not stall the release.
async function holdExclusive(file, ms) {
  const code = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN EXCLUSIVE");
db.exec("INSERT INTO lessons_fts(lessons_fts) VALUES('optimize')");
process.stdout.write("held\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));`;
  const child = spawn(process.execPath, ["-e", code, file, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((res) => child.on("exit", res));
  await new Promise((res, rej) => {
    child.on("error", rej);
    child.stdout.on("data", (d) => String(d).includes("held") && res());
  });
  return { exited };
}

describe("openMemory busy timeout", () => {
  it("waits out a second process's write lock, then the write lands", async () => {
    m = openMemory(dir);
    m.close();
    m = null;
    const { exited } = await holdExclusive(memoryPath(dir), 800);
    try {
      m = openMemory(dir);
      addLesson(m, { text: "written after the lock cleared", kind: "pattern", source: { agent: "worker" } });
      expect(listLessons(m).map((r) => r.text)).toContain("written after the lock cleared");
    } finally {
      await exited;
    }
  });

  it("gives up with 'database is locked' within the bound, below the 5 s SessionStart hook timeout", async () => {
    m = openMemory(dir);
    m.close();
    m = null;
    const { exited } = await holdExclusive(memoryPath(dir), 6500);
    const t0 = Date.now();
    let err = null;
    try {
      m = openMemory(dir);
      addLesson(m, { text: "never lands", kind: "pattern", source: { agent: "worker" } });
    } catch (e) {
      err = e;
    }
    const waited = Date.now() - t0;
    await exited;
    expect(err).not.toBeNull();
    expect(String(err.message)).toMatch(/database is locked/);
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(waited).toBeLessThan(4500);
  });
});

describe("inspectMemory (read-only) busy timeout", () => {
  it("waits out a second process's write lock", async () => {
    m = openMemory(dir);
    addLesson(m, { text: "seed", kind: "pattern", source: { agent: "worker" } });
    m.close();
    m = null;
    const { exited } = await holdExclusive(memoryPath(dir), 800);
    let r;
    try {
      r = inspectMemory(dir);
    } finally {
      await exited;
    }
    expect(r.error).toBeNull();
    expect(r.userVersion).toBe(12);
  });
});

// --- BEGIN IMMEDIATE (card memory-db-begin-immediate) -------------------------------------------------------------
// A deferred BEGIN that reads and then writes upgrades SHARED to RESERVED; SQLite returns SQLITE_BUSY for that upgrade
// at once, without calling the busy handler. So the holder here takes RESERVED (BEGIN IMMEDIATE), which lets readers
// in; holdExclusive would block the first read and let deferred code pass.
async function holdReserved(file, ms) {
  const code = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("held\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));`;
  const child = spawn(process.execPath, ["-e", code, file, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((res) => child.on("exit", res));
  await new Promise((res, rej) => {
    child.on("error", rej);
    child.stdout.on("data", (d) => String(d).includes("held") && res());
  });
  return { exited };
}

describe("write transactions wait out a second process's write lock (card memory-db-begin-immediate)", () => {
  it("recordOutcomes waits out a second process holding the write lock (reader-then-writer)", async () => {
    m = openMemory(dir);
    const { exited } = await holdReserved(memoryPath(dir), 800);
    let elapsed;
    const t0 = Date.now();
    try {
      recordOutcomes(m, [handOutcomeRow({ card: "c-bi1", commit: "sha-bi1", now: "2026-10-01T00:00:00.000Z" })]);
      elapsed = Date.now() - t0;
    } finally {
      await exited;
    }
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(MEMORY_BUSY_TIMEOUT_MS + 1000);
    expect(listOutcomes(m, { track: "hand" }).map((r) => r.card)).toContain("c-bi1");
  });

  it("openMemory migrates a v11 store while a second process holds the write lock", async () => {
    m = openMemory(dir);
    m.exec("ALTER TABLE lessons DROP COLUMN archived;");
    m.exec("ALTER TABLE lessons DROP COLUMN archived_reason;");
    m.exec("PRAGMA user_version = 11;");
    m.close();
    m = null;
    const { exited } = await holdReserved(memoryPath(dir), 800);
    let elapsed;
    const t0 = Date.now();
    try {
      m = openMemory(dir);
      elapsed = Date.now() - t0;
    } finally {
      await exited;
    }
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(MEMORY_BUSY_TIMEOUT_MS + 1000);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(12);
  });

  it("runReflect applies counters while a second process holds the write lock", async () => {
    m = openMemory(dir);
    const lesson = addLesson(m, { text: "a pattern worth keeping around", kind: "pattern", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[0].memoryUsed = [lesson.id];
    const { exited } = await holdReserved(memoryPath(dir), 800);
    let result;
    let elapsed;
    const t0 = Date.now();
    try {
      result = await runReflect(m, report, { reportHash: "hash-bi-reflect", dir, classes: REFLECT_CLASSES, propose: noopPropose });
      elapsed = Date.now() - t0;
    } finally {
      await exited;
    }
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(MEMORY_BUSY_TIMEOUT_MS + 1000);
    expect(result.ok).toBe(true);
    expect(result.counters.helpful).toEqual([lesson.id]);
    expect(getLesson(m, lesson.id).helpful).toBe(1);
  });
});
