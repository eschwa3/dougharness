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

// Provider presets (card embedding-providers-unsloth): memory.embeddings.preset fills only the fields the
// config leaves unset. sendsDims: whether the request carries `dimensions`; requiresKey: an unset key env var
// is refused without calling the server; modelsList: "v1" lists models with GET /v1/models.
const PRESETS = {
  ollama: { provider: "openai-compatible", baseUrl: OLLAMA_BASE_URL, apiKeyEnv: undefined, sendsDims: true, requiresKey: false, modelsList: null },
  unsloth: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:8888", apiKeyEnv: "UNSLOTH_API_KEY", sendsDims: false, requiresKey: true, modelsList: "v1" },
  openai: { provider: "openai-compatible", baseUrl: "https://api.openai.com", apiKeyEnv: "OPENAI_API_KEY", sendsDims: true, requiresKey: true, modelsList: "v1" },
  voyage: { provider: "voyage", baseUrl: "https://api.voyageai.com", apiKeyEnv: "VOYAGE_API_KEY", sendsDims: true, requiresKey: true, modelsList: null },
  custom: { provider: undefined, baseUrl: undefined, apiKeyEnv: undefined, sendsDims: true, requiresKey: false, modelsList: null },
};

function presetOf(e) {
  return e && typeof e.preset === "string" && Object.hasOwn(PRESETS, e.preset) ? PRESETS[e.preset] : null;
}

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
  const resolved = applyPreset(e);
  if (!isValidEmbeddingsConfig(resolved)) {
    process.stderr.write(`[doug] ${CONFIG_RELPATH} memory.embeddings is not a valid shape; treating as unset (keyword-only)\n`);
    return { embeddings: null };
  }
  if (e.preset !== undefined) return {
      embeddings: { preset: e.preset, provider: resolved.provider, baseUrl: resolved.baseUrl, model: resolved.model, dims: resolved.dims, apiKeyEnv: resolved.apiKeyEnv },
    };
  return { embeddings: { provider: e.provider, baseUrl: e.baseUrl, model: e.model, dims: e.dims, apiKeyEnv: e.apiKeyEnv } };
}

