// The opt-in semantic code index (card semantic-index): a cache of tracked-file chunks in the same node:sqlite
// store lib/memory.mjs opens (schema v6: code_files, code_chunks, code_chunks_fts, code_index_builds). Keyword-
// only over FTS5 with nothing installed, hybrid with an embedding provider configured — same product-first shape
// as lib/memory.mjs's lessons store. This module never opens the database itself; every export takes the `m`
// handle lib/memory.mjs's openMemory() returns.
//
// Reuse, not a second matcher: the path-glob dialect (`**`, `*`, `?`) is lib/memory.mjs's own (isGlobPattern,
// globToRegExp), exported from there for exactly this reuse — both modules live in this plugin's lib/, so there
// is no cross-plugin boundary excusing a duplicate the way learn.mjs's local copy of doug-gates/lib/glob.mjs is.
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isGlobPattern, globToRegExp, ftsMatchQuery } from "./memory.mjs";
import { checkEmbeddingSanity } from "./embeddings.mjs";

const MAX_INDEXABLE_FILE_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const CHUNK_CHAR_CAP = 2000;
const LOCKFILE_NAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function matchesAnyGlob(patterns, value) {
  for (const p of patterns) {
    if (isGlobPattern(p) ? globToRegExp(p).test(value) : p === value) return true;
  }
  return false;
}

function isLockfilePath(path) {
  return LOCKFILE_NAMES.has(path.split("/").pop());
}

function isUnderSkippedDir(path) {
  return path.split("/").some((seg) => SKIPPED_DIR_NAMES.has(seg));
}

function isMinFile(path) {
  return path.split("/").pop().includes(".min.");
}

// Binary iff the file's first 8KB contains a NUL byte. Any read failure (permissions, a symlink race) is
// treated as "not binary" here — listIndexableFiles' own statSync/readFileSync calls are what actually decide
// whether the file is usable, this is only the content sniff.
function looksBinary(absPath) {
  let fd;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function gitHeadSha(dir) {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) return null;
  const sha = res.stdout.trim();
  return sha || null;
}

