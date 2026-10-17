"""The Code Query cron entrypoint — one pull-and-index pass, then exit.

Invoked hourly by a k8s CronJob, not a long-running
process: `python -m commonindex.workers.codequery`. The loop below is real —
fan out across configured repos, one transaction per repo covering the
object/revision/event triple mvp-schema.md requires land together, no repo's
failure blocking another's. What it calls into (`Connector.pull`, the ACL
crawl) is real business logic owned elsewhere, unimplemented until that module
is — same maturity as every other worker in this package today.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os

from commonindex.workers.aclcrawl import Crawler
from commonindex.workers.codecontext import replace_code_chunks
from commonindex.workers.connectors import Record
from commonindex.workers.connectors.git import Connector, RepoRef


def _repos_from_env() -> list[RepoRef]:
    """CODEQUERY_REPOS is a JSON array of {"org","repo","branch"[,"space_id"]}
    — set by deploy/k8s/local/configmap.yaml. A repo list living in an object
    of its own (mirroring `connections` for warehouses) is the natural next
    step once more than one source needs the same config shape; an env var is
    enough for the one connector v1 ships."""
    raw = os.environ.get("CODEQUERY_REPOS", "[]")
    return [RepoRef(**r) for r in json.loads(raw)]


def _acl_keys(ref: RepoRef, record: Record) -> list[str]:
    """What a file from this repo is readable by.

    `record.acl_keys` is the imported source ACL — the crawl that fills it is
    still unimplemented, so today it is empty for every real pull. The repo key
    is the floor beneath it: without one, a pulled file carries `{}`, overlaps
    with nothing, and is invisible to its own indexer. Union rather than
    replacement, so the crawl landing later only adds keys.
    """
    return sorted({*record.acl_keys, ref.acl_key})


async def run_once(pool, repos: list[RepoRef] | None = None, actor_id: str = "codequery") -> dict:
    """One pass over every configured repo. Returns a per-stream summary
    rather than raising past the first failure, so one stalled repo does not
    take the rest of the hour's pull down with it."""
    repos = repos if repos is not None else _repos_from_env()
    connector = Connector(repos=repos)
    crawler = Crawler()
    results: dict[str, dict] = {}

    # Checked once, before any repo is pulled. objects.created_by,
    # revisions.author_id and events.actor_id are all foreign keys to `actors`,
    # so an indexer with no actor row fails on its first write with a constraint
    # violation naming a column, several layers below the actual problem. It is
    # not created here: 0017 requires every agent to name a human who answers
    # for it, and a process that inserts its own actor is a process that grants
    # itself an identity and picks its own owner.
    if not await pool.fetchval("select 1 from actors where id = $1", actor_id):
        raise SystemExit(
            f"no actor {actor_id!r} to index as. Create one and name the person "
            f"answerable for it:\n"
            f"  insert into actors (id, kind, display, owner_id)\n"
            f"  values ('{actor_id}', 'agent', 'Code Query indexer', '<a human actor id>');\n"
            f"Development databases get this from scripts/seed_dev.py.")

    for ref in repos:
        try:
            cursor = await _cursor_for(pool, ref)
            records, next_cursor = await connector.pull(ref.stream_name, cursor)
            written = removed = 0
            async with pool.acquire() as conn, conn.transaction():
                for record in records:
                    path = record.props.get("path") or record.id
                    if record.deleted:
                        removed += await _tombstone_code_file(conn, ref, path, actor_id)
                    else:
                        written += await _upsert_code_file(conn, ref, record, actor_id)
                if ref.stream_name in connector.full_reads:
                    removed += await _retire_absent(conn, ref, records, actor_id)
                await _upsert_repo(conn, ref, next_cursor, actor_id)
            # The ACL crawl is a SEPARATE cadence (N1 rule 2) and is still
            # unimplemented. It used to raise straight past the summary, so a
            # fully successful pull — already committed one line above —
            # reported itself as "not_implemented". A missing crawl is a note
            # about permission freshness, not a failed index.
            acls = "ok"
            try:
                await crawler.crawl(ref.stream_name)
            except NotImplementedError:
                acls = "not_implemented"
            # `pulled` is what the source offered; `indexed` is what actually
            # changed. They differ on every re-read, and a pass that pulls 900
            # files and indexes 3 is the healthy case, not a stalled one.
            results[ref.stream_name] = {"pulled": len(records), "indexed": written,
                                        "deleted": removed, "cursor": next_cursor,
                                        "acls": acls}
        except NotImplementedError:
            results[ref.stream_name] = {"error": "not_implemented"}
        except Exception as error:  # noqa: BLE001
            # One repo's failure must not take the hour's pass down with it, and
            # the reason belongs in the summary rather than only in a traceback
            # nobody reads — a throttled repo and a misnamed one look identical
            # otherwise, and have different fixes.
            results[ref.stream_name] = {"error": type(error).__name__,
                                        "detail": str(error)[:200]}
    return results


