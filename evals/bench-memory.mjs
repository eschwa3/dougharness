#!/usr/bin/env node
// bench-memory.mjs (card memory-benchmark, stage 1): a repeatable benchmark of the memory store
// (plugins/doug-flow/lib/memory.mjs). Subcommands: snapshot | accuracy | speed | usefulness | all.
// Run `node evals/bench-memory.mjs --help` for flags. Offline and free by default; a provider-backed pass
// (semantic, hybrid, rerank) runs only when a provider is configured (--config <dir>) or --ollama, and a paid
// (non-localhost) provider runs only with --spend --price-per-mtok <usd> --cap <usd> and an estimate within
// the cap. No price is hard-coded here.
//
// Metric definitions are those of evals/measure-recall.mjs (header comment, Manning/Raghavan/Schuetze ch. 8):
//   P@k = (relevant items in the top k) / k
//   R@k = (relevant items in the top k) / (all relevant items for the query)
//   RR  = 1 / (rank of the first relevant item), 0 when none is in the top k; MRR = mean of RR.
// Each is a plain arithmetic mean over the scored queries.
//
// Percentile (nearest rank): p-th percentile of n values = the value at 1-based rank ceil(p * n / 100) of the
// ascending sorted copy (rank at least 1). It never interpolates, so p95 of 20 values is the 19th, not the max.
//
// Retriever adapter: { name, kind: "keyword"|"dense"|"hybrid"|"grep"|"framework", mode, setup(lessons, ctx) ->
// state, search(state, query, k) -> ordered keys (citation basenames), teardown(state), meta(state) ->
// { storageBytes, dependency } }. `mode` names the key under `modes` in the accuracy result (defaults to kind).
// meta takes the state because storage is only known after setup. Accuracy and speed loop over a registry.
//
// Output splits into `deterministic` (accuracy, usefulness, counts, storage bytes of the deterministic builds:
// identical on every rerun over the same snapshot) and `timings` (wall clock: varies by machine and run).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, copyFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  openMemory,
  memoryPath,
  addLesson,
  searchLessons,
  embedLessons,
  recallLessons,
  ftsMatchQuery,
  handOutcomeRow,
  recordOutcomes,
} from "../plugins/doug-flow/lib/memory.mjs";
import { importAutoMemory } from "../plugins/doug-flow/lib/memory-import.mjs";
import { readMemoryConfig, createProvider, probeProvider } from "../plugins/doug-flow/lib/embeddings.mjs";
import { projectSlug } from "../plugins/doug-flow/lib/cost.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DEFAULT_QUERIES = join(here, "memory/bench-queries.jsonl");
const MEMORY_CLI = join(root, "plugins/doug-flow/scripts/memory.mjs");
const HOOKS_DIR = join(root, "plugins/doug-gates/scripts");
const DEFAULT_K = 8;
const DEFAULT_ITERATIONS = 30;
const DEFAULT_SIZES = "real,1000,10000,100000";
const DEFAULT_BUDGET_MS = 20000;
const DEFAULT_IMPORT_FILES = 50;
const IMPORT_FULL_MAX = 1000;
const GREP_MAX_LESSONS = 20000;
const STALE_DAYS = 30;
const SPEED_SEED = 20261002;
const SYN_NOW = Date.parse("2026-01-01T00:00:00.000Z");
const QUERY_TYPES = ["title", "goal", "paraphrase"];
const FRAMEWORKS_DIR = join(here, "frameworks");
const FRAMEWORK_VENV = join(root, ".doug/.state/bench/py");
const FRAMEWORK_PYTHON = join(FRAMEWORK_VENV, "bin/python");
const NOT_INSTALLED_FRAMEWORKS = "not installed: run bench-memory.mjs install-frameworks";

// --- small pure helpers ------------------------------------------------------------------------------------------

export function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[Math.min(rank, sorted.length) - 1];
}

const STOPWORDS = new Set(
  ("the and for with that this from are was were but not you all can has have its into than then they their there " +
    "been will would should could does did why how what when where who which about also any per").split(" ")
);

