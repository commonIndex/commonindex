"""Give every doc without an excerpt the one its body implies.

`docs.propose` did not derive the excerpt (only `docs.revise` did), so docs an
agent, an import or MCP created read "Empty — open it to start writing." in
the list. New docs get one when they are made; this fixes the ones made
before. Safe to run again: it touches only docs with no excerpt.

    COMMONINDEX_DSN=postgresql://... uv run python scripts/backfill_doc_excerpts.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


async def main() -> None:
    import asyncpg

    from commonindex.gateway.docs import excerpt

    conn = await asyncpg.connect(os.environ["COMMONINDEX_DSN"])
    try:
        rows = await conn.fetch(
            "select id, props->'body' as body from objects where type = 'doc'"
            "   and deleted_at is null and coalesce(props->>'excerpt', '') = ''")
        fixed = 0
        for r in rows:
            body = json.loads(r["body"]) if isinstance(r["body"], str) else r["body"]
            text = excerpt(body)
            if text:
                await conn.execute("update objects set props = props || jsonb_build_object('excerpt', $2::text)"
                                   " where id = $1", r["id"], text)
                fixed += 1
        print(f"{fixed} of {len(rows)} docs without an excerpt now have one")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
