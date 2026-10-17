"""Index one or more local clones into Code Query, and grant read on each.

The production-shaped path, not a fixture: this drives the same connector,
the same per-repo transaction and the same tombstone logic the cron does, so
what you search locally is what the hourly pass would have produced.

    export COMMONINDEX_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test
    uv run python scripts/index_repos.py ~/code/storefront ~/code/ledger

Re-running is cheap and safe: unchanged files are skipped by content hash, so
a second pass over an untouched clone indexes nothing and emits no events.

Pass several genuinely different repositories. Repo routing is the thing this
corpus exists to exercise, and a corpus where every repo says the same thing
cannot demonstrate that routing picked the right one.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from commonindex.workers.codequery import index_local


async def index_one(pool, path: Path, *, space_id: str, actor_id: str) -> dict:
    return await index_local(pool, path, space_id=space_id, actor_id=actor_id)


async def main_async(paths: list[Path], space_id: str, actor_id: str) -> None:
    import asyncpg

    pool = await asyncpg.create_pool(os.environ["COMMONINDEX_DSN"], min_size=1, max_size=4)
    try:
        for path in paths:
            # One repo's failure does not take the others down, same as the
            # cron's fan-out. A bad path is the common case here.
            try:
                result = await index_one(pool, path, space_id=space_id, actor_id=actor_id)
            except Exception as error:  # noqa: BLE001
                print(f"{path}: {type(error).__name__}: {error}", file=sys.stderr)
                continue
            print(f"{result['repo']} @ {result['branch']}: "
                  f"{result['indexed']} indexed, {result['deleted']} deleted, "
                  f"{result['pulled']} pulled  [{result['repo_id']}]")
    finally:
        await pool.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path, default=[ROOT],
                        help="clone directories; defaults to this repository")
    parser.add_argument("--space", default=os.environ.get("COMMONINDEX_SPACE") or "pay")
    parser.add_argument("--actor", default="maya")
    args = parser.parse_args()
    asyncio.run(main_async([p.expanduser().resolve() for p in args.paths or [ROOT]],
                           args.space, args.actor))


if __name__ == "__main__":
    main()
