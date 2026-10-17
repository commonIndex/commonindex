"""An upgrade applies exactly the migrations that are new.

migrate.py skipped everything once the schema existed, so a deployment got its
first migrations and never another — each new file had to be applied by hand.
"""

from __future__ import annotations

import pytest
from db import DSN

from scripts.migrate import BASELINE, MIGRATIONS, pending

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


@pytest.fixture
async def conn():
    try:
        c = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    try:
        yield c
    finally:
        await c.close()


async def before_tracking(conn):
    """A database as every one was brought up before tracking: every migration
    of its day applied, nothing recorded."""
    await conn.execute("drop schema if exists public cascade; create schema public;")
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name <= BASELINE:
            await conn.execute(path.read_text())


async def test_a_database_from_before_tracking_gets_only_what_came_after(conn):
    await before_tracking(conn)
    todo = [p.name for p in await pending(conn)]
    later = sorted(p.name for p in MIGRATIONS.glob("*.sql") if p.name > BASELINE)
    assert todo == later and "0032_messages_by_parent.sql" in todo
    assert await conn.fetchval("select count(*) from schema_migrations") == \
        len([p for p in MIGRATIONS.glob("*.sql") if p.name <= BASELINE])


async def test_once_applied_nothing_is_pending(conn):
    await before_tracking(conn)
    for p in await pending(conn):
        async with conn.transaction():
            await conn.execute(p.read_text())
            await conn.execute("insert into schema_migrations (name) values ($1)", p.name)
    assert await pending(conn) == []
    assert await conn.fetchval("select to_regclass('messages_by_parent') is not null")