async def _cursor_for(pool, ref: RepoRef) -> str | None:
    """The commit to read changes since — none, so the whole tree, when the
    repository was last indexed under other rules for which files count."""
    from commonindex.workers.connectors.localgit import RULES

    row = await pool.fetchrow(
        "select props->>'last_indexed_sha' as sha, props->>'index_rules' as rules from objects"
        " where id = $1 and deleted_at is null", ref.repo_id)
    if row is None or row["rules"] != RULES:
        return None
    return row["sha"]


def _file_id(repo_id: str, path: str) -> str:
    """Keyed by (repo, path) so a re-pull updates one row rather than
    accumulating one per historical version."""
    return f"code_file-{hashlib.sha256(f'{repo_id}:{path}'.encode()).hexdigest()[:16]}"


async def _tombstone_code_file(conn, ref: RepoRef, path: str, actor_id: str) -> bool:
    """A file deleted at the source stops being searchable.

    `_upsert_code_file` only ever upserted, so a deleted file stayed in the
    index and kept answering queries — a wrong answer, and a leak once the
    deletion was the point (a key checked in and removed). Returns whether
    anything was actually tombstoned, so a delete for a path that was never
    indexed is not reported as work.

    The chunks go rather than being left to the object's cascade: the object
    row survives as a tombstone, so nothing cascades, and a chunk whose only
    protection is a caller remembering to join `deleted_at is null` is one
    forgotten join away from being served.
    """
    file_id = _file_id(ref.repo_id, path)
    row = await conn.fetchrow(
        "update objects set deleted_at = now(), updated_at = now()"
        " where id = $1 and deleted_at is null returning id", file_id)
    if row is None:
        return False
    await conn.execute("delete from chunks where object_id = $1", file_id)
    await _emit(conn, ref.space_id, actor_id, "object.delete", file_id, {"path": path})
    return True


async def _retire_absent(conn, ref: RepoRef, records: list[Record], actor_id: str) -> int:
    """After a whole-tree read, tombstone every file of the repository that the
    read did not return.

    A diff names its deletions; a whole-tree read cannot. It is what a pass
    falls back to when the cursor is gone (a force-push, a rewritten history)
    or the index rules changed, so a file the rewrite removed — a key purged
    from history is the case that matters — or one the rules now exclude was
    simply absent from what was read, and stayed searchable for good.
    """
    seen = {r.props.get("path") or r.id for r in records if not r.deleted}
    gone = [row["props_path"] for row in await conn.fetch(
        "select props->>'path' as props_path from objects where type = 'code_file'"
        " and props->>'repo_id' = $1 and deleted_at is null", ref.repo_id)
        if row["props_path"] not in seen]
    removed = 0
    for path in gone:
        removed += await _tombstone_code_file(conn, ref, path, actor_id)
    return removed