export function tokenize(text) {
  const out = [];
  for (const m of String(text ?? "").toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length >= 3 && !STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

const unique = (xs) => [...new Set(xs)];

export function validateParaphrase(query, text) {
  const inText = new Set(tokenize(text));
  const shared = unique(tokenize(query)).filter((t) => inText.has(t));
  return { ok: shared.length === 0, shared };
}

// tokenFiles: { token: [file...] } as `grep -ril -F token <dir>` printed it. Files rank by the number of
// DISTINCT query tokens found in them (desc), ties by filename ascending; files with no hit are omitted.
export function rankByGrep(queryTokens, tokenFiles) {
  const counts = new Map();
  for (const t of unique(queryTokens)) {
    for (const f of unique(tokenFiles[t] || [])) counts.set(f, (counts.get(f) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([f]) => f);
}

export function scoreQueries(perQuery, k) {
  const agg = (qs) => {
    if (!qs.length) return { n: 0, recallAtK: 0, precisionAtK: 0, mrr: 0 };
    let r = 0;
    let p = 0;
    let rr = 0;
    for (const q of qs) {
      const expected = new Set(q.expected);
      const top = unique(q.ranked).slice(0, k);
      const hits = top.filter((key) => expected.has(key)).length;
      const first = top.findIndex((key) => expected.has(key));
      r += expected.size ? hits / expected.size : 0;
      p += hits / k;
      rr += first >= 0 ? 1 / (first + 1) : 0;
    }
    return { n: qs.length, recallAtK: r / qs.length, precisionAtK: p / qs.length, mrr: rr / qs.length };
  };
  const byType = {};
  for (const type of unique(perQuery.map((q) => q.type))) byType[type] = agg(perQuery.filter((q) => q.type === type));
  return { ...agg(perQuery), byType };
}

// mulberry32: a 32-bit seeded PRNG, so a synthetic store is identical on every run (never Math.random).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRE = ["quar", "mar", "cob", "jun", "ony", "tun", "saf", "zeph", "brin", "calt", "dov", "elm", "fyr", "gran", "hel", "ivo"];
const SUF = ["tz", "ble", "alt", "iper", "x", "dra", "fron", "yr", "wick", "ton", "mere", "ley", "stone", "vale", "crest", "burn"];
const COMMON = ["cache", "lock", "build", "parser", "config", "timeout", "retry", "queue", "sync", "hook", "gate", "plan", "test", "report", "merge", "token", "index", "store", "worker", "review"];
export const VOCABULARY = [...COMMON, ...PRE.flatMap((p) => SUF.map((s) => p + s))];
const KINDS = ["project", "project", "project", "project", "feedback", "pitfall", "pattern"];

function pick(rng) {
  return VOCABULARY[Math.floor(rng() ** 1.5 * VOCABULARY.length)];
}

// n synthetic lessons, snapshot-shaped. `now` (ms, Date, or ISO string) anchors `created` (0-20 days before it);
// the default is a fixed instant so the same (seed, n) is the same lessons everywhere.
export function generateLessons(seed, n, { now = SYN_NOW } = {}) {
  const rng = mulberry32(seed);
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const lessons = [];
  for (let i = 0; i < n; i++) {
    const words = Array.from({ length: 14 + Math.floor(rng() * 13) }, () => pick(rng));
    const text = words[0][0].toUpperCase() + words[0].slice(1) + " " + words.slice(1).join(" ") + ".";
    lessons.push({
      id: `g${seed}-${i}`,
      kind: KINDS[Math.floor(rng() * KINDS.length)],
      citation: `gen-${seed}-${i}.md`,
      text,
      created: new Date(nowMs - Math.floor(rng() * 20 * 86400000)).toISOString(),
      confirmed: null,
      helpful: 0,
      harmful: 0,
      superseded_by: null,
      stale: null,
    });
  }
  return lessons;
}

function syntheticQueries(seed, n) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  return Array.from({ length: n }, () => Array.from({ length: 3 + Math.floor(rng() * 3) }, () => pick(rng)).join(" "));
}

const readJsonl = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

export function readSnapshot(file) {
  const rows = readJsonl(file);
  const header = rows.length && rows[0].id === undefined ? rows.shift() : {};
  return { snapshotAt: header.snapshotAt ?? null, reflections: header.reflections ?? null, lessons: rows };
}

export function summarizeLessonCounters(lessons) {
  const s = { withHelpful: 0, withHarmful: 0, helpfulSum: 0, harmfulSum: 0 };
  for (const l of lessons) {
    if (l.helpful > 0) s.withHelpful++;
    if (l.harmful > 0) s.withHarmful++;
    s.helpfulSum += l.helpful || 0;
    s.harmfulSum += l.harmful || 0;
  }
  return s;
}

function walkJson(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJson(p));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

// A report is a JSON file with a `levels` array; its tasks are levels[].tasks[]. A task "used memory" when its
// memoryUsed array is non-empty (absent and empty do not count). A report whose bytes were already seen (the
// last report is usually also saved under reports/) is counted once.
export function collectUsefulness({ reportsDir, lastReportFile, lessonIds }) {
  const known = new Set(lessonIds);
  const files = [...(reportsDir ? walkJson(reportsDir) : []), ...(lastReportFile && existsSync(lastReportFile) ? [lastReportFile] : [])];
  const seen = new Set();
  const used = new Set();
  let reports = 0;
  let tasks = 0;
  let withMemory = 0;
  for (const f of files) {
    let raw;
    let doc;
    try {
      raw = readFileSync(f, "utf8");
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!doc || !Array.isArray(doc.levels)) continue;
    const hash = createHash("sha256").update(raw).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    reports++;
    for (const level of doc.levels) {
      for (const task of (level && level.tasks) || []) {
        tasks++;
        if (Array.isArray(task.memoryUsed) && task.memoryUsed.length) {
          withMemory++;
          for (const id of task.memoryUsed) used.add(id);
        }
      }
    }
  }
  const unresolvedIds = [...used].filter((id) => !known.has(id)).sort();
  return {
    reports,
    tasks,
    tasksWithMemoryUsed: withMemory,
    distinctLessonIdsUsed: used.size,
    resolvedIdsUsed: used.size - unresolvedIds.length,
    unresolvedIds,
  };
}

// --- the real store, read-only -----------------------------------------------------------------------------------

export function readStore(storeDir) {
  const file = memoryPath(storeDir);
  if (!existsSync(file)) throw new Error(`no memory store at ${file}`);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const lessons = db
      .prepare("SELECT id, kind, citation, text, created, confirmed, helpful, harmful, superseded_by, stale FROM lessons ORDER BY created ASC, id ASC")
      .all()
      .map((r) => ({ ...r, citation: r.citation ? basename(r.citation) : null }));
    let reflections = null;
    try {
      reflections = { rows: 0, helpful: 0, harmful: 0, unknown: 0 };
      for (const r of db.prepare("SELECT counters FROM reflections").all()) {
        reflections.rows++;
        const c = JSON.parse(r.counters);
        for (const key of ["helpful", "harmful", "unknown"]) reflections[key] += Array.isArray(c[key]) ? c[key].length : Number(c[key]) || 0;
      }
    } catch {
      reflections = null;
    }
    return { lessons, reflections };
  } finally {
    db.close();
  }
}

export function writeSnapshot({ store, out, now = new Date() }) {
  const { lessons, reflections } = readStore(store);
  const file = out || join(store, ".doug/.state/bench/lessons.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const header = { snapshotAt: now.toISOString(), lessons: lessons.length, reflections };
  writeFileSync(file, [header, ...lessons].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { file, snapshotAt: header.snapshotAt, count: lessons.length };
}

// Freezes the usefulness inputs next to the snapshot: the last report as <outDir>/last-report.json and every report
// JSON (a file with a `levels` array) under reportsDir as <outDir>/reports/<same relative path>. A previous freeze
// is replaced, so the copies always match the snapshot they sit beside.
export function freezeReports({ outDir, reportsDir, lastReportFile }) {
  const files = [];
  rmSync(join(outDir, "reports"), { recursive: true, force: true });
  rmSync(join(outDir, "last-report.json"), { force: true });
  mkdirSync(outDir, { recursive: true });
  if (lastReportFile && existsSync(lastReportFile)) {
    copyFileSync(lastReportFile, join(outDir, "last-report.json"));
    files.push("last-report.json");
  }
  if (reportsDir) {
    for (const f of walkJson(reportsDir)) {
      let doc;
      try {
        doc = JSON.parse(readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      if (!doc || !Array.isArray(doc.levels)) continue;
      const rel = relative(reportsDir, f);
      mkdirSync(dirname(join(outDir, "reports", rel)), { recursive: true });
      copyFileSync(f, join(outDir, "reports", rel));
      files.push(`reports/${rel}`);
    }
  }
  return { reports: files.length, files };
}

// --- scratch stores and retrievers -------------------------------------------------------------------------------

const isLive = (l) => !l.superseded_by && !l.stale;
const ageDays = (l, nowMs) => (nowMs - new Date(l.confirmed || l.created).getTime()) / 86400000;
const dedupe = (keys) => unique(keys.filter((k) => k));
const toMs = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).getTime();
// The one recency rule every retriever shares (the rule recallLessons applies to fts5): a lesson is a candidate
// when it is not superseded, not stale, and `confirmed || created` is within STALE_DAYS of `now`.
const eligible = (lessons, nowMs, staleDays = STALE_DAYS) => lessons.filter((l) => isLive(l) && ageDays(l, nowMs) <= staleDays);

function buildStore(dir, lessons) {
  const m = openMemory(dir);
  // Scratch store: skip the per-commit fsync while building (100k lessons would take minutes), then restore the
  // default so the timed record call below pays the same durability cost as the real store.
  m.exec("PRAGMA synchronous = OFF");
  for (const l of lessons) {
    addLesson(m, { id: l.id, text: l.text, kind: l.kind, citation: l.citation ?? null, source: { agent: "bench" }, created: l.created });
  }
  const upd = m.prepare("UPDATE lessons SET confirmed = ?, helpful = ?, harmful = ?, stale = ? WHERE id = ?");
  const sup = m.prepare("UPDATE lessons SET superseded_by = ? WHERE id = ?");
  m.exec("BEGIN");
  for (const l of lessons) upd.run(l.confirmed ?? null, l.helpful || 0, l.harmful || 0, l.stale ?? null, l.id);
  for (const l of lessons) if (l.superseded_by) sup.run(l.superseded_by, l.id);
  m.exec("COMMIT");
  m.exec("PRAGMA synchronous = FULL");
  return m;
}

const fileSize = (p) => (existsSync(p) ? statSync(p).size : 0);
const dbBytes = (dir) => fileSize(memoryPath(dir)) + fileSize(memoryPath(dir) + "-wal");

export const fts5 = {
  name: "fts5",
  kind: "keyword",
  mode: "keyword",
  async setup(lessons, ctx = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bench-fts5-"));
    return { dir, m: buildStore(dir, lessons), now: ctx.now ?? new Date() };
  },
  async search(state, query, k) {
    const r = await recallLessons(state.m, query, { k, now: state.now, provider: null });
    return dedupe(r.lessons.map((l) => l.citation));
  },
  teardown(state) {
    state.m.close();
    rmSync(state.dir, { recursive: true, force: true });
  },
  meta: (state) => ({ storageBytes: dbBytes(state.dir), dependency: "node:sqlite (FTS5), built into Node >=22.16; nothing to install" }),
};

// The shipped BM25 side of recallLessons (memory.mjs recallLessons step b): the FTS5 top `n` of the live lessons in
// `m`, in bm25 order, keeping only ids in `ids` (the recency-window set). The limit applies before the window
// filter, exactly as in the product.
function bm25Ids(m, query, ids, n = 50) {
  const match = ftsMatchQuery(query);
  if (!match) return [];
  return m
    .prepare(
      `SELECT l.id FROM lessons_fts f JOIN lessons l ON l.id = f.id
       WHERE lessons_fts MATCH ? AND l.superseded_by IS NULL AND l.stale IS NULL
       ORDER BY bm25(lessons_fts) LIMIT ?`
    )
    .all(match, n)
    .map((r) => r.id)
    .filter((id) => ids.has(id));
}

// The shipped recallLessons formula with the recency weight fixed at 1 (the shipped weight is
// 0.5 + 0.5 * exp(-ageDays / 90), applied to the BM25 score in the no-provider fallback): the BM25 order of the live, in-window lessons. The
// stage-2 attribution of the shipped `fts5` row to recency is measured by comparing it with this row.
export const fts5NoRecency = {
  name: "fts5:norecency",
  kind: "keyword",
  mode: "fts5:norecency",
  async setup(lessons, ctx = {}) {
    const st = await fts5.setup(lessons, ctx);
    st.ids = new Set(eligible(lessons, toMs(st.now)).map((l) => l.id));
    st.citation = new Map(lessons.map((l) => [l.id, l.citation]));
    return st;
  },
  async search(st, query, k) {
    return dedupe(bm25Ids(st.m, query, st.ids).map((id) => st.citation.get(id))).slice(0, k);
  },
  teardown: (st) => fts5.teardown(st),
  meta: (st) => fts5.meta(st),
};

// SQLite FTS5 tokenizer variants over a bench-owned table in a scratch db (not the shipped lessons_fts): same
// lessons (live, inside the recency window at ctx.now), same OR-of-quoted-tokens query as the shipped path
// (ftsMatchQuery), same bm25 ordering; only the tokenizer differs. porter stems; trigram matches substrings.
const FTS_TOKENIZERS = { porter: "porter unicode61", trigram: "trigram" };
export function ftsVariant(tokenizer) {
  const tokenize_ = FTS_TOKENIZERS[tokenizer];
  if (!tokenize_) throw new Error(`unknown fts5 tokenizer variant: ${tokenizer} (porter | trigram)`);
  const name = `fts5:${tokenizer}`;
  return {
    name,
    kind: "keyword",
    mode: name,
    async setup(lessons, ctx = {}) {
      const dir = mkdtempSync(join(tmpdir(), "bench-fts5v-"));
      const file = join(dir, "variant.db");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const db = new DatabaseSync(file);
      db.exec("PRAGMA journal_mode = OFF");
      db.exec("PRAGMA synchronous = OFF");
      db.exec(`CREATE VIRTUAL TABLE docs USING fts5(text, tokenize='${tokenize_}')`);
      const ins = db.prepare("INSERT INTO docs(rowid, text) VALUES (?, ?)");
      const citations = [];
      db.exec("BEGIN");
      for (const l of eligible(lessons, toMs(ctx.now))) {
        ins.run(citations.length + 1, l.text);
        citations.push(l.citation);
      }
      db.exec("COMMIT");
      return { dir, file, db, citations };
    },
    async search(state, query, k) {
      const match = ftsMatchQuery(query);
      if (!match) return [];
      const rows = state.db.prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT ?").all(match, k);
      return dedupe(rows.map((r) => state.citations[Number(r.rowid) - 1]));
    },
    teardown(state) {
      state.db.close();
      rmSync(state.dir, { recursive: true, force: true });
    },
    meta: (state) => ({ storageBytes: fileSize(state.file), dependency: `node:sqlite FTS5 tokenizer '${tokenize_}', built in; nothing to install` }),
  };
}

// `grep -ril -F <token> <dir>` per distinct query token over one file per eligible lesson (live, inside the same
// recency window as every other retriever), named by lesson id so lessons that share a citation stay separate;
// files rank by rankByGrep (ties by file name) and map back to their citation.
export const grep = {
  name: "grep",
  kind: "grep",
  mode: "grep",
  maxLessons: GREP_MAX_LESSONS,
  skipReason: (n) => `grep over ${n} files not run above ${GREP_MAX_LESSONS}: one token scan alone took tens of seconds to minutes`,
  async setup(lessons, ctx = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bench-grep-"));
    const citationOf = new Map();
    let bytes = 0;
    let i = 0;
    for (const l of eligible(lessons, toMs(ctx.now))) {
      if (!l.citation) continue;
      const name = `${String(i++).padStart(7, "0")}-${String(l.id).replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;
      const body = l.text + "\n";
      writeFileSync(join(dir, name), body);
      citationOf.set(name, l.citation);
      bytes += Buffer.byteLength(body);
    }
    return { dir, bytes, citationOf };
  },
  async search(state, query, k) {
    const tokenFiles = {};
    for (const t of unique(tokenize(query))) {
      const r = spawnSync("grep", ["-ril", "-F", "--", t, state.dir], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.error) throw new Error(`grep not runnable: ${r.error.message}`);
      if (r.status !== 0 && r.status !== 1) throw new Error(`grep exited ${r.status}: ${String(r.stderr).slice(0, 120)}`);
      tokenFiles[t] = r.stdout.split("\n").filter(Boolean).map((p) => basename(p));
    }
    return dedupe(rankByGrep(Object.keys(tokenFiles), tokenFiles).map((f) => state.citationOf.get(f))).slice(0, k);
  },
  teardown(state) {
    rmSync(state.dir, { recursive: true, force: true });
  },
  meta: (state) => ({ storageBytes: state.bytes, dependency: "system grep (POSIX); nothing to install" }),
};

function toFloats(blob) {
  const copy = new Uint8Array(blob.length);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
};

// --- dense retrieval pieces: prefixes, vector cache, cosine, fusion, rerank, ANN recall, store loader -------------

// Per-model task prefixes, keyed by the BARE model name (a ":tag" is stripped by prefixFor). These come from the
// model cards as the research note and docs/research/memory-recall.md §2 recorded them; none can be checked
// against the local Ollama install (every modelfile here is `TEMPLATE {{ .Prompt }}`, so Ollama adds no prefix
// itself). embeddinggemma: EmbeddingGemma card, "task: search result | query: " / "title: none | text: ".
// nomic-embed-text: Nomic card, "search_query: " / "search_document: ". mxbai-embed-large: mixedbread card, the
// query prompt "Represent this sentence for searching relevant passages: ", documents raw. bge-m3: the BGE-M3
// card needs no instruction on either side. qwen3-embedding: Qwen3-Embedding card, queries are
// "Instruct: <task>\nQuery: <query>", documents raw. See the report for what was and was not confirmed.
export const PREFIXES = {
  embeddinggemma: { query: "task: search result | query: ", doc: "title: none | text: " },
  "nomic-embed-text": { query: "search_query: ", doc: "search_document: " },
  "mxbai-embed-large": { query: "Represent this sentence for searching relevant passages: ", doc: "" },
  "bge-m3": { query: "", doc: "" },
  "qwen3-embedding": { query: "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ", doc: "" },
};

export function prefixFor(model, kind, { noprefix = false } = {}) {
  if (noprefix) return "";
  const entry = PREFIXES[String(model ?? "").split(":")[0]];
  return entry ? entry[kind === "query" ? "query" : "doc"] : "";
}

const f32ToB64 = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
const b64ToF32 = (s) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

// An append-only jsonl vector cache. The key hashes the model, the prefix and the text (JSON-encoded as one array
// so no field can bleed into its neighbour); vectors are stored as float32 bytes so a cold run and a warm run
// return the identical numbers.
export function vectorCache(file) {
  const map = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const { k, d } = JSON.parse(line);
        map.set(k, b64ToF32(d));
      } catch {
        // a torn last line from an interrupted run is ignored; the vector is simply recomputed
      }
    }
  }
  const key = (model, prefix, text) => createHash("sha256").update(JSON.stringify([model, prefix, text])).digest("hex");
  return {
    key,
    get: (model, prefix, text) => map.get(key(model, prefix, text)),
    set(model, prefix, text, vec) {
      const f = Float32Array.from(vec);
      const k = key(model, prefix, text);
      map.set(k, f);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ k, d: f32ToB64(f) }) + "\n");
    },
  };
}

const keyAsc = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// True cosine (not a dot product), exact, over every item: [{ key, score }] desc, ties by key asc, at most k.
export function cosineTopK(query, items, k) {
  let qn = 0;
  for (let i = 0; i < query.length; i++) qn += query[i] * query[i];
  qn = Math.sqrt(qn);
  const scored = items.map(({ key, vec }) => {
    let d = 0;
    let n = 0;
    for (let i = 0; i < vec.length; i++) {
      d += query[i] * vec[i];
      n += vec[i] * vec[i];
    }
    const denom = qn * Math.sqrt(n);
    return { key, score: denom ? d / denom : 0 };
  });
  return scored.sort((a, b) => b.score - a.score || keyAsc(a, b)).slice(0, k);
}

// Reciprocal rank fusion: score(d) = sum over lists of 1 / (k + rank), rank 1-based, k = 60 (Cormack, Clarke and
// Buettcher, "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods", SIGIR 2009).
export function rrf(rankings, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of rankings) list.forEach((key, i) => scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1)));
  return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score || keyAsc(a, b));
}

// Weighted reciprocal-rank fusion: score(d) = sum over lists i of weights[i] / (k + rank_i(d)), rank 1-based.
// weights [1, 1] is plain rrf.
export function wrrf(rankings, weights, { k = 60 } = {}) {
  const scores = new Map();
  rankings.forEach((list, li) => list.forEach((key, i) => scores.set(key, (scores.get(key) || 0) + weights[li] / (k + i + 1))));
  return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score || keyAsc(a, b));
}

// dense+kwboost: the dense order, then a lesson that BM25 ranks in its top 3 is promoted to at most dense rank 2.
// Precisely: start from a copy of denseKeys; for each key of bm25Keys.slice(0, 3), taken from BM25 rank 3 down to
// rank 1, if it is present in the copy and sits below position 2 (index > 1), move it to position 2 (index 1).
// Dense rank 1 never moves; the BM25 top 3 that are present end at ranks 2, 3, 4 in BM25 order; a BM25 key absent
// from denseKeys is ignored. Returns a new array.
export function kwBoost(denseKeys, bm25Keys) {
  const out = denseKeys.slice();
  for (const key of bm25Keys.slice(0, 3).reverse()) {
    const at = out.indexOf(key);
    if (at > 1) {
      out.splice(at, 1);
      out.splice(1, 0, key);
    }
  }
  return out;
}

// The first n keys of the fts5 order, reordered by cosine (desc, ties keep the fts position). Nothing outside
// those n ever appears, however well it scores.
export function rerank(ftsKeys, cosineByKey, { n = 50 } = {}) {
  return ftsKeys
    .slice(0, n)
    .map((key, i) => ({ key, i, score: cosineByKey.has(key) ? cosineByKey.get(key) : -Infinity }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.key);
}

// |top-k of approx intersect top-k of exact| / k. Always divides by k, so a short answer cannot score well.
export function annRecall(approxKeys, exactKeys, k = 10) {
  const exact = new Set(exactKeys.slice(0, k));
  return approxKeys.slice(0, k).filter((key) => exact.has(key)).length / k;
}

function packageEntry(pkgDir, pkg) {
  const pick = (x) => {
    if (typeof x === "string") return x;
    if (Array.isArray(x)) return x.map(pick).find(Boolean);
    if (x && typeof x === "object") {
      for (const cond of ["import", "node", "default", "require"]) if (x[cond]) return pick(x[cond]);
    }
    return undefined;
  };
  let rel;
  if (pkg.exports !== undefined) {
    const root = pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) && Object.keys(pkg.exports).some((k) => k.startsWith(".")) ? pkg.exports["."] : pkg.exports;
    rel = pick(root);
  }
  rel = rel || pkg.main || "index.js";
  const base = join(pkgDir, rel);
  return [base, base + ".js", base + ".mjs", join(base, "index.js")].find((p) => existsSync(p) && statSync(p).isFile()) || base;
}

// Dynamic import of a package installed under `dir` (the install-stores directory). A missing package, or one that
// is installed but will not load (a native binding that failed to build), resolves to { status: "not measured",
// reason } so a matrix keeps going; it never throws.
export async function loadStore(name, { dir }) {
  const pkgDir = join(dir, "node_modules", ...name.split("/"));
  if (!existsSync(join(pkgDir, "package.json"))) {
    return { status: "not measured", reason: `not installed (${name} is not under ${dir}/node_modules): run bench-memory.mjs install-stores` };
  }
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const entry = realpathSync(packageEntry(realpathSync(pkgDir), pkg));
    return { module: await import(pathToFileURL(entry).href) };
  } catch (err) {
    return { status: "not measured", reason: `${name} is installed but failed to load: ${String(err && err.message).split("\n")[0]}` };
  }
}

// Vectors for `texts` (each sent as prefix + text): cache hits first, then one embedder call for the misses
// (duplicates sent once). Always Float32Array, so a cold run and a warm run see identical numbers.
export async function embedCached(texts, prefix, { model, embedder, cache = null }) {
  const out = new Array(texts.length);
  const missing = new Map();
  texts.forEach((t, i) => {
    const hit = cache ? cache.get(model, prefix, t) : undefined;
    if (hit) out[i] = hit;
    else {
      if (!missing.has(t)) missing.set(t, []);
      missing.get(t).push(i);
    }
  });
  if (missing.size) {
    const uniq = [...missing.keys()];
    const vecs = await embedder(uniq.map((t) => prefix + t), { model });
    if (!Array.isArray(vecs) || vecs.length !== uniq.length) throw new Error(`embedder returned ${vecs && vecs.length} vectors for ${uniq.length} texts (${model})`);
    uniq.forEach((t, j) => {
      const v = Float32Array.from(vecs[j]);
      if (cache) cache.set(model, prefix, t, v);
      for (const i of missing.get(t)) out[i] = v;
    });
  }
  return out;
}

// The dense retriever family for one embedding model. Every setup() call builds its own state (a scratch store and
// the document vectors) so an accuracy pass and a speed pass never share one; teardown(state) frees that state and
// close() frees whatever is left:
//   dense:<model>   cosine, exact, over the eligible lessons' document vectors
//   rrf:<model>     reciprocal-rank fusion (k=60) of the bm25 top 50 and the dense top 50
//   rerank:<model>  the bm25 top 50 reordered by cosine
// With `fusion` it appends, after those three, the stage-2 fusion variants:
//   rrf:<model>:d10, rrf:<model>:d20   rrf over the bm25 top n and the dense top n (n = 10, 20)
//   wrrf:<model>:w2, wrrf:<model>:w3   weighted rrf, dense weight 2 / 3, keyword weight 1, depth 50
//   dense+kwboost:<model>              kwBoost over the full dense order and the bm25 top 50
// `embedder(texts, { model })` returns one vector per text; texts already carry the model's prefix. Vectors go
// through `cache` (vectorCache) when given. Every name gets a ":noprefix" suffix when noprefix is set.
export function denseFamily({ model, embedder, cache = null, noprefix = false, staleDays = STALE_DAYS, fusion = false, recency = false }) {
  const suffix = noprefix ? ":noprefix" : "";
  const qPrefix = prefixFor(model, "query", { noprefix });
  const dPrefix = prefixFor(model, "doc", { noprefix });
  const states = new Set();

  const embedAll = (texts, prefix) => embedCached(texts, prefix, { model, embedder, cache });

  async function build(lessons, ctx = {}, needsFts) {
    const docs = eligible(lessons, toMs(ctx.now), staleDays);
    const vecs = await embedAll(docs.map((l) => l.text), dPrefix);
    const items = docs.map((l, i) => ({ key: l.id, vec: vecs[i] }));
    const st = {
      items,
      citation: new Map(docs.map((l) => [l.id, l.citation])),
      ids: new Set(docs.map((l) => l.id)),
      // age in days from confirmed || created to this setup's `now`, for the recency variant
      age: new Map(docs.map((l) => [l.id, ageDays(l, toMs(ctx.now))])),
      fts: null,
    };
    if (needsFts) st.fts = await fts5.setup(lessons, ctx);
    states.add(st);
    return st;
  }
  const queryVec = async (q) => (await embedAll([String(q)], qPrefix))[0];
  const bm25 = (st, query, n = 50) => bm25Ids(st.fts.m, query, st.ids).slice(0, n);
  const cites = (st, ids) => dedupe(ids.map((id) => st.citation.get(id)));
  const dims = (st) => (st.items.length ? st.items[0].vec.length : 0);
  const freeState = (st) => {
    if (st.fts) fts5.teardown(st.fts);
    st.fts = null;
    states.delete(st);
  };
  const common = (kind, base, needsFts, tag = "") => {
    const name = `${base}:${model}${tag}${suffix}`;
    return {
      name,
      kind,
      mode: name,
      setup: (lessons, ctx) => build(lessons, ctx, needsFts),
      teardown: freeState,
      meta: (st) => ({
        storageBytes: st.items.length * dims(st) * 4 + (st.fts ? dbBytes(st.fts.dir) : 0),
        embeddingBytes: st.items.length * dims(st) * 4,
        embedded: st.items.length,
        dims: dims(st),
        dependency: `${model} via the embedder (${noprefix ? "no prefixes" : "model-card prefixes"}); embedding model and server`,
      }),
    };
  };
  const fuseAt = (n) =>
    async function (st, query, k) {
      const q = await queryVec(query);
      const dense = cosineTopK(q, st.items, n).map((r) => r.key);
      return cites(st, rrf([bm25(st, query, n), dense]).map((r) => r.key)).slice(0, k);
    };
  const weighted = (w) =>
    async function (st, query, k) {
      const q = await queryVec(query);
      const dense = cosineTopK(q, st.items, 50).map((r) => r.key);
      return cites(st, wrrf([bm25(st, query), dense], [1, w]).map((r) => r.key)).slice(0, k);
    };
  const retrievers = [
    {
      ...common("dense", "dense", false),
      async search(st, query, k) {
        const q = await queryVec(query);
        return cites(st, cosineTopK(q, st.items, st.items.length).map((r) => r.key)).slice(0, k);
      },
    },
    { ...common("hybrid", "rrf", true), search: fuseAt(50) },
    {
      ...common("hybrid", "rerank", true),
      async search(st, query, k) {
        const q = await queryVec(query);
        const cand = bm25(st, query);
        const set = new Set(cand);
        const cos = new Map(cosineTopK(q, st.items.filter((it) => set.has(it.key)), cand.length).map((r) => [r.key, r.score]));
        return cites(st, rerank(cand, cos, { n: 50 })).slice(0, k);
      },
    },
  ];
  if (fusion) {
    retrievers.push(
      { ...common("hybrid", "rrf", true, ":d10"), search: fuseAt(10) },
      { ...common("hybrid", "rrf", true, ":d20"), search: fuseAt(20) },
      { ...common("hybrid", "wrrf", true, ":w2"), search: weighted(2) },
      { ...common("hybrid", "wrrf", true, ":w3"), search: weighted(3) },
      {
        ...common("hybrid", "dense+kwboost", true),
        async search(st, query, k) {
          const q = await queryVec(query);
          const dense = cosineTopK(q, st.items, st.items.length).map((r) => r.key);
          return cites(st, kwBoost(dense, bm25(st, query))).slice(0, k);
        },
      }
    );
  }
  if (recency) {
    // dense:<m>:recency: cosine x the shipped recency weight (recallLessons: 0.5 + 0.5 * exp(-ageDays / 90)), i.e.
    // plain dense plus the one thing the product multiplies in. Ties by key asc.
    retrievers.push({
      ...common("dense", "dense", false, ":recency"),
      async search(st, query, k) {
        const q = await queryVec(query);
        const scored = cosineTopK(q, st.items, st.items.length).map((r) => ({ key: r.key, score: r.score * (0.5 + 0.5 * Math.exp(-st.age.get(r.key) / 90)) }));
        scored.sort((a, b) => b.score - a.score || keyAsc(a, b));
        return cites(st, scored.map((r) => r.key)).slice(0, k);
      },
    });
  }
  return {
    retrievers,
    close() {
      for (const st of [...states]) freeState(st);
    },
  };
}

// The state and query path every provider-backed retriever shares: one scratch store per setup() call with the
// lessons embedded through `provider` (query vectors cached per text), `queryVector`, and a close().
function providerCore(provider, { staleDays = STALE_DAYS } = {}) {
  const states = new Set();
  // The query-vector cache belongs to one setup() (one state), never to the factory: a later setup, such as the speed
  // pass after the accuracy pass, embeds its own queries instead of reading vectors another pass cached.
  const cachedFor = () => {
    const queryCache = new Map();
    return {
      ...provider,
      async embed(texts, opts = {}) {
        if (opts.inputType !== "query" || texts.length !== 1) return provider.embed(texts, opts);
        if (queryCache.has(texts[0])) return queryCache.get(texts[0]);
        const r = await provider.embed(texts, opts);
        if (r.ok) queryCache.set(texts[0], r);
        return r;
      },
    };
  };
  async function build(lessons, ctx = {}) {
    const cached = cachedFor();
    const built = await fts5.setup(lessons, ctx);
    const emb = await embedLessons(built.m, cached);
    if (emb.total > 0 && emb.embedded === 0) {
      fts5.teardown(built);
      throw new Error(`embedding failed: ${emb.reason}`);
    }
    const nowMs = toMs(built.now);
    const rows = built.m
      .prepare("SELECT id, citation, created, confirmed, embedding FROM lessons WHERE superseded_by IS NULL AND stale IS NULL AND embedding IS NOT NULL")
      .all()
      .filter((r) => ageDays(r, nowMs) <= staleDays)
      .map((r) => ({ id: r.id, citation: r.citation, vec: toFloats(r.embedding) }));
    const st = { built, emb, rows, cached, byId: new Map(rows.map((r) => [r.id, r])) };
    states.add(st);
    return st;
  }
  const freeState = (st) => {
    if (states.delete(st)) fts5.teardown(st.built);
  };
  const queryVector = async (st, query) => {
    const r = await st.cached.embed([String(query)], { inputType: "query" });
    if (!r.ok) throw new Error(`query embedding failed: ${r.reason}`);
    return r.vectors[0];
  };
  const common = (kind, mode, base = mode, tag = "") => ({
    kind,
    mode,
    name: `${base}:${provider.model}${tag}`,
    setup: (lessons, ctx) => build(lessons, ctx),
    teardown: freeState,
    meta: (state) => ({
      storageBytes: dbBytes(state.built.dir),
      embeddingBytes: state.emb.embedded * provider.dims * 4,
      embedded: state.emb.embedded,
      failed: state.emb.failed,
      dependency: `${provider.model} (${provider.dims} dims) via ${provider.name}; embedding model and server`,
    }),
  });
  return {
    common,
    queryVector,
    close() {
      for (const st of [...states]) freeState(st);
    },
  };
}

// semantic (cosine only), hybrid-shipped (the shipped recallLessons with this provider: cosine x recency x scope),
// rerank (top-50 BM25 reordered by cosine), all through one provider (createProvider). Each setup() call builds its
// own scratch store and embeds the lessons into it; the factory returns the retrievers and a close().
export function providerRetrievers(provider, { staleDays = STALE_DAYS } = {}) {
  const core = providerCore(provider, { staleDays });
  const { common, queryVector } = core;
  const retrievers = [
    {
      ...common("dense", "semantic"),
      async search(state, query, k) {
        const q = await queryVector(state, query);
        return dedupe(
          state.rows
            .map((r) => ({ key: r.citation, score: dot(q, r.vec) }))
            .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
            .map((r) => r.key)
        ).slice(0, k);
      },
    },
    {
      ...common("hybrid", "hybrid", "hybrid-shipped"),
      async search(state, query, k) {
        const r = await recallLessons(state.built.m, query, { k, now: state.built.now, provider: state.cached });
        if (r.mode !== "hybrid") throw new Error(`hybrid recall fell back to keyword: ${r.reason}`);
        return dedupe(r.lessons.map((l) => l.citation));
      },
    },
    {
      ...common("hybrid", "rerank"),
      async search(state, query, k) {
        const q = await queryVector(state, query);
        const bm25 = searchLessons(state.built.m, query, { k: 50 }).filter((l) => state.byId.has(l.id));
        return dedupe(
          bm25
            .map((l, i) => ({ key: l.citation, i, score: dot(q, state.byId.get(l.id).vec) }))
            .sort((a, b) => b.score - a.score || a.i - b.i)
            .map((r) => r.key)
        ).slice(0, k);
      },
    },
  ];
  return { retrievers, close: core.close };
}

// The stage-3 (pre-change) shipped hybrid formula, kept as it was with the recency weight fixed at 1: the bm25 top 50
// and the dot-product top 50 of the stored vectors, fused with 1/(60 + rank) per side, ties in insertion order (bm25
// side first). recallLessons no longer uses RRF since card recall-dense-ranking, so this row is the old formula,
// not a norecency of the current ranking; the doc's section 2 attribution relies on it staying as is.
export function hybridShippedNorecency(provider, { staleDays = STALE_DAYS } = {}) {
  const core = providerCore(provider, { staleDays });
  const r = {
    ...core.common("hybrid", `hybrid-shipped:${provider.model}:norecency`, "hybrid-shipped", ":norecency"),
    async search(state, query, k) {
      const q = await core.queryVector(state, query);
      const ids = new Set(state.rows.map((x) => x.id));
      const bm25 = bm25Ids(state.built.m, query, ids);
      const vector = state.rows
        .map((x) => ({ id: x.id, score: dot(q, x.vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map((x) => x.id);
      const fused = new Map();
      bm25.forEach((id, i) => fused.set(id, (fused.get(id) || 0) + 1 / (60 + i + 1)));
      vector.forEach((id, i) => fused.set(id, (fused.get(id) || 0) + 1 / (60 + i + 1)));
      const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => state.byId.get(id).citation);
      return dedupe(ranked).slice(0, k);
    },
  };
  return { retrievers: [r], close: core.close };
}

// A provider whose vectors come from a seeded PRNG keyed by (seed, text), at the model's dims: the same text gives
// the same unit-length vector as a document or as a query, a different text or seed a different one. No network.
// Used to time dense, rrf and hybrid-shipped recall at 1k, 10k and 100k lessons without embedding synthetic text
// through Ollama; recall quality is not measured on these vectors (random vectors carry no meaning), only latency.
export function syntheticProvider({ model, dims, seed }) {
  const vectorOf = (text) => {
    const h = createHash("sha256").update(`${seed}\u0000${text}`).digest();
    const rng = mulberry32(h.readUInt32LE(0));
    const v = new Float32Array(dims);
    let n = 0;
    for (let i = 0; i < dims; i++) {
      v[i] = rng() * 2 - 1;
      n += v[i] * v[i];
    }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dims; i++) v[i] /= n;
    return v;
  };
  return {
    name: "synthetic",
    model,
    dims,
    async embed(texts) {
      return { ok: true, vectors: texts.map(vectorOf) };
    },
  };
}

// --- agent-memory frameworks over a JSON stdin/stdout protocol -------------------------------------------------------
// `framework:<name>[:<variant>]` spawns `<python> <dir>/<name>.py` and speaks one JSON object per line. The bench
// sends {op:"setup", lessons:[{key,text}], config:{variant, ...config}} (only the eligible lessons: live and inside
// the recency window; key = the lesson id) and expects {ok:true, setupMs, storageBytes, llmCalls}; then
// {op:"search", query, k} and expects {keys:[...], ms}; {op:"close"} ends the child. Any failure is a rejection whose
// message is the reason, which runAccuracy and runSpeed turn into { status: "not measured", reason }.
function spawnAdapter(python, file, timeoutMs) {
  const child = spawn(python, [file], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  let buf = "";
  let errTail = "";
  let dead = null;
  let pending = null;
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  const settle = (fn) => {
    const p = pending;
    pending = null;
    if (p) {
      clearTimeout(p.timer);
      fn(p);
    }
  };
  const fail = (reason) => {
    if (!dead) dead = reason;
    kill();
    settle((p) => p.reject(new Error(reason)));
  };
  child.stdin.on("error", () => {});
  child.stderr.on("data", (d) => {
    process.stderr.write(d);
    errTail = (errTail + d).slice(-600);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || !pending) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(`malformed reply (not JSON): ${line.slice(0, 120)}`);
        return;
      }
      settle((p) => p.resolve(msg));
    }
  });
  child.on("error", (err) => fail(`cannot start ${python}: ${err.message}`));
  child.on("exit", (code, signal) => {
    if (!dead) dead = `adapter exited (${signal || `code ${code}`}) before replying${errTail.trim() ? `: ${errTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`;
    settle((p) => p.reject(new Error(dead)));
  });
  return {
    child,
    request(msg, label) {
      if (dead) return Promise.reject(new Error(dead));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(`timed out after ${timeoutMs} ms waiting for the ${label} reply`), timeoutMs);
        pending = { resolve, reject, timer };
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    kill,
    async close() {
      if (child.exitCode === null && child.signalCode === null && !dead) {
        try {
          child.stdin.write(JSON.stringify({ op: "close" }) + "\n");
        } catch {
          // best effort
        }
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 2000);
          child.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      kill();
    },
  };
}

const malformed = (what, got) => new Error(`malformed reply: expected ${what}, got ${JSON.stringify(got).slice(0, 120)}`);

export function frameworkRetriever({ framework, variant = null, python = FRAMEWORK_PYTHON, dir = FRAMEWORKS_DIR, timeoutMs = 600000, config = {} }) {
  const name = `framework:${framework}${variant ? `:${variant}` : ""}`;
  const r = {
    name,
    kind: "framework",
    mode: name,
    async setup(lessons, ctx = {}) {
      if (python.includes("/") && !existsSync(python)) throw new Error(NOT_INSTALLED_FRAMEWORKS);
      const sent = eligible(lessons, toMs(ctx.now));
      const adapter = spawnAdapter(python, join(dir, `${framework}.py`), timeoutMs);
      try {
        const reply = await adapter.request({ op: "setup", lessons: sent.map((l) => ({ key: l.id, text: l.text })), config: { variant, ...config } }, "setup");
        if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") throw malformed("{ok, setupMs, storageBytes, llmCalls}", reply);
        if (!reply.ok) throw new Error(reply.notInstalled ? `${NOT_INSTALLED_FRAMEWORKS} (${reply.error || framework})` : String(reply.error || "adapter reported ok:false"));
        for (const f of ["setupMs", "storageBytes", "llmCalls"]) if (typeof reply[f] !== "number") throw malformed("{ok:true, setupMs, storageBytes, llmCalls} with numbers", reply);
        return { adapter, citation: new Map(sent.map((l) => [l.id, l.citation])), setupMs: reply.setupMs, storageBytes: reply.storageBytes, llmCalls: reply.llmCalls };
      } catch (err) {
        adapter.kill();
        throw err;
      }
    },
    async search(st, query, k) {
      try {
        const reply = await st.adapter.request({ op: "search", query, k }, "search");
        if (reply && reply.ok === false) throw new Error(String(reply.error || "adapter reported ok:false"));
        if (!reply || !Array.isArray(reply.keys) || reply.keys.some((x) => typeof x !== "string")) throw malformed("{keys: [string], ms}", reply);
        return dedupe(reply.keys.filter((key) => st.citation.has(key)).map((key) => st.citation.get(key))).slice(0, k);
      } catch (err) {
        st.adapter.kill();
        throw err;
      }
    },
    teardown: (st) => st.adapter.close(),
    meta: (st) => ({
      storageBytes: st.storageBytes,
      dependency: `${framework} adapter (evals/frameworks/${framework}.py) in the bench Python venv`,
      setupMs: st.setupMs,
      llmCalls: st.llmCalls,
    }),
  };
  // Only a :verbatim variant is deterministic. Any other (extract, or no variant at all: Graphiti always asks an LLM to
  // extract) is flagged, so the bench routes it to `nondeterministic`.
  if (variant !== "verbatim") r.deterministic = false;
  if (variant === "extract") {
    r.realOnly = true; // LLM extraction is far too slow to ingest at synthetic sizes
    r.realOnlyReason = `${name} is timed on the real snapshot only: LLM extraction is too slow to ingest synthetic lessons`;
  }
  return r;
}

// --- Ollama embedder, model facts, install-stores ----------------------------------------------------------------

export const OLLAMA_URL = "http://localhost:11434";
export const ALL_MODELS = ["embeddinggemma", "nomic-embed-text", "mxbai-embed-large", "bge-m3", "qwen3-embedding:0.6b"];
export const STORE_PACKAGES = ["sqlite-vec", "@lancedb/lancedb", "hnswlib-node", "usearch", "vectra"];
const STORES_DIR = join(root, ".doug/.state/bench/stores");
const VECTORS_DIR = join(root, ".doug/.state/bench/vectors");

const l2 = (v) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

// POST /api/embed {model, input:[...]} in batches (Ollama truncates an over-long input to the model's context by
// default, silently). Vectors are L2-normalized. `stats[model]` accumulates { texts, ms, calls } when given.
export function ollamaEmbedder({ baseUrl = OLLAMA_URL, fetchImpl = globalThis.fetch, batch = 32, stats = null, timeoutMs = 600000 } = {}) {
  return async (texts, { model }) => {
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      const chunk = texts.slice(i, i + batch);
      const t0 = performance.now();
      const res = await fetchImpl(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: chunk }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ollama /api/embed HTTP ${res.status} for ${model}: ${String(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      if (!Array.isArray(j.embeddings) || j.embeddings.length !== chunk.length) throw new Error(`ollama /api/embed returned ${j.embeddings && j.embeddings.length} vectors for ${chunk.length} texts (${model})`);
      if (stats) {
        const s = (stats[model] ||= { texts: 0, ms: 0, calls: 0 });
        s.texts += chunk.length;
        s.ms += performance.now() - t0;
        s.calls++;
      }
      out.push(...j.embeddings.map(l2));
    }
    return out;
  };
}

// The model's native embedding width from POST /api/show (`<arch>.embedding_length`), the same number
// `ollama show` prints as "embedding length"; null when the server does not say.
export async function ollamaDims(model, { baseUrl = OLLAMA_URL, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    if (!res.ok) return null;
    const info = (await res.json()).model_info || {};
    const key = Object.keys(info).find((x) => x.endsWith(".embedding_length"));
    return key ? Number(info[key]) : null;
  } catch {
    return null;
  }
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

// Builds the registry for `--ollama`: for each model, dense/rrf/rerank with the model-card prefixes (plus the stage-2
// fusion variants) and again without prefixes (the base three), plus hybrid-shipped (the product's recallLessons
// through createProvider at /v1/embeddings with the model's native dims) and its pre-change RRF recency-1 twin. `synthetic` holds
// the same-named dense, rrf and hybrid-shipped retrievers over seeded synthetic vectors (syntheticProvider), which
// the speed pass times at 1k lessons and above instead of embedding synthetic text through Ollama.
// Returns { registry, synthetic, models: { model: { dims } }, close }.
async function buildOllamaRegistry({ models, baseUrl, fetchImpl, stats, vectorsDir = VECTORS_DIR, dimsOverride = null }) {
  const embedder = ollamaEmbedder({ baseUrl, fetchImpl, stats });
  const registry = [];
  const synthetic = [];
  const info = {};
  const closers = [];
  for (const model of models) {
    const dims = dimsOverride || (await ollamaDims(model, { baseUrl, fetchImpl }));
    info[model] = { dims };
    for (const noprefix of [false, true]) {
      const cache = vectorCache(join(vectorsDir, `${safeName(model)}${noprefix ? "-noprefix" : ""}.jsonl`));
      const g = denseFamily({ model, embedder, cache, noprefix, fusion: !noprefix, recency: !noprefix });
      registry.push(...g.retrievers);
      closers.push(() => g.close());
    }
    if (dims) {
      const provider = createProvider({ embeddings: { provider: "openai-compatible", baseUrl, model, dims } }, { fetch: fetchImpl, timeoutMs: 120000 });
      const pg = providerRetrievers(provider);
      registry.push(...pg.retrievers.filter((r) => r.mode === "hybrid").map((r) => ({ ...r, mode: r.name })));
      closers.push(() => pg.close());
      const nr = hybridShippedNorecency(provider);
      registry.push(...nr.retrievers);
      closers.push(() => nr.close());

      const syn = syntheticProvider({ model, dims, seed: SPEED_SEED });
      const sg = denseFamily({ model, embedder: async (texts) => (await syn.embed(texts)).vectors });
      synthetic.push(...sg.retrievers.filter((r) => r.name === `dense:${model}` || r.name === `rrf:${model}`));
      closers.push(() => sg.close());
      const sp = providerRetrievers(syn);
      synthetic.push(...sp.retrievers.filter((r) => r.mode === "hybrid").map((r) => ({ ...r, mode: r.name })));
      closers.push(() => sp.close());
    }
  }
  return { registry, synthetic, models: info, close: () => closers.forEach((c) => c()) };
}

// Installs the vector-store packages into a scratch directory with its own package.json (never the repo's).
// Runs the one combined `pnpm add`; if it fails, retries each package alone so one failed build does not hide the
// rest. Returns [{ package, ok, output }] with the command output verbatim.
export function installStores({ dir = STORES_DIR, say = () => {}, runner = spawnSync } = {}) {
  mkdirSync(dir, { recursive: true });
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) {
    // pnpm 10 skips dependency build scripts unless allowed; the allow-list is scratch-local, not the repo's.
    writeFileSync(pj, JSON.stringify({ name: "bench-stores", private: true, pnpm: { onlyBuiltDependencies: STORE_PACKAGES } }, null, 2) + "\n");
  }
  const run = (pkgs) => {
    const args = ["--dir", dir, "--ignore-workspace", "add", ...pkgs];
    say(`$ pnpm ${args.join(" ")}`);
    const r = runner("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error.message) : ""}`;
    say(output.trimEnd());
    say(`exit ${r.status}`);
    return { ok: r.status === 0, output };
  };
  const all = run(STORE_PACKAGES);
  if (all.ok) return STORE_PACKAGES.map((p) => ({ package: p, ok: true, output: "(installed by the combined command)" }));
  return STORE_PACKAGES.map((p) => ({ package: p, ...run([p]) }));
}

// The Python packages each framework adapter imports. The venv is a uv-managed Python 3.12 at
// .doug/.state/bench/py (the system Python 3.9 is too old for these libraries). One list per framework, so a
// framework whose package will not install is reported alone.
export const FRAMEWORK_PACKAGES = {
  mem0: ["mem0ai", "ollama"],
  langmem: ["langmem", "langgraph"],
  graphiti: ["graphiti-core", "falkordblite"],
  letta: ["letta-client", "requests"],
};

// Creates the venv (uv venv --python 3.12) and installs every framework's packages with `uv pip install`; a failed
// combined install is retried framework by framework. Returns [{ framework, packages, ok, output }].
export function installFrameworks({ dir = FRAMEWORK_VENV, say = () => {}, runner = spawnSync, packages = FRAMEWORK_PACKAGES } = {}) {
  const sh = (cmd, args) => {
    say(`$ ${cmd} ${args.join(" ")}`);
    const r = runner(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error.message) : ""}`;
    say(output.trimEnd());
    say(`exit ${r.status}`);
    return { ok: r.status === 0, output };
  };
  const python = join(dir, "bin/python");
  if (!existsSync(python)) {
    const made = sh("uv", ["venv", "--python", "3.12", dir]);
    if (!made.ok) return Object.keys(packages).map((framework) => ({ framework, packages: packages[framework], ok: false, output: made.output }));
  }
  const install = (pkgs) => sh("uv", ["pip", "install", "--python", python, ...pkgs]);
  const all = install([...new Set(Object.values(packages).flat())]);
  if (all.ok) return Object.keys(packages).map((framework) => ({ framework, packages: packages[framework], ok: true, output: "(installed by the combined command)" }));
  return Object.keys(packages).map((framework) => ({ framework, packages: packages[framework], ...install(packages[framework]) }));
}

// --- accuracy ----------------------------------------------------------------------------------------------------

const notMeasured = (reason) => ({ status: "not measured", reason });

// Resolves each query's expected citation keys against the snapshot and drops what cannot be scored: an expected
// key matching no lesson is `unresolved`; a paraphrase sharing a keyword with an expected lesson is a `violator`.
export function prepareQueries(lessons, queries) {
  const byBase = new Map();
  for (const l of lessons) {
    if (!l.citation) continue;
    if (!byBase.has(l.citation)) byBase.set(l.citation, []);
    byBase.get(l.citation).push(l);
  }
  const unresolved = [];
  const violators = [];
  const scoredQueries = [];
  for (const q of queries) {
    const expected = [];
    const texts = [];
    for (const key of q.expected) {
      const hit = byBase.get(key);
      if (!hit) {
        unresolved.push({ id: q.id, key });
        continue;
      }
      expected.push(key);
      const live = hit.filter((l) => !l.superseded_by);
      for (const l of live.length ? live : hit) texts.push(l.text);
    }
    if (q.type === "paraphrase") {
      const shared = unique(texts.flatMap((t) => validateParaphrase(q.query, t).shared));
      if (shared.length) {
        violators.push({ id: q.id, shared });
        continue;
      }
    }
    if (expected.length) scoredQueries.push({ id: q.id, type: q.type, query: q.query, expected: unique(expected) });
  }
  return { scoredQueries, unresolved, violators };
}

// `registry` (an array of retrievers) replaces the default [fts5, grep] plus the provider's; the caller then owns
// which retrievers run and what a missing provider looks like.
export async function runAccuracy({ snapshot, queries, k = DEFAULT_K, provider = null, providerReason = null, staleDays = STALE_DAYS, registry: given = null }) {
  const lessons = snapshot.lessons;
  const now = snapshot.snapshotAt ?? new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const { scoredQueries, unresolved, violators } = prepareQueries(lessons, queries);

  const modes = {};
  const timings = {};
  const registry = given ? [...given] : [fts5, grep];
  let group = null;
  if (provider && !given) {
    group = providerRetrievers(provider, { staleDays });
    registry.push(...group.retrievers);
  }
  try {
    for (const r of registry) {
      const key = r.mode || r.kind;
      const flag = r.deterministic === false ? { deterministic: false } : {};
      let state = null;
      try {
        state = await r.setup(lessons, { now });
        const perQuery = [];
        for (const q of scoredQueries) {
          perQuery.push({ id: q.id, type: q.type, ranked: await r.search(state, q.query, k), expected: q.expected });
        }
        // Wall-clock and LLM-call fields are not part of the deterministic result: they go to `timings`.
        const { setupMs, ingestMs, llmCalls, ...meta } = r.meta(state);
        const timed = Object.fromEntries(Object.entries({ setupMs, ingestMs, llmCalls }).filter(([, v]) => v !== undefined));
        if (Object.keys(timed).length) timings[key] = timed;
        modes[key] = { retriever: r.name, kind: r.kind, ...flag, ...scoreQueries(perQuery, k), perQuery, meta };
      } catch (err) {
        modes[key] = { ...notMeasured(err.message), ...flag };
      } finally {
        if (state) await r.teardown(state);
      }
    }
  } finally {
    if (group) group.close();
  }
  if (!provider && !given) {
    for (const mode of ["semantic", "hybrid", "rerank"]) modes[mode] = notMeasured(providerReason || "no provider configured");
  }
  const live = lessons.filter(isLive);
  const counts = {
    lessons: lessons.length,
    live: live.length,
    inRecallWindow: live.filter((l) => ageDays(l, nowMs) <= staleDays).length,
    queries: queries.length,
    scored: scoredQueries.length,
    byType: Object.fromEntries(QUERY_TYPES.map((t) => [t, scoredQueries.filter((q) => q.type === t).length])),
  };
  return { k, snapshotAt: now, staleDays, counts, modes, unresolved, violators, timings };
}

// --- usefulness --------------------------------------------------------------------------------------------------

export function runUsefulness({ lessons, reflections = null, reportsDir, lastReportFile }) {
  const top = (field) =>
    lessons
      .filter((l) => l[field] > 0)
      .sort((a, b) => b[field] - a[field] || (a.id < b.id ? -1 : 1))
      .slice(0, 5)
      .map((l) => ({ id: l.id, citation: l.citation, [field]: l[field] }));
  const reports = collectUsefulness({ reportsDir, lastReportFile, lessonIds: lessons.map((l) => l.id) });
  return {
    lessons: lessons.length,
    counters: summarizeLessonCounters(lessons),
    topHelpful: top("helpful"),
    topHarmful: top("harmful"),
    reflections,
    ...reports,
    memoryUsedRate: reports.tasks ? reports.tasksWithMemoryUsed / reports.tasks : 0,
  };
}

// --- speed -------------------------------------------------------------------------------------------------------

export function scanHooks(dir = HOOKS_DIR) {
  const mentions = [];
  const importers = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs|ts)$/.test(e.name)) {
        readFileSync(p, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (!/memory[A-Za-z-]*\.mjs/.test(line)) return;
            const rel = `${relative(root, p)}:${i + 1}`;
            mentions.push(rel);
            if (/\b(import|require)\b/.test(line)) importers.push(rel);
          });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { command: `grep -rnE "memory[A-Za-z-]*\\.mjs" plugins/doug-gates/scripts`, mentions, importers };
}

async function timeLoop(fn, { iterations, budgetMs, min = 3 }) {
  const samples = [];
  const t0 = performance.now();
  while (samples.length < iterations && (samples.length < min || performance.now() - t0 < budgetMs)) {
    const s = performance.now();
    await fn(samples.length);
    samples.push(performance.now() - s);
  }
  return samples;
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const summarize = (samples) => ({ p50: r3(percentile(samples, 50)), p95: r3(percentile(samples, 95)), n: samples.length });

function writeImportFiles(memDir, lessons, tag) {
  rmSync(memDir, { recursive: true, force: true });
  mkdirSync(memDir, { recursive: true });
  lessons.forEach((l, j) => {
    const name = `bench-${tag}-${j}.md`;
    writeFileSync(join(memDir, name), `---\nname: ${name}\ndescription: bench ${j}\nmetadata:\n  type: project\n---\n${l.text}\n`);
  });
}

// Extra measurements only the shipped store has (a cold CLI start, recording an outcome, importing auto-memory
// files); the speed loop calls this hook on any retriever that defines it, so no retriever is special-cased by name.
fts5.speedExtras = async (state, { lessons, queries, opts, iter, tim }) => {
  if (!opts.skipColdStart) {
    const q = queries[0];
    const spawnMs = (args) => {
      const s = performance.now();
      const res = spawnSync(process.execPath, args, { encoding: "utf8" });
      if (res.status !== 0) throw new Error(`spawn failed (${res.status}): ${String(res.stderr).slice(0, 200)}`);
      return performance.now() - s;
    };
    const n = Math.min(opts.iterations, 10);
    const baseline = await timeLoop(() => spawnMs(["-e", "0"]), { iterations: n, budgetMs: opts.budgetMs });
    const cli = await timeLoop(() => spawnMs([MEMORY_CLI, "recall", q, state.dir]), { iterations: n, budgetMs: opts.budgetMs });
    tim.coldStart = { nodeBare: summarize(baseline), memoryCliRecall: summarize(cli) };
  }
  let c = 0;
  tim.record = summarize(
    await timeLoop(() => {
      const row = handOutcomeRow({ card: "bench-card", commit: `b${String(c++).padStart(7, "0")}`, now: "2026-01-01T00:00:00.000Z" });
      recordOutcomes(state.m, [row]);
    }, iter)
  );
  const claudeDir = mkdtempSync(join(tmpdir(), "bench-claude-"));
  const projectDir = "/bench-project";
  const memDir = join(claudeDir, "projects", projectSlug(projectDir), "memory");
  try {
    const batch = Math.min(opts.importFiles, lessons.length || opts.importFiles);
    const importOnly = [];
    const t0 = performance.now();
    for (let i = 0; i < Math.min(opts.iterations, 10) && (i < 3 || performance.now() - t0 < opts.budgetMs); i++) {
      writeImportFiles(memDir, generateLessons(SPEED_SEED + 100 + i, batch), `j${i}`);
      const s = performance.now();
      importAutoMemory(state.m, { projectDir, claudeDir });
      importOnly.push(performance.now() - s);
    }
    tim.import = { filesPerCall: batch, ...summarize(importOnly) };
    if (lessons.length <= IMPORT_FULL_MAX) {
      const full = [];
      for (let i = 0; i < Math.min(opts.iterations, 3); i++) {
        const dir = mkdtempSync(join(tmpdir(), "bench-imp-"));
        const m2 = openMemory(dir);
        writeImportFiles(memDir, generateLessons(SPEED_SEED + 200 + i, lessons.length), `f${i}`);
        const s = performance.now();
        importAutoMemory(m2, { projectDir, claudeDir });
        full.push(performance.now() - s);
        m2.close();
        rmSync(dir, { recursive: true, force: true });
      }
      tim.importFull = { files: lessons.length, ...summarize(full) };
    } else {
      tim.importFull = notMeasured(`full import of ${lessons.length} files not run above ${IMPORT_FULL_MAX} (importAutoMemory scans every lesson per new file)`);
    }
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
};

async function speedAtSize({ label, lessons, now, queries, opts }) {
  const det = { lessons: lessons.length, storage: {} };
  const tim = { setupMs: {}, recall: {} };
  const iter = { iterations: opts.iterations, budgetMs: opts.budgetMs };
  const synthetic = opts.synthetic || new Map();
  for (const listed of opts.retrievers) {
    // At a synthetic size a retriever that needs real embeddings is swapped for its synthetic-vector twin (same
    // name), when one was given; the adapter's own realOnly flag decides what is skipped, never its name.
    const r = label === "real" ? listed : synthetic.get(listed.name) || listed;
    let state = null;
    if (r.maxLessons && lessons.length > r.maxLessons) {
      tim.recall[r.name] = notMeasured(r.skipReason ? r.skipReason(lessons.length) : `${r.name} not run above ${r.maxLessons} lessons`);
      continue;
    }
    if (r.realOnly && label !== "real") {
      tim.recall[r.name] = notMeasured(r.realOnlyReason || `${r.name} is timed on the real snapshot only: it needs an embedding per lesson, and embedding ${lessons.length} synthetic lessons through Ollama is the separate embed-speed measurement`);
      continue;
    }
    try {
      const t0 = performance.now();
      state = await r.setup(lessons, { now });
      tim.setupMs[r.name] = r3(performance.now() - t0);
      const bytes = { storageBytes: r.meta(state).storageBytes };
      // an LLM-extraction store's size differs run to run, so it is reported beside the timings
      if (r.deterministic === false) (tim.nondeterministicStorage ||= {})[r.name] = bytes;
      else det.storage[r.name] = bytes;
      tim.recall[r.name] = summarize(await timeLoop((i) => r.search(state, queries[i % queries.length], DEFAULT_K), iter));
      if (r.speedExtras) await r.speedExtras(state, { lessons, queries, opts, iter, tim });
    } catch (err) {
      tim.recall[r.name] = notMeasured(err.message);
    } finally {
      if (state) await r.teardown(state);
    }
  }
  return { label, det, tim };
}

export async function runSpeed({ sizes, iterations, budgetMs, importFiles, skipColdStart, real = null, queries = [], retrievers = [fts5, grep], synthetic = [] }) {
  const syntheticByName = new Map(synthetic.map((r) => [r.name, r]));
  const nowMs = Date.now();
  const deterministic = { sizes: [], hooks: scanHooks() };
  const timings = { iterations, budgetMs, sizes: [] };
  for (const size of sizes) {
    let lessons;
    let now;
    let qs;
    if (size === "real") {
      if (!real) throw new Error('size "real" needs a snapshot (run `snapshot`, or pass --snapshot)');
      lessons = real.lessons;
      now = real.snapshotAt;
      qs = queries.length ? queries : syntheticQueries(SPEED_SEED, 50);
    } else {
      lessons = generateLessons(SPEED_SEED, Number(size), { now: nowMs });
      now = new Date(nowMs);
      qs = syntheticQueries(SPEED_SEED, 50);
    }
    const { det, tim } = await speedAtSize({
      label: size,
      lessons,
      now,
      queries: qs,
      opts: { iterations, budgetMs, importFiles, skipColdStart, retrievers, synthetic: syntheticByName },
    });
    deterministic.sizes.push({ size, ...det });
    timings.sizes.push({ size, ...tim });
  }
  return { deterministic, timings };
}

// --- vector stores -----------------------------------------------------------------------------------------------
// A store adapter: { name, pkg, ann, build(mod, flat, n, dims, dir, ctx) -> handle, query(handle, vec, k) -> row
// indices, bytes(handle) -> bytes on disk (or in memory for bruteforce), close(handle) }. `flat` is a Float32Array
// of n*dims unit vectors. The store matrix runs every cell in its own child process (`store-cell`) so a native
// crash is contained and resident memory is the cell's alone.

const dirBytes = (d) => {
  let n = 0;
  if (!existsSync(d)) return 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
};
const vecAt = (flat, i, dims) => flat.subarray(i * dims, (i + 1) * dims);
const HNSW = { m: 16, efConstruction: 200, efSearch: 64 };
const checkBuild = (ctx, t0, i) => {
  if (ctx.abortMs && i % 256 === 0 && performance.now() - t0 > ctx.abortMs) throw new Error(`build aborted after ${Math.round(performance.now() - t0)} ms with ${i} vectors inserted (over 2x --budget-ms)`);
};

export const STORE_ADAPTERS = [
  {
    name: "bruteforce",
    pkg: null,
    ann: false,
    async build(_mod, flat, n, dims) {
      return { flat, n, dims };
    },
    async query(h, q, k) {
      const best = []; // sorted desc by score, at most k
      for (let i = 0; i < h.n; i++) {
        let d = 0;
        const off = i * h.dims;
        for (let j = 0; j < h.dims; j++) d += q[j] * h.flat[off + j];
        if (best.length < k || d > best[best.length - 1].d) {
          let pos = best.length;
          while (pos > 0 && best[pos - 1].d < d) pos--;
          best.splice(pos, 0, { i, d });
          if (best.length > k) best.pop();
        }
      }
      return best.map((b) => b.i);
    },
    bytes: (h) => h.n * h.dims * 4,
    close() {},
  },
  {
    name: "sqlite-vec",
    pkg: "sqlite-vec",
    ann: false, // vec0 KNN is a full scan (exact)
    async build(mod, flat, n, dims, dir, ctx) {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const file = join(dir, "vec.db");
      const db = new DatabaseSync(file, { allowExtension: true });
      mod.load(db);
      db.exec("PRAGMA journal_mode = OFF");
      db.exec("PRAGMA synchronous = OFF");
      db.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding float[${dims}])`);
      const ins = db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)");
      const t0 = performance.now();
      db.exec("BEGIN");
      for (let i = 0; i < n; i++) {
        checkBuild(ctx, t0, i);
        const v = vecAt(flat, i, dims);
        ins.run(BigInt(i + 1), new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      }
      db.exec("COMMIT");
      return { db, file, sel: db.prepare("SELECT rowid FROM v WHERE embedding MATCH ? AND k = ? ORDER BY distance") };
    },
    async query(h, q, k) {
      return h.sel.all(new Uint8Array(q.buffer, q.byteOffset, q.byteLength), k).map((r) => Number(r.rowid) - 1);
    },
    bytes: (h) => fileSize(h.file),
    close: (h) => h.db.close(),
  },
  // lancedb: flat (no index, exact), ivfpq (library defaults), and ivfpq:refine10 (same index, each query
  // re-ranks 10 x k candidates with the exact vectors: VectorQuery.refineFactor, @lancedb/lancedb dist/query.d.ts:390).
  ...["flat", "ivfpq", "ivfpq:refine10"].map((variant) => ({
    name: variant === "flat" ? "lancedb" : `lancedb-${variant}`,
    pkg: "@lancedb/lancedb",
    ann: variant !== "flat",
    async build(mod, flat, n, dims, dir, ctx) {
      if (variant !== "flat" && n < 256) throw new Error(`IVF_PQ needs at least 256 vectors to train (has ${n})`);
      const db = await mod.connect(join(dir, "lance"));
      const rows = [];
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        checkBuild(ctx, t0, i);
        rows.push({ id: i, vector: Array.from(vecAt(flat, i, dims)) });
      }
      const table = await db.createTable("v", rows);
      if (variant !== "flat") await table.createIndex("vector", { config: mod.Index.ivfPq({ distanceType: "cosine" }) });
      return { db, table, dir: join(dir, "lance") };
    },
    async query(h, q, k) {
      let query = h.table.search(Array.from(q)).distanceType("cosine").limit(k);
      if (variant === "ivfpq:refine10") query = query.refineFactor(10);
      return (await query.toArray()).map((x) => Number(x.id));
    },
    bytes: (h) => dirBytes(h.dir),
    close: (h) => h.table.close && h.table.close(),
  })),
  {
    name: "hnswlib",
    pkg: "hnswlib-node",
    ann: true,
    async build(mod, flat, n, dims, dir, ctx) {
      const { HierarchicalNSW } = mod.default;
      const idx = new HierarchicalNSW("cosine", dims);
      idx.initIndex(n, HNSW.m, HNSW.efConstruction, 100);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        checkBuild(ctx, t0, i);
        idx.addPoint(Array.from(vecAt(flat, i, dims)), i);
      }
      idx.setEf(HNSW.efSearch);
      return { idx, file: join(dir, "hnsw.bin") };
    },
    async query(h, q, k) {
      return h.idx.searchKnn(Array.from(q), k).neighbors;
    },
    bytes(h) {
      h.idx.writeIndexSync(h.file);
      return fileSize(h.file);
    },
    close() {},
  },
  {
    name: "usearch",
    pkg: "usearch",
    ann: true,
    async build(mod, flat, n, dims, dir, ctx) {
      const idx = new mod.Index({ dimensions: dims, metric: mod.MetricKind.Cos, quantization: mod.ScalarKind.F32, connectivity: HNSW.m, expansion_add: HNSW.efConstruction, expansion_search: HNSW.efSearch });
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        checkBuild(ctx, t0, i);
        idx.add(BigInt(i), vecAt(flat, i, dims));
      }
      return { idx, file: join(dir, "usearch.bin") };
    },
    async query(h, q, k) {
      return Array.from(h.idx.search(q, k).keys, Number);
    },
    bytes(h) {
      h.idx.save(h.file);
      return fileSize(h.file);
    },
    close() {},
  },
  {
    name: "vectra",
    pkg: "vectra",
    ann: false, // vectra scans every item in JS (exact)
    async build(mod, flat, n, dims, dir, ctx) {
      const idx = new mod.LocalIndex(join(dir, "vectra"));
      await idx.createIndex({ version: 1, deleteIfExists: true });
      await idx.beginUpdate();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        checkBuild(ctx, t0, i);
        await idx.insertItem({ vector: Array.from(vecAt(flat, i, dims)), metadata: { i } });
      }
      await idx.endUpdate();
      return { idx, dir: join(dir, "vectra") };
    },
    async query(h, q, k) {
      return (await h.idx.queryItems(Array.from(q), "", k)).map((r) => r.item.metadata.i);
    },
    bytes: (h) => dirBytes(h.dir),
    close() {},
  },
];

// Clustered synthetic unit vectors from a seeded PRNG: ~sqrt(n) cluster centres, each vector a centre plus noise,
// normalized. (Uniform random vectors in 1000 dimensions are all near-orthogonal, which says nothing about a
// real embedding's neighbour structure; this keeps neighbours meaningful while staying deterministic.) Queries are
// a stored vector plus noise, normalized, so each has a real neighbourhood.
export function syntheticVectors(seed, n, dims) {
  const rng = mulberry32((seed ^ dims) >>> 0);
  const centres = Math.max(4, Math.round(Math.sqrt(n)));
  const noise = 0.5 * Math.sqrt(3 / dims);
  const cs = Array.from({ length: centres }, () => l2(Float32Array.from({ length: dims }, () => rng() * 2 - 1)));
  const flat = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) {
    const c = cs[Math.floor(rng() * centres)];
    const out = vecAt(flat, i, dims);
    let norm = 0;
    for (let j = 0; j < dims; j++) {
      out[j] = c[j] + noise * (rng() * 2 - 1);
      norm += out[j] * out[j];
    }
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dims; j++) out[j] /= norm;
  }
  const queries = Array.from({ length: 50 }, () => {
    const src = vecAt(flat, Math.floor(rng() * n), dims);
    return l2(Float32Array.from(src, (x) => x + 0.6 * noise * (rng() * 2 - 1)));
  });
  return { flat, queries };
}

