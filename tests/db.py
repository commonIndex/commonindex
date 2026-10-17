"""Integration-test plumbing.

Every run applies the migrations from scratch against an empty schema. That is
slower than reusing state and it is the point: a migration that only works when
applied on top of yesterday's database is a migration that will fail in
production, and the only way to find out is to keep proving it from zero.
"""

from __future__ import annotations

import os
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"

#: Overridable so CI can point at the compose service. Defaults to a local
#: install, because requiring Docker to run one test suite is friction that gets
#: the suite skipped.
DSN = os.environ.get("COMMONINDEX_TEST_DSN", "postgresql://localhost/commonindex_test")


async def reset(conn) -> None:
    """Drop everything and re-apply every migration in filename order."""
    await conn.execute("drop schema if exists public cascade; create schema public;")
    for path in sorted(MIGRATIONS.glob("*.sql")):
        await conn.execute(path.read_text())


async def seed(conn) -> None:
    """A small, deliberately lopsided fixture.

    The numbers are chosen so a wrong aggregate is visible rather than plausible:
    six proposals, four merged, one of those undone. Acceptance is exactly 4/6
    and undo-after-merge exactly 1/4 — both fractions no off-by-one produces by
    accident.
    """
    await conn.execute("""
        insert into spaces (id, org_id, name) values ('pay', 'example', 'Payments'),
                                                     ('growth', 'example', 'Growth');
        insert into space_seq (space_id) values ('pay'), ('growth');
        insert into actors (id, kind, display, owner_id) values
            ('maya', 'human', 'Maya', null),
            -- Every agent has a human who answers for it, which 0017 made a
            -- constraint rather than a sentence in a type definition. A fixture
            -- that creates an unowned agent is a fixture creating a row the
            -- product will not.
            ('scribe', 'agent', 'Scribe', 'maya'),
            ('triage', 'agent', 'Triage', 'maya');
        insert into objects (id, space_id, type, key, title, created_by, acl_keys) values
            ('doc-1', 'pay', 'doc', 'D-1', 'Refund spec', 'maya', '{space:pay}');
    """)

    # created_at is set explicitly so the window predicate is exercised rather
    # than every row landing inside any plausible range.
    rows = [
        # id,     author,   status,     undone, days_ago, decided_after_s
        ("p1", "scribe", "merged", True, 3, 3600),
        ("p2", "scribe", "merged", False, 3, 1800),
        ("p3", "scribe", "merged", False, 2, 7200),
        ("p4", "triage", "merged", False, 2, 900),
        ("p5", "scribe", "rejected", False, 1, 600),
        ("p6", "triage", "pending", False, 1, None),
        # outside a 30-day window, so a missing bound shows up as a wrong total
        ("p7", "scribe", "merged", False, 400, 300),
    ]
    for pid, author, status, undone, days, decided in rows:
        await conn.execute(
            """
            insert into proposals
                (id, space_id, target_id, base_rev, delta_kind, delta, author_id,
                 status, created_at, decided_at, undone_at)
            values ($1, 'pay', 'doc-1', 1, 'props', '{}', $2, $3,
                    now() - ($4 || ' days')::interval,
                    case when $5::int is null then null
                         else now() - ($4 || ' days')::interval + ($5 || ' seconds')::interval end,
                    case when $6 then now() - ($4 || ' days')::interval + interval '2 hours'
                         else null end)
            """,
            pid, author, status, str(days), decided, undone,
        )

    await conn.execute("""
        insert into runs (id, space_id, agent_id, status, cost_usd, started_at) values
            ('r1', 'pay', 'scribe', 'done', 0.38, now() - interval '3 days'),
            ('r2', 'pay', 'scribe', 'done', 0.21, now() - interval '2 days'),
            ('r3', 'pay', 'triage', 'done', 0.64, now() - interval '1 day'),
            ('r4', 'growth', 'scribe', 'done', 9.99, now() - interval '1 day');
    """)
