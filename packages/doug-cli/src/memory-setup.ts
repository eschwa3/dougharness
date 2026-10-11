// `doug memory setup`: find a running local embedding server, verify it, and (on the user's yes) enable it in
// .doug/config.json. Never installs anything, never runs a child process, never throws for a bad server.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { checkEmbeddingSanity, createProvider, DEFAULT_SANITY_PAIRS, doctorReport, loadSanityPairs, probeProvider, readMemoryConfig } from "@dougharness/flow/lib/embeddings.mjs";
import type { EmbeddingProvider } from "@dougharness/flow/lib/embeddings.mjs";
import { embedLessons, openMemory } from "@dougharness/flow/lib/memory.mjs";

export interface Endpoint {
  id: string;
  label: string;
  url: string;
  hint: string;
}

const LLAMA_HINT = "llama-server -m <embedding model>.gguf --embeddings";

// Conventional default ports. Verified: Ollama 11434, llama-server 8080, Unsloth Studio 8888.
// Unverified: LM Studio 1234, vLLM 8000, LocalAI on 8080; a wrong one just finds nothing.
export const ENDPOINTS: Endpoint[] = [
  { id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434", hint: "ollama pull embeddinggemma" },
  { id: "unsloth", label: "Unsloth Studio", url: "http://127.0.0.1:8888", hint: "load or serve an embedding model in Unsloth Studio" },
  { id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234", hint: "load or serve an embedding model in LM Studio" },
  { id: "llama-server-or-localai", label: "llama-server or LocalAI", url: "http://127.0.0.1:8080", hint: LLAMA_HINT },
  { id: "vllm", label: "vLLM", url: "http://127.0.0.1:8000", hint: "load or serve an embedding model in vLLM" },
];

export interface MemorySetupDeps {
  endpoints?: Endpoint[];
  ask?: (question: string) => Promise<string>;
  isTTY?: boolean;
  platform?: string;
  out?: (line: string) => void;
  listTimeoutMs?: number;
  embedTimeoutMs?: number;
}

export interface MemorySetupOpts {
  dir: string;
  url?: string;
  yes?: boolean;
}

export const MEMORY_USAGE = "Usage: doug memory setup [dir] [--url <url>] [--yes]\n";

const KNOWN = ["embeddinggemma", "qwen3-embedding", "nomic-embed", "mxbai-embed", "bge", "snowflake-arctic-embed", "all-minilm"];

function baseName(id: string): string {
  const b = id.toLowerCase().split(/[/\\]/).pop() ?? "";
  const i = b.indexOf(":");
  return i === -1 ? b : b.slice(0, i);
}

function rank(id: string): number {
  const n = baseName(id);
  const k = KNOWN.findIndex((p) => n.startsWith(p));
  if (k !== -1) return k;
  return n.includes("embed") ? KNOWN.length : KNOWN.length + 1;
}

export function normaliseUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

function reasonOf(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return "timeout";
  return e && e.message ? e.message : String(err);
}

interface Probed {
  ep: Endpoint;
  base: string;
  ok: boolean;
  ids: string[];
  llama: boolean;
  reason: string;
}

async function probeModels(ep: Endpoint, timeoutMs: number): Promise<Probed> {
  const base = normaliseUrl(ep.url);
  const r: Probed = { ep, base, ok: false, ids: [], llama: false, reason: "" };
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      r.reason = `HTTP ${res.status}`;
      return r;
    }
    const json = (await res.json()) as { data?: unknown };
    if (!json || !Array.isArray(json.data)) {
      r.reason = "malformed /v1/models body";
      return r;
    }
    for (const item of json.data as Array<{ id?: unknown; owned_by?: unknown }>) {
      if (item && typeof item.id === "string") {
        r.ids.push(item.id);
        if (item.owned_by === "llamacpp") r.llama = true;
      }
    }
    r.ok = true;
  } catch (err) {
    r.reason = reasonOf(err);
  }
  return r;
}

function modelMatches(reported: string, id: string): boolean {
  const a = baseName(reported);
  const b = baseName(id);
  return a.startsWith(b) || b.startsWith(a);
}

interface Verified {
  dims: number;
  model: string;
  baseUrl: string;
  provider: EmbeddingProvider;
  label: string;
}

