"""JSON line protocol shared by the framework adapters (see evals/bench-memory.mjs, frameworkRetriever).

stdin: one JSON object per line: {"op":"setup","lessons":[{"key","text"}],"config":{...}}, {"op":"search","query","k"},
{"op":"close"}. stdout: one JSON object per line. Frameworks print to stdout, so the real stdout is moved aside and
sys.stdout points at stderr, which the bench forwards to its own stderr (a progress log).
"""
import json
import os
import sys
import time

# An adapter is named after its framework (mem0.py, letta.py), so its own directory must not stay on sys.path or the
# script would shadow the package it imports.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]

_out = os.fdopen(os.dup(1), "w", buffering=1)
sys.stdout = sys.stderr


def send(obj):
    _out.write(json.dumps(obj) + "\n")
    _out.flush()


def dir_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def serve(setup, search, close=None):
    """setup(lessons, config) -> {"setupMs", "storageBytes", "llmCalls"}; search(query, k) -> list of lesson keys."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        op = msg.get("op")
        try:
            if op == "setup":
                reply = setup(msg["lessons"], msg.get("config") or {})
                send({"ok": True, **reply})
            elif op == "search":
                t0 = time.perf_counter()
                keys = search(msg["query"], int(msg["k"]))
                send({"keys": keys, "ms": round((time.perf_counter() - t0) * 1000, 3)})
            elif op == "close":
                if close:
                    close()
                send({"ok": True})
                return
        except ModuleNotFoundError as err:
            send({"ok": False, "notInstalled": True, "error": f"{type(err).__name__}: {err}"})
        except Exception as err:  # reported to the bench as the reason, never a crash
            import traceback

            traceback.print_exc()
            send({"ok": False, "error": f"{type(err).__name__}: {str(err)[:300]}"})


# The bench's per-model task prefixes (evals/bench-memory.mjs PREFIXES, same values), for adapters asked to prefix
# (`config.prefix: true`). Keyed by the bare model name.
PREFIXES = {
    "embeddinggemma": {"query": "task: search result | query: ", "doc": "title: none | text: "},
    "nomic-embed-text": {"query": "search_query: ", "doc": "search_document: "},
    "mxbai-embed-large": {"query": "Represent this sentence for searching relevant passages: ", "doc": ""},
    "bge-m3": {"query": "", "doc": ""},
    "qwen3-embedding": {"query": "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ", "doc": ""},
}


def prefixes(model, enabled):
    if not enabled:
        return {"query": "", "doc": ""}
    return PREFIXES.get(str(model).split(":")[0], {"query": "", "doc": ""})