// Real vectors for the snapshot at one model: eligible lessons' document vectors and every scored query's vector,
// through the same vector cache the accuracy matrix fills.
async function realVectors({ model, snapshot, queries, baseUrl, fetchImpl }) {
  const embedder = ollamaEmbedder({ baseUrl, fetchImpl });
  const cache = vectorCache(join(VECTORS_DIR, `${safeName(model)}.jsonl`));
  const docs = eligible(snapshot.lessons, toMs(snapshot.snapshotAt));
  const { scoredQueries } = prepareQueries(snapshot.lessons, queries);
  const dv = await embedCached(docs.map((l) => l.text), prefixFor(model, "doc"), { model, embedder, cache });
  const qv = await embedCached(scoredQueries.map((q) => q.query), prefixFor(model, "query"), { model, embedder, cache });
  const dims = dv[0].length;
  const flat = new Float32Array(docs.length * dims);
  dv.forEach((v, i) => flat.set(l2(v), i * dims));
  return { docs, flat, dims, scoredQueries, queries: qv.map(l2) };
}

// One (store, size) cell, run in this process: build, time k=10 queries, recall against exact, resident memory.
export async function runStoreCell({ name, size, model, dims, budgetMs, storesDir, snapshot, queries, baseUrl, fetchImpl }) {
  const adapter = STORE_ADAPTERS.find((a) => a.name === name);
  if (!adapter) throw new Error(`unknown store ${name}`);
  let mod = null;
  if (adapter.pkg) {
    const loaded = await loadStore(adapter.pkg, { dir: storesDir });
    if (loaded.status) return { store: name, size, ...loaded };
    mod = loaded.module;
  }
  let data;
  let real = null;
  if (size === "real") {
    real = await realVectors({ model, snapshot, queries, baseUrl, fetchImpl });
    data = { flat: real.flat, queries: real.queries, n: real.docs.length, dims: real.dims };
  } else {
    const n = Number(size);
    data = { ...syntheticVectors(SPEED_SEED, n, dims), n, dims };
  }
  const exactAdapter = STORE_ADAPTERS[0];
  const exactH = await exactAdapter.build(null, data.flat, data.n, data.dims);
  const exact = [];
  for (const q of data.queries) exact.push(await exactAdapter.query(exactH, q, 10));
  const dir = mkdtempSync(join(tmpdir(), `bench-store-${name}-`));
  const rssBefore = process.memoryUsage().rss;
  try {
    const t0 = performance.now();
    const h = await adapter.build(mod, data.flat, data.n, data.dims, dir, { abortMs: budgetMs * 2 });
    const buildMs = performance.now() - t0;
    for (let i = 0; i < Math.min(3, data.queries.length); i++) await adapter.query(h, data.queries[i], 10);
    const samples = [];
    const results = [];
    const qStart = performance.now();
    for (let i = 0; i < data.queries.length; i++) {
      const s = performance.now();
      results.push(await adapter.query(h, data.queries[i], 10));
      samples.push(performance.now() - s);
      if (i >= 4 && performance.now() - qStart > budgetMs) break;
    }
    const rssAfter = process.memoryUsage().rss;
    const out = {
      store: name,
      size,
      vectors: data.n,
      dims: data.dims,
      buildMs: r3(buildMs),
      query: summarize(samples),
      storageBytes: adapter.bytes(h),
      rssDeltaMb: Math.round((rssAfter - rssBefore) / 1048576),
      maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      annRecall10: r3(results.reduce((s, r, i) => s + annRecall(r, exact[i], 10), 0) / results.length),
      exact: !adapter.ann,
    };
    if (real) {
      const perQuery = real.scoredQueries.map((q, i) => ({
        id: q.id,
        type: q.type,
        ranked: dedupe(results[i].slice(0, 8).map((x) => real.docs[x].citation)),
        expected: q.expected,
      }));
      const overlap = results.map((r, i) => annRecall(r.slice(0, 8), exact[i].slice(0, 8), 8));
      const sc = scoreQueries(perQuery, 8);
      out.accuracy = { n: sc.n, recallAtK: sc.recallAtK, precisionAtK: sc.precisionAtK, mrr: sc.mrr, overlapAt8WithExact: r3(overlap.reduce((a, b) => a + b, 0) / overlap.length) };
    }
    await adapter.close(h);
    return out;
  } catch (err) {
    return { store: name, size, status: "not measured", reason: String(err && err.message).split("\n")[0] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// du -skL of the package's resolved install directory (its node_modules sibling set, i.e. the package plus the
// dependencies pnpm linked beside it), native binaries found in it, and whether a build ran from source.
export function dependencyCost(storesDir, pkg) {
  const link = join(storesDir, "node_modules", ...pkg.split("/"));
  if (!existsSync(join(link, "package.json"))) return { package: pkg, installed: false };
  const real = realpathSync(link);
  const version = JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version;
  const holder = pkg.startsWith("@") ? dirname(dirname(real)) : dirname(real);
  const du = spawnSync("du", ["-skL", holder], { encoding: "utf8" });
  const find = spawnSync("find", ["-L", holder, "(", "-name", "*.node", "-o", "-name", "*.dylib", "-o", "-name", "*.so", ")", "-not", "-path", "*/obj.target/*"], { encoding: "utf8" });
  const natives = String(find.stdout).split("\n").filter(Boolean);
  return {
    package: pkg,
    installed: true,
    version,
    installedKb: Number(String(du.stdout).split(/\s+/)[0]),
    nativeBinaries: natives.length,
    nativeSample: natives.slice(0, 2).map((p) => relative(holder, p)),
    builtFromSource: existsSync(join(real, "build", "Release")),
  };
}

// Orchestrates the matrix: every store x size as a child process, ascending sizes per store. A cell whose
// predicted build time (the previous cell's build time scaled linearly by size) exceeds the budget is skipped with
// that reason; a child that fails or exceeds its wall-clock allowance is reported with its reason.
export async function runStoreMatrix({ stores, sizes, model, dims, budgetMs, storesDir, snapshotFile, queriesFile, baseUrl, say = () => {} }) {
  const cells = [];
  for (const name of stores) {
    let last = null;
    for (const size of sizes) {
      const n = size === "real" ? null : Number(size);
      if (last && n && last.n && last.buildMs * (n / last.n) > budgetMs) {
        cells.push({ store: name, size, status: "not measured", reason: `predicted build ${Math.round(last.buildMs * (n / last.n))} ms (linear from ${last.n} vectors in ${Math.round(last.buildMs)} ms) exceeds --budget-ms ${budgetMs}` });
        say(`${name} ${size}: skipped (predicted over budget)`);
        continue;
      }
      const args = [fileURLToPath(import.meta.url), "store-cell", "--name", name, "--size", String(size), "--model", model, "--dims", String(dims), "--budget-ms", String(budgetMs), "--stores-dir", storesDir, "--snapshot", snapshotFile, "--queries", queriesFile, "--ollama-url", baseUrl];
      const t0 = performance.now();
      const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: budgetMs * 3 + 120000, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" } });
      let cell;
      try {
        cell = JSON.parse(r.stdout);
      } catch {
        cell = { store: name, size, status: "not measured", reason: r.error ? `cell did not finish: ${r.error.message}` : `cell exited ${r.status}${r.signal ? ` (${r.signal})` : ""}: ${String(r.stderr).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300)}` };
      }
      say(`${name} ${size}: ${cell.status ? `not measured (${cell.reason})` : `build ${cell.buildMs} ms, query p50 ${cell.query.p50} ms, recall@10 ${cell.annRecall10}`} [${Math.round(performance.now() - t0)} ms wall]`);
      cells.push(cell);
      if (cell.buildMs) last = { n: cell.vectors, buildMs: cell.buildMs };
      if (cell.status && size !== "real") break; // a failed synthetic cell: larger sizes will not do better
    }
  }
  return cells;
}

// --- derived reports (so the numbers in the report can be rerun from the repo) --------------------------------------

export function nearTies({ sizes = [1000, 10000], dims = 768 } = {}) {
  return sizes.map((n) => {
    const { flat, queries } = syntheticVectors(SPEED_SEED, n, dims);
    const sum = new Array(11).fill(0);
    for (const q of queries) {
      const sims = [];
      for (let i = 0; i < n; i++) sims.push(dot(q, vecAt(flat, i, dims)));
      sims.sort((a, b) => b - a);
      for (let r = 0; r < 11; r++) sum[r] += sims[r];
    }
    const mean = sum.map((x) => r4(x / queries.length));
    return { vectors: n, dims, meanCosineRank1to11: mean, spreadRank2to11: r4(mean[1] - mean[10]) };
  });
}

const FUSION_COLUMNS = ["dense:#", "rrf:#", "rrf:#:d20", "rrf:#:d10", "wrrf:#:w2", "wrrf:#:w3", "dense+kwboost:#", "rerank:#"];

// Differences of cells of one accuracy result: recency cost (hybrid-shipped:m:norecency - hybrid-shipped:m), the
// residual (rrf:m - hybrid-shipped:m:norecency: prefixes, scoring and tie-break the shipped path lacks), the fusion cost
// (dense:m - rrf:m), and the fusion variants' MRR, R@8 and paraphrase R@8 per model.
export function deriveTables(accuracy, models = ALL_MODELS) {
  const mrr = (n) => (accuracy.modes[n] && !accuracy.modes[n].status ? accuracy.modes[n].mrr : null);
  const attribution = models.map((m) => ({
    model: m,
    dense: mrr(`dense:${m}`),
    rrf: mrr(`rrf:${m}`),
    hybridShippedNorecency: mrr(`hybrid-shipped:${m}:norecency`),
    hybridShipped: mrr(`hybrid-shipped:${m}`),
    recencyCost: r4(mrr(`hybrid-shipped:${m}:norecency`) - mrr(`hybrid-shipped:${m}`)),
    residual: r4(mrr(`rrf:${m}`) - mrr(`hybrid-shipped:${m}:norecency`)),
    fusionCost: r4(mrr(`dense:${m}`) - mrr(`rrf:${m}`)),
    denseWithRecency: mrr(`dense:${m}:recency`),
  }));
  const fusion = models.map((m) => ({
    model: m,
    variants: Object.fromEntries(
      FUSION_COLUMNS.map((c) => {
        const x = accuracy.modes[c.replace("#", m)];
        return [c.replace("#", m), x && !x.status ? { mrr: x.mrr, recallAtK: x.recallAtK, paraphraseRecallAtK: x.byType.paraphrase ? x.byType.paraphrase.recallAtK : null } : null];
      })
    ),
  }));
  return { attribution, fusion };
}
const r4 = (x) => Math.round(x * 10000) / 10000;

// Scores two accuracy results on the queries whose every expected lesson is among the citations of the eligible
// lessons that an `every`-n-th sample kept (what the framework adapters' `every` option ingests).
export function subsetScores({ snapshot, every = 8, results }) {
  const nowMs = new Date(snapshot.snapshotAt).getTime();
  const sampled = eligible(snapshot.lessons, nowMs).filter((_, i) => i % every === 0);
  const cits = new Set(sampled.map((l) => l.citation));
  return {
    sampledLessons: sampled.length,
    results: Object.fromEntries(
      Object.entries(results).map(([name, mode]) => {
        const picked = mode.perQuery.filter((q) => q.expected.every((e) => cits.has(e)));
        const sc = scoreQueries(picked, mode.k || DEFAULT_K);
        return [name, { queries: sc.n, recallAtK: sc.recallAtK, mrr: sc.mrr }];
      })
    ),
  };
}

// --- args, provider resolution, output ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set(["json", "ollama", "spend", "skip-cold-start", "help"]);
const VALUE_FLAGS = new Set([
  "snapshot", "queries", "k", "config", "price-per-mtok", "cap", "reports", "last-report", "sizes", "iterations",
  "store", "out", "budget-ms", "import-files", "model", "dims", "models", "ollama-url", "stores-dir", "stores", "size", "name",
  "frameworks", "framework-python", "framework-dir", "framework-timeout-ms", "framework-config", "vectors-dir",
  "accuracy-json", "a", "b", "every",
]);
const COMMANDS = new Set(["snapshot", "accuracy", "speed", "usefulness", "all", "install-stores", "install-frameworks", "stores", "store-cell", "embed-speed", "near-ties", "derive", "subset"]);

export const USAGE = `Usage: bench-memory.mjs <snapshot|accuracy|speed|usefulness|all|install-stores|install-frameworks|stores|embed-speed> [flags]
  snapshot       [--store <dir>] [--out <file>] [--reports <dir>] [--last-report <file>]   freeze the store and the report inputs to .doug/.state/bench/
  accuracy       [--snapshot <file>] [--queries <file>] [--k <n>] [--frameworks <name[:variant],...>] [--json]
  speed          [--sizes real,1000,10000,100000] [--iterations <n>] [--budget-ms <ms>] [--import-files <n>] [--skip-cold-start] [--json]
  usefulness     [--store <dir>] [--snapshot <file>] [--reports <dir>] [--last-report <file>] [--json]
  all            accuracy + usefulness + speed; --json prints { deterministic, timings, nondeterministic? }
  install-stores pnpm --dir .doug/.state/bench/stores --ignore-workspace add sqlite-vec @lancedb/lancedb hnswlib-node usearch vectra
  install-frameworks  uv venv --python 3.12 .doug/.state/bench/py, then uv pip install the Mem0, LangMem, Graphiti and Letta client packages
  --frameworks   mem0:verbatim,mem0:extract,langmem,graphiti,letta ... (accuracy, speed, all): spawn evals/frameworks/<name>.py in that venv;
                 :extract results are nondeterministic and go under "nondeterministic" with the run date. Also --framework-python <path>,
                 --framework-dir <dir>, --framework-timeout-ms <ms>, --framework-config <json>, --vectors-dir <dir> (the vector cache)
  stores         [--model <m>|best] [--stores a,b] [--sizes real,1000,10000,100000] [--budget-ms <ms>] [--json]   vector-store matrix (one child process per cell)
  embed-speed    [--models a,b] [--size <lessons>] [--json]   embedding throughput through Ollama
  near-ties      [--sizes 1000,10000] [--dims 768]   mean cosine of a synthetic query's ranks 1 to 11 (why ANN recall is low on the synthetic set)
  derive         --accuracy-json <file>   attribution (recency, prefix, fusion) and fusion tables, computed from an "accuracy --json" output
  subset         --a <accuracy json> --b <accuracy json> [--every 8] [--snapshot <file>]   score two runs on the queries whose expected lesson is in an every-n-th sample
  provider       --config <dir> | --ollama [--models a,b | --model <m>] [--dims <n>] [--ollama-url <url>]; --ollama runs every
                 model (dense, rrf, rerank, each with and without prefixes, plus hybrid-shipped); a paid provider also needs
                 --spend --price-per-mtok <usd> --cap <usd>`;

function parseArgs(argv) {
  const flags = {};
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        if (i + 1 >= argv.length) return { error: `--${name} needs a value` };
        flags[name] = argv[++i];
      } else return { error: `unknown flag: ${a}` };
    } else if (!cmd) cmd = a;
    else return { error: `unexpected argument: ${a}` };
  }
  return { cmd, flags };
}

