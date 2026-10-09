import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readMemoryConfig, readIndexConfig, createProvider, probeProvider, doctorReport, checkEmbeddingSanity, loadSanityPairs, DEFAULT_SANITY_PAIRS } from "../lib/embeddings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doug-embeddings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(embeddings) {
  mkdirSync(join(dir, ".doug"), { recursive: true });
  writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { embeddings } }), "utf8");
}

function vec(n, fill) {
  return Array.from({ length: n }, (_, i) => fill ?? (i + 1) / n);
}

// A tiny HTTP server standing in for Ollama/llama-server/Voyage. `handler(req, body)` returns
// { status, json } or null to hang the connection past the caller's timeout.
function startServer(handler) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      const result = handler(req, body);
      if (result === null) return; // never respond: exercises the client timeout
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

describe("readMemoryConfig", () => {
  it("defaults to embeddings: null when .doug/config.json is missing", () => {
    expect(readMemoryConfig(dir)).toEqual({ embeddings: null });
  });

  it("defaults to embeddings: null when the file is unreadable JSON", () => {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), "{ not json", "utf8");
    expect(readMemoryConfig(dir)).toEqual({ embeddings: null });
  });

  it("defaults to embeddings: null when memory.embeddings is absent", () => {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ version: 1 }), "utf8");
    expect(readMemoryConfig(dir)).toEqual({ embeddings: null });
  });

  it("reads a valid openai-compatible shape", () => {
    writeConfig({ provider: "openai-compatible", baseUrl: "http://localhost:11434", model: "embeddinggemma", dims: 512 });
    expect(readMemoryConfig(dir)).toEqual({
      embeddings: { provider: "openai-compatible", baseUrl: "http://localhost:11434", model: "embeddinggemma", dims: 512, apiKeyEnv: undefined },
    });
  });

  it("treats an invalid shape as null and reports once on stderr", () => {
    writeConfig({ provider: "bogus", baseUrl: "x", model: "m", dims: 4 });
    const spy = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => {
      spy.push(s);
      return true;
    };
    try {
      expect(readMemoryConfig(dir)).toEqual({ embeddings: null });
    } finally {
      process.stderr.write = orig;
    }
    expect(spy.join("")).toMatch(/memory\.embeddings is not a valid shape/);
  });

  it("treats a missing dims or model as invalid", () => {
    writeConfig({ provider: "voyage", baseUrl: "https://api.voyageai.com" });
    expect(readMemoryConfig(dir)).toEqual({ embeddings: null });
  });
});

function writeIndexConfig(index) {
  mkdirSync(join(dir, ".doug"), { recursive: true });
  writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { index } }), "utf8");
}

describe("readIndexConfig", () => {
  it("defaults to the off shape when .doug/config.json is missing", () => {
    expect(readIndexConfig(dir)).toEqual({ enabled: false, include: [], exclude: [], chunkLines: 60 });
  });

  it("defaults to the off shape when the file is unreadable JSON", () => {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), "{ not json", "utf8");
    expect(readIndexConfig(dir)).toEqual({ enabled: false, include: [], exclude: [], chunkLines: 60 });
  });

  it("defaults to the off shape when memory.index is absent or null", () => {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ version: 1 }), "utf8");
    expect(readIndexConfig(dir)).toEqual({ enabled: false, include: [], exclude: [], chunkLines: 60 });
    writeIndexConfig(null);
    expect(readIndexConfig(dir)).toEqual({ enabled: false, include: [], exclude: [], chunkLines: 60 });
  });

  it("reads a valid shape, defaulting include/exclude/chunkLines when absent", () => {
    writeIndexConfig({ enabled: true });
    expect(readIndexConfig(dir)).toEqual({ enabled: true, include: [], exclude: [], chunkLines: 60 });
  });

  it("reads a fully-specified valid shape", () => {
    writeIndexConfig({ enabled: true, include: ["src/**"], exclude: ["**/*.test.mjs"], chunkLines: 40 });
    expect(readIndexConfig(dir)).toEqual({ enabled: true, include: ["src/**"], exclude: ["**/*.test.mjs"], chunkLines: 40 });
  });

  it("treats a non-object, and each invalid field type, as the off shape and reports once on stderr", () => {
    const bad = [
      { enabled: "yes" },
      { enabled: true, include: "src/**" },
      { enabled: true, exclude: [1, 2] },
      { enabled: true, chunkLines: 0 },
      { enabled: true, chunkLines: 1.5 },
      "not-an-object",
      42,
    ];
    for (const value of bad) {
      writeIndexConfig(value);
      const spy = [];
      const orig = process.stderr.write;
      process.stderr.write = (s) => {
        spy.push(s);
        return true;
      };
      try {
        expect(readIndexConfig(dir), JSON.stringify(value)).toEqual({ enabled: false, include: [], exclude: [], chunkLines: 60 });
      } finally {
        process.stderr.write = orig;
      }
      expect(spy.join(""), JSON.stringify(value)).toMatch(/memory\.index is not a valid shape/);
    }
  });

  it("never throws", () => {
    writeIndexConfig({ enabled: true, chunkLines: "sixty" });
    expect(() => readIndexConfig(dir)).not.toThrow();
  });
});

