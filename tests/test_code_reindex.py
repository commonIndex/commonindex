"""Re-indexing a repository, pass after pass, against a real database and a real clone.

The connector tests check what a pull returns; these check what a second pass
leaves searchable. A re-index is the cron's whole job, and its failures are
quiet ones: an edit still answering with yesterday's code, a deleted file still
found, a pass that rewrites the corpus because nothing told it to stop.
"""

from __future__ import annotations

import subprocess

import pytest
from db import DSN, reset, seed

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    try:
        yield conn
    finally:
        await conn.close()


class _PoolOf:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Held:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_):
                return False

        return _Held()

    def __getattr__(self, name):
        return getattr(self._conn, name)


def git(repo, *args):
    subprocess.run(["git", "-c", "user.email=t@e.st", "-c", "user.name=t", *args],
                   cwd=repo, check=True, capture_output=True)


def write(repo, files):
    for path, text in files.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(text)


def commit(repo, message="change"):
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "ledger"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", "https://github.com/example/ledger.git")
    write(repo, {"ledger/post.py": "def post_entry(amount):\n    return amount\n",
                 "ledger/void.py": "def void_entry(entry):\n    return None\n",
                 "ledger/rates.py": "def convert_currency(value):\n    return value\n"})
    commit(repo, "first")
    return repo


async def index(db, repo):
    from commonindex.workers.codequery import index_local

    return await index_local(_PoolOf(db), repo, space_id="pay", actor_id="maya")


async def found(db, q):
    """What a search finds, through the same Postgres leg code.search falls back to."""
    from commonindex.gateway.codesearch import search

    repo_id = await db.fetchval("select id from objects where type = 'code_repo' and deleted_at is null")
    out = await search(_PoolOf(db), None, q=q, space="pay", acl_keys=["object:" + repo_id])
    return sorted(h["path"] for h in out["hits"])


async def live_paths(db):
    return sorted(r["title"] for r in await db.fetch(
        "select title from objects where type = 'code_file' and deleted_at is null"))


async def test_a_second_pass_with_nothing_new_writes_nothing(db, repo):
    first = await index(db, repo)
    events = await db.fetchval("select count(*) from events")
    revisions = await db.fetchval("select count(*) from revisions")

    again = await index(db, repo)

    assert first["indexed"] == 3
    assert again == {**again, "pulled": 0, "indexed": 0, "deleted": 0}
    assert await db.fetchval("select count(*) from revisions") == revisions
    # The repository row's health is the only event: no file looks edited.
    assert await db.fetchval("select count(*) from events where verb = 'object.upsert'"
                             " and object_id like 'code_file-%' and seq > 0") == 3
    assert await db.fetchval("select count(*) from events") == events + 1


async def test_an_edit_is_searchable_and_the_old_text_is_not(db, repo):
    await index(db, repo)
    write(repo, {"ledger/post.py": "def post_journal_line(amount):\n    return amount\n"})
    commit(repo)

    out = await index(db, repo)

    assert (out["pulled"], out["indexed"]) == (1, 1)
    assert await found(db, "post_journal_line") == ["ledger/post.py"]
    assert await found(db, "post_entry") == []
    assert await db.fetchval("select current_rev from objects where title = 'ledger/post.py'") == 2


async def test_a_deleted_file_stops_answering(db, repo):
    await index(db, repo)
    (repo / "ledger" / "void.py").unlink()
    commit(repo)

    out = await index(db, repo)

    assert out["deleted"] == 1
    assert await found(db, "void_entry") == []
    assert await live_paths(db) == ["ledger/post.py", "ledger/rates.py"]
    assert await db.fetchval("select count(*) from chunks c join objects o on o.id = c.object_id"
                             " where o.title = 'ledger/void.py'") == 0


async def test_a_rename_moves_the_file_rather_than_copying_it(db, repo):
    await index(db, repo)
    git(repo, "mv", "ledger/rates.py", "ledger/fx.py")
    commit(repo)

    await index(db, repo)

    assert await found(db, "convert_currency") == ["ledger/fx.py"]
    assert await live_paths(db) == ["ledger/fx.py", "ledger/post.py", "ledger/void.py"]


