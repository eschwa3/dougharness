"""Graphiti adapter (graphiti-core, the open-source engine behind Zep; Zep Community Edition itself is deprecated, see
the report). Backend: embedded FalkorDB (falkordblite: redislite.async_falkordb_client.AsyncFalkorDB, passed to
graphiti_core.driver.falkordb_driver.FalkorDriver(falkor_db=...), falkordb_driver.py:139). LLM: gemma4 through Ollama's
OpenAI-compatible endpoint (OpenAIGenericClient, llm_client/openai_generic_client.py:40). Embedder: OpenAIEmbedder with
base_url set to Ollama (embedder/openai.py:27-60). One episode per lesson (add_episode, graphiti.py:1043), named by our
key; graphiti.search() (graphiti.py:1586) is hybrid BM25 + cosine + RRF over entity edges (EDGE_HYBRID_SEARCH_RRF,
graphiti.py:1628), and each EntityEdge lists the episode uuids it came from (edges.py:267), mapped back to our key.
Ingest runs the LLM several times per episode, so it is by far the dominant cost: config "limit" / "every" sample it.
"""
import asyncio
import os
import shutil
import tempfile
import time
from datetime import datetime, timezone

os.environ.setdefault("GRAPHITI_TELEMETRY_ENABLED", "false")

from _proto import dir_bytes, serve  # noqa: E402

state = {}
loop = asyncio.new_event_loop()


async def asetup(lessons, config):
    from graphiti_core import Graphiti
    from graphiti_core.cross_encoder.client import CrossEncoderClient
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
    from graphiti_core.nodes import EpisodeType
    from ollama import Client
    from redislite.async_falkordb_client import AsyncFalkorDB

    url = config.get("ollamaUrl", "http://localhost:11434")
    embed_model = config.get("embedModel", "embeddinggemma")
    llm_model = config.get("llmModel", "gemma4:latest")
    if config.get("limit"):
        lessons = lessons[: int(config["limit"])]
    if config.get("every"):
        lessons = lessons[:: int(config["every"])]
    dims = len(Client(host=url).embed(model=embed_model, input="dimension probe")["embeddings"][0])

    class NoRerank(CrossEncoderClient):  # graphiti.search() never reranks; this keeps it from building an OpenAI client
        async def rank(self, query, passages):
            raise RuntimeError("cross encoder unexpectedly used")

    work = tempfile.mkdtemp(prefix="bench-graphiti-")
    state["work"] = work
    db = AsyncFalkorDB(os.path.join(work, "falkor.db"))
    llm = OpenAIGenericClient(config=LLMConfig(api_key="ollama", model=llm_model, small_model=llm_model, base_url=url + "/v1", temperature=0))
    calls = {"n": 0}
    original = llm.generate_response

    async def counted(*a, **kw):
        calls["n"] += 1
        return await original(*a, **kw)

    llm.generate_response = counted
    g = Graphiti(
        graph_driver=FalkorDriver(falkor_db=db),
        llm_client=llm,
        embedder=OpenAIEmbedder(config=OpenAIEmbedderConfig(api_key="ollama", embedding_model=embed_model, embedding_dim=dims, base_url=url + "/v1")),
        cross_encoder=NoRerank(),
    )
    await g.build_indices_and_constraints()
    state.update(g=g, db=db, key_of={})
    t0 = time.perf_counter()
    for i, lesson in enumerate(lessons):
        t1 = time.perf_counter()
        try:
            # `uuid` would name an existing episode to load (graphiti.py:1082), so it is not passed; the new episode's
            # uuid comes back in the result and is mapped to our key.
            res = await g.add_episode(name=lesson["key"], episode_body=lesson["text"], source_description="memory lesson", reference_time=datetime.now(timezone.utc), source=EpisodeType.text, group_id="bench")
            state["key_of"][res.episode.uuid] = lesson["key"]
            note = "ok"
        except Exception as err:  # one lesson the LLM could not extract must not sink the run: it is simply not retrievable
            note = f"FAILED {type(err).__name__}: {str(err)[:120]}"
        print(f"graphiti: lesson {i + 1}/{len(lessons)} {time.perf_counter() - t1:.1f}s {note}, llm calls so far {calls['n']}", flush=True)
    setup_ms = (time.perf_counter() - t0) * 1000
    return {"setupMs": round(setup_ms, 1), "storageBytes": dir_bytes(work), "llmCalls": calls["n"]}


def setup(lessons, config):
    return loop.run_until_complete(asetup(lessons, config))


def search(query, k):
    async def go():
        edges = await state["g"].search(query, group_ids=["bench"], num_results=max(k * 4, 20))
        keys = []
        for e in edges:
            for ep in e.episodes:
                key = state["key_of"].get(ep)
                if key and key not in keys:
                    keys.append(key)
        return keys[:k]

    return loop.run_until_complete(go())


def close():
    try:
        loop.run_until_complete(state["g"].close())
    except Exception:
        pass
    shutil.rmtree(state.get("work", ""), ignore_errors=True)


if __name__ == "__main__":
    serve(setup, search, close)