describe("createProvider: openai-compatible", () => {
  it("returns null when no provider is configured", () => {
    expect(createProvider({ embeddings: null })).toBeNull();
  });

  it("POSTs model/input/dimensions, an ordered response round-trips normalized vectors", async () => {
    let seenBody = null;
    let seenHeaders = null;
    const server = await startServer((req, body) => {
      seenBody = body;
      seenHeaders = req.headers;
      return {
        status: 200,
        json: {
          object: "list",
          data: [
            { object: "embedding", index: 1, embedding: [0, 1] },
            { object: "embedding", index: 0, embedding: [3, 4] },
          ],
          model: "embeddinggemma",
        },
      };
    });
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 2 } };
      const provider = createProvider(cfg);
      const result = await provider.embed(["hello", "world"], { inputType: "document" });
      expect(result.ok).toBe(true);
      expect(result.vectors).toHaveLength(2);
      // index 0 -> [3,4] normalized to [0.6, 0.8]; index 1 -> [0,1] normalized to [0,1]
      expect(result.vectors[0][0]).toBeCloseTo(0.6, 5);
      expect(result.vectors[0][1]).toBeCloseTo(0.8, 5);
      expect(result.vectors[1][0]).toBeCloseTo(0, 5);
      expect(result.vectors[1][1]).toBeCloseTo(1, 5);
      expect(seenBody).toEqual({ model: "embeddinggemma", input: ["title: none | text: hello", "title: none | text: world"], dimensions: 2 });
      expect(seenHeaders.authorization).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("sends a query prefix for embeddinggemma and no prefix for an unlisted model", async () => {
    const seenInputs = [];
    const server = await startServer((req, body) => {
      seenInputs.push(body.input);
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) } };
    });
    try {
      const gemma = createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 2 } });
      await gemma.embed(["q"], { inputType: "query" });
      expect(seenInputs[0]).toEqual(["task: search result | query: q"]);

      const nomic = createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "nomic-embed-text", dims: 2 } });
      await nomic.embed(["q"], { inputType: "query" });
      expect(seenInputs[1]).toEqual(["search_query: q"]);
      await nomic.embed(["d"], { inputType: "document" });
      expect(seenInputs[2]).toEqual(["search_document: d"]);

      const other = createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "mystery-model", dims: 2 } });
      await other.embed(["q"], { inputType: "query" });
      expect(seenInputs[3]).toEqual(["q"]);
    } finally {
      server.close();
    }
  });

  it("prefixes queries only for mxbai-embed-large and qwen3-embedding, never documents", async () => {
    const seenInputs = [];
    const server = await startServer((req, body) => {
      seenInputs.push(body.input);
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) } };
    });
    const mk = (model) => createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model, dims: 2 } });
    const mxbaiPrefix = "Represent this sentence for searching relevant passages: ";
    const qwenPrefix = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";
    try {
      for (const model of ["mxbai-embed-large", "mxbai-embed-large:latest"]) {
        seenInputs.length = 0;
        await mk(model).embed(["q"], { inputType: "query" });
        await mk(model).embed(["d"], { inputType: "document" });
        expect(seenInputs[0]).toEqual([mxbaiPrefix + "q"]);
        expect(seenInputs[0][0]).toBe("Represent this sentence for searching relevant passages: q");
        expect(seenInputs[1]).toEqual(["d"]);
      }
      for (const model of ["qwen3-embedding:0.6b", "qwen3-embedding"]) {
        seenInputs.length = 0;
        await mk(model).embed(["q"], { inputType: "query" });
        await mk(model).embed(["d"], { inputType: "document" });
        expect(seenInputs[0]).toEqual([qwenPrefix + "q"]);
        expect(seenInputs[0][0]).toBe("Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:q");
        expect(seenInputs[1]).toEqual(["d"]);
      }
    } finally {
      server.close();
    }
  });

  describe("prefix matching on HF-style model names", () => {
    const mxbaiPrefix = "Represent this sentence for searching relevant passages: ";
    const qwenPrefix = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";
    const seenInputs = [];
    let server;
    const mk = (model) => createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model, dims: 2 } });
    async function run(model) {
      seenInputs.length = 0;
      await mk(model).embed(["q"], { inputType: "query" });
      await mk(model).embed(["d"], { inputType: "document" });
      return { query: seenInputs[0], document: seenInputs[1] };
    }

    beforeEach(async () => {
      seenInputs.length = 0;
      server = await startServer((req, body) => {
        seenInputs.push(body.input);
        return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) } };
      });
    });
    afterEach(() => {
      server.close();
    });

    it("case 1: Qwen/Qwen3-Embedding-0.6B gets the qwen3 query prefix, documents none", async () => {
      const r = await run("Qwen/Qwen3-Embedding-0.6B");
      expect(r.query).toEqual([qwenPrefix + "q"]);
      expect(r.document).toEqual(["d"]);
    });

    it("case 2: mixedbread-ai/mxbai-embed-large-v1 gets the mxbai query prefix, documents none", async () => {
      const r = await run("mixedbread-ai/mxbai-embed-large-v1");
      expect(r.query).toEqual([mxbaiPrefix + "q"]);
      expect(r.document).toEqual(["d"]);
    });

    it("case 3: nomic-ai/nomic-embed-text-v1.5 gets search_query: and search_document:", async () => {
      const r = await run("nomic-ai/nomic-embed-text-v1.5");
      expect(r.query).toEqual(["search_query: q"]);
      expect(r.document).toEqual(["search_document: d"]);
      // the org here starts with "nomic" so a startsWith on the full name already matches; an org that does not makes the basename strip load-bearing
      const other = await run("someorg/Nomic-Embed-Text-v1.5");
      expect(other.query).toEqual(["search_query: q"]);
      expect(other.document).toEqual(["search_document: d"]);
    });

    it("case 4: google/embeddinggemma-300m gets the gemma query and document prefixes", async () => {
      const r = await run("google/embeddinggemma-300m");
      expect(r.query).toEqual(["task: search result | query: q"]);
      expect(r.document).toEqual(["title: none | text: d"]);
    });

    it("case 5: hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0 gets the qwen3 query prefix", async () => {
      const r = await run("hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0");
      expect(r.query).toEqual([qwenPrefix + "q"]);
      expect(r.document).toEqual(["d"]);
    });

    it("case 6: unlisted BAAI/bge-small-en-v1.5 gets no prefix", async () => {
      const r = await run("BAAI/bge-small-en-v1.5");
      expect(r.query).toEqual(["q"]);
      expect(r.document).toEqual(["d"]);
    });

    const gemma = { query: "task: search result | query: q", document: "title: none | text: d" };
    const nomic = { query: "search_query: q", document: "search_document: d" };
    it.each([
      ["../models/embeddinggemma-300M-Q8_0.gguf", gemma],
      ["C:\\models\\nomic-embed-text-v1.5.Q8_0.gguf", nomic],
      ["embeddinggemma:latest", gemma],
      ["nomic-embed-text:latest", nomic],
      ["text-embedding-nomic-embed-text-v1.5", nomic],
    ])("case 7: local server id %s gets its family prefixes", async (id, want) => {
      const r = await run(id);
      expect(r.query).toEqual([want.query]);
      expect(r.document).toEqual([want.document]);
    });

    it.each(["text-embedding-3-small", "gemma4:latest"])("case 8: %s gets no prefix", async (id) => {
      const r = await run(id);
      expect(r.query).toEqual(["q"]);
      expect(r.document).toEqual(["d"]);
    });
  });

  it("sends a Bearer header only when the configured env var is set", async () => {
    const seenAuth = [];
    const server = await startServer((req, body) => {
      seenAuth.push(req.headers.authorization || null);
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) } };
    });
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 2, apiKeyEnv: "TEST_EMB_KEY" } };
      const provider = createProvider(cfg);
      delete process.env.TEST_EMB_KEY;
      await provider.embed(["x"]);
      expect(seenAuth[0]).toBeNull();
      process.env.TEST_EMB_KEY = "secret-value";
      try {
        await provider.embed(["x"]);
      } finally {
        delete process.env.TEST_EMB_KEY;
      }
      expect(seenAuth[1]).toBe("Bearer secret-value");
    } finally {
      server.close();
    }
  });

  it("truncates and re-normalizes when the server returns 768 dims for a 512-dim request", async () => {
    const server = await startServer((req, body) => {
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: vec(768) })) } };
    });
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 } };
      const result = await createProvider(cfg).embed(["x"]);
      expect(result.ok).toBe(true);
      expect(result.vectors[0]).toHaveLength(512);
      let sumSq = 0;
      for (const v of result.vectors[0]) sumSq += v * v;
      expect(Math.sqrt(sumSq)).toBeCloseTo(1, 4);
    } finally {
      server.close();
    }
  });

  it("reports ok:false with a clear reason when the response is shorter than dims", async () => {
    const server = await startServer((req, body) => ({ status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 2, 3] })) } }));
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 8 } };
      const result = await createProvider(cfg).embed(["x"]);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/wrong dims: got 3, expected 8/);
    } finally {
      server.close();
    }
  });

  it("(MAJOR 1) voyage: truncates and re-normalizes when the server returns more dims than asked", async () => {
    process.env.TEST_VOYAGE_DIMS_KEY = "k";
    const server = await startServer((req, body) => {
      if (req.url !== "/v1/embeddings") return { status: 404, json: {} };
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: vec(1024) })) } };
    });
    try {
      const cfg = { embeddings: { provider: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 512, apiKeyEnv: "TEST_VOYAGE_DIMS_KEY" } };
      const result = await createProvider(cfg).embed(["x"]);
      expect(result.ok).toBe(true);
      expect(result.vectors[0]).toHaveLength(512);
      let sumSq = 0;
      for (const v of result.vectors[0]) sumSq += v * v;
      expect(Math.sqrt(sumSq)).toBeCloseTo(1, 4);
    } finally {
      delete process.env.TEST_VOYAGE_DIMS_KEY;
      server.close();
    }
  });

  it("(MAJOR 1) voyage: reports ok:false with wrong dims when the server returns fewer dims than asked", async () => {
    process.env.TEST_VOYAGE_SHORT_KEY = "k";
    const server = await startServer((req, body) => {
      if (req.url !== "/v1/embeddings") return { status: 404, json: {} };
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 2, 3] })) } };
    });
    try {
      const cfg = { embeddings: { provider: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 8, apiKeyEnv: "TEST_VOYAGE_SHORT_KEY" } };
      const result = await createProvider(cfg).embed(["x"]);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/wrong dims: got 3, expected 8/);
    } finally {
      delete process.env.TEST_VOYAGE_SHORT_KEY;
      server.close();
    }
  });

  it("times out within ~2.5s and reports ok:false when the server never responds", async () => {
    const server = await startServer(() => null);
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 2 } };
      const provider = createProvider(cfg, { timeoutMs: 300 });
      const start = Date.now();
      const result = await provider.embed(["x"]);
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(false);
      expect(elapsed).toBeLessThan(2500);
    } finally {
      server.close();
    }
  }, 3000);

  it("reports ok:false, never throws, on connection refused", async () => {
    const cfg = { embeddings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "m", dims: 2 } };
    const result = await createProvider(cfg).embed(["x"]);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
  });

  it("batches over 100 texts into multiple requests", async () => {
    const batchSizes = [];
    const server = await startServer((req, body) => {
      batchSizes.push(body.input.length);
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) } };
    });
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 2 } };
      const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
      const result = await createProvider(cfg).embed(texts);
      expect(result.ok).toBe(true);
      expect(result.vectors).toHaveLength(150);
      expect(batchSizes).toEqual([100, 50]);
    } finally {
      server.close();
    }
  });
});

