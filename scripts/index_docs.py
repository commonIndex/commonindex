"""Fill doc vectors — the backfill for docs indexed before a model was set, and
the re-embed after changing the model.

    COMMONINDEX_DSN=... COMMONINDEX_EMBED_BASE_URL=... COMMONINDEX_EMBED_MODEL=... \
        uv run python scripts/index_docs.py [--reembed]

Chunks themselves are the indexer's (`make index-backfill`); this only gives
them vectors. Saves embed on their own and the gateway fills any gap in the
background, so this is for a deployment that has just turned a model on. With
`--reembed` existing vectors are dropped first, which a model change needs:
vectors from two models in one column are not comparable.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from commonindex.gateway.docindex import EMBEDDED_TYPES, embed_missing
from commonindex.gateway.llm import OpenAICompatibleEmbedder


async def main(reembed: bool) -> None:
    import asyncpg

    embedder = OpenAICompatibleEmbedder.from_env()
    if embedder is None:
        sys.exit("set COMMONINDEX_EMBED_BASE_URL and COMMONINDEX_EMBED_MODEL")
    pool = await asyncpg.create_pool(os.environ["COMMONINDEX_DSN"], min_size=1, max_size=2)
    try:
        if reembed:
            await pool.execute("update chunks set embedding = null"
                               " where object_type = any($1::text[])", list(EMBEDDED_TYPES))
        total = 0
        while n := await embed_missing(pool, embedder, batch=64):
            total += n
            print(f"embedded {total} chunks…", flush=True)
        print(f"done: {total} chunks embedded")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main("--reembed" in sys.argv))
