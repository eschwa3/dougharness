// Card init-memory-step: doug init offers `doug memory setup` as an opt-in step and never fails because of it.
// Fake OpenAI-compatible servers (node:http) stand in for Ollama / llama-server; one per server shape.
import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runInit } from "../src/init.js";
import { readMemoryConfig } from "../../../plugins/doug-flow/lib/embeddings.mjs";
import type { InitOptions } from "../src/init.js";
import { localListenerDenied } from "./listen-probe.js";

// Reviewer finding: lets one test make the written config drop `memory`, to pin that init says "configured" from the file after the write.
const stub = vi.hoisted(() => ({ dropMemory: false }));
vi.mock("../src/generate/proposal.js", async (orig) => {
  const real = await orig<typeof import("../src/generate/proposal.js")>();
  return {
    ...real,
    buildProposal: (...a: Parameters<typeof real.buildProposal>) => {
      const p = real.buildProposal(...a);
      if (stub.dropMemory) {
        for (const c of p.changes) {
          if (c.path === ".doug/config.json" && c.after) {
            const cfg = JSON.parse(c.after) as Record<string, unknown>;
            delete cfg.memory;
            c.after = JSON.stringify(cfg, null, 2) + "\n";
          }
        }
      }
      return p;
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "ts-pnpm");
const pairsFile = join(here, "..", "..", "..", "plugins", "doug-flow", "lib", "data", "pairs.json");
const listenDenied = await localListenerDenied();

// Deterministic fake embedding: both sentences of a paraphrase pair share one axis, every unrelated sentence has
// its own axis, so the real cosine sanity check passes. "constant" returns one vector for everything (fails it).
function buildVectorizer() {
  const pairs = JSON.parse(readFileSync(pairsFile, "utf8")) as { paraphrase: string[][]; unrelated: string[][] };
  const index = new Map<string, number>();
  let n = 0;
  for (const p of pairs.paraphrase) {
    index.set(p[0], n);
    index.set(p[1], n);
    n++;
  }
  for (const p of pairs.unrelated) {
    index.set(p[0], n++);
    index.set(p[1], n++);
  }
  const dims = n + 1;
  return (text: string, constant: boolean): number[] => {
    const v = new Array<number>(dims).fill(0);
    let axis = dims - 1;
    if (!constant) {
      for (const [s, i] of index) {
        if (text.includes(s)) {
          axis = i;
          break;
        }
      }
    }
    v[axis] = 1;
    return v;
  };
}

type Mode = "good" | "no-embedding-model" | "llama-501" | "chat";

interface Fake {
  url: string;
  requests: string[];
  server: Server;
}

const servers: Server[] = [];
const dirs: string[] = [];

async function startFake(mode: Mode): Promise<Fake> {
  const vectorize = buildVectorizer();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/v1/models") {
        const id = mode === "good" ? "my-embed:latest" : mode === "chat" ? "chat-model:7b" : mode === "llama-501" ? "../models/my-embed.gguf" : "llama3:8b";
        return send(200, { object: "list", data: [{ id, owned_by: mode === "llama-501" ? "llamacpp" : "library" }] });
      }
      if (req.method === "POST" && req.url === "/v1/embeddings") {
        if (mode === "llama-501") {
          return send(501, { error: { code: 501, message: "This server does not support embeddings. Start it with `--embeddings`", type: "not_supported_error" } });
        }
        if (mode === "no-embedding-model") return send(400, { error: { message: "model does not support embeddings" } });
        const parsed = JSON.parse(body) as { model: string; input: string | string[] };
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        return send(200, {
          object: "list",
          model: parsed.model,
          data: inputs.map((t, i) => ({ object: "embedding", index: i, embedding: vectorize(t, mode === "chat") })),
        });
      }
      send(404, { error: "not found" });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests, server };
}

async function closedPortUrl(): Promise<string> {
  const f = await startFake("good");
  await new Promise<void>((r) => f.server.close(() => r()));
  return f.url;
}

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-init-memory-"));
  dirs.push(dir);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

function memoryEmbeddings(dir: string): unknown {
  const file = join(dir, ".doug", "config.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { memory?: { embeddings?: unknown } }).memory?.embeddings;
}

function baseOpts(dir: string, overrides: Partial<InitOptions>): InitOptions {
  return {
    dir,
    yes: false,
    dryRun: false,
    color: false,
    quiet: true,
    showHookFiles: false,
    isTTY: true,
    // 'y' to the apply confirmation, Enter to every later prompt.
    ask: async (q: string) => (q.startsWith("Apply") ? "y" : ""),
    ...overrides,
  };
}

// runInit spawns git in-process; keep a leaked GIT_* location variable from redirecting it.
async function initClean(opts: InitOptions): Promise<number> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GIT_") || k === "CLAUDE_PROJECT_DIR") {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return await runInit(opts);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(listenDenied !== "")("doug init semantic memory step", () => {
  it("embedding model listed and passing: writes memory.embeddings, returns 0", async () => {
    const fake = await startFake("good");
    const dir = tempProject();
    const code = await initClean(baseOpts(dir, { memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] } }));
    expect(code).toBe(0);
    const emb = memoryEmbeddings(dir) as { provider: string; baseUrl: string; model: string; dims: number };
    expect(emb).toMatchObject({ provider: "openai-compatible", baseUrl: fake.url, model: "my-embed:latest" });
    expect(emb.dims).toBeGreaterThan(0);
  });

  it("no embedding model listed: returns 0, writes nothing", async () => {
    const fake = await startFake("no-embedding-model");
    const dir = tempProject();
    const code = await initClean(baseOpts(dir, { memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] } }));
    expect(code).toBe(0);
    expect(memoryEmbeddings(dir)).toBeUndefined();
  });

  it("llama-server 501 embeddings error: returns 0, writes nothing", async () => {
    const fake = await startFake("llama-501");
    const dir = tempProject();
    const code = await initClean(baseOpts(dir, { memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] } }));
    expect(code).toBe(0);
    expect(memoryEmbeddings(dir)).toBeUndefined();
    expect(fake.requests).toContain("POST /v1/embeddings");
  });

  it("chat model failing the sanity check: returns 0, writes nothing", async () => {
    const fake = await startFake("chat");
    const dir = tempProject();
    const code = await initClean(baseOpts(dir, { memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] } }));
    expect(code).toBe(0);
    expect(memoryEmbeddings(dir)).toBeUndefined();
    expect(fake.requests).toContain("POST /v1/embeddings");
  });

  it("server down (closed port): returns 0, writes nothing", async () => {
    const url = await closedPortUrl();
    const dir = tempProject();
    const code = await initClean(baseOpts(dir, { memorySetup: { endpoints: [{ id: "fake", label: "Fake", url, hint: "x" }] } }));
    expect(code).toBe(0);
    expect(memoryEmbeddings(dir)).toBeUndefined();
  });

  it("--yes: returns 0 and makes zero requests", async () => {
    const fake = await startFake("good");
    const dir = tempProject();
    const code = await initClean(baseOpts(dir, { yes: true, memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] } }));
    expect(code).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(memoryEmbeddings(dir)).toBeUndefined();
  });

  it("an ask that throws on the setup prompt still returns 0", async () => {
    const fake = await startFake("good");
    const dir = tempProject();
    const code = await initClean(
      baseOpts(dir, {
        ask: async (q: string) => {
          if (q.startsWith("Apply")) return "y";
          throw new Error("boom");
        },
        memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] },
      }),
    );
    expect(code).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(memoryEmbeddings(dir)).toBeUndefined();
  });

  it("a config that already has memory.embeddings makes no request", async () => {
    const fake = await startFake("good");
    const dir = tempProject();
    // init rewrites .doug/config.json from detection, so the step must read the memory key before applying.
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { embeddings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9", model: "x-embed", dims: 8 } } }));
    const code = await initClean(baseOpts(dir, { memorySetup: { endpoints: [{ id: "fake", label: "Fake", url: fake.url, hint: "x" }] } }));
    expect(code).toBe(0);
    expect(fake.requests).toEqual([]);
  });
  describe("re-init on a configured project", () => {
    const emb = { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9", model: "x-embed", dims: 8 };
    const index = { enabled: true, include: ["src/**"], exclude: ["dist/**"], chunkLines: 40 };

    function seed(dir: string): void {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { embeddings: emb, index } }, null, 2));
    }

    function rawEmbeddingsKey(dir: string): string {
      const text = readFileSync(join(dir, ".doug", "config.json"), "utf8");
      const m = /"embeddings"\s*:\s*(\{[^}]*\})/.exec(text);
      return m ? m[1].replace(/\s+/g, "") : "";
    }

    async function runTwice(dir: string, lines: string[]): Promise<{ afterFirst: string; afterSecond: string }> {
      const opts = baseOpts(dir, { yes: true, quiet: false, out: (s: string) => lines.push(s) });
      expect(await initClean(opts)).toBe(0);
      const afterFirst = JSON.stringify(memoryEmbeddings(dir));
      expect(await initClean(opts)).toBe(0);
      return { afterFirst, afterSecond: JSON.stringify(memoryEmbeddings(dir)) };
    }

    it("memory.embeddings is byte-identical after each of two inits", async () => {
      const dir = tempProject();
      seed(dir);
      const lines: string[] = [];
      const { afterFirst, afterSecond } = await runTwice(dir, lines);
      expect(afterFirst).toBe(JSON.stringify(emb));
      expect(afterSecond).toBe(JSON.stringify(emb));
      expect(rawEmbeddingsKey(dir)).toBe(JSON.stringify(emb));
    });

    it("says 'Semantic memory is configured.' only when memory.embeddings is still set after the write", async () => {
      const dir = tempProject();
      seed(dir);
      const lines: string[] = [];
      await runTwice(dir, lines);
      const claimed = lines.includes("Semantic memory is configured.");
      expect(claimed).toBe(!!readMemoryConfig(dir).embeddings);
      // a configured project must both keep the setting and say so
      expect(readMemoryConfig(dir).embeddings).toBeTruthy();
      expect(claimed).toBe(true);
    });

    it("does not say 'configured' when the write dropped memory.embeddings", async () => {
      const dir = tempProject();
      seed(dir);
      const lines: string[] = [];
      stub.dropMemory = true;
      try {
        expect(await initClean(baseOpts(dir, { yes: true, quiet: false, out: (s: string) => lines.push(s) }))).toBe(0);
      } finally {
        stub.dropMemory = false;
      }
      expect(readMemoryConfig(dir).embeddings).toBeFalsy();
      expect(lines).not.toContain("Semantic memory is configured.");
    });

    it("other memory keys (memory.index) are preserved across re-init", async () => {
      const dir = tempProject();
      seed(dir);
      await runTwice(dir, []);
      const cfg = JSON.parse(readFileSync(join(dir, ".doug", "config.json"), "utf8")) as { memory?: { index?: unknown } };
      expect(JSON.stringify(cfg.memory?.index)).toBe(JSON.stringify(index));
    });
  });
});