// A preset fills provider, baseUrl and apiKeyEnv only where the config leaves them unset. A config with no
// `preset` key is returned as is.
function applyPreset(e) {
  if (!e || typeof e !== "object" || e.preset === undefined) return e;
  const p = presetOf(e);
  if (!p) return null;
  const out = { ...e };
  for (const k of ["provider", "baseUrl", "apiKeyEnv"]) {
    if (out[k] === undefined && p[k] !== undefined) out[k] = p[k];
  }
  return out;
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

// Task prefixes the provider layer must add; the server never adds them. Only the models below carry a
// prefix; every other model gets none. mxbai and qwen3 prefix queries only, documents get "".
export const PREFIXED_MODELS = ["embeddinggemma", "nomic-embed-text", "mxbai-embed-large", "qwen3-embedding"];

export function prefixFor(model, inputType) {
  // Match on the lowercased basename after the last "/", so HF-style names (org/name) and Ollama names agree.
  let m = String(model || "").split(/[/\\]/).pop().toLowerCase();
  // LM Studio-style "text-embedding-<name>" ids: match on <name> when it is a prefixed family (not OpenAI's text-embedding-3-*).
  if (m.startsWith("text-embedding-")) {
    const rest = m.slice("text-embedding-".length);
    if (["mxbai-embed-large", "qwen3-embedding", "embeddinggemma", "nomic"].some((f) => rest.startsWith(f))) m = rest;
  }
  // https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1 README ("add the prompt for query (not for
  // documents)"); https://ollama.com/library/mxbai-embed-large
  if (m.startsWith("mxbai-embed-large")) {
    return inputType === "query" ? "Represent this sentence for searching relevant passages: " : "";
  }
  // https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/config_sentence_transformers.json (query prompt;
  // "document": ""). No space after "Query:".
  if (m.startsWith("qwen3-embedding")) {
    return inputType === "query"
      ? "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"
      : "";
  }
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

// The key never reaches a reason: a server that echoes the Authorization header back in an error body gets
// every occurrence of the key replaced.
async function readBodySnippet(res, key) {
  try {
    let text = await res.text();
    if (key) text = text.split(key).join("[redacted]");
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

// A provider whose baseUrl host is localhost, 127.0.0.1 or ::1 never requires a key (card local-provider-no-key):
// the key is sent only when its env var is set, and a 401/403 says the server wants one. An unparseable URL is not local.
function isLocalUrl(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

function localKeyReason(e) {
  const preset = presetOf(e);
  const name = e.apiKeyEnv || (preset && preset.apiKeyEnv) || "OPENAI_API_KEY";
  return process.env[name] ? `server rejected the key in ${name}` : `server requires a key: set ${name}`;
}

// `state` is the provider instance's memory: { omitDims } turns true once a server has rejected `dimensions`.
async function embedOpenAICompatible(e, texts, inputType, { fetchImpl, timeoutMs }, state = { omitDims: false }) {
  const preset = presetOf(e);
  const local = isLocalUrl(e.baseUrl);
  if (preset && preset.requiresKey && !local) {
    const name = e.apiKeyEnv || "OPENAI_API_KEY";
    if (!process.env[name]) return { ok: false, reason: `missing API key: set ${name}` };
  }
  const prefix = prefixFor(e.model, inputType);
  const input = texts.map((t) => prefix + t);
  const url = `${e.baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  const headers = { "content-type": "application/json" };
  const key = process.env[e.apiKeyEnv || (local && preset && preset.apiKeyEnv) || "OPENAI_API_KEY"];
  if (key) headers.authorization = `Bearer ${key}`;
  const send = async (withDims) => {
    const payload = withDims ? { model: e.model, input, dimensions: e.dims } : { model: e.model, input };
    try {
      return await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return { failure: { ok: false, reason: isAbortLike(err) ? "timeout" : `request failed: ${err.message}` } };
    }
  };
  const sendsDims = !(preset && !preset.sendsDims) && !state.omitDims;
  let res = await send(sendsDims);
  if (res.failure) return res.failure;
  let body = null;
  if (!res.ok) {
    body = await readBodySnippet(res, key);
    // A server that rejects `dimensions` (400 naming it): retry this batch once without it, remember that.
    if (sendsDims && res.status === 400 && /dimensions/i.test(body)) {
      state.omitDims = true;
      res = await send(false);
      if (res.failure) return res.failure;
      body = res.ok ? null : await readBodySnippet(res, key);
    }
  }
  if (!res.ok) {
    if (local && (res.status === 401 || res.status === 403)) return { ok: false, reason: localKeyReason(e) };
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
    const body = await readBodySnippet(res, key);
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
  const state = { omitDims: false };
  const sendBatch =
    e.provider === "voyage"
      ? (texts, inputType) => embedVoyage(e, texts, inputType, { fetchImpl, timeoutMs })
      : (texts, inputType) => embedOpenAICompatible(e, texts, inputType, { fetchImpl, timeoutMs }, state);
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

// Whether a /v1/models entry is the configured model: the id equals it, or the id's last "/" segment equals or
// starts with it, case-insensitively.
function v1ModelMatches(entry, wantModel) {
  const id = entry && typeof entry.id === "string" ? entry.id.toLowerCase() : "";
  const want = String(wantModel).toLowerCase();
  if (!id) return false;
  if (id === want) return true;
  const last = id.split("/").pop();
  return last === want || last.startsWith(want);
}

// The unsloth/openai presets: GET <base>/v1/models with the Bearer key. Never throws; the key is never put in
// a reason.
async function probeV1Models(e, root, wantModel, { fetchImpl, timeoutMs }) {
  const kind = e.preset;
  const envName = e.apiKeyEnv || (presetOf(e) && presetOf(e).apiKeyEnv) || "OPENAI_API_KEY";
  const base = { reachable: false, kind, version: null, models: null, modelPresent: false, modelLoaded: null, embedOk: null };
  const key = process.env[envName];
  const local = isLocalUrl(root);
  if (!key && !local) return { ...base, reason: `missing API key: set ${envName}` };
  let res;
  try {
    res = await fetchImpl(`${root}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ...base, reason: isAbortLike(err) ? "timeout" : `request failed: ${err.message}` };
  }
  if (local && (res.status === 401 || res.status === 403)) return { ...base, reason: localKeyReason(e) };
  if (res.status === 401) return { ...base, reason: `HTTP 401: key rejected or missing; set ${envName}` };
  if (!res.ok) return { ...base, reason: `HTTP ${res.status}` };
  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { ...base, reason: `invalid JSON response: ${err.message}` };
  }
  const entries = Array.isArray(json && json.data) ? json.data : [];
  const match = entries.find((m) => v1ModelMatches(m, wantModel));
  return {
    ...base,
    reachable: true,
    models: entries.map((m) => m && m.id).filter((id) => typeof id === "string"),
    modelPresent: !!match,
    modelLoaded: match && typeof match.loaded === "boolean" ? match.loaded : null,
    reason: null,
  };
}

// Probes a configured provider, or a local Ollama when nothing is configured. GET /api/version (then /api/tags)
// is tried first; only when it succeeds is this reported as kind "ollama" with a model list. When /api/version
// fails — a working llama-server, vLLM, LM Studio, or hosted key never serves it — this falls back to one
// embed(["probe"]) call and reports reachability from that instead, as kind "openai-compatible": a real,
// reachable non-Ollama provider must never be told to go install Ollama. The one exception: an openai-compatible
// provider configured at the Ollama preset host:port (localhost/127.0.0.1:11434) that is NOT reachable even via
// the embed fallback is still reported as kind "ollama" — that combination means a down local Ollama, the one
// case doctor exists to catch, not a different, genuinely unreachable server. With nothing configured the probe
// targets DOUG_OLLAMA_BASE_URL when set and non-empty (read at call time), else localhost:11434; a configured
// baseUrl always wins. Never throws; every branch has a
// 2s timeout.
export async function probeProvider(cfg, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const e = cfg && cfg.embeddings;
  const baseUrl = e && e.baseUrl ? e.baseUrl : process.env.DOUG_OLLAMA_BASE_URL || OLLAMA_BASE_URL;
  const wantModel = e && e.model ? e.model : DEFAULT_MODEL;
  const root = baseUrl.replace(/\/$/, "");
  const preset = presetOf(e);
  if (preset && preset.modelsList === "v1") return probeV1Models(e, root, wantModel, { fetchImpl, timeoutMs });
  if (preset && e.provider === "voyage") {
    // No models endpoint is documented for Voyage: one embed probe, never the Ollama /api/version path.
    const result = await createProvider(cfg, { fetch: fetchImpl, timeoutMs }).embed(["probe"]);
    return { reachable: result.ok, kind: "voyage", version: null, models: null, modelPresent: null, embedOk: result.ok, reason: result.ok ? null : result.reason };
  }
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

const PRESET_SNIPPETS = [
  ["ollama", '"memory": { "embeddings": { "preset": "ollama", "model": "embeddinggemma", "dims": 512 } }'],
  ["unsloth", '"memory": { "embeddings": { "preset": "unsloth", "model": "embeddinggemma", "dims": 512 } }  (a key is only needed if the server enforces auth: UNSLOTH_API_KEY)'],
  ["openai", '"memory": { "embeddings": { "preset": "openai", "model": "text-embedding-3-small", "dims": 512 } }  (set OPENAI_API_KEY)'],
  ["voyage", '"memory": { "embeddings": { "preset": "voyage", "model": "voyage-4", "dims": 512 } }  (set VOYAGE_API_KEY)'],
];

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
    lines.push("Or pick a provider preset (one snippet per preset):");
    for (const [name, snippet] of PRESET_SNIPPETS) lines.push(`  ${name}: ${snippet}`);
    return lines.join("\n");
  }

  lines.push(`memory.embeddings is configured: ${embeddings.provider} ${embeddings.model}/${embeddings.dims} at ${embeddings.baseUrl}.`);
  if (presetOf(embeddings) && PRESETS[embeddings.preset].modelsList === "v1") {
    if (!probe.reachable) lines.push(`Not reachable: ${probe.reason || "unknown error"}.`);
    else if (probe.modelPresent === false) lines.push(`Reachable but ${embeddings.model} is not listed by ${embeddings.baseUrl}/v1/models.`);
    else if (probe.modelLoaded === false) lines.push(`${embeddings.model} is listed but not loaded; load it on the server.`);
    else lines.push(`Reachable; would use ${embeddings.model}/${embeddings.dims}.`);
    return lines.join("\n");
  }
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
