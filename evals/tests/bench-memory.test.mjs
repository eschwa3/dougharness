import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, cpSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  percentile,
  scoreQueries,
  tokenize,
  validateParaphrase,
  rankByGrep,
  generateLessons,
  readSnapshot,
  summarizeLessonCounters,
  collectUsefulness,
  runAccuracy,
  runSpeed,
  main,
  fts5,
  grep,
  providerRetrievers,
  // stage 2 (new exports, see the contract comment below)
  PREFIXES,
  prefixFor,
  vectorCache,
  cosineTopK,
  rrf,
  rerank,
  annRecall,
  loadStore,
  ftsVariant,
  denseFamily,
  // stage 3 and the stage-2 review fixes (new exports, see the contract comment below)
  frameworkRetriever,
  syntheticProvider,
  wrrf,
  kwBoost,
  fts5NoRecency,
  hybridShippedNorecency,
  embedCached,
  STORE_ADAPTERS,
  USAGE,
} from "../bench-memory.mjs";
import { openMemory, addLesson, searchLessons } from "../../plugins/doug-flow/lib/memory.mjs";

// Card memory-benchmark, tester-first. The contract the coder implements in evals/bench-memory.mjs
// (offline, no real store, no network, no grep spawn). Fixture: evals/memory/bench-fixture/ (synthetic).
//
// percentile(values, p)            nearest-rank percentile, p in 0..100, unsorted input allowed:
//                                  value at 1-based rank ceil(p/100 * n) of the sorted copy.
// scoreQueries(perQuery, k)        perQuery = [{ id, type, ranked: [key...], expected: [key...] }];
//                                  returns { n, recallAtK, precisionAtK, mrr, byType: { <type>: same 4 fields } }.
//                                  Definitions as evals/measure-recall.mjs header (P@k = hits in top k / k,
//                                  R@k = hits in top k / expected count, RR = 1 / rank of FIRST relevant hit).
// tokenize(text)                   lowercased [a-z0-9]+ word tokens of length >= 3, minus a small stopword list
//                                  (must include "the" and "and"); order preserved.
// validateParaphrase(query, text)  { ok, shared: [tokens] }; ok = query tokens and text tokens do not intersect.
// rankByGrep(queryTokens, tokenFiles)
//                                  tokenFiles = { token: [file...] } (what `grep -ril -F token` printed; a file
//                                  may repeat); files ranked by number of DISTINCT query tokens found in them
//                                  (desc), ties broken by filename ascending; files with no hit omitted.
// generateLessons(seed, n)         n synthetic lessons from a seeded PRNG over a fixed vocabulary; each is
//                                  { id, kind, citation (*.md basename), text, created (ISO), ... }; never Math.random.
// readSnapshot(file)               jsonl: first line { snapshotAt }, then one lesson per line
//                                  { id, kind, citation, text, created, confirmed, helpful, harmful,
//                                    superseded_by, stale } -> { snapshotAt, lessons }.
// summarizeLessonCounters(lessons) -> { withHelpful, withHarmful, helpfulSum, harmfulSum }.
// collectUsefulness({ reportsDir, lastReportFile, lessonIds })
//                                  walks reportsDir recursively for *.json, plus lastReportFile; only files with a
//                                  `levels` array are reports; tasks are levels[].tasks[] -> { reports, tasks,
//                                  tasksWithMemoryUsed (non-empty memoryUsed), distinctLessonIdsUsed,
//                                  unresolvedIds (sorted; used ids not in lessonIds) }.
// runAccuracy({ snapshot, queries, k, provider })  async; scratch store from the snapshot (created/confirmed/
//                                  superseded/stale preserved), recallLessons with now = snapshot.snapshotAt,
//                                  provider null -> keyword. Returns { k, modes, unresolved, violators } where
//                                  modes.keyword and modes.grep are scoreQueries output plus
//                                  perQuery: [{ id, type, ranked: [citation basename...], expected }], and
//                                  modes.semantic / modes.hybrid / modes.rerank are
//                                  { status: "not measured", reason } with no provider. unresolved =
//                                  [{ id, key }] for expected keys that match no snapshot citation; violators =
//                                  [{ id, shared }] for paraphrase queries sharing a keyword with an expected
//                                  lesson. Violators are reported and NOT scored; a query left with no resolvable
//                                  expected key is not scored either.
// main(argv, io)                   async -> exit code. io = { stdout(s), stderr(s), fetch, env }. Flags used here:
//                                  accuracy|all, --snapshot, --queries, --k, --json, --config <dir>, --ollama,
//                                  --spend, --price-per-mtok, --cap, --reports <dir>, --last-report <file>,
//                                  --sizes <csv>, --iterations <n>, --skip-cold-start. With --snapshot and no
//                                  --store, lesson counters for usefulness come from the snapshot. `all --json`
//                                  prints { deterministic: { accuracy, usefulness, ... }, timings: {...} }.
//                                  A paid (non-localhost) provider without --spend + --price-per-mtok + --cap, or
//                                  with estimate > cap, prints the estimate and returns 2 with NO fetch call.

// ---------------------------------------------------------------------------------------------------------------
// Stage 2 (card memory-benchmark), tester-first. New exports the coder adds to evals/bench-memory.mjs. All tests
// below are offline: a fake embedder (hashed bag-of-words), no Ollama, no stores, no network.
//
// PREFIXES                         { [model]: { query: string, doc: string } } keyed by the BARE model name
//                                  ("embeddinggemma", "nomic-embed-text", "mxbai-embed-large", "bge-m3",
//                                  "qwen3-embedding"); values as in the brief (doc "" when none).
// prefixFor(model, kind, { noprefix = false } = {})
//                                  kind is "query" or "doc"; returns the prefix string; "" when noprefix.
// vectorCache(file)                { key(model, prefix, text) -> string, get(model, prefix, text) -> vec|undefined,
//                                  set(model, prefix, text, vec) }. Backed by the jsonl file `file`: set() appends
//                                  to it at once (no flush call), and a NEW vectorCache(sameFile) reads it back.
//                                  The key covers model, prefix and text.
// cosineTopK(query, items, k)      items = [{ key, vec }] (plain arrays, NOT necessarily unit length); returns
//                                  [{ key, score }] by true cosine desc (ties: key asc), at most k.
// rrf(rankings, { k = 60 } = {})   rankings = [[key...], ...]; returns [{ key, score }] by fused score desc (ties:
//                                  key asc); score = sum over lists of 1/(k + rank), rank 1-based (Cormack 2009).
// rerank(ftsKeys, cosineByKey, { n = 50 } = {})
//                                  ftsKeys = fts5 order; cosineByKey = Map<key, score>; takes the first n of
//                                  ftsKeys, orders them by score desc (ties: fts position), returns keys. A key
//                                  outside the first n never appears.
// annRecall(approxKeys, exactKeys, k = 10)
//                                  |top-k of approx intersect top-k of exact| / k. Always divides by k.
// loadStore(name, { dir })         async. Dynamic import of package `name` from `dir` (the install-stores dir).
//                                  Missing -> RESOLVES { status: "not measured", reason } with reason matching
//                                  /not installed/ and /install-stores/; never throws. Present -> { module }.
// ftsVariant(tokenizer)            "porter" | "trigram" -> a registry retriever named `fts5:${tokenizer}` over a
//                                  bench-owned FTS5 table (tokenize='porter unicode61' / 'trigram'). Same setup
//                                  (lessons, { now }) / search(state, query, k) / teardown(state) / meta(state)
//                                  adapter as fts5. Like every retriever: live lessons only (not superseded, not
//                                  stale) inside the 30-day recency window at ctx.now (confirmed || created).
// denseFamily({ model, embedder, cache = null, noprefix = false, staleDays = 30 })
//                                  -> { retrievers, close }. embedder(texts, { model }) -> Promise<number[][]>.
//                                  retrievers = dense:<model>, rrf:<model>, rerank:<model> (each name gets a
//                                  `:noprefix` suffix when noprefix), each with a unique `mode`. Doc texts are
//                                  prefixed with prefixFor(model, "doc"), the query with prefixFor(model, "query"),
//                                  vectors go through `cache` when given.
// runAccuracy({ ..., registry })   registry = array of retrievers that REPLACES the default [fts5, grep] (+ the
//                                  provider's); results land in modes[r.mode || r.kind].
// runSpeed({ ..., retrievers })    the retrievers to time (default [fts5, grep]); recall timings under
//                                  timings.sizes[i].recall[r.name].
// providerRetrievers(provider)     the state set up for one lesson array is independent of the state set up for
//                                  another (speed at each size times its own store).
// grep                             one scratch file per LESSON (not per citation); same recency window as fts5.
// scoreQueries                     precision divides by k, ranked keys are de-duplicated before scoring.
// main snapshot                    also copies the report inputs (--last-report, --reports, defaults as for
//                                  usefulness) next to the snapshot file: <dirname(out)>/last-report.json and
//                                  <dirname(out)>/reports/ (tree preserved). `usefulness --snapshot <file>` with
//                                  no --reports/--last-report reads those frozen copies.

// ---------------------------------------------------------------------------------------------------------------
// Stage 3 (card memory-benchmark) and the stage-2 review fixes, tester-first. NEW EXPORTS the coder adds to
// evals/bench-memory.mjs (all tests are offline: node fake adapter, fake embedders and providers, no Ollama,
// no Python, no network). Every export below is new; embedCached, STORE_ADAPTERS and USAGE already exist and are
// only pinned.
//
// frameworkRetriever({ framework, variant = null, python = <venv python>, dir = <evals/frameworks>,
//                      timeoutMs = 600000, config = {} })
//                                  -> a retriever adapter named `framework:<framework>[:<variant>]`, kind
//                                  "framework", mode === name. Spawns `python <dir>/<framework>.py` and speaks one
//                                  JSON object per line: setup sends {op:"setup", lessons:[{key,text}], config:
//                                  {variant, ...config}} (key = the lesson id; ONLY the eligible lessons: live and
//                                  inside the recency window) and expects {ok:true, setupMs, storageBytes,
//                                  llmCalls}; search sends {op:"search", query, k} and expects {keys:[...], ms}.
//                                  Returned keys are mapped back to citations (de-duplicated, at most k); a key
//                                  that was never sent is dropped. Failures become setup/search rejections whose
//                                  message is the reason (runAccuracy/runSpeed turn those into
//                                  {status:"not measured", reason}); reasons: "timed out ..." (the child is killed),
//                                  "malformed reply ..." (not JSON, or JSON of the wrong shape), the adapter's own
//                                  `error` text for {ok:false}, and "not installed: run bench-memory.mjs
//                                  install-frameworks" when the python path does not exist OR the adapter replies
//                                  {ok:false, notInstalled:true}. A child that failed or timed out is killed;
//                                  teardown kills it too. meta(state) = { storageBytes, dependency, setupMs,
//                                  llmCalls } (setupMs and llmCalls as the adapter reported them).
//                                  variant "extract" -> retriever.deterministic === false and realOnly === true
//                                  (LLM extraction is nondeterministic and too slow to ingest at synthetic sizes);
//                                  any other variant: neither flag set.
// syntheticProvider({ model, dims, seed })
//                                  -> a provider { name, model, dims, embed(texts, { inputType }) -> { ok: true,
//                                  vectors: [Float32Array(dims) unit length] } } whose vector for a text comes from
//                                  a seeded PRNG keyed by (seed, text): same text -> same vector (document or
//                                  query), different text or seed -> different vector. No network.
// wrrf(rankings, weights, { k = 60 } = {})
//                                  weighted reciprocal-rank fusion: score(d) = sum over lists i of weights[i] /
//                                  (k + rank_i(d)), rank 1-based; returns [{ key, score }] by score desc, ties key asc.
// kwBoost(denseKeys, bm25Keys)     the dense order, then each key of bm25Keys.slice(0, 3), taken from BM25 rank 3 down
//                                  to rank 1, that is present in denseKeys and sits below dense rank 2 is moved to
//                                  rank 2. (So dense rank 1 never moves; BM25 top-3 keys end up at ranks 2, 3, 4 in
//                                  BM25 order; a BM25 key absent from denseKeys is ignored.) Returns a new array.
// fts5NoRecency                    retriever `fts5:norecency` (kind keyword): the shipped recallLessons formula with
//                                  recency fixed at 1, i.e. the BM25 order of the live, in-window lessons.
// hybridShippedNorecency(provider, { staleDays = 30 } = {})
//                                  -> { retrievers: [r], close }; r.name === `hybrid-shipped:<model>:norecency`, kind
//                                  "hybrid": the shipped hybrid formula (BM25 top 50 and dot-product top 50, RRF k=60)
//                                  reimplemented in the bench with recency 1.
// denseFamily({ ..., fusion: true })
//                                  appends five retrievers AFTER the base three (names, in order):
//                                  rrf:<m>:d10, rrf:<m>:d20 (BM25 top n + dense top n, n = 10 / 20),
//                                  wrrf:<m>:w2, wrrf:<m>:w3 (wrrf, dense weight 2 / 3, keyword weight 1, depth 50),
//                                  dense+kwboost:<m> (kwBoost over the full dense order and the BM25 top 50).
//                                  Without the option denseFamily returns exactly the base three.
// setup per call                   denseFamily and providerRetrievers retrievers build a FRESH state on every setup()
//                                  call, even for the same lessons array (accuracy and speed passes must not share
//                                  one); teardown(state) frees only that state; group.close() frees what is left.
// runAccuracy({ ..., registry })   result gains `timings`: { [mode]: { setupMs?, ingestMs?, llmCalls? } } holding those
//                                  three fields of a retriever's meta, for retrievers that report any; modes[mode].meta
//                                  no longer carries them. A retriever with `deterministic: false` gets
//                                  modes[mode].deterministic === false.
// STORE_ADAPTERS                   gains `lancedb-ivfpq:refine10` (ann, package @lancedb/lancedb).
// main flags                       --frameworks <csv of name[:variant]> (spawned per the frameworkRetriever contract),
//                                  --framework-python <path>, --framework-dir <dir>, --vectors-dir <dir> (the vector
//                                  cache directory; tests never touch the real one). io.now() -> Date is the run's
//                                  clock. USAGE lists install-frameworks and --frameworks.
// main output                      accuracy/all --json: modes of a `deterministic: false` retriever are NOT in
//                                  deterministic accuracy .modes; they appear under top-level
//                                  `nondeterministic: { date: <ISO string of io.now()>, modes: {...} }` (key absent when
//                                  there are none); the timings/LLM-call fields go under `timings.retrievers`; the
//                                  `accuracy` command prints the same `timings` and `nondeterministic` keys beside the
//                                  accuracy fields. `--ollama` registers the fusion variants, `fts5:norecency` is in
//                                  every registry, `--ollama` also `hybrid-shipped:<m>:norecency`, hybrid-shipped
//                                  uses the model's own dims, and the speed pass times dense/rrf/hybrid-shipped
//                                  at synthetic sizes with syntheticProvider vectors (no real embedding calls);
//                                  a retriever times at non-real sizes unless it carries realOnly itself (no name rule).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fx = join(root, "evals/memory/bench-fixture");
const snapFile = join(fx, "lessons.jsonl");
const queriesFile = join(fx, "queries.jsonl");

