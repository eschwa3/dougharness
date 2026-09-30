#!/usr/bin/env node
// measure-recall.mjs (card memory-measure, clean-room rewrite for card measure-recall-own-rewrite): measures
// recall@k, precision@k, and MRR of plugins/doug-flow/lib/memory.mjs's recallLessons against a golden query set
// (evals/memory/golden.jsonl, keys resolved against evals/memory/lessons.jsonl), store-agnostic — without
// --store it builds and tears down a scratch store from --lessons; with --store <dir> it measures that real
// store instead. Keyword-only always runs and is reported as the floor; a hybrid pass runs alongside it only
// when memory.embeddings (read from --config) names a reachable provider, and is reported as
// "not measured (<reason>)" rather than a fabricated number otherwise. A lexical-leakage check classifies every
// expected hit the run actually retrieved as lexical (the query shares an "entity" token with the hit's own
// text) or semantic (it shares none); the hybrid pass additionally reports semanticWins, the semantic hits
// keyword-only missed.
//
// Metric definitions and sources (docs/research/measure-recall-own-rewrite.md):
//   P@k = (relevant items in the top k) / k
//     Manning, Raghavan, Schütze, "Introduction to Information Retrieval", ch. 8.3/8.4:
//     https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-unranked-retrieval-sets-1.html
//     https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html
//   R@k = (relevant items in the top k) / (all relevant items for the query) — same source, ch. 8.3.
//   RR = 1 / (rank of the first relevant item), 0 when no relevant item is in the list;
//   MRR = mean of RR over the query set.
//     https://en.wikipedia.org/wiki/Mean_reciprocal_rank
//   Each per-query measure is averaged as a plain arithmetic mean (the IR book states this for MAP, ch. 8.4;
//   applying the same averaging to P@k, R@k, and RR is this script's own choice) — but not over the same
//   denominator: a query with zero expected items has nothing to score for recall, so it is excluded from the
//   recall@k mean (0/0), while it still counts as a 0 in the precision@k and MRR means, since it is a real query
//   the run scored (zero relevant retrieved, no first-relevant rank), not a query that never happened.
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openMemory, memoryPath, addLesson, embedLessons, recallLessons } from "../plugins/doug-flow/lib/memory.mjs";
import { readMemoryConfig, createProvider } from "../plugins/doug-flow/lib/embeddings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DEFAULT_LESSONS = join(root, "evals/memory/lessons.jsonl");
const DEFAULT_GOLDEN = join(root, "evals/memory/golden.jsonl");
const DEFAULT_CONFIG = process.cwd();
const DEFAULT_K = 8;

export const USAGE =
  "Usage: measure-recall.mjs [--lessons <file>] [--golden <file>] [--store <dir>] [--config <dir>] [--k <n>] [--json]";

// --- args -----------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { lessons: DEFAULT_LESSONS, golden: DEFAULT_GOLDEN, store: null, config: DEFAULT_CONFIG, k: DEFAULT_K, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lessons") opts.lessons = argv[++i];
    else if (a === "--golden") opts.golden = argv[++i];
    else if (a === "--store") opts.store = argv[++i];
    else if (a === "--config") opts.config = argv[++i];
    else if (a === "--k") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: `--k must be an integer > 0, got ${raw}` };
      opts.k = n;
    } else if (a === "--json") opts.json = true;
    else return { error: `unknown argument: ${a}` };
  }
  return { opts };
}

function parseJsonl(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- lesson id / golden key resolution --------------------------------------------------------------------
// Mirrors the private id scheme addLesson computes in plugins/doug-flow/lib/memory.mjs (sha256 of
// "<kind>\n<citation or "">\n<text>", first 16 hex chars) so a golden entry's expected key resolves to the same
// id a lesson row actually gets, without that helper being exported from memory.mjs itself.

export function computeLessonId({ kind, citation, text }) {
  return createHash("sha256")
    .update(`${kind}\n${citation || ""}\n${text}`)
    .digest("hex")
    .slice(0, 16);
}

export function keyToIdMap(lessons) {
  const map = new Map();
  for (const l of lessons) map.set(l.key, computeLessonId({ kind: l.kind, citation: l.citation, text: l.text }));
  return map;
}

// A golden entry's expected key resolves through the map when it names a lessons.jsonl `key`; an unknown key is
// taken as a literal lesson id (lets a golden fixture reference an id directly, without a key in lessons.jsonl).
export function expectedIdsFor(entry, map) {
  const expected = (entry && entry.expected) || [];
  return expected.map((key) => (map.has(key) ? map.get(key) : key));
}

// --- lexical-leakage classification -----------------------------------------------------------------------
// An entity token is any backticked span (kept regardless of its own shape), or a whitespace token containing
// "/", ".", "_", "-", a digit, or a capital letter after its first character. Trailing sentence punctuation and
// a trailing possessive ('s or the curly '’s) are stripped before a whitespace token's shape is tested;
// every stored token is lowercased, so comparison against a hit's text is case-insensitive.

function stripTrailingPunct(s) {
  return s.replace(/[.,!?;:)\]}"]+$/, "");
}

