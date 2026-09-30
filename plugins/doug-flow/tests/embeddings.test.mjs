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
