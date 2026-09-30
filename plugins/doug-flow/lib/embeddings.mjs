// Embedding provider layer for the memory store (card memory-recall), over fetch, no install weight: no ONNX
// runtime, no native dependency, no new package. Two adapters share the same shape, an OpenAI-compatible
// /v1/embeddings endpoint (Ollama, llama-server, vLLM, LM Studio, a hosted OpenAI-shaped key) and Voyage AI's
// own endpoint. Product first: memory.embeddings in .doug/config.json is null by default, and every function
// here treats "no provider" or "provider unreachable" as a normal outcome, never a thrown error.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_RELPATH = ".doug/config.json";
const VALID_PROVIDERS = new Set(["openai-compatible", "voyage"]);
const DEFAULT_TIMEOUT_MS = 2000;
const OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "embeddinggemma";

function isValidEmbeddingsConfig(e) {
  return !!(
    e &&
    typeof e === "object" &&
    VALID_PROVIDERS.has(e.provider) &&
    typeof e.baseUrl === "string" &&
    e.baseUrl.trim() &&
    typeof e.model === "string" &&
    e.model.trim() &&
    typeof e.dims === "number" &&
    Number.isFinite(e.dims) &&
    e.dims > 0 &&
    (e.apiKeyEnv === undefined || typeof e.apiKeyEnv === "string")
  );
}

// Tolerant: a missing or unreadable .doug/config.json, or a missing/malformed memory.embeddings key, is
// { embeddings: null } (keyword-only). An embeddings key that is present but the wrong shape is reported once
// on stderr and also treated as null, so a typo in the config never throws mid-run.
export function readMemoryConfig(dir) {
  const file = join(dir, CONFIG_RELPATH);
  if (!existsSync(file)) return { embeddings: null };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { embeddings: null };
  }
  const memory = raw && typeof raw === "object" ? raw.memory : undefined;
  const e = memory && typeof memory === "object" ? memory.embeddings : undefined;
  if (e === null || e === undefined) return { embeddings: null };
  if (!isValidEmbeddingsConfig(e)) {
    process.stderr.write(`[doug] ${CONFIG_RELPATH} memory.embeddings is not a valid shape; treating as unset (keyword-only)\n`);
    return { embeddings: null };
  }
  return { embeddings: { provider: e.provider, baseUrl: e.baseUrl, model: e.model, dims: e.dims, apiKeyEnv: e.apiKeyEnv } };
}

function isValidIndexConfig(idx) {
  return !!(
    idx &&
    typeof idx === "object" &&
    typeof idx.enabled === "boolean" &&
    (idx.include === undefined || (Array.isArray(idx.include) && idx.include.every((s) => typeof s === "string"))) &&
    (idx.exclude === undefined || (Array.isArray(idx.exclude) && idx.exclude.every((s) => typeof s === "string"))) &&
    (idx.chunkLines === undefined || (Number.isInteger(idx.chunkLines) && idx.chunkLines > 0))
  );
}

const INDEX_CONFIG_OFF = { enabled: false, include: [], exclude: [], chunkLines: 60 };

// memory.index (card semantic-index): the opt-in code index's own config, read the same tolerant way
// readMemoryConfig reads memory.embeddings — missing/unreadable config, an absent/null key, or an invalid shape
// all come back as the same "off" shape, an invalid shape warning once on stderr; this never throws. `enabled`
// only gates the flow's own use of the index (brief B); the `memory.mjs index` CLI commands run regardless,
// since running one is itself the opt-in.
export function readIndexConfig(dir) {
  const file = join(dir, CONFIG_RELPATH);
  if (!existsSync(file)) return { ...INDEX_CONFIG_OFF };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...INDEX_CONFIG_OFF };
  }
  const memory = raw && typeof raw === "object" ? raw.memory : undefined;
  const idx = memory && typeof memory === "object" ? memory.index : undefined;
  if (idx === null || idx === undefined) return { ...INDEX_CONFIG_OFF };
  if (!isValidIndexConfig(idx)) {
    process.stderr.write(`[doug] ${CONFIG_RELPATH} memory.index is not a valid shape; treating as off\n`);
    return { ...INDEX_CONFIG_OFF };
  }
  return {
    enabled: idx.enabled,
    include: Array.isArray(idx.include) ? idx.include : [],
    exclude: Array.isArray(idx.exclude) ? idx.exclude : [],
    chunkLines: typeof idx.chunkLines === "number" ? idx.chunkLines : 60,
  };
}

