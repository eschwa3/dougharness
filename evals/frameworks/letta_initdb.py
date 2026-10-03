"""Creates the Letta server's schema in an empty Postgres (LETTA_PG_URI) from the ORM models: the PyPI wheel ships no
alembic migrations, so `letta server` alone fails with `relation "organizations" does not exist`. Run with the Letta
server venv's Python by letta.py."""
import asyncio, os, sys

# this directory holds letta.py, which would shadow the `letta` package
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [p for p in sys.path if os.path.abspath(p or '.') != _here]
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from letta.orm.base import Base
import letta.orm  # registers every model
async def main():
    eng = create_async_engine(os.environ["LETTA_PG_URI"])
    async with eng.begin() as c:
        await c.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await c.run_sync(Base.metadata.create_all)
    print("tables:", len(Base.metadata.tables))
asyncio.run(main())
