"""Stand up a development database with enough history to draw a chart.

Deliberately NOT the database the tests use. ``tests/db.py`` opens every
integration run with ``drop schema public cascade`` — which is correct, because
a migration that only works on top of yesterday's database will fail in
production and applying from zero is the only way to find out. It also means a
test run silently destroys whatever a running gateway was serving. Found the
hard way: ``pytest -q`` emptied the dashboards the UI had open.

So the dev database is a different database, and this script rebuilds it:

    make dev-db      # create commonindex_dev, migrate, seed
    make dev-gateway # serve it on :8000

Idempotent — running it twice leaves the same rows, so it is safe to re-run
against a database you have been clicking around in.
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

DSN = os.environ.get("COMMONINDEX_DEV_DSN", "postgresql://localhost/commonindex_dev")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # run as a file: `scripts.migrate` is under the root
DAYS = 45
NOW = datetime.now(tz=UTC)

AGENTS = ["scribe", "triage", "analyst"]
KINDS = ["props", "crdt", "gitref"]   # the delta encodings the schema allows


async def main() -> None:
    import asyncpg

    conn = await asyncpg.connect(DSN)
    try:
        # Every migration this database has not had — the same tracking the
        # deployment's migrate step uses, so a dev database gets new ones too.
        from scripts.migrate import pending

        for f in await pending(conn):
            print(f"  applying {f.name}")
            async with conn.transaction():
                await conn.execute(f.read_text())
                await conn.execute("insert into schema_migrations (name) values ($1)", f.name)

        await seed(conn)
        counts = await conn.fetch(
            "select 'proposals' t, count(*) c from proposals"
            " union all select 'runs', count(*) from runs"
            " union all select 'connections', count(*) from connections")
        for r in counts:
            print(f"  {r['t']:<12} {r['c']}")
    finally:
        await conn.close()


async def seed(conn) -> None:
    rng = random.Random(7)  # a fixed seed, so screenshots and numbers reproduce

    await conn.execute(
        "insert into spaces (id, org_id, name) values"
        " ('pay','example','Payments'),('growth','example','Growth')"
        " on conflict (id) do nothing")
    # A space without its sequence row is a space nothing can write an event
    # into: `_emit` does `update space_seq ... returning next_seq - 1`, which
    # matches nothing and yields a null seq against a not-null column. The test
    # fixture has always seeded this and the dev seeder did not, so indexing
    # code worked under pytest and failed on a developer's own database.
    await conn.execute(
        "insert into space_seq (space_id) values ('pay'),('growth')"
        " on conflict (space_id) do nothing")
    # The signed-in person, FIRST — an agent needs an owner to exist now, and
    # the owner has to be there before it. The UI used to author as "analyst",
    # which is seeded as a propose-only AGENT, so every dashboard a human built
    # came back unratified because the platform thought a bot had made it.
    for pid, name in [("maya", "Maya"), ("alex", "Alex")]:
        await conn.execute(
            "insert into actors (id, kind, display) values ($1,'human',$2)"
            " on conflict (id) do nothing", pid, name)
    # Humans and agents in one table — the product tenet as a DDL constraint.
    # And every agent names the person who answers for it, which 0017 made a
    # constraint rather than a sentence in a type definition.
    for a in AGENTS:
        await conn.execute(
            "insert into actors (id, kind, display, owner_id) values ($1,'agent',$1,'maya')"
            " on conflict (id) do update set owner_id = coalesce(actors.owner_id, 'maya')", a)
    # The Code Query indexer writes objects, revisions and events, all of which
    # are foreign keys to `actors` — so the cron cannot run until it exists.
    #
    # Seeded here rather than in a migration, and kept out of AGENTS on purpose.
    # A migration cannot create it: 0017 requires every agent to name an owner,
    # and a fresh production database has no humans to name — inventing one is
    # exactly what 0017's own comment refuses to do. And AGENTS drives the
    # seeded proposal and run history, so adding it there would shift every
    # number the fixed rng seed exists to keep reproducible.
    await conn.execute(
        "insert into actors (id, kind, display, owner_id)"
        " values ('codequery','agent','Code Query indexer','maya')"
        " on conflict (id) do update set owner_id = coalesce(actors.owner_id, 'maya')")

    # The platform's own Postgres, registered as a warehouse. Self-referential
    # on purpose: it means the create-a-dashboard flow has real tables with real
    # rows to build on, without asking anyone to bring a warehouse first.
    await conn.execute(
        "insert into connections (id, space_id, name, kind, dsn, impersonation,"
        " read_only, created_by, checked_at) values"
        " ('conn-platform','pay','Platform Postgres','postgres',$1,false,true,'maya',now())"
        " on conflict (id) do update set dsn = excluded.dsn, checked_at = now()",
        DSN.replace("postgresql://", "postgresql+asyncpg://"))

    # Before the 'already seeded' return, not after it: a database seeded before
    # templates existed returned early on every later run and never got them, so
    # its Designs tab said 'No starter layouts are available yet'. Each insert is
    # `on conflict do nothing`, so running this again changes nothing.
    # The starter templates ship with the repo rather than living in whoever's
    # dev database happened to create them. A Designs tab with nothing to start
    # from is the same empty tab it was before templates existed.
    import json as _json

    for i, f in enumerate(sorted((ROOT / "designs").glob("*.json")), start=1):
        props = _json.loads(f.read_text())
        await conn.execute(
            "insert into objects (id, space_id, type, key, title, props, created_by)"
            " values ($1,'pay','design',$2,$3,$4::jsonb,'maya')"
            " on conflict (id) do nothing",
            f"design-{f.stem}", f"DES-{i}", props["title"], _json.dumps(props))

    # `_next_key` draws DES-n from space_seq, which still says 1 — so the first
    # real `designs.propose` would pick a key one of these already holds and die
    # on the unique index on (space_id, key). Reserve what was just written.
    # An UPDATE matches nothing here: `space_seq` has no row for the space until
    # `_next_key` lazily inserts one, so the first version of this silently did
    # nothing and the collision survived it.
    await conn.execute(
        "insert into space_seq (space_id, next_seq) values ('pay', $1)"
        " on conflict (space_id) do update"
        "   set next_seq = greatest(space_seq.next_seq, excluded.next_seq)",
        len(sorted((ROOT / "designs").glob("*.json"))) + 1)

    if await conn.fetchval("select count(*) from proposals") >= 400:
        return  # already seeded; leave the history alone

    await conn.execute(
        "insert into objects (id, space_id, type, key, title, created_by)"
        " values ('doc-1','pay','doc','DOC-1','Refund spec','maya')"
        " on conflict (id) do nothing")


    for i in range(400):
        author = rng.choice(AGENTS)
        created = NOW - timedelta(days=rng.uniform(0, DAYS))
        # Review wait is the gap between filing and a decision — the thing the
        # latency metric measures, so it has to be a real interval rather than a
        # column of noise.
        decided = created + timedelta(seconds=rng.lognormvariate(9.0, 0.9))
        status = "merged" if rng.random() < 0.78 else "rejected"
        # An unexplained rejection teaches the agent nothing, so every one
        # carries a reason — that column is the learning signal, not metadata.
        reason = rng.choice(["merits", "scope", "needs-decision"]) if status == "rejected" else None
        undone = decided + timedelta(hours=rng.uniform(1, 60)) if (
            status == "merged" and rng.random() < 0.10) else None
        await conn.execute(
            "insert into proposals (id, space_id, target_id, base_rev, delta_kind, delta,"
            " author_id, status, reject_reason, created_at, decided_at, decided_by,"
            " undone_at, undone_by)"
            " values ($1,'pay','doc-1',1,$2,'{}'::jsonb,$3,$4,$5,$6,$7,'maya',$8,$9)"
            " on conflict (id) do nothing",
            f"prop-{i}", rng.choice(KINDS), author, status, reason, created, decided,
            undone, "maya" if undone else None)

    for i in range(300):
        started = NOW - timedelta(days=rng.uniform(0, DAYS))
        await conn.execute(
            "insert into runs (id, space_id, agent_id, status, started_at, ended_at,"
            " cost_tokens, cost_usd) values ($1,'pay',$2,'done',$3,$4,$5,$6)"
            " on conflict (id) do nothing",
            f"run-{i}", rng.choice(AGENTS), started,
            started + timedelta(seconds=rng.uniform(20, 900)),
            rng.randint(2000, 90000), round(rng.uniform(0.02, 1.40), 2))


if __name__ == "__main__":
    asyncio.run(main())
