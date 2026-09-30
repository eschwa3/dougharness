import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  USAGE,
  parseArgs,
  computeLessonId,
  keyToIdMap,
  expectedIdsFor,
  entityTokens,
  sharesEntity,
  modeStats,
  renderTable,
  main,
} from "../measure-recall.mjs";

// measure-recall.mjs (card memory-measure #1): recall@k/precision@k/MRR of memory.mjs recall against a golden
// set, keyword-only reported as the floor next to hybrid, and a lexical-leakage check so a hit that merely
// shares an entity name with the query is never counted as a semantic win.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const lessonsFile = join(root, "evals/memory/lessons.jsonl");
const goldenFile = join(root, "evals/memory/golden.jsonl");
const fixtureDir = join(root, "evals/fixtures/ts-basic");

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function run(argv) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

describe("parseArgs", () => {
  it("defaults to the repository's own lessons and golden files with k=8", () => {
    const { opts } = parseArgs([]);
    expect(opts.lessons).toBe(lessonsFile);
    expect(opts.golden).toBe(goldenFile);
    expect(opts.k).toBe(8);
    expect(opts.json).toBe(false);
    expect(opts.store).toBeNull();
  });
  it("rejects a non-integer or non-positive --k, and an unknown flag", () => {
    expect(parseArgs(["--k", "0"]).error).toMatch(/--k must be an integer/);
    expect(parseArgs(["--k", "abc"]).error).toMatch(/--k must be an integer/);
    expect(parseArgs(["--nope"]).error).toBe("unknown argument: --nope");
  });
  it("takes --lessons, --golden, --store, --config, and --json", () => {
    const { opts } = parseArgs(["--lessons", "a.jsonl", "--golden", "b.jsonl", "--store", "/tmp/x", "--config", "/tmp/y", "--k", "3", "--json"]);
    expect(opts).toEqual({ lessons: "a.jsonl", golden: "b.jsonl", store: "/tmp/x", config: "/tmp/y", k: 3, json: true });
  });
});

describe("computeLessonId", () => {
  it("matches the id addLesson actually computes for the same kind, citation, and text", async () => {
    const { openMemory, addLesson } = await import("../../plugins/doug-flow/lib/memory.mjs");
    const dir = mkdtempSync(join(tmpdir(), "doug-measure-recall-id-"));
    const m = openMemory(dir);
    try {
      const row = addLesson(m, { text: "a test lesson", kind: "project", source: { agent: "test" }, citation: "a.ts:1" });
      expect(row.id).toBe(computeLessonId({ kind: "project", citation: "a.ts:1", text: "a test lesson" }));
    } finally {
      m.close();
    }
  });
});

describe("keyToIdMap / expectedIdsFor", () => {
  const lessons = [{ key: "k1", kind: "project", text: "t1", citation: null }, { key: "k2", kind: "pitfall", text: "t2", citation: "a.ts:1" }];
  it("maps each key to the id addLesson would compute for it", () => {
    const map = keyToIdMap(lessons);
    expect(map.get("k1")).toBe(computeLessonId(lessons[0]));
    expect(map.get("k2")).toBe(computeLessonId(lessons[1]));
  });
  it("resolves a golden entry's expected keys through the map, and takes an unknown key as a literal id", () => {
    const map = keyToIdMap(lessons);
    expect(expectedIdsFor({ expected: ["k1", "k2"] }, map)).toEqual([map.get("k1"), map.get("k2")]);
    expect(expectedIdsFor({ expected: ["not-a-key-abc123"] }, map)).toEqual(["not-a-key-abc123"]);
    expect(expectedIdsFor({}, map)).toEqual([]);
  });
});