async def test_a_file_deleted_and_restored_keeps_its_object(db, repo):
    await index(db, repo)
    file_id = await db.fetchval("select id from objects where title = 'ledger/void.py'")
    (repo / "ledger" / "void.py").unlink()
    commit(repo)
    await index(db, repo)
    write(repo, {"ledger/void.py": "def void_entry(entry):\n    return entry\n"})
    commit(repo)

    await index(db, repo)

    assert await db.fetchval("select id from objects where title = 'ledger/void.py'"
                             " and deleted_at is null") == file_id
    assert await found(db, "void_entry") == ["ledger/void.py"]


async def test_new_index_rules_reread_the_tree_without_rewriting_it(db, repo):
    """A widened allowlist must reach files untouched since the last pass —
    and re-reading them must not count as editing them."""
    await index(db, repo)
    await db.execute("update objects set props = props || '{\"index_rules\": \"older\"}'"
                     " where type = 'code_repo'")

    out = await index(db, repo)

    assert (out["pulled"], out["indexed"]) == (3, 0)


async def test_a_force_push_drops_what_the_new_history_does_not_have(db, repo):
    """A rewritten history cannot be diffed from the old cursor, so the pass
    reads the whole tree. A file the rewrite removed is then simply absent from
    what was read — and absent is not the same as deleted unless the pass says
    so."""
    await index(db, repo)
    git(repo, "checkout", "-q", "--orphan", "rewritten")
    git(repo, "rm", "-q", "--cached", "ledger/void.py")
    (repo / "ledger" / "void.py").unlink()
    commit(repo, "rewritten")
    git(repo, "branch", "-q", "-D", "main")
    git(repo, "branch", "-q", "-m", "main")
    git(repo, "reflog", "expire", "--expire=now", "--all")
    git(repo, "gc", "-q", "--prune=now")

    out = await index(db, repo)

    assert out["deleted"] == 1
    assert await found(db, "void_entry") == []
    assert await live_paths(db) == ["ledger/post.py", "ledger/rates.py"]


async def test_a_file_the_rules_now_exclude_stops_answering(db, repo, monkeypatch):
    from commonindex.workers.connectors import localgit

    await index(db, repo)
    monkeypatch.setattr(localgit, "EXCLUDED_NAMES", {*localgit.EXCLUDED_NAMES, "rates.py"})
    await db.execute("update objects set props = props || '{\"index_rules\": \"older\"}'"
                     " where type = 'code_repo'")

    out = await index(db, repo)

    assert out["deleted"] == 1
    assert await found(db, "convert_currency") == []


