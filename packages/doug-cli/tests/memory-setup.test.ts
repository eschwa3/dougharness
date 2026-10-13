// Card memory-setup-command: `doug memory setup`. Real node:http fake servers on port 0, passed in through
// deps.endpoints; skipped where the sandbox denies local listeners (lesson 910a7a324cb71ed4).
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addLesson, lessonsNeedingEmbedding, openMemory } from "../../../plugins/doug-flow/lib/memory.mjs";
import { runMemory, runMemorySetup, type Endpoint } from "../src/memory-setup.js";
import { localListenerDenied } from "./listen-probe.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAIRS = JSON.parse(readFileSync(resolve(here, "../../../plugins/doug-flow/lib/data/pairs.json"), "utf8")) as {
  paraphrase: [string, string][];
  unrelated: [string, string][];
};
const DIMS = 64;
const PREFIXES = ["title: none | text: ", "task: search result | query: ", "search_document: ", "search_query: "];

function vectorFor(text: string, sameForAll: boolean): number[] {
  let t = text;
  for (const p of PREFIXES) if (t.startsWith(p)) t = t.slice(p.length);
  let idx = 40;
  if (sameForAll) idx = 0;
  else if (t === "probe") idx = 0;
  else {
    const pi = PAIRS.paraphrase.findIndex((p) => p.includes(t));
    if (pi !== -1) idx = pi;
    else {
      const flat = PAIRS.unrelated.flat();
      const ui = flat.indexOf(t);
      if (ui !== -1) idx = 12 + ui;
    }
  }
  const v = new Array(DIMS).fill(0);
  v[idx] = 1;
  return v;
}

interface FakeOpts {
  models: Array<{ id: string; owned_by?: string }>;
  embeddings?: "ok" | "501" | "same";
}

const servers: Server[] = [];
const hitCounts = new Map<string, { models: number; embeddings: number }>();
async function fake(o: FakeOpts): Promise<Endpoint> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: o.models }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (o.embeddings === "501") {
          res.statusCode = 501;
          res.end(JSON.stringify({ error: { code: 501, message: "This server does not support embeddings. Start it with `--embeddings`", type: "not_supported_error" } }));
          return;
        }
        const parsed = JSON.parse(body) as { input: string[]; model: string };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            object: "list",
            model: parsed.model,
            data: parsed.input.map((t, index) => ({ object: "embedding", index, embedding: vectorFor(t, o.embeddings === "same") })),
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const counts = { models: 0, embeddings: 0 };
  hitCounts.set(`http://127.0.0.1:${port}`, counts);
  server.on("request", (req) => {
    if (req.url === "/v1/models") counts.models++;
    else if (req.url === "/v1/embeddings") counts.embeddings++;
  });
  return { id: "fake", label: "Fake", url: `http://127.0.0.1:${port}`, hint: "fake hint: ollama pull embeddinggemma" };
}

async function closedPort(): Promise<Endpoint> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return { id: "closed", label: "Closed", url: `http://127.0.0.1:${port}`, hint: "none" };
}

const dirs: string[] = [];
function project(): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "memory-setup-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".doug"), { recursive: true });
  const config = join(dir, ".doug", "config.json");
  writeFileSync(config, JSON.stringify({ preset: "unsloth", memory: { staleDays: 30 }, other: { a: 1 } }, null, 2) + "\n");
  return { dir, config };
}

const listenDenied = await localListenerDenied();
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Safe defaults: a temp cacheDir and an installLocal stub, so a regression that installs on an empty answer
// cannot run the real npm install or model download. A test that passes its own deps keeps them.
function harness(extra: { ask?: string } = {}) {
  const lines: string[] = [];
  const installs: string[] = [];
  const cacheDir = mkdtempSync(join(tmpdir(), "memory-setup-cache-"));
  dirs.push(cacheDir);
  return {
    lines,
    installs,
    text: () => lines.join("\n"),
    deps: {
      out: (l: string) => void lines.push(l),
      isTTY: true,
      ask: async () => extra.ask ?? "",
      listTimeoutMs: 2000,
      embedTimeoutMs: 5000,
      cacheDir,
      installLocal: async (c: string) => {
        installs.push(c);
        return { ok: true };
      },
    },
  };
}