describe("createProvider: voyage", () => {
  it("posts input_type and output_dimension, and requires the api key", async () => {
    let seenBody = null;
    let seenAuth = null;
    const server = await startServer((req, body) => {
      if (req.url !== "/v1/embeddings") return { status: 404, json: {} };
      seenBody = body;
      seenAuth = req.headers.authorization;
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 1] })) } };
    });
    try {
      const cfg = { embeddings: { provider: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 2, apiKeyEnv: "TEST_VOYAGE_KEY" } };
      const provider = createProvider(cfg);
      delete process.env.TEST_VOYAGE_KEY;
      const noKey = await provider.embed(["x"], { inputType: "query" });
      expect(noKey.ok).toBe(false);
      expect(noKey.reason).toMatch(/missing API key/);

      process.env.TEST_VOYAGE_KEY = "voy-secret";
      try {
        const result = await provider.embed(["x"], { inputType: "query" });
        expect(result.ok).toBe(true);
      } finally {
        delete process.env.TEST_VOYAGE_KEY;
      }
      expect(seenBody).toEqual({ input: ["x"], model: "voyage-4", input_type: "query", output_dimension: 2 });
      expect(seenAuth).toBe("Bearer voy-secret");
    } finally {
      server.close();
    }
  });
});

describe("probeProvider", () => {
  it("probes a fake Ollama's /api/version and /api/tags, reports kind ollama, and matches modelPresent on the name before ':' (MINOR 6)", async () => {
    const server = await startServer((req) => {
      if (req.url === "/api/version") return { status: 200, json: { version: "0.30.10" } };
      if (req.url === "/api/tags") return { status: 200, json: { models: [{ name: "embeddinggemma:latest", model: "embeddinggemma:latest" }] } };
      return { status: 404, json: {} };
    });
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 } };
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(true);
      expect(probe.kind).toBe("ollama");
      expect(probe.version).toBe("0.30.10");
      expect(Array.isArray(probe.models)).toBe(true);
      expect(probe.modelPresent).toBe(true);
    } finally {
      server.close();
    }
  });

  it("reports unreachable, never throwing, when there is no server", async () => {
    const cfg = { embeddings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "m", dims: 2 } };
    const probe = await probeProvider(cfg);
    expect(probe.reachable).toBe(false);
    expect(typeof probe.reason).toBe("string");
  });

  it("an unconfigured probe uses DOUG_OLLAMA_BASE_URL when set (card doctor-probe-env-override)", async () => {
    const hits = [];
    const server = await startServer((req) => {
      hits.push(req.url);
      if (req.url === "/api/version") return { status: 200, json: { version: "0.30.10" } };
      if (req.url === "/api/tags") return { status: 200, json: { models: [] } };
      return { status: 404, json: {} };
    });
    const prev = process.env.DOUG_OLLAMA_BASE_URL;
    try {
      process.env.DOUG_OLLAMA_BASE_URL = serverUrl(server);
      const probe = await probeProvider({ embeddings: null });
      expect(probe.reachable).toBe(true);
      expect(probe.kind).toBe("ollama");
      expect(hits).toContain("/api/version");
    } finally {
      if (prev === undefined) delete process.env.DOUG_OLLAMA_BASE_URL;
      else process.env.DOUG_OLLAMA_BASE_URL = prev;
      server.close();
    }
  });

  it("probes a bare embed call for a non-Ollama-like provider (voyage), falling back off a 404 /api/version", async () => {
    const server = await startServer((req, body) => {
      if (req.url !== "/v1/embeddings") return { status: 404, json: {} };
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 1] })) } };
    });
    try {
      process.env.TEST_VOYAGE_PROBE_KEY = "k";
      const cfg = { embeddings: { provider: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 2, apiKeyEnv: "TEST_VOYAGE_PROBE_KEY" } };
      const probe = await probeProvider(cfg);
      expect(probe.embedOk).toBe(true);
      expect(probe.reachable).toBe(true);
      expect(probe.kind).toBe("openai-compatible");
    } finally {
      delete process.env.TEST_VOYAGE_PROBE_KEY;
      server.close();
    }
  });

  it("(MAJOR 2) falls back to an embed probe, kind openai-compatible, and doctorReport prints no install command, when a real server (e.g. llama-server) has /v1/embeddings but no /api/version", async () => {
    const server = await startServer((req, body) => {
      if (req.url === "/v1/embeddings") return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) } };
      return { status: 404, json: {} };
    });
    try {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 2 } };
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(true);
      expect(probe.embedOk).toBe(true);
      expect(probe.kind).toBe("openai-compatible");
      const report = doctorReport(cfg, probe, "darwin");
      expect(report).not.toMatch(/install|brew install|winget install|curl -fsSL/i);
    } finally {
      server.close();
    }
  });

  it("(review #1) reports kind ollama and doctorReport prints the install and pull lines when the configured Ollama preset (localhost:11434) is down, even via the embed fallback", async () => {
    // No real server: a fetch that always fails, decoupled from whatever is or isn't actually listening on the
    // real port 11434 in this environment.
    const alwaysFailFetch = async () => {
      throw new Error("connection refused (simulated)");
    };
    for (const baseUrl of ["http://localhost:11434", "http://127.0.0.1:11434"]) {
      const cfg = { embeddings: { provider: "openai-compatible", baseUrl, model: "embeddinggemma", dims: 512 } };
      const probe = await probeProvider(cfg, { fetch: alwaysFailFetch, timeoutMs: 200 });
      expect(probe.reachable, baseUrl).toBe(false);
      expect(probe.kind, baseUrl).toBe("ollama");
      const report = doctorReport(cfg, probe, "darwin");
      expect(report, baseUrl).toMatch(/brew install ollama/);
      expect(report, baseUrl).toMatch(/ollama pull embeddinggemma/);
    }
  });

  it("(review #1) stays kind openai-compatible when down at a host:port that is not the Ollama preset", async () => {
    const alwaysFailFetch = async () => {
      throw new Error("connection refused (simulated)");
    };
    const cfg = { embeddings: { provider: "openai-compatible", baseUrl: "http://localhost:8080", model: "m", dims: 2 } };
    const probe = await probeProvider(cfg, { fetch: alwaysFailFetch, timeoutMs: 200 });
    expect(probe.reachable).toBe(false);
    expect(probe.kind).toBe("openai-compatible");
    const report = doctorReport(cfg, probe, "darwin");
    expect(report).not.toMatch(/install|brew install|winget install|curl -fsSL/i);
  });
});

// A stub provider whose embed() looks each text up in a fixed map, ignoring inputType — checkEmbeddingSanity
// only cares that all sentences go out in one call and come back in the same order.
function fakeProvider(vectorsByText) {
  return {
    model: "fake",
    dims: 2,
    async embed(texts) {
      return { ok: true, vectors: texts.map((t) => Float32Array.from(vectorsByText[t])) };
    },
  };
}