// Tracked files from `git ls-files -z`, filtered by the default policy (skip oversize, binary, lockfiles,
// node_modules/dist/.git, *.min.*) and then by cfg.include/cfg.exclude globs. A non-git dir or a git failure
// throws a clear error naming the directory and git's own stderr; the CLI turns that into exit 1 with the
// message (docs/memory.md documents this the same way lib/memory.mjs's own thrown errors surface).
export function listIndexableFiles(dir, cfg = {}) {
  const include = Array.isArray(cfg.include) ? cfg.include : [];
  const exclude = Array.isArray(cfg.exclude) ? cfg.exclude : [];
  const res = spawnSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`git ls-files failed in ${dir}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`git ls-files failed in ${dir} (exit ${res.status}): ${(res.stderr || "").trim() || "not a git repository"}`);
  }
  const tracked = (res.stdout || "").split("\0").filter(Boolean);
  const out = [];
  for (const path of tracked) {
    if (isLockfilePath(path)) continue;
    if (isUnderSkippedDir(path)) continue;
    if (isMinFile(path)) continue;
    if (include.length && !matchesAnyGlob(include, path)) continue;
    if (exclude.length && matchesAnyGlob(exclude, path)) continue;
    const abs = join(dir, path);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // tracked by git but missing on disk (rare race, e.g. a case-only rename) - skip quietly
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_INDEXABLE_FILE_BYTES) continue;
    if (looksBinary(abs)) continue;
    out.push(path);
  }
  out.sort();
  return out;
}

// Deterministic, language-agnostic chunking: blank-line-separated blocks, merged forward while the merged span
// stays within chunkLines lines and CHUNK_CHAR_CAP characters, a single block already over that split by lines.
// Line numbers are 1-based and inclusive, and map back to the exact source lines (including any blank lines a
// merged chunk's text spans internally). Whitespace-only input yields no chunks.
export function chunkText(text, { chunkLines = 60 } = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  // A trailing "" from a final newline is not a real line; an input with no trailing newline keeps its last line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const blocks = [];
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      if (start !== null) {
        blocks.push([start, i]); // i is 0-based here, i.e. the 1-based line number of the previous line
        start = null;
      }
    } else if (start === null) {
      start = i + 1;
    }
  }
  if (start !== null) blocks.push([start, lines.length]);

  const sliceText = (s, e) => lines.slice(s - 1, e).join("\n");

  function splitOversizeBlock(s, e) {
    const spans = [];
    let gs = s;
    while (gs <= e) {
      let ge = Math.min(gs + chunkLines - 1, e);
      let candidate = sliceText(gs, ge);
      while (candidate.length > CHUNK_CHAR_CAP && ge > gs) {
        ge--;
        candidate = sliceText(gs, ge);
      }
      spans.push([gs, ge]);
      gs = ge + 1;
    }
    return spans;
  }

  const spans = [];
  for (const [s, e] of blocks) {
    const lineCount = e - s + 1;
    const text2 = sliceText(s, e);
    if (lineCount <= chunkLines && text2.length <= CHUNK_CHAR_CAP) spans.push([s, e]);
    else spans.push(...splitOversizeBlock(s, e));
  }

  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last) {
      const combinedLines = e - last[0] + 1;
      const combinedText = sliceText(last[0], e);
      if (combinedLines <= chunkLines && combinedText.length <= CHUNK_CHAR_CAP) {
        last[1] = e;
        continue;
      }
    }
    merged.push([s, e]);
  }

  return merged
    .map(([s, e]) => ({ startLine: s, endLine: e, text: sliceText(s, e) }))
    .filter((c) => c.text.trim() !== "");
}

// `n` is the 0-based occurrence index of this content hash within the file (0 for the first). Without it, two
// identical blocks in the same file (e.g. repeated boilerplate) collide on one id and collapse to one row while
// code_files.chunks still counts both (review MINOR 4) - carrying `n` gives each occurrence its own id, so a
// truly unmoved chunk still keeps its id and embedding across rebuilds and a genuine duplicate still gets its
// own row.
function chunkId(path, contentHash, n = 0) {
  return sha256Hex(`${path}\n${contentHash}\n${n}`).slice(0, 16);
}

// Assigns each chunk its id from its content hash and its occurrence index among chunks sharing that hash within
// this one file's chunk list, in order - shared by buildIndex and indexStatus so both derive the exact same ids.
function idsForChunks(path, chunks) {
  const counts = new Map();
  return chunks.map((c) => {
    const contentHash = sha256Hex(c.text);
    const n = counts.get(contentHash) || 0;
    counts.set(contentHash, n + 1);
    return { id: chunkId(path, contentHash, n), contentHash, ...c };
  });
}

// True when the code index holds at least one chunk but none of them are embedded under provider.model/dims -
// a model or dims change, including the very first embed the code index has ever run. Mirrors
// scripts/memory.mjs's embeddingChangeDetected for lessons, over code_chunks instead.
function codeIndexEmbeddingChangeDetected(m, provider) {
  const total = m.prepare("SELECT COUNT(*) AS n FROM code_chunks").get().n;
  if (total === 0) return false;
  const matching = m
    .prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding_model = ? AND embedding_dims = ?")
    .get(provider.model, provider.dims).n;
  return matching === 0;
}

function vectorToBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToVector(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

// Embeds every code_chunks row not yet embedded under provider.model/dims, batch texts at a time, exactly the
// way lib/memory.mjs's embedLessons embeds lesson rows: a batch the provider fails is counted in `failed` and
// left unembedded (never thrown), the next batch still runs.
async function embedCodeChunks(m, provider, { batch = 32, onProgress } = {}) {
  const todo = m
    .prepare(
      `SELECT id, text FROM code_chunks WHERE embedding IS NULL OR embedding_model IS NOT ? OR embedding_dims IS NOT ?
       ORDER BY id ASC`
    )
    .all(provider.model, provider.dims);
  let embedded = 0;
  let failed = 0;
  let reason = null;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const result = await provider.embed(
      slice.map((c) => c.text),
      { inputType: "document" }
    );
    if (!result.ok) {
      failed += slice.length;
      reason = result.reason;
    } else {
      for (let j = 0; j < slice.length; j++) {
        m.prepare("UPDATE code_chunks SET embedding_model = ?, embedding_dims = ?, embedding = ? WHERE id = ?").run(
          provider.model,
          provider.dims,
          vectorToBlob(result.vectors[j]),
          slice[j].id
        );
        embedded++;
      }
    }
    if (onProgress) onProgress({ embedded, total: todo.length, failed, reason });
  }
  return { total: todo.length, embedded, failed, reason };
}

function toIsoTimestamp(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return d.toISOString();
}

// Incrementally (re)builds the code index: hashes every indexable file, re-chunks and re-embeds only what
// changed, drops rows for files no longer indexable, then (with a provider) embeds pending chunks in batches -
// running the embed-check cosine sanity check first whenever this is the first time the index has ever used
// provider.model/dims (see codeIndexEmbeddingChangeDetected), the same gate scripts/memory.mjs's reembed applies
// to lessons. A failed check, or no provider at all, still lets the build complete keyword-only (never a thrown
// error for a provider or check problem) - only a bad `dir` (listIndexableFiles) or a database problem throws.
export async function buildIndex(m, dir, opts = {}) {
  const { cfg = {}, provider = null, batch = 32, check = true, pairs = null, onProgress, now } = opts;
  const startedAt = toIsoTimestamp(now);
  const chunkLines = cfg.chunkLines || 60;

  const files = listIndexableFiles(dir, cfg);
  const fileSet = new Set(files);

  let filesChanged = 0;
  for (const path of files) {
    let bytes;
    try {
      bytes = readFileSync(join(dir, path));
    } catch {
      continue; // disappeared between listing and reading; the next build will see it as removed
    }
    const hash = sha256Hex(bytes);
    const existingFile = m.prepare("SELECT hash FROM code_files WHERE path = ?").get(path);
    if (existingFile && existingFile.hash === hash) continue;

    filesChanged++;
    const text = bytes.toString("utf8");
    const chunks = chunkText(text, { chunkLines });
    const newRows = idsForChunks(path, chunks);
    const newIds = new Set(newRows.map((r) => r.id));
    const existingIds = m
      .prepare("SELECT id FROM code_chunks WHERE path = ?")
      .all(path)
      .map((r) => r.id);
    const indexedAt = toIsoTimestamp(now);

    m.exec("BEGIN");
    try {
      for (const id of existingIds) {
        if (newIds.has(id)) continue;
        m.prepare("DELETE FROM code_chunks WHERE id = ?").run(id);
        m.prepare("DELETE FROM code_chunks_fts WHERE id = ?").run(id);
      }
      for (const row of newRows) {
        const already = m.prepare("SELECT id FROM code_chunks WHERE id = ?").get(row.id);
        if (already) {
          m.prepare("UPDATE code_chunks SET start_line = ?, end_line = ?, indexed = ? WHERE id = ?").run(
            row.startLine,
            row.endLine,
            indexedAt,
            row.id
          );
        } else {
          m.prepare(
            `INSERT INTO code_chunks (id, path, start_line, end_line, content_hash, text, indexed)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(row.id, path, row.startLine, row.endLine, row.contentHash, row.text, indexedAt);
          m.prepare("INSERT INTO code_chunks_fts (id, path, text) VALUES (?, ?, ?)").run(row.id, path, row.text);
        }
      }
      m.prepare(
        `INSERT INTO code_files (path, hash, bytes, chunks, indexed) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, bytes = excluded.bytes, chunks = excluded.chunks, indexed = excluded.indexed`
      ).run(path, hash, bytes.byteLength, newRows.length, indexedAt);
      m.exec("COMMIT");
    } catch (err) {
      m.exec("ROLLBACK");
      throw err;
    }
  }

  let filesRemoved = 0;
  const storedPaths = m
    .prepare("SELECT path FROM code_files")
    .all()
    .map((r) => r.path);
  for (const path of storedPaths) {
    if (fileSet.has(path)) continue;
    filesRemoved++;
    const ids = m
      .prepare("SELECT id FROM code_chunks WHERE path = ?")
      .all(path)
      .map((r) => r.id);
    m.exec("BEGIN");
    try {
      for (const id of ids) {
        m.prepare("DELETE FROM code_chunks WHERE id = ?").run(id);
        m.prepare("DELETE FROM code_chunks_fts WHERE id = ?").run(id);
      }
      m.prepare("DELETE FROM code_files WHERE path = ?").run(path);
      m.exec("COMMIT");
    } catch (err) {
      m.exec("ROLLBACK");
      throw err;
    }
  }

  const totalFiles = m.prepare("SELECT COUNT(*) AS n FROM code_files").get().n;
  const totalChunks = m.prepare("SELECT COUNT(*) AS n FROM code_chunks").get().n;

  let chunksEmbedded = 0;
  let chunksFailed = 0;
  let embedSeconds = null;
  let checkStatus = "not-needed";
  let reason = null;

  if (!provider) {
    reason = "no provider configured";
  } else {
    const pendingCount = m
      .prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding IS NULL OR embedding_model IS NOT ? OR embedding_dims IS NOT ?")
      .get(provider.model, provider.dims).n;

    if (pendingCount === 0) {
      checkStatus = "not-needed";
    } else if (check === false) {
      checkStatus = "skipped";
    } else if (check === "force" || codeIndexEmbeddingChangeDetected(m, provider)) {
      if (!pairs) {
        checkStatus = "failed";
        reason = "no sanity pairs file available to check a new model/dims pair";
      } else {
        const sanity = await checkEmbeddingSanity(provider, pairs);
        checkStatus = sanity.ok ? "ok" : "failed";
        if (!sanity.ok) reason = sanity.reason;
      }
    } else {
      checkStatus = "not-needed";
    }

    if (checkStatus !== "failed") {
      const embedStart = Date.now();
      const embedResult = await embedCodeChunks(m, provider, { batch, onProgress });
      embedSeconds = (Date.now() - embedStart) / 1000;
      chunksEmbedded = embedResult.embedded;
      chunksFailed = embedResult.failed;
      if (embedResult.reason) reason = embedResult.reason;
    }
  }

  const finishedAt = toIsoTimestamp(now);
  const headSha = gitHeadSha(dir);
  m.prepare(
    `INSERT INTO code_index_builds
       (started, finished, head_sha, files, chunks, files_changed, chunks_embedded, chunks_failed, embed_seconds, provider, model, dims, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    startedAt,
    finishedAt,
    headSha,
    totalFiles,
    totalChunks,
    filesChanged,
    chunksEmbedded,
    chunksFailed,
    embedSeconds,
    provider ? provider.name : null,
    provider ? provider.model : null,
    provider ? provider.dims : null,
    reason
  );

  return {
    files: totalFiles,
    chunks: totalChunks,
    filesChanged,
    filesRemoved,
    chunksEmbedded,
    chunksFailed,
    embedSeconds,
    check: checkStatus,
    reason,
  };
}

// The index's size and its refresh cost, without writing anything. Refresh cost re-lists and re-hashes every
// indexable file (no chunking beyond the added/changed set, no writes) and counts exactly the chunks the next
// buildIndex would find new - the same id derivation buildIndex uses, so the two never disagree.
export function indexStatus(m, dir, opts = {}) {
  const { cfg = {}, provider = null } = opts;
  const chunkLines = cfg.chunkLines || 60;

  const filesRow = m.prepare("SELECT COUNT(*) AS n FROM code_files").get();
  const chunksRow = m.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)), 0) AS bytes FROM code_chunks").get();
  const dbBytes = existsSync(m.file) ? statSync(m.file).size : 0;

  let embedded = 0;
  if (provider) {
    embedded = m
      .prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding_model = ? AND embedding_dims = ?")
      .get(provider.model, provider.dims).n;
  }

  const lastBuild = m.prepare("SELECT * FROM code_index_builds ORDER BY id DESC LIMIT 1").get() || null;
  const currentHead = gitHeadSha(dir);

  const files = listIndexableFiles(dir, cfg);
  const fileSet = new Set(files);
  const storedFiles = m.prepare("SELECT path, hash FROM code_files").all();
  const storedByPath = new Map(storedFiles.map((r) => [r.path, r.hash]));

  let added = 0;
  let changed = 0;
  let removed = 0;
  let chunksToEmbed = 0;
  for (const path of files) {
    let bytes;
    try {
      bytes = readFileSync(join(dir, path));
    } catch {
      continue;
    }
    const hash = sha256Hex(bytes);
    const storedHash = storedByPath.get(path);
    const isNew = storedHash === undefined;
    const isChanged = !isNew && storedHash !== hash;
    if (!isNew && !isChanged) continue;
    if (isNew) added++;
    else changed++;

    const text = bytes.toString("utf8");
    for (const row of idsForChunks(path, chunkText(text, { chunkLines }))) {
      const exists = m.prepare("SELECT 1 AS x FROM code_chunks WHERE id = ?").get(row.id);
      if (!exists) chunksToEmbed++;
    }
  }
  for (const path of storedByPath.keys()) {
    if (!fileSet.has(path)) removed++;
  }

  // The rate comes from the most recent build that actually measured one, not necessarily the last build overall
  // (review MAJOR 1): a no-op rebuild or a keyword-only build (no provider, or a failed check) writes a row with
  // embed_seconds/chunks_embedded at 0, and taking the rate from that row alone would wipe a perfectly good
  // estimate an earlier, real embed pass already measured.
  const lastMeasuredBuild = m
    .prepare("SELECT chunks_embedded, embed_seconds FROM code_index_builds WHERE embed_seconds > 0 AND chunks_embedded > 0 ORDER BY id DESC LIMIT 1")
    .get();
  let rate = null;
  let refreshSeconds = null;
  let rateReason = null;
  if (lastMeasuredBuild) {
    rate = lastMeasuredBuild.chunks_embedded / lastMeasuredBuild.embed_seconds;
    refreshSeconds = rate > 0 ? chunksToEmbed / rate : null;
  } else {
    rateReason = "no measured build";
  }

  return {
    files: filesRow.n,
    chunks: chunksRow.n,
    textBytes: chunksRow.bytes,
    dbBytes,
    provider: provider ? provider.name : "none",
    model: provider ? provider.model : null,
    dims: provider ? provider.dims : null,
    embedded,
    built: lastBuild
      ? { finished: lastBuild.finished, headSha: lastBuild.head_sha, current: !!currentHead && currentHead === lastBuild.head_sha }
      : null,
    refresh: { added, changed, removed, chunksToEmbed, seconds: refreshSeconds, rate, rateReason },
  };
}

function rowsByIdMap(m, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = m.prepare(`SELECT id, path, start_line, end_line, text FROM code_chunks WHERE id IN (${placeholders})`).all(...ids);
  return new Map(rows.map((r) => [r.id, r]));
}

// Hybrid search in the shape of recallLessons' steps (b)-(d): BM25 over code_chunks_fts (top 50) fused with
// cosine over chunks stored under the provider's model/dims (top 50) by reciprocal rank fusion (1/(60+rank) per
// side) - no recency term, code has none. `files` globs restrict candidates by path on both sides: in SQL for
// the BM25 side (a precomputed allow-list of matching paths, so the ranking itself runs restricted), in memory
// for the vector side. Never throws for a provider problem; a query with no FTS tokens simply has no BM25 side.
export async function searchIndex(m, query, opts = {}) {
  const { k = 8, files = [], provider = null } = opts;

  const allowedPaths = files.length
    ? new Set(
        m
          .prepare("SELECT DISTINCT path FROM code_chunks")
          .all()
          .map((r) => r.path)
          .filter((p) => matchesAnyGlob(files, p))
      )
    : null;
  const pathsExcluded = allowedPaths !== null && allowedPaths.size === 0;

  // review MINOR 5: a `path IN (?, ?, ...)` clause with one bound parameter per matching path can exceed
  // SQLITE_MAX_VARIABLE_NUMBER on a large repo with a broad --files glob. Take the raw top 200 BM25 matches (no
  // path filter in SQL) and restrict to allowedPaths in memory instead, the same way the vector side already
  // does, then cut to the usual top 50.
  let bm25Ranked = [];
  const match = ftsMatchQuery(query);
  if (match && !pathsExcluded) {
    const rows = m
      .prepare("SELECT id, path FROM code_chunks_fts WHERE code_chunks_fts MATCH ? ORDER BY bm25(code_chunks_fts) LIMIT 200")
      .all(match);
    const filtered = allowedPaths ? rows.filter((r) => allowedPaths.has(r.path)) : rows;
    bm25Ranked = filtered.slice(0, 50).map((r) => r.id);
  }

  let mode = "keyword-only";
  let reason = "no provider configured";
  let providerName = null;
  let vectorRanked = [];
  if (provider) {
    providerName = provider.name;
    let vectorRows = m
      .prepare("SELECT id, path, embedding FROM code_chunks WHERE embedding_model = ? AND embedding_dims = ?")
      .all(provider.model, provider.dims);
    if (allowedPaths) vectorRows = vectorRows.filter((r) => allowedPaths.has(r.path));
    if (!vectorRows.length) {
      reason = `no vectors stored for ${provider.model}/${provider.dims}`;
    } else {
      const embedResult = await provider.embed([String(query || "")], { inputType: "query" });
      if (!embedResult.ok) {
        reason = embedResult.reason;
      } else {
        const qVec = embedResult.vectors[0];
        const scored = vectorRows.map((r) => {
          const vec = blobToVector(r.embedding);
          let dot = 0;
          for (let i = 0; i < qVec.length && i < vec.length; i++) dot += qVec[i] * vec[i];
          return { id: r.id, score: dot };
        });
        scored.sort((a, b) => b.score - a.score);
        vectorRanked = scored.slice(0, 50).map((s) => s.id);
        mode = "hybrid";
        reason = null;
      }
    }
  }

  const fused = new Map();
  bm25Ranked.forEach((id, idx) => fused.set(id, (fused.get(id) || 0) + 1 / (60 + idx + 1)));
  vectorRanked.forEach((id, idx) => fused.set(id, (fused.get(id) || 0) + 1 / (60 + idx + 1)));

  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const rows = rowsByIdMap(
    m,
    ranked.map(([id]) => id)
  );

  const chunks = ranked
    .map(([id, score]) => {
      const row = rows.get(id);
      if (!row) return null;
      const sides = [];
      if (bm25Ranked.includes(id)) sides.push("bm25");
      if (vectorRanked.includes(id)) sides.push("vector");
      return { id, path: row.path, startLine: row.start_line, endLine: row.end_line, score, sides, text: row.text };
    })
    .filter(Boolean);

  return { mode, reason: mode === "hybrid" ? null : reason, provider: providerName, chunks };
}