async def _upsert_code_file(conn, ref: RepoRef, record: Record, actor_id: str) -> bool:
    """One code_file per Record — a pointer to current state, per
    types/code_file.json's doc; the repo's own history is the history.

    Returns whether it wrote. Unchanged content is skipped whole: no revision,
    no re-chunk, no event. The comparison is a hash of the body rather than the
    commit sha, because a full re-read (an unknown cursor, a first pull after a
    force-push) stamps every file with the new HEAD and would otherwise look
    like every file in the repo had changed at once — reindexing the corpus and
    emitting an event per file.
    """
    path = record.props.get("path") or record.id
    repo_id = ref.repo_id
    acl_keys = _acl_keys(ref, record)
    file_id = _file_id(repo_id, path)
    body = record.props.get("body", "")
    content_hash = hashlib.sha256(body.encode()).hexdigest()
    props = {
        "repo_id": repo_id, "path": path,
        "language": record.props.get("language"),
        "sha": record.props.get("sha"), "size": record.props.get("size"),
        "content_hash": content_hash, "body": body,
    }
    existing = await conn.fetchrow(
        "select current_rev, deleted_at, props->>'content_hash' as content_hash"
        "  from objects where id = $1", file_id)
    if (existing is not None and existing["deleted_at"] is None
            and existing["content_hash"] == content_hash):
        # `sha` therefore names the commit at which this content was last
        # observed to change, not merely the last commit we looked at — which
        # is the more useful thing for a citation to point a reader at.
        return False
    rev = (existing["current_rev"] + 1) if existing else 1
    if existing is None:
        await conn.execute(
            "insert into objects (id, space_id, type, title, props, acl_keys, created_by)"
            " values ($1,$2,'code_file',$3,$4::jsonb,$5,$6)",
            file_id, ref.space_id, path, json.dumps(props), acl_keys, actor_id)
    else:
        # deleted_at back to null: a path re-added after a delete is the same
        # object returning, not a second one, and it keeps its id and grants.
        await conn.execute(
            "update objects set props = $2::jsonb, acl_keys = $3, current_rev = $4,"
            " deleted_at = null, updated_at = now() where id = $1",
            file_id, json.dumps(props), acl_keys, rev)
    await conn.execute(
        "insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
        file_id, rev, actor_id, json.dumps(props))
    await replace_code_chunks(
        conn, object_id=file_id, space_id=ref.space_id, rev=rev,
        body=props["body"], acl_keys=acl_keys,
    )
    await _emit(conn, ref.space_id, actor_id, "object.upsert", file_id, {"path": path})
    return True


async def _upsert_repo(conn, ref: RepoRef, sha: str | None, actor_id: str) -> None:
    """The connector-health row (types/code_repo.json) — created on first
    pull, its cursor and health advanced on every one after."""
    from datetime import UTC, datetime

    from commonindex.workers.connectors.localgit import RULES

    repo_id = ref.repo_id
    now = datetime.now(tz=UTC).isoformat()
    props = {
        "provider": ref.provider, "org": ref.org, "repo": ref.repo,
        "default_branch": ref.branch, "health": "ok",
        "last_indexed_sha": sha, "last_indexed_at": now, "index_rules": RULES,
    }
    existing = await conn.fetchrow("select id from objects where id = $1", repo_id)
    if existing is None:
        # acl_keys on the repo row too, not only on its files: the repo object
        # is what "which repositories may I search?" reads, and objects.acl_keys
        # defaults to '{}' — which overlaps with nothing, so a repo left at the
        # default is invisible to the routing step that is supposed to find it.
        await conn.execute(
            "insert into objects (id, space_id, type, title, props, acl_keys, created_by)"
            " values ($1,$2,'code_repo',$3,$4::jsonb,$5,$6)",
            repo_id, ref.space_id, f"{ref.org}/{ref.repo}", json.dumps(props),
            [ref.acl_key], actor_id)
    else:
        await conn.execute(
            "update objects set props = props || $2::jsonb, acl_keys = $3,"
            " updated_at = now() where id = $1", repo_id, json.dumps(props), [ref.acl_key])
    await _emit(conn, ref.space_id, actor_id, "object.upsert", repo_id, {"sha": sha})
    await _retire_copies(conn, ref, actor_id)