describe("checkEmbeddingSanity", () => {
  it("ok, with the right gap and means, when paraphrases are close and unrelated pairs are far", async () => {
    const vectorsByText = {
      p1a: [1, 0],
      p1b: [0.9, Math.sqrt(1 - 0.9 * 0.9)],
      p2a: [0, 1],
      p2b: [Math.sqrt(1 - 0.9 * 0.9), 0.9],
      u1a: [1, 0],
      u1b: [0.1, Math.sqrt(1 - 0.1 * 0.1)],
      u2a: [0, 1],
      u2b: [Math.sqrt(1 - 0.1 * 0.1), 0.1],
    };
    const pairs = {
      margin: 0.15,
      paraphrase: [
        ["p1a", "p1b"],
        ["p2a", "p2b"],
      ],
      unrelated: [
        ["u1a", "u1b"],
        ["u2a", "u2b"],
      ],
    };
    const result = await checkEmbeddingSanity(fakeProvider(vectorsByText), pairs);
    expect(result.ok).toBe(true);
    expect(result.margin).toBe(0.15);
    expect(result.gap).toBeCloseTo(0.8, 5);
    expect(result.paraphrase.mean).toBeCloseTo(0.9, 5);
    expect(result.paraphrase.min).toBeCloseTo(0.9, 5);
    expect(result.unrelated.mean).toBeCloseTo(0.1, 5);
    expect(result.unrelated.max).toBeCloseTo(0.1, 5);
    expect(result.failures).toEqual([]);
    expect(result.reason).toBeNull();
  });

  it("not ok on all-identical vectors: gap 0, failures empty (fails on the margin only), reason names the margin", async () => {
    const vectorsByText = { p1a: [1, 0], p1b: [1, 0], p2a: [1, 0], p2b: [1, 0], u1a: [1, 0], u1b: [1, 0], u2a: [1, 0], u2b: [1, 0] };
    const pairs = {
      margin: 0.15,
      paraphrase: [
        ["p1a", "p1b"],
        ["p2a", "p2b"],
      ],
      unrelated: [
        ["u1a", "u1b"],
        ["u2a", "u2b"],
      ],
    };
    const result = await checkEmbeddingSanity(fakeProvider(vectorsByText), pairs);
    expect(result.ok).toBe(false);
    expect(result.gap).toBeCloseTo(0, 5);
    expect(result.failures).toEqual([]);
    expect(result.reason).toMatch(/margin 0\.15/);
  });

  it("lists a paraphrase pair scoring below the unrelated mean in failures, without flagging one that scores above it", async () => {
    const vectorsByText = {
      p1a: [1, 0],
      p1b: [0.9, Math.sqrt(1 - 0.9 * 0.9)],
      p2a: [0, 1],
      p2b: [Math.sqrt(1 - 0.2 * 0.2), 0.2],
      u1a: [1, 0],
      u1b: [0.5, Math.sqrt(1 - 0.5 * 0.5)],
      u2a: [0, 1],
      u2b: [Math.sqrt(1 - 0.5 * 0.5), 0.5],
    };
    const pairs = {
      margin: 0.15,
      paraphrase: [
        ["p1a", "p1b"],
        ["p2a", "p2b"],
      ],
      unrelated: [
        ["u1a", "u1b"],
        ["u2a", "u2b"],
      ],
    };
    const result = await checkEmbeddingSanity(fakeProvider(vectorsByText), pairs);
    expect(result.ok).toBe(false);
    expect(result.unrelated.mean).toBeCloseTo(0.5, 5);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].pair).toEqual(["p2a", "p2b"]);
    expect(result.failures[0].cosine).toBeCloseTo(0.2, 5);
  });

  it("passes a provider error straight through as { ok:false, reason }", async () => {
    const provider = { model: "fake", dims: 2, async embed() { return { ok: false, reason: "connection refused" }; } };
    const pairs = { margin: 0.15, paraphrase: [["a", "b"]], unrelated: [["c", "d"]] };
    const result = await checkEmbeddingSanity(provider, pairs);
    expect(result).toEqual({ ok: false, reason: "connection refused" });
  });
});

describe("loadSanityPairs", () => {
  it("loads a valid 12+12 pairs file", () => {
    const file = join(dir, "pairs.json");
    const paraphrase = Array.from({ length: 12 }, (_, i) => [`p${i}a`, `p${i}b`]);
    const unrelated = Array.from({ length: 12 }, (_, i) => [`u${i}a`, `u${i}b`]);
    writeFileSync(file, JSON.stringify({ margin: 0.15, paraphrase, unrelated }), "utf8");
    const loaded = loadSanityPairs(file);
    expect(loaded.margin).toBe(0.15);
    expect(loaded.paraphrase).toHaveLength(12);
    expect(loaded.unrelated).toHaveLength(12);
  });

  it("throws a clear message on a missing margin", () => {
    const file = join(dir, "pairs.json");
    const twelve = Array.from({ length: 12 }, (_, i) => [`x${i}a`, `x${i}b`]);
    writeFileSync(file, JSON.stringify({ paraphrase: twelve, unrelated: twelve }), "utf8");
    expect(() => loadSanityPairs(file)).toThrow(/"margin" must be a number/);
  });

  it("throws a clear message when a list does not have exactly 12 pairs", () => {
    const file = join(dir, "pairs.json");
    writeFileSync(file, JSON.stringify({ margin: 0.15, paraphrase: [["a", "b"]], unrelated: [] }), "utf8");
    expect(() => loadSanityPairs(file)).toThrow(/"paraphrase" must be an array of exactly 12 pairs/);
  });

  it("throws a clear message on a malformed pair entry", () => {
    const file = join(dir, "pairs.json");
    const twelve = Array.from({ length: 12 }, (_, i) => [`x${i}a`, `x${i}b`]);
    const bad = [...twelve.slice(1), ["only-one"]];
    writeFileSync(file, JSON.stringify({ margin: 0.15, paraphrase: bad, unrelated: twelve }), "utf8");
    expect(() => loadSanityPairs(file)).toThrow(/"paraphrase" entries must each be a \[sentenceA, sentenceB\] pair/);
  });

  it("throws a clear message when the file does not exist", () => {
    expect(() => loadSanityPairs(join(dir, "missing.json"))).toThrow(/cannot read sanity pairs file/);
  });
});

describe("DEFAULT_SANITY_PAIRS", () => {
  const repoRoot = join(__dirname, "..", "..", "..");
  const pluginRoot = join(repoRoot, "plugins", "doug-flow");

  it("resolves under plugins/doug-flow/lib/data/pairs.json", () => {
    expect(DEFAULT_SANITY_PAIRS.replace(/\\/g, "/")).toMatch(/plugins\/doug-flow\/lib\/data\/pairs\.json$/);
  });

  it("is under an entry of plugins/doug-flow/package.json's files array", () => {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
    const relFromPlugin = relative(pluginRoot, DEFAULT_SANITY_PAIRS).replace(/\\/g, "/");
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files.some((entry) => relFromPlugin === entry || relFromPlugin.startsWith(`${entry}/`))).toBe(true);
  });

  it("loads with loadSanityPairs, returning at least 12 paraphrase and 12 unrelated pairs", () => {
    const loaded = loadSanityPairs(DEFAULT_SANITY_PAIRS);
    expect(loaded.paraphrase.length).toBeGreaterThanOrEqual(12);
    expect(loaded.unrelated.length).toBeGreaterThanOrEqual(12);
  });

  it("no longer has the pairs file at evals/memory/pairs.json (moved, not copied)", () => {
    expect(existsSync(join(repoRoot, "evals", "memory", "pairs.json"))).toBe(false);
  });
});

describe("doctorReport", () => {
  it("says keyword-only and gives the enable snippet when nothing is configured", () => {
    const probe = { reachable: false, kind: "ollama", version: null, models: null, modelPresent: false, embedOk: null, reason: "cannot reach http://localhost:11434" };
    const text = doctorReport({ embeddings: null }, probe, "darwin");
    expect(text).toMatch(/keyword-only/);
    expect(text).toMatch(/brew install ollama/);
    expect(text).toMatch(/ollama pull embeddinggemma/);
    expect(text).toMatch(/"provider": "openai-compatible"/);
  });

  it("gives the linux install command on linux and winget on win32", () => {
    const probe = { reachable: false, kind: "ollama", version: null, models: null, modelPresent: false, embedOk: null, reason: "x" };
    expect(doctorReport({ embeddings: null }, probe, "linux")).toMatch(/curl -fsSL https:\/\/ollama\.com\/install\.sh \| sh/);
    expect(doctorReport({ embeddings: null }, probe, "win32")).toMatch(/winget install Ollama\.Ollama/);
  });

  it("reports what a reachable, fully-present provider would use", () => {
    const cfg = { embeddings: { provider: "openai-compatible", baseUrl: "http://localhost:11434", model: "embeddinggemma", dims: 512 } };
    const probe = { reachable: true, kind: "ollama", version: "0.30.10", models: [{ name: "embeddinggemma" }], modelPresent: true, embedOk: null, reason: null };
    const text = doctorReport(cfg, probe, "darwin");
    expect(text).toMatch(/embeddinggemma\/512/);
    expect(text).not.toMatch(/keyword-only/);
  });

  it("(MAJOR 2) prints no install command for an unreachable, non-ollama-kind provider", () => {
    const cfg = { embeddings: { provider: "openai-compatible", baseUrl: "http://example.invalid:8080", model: "m", dims: 4 } };
    const probe = { reachable: false, kind: "openai-compatible", version: null, models: null, modelPresent: null, embedOk: false, reason: "request failed: fetch failed" };
    const text = doctorReport(cfg, probe, "darwin");
    expect(text).toMatch(/Not reachable/);
    expect(text).not.toMatch(/install|brew install|winget install|curl -fsSL/i);
  });
});

