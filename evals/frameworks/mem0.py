"""Mem0 adapter (mem0ai, embedded Qdrant, Ollama embedder and LLM). Variants: verbatim (infer=False), extract (infer=True).

Every fact below is from the installed mem0ai source (mem0/memory/main.py, mem0/embeddings/ollama.py, mem0/llms/ollama.py).
Our lesson key travels as metadata={"key": ...}; search results carry it under result["metadata"]["key"].
"""
import os
import shutil
import tempfile
import time

os.environ.setdefault("MEM0_TELEMETRY", "False")  # mem0/memory/telemetry.py reads this at import

from _proto import dir_bytes, prefixes, serve  # noqa: E402

state = {}


def setup(lessons, config):
    from mem0 import Memory

    url = config.get("ollamaUrl", "http://localhost:11434")
    embed_model = config.get("embedModel", "embeddinggemma")
    llm_model = config.get("llmModel", "gemma4:latest")
    infer = config.get("variant") == "extract"
    limit = config.get("limit")
    if limit:  # first n lessons: a quick timing sample
        lessons = lessons[: int(limit)]
    if config.get("every"):  # every n-th lesson: a spread sample for a labelled partial accuracy figure
        lessons = lessons[:: int(config["every"])]
    work = tempfile.mkdtemp(prefix="bench-mem0-")
    state["work"] = work
    from ollama import Client

    dims = len(Client(host=url).embed(model=embed_model, input="dimension probe")["embeddings"][0])
    memory = Memory.from_config(
        {
            "llm": {"provider": "ollama", "config": {"model": llm_model, "ollama_base_url": url, "temperature": 0, "max_tokens": 4000}},
            "embedder": {"provider": "ollama", "config": {"model": embed_model, "ollama_base_url": url, "embedding_dims": dims}},
            "vector_store": {"provider": "qdrant", "config": {"collection_name": "bench", "path": os.path.join(work, "qdrant"), "embedding_model_dims": dims, "on_disk": True}},
            "history_db_path": os.path.join(work, "history.db"),
        }
    )
    calls = {"n": 0}
    original = memory.llm.generate_response

    def counted(*a, **kw):
        calls["n"] += 1
        return original(*a, **kw)

    memory.llm.generate_response = counted
    pre = prefixes(embed_model, config.get("prefix"))
    if config.get("prefix"):
        # Mem0's embedder is told what the text is for: embed(text, memory_action) with "add" or "search"
        # (mem0/embeddings/ollama.py:39), so the document prefix goes on add and the query prefix on search.
        raw_embed, raw_batch = memory.embedding_model.embed, memory.embedding_model.embed_batch
        memory.embedding_model.embed = lambda text, memory_action=None: raw_embed((pre["query"] if memory_action == "search" else pre["doc"]) + text, memory_action)
        memory.embedding_model.embed_batch = lambda texts, memory_action="add": raw_batch([(pre["query"] if memory_action == "search" else pre["doc"]) + t for t in texts], memory_action)
    if config.get("think") is False:
        # gemma4 is a thinking model; Ollama's `think` flag turns the thinking off for the LLM client's calls.
        raw_chat = memory.llm.client.chat
        memory.llm.client.chat = lambda **kw: raw_chat(think=False, **kw)
    state["memory"] = memory
    t0 = time.perf_counter()
    stored = 0
    for i, lesson in enumerate(lessons):
        t1 = time.perf_counter()
        res = memory.add(lesson["text"], user_id="bench", metadata={"key": lesson["key"]}, infer=infer)
        stored += len(res.get("results", []))
        print(f"mem0 {config.get('variant')}: lesson {i + 1}/{len(lessons)} {time.perf_counter() - t1:.1f}s, {len(res.get('results', []))} memories, llm calls so far {calls['n']}", flush=True)
    setup_ms = (time.perf_counter() - t0) * 1000
    print(f"mem0: stored {stored} memories from {len(lessons)} lessons in {setup_ms / 1000:.1f}s", flush=True)
    return {"setupMs": round(setup_ms, 1), "storageBytes": dir_bytes(work), "llmCalls": calls["n"]}


def search(query, k):
    # threshold=0 so the ranking, not the default 0.1 score cut-off, decides what comes back (main.py search(): threshold=0.1).
    res = state["memory"].search(query, top_k=k, filters={"user_id": "bench"}, threshold=0.0)["results"]
    keys = []
    for r in res:
        key = (r.get("metadata") or {}).get("key")
        if key:
            keys.append(key)
    return keys


def close():
    mem = state.get("memory")
    try:
        if mem is not None and hasattr(mem, "vector_store") and hasattr(mem.vector_store, "client"):
            mem.vector_store.client.close()
    except Exception:
        pass
    shutil.rmtree(state.get("work", ""), ignore_errors=True)


if __name__ == "__main__":
    serve(setup, search, close)