async function embedDims(base: string, id: string, timeoutMs: number, out: (l: string) => void): Promise<number | null> {
  try {
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: id, input: ["probe"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 501 || body.includes("--embeddings")) {
        out(`${id}: the server was started without embeddings; restart it with --embeddings.`);
      } else {
        out(`${id}: embed failed: HTTP ${res.status}${body ? `: ${body}` : ""}`);
      }
      return null;
    }
    const json = (await res.json()) as { model?: unknown; data?: Array<{ embedding?: unknown }> };
    const vec = json && Array.isArray(json.data) && json.data[0] ? json.data[0].embedding : null;
    if (!Array.isArray(vec) || vec.length === 0) {
      out(`${id}: embed failed: response had no embedding`);
      return null;
    }
    if (typeof json.model === "string" && !modelMatches(json.model, id)) {
      out(`warning: asked for ${id} but the server reports ${json.model}`);
    }
    return vec.length;
  } catch (err) {
    out(`${id}: embed failed: ${reasonOf(err)}`);
    return null;
  }
}

async function findPassing(servers: Probed[], embedTimeoutMs: number, out: (l: string) => void): Promise<Verified[]> {
  const passing: Verified[] = [];
  for (const s of servers) {
    if (!s.ok) continue;
    const hint = s.llama ? LLAMA_HINT : s.ep.hint;
    const label = s.llama ? "llama-server" : s.ep.label;
    const ordered = s.ids
      .map((id, i) => ({ id, i }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
      .map((x) => x.id);
    if (ordered.length === 0) {
      out(`${label} at ${s.base} lists no models. No embedding model: ${hint}`);
      continue;
    }
    if (rank(ordered[0]) > KNOWN.length) out(`${label} at ${s.base}: no known embedding model listed. ${hint}`);
    let reason = "no model passed verification";
    let verified = false;
    for (const id of ordered.slice(0, 3)) {
      const dims = await embedDims(s.base, id, embedTimeoutMs, out);
      if (dims === null) {
        reason = `${id}: embed failed`;
        continue;
      }
      try {
        const cfg = { embeddings: { provider: "openai-compatible", baseUrl: s.base, model: id, dims } };
        const provider = createProvider(cfg, { timeoutMs: embedTimeoutMs });
        const check = await checkEmbeddingSanity(provider, loadSanityPairs(DEFAULT_SANITY_PAIRS));
        if (!check.ok) {
          out(`${id}: failed the cosine sanity check: ${check.reason}`);
          reason = `${id} failed the cosine sanity check: ${check.reason}`;
          continue;
        }
        passing.push({ dims, model: id, baseUrl: s.base, provider, label });
        verified = true;
        break;
      } catch (err) {
        out(`${id}: sanity check error: ${reasonOf(err)}`);
        reason = `${id}: sanity check error: ${reasonOf(err)}`;
      }
    }
    if (!verified) out(`${label} at ${s.base}: not offered, ${reason}`);
  }
  return passing;
}

function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
    rl.once("close", () => resolve(""));
  });
}

function urlEndpoint(url: string): Endpoint {
  return { id: "url", label: "the given server", url, hint: "load or serve an embedding model in that server" };
}

