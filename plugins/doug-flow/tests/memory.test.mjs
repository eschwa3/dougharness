import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { classifyBlocks } from "../lib/board.mjs";
import { CODEX_PRICES } from "../lib/cost.mjs";
import {
  MEMORY_DB_RELPATH,
  memoryPath,
  openMemory,
  addLesson,
  getLesson,
  supersedeLesson,
  listLessons,
  searchLessons,
  outcomeRows,
  recordOutcomes,
  listOutcomes,
  handOutcomeRow,
  conditionConfigHash,
  setLessonEmbedding,
  lessonsNeedingEmbedding,
  embedLessons,
  checkCitation,
  recallLessons,
  unstaleLesson,
  runReflect,
  buildReflectPrompt,
  REFLECT_SCHEMA,
  REFLECT_DUPLICATE_JACCARD,
  REFLECT_PROMPT_LESSON_CAP,
} from "../lib/memory.mjs";

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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
    addLesson(m, { text: "keep the gate green", kind: "pattern", source: { agent: "worker" } });
    m.close();

    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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

  it("M1 (card run-report-codex-cost): a fresh store is at user_version 8 with a codex_usd column on outcomes", () => {
    m = openMemory(dir);
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
    const cols = m.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name);
    expect(cols).toContain("codex_usd");
  });
});

describe("openMemory: a store from a future schema version", () => {
  it("throws one clear error naming the store's version and the version this code understands, rather than opening it silently", () => {
    const file = memoryPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE outcomes (id INTEGER PRIMARY KEY);");
    raw.exec("PRAGMA user_version = 9");
    raw.close();

    expect(() => openMemory(dir)).toThrow(/user_version 9/);
    expect(() => openMemory(dir)).toThrow(/understands up to version 8/);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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
    expect(m.prepare("PRAGMA user_version").get().user_version).toBe(8);
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

  it("fuses bm25 and vector ranks by reciprocal rank fusion, reordering a weak keyword match ahead of a strong one when the vector side favors it", async () => {
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

  it("REFLECT_SCHEMA requires lessons and REFLECT_DUPLICATE_JACCARD is 0.6", () => {
    expect(REFLECT_SCHEMA.required).toEqual(["lessons"]);
    expect(REFLECT_SCHEMA.properties.lessons.items.required).toEqual(["kind", "text", "citation", "task", "notDerivableBecause"]);
    expect(REFLECT_DUPLICATE_JACCARD).toBe(0.6);
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

  it("real wins over verified (harmful, not helpful), a first-verified task's used lessons get helpful, an unknown id is reported not thrown, and a task with neither touches nothing", async () => {
    const helpfulLesson = addLesson(m, { text: "a pattern worth keeping around", kind: "pattern", source: { agent: "worker" } });
    const harmfulLesson = addLesson(m, { text: "a pitfall that bit us badly", kind: "pitfall", source: { agent: "worker" } });
    const report = buildReflectReport();
    report.levels[0].tasks[0].memoryUsed = [helpfulLesson.id, "lesson-missing"];
    report.levels[0].tasks[1].memoryUsed = [harmfulLesson.id];

    const result = await runReflect(m, report, { reportHash: "hash-counters-1", dir, classes: REFLECT_CLASSES, propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.counters.helpful).toEqual([helpfulLesson.id]);
    expect(result.counters.harmful).toEqual([harmfulLesson.id]);
    expect(result.counters.unknown).toEqual(["lesson-missing"]);
    expect(getLesson(m, helpfulLesson.id).helpful).toBe(1);
    expect(getLesson(m, helpfulLesson.id).harmful).toBe(0);
    expect(getLesson(m, harmfulLesson.id).harmful).toBe(1);
    expect(getLesson(m, harmfulLesson.id).helpful).toBe(0);
    // neither-task's memoryUsed (an id naming no lesson) never shows up anywhere: nothing bumped, nothing unknown.
    expect(result.counters.helpful).not.toContain("lesson-untouched");
    expect(result.counters.harmful).not.toContain("lesson-untouched");
    expect(result.counters.unknown).not.toContain("lesson-untouched");
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
    const result = await runReflect(m, report, {
      reportHash: "hash-fail-1",
      dir,
      classes: REFLECT_CLASSES,
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
    report.levels[0].tasks[0].memoryUsed = [helpfulLesson.id];
    const result = await runReflect(m, report, { reportHash: "hash-dry-1", dir, classes: REFLECT_CLASSES, dryRun: true, propose: noopPropose });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.counters.helpful).toEqual([helpfulLesson.id]);
    expect(getLesson(m, helpfulLesson.id).helpful).toBe(0);
    expect(m.prepare("SELECT * FROM reflections WHERE report_hash = ?").get("hash-dry-1")).toBeUndefined();
    expect(listLessons(m)).toHaveLength(1);
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

  it("C.4: a near-duplicate (Jaccard >= REFLECT_DUPLICATE_JACCARD) or an addLesson id collision bumps the existing lesson instead of appending", async () => {
    const existing = addLesson(m, { text: "always run pnpm typecheck before every commit to the repo", kind: "pattern", citation: "report:clean-task", source: { agent: "worker" } });
    const near = { kind: "pattern", text: "always run pnpm typecheck before every commit made to the repo", citation: "report:clean-task", task: "clean-task", notDerivableBecause: "distinct enough" };
    const idCollision = { kind: existing.kind, text: existing.text, citation: existing.citation, task: "clean-task", notDerivableBecause: "same exact text and kind" };
    const result = await reflectWithProposals([near, idCollision], "hash-filter-c4");
    expect(result.appended).toHaveLength(0);
    expect(result.bumped).toEqual([existing.id, existing.id]);
    expect(getLesson(m, existing.id).helpful).toBe(2);
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

  it("C.5 (minor 4): the 3-item cap limits appends, not evaluation — a near-duplicate found past the cap still bumps; only a genuinely new proposal past the cap is rejected naming the limit", async () => {
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
    // p4 is a near-duplicate of the already-appended p1: it bumps p1, it is not rejected for the cap.
    expect(result.bumped).toEqual([p1Id]);
    expect(getLesson(m, p1Id).helpful).toBe(1);
    // p5 is genuinely new and only rejected because the cap of 3 appends is already spent.
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].text).toBe(p5GenuinelyNew.text);
    expect(result.rejected[0].reason).toMatch(/at most 3/);
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