// memory.staleDays (card memory-docs-drift #2): how many days a lesson may go unconfirmed before recallLessons
// excludes it as a candidate (recallLessons' own default is 30, mirrored here). Tolerant like readMemoryConfig
// above: a missing/unreadable config or an unset key is silently 30; a present value that is not a positive
// finite number warns once on stderr and still returns 30 — this must never throw or exit nonzero.
export function readMemoryStaleDays(dir) {
  const file = join(dir, CONFIG_RELPATH);
  if (!existsSync(file)) return 30;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return 30;
  }
  const memory = raw && typeof raw === "object" ? raw.memory : undefined;
  const value = memory && typeof memory === "object" ? memory.staleDays : undefined;
  if (value === undefined) return 30;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    process.stderr.write(`[doug] ${CONFIG_RELPATH} memory.staleDays is not a positive number; using 30\n`);
    return 30;
  }
  return value;
}

function l2normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) return Float32Array.from(vec);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// Cosine sanity check (card memory-measure #3, ruvLLM #655: a non-semantic embedder scored paraphrase and
// unrelated pairs both 91-100%, making retrieval worse than keyword-only, silently). A dozen known paraphrase
// pairs and a dozen known-unrelated pairs, embedded together, must separate by a stated margin or the
// configured embedder is not doing semantic work. Failing loudly here catches that before reembed commits to
// it.
// This path lives inside plugins/doug-flow/lib, under this plugin's own `files` list in package.json, so a
// standalone-published copy of this plugin (installed on its own, without the rest of this repo checked out
// alongside it) still has it.
export const DEFAULT_SANITY_PAIRS = join(dirname(fileURLToPath(import.meta.url)), "data/pairs.json");

function meanOf(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Vectors from embed() are L2-normalized (l2normalize), so cosine similarity is just the dot product.
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function isPairArray(value, name, file) {
  if (!Array.isArray(value) || value.length !== 12) {
    throw new Error(`sanity pairs file ${file}: "${name}" must be an array of exactly 12 pairs`);
  }
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      !pair[0].trim() ||
      !pair[1].trim()
    ) {
      throw new Error(`sanity pairs file ${file}: "${name}" entries must each be a [sentenceA, sentenceB] pair of non-empty strings`);
    }
  }
}

// Loads and validates the sanity pairs file's shape (throws a clear message on anything else): 12 paraphrase
// pairs, 12 unrelated pairs, a numeric margin. Never guesses a default margin — a malformed file is a hard stop.
export function loadSanityPairs(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read sanity pairs file ${file}: ${err.message}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`sanity pairs file ${file} must contain a JSON object`);
  if (typeof raw.margin !== "number" || !Number.isFinite(raw.margin)) {
    throw new Error(`sanity pairs file ${file}: "margin" must be a number`);
  }
  isPairArray(raw.paraphrase, "paraphrase", file);
  isPairArray(raw.unrelated, "unrelated", file);
  return { margin: raw.margin, paraphrase: raw.paraphrase, unrelated: raw.unrelated };
}

// Embeds every sentence from both pair lists in one embed() call (inputType "document", matching how lessons
// are stored), then scores each pair by cosine. ok iff the paraphrase mean clears the unrelated mean by at
// least `margin`, AND no single paraphrase pair scores below the unrelated mean (a good mean hiding one dead
// pair is still a red flag). `failures` lists only that second kind of offender, each with its cosine — a
// margin-only failure (e.g. every vector identical) reports through `reason` with an empty `failures`, since no
// individual pair is uniquely at fault. A provider error (unreachable, timeout, bad response) short-circuits to
// `{ ok:false, reason }` before any scoring.
export async function checkEmbeddingSanity(provider, pairs) {
  const { margin, paraphrase, unrelated } = pairs;
  const sentences = [];
  for (const pair of paraphrase) sentences.push(pair[0], pair[1]);
  for (const pair of unrelated) sentences.push(pair[0], pair[1]);
  const result = await provider.embed(sentences, { inputType: "document" });
  if (!result.ok) return { ok: false, reason: result.reason };
  const vectors = result.vectors;
  const paraScores = paraphrase.map((_, i) => dot(vectors[i * 2], vectors[i * 2 + 1]));
  const unrelatedBase = paraphrase.length * 2;
  const unrelatedScores = unrelated.map((_, i) => dot(vectors[unrelatedBase + i * 2], vectors[unrelatedBase + i * 2 + 1]));
  const paraphraseMean = meanOf(paraScores);
  const paraphraseMin = Math.min(...paraScores);
  const unrelatedMean = meanOf(unrelatedScores);
  const unrelatedMax = Math.max(...unrelatedScores);
  const gap = paraphraseMean - unrelatedMean;
  const failures = [];
  for (let i = 0; i < paraScores.length; i++) {
    if (paraScores[i] < unrelatedMean) {
      failures.push({ pair: paraphrase[i], cosine: paraScores[i] });
    }
  }
  const marginOk = gap >= margin;
  const ok = marginOk && failures.length === 0;
  const reason = ok
    ? null
    : marginOk
      ? `${failures.length} paraphrase pair(s) scored below the unrelated mean ${unrelatedMean.toFixed(4)}`
      : `gap ${gap.toFixed(4)} is below the margin ${margin}`;
  return {
    ok,
    margin,
    gap,
    paraphrase: { mean: paraphraseMean, min: paraphraseMin },
    unrelated: { mean: unrelatedMean, max: unrelatedMax },
    failures,
    reason,
  };
}

