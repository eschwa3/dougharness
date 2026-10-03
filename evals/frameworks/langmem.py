"""LangMem adapter. LangMem stores memories in a LangGraph BaseStore; its manage-memory tool writes
store.put(namespace, key=<id>, value={"content": ...}) (langmem/knowledge/tools.py:332) and its search tool calls
store.search(namespace, query=..., limit=...) (langmem/knowledge/tools.py:465). This adapter makes those two calls on
langgraph's InMemoryStore with an Ollama embed function (IndexConfig.embed accepts a callable:
langgraph/store/base/__init__.py:598). No LLM is involved on this path, so llmCalls is 0.
Config: `field: "content"` embeds only the content field instead of the whole value as LangMem writes it (default index
fields ["$"] = the JSON of {"content": text}, langgraph/store/base/embed.py:247; variant "content" is the same switch);
`prefix: true` embeds through a LangChain `Embeddings` object (embed_documents / embed_query,
langchain_core.embeddings.Embeddings, accepted by IndexConfig.embed: langgraph/store/base/__init__.py:598) that adds the
embedding model's document and query prefixes, which a plain embed function cannot tell apart.
"""
import time

from _proto import prefixes, serve

state = {}


def setup(lessons, config):
    from langgraph.store.memory import InMemoryStore
    from ollama import Client

    url = config.get("ollamaUrl", "http://localhost:11434")
    embed_model = config.get("embedModel", "embeddinggemma")
    client = Client(host=url)
    dims = len(client.embed(model=embed_model, input="dimension probe")["embeddings"][0])

    def embed(texts):
        out = []
        for i in range(0, len(texts), 32):
            out.extend(client.embed(model=embed_model, input=texts[i : i + 32])["embeddings"])
        return out

    pre = prefixes(embed_model, config.get("prefix"))
    if config.get("prefix"):
        from langchain_core.embeddings import Embeddings

        class Prefixed(Embeddings):
            def embed_documents(self, texts):
                return embed([pre["doc"] + t for t in texts])

            def embed_query(self, text):
                return embed([pre["query"] + text])[0]

        embedder = Prefixed()
    else:
        embedder = embed
    store = InMemoryStore(index={"dims": dims, "embed": embedder})
    ns = ("bench", "memories")
    index = ["content"] if config.get("variant") == "content" or config.get("field") == "content" else None
    t0 = time.perf_counter()
    for lesson in lessons:
        if index:
            store.put(ns, lesson["key"], {"content": lesson["text"]}, index=index)
        else:
            store.put(ns, lesson["key"], {"content": lesson["text"]})
    setup_ms = (time.perf_counter() - t0) * 1000
    state.update(store=store, ns=ns)
    # in-process store: the footprint is the vectors plus the texts held in memory
    storage = len(lessons) * dims * 4 + sum(len(lesson["text"].encode()) for lesson in lessons)
    return {"setupMs": round(setup_ms, 1), "storageBytes": storage, "llmCalls": 0}


def search(query, k):
    return [item.key for item in state["store"].search(state["ns"], query=query, limit=k)]


if __name__ == "__main__":
    serve(setup, search)
