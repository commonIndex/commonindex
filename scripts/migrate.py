"""Apply every migration in migrations/*.sql that this database has not had.

Each applied file is recorded in `schema_migrations`, one row per file, and
applied in its own transaction with its row — so a migration that fails
leaves nothing half-done and is tried again on the next start, and an upgrade
applies exactly the files that are new.

It used to skip everything once the schema existed: the first deployment got
every migration and no later one got any, so each new file had to be applied
by hand.

**A database from before this tracking** has a schema and no rows. Every such
database was brought up by applying every migration of its day — all at once,
or by hand since — so it is recorded as having everything through BASELINE,
the last migration that existed before tracking did, and only later files are
applied to it.

    COMMONINDEX_DSN=postgresql://… python scripts/migrate.py
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"

#: The newest migration from before migrations were tracked.
BASELINE = "0031_panel_col.sql"


async def pending(conn) -> list[Path]:
    """The migration files this database has not had, in order — recording a
    pre-tracking database's baseline first."""
    await conn.execute(
        "create table if not exists schema_migrations ("
        " name text primary key, applied_at timestamptz not null default now())")
    done = {r["name"] for r in await conn.fetch("select name from schema_migrations")}
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not done and await conn.fetchval(
            "select exists (select 1 from information_schema.tables where table_name = 'spaces')"):
        old = [p.name for p in files if p.name <= BASELINE]
        await conn.executemany("insert into schema_migrations (name) values ($1) on conflict do nothing",
                               [(n,) for n in old])
        print(f"schema from before tracking: recorded {len(old)} migrations through {BASELINE}")
        done = set(old)
    return [p for p in files if p.name not in done]


async def main() -> None:
    import asyncpg

    conn = await asyncpg.connect(os.environ["COMMONINDEX_DSN"])
    try:
        todo = await pending(conn)
        if not todo:
            print("schema up to date")
        for path in todo:
            print(f"applying {path.name}")
            async with conn.transaction():
                await conn.execute(path.read_text())
                await conn.execute("insert into schema_migrations (name) values ($1)", path.name)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
