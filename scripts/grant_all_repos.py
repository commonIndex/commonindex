"""Grant every actor read on every indexed repository.

A development convenience, and deliberately a separate script rather than a flag
on the indexer: "everyone can read everything" is the exact posture the ACL
design exists to make impossible by accident, so it should be something someone
ran on purpose and can find again in shell history.

Not for production. Real access is administered per repository with
`access.grant` (resource `object:<repo_id>`, relation `read`), which is what
this writes in bulk.

    COMMONINDEX_DSN=... uv run python scripts/grant_all_repos.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


async def main() -> None:
    import asyncpg

    dsn = os.environ.get("COMMONINDEX_DEV_DSN") or os.environ["COMMONINDEX_DSN"]
    conn = await asyncpg.connect(dsn.replace("postgresql+asyncpg://", "postgresql://"))
    try:
        repos = await conn.fetch(
            "select id from objects where type = 'code_repo' and deleted_at is null")
        spaces = await conn.fetch("select id from spaces")
        actors = await conn.fetch("select id from actors")

        # Two different checks, and granting only one leaves every request
        # denied in a way that looks like a broken token. The gateway's
        # middleware checks the operation's declared relation against the SPACE
        # before a handler runs; the search itself then overlaps the caller's
        # acl_keys against each REPO. Repo grants alone get you a 403 before any
        # code is searched, which is exactly what happened the first time.
        pairs = [(f"space:{s['id']}", "admin") for s in spaces]
        pairs += [(f"object:{r['id']}", "read") for r in repos]

        for resource, relation in pairs:
            for actor in actors:
                await conn.execute(
                    "insert into grants (id, subject, relation, resource, granted_by)"
                    " values ($1,$2,$3,$4,$2) on conflict (id) do nothing",
                    f"g-{actor['id']}-{relation}-{resource.replace(':', '-')}",
                    actor["id"], relation, resource)
        print(f"granted {len(actors)} actors: admin on {len(spaces)} space(s), "
              f"read on {len(repos)} repo(s) — {len(pairs) * len(actors)} grants")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
