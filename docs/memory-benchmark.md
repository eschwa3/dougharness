# Memory benchmark

Card memory-benchmark, all three stages. Stage 1 measured the shipped keyword path (`recallLessons` over FTS5) against plain `grep`. Stage 2 added five Ollama embedding models, dense / fused / reranked retrieval, two FTS5 tokenizer variants and five embedded vector stores. Stage 3 (this revision) corrects the stage-2 attribution, adds the fusion variants, measures dense / rrf / hybrid-shipped latency up to 100,000 lessons, and measures four agent-memory frameworks on local Ollama only (Mem0, LangMem, Graphiti, Letta). The recommendation is section 9: tune.

Machine: Apple silicon (18 GB), macOS, Node 22.23.2, SQLite 3.51.3 (bundled in `node:sqlite`), Python 3.12.13 (uv), Docker 29.7.2, Ollama 0.33.3 on localhost. Timings vary by machine and run; every accuracy number reruns identically from the cached vectors (see Determinism). No paid API was called anywhere: the embedders are Ollama models, the LLM is `gemma4:latest` (8.0B, Q4_K_M) on the same Ollama.

Snapshot: the real store frozen at 2026-10-02T16:26:28Z (156 lessons, 112 live, 44 superseded; the live ones are 101 project, 6 feedback, 3 pitfall, 2 pattern; live lesson text is 122 to 12,120 characters, median 1,644). The snapshot, the cached vectors (`.doug/.state/bench/vectors/`), the frozen report inputs and the logs behind these numbers (`.doug/.state/bench/logs/`) are gitignored; the query set is checked in (`evals/memory/bench-queries.jsonl`). Only the 112 live, in-window lessons are ever sent to a retriever, so every framework ingested 112 lessons, not 156.

## Commands behind the numbers

Every number below ends with a bracketed tag naming the command that produced it; the logs are under `.doug/.state/bench/logs/`. Run from the repo root. All of them exited 0 unless a row says otherwise.