// Card embedding-providers-unsloth: provider presets, the dimensions-rejected retry, /v1/models detection.
// Every fake key is built at runtime so no credential-looking literal sits in the file.
const goodToken = ["unsloth", "test", "token", String(process.pid)].join("-");
const otherToken = ["unsloth", "other", "token", String(process.pid)].join("-");

function withEnv(name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

function norm(v) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

const DIMS_400 = { detail: "'dimensions' is not supported by ggml-org/embeddinggemma-300M-GGUF." };

function silenceStderr(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stderr.write = orig;
  }
}

describe("readMemoryConfig: presets", () => {
  it("the unsloth preset fills provider, baseUrl and apiKeyEnv", () => {
    writeConfig({ preset: "unsloth", model: "embeddinggemma", dims: 512 });
    const e = readMemoryConfig(dir).embeddings;
    expect(e).not.toBeNull();
    expect(e.provider).toBe("openai-compatible");
    expect(e.baseUrl).toBe("http://127.0.0.1:8888");
    expect(e.apiKeyEnv).toBe("UNSLOTH_API_KEY");
    expect(e.model).toBe("embeddinggemma");
    expect(e.dims).toBe(512);
  });

  it("explicit baseUrl and apiKeyEnv win over the preset", () => {
    writeConfig({ preset: "unsloth", baseUrl: "http://10.0.0.5:9999", apiKeyEnv: "MY_EMBED_ENV", model: "m", dims: 8 });
    const e = readMemoryConfig(dir).embeddings;
    expect(e.baseUrl).toBe("http://10.0.0.5:9999");
    expect(e.apiKeyEnv).toBe("MY_EMBED_ENV");
    expect(e.provider).toBe("openai-compatible");
  });

  it("the voyage preset fills the voyage provider and base", () => {
    writeConfig({ preset: "voyage", model: "voyage-4", dims: 512 });
    const e = readMemoryConfig(dir).embeddings;
    expect(e.provider).toBe("voyage");
    expect(e.baseUrl).toBe("https://api.voyageai.com");
    expect(e.apiKeyEnv).toBe("VOYAGE_API_KEY");
  });

  it("an unknown preset is an invalid shape: null plus a stderr note", () => {
    writeConfig({ preset: "bogus", provider: "openai-compatible", baseUrl: "http://x", model: "m", dims: 4 });
    const spy = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => (spy.push(s), true);
    try {
      expect(readMemoryConfig(dir)).toEqual({ embeddings: null });
    } finally {
      process.stderr.write = orig;
    }
    expect(spy.join("")).toMatch(/memory\.embeddings is not a valid shape/);
  });

  it("a preset still requires model and dims", () => {
    writeConfig({ preset: "unsloth" });
    expect(silenceStderr(() => readMemoryConfig(dir))).toEqual({ embeddings: null });
  });

  it("a no-preset config returns exactly today's object, with no extra keys", () => {
    writeConfig({ provider: "openai-compatible", baseUrl: "http://localhost:11434", model: "embeddinggemma", dims: 512 });
    const e = readMemoryConfig(dir).embeddings;
    expect(Object.keys(e).sort()).toEqual(["apiKeyEnv", "baseUrl", "dims", "model", "provider"]);
    expect("preset" in e).toBe(false);
  });
});

describe("createProvider: unsloth preset and dimensions retry", () => {
  it("the unsloth preset omits dimensions, truncates a 768-wide reply to unit vectors of dims, and sends the Bearer key", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    let seenBody = null;
    let seenAuth = null;
    const server = await startServer((req, body) => {
      seenBody = body;
      seenAuth = req.headers.authorization;
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: vec(768) })) } };
    });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 });
      const provider = createProvider(readMemoryConfig(dir));
      const result = await provider.embed(["a", "b"], { inputType: "document" });
      expect(result.ok).toBe(true);
      expect(seenBody).not.toBeNull();
      expect("dimensions" in seenBody).toBe(false);
      expect(seenBody.model).toBe("embeddinggemma");
      expect(seenAuth).toBe(`Bearer ${goodToken}`);
      expect(result.vectors).toHaveLength(2);
      for (const v of result.vectors) {
        expect(v).toHaveLength(512);
        expect(norm(v)).toBeCloseTo(1, 5);
      }
    } finally {
      server.close();
      restore();
    }
  });

  // Card local-provider-no-key: the refusal now applies to a non-local host only (a local server never needs a key).
  it("the unsloth preset with its key unset on a non-local host returns missing API key without calling the server", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" };
    };
    try {
      writeConfig({ preset: "unsloth", baseUrl: "https://example.com:8888", model: "m", dims: 4 });
      const provider = createProvider(readMemoryConfig(dir), { fetch: fetchImpl });
      const result = await provider.embed(["x"], { inputType: "document" });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing API key: set UNSLOTH_API_KEY");
      expect(calls).toBe(0);
    } finally {
      restore();
    }
  });

  it("an explicit apiKeyEnv wins: the missing-key message names it", async () => {
    const r1 = withEnv("UNSLOTH_API_KEY", otherToken);
    const r2 = withEnv("MY_OWN_EMBED_ENV", undefined);
    try {
      writeConfig({ preset: "unsloth", baseUrl: "https://example.com:8888", apiKeyEnv: "MY_OWN_EMBED_ENV", model: "m", dims: 4 });
      const neverFetch = async () => {
        throw new Error("fetch must not be called");
      };
      const result = await createProvider(readMemoryConfig(dir), { fetch: neverFetch }).embed(["x"], { inputType: "document" });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing API key: set MY_OWN_EMBED_ENV");
    } finally {
      r1();
      r2();
    }
  });

  it("retries once without dimensions on a 400 naming dimensions, truncates and renormalises, and remembers", async () => {
    const seen = [];
    const server = await startServer((req, body) => {
      seen.push(body);
      if ("dimensions" in body) return { status: 400, json: DIMS_400 };
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: vec(768) })) } };
    });
    try {
      const provider = createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 } });
      const first = await provider.embed(["a", "b"], { inputType: "document" });
      expect(first.ok).toBe(true);
      expect(first.vectors).toHaveLength(2);
      for (const v of first.vectors) {
        expect(v).toHaveLength(512);
        expect(norm(v)).toBeCloseTo(1, 5);
      }
      expect(seen).toHaveLength(2);
      expect("dimensions" in seen[0]).toBe(true);
      expect("dimensions" in seen[1]).toBe(false);

      const second = await provider.embed(["c"], { inputType: "document" });
      expect(second.ok).toBe(true);
      expect(second.vectors[0]).toHaveLength(512);
      expect(seen).toHaveLength(3);
      expect("dimensions" in seen[2]).toBe(false);
    } finally {
      server.close();
    }
  });

  it("does not retry a 400 whose body does not mention dimensions", async () => {
    let calls = 0;
    const server = await startServer(() => {
      calls++;
      return { status: 400, json: { detail: "input too long" } };
    });
    try {
      const provider = createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 4 } });
      const result = await provider.embed(["x"], { inputType: "document" });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/HTTP 400/);
      expect(calls).toBe(1);
    } finally {
      server.close();
    }
  });

  it("a no-preset openai-compatible config sends exactly {model, input, dimensions} and no authorization header with the key unset", async () => {
    const restore = withEnv("OPENAI_API_KEY", undefined);
    let seenBody = null;
    let seenHeaders = null;
    const server = await startServer((req, body) => {
      seenBody = body;
      seenHeaders = req.headers;
      return { status: 200, json: { data: [{ index: 0, embedding: [1, 0, 0, 0] }] } };
    });
    try {
      const provider = createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "some-model", dims: 4 } });
      const result = await provider.embed(["x"], { inputType: "document" });
      expect(result.ok).toBe(true);
      expect(Object.keys(seenBody).sort()).toEqual(["dimensions", "input", "model"]);
      expect(seenBody.dimensions).toBe(4);
      expect(seenHeaders.authorization).toBeUndefined();
    } finally {
      server.close();
      restore();
    }
  });
});

