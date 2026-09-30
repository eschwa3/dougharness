// lib/code-index.mjs (card semantic-index): the opt-in semantic code index - file listing, chunking, incremental
// build, status, and search. Uses a real temp git repo fixture (the way tests/land.test.mjs builds one) and a
// fixed-vector fake provider (the way tests/memory.test.mjs and tests/embeddings.test.mjs do).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../lib/memory.mjs";
import { listIndexableFiles, chunkText, buildIndex, indexStatus, searchIndex } from "../lib/code-index.mjs";

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(files = { "README.md": "# fx\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "doug-code-index-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeRepoFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function writeRepoFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

function commitAll(dir, message = "update") {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

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

// Like fakeProvider, but with a tiny artificial delay so embed_seconds is measurably > 0 (a truly instant fake
// could otherwise round to 0, making an assertion that a measured rate/seconds exists flaky).
function delayedProvider({ name = "fake", model = "fake-model", dims = 3, vectorFor = () => [1, 0, 0], delayMs = 5 } = {}) {
  return {
    name,
    model,
    dims,
    async embed(texts) {
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, vectors: texts.map((t) => Float32Array.from(vectorFor(t))) };
    },
  };
}

function downProvider({ name = "fake", model = "fake-model", dims = 3, reason = "connection refused" } = {}) {
  return { name, model, dims, async embed() { return { ok: false, reason }; } };
}

const okPairs = () => {
  const b = (cos) => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
  const paraphrase = Array.from({ length: 12 }, (_, i) => [`para ${i} a`, `para ${i} b`]);
  const unrelated = Array.from({ length: 12 }, (_, i) => [`unrel ${i} a`, `unrel ${i} b`]);
  const vectorsByText = {};
  for (const [a, bb] of paraphrase) {
    vectorsByText[a] = [1, 0];
    vectorsByText[bb] = b(0.9);
  }
  for (const [a, bb] of unrelated) {
    vectorsByText[a] = [0, 1];
    vectorsByText[bb] = [Math.sqrt(1 - 0.1 * 0.1), 0.1];
  }
  return { pairs: { margin: 0.15, paraphrase, unrelated }, vectorsByText };
};

// A sanity-check-aware fake provider: scores exactly the pairs.json sentences via vectorsByText, and any other
// text (a real code chunk) via vectorFor - so the same provider can pass checkEmbeddingSanity and then embed
// chunks in one build.
function sanityAwareProvider({ model = "fake-model", dims = 2, vectorsByText = {}, vectorFor = () => [1, 0] } = {}) {
  return {
    name: "fake",
    model,
    dims,
    async embed(texts) {
      return { ok: true, vectors: texts.map((t) => Float32Array.from(vectorsByText[t] || vectorFor(t))) };
    },
  };
}

let dir;
let m;

afterEach(() => {
  if (m) {
    try {
      m.close();
    } catch {
      // already closed
    }
    m = null;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("chunkText", () => {
  it("splits blank-line-separated blocks into chunks with 1-based inclusive line numbers mapping back to the source", () => {
    const text = "line one\nline two\n\nline four\nline five\n";
    const chunks = chunkText(text, { chunkLines: 60 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startLine: 1, endLine: 5, text: "line one\nline two\n\nline four\nline five" });
  });

  it("is deterministic: the same input always yields the same chunks", () => {
    const text = Array.from({ length: 30 }, (_, i) => (i % 5 === 4 ? "" : `line ${i}`)).join("\n");
    const a = chunkText(text, { chunkLines: 10 });
    const b = chunkText(text, { chunkLines: 10 });
    expect(a).toEqual(b);
  });

  it("respects chunkLines: merges consecutive blocks only while the merged span stays within it", () => {
    // Three two-line blocks, each separated from the next by one blank line. chunkLines=5 lets the first two
    // blocks merge (combined span 1-5, 5 lines) but merging the third in too would reach 8 lines, over the cap,
    // so it starts a new chunk on its own.
    const text = "a\nb\n\nc\nd\n\ne\nf\n";
    const chunks = chunkText(text, { chunkLines: 5 });
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 5],
      [7, 8],
    ]);
    expect(chunks[0].text).toBe("a\nb\n\nc\nd");
    expect(chunks[1].text).toBe("e\nf");
  });

  it("respects the 2000-character cap even when chunkLines would allow merging further", () => {
    const longLine = "x".repeat(1500);
    const text = `${longLine}\n\n${longLine}\n`;
    const chunks = chunkText(text, { chunkLines: 60 });
    // Merging both 1500-char lines (plus the blank line) would exceed 2000 chars, so they stay separate chunks.
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2000);
  });

  it("splits a single block longer than chunkLines by lines", () => {
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i}`);
    const text = lines.join("\n") + "\n";
    const chunks = chunkText(text, { chunkLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(50);
    // The spans are contiguous and cover every line exactly once.
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(130);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
  });

  it("drops whitespace-only chunks: an all-blank or empty input yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("\n\n   \n\t\n")).toEqual([]);
  });

  it("maps chunk text back to the exact source lines", () => {
    const text = "one\ntwo\nthree\nfour\nfive\n";
    const chunks = chunkText(text, { chunkLines: 2 });
    const sourceLines = text.split("\n");
    for (const c of chunks) {
      const expected = sourceLines.slice(c.startLine - 1, c.endLine).join("\n");
      expect(c.text).toBe(expected);
    }
  });
});

describe("listIndexableFiles", () => {
  beforeEach(() => {
    dir = repo({
      "README.md": "readme\n",
      "src/a.mjs": "export const a = 1;\n",
      "src/b.mjs": "export const b = 2;\n",
    });
  });

  it("lists only tracked files, sorted", () => {
    writeFileSync(join(dir, "untracked.txt"), "not tracked\n");
    const files = listIndexableFiles(dir, {});
    expect(files).toEqual(["README.md", "src/a.mjs", "src/b.mjs"]);
    expect(files).not.toContain("untracked.txt");
  });

  it("skips a binary file (a NUL byte in its first 8KB)", () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3, 4]));
    commitAll(dir);
    const files = listIndexableFiles(dir, {});
    expect(files).not.toContain("bin.dat");
  });

  it("skips a file over 256KB", () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(256 * 1024 + 1));
    commitAll(dir);
    const files = listIndexableFiles(dir, {});
    expect(files).not.toContain("big.txt");
  });

  it("skips lockfiles, node_modules/, dist/, .git/, and *.min.* files", () => {
    writeRepoFiles(dir, {
      "pnpm-lock.yaml": "lockfile\n",
      "package-lock.json": "{}\n",
      "yarn.lock": "lockfile\n",
      "node_modules/pkg/index.js": "module.exports = {};\n",
      "dist/bundle.js": "console.log(1);\n",
      "vendor.min.js": "console.log(2);\n",
    });
    commitAll(dir);
    const files = listIndexableFiles(dir, {});
    for (const skipped of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "node_modules/pkg/index.js", "dist/bundle.js", "vendor.min.js"]) {
      expect(files, skipped).not.toContain(skipped);
    }
    expect(files).toContain("src/a.mjs");
  });

  it("cfg.include restricts to matching files, cfg.exclude drops matching ones", () => {
    const included = listIndexableFiles(dir, { include: ["src/**"] });
    expect(included).toEqual(["src/a.mjs", "src/b.mjs"]);

    const excluded = listIndexableFiles(dir, { exclude: ["src/**"] });
    expect(excluded).toEqual(["README.md"]);
  });

  it("throws a clear error on a non-git directory", () => {
    const plain = mkdtempSync(join(tmpdir(), "doug-code-index-nogit-"));
    try {
      expect(() => listIndexableFiles(plain, {})).toThrow(/git/i);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("buildIndex: first build", () => {
  beforeEach(() => {
    dir = repo({
      "src/a.mjs": "export function a() {\n  return 1;\n}\n",
      "src/b.mjs": "export function b() {\n  return 2;\n}\n",
    });
    m = openMemory(dir);
  });

  it("populates code_files, code_chunks, and code_chunks_fts, and records one builds row with head_sha", async () => {
    const result = await buildIndex(m, dir, { cfg: {} });
    expect(result.files).toBe(2);
    expect(result.filesChanged).toBe(2);
    expect(result.filesRemoved).toBe(0);
    expect(result.chunks).toBeGreaterThan(0);

    const fileRows = m.prepare("SELECT * FROM code_files ORDER BY path").all();
    expect(fileRows.map((r) => r.path)).toEqual(["src/a.mjs", "src/b.mjs"]);
    const chunkRows = m.prepare("SELECT * FROM code_chunks").all();
    expect(chunkRows.length).toBe(result.chunks);
    const ftsCount = m.prepare("SELECT COUNT(*) AS n FROM code_chunks_fts").get().n;
    expect(ftsCount).toBe(result.chunks);

    const builds = m.prepare("SELECT * FROM code_index_builds").all();
    expect(builds).toHaveLength(1);
    expect(builds[0].head_sha).toBe(git(dir, "rev-parse", "HEAD"));
    expect(builds[0].files).toBe(2);
  });

  it("chunks a file's content back to the exact stored text", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const row = m.prepare("SELECT * FROM code_chunks WHERE path = 'src/a.mjs'").get();
    expect(row.text).toContain("function a()");
  });
});

describe("buildIndex: incremental", () => {
  beforeEach(() => {
    dir = repo({
      "src/a.mjs": "export function a() {\n  return 1;\n}\n",
      "src/b.mjs": "export function b() {\n  return 2;\n}\n",
    });
    m = openMemory(dir);
  });

  it("a rebuild with nothing changed touches no rows: indexed timestamps unchanged, filesChanged 0", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const before = m.prepare("SELECT path, indexed FROM code_files ORDER BY path").all();

    const result = await buildIndex(m, dir, { cfg: {} });
    expect(result.filesChanged).toBe(0);
    expect(result.filesRemoved).toBe(0);
    const after = m.prepare("SELECT path, indexed FROM code_files ORDER BY path").all();
    expect(after).toEqual(before);
  });

  it("editing one file re-chunks only that path: an unmoved chunk keeps its id and embedding, a changed chunk loses its row", async () => {
    // chunkLines:3 keeps each 3-line function its own chunk without merging into its neighbor once a second
    // function is added (their combined span, 7 lines, would exceed it) - so the original chunk's content is
    // truly unmoved and its id/embedding must survive.
    const cfg = { chunkLines: 3 };
    await buildIndex(m, dir, { cfg });
    const provider = fakeProvider();
    await buildIndex(m, dir, { cfg, provider, check: false });

    const bRowsBefore = m.prepare("SELECT * FROM code_chunks WHERE path = 'src/b.mjs'").all();
    expect(bRowsBefore.every((r) => r.embedding_model === "fake-model")).toBe(true);

    const aRowsBefore = m.prepare("SELECT * FROM code_chunks WHERE path = 'src/a.mjs'").all();
    expect(aRowsBefore).toHaveLength(1);
    const unmovedId = aRowsBefore[0].id;

    writeFileSync(
      join(dir, "src/a.mjs"),
      "export function a() {\n  return 1;\n}\n\nexport function extra() {\n  return 99;\n}\n"
    );
    commitAll(dir, "edit a");

    const result = await buildIndex(m, dir, { cfg, provider, check: false });
    expect(result.filesChanged).toBe(1);

    // src/b.mjs was untouched: its chunk rows and embeddings survive unchanged.
    const bRowsAfter = m.prepare("SELECT * FROM code_chunks WHERE path = 'src/b.mjs'").all();
    expect(bRowsAfter).toEqual(bRowsBefore);

    // src/a.mjs's original "function a" chunk text is unchanged content, so its id and embedding survive too.
    const aRowsAfter = m.prepare("SELECT * FROM code_chunks WHERE path = 'src/a.mjs'").all();
    const stillThere = aRowsAfter.find((r) => r.id === unmovedId);
    expect(stillThere).toBeTruthy();
    expect(stillThere.embedding_model).toBe("fake-model");
    // A brand new chunk (the added function) appears too; the same build call's embed phase embeds it.
    expect(aRowsAfter).toHaveLength(2);
    const newRow = aRowsAfter.find((r) => r.id !== unmovedId);
    expect(newRow.embedding_model).toBe("fake-model");

    // Now change that second chunk's own content: its old row must disappear, replaced by a new id, while the
    // first (still-unmoved) chunk's row and embedding are untouched.
    writeFileSync(
      join(dir, "src/a.mjs"),
      "export function a() {\n  return 1;\n}\n\nexport function extra() {\n  return 12345;\n}\n"
    );
    commitAll(dir, "edit extra");
    await buildIndex(m, dir, { cfg, provider, check: false });
    const aRowsFinal = m.prepare("SELECT * FROM code_chunks WHERE path = 'src/a.mjs'").all();
    expect(aRowsFinal).toHaveLength(2);
    expect(aRowsFinal.some((r) => r.id === unmovedId)).toBe(true);
    expect(aRowsFinal.some((r) => r.id === newRow.id)).toBe(false);

    // review MAJOR 2: code_chunks_fts must stay in step with code_chunks on every delete, not just on insert.
    const ftsCount = m.prepare("SELECT COUNT(*) AS n FROM code_chunks_fts").get().n;
    const chunkCount = m.prepare("SELECT COUNT(*) AS n FROM code_chunks").get().n;
    expect(ftsCount).toBe(chunkCount);
    const search = await searchIndex(m, "extra", {});
    expect(search.chunks.some((c) => c.id === newRow.id)).toBe(false);
  });

  it("removing a file from git drops its chunks and its code_files row", async () => {
    await buildIndex(m, dir, { cfg: {} });
    git(dir, "rm", "-q", "src/b.mjs");
    commitAll(dir, "remove b");

    const result = await buildIndex(m, dir, { cfg: {} });
    expect(result.filesRemoved).toBe(1);
    expect(m.prepare("SELECT * FROM code_files WHERE path = 'src/b.mjs'").get()).toBeUndefined();
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE path = 'src/b.mjs'").get().n).toBe(0);

    // review MAJOR 2: the fts5 side loses its rows for the removed file too, and a search no longer finds it.
    const ftsCount = m.prepare("SELECT COUNT(*) AS n FROM code_chunks_fts").get().n;
    const chunkCount = m.prepare("SELECT COUNT(*) AS n FROM code_chunks").get().n;
    expect(ftsCount).toBe(chunkCount);
    const search = await searchIndex(m, "function", {});
    expect(search.chunks.every((c) => c.path !== "src/b.mjs")).toBe(true);
  });

  it("a renamed file re-indexes under the new path", async () => {
    await buildIndex(m, dir, { cfg: {} });
    git(dir, "mv", "src/b.mjs", "src/renamed.mjs");
    commitAll(dir, "rename b");

    const result = await buildIndex(m, dir, { cfg: {} });
    expect(result.filesRemoved).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(m.prepare("SELECT * FROM code_files WHERE path = 'src/b.mjs'").get()).toBeUndefined();
    expect(m.prepare("SELECT * FROM code_files WHERE path = 'src/renamed.mjs'").get()).toBeTruthy();
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE path = 'src/renamed.mjs'").get().n).toBeGreaterThan(0);
  });
});

describe("buildIndex: embedding", () => {
  beforeEach(() => {
    dir = repo({
      "src/a.mjs": "export function a() {\n  return 1;\n}\n",
      "src/b.mjs": "export function b() {\n  return 2;\n}\n",
    });
    m = openMemory(dir);
  });

  it("embeds pending chunks in batches with progress, under a fixed-vector fake with check:false", async () => {
    const progress = [];
    const provider = fakeProvider();
    const result = await buildIndex(m, dir, { cfg: {}, provider, batch: 1, check: false, onProgress: (p) => progress.push(p) });
    expect(result.check).toBe("skipped");
    expect(result.chunksEmbedded).toBe(result.chunks);
    expect(result.chunksFailed).toBe(0);
    expect(progress.length).toBe(result.chunks);
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding_model IS NULL").get().n).toBe(0);
  });

  it("a provider that is down counts chunksFailed and leaves chunks unembedded; a later build embeds them", async () => {
    const good = fakeProvider();
    await buildIndex(m, dir, { cfg: {}, provider: good, check: false });
    // Force a fresh round of pending chunks by editing a file.
    writeFileSync(join(dir, "src/a.mjs"), "export function a() {\n  return 100;\n}\n");
    commitAll(dir, "edit a");

    const down = downProvider({ model: good.model, dims: good.dims });
    const failedBuild = await buildIndex(m, dir, { cfg: {}, provider: down, check: false });
    expect(failedBuild.chunksFailed).toBeGreaterThan(0);
    expect(failedBuild.chunksEmbedded).toBe(0);
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding_model IS NULL").get().n).toBeGreaterThan(0);

    const laterBuild = await buildIndex(m, dir, { cfg: {}, provider: good, check: false });
    expect(laterBuild.chunksEmbedded).toBeGreaterThan(0);
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding_model IS NULL").get().n).toBe(0);
  });

  it("a new model/dims pair runs the sanity check, and a failing check embeds nothing", async () => {
    // The fixed-vector fake gives every sentence the same vector, so checkEmbeddingSanity fails on the margin.
    const provider = fakeProvider();
    const { pairs } = okPairs();
    const result = await buildIndex(m, dir, { cfg: {}, provider, pairs });
    expect(result.check).toBe("failed");
    expect(typeof result.reason).toBe("string");
    expect(result.chunksEmbedded).toBe(0);
    expect(m.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE embedding_model IS NOT NULL").get().n).toBe(0);
    const build = m.prepare("SELECT * FROM code_index_builds ORDER BY id DESC LIMIT 1").get();
    expect(build.reason).toBe(result.reason);
  });

  it("a new model/dims pair with a passing sanity check embeds normally", async () => {
    const { pairs, vectorsByText } = okPairs();
    const provider = sanityAwareProvider({ vectorsByText, dims: 2 });
    const result = await buildIndex(m, dir, { cfg: {}, provider, pairs });
    expect(result.check).toBe("ok");
    expect(result.chunksEmbedded).toBe(result.chunks);
  });

  it("check:false skips the sanity check entirely, embedding directly even against a non-semantic fake", async () => {
    const provider = fakeProvider();
    const result = await buildIndex(m, dir, { cfg: {}, provider, check: false });
    expect(result.check).toBe("skipped");
    expect(result.chunksEmbedded).toBe(result.chunks);
  });
});

describe("buildIndex: duplicate chunk content (review MINOR 4)", () => {
  it("three identical blocks in one file each get a distinct row, not collapsed to one", async () => {
    // chunkLines:1 keeps each 1-line block its own chunk (no merging), so all three duplicate lines really do
    // become three separate, identically-texted chunks - the exact case a content-hash-only id collapses.
    const dupDir = repo({ "src/dup.mjs": "const x = 1;\n\nconst x = 1;\n\nconst x = 1;\n" });
    const dupM = openMemory(dupDir);
    try {
      const result = await buildIndex(dupM, dupDir, { cfg: { chunkLines: 1 } });
      expect(result.chunks).toBe(3);

      const fileRow = dupM.prepare("SELECT * FROM code_files WHERE path = 'src/dup.mjs'").get();
      expect(fileRow.chunks).toBe(3);

      const chunkRows = dupM.prepare("SELECT * FROM code_chunks WHERE path = 'src/dup.mjs' ORDER BY start_line").all();
      expect(chunkRows).toHaveLength(3);
      expect(new Set(chunkRows.map((r) => r.id)).size).toBe(3);
      expect(chunkRows.map((r) => [r.start_line, r.end_line])).toEqual([
        [1, 1],
        [3, 3],
        [5, 5],
      ]);
      expect(chunkRows.every((r) => r.text === "const x = 1;")).toBe(true);
      expect(dupM.prepare("SELECT COUNT(*) AS n FROM code_chunks_fts WHERE path = 'src/dup.mjs'").get().n).toBe(3);
    } finally {
      dupM.close();
      rmSync(dupDir, { recursive: true, force: true });
    }
  });
});

describe("indexStatus", () => {
  beforeEach(() => {
    dir = repo({
      "src/a.mjs": "export function a() {\n  return 1;\n}\n",
      "src/b.mjs": "export function b() {\n  return 2;\n}\n",
    });
    m = openMemory(dir);
  });

  it("reports every count 0 and built: never before the first build; refresh counts every indexable file as added", () => {
    const status = indexStatus(m, dir, { cfg: {} });
    expect(status.files).toBe(0);
    expect(status.chunks).toBe(0);
    expect(status.textBytes).toBe(0);
    expect(status.built).toBeNull();
    expect(status.refresh.added).toBe(2);
    expect(status.refresh.changed).toBe(0);
    expect(status.refresh.removed).toBe(0);
    expect(status.refresh.chunksToEmbed).toBeGreaterThan(0);
    expect(status.refresh.seconds).toBeNull();
    expect(status.refresh.rateReason).toBe("no measured build");
  });

  it("reports exact size counts after a build, and HEAD equality", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const status = indexStatus(m, dir, { cfg: {} });
    expect(status.files).toBe(2);
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.built.headSha).toBe(git(dir, "rev-parse", "HEAD"));
    expect(status.built.current).toBe(true);
    expect(status.refresh.added).toBe(0);
    expect(status.refresh.changed).toBe(0);
    expect(status.refresh.removed).toBe(0);
    expect(status.refresh.chunksToEmbed).toBe(0);

    writeFileSync(join(dir, "src/c.mjs"), "export const c = 3;\n");
    commitAll(dir, "add c");
    const afterAdd = indexStatus(m, dir, { cfg: {} });
    expect(afterAdd.built.current).toBe(false);
    expect(afterAdd.refresh.added).toBe(1);
  });

  it("chunks-to-embed equals what the next build then embeds, and rate/seconds are measured from the last build", async () => {
    // delayedProvider, not fakeProvider: an instant embed can round embed_seconds to 0, which would make the
    // "seconds is measured" assertion below flaky.
    const provider = delayedProvider();
    await buildIndex(m, dir, { cfg: {}, provider, check: false });

    writeFileSync(join(dir, "src/a.mjs"), "export function a() {\n  return 1;\n}\n\nexport function extra() {\n  return 2;\n}\n");
    commitAll(dir, "edit a");

    const status = indexStatus(m, dir, { cfg: {}, provider });
    expect(status.refresh.chunksToEmbed).toBeGreaterThan(0);
    expect(status.refresh.seconds).not.toBeNull();
    expect(typeof status.refresh.rateReason).not.toBe("string");

    const result = await buildIndex(m, dir, { cfg: {}, provider, check: false });
    expect(result.chunksEmbedded).toBe(status.refresh.chunksToEmbed);
  });

  it("(review MAJOR 1) a no-op rebuild does not wipe an earlier build's measured rate", async () => {
    // delayedProvider, not fakeProvider: a truly instant fake could otherwise round embed_seconds to 0 and
    // never qualify as "measured" in the first place, which would defeat this test's own premise.
    const provider = delayedProvider();
    const measured = await buildIndex(m, dir, { cfg: {}, provider, check: false });
    expect(measured.chunksEmbedded).toBeGreaterThan(0);
    expect(measured.embedSeconds).toBeGreaterThan(0);

    // Nothing changed: this build writes a code_index_builds row with chunks_embedded 0 (nothing pending), which
    // must never be read as "the rate" in place of the earlier real embed pass.
    const noop = await buildIndex(m, dir, { cfg: {}, provider, check: false });
    expect(noop.chunksEmbedded).toBe(0);

    writeFileSync(join(dir, "src/a.mjs"), "export function a() {\n  return 1;\n}\n\nexport function extra() {\n  return 2;\n}\n");
    commitAll(dir, "edit a");
    const status = indexStatus(m, dir, { cfg: {}, provider });
    expect(status.refresh.chunksToEmbed).toBeGreaterThan(0);
    expect(status.refresh.rateReason).toBeNull();
    expect(status.refresh.rate).toBeGreaterThan(0);
    expect(status.refresh.seconds).not.toBeNull();
  });

  it("reports embedded counts for the configured provider, and 'none' when no provider is given", async () => {
    const provider = fakeProvider();
    await buildIndex(m, dir, { cfg: {}, provider, check: false });
    const withProvider = indexStatus(m, dir, { cfg: {}, provider });
    expect(withProvider.provider).toBe("fake");
    expect(withProvider.embedded).toBe(withProvider.chunks);

    const withoutProvider = indexStatus(m, dir, { cfg: {} });
    expect(withoutProvider.provider).toBe("none");
    expect(withoutProvider.embedded).toBe(0);
  });
});

describe("searchIndex", () => {
  beforeEach(() => {
    dir = repo({
      "src/upload.mjs": "export function retryUpload() {\n  // retry flaky uploads\n  return true;\n}\n",
      "src/other.mjs": "export function unrelatedThing() {\n  return false;\n}\n",
    });
    m = openMemory(dir);
  });

  it("is keyword-only with no provider, returning a BM25 match with sides ['bm25']", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const result = await searchIndex(m, "retry flaky uploads", {});
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no provider configured");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].sides).toEqual(["bm25"]);
    expect(result.chunks[0].path).toBe("src/upload.mjs");
  });

  it("fuses bm25 and vector ranks with a fake provider, hybrid mode", async () => {
    const provider = fakeProvider({ vectorFor: () => [1, 0, 0] });
    await buildIndex(m, dir, { cfg: {}, provider, check: false });
    const result = await searchIndex(m, "retry flaky uploads", { provider });
    expect(result.mode).toBe("hybrid");
    expect(result.provider).toBe("fake");
    const hit = result.chunks.find((c) => c.path === "src/upload.mjs");
    expect(hit).toBeTruthy();
    expect(hit.sides.sort()).toEqual(["bm25", "vector"]);
  });

  it("restricts candidates on both sides with files globs", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const result = await searchIndex(m, "function", { files: ["src/other.mjs"] });
    for (const c of result.chunks) expect(c.path).toBe("src/other.mjs");
  });

  it("(review MINOR 5) a glob matching several paths still restricts every candidate, without an unbounded IN(...) list", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const result = await searchIndex(m, "function", { files: ["src/*.mjs"] });
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) expect(c.path).toMatch(/^src\//);
  });

  it("(review MAJOR 3) keyword-only, naming the exact model/dims pair, when stored vectors exist only under a different pair", async () => {
    const other = fakeProvider({ model: "other-model", dims: 8, vectorFor: () => [1, 0, 0, 0, 0, 0, 0, 0] });
    await buildIndex(m, dir, { cfg: {}, provider: other, check: false });
    const queryProvider = fakeProvider({ model: "fake-model", dims: 3 });
    const result = await searchIndex(m, "retry flaky uploads", { provider: queryProvider });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no vectors stored for fake-model/3");
  });

  it("(review MAJOR 3) only rows under the matching model/dims pair reach the vector side, even when another row carries a different pair's vector", async () => {
    await buildIndex(m, dir, { cfg: {} }); // no provider: just creates the chunk rows
    const uploadRow = m.prepare("SELECT id FROM code_chunks WHERE path = 'src/upload.mjs'").get();
    const otherRow = m.prepare("SELECT id FROM code_chunks WHERE path = 'src/other.mjs'").get();
    const blobFor = (vals) => Buffer.from(Float32Array.from(vals).buffer);
    m.prepare("UPDATE code_chunks SET embedding_model = 'fake-model', embedding_dims = 3, embedding = ? WHERE id = ?").run(
      blobFor([1, 0, 0]),
      uploadRow.id
    );
    m.prepare("UPDATE code_chunks SET embedding_model = 'other-model', embedding_dims = 8, embedding = ? WHERE id = ?").run(
      blobFor([0, 1, 0, 0, 0, 0, 0, 0]),
      otherRow.id
    );

    const provider = fakeProvider({ model: "fake-model", dims: 3, vectorFor: () => [1, 0, 0] });
    const result = await searchIndex(m, "function", { provider });
    expect(result.mode).toBe("hybrid");
    const uploadHit = result.chunks.find((c) => c.id === uploadRow.id);
    expect(uploadHit.sides).toContain("vector");
    // src/other.mjs's chunk also mentions "function" (bm25 side is legitimate), but its vector is stored under a
    // different pair - the WHERE embedding_model/dims filter must keep it off the vector side entirely.
    const otherHit = result.chunks.find((c) => c.id === otherRow.id);
    if (otherHit) expect(otherHit.sides).not.toContain("vector");
  });

  it("falls back to keyword-only, naming the reason, when the provider fails at query time", async () => {
    const good = fakeProvider();
    await buildIndex(m, dir, { cfg: {}, provider: good, check: false });
    const down = downProvider({ model: good.model, dims: good.dims });
    const result = await searchIndex(m, "retry flaky uploads", { provider: down });
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("connection refused");
  });

  it("a query with no FTS tokens returns [], not a throw", async () => {
    await buildIndex(m, dir, { cfg: {} });
    const result = await searchIndex(m, "!!! ??? ...", {});
    expect(result.chunks).toEqual([]);
  });
});