function intFlag(flags, name, def) {
  if (flags[name] === undefined) return def;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be an integer > 0, got ${flags[name]}`);
  return n;
}

class UsageError extends Error {}

const isLocalUrl = (u) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

// Returns { provider, reason } to run, or { exit: 2 } after printing why a paid provider may not run yet.
async function resolveProvider({ flags, fetchImpl, snapshot, queries, say }) {
  const cfg = flags.ollama
    ? { embeddings: { provider: "openai-compatible", baseUrl: flags["ollama-url"] || OLLAMA_URL, model: flags.model || String(flags.models || ALL_MODELS[0]).split(",")[0], dims: Number(flags.dims || 768) } }
    : readMemoryConfig(flags.config || process.cwd());
  const e = cfg.embeddings;
  if (!e) return { provider: null, reason: "no memory.embeddings provider configured (pass --config <dir> with one, or --ollama)" };
  if (isLocalUrl(e.baseUrl)) {
    const probe = await probeProvider(cfg, { fetch: fetchImpl, timeoutMs: 2000 });
    if (!probe.reachable) return { provider: null, reason: `provider not reachable at ${e.baseUrl}: ${probe.reason}` };
    if (probe.kind === "ollama" && probe.modelPresent === false) return { provider: null, reason: `model ${e.model} is not pulled (ollama pull ${e.model})` };
    return { provider: createProvider(cfg, { fetch: fetchImpl, timeoutMs: 120000 }) };
  }
  const chars = snapshot.lessons.filter(isLive).reduce((n, l) => n + l.text.length, 0) + queries.reduce((n, q) => n + q.query.length, 0);
  const tokens = Math.ceil(chars / 4);
  const price = flags["price-per-mtok"] === undefined ? NaN : Number(flags["price-per-mtok"]);
  const cap = flags.cap === undefined ? NaN : Number(flags.cap);
  const estimate = tokens * price / 1e6;
  say(`estimate: ${chars} chars ~ ${tokens} tokens to embed via ${e.provider} ${e.baseUrl} (${e.model})`);
  const missing = [];
  if (!flags.spend) missing.push("--spend");
  if (!(price >= 0)) missing.push("--price-per-mtok <usd>");
  if (!(cap >= 0)) missing.push("--cap <usd>");
  if (missing.length) {
    say(`paid provider: no call made. Missing ${missing.join(", ")}; pass --spend --price-per-mtok <usd> --cap <usd> to run.`);
    return { exit: 2 };
  }
  say(`estimate: ${tokens} tokens x $${price}/Mtok = $${estimate.toFixed(6)}; cap $${cap}`);
  if (estimate > cap) {
    say(`estimate $${estimate.toFixed(6)} exceeds cap $${cap}: no call made.`);
    return { exit: 2 };
  }
  return { provider: createProvider(cfg, { fetch: fetchImpl, timeoutMs: 120000 }) };
}

const pct = (x) => x.toFixed(4);
function renderAccuracy(res, timings = {}) {
  const lines = [`accuracy: k=${res.k}, snapshot ${res.snapshotAt}, ${res.counts.scored}/${res.counts.queries} queries scored (${res.counts.live} live lessons, ${res.counts.inRecallWindow} inside the ${res.staleDays}-day recall window)`];
  const width = Math.max(34, ...Object.keys(res.modes).map((m) => m.length + 1));
  lines.push("mode".padEnd(width) + " n    R@k    P@k    MRR    storage");
  for (const [mode, s] of Object.entries(res.modes)) {
    const tag = s.deterministic === false ? " [nondeterministic]" : "";
    if (s.status) lines.push(`${mode.padEnd(width)} not measured (${s.reason})${tag}`);
    else lines.push(`${mode.padEnd(width)} ${String(s.n).padEnd(4)} ${pct(s.recallAtK)} ${pct(s.precisionAtK)} ${pct(s.mrr)}  ${s.meta.storageBytes} B${tag}`);
  }
  for (const type of QUERY_TYPES) {
    const row = Object.entries(res.modes)
      .filter(([, s]) => !s.status && s.byType[type])
      .map(([mode, s]) => `${mode} R@k ${pct(s.byType[type].recallAtK)} MRR ${pct(s.byType[type].mrr)} (n=${s.byType[type].n})`);
    if (row.length) lines.push(`  ${type}: ${row.join("; ")}`);
  }
  for (const [mode, t] of Object.entries(timings)) lines.push(`  timings ${mode}: ${Object.entries(t).map(([f, v]) => `${f} ${v}`).join(", ")}`);
  if (res.unresolved.length) lines.push(`unresolved expected keys: ${res.unresolved.map((u) => `${u.id}:${u.key}`).join(", ")}`);
  if (res.violators.length) lines.push(`paraphrase violators (not scored): ${res.violators.map((v) => `${v.id}[${v.shared.join(",")}]`).join(", ")}`);
  return lines.join("\n");
}

function renderUsefulness(u) {
  return [
    `usefulness: ${u.lessons} lessons; helpful>0 ${u.counters.withHelpful} (sum ${u.counters.helpfulSum}), harmful>0 ${u.counters.withHarmful} (sum ${u.counters.harmfulSum})`,
    u.reflections ? `reflections: ${u.reflections.rows} rows, helpful ${u.reflections.helpful}, harmful ${u.reflections.harmful}, unknown ${u.reflections.unknown}` : "reflections: not available",
    `reports ${u.reports}, tasks ${u.tasks}, with memoryUsed ${u.tasksWithMemoryUsed} (${pct(u.memoryUsedRate)}), distinct lesson ids used ${u.distinctLessonIdsUsed} (resolved ${u.resolvedIdsUsed}, unresolved ${u.unresolvedIds.length})`,
  ].join("\n");
}

function renderSpeed(s) {
  const lines = ["speed (ms; p50/p95 over n samples; timings vary by machine)"];
  s.timings.sizes.forEach((t, i) => {
    const d = s.deterministic.sizes[i];
    const f = (x) => (x && x.p50 !== undefined ? `${x.p50}/${x.p95} n=${x.n}` : x && x.reason ? `not measured (${x.reason})` : "-");
    lines.push(`${t.size} (${d.lessons} lessons): ${Object.entries(t.recall).map(([n, v]) => `${n} ${f(v)}`).join("; ")}`);
    const extra = [`record ${f(t.record)}`, `import ${f(t.import)}`];
    if (t.importFull) extra.push(`full import ${t.importFull.p50 !== undefined ? `${t.importFull.files} files ${f(t.importFull)}` : "not measured"}`);
    if (t.coldStart) extra.push(`cold start ${f(t.coldStart.memoryCliRecall)} vs bare node ${f(t.coldStart.nodeBare)}`);
    if (t.record) lines.push(`  ${extra.join("; ")}`);
    lines.push(`  storage: ${Object.entries(d.storage).map(([n, v]) => `${n} ${v.storageBytes} B`).join(", ")}`);
  });
  const h = s.deterministic.hooks;
  lines.push(h.importers.length ? `hooks importing memory: ${h.importers.join(", ")}` : `no hook loads memory.mjs (${h.command}: ${h.mentions.length} mention(s))`);
  return lines.join("\n");
}

function renderStores(r) {
  const lines = [`stores: model ${r.deterministic.model} (${r.deterministic.dims} dims); build ms, query p50/p95 ms (k=10), storage, recall@10 vs exact, rss delta`];
  for (const c of r.timings.cells) {
    if (c.status) lines.push(`${c.store.padEnd(14)} ${String(c.size).padEnd(7)} not measured (${c.reason})`);
    else lines.push(`${c.store.padEnd(14)} ${String(c.size).padEnd(7)} build ${c.buildMs} ms, query ${c.query.p50}/${c.query.p95} ms, ${c.storageBytes} B, recall@10 ${c.annRecall10}, rss +${c.rssDeltaMb} MB${c.accuracy ? `, R@8 ${pct(c.accuracy.recallAtK)} MRR ${pct(c.accuracy.mrr)} overlap@8 ${c.accuracy.overlapAt8WithExact}` : ""}`);
  }
  for (const d of r.deterministic.deps) lines.push(d.installed ? `dep ${d.package}@${d.version}: ${d.installedKb} KB installed, ${d.nativeBinaries} native binar${d.nativeBinaries === 1 ? "y" : "ies"}${d.builtFromSource ? ", built from source" : ""}` : `dep ${d.package}: not installed`);
  return lines.join("\n");
}

function renderEmbedSpeed(e) {
  const lines = [`embedding throughput (Ollama ${e.baseUrl}; batch ${e.batch}; ${e.lessons} synthetic lessons; 10k/100k are linear extrapolations)`];
  for (const [m, v] of Object.entries(e.models)) {
    if (v.status) lines.push(`${m}: not measured (${v.reason})`);
    else lines.push(`${m} (${v.dims} dims): cold first call ${v.coldFirstMs} ms (model load), ${v.perLessonMs} ms/lesson warm, 1k ${v.totalMs} ms, 10k ~${v.extrapolatedMs[10000]} ms, 100k ~${v.extrapolatedMs[100000]} ms; single query ${v.queryMs.p50}/${v.queryMs.p95} ms (n=${v.queryMs.n})`);
  }
  return lines.join("\n");
}

// Embedding cost per model: unload it, time the first single-text call (model load), then embed N synthetic lessons
// in batches and 30 single queries, all through real Ollama. 10k/100k are the 1k time scaled linearly.
export async function runEmbedSpeed({ models, baseUrl, fetchImpl, lessons = 1000, batch = 32, unload = true }) {
  const out = { baseUrl, batch, lessons, models: {} };
  const texts = generateLessons(SPEED_SEED + 7, lessons).map((l) => l.text);
  const qs = syntheticQueries(SPEED_SEED + 9, 30);
  for (const model of models) {
    try {
      if (unload) spawnSync("ollama", ["stop", model], { encoding: "utf8" });
      const emb = ollamaEmbedder({ baseUrl, fetchImpl, batch });
      const prefDoc = prefixFor(model, "doc");
      const prefQ = prefixFor(model, "query");
      let s = performance.now();
      const first = await emb([prefDoc + texts[0]], { model });
      const coldFirstMs = performance.now() - s;
      s = performance.now();
      await emb(texts.map((t) => prefDoc + t), { model });
      const totalMs = performance.now() - s;
      const q = [];
      for (const query of qs) {
        const t0 = performance.now();
        await emb([prefQ + query], { model });
        q.push(performance.now() - t0);
      }
      out.models[model] = {
        dims: first[0].length,
        coldFirstMs: r3(coldFirstMs),
        totalMs: r3(totalMs),
        perLessonMs: r3(totalMs / lessons),
        extrapolatedMs: { 10000: Math.round((totalMs * 10000) / lessons), 100000: Math.round((totalMs * 100000) / lessons) },
        queryMs: summarize(q),
      };
    } catch (err) {
      out.models[model] = notMeasured(err.message);
    }
  }
  return out;
}

// --- main --------------------------------------------------------------------------------------------------------

export async function main(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const fetchImpl = io.fetch || globalThis.fetch;
  const parsed = parseArgs(argv);
  if (parsed.error || parsed.flags.help || !COMMANDS.has(parsed.cmd)) {
    stderr(`${parsed.error ? parsed.error + "\n" : ""}${USAGE}\n`);
    return parsed.flags && parsed.flags.help ? 0 : 2;
  }
  const { cmd, flags } = parsed;
  const emit = (obj, text) => stdout(flags.json ? JSON.stringify(obj, null, 2) + "\n" : text + "\n");
  try {
    const storeDir = flags.store || process.cwd();
    const snapshotFile = flags.snapshot || join(process.cwd(), ".doug/.state/bench/lessons.jsonl");
    const loadSnapshot = () => {
      if (!existsSync(snapshotFile)) throw new Error(`no snapshot at ${snapshotFile}; run \`node evals/bench-memory.mjs snapshot\` first`);
      return readSnapshot(snapshotFile);
    };
    const loadQueries = () => readJsonl(flags.queries || DEFAULT_QUERIES);
    const k = intFlag(flags, "k", DEFAULT_K);
    const say = (s) => stdout(s + "\n");

    if (cmd === "install-stores") {
      const results = installStores({ dir: flags["stores-dir"] || STORES_DIR, say });
      for (const r of results) say(`${r.package}: ${r.ok ? "installed" : "FAILED"}`);
      return results.every((r) => r.ok) ? 0 : 1;
    }

    if (cmd === "near-ties") {
      const sizes = String(flags.sizes || "1000,10000").split(",").map(Number);
      const out = nearTies({ sizes, dims: flags.dims ? Number(flags.dims) : 768 });
      emit(out, out.map((o) => `${o.vectors} vectors, ${o.dims} dims: mean cosine by rank 1..11: ${o.meanCosineRank1to11.join(" ")}; rank 2 to 11 spread ${o.spreadRank2to11}`).join("\n"));
      return 0;
    }

    if (cmd === "derive") {
      if (!flags["accuracy-json"]) throw new UsageError("derive needs --accuracy-json <file>");
      const out = deriveTables(JSON.parse(readFileSync(flags["accuracy-json"], "utf8")));
      emit(out, [
        "model | dense | rrf | hybrid-shipped norecency | hybrid-shipped | recency cost | residual (rrf - norecency) | fusion cost (dense - rrf) | dense with recency",
        ...out.attribution.map((a) => [a.model, a.dense, a.rrf, a.hybridShippedNorecency, a.hybridShipped, a.recencyCost, a.residual, a.fusionCost, a.denseWithRecency].join(" | ")),
        "",
        ...out.fusion.map((f) => `${f.model}: ${Object.entries(f.variants).map(([n, v]) => `${n} ${v ? `MRR ${pct(v.mrr)} R@8 ${pct(v.recallAtK)} para ${pct(v.paraphraseRecallAtK ?? 0)}` : "n/m"}`).join("; ")}`),
      ].join("\n"));
      return 0;
    }

    if (cmd === "subset") {
      if (!flags.a || !flags.b) throw new UsageError("subset needs --a <accuracy json> and --b <accuracy json>");
      const pickModes = (file) => {
        const j = JSON.parse(readFileSync(file, "utf8"));
        return { ...j.modes, ...((j.nondeterministic && j.nondeterministic.modes) || {}) };
      };
      const results = {};
      for (const [tag, file] of [["a", flags.a], ["b", flags.b]]) {
        for (const [name, mode] of Object.entries(pickModes(file))) if (name.startsWith("framework:") && !mode.status) results[`${tag}:${name}`] = { ...mode, k };
      }
      const out = subsetScores({ snapshot: loadSnapshot(), every: intFlag(flags, "every", 8), results });
      emit(out, `sample of ${out.sampledLessons} lessons\n` + Object.entries(out.results).map(([n, v]) => `${n}: ${v.queries} queries, R@${k} ${pct(v.recallAtK)}, MRR ${pct(v.mrr)}`).join("\n"));
      return 0;
    }

    if (cmd === "install-frameworks") {
      const results = installFrameworks({ dir: flags["framework-python"] ? dirname(dirname(flags["framework-python"])) : FRAMEWORK_VENV, say });
      for (const r of results) say(`${r.framework} (${r.packages.join(", ")}): ${r.ok ? "installed" : "FAILED"}`);
      return results.every((r) => r.ok) ? 0 : 1;
    }

    if (cmd === "snapshot") {
      const r = writeSnapshot({ store: storeDir, out: flags.out });
      stdout(`wrote ${r.count} lessons to ${r.file} (snapshotAt ${r.snapshotAt})\n`);
      const frozen = freezeReports({
        outDir: dirname(r.file),
        reportsDir: flags.reports || join(process.cwd(), ".doug/.state/reports"),
        lastReportFile: flags["last-report"] || join(process.cwd(), ".doug/.state/last-report.json"),
      });
      stdout(`froze ${frozen.reports} report file(s) next to the snapshot (${frozen.files.join(", ") || "none found"})\n`);
      return 0;
    }

    const baseUrl = flags["ollama-url"] || OLLAMA_URL;
    const models = flags.model ? [flags.model] : String(flags.models || ALL_MODELS.join(",")).split(",").map((m) => m.trim()).filter(Boolean);
    const storesDir = flags["stores-dir"] || STORES_DIR;

    if (cmd === "store-cell") {
      const cell = await runStoreCell({
        name: flags.name,
        size: flags.size,
        model: flags.model,
        dims: Number(flags.dims),
        budgetMs: intFlag(flags, "budget-ms", DEFAULT_BUDGET_MS),
        storesDir,
        snapshot: flags.size === "real" ? loadSnapshot() : null,
        queries: flags.size === "real" ? loadQueries() : [],
        baseUrl,
        fetchImpl,
      });
      stdout(JSON.stringify(cell) + "\n");
      return 0;
    }

    if (cmd === "embed-speed") {
      const e = await runEmbedSpeed({ models, baseUrl, fetchImpl, lessons: intFlag(flags, "size", 1000) });
      emit(e, renderEmbedSpeed(e));
      return 0;
    }

    if (cmd === "stores") {
      const snapshot = loadSnapshot();
      const queries = loadQueries();
      let model = flags.model;
      let pick = null;
      if (!model) {
        const o = await buildOllamaRegistry({ models: ALL_MODELS, baseUrl, fetchImpl, stats: null });
        const dense = o.registry.filter((r) => r.name.startsWith("dense:") && !r.name.endsWith(":noprefix"));
        const acc = await runAccuracy({ snapshot, queries, k: DEFAULT_K, registry: dense });
        const scored = Object.values(acc.modes).filter((m) => !m.status).sort((a, b) => b.mrr - a.mrr);
        if (!scored.length) throw new Error("no dense model could be measured, so there is no best model to pick (is Ollama running?)");
        model = scored[0].retriever.slice("dense:".length);
        pick = scored.map((m) => ({ model: m.retriever.slice("dense:".length), mrr: m.mrr }));
        o.close();
      }
      const dims = flags.dims ? Number(flags.dims) : await ollamaDims(model, { baseUrl, fetchImpl });
      if (!dims) throw new Error(`cannot tell ${model}'s embedding width (pass --dims)`);
      const sizes = String(flags.sizes || DEFAULT_SIZES).split(",").map((x) => x.trim()).filter(Boolean);
      const names = flags.stores ? String(flags.stores).split(",") : STORE_ADAPTERS.map((a) => a.name);
      const cells = await runStoreMatrix({ stores: names, sizes, model, dims, budgetMs: intFlag(flags, "budget-ms", DEFAULT_BUDGET_MS), storesDir, snapshotFile, queriesFile: flags.queries || DEFAULT_QUERIES, baseUrl, say: (x) => stderr(x + "\n") });
      const deps = STORE_PACKAGES.map((pk) => dependencyCost(storesDir, pk));
      const r = { deterministic: { model, dims, pickedBy: pick, deps }, timings: { budgetMs: intFlag(flags, "budget-ms", DEFAULT_BUDGET_MS), cells } };
      emit(r, renderStores(r));
      return 0;
    }

    const wantAccuracy = cmd === "accuracy" || cmd === "all";
    const wantUseful = cmd === "usefulness" || cmd === "all";
    const wantSpeed = cmd === "speed" || cmd === "all";
    const result = { deterministic: {}, timings: {} };
    const text = [];

    let snapshot = null;
    let queries = [];
    if (wantAccuracy || (wantUseful && !flags.store) || (wantSpeed && String(flags.sizes || DEFAULT_SIZES).split(",").includes("real"))) {
      snapshot = loadSnapshot();
    }
    if (wantAccuracy || wantSpeed) {
      try {
        queries = loadQueries();
      } catch (err) {
        if (wantAccuracy) throw err;
      }
    }

    // The retrievers every run shares, plus the provider-backed ones: with --ollama the whole model matrix, with
    // --config the one configured provider, else none.
    const closers = [];
    const stats = {};
    const now = io.now || (() => new Date());
    const vectorsDir = flags["vectors-dir"] || VECTORS_DIR;
    let registry = null;
    let synthetic = [];
    let providerInfo = { provider: null, reason: null };
    let modelsInfo = null;
    if (wantAccuracy || wantSpeed) {
      const p = await resolveProvider({ flags, fetchImpl, snapshot: snapshot || { lessons: [] }, queries, say: (s) => stdout(s + "\n") });
      if (p.exit) return p.exit;
      providerInfo = p;
      registry = [fts5, fts5NoRecency, ftsVariant("porter"), ftsVariant("trigram"), grep];
      if (p.provider && flags.ollama) {
        const o = await buildOllamaRegistry({ models, baseUrl, fetchImpl, stats, vectorsDir, dimsOverride: flags.dims ? Number(flags.dims) : null });
        registry.push(...o.registry);
        synthetic = o.synthetic;
        modelsInfo = o.models;
        closers.push(o.close);
      } else if (p.provider) {
        const g = providerRetrievers(p.provider);
        registry.push(...g.retrievers);
        closers.push(g.close);
      }
      if (flags.frameworks) {
        let extra = {};
        if (flags["framework-config"]) {
          try {
            extra = JSON.parse(flags["framework-config"]);
          } catch {
            throw new UsageError("--framework-config must be a JSON object");
          }
        }
        for (const spec of String(flags.frameworks).split(",").map((x) => x.trim()).filter(Boolean)) {
          const at = spec.indexOf(":");
          registry.push(
            frameworkRetriever({
              framework: at < 0 ? spec : spec.slice(0, at),
              variant: at < 0 ? null : spec.slice(at + 1),
              ...(flags["framework-python"] ? { python: flags["framework-python"] } : {}),
              ...(flags["framework-dir"] ? { dir: flags["framework-dir"] } : {}),
              timeoutMs: intFlag(flags, "framework-timeout-ms", 3600000),
              config: { ollamaUrl: baseUrl, ...extra },
            })
          );
        }
      }
    }
    try {
    if (wantAccuracy) {
      const full = await runAccuracy({ snapshot, queries, k, registry });
      if (!providerInfo.provider) {
        for (const mode of ["semantic", "hybrid", "rerank"]) full.modes[mode] = notMeasured(providerInfo.reason || "no provider configured");
      }
      if (modelsInfo) full.models = modelsInfo;
      // Retrievers flagged deterministic:false (an LLM's extraction varies run to run) leave the deterministic
      // section for `nondeterministic`, stamped with the run's date; wall-clock and LLM-call fields go to timings.
      const { timings: perRetriever, ...accuracy } = full;
      const modeEntries = Object.entries(accuracy.modes);
      accuracy.modes = Object.fromEntries(modeEntries.filter(([, m]) => m.deterministic !== false));
      const loose = Object.fromEntries(modeEntries.filter(([, m]) => m.deterministic === false));
      if (Object.keys(loose).length) result.nondeterministic = { date: now().toISOString(), modes: loose };
      if (Object.keys(perRetriever).length) result.timings.retrievers = perRetriever;
      result.deterministic.accuracy = accuracy;
      text.push(renderAccuracy({ ...accuracy, modes: { ...accuracy.modes, ...loose } }, perRetriever));
    }
    if (wantUseful) {
      const src = flags.store ? readStore(storeDir) : { lessons: snapshot.lessons, reflections: snapshot.reflections };
      // Without --store the lesson counters come from the snapshot, so the report inputs do too: the copies
      // `snapshot` froze beside it. With --store the live defaults apply.
      const frozenDir = dirname(snapshotFile);
      const useful = runUsefulness({
        lessons: src.lessons,
        reflections: src.reflections,
        reportsDir: flags.reports || (flags.store ? join(process.cwd(), ".doug/.state/reports") : join(frozenDir, "reports")),
        lastReportFile: flags["last-report"] || (flags.store ? join(process.cwd(), ".doug/.state/last-report.json") : join(frozenDir, "last-report.json")),
      });
      result.deterministic.usefulness = useful;
      text.push(renderUsefulness(useful));
    }
    if (wantSpeed) {
      const sizes = String(flags.sizes || DEFAULT_SIZES).split(",").map((s) => s.trim()).filter(Boolean);
      for (const s of sizes) if (s !== "real" && !(Number.isInteger(Number(s)) && Number(s) > 0)) throw new UsageError(`--sizes entries must be "real" or positive integers, got ${s}`);
      const speed = await runSpeed({
        sizes,
        iterations: intFlag(flags, "iterations", DEFAULT_ITERATIONS),
        budgetMs: intFlag(flags, "budget-ms", DEFAULT_BUDGET_MS),
        importFiles: intFlag(flags, "import-files", DEFAULT_IMPORT_FILES),
        skipColdStart: !!flags["skip-cold-start"],
        real: snapshot,
        queries: queries.map((q) => q.query),
        // A retriever that needs real embeddings and has no synthetic-vector twin is timed on the real size only.
        retrievers: registry.map((r) => (["keyword", "grep", "framework"].includes(r.kind) || synthetic.some((x) => x.name === r.name) ? r : { ...r, realOnly: true })),
        synthetic,
      });
      result.deterministic.speed = speed.deterministic;
      result.timings.speed = speed.timings;
      text.push(renderSpeed(speed));
    }

    if (Object.keys(stats).length) result.timings.embedding = stats;

    if (cmd === "all") emit(result, text.join("\n\n"));
    else if (cmd === "accuracy") {
      const beside = {};
      if (result.nondeterministic) beside.nondeterministic = result.nondeterministic;
      const t = Object.fromEntries(["retrievers", "embedding"].filter((f) => result.timings[f]).map((f) => [f, result.timings[f]]));
      if (Object.keys(t).length) beside.timings = t;
      emit({ ...result.deterministic.accuracy, ...beside }, text[0]);
    }
    else if (cmd === "usefulness") emit(result.deterministic.usefulness, text[0]);
    else emit({ ...result.deterministic.speed, timings: result.timings.speed }, text[0]);
    return 0;
    } finally {
      for (const c of closers) await c();
    }
  } catch (err) {
    stderr(`bench-memory: ${err.message}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code));
}