function stripPossessive(s) {
  return s.replace(/(?:'s|’s)$/i, "");
}

function isEntityShaped(token) {
  if (/[/._-]/.test(token)) return true;
  if (/\d/.test(token)) return true;
  return /[A-Z]/.test(token.slice(1));
}

export function entityTokens(text) {
  const result = new Set();
  const s = String(text ?? "");
  const withoutBackticks = s.replace(/`([^`]+)`/g, (_, inner) => {
    const trimmed = inner.trim();
    if (trimmed) result.add(trimmed.toLowerCase());
    return " ";
  });
  for (const raw of withoutBackticks.split(/\s+/)) {
    if (!raw) continue;
    const token = stripPossessive(stripTrailingPunct(raw));
    if (!token) continue;
    if (isEntityShaped(token)) result.add(token.toLowerCase());
  }
  return result;
}

export function sharesEntity(tokens, text) {
  const hay = String(text ?? "").toLowerCase();
  for (const t of tokens) {
    if (t && hay.includes(t)) return true;
  }
  return false;
}

// --- per-mode aggregate stats ------------------------------------------------------------------------------
// perQuery: [{ query, expectedIds, hits: [{ id, text }, ...] }, ...], hits already the top-k a recall call
// returned. `hits`/`lexical`/`semantic` below count expected ids actually found in `hits`, split by whether the
// query shares an entity token with the found hit's text. A query whose expectedIds is empty (no relevant item
// exists to score) has nothing to score for recall, so it is excluded from the recall@k mean (0/0, tracked by
// its own denominator nRecall below); it still counts as a 0 in the precision@k and MRR means (denominator
// nAll, every query processed) — it retrieved zero relevant items and has no first-relevant rank, which are
// both real, scoreable outcomes, not a query that never happened. `baseline`, when given (the keyword-only
// perQuery this mode is compared against), adds `semanticWins`: the semantic hits found here that baseline did
// not find for the same query. A lexical hit never counts as a semanticWin even when baseline missed it too.
export function modeStats(perQuery, k, baseline = null) {
  let hits = 0;
  let lexical = 0;
  let semantic = 0;
  let semanticWins = 0;
  let recallSum = 0;
  let precisionSum = 0;
  let mrrSum = 0;
  let nAll = 0;
  let nRecall = 0;
  const baselineByQuery = baseline ? new Map(baseline.map((b) => [b.query, new Set((b.hits || []).map((h) => h.id))])) : null;

  for (const q of perQuery) {
    const expected = new Set(q.expectedIds || []);
    const qHits = q.hits || [];
    const hitIds = qHits.map((h) => h.id);
    const foundIds = hitIds.filter((id) => expected.has(id));
    hits += foundIds.length;

    const tokens = entityTokens(q.query);
    for (const h of qHits) {
      if (!expected.has(h.id)) continue;
      if (sharesEntity(tokens, h.text || "")) {
        lexical++;
      } else {
        semantic++;
        if (baselineByQuery) {
          const baseHits = baselineByQuery.get(q.query) || new Set();
          if (!baseHits.has(h.id)) semanticWins++;
        }
      }
    }

    nAll++;
    precisionSum += foundIds.length / k;
    let rank = 0;
    for (let i = 0; i < hitIds.length; i++) {
      if (expected.has(hitIds[i])) {
        rank = i + 1;
        break;
      }
    }
    mrrSum += rank > 0 ? 1 / rank : 0;

    if (expected.size === 0) continue;
    nRecall++;
    recallSum += foundIds.length / expected.size;
  }

  const result = {
    recallAtK: nRecall ? recallSum / nRecall : 0,
    precisionAtK: nAll ? precisionSum / nAll : 0,
    mrr: nAll ? mrrSum / nAll : 0,
    hits,
    lexical,
    semantic,
  };
  if (baseline) result.semanticWins = semanticWins;
  return result;
}

// --- rendering -----------------------------------------------------------------------------------------------

export function renderTable(summary, hybridReason = null) {
  const lines = [];
  lines.push(`k=${summary.k}  queries=${summary.queries}  provider=${summary.provider ?? "none"}`);
  lines.push("");
  lines.push("| mode | recall@k | precision@k | mrr | hits | lexical | semantic | semanticWins |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, stats] of Object.entries(summary.modes)) {
    if (!stats) {
      lines.push(`| ${name} | not measured (${hybridReason}) |`);
      continue;
    }
    const wins = stats.semanticWins !== undefined ? stats.semanticWins : "";
    lines.push(
      `| ${name} | ${stats.recallAtK.toFixed(3)} | ${stats.precisionAtK.toFixed(3)} | ${stats.mrr.toFixed(3)} | ${stats.hits} | ${stats.lexical} | ${stats.semantic} | ${wins} |`
    );
  }
  return lines.join("\n");
}

// --- main -------------------------------------------------------------------------------------------------

export async function main(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));

  const { opts, error } = parseArgs(argv);
  if (error) {
    stderr(`${error}\n${USAGE}\n`);
    return 2;
  }

  let lessonsRaw;
  try {
    lessonsRaw = readFileSync(opts.lessons, "utf8");
  } catch (err) {
    stderr(`cannot read --lessons ${opts.lessons}: ${err.message}\n`);
    return 1;
  }
  let goldenRaw;
  try {
    goldenRaw = readFileSync(opts.golden, "utf8");
  } catch (err) {
    stderr(`cannot read --golden ${opts.golden}: ${err.message}\n`);
    return 1;
  }

  const lessons = parseJsonl(lessonsRaw);
  const golden = parseJsonl(goldenRaw);
  const keyMap = keyToIdMap(lessons);

  let storeDir = opts.store;
  let scratch = false;
  if (storeDir) {
    if (!existsSync(memoryPath(storeDir))) {
      stderr(`no memory store at ${memoryPath(storeDir)}\n`);
      return 1;
    }
  } else {
    storeDir = mkdtempSync(join(tmpdir(), "doug-measure-recall-"));
    scratch = true;
  }

  const m = openMemory(storeDir);
  try {
    if (scratch) {
      for (const l of lessons) {
        addLesson(m, {
          text: l.text,
          kind: l.kind,
          citation: l.citation ?? null,
          scope: l.scope ?? [],
          source: { agent: "measure-recall" },
        });
      }
    }

    const cfg = readMemoryConfig(opts.config);
    let provider = createProvider(cfg);
    let hybridReason = provider ? null : "memory.embeddings not configured";

    if (provider) {
      if (scratch) {
        // A fresh scratch store has no stored vectors yet; embed the lessons just added so the hybrid pass has
        // something to compare against. embedLessons never throws — a batch it can't embed is counted failed,
        // never thrown — so an unreachable provider surfaces here as embedded === 0, not an exception.
        const embedResult = await embedLessons(m, provider);
        if (embedResult.total > 0 && embedResult.embedded === 0) {
          hybridReason = embedResult.reason || "embedding failed";
          provider = null;
        }
      } else {
        // A real store's vectors (if any) are already there; only check that the provider itself is reachable,
        // never embed into a store this run does not own.
        const probe = await provider.embed(["probe"]);
        if (!probe.ok) {
          hybridReason = probe.reason;
          provider = null;
        }
      }
    }

    const kwPerQuery = [];
    const hyPerQuery = provider ? [] : null;
    for (const g of golden) {
      const expectedIds = expectedIdsFor(g, keyMap);
      const files = g.files || [];
      const kwResult = await recallLessons(m, g.query, { k: opts.k, files, provider: null });
      kwPerQuery.push({ query: g.query, expectedIds, hits: kwResult.lessons.map((l) => ({ id: l.id, text: l.text })) });
      if (provider) {
        const hyResult = await recallLessons(m, g.query, { k: opts.k, files, provider });
        hyPerQuery.push({ query: g.query, expectedIds, hits: hyResult.lessons.map((l) => ({ id: l.id, text: l.text })) });
      }
    }

    const kwStats = modeStats(kwPerQuery, opts.k);
    const hyStats = provider ? modeStats(hyPerQuery, opts.k, kwPerQuery) : null;

    const summary = {
      k: opts.k,
      queries: golden.length,
      provider: provider ? provider.name : null,
      modes: { "keyword-only": kwStats, hybrid: hyStats },
    };

    if (opts.json) stdout(`${JSON.stringify(summary)}\n`);
    else stdout(`${renderTable(summary, hybridReason)}\n`);
    return 0;
  } finally {
    m.close();
    if (scratch) rmSync(storeDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.stack || String(err)}\n`);
      process.exit(1);
    }
  );
}