describe.skipIf(listenDenied !== "")("doug memory setup", () => {
  it("1: picks the embedding model on an Ollama-shaped server, writes config, re-embeds, prints doctor", async () => {
    const ep = await fake({ models: [{ id: "gemma4:latest", owned_by: "library" }, { id: "embeddinggemma:latest", owned_by: "library" }] });
    const { dir, config } = project();
    const m = openMemory(dir);
    addLesson(m, { text: "a lesson to embed", kind: "project", source: { agent: "test" } });
    m.close();
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [ep] });
    expect(r.status).toBe("enabled");
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.memory.embeddings).toEqual({ provider: "openai-compatible", baseUrl: ep.url, model: "embeddinggemma:latest", dims: DIMS });
    expect(written.memory.staleDays).toBe(30);
    expect(written.other).toEqual({ a: 1 });
    expect(readFileSync(config, "utf8").endsWith("}\n")).toBe(true);
    const m2 = openMemory(dir);
    expect(lessonsNeedingEmbedding(m2, { model: "embeddinggemma:latest", dims: DIMS })).toHaveLength(0);
    m2.close();
    expect(h.text()).toContain("Embedded 1/1 lesson(s)");
    expect(h.text()).toContain("memory.embeddings is configured");
  });

  it("2: an empty model list prints the pull hint and leaves the config alone", async () => {
    const ep = await fake({ models: [] });
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [ep] });
    expect(r.status).toBe("keyword-only");
    expect(h.text()).toContain("ollama pull embeddinggemma");
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("3: a llama-server without --embeddings is named and nothing is written", async () => {
    const ep = await fake({ models: [{ id: "../models/embeddinggemma-300M-Q8_0.gguf", owned_by: "llamacpp" }], embeddings: "501" });
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [ep] });
    expect(r.status).toBe("keyword-only");
    expect(h.text()).toContain("--embeddings");
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("4: a model whose vectors are all identical fails the sanity check and is never saved", async () => {
    const ep = await fake({ models: [{ id: "gemma4:latest" }], embeddings: "same" });
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [ep] });
    expect(r.status).toBe("keyword-only");
    expect(h.text()).toContain("sanity");
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("5: no reachable server prints the platform install command", async () => {
    const eps = [await closedPort(), await closedPort()];
    const { dir } = project();
    const mac = harness();
    const r1 = await runMemorySetup({ dir }, { ...mac.deps, endpoints: eps, platform: "darwin", ask: async () => "" });
    expect(r1.status).toBe("keyword-only");
    expect(mac.installs).toEqual([]);
    expect(mac.text().split("\n").filter((l) => l.includes(eps[0].url)).length).toBe(1);
    expect(mac.text()).toContain("curl -fsSL https://ollama.com/install.sh | sh");
    expect(mac.text()).toContain("ollama pull embeddinggemma");
    const win = harness();
    const r2 = await runMemorySetup({ dir }, { ...win.deps, endpoints: eps, platform: "win32" });
    expect(r2.status).toBe("keyword-only");
    expect(win.text()).toContain("irm https://ollama.com/install.ps1 | iex");
    expect(win.installs).toEqual([]);
  });

  it("6: finds the one live server among three endpoints", async () => {
    const up = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const eps = [await closedPort(), up, await closedPort()];
    const { dir, config } = project();
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: eps });
    expect(r.status).toBe("enabled");
    expect(JSON.parse(readFileSync(config, "utf8")).memory.embeddings.baseUrl).toBe(up.url);
  });

  it("7: --url adds an endpoint (trailing /v1 and slash stripped)", async () => {
    const up = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const { dir, config } = project();
    const h = harness();
    const r = await runMemorySetup({ dir, url: `${up.url}/v1/` }, { ...h.deps, endpoints: [await closedPort()] });
    expect(r.status).toBe("enabled");
    expect(JSON.parse(readFileSync(config, "utf8")).memory.embeddings.baseUrl).toBe(up.url);
  });

  it("8: answer n, and no TTY without --yes, write nothing", async () => {
    const ep = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const no = harness({ ask: "n" });
    expect((await runMemorySetup({ dir }, { ...no.deps, endpoints: [ep] })).status).toBe("keyword-only");
    expect(readFileSync(config, "utf8")).toBe(before);
    const noTty = harness();
    const r = await runMemorySetup({ dir }, { ...noTty.deps, isTTY: false, endpoints: [ep] });
    expect(r.status).toBe("keyword-only");
    expect(noTty.text()).toContain("doug memory setup --yes");
    expect(readFileSync(config, "utf8")).toBe(before);
    const yes = harness();
    expect((await runMemorySetup({ dir, yes: true }, { ...yes.deps, isTTY: false, endpoints: [ep] })).status).toBe("enabled");
  });

  it("a missing config says run doug init first and writes nothing", async () => {
    const ep = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const dir = mkdtempSync(join(tmpdir(), "memory-setup-"));
    dirs.push(dir);
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [ep] });
    expect(r.status).toBe("keyword-only");
    expect(h.text()).toContain("run doug init first");
  });
});