// The lexical-leakage rule, stated in the brief: an entity token is any backticked span, or a whitespace token
// containing "/", ".", "_", "-", a digit, or a capital letter after its first character; trailing punctuation is
// stripped first; comparison is case-insensitive.
describe("entityTokens", () => {
  it("flags a backticked span verbatim, regardless of its own shape", () => {
    expect(entityTokens("what does `slugify` do")).toEqual(new Set(["slugify"]));
  });
  it("flags a path, a dotted or underscored or hyphenated word, a digit, and camelCase, but not a plain word", () => {
    expect(entityTokens("see src/duration.ts near line 17 for parseDuration and a_b and x-y and hello")).toEqual(
      new Set(["src/duration.ts", "17", "parseduration", "a_b", "x-y"])
    );
  });
  it("strips trailing punctuation before testing a token's shape", () => {
    expect(entityTokens("what about duration.ts, or strings.ts?")).toEqual(new Set(["duration.ts", "strings.ts"]));
  });
  it("finds no entity tokens in an ordinary-English paraphrase", () => {
    expect(entityTokens("malformed input is rejected before any unit math ever runs")).toEqual(new Set());
  });
  // MINOR 2: a possessive ('s or ’s) on an entity-shaped word must be stripped too, or the token never matches a
  // lesson that only ever writes the bare filename, understating lexical hits in favor of semantic ones.
  it("strips a trailing possessive so the entity still matches the bare word", () => {
    expect(entityTokens("what does strings.ts's dash collapse do")).toEqual(new Set(["strings.ts"]));
    expect(entityTokens("what does strings.ts’s dash collapse do")).toEqual(new Set(["strings.ts"]));
    expect(sharesEntity(entityTokens("what does strings.ts's dash collapse do"), "slugify's dash-collapse regex lives in strings.ts, run after lowercasing")).toBe(true);
  });
});

describe("sharesEntity and modeStats' lexical/semantic split", () => {
  it("counts a hit as lexical when an entity token of the query is a substring of the hit's text, not semantic", () => {
    const tokens = entityTokens("why does `parseDuration` compute the h case wrong");
    expect(sharesEntity(tokens, "parseDuration's case for the 'h' unit multiplies by 60_000")).toBe(true);
    expect(sharesEntity(tokens, "an unrelated lesson about something else entirely")).toBe(false);
  });
  it("splits expected hits into lexical and semantic, and semanticWins are the semantic ones keyword-only missed", () => {
    const kwPerQuery = [{ query: "why does `parseDuration` compute the h case wrong", expectedIds: ["L1", "L2"], hits: [{ id: "L1", text: "parseDuration's h case is wrong" }] }];
    const hyPerQuery = [
      {
        query: "why does `parseDuration` compute the h case wrong",
        expectedIds: ["L1", "L2"],
        hits: [
          { id: "L1", text: "parseDuration's h case is wrong" },
          { id: "L2", text: "an hour is not the same length as a minute" },
        ],
      },
    ];
    const kwStats = modeStats(kwPerQuery, 8);
    expect(kwStats).toMatchObject({ hits: 1, lexical: 1, semantic: 0 });
    expect(kwStats.semanticWins).toBeUndefined();
    const hyStats = modeStats(hyPerQuery, 8, kwPerQuery);
    expect(hyStats).toMatchObject({ hits: 2, lexical: 1, semantic: 1, semanticWins: 1 });
  });
  it("never counts a lexical hit as a semantic win, even when keyword-only missed it too", () => {
    // MUTATION PROOF (rule 7): flipping the `sharesEntity` check inside modeStats so every true hit is treated
    // as semantic makes this assertion fail (lexical becomes 0, semanticWins becomes 1) — confirmed by hand,
    // then reverted; see the task's final report for which assertion failed.
    const kwPerQuery = [{ query: "why does `parseDuration` compute the h case wrong", expectedIds: ["L1"], hits: [] }];
    const hyPerQuery = [{ query: "why does `parseDuration` compute the h case wrong", expectedIds: ["L1"], hits: [{ id: "L1", text: "parseDuration's h case is wrong" }] }];
    const hyStats = modeStats(hyPerQuery, 8, kwPerQuery);
    expect(hyStats).toMatchObject({ hits: 1, lexical: 1, semantic: 0, semanticWins: 0 });
  });
  it("computes recall@k, precision@k, and MRR over more than one query", () => {
    const perQuery = [
      { query: "q1", expectedIds: ["A", "B"], hits: [{ id: "A", text: "" }, { id: "X", text: "" }] }, // recall 1/2, first hit at rank 1
      { query: "q2", expectedIds: ["C"], hits: [{ id: "X", text: "" }, { id: "C", text: "" }] }, // recall 1, first hit at rank 2
    ];
    const stats = modeStats(perQuery, 2);
    expect(stats.recallAtK).toBeCloseTo((0.5 + 1) / 2, 10);
    expect(stats.precisionAtK).toBeCloseTo((0.5 + 0.5) / 2, 10);
    expect(stats.mrr).toBeCloseTo((1 + 0.5) / 2, 10);
    expect(stats.hits).toBe(2);
  });
  // Per .doug/.state/research/measure-recall-own-rewrite.md: a query with zero expected items has nothing to
  // score for recall, so it is excluded from the recall@k mean (0/0), but it still counts as a 0 in the
  // precision@k and MRR means — it is a real query the run scored, not a query that never happened.
  it("counts a query with no expected items as 0 in the precision and MRR means, but excludes it from the recall mean", () => {
    const perQuery = [
      { query: "q1", expectedIds: ["A"], hits: [{ id: "A", text: "" }, { id: "X", text: "" }] }, // relevant hit at rank 1, k=2
      { query: "q2", expectedIds: [], hits: [{ id: "X", text: "" }] }, // no relevant item exists for this query
    ];
    const stats = modeStats(perQuery, 2);
    expect(stats.precisionAtK).toBeCloseTo(0.25, 10); // (0.5 + 0) / 2
    expect(stats.mrr).toBeCloseTo(0.5, 10); // (1 + 0) / 2
    expect(stats.recallAtK).toBeCloseTo(1, 10); // only q1 counted: 1 / 1
  });
});