// A stand-in /v1/models server; `accept` is the Bearer token it takes (any other gets 401).
function modelsServer({ accept, models, onModels }) {
  return startServer((req) => {
    if (req.url === "/v1/models") {
      onModels?.(req);
      if (req.headers.authorization !== `Bearer ${accept}`) return { status: 401, json: { detail: "Not authenticated" } };
      return { status: 200, json: { object: "list", data: models } };
    }
    return { status: 404, json: {} };
  });
}

describe("probeProvider and doctorReport: unsloth preset", () => {
  it("a missing key on a non-local host is unreachable with a reason naming the env var, and makes no request", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    const server = { close() {} };
    try {
      writeConfig({ preset: "unsloth", baseUrl: "https://example.com:8888", model: "embeddinggemma", dims: 512 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg, { fetch: fetchImpl });
      expect(probe.reachable).toBe(false);
      expect(probe.reason).toBe("missing API key: set UNSLOTH_API_KEY");
      expect(calls).toBe(0);
      expect(doctorReport(cfg, probe, "darwin")).toMatch(/UNSLOTH_API_KEY/);
    } finally {
      server.close();
      restore();
    }
  });

  it("a 401 from a local /v1/models with a wrong key set says the server rejected the key, names the env var, and never prints the key", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", otherToken);
    const server = await modelsServer({ accept: goodToken, models: [] });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(false);
      expect(probe.reason).toBe("server rejected the key in UNSLOTH_API_KEY");
      const text = doctorReport(cfg, probe, "darwin");
      expect(text).toMatch(/UNSLOTH_API_KEY/);
      expect(text).not.toContain(otherToken);
      expect(JSON.stringify(probe)).not.toContain(otherToken);
    } finally {
      server.close();
      restore();
    }
  });

  it("a listed, loaded model: kind unsloth, modelPresent and modelLoaded true", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const server = await modelsServer({ accept: goodToken, models: [{ id: "ggml-org/embeddinggemma-300M-GGUF", loaded: true }] });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(true);
      expect(probe.kind).toBe("unsloth");
      expect(probe.modelPresent).toBe(true);
      expect(probe.modelLoaded).toBe(true);
      const text = doctorReport(cfg, probe, "darwin");
      expect(text).not.toMatch(/keyword-only/);
      expect(text).not.toMatch(/not loaded/i);
      expect(text).not.toMatch(/not listed/i);
    } finally {
      server.close();
      restore();
    }
  });

  it("a listed but not loaded model: modelLoaded false and a not-loaded doctor line", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const server = await modelsServer({ accept: goodToken, models: [{ id: "ggml-org/embeddinggemma-300M-GGUF", loaded: false }] });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(true);
      expect(probe.modelPresent).toBe(true);
      expect(probe.modelLoaded).toBe(false);
      expect(doctorReport(cfg, probe, "darwin")).toMatch(/not loaded/i);
    } finally {
      server.close();
      restore();
    }
  });

  it("a model not in the list: modelPresent false and a not-listed doctor line", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const server = await modelsServer({ accept: goodToken, models: [{ id: "unsloth/Qwen3-4B-GGUF", loaded: true }] });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(true);
      expect(probe.modelPresent).toBe(false);
      expect(doctorReport(cfg, probe, "darwin")).toMatch(/not listed/i);
    } finally {
      server.close();
      restore();
    }
  });

  it("matches a model by the last path segment with the :tag cut off, case-insensitively", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const server = await modelsServer({ accept: goodToken, models: [{ id: "ollama/Qwen3-Embedding:0.6b", loaded: true }] });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "qwen3-embedding", dims: 512 });
      const probe = await probeProvider(readMemoryConfig(dir));
      expect(probe.modelPresent).toBe(true);
      expect(probe.modelLoaded).toBe(true);
    } finally {
      server.close();
      restore();
    }
  });
});

describe("doctorReport: nothing configured", () => {
  it("prints one config snippet per preset", () => {
    const probe = { reachable: false, kind: "ollama", version: null, models: null, modelPresent: false, embedOk: null, reason: "cannot reach http://localhost:11434" };
    const text = doctorReport({ embeddings: null }, probe, "darwin");
    expect(text).toMatch(/keyword-only/);
    for (const p of ["ollama", "unsloth", "openai", "voyage"]) {
      expect(text, p).toMatch(new RegExp(`"preset": "${p}"`));
    }
    expect(text).toMatch(/UNSLOTH_API_KEY/);
  });

  it("keeps today's lines verbatim, then adds the per-preset snippets after them", () => {
    const probe = { reachable: false, kind: "ollama", version: null, models: null, modelPresent: false, embedOk: null, reason: "cannot reach http://localhost:11434" };
    const oldSnippet =
      '"memory": { "embeddings": { "provider": "openai-compatible", "baseUrl": "http://localhost:11434", "model": "embeddinggemma", "dims": 512 } }';
    const oldUnreachable = [
      "memory.embeddings is not configured in .doug/config.json; the store is keyword-only.",
      "No local Ollama found at http://localhost:11434 (cannot reach http://localhost:11434).",
      "Install it with: brew install ollama",
      "Then: ollama pull embeddinggemma",
      "Enable it by adding to .doug/config.json:",
      `  ${oldSnippet}`,
    ].join("\n");
    const text = doctorReport({ embeddings: null }, probe, "darwin");
    expect(text.startsWith(oldUnreachable)).toBe(true);
    const rest = text.slice(oldUnreachable.length);
    expect(rest.length).toBeGreaterThan(0);
    for (const p of ["ollama", "unsloth", "openai", "voyage"]) expect(rest, p).toMatch(new RegExp(`"preset": "${p}"`));

    const reachable = { reachable: true, kind: "ollama", version: "0.30.10", models: [], modelPresent: true, embedOk: null, reason: null };
    const oldReachable = [
      "memory.embeddings is not configured in .doug/config.json; the store is keyword-only.",
      "A local Ollama was found at http://localhost:11434 (version 0.30.10).",
      "The model it would use, embeddinggemma, is already pulled.",
      "Enable it by adding to .doug/config.json:",
      `  ${oldSnippet}`,
    ].join("\n");
    const text2 = doctorReport({ embeddings: null }, reachable, "darwin");
    expect(text2.startsWith(oldReachable)).toBe(true);
    expect(text2.slice(oldReachable.length)).toMatch(/"preset": "unsloth"/);
  });
});

describe("model listed rule for /v1/models (no :tag cut)", () => {
  async function listed(model, id) {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const server = await modelsServer({ accept: goodToken, models: [{ id, loaded: true }] });
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model, dims: 512 });
      const probe = await probeProvider(readMemoryConfig(dir));
      expect(probe.reachable).toBe(true);
      return probe.modelPresent;
    } finally {
      server.close();
      restore();
    }
  }

  it("a model name carrying a :tag matches the same id's last segment", async () => {
    expect(await listed("qwen3-embedding:0.6b", "ollama/qwen3-embedding:0.6b")).toBe(true);
  });

  it("embeddinggemma is listed by ggml-org/embeddinggemma-300M-GGUF (last segment prefix, case-insensitive)", async () => {
    expect(await listed("embeddinggemma", "ggml-org/embeddinggemma-300M-GGUF")).toBe(true);
  });

  it("gemma is not listed by ggml-org/embeddinggemma-300M-GGUF (a substring is not a prefix)", async () => {
    expect(await listed("gemma", "ggml-org/embeddinggemma-300M-GGUF")).toBe(false);
  });
});