describe.skipIf(listenDenied !== "")("card memory-setup-choose-server", () => {
  async function two() {
    const a = { ...(await fake({ models: [{ id: "embeddinggemma:latest" }] })), label: "Alpha" };
    const b = { ...(await fake({ models: [{ id: "nomic-embed-text:latest" }] })), label: "Beta" };
    return { a, b };
  }
  const foundLine = (text: string, label: string, ep: Endpoint, model: string) =>
    text.split("\n").find((l) => l.includes("Found") && l.includes(label) && l.includes(ep.url) && l.includes(model) && l.includes(`${DIMS} dims`));
  const emb = (config: string) => JSON.parse(readFileSync(config, "utf8")).memory.embeddings;

  it("C1: two passing servers are both listed numbered; the answer picks server 2", async () => {
    const { a, b } = await two();
    const { dir, config } = project();
    const questions: string[] = [];
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, ask: async (q: string) => (questions.push(q), "2"), endpoints: [a, b] });
    expect(r.status).toBe("enabled");
    const l1 = foundLine(h.text(), "Alpha", a, "embeddinggemma:latest");
    const l2 = foundLine(h.text(), "Beta", b, "nomic-embed-text:latest");
    expect(l1).toBeDefined();
    expect(l2).toBeDefined();
    expect(l1).toMatch(/^\s*1\./);
    expect(l2).toMatch(/^\s*2\./);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/\b1\b[\s\S]*\b2\b/);
    expect(emb(config)).toEqual({ provider: "openai-compatible", baseUrl: b.url, model: "nomic-embed-text:latest", dims: DIMS });
  });

  it("C2: --yes takes the first server in order and never asks", async () => {
    const { a, b } = await two();
    const { dir, config } = project();
    let asked = 0;
    const h = harness();
    const r = await runMemorySetup({ dir, yes: true }, { ...h.deps, ask: async () => (asked++, "2"), endpoints: [a, b] });
    expect(r.status).toBe("enabled");
    expect(asked).toBe(0);
    expect(emb(config)).toEqual({ provider: "openai-compatible", baseUrl: a.url, model: "embeddinggemma:latest", dims: DIMS });
  });

  it("C3: Enter picks server 1, and both Found lines were printed", async () => {
    const { a, b } = await two();
    const { dir, config } = project();
    const h = harness({ ask: "" });
    const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [a, b] });
    expect(r.status).toBe("enabled");
    expect(h.lines.filter((l) => l.includes("Found"))).toHaveLength(2);
    expect(emb(config).baseUrl).toBe(a.url);
    expect(emb(config).model).toBe("embeddinggemma:latest");
  });

  it("C4: n declines and an out-of-range answer is rejected; nothing is written", async () => {
    const { a, b } = await two();
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    for (const answer of ["n", "7", "banana"]) {
      const h = harness({ ask: answer });
      const r = await runMemorySetup({ dir }, { ...h.deps, endpoints: [a, b] });
      expect(r.status).toBe("keyword-only");
      expect(h.text()).toContain("Not enabled");
      expect(readFileSync(config, "utf8")).toBe(before);
    }
  });

  it("C5: one passing server keeps the single-server prompt byte for byte", async () => {
    const ep = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const { dir } = project();
    const questions: string[] = [];
    const h = harness();
    await runMemorySetup({ dir }, { ...h.deps, ask: async (q: string) => (questions.push(q), ""), endpoints: [ep] });
    expect(questions).toEqual([`Enable semantic memory with embeddinggemma:latest at ${ep.url}? [Y/n] `]);
  });

  it("C6: a reachable server whose models all fail is printed with label, URL and reason; the single prompt is used", async () => {
    const bad = { ...(await fake({ models: [{ id: "gemma4:latest" }], embeddings: "same" })), label: "Badserver" };
    const good = { ...(await fake({ models: [{ id: "embeddinggemma:latest" }] })), label: "Goodserver" };
    const { dir, config } = project();
    const questions: string[] = [];
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, ask: async (q: string) => (questions.push(q), ""), endpoints: [bad, good] });
    expect(r.status).toBe("enabled");
    const line = h.lines.find((l) => l.includes("Badserver") && l.includes(bad.url) && l.includes("sanity"));
    expect(line).toBeDefined();
    expect(h.lines.filter((l) => l.includes("Found"))).toHaveLength(1);
    expect(questions).toEqual([`Enable semantic memory with embeddinggemma:latest at ${good.url}? [Y/n] `]);
    expect(emb(config).baseUrl).toBe(good.url);
  });

  it("C7: no TTY and no --yes lists both servers and writes nothing", async () => {
    const { a, b } = await two();
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const h = harness();
    const r = await runMemorySetup({ dir }, { ...h.deps, isTTY: false, endpoints: [a, b] });
    expect(r.status).toBe("keyword-only");
    expect(foundLine(h.text(), "Alpha", a, "embeddinggemma:latest")).toBeDefined();
    expect(foundLine(h.text(), "Beta", b, "nomic-embed-text:latest")).toBeDefined();
    expect(h.text()).toContain("Run `doug memory setup --yes` to enable it.");
    expect(readFileSync(config, "utf8")).toBe(before);
  });
});