// Task prefixes the provider layer must add; the server never adds them. Only the two models named in the
// research note carry a prefix; every other model gets none.
function prefixFor(model, inputType) {
  const m = String(model || "");
  if (m.startsWith("embeddinggemma")) {
    return inputType === "query" ? "task: search result | query: " : "title: none | text: ";
  }
  if (m.startsWith("nomic")) {
    return inputType === "query" ? "search_query: " : "search_document: ";
  }
  return "";
}

function isAbortLike(err) {
  return err && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function readBodySnippet(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

async function embedOpenAICompatible(e, texts, inputType, { fetchImpl, timeoutMs }) {
  const prefix = prefixFor(e.model, inputType);
  const input = texts.map((t) => prefix + t);
  const url = `${e.baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  const headers = { "content-type": "application/json" };
  const key = process.env[e.apiKeyEnv || "OPENAI_API_KEY"];
  if (key) headers.authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: e.model, input, dimensions: e.dims }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: isAbortLike(err) ? "timeout" : `request failed: ${err.message}` };
  }
  if (!res.ok) {
    const body = await readBodySnippet(res);
    return { ok: false, reason: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { ok: false, reason: `invalid JSON response: ${err.message}` };
  }
  if (!json || !Array.isArray(json.data)) return { ok: false, reason: "response missing data[]" };
  const ordered = new Array(texts.length);
  for (const item of json.data) {
    if (item && typeof item.index === "number" && Array.isArray(item.embedding)) ordered[item.index] = item.embedding;
  }
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    let vec = ordered[i];
    if (!Array.isArray(vec)) return { ok: false, reason: "response missing an embedding" };
    // Older Ollama and llama-server ignore `dimensions` and return the native width; truncate then re-normalize.
    if (vec.length > e.dims) vec = vec.slice(0, e.dims);
    if (vec.length !== e.dims) return { ok: false, reason: `wrong dims: got ${vec.length}, expected ${e.dims}` };
    vectors.push(l2normalize(Float32Array.from(vec)));
  }
  return { ok: true, vectors };
}

async function embedVoyage(e, texts, inputType, { fetchImpl, timeoutMs }) {
  const key = process.env[e.apiKeyEnv || "VOYAGE_API_KEY"];
  if (!key) return { ok: false, reason: `missing API key: set ${e.apiKeyEnv || "VOYAGE_API_KEY"}` };
  const base = e.baseUrl && e.baseUrl.trim() ? e.baseUrl : "https://api.voyageai.com";
  const url = `${base.replace(/\/$/, "")}/v1/embeddings`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        input: texts,
        model: e.model,
        input_type: inputType === "query" ? "query" : "document",
        output_dimension: e.dims,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: isAbortLike(err) ? "timeout" : `request failed: ${err.message}` };
  }
  if (!res.ok) {
    const body = await readBodySnippet(res);
    return { ok: false, reason: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { ok: false, reason: `invalid JSON response: ${err.message}` };
  }
  if (!json || !Array.isArray(json.data)) return { ok: false, reason: "response missing data[]" };
  const ordered = new Array(texts.length);
  for (const item of json.data) {
    if (item && typeof item.index === "number" && Array.isArray(item.embedding)) ordered[item.index] = item.embedding;
  }
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    let vec = ordered[i];
    if (!Array.isArray(vec)) return { ok: false, reason: "response missing an embedding" };
    // Same rule as openai-compatible: a server that ignores output_dimension gets truncated then re-normalized;
    // anything still the wrong length after that is a real error, not silently mislabeled with the wrong dims.
    if (vec.length > e.dims) vec = vec.slice(0, e.dims);
    if (vec.length !== e.dims) return { ok: false, reason: `wrong dims: got ${vec.length}, expected ${e.dims}` };
    vectors.push(l2normalize(Float32Array.from(vec)));
  }
  return { ok: true, vectors };
}

// Splits into batches of at most 100 texts per request; a failure on any batch stops and reports that batch's
// reason (embed() never throws or hangs past timeoutMs per request).
async function embedBatched(texts, inputType, sendBatch) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += 100) {
    const result = await sendBatch(texts.slice(i, i + 100), inputType);
    if (!result.ok) return result;
    vectors.push(...result.vectors);
  }
  return { ok: true, vectors };
}

// cfg is the { embeddings } shape readMemoryConfig returns. Returns null when nothing is configured (the
// caller's cue to run keyword-only); otherwise { name, model, dims, embed(texts, { inputType }) }.
export function createProvider(cfg, opts = {}) {
  const e = cfg && cfg.embeddings;
  if (!e) return null;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sendBatch =
    e.provider === "voyage"
      ? (texts, inputType) => embedVoyage(e, texts, inputType, { fetchImpl, timeoutMs })
      : (texts, inputType) => embedOpenAICompatible(e, texts, inputType, { fetchImpl, timeoutMs });
  return {
    name: e.provider,
    model: e.model,
    dims: e.dims,
    async embed(texts, { inputType = "document" } = {}) {
      try {
        return await embedBatched(texts, inputType, sendBatch);
      } catch (err) {
        return { ok: false, reason: `unexpected error: ${err.message}` };
      }
    },
  };
}

// Ollama lists a pulled model with a ":tag" suffix (embeddinggemma:latest) even when the config names it bare
// (embeddinggemma); match on the exact name or the part before ":" on either side.
function baseModelName(name) {
  const s = String(name ?? "");
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(0, i);
}

function modelNameMatches(entry, wantModel) {
  if (!entry) return false;
  const want = baseModelName(wantModel);
  return [entry.name, entry.model].some((n) => n !== undefined && n !== null && (n === wantModel || baseModelName(n) === want));
}

// True for the Ollama preset's host:port (localhost or 127.0.0.1 on 11434) regardless of scheme or trailing
// slash — used only to decide whether an unreachable openai-compatible provider is still worth telling the
// user to go install Ollama for, never to change what gets fetched.
function isOllamaPresetUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port === "11434";
  } catch {
    return false;
  }
}

// Probes a configured provider, or a local Ollama when nothing is configured. GET /api/version (then /api/tags)
// is tried first; only when it succeeds is this reported as kind "ollama" with a model list. When /api/version
// fails — a working llama-server, vLLM, LM Studio, or hosted key never serves it — this falls back to one
// embed(["probe"]) call and reports reachability from that instead, as kind "openai-compatible": a real,
// reachable non-Ollama provider must never be told to go install Ollama. The one exception: an openai-compatible
// provider configured at the Ollama preset host:port (localhost/127.0.0.1:11434) that is NOT reachable even via
// the embed fallback is still reported as kind "ollama" — that combination means a down local Ollama, the one
// case doctor exists to catch, not a different, genuinely unreachable server. Never throws; every branch has a
// 2s timeout.
export async function probeProvider(cfg, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const e = cfg && cfg.embeddings;
  const baseUrl = e && e.baseUrl ? e.baseUrl : OLLAMA_BASE_URL;
  const wantModel = e && e.model ? e.model : DEFAULT_MODEL;
  const root = baseUrl.replace(/\/$/, "");
  const isPresetHost = (!e || e.provider === "openai-compatible") && isOllamaPresetUrl(baseUrl);

  let version = null;
  let versionReachable = false;
  let versionReason = null;
  try {
    const res = await fetchImpl(`${root}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const json = await res.json();
      version = json && typeof json.version === "string" ? json.version : null;
      versionReachable = true;
    } else {
      versionReason = `HTTP ${res.status}`;
    }
  } catch (err) {
    versionReason = isAbortLike(err) ? "timeout" : `request failed: ${err.message}`;
  }

  if (versionReachable) {
    let models = null;
    try {
      const res = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const json = await res.json();
        models = Array.isArray(json && json.models) ? json.models : [];
      }
    } catch {
      models = null;
    }
    const modelPresent = Array.isArray(models) ? models.some((mo) => modelNameMatches(mo, wantModel)) : false;
    return { reachable: true, kind: "ollama", version, models, modelPresent, embedOk: null, reason: null };
  }

  const provider2 = createProvider(cfg, { fetch: fetchImpl, timeoutMs });
  if (!provider2) {
    return { reachable: false, kind: "ollama", version: null, models: null, modelPresent: false, embedOk: false, reason: versionReason || "no provider configured" };
  }
  const result = await provider2.embed(["probe"]);
  return {
    reachable: result.ok,
    kind: !result.ok && isPresetHost ? "ollama" : "openai-compatible",
    version: null,
    models: null,
    modelPresent: null,
    embedOk: result.ok,
    reason: result.ok ? null : result.reason,
  };
}