describe("probeProvider and doctorReport: voyage preset", () => {
  it("makes no /api/version request, reports kind voyage, and works with the key", async () => {
    const restore = withEnv("VOYAGE_API_KEY", goodToken);
    const paths = [];
    const server = await startServer((req, body) => {
      paths.push(req.url);
      if (req.url !== "/v1/embeddings") return { status: 404, json: {} };
      return { status: 200, json: { data: body.input.map((_, i) => ({ index: i, embedding: [1, 1] })) } };
    });
    try {
      writeConfig({ preset: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 2 });
      const probe = await probeProvider(readMemoryConfig(dir));
      expect(probe.reachable).toBe(true);
      expect(probe.kind).toBe("voyage");
      expect(paths).not.toContain("/api/version");
      expect(paths).not.toContain("/api/tags");
    } finally {
      server.close();
      restore();
    }
  });

  it("with VOYAGE_API_KEY unset, the probe and the doctor name VOYAGE_API_KEY", async () => {
    const restore = withEnv("VOYAGE_API_KEY", undefined);
    const paths = [];
    const server = await startServer((req) => {
      paths.push(req.url);
      return { status: 200, json: { data: [] } };
    });
    try {
      writeConfig({ preset: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 2 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(false);
      expect(probe.reason).toMatch(/VOYAGE_API_KEY/);
      expect(doctorReport(cfg, probe, "darwin")).toMatch(/VOYAGE_API_KEY/);
      expect(paths).not.toContain("/api/version");
    } finally {
      server.close();
      restore();
    }
  });
});

describe("key redaction: a server that echoes the Authorization header in an error body", () => {
  const echo = (status) => (req) => ({ status, json: { detail: `rejected ${String(req.headers.authorization)} as ${String(req.headers.authorization).replace("Bearer ", "")}` } });

  it("the embed reason never contains the key: unsloth preset (400), no-preset with apiKeyEnv (500), voyage (400)", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const r2 = withEnv("MY_EMBED_ENV", otherToken);
    const r3 = withEnv("VOYAGE_API_KEY", goodToken);
    const s400 = await startServer(echo(400));
    const s500 = await startServer(echo(500));
    try {
      const a = await createProvider({ embeddings: { preset: "unsloth", provider: "openai-compatible", baseUrl: serverUrl(s400), model: "m", dims: 4, apiKeyEnv: "UNSLOTH_API_KEY" } }).embed(["x"], { inputType: "document" });
      expect(a.ok).toBe(false);
      expect(a.reason).toMatch(/HTTP 400/);
      expect(a.reason).not.toContain(goodToken);

      const b = await createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(s500), model: "m", dims: 4, apiKeyEnv: "MY_EMBED_ENV" } }).embed(["x"], { inputType: "document" });
      expect(b.ok).toBe(false);
      expect(b.reason).toMatch(/HTTP 500/);
      expect(b.reason).not.toContain(otherToken);

      const c = await createProvider({ embeddings: { provider: "voyage", baseUrl: serverUrl(s400), model: "voyage-4", dims: 4 } }).embed(["x"], { inputType: "document" });
      expect(c.ok).toBe(false);
      expect(c.reason).not.toContain(goodToken);
    } finally {
      s400.close();
      s500.close();
      restore();
      r2();
      r3();
    }
  });

  it("the embed-probe reason and doctorReport text never contain the key: voyage preset and no-preset with apiKeyEnv", async () => {
    const r1 = withEnv("VOYAGE_API_KEY", goodToken);
    const r2 = withEnv("MY_EMBED_ENV", otherToken);
    const server = await startServer(echo(400));
    try {
      const cases = [
        [{ preset: "voyage", baseUrl: serverUrl(server), model: "voyage-4", dims: 4 }, goodToken],
        [{ provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 4, apiKeyEnv: "MY_EMBED_ENV" }, otherToken],
      ];
      for (const [conf, token] of cases) {
        writeConfig(conf);
        const cfg = readMemoryConfig(dir);
        const probe = await probeProvider(cfg);
        expect(probe.reachable).toBe(false);
        expect(probe.reason).toMatch(/HTTP 400/);
        expect(JSON.stringify(probe)).not.toContain(token);
        expect(doctorReport(cfg, probe, "darwin")).not.toContain(token);
      }
    } finally {
      server.close();
      r1();
      r2();
    }
  });

  it("the redaction holds on the dimensions-retry response", async () => {
    const restore = withEnv("MY_EMBED_ENV", otherToken);
    let calls = 0;
    const server = await startServer((req, body) => {
      calls++;
      if ("dimensions" in body) return { status: 400, json: DIMS_400 };
      return { status: 500, json: { detail: `rejected ${String(req.headers.authorization)}` } };
    });
    try {
      const result = await createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 4, apiKeyEnv: "MY_EMBED_ENV" } }).embed(["x"], { inputType: "document" });
      expect(calls).toBe(2);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/HTTP 500/);
      expect(result.reason).not.toContain(otherToken);
    } finally {
      server.close();
      restore();
    }
  });

  it("redacts before truncating: no fragment of 8+ chars of a key that straddles the 200-char cut", async () => {
    const restore = withEnv("MY_EMBED_ENV", otherToken);
    const prefix = '{"detail":"';
    const pad = "x".repeat(190 - prefix.length - "Bearer ".length);
    const server = await startServer((req) => ({ status: 500, json: { detail: pad + String(req.headers.authorization) } }));
    try {
      const result = await createProvider({ embeddings: { provider: "openai-compatible", baseUrl: serverUrl(server), model: "m", dims: 4, apiKeyEnv: "MY_EMBED_ENV" } }).embed(["x"], { inputType: "document" });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("xxxxxxxx");
      for (let i = 0; i + 8 <= otherToken.length; i++) expect(result.reason).not.toContain(otherToken.slice(i, i + 8));
    } finally {
      server.close();
      restore();
    }
  });

  it("the probe reason and doctorReport text never contain the key", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    const server = await startServer(echo(500));
    try {
      writeConfig({ preset: "unsloth", baseUrl: serverUrl(server), model: "embeddinggemma", dims: 512 });
      const cfg = readMemoryConfig(dir);
      const probe = await probeProvider(cfg);
      expect(probe.reachable).toBe(false);
      expect(JSON.stringify(probe)).not.toContain(goodToken);
      expect(doctorReport(cfg, probe, "darwin")).not.toContain(goodToken);
    } finally {
      server.close();
      restore();
    }
  });
});