describe.skipIf(listenDenied !== "")("card memory-setup-dedupe-url", () => {
  const emb = (config: string) => JSON.parse(readFileSync(config, "utf8")).memory.embeddings;

  for (const suffix of ["", "/", "/v1", "/v1/"]) {
    it(`D1: --url ${JSON.stringify(suffix)} naming a running default endpoint is probed once, keeps the default's label, single prompt`, async () => {
      const ep = { ...(await fake({ models: [{ id: "embeddinggemma:latest" }] })), label: "Defaultsrv" };
      const { dir, config } = project();
      const questions: string[] = [];
      const h = harness();
      const r = await runMemorySetup({ dir, url: ep.url + suffix }, { ...h.deps, ask: async (q: string) => (questions.push(q), ""), endpoints: [ep] });
      expect(r.status).toBe("enabled");
      const found = h.lines.filter((l) => l.includes("Found"));
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("Defaultsrv");
      expect(found[0]).not.toContain("the given server");
      expect(found[0]).not.toMatch(/^\s*\d+\./);
      expect(questions).toEqual([`Enable semantic memory with embeddinggemma:latest at ${ep.url}? [Y/n] `]);
      expect(hitCounts.get(ep.url)!.models).toBe(1);
      const sameModelEmbeds = hitCounts.get(ep.url)!.embeddings;
      expect(sameModelEmbeds).toBeGreaterThan(0);
      expect(emb(config).baseUrl).toBe(ep.url);
    });
  }

  it("D1b: the default's verification runs once, not twice (embedding requests match a plain run)", async () => {
    const plain = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const dup = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    await runMemorySetup({ dir: project().dir }, { ...harness().deps, endpoints: [plain] });
    await runMemorySetup({ dir: project().dir, url: `${dup.url}/v1` }, { ...harness().deps, endpoints: [dup] });
    expect(hitCounts.get(dup.url)!.embeddings).toBe(hitCounts.get(plain.url)!.embeddings);
  });

  it("D2: --url naming a different server than every default still adds the given server", async () => {
    const def = { ...(await fake({ models: [{ id: "embeddinggemma:latest" }] })), label: "Defaultsrv" };
    const other = await fake({ models: [{ id: "nomic-embed-text:latest" }] });
    const { dir } = project();
    const questions: string[] = [];
    const h = harness();
    await runMemorySetup({ dir, url: `${other.url}/v1` }, { ...h.deps, ask: async (q: string) => (questions.push(q), "1"), endpoints: [def] });
    const found = h.lines.filter((l) => l.includes("Found"));
    expect(found).toHaveLength(2);
    expect(found.some((l) => l.includes("Defaultsrv") && l.includes(def.url))).toBe(true);
    expect(found.some((l) => l.includes("the given server") && l.includes(other.url))).toBe(true);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/\b1\b[\s\S]*\b2\b/);
  });

  it("D3: --url with host localhost is not aliased to the default's 127.0.0.1 (exact equality after normalising)", async () => {
    const ep = { ...(await fake({ models: [{ id: "embeddinggemma:latest" }] })), label: "Defaultsrv" };
    const port = new URL(ep.url).port;
    const alias = `http://localhost:${port}`;
    const { dir } = project();
    const h = harness();
    await runMemorySetup({ dir, url: `${alias}/v1` }, { ...h.deps, endpoints: [ep] });
    expect(h.lines.some((l) => l.includes("Found") && l.includes("Defaultsrv") && l.includes(ep.url))).toBe(true);
    expect(h.lines.some((l) => l.includes("the given server") && l.includes(alias))).toBe(true);
  });
});