const INSTALL_COMMANDS = {
  darwin: "brew install ollama",
  linux: "curl -fsSL https://ollama.com/install.sh | sh",
  win32: "winget install Ollama.Ollama",
};

const PRESET_SNIPPET =
  '"memory": { "embeddings": { "provider": "openai-compatible", "baseUrl": "http://localhost:11434", "model": "embeddinggemma", "dims": 512 } }';

function installCommandFor(platform) {
  return INSTALL_COMMANDS[platform] || INSTALL_COMMANDS.linux;
}

// Renders the text `memory.mjs doctor` prints, from a probeProvider() result: what was found, the model it
// would use, and the one command to install what is missing for the given platform (default process.platform).
// cfg is the { embeddings } shape readMemoryConfig returns — the caller reads the config once and passes it in,
// so an invalid memory.embeddings shape is reported on stderr exactly once, not once per doctorReport call.
export function doctorReport(cfg, probe, platform = process.platform) {
  const embeddings = cfg && cfg.embeddings;
  const installCmd = installCommandFor(platform);
  const lines = [];

  if (!embeddings) {
    lines.push("memory.embeddings is not configured in .doug/config.json; the store is keyword-only.");
    if (probe.reachable) {
      lines.push(`A local Ollama was found at ${OLLAMA_BASE_URL} (version ${probe.version || "unknown"}).`);
      lines.push(
        probe.modelPresent
          ? `The model it would use, ${DEFAULT_MODEL}, is already pulled.`
          : `Pull the model it would use with: ollama pull ${DEFAULT_MODEL}`
      );
    } else {
      lines.push(`No local Ollama found at ${OLLAMA_BASE_URL} (${probe.reason || "not reachable"}).`);
      lines.push(`Install it with: ${installCmd}`);
      lines.push(`Then: ollama pull ${DEFAULT_MODEL}`);
    }
    lines.push("Enable it by adding to .doug/config.json:");
    lines.push(`  ${PRESET_SNIPPET}`);
    return lines.join("\n");
  }

  lines.push(`memory.embeddings is configured: ${embeddings.provider} ${embeddings.model}/${embeddings.dims} at ${embeddings.baseUrl}.`);
  if (!probe.reachable) {
    lines.push(`Not reachable: ${probe.reason || "unknown error"}.`);
    // Only an Ollama-shaped miss (or nothing detected at all) gets install instructions — a real, reachable
    // llama-server/vLLM/hosted key that merely lacks /api/version must never be told to go install Ollama.
    if (probe.kind === "ollama") {
      lines.push(`Install it with: ${installCmd}`);
      lines.push(`Then: ollama pull ${embeddings.model}`);
    }
  } else if (probe.modelPresent === false) {
    lines.push(`Reachable (version ${probe.version || "unknown"}) but ${embeddings.model} is not pulled.`);
    lines.push(`Pull it with: ollama pull ${embeddings.model}`);
  } else if (probe.embedOk === false) {
    lines.push(`Reachable but an embed call failed: ${probe.reason || "unknown error"}.`);
  } else {
    lines.push(`Reachable; would use ${embeddings.model}/${embeddings.dims}.`);
  }
  return lines.join("\n");
}