const readJsonl = (f) =>
  readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

async function run(argv, io = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: {}, ...io });
  return { code, stdout, stderr };
}

function configDir(embeddings) {
  const dir = mkdtempSync(join(tmpdir(), "bench-cfg-"));
  mkdirSync(join(dir, ".doug"), { recursive: true });
  writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(embeddings ? { memory: { embeddings } } : {}));
  return dir;
}

const paid = { provider: "openai-compatible", baseUrl: "https://embeddings.example.invalid/v1", model: "m", dims: 3, apiKeyEnv: "BENCH_FAKE_KEY" };

function fakeFetch() {
  return vi.fn(async (url, init) => {
    let n = 1;
    try {
      const body = JSON.parse(init.body);
      n = Array.isArray(body.input) ? body.input.length : 1;
    } catch {}
    const data = Array.from({ length: n }, (_, index) => ({ index, embedding: [1, 0, 0] }));
    return { ok: true, status: 200, json: async () => ({ data }), text: async () => "{}" };
  });
}

describe("percentile (nearest rank)", () => {
  it("p50 and p95 of 1..20 are 10 and 19, not the max", () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(10);
    expect(percentile(v, 95)).toBe(19);
    expect(percentile(v, 100)).toBe(20);
  });
  it("sorts unsorted input and handles a single value", () => {
    expect(percentile([50, 15, 40, 20, 35], 50)).toBe(35);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("scoreQueries", () => {
  const perQuery = [
    { id: "q1", type: "title", ranked: ["a", "b", "c", "d"], expected: ["b"] }, // first hit rank 2
    { id: "q2", type: "title", ranked: ["x", "y", "z", "w"], expected: ["x", "w"] }, // two expected, one beyond k
    { id: "q3", type: "goal", ranked: ["p", "q", "r"], expected: ["s", "t"] }, // nothing found
    { id: "q4", type: "goal", ranked: ["m", "n", "o"], expected: ["m", "o"] }, // two expected, both in top 3
  ];
  it("computes recall@3, precision@3 and MRR by hand", () => {
    const s = scoreQueries(perQuery, 3);
    expect(s.n).toBe(4);
    expect(s.recallAtK).toBeCloseTo((1 + 0.5 + 0 + 1) / 4, 10);
    expect(s.precisionAtK).toBeCloseTo((1 / 3 + 1 / 3 + 0 + 2 / 3) / 4, 10);
    expect(s.mrr).toBeCloseTo((0.5 + 1 + 0 + 1) / 4, 10);
  });
  it("splits by query type", () => {
    const s = scoreQueries(perQuery, 3);
    expect(s.byType.title.n).toBe(2);
    expect(s.byType.title.recallAtK).toBeCloseTo(0.75, 10);
    expect(s.byType.title.precisionAtK).toBeCloseTo(1 / 3, 10);
    expect(s.byType.title.mrr).toBeCloseTo(0.75, 10);
    expect(s.byType.goal.recallAtK).toBeCloseTo(0.5, 10);
    expect(s.byType.goal.mrr).toBeCloseTo(0.5, 10);
  });
});

describe("tokenize and validateParaphrase", () => {
  it("lowercases, drops short words and stopwords", () => {
    expect(tokenize("The Zephyr-flag, and v2 in Cache!")).toEqual(["zephyr", "flag", "cache"]);
  });
  it("flags a paraphrase that shares a keyword", () => {
    const r = validateParaphrase("slow down request flooding gateway", "Onyx gateway throttles bursts above fifty requests per second.");
    expect(r.ok).toBe(false);
    expect(r.shared).toEqual(["gateway"]);
  });
  it("passes a paraphrase that shares none, ignoring stopword overlap", () => {
    const text = "Juniper exporter writes timestamps in UTC while the importer expects local time.";
    expect(validateParaphrase("why do dates look shifted between tools", text)).toEqual({ ok: true, shared: [] });
    expect(validateParaphrase("the and dates", text).ok).toBe(true);
  });
});

describe("rankByGrep", () => {
  const tokenFiles = {
    alpha: ["f4.md", "f2.md", "f3.md"],
    beta: ["f3.md", "f2.md"],
    gamma: ["f3.md", "f1.md", "f1.md"], // f1 repeats: still one distinct token
  };
  it("ranks by distinct tokens found, ties by filename", () => {
    expect(rankByGrep(["alpha", "beta", "gamma"], tokenFiles)).toEqual(["f3.md", "f2.md", "f1.md", "f4.md"]);
  });
  it("omits files with no hit and ignores tokens grep found nowhere", () => {
    expect(rankByGrep(["beta", "nowhere"], tokenFiles)).toEqual(["f2.md", "f3.md"]);
  });
});

describe("generateLessons", () => {
  it("same seed gives identical lessons, a different seed differs", () => {
    const a = generateLessons(42, 30);
    expect(a).toHaveLength(30);
    expect(generateLessons(42, 30)).toEqual(a);
    expect(generateLessons(43, 30)).not.toEqual(a);
  });
  it("is well formed with unique ids and never touches Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    const ls = generateLessons(7, 50);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(new Set(ls.map((l) => l.id)).size).toBe(50);
    for (const l of ls) {
      expect(["feedback", "project", "pitfall", "pattern"]).toContain(l.kind);
      expect(l.citation).toMatch(/\.md$/);
      expect(l.text.length).toBeGreaterThan(10);
      expect(Number.isNaN(Date.parse(l.created))).toBe(false);
    }
  });
});

describe("snapshot, counters, usefulness", () => {
  it("reads the fixture snapshot", () => {
    const s = readSnapshot(snapFile);
    expect(s.snapshotAt).toBe("2020-01-10T00:00:00.000Z");
    expect(s.lessons).toHaveLength(8);
    expect(s.lessons[0].citation).toBe("quartz-landing.md");
  });
  it("sums helpful/harmful counters", () => {
    expect(summarizeLessonCounters(readSnapshot(snapFile).lessons)).toEqual({ withHelpful: 2, withHarmful: 1, helpfulSum: 4, harmfulSum: 2 });
  });
  it("counts tasks with non-empty memoryUsed, distinct ids, unresolved ids", () => {
    const lessonIds = readSnapshot(snapFile).lessons.map((l) => l.id);
    const u = collectUsefulness({ reportsDir: join(fx, "reports"), lastReportFile: join(fx, "last-report.json"), lessonIds });
    expect(u.reports).toBe(3); // card-a, card-b, last-report; condition.json has no levels
    expect(u.tasks).toBe(6);
    expect(u.tasksWithMemoryUsed).toBe(4); // empty and absent memoryUsed do not count
    expect(u.distinctLessonIdsUsed).toBe(5);
    expect(u.unresolvedIds).toEqual(["l-ghost", "l-ghost2"]);
  });
});

describe("runAccuracy on the fixture", () => {
  const snapshot = readSnapshot(snapFile);
  const queries = readJsonl(queriesFile);
  it("recalls a lesson older than 30 days against wall clock but inside the window at snapshotAt", async () => {
    const r = await runAccuracy({ snapshot, queries, k: 3, provider: null });
    const t1 = r.modes.keyword.perQuery.find((q) => q.id === "t1");
    expect(t1.ranked[0]).toBe("quartz-landing.md");
  });
  it("does not recall a lesson already stale at snapshotAt", async () => {
    const r = await runAccuracy({ snapshot, queries, k: 3, provider: null });
    const a1 = r.modes.keyword.perQuery.find((q) => q.id === "a1");
    expect(a1.ranked).not.toContain("ancient-landing.md");
  });
  it("reports unresolved keys and paraphrase violators instead of scoring them", async () => {
    const r = await runAccuracy({ snapshot, queries, k: 3, provider: null });
    expect(r.unresolved).toEqual([{ id: "m1", key: "missing-landing.md" }]);
    expect(r.violators).toEqual([{ id: "p2", shared: ["gateway"] }]);
    const ids = r.modes.keyword.perQuery.map((q) => q.id).sort();
    expect(ids).toEqual(["a1", "g1", "g2", "p1", "t1", "t2"]);
    expect(r.modes.keyword.n).toBe(6);
  });
  it("ranks the matching lesson first for keyword and grep-shaped modes, and does not fabricate semantic numbers", async () => {
    const r = await runAccuracy({ snapshot, queries, k: 3, provider: null });
    expect(r.modes.keyword.perQuery.find((q) => q.id === "g1").ranked[0]).toBe("marble-landing.md");
    expect(r.modes.keyword.perQuery.find((q) => q.id === "p1").ranked).not.toContain("juniper-landing.md");
    expect(r.modes.grep.perQuery.find((q) => q.id === "t2").ranked[0]).toBe("tundra-landing.md");
    for (const m of ["semantic", "hybrid", "rerank"]) {
      expect(r.modes[m].status).toBe("not measured");
      expect(r.modes[m].reason).toMatch(/\S/);
    }
  });
});

describe("main: spend guard and fixed-fixture runs", () => {
  const base = ["accuracy", "--snapshot", snapFile, "--queries", queriesFile, "--k", "3"];
  it("a paid provider without --spend returns 2, prints an estimate, never calls fetch", async () => {
    const fetch = fakeFetch();
    const r = await run([...base, "--config", configDir(paid)], { fetch, env: { BENCH_FAKE_KEY: "x" } });
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/estimate/i);
    expect(r.stdout + r.stderr).toMatch(/--spend/);
    expect(fetch).not.toHaveBeenCalled();
  });
  // Added by the coder: mutation 9 (drop the --spend check) survived the cases above, since each of them also
  // lacks a price or cap. A price and a cap within budget but no --spend must still be refused.
  it("a price and a cap without --spend is still 2 with no call", async () => {
    const fetch = fakeFetch();
    const r = await run([...base, "--config", configDir(paid), "--price-per-mtok", "1", "--cap", "100"], { fetch, env: { BENCH_FAKE_KEY: "x" } });
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/--spend/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("--spend without a price or cap is still 2 with no call", async () => {
    const fetch = fakeFetch();
    const r = await run([...base, "--config", configDir(paid), "--spend", "--cap", "5"], { fetch, env: { BENCH_FAKE_KEY: "x" } });
    expect(r.code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an estimate above the cap is 2 with no call", async () => {
    const fetch = fakeFetch();
    const r = await run([...base, "--config", configDir(paid), "--spend", "--price-per-mtok", "1000000", "--cap", "1"], { fetch, env: { BENCH_FAKE_KEY: "x" } });
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/estimate/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("with every flag and an estimate within the cap the provider is called and the run exits 0", async () => {
    const fetch = fakeFetch();
    const r = await run([...base, "--config", configDir(paid), "--spend", "--price-per-mtok", "1", "--cap", "100"], { fetch, env: { BENCH_FAKE_KEY: "x" } });
    expect(r.code).toBe(0);
    expect(fetch).toHaveBeenCalled();
  });
  it("--ollama with an unreachable server reports not measured and exits 0", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await run([...base, "--ollama", "--json"], { fetch });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).modes.semantic.status).toBe("not measured");
  });
  it("no provider configured: keyword and grep numbers, semantic not measured", async () => {
    const r = await run([...base, "--config", configDir(null), "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(typeof j.modes.keyword.recallAtK).toBe("number");
    expect(j.modes.semantic.status).toBe("not measured");
  });
});

describe("determinism", () => {
  it("the deterministic section of two `all --json` runs over the fixture is deep-equal", async () => {
    const argv = [
      "all", "--json", "--snapshot", snapFile, "--queries", queriesFile, "--k", "3",
      "--reports", join(fx, "reports"), "--last-report", join(fx, "last-report.json"),
      "--sizes", "real,40", "--iterations", "1", "--skip-cold-start", "--config", configDir(null),
    ];
    const a = await run(argv);
    const b = await run(argv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const ja = JSON.parse(a.stdout);
    const jb = JSON.parse(b.stdout);
    expect(ja.timings).toBeTruthy();
    expect(ja.deterministic.accuracy.modes.keyword.n).toBe(6);
    expect(ja.deterministic.usefulness.tasksWithMemoryUsed).toBe(4);
    expect(ja.deterministic).toEqual(jb.deterministic);
  });
});

describe("checked-in query set", () => {
  const file = join(root, "evals/memory/bench-queries.jsonl");
  const lines = readJsonl(file);
  it("every line has a valid type, a query, and non-empty expected keys", () => {
    expect(lines.length).toBeGreaterThanOrEqual(40);
    for (const q of lines) {
      expect(["title", "goal", "paraphrase"]).toContain(q.type);
      expect(typeof q.id).toBe("string");
      expect(typeof q.card).toBe("string");
      expect(q.query.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(q.expected)).toBe(true);
      expect(q.expected.length).toBeGreaterThan(0);
    }
    expect(new Set(lines.map((q) => q.id)).size).toBe(lines.length);
  });
  it("has at least 30 title/goal queries and at least 10 paraphrase queries", () => {
    expect(lines.filter((q) => q.type !== "paraphrase").length).toBeGreaterThanOrEqual(30);
    expect(lines.filter((q) => q.type === "paraphrase").length).toBeGreaterThanOrEqual(10);
  });
});

// =================================================================================================================
// Stage 2 and stage-1 review fixes
// =================================================================================================================

const replayFile = join(fx, "lessons-replay.jsonl");
const replay = readSnapshot(replayFile);
const NOW = replay.snapshotAt;

// Hashed bag-of-words embedder: unit-length vectors, deterministic, lexical overlap = cosine.
const DIMS = 32;
function vecOf(text) {
  const v = new Array(DIMS).fill(0);
  for (const m of String(text).toLowerCase().matchAll(/[a-z0-9]+/g)) {
    let h = 2166136261;
    for (const ch of m[0]) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
function fakeEmbedder() {
  const calls = [];
  const fn = async (texts, opts = {}) => {
    calls.push({ model: opts.model, texts: [...texts] });
    return texts.map(vecOf);
  };
  fn.calls = calls;
  fn.texts = () => calls.flatMap((c) => c.texts);
  return fn;
}
function fakeProvider(vectorFor = vecOf, model = "fake-embed") {
  return {
    name: "fake",
    model,
    dims: DIMS,
    async embed(texts) {
      return { ok: true, vectors: texts.map((t) => Float32Array.from(vectorFor(t))) };
    },
  };
}
function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
async function searchWith(r, lessons, query, k = 8, now = NOW) {
  const state = await r.setup(lessons, { now });
  try {
    return await r.search(state, query, k);
  } finally {
    await r.teardown(state);
  }
}

describe("prefix table", () => {
  it("mxbai: the query gets its prefix and the doc gets none", () => {
    expect(prefixFor("mxbai-embed-large", "query")).toBe("Represent this sentence for searching relevant passages: ");
    expect(prefixFor("mxbai-embed-large", "doc")).toBe("");
    expect(PREFIXES["mxbai-embed-large"].query).toBe("Represent this sentence for searching relevant passages: ");
  });
  it("nomic: both sides prefixed", () => {
    expect(prefixFor("nomic-embed-text", "query")).toBe("search_query: ");
    expect(prefixFor("nomic-embed-text", "doc")).toBe("search_document: ");
  });
  it("embeddinggemma, qwen3 and bge-m3 follow the brief", () => {
    expect(prefixFor("embeddinggemma", "query")).toBe("task: search result | query: ");
    expect(prefixFor("embeddinggemma", "doc")).toBe("title: none | text: ");
    expect(prefixFor("qwen3-embedding", "query")).toBe("Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ");
    expect(prefixFor("qwen3-embedding", "doc")).toBe("");
    expect(prefixFor("bge-m3", "query")).toBe("");
    expect(prefixFor("bge-m3", "doc")).toBe("");
  });
  it("the noprefix variant gets none on either side, for every model", () => {
    for (const model of Object.keys(PREFIXES)) {
      expect(prefixFor(model, "query", { noprefix: true })).toBe("");
      expect(prefixFor(model, "doc", { noprefix: true })).toBe("");
    }
    expect(Object.keys(PREFIXES).sort()).toEqual(["bge-m3", "embeddinggemma", "mxbai-embed-large", "nomic-embed-text", "qwen3-embedding"]);
  });
});

describe("vectorCache", () => {
  it("hits on the same model, prefix and text", () => {
    const c = vectorCache(join(tmp("bench-vc-"), "m.jsonl"));
    c.set("m1", "p: ", "hello", [1, 2, 3]);
    expect(Array.from(c.get("m1", "p: ", "hello"))).toEqual([1, 2, 3]);
  });
  it("misses when only the model differs", () => {
    const c = vectorCache(join(tmp("bench-vc-"), "m.jsonl"));
    c.set("m1", "p: ", "hello", [1, 2, 3]);
    expect(c.get("m2", "p: ", "hello")).toBeUndefined();
  });
  it("misses when only the prefix differs", () => {
    const c = vectorCache(join(tmp("bench-vc-"), "m.jsonl"));
    c.set("m1", "p: ", "hello", [1, 2, 3]);
    expect(c.get("m1", "", "hello")).toBeUndefined();
    expect(c.get("m1", "q: ", "hello")).toBeUndefined();
  });
  it("misses when only the text differs, and keys are distinct per field", () => {
    const c = vectorCache(join(tmp("bench-vc-"), "m.jsonl"));
    c.set("m1", "p: ", "hello", [1, 2, 3]);
    expect(c.get("m1", "p: ", "hello!")).toBeUndefined();
    expect(new Set([c.key("m1", "p", "t"), c.key("m2", "p", "t"), c.key("m1", "q", "t"), c.key("m1", "p", "u")]).size).toBe(4);
  });
  it("a new instance over the same file reads the vectors back", () => {
    const file = join(tmp("bench-vc-"), "m.jsonl");
    vectorCache(file).set("m1", "p: ", "hello", [0.5, 0.25]);
    expect(Array.from(vectorCache(file).get("m1", "p: ", "hello"))).toEqual([0.5, 0.25]);
    expect(vectorCache(file).get("m2", "p: ", "hello")).toBeUndefined();
  });
});

describe("cosineTopK", () => {
  // Non-unit vectors on purpose: true cosine order A, B, C; raw dot-product order B, A, C.
  const items = [
    { key: "A", vec: [0.5, 0] }, // cos 1, dot 0.5
    { key: "B", vec: [10, 10] }, // cos 0.7071, dot 10
    { key: "C", vec: [0, 5] }, // cos 0, dot 0
  ];
  it("orders by true cosine, not dot product", () => {
    const r = cosineTopK([1, 0], items, 3);
    expect(r.map((x) => x.key)).toEqual(["A", "B", "C"]);
    expect(r[0].score).toBeCloseTo(1, 10);
    expect(r[1].score).toBeCloseTo(Math.SQRT1_2, 10);
    expect(r[2].score).toBeCloseTo(0, 10);
  });
  it("returns at most k, and scales of the query do not matter", () => {
    expect(cosineTopK([7, 0], items, 2).map((x) => x.key)).toEqual(["A", "B"]);
  });
});

describe("rrf (k=60)", () => {
  // list1 [a,b,c], list2 [b,d,a]: a 1/61+1/63, b 1/62+1/61, c 1/63 (one list only), d 1/62 (one list only).
  const fuse = () => rrf([["a", "b", "c"], ["b", "d", "a"]]);
  it("fuses in the hand-computed order", () => {
    expect(fuse().map((x) => x.key)).toEqual(["b", "a", "d", "c"]);
  });
  it("scores match 1/(60+rank) with rank starting at 1, including single-list items", () => {
    const s = Object.fromEntries(fuse().map((x) => [x.key, x.score]));
    expect(s.a).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(s.b).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(s.c).toBeCloseTo(1 / 63, 10);
    expect(s.d).toBeCloseTo(1 / 62, 10);
  });
  it("a tie is broken by key", () => {
    expect(rrf([["y"], ["x"]]).map((r) => r.key)).toEqual(["x", "y"]);
  });
});

describe("rerank", () => {
  const fts = ["a", "b", "c", "d", "e"];
  const cos = new Map([["a", 0.1], ["b", 0.5], ["c", 0.3], ["d", 0.99], ["e", 0.9]]);
  it("reorders the fts top-n by cosine and never returns an item outside it", () => {
    expect(rerank(fts, cos, { n: 3 })).toEqual(["b", "c", "a"]);
  });
  it("takes the top-n from the fts list, not the dense one (d and e are dense's best)", () => {
    const r = rerank(fts, cos, { n: 3 });
    expect(r).not.toContain("d");
    expect(r).not.toContain("e");
  });
  it("with n covering the list it is a full cosine sort; ties keep fts order", () => {
    expect(rerank(fts, cos, { n: 50 })).toEqual(["d", "e", "b", "c", "a"]);
    expect(rerank(["p", "q", "r"], new Map([["p", 1], ["q", 1], ["r", 1]]), { n: 3 })).toEqual(["p", "q", "r"]);
  });
});

describe("annRecall", () => {
  const exact = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  it("8 of the exact top 10 in the approximate top 10 is 0.8; exact items past 10 do not count", () => {
    const approx = ["1", "2", "3", "4", "5", "6", "7", "8", "x", "y", "9"];
    expect(annRecall(approx, exact, 10)).toBeCloseTo(0.8, 10);
    expect(annRecall(["11", "12", "1", "2", "3", "4", "5", "6", "7", "8"], exact, 10)).toBeCloseTo(0.8, 10);
  });
  it("divides by 10, not by how many came back", () => {
    expect(annRecall(["1", "2", "3", "4", "5"], exact, 10)).toBeCloseTo(0.5, 10);
    expect(annRecall([], exact, 10)).toBe(0);
  });
  it("defaults k to 10", () => {
    expect(annRecall(["1", "2", "3", "4", "5"], exact)).toBeCloseTo(0.5, 10);
  });
});

describe("loadStore", () => {
  it("a missing package resolves to not measured (not installed...), never throws", async () => {
    const dir = tmp("bench-stores-");
    const r = await loadStore("sqlite-vec", { dir });
    expect(r.status).toBe("not measured");
    expect(r.reason).toMatch(/not installed/);
    expect(r.reason).toMatch(/install-stores/);
    expect(r.module).toBeUndefined();
  });
  it("an installed package comes back as its module", async () => {
    const dir = tmp("bench-stores-");
    const pkg = join(dir, "node_modules", "fakestore");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fakestore", version: "1.0.0", type: "module", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), "export const marker = 'fakestore-loaded';\n");
    const r = await loadStore("fakestore", { dir });
    expect(r.status).toBeUndefined();
    expect(r.module.marker).toBe("fakestore-loaded");
  });
});

describe("SQLite FTS5 variants", () => {
  it("fts5:trigram finds the substring `ration` in parseDuration; the shipped unicode61 table does not", async () => {
    const tri = ftsVariant("trigram");
    expect(tri.name).toBe("fts5:trigram");
    expect(await searchWith(tri, replay.lessons, "ration", 8)).toContain("duration-landing.md");
    expect(await searchWith(fts5, replay.lessons, "ration", 8)).not.toContain("duration-landing.md");
  });
  it("fts5:porter stems: `retrying` finds a lesson that says retry and retries", async () => {
    const por = ftsVariant("porter");
    expect(por.name).toBe("fts5:porter");
    expect((await searchWith(por, replay.lessons, "retrying", 8))[0]).toBe("duration-landing.md");
  });
  it("exposes the retriever adapter shape", () => {
    for (const r of [ftsVariant("porter"), ftsVariant("trigram")]) {
      expect(r.kind).toBe("keyword");
      for (const f of ["setup", "search", "teardown", "meta"]) expect(typeof r[f]).toBe("function");
    }
  });
});

describe("scoreQueries survivors (R5, R9)", () => {
  it("R5: precision divides by k, not by how many came back", () => {
    const s = scoreQueries([{ id: "q", type: "title", ranked: ["a"], expected: ["a"] }], 3);
    expect(s.precisionAtK).toBeCloseTo(1 / 3, 10);
    expect(s.byType.title.precisionAtK).toBeCloseTo(1 / 3, 10);
    expect(s.recallAtK).toBe(1);
  });
  it("R9: repeated ranked keys count once (hits, recall, MRR)", () => {
    const dupHit = scoreQueries([{ id: "q", type: "title", ranked: ["a", "a"], expected: ["a"] }], 2);
    expect(dupHit.precisionAtK).toBeCloseTo(1 / 2, 10);
    expect(dupHit.recallAtK).toBe(1);
    const dupFirst = scoreQueries([{ id: "q", type: "title", ranked: ["a", "a", "b"], expected: ["b"] }], 3);
    expect(dupFirst.mrr).toBeCloseTo(0.5, 10);
    expect(dupFirst.precisionAtK).toBeCloseTo(1 / 3, 10);
  });
});

describe("scratch store replay: superseded, confirmed, stale (R3, R4)", () => {
  it("R3: a superseded lesson is not recalled; its replacement is", async () => {
    const ranked = await searchWith(fts5, replay.lessons, "kestrel handshake timeout plaintext", 8);
    expect(ranked).not.toContain("handshake-old-landing.md");
    expect(ranked).toContain("handshake-new-landing.md");
  });
  it("R4: a lesson created long ago but confirmed inside the window is recalled", async () => {
    const ranked = await searchWith(fts5, replay.lessons, "mallard deploy", 8);
    expect(ranked[0]).toBe("mallard-landing.md");
  });
  it("R4: a lesson stale at snapshotAt is not recalled even though it was created inside the window", async () => {
    const ranked = await searchWith(fts5, replay.lessons, "heron dashboard refresh", 8);
    expect(ranked).not.toContain("heron-landing.md");
  });
});

describe("every retriever sees the same live set and recency window", () => {
  const dense = () => denseFamily({ model: "nomic-embed-text", embedder: fakeEmbedder() });
  const cases = [
    ["fts5", () => ({ r: fts5 })],
    ["grep", () => ({ r: grep })],
    ["fts5:porter", () => ({ r: ftsVariant("porter") })],
    ["fts5:trigram", () => ({ r: ftsVariant("trigram") })],
    ["dense", () => {
      const g = dense();
      return { r: g.retrievers.find((x) => x.name.startsWith("dense:")), g };
    }],
  ];
  for (const [label, make] of cases) {
    it(`${label}: no superseded, no stale, no out-of-window lesson; a recently confirmed one is first`, async () => {
      const { r, g } = make();
      try {
        expect(await searchWith(r, replay.lessons, "plaintext", 8)).not.toContain("handshake-old-landing.md");
        expect(await searchWith(r, replay.lessons, "heron dashboard", 8)).not.toContain("heron-landing.md");
        expect(await searchWith(r, replay.lessons, "obelisk relic", 8)).not.toContain("dusty-landing.md");
        expect((await searchWith(r, replay.lessons, "mallard", 8))[0]).toBe("mallard-landing.md");
      } finally {
        if (g) await g.close();
      }
    });
  }
});

describe("grep indexes live lessons only (R10)", () => {
  it("a superseded lesson and a stale lesson are not in the grep corpus", async () => {
    expect(await searchWith(grep, replay.lessons, "plaintext", 8)).not.toContain("handshake-old-landing.md");
    expect(await searchWith(grep, replay.lessons, "heron", 8)).not.toContain("heron-landing.md");
    expect(await searchWith(grep, replay.lessons, "thirty", 8)).toContain("handshake-new-landing.md");
  });
});

describe("grep filenames are unique per lesson (three live lessons share one citation)", () => {
  it("every shared-citation lesson is searchable, not just the last one written", async () => {
    for (const token of ["xylophone", "yodel", "zither"]) {
      expect(await searchWith(grep, replay.lessons, token, 8)).toEqual(["shared-landing.md"]);
    }
  });
});

describe("registry is a parameter", () => {
  const customRetriever = (name, ranked) => ({
    name,
    kind: "keyword",
    mode: name,
    async setup() {
      return { n: 0 };
    },
    async search(state) {
      state.n++;
      return ranked;
    },
    teardown() {},
    meta: () => ({ storageBytes: 7 }),
  });
  it("runAccuracy runs exactly the registry it is given, keyed by mode", async () => {
    const snapshot = readSnapshot(snapFile);
    const queries = readJsonl(queriesFile);
    const r = await runAccuracy({ snapshot, queries, k: 3, provider: null, registry: [customRetriever("oracle", ["marble-landing.md"])] });
    expect(r.modes.oracle.perQuery.every((q) => q.ranked[0] === "marble-landing.md")).toBe(true);
    expect(r.modes.oracle.perQuery.find((q) => q.id === "g1").ranked).toEqual(["marble-landing.md"]);
    expect(r.modes.oracle.meta.storageBytes).toBe(7);
    expect(r.modes.keyword).toBeUndefined();
    expect(r.modes.grep).toBeUndefined();
  });
  it("runSpeed times the retrievers it is given and no others", async () => {
    const out = await runSpeed({
      sizes: ["12"], iterations: 2, budgetMs: 1000, importFiles: 1, skipColdStart: true,
      retrievers: [customRetriever("oracle", ["x.md"])],
    });
    const recall = out.timings.sizes[0].recall;
    expect(Object.keys(recall)).toEqual(["oracle"]);
    expect(typeof recall.oracle.p50).toBe("number");
    expect(out.deterministic.sizes[0].storage.oracle.storageBytes).toBe(7);
    expect(out.timings.sizes[0].record).toBeUndefined();
  });
});

describe("providerRetrievers: state per lesson set (R11, R12)", () => {
  const snapshot = readSnapshot(snapFile);
  it("setup on two lesson sets gives two independent states", async () => {
    const group = providerRetrievers(fakeProvider());
    const setA = snapshot.lessons.slice(0, 3);
    const setB = snapshot.lessons.slice(2, 7);
    try {
      for (const r of group.retrievers) {
        const a = await r.setup(setA, { now: NOW });
        const b = await r.setup(setB, { now: snapshot.snapshotAt });
        expect(r.meta(a).embedded).toBe(3);
        expect(r.meta(b).embedded).toBe(5);
        expect(await r.search(b, "onyx gateway throttles", 8)).toContain("onyx-landing.md");
        expect(await r.search(a, "onyx gateway throttles", 8)).not.toContain("onyx-landing.md");
      }
    } finally {
      await group.close();
    }
  });
  it("speed at each size times its own store", async () => {
    const group = providerRetrievers(fakeProvider());
    try {
      const out = await runSpeed({
        sizes: ["6", "200"], iterations: 1, budgetMs: 2000, importFiles: 1, skipColdStart: true,
        retrievers: group.retrievers,
      });
      expect(group.retrievers.length).toBeGreaterThan(0);
      for (const r of group.retrievers) {
        const small = out.deterministic.sizes[0].storage[r.name].storageBytes;
        const big = out.deterministic.sizes[1].storage[r.name].storageBytes;
        expect(big).toBeGreaterThan(small);
      }
    } finally {
      await group.close();
    }
  });
  it("R11: the hybrid retriever returns the matching lesson, not an empty list", async () => {
    const group = providerRetrievers(fakeProvider());
    try {
      const hybrid = group.retrievers.find((r) => r.name.startsWith("hybrid"));
      expect(hybrid).toBeTruthy();
      const ranked = await searchWith(hybrid, snapshot.lessons, "zephyr quartz cache", 3, snapshot.snapshotAt);
      expect(ranked[0]).toBe("quartz-landing.md");
    } finally {
      await group.close();
    }
  });
  it("R12: when the provider has one, the rerank retriever reorders the fts5 candidates by cosine", async () => {
    const fixt = await reverseFixture();
    const group = providerRetrievers(fakeProvider(fixt.vecFor));
    try {
      const rr = group.retrievers.find((r) => r.name.startsWith("rerank"));
      if (!rr) return; // stage 2 may move rerank onto the dense vectors; denseFamily covers it then
      const ranked = await searchWith(rr, fixt.lessons, "gizmo", 3);
      expect(ranked).toEqual(fixt.cosOrder);
      expect(ranked).not.toEqual(fixt.bm25);
    } finally {
      await group.close();
    }
  });
});

// Three live lessons all matching `gizmo`; vectors are built so cosine order is the reverse of bm25 order.
async function reverseFixture() {
  const words = ["alpha", "beta", "gamma"];
  const lessons = words.map((w, i) => ({
    id: `r-${w}`, kind: "project", citation: `${w}-landing.md`,
    text: `Gizmo ${w}${" filler".repeat(i * 3)}.`,
    created: "2020-01-05T00:00:00.000Z", confirmed: null, helpful: 0, harmful: 0, superseded_by: null, stale: null,
  }));
  const probe = await fts5.setup(lessons, { now: NOW });
  const bm25 = searchLessons(probe.m, "gizmo", { k: 50 }).map((l) => l.citation);
  await fts5.teardown(probe);
  const cosOrder = bm25.slice().reverse(); // best cosine first
  const axis = (cit) => words.findIndex((w) => cit.startsWith(w));
  const queryVec = [0, 0, 0];
  cosOrder.forEach((cit, rank) => (queryVec[axis(cit)] = 3 - rank));
  const vecFor = (t) => {
    if (t === "gizmo") return queryVec;
    const v = [0, 0, 0];
    v[words.findIndex((w) => t.includes(w))] = 1;
    return v;
  };
  return { lessons, bm25, cosOrder, vecFor };
}

describe("denseFamily with a fake embedder", () => {
  const snapshot = readSnapshot(snapFile);
  const model = "mxbai-embed-large";
  const byPrefix = (g, p) => g.retrievers.find((r) => r.name.startsWith(p));

  it("names and unique modes: dense, rrf, rerank; noprefix suffix", () => {
    const g = denseFamily({ model, embedder: fakeEmbedder() });
    expect(g.retrievers.map((r) => r.name)).toEqual([`dense:${model}`, `rrf:${model}`, `rerank:${model}`]);
    const keys = g.retrievers.map((r) => r.mode || r.kind);
    expect(new Set(keys).size).toBe(3);
    const np = denseFamily({ model, embedder: fakeEmbedder(), noprefix: true });
    expect(np.retrievers.map((r) => r.name)).toEqual([`dense:${model}:noprefix`, `rrf:${model}:noprefix`, `rerank:${model}:noprefix`]);
  });

  it("mxbai: the query is sent with its prefix and the docs raw; nomic: both prefixed; noprefix: neither", async () => {
    const q = "zephyr quartz cache";
    const docs = snapshot.lessons.filter((l) => !l.superseded_by).map((l) => l.text);
    const run1 = async (opts) => {
      const emb = fakeEmbedder();
      const g = denseFamily({ embedder: emb, ...opts });
      await searchWith(byPrefix(g, "dense:"), snapshot.lessons, q, 3, snapshot.snapshotAt);
      await g.close();
      return emb.texts();
    };
    const mx = await run1({ model });
    expect(mx).toContain("Represent this sentence for searching relevant passages: " + q);
    expect(mx).toContain(docs[0]);
    expect(mx).not.toContain(q);
    const nm = await run1({ model: "nomic-embed-text" });
    expect(nm).toContain("search_query: " + q);
    expect(nm).toContain("search_document: " + docs[0]);
    expect(nm).not.toContain(docs[0]);
    const np = await run1({ model, noprefix: true });
    expect(np).toContain(q);
    expect(np).not.toContain("Represent this sentence for searching relevant passages: " + q);
  });

  it("the dense retriever ranks the lexical match first", async () => {
    // bge-m3 has no query prefix, so the fake lexical embedder is not skewed by prefix words.
    const g = denseFamily({ model: "bge-m3", embedder: fakeEmbedder() });
    try {
      expect((await searchWith(byPrefix(g, "dense:"), snapshot.lessons, "zephyr quartz cache", 3, snapshot.snapshotAt))[0]).toBe("quartz-landing.md");
      expect((await searchWith(byPrefix(g, "rrf:"), snapshot.lessons, "zephyr quartz cache", 3, snapshot.snapshotAt))[0]).toBe("quartz-landing.md");
      expect((await searchWith(byPrefix(g, "rerank:"), snapshot.lessons, "zephyr quartz cache", 3, snapshot.snapshotAt))[0]).toBe("quartz-landing.md");
    } finally {
      await g.close();
    }
  });

  it("R12: rerank:<model> orders the fts5 candidates by cosine, not by bm25", async () => {
    const fixt = await reverseFixture();
    expect(fixt.bm25).toHaveLength(3);
    const g = denseFamily({ model: "bge-m3", embedder: async (texts) => texts.map(fixt.vecFor) }); // bge-m3: no prefixes
    try {
      const ranked = await searchWith(byPrefix(g, "rerank:"), fixt.lessons, "gizmo", 3);
      expect(ranked).toEqual(fixt.cosOrder);
      expect(ranked).not.toEqual(fixt.bm25);
    } finally {
      await g.close();
    }
  });

  it("vector cache: a warm run embeds nothing; a noprefix run re-embeds only the query (mxbai docs have no prefix)", async () => {
    const file = join(tmp("bench-vc-"), "mxbai.jsonl");
    const q = "zephyr quartz cache";
    const go = async (opts, cache) => {
      const emb = fakeEmbedder();
      const g = denseFamily({ model, embedder: emb, cache, ...opts });
      await searchWith(byPrefix(g, "dense:"), snapshot.lessons, q, 3, snapshot.snapshotAt);
      await g.close();
      return emb.texts();
    };
    const cold = await go({}, vectorCache(file));
    expect(cold.length).toBeGreaterThan(1);
    expect(await go({}, vectorCache(file))).toEqual([]);
    expect(await go({ noprefix: true }, vectorCache(file))).toEqual([q]);
  });

  it("determinism: two accuracy runs over the same registry are deep-equal", async () => {
    const queries = readJsonl(queriesFile);
    const once = async () => {
      const g = denseFamily({ model: "nomic-embed-text", embedder: fakeEmbedder() });
      try {
        return await runAccuracy({ snapshot, queries, k: 3, provider: null, registry: [fts5, grep, ftsVariant("porter"), ftsVariant("trigram"), ...g.retrievers] });
      } finally {
        await g.close();
      }
    };
    const a = await once();
    const b = await once();
    for (const r of ["fts5:porter", "fts5:trigram", "dense:nomic-embed-text", "rrf:nomic-embed-text", "rerank:nomic-embed-text"]) {
      const m = Object.values(a.modes).find((x) => x.retriever === r);
      expect(m, r).toBeTruthy();
      expect(typeof m.mrr).toBe("number");
    }
    expect(a).toEqual(b);
  });
});

describe("snapshot freezes the usefulness inputs", () => {
  it("usefulness --snapshot reads the frozen reports even after the sources change", async () => {
    const work = tmp("bench-freeze-");
    const store = join(work, "store");
    mkdirSync(store, { recursive: true });
    const m = openMemory(store);
    for (const id of ["l-one", "l-cobalt", "l-marble", "l-quartz"]) {
      addLesson(m, { id, text: `A lesson for the frozen snapshot, ${id}.`, kind: "project", citation: `${id}.md`, source: { agent: "t" } });
    }
    m.close();
    const srcReports = join(work, "src-reports");
    const srcLast = join(work, "src-last-report.json");
    cpSync(join(fx, "reports"), srcReports, { recursive: true });
    cpSync(join(fx, "last-report.json"), srcLast);
    const outDir = join(work, "bench");
    const out = join(outDir, "lessons.jsonl");

    const snap = await run(["snapshot", "--store", store, "--out", out, "--reports", srcReports, "--last-report", srcLast]);
    expect(snap.code).toBe(0);
    expect(readFileSync(join(outDir, "last-report.json"), "utf8")).toBe(readFileSync(join(fx, "last-report.json"), "utf8"));
    expect(existsSync(join(outDir, "reports", "card-a", "report.json"))).toBe(true);
    expect(existsSync(join(outDir, "reports", "card-b", "report.json"))).toBe(true);

    // change the live sources: drop a report, rewrite the last report with a new task
    rmSync(join(srcReports, "card-a"), { recursive: true, force: true });
    writeFileSync(srcLast, JSON.stringify({ levels: [{ tasks: [{ id: "x1", memoryUsed: ["l-one"] }, { id: "x2", memoryUsed: ["l-one"] }, { id: "x3", memoryUsed: ["l-one"] }] }] }));

    const r = await run(["usefulness", "--snapshot", out, "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.reports).toBe(3);
    expect(j.tasks).toBe(6);
    expect(j.tasksWithMemoryUsed).toBe(4);
    expect(j.unresolvedIds).toEqual(["l-ghost", "l-ghost2"]);
  });
});

// =================================================================================================================
// Stage 3: agent-memory frameworks over the JSON stdin/stdout protocol (fake adapter, no Python)
// =================================================================================================================

const fwDir = join(fx, "frameworks");
const fakePython = join(fwDir, "fake-python");
try {
  chmodSync(fakePython, 0o755);
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readPid(file) {
  for (let i = 0; i < 60; i++) {
    if (existsSync(file)) {
      const s = readFileSync(file, "utf8").trim();
      if (s) return Number(s);
    }
    await sleep(50);
  }
  throw new Error("the fake adapter never wrote its pid");
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function expectDead(pid) {
  for (let i = 0; i < 80; i++) {
    if (!alive(pid)) return;
    await sleep(50);
  }
  expect(alive(pid), "the adapter child is still running").toBe(false);
}
const fw = (opts = {}) => frameworkRetriever({ framework: "echo", variant: "verbatim", python: fakePython, dir: fwDir, ...opts });

describe("frameworkRetriever: shape and flags", () => {
  it("names, kind, mode; only :extract is nondeterministic and real-size-only", () => {
    const v = fw();
    expect(v.name).toBe("framework:echo:verbatim");
    expect(v.kind).toBe("framework");
    expect(v.mode || v.kind).toBe(v.name);
    for (const f of ["setup", "search", "teardown", "meta"]) expect(typeof v[f]).toBe("function");
    expect(v.deterministic).not.toBe(false);
    expect(v.realOnly).toBeFalsy();
    const x = fw({ variant: "extract" });
    expect(x.name).toBe("framework:echo:extract");
    expect(x.deterministic).toBe(false);
    expect(x.realOnly).toBe(true);
    expect(frameworkRetriever({ framework: "echo" }).name).toBe("framework:echo");
  });
});

describe("frameworkRetriever: protocol, key mapping, eligibility", () => {
  it("maps the adapter's keys back to citations, over only the live in-window lessons", async () => {
    const r = fw();
    expect(await searchWith(r, replay.lessons, "thirty", 8)).toEqual(["handshake-new-landing.md"]);
    expect(await searchWith(r, replay.lessons, "plaintext", 8)).toEqual([]); // the superseded lesson was never sent
    expect(await searchWith(r, replay.lessons, "heron dashboard", 8)).not.toContain("heron-landing.md"); // stale
    expect(await searchWith(r, replay.lessons, "obelisk relic", 8)).not.toContain("dusty-landing.md"); // out of window
    expect((await searchWith(r, replay.lessons, "mallard", 8))[0]).toBe("mallard-landing.md"); // confirmed recently
  });
  it("lessons that share a citation come back once", async () => {
    expect(await searchWith(fw(), replay.lessons, "xylophone yodel zither", 8)).toEqual(["shared-landing.md"]);
  });
  it("a key the bench never sent (the adapter's own id) is dropped, not passed through", async () => {
    const ranked = await searchWith(fw({ config: { leak: true } }), replay.lessons, "thirty", 8);
    expect(ranked).toEqual(["handshake-new-landing.md"]);
  });
  it("search honours k", async () => {
    const ranked = await searchWith(fw(), replay.lessons, "kestrel handshake timeout mallard xylophone yodel zither", 2);
    expect(ranked.length).toBeLessThanOrEqual(2);
  });
  it("meta carries the adapter's setupMs, storageBytes and llmCalls; the variant reaches the adapter", async () => {
    const meta = async (variant) => {
      const r = fw({ variant });
      const st = await r.setup(replay.lessons, { now: NOW });
      try {
        return r.meta(st);
      } finally {
        await r.teardown(st);
      }
    };
    const v = await meta("verbatim");
    expect(v.setupMs).toBe(4321);
    expect(v.storageBytes).toBeGreaterThan(0);
    expect(v.llmCalls).toBe(0);
    const x = await meta("extract");
    expect(x.llmCalls).toBeGreaterThan(0);
    expect(x.setupMs).toBe(4321);
  });
  it("teardown kills the adapter child", async () => {
    const pidFile = join(tmp("bench-fw-"), "pid");
    const r = fw({ config: { pidFile } });
    const st = await r.setup(replay.lessons, { now: NOW });
    const pid = await readPid(pidFile);
    expect(alive(pid)).toBe(true);
    await r.teardown(st);
    await expectDead(pid);
  });
  it("runAccuracy over the fixture: the framework mode is scored like any other", async () => {
    const snapshot = readSnapshot(snapFile);
    const res = await runAccuracy({ snapshot, queries: readJsonl(queriesFile), k: 3, registry: [fw()] });
    const m = res.modes["framework:echo:verbatim"];
    expect(m.n).toBe(6);
    expect(m.perQuery.find((q) => q.id === "g1").ranked[0]).toBe("marble-landing.md");
    expect(m.perQuery.find((q) => q.id === "a1").ranked).not.toContain("ancient-landing.md");
  });
});

describe("frameworkRetriever: failures are `not measured`, never a throw", () => {
  const snapshot = readSnapshot(snapFile);
  const queries = readJsonl(queriesFile);
  const measure = async (r) => (await runAccuracy({ snapshot, queries, k: 3, registry: [r] })).modes[r.name];

  it("a missing venv python: not measured (not installed: run bench-memory.mjs install-frameworks)", async () => {
    const m = await measure(fw({ python: join(tmp("bench-nopy-"), "py/bin/python") }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/not installed/);
    expect(m.reason).toMatch(/install-frameworks/);
  });
  it("a missing package inside the venv (adapter replies notInstalled) reports the same", async () => {
    const m = await measure(fw({ config: { notInstalled: true } }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/not installed/);
    expect(m.reason).toMatch(/install-frameworks/);
  });
  it("an adapter {ok:false, error} reports its own error text", async () => {
    const m = await measure(fw({ config: { fail: "boom: gizmo exploded" } }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/boom: gizmo exploded/);
  });
  it("a reply that is not JSON is `malformed`", async () => {
    const m = await measure(fw({ config: { garbage: "search" } }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/malformed/i);
  });
  it("JSON of the wrong shape is `malformed` too", async () => {
    const m = await measure(fw({ config: { shape: "search" } }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/malformed/i);
  });
  it("a setup that never replies times out and the child is killed", async () => {
    const pidFile = join(tmp("bench-fw-"), "pid");
    const m = await measure(fw({ timeoutMs: 600, config: { hang: "setup", pidFile } }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/timed out/i);
    await expectDead(await readPid(pidFile));
  });
  it("a search that never replies times out and the child is killed", async () => {
    const pidFile = join(tmp("bench-fw-"), "pid");
    const m = await measure(fw({ timeoutMs: 600, config: { hang: "search", pidFile } }));
    expect(m.status).toBe("not measured");
    expect(m.reason).toMatch(/timed out/i);
    await expectDead(await readPid(pidFile));
  });
});

describe("meta timings and LLM calls route to `timings`; :extract is nondeterministic (runAccuracy)", () => {
  const snapshot = readSnapshot(snapFile);
  const queries = readJsonl(queriesFile);
  const retriever = (name, meta, extra = {}) => ({
    name, kind: "keyword", mode: name,
    async setup() { return {}; },
    async search() { return ["marble-landing.md"]; },
    teardown() {},
    meta: () => meta,
    ...extra,
  });
  it("setupMs, ingestMs and llmCalls leave modes[mode].meta and land in result.timings[mode]", async () => {
    const timed = retriever("timed", { storageBytes: 7, dependency: "d", setupMs: 12, ingestMs: 34, llmCalls: 5 });
    const plain = retriever("plain", { storageBytes: 9 });
    const r = await runAccuracy({ snapshot, queries, k: 3, registry: [timed, plain] });
    expect(r.modes.timed.meta).toEqual({ storageBytes: 7, dependency: "d" });
    expect(r.modes.plain.meta).toEqual({ storageBytes: 9 });
    expect(r.timings).toEqual({ timed: { setupMs: 12, ingestMs: 34, llmCalls: 5 } });
  });
  it("a retriever flagged deterministic:false is marked so in its mode; others are not", async () => {
    const flagged = retriever("flagged", { storageBytes: 1 }, { deterministic: false });
    const plain = retriever("plain", { storageBytes: 1 });
    const r = await runAccuracy({ snapshot, queries, k: 3, registry: [flagged, plain] });
    expect(r.modes.flagged.deterministic).toBe(false);
    expect(r.modes.plain.deterministic).not.toBe(false);
  });
  it("a framework run: storage stays in meta, ingest time and LLM calls go to timings", async () => {
    const r = await runAccuracy({ snapshot, queries, k: 3, registry: [fw(), fw({ variant: "extract" })] });
    const v = r.modes["framework:echo:verbatim"];
    expect(v.meta.storageBytes).toBeGreaterThan(0);
    expect(JSON.stringify(r.modes)).not.toMatch(/setupMs|llmCalls|4321/);
    expect(r.timings["framework:echo:verbatim"]).toMatchObject({ setupMs: 4321, llmCalls: 0 });
    expect(r.timings["framework:echo:extract"].llmCalls).toBeGreaterThan(0);
    expect(r.modes["framework:echo:extract"].deterministic).toBe(false);
    expect(r.modes["framework:echo:verbatim"].deterministic).not.toBe(false);
  });
});

// A fake Ollama: version/tags (probe), /api/show (native dims), /api/embed (dense family) and /v1/embeddings
// (the shipped path through createProvider). Vectors are hashed bags of words at `dims`.
function vecN(text, n) {
  const v = new Array(n).fill(0);
  for (const m of String(text).toLowerCase().matchAll(/[a-z0-9]+/g)) {
    let h = 2166136261;
    for (const ch of m[0]) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % n] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
function fakeOllama({ dims = 24 } = {}) {
  const inputs = [];
  const v1 = [];
  const fn = vi.fn(async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === "/api/version") return json({ version: "0.9.0" });
    if (path === "/api/tags") return json({ models: [{ name: "bge-m3:latest", model: "bge-m3:latest" }] });
    if (path === "/api/show") return json({ model_info: { "bert.embedding_length": dims } });
    if (path === "/api/embed") {
      inputs.push(...body.input);
      return json({ embeddings: body.input.map((t) => vecN(t, dims)) });
    }
    if (path === "/v1/embeddings") {
      v1.push(body);
      inputs.push(...body.input);
      return json({ data: body.input.map((t, index) => ({ index, embedding: vecN(t, dims) })) });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  });
  fn.inputs = inputs;
  fn.v1 = v1;
  return fn;
}
const mainBase = (extra = []) => ["--snapshot", snapFile, "--queries", queriesFile, ...extra];
const isTimed = (x) => x && typeof x.p50 === "number";

describe("main: frameworks routing (fake adapter through the real flags)", () => {
  const fwArgs = ["--frameworks", "echo:verbatim,echo:extract", "--framework-python", fakePython, "--framework-dir", fwDir];
  const when = () => new Date("2031-05-17T12:00:00.000Z");

  it("accuracy --json: :extract goes under nondeterministic with the run date, timings under timings.retrievers", async () => {
    const r = await run(["accuracy", ...mainBase(["--k", "3", "--config", configDir(null), ...fwArgs, "--json"])], { now: when });
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.modes["framework:echo:verbatim"].n).toBe(6);
    expect(j.modes["framework:echo:verbatim"].perQuery.find((q) => q.id === "g1").ranked[0]).toBe("marble-landing.md");
    expect(j.modes["framework:echo:extract"]).toBeUndefined();
    expect(j.nondeterministic.date).toMatch(/^2031-05-17/);
    expect(typeof j.nondeterministic.modes["framework:echo:extract"].recallAtK).toBe("number");
    expect(JSON.stringify(j.modes)).not.toMatch(/setupMs|llmCalls|4321/);
    expect(j.timings.retrievers["framework:echo:verbatim"]).toMatchObject({ setupMs: 4321, llmCalls: 0 });
    expect(j.timings.retrievers["framework:echo:extract"].llmCalls).toBeGreaterThan(0);
  });

  it("a run with only deterministic retrievers has no nondeterministic section", async () => {
    const r = await run(["accuracy", ...mainBase(["--k", "3", "--config", configDir(null), "--frameworks", "echo:verbatim", "--framework-python", fakePython, "--framework-dir", fwDir, "--json"])], { now: when });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).nondeterministic).toBeUndefined();
  });

  it("all --json: deterministic section is stable across runs and holds no extract, timing or LLM-call field; extract is real-size-only", async () => {
    const argv = [
      "all", ...mainBase(["--k", "3", "--config", configDir(null), ...fwArgs, "--json",
        "--reports", join(fx, "reports"), "--last-report", join(fx, "last-report.json"),
        "--sizes", "real,25", "--iterations", "1", "--skip-cold-start", "--import-files", "2"]),
    ];
    const a = await run(argv, { now: when });
    const b = await run(argv, { now: when });
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const ja = JSON.parse(a.stdout);
    const jb = JSON.parse(b.stdout);
    expect(ja.deterministic).toEqual(jb.deterministic);
    expect(ja.deterministic.accuracy.modes["framework:echo:verbatim"].n).toBe(6);
    expect(ja.deterministic.accuracy.modes["framework:echo:extract"]).toBeUndefined();
    expect(JSON.stringify(ja.deterministic)).not.toMatch(/llmCalls|setupMs|4321/);
    expect(ja.nondeterministic.date).toMatch(/^2031-05-17/);
    expect(ja.nondeterministic.modes["framework:echo:extract"].n).toBe(6);
    expect(ja.timings.retrievers["framework:echo:extract"].llmCalls).toBeGreaterThan(0);
    // the adapter flag, not a name rule, decides what is timed at a synthetic size
    const [real, syn] = ja.timings.speed.sizes;
    expect(isTimed(real.recall["framework:echo:verbatim"])).toBe(true);
    expect(isTimed(real.recall["framework:echo:extract"])).toBe(true);
    expect(isTimed(syn.recall["framework:echo:verbatim"])).toBe(true);
    expect(syn.recall["framework:echo:extract"].status).toBe("not measured");
    expect(syn.recall["framework:echo:extract"].reason).toMatch(/real/i);
  });

  it("USAGE names the new command and flag", () => {
    expect(USAGE).toMatch(/install-frameworks/);
    expect(USAGE).toMatch(/--frameworks/);
  });
});

// =================================================================================================================
// Stage-2 review fixes
// =================================================================================================================

const lesson = (id, citation, text, created = "2020-01-05T00:00:00.000Z") => ({
  id, kind: "project", citation, text, created, confirmed: null, helpful: 0, harmful: 0, superseded_by: null, stale: null,
});
const cites = (n, i) => `n${i}-landing.md`;

// 24 lessons matching `gizmo`: BM25 order is L0..L23 (longer text, worse score); dense order is L23..L0
// (lesson i sits at angle (23-i) * (pi/2)/24 from the query [1,0]).
function depthFixture(n = 24) {
  const lessons = Array.from({ length: n }, (_, i) => lesson(`d-${i}`, cites(n, i), `Gizmo nu${i}${" filler".repeat(2 * i)}.`));
  const step = Math.PI / 2 / n;
  const embedder = async (texts) =>
    texts.map((t) => {
      const m = /nu(\d+)/.exec(t);
      if (!m) return [1, 0];
      const a = (n - 1 - Number(m[1])) * step;
      return [Math.cos(a), Math.sin(a)];
    });
  return { n, lessons, embedder };
}
async function bm25Order(lessons, query) {
  const probe = await fts5.setup(lessons, { now: NOW });
  try {
    return searchLessons(probe.m, query, { k: 50 }).map((l) => l.citation);
  } finally {
    await fts5.teardown(probe);
  }
}

// Three lessons matching `gizmo`: BM25 order alpha, beta, gamma; dense order gamma, alpha, beta.
function weightFixture() {
  const lessons = [
    lesson("w-a", "alpha-landing.md", "Gizmo alpha."),
    lesson("w-b", "beta-landing.md", `Gizmo beta${" filler".repeat(3)}.`),
    lesson("w-c", "gamma-landing.md", `Gizmo gamma${" filler".repeat(6)}.`),
  ];
  const axis = ["alpha", "beta", "gamma"];
  const embedder = async (texts) =>
    texts.map((t) => {
      if (/^\s*gizmo\s*$/i.test(t)) return [2, 1, 3]; // cosine: gamma .80, alpha .53, beta .27
      const v = [0, 0, 0];
      v[axis.findIndex((w) => t.toLowerCase().includes(w))] = 1;
      return v;
    });
  return { lessons, embedder };
}

describe("fusion pieces: wrrf and kwBoost (hand-computed)", () => {
  it("wrrf: score = sum of weight / (60 + rank); weights change the winner", () => {
    const r = wrrf([["a", "b"], ["b", "a"]], [1, 3]);
    const s = Object.fromEntries(r.map((x) => [x.key, x.score]));
    expect(s.a).toBeCloseTo(1 / 61 + 3 / 62, 10);
    expect(s.b).toBeCloseTo(1 / 62 + 3 / 61, 10);
    expect(r.map((x) => x.key)).toEqual(["b", "a"]);
    expect(wrrf([["a", "b"], ["b", "a"]], [3, 1]).map((x) => x.key)).toEqual(["a", "b"]);
  });
  it("wrrf with weights [1,1] is plain rrf; ties break by key; an item in one list scores that list only", () => {
    const lists = [["a", "b", "c"], ["b", "d", "a"]];
    expect(wrrf(lists, [1, 1]).map((x) => x.key)).toEqual(rrf(lists).map((x) => x.key));
    expect(wrrf([["y"], ["x"]], [1, 1]).map((r) => r.key)).toEqual(["x", "y"]);
    expect(wrrf([["a"], []], [2, 5])[0].score).toBeCloseTo(2 / 61, 10);
  });
  it("kwBoost: BM25 top-3 keys below dense rank 2 are promoted to ranks 2, 3 in BM25 order", () => {
    expect(kwBoost(["a", "b", "c", "d", "e", "f"], ["e", "c", "x"])).toEqual(["a", "e", "c", "b", "d", "f"]);
  });
  it("kwBoost: dense rank 1 never moves, a key already at rank 2 keeps its place ahead of later promotions", () => {
    expect(kwBoost(["a", "b", "c", "d"], ["b", "d", "x"])).toEqual(["a", "b", "d", "c"]);
    expect(kwBoost(["a", "b", "c"], ["a", "c", "y"])).toEqual(["a", "c", "b"]);
  });
  it("kwBoost: only BM25 ranks 1-3 count; an empty BM25 list changes nothing; the input is not mutated", () => {
    const dense = ["a", "b", "c", "d", "e"];
    expect(kwBoost(dense, ["x", "y", "z", "e"])).toEqual(dense);
    expect(kwBoost(dense, [])).toEqual(dense);
    kwBoost(dense, ["e"]);
    expect(dense).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("denseFamily fusion variants (fusion: true)", () => {
  const model = "bge-m3"; // no prefixes: the fixture embedders see the raw text
  const names = (g) => g.retrievers.map((r) => r.name);
  const by = (g, n) => g.retrievers.find((r) => r.name === n);

  it("names and unique modes; the default family stays at three", () => {
    const g = denseFamily({ model, embedder: fakeEmbedder(), fusion: true });
    expect(names(g)).toEqual([
      `dense:${model}`, `rrf:${model}`, `rerank:${model}`,
      `rrf:${model}:d10`, `rrf:${model}:d20`, `wrrf:${model}:w2`, `wrrf:${model}:w3`, `dense+kwboost:${model}`,
    ]);
    expect(new Set(g.retrievers.map((r) => r.mode || r.kind)).size).toBe(8);
    expect(names(denseFamily({ model, embedder: fakeEmbedder() }))).toHaveLength(3);
  });

  it("rrf depth: d10 fuses the top 10 of each list (20 lessons), d20 the top 20 (all 24), the default 50 (all 24)", async () => {
    const f = depthFixture();
    expect(await bm25Order(f.lessons, "gizmo")).toEqual(Array.from({ length: 24 }, (_, i) => cites(24, i))); // fixture precondition
    const g = denseFamily({ model, embedder: f.embedder, fusion: true });
    try {
      const d10 = await searchWith(by(g, `rrf:${model}:d10`), f.lessons, "gizmo", 24);
      const want10 = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 14 + i)].map((i) => cites(24, i));
      expect(d10).toHaveLength(20);
      expect(new Set(d10)).toEqual(new Set(want10));
      expect(await searchWith(by(g, `rrf:${model}:d20`), f.lessons, "gizmo", 24)).toHaveLength(24);
      expect(await searchWith(by(g, `rrf:${model}`), f.lessons, "gizmo", 24)).toHaveLength(24);
    } finally {
      await g.close();
    }
  });

  it("wrrf: the dense side carries the weight (X1 too: rrf is a fusion, not the dense order)", async () => {
    const f = weightFixture();
    expect(await bm25Order(f.lessons, "gizmo")).toEqual(["alpha-landing.md", "beta-landing.md", "gamma-landing.md"]); // precondition
    const g = denseFamily({ model, embedder: f.embedder, fusion: true });
    try {
      // dense order gamma, alpha, beta. rrf: alpha 1/61+1/62 > gamma 1/63+1/61 > beta 1/62+1/63.
      expect(await searchWith(by(g, `dense:${model}`), f.lessons, "gizmo", 3)).toEqual(["gamma-landing.md", "alpha-landing.md", "beta-landing.md"]);
      expect(await searchWith(by(g, `rrf:${model}`), f.lessons, "gizmo", 3)).toEqual(["alpha-landing.md", "gamma-landing.md", "beta-landing.md"]);
      // w2: gamma 1/63+2/61 = .048660 > alpha 1/61+2/62 = .048651; w3 likewise. Weight on the keyword side would put alpha first.
      expect(await searchWith(by(g, `wrrf:${model}:w2`), f.lessons, "gizmo", 3)).toEqual(["gamma-landing.md", "alpha-landing.md", "beta-landing.md"]);
      expect(await searchWith(by(g, `wrrf:${model}:w3`), f.lessons, "gizmo", 3)).toEqual(["gamma-landing.md", "alpha-landing.md", "beta-landing.md"]);
    } finally {
      await g.close();
    }
  });

  it("dense+kwboost: dense order with the BM25 top 3 lifted to ranks 2-4", async () => {
    const f = depthFixture();
    const g = denseFamily({ model, embedder: f.embedder, fusion: true });
    try {
      const dense = await searchWith(by(g, `dense:${model}`), f.lessons, "gizmo", 6);
      expect(dense).toEqual([23, 22, 21, 20, 19, 18].map((i) => cites(24, i)));
      const boosted = await searchWith(by(g, `dense+kwboost:${model}`), f.lessons, "gizmo", 6);
      expect(boosted).toEqual([23, 0, 1, 2, 22, 21].map((i) => cites(24, i)));
    } finally {
      await g.close();
    }
  });
});

describe("fts5:norecency and hybrid-shipped:<model>:norecency", () => {
  // A: BM25 rank 1, 29 days old (recency .862). B: BM25 rank 2, brand new (recency 1.0).
  const lessons = [
    lesson("r-a", "a-landing.md", "Gizmo alpha.", "2019-12-12T00:00:00.000Z"),
    lesson("r-b", "b-landing.md", "Gizmo beta with some filler words here.", "2020-01-10T00:00:00.000Z"),
  ];
  const pad = (v) => {
    const o = new Array(DIMS).fill(0);
    v.forEach((x, i) => (o[i] = x));
    return o;
  };
  const vectorFor = (t) => (/^\s*gizmo\s*$/i.test(t) || /alpha/i.test(t) ? pad([1, 0]) : pad([0.5, Math.sqrt(0.75)]));

  it("fts5:norecency is the BM25 order; the shipped fts5 row multiplies recency in and flips these two", async () => {
    expect(fts5NoRecency.name).toBe("fts5:norecency");
    expect(fts5NoRecency.kind).toBe("keyword");
    expect(await bm25Order(lessons, "gizmo")).toEqual(["a-landing.md", "b-landing.md"]);
    expect(await searchWith(fts5NoRecency, lessons, "gizmo", 8, "2020-01-10T00:00:00.000Z")).toEqual(["a-landing.md", "b-landing.md"]);
    expect(await searchWith(fts5, lessons, "gizmo", 8, "2020-01-10T00:00:00.000Z")).toEqual(["b-landing.md", "a-landing.md"]);
  });
  it("fts5:norecency keeps the live set and the window: no superseded, stale or out-of-window lesson", async () => {
    expect(await searchWith(fts5NoRecency, replay.lessons, "plaintext", 8)).not.toContain("handshake-old-landing.md");
    expect(await searchWith(fts5NoRecency, replay.lessons, "heron dashboard", 8)).not.toContain("heron-landing.md");
    expect(await searchWith(fts5NoRecency, replay.lessons, "obelisk relic", 8)).not.toContain("dusty-landing.md");
    expect((await searchWith(fts5NoRecency, replay.lessons, "mallard", 8))[0]).toBe("mallard-landing.md");
  });
  it("hybrid-shipped ranks by cosine x recency (A first); the norecency row is still the old RRF with recency 1 (A first), and RRF with recency would put B first", async () => {
    const now = "2020-01-10T00:00:00.000Z";
    const shipped = providerRetrievers(fakeProvider(vectorFor));
    const nr = hybridShippedNorecency(fakeProvider(vectorFor));
    try {
      expect(nr.retrievers).toHaveLength(1);
      const r = nr.retrievers[0];
      expect(r.name).toBe("hybrid-shipped:fake-embed:norecency");
      expect(r.kind).toBe("hybrid");
      // Shipped (recallLessons): cosine x recency. A: 1 x .862 = .862; B: .5 x 1 = .5 -> A first.
      // The old shipped RRF with recency would disagree: A 1/61+1/61 = .0328 x .862 = .0283 < B 1/62+1/62 = .0323 -> B first,
      // so restoring RRF in recallLessons fails the shipped assertion.
      // Norecency row (stage-3 RRF, recency 1): A .0328 > B .0323 -> A first.
      expect(await searchWith(shipped.retrievers.find((x) => x.name.startsWith("hybrid-shipped")), lessons, "gizmo", 8, now)).toEqual(["a-landing.md", "b-landing.md"]);
      expect(await searchWith(r, lessons, "gizmo", 8, now)).toEqual(["a-landing.md", "b-landing.md"]);
    } finally {
      await shipped.close();
      await nr.close();
    }
  });
  it("hybrid-shipped norecency keeps the live set and the window", async () => {
    const nr = hybridShippedNorecency(fakeProvider());
    try {
      const r = nr.retrievers[0];
      expect(await searchWith(r, replay.lessons, "plaintext", 8)).not.toContain("handshake-old-landing.md");
      expect(await searchWith(r, replay.lessons, "heron dashboard", 8)).not.toContain("heron-landing.md");
      expect(await searchWith(r, replay.lessons, "obelisk relic", 8)).not.toContain("dusty-landing.md");
    } finally {
      await nr.close();
    }
  });
});

describe("syntheticProvider and synthetic-vector recall timing through a fake provider", () => {
  const norm = (v) => Math.hypot(...v);
  it("deterministic by (seed, text), unit length at the model's dims, no inputType dependence", async () => {
    const p = syntheticProvider({ model: "m", dims: 24, seed: 7 });
    expect(p.model).toBe("m");
    expect(p.dims).toBe(24);
    expect(typeof p.name).toBe("string");
    const r = await p.embed(["alpha", "beta", "alpha"], { inputType: "document" });
    expect(r.ok).toBe(true);
    expect(r.vectors).toHaveLength(3);
    for (const v of r.vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v).toHaveLength(24);
      expect(norm(v)).toBeCloseTo(1, 4);
    }
    expect(Array.from(r.vectors[0])).toEqual(Array.from(r.vectors[2]));
    expect(Array.from(r.vectors[0])).not.toEqual(Array.from(r.vectors[1]));
    const q = await p.embed(["alpha"], { inputType: "query" });
    expect(Array.from(q.vectors[0])).toEqual(Array.from(r.vectors[0]));
    const again = await syntheticProvider({ model: "m", dims: 24, seed: 7 }).embed(["alpha"], { inputType: "document" });
    expect(Array.from(again.vectors[0])).toEqual(Array.from(r.vectors[0]));
    const other = await syntheticProvider({ model: "m", dims: 24, seed: 8 }).embed(["alpha"], { inputType: "document" });
    expect(Array.from(other.vectors[0])).not.toEqual(Array.from(r.vectors[0]));
  });
  it("the provider retrievers time dense, rrf-style and hybrid-shipped recall over synthetic lessons through it", async () => {
    const group = providerRetrievers(syntheticProvider({ model: "m", dims: 16, seed: 1 }));
    try {
      const out = await runSpeed({ sizes: ["30"], iterations: 2, budgetMs: 2000, importFiles: 1, skipColdStart: true, retrievers: group.retrievers });
      for (const r of group.retrievers) expect(isTimed(out.timings.sizes[0].recall[r.name]), r.name).toBe(true);
      expect(group.retrievers.some((r) => r.name.startsWith("hybrid-shipped"))).toBe(true);
    } finally {
      await group.close();
    }
  });
  it("main speed: dense, rrf and hybrid-shipped are timed at a synthetic size with no real embedding of synthetic text", async () => {
    const fetch = fakeOllama({ dims: 24 });
    const r = await run(["speed", ...mainBase(["--ollama", "--models", "bge-m3", "--sizes", "real,40", "--iterations", "1", "--skip-cold-start", "--import-files", "2", "--budget-ms", "5000", "--vectors-dir", tmp("bench-vec-"), "--json"])], { fetch });
    expect(r.code, r.stderr).toBe(0);
    const [real, syn] = JSON.parse(r.stdout).timings.sizes;
    for (const name of ["dense:bge-m3", "rrf:bge-m3", "hybrid-shipped:bge-m3", "fts5:norecency", "fts5:porter"]) {
      expect(isTimed(real.recall[name]), `real ${name}`).toBe(true);
      expect(isTimed(syn.recall[name]), `40 ${name}`).toBe(true);
    }
    const known = [...readSnapshot(snapFile).lessons.map((l) => l.text), ...readJsonl(queriesFile).map((q) => q.query)];
    const stray = fetch.inputs.filter((s) => !known.some((t) => s.endsWith(t)));
    expect(stray, "synthetic texts were sent to the embedder").toEqual([]);
  });
});

describe("main --ollama: registry, hybrid-shipped dims (X5)", () => {
  it("hybrid-shipped uses the model's own dims (24 here), and the new variants are all measured", async () => {
    const fetch = fakeOllama({ dims: 24 });
    const r = await run(["accuracy", ...mainBase(["--ollama", "--models", "bge-m3", "--k", "3", "--vectors-dir", tmp("bench-vec-"), "--json"])], { fetch });
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    for (const name of [
      "dense:bge-m3", "rrf:bge-m3", "rerank:bge-m3", "rrf:bge-m3:d10", "rrf:bge-m3:d20", "wrrf:bge-m3:w2", "wrrf:bge-m3:w3",
      "dense+kwboost:bge-m3", "hybrid-shipped:bge-m3", "hybrid-shipped:bge-m3:norecency", "fts5:norecency",
    ]) {
      expect(j.modes[name], name).toBeTruthy();
      expect(j.modes[name].status, `${name}: ${j.modes[name].reason}`).toBeUndefined();
      expect(typeof j.modes[name].recallAtK, name).toBe("number");
    }
    expect(fetch.v1.length).toBeGreaterThan(0);
    for (const body of fetch.v1) expect(body.dimensions).toBe(24);
  });
});

describe("per-call state: accuracy and speed passes do not share one", () => {
  const snapshot = readSnapshot(snapFile);
  const queries = readJsonl(queriesFile);
  const speedOpts = { sizes: ["real"], iterations: 1, budgetMs: 1000, importFiles: 1, skipColdStart: true, real: snapshot, queries: queries.map((q) => q.query) };

  it("denseFamily: accuracy then speed over the same lessons embeds the documents twice", async () => {
    const emb = fakeEmbedder();
    const g = denseFamily({ model: "bge-m3", embedder: emb });
    const dense = g.retrievers.filter((r) => r.name.startsWith("dense:"));
    const docs = new Set(snapshot.lessons.map((l) => l.text));
    const count = () => emb.texts().filter((t) => docs.has(t)).length;
    try {
      await runAccuracy({ snapshot, queries, k: 3, registry: dense });
      const afterAccuracy = count();
      expect(afterAccuracy).toBeGreaterThan(0);
      await runSpeed({ ...speedOpts, retrievers: dense });
      expect(count()).toBe(2 * afterAccuracy);
    } finally {
      await g.close();
    }
  });
  it("providerRetrievers: the same, counted at the provider", async () => {
    let docEmbeds = 0;
    const base = fakeProvider();
    const provider = { ...base, async embed(texts, opts = {}) { if (opts.inputType === "document") docEmbeds += texts.length; return base.embed(texts, opts); } };
    const group = providerRetrievers(provider);
    const dense = group.retrievers.filter((r) => r.kind === "dense");
    try {
      await runAccuracy({ snapshot, queries, k: 3, registry: dense });
      const afterAccuracy = docEmbeds;
      expect(afterAccuracy).toBeGreaterThan(0);
      await runSpeed({ ...speedOpts, retrievers: dense });
      expect(docEmbeds).toBe(2 * afterAccuracy);
    } finally {
      await group.close();
    }
  });
  it("two setups of one lessons array are different states, and tearing one down leaves the other searchable", async () => {
    const g = denseFamily({ model: "bge-m3", embedder: fakeEmbedder() });
    const pg = providerRetrievers(fakeProvider());
    try {
      for (const r of [...g.retrievers, ...pg.retrievers.filter((x) => !x.name.startsWith("hybrid"))]) {
        const a = await r.setup(snapshot.lessons, { now: snapshot.snapshotAt });
        const b = await r.setup(snapshot.lessons, { now: snapshot.snapshotAt });
        expect(a, r.name).not.toBe(b);
        await r.teardown(a);
        expect(await r.search(b, "zephyr quartz cache", 3), r.name).toContain("quartz-landing.md");
        await r.teardown(b);
      }
    } finally {
      await g.close();
      await pg.close();
    }
  });
});

describe("pins for surviving mutations (X1-X3, X5-X7; X1 and X5 are above)", () => {
  const snapshot = readSnapshot(snapFile);

  it("X2: the bruteforce store returns the nearest first", async () => {
    const bf = STORE_ADAPTERS.find((a) => a.name === "bruteforce");
    const flat = Float32Array.from([1, 0, 0, 1, 0.6, 0.8]); // scores against [1,0]: 1, 0, .6
    const h = await bf.build(null, flat, 3, 2);
    expect(await bf.query(h, Float32Array.from([1, 0]), 3)).toEqual([0, 2, 1]);
    expect(await bf.query(h, Float32Array.from([1, 0]), 2)).toEqual([0, 2]);
  });
  it("lancedb-ivfpq:refine10 is in the store matrix as an ANN adapter of the lancedb package", () => {
    const a = STORE_ADAPTERS.find((x) => x.name === "lancedb-ivfpq:refine10");
    expect(a).toBeTruthy();
    expect(a.ann).toBe(true);
    expect(a.pkg).toBe("@lancedb/lancedb");
    expect(STORE_ADAPTERS.find((x) => x.name === "lancedb-ivfpq")).toBeTruthy();
  });
  it("X3: hybrid-shipped refuses to fall back to keyword silently when the query embedding fails", async () => {
    const base = fakeProvider();
    const provider = { ...base, async embed(texts, opts = {}) { return opts.inputType === "query" ? { ok: false, reason: "embedder down" } : base.embed(texts, opts); } };
    const group = providerRetrievers(provider);
    try {
      const hybrid = group.retrievers.find((r) => r.name.startsWith("hybrid-shipped"));
      const state = await hybrid.setup(snapshot.lessons, { now: snapshot.snapshotAt });
      await expect(hybrid.search(state, "zephyr quartz cache", 3)).rejects.toThrow(/fell back to keyword/);
      await hybrid.teardown(state);
      const res = await runAccuracy({ snapshot, queries: readJsonl(queriesFile), k: 3, registry: [hybrid] });
      expect(res.modes[hybrid.mode || hybrid.kind].status).toBe("not measured");
      expect(res.modes[hybrid.mode || hybrid.kind].reason).toMatch(/embedder down/);
    } finally {
      await group.close();
    }
  });
  it("X6: the BM25 side of rrf and rerank obeys the recency window (an out-of-window lesson never appears)", async () => {
    const g = denseFamily({ model: "bge-m3", embedder: fakeEmbedder() });
    try {
      for (const r of g.retrievers.filter((x) => x.name.startsWith("rrf:") || x.name.startsWith("rerank:"))) {
        expect(await searchWith(r, replay.lessons, "obelisk relic", 8), r.name).not.toContain("dusty-landing.md");
        expect(await searchWith(r, replay.lessons, "plaintext", 8), r.name).not.toContain("handshake-old-landing.md");
        expect(await searchWith(r, replay.lessons, "heron dashboard", 8), r.name).not.toContain("heron-landing.md");
      }
    } finally {
      await g.close();
    }
  });
  it("X6: out-of-window lessons do not occupy BM25 ranks in rrf (three of them lead BM25; they must not shift the fused order)", async () => {
    const old = "2019-05-01T00:00:00.000Z";
    const lessons = [
      lesson("x-g0", "g0-landing.md", "Gizmo ghost.", old),
      lesson("x-g1", "g1-landing.md", "Gizmo ghost one.", old),
      lesson("x-g2", "g2-landing.md", "Gizmo ghost two here.", old),
      lesson("x-a", "a-landing.md", `Gizmo apple${" filler".repeat(4)}.`),
      lesson("x-b", "b-landing.md", `Gizmo berry${" filler".repeat(8)}.`),
      lesson("x-c", "c-landing.md", `Gizmo cherry${" filler".repeat(12)}.`),
      lesson("x-d", "d-landing.md", `Gizmo damson${" filler".repeat(16)}.`),
    ];
    // BM25 over the eligible four: a, b, c, d (the ghosts, shortest, would be ranks 1-3). Dense: b, c, d, a.
    // rrf: b 1/62+1/61 > a 1/61+1/63 > c 1/63+1/62 > d 1/64+1/63; with the ghosts counted a drops below c.
    const word = ["apple", "berry", "cherry", "damson"];
    const weight = [1, 4, 3, 2];
    const embedder = async (texts) =>
      texts.map((t) => {
        if (/^\s*gizmo\s*$/i.test(t)) return weight;
        const v = [0, 0, 0, 0];
        const i = word.findIndex((w) => t.toLowerCase().includes(w));
        if (i >= 0) v[i] = 1;
        return v;
      });
    const g = denseFamily({ model: "bge-m3", embedder });
    try {
      const rrfR = g.retrievers.find((x) => x.name === "rrf:bge-m3");
      expect(await searchWith(rrfR, lessons, "gizmo", 4)).toEqual(["b-landing.md", "a-landing.md", "c-landing.md", "d-landing.md"]);
    } finally {
      await g.close();
    }
  });
  it("X7: duplicate texts are sent once and every slot is filled", async () => {
    const calls = [];
    const embedder = async (texts) => {
      calls.push([...texts]);
      return texts.map((t) => [t.length, 1]);
    };
    const out = await embedCached(["aa", "bbb", "aa"], "", { model: "m", embedder });
    expect(calls).toEqual([["aa", "bbb"]]);
    expect(out.map((v) => Array.from(v))).toEqual([[2, 1], [3, 1], [2, 1]]);
    for (const v of out) expect(v).toBeInstanceOf(Float32Array);
  });
});

// =================================================================================================================
// Final-review gaps. Contract additions: denseFamily({ ..., recency: true }) appends `dense:<m>:recency` AFTER every
// other retriever of the family (after the fusion variants when fusion is also on): cosine x (0.5 + 0.5 * exp(-age/90)),
// age in days from (confirmed || created) to the setup's `now`, the recallLessons formula; sorted by that score desc,
// ties by key asc; same live set and window as dense. A framework `config` option (`prefix: true` among them) goes to
// the adapter inside setup's config untouched. A framework named with no variant, or any variant but `verbatim`, is
// nondeterministic (deterministic === false).
// =================================================================================================================

describe("review gap 1: the query vector cache is per setup, not per factory", () => {
  const snapshot = readSnapshot(snapFile);
  it("two setups from one factory each embed the query (dense, hybrid-shipped, rerank, hybrid-shipped norecency)", async () => {
    let queryEmbeds = 0;
    const base = fakeProvider();
    const provider = { ...base, async embed(texts, opts = {}) { if (opts.inputType === "query") queryEmbeds += texts.length; return base.embed(texts, opts); } };
    const groups = [providerRetrievers(provider), hybridShippedNorecency(provider)];
    try {
      for (const r of groups.flatMap((g) => g.retrievers)) {
        queryEmbeds = 0;
        for (let pass = 0; pass < 2; pass++) {
          const st = await r.setup(snapshot.lessons, { now: snapshot.snapshotAt });
          await r.search(st, "zephyr quartz cache", 3);
          await r.teardown(st);
        }
        expect(queryEmbeds, r.name).toBe(2);
      }
    } finally {
      for (const g of groups) await g.close();
    }
  });
});

describe("review gap 2: only :verbatim framework variants are deterministic", () => {
  it("graphiti with no variant is nondeterministic; mem0:verbatim is not flagged; mem0:extract is", () => {
    expect(frameworkRetriever({ framework: "graphiti" }).deterministic).toBe(false);
    expect(frameworkRetriever({ framework: "graphiti", variant: "verbatim" }).deterministic).not.toBe(false);
    expect(frameworkRetriever({ framework: "mem0", variant: "verbatim" }).deterministic).not.toBe(false);
    expect(frameworkRetriever({ framework: "mem0", variant: "extract" }).deterministic).toBe(false);
  });
});

describe("review gap 3: hybrid-shipped norecency pins the fusion", () => {
  // BM25 order a, b, c, d, e (longer text, worse score). Vector (dot) order b, c, d, e, a.
  // Fused 1/(60+rank) per side: b .0325, c .0319... -> b, c, a, d, e.
  //   BM25 side dropped -> the vector order b, c, d, e, a
  //   vector side dropped -> the BM25 order a, b, c, d, e
  //   vector depth cut to 1 -> only b gets a vector term: b, a, c, d, e
  const names = ["apple", "berry", "cherry", "damson", "elder"];
  const lessons = names.map((w, i) => lesson(`h-${w}`, `${w}-landing.md`, `Gizmo ${w}${" filler".repeat(4 * i)}.`));
  const weight = [1, 5, 4, 3, 2]; // dot with the one-hot doc vectors: berry 5, cherry 4, damson 3, elder 2, apple 1
  const vectorFor = (t) => {
    const v = new Array(DIMS).fill(0);
    if (/^\s*gizmo\s*$/i.test(t)) weight.forEach((x, i) => (v[i] = x));
    else v[names.findIndex((w) => t.toLowerCase().includes(w))] = 1;
    return v;
  };
  it("the fused order differs from BM25 alone, vector alone and a vector depth of 1", async () => {
    expect(await bm25Order(lessons, "gizmo")).toEqual(names.map((w) => `${w}-landing.md`)); // precondition
    const nr = hybridShippedNorecency(fakeProvider(vectorFor));
    try {
      expect(await searchWith(nr.retrievers[0], lessons, "gizmo", 5)).toEqual(["berry", "cherry", "apple", "damson", "elder"].map((w) => `${w}-landing.md`));
    } finally {
      await nr.close();
    }
  });
});

describe("review gap 4: dense:<model>:recency", () => {
  // Query [1,0]. cosine: A 1.00 (29 days old), B .90 (new), C .80 (new), D .85 (created 2019-03-01, confirmed 1 day ago).
  // recency 0.5 + 0.5 e^(-age/90): A .8622, B 1, C 1, D .9945.
  // scores: B .9000, A .8622, D .8453, C .8000 -> B, A, D, C. Plain dense is A, B, D, C. Using `created` for D (age 315 days,
  // recency .515) would put D last.
  const mk = (id, w, created, confirmed = null) => ({ ...lesson(id, `${w}-landing.md`, `Gizmo ${w}.`, created), confirmed });
  const lessons = [
    mk("t-a", "apple", "2019-12-12T00:00:00.000Z"),
    mk("t-b", "berry", "2020-01-10T00:00:00.000Z"),
    mk("t-c", "cherry", "2020-01-10T00:00:00.000Z"),
    mk("t-d", "damson", "2019-03-01T00:00:00.000Z", "2020-01-09T00:00:00.000Z"),
  ];
  const cos = { apple: 1, berry: 0.9, cherry: 0.8, damson: 0.85 };
  const embedder = async (texts) =>
    texts.map((t) => {
      const w = Object.keys(cos).find((x) => t.toLowerCase().includes(x));
      return w ? [cos[w], Math.sqrt(1 - cos[w] ** 2)] : [1, 0];
    });
  it("is named dense:<m>:recency, last in the family, with its own mode", () => {
    const g = denseFamily({ model: "bge-m3", embedder, recency: true });
    expect(g.retrievers.map((r) => r.name)).toEqual(["dense:bge-m3", "rrf:bge-m3", "rerank:bge-m3", "dense:bge-m3:recency"]);
    expect(new Set(g.retrievers.map((r) => r.mode || r.kind)).size).toBe(4);
    const both = denseFamily({ model: "bge-m3", embedder, recency: true, fusion: true });
    expect(both.retrievers[both.retrievers.length - 1].name).toBe("dense:bge-m3:recency");
  });
  it("orders by cosine times the shipped recency weight, age from confirmed || created at now", async () => {
    const g = denseFamily({ model: "bge-m3", embedder, recency: true });
    try {
      const find = (n) => g.retrievers.find((r) => r.name === n);
      expect(await searchWith(find("dense:bge-m3"), lessons, "gizmo", 8)).toEqual(["apple", "berry", "damson", "cherry"].map((w) => `${w}-landing.md`));
      expect(await searchWith(find("dense:bge-m3:recency"), lessons, "gizmo", 8)).toEqual(["berry", "apple", "damson", "cherry"].map((w) => `${w}-landing.md`));
    } finally {
      await g.close();
    }
  });
  it("keeps the live set and the window", async () => {
    const g = denseFamily({ model: "bge-m3", embedder: fakeEmbedder(), recency: true });
    try {
      const r = g.retrievers.find((x) => x.name === "dense:bge-m3:recency");
      expect(await searchWith(r, replay.lessons, "plaintext", 8)).not.toContain("handshake-old-landing.md");
      expect(await searchWith(r, replay.lessons, "heron dashboard", 8)).not.toContain("heron-landing.md");
      expect(await searchWith(r, replay.lessons, "obelisk relic", 8)).not.toContain("dusty-landing.md");
    } finally {
      await g.close();
    }
  });
});

describe("review gap 5: framework config options reach the adapter in setup's config", () => {
  const received = async (config) => {
    const configFile = join(tmp("bench-fwcfg-"), "config.json");
    const r = fw({ variant: "verbatim", config: { configFile, ...config } });
    const st = await r.setup(replay.lessons, { now: NOW });
    await r.teardown(st);
    return JSON.parse(readFileSync(configFile, "utf8"));
  };
  it("prefix: true arrives as prefix: true next to the variant", async () => {
    const c = await received({ prefix: true });
    expect(c.prefix).toBe(true);
    expect(c.variant).toBe("verbatim");
  });
  it("without the option the adapter is not told to prefix", async () => {
    expect((await received({})).prefix).toBeFalsy();
  });
});