// Card memory-bundled-embedding: the second-yes offer to install the bundled local model, made only when no
// server runs. The new deps (cacheDir, installLocal, loadTransformers) are passed through a loosely typed bag
// until the coder declares them on MemorySetupDeps.
const LOCAL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const offerQuestion = (cacheDir: string) =>
  `Or install the bundled embedding model instead: about 470 MB of runtime and 310 MB of weights (embeddinggemma q8) into ${cacheDir}. The model is under the Gemma Terms of Use: https://ai.google.dev/gemma/terms. Install it? [y/N] `;

function localStub() {
  const row = Array.from({ length: 768 }, (_, j) => (j % 5) + 1);
  const mod = {
    env: {} as Record<string, unknown>,
    AutoTokenizer: { from_pretrained: async () => (texts: string[]) => ({ texts }) },
    AutoModel: { from_pretrained: async () => async (inputs: { texts: string[] }) => ({ sentence_embedding: { tolist: () => inputs.texts.map(() => row) } }) },
  };
  return async () => mod;
}

function offerHarness(answers: { offer?: string; installResult?: { ok: boolean; reason?: string } }) {
  const questions: string[] = [];
  const installs: string[] = [];
  const cacheDir = mkdtempSync(join(tmpdir(), "memory-setup-cache-"));
  dirs.push(cacheDir);
  const h = harness();
  const deps = {
    ...h.deps,
    cacheDir,
    ask: async (q: string) => {
      questions.push(q);
      return q.startsWith("Or install") ? (answers.offer ?? "") : "";
    },
    installLocal: async (c: string) => {
      installs.push(c);
      return answers.installResult ?? { ok: true };
    },
    loadTransformers: localStub(),
  };
  return { h, deps, questions, installs, cacheDir };
}