// Card local-provider-no-key: a provider whose baseUrl host is localhost, 127.0.0.1 or ::1 never requires a key.
describe("local providers need no key (card local-provider-no-key)", () => {
  function fakeFetch(status, json = { data: [{ index: 0, embedding: vec(4) }] }) {
    const calls = [];
    const fn = async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
    };
    fn.calls = calls;
    return fn;
  }
  const authOf = (call) => {
    const h = call.headers;
    const k = Object.keys(h).find((n) => n.toLowerCase() === "authorization");
    return k ? h[k] : undefined;
  };
  function cfgOf(embeddings) {
    return { embeddings: { provider: "openai-compatible", model: "m", dims: 4, ...embeddings } };
  }
  const unsloth = (extra = {}) => cfgOf({ preset: "unsloth", baseUrl: "http://127.0.0.1:8888", apiKeyEnv: "UNSLOTH_API_KEY", ...extra });
  const modelsJson = { data: [{ id: "m", loaded: true }] };

  it("a: unsloth with no key sends no authorization header and succeeds", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      const f = fakeFetch(200);
      const result = await createProvider(unsloth(), { fetch: f }).embed(["x"]);
      expect(result.ok).toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(authOf(f.calls[0])).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("b: unsloth with a key sends Bearer <key>", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    try {
      const f = fakeFetch(200);
      const result = await createProvider(unsloth(), { fetch: f }).embed(["x"]);
      expect(result.ok).toBe(true);
      expect(authOf(f.calls[0])).toBe(`Bearer ${goodToken}`);
    } finally {
      restore();
    }
  });

  it("c: a local 401 and 403 from embed give 'server requires a key: set UNSLOTH_API_KEY'", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      for (const status of [401, 403]) {
        const f = fakeFetch(status, { error: "no" });
        const result = await createProvider(unsloth(), { fetch: f }).embed(["x"]);
        expect(f.calls).toHaveLength(1);
        expect(result).toEqual({ ok: false, reason: "server requires a key: set UNSLOTH_API_KEY" });
      }
    } finally {
      restore();
    }
  });

  it("c: a local 401 and 403 from probeProvider's /v1/models give the same reason", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      for (const status of [401, 403]) {
        const f = fakeFetch(status, { error: "no" });
        const probe = await probeProvider(unsloth(), { fetch: f });
        expect(f.calls).toHaveLength(1);
        expect(probe.reachable).toBe(false);
        expect(probe.reason).toBe("server requires a key: set UNSLOTH_API_KEY");
      }
    } finally {
      restore();
    }
  });

  it("c: a local 401 with the configured apiKeyEnv set says the key was rejected, and never prints it", async () => {
    const r1 = withEnv("MY_LOCAL_KEY_ENV", goodToken);
    try {
      const f = fakeFetch(401, { error: goodToken });
      const result = await createProvider(unsloth({ apiKeyEnv: "MY_LOCAL_KEY_ENV" }), { fetch: f }).embed(["x"]);
      expect(result).toEqual({ ok: false, reason: "server rejected the key in MY_LOCAL_KEY_ENV" });
      expect(JSON.stringify(result)).not.toContain(goodToken);
    } finally {
      r1();
    }
  });

  it("d: openai with no key is refused with missing API key before any request", async () => {
    const restore = withEnv("OPENAI_API_KEY", undefined);
    try {
      const f = fakeFetch(200);
      const cfg = cfgOf({ preset: "openai", baseUrl: "https://api.openai.com", apiKeyEnv: "OPENAI_API_KEY" });
      const result = await createProvider(cfg, { fetch: f }).embed(["x"]);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/missing API key/);
      expect(f.calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("e: a custom provider at http://localhost:1234 with no apiKeyEnv and no key sends no auth header", async () => {
    const restore = withEnv("OPENAI_API_KEY", undefined);
    try {
      const f = fakeFetch(200);
      const result = await createProvider(cfgOf({ preset: "custom", baseUrl: "http://localhost:1234" }), { fetch: f }).embed(["x"]);
      expect(result.ok).toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("http://localhost:1234/v1/embeddings");
      expect(authOf(f.calls[0])).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("e: a local 401 from a custom provider with no apiKeyEnv names OPENAI_API_KEY (the default env)", async () => {
    const restore = withEnv("OPENAI_API_KEY", undefined);
    try {
      const f = fakeFetch(401, {});
      const result = await createProvider(cfgOf({ preset: "custom", baseUrl: "http://localhost:1234" }), { fetch: f }).embed(["x"]);
      expect(result).toEqual({ ok: false, reason: "server requires a key: set OPENAI_API_KEY" });
    } finally {
      restore();
    }
  });

  it("f: a non-local URL under the unsloth preset (requiresKey) is still refused before any request", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      const f = fakeFetch(200);
      const cfg = unsloth({ baseUrl: "https://example.com" });
      const result = await createProvider(cfg, { fetch: f }).embed(["x"]);
      expect(result).toEqual({ ok: false, reason: "missing API key: set UNSLOTH_API_KEY" });
      expect(f.calls).toHaveLength(0);
      const probe = await probeProvider(cfg, { fetch: f });
      expect(probe.reachable).toBe(false);
      expect(probe.reason).toBe("missing API key: set UNSLOTH_API_KEY");
      expect(f.calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("f: a non-local custom provider (requiresKey false) sends without a key and a 401 stays a plain HTTP reason", async () => {
    const restore = withEnv("OPENAI_API_KEY", undefined);
    try {
      const ok = fakeFetch(200);
      const r1 = await createProvider(cfgOf({ preset: "custom", baseUrl: "https://example.com" }), { fetch: ok }).embed(["x"]);
      expect(r1.ok).toBe(true);
      expect(authOf(ok.calls[0])).toBeUndefined();
      const denied = fakeFetch(401, {});
      const r2 = await createProvider(cfgOf({ preset: "custom", baseUrl: "https://example.com" }), { fetch: denied }).embed(["x"]);
      expect(r2.ok).toBe(false);
      expect(r2.reason).toMatch(/^HTTP 401/);
      expect(r2.reason).not.toMatch(/server requires a key/);
    } finally {
      restore();
    }
  });

  it("g: probeProvider and doctorReport for unsloth with no key against a reachable fake are reachable", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      const f = fakeFetch(200, modelsJson);
      const cfg = unsloth();
      const probe = await probeProvider(cfg, { fetch: f });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("http://127.0.0.1:8888/v1/models");
      expect(authOf(f.calls[0])).toBeUndefined();
      expect(probe.reachable).toBe(true);
      expect(probe.reason).toBeNull();
      expect(doctorReport(cfg, probe, "darwin")).not.toMatch(/missing API key/);
    } finally {
      restore();
    }
  });

  it("[::1]: a provider at http://[::1]:8888 counts as local (no key needed, 401 names the env)", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      const cfg = unsloth({ baseUrl: "http://[::1]:8888" });
      const ok = fakeFetch(200);
      const r1 = await createProvider(cfg, { fetch: ok }).embed(["x"]);
      expect(r1.ok).toBe(true);
      expect(authOf(ok.calls[0])).toBeUndefined();
      const denied = fakeFetch(401, {});
      const r2 = await createProvider(cfg, { fetch: denied }).embed(["x"]);
      expect(r2).toEqual({ ok: false, reason: "server requires a key: set UNSLOTH_API_KEY" });
    } finally {
      restore();
    }
  });
});

// Card local-provider-no-key, fix pass 1.
describe("local-provider-no-key: lookalike hosts, non-local 401, wrong key", () => {
  function fake(status, json = { data: [{ index: 0, embedding: vec(4) }] }) {
    const calls = [];
    const fn = async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
    };
    fn.calls = calls;
    return fn;
  }
  const cfg = (baseUrl) => ({ embeddings: { provider: "openai-compatible", preset: "unsloth", baseUrl, apiKeyEnv: "UNSLOTH_API_KEY", model: "m", dims: 4 } });

  for (const url of ["https://localhost.evil.com", "http://127.0.0.1.nip.io", "http://user@127.0.0.1@evil.com"]) {
    it(`lookalike host ${url} is not local: embed and probe refuse before any request`, async () => {
      const restore = withEnv("UNSLOTH_API_KEY", undefined);
      try {
        const f = fake(200);
        const result = await createProvider(cfg(url), { fetch: f }).embed(["x"]);
        expect(result).toEqual({ ok: false, reason: "missing API key: set UNSLOTH_API_KEY" });
        const probe = await probeProvider(cfg(url), { fetch: f });
        expect(probe.reachable).toBe(false);
        expect(probe.reason).toBe("missing API key: set UNSLOTH_API_KEY");
        expect(f.calls).toHaveLength(0);
      } finally {
        restore();
      }
    });
  }

  it("a non-local probe 401 (key set) keeps the old text, not 'server requires a key'", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    try {
      const f = fake(401, {});
      const probe = await probeProvider(cfg("https://example.com:8888"), { fetch: f });
      expect(f.calls).toHaveLength(1);
      expect(probe.reachable).toBe(false);
      expect(probe.reason).toBe("HTTP 401: key rejected or missing; set UNSLOTH_API_KEY");
      expect(JSON.stringify(probe)).not.toContain(goodToken);
    } finally {
      restore();
    }
  });

  it("a local 401 and 403 with the key SET: embed and probe say 'server rejected the key in UNSLOTH_API_KEY', never the value", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", goodToken);
    try {
      for (const status of [401, 403]) {
        const f = fake(status, { error: goodToken });
        const result = await createProvider(cfg("http://127.0.0.1:8888"), { fetch: f }).embed(["x"]);
        expect(result).toEqual({ ok: false, reason: "server rejected the key in UNSLOTH_API_KEY" });
        const probe = await probeProvider(cfg("http://127.0.0.1:8888"), { fetch: f });
        expect(probe.reachable).toBe(false);
        expect(probe.reason).toBe("server rejected the key in UNSLOTH_API_KEY");
        expect(JSON.stringify(probe) + JSON.stringify(result)).not.toContain(goodToken);
      }
    } finally {
      restore();
    }
  });

  it("a local 401 with the key UNSET stays 'server requires a key: set UNSLOTH_API_KEY' (embed and probe)", async () => {
    const restore = withEnv("UNSLOTH_API_KEY", undefined);
    try {
      const f = fake(401, {});
      const result = await createProvider(cfg("http://127.0.0.1:8888"), { fetch: f }).embed(["x"]);
      expect(result).toEqual({ ok: false, reason: "server requires a key: set UNSLOTH_API_KEY" });
      const probe = await probeProvider(cfg("http://127.0.0.1:8888"), { fetch: f });
      expect(probe.reason).toBe("server requires a key: set UNSLOTH_API_KEY");
    } finally {
      restore();
    }
  });
});