async def test_a_large_file_and_a_binary_never_reach_search(db, repo):
    from commonindex.workers.connectors.localgit import MAX_FILE_BYTES

    write(repo, {"ledger/huge.py": "giant_marker = 1\n" * (MAX_FILE_BYTES // 16)})
    (repo / "ledger" / "blob.py").write_bytes(b"binary_marker\0\x01\x02")
    commit(repo)

    await index(db, repo)

    assert await found(db, "giant_marker") == []
    assert await found(db, "binary_marker") == []
    assert "ledger/huge.py" not in await live_paths(db)


async def test_many_files_index_once_and_search_stays_bounded(db, tmp_path):
    """A repository bigger than any one answer: every file indexed in one pass,
    a common word capped at the limit, a rare one found exactly."""
    from commonindex.gateway.codesearch import MAX_LIMIT, search

    repo = tmp_path / "mono"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, {f"pkg{i // 50}/mod{i}.py": f"def handler_{i}(request):\n    return request\n"
                 for i in range(600)})
    write(repo, {"pkg3/rare.py": "def reconcile_ledger_rare():\n    pass\n"})
    commit(repo, "many")

    out = await index(db, repo)
    repo_id = out["repo_id"]

    assert out["indexed"] == 601
    common = await search(_PoolOf(db), None, q="request", space="pay",
                          acl_keys=["object:" + repo_id], limit=500)
    assert len(common["hits"]) == MAX_LIMIT
    rare = await search(_PoolOf(db), None, q="reconcile_ledger_rare", space="pay",
                        acl_keys=["object:" + repo_id])
    assert [h["path"] for h in rare["hits"]] == ["pkg3/rare.py"]


async def test_a_reindex_never_widens_who_can_read(db, repo):
    """The pass grants its own actor; nobody else gains a repository by it
    being indexed again."""
    await index(db, repo)
    write(repo, {"ledger/post.py": "def post_entry(amount):\n    return -amount\n"})
    commit(repo)
    await index(db, repo)

    readers = await db.fetch("select distinct subject from grants where resource like 'object:code_repo-%'")
    assert [r["subject"] for r in readers] == ["maya"]
    repo_id = await db.fetchval("select id from objects where type = 'code_repo'")
    from commonindex.gateway.codesearch import search

    stranger = await search(_PoolOf(db), None, q="post_entry", space="pay", acl_keys=["space:pay"])
    assert stranger["hits"] == [] and repo_id


# ── the scheduled pass (python -m commonindex.workers.codequery) ─────────

@pytest.fixture
def scheduled(monkeypatch, tmp_path):
    """run_once with its GitHub connector swapped for clones on disk: the same
    pull contract (cursor in, records and new head out), no network."""
    from commonindex.workers import codequery
    from commonindex.workers.connectors import localgit

    clones = {}

    class OnDisk:
        def __init__(self, repos):
            self._inner = localgit.Connector(
                [localgit.LocalRepo(ref=r, path=clones.get(r.repo, tmp_path / "missing")) for r in repos])

        @property
        def full_reads(self):
            return self._inner.full_reads

        async def pull(self, stream, cursor):
            return await self._inner.pull(stream, cursor)

    monkeypatch.setattr(codequery, "Connector", OnDisk)

    async def run(db, *names):
        from commonindex.workers.connectors.git import RepoRef

        await db.execute("insert into actors (id, kind, display, owner_id) values"
                         " ('codequery', 'agent', 'Code Query indexer', 'maya') on conflict do nothing")
        repos = [RepoRef(org="example", repo=n, branch="main", space_id="pay") for n in names]
        return await codequery.run_once(_PoolOf(db), repos)

    return clones, run


async def test_the_scheduled_pass_picks_up_a_commit_and_skips_the_rest(db, repo, scheduled):
    clones, run = scheduled
    clones["ledger"] = repo

    first = await run(db, "ledger")
    write(repo, {"ledger/post.py": "def post_journal_line(amount):\n    return amount\n"})
    commit(repo)
    second = await run(db, "ledger")
    third = await run(db, "ledger")

    stream = "example/ledger#main"
    assert first[stream]["indexed"] == 3
    assert (second[stream]["pulled"], second[stream]["indexed"]) == (1, 1)
    assert (third[stream]["pulled"], third[stream]["indexed"]) == (0, 0)
    assert await found(db, "post_journal_line") == ["ledger/post.py"]


async def test_one_broken_repository_does_not_stop_the_others(db, repo, scheduled):
    clones, run = scheduled
    clones["ledger"] = repo        # "gone" has no clone at all

    out = await run(db, "gone", "ledger")

    assert out["example/gone#main"]["error"] == "GitError"
    assert out["example/ledger#main"]["indexed"] == 3


async def test_the_scheduled_pass_also_drops_what_a_rewrite_removed(db, repo, scheduled):
    clones, run = scheduled
    clones["ledger"] = repo
    await run(db, "ledger")
    await db.execute("update objects set props = props || '{\"last_indexed_sha\": \"0000000\"}'"
                     " where type = 'code_repo'")      # a cursor this history does not have
    (repo / "ledger" / "void.py").unlink()
    git(repo, "commit", "-q", "--amend", "-a", "-m", "rewritten")

    out = await run(db, "ledger")

    assert out["example/ledger#main"]["deleted"] == 1
    assert await found(db, "void_entry") == []


async def test_the_scheduled_pass_refuses_to_run_without_its_actor(db, repo, scheduled):
    from commonindex.workers import codequery
    from commonindex.workers.connectors.git import RepoRef

    with pytest.raises(SystemExit, match="no actor 'codequery'"):
        await codequery.run_once(_PoolOf(db), [RepoRef(org="example", repo="ledger", branch="main")])