describe.skipIf(listenDenied !== "")("doug memory setup: the bundled local model offer", () => {
  it("L-M11: with no server reachable on a TTY the exact offer is asked once, naming 470 MB, 310 MB, the cache dir, and the Gemma terms", async () => {
    const eps = [await closedPort(), await closedPort()];
    const { dir } = project();
    const t = offerHarness({ offer: "" });
    await runMemorySetup({ dir }, { ...t.deps, endpoints: eps } as never);
    const offers = t.questions.filter((q) => q.startsWith("Or install"));
    expect(offers).toEqual([offerQuestion(t.cacheDir)]);
    expect(offers[0]).toContain("470 MB");
    expect(offers[0]).toContain("310 MB");
    expect(offers[0]).toContain("https://ai.google.dev/gemma/terms");
    // the Ollama pointer comes first, unchanged
    expect(t.h.text()).toContain("ollama pull embeddinggemma");
  });

  it("L-M12: Enter, n, no, and other non-y answers never install; declined, config untouched", async () => {
    for (const answer of ["", "n", "N", "no", "maybe", "  "]) {
      const eps = [await closedPort()];
      const { dir, config } = project();
      const before = readFileSync(config, "utf8");
      const t = offerHarness({ offer: answer });
      const r = await runMemorySetup({ dir }, { ...t.deps, endpoints: eps } as never);
      expect(t.installs, `answer ${JSON.stringify(answer)}`).toEqual([]);
      expect(r).toEqual({ status: "keyword-only", reason: "declined" });
      expect(readFileSync(config, "utf8")).toBe(before);
    }
  });

  it("L-M10: a reachable server never shows the offer, whether it passes or not", async () => {
    const good = await fake({ models: [{ id: "embeddinggemma:latest" }] });
    const empty = await fake({ models: [] });
    const same = await fake({ models: [{ id: "embeddinggemma:latest" }], embeddings: "same" });
    for (const ep of [good, empty, same]) {
      const { dir } = project();
      const t = offerHarness({ offer: "y" });
      await runMemorySetup({ dir }, { ...t.deps, endpoints: [ep] } as never);
      expect(t.questions.filter((q) => q.startsWith("Or install"))).toEqual([]);
      expect(t.installs).toEqual([]);
    }
  });

  it("L-M13: no TTY never asks the offer and never installs; the result is today's no-server line", async () => {
    const eps = [await closedPort()];
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const t = offerHarness({ offer: "y" });
    const r = await runMemorySetup({ dir }, { ...t.deps, isTTY: false, endpoints: eps } as never);
    expect(t.questions).toEqual([]);
    expect(t.installs).toEqual([]);
    expect(r).toEqual({ status: "keyword-only", reason: "no server reachable" });
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("L-M14: --yes never asks the offer and never installs", async () => {
    const eps = [await closedPort()];
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const t = offerHarness({ offer: "y" });
    const r = await runMemorySetup({ dir, yes: true }, { ...t.deps, endpoints: eps } as never);
    expect(t.questions.filter((q) => q.startsWith("Or install"))).toEqual([]);
    expect(t.installs).toEqual([]);
    expect(r).toEqual({ status: "keyword-only", reason: "no server reachable" });
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("L-M15/L-M16: a y installs into the cache dir, writes exactly { preset: local }, re-embeds lessons with the local model, prints the doctor report", async () => {
    for (const answer of ["y", "Y", "yes"]) {
      const eps = [await closedPort()];
      const { dir, config } = project();
      const m = openMemory(dir);
      addLesson(m, { text: "a lesson to embed locally", kind: "project", source: { agent: "test" } });
      m.close();
      const t = offerHarness({ offer: answer });
      const r = await runMemorySetup({ dir }, { ...t.deps, endpoints: eps } as never);
      expect(r).toEqual({ status: "enabled", reason: "enabled" });
      expect(t.installs).toEqual([t.cacheDir]);
      const written = JSON.parse(readFileSync(config, "utf8"));
      expect(written.memory.embeddings).toEqual({ preset: "local" });
      expect(written.memory.staleDays).toBe(30);
      expect(written.other).toEqual({ a: 1 });
      const m2 = openMemory(dir);
      expect(lessonsNeedingEmbedding(m2, { model: LOCAL_ID, dims: 512 })).toHaveLength(0);
      m2.close();
      expect(t.h.text()).toContain("Embedded 1/1 lesson(s)");
      expect(t.h.text()).toContain("Cache:");
    }
  });

  it("L-M18: a failed install prints the reason, returns local install failed, and leaves the config untouched", async () => {
    const eps = [await closedPort()];
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const t = offerHarness({ offer: "y", installResult: { ok: false, reason: "disk full" } });
    const r = await runMemorySetup({ dir }, { ...t.deps, endpoints: eps } as never);
    expect(t.installs).toEqual([t.cacheDir]);
    expect(r).toEqual({ status: "keyword-only", reason: "local install failed" });
    expect(t.h.text()).toContain("Bundled model install failed: disk full");
    expect(readFileSync(config, "utf8")).toBe(before);
  });
});

describe.skipIf(listenDenied !== "")("doug memory setup: the default local install", () => {
  function spawnStub(code: number) {
    const calls: { command: string; args: string[] }[] = [];
    const impl = (command: string, args: string[]) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", code));
      return child;
    };
    return { calls, impl };
  }
  function transformersStub() {
    const row = Array.from({ length: 768 }, (_, j) => (j % 5) + 1);
    const remoteAtLoad: unknown[] = [];
    const env: Record<string, unknown> = {};
    const mod = {
      env,
      AutoTokenizer: { from_pretrained: async () => (texts: string[]) => ({ texts }) },
      AutoModel: {
        from_pretrained: async () => {
          remoteAtLoad.push(env.allowRemoteModels);
          return async (inputs: { texts: string[] }) => ({ sentence_embedding: { tolist: () => inputs.texts.map(() => row) } });
        },
      },
    };
    return { remoteAtLoad, load: async () => mod };
  }

  it("L-R8: the default install runs the runtime install then downloads the model", async () => {
    const eps = [await closedPort()];
    const { dir, config } = project();
    const cacheDir = mkdtempSync(join(tmpdir(), "memory-setup-cache-"));
    dirs.push(cacheDir);
    const sp = spawnStub(0);
    const tf = transformersStub();
    const h = harness();
    const { installLocal: _drop, ...base } = h.deps;
    const r = await runMemorySetup({ dir }, {
      ...base,
      cacheDir,
      endpoints: eps,
      ask: async (q: string) => (q.startsWith("Or install") ? "y" : ""),
      spawnImpl: sp.impl,
      loadTransformers: tf.load,
    } as never);
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0].args).toContain("install");
    expect(sp.calls[0].args).toContain("--prefix");
    expect(tf.remoteAtLoad).toContain(true);
    expect(JSON.parse(readFileSync(config, "utf8")).memory.embeddings).toEqual({ preset: "local" });
    expect(r.status).toBe("enabled");
  });

  it("L-R8b: a failed runtime install prints the reason and never downloads the model", async () => {
    const eps = [await closedPort()];
    const { dir, config } = project();
    const before = readFileSync(config, "utf8");
    const cacheDir = mkdtempSync(join(tmpdir(), "memory-setup-cache-"));
    dirs.push(cacheDir);
    const sp = spawnStub(1);
    const tf = transformersStub();
    const h = harness();
    const { installLocal: _drop, ...base } = h.deps;
    const r = await runMemorySetup({ dir }, {
      ...base,
      cacheDir,
      endpoints: eps,
      ask: async (q: string) => (q.startsWith("Or install") ? "y" : ""),
      spawnImpl: sp.impl,
      loadTransformers: tf.load,
    } as never);
    expect(sp.calls).toHaveLength(1);
    expect(h.text()).toContain("Bundled model install failed: ");
    expect(tf.remoteAtLoad).toEqual([]);
    expect(r).toEqual({ status: "keyword-only", reason: "local install failed" });
    expect(readFileSync(config, "utf8")).toBe(before);
  });
});

describe("runMemory argv", () => {
  it("9: an unknown flag, subcommand, or valueless --url returns 2", async () => {
    const { dir } = project();
    expect(await runMemory(["setup", dir, "--bogus"])).toBe(2);
    expect(await runMemory(["nope"])).toBe(2);
    expect(await runMemory(["setup", dir, "--url"])).toBe(2);
  });
});