describe("renderTable", () => {
  it("prints a table row for keyword-only and, when hybrid ran, one for it too", () => {
    const summary = { k: 8, queries: 2, provider: "voyage", modes: { "keyword-only": modeStats([], 8), hybrid: modeStats([], 8, []) } };
    const text = renderTable(summary);
    expect(text).toContain("k=8  queries=2  provider=voyage");
    expect(text).toContain("| keyword-only |");
    expect(text).toContain("| hybrid |");
  });
  it("prints the hybrid row as not measured, with the reason, when there is no provider result", () => {
    const summary = { k: 8, queries: 2, provider: null, modes: { "keyword-only": modeStats([], 8), hybrid: null } };
    const text = renderTable(summary, "memory.embeddings not configured");
    expect(text).toContain("| hybrid | not measured (memory.embeddings not configured)");
  });
});

describe("main()", () => {
  it("measures the repository's real lessons.jsonl and golden.jsonl keyword-only, with no provider configured, and exits 0", async () => {
    const emptyConfigDir = mkdtempSync(join(tmpdir(), "doug-measure-recall-cfg-"));
    const { code, stdout } = await run(["--config", emptyConfigDir, "--json"]);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.k).toBe(8);
    expect(summary.queries).toBeGreaterThanOrEqual(12);
    expect(summary.provider).toBeNull();
    expect(summary.modes.hybrid).toBeNull();
    // Pinned to the real numbers this run produced (also the ones recorded in evals/README.md): a regression in
    // recall, in the entity/paraphrase split, or in the golden set itself changes this test, not just the doc.
    const kw = summary.modes["keyword-only"];
    expect(kw).toEqual({ recallAtK: 1, precisionAtK: 0.125, mrr: 0.9642857142857143, hits: 14, lexical: 7, semantic: 7 });
  });
  it("exits 2 with usage on a bad --k, and 1 on an unreadable lessons or golden file", async () => {
    const bad = await run(["--k", "0"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain(USAGE);
    const noLessons = await run(["--lessons", join(root, "evals/memory/nope.jsonl")]);
    expect(noLessons.code).toBe(1);
    expect(noLessons.stderr).toContain("cannot read");
    const noGolden = await run(["--golden", join(root, "evals/memory/nope.jsonl")]);
    expect(noGolden.code).toBe(1);
    expect(noGolden.stderr).toContain("cannot read");
  });
  // MINOR 1: a typo'd --store must never silently create an empty store and print plausible zeros.
  it("refuses a --store directory with no memory store yet, naming the db path, and leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-measure-recall-nostore-"));
    const { memoryPath } = await import("../../plugins/doug-flow/lib/memory.mjs");
    const { code, stderr } = await run(["--store", dir]);
    expect(code).toBe(1);
    expect(stderr).toContain(`no memory store at ${memoryPath(dir)}`);
    expect(existsSync(memoryPath(dir))).toBe(false);
  });

  // A golden line's `files` field must reach recallLessons' own `files` option (plugins/doug-flow/lib/memory.mjs,
  // the x1.5 scope boost), or a golden query that names files never benefits from it. Fixture: two lessons whose
  // text both match the query, but only one's scope matches the golden line's `files`; without the boost the
  // *other* lesson (shorter, better BM25 match) ranks first at k=1, so the boost is the only thing that can put
  // the expected lesson on top. Confirmed by hand against a forwarding fix: recall@1 is 0 without it, 1 with it.
  it("passes a golden query's `files` through to recallLessons so its scope boost can apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-measure-recall-files-"));
    const lessonsFileTmp = join(dir, "lessons.jsonl");
    const goldenFileTmp = join(dir, "golden.jsonl");
    writeFileSync(
      lessonsFileTmp,
      [
        { key: "other-lesson", kind: "project", scope: ["src/other.ts"], text: "parse config values from disk", citation: null },
        {
          key: "target-lesson",
          kind: "project",
          scope: ["src/target.ts"],
          text: "parse config values from disk and validate types before use",
          citation: null,
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n"
    );
    writeFileSync(
      goldenFileTmp,
      JSON.stringify({ query: "parse config values from disk", expected: ["target-lesson"], files: ["src/target.ts"] }) + "\n"
    );
    const emptyConfigDir = mkdtempSync(join(tmpdir(), "doug-measure-recall-files-cfg-"));
    const { code, stdout } = await run(["--lessons", lessonsFileTmp, "--golden", goldenFileTmp, "--config", emptyConfigDir, "--k", "1", "--json"]);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.modes["keyword-only"].recallAtK).toBe(1);
  });
});