async def _retire_copies(conn, ref: RepoRef, actor_id: str) -> int:
    """Retire any other row for this same org/repo/branch in the space.

    The id is derived from them, so there is one — unless an older build named
    repositories differently. Then the old copy kept every file it had, every
    search answered twice, and "not indexed" was reported beside the results.
    The newest index is the repository; the rest go, files and chunks with it.
    """
    stale = [r["id"] for r in await conn.fetch(
        "select id from objects where type = 'code_repo' and space_id = $1 and id <> $2"
        "   and deleted_at is null and lower(props->>'org') = lower($3)"
        "   and lower(props->>'repo') = lower($4) and props->>'default_branch' = $5",
        ref.space_id, ref.repo_id, ref.org, ref.repo, ref.branch)]
    for old in stale:
        files = [r["id"] for r in await conn.fetch(
            "update objects set deleted_at = now(), updated_at = now()"
            " where type = 'code_file' and props->>'repo_id' = $1 and deleted_at is null"
            " returning id", old)]
        await conn.execute("delete from chunks where object_id = any($1::text[])", files)
        await conn.execute("update objects set deleted_at = now(), updated_at = now() where id = $1", old)
        await _emit(conn, ref.space_id, actor_id, "object.delete", old, {"superseded_by": ref.repo_id})
    return len(stale)


async def _emit(conn, space_id: str, actor_id: str, verb: str, object_id: str, payload: dict) -> None:
    seq = await conn.fetchval(
        "update space_seq set next_seq = next_seq + 1 where space_id = $1"
        " returning next_seq - 1", space_id)
    await conn.execute(
        "insert into events (space_id, seq, actor_id, verb, object_id, payload)"
        " values ($1,$2,$3,$4,$5,$6::jsonb)",
        space_id, seq, actor_id, verb, object_id, json.dumps(payload))


async def grant_read(conn, *, subject: str, resource: str, granted_by: str) -> None:
    """Indexing a repo and being allowed to read it are separate facts, and
    only the first has code behind it in the cron. The id follows
    commonindex/gateway/access.py's convention, so this is the same row
    `access.grant` upserts and `access.revoke` removes by id."""
    await conn.execute(
        "insert into grants (id, subject, relation, resource, granted_by)"
        " values ($1,$2,'read',$3,$4) on conflict (id) do nothing",
        f"g-{subject}-read-{resource.replace(':', '-')}", subject, resource, granted_by)


async def index_local(pool, path, *, space_id: str, actor_id: str, grant: bool = True) -> dict:
    """Index one local clone: the same connector, the same per-repo transaction
    and the same tombstones as the hourly pass, and a read grant for whoever
    indexed it. Shared by `scripts/index_repos.py` and `code.index`, so what the
    page indexes is what the script would have."""
    from commonindex.workers.connectors.localgit import Connector, LocalRepo, ref_for

    ref = await ref_for(path, space_id=space_id)
    connector = Connector([LocalRepo(ref=ref, path=path)])

    cursor = await _cursor_for(pool, ref)
    records, head = await connector.pull(ref.stream_name, cursor)

    written = removed = 0
    async with pool.acquire() as conn, conn.transaction():
        for record in records:
            file_path = record.props.get("path") or record.id
            if record.deleted:
                removed += await _tombstone_code_file(conn, ref, file_path, actor_id)
            else:
                written += await _upsert_code_file(conn, ref, record, actor_id)
        if ref.stream_name in connector.full_reads:
            removed += await _retire_absent(conn, ref, records, actor_id)
        await _upsert_repo(conn, ref, head, actor_id)
        # Not on a scheduled refresh (coderefresh.py): a read an admin revoked
        # since the first index must not come back on the hour.
        if grant:
            await grant_read(conn, subject=actor_id, resource=ref.acl_key, granted_by=actor_id)

    return {"repo": f"{ref.org}/{ref.repo}", "repo_id": ref.repo_id,
            "branch": ref.branch, "pulled": len(records),
            "indexed": written, "deleted": removed, "head": head}


def main() -> None:
    import asyncpg

    dsn = os.environ["COMMONINDEX_DSN"]

    async def _main() -> int:
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
        try:
            results = await run_once(pool)
        finally:
            await pool.close()
        print(json.dumps(results))
        # Exit non-zero if ANY repo failed. It printed its error and exited 0
        # before, so a caller that chained a second step — `make github-index`
        # does exactly that — reported success over a pull that wrote nothing.
        # A partial failure is still a failure to whoever scheduled this.
        return 1 if any("error" in r for r in results.values()) else 0

    raise SystemExit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
