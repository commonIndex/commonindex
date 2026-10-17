"""Index the page's repositories again on a schedule.

A repository indexed from Code query's page — by URL, or from a folder under
COMMONINDEX_CODE_ROOTS — was indexed once and then went stale: nothing ran it
again until an admin pressed the button, and a private repository needed its
token pasted every time. The scheduled pass (codequery.run_once) only knows
the repositories in CODEQUERY_REPOS.

Now each successful index records its source in `code_sources`, and the job
worker queues the same `code_index` job for every source that has not been
refreshed for COMMONINDEX_CODE_REFRESH_SECONDS (default hourly; 0 turns it
off). The job fetches the clone, re-indexes only what changed, and the shard
is rebuilt — exactly what pressing the button does.

A refresh runs as whoever indexed the repository and grants nothing: an admin
who revoked someone's read on a repository must not see it come back on the
hour.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

DEFAULT_EVERY_SECONDS = 3600


def every_seconds() -> int:
    raw = (os.environ.get("COMMONINDEX_CODE_REFRESH_SECONDS") or "").strip()
    try:
        return max(0, int(raw)) if raw else DEFAULT_EVERY_SECONDS
    except ValueError:
        return DEFAULT_EVERY_SECONDS


async def remember(pool, *, space: str, key: str, path: str, url: str | None,
                   branch: str | None, actor: str, token: str | None, keep_token: bool) -> None:
    """Record where a repository came from, after it indexed.

    A token is kept only encrypted. A re-index without one keeps the token
    already held — re-indexing a private repository should not quietly stop
    its refresh — unless `keep_token` is false, which forgets it.
    """
    from commonindex.workers.jobs import _seal

    sealed = _seal(token) if token and keep_token else None
    await pool.execute(
        "insert into code_sources (space_id, key, url, path, branch, actor_id, token)"
        " values ($1, $2, $3, $4, $5, $6, $7)"
        " on conflict (space_id, key) do update set url = excluded.url, path = excluded.path,"
        "   branch = excluded.branch, actor_id = excluded.actor_id, refreshed_at = now(),"
        "   token = case when $8 then coalesce(excluded.token, code_sources.token) end",
        space, key, url, path, branch, actor, sealed, keep_token)


async def queue_due(pool) -> int:
    """Queue a refresh for every source that is due and not already being
    indexed. Returns how many were queued."""
    every = every_seconds()
    if not every:
        return 0
    from commonindex.workers.jobs import _open, enqueue

    queued = 0
    async with pool.acquire() as conn, conn.transaction():
        due = await conn.fetch(
            "select space_id, key, url, path, branch, actor_id, token from code_sources"
            " where refreshed_at < now() - make_interval(secs => $1)"
            " order by refreshed_at limit 20 for update skip locked", every)
        for row in due:
            # The same lock and the same check as a manual index, so the two
            # never run over one clone at once.
            await conn.execute("select pg_advisory_xact_lock(hashtext($1))", "code_index:" + row["key"])
            # Marked first: a source that fails waits its interval before the
            # next try rather than being queued on every pass.
            await conn.execute("update code_sources set refreshed_at = now()"
                               " where space_id = $1 and key = $2", row["space_id"], row["key"])
            if await conn.fetchval("select 1 from jobs where kind = 'code_index' and key = $1"
                                   " and state in ('queued', 'running')", row["key"]):
                continue
            try:
                token = _open(row["token"])
            except Exception:  # noqa: BLE001 - a rotated key: refresh as public, and say so if it fails
                log.warning("code refresh: the kept token for %s cannot be decrypted", row["key"])
                token = None
            label = (row["url"] or "").removeprefix("https://").removesuffix(".git") \
                or os.path.basename(row["path"])
            await enqueue(conn, "code_index",
                          {"path": row["path"], "space": row["space_id"], "actor": row["actor_id"],
                           "url": row["url"], "branch": row["branch"], "refresh": True},
                          key=row["key"], space=row["space_id"], secret=token,
                          progress={"path": label, "repo": label, "source": "url" if row["url"] else "path",
                                    "step": "queued", "zoekt": None, "result": None, "refresh": True})
            queued += 1
    return queued
