"""Alembic migration environment, trimmed to the fixture's needs."""

from alembic import context

config = context.config


def run_migrations_offline() -> None:
    context.configure(url="sqlite:///acme.db", literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    raise NotImplementedError("fixture only: never run against this file")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