describe("--config default", () => {
  // parseArgs itself has no cwd seam (its default is a fixed constant), so this drives the real script as a
  // child process with a distinct cwd, the way a person actually invokes it without --config.
  it("reads .doug/config.json from the process's cwd, not the repo root, when --config is omitted", () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "doug-measure-recall-cwd-"));
    mkdirSync(join(cwdDir, ".doug"), { recursive: true });
    // A reachable-looking but refusing endpoint: readMemoryConfig accepts this shape, so createProvider succeeds
    // and the run actually tries to reach it — that attempt (and its failure reason) is what proves this
    // directory's config.json was read, rather than falling through to the repo root's (which has none).
    writeFileSync(
      join(cwdDir, ".doug", "config.json"),
      JSON.stringify({ memory: { embeddings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "test-model", dims: 8 } } })
    );
    const lessonsFileTmp = join(cwdDir, "lessons.jsonl");
    const goldenFileTmp = join(cwdDir, "golden.jsonl");
    writeFileSync(lessonsFileTmp, JSON.stringify({ key: "k1", kind: "project", scope: [], text: "a lesson", citation: null }) + "\n");
    writeFileSync(goldenFileTmp, JSON.stringify({ query: "a lesson", expected: ["k1"] }) + "\n");

    const result = spawnSync(
      process.execPath,
      [join(root, "evals/measure-recall.mjs"), "--lessons", lessonsFileTmp, "--golden", goldenFileTmp, "--k", "1"],
      { cwd: cwdDir, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    // The repo root's own .doug/config.json has no memory.embeddings, so defaulting there (the bug) always
    // renders this exact "not configured" reason; reading cwdDir's config instead means a connection was
    // actually attempted and refused, rendering some other reason.
    expect(result.stdout).not.toContain("not measured (memory.embeddings not configured)");
    expect(result.stdout).toMatch(/hybrid \| not measured \(/);
  });
});

describe("evals/memory/lessons.jsonl", () => {
  const lessons = readJsonl(lessonsFile);
  it("has at least 24 lessons, mixed kinds", () => {
    expect(lessons.length).toBeGreaterThanOrEqual(24);
    const kinds = new Set(lessons.map((l) => l.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });
  it("holds every ts-basic-suite lesson's citation against the real fixture, since the memory arm re-checks it there", async () => {
    const { checkCitation } = await import("../../plugins/doug-flow/lib/memory.mjs");
    const suiteLessons = lessons.filter((l) => l.suite === "ts-basic");
    expect(suiteLessons.length).toBeGreaterThan(0);
    for (const l of suiteLessons) {
      const result = checkCitation({ citation: l.citation }, fixtureDir);
      expect(result.ok, `${l.key}: ${l.citation} -> ${result.reason}`).toBe(true);
    }
  });
});

describe("evals/memory/golden.jsonl", () => {
  const golden = readJsonl(goldenFile);
  it("has at least 12 queries", () => {
    expect(golden.length).toBeGreaterThanOrEqual(12);
  });
  it("has at least 4 paraphrases sharing no entity token with the query, and at least 4 that name one", () => {
    const withEntity = golden.filter((g) => entityTokens(g.query).size > 0);
    const withoutEntity = golden.filter((g) => entityTokens(g.query).size === 0);
    expect(withEntity.length).toBeGreaterThanOrEqual(4);
    expect(withoutEntity.length).toBeGreaterThanOrEqual(4);
  });
  it("every expected key names a real lesson", () => {
    const lessons = readJsonl(lessonsFile);
    const keys = new Set(lessons.map((l) => l.key));
    for (const g of golden) for (const key of g.expected) expect(keys.has(key), `${g.query} -> ${key}`).toBe(true);
  });
});