export async function runMemorySetup(
  opts: MemorySetupOpts,
  deps: MemorySetupDeps = {},
): Promise<{ status: "enabled" | "keyword-only"; reason: string }> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(l + "\n"));
  const isTTY = deps.isTTY ?? !!process.stdin.isTTY;
  const platform = deps.platform ?? process.platform;
  const listTimeoutMs = deps.listTimeoutMs ?? 1500;
  const embedTimeoutMs = deps.embedTimeoutMs ?? 15000;
  const ask = deps.ask ?? defaultAsk;
  const keywordOnly = (reason: string) => ({ status: "keyword-only" as const, reason });

  try {
    const eps: Endpoint[] = [...(deps.endpoints ?? ENDPOINTS)];
    if (opts.url) {
      const given = normaliseUrl(opts.url);
      if (!eps.some((ep) => normaliseUrl(ep.url) === given)) eps.push(urlEndpoint(opts.url));
    }
    let probed = await Promise.all(eps.map((ep) => probeModels(ep, listTimeoutMs)));
    // Every unreachable or odd endpoint is reported as one line.
    const report = (list: Probed[]) => {
      for (const p of list) {
        if (!p.ok) out(`${p.ep.label} at ${p.base}: ${p.reason}`);
      }
    };
    report(probed);
    let passing = await findPassing(probed, embedTimeoutMs, out);

    if (passing.length === 0 && !probed.some((p) => p.ok) && isTTY && !opts.yes) {
      const pasted = (await ask("No local embedding server found. Paste a server URL (Enter to skip): ")).trim();
      if (pasted) {
        const more = await probeModels(urlEndpoint(pasted), listTimeoutMs);
        report([more]);
        probed = [...probed, more];
        passing = await findPassing([more], embedTimeoutMs, out);
      }
    }

    if (passing.length === 0) {
      if (!probed.some((p) => p.ok)) {
        const cmd = platform === "win32" ? "irm https://ollama.com/install.ps1 | iex" : "curl -fsSL https://ollama.com/install.sh | sh";
        out("No local embedding server found. To get one, install Ollama:");
        out(`  ${cmd}`);
        out("  ollama pull embeddinggemma");
        return keywordOnly("no server reachable");
      }
      out("No server passed verification; memory stays keyword-only.");
      return keywordOnly("no server passed verification");
    }

    let found = passing[0];
    const foundLine = (v: Verified) => `Found ${v.label} at ${v.baseUrl}: model ${v.model}, ${v.dims} dims.`;
    if (passing.length === 1) out(foundLine(found));
    else passing.forEach((v, i) => out(`${i + 1}. ${foundLine(v)}`));
    if (!opts.yes) {
      if (!isTTY) {
        out("Run `doug memory setup --yes` to enable it.");
        return keywordOnly("not confirmed (no TTY)");
      }
      if (passing.length === 1) {
        const answer = (await ask(`Enable semantic memory with ${found.model} at ${found.baseUrl}? [Y/n] `)).trim().toLowerCase();
        if (answer !== "" && !answer.startsWith("y")) {
          out("Not enabled.");
          return keywordOnly("declined");
        }
      } else {
        const answer = (await ask(`Enable which server? [1-${passing.length}, Enter for 1, n for none] `)).trim();
        const n = answer === "" ? 1 : /^\d+$/.test(answer) ? Number(answer) : 0;
        if (n < 1 || n > passing.length) {
          out("Not enabled.");
          return keywordOnly("declined");
        }
        found = passing[n - 1];
      }
    }

    const file = join(opts.dir, ".doug", "config.json");
    let config: Record<string, unknown> | null = null;
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
      }
    } catch {
      config = null;
    }
    if (!config) {
      out("run doug init first (no readable .doug/config.json).");
      return keywordOnly("no config");
    }
    const memory = config.memory && typeof config.memory === "object" && !Array.isArray(config.memory) ? (config.memory as Record<string, unknown>) : {};
    config.memory = { ...memory, embeddings: { provider: "openai-compatible", baseUrl: found.baseUrl, model: found.model, dims: found.dims } };
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    out(`Wrote memory.embeddings to ${file}.`);

    try {
      const m = openMemory(opts.dir);
      try {
        const r = await embedLessons(m, found.provider);
        out(`Embedded ${r.embedded}/${r.total} lesson(s)`);
        if (r.failed) out(`${r.failed} lesson(s) failed to embed: ${r.reason}`);
      } finally {
        m.close();
      }
    } catch (err) {
      out(`Re-embedding existing lessons failed: ${reasonOf(err)}`);
    }
    try {
      const cfg = readMemoryConfig(opts.dir);
      out(doctorReport(cfg, await probeProvider(cfg)));
    } catch (err) {
      out(`doctor report failed: ${reasonOf(err)}`);
    }
    return { status: "enabled", reason: "enabled" };
  } catch (err) {
    out(`memory setup failed: ${reasonOf(err)}`);
    return keywordOnly(reasonOf(err));
  }
}

export async function runMemory(argv: string[]): Promise<number> {
  if (argv[0] !== "setup") {
    process.stderr.write(`Unknown memory subcommand: ${argv[0] ?? "(none)"}\n${MEMORY_USAGE}`);
    return 2;
  }
  let dir: string | undefined;
  let url: string | undefined;
  let yes = false;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--url") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) {
        process.stderr.write(`--url needs a value\n${MEMORY_USAGE}`);
        return 2;
      }
      url = v;
    } else if (a.startsWith("-")) {
      process.stderr.write(`Unknown flag: ${a}\n${MEMORY_USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      process.stderr.write(`Unexpected argument: ${a}\n${MEMORY_USAGE}`);
      return 2;
    }
  }
  const result = await runMemorySetup({ dir: dir ?? process.cwd(), url, yes });
  return result.status === "enabled" ? 0 : 1;
}
