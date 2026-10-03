"""Letta adapter: the retired Python Letta server with Postgres in Docker (see start_server), lessons inserted as archival
passages of an archive (letta_client resources/archives/passages.py:47 create) and searched directly through the
passages API (resources/passages.py:48 search, POST /v1/passages/search), not through an agent turn, so retrieval is
measured and not the LLM. The embedder is Ollama (embedding_config.embedding_endpoint_type "ollama",
letta_client/types/embedding_config_param.py). Our key travels in the passage metadata and in an id table made from the
create replies. No LLM call is made on this path, so llmCalls is 0. The Letta docs pages were not read (the research
budget hook blocked the fetch); every fact here is from the installed client's source and from the server's own replies.
"""
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request

from _proto import prefixes, serve

state = {}


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True)


PG = "doug-bench-pg"


def start_server(config, work):
    """Runs the retired Python Letta server (PyPI letta==0.16.8, `letta server`, its own venv .doug/.state/bench/py-letta)
    against a pgvector Postgres in Docker (container doug-bench-pg). The current letta/letta Docker image is Letta Code
    (its entrypoint says the Python server is end-of-life) and its App Server speaks WebSocket, with no archival-passages
    REST API; the retired server needs Postgres (it has no SQLite fallback) and an ORM-created schema (letta_initdb.py)."""
    here = os.path.dirname(os.path.abspath(__file__))
    venv = config.get("lettaVenv", os.path.join(here, "../../.doug/.state/bench/py-letta"))
    exe = os.path.join(venv, "bin/letta")
    if not os.path.exists(exe):
        raise ModuleNotFoundError(f"no Letta server at {exe}")
    port = int(config.get("lettaPort", 8283))
    pg_port = int(config.get("pgPort", 55432))
    sh("docker", "rm", "-f", PG)
    r = sh("docker", "run", "-d", "--name", PG, "-e", "POSTGRES_USER=letta", "-e", "POSTGRES_PASSWORD=letta", "-e", "POSTGRES_DB=letta", "-p", f"{pg_port}:5432", config.get("pgImage", "pgvector/pgvector:pg16"))
    if r.returncode != 0:
        raise RuntimeError(f"docker run failed: {r.stderr.strip()[:300]}")
    for _ in range(60):
        if sh("docker", "exec", PG, "pg_isready", "-U", "letta", "-d", "letta").returncode == 0:
            break
        time.sleep(1)
    time.sleep(2)
    env = {k: v for k, v in os.environ.items()}
    env.update(HOME=work, LETTA_PG_URI=f"postgresql+asyncpg://letta:letta@localhost:{pg_port}/letta")
    init = subprocess.run([os.path.join(venv, "bin/python"), os.path.join(here, "letta_initdb.py")], env=env, capture_output=True, text=True)
    if init.returncode != 0:
        raise RuntimeError("letta schema init failed: " + init.stderr[-300:])
    log = open(os.path.join(work, "server.log"), "w")
    proc = subprocess.Popen([exe, "server", "--port", str(port)], env=env, cwd=work, stdout=log, stderr=subprocess.STDOUT)  # cwd: the server writes openapi_letta.json there
    state["proc"] = proc
    base = f"http://localhost:{port}"
    deadline = time.time() + 300
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("letta server exited: " + open(os.path.join(work, "server.log")).read()[-400:])
        try:
            urllib.request.urlopen(base + "/v1/health/", timeout=3)
            return base
        except Exception:
            time.sleep(3)
    raise RuntimeError("letta server did not become healthy in 300s: " + open(os.path.join(work, "server.log")).read()[-400:])


def setup(lessons, config):
    from letta_client import Letta
    from ollama import Client

    embed_model = config.get("embedModel", "embeddinggemma")
    if config.get("limit"):
        lessons = lessons[: int(config["limit"])]
    if config.get("every"):
        lessons = lessons[:: int(config["every"])]
    dims = len(Client(host=config.get("ollamaUrl", "http://localhost:11434")).embed(model=embed_model, input="dimension probe")["embeddings"][0])
    work = tempfile.mkdtemp(prefix="bench-letta-")
    state["work"] = work
    try:
        base = start_server(config, work)
    except BaseException:
        close()  # a failed start must not leave the doug-bench-pg container or the server behind
        raise
    client = Letta(base_url=base)
    archive = client.archives.create(
        name="bench",
        embedding_config={"embedding_endpoint_type": "ollama", "embedding_endpoint": config.get("ollamaUrl", "http://localhost:11434") + "/v1", "embedding_model": embed_model, "embedding_dim": dims},
    )
    # `prefix: true`: the server embeds the passage text, so the model's document prefix is put in the stored text and
    # the query prefix in the query (the same strings reach the embedder as with a prefixing embedder).
    pre = prefixes(embed_model, config.get("prefix"))
    state.update(client=client, archive=archive.id, key_of={}, pre=pre)
    t0 = time.perf_counter()
    for i, lesson in enumerate(lessons):
        p = client.archives.passages.create(archive.id, text=pre["doc"] + lesson["text"], metadata={"key": lesson["key"]})
        state["key_of"][p.id] = lesson["key"]
        if (i + 1) % 10 == 0:
            print(f"letta: {i + 1}/{len(lessons)} passages in {time.perf_counter() - t0:.1f}s", flush=True)
    setup_ms = (time.perf_counter() - t0) * 1000
    size = sh("docker", "exec", PG, "du", "-sk", "/var/lib/postgresql/data")
    kb = int(size.stdout.split()[0]) if size.returncode == 0 and size.stdout.split() else 0
    return {"setupMs": round(setup_ms, 1), "storageBytes": kb * 1024, "llmCalls": 0}


def search(query, k):
    res = state["client"].passages.search(archive_id=state["archive"], query=state["pre"]["query"] + query, limit=k)
    keys = []
    for item in res:
        key = state["key_of"].get(item.passage.id)
        if key and key not in keys:
            keys.append(key)
    return keys


def close():
    proc = state.get("proc")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
    sh("docker", "rm", "-f", PG)
    shutil.rmtree(state.get("work", ""), ignore_errors=True)


if __name__ == "__main__":
    serve(setup, search, close)