| Tag | Command (log prefix) |
|---|---|
| [ACC] | `node evals/bench-memory.mjs accuracy --ollama --json` (`s4-accuracy`; the earlier `s3-accuracy` run has the same 70 modes byte for byte, and `s4` adds the five `dense:<m>:recency` rows) |
| [SPD] | `node evals/bench-memory.mjs speed --ollama --json` (`s4-speed`; default sizes real, 1000, 10000, 100000; 30 iterations; 20 s budget; cold start included) |
| [ALL] | `node evals/bench-memory.mjs all --ollama --json --iterations 5`, run twice (`s4-all1`, `s4-all2`) |
| [EMB] | `node evals/bench-memory.mjs embed-speed --json` (stage 2, `embed-speed`) |
| [STO] | `node evals/bench-memory.mjs stores --budget-ms 120000 --json` (stage 2, `stores`) and `... stores --model embeddinggemma --stores hnswlib --sizes 100000 --budget-ms 300000 --json` (`stores-hnswlib-100k`) |
| [IVF] | `node evals/bench-memory.mjs stores --model embeddinggemma --stores lancedb-ivfpq,lancedb-ivfpq:refine10 --sizes real,1000,10000,100000 --budget-ms 120000 --json` (`s3-stores-ivfpq`) |
| [TIE] | `node evals/bench-memory.mjs near-ties` (mean cosine of a synthetic query's ranks 1 to 11 over `syntheticVectors(20261002, n, 768)`) |
| [DERIVE] | `node evals/bench-memory.mjs derive --accuracy-json .doug/.state/bench/logs/s4-accuracy.json` (differences of cells of [ACC]: recency cost, residual, fusion cost, the fusion variants) |
| [INSTALL] | `node evals/bench-memory.mjs install-frameworks` (`install-frameworks.log`) |
| [M0V] | `node evals/bench-memory.mjs accuracy --frameworks mem0:verbatim --json` (`s4-m0v-np`) and `... --framework-config '{"prefix":true}' --json` (`s4-m0v-p`) |
| [LMV] | `node evals/bench-memory.mjs accuracy --frameworks langmem:verbatim [--framework-config '{"prefix":true}' | '{"field":"content"}' | '{"prefix":true,"field":"content"}'] --json` (`s4-lm-np`, `s4-lm-p`, `s4-lmc-np`, `s4-lmc-p`) |
| [LTV] | `node evals/bench-memory.mjs accuracy --frameworks letta:verbatim [--framework-config '{"prefix":true}'] --json` (`s4-lt-np`, `s4-lt-p`) |
| [M0X4] | `node evals/bench-memory.mjs accuracy --frameworks mem0:extract --framework-config '{"limit":4}' --json` (`s3-fw-mem0-extract-sample`, thinking on) and `... '{"limit":4,"think":false}' ...` (`s4-m0x-nothink4`, thinking off) |
| [M0X8] | `node evals/bench-memory.mjs accuracy --frameworks mem0:extract --framework-config '{"every":8}' --json` (`s3-fw-mem0-extract-every8`) and `... --frameworks mem0:verbatim --framework-config '{"every":8}' --json` (`s3-fw-mem0-verbatim-every8`), scored with `node evals/bench-memory.mjs subset --a <extract.json> --b <verbatim.json> --every 8 --snapshot .doug/.state/bench/lessons.jsonl` |
| [M0XF] | `node evals/bench-memory.mjs accuracy --frameworks mem0:extract --framework-config '{"think":false}' --json` (`s4-m0x-nothink-full`) |
| [GR] | `node evals/bench-memory.mjs accuracy --frameworks graphiti --framework-config '{"limit":2}' --json` (`s3-fw-graphiti-limit2`; run before a bare `graphiti` was routed as nondeterministic, so its JSON shows it under the deterministic modes) |
| [FWS] | `node evals/bench-memory.mjs speed --frameworks mem0:verbatim,langmem,langmem:content --sizes real,1000,10000 --skip-cold-start --json` (`s3-fw-speed-a`) and `... speed --frameworks letta --sizes real,1000 --skip-cold-start --json` (`s3-fw-speed-b`); run with the stage-3 adapters before the prefix option existed (no prefixes) |
| [FWD] | `node evals/bench-memory.mjs accuracy --frameworks mem0:verbatim,langmem:verbatim,letta:verbatim --framework-config '{"prefix":true}' --json`, run twice (`s4-fwdet1`, `s4-fwdet2`) |

Reproduce in order: `node evals/bench-memory.mjs install-stores`, `install-frameworks`, `snapshot`, then the commands above. Letta needs a second venv and a Docker Postgres (section 6); `docker rm -f doug-bench-pg` if a run is killed.

Determinism: the `deterministic` sections of the two [ALL] runs were diffed (`diff s4-det1.json s4-det2.json` after extracting `.deterministic` with `JSON.stringify(x, null, 2)`, exit 0, 4,752,044 bytes each; both runs exit 0), and all 75 accuracy modes of [ALL] are byte-identical to the same modes of [ACC]. The deterministic framework rows (`mem0:verbatim`, `langmem:verbatim`, `letta:verbatim`, prefix on) were run twice with [FWD]: every accuracy number is identical; the only difference in the two outputs is Letta's `storageBytes` (53,420,032 against 53,346,304 B, the Postgres data directory), so Letta's storage is not byte-stable even though its rankings are. `:extract`, a bare `graphiti` and any non-`verbatim` variant are routed to a top-level `nondeterministic` section with the run date (an LLM extracts); only a `:verbatim` variant is treated as deterministic.

## 1. Setup facts

Retrievers all see the same lessons through the same rule: not superseded, not stale, and `confirmed || created` within 30 days of the snapshot time (the window `recallLessons` applies). All 112 live lessons were inside the window at snapshot time (the oldest is from 2026-09-03), so the window did not change any row here; it matters only for a store older than 30 days. `grep` is subject to the same window, which stage 1 did not apply to it; grep's numbers moved slightly (MRR 0.341 to 0.353) because ties now break by lesson order instead of citation name.

Queries: `node evals/bench-memory.mjs accuracy` scores k=8 over 100 queries, none unresolved, no paraphrase violators: 54 title queries (the card title verbatim), 30 goal queries (the card goal's first sentence, cut at 300 characters; 13 of the 30 reach that cut), and 16 hand-written paraphrases that the script verifies share no keyword with the expected lesson. The expected lesson is the card's `<card-id>-landing.md`, so every query has one expected lesson and P@8 cannot exceed 0.125.

Models (dims from `ollama show <model>`, "embedding length", and `POST /api/show`):

| Model | Dims | Context (ollama show) | Prefixes | Prefix source |
|---|---|---|---|---|
| embeddinggemma | 768 | 2048 | query `task: search result \| query: `, doc `title: none \| text: ` | docs/research/memory-recall.md §2; the Hugging Face card is gated and was not read: unverified |
| nomic-embed-text | 768 | 2048 (modelfile num_ctx 8192) | `search_query: ` / `search_document: ` | confirmed on the Hugging Face card (nomic-embed-text-v1.5) |
| mxbai-embed-large | 1024 | 512 | query `Represent this sentence for searching relevant passages: `, doc none | confirmed on the Hugging Face card (mxbai-embed-large-v1) |
| bge-m3 | 1024 | 8192 | none | confirmed: the card says it no longer needs instructions on queries |
| qwen3-embedding:0.6b | 1024 | 32768 | query `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: `, doc none | the card's format is `Instruct: {task}\nQuery:{query}`; the task text here is the brief's, the card's example says "web search query", and the card's code has no space after `Query:` while its curl example has one. Approximately confirmed, not verbatim |

No Ollama modelfile carries a prefix (each is `TEMPLATE {{ .Prompt }}`), so prefixes come only from the bench's table. Ollama truncates an over-long input to the model's context by default and says nothing; with a median lesson of 1,644 characters, mxbai's 512-token context cuts some of the live lessons (not measured how many).

Vector-store install (`node evals/bench-memory.mjs install-stores`, exit 0, log `.doug/.state/bench/logs/install-stores.log`): one combined `pnpm --dir .doug/.state/bench/stores --ignore-workspace add sqlite-vec @lancedb/lancedb hnswlib-node usearch vectra` (pnpm 9.15.4), 193 packages added in 29.3 s, all five installed, no per-package retry needed:

| Package | Version | Outcome (from the log) |
|---|---|---|
| sqlite-vec | 0.1.9 | installed; prebuilt `vec0.dylib` for darwin-arm64 |
| @lancedb/lancedb | 0.39.0 | installed; prebuilt darwin-arm64 `.node` |
| hnswlib-node | 3.0.0 | installed; `node-gyp rebuild` ran (Python 3.9.6, clang, two `-Wsign-compare` warnings) and ended `gyp info ok` / `install: Done` |
| usearch | 2.26.2 | installed; `node-gyp-build` ended `Done` (a prebuilt binary was used) |
| vectra | 0.15.0 | installed; pure JS |

pnpm also printed `WARN 2 deprecated subdependencies found: node-domexception@1.0.0, whatwg-encoding@3.1.1` and `The following dependencies have build scripts that were ignored: onnxruntime-node, protobufjs, sharp` (transitive dependencies; nothing here needed them). The scratch `package.json` carries a `pnpm.onlyBuiltDependencies` allow-list for the five packages (pnpm 10 would otherwise skip hnswlib's build); the repo's `package.json` and lockfile are untouched.

Framework install ([INSTALL], exit 0, `uv venv --python 3.12 .doug/.state/bench/py` then one combined `uv pip install mem0ai ollama langmem langgraph graphiti-core falkordblite letta-client requests`; 75 packages in the venv; no per-package retry needed):

| Framework | Packages | Version | Directory size (`du -sk` of the package directory, not its dependencies) |
|---|---|---|---|
| Mem0 | mem0ai, ollama | mem0ai 2.2.1, ollama 0.6.3 | mem0 2,316 KB; qdrant_client (its embedded vector store) 5,044 KB |
| LangMem | langmem, langgraph | langmem 0.0.30, langgraph 1.2.12 | langmem 304 KB; langgraph 1,648 KB |
| Graphiti | graphiti-core, falkordblite | graphiti-core 0.30.2, falkordblite 0.10.0 | graphiti_core 2,928 KB; redislite (the embedded FalkorDB server) 40,184 KB |
| Letta (client) | letta-client | 1.12.1 | letta_client 5,088 KB |

The whole main venv is 229,660 KB (`du -sk .doug/.state/bench/py`). Letta's server is separate (section 6): its venv `.doug/.state/bench/py-letta` is 798,228 KB, plus Docker images `pgvector/pgvector:pg16` 650 MB and `letta/letta:latest` 1.72 GB (the latter turned out to be unusable, section 6). Docker image sizes from `docker images`.

## 2. Accuracy

Command: [ACC] (k=8, 100 queries). One ranking table, every retriever ordered by MRR over all queries (ties by p95 recall at the real size). Names: `dense:<m>` cosine over document vectors; `dense:<m>:recency` the same cosine multiplied by the shipped recency weight `0.5 + 0.5 * exp(-ageDays / 90)` (`recallLessons`, age from `confirmed || created`); `rrf:<m>` reciprocal-rank fusion (k=60) of the bm25 top 50 and the dense top 50; `rerank:<m>` the bm25 top 50 reordered by cosine; `rrf:<m>:d10|d20` the same fusion over the top 10 / 20 of each list; `wrrf:<m>:w2|w3` weighted fusion, dense weight 2 / 3, keyword weight 1, depth 50; `dense+kwboost:<m>` the dense order with the bm25 top 3 lifted to ranks 2 to 4 (exact rule in the `kwBoost` comment in `evals/bench-memory.mjs`); `hybrid-shipped:<m>` the product path (`recallLessons` with a `createProvider` provider at Ollama `/v1/embeddings`, the repo's own `prefixFor`, the model's native dims); `hybrid-shipped:<m>:norecency` the same formula reimplemented in the bench with the recency weight fixed at 1; `:noprefix` no task prefixes on either side; `fts5` the shipped keyword path, `fts5:norecency` the same formula with recency 1, `fts5:porter` and `fts5:trigram` bench-owned tables with those tokenizers, `grep` is `grep -ril -F` per distinct query token. Latency columns come from [SPD] (section 3): p95 recall ms at the real size (112 eligible lessons; the dense, rrf, rerank, wrrf and kwboost rows use a cached query vector, so they exclude the live query-embedding call of 13 to 47 ms per query in section 4; `hybrid-shipped` rows include one live Ollama call per query) and at 100,000 lessons (`n/m` = not measured: the retriever has no synthetic-vector twin, or grep above 20,000 files).

| # | Retriever | MRR | R@8 | P@8 | paraphrase R@8 | title R@8 | goal R@8 | p95 ms, real | p95 ms, 100k |
|---|---|---|---|---|---|---|---|---|---|
| 1 | dense:embeddinggemma | 0.6952 | 0.9200 | 0.1150 | 0.7500 | 0.9815 | 0.9000 | 1.085 | 198.67 |
| 2 | dense:qwen3-embedding:0.6b | 0.6688 | 0.9100 | 0.1138 | 0.6250 | 1.0000 | 0.9000 | 0.845 | 217.095 |
| 3 | dense+kwboost:embeddinggemma | 0.6682 | 0.8800 | 0.1100 | 0.5625 | 0.9815 | 0.8667 | 0.875 | n/m |
| 4 | dense:embeddinggemma:recency | 0.6576 | 0.9000 | 0.1125 | 0.6250 | 1.0000 | 0.8667 | 0.215 | n/m |
| 5 | dense:qwen3-embedding:0.6b:recency | 0.6548 | 0.9000 | 0.1125 | 0.6250 | 1.0000 | 0.8667 | 0.253 | n/m |
| 6 | dense:embeddinggemma:noprefix | 0.6539 | 0.8800 | 0.1100 | 0.5000 | 1.0000 | 0.8667 | 0.154 | n/m |
| 7 | dense+kwboost:qwen3-embedding:0.6b | 0.6524 | 0.9100 | 0.1138 | 0.6250 | 1.0000 | 0.9000 | 1.05 | n/m |
| 8 | dense:mxbai-embed-large | 0.6506 | 0.8400 | 0.1050 | 0.4375 | 0.9444 | 0.8667 | 0.483 | 240.264 |
| 9 | wrrf:qwen3-embedding:0.6b:w3 | 0.6496 | 0.8500 | 0.1062 | 0.1875 | 0.9815 | 0.9667 | 1.163 | n/m |
| 10 | dense+kwboost:mxbai-embed-large | 0.6475 | 0.8600 | 0.1075 | 0.5000 | 0.9630 | 0.8667 | 0.886 | n/m |
| 11 | dense:bge-m3:noprefix | 0.6469 | 0.8600 | 0.1075 | 0.3750 | 1.0000 | 0.8667 | 0.265 | n/m |
| 12 | dense:bge-m3 | 0.6469 | 0.8600 | 0.1075 | 0.3750 | 1.0000 | 0.8667 | 0.734 | 228.084 |
| 13 | dense:nomic-embed-text | 0.6463 | 0.8400 | 0.1050 | 0.4375 | 0.9815 | 0.8000 | 0.386 | 210.649 |
| 14 | wrrf:embeddinggemma:w2 | 0.6441 | 0.8400 | 0.1050 | 0.1875 | 0.9815 | 0.9333 | 0.877 | n/m |
| 15 | wrrf:embeddinggemma:w3 | 0.6429 | 0.8300 | 0.1037 | 0.1875 | 0.9815 | 0.9000 | 0.887 | n/m |
| 16 | wrrf:qwen3-embedding:0.6b:w2 | 0.6377 | 0.8500 | 0.1062 | 0.1875 | 0.9815 | 0.9667 | 1.167 | n/m |
| 17 | wrrf:bge-m3:w2 | 0.6373 | 0.8100 | 0.1013 | 0.0000 | 0.9815 | 0.9333 | 0.903 | n/m |
| 18 | wrrf:bge-m3:w3 | 0.6337 | 0.8100 | 0.1013 | 0.0000 | 0.9815 | 0.9333 | 0.949 | n/m |
| 19 | rerank:embeddinggemma | 0.6323 | 0.8300 | 0.1037 | 0.1875 | 0.9815 | 0.9000 | 0.794 | n/m |
| 20 | rerank:qwen3-embedding:0.6b | 0.6313 | 0.8400 | 0.1050 | 0.1875 | 0.9815 | 0.9333 | 0.862 | n/m |
| 21 | dense+kwboost:nomic-embed-text | 0.6304 | 0.8400 | 0.1050 | 0.3750 | 0.9815 | 0.8333 | 0.868 | n/m |
| 22 | wrrf:nomic-embed-text:w3 | 0.6298 | 0.8100 | 0.1013 | 0.0625 | 0.9815 | 0.9000 | 0.868 | n/m |
| 23 | dense:qwen3-embedding:0.6b:noprefix | 0.6281 | 0.8700 | 0.1087 | 0.5000 | 0.9630 | 0.9000 | 0.293 | n/m |
| 24 | rrf:qwen3-embedding:0.6b:d10 | 0.6272 | 0.9100 | 0.1138 | 0.5625 | 1.0000 | 0.9333 | 1.022 | n/m |
| 25 | dense:nomic-embed-text:noprefix | 0.6253 | 0.8200 | 0.1025 | 0.4375 | 0.9444 | 0.8000 | 0.169 | n/m |
| 26 | rrf:embeddinggemma:d10 | 0.6231 | 0.9000 | 0.1125 | 0.5625 | 1.0000 | 0.9000 | 0.849 | n/m |
| 27 | rrf:bge-m3:d10 | 0.6226 | 0.8700 | 0.1087 | 0.3750 | 1.0000 | 0.9000 | 0.955 | n/m |
| 28 | wrrf:nomic-embed-text:w2 | 0.6221 | 0.8000 | 0.1000 | 0.0000 | 0.9815 | 0.9000 | 0.875 | n/m |
| 29 | dense+kwboost:bge-m3 | 0.6216 | 0.8600 | 0.1075 | 0.3750 | 1.0000 | 0.8667 | 0.982 | n/m |
| 30 | rerank:embeddinggemma:noprefix | 0.6191 | 0.8200 | 0.1025 | 0.1250 | 0.9815 | 0.9000 | 0.81 | n/m |
| 31 | wrrf:mxbai-embed-large:w2 | 0.6174 | 0.8100 | 0.1013 | 0.1250 | 0.9630 | 0.9000 | 0.919 | n/m |
| 32 | rerank:bge-m3:noprefix | 0.6134 | 0.7900 | 0.0988 | 0.0000 | 0.9815 | 0.8667 | 0.896 | n/m |
| 33 | rerank:bge-m3 | 0.6134 | 0.7900 | 0.0988 | 0.0000 | 0.9815 | 0.8667 | 0.998 | n/m |
| 34 | wrrf:mxbai-embed-large:w3 | 0.6125 | 0.8100 | 0.1013 | 0.1250 | 0.9630 | 0.9000 | 0.901 | n/m |
| 35 | rrf:qwen3-embedding:0.6b:d20 | 0.6120 | 0.8800 | 0.1100 | 0.4375 | 0.9815 | 0.9333 | 1.01 | n/m |
| 36 | rrf:nomic-embed-text:d10 | 0.6118 | 0.8500 | 0.1062 | 0.3750 | 0.9815 | 0.8667 | 0.877 | n/m |
| 37 | rrf:bge-m3:d20 | 0.6111 | 0.8300 | 0.1037 | 0.1875 | 0.9815 | 0.9000 | 0.952 | n/m |
| 38 | dense:mxbai-embed-large:noprefix | 0.6097 | 0.8300 | 0.1037 | 0.5000 | 0.9259 | 0.8333 | 0.252 | n/m |
| 39 | rrf:embeddinggemma:d20 | 0.6066 | 0.8800 | 0.1100 | 0.5000 | 0.9815 | 0.9000 | 0.859 | n/m |
| 40 | rrf:bge-m3:noprefix | 0.6048 | 0.7900 | 0.0988 | 0.0000 | 0.9815 | 0.8667 | 0.913 | n/m |
| 41 | rrf:bge-m3 | 0.6048 | 0.7900 | 0.0988 | 0.0000 | 0.9815 | 0.8667 | 1.316 | 263.932 |
| 42 | rerank:nomic-embed-text | 0.6046 | 0.7700 | 0.0963 | 0.0000 | 0.9630 | 0.8333 | 0.794 | n/m |
| 43 | rrf:qwen3-embedding:0.6b | 0.6035 | 0.8400 | 0.1050 | 0.1875 | 0.9815 | 0.9333 | 0.927 | 278.523 |
| 44 | rrf:nomic-embed-text:d20 | 0.6019 | 0.8400 | 0.1050 | 0.2500 | 0.9815 | 0.9000 | 0.851 | n/m |
| 45 | rrf:embeddinggemma:noprefix | 0.6013 | 0.8100 | 0.1013 | 0.1250 | 0.9815 | 0.8667 | 0.858 | n/m |
| 46 | dense:bge-m3:recency | 0.5977 | 0.8300 | 0.1037 | 0.3750 | 1.0000 | 0.7667 | 0.24 | n/m |
| 47 | rrf:nomic-embed-text | 0.5968 | 0.8100 | 0.1013 | 0.0625 | 0.9815 | 0.9000 | 1.005 | 223.65 |
| 48 | hybrid-shipped:nomic-embed-text:norecency | 0.5968 | 0.8100 | 0.1013 | 0.0625 | 0.9815 | 0.9000 | 17.078 | n/m |
| 49 | rerank:mxbai-embed-large | 0.5965 | 0.7800 | 0.0975 | 0.0625 | 0.9259 | 0.9000 | 0.806 | n/m |
| 50 | rrf:embeddinggemma | 0.5945 | 0.8000 | 0.1000 | 0.0625 | 0.9815 | 0.8667 | 0.893 | 252.018 |
| 51 | hybrid-shipped:embeddinggemma:norecency | 0.5945 | 0.8000 | 0.1000 | 0.0625 | 0.9815 | 0.8667 | 41.897 | n/m |
| 52 | rerank:qwen3-embedding:0.6b:noprefix | 0.5930 | 0.8300 | 0.1037 | 0.1875 | 0.9630 | 0.9333 | 0.92 | n/m |
| 53 | rrf:mxbai-embed-large:d10 | 0.5921 | 0.8700 | 0.1087 | 0.4375 | 0.9815 | 0.9000 | 0.911 | n/m |
| 54 | rrf:nomic-embed-text:noprefix | 0.5840 | 0.8000 | 0.1000 | 0.0625 | 0.9815 | 0.8667 | 0.881 | n/m |
| 55 | hybrid-shipped:bge-m3:norecency | 0.5832 | 0.7900 | 0.0988 | 0.0000 | 0.9815 | 0.8667 | 48.488 | n/m |
| 56 | hybrid-shipped:qwen3-embedding:0.6b:norecency | 0.5819 | 0.8400 | 0.1050 | 0.1875 | 0.9815 | 0.9333 | 47.624 | n/m |
| 57 | rerank:nomic-embed-text:noprefix | 0.5795 | 0.7600 | 0.0950 | 0.0000 | 0.9630 | 0.8000 | 0.785 | n/m |
| 58 | rrf:qwen3-embedding:0.6b:noprefix | 0.5786 | 0.8400 | 0.1050 | 0.1875 | 0.9815 | 0.9333 | 1.156 | n/m |
| 59 | rrf:mxbai-embed-large:d20 | 0.5780 | 0.8400 | 0.1050 | 0.3750 | 0.9630 | 0.8667 | 0.901 | n/m |
| 60 | dense:nomic-embed-text:recency | 0.5765 | 0.8100 | 0.1013 | 0.3750 | 1.0000 | 0.7000 | 0.193 | n/m |
| 61 | rrf:mxbai-embed-large:noprefix | 0.5714 | 0.8000 | 0.1000 | 0.0625 | 0.9630 | 0.9000 | 0.898 | n/m |
| 62 | rrf:mxbai-embed-large | 0.5692 | 0.7900 | 0.0988 | 0.0625 | 0.9630 | 0.8667 | 0.956 | 262.341 |
| 63 | dense:mxbai-embed-large:recency | 0.5691 | 0.8200 | 0.1025 | 0.4375 | 0.9074 | 0.8667 | 0.229 | n/m |
| 64 | rerank:mxbai-embed-large:noprefix | 0.5680 | 0.7800 | 0.0975 | 0.0625 | 0.9259 | 0.9000 | 0.829 | n/m |
| 65 | hybrid-shipped:mxbai-embed-large:norecency | 0.5614 | 0.8000 | 0.1000 | 0.0625 | 0.9630 | 0.9000 | 28.234 | n/m |
| 66 | hybrid-shipped:bge-m3 | 0.5584 | 0.7900 | 0.0988 | 0.0000 | 0.9815 | 0.8667 | 47.558 | 1584.225 |
| 67 | hybrid-shipped:embeddinggemma | 0.5549 | 0.8100 | 0.1013 | 0.1250 | 0.9815 | 0.8667 | 45.889 | 1368.671 |
| 68 | hybrid-shipped:mxbai-embed-large | 0.5344 | 0.8000 | 0.1000 | 0.0625 | 0.9815 | 0.8667 | 32.907 | 1543.796 |
| 69 | hybrid-shipped:qwen3-embedding:0.6b | 0.5229 | 0.8200 | 0.1025 | 0.1250 | 0.9815 | 0.9000 | 49.941 | 1550.88 |
| 70 | hybrid-shipped:nomic-embed-text | 0.5181 | 0.8000 | 0.1000 | 0.0625 | 0.9815 | 0.8667 | 23.685 | 1363.611 |
| 71 | fts5:porter | 0.5043 | 0.7700 | 0.0963 | 0.1875 | 0.9444 | 0.7667 | 0.431 | 25.923 |
| 72 | fts5:norecency | 0.4707 | 0.7400 | 0.0925 | 0.0625 | 0.9444 | 0.7333 | 0.707 | 62.164 |
| 73 | fts5:trigram | 0.4593 | 0.7100 | 0.0887 | 0.1250 | 0.8889 | 0.7000 | 0.615 | 40.641 |
| 74 | fts5 (shipped) | 0.4056 | 0.7400 | 0.0925 | 0.0625 | 0.9259 | 0.7667 | 2.022 | 631.519 |
| 75 | grep | 0.3531 | 0.6600 | 0.0825 | 0.0000 | 0.8333 | 0.7000 | 125.675 | n/m |

What the table says, with its limits (one expected lesson per query, 100 queries, 16 paraphrases):

- Dense retrieval over the right model beats every keyword and fused variant on MRR and on paraphrase recall. The best, `dense:embeddinggemma`, reaches MRR 0.6952 against the shipped `fts5` 0.4056, and paraphrase R@8 0.7500 against 0.0625 [ACC]. The keyword path's one paraphrase hit (`p-codex-review-network-access`) matches on `could`, `not`, `a` and `on`, stopwords that FTS5 indexes and the bench's paraphrase check ignores; it is not a semantic hit.
- No fusion variant beat the dense row of its model (section 2.2). `hybrid-shipped` is the lowest of the dense-using rows (MRR 0.5181 to 0.5584 [ACC]); the attribution is in section 2.1, and the cost of the recency weight, measured on plain dense, in section 2.4.
- Of the keyword variants, `fts5:porter` (stemming) is best: MRR 0.5043 against 0.4056, paraphrase R@8 0.1875 against 0.0625 [ACC]. `fts5:trigram` (substring) is between them on MRR and below the shipped path on title R@8.
- Differences below roughly 0.03 in MRR are within what 100 single-answer queries can resolve (section 2.2 uses that when choosing between plain dense and its two nearest rows).

### 2.1 Why the shipped hybrid loses to dense (stage-2 attribution, corrected)

Stage 2 said `hybrid-shipped` is lower "because `recallLessons` also multiplies in a recency weight". That is only part of it, and the claim was not measured. The stage-3 bench measures the pieces: `hybrid-shipped:<m>:norecency` is the shipped formula (bm25 top 50 + dot-product top 50, RRF k=60, insertion-order ties) with recency 1, so its gap to `hybrid-shipped:<m>` is the recency weight alone [ACC]:

| Model | dense | rrf | hybrid-shipped norecency | hybrid-shipped | recency cost (norecency - shipped) | rrf - norecency (prefix, scoring, tie-break) | fusion cost (dense - rrf) |
|---|---|---|---|---|---|---|---|
| embeddinggemma | 0.6952 | 0.5945 | 0.5945 | 0.5549 | 0.0396 | 0.0000 | 0.1007 |
| nomic-embed-text | 0.6463 | 0.5968 | 0.5968 | 0.5181 | 0.0787 | 0.0000 | 0.0495 |
| mxbai-embed-large | 0.6506 | 0.5692 | 0.5614 | 0.5344 | 0.0270 | 0.0077 | 0.0814 |
| bge-m3 | 0.6469 | 0.6048 | 0.5832 | 0.5584 | 0.0247 | 0.0217 | 0.0421 |
| qwen3-embedding:0.6b | 0.6688 | 0.6035 | 0.5819 | 0.5229 | 0.0591 | 0.0216 | 0.0653 |

Command for the table: [DERIVE] over [ACC]. Reading it:

- Recency costs 0.0247 to 0.0787 MRR in the fusion (the "recency cost" column). The query set has no time-sensitive query, and 66 of the 112 live lessons carry a `confirmed` date (counted from the snapshot), so on this set recency can only hurt; this does not say recency is wrong for a real recall (the answer to "what did we decide last week" is a recent lesson). Section 2.4 measures the same weight applied to plain dense.
- The residual `rrf - norecency` is what the bench's `rrf:<m>` has that the shipped formula lacks: the model-card prefixes where the shipped provider layer has none (`embeddings.mjs` `prefixFor` lines 235-244 prefix only embeddinggemma and nomic; mxbai and qwen3 get no query prefix, and qwen3 is missing its instruction), cosine instead of dot product, and key-ascending instead of insertion-order tie-breaks. It is 0 for embeddinggemma and nomic (same prefixes on both paths), 0.0077 for mxbai and 0.0217 and 0.0216 for bge-m3 and qwen3. bge-m3 takes no prefix at all, so its 0.0217 is the tie-break / scoring difference alone.
- The main loss against dense is fusion itself (last column, 0.0421 to 0.1007). At 112 lessons each 50-deep list covers about 45 percent of the store, so a mediocre lesson that sits at ranks 10 and 15 (1/70 + 1/75 = 0.028) beats a top dense hit that BM25 missed (1/61 = 0.016). That mechanism is derived from the formula and consistent with the table; it was not instrumented per query.
- The shipped `fts5` row carries recency (0.4056); `fts5:norecency` is 0.4707 [ACC]. The dense, rrf, porter and trigram rows never carried it, so the stage-2 `fts5` row was not on the same footing as the others.
- Qwen3's missing instruction prefix and the missing tie-break in the shipped hybrid sit beside mxbai's missing query prefix as product gaps (same lines of `embeddings.mjs`).

### 2.2 Fusion variants

Does any fusion beat dense? MRR by model [ACC] (command for the table: [DERIVE] over [ACC]):

| Model | dense | rrf (d50) | rrf d20 | rrf d10 | wrrf w2 | wrrf w3 | dense+kwboost | rerank |
|---|---|---|---|---|---|---|---|---|
| embeddinggemma | 0.6952 | 0.5945 | 0.6066 | 0.6231 | 0.6441 | 0.6429 | 0.6682 | 0.6323 |
| nomic-embed-text | 0.6463 | 0.5968 | 0.6019 | 0.6118 | 0.6221 | 0.6298 | 0.6304 | 0.6046 |
| mxbai-embed-large | 0.6506 | 0.5692 | 0.5780 | 0.5921 | 0.6174 | 0.6125 | 0.6475 | 0.5965 |
| bge-m3 | 0.6469 | 0.6048 | 0.6111 | 0.6226 | 0.6373 | 0.6337 | 0.6216 | 0.6134 |
| qwen3-embedding:0.6b | 0.6688 | 0.6035 | 0.6120 | 0.6272 | 0.6377 | 0.6496 | 0.6524 | 0.6313 |

R@8 / paraphrase R@8 for the same columns [ACC]:

| Model | dense | rrf (d50) | rrf d20 | rrf d10 | wrrf w2 | wrrf w3 | dense+kwboost | rerank |
|---|---|---|---|---|---|---|---|---|
| embeddinggemma | 0.9200 / 0.7500 | 0.8000 / 0.0625 | 0.8800 / 0.5000 | 0.9000 / 0.5625 | 0.8400 / 0.1875 | 0.8300 / 0.1875 | 0.8800 / 0.5625 | 0.8300 / 0.1875 |
| nomic-embed-text | 0.8400 / 0.4375 | 0.8100 / 0.0625 | 0.8400 / 0.2500 | 0.8500 / 0.3750 | 0.8000 / 0.0000 | 0.8100 / 0.0625 | 0.8400 / 0.3750 | 0.7700 / 0.0000 |
| mxbai-embed-large | 0.8400 / 0.4375 | 0.7900 / 0.0625 | 0.8400 / 0.3750 | 0.8700 / 0.4375 | 0.8100 / 0.1250 | 0.8100 / 0.1250 | 0.8600 / 0.5000 | 0.7800 / 0.0625 |
| bge-m3 | 0.8600 / 0.3750 | 0.7900 / 0.0000 | 0.8300 / 0.1875 | 0.8700 / 0.3750 | 0.8100 / 0.0000 | 0.8100 / 0.0000 | 0.8600 / 0.3750 | 0.7900 / 0.0000 |
| qwen3-embedding:0.6b | 0.9100 / 0.6250 | 0.8400 / 0.1875 | 0.8800 / 0.4375 | 0.9100 / 0.5625 | 0.8500 / 0.1875 | 0.8500 / 0.1875 | 0.9100 / 0.6250 | 0.8400 / 0.1875 |

- No fusion beats dense on MRR for any of the five models. The nearest are `dense+kwboost` (embeddinggemma 0.6682 against 0.6952, mxbai 0.6475 against 0.6506, qwen3 0.6524 against 0.6688) and `wrrf:w3` for qwen3 (0.6496).
- Shallower lists help rrf: depth 50 to 20 to 10 raises MRR for every model (embeddinggemma 0.5945, 0.6066, 0.6231), because a shallower list gives bm25 fewer chances to inject a mediocre lesson. rrf d10 keeps R@8 close to dense (embeddinggemma 0.9000 against 0.9200; qwen3 0.9100 against 0.9100).
- Weighting the dense side (w2, w3) helps MRR more than depth but wrecks paraphrase recall (embeddinggemma 0.7500 to 0.1875): the bm25 side still reorders the paraphrase queries it cannot match.
- `dense+kwboost` loses 0.0270 MRR to dense for embeddinggemma and gives back paraphrase R@8 (0.7500 to 0.5625). Its gain, if any, would be on exact-identifier queries, which this query set barely has (title R@8 is 0.9815 for plain dense).
- Noise: the gap of plain `dense:embeddinggemma` to `dense+kwboost:embeddinggemma` (0.0270 MRR) and to `dense:qwen3-embedding:0.6b` (0.0264) sits inside the roughly 0.03 band that 100 queries resolve, so MRR alone does not separate them. The choice of plain embeddinggemma dense rests on paraphrase R@8: 12 of the 16 paraphrase queries hit in the top 8, against 9 for `dense+kwboost` and 10 for qwen3 dense [ACC]. Sixteen paraphrases is a small sample too; read it as a direction.

### 2.3 Prefix worth

Prefix worth ([ACC]; dense MRR with the model-card prefixes and without; `bge-m3` takes no prefix, so its two columns are identical by construction):

| Model | dense MRR (prefix) | dense MRR (noprefix) | para R@8 (prefix / no) | rrf MRR (p / np) | rerank MRR (p / np) |
|---|---|---|---|---|---|
| embeddinggemma | 0.6952 | 0.6539 | 0.7500 / 0.5000 | 0.5945 / 0.6013 | 0.6323 / 0.6191 |
| nomic-embed-text | 0.6463 | 0.6253 | 0.4375 / 0.4375 | 0.5968 / 0.5840 | 0.6046 / 0.5795 |
| mxbai-embed-large | 0.6506 | 0.6097 | 0.4375 / 0.5000 | 0.5692 / 0.5714 | 0.5965 / 0.5680 |
| bge-m3 | 0.6469 | 0.6469 | 0.3750 / 0.3750 | 0.6048 / 0.6048 | 0.6134 / 0.6134 |
| qwen3-embedding:0.6b | 0.6688 | 0.6281 | 0.6250 / 0.5000 | 0.6035 / 0.5786 | 0.6313 / 0.5930 |

Prefixes helped the dense row of every model that has them (embeddinggemma +0.0413 MRR, +0.2500 paraphrase R@8; qwen3-embedding +0.0407; mxbai +0.0409; nomic +0.0210) [ACC]. They did not consistently help `rrf:` (embeddinggemma and mxbai fused slightly worse with them). mxbai's dense paraphrase R@8 was higher without the prefix (0.5000 against 0.4375), though its MRR was lower. The shipped provider layer has no mxbai query prefix (`plugins/doug-flow/lib/embeddings.mjs` `prefixFor`, lines 235-244), which is why `hybrid-shipped:mxbai-embed-large` is measured as shipped, without it.

### 2.4 Dense with the shipped recency weight

`dense:<m>:recency` ranks by cosine times the shipped recency weight, so it is "plain dense plus the one thing `recallLessons` multiplies in". Command: [ACC]; table by [ACC] cells (the `derive` subcommand prints the same MRR cells):

| Model | dense MRR | dense:recency MRR | recency cost | dense R@8 | recency R@8 | dense para R@8 | recency para R@8 | hybrid-shipped MRR | gain of dense:recency over shipped | gain of plain dense over shipped |
|---|---|---|---|---|---|---|---|---|---|---|
| embeddinggemma | 0.6952 | 0.6576 | -0.0376 | 0.9200 | 0.9000 | 0.7500 | 0.6250 | 0.5549 | 0.1027 | 0.1403 |
| nomic-embed-text | 0.6463 | 0.5765 | -0.0697 | 0.8400 | 0.8100 | 0.4375 | 0.3750 | 0.5181 | 0.0584 | 0.1282 |
| mxbai-embed-large | 0.6506 | 0.5691 | -0.0815 | 0.8400 | 0.8200 | 0.4375 | 0.4375 | 0.5344 | 0.0346 | 0.1162 |
| bge-m3 | 0.6469 | 0.5977 | -0.0492 | 0.8600 | 0.8300 | 0.3750 | 0.3750 | 0.5584 | 0.0393 | 0.0885 |
| qwen3-embedding:0.6b | 0.6688 | 0.6548 | -0.0141 | 0.9100 | 0.9000 | 0.6250 | 0.6250 | 0.5229 | 0.1319 | 0.1460 |

- Recency costs plain dense 0.0141 to 0.0815 MRR, depending on the model (embeddinggemma 0.0376), and a little R@8 (embeddinggemma 0.9200 to 0.9000) and paraphrase R@8 (0.7500 to 0.6250) [ACC].
- Even with recency kept, cosine beats the shipped hybrid for every model: embeddinggemma 0.6576 against 0.5549 (+0.1027 MRR), qwen3 0.6548 against 0.5229 (+0.1319), nomic +0.0584, bge-m3 +0.0393, mxbai +0.0346 [ACC]. The smallest gain (mxbai) is 0.0346, inside the roughly 0.03 band's reach, so for mxbai and bge-m3 the case rests on R@8 and paraphrase R@8 rather than MRR alone.
- So of the shipped hybrid's gap to plain dense (embeddinggemma 0.1403), about 0.1027 is recovered by switching the ranking to cosine and keeping recency, and the remaining 0.0376 is the recency weight itself. The recommendation (section 9) uses the first number, which keeps recency.

## 3. Speed and storage

Command: [SPD]. Milliseconds, p50 / p95 (nearest rank) over n samples (n=30 unless shown; record n=30; import n=10, 8 at 10,000 and 3 at 100,000; cold start n=10). Synthetic stores come from a seeded generator (seed 20261002); "real" is the snapshot. A cell stops at n=3 samples once its 20 s budget is spent. [SPD] was rerun after the per-setup query cache fix (`providerCore` once held one query cache per factory, so a speed pass after an accuracy pass could time cached query vectors); the accuracy numbers did not change.

Keyword paths [SPD]:

| Lessons | fts5 (shipped) | fts5:norecency | fts5:porter | fts5:trigram | grep |
|---|---|---|---|---|---|
| real (112 eligible) | 1.044 / 2.022 | 0.519 / 0.707 | 0.266 / 0.431 | 0.433 / 0.615 | 86.15 / 125.675 |
| 1000 | 4.871 / 7.891 | 0.489 / 0.716 | 0.156 / 0.238 | 0.347 / 0.477 | 385.33 / 562.506 |
| 10000 | 44.934 / 51.108 | 3.649 / 5.518 | 1.162 / 1.963 | 2.977 / 4.286 | 4082.465 / 28962.095 (n=3) |
| 100000 | 549.609 / 631.519 | 41.078 / 62.164 | 12.241 / 25.923 | 27.701 / 40.641 | n/m |

- `fts5` is the shipped `recallLessons` (it loads every live row before ranking); `fts5:norecency` is the same formula over the bench's scratch store and times only the bm25 top-50 query plus the window filter. The gap (549.609 against 41.078 ms p50 at 100,000) is row loading and handling, the same 86 percent finding stage 2 profiled (`recallLessons` 612.5 ms, bm25 query alone 83.1 ms, bare `SELECT *` of live rows 211.8 ms at 100,000, median of 5, `.doug/.state/scratch/profile.mjs`, log `.doug/.state/bench/logs/profile-recall-100k.log`; a stage-2 measurement from a scratch script that is not in the repo).

The other costs of the shipped store at every size [SPD] (p50 / p95 ms):

| Lessons | record one outcome | import, 50 new files | full import of N files into an empty store | cold-start CLI recall (bare `node -e 0`) |
|---|---|---|---|---|
| 156 lessons (real, all rows) | 0.426 / 0.669 | 152.227 / 182.646 | 241.237 / 509.512 (156 files) | 38.749 / 42.537 (21.81 / 28.808) |
| 1,000 | 0.468 / 0.997 | 340.139 / 399.009 | 2967.328 / 3056.398 (1000 files) | 43.777 / 49.025 (21.196 / 28.918) |
| 10,000 | 0.456 / 0.604 | 2556.281 / 2589.561 | not measured (above 1,000 files) | 91.574 / 115.583 (22.206 / 25.83) |
| 100,000 | 0.499 / 0.832 | 28044.414 / 28550.438 | not measured (above 1,000 files) | 602.924 / 695.02 (22.676 / 91.174) |

- Record is flat: 0.43 to 0.50 ms p50 from 156 to 100,000 lessons. Importing 50 new files grows with the store (152 ms, 340 ms, 2,556 ms, 28,044 ms p50 at 156, 1,000, 10,000 and 100,000 lessons) because `importAutoMemory` scans every lesson per new file; a full import of 1,000 files takes 2,967 ms p50. Cold-start CLI recall is 38.7 ms at the real size and 602.9 ms at 100,000 against a bare node's 21 to 23 ms. A reviewer's separate probe gave similar figures (cold start 45.6 / 89.9 / 586.9 ms, import 317.7 ms / 2.43 s / 26.2 s at 1,000 / 10,000 / 100,000, record 0.4 to 0.6 ms); the values above are this run's. No hook loads memory.mjs (`grep -rnE "memory[A-Za-z-]*\.mjs" plugins/doug-gates/scripts` finds one message string, not an import).

Dense, rrf and hybrid-shipped at scale, which stage 2 could not time (it would have needed an embedding per synthetic lesson). Stage 3 stores seeded synthetic vectors through a fake provider (`syntheticProvider`: unit vectors from a PRNG keyed by (seed, text) at the model's dims; the query vector likewise), so these are latency numbers only; the vectors carry no meaning and recall is not measured on them. At the real size the query vector comes from Ollama (cached for dense and rrf, live for hybrid-shipped); at 1,000 and above every query vector is synthetic, so hybrid-shipped drops from 31 ms to 8 ms between real and 1,000 only because the live embedding call (13 to 47 ms, section 4) is no longer in the number. p50 / p95 ms [SPD]:

| Model | retriever | real (112 lessons) | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|
| embeddinggemma | dense | 0.174 / 1.085 | 1.454 / 1.848 | 15.396 / 32.408 | 172.395 / 198.67 |
| embeddinggemma | rrf | 0.729 / 0.893 | 1.878 / 2.417 | 17.4 / 22.583 | 193.645 / 252.018 |
| embeddinggemma | hybrid-shipped | 31.27 / 45.889 | 7.873 / 12.892 | 93.511 / 115.402 | 1219.838 / 1368.671 (n=17) |
| nomic-embed-text | dense | 0.339 / 0.386 | 1.398 / 1.548 | 15.755 / 18.07 | 178.469 / 210.649 |
| nomic-embed-text | rrf | 0.739 / 1.005 | 1.781 / 2.203 | 18.879 / 26.058 | 188.087 / 223.65 |
| nomic-embed-text | hybrid-shipped | 16.892 / 23.685 | 7.607 / 11.819 | 86.92 / 106.177 | 1192.218 / 1363.611 (n=17) |
| mxbai-embed-large | dense | 0.436 / 0.483 | 1.734 / 1.906 | 18.782 / 20.091 | 215.929 / 240.264 |
| mxbai-embed-large | rrf | 0.747 / 0.956 | 2.143 / 2.454 | 21.17 / 24.409 | 227.77 / 262.341 |
| mxbai-embed-large | hybrid-shipped | 27.063 / 32.907 | 7.736 / 10.706 | 101.859 / 116.391 | 1326.625 / 1543.796 (n=15) |
| bge-m3 | dense | 0.46 / 0.734 | 1.736 / 1.91 | 19.32 / 20.339 | 214.014 / 228.084 |
| bge-m3 | rrf | 0.915 / 1.316 | 2.416 / 4.274 | 22.327 / 43.894 | 229.125 / 263.932 |
| bge-m3 | hybrid-shipped | 43.05 / 47.558 | 8.32 / 11.385 | 93.893 / 105.076 | 1357.809 / 1584.225 (n=15) |
| qwen3-embedding:0.6b | dense | 0.458 / 0.845 | 1.809 / 1.874 | 18.607 / 19.363 | 213.496 / 217.095 |
| qwen3-embedding:0.6b | rrf | 0.721 / 0.927 | 2.207 / 2.606 | 22.714 / 26.145 | 232.628 / 278.523 |
| qwen3-embedding:0.6b | hybrid-shipped | 36.757 / 49.941 | 8.369 / 10.982 | 94.778 / 113.776 | 1305.031 / 1550.88 (n=16) |

- The product's scalability number is `hybrid-shipped` at 100,000 lessons: 1.19 to 1.36 s p50 (1.36 to 1.58 s p95) [SPD]. Every query reads and decodes every vector blob. The bench's `dense` scan over in-memory vectors is 172 to 216 ms and `rrf` 188 to 233 ms at the same size [SPD]; dense scan cost grows with dimensions (768-dim models 172 to 178 ms, 1024-dim 213 to 216 ms), as stage 2's `bruteforce` row (56 ms for 100,000 vectors) suggests for a tighter scan loop. Setup at 100,000 (not part of recall latency, [SPD] `setupMs`): `hybrid-shipped` about 105 s for embeddinggemma (store build plus embedding rows), rrf and fts5 about 45 to 48 s (store build).
- At the real size and at 1,000 lessons nothing here is slow except grep (125.675 ms p95 real, 562.506 ms at 1,000): the slowest embedding-based recall is hybrid-shipped at 49.941 ms p95 (qwen3, real; bge-m3 47.558 ms), almost all of it the live query-embedding call.
- grep at 100,000 files was not measured: the script skips grep above 20,000 files (one token scan took 30 s to minutes in stage 2). At 10,000 files the three samples ran 4082 ms p50 and 28962 ms p95 [SPD].

Storage (DB bytes; embeddings not included for the keyword rows; byte-identical to the stage-2 numbers) [SPD]:

| Retriever | real | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|
| fts5 (and fts5:norecency, same scratch store) | 1,118,208 B | 704,512 B | 5,812,224 B | 58,355,712 B |
| fts5:porter | 393,216 B | 266,240 B | 2,330,624 B | 24,260,608 B |
| fts5:trigram | 946,176 B | 598,016 B | 6,451,200 B | 58,560,512 B |
| grep | 204,908 B | 149,800 B | 1,492,939 B | not measured |

Dense retrievers hold n x dims x 4 bytes of vectors (112 lessons x 768 dims = 344,064 B; the vector cache on disk is about 0.9 to 1.2 MB per model per variant). The real store is larger per lesson than the synthetic ones because real lessons are long.

## 4. Embedding throughput

Command: [EMB] (1,000 synthetic lessons from the generator, batches of 32 through `POST /api/embed`, then 30 single queries; `ollama stop <model>` before each model). 10k and 100k are the 1k time scaled linearly: extrapolations, not measurements. "Cold first call" is one document call right after `ollama stop`; for nomic-embed-text it was 19 ms, so the unload evidently did not take (or the model loads that fast): read the cold column as unreliable for that row. The accuracy run that filled the vector cache did not record its own embedding time (its JSON dropped `timings.embedding`; fixed in the script since), so these figures are the only throughput numbers.

| Model | dims | cold first call ms | ms/lesson (1k, batch 32) | 1k s | 10k s (extrap.) | 100k min (extrap.) | single query p50/p95 ms |
|---|---|---|---|---|---|---|---|
| embeddinggemma | 768 | 1324.006 | 10.837 | 10.8 | 108 | 18 | 27.057 / 29.913 |
| nomic-embed-text | 768 | 19.024 | 8.453 | 8.5 | 85 | 14 | 13.448 / 17.265 |
| mxbai-embed-large | 1024 | 552.769 | 21.216 | 21.2 | 212 | 35 | 22.704 / 24.594 |
| bge-m3 | 1024 | 73.346 | 22.077 | 22.1 | 221 | 37 | 37.507 / 38.809 |
| qwen3-embedding:0.6b | 1024 | 887.918 | 29.966 | 30.0 | 300 | 50 | 35.792 / 47.206 |

## 5. Vector stores

Command: [STO] unless a row says [IVF]. The model is picked by MRR from section 2's prefixed dense rows: `embeddinggemma`, 768 dims. Each (store, size) cell runs in its own child process. "real" is the 112 eligible lessons' document vectors with the 100 real query vectors; 1k, 10k and 100k are synthetic: unit vectors from the seeded PRNG at 768 dims, clustered (about sqrt(n) centres plus noise) so neighbours are meaningful, queries a stored vector plus noise. Uniform random vectors would be harder for an approximate index and say little about real embeddings; they were not run. Query timings are k=10 over up to 50 queries (3 warm-up queries first); recall@10 is against exact brute force on the same vectors. RSS delta is resident memory after build and queries minus before build, in the cell's own process (approximate); peak RSS is the whole cell including the exact baseline. A cell whose predicted build time (the previous size's build scaled linearly) exceeds `--budget-ms` is skipped with that reason.

Index parameters: hnswlib-node `HierarchicalNSW("cosine")` M=16, efConstruction=200, ef=64; usearch cosine f32, connectivity 16, expansion_add 200, expansion_search 64; sqlite-vec `vec0` (full scan, exact); lancedb flat (no index, exact) and `ivfPq` index (library defaults, cosine; trained at build); vectra `LocalIndex` (JS scan, exact); bruteforce is a JS exact cosine scan over a flat Float32Array.

Accuracy on the real snapshot (exact stores and the ANN stores agree with brute force on every query: overlap@8 is 1 for each; `lancedb-ivfpq` could not run at 112 vectors, it needs 256 to train):

| Store | R@8 | MRR | P@8 | overlap@8 with exact |
|---|---|---|---|---|
| bruteforce | 0.9200 | 0.6952 | 0.1150 | 1 |
| sqlite-vec | 0.9200 | 0.6952 | 0.1150 | 1 |
| lancedb | 0.9200 | 0.6952 | 0.1150 | 1 |
| hnswlib | 0.9200 | 0.6952 | 0.1150 | 1 |
| usearch | 0.9200 | 0.6952 | 0.1150 | 1 |
| vectra | 0.9200 | 0.6952 | 0.1150 | 1 |

Speed and scale:

| Store | Vectors | Build ms | Query p50/p95 ms (k=10) | Storage | recall@10 vs exact | RSS delta MB | peak RSS MB |
|---|---|---|---|---|---|---|---|
| bruteforce | real (112) | 0.007 | 0.065 / 0.081 | 344064 | 1 | 0 | 65 |
| bruteforce | 1000 (1000) | 0.006 | 0.565 / 0.57 | 3072000 | 1 | 0 | 58 |
| bruteforce | 10000 (10000) | 0.009 | 5.604 / 5.894 | 30720000 | 1 | 0 | 85 |
| bruteforce | 100000 (100000) | 0.012 | 56.238 / 59.309 | 307200000 | 1 | 0 | 349 |
| sqlite-vec | real (112) | 259.049 | 0.461 / 0.842 | 3186688 | 1 | 7 | 68 |
| sqlite-vec | 1000 (1000) | 49.163 | 0.394 / 0.447 | 3198976 | 1 | 7 | 66 |
| sqlite-vec | 10000 (10000) | 467.975 | 4.488 / 4.553 | 31752192 | 1 | 7 | 92 |
| sqlite-vec | 100000 (100000) | 4697.355 | 46.486 / 48.574 | 310947840 | 1 | 7 | 357 |
| lancedb | real (112) | 94.405 | 0.527 / 0.738 | 346202 | 1 | 45 | 125 |
| lancedb | 1000 (1000) | 46.774 | 0.755 / 1 | 3081255 | 1 | 87 | 165 |
| lancedb | 10000 (10000) | 284.097 | 4.359 / 4.702 | 30801449 | 1 | 373 | 478 |
| lancedb | 100000 (100000) | 3284.139 | 28.338 / 39.213 | 307993464 | 1 | 2440 | 3462 |
| lancedb-ivfpq | real | not measured: IVF_PQ needs at least 256 vectors to train (has 112) | | | | | |
| lancedb-ivfpq | 1000 (1000) | 265.229 | 0.589 / 0.839 | 3923038 | 0.624 | 106 | 183 |
| lancedb-ivfpq | 10000 (10000) | 1596.786 | 0.721 / 1.102 | 32090914 | 0.286 | 407 | 512 |
| lancedb-ivfpq | 100000 (100000) | 17611.109 | 2.306 / 2.546 | 313842734 | 0.082 | 2274 | 3408 |
| lancedb-ivfpq (rerun [IVF]) | 1000 | 470.905 | 0.595 / 0.809 | 3923038 | 0.626 | 93 | 170 |
| lancedb-ivfpq (rerun [IVF]) | 10000 | 1924.027 | 0.711 / 0.987 | 32090913 | 0.292 | 422 | 527 |
| lancedb-ivfpq (rerun [IVF]) | 100000 | 23614.629 | 3.587 / 7.541 | 313842669 | 0.06 | 847 | 2649 |
| lancedb-ivfpq:refine10 [IVF] | 1000 | 181.971 | 1.262 / 3.214 | 3923038 | 1 | 99 | 177 |
| lancedb-ivfpq:refine10 [IVF] | 10000 | 1798.133 | 1.398 / 1.896 | 32090913 | 0.99 | 424 | 529 |
| lancedb-ivfpq:refine10 [IVF] | 100000 | 20300.632 | 2.944 / 3.29 | 313842990 | 0.406 | 951 | 3044 |
| hnswlib | real (112) | 13.715 | 0.108 / 0.113 | 360764 | 1 | 5 | 66 |
| hnswlib | 1000 (1000) | 592.69 | 0.299 / 0.343 | 3220244 | 1 | 7 | 66 |
| hnswlib | 10000 (10000) | 13121.87 | 0.348 / 0.384 | 32209328 | 1 | 36 | 122 |
| hnswlib | 100000 | not measured: predicted build 131219 ms (linear from 10000 vectors in 13122 ms) exceeds --budget-ms 120000 | | | | | |
| usearch | real (112) | 7.811 | 0.058 / 0.062 | 360304 | 1 | 1 | 72 |
| usearch | 1000 (1000) | 442.388 | 0.218 / 0.245 | 3216860 | 1 | 4 | 74 |
| usearch | 10000 (10000) | 10514.845 | 0.27 / 0.295 | 32202136 | 1 | 33 | 130 |
| usearch | 100000 (100000) | 112984.2 | 0.31 / 0.404 | 322081552 | 0.998 | 320 | 682 |
| vectra | real (112) | 19.28 | 0.092 / 0.099 | 1828394 | 1 | 2 | 173 |
| vectra | 1000 (1000) | 90.01 | 0.624 / 0.67 | 16272253 | 1 | 36 | 232 |
| vectra | 10000 (10000) | 1124.336 | 6.467 / 6.875 | 162732505 | 1 | 471 | 836 |
| vectra | 100000 | not measured: Error saving index: RangeError: Invalid string length | | | | | |

Supplemental cell, run separately because the predicted time exceeded the budget: `node evals/bench-memory.mjs stores --model embeddinggemma --stores hnswlib --sizes 100000 --budget-ms 300000 --json`: hnswlib at 100,000 vectors built in 129,707 ms, query p50 0.363 / p95 0.436 ms, 322,065,624 B, recall@10 0.998, RSS delta 325 MB, peak RSS 675 MB.

Notes on the cells:

- `vectra` at 100,000 failed with `Error saving index: RangeError: Invalid string length` (its index is one JSON string; at 10,000 vectors it was already 162,732,505 B on disk). Not measured at that size; no rerun fixes it short of a different storage format.
- `lancedb-ivfpq` with default parameters: query 2.3 ms at 100,000 but recall@10 only 0.082 (0.624 at 1,000, 0.286 at 10,000) in the stage-2 run; the stage-3 rerun gave 0.626, 0.292 and 0.06 [IVF] (index training is not bit-reproducible).
- Why so low: the synthetic set has a near-tie structure. A query's nearest vector is its own source (mean cosine 0.958), and the next ten neighbours sit within 0.0126 (1,000 vectors) / 0.0105 (10,000) of each other (mean cosine by rank 2 to 11: 0.7834 down to 0.7708 at 1,000; 0.7869 down to 0.7764 at 10,000) [TIE]. Product quantization's coarse distances cannot order ten near-ties, so approximate recall@10 is low even when the right region is searched. A real embedding's neighbour structure is not this flat, which is why the real-size overlap@8 of 1 for every ANN store above is trivially true: 112 vectors are fewer than any index's search width.
- `lancedb-ivfpq:refine10` (`refineFactor(10)`: each query re-ranks 10 x k candidates with the exact vectors, `@lancedb/lancedb` `dist/query.d.ts:390`) repairs it at 1,000 and 10,000 vectors: recall@10 1 and 0.99 at 1.262 and 1.398 ms p50 (against 0.626 and 0.292 at 0.6 to 0.7 ms) [IVF]. It does not repair 100,000: 0.406 at 2.944 ms (against 0.06), so a refine factor of 10 is not enough there. `nprobes` was not varied in the bench; a separate probe during review found nprobes 50 changed nothing at 10,000 (not re-measured here).
- The exact stores at 100,000 vectors: bruteforce 56.2 ms p50, sqlite-vec 46.5 ms, lancedb flat 28.3 ms. The ANN stores answer in about 0.3 ms (hnswlib, usearch) at recall@10 0.998, and pay for it in build time (113 s and 130 s against 3 to 5 s).
- Native-memory cost differs: lancedb needed 2,440 MB resident delta at 100,000 vectors (peak 3,462 MB), because it builds from an array of row objects; the rest stayed under 700 MB peak.

Dependency cost (`du -skL` of the package's resolved install directory including the dependencies pnpm linked beside it; native binaries found by `find -L` for `*.node`, `*.dylib`, `*.so`; the usearch count includes prebuilds for other platforms that ship in the package):

| Package | version | installed KB (with deps) | native binaries | built from source |
|---|---|---|---|---|
| sqlite-vec | 0.1.9 | 188 | 1 (sqlite-vec-darwin-arm64/vec0.dylib) | false |
| @lancedb/lancedb | 0.39.0 | 289776 | 1 (@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node) | false |
| hnswlib-node | 3.0.0 | 4368 | 1 (hnswlib-node/build/Release/addon.node) | true |
| usearch | 2.26.2 | 26364 | 4 (usearch/prebuilds/linux-arm64/usearch.node, usearch/prebuilds/win32-x64/usearch.node) | false |
| vectra | 0.15.0 | 91096 | 0 () | false |

## 6. Agent-memory frameworks

All four ran on local Ollama only: embedder `embeddinggemma` (the stage-2 best dense model), LLM `gemma4:latest` where a framework extracts with one. No paid API was called. Each framework is a small adapter in `evals/frameworks/<name>.py` over a JSON-line protocol (`_proto.py`); the bench's `frameworkRetriever` sends the 112 eligible lessons, asks for k=8 keys and maps the framework's ids back to lesson keys, so the framework is scored by the same code and queries as every other retriever. Every framework API fact below is from the installed package's source (file:line of the installed copy), not from its docs.

**Prefixes.** Stage 3's first draft said none of Mem0, LangMem or Letta can apply embeddinggemma's query / document prefixes. That was wrong, and the rerun below corrects it: Mem0's embedder is told what a text is for (`embed(text, memory_action)`, `mem0/embeddings/ollama.py:39`, "add" or "search"), LangMem's store accepts a LangChain `Embeddings` object with separate `embed_documents` and `embed_query` (`langgraph/store/base/__init__.py:598`; `langchain_core.embeddings.Embeddings`), and Letta's server embeds whatever text it is given, so a client can put the prefix in the stored text and in the query. The adapters take `{"prefix": true}` (the model's prefixes from the bench's table) and `{"field": "content"}` (LangMem: embed only the content field). With the prefix on, three frameworks land exactly on `dense:embeddinggemma` (MRR 0.6952), and without it exactly on `dense:embeddinggemma:noprefix` (0.6539) [ACC] [M0V] [LMV] [LTV].

| Framework / variant | Outcome | MRR | R@8 | P@8 | paraphrase R@8 | Ingest, 112 lessons | LLM calls | Search p50 / p95 ms (real) |
|---|---|---|---|---|---|---|---|---|
| Mem0 `verbatim`, prefix on | measured | 0.6952 | 0.9200 | 0.1150 | 0.7500 | 7.8 s | 0 | 27.906 / 31.057 |
| Mem0 `verbatim`, no prefix | measured | 0.6539 | 0.8800 | 0.1100 | 0.5000 | 7.8 s | 0 | 27.906 / 31.057 |
| LangMem, content field only, prefix on | measured | 0.6952 | 0.9200 | 0.1150 | 0.7500 | 7.5 s | 0 | 29.802 / 36.391 |
| LangMem, content field only, no prefix | measured | 0.6539 | 0.8800 | 0.1100 | 0.5000 | 7.2 s | 0 | 29.802 / 36.391 |
| LangMem, LangMem's own default wrapper, prefix on | measured | 0.6579 | 0.8900 | 0.1113 | 0.6875 | 7.3 s | 0 | 28.99 / 35.655 |
| LangMem, LangMem's own default wrapper, no prefix | measured | 0.5834 | 0.8500 | 0.1062 | 0.5000 | 7.2 s | 0 | 28.99 / 35.655 |
| Letta archival passages (retired server), prefix on (client side) | measured | 0.6952 | 0.9200 | 0.1150 | 0.7500 | 30.7 s | 0 | 197.936 / 214.842 |
| Letta archival passages (retired server), no prefix | measured | 0.6539 | 0.8800 | 0.1100 | 0.5000 | 34.3 s | 0 | 197.936 / 214.842 |
| Mem0 `extract`, thinking on | sample + extrapolation only | n/m | n/m | n/m | n/m | 64.97 s per lesson (14 lessons), about 121 min extrapolated | 1 per lesson | n/m |
| Mem0 `extract`, thinking off (2026-10-02) | measured, nondeterministic; 5 of 112 lessons stored zero memories and 4 extraction responses failed to parse, all counted as misses | 0.3169 | 0.5800 | 0.0725 | 0.1875 | 50.6 min (27.1 s per lesson) | 112 | n/m |
| Graphiti (Zep's engine) | not measurable on local gemma4 | n/m | n/m | n/m | n/m | 273 s (lesson 1) and 813 s then a JSON decode failure (lesson 2) | 3 for lesson 1, 6 for 2 lessons | n/m |

Sources: Mem0 verbatim [M0V]; LangMem [LMV]; Letta [LTV]; Mem0 extract [M0X4], [M0X8], [M0XF]; Graphiti [GR]; search latencies and ingest at larger sizes [FWS] (an earlier, unprefixed run; the ingest column above is from the rerun's `timings`). Search latency is the whole round trip the bench sees: it includes one live Ollama query embedding (13 to 47 ms in section 4) and the pipe, so it is not the framework's own scoring time.

### Mem0 (mem0ai 2.2.1, embedded Qdrant)

- Config from `mem0/configs/base.py` `MemoryConfig` (`vector_store` qdrant with `path` and `on_disk`, `embedder` ollama, `llm` ollama, `history_db_path`); Ollama embedder `mem0/embeddings/ollama.py` (`embed()` sends the text it is given; the adapter's prefix option wraps `embed` and `embed_batch` and adds the document prefix on "add" and the query prefix on "search"); Ollama LLM `mem0/llms/ollama.py` (`format: json`, `num_predict = max_tokens`).
- `verbatim` is `memory.add(text, user_id=..., metadata={"key": ...}, infer=False)`: `infer` exists at `mem0/memory/main.py:770`, and the `not infer` branch at `main.py:882` embeds the message and stores it as is. Our key travels in `metadata` and comes back under `result["metadata"]["key"]` (`main.py:1735`). A search with Mem0's default `threshold=0.1` (`main.py:1642`) can drop low-scoring hits, so the adapter passes `threshold=0`.
- Its result equals `dense:embeddinggemma:noprefix` to the last digit unprefixed (MRR 0.6539404761904766 both) and `dense:embeddinggemma` prefixed (0.6952) [M0V] [ACC]: with BM25 and spaCy entity boosting unavailable (neither `spacy` nor `fastembed` is installed; Mem0 logged "fastembed not installed - BM25 keyword search disabled" and a spaCy warning, `main.py:1648-1678`), Mem0's search over the default install is plain cosine over Qdrant. The `mem0ai[nlp]` / `[extras]` hybrid scoring was not measured.
- `extract` (`infer=True`) makes one LLM call per add (`main.py:958`, "Phase 2: LLM extraction (single call)") and stores each extracted fact as its own memory. gemma4 is a thinking model and its thinking was left on in the first sample: 36.7 to 94.5 s per lesson (mean 64.97 s over a 14-lesson sample, 14 LLM calls, 96 memories, 6.9 facts per lesson) [M0X8]; 4 lessons took 57.2 s each [M0X4]. Thinking inflates this time. Turning it off is one flag for Mem0 (Ollama's `think: false` on the chat call; adapter option `{"think": false}`): the same 4 lessons then took 29.7 s each (118.9 s, 29 memories, one lesson extracting nothing) [M0X4], 1.9 times faster, so the thinking-on figures above overstate the cost of LLM extraction by about that factor. Caveat: that speed-up may not be free. Turning thinking off may have cost JSON validity as well as halving the time: the thinking-on runs had 0 "Error parsing extraction response" lines and 0 empty lessons (0 of 18 lessons, 4 + 14 [M0X4] [M0X8]), while the full thinking-off run's log (`s4-m0x-nothink-full.err`) has 4 lines `Error parsing extraction response: Expecting ',' delimiter: line 1 column 816 (char 815)` (and three more of the same kind, at line 4 columns 253, 157 and 245), and 5 of its 112 lessons logged `0 memories` (lessons 4, 32, 62, 63 and 111, each e.g. `mem0 extract: lesson 32/112 17.5s, 0 memories`). A lesson that stores nothing cannot be retrieved. The thinking-off 4-lesson sample also stored zero memories for lesson 4 without a parse error, so not every empty lesson is a parse failure. With thinking off the full 112-lesson ingest was run (about 55 minutes was the sample's extrapolation, under the 60-minute limit): 50.6 minutes, 112 LLM calls, 772 stored memories (6.9 per lesson), and it scores MRR 0.3169, R@8 0.5800, paraphrase R@8 0.1875, against `verbatim` with the same unprefixed embedder at 0.6539, 0.8800, 0.5000 [M0XF]. The score counts the 5 lessons that stored zero memories as misses (every query whose expected lesson is one of them scores 0), so part of the gap to verbatim is lost JSON validity, not only worse facts; the log shows 4 `Error parsing extraction response` lines (see the caveat below). This row is nondeterministic (an LLM extracts), run on 2026-10-02, and is reported under `nondeterministic` in the JSON. On the every-8th thinking-on sample, scored on the 10 queries whose expected lesson is in the 14 sampled lessons, `extract` has R@8 0.9000 and MRR 0.6375 against `verbatim` on the same 14-lesson store R@8 1.0000 and MRR 0.8833 [M0X8] (10 queries, one paraphrase: a direction, not a number). `max_tokens` was set to 4000 because Mem0's default of 2000 is `num_predict` and a thinking model spends it before the JSON answer; with 2000 the content could be empty.

### LangMem (langmem 0.0.30, LangGraph `InMemoryStore`)

- LangMem has no retrieval of its own: its search tool calls `store.search(namespace, query=..., limit=...)` (`langmem/knowledge/tools.py:465`) and its manage tool writes `store.put(namespace, key=<id>, value={"content": ...})` (`tools.py:332`). The adapter makes those two calls on `InMemoryStore(index={"dims": 768, "embed": <embedder>})`; `IndexConfig.embed` accepts a callable or a LangChain `Embeddings` object (`langgraph/store/base/__init__.py:598`). With `prefix: true` the adapter passes an `Embeddings` subclass whose `embed_documents` adds the document prefix and `embed_query` the query prefix. Key = our key, so no mapping is required. No LLM is on this path.
- As LangMem writes it, the default index field `["$"]` embeds the JSON of the whole value, `{"content": "<text>"}` (`langgraph/store/base/embed.py:247`). That wrapper costs 0.0705 MRR unprefixed (0.5834 against 0.6539) and 0.0373 prefixed (0.6579 against 0.6952) [LMV]. Indexing only the `content` field (`put(..., index=["content"])`) recovers the dense numbers exactly in both cases [LMV]. A product that stored lessons through LangMem unmodified would pay the wrapper cost.

### Graphiti (graphiti-core 0.30.2, embedded FalkorDB, and Zep)

- Zep Community Edition is deprecated. The repo README (`https://github.com/getzep/zep`, raw `README.md` lines 66-69, checked with `grep -n` on the downloaded file) says: "Zep Community Edition is no longer supported. Its code has been moved to the [`legacy/`](legacy/) folder."; line 45 labels `legacy/` "Deprecated Zep Community Edition (unsupported)". So Graphiti, Zep's open-source engine, is the measured Zep engine; Zep Cloud is a paid service and was not run.
- Backend: falkordblite 0.10.0 installed on Python 3.12 and its embedded server ran (`redislite.async_falkordb_client.AsyncFalkorDB`, passed to `FalkorDriver(falkor_db=...)`, `graphiti_core/driver/falkordb_driver.py:139`); no Neo4j or Docker was needed. LLM through `OpenAIGenericClient` at Ollama's `/v1` (`llm_client/openai_generic_client.py:40`); embedder `OpenAIEmbedder` with `base_url` pointed at Ollama (`embedder/openai.py:27-60`); `Graphiti.search()` is BM25 + cosine + RRF over entity edges (`graphiti.py:1628`, `EDGE_HYBRID_SEARCH_RRF`) and does not call the cross-encoder, so a no-op cross-encoder replaces the OpenAI default (`graphiti.py:227`) that would need an OpenAI key.
- One episode per lesson (`add_episode`, `graphiti.py:1043`). Its `uuid` argument names an existing episode to load, so passing our id fails with `NodeNotFoundError` (first attempt, 0 LLM calls); the adapter takes the new episode's uuid from the result and maps `EntityEdge.episodes` (`edges.py:267`) back to our key.
- Result [GR]: lesson 1 took 273.0 s (3 LLM calls); lesson 2 took 813.1 s (3 more) and then failed with `JSONDecodeError: Unterminated string starting at: line 137` (gemma4's JSON truncated or malformed through the structured-output path). 112 lessons at 273 s would be about 8.5 hours: an extrapolation from a single lesson, not a lower bound (lesson 2 took three times as long and then failed; two lessons are not a distribution). gemma4's thinking was left on for Graphiti, which inflates its time and plausibly its truncated JSON (the thinking tokens come out of the same budget); whether Graphiti's OpenAI-compatible client can switch it off (`reasoning_effort` through Ollama's `/v1`) was not tried, and Graphiti's calls go through a different client than Mem0's, so it is not the same one-flag change. Not run in full, so Graphiti has no accuracy number; a 1-lesson store scores nothing meaningful. A bare `graphiti` (no variant) is now routed as nondeterministic by the bench; the sample above ran before that change.

### Letta (the retired Python server; the current Docker image cannot do this)

- The brief's plan was the `letta/letta` Docker image. `docker pull letta/letta:latest` (1.72 GB) pulled an image whose labels name `letta-ai/letta-code` and whose entrypoint (`/usr/local/bin/letta-container-entrypoint`) prints: "The retired Python Letta server is end-of-life and this image now contains Letta Code" and points to `https://docs.letta.com/self-hosting/`. Its `letta server --listen` is a WebSocket "App Server"; it has no archival-passages REST API. The Letta docs pages (self-hosting, archival memory) were not read: the research-budget hook (6 fetches) blocked further fetches, so the current self-hosting path is unverified.
- What ran instead: the last Python server on PyPI, `letta==0.16.8` (`uv pip install "letta<0.30"` into a second venv; PyPI's current `letta 0.34.2` is Letta Code), against a pgvector Postgres in Docker (`pgvector/pgvector:pg16`, container `doug-bench-pg`, removed at the end). Bringing it up needed four fixes that are findings in themselves: `mcp` had to be pinned to 1.12.4 and `fastmcp` to 2.12.5 (the wheel's loose `mcp>=1.9.4` / `fastmcp>=2.12.5` resolved to releases it cannot import); `asyncpg` is not a declared dependency; the server has no SQLite fallback (it tried port 5432) and the wheel ships no alembic migrations, so the schema is created from the ORM models (`evals/frameworks/letta_initdb.py`, 48 tables). This is a retired, end-of-life server: the number says what its archival memory retrieves, not what the current Letta does.
- Client: `letta-client` 1.12.1. `archives.create(embedding_config={"embedding_endpoint_type": "ollama", "embedding_endpoint": "http://localhost:11434/v1", ...})` (`resources/archives/archives.py:61`, `types/embedding_config_param.py`; the endpoint needs the `/v1` suffix or the server calls `/embeddings` and gets a 404), `archives.passages.create(archive_id, text=..., metadata={"key": ...})` (`resources/archives/passages.py:47`), and retrieval through `passages.search(archive_id=..., query=..., limit=k)` (`resources/passages.py:48`, `POST /v1/passages/search`), not an agent turn, so the LLM is not involved (0 calls). Our key is mapped from the passage ids returned at creation. The server embeds the text it is given, so the prefix option puts the document prefix in the stored text and the query prefix in the query.
- Result [LTV]: unprefixed MRR 0.6539, prefixed 0.6952: archival search over Ollama embeddings is a cosine search too. Cost: 30.7 to 34.3 s to insert 112 passages and 220.0 s for 1,000 (0.22 s per passage), so 10,000 would be about 37 minutes (extrapolation, not run); search 198 to 204 ms p50 over REST [FWS]; storage about 53.4 MB in the Postgres data directory for 112 passages (53,420,032 and 53,346,304 B in the two [FWD] runs: it varies run to run, so Letta's `storageBytes` is the one framework field that is not byte-stable); the server, Postgres and venv are 798 MB + a 650 MB image.

### Speed at 1,000 and 10,000 lessons

Ingest and search at larger sizes [FWS] (synthetic lessons; the framework embeds them through Ollama, so ingest is embedding-bound; search includes the live query embedding; no prefixes):

| Framework | Ingest 1,000 | Ingest 10,000 | Search p50 / p95 ms, 1,000 | Search p50 / p95 ms, 10,000 |
|---|---|---|---|---|
| Mem0 verbatim | 33.9 s | 403.9 s | 53.658 / 55.682 | 94.976 / 103.357 |
| LangMem | 32.9 s | 325.2 s | 61.39 / 66.251 | 191.364 / 227.463 |
| LangMem `content` | 32.8 s | 323.3 s | 61.492 / 64.031 | 192.537 / 227.459 |
| Letta | 220.0 s | about 2,200 s (extrapolated, not run) | 204.135 / 215.043 | not run |

`:extract` and Graphiti are not timed at synthetic sizes by design (LLM extraction at 30 to 800 s per lesson). For scale: bench `dense` at 10,000 is 15 to 19 ms and `hybrid-shipped` 87 to 102 ms (section 3), so the in-process paths are faster than every framework's search, which is a network or a process hop plus the same Ollama embedding.

## 7. Usefulness

Command: `node evals/bench-memory.mjs usefulness` (reads the report inputs `snapshot` froze beside the snapshot).

- Lesson counters (156 lessons): 38 with helpful > 0 (sum 87), 11 with harmful > 0 (sum 14). Top helpful: `doug-build-progress.md` 19, `eval-accuracy-landing.md` 6, `fix-loop-lessons.md` 5. Top harmful: `doug-build-progress.md` 3, `fix-loop-lessons.md` 2.
- `reflections` table: 10 rows, counters helpful 87, harmful 14, unknown 0 (they match the lesson sums).
- Reports: only one report JSON on disk has a `levels` array (`.doug/.state/last-report.json`; the per-card directories hold only `condition.json`). In it, 2 of 3 tasks had a non-empty `memoryUsed`, 6 distinct lesson ids, all resolving to a lesson. Thin evidence; the counters are the usable signal.

## 8. One ranking across the three stages

Ordered by accuracy (MRR over the 100 queries, k=8), with the p95 recall at the real size as the tie-break, then scale as the last column. Sources: stage 1 rows [ACC]; stage 2 rows [ACC], [SPD], [STO], [IVF]; stage 3 rows [ACC], [M0V], [LMV], [LTV], [M0XF], [FWS] (framework search latencies and ingest times come from [FWS], which ran without prefixes; a prefix changes the text sent to the embedder, not the round trip). "(live)" marks a p95 that includes one live Ollama query embedding; the other rows use a cached query vector. Retrievers the table leaves out are in the section 2 table.

| # | Stage | Retriever | MRR | R@8 | paraphrase R@8 | p95 ms, real | Scale | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | dense:embeddinggemma | 0.6952 | 0.9200 | 0.7500 | 1.085 | 198.67 ms p95 at 100k (JS scan); usearch store 0.404 ms p95 at 100k, 113 s build | the best row; prefixes worth +0.0413 MRR |
| 2 | 3 | mem0 verbatim, prefix on | 0.6952 | 0.9200 | 0.7500 | 31.057 (live) | ingest 33.9 s per 1,000; search p95 103 ms at 10,000 | = dense:embeddinggemma; latency from the unprefixed run [FWS] |
| 3 | 3 | langmem, content field, prefix on | 0.6952 | 0.9200 | 0.7500 | 36.391 (live) | ingest 32.8 s per 1,000; search p95 227 ms at 10,000 | = dense:embeddinggemma |
| 4 | 3 | letta archival search (retired server), prefix on (client side) | 0.6952 | 0.9200 | 0.7500 | 214.842 (live) | ingest 220 s per 1,000; search p50 204 ms at 1,000 | = dense:embeddinggemma; needs Postgres + server |
| 5 | 2 | dense:qwen3-embedding:0.6b | 0.6688 | 0.9100 | 0.6250 | 0.845 | 217.095 ms p95 at 100k | 1024 dims, 50 min per 100k to embed |
| 6 | 2 | dense+kwboost:embeddinggemma | 0.6682 | 0.8800 | 0.5625 | 0.875 | not timed | best fusion |
| 7 | 3 | langmem, LangMem's own default wrapper, prefix on | 0.6579 | 0.8900 | 0.6875 | 35.655 (live) | ingest 32.9 s per 1,000 | the JSON wrapper still costs 0.0373 |
| 8 | 2 | dense:embeddinggemma:recency | 0.6576 | 0.9000 | 0.6250 | 0.215 | not timed | plain dense with the shipped recency weight |
| 9 | 2 | dense:embeddinggemma:noprefix | 0.6539 | 0.8800 | 0.5000 | 0.154 | not timed | the reference for the unprefixed framework rows |
| 10 | 3 | mem0 verbatim, no prefix | 0.6539 | 0.8800 | 0.5000 | 31.057 (live) | ingest 33.9 s per 1,000 | = dense noprefix |
| 11 | 3 | langmem, content field, no prefix | 0.6539 | 0.8800 | 0.5000 | 36.391 (live) | ingest 32.8 s per 1,000 | = dense noprefix |
| 12 | 3 | letta archival search (retired server), no prefix | 0.6539 | 0.8800 | 0.5000 | 214.842 (live) | ingest 220 s per 1,000 | = dense noprefix |
| 13 | 2 | dense:mxbai-embed-large | 0.6506 | 0.8400 | 0.4375 | 0.483 | 240.264 ms p95 at 100k |  |
| 14 | 2 | wrrf:qwen3-embedding:0.6b:w3 | 0.6496 | 0.8500 | 0.1875 | 1.163 | not timed | weighting hurts paraphrase |
| 15 | 2 | dense:bge-m3 | 0.6469 | 0.8600 | 0.3750 | 0.734 | 228.084 ms p95 at 100k |  |
| 16 | 2 | dense:nomic-embed-text | 0.6463 | 0.8400 | 0.4375 | 0.386 | 210.649 ms p95 at 100k | fastest to embed (8.5 ms per lesson) |
| 17 | 2 | rerank:embeddinggemma | 0.6323 | 0.8300 | 0.1875 | 0.794 | not timed |  |
| 18 | 2 | rrf:qwen3-embedding:0.6b:d10 | 0.6272 | 0.9100 | 0.5625 | 1.022 | not timed | shallow rrf |
| 19 | 2 | rrf:embeddinggemma | 0.5945 | 0.8000 | 0.0625 | 0.893 | 252.018 ms p95 at 100k |  |
| 20 | 2 | hybrid-shipped:embeddinggemma:norecency | 0.5945 | 0.8000 | 0.0625 | 41.897 (live) | not timed | recency 1 |
| 21 | 3 | langmem, LangMem's own default wrapper, no prefix | 0.5834 | 0.8500 | 0.5000 | 35.655 (live) | ingest 32.9 s per 1,000 | JSON wrapper costs 0.0705 |
| 22 | 2 | hybrid-shipped:bge-m3 | 0.5584 | 0.7900 | 0.0000 | 47.558 (live) | 1584.225 ms p95 at 100k | what Doug ships (best of the five) |
| 23 | 2 | hybrid-shipped:embeddinggemma | 0.5549 | 0.8100 | 0.1250 | 45.889 (live) | 1368.671 ms p95 at 100k | what Doug ships with the default model |
| 24 | 2 | hybrid-shipped:nomic-embed-text | 0.5181 | 0.8000 | 0.0625 | 23.685 (live) | 1363.611 ms p95 at 100k | what Doug ships (worst of the five) |
| 25 | 2 | fts5:porter | 0.5043 | 0.7700 | 0.1875 | 0.431 | 25.923 ms p95 at 100k | best keyword |
| 26 | 2 | fts5:norecency | 0.4707 | 0.7400 | 0.0625 | 0.707 | 62.164 ms p95 at 100k |  |
| 27 | 2 | fts5:trigram | 0.4593 | 0.7100 | 0.1250 | 0.615 | 40.641 ms p95 at 100k |  |
| 28 | 1 | fts5 (shipped keyword path) | 0.4056 | 0.7400 | 0.0625 | 2.022 | 631.519 ms p95 at 100k | stage 1 baseline |
| 29 | 1 | grep | 0.3531 | 0.6600 | 0.0000 | 125.675 | not measured (4082 ms p50 at 10k) |  |
| 30 | 3 | mem0 extract, thinking off (full 112 lessons; nondeterministic) | 0.3169 | 0.5800 | 0.1875 | n/m | ingest 50.6 min | LLM extraction, one run; 5 empty lessons and 4 JSON parse errors, scored as misses |
| not run | 3 | mem0 extract, thinking on | n/m | n/m | n/m | n/m | 64.97 s per lesson, about 121 min for 112 (extrapolated) | sample: worse than verbatim (R@8 0.9000 against 1.0000, MRR 0.6375 against 0.8833 on 10 queries) |
| not run | 3 | graphiti (Zep's engine) | n/m | n/m | n/m | n/m | 273 to 813 s per lesson | failed to extract lesson 2 |

Vector stores (stage 2, section 5) do not change accuracy: every exact store returns the same ranking as `dense:embeddinggemma` (R@8 0.9200, MRR 0.6952 [STO]); they differ in speed and scale only. At 100,000 vectors [STO] [IVF]: usearch and hnswlib answer in about 0.3 ms p50 at recall@10 0.998 (build 113 to 130 s), sqlite-vec 46.5 ms exact (build 4.7 s), lancedb flat 28.3 ms exact, bruteforce 56.2 ms; `lancedb-ivfpq` 0.06 to 0.082 recall@10 and `:refine10` 0.406.

## 9. Recommendation: tune, do not replace

Keep the architecture (in-process SQLite with FTS5 and stored embeddings; no server, no framework). Tune the ranking in `recallLessons`. The numbers that decide it:

1. **What ships is the weakest dense-using retriever, and the gap is fusion plus recency, not the store.** With embeddinggemma, the default model, the shipped hybrid scores MRR 0.5549, R@8 0.8100, paraphrase R@8 0.1250 [ACC]. Ranking by cosine alone scores 0.6952, 0.9200, 0.7500; ranking by cosine times the shipped recency weight (`dense:embeddinggemma:recency`) scores 0.6576, 0.9000, 0.6250 [ACC]. The shipped keyword-only path scores 0.4056 [ACC], so the hybrid is already worth +0.1493 MRR over it.
2. **No fusion variant recovers it.** Across five models and seven fusion variants each (rrf at depth 10, 20 and 50; weighted w2 and w3; rerank; dense with a keyword boost) none exceeded its model's dense row on MRR [ACC]. The nearest, `dense+kwboost:embeddinggemma`, is 0.6682 (+0.1133 over shipped, 0.0270 under dense) with paraphrase R@8 0.5625, and 0.0270 is inside the noise band: the choice of plain dense rests on paraphrase R@8 (12 of 16 queries against 9 for kwboost and 10 for qwen3 dense, section 2.2).
3. **Recency is kept in the proposed change, and its cost is measured.** The change below multiplies cosine by the shipped recency weight. That gives embeddinggemma MRR 0.6576, a gain of +0.1027 over the shipped hybrid (R@8 0.8100 to 0.9000, paraphrase R@8 0.1250 to 0.6250) [ACC]; the same change gains +0.1319 for qwen3, +0.0584 nomic, +0.0393 bge-m3 and +0.0346 mxbai (section 2.4). Dropping recency as well would gain a further 0.0376 for embeddinggemma (0.6952), but this query set has no time-sensitive query, so it cannot show that recency is wrong; that is a separate decision for a set that has such queries.
4. **No framework beats the plain cosine ranking on the same embedder, and each adds cost.** With the model's task prefixes applied, Mem0 verbatim, LangMem (content field) and Letta archival search all land on MRR 0.6952, exactly `dense:embeddinggemma`; without them all land on 0.6539, exactly `dense:embeddinggemma:noprefix` [ACC] [M0V] [LMV] [LTV]. They are a cosine search behind an API; nothing in them improves on it, and LangMem's own default storage wrapper loses 0.0373 prefixed (0.0705 unprefixed). LLM extraction (Mem0 `extract`) is 30 to 65 s per lesson on a local 8B model (65 s with thinking on, 30 s with it off; the full thinking-off run scored MRR 0.3169, against verbatim's 0.6539 on the same embedder, with 5 of 112 lessons storing zero memories and 4 JSON parse errors in its log, counted as misses, and with thinking off possibly costing JSON validity as well as halving the time) [M0X4] [M0XF]; Graphiti took 273 to 813 s per lesson and failed to extract one [GR]; Letta needs a server plus Postgres and its current Docker image no longer provides the API [LTV]. Replacing the store would add latency (framework search 28 to 204 ms p50 against hybrid-shipped 17 to 43 ms at the real size, both including one live query embedding) and operations, for no measured accuracy gain on this query set.
5. **Scale is not the problem yet, and is a second card.** At the real size every in-process path is under 50 ms p95, almost all of it the live query embedding [SPD]. At 100,000 lessons the shipped hybrid takes 1.19 to 1.36 s p50 (every query decodes every vector), the shipped keyword path 549.6 ms against 41.1 ms for the bm25 query alone, an import of 50 files 28.0 s and a cold-start recall 602.9 ms [SPD]; the store is two to three orders of magnitude from that today.

**The concrete product change (a follow-up card, not part of this one):** in `plugins/doug-flow/lib/memory.mjs` `recallLessons`, when a provider and stored vectors exist, rank the candidates by cosine similarity times the existing recency weight, and keep BM25 only as the no-provider fallback (the existing keyword-only path), instead of the 50 + 50 RRF fusion times the recency weight. Measured gain on this query set, embeddinggemma: MRR 0.5549 to 0.6576 (+0.1027), R@8 0.8100 to 0.9000, paraphrase R@8 0.1250 to 0.6250 [ACC] (section 2.4 for the other models). The number and the change match: both keep recency. If exact-identifier recall is a worry, the measured lower-risk variant is `dense+kwboost` (BM25 top 3 lifted to ranks 2 to 4), MRR 0.6682 without recency. Two smaller fixes the same card should take or split: give the shipped provider layer the mxbai query prefix and the qwen3 instruction (`embeddings.mjs` `prefixFor`, lines 235-244; prefixes were worth +0.0409 and +0.0407 dense MRR for mxbai and qwen3, section 2.3), and load only the candidate rows in `recallLessons` instead of every live row (86 percent of its 612 ms at 100,000 lessons, section 3).

Limits of this recommendation: one corpus (this repository's 112 live lessons), 100 single-answer queries (differences under about 0.03 MRR are noise), 16 paraphrases written by the same author who designed the check, a local 8B thinking model as the only LLM, `embeddinggemma`'s prefixes unverified (the Hugging Face card is gated), and Mem0's optional BM25 / entity hybrid (`mem0ai[nlp]`) not measured.

### 9.1 Landed: cosine times recency (card recall-dense-ranking, 2026-10-03)

`recallLessons` now ranks by cosine times the recency weight (times the scope boost) when a provider and stored vectors exist, with lesson-id tie-break, and keeps BM25 as the no-provider fallback; BM25 hits with no vector are appended after the vectored lessons. Re-measured with `node evals/bench-memory.mjs accuracy --ollama --models embeddinggemma --json`: `hybrid-shipped:embeddinggemma` MRR 0.6576, up from 0.5549 (+0.1027), equal to the `dense:embeddinggemma:recency` 0.6576 of section 9; `hybrid-shipped:embeddinggemma:norecency` is 0.5945 [ACC], but it stays the pre-change RRF formula with recency 1 (`hybridShippedNorecency` in `evals/bench-memory.mjs`), so 0.5945 is not a norecency of the new ranking. The `hybrid-shipped` rows in the tables above (0.5549 and the like) are all pre-change.

## Left out, and why

- Mem0 `extract` with thinking on over all 112 lessons, and Graphiti over any full set: the sample timings (65 s and 273 to 813 s per lesson) extrapolate to about 2 hours and about 8.5 hours (from one lesson), over the 60-minute limit; the extrapolations are labelled as such. Graphiti's thinking-off run was not tried (section 6).
- Letta's current self-hosting path: the docs fetch was blocked by the research-budget hook, and the current `letta/letta` image has no passages API. The retired server was measured instead.
- Mem0 with `mem0ai[nlp]` / `[extras]` (spaCy, fastembed BM25): not installed, so Mem0's own hybrid scoring is not measured.
- Mem0 / LangMem / Letta at 100,000 lessons: ingest through Ollama at 10 to 100 lessons per second would be hours; 1,000 and 10,000 (Letta: 1,000) were measured and 10,000 for Letta extrapolated. The framework speed runs [FWS] were not repeated with prefixes.
- Chroma and FAISS as vector stores: the card's store list was five packages (sqlite-vec, lancedb, hnswlib-node, usearch, vectra); the research note listed `faiss-node` as a candidate but its install is a prebuild or a source build, and Chroma (a Python or server package, and a Mem0 optional store) was never researched. Neither is a new class: usearch and hnswlib already stand for in-process HNSW ANN, and sqlite-vec, lancedb flat and bruteforce for exact scan, and accuracy does not depend on the store (section 8). Measuring them would add two more rows of build and query time, not a different conclusion.
- `nprobes` tuning for `lancedb-ivfpq` and a uniform-random-vector variant of the matrix; the truncation rate of long lessons at mxbai's 512-token context; the embeddinggemma prefix and the qwen3 task text are unverified.
- Pinning `refineFactor(10)` with an offline test: the adapter needs the native lancedb package; a mutation that removes the refine call survives the offline suite and is caught only by the real run ([IVF]: recall@10 0.99 with it, 0.292 without at 10,000).
- No test covers `install-stores`, `install-frameworks`, the store adapters, `store-cell`, or the `near-ties`, `derive` and `subset` subcommands (they were added after the tester's contract and the test file is not mine to edit): they need installed natives or a venv, or were verified by running them on the logs above.

## Found on the way

- `recallLessons` reads and maps every live row, embedding blobs included, on each call: 549.6 ms at 100,000 lessons for the keyword path and 1.19 to 1.36 s for the hybrid [SPD].
- `plugins/doug-flow/lib/embeddings.mjs` `prefixFor` (235-244) gives mxbai-embed-large no query prefix and qwen3-embedding no instruction, though both model cards require one; the bench measures the shipped path as is.
- `importAutoMemory` is O(files x lessons) for new files: 50 files cost 152 ms at 156 lessons and 28.0 s at 100,000 [SPD].
- The first stage-3 draft concluded that the frameworks "cannot apply prefixes". The review caught it: each exposes a hook (`memory_action`, an `Embeddings` object, or the text itself), and with the prefix on they equal plain dense.
- A query-vector cache shared by a factory made `all` time cached vectors in its speed pass after its accuracy pass; it is per setup now.
- The PyPI package `letta` changed meaning: 0.34.2 is Letta Code, the old server is `letta<0.30`, whose loose pins (`mcp>=1.9.4`, `fastmcp>=2.12.5`) break on current releases, and the `letta/letta` Docker image is Letta Code as well. Anyone following an older Letta guide gets the wrong software.
- A script named after its framework shadows the framework: `mem0.py` run as a script put its own directory first on `sys.path`, so `from mem0 import Memory` imported the adapter (and a bare `ImportError` looked like "not installed"). `_proto.py` now removes the adapter directory from `sys.path` and the protocol reports `notInstalled` only for `ModuleNotFoundError`. The bench also sets `PYTHONDONTWRITEBYTECODE=1` in the adapter's environment so no `__pycache__` appears under `evals/frameworks/`.
- Graphiti's `add_episode(uuid=...)` loads an existing episode rather than naming a new one (`NodeNotFoundError`).
- The research-budget hook (6 fetches) counted the Zep README fetch, its verification download and the first Letta probes; later probes of Ollama's HTTP API with `curl` were blocked, so framework debugging used the bench's own requests and the `ollama` CLI.
- Mem0's default `threshold=0.1` and Ollama `num_predict` equal to `max_tokens` (a thinking model can spend the whole budget on thinking) are silent traps for local reasoning models. Ollama's `think: false` halves the extraction time of a gemma4 call, but the full thinking-off Mem0 run had 4 `Error parsing extraction response` lines and 5 of 112 lessons stored zero memories (thinking-on: 0 of 18), so it may also cost JSON validity.
- The stage-2 mutation logs under `.doug/.state/scratch/mut-*.log` were deleted by a cleanup glob in an earlier session of this card (scratch, gitignored; `.doug/.state/bench/logs/mutations-stage2.log` remains), and `mutate.py` disappeared from the same scratch directory once and was rewritten.
