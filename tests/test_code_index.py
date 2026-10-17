"""Indexing a clone from the page, against a real database and a real clone.

Indexing was a terminal command, so Code query was a dead end for anyone
without one. What is defended: a clone under an allowed folder is indexed in
the background — the same files, repository row and read grant the script
writes — and its progress is readable; nothing outside the folders the
operator listed can be indexed, whatever the path says; a folder that is not a
clone is refused; a failure is kept and said, not swallowed.
"""

from __future__ import annotations

import json
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


@pytest.fixture(autouse=True)
def fresh_jobs(monkeypatch):

    # No Zoekt unless a test asks for one: building a shard runs Docker.
    monkeypatch.delenv("COMMONINDEX_ZOEKT_URL", raising=False)
    monkeypatch.delenv("COMMONINDEX_WORKER", raising=False)
    yield


def git_init(path):
    """An empty clone: no commit, so no HEAD to read."""
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)


def clone(root, name="ledger", files=None):
    """A real git clone with one commit."""
    repo = root / name
    repo.mkdir()
    for path, text in (files or {"ledger/post.py": "def post_entry(amount):\n    return amount\n"}).items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(text)
    for args in (["init", "-q", "-b", "main"], ["add", "."],
                 ["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-q", "-m", "first"]):
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
    return repo


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


class _Req:
    def __init__(self, body, conn):
        self._body = body
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": "maya"})(),
                                    "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {
            "commonindex": {"pool": _PoolOf(conn)}})()})()

    async def json(self):
        return self._body


async def index(db, path=None, key="k", **body):
    from commonindex.gateway.codeindex import code_index

    out = await code_index(_Req({**({"path": str(path)} if path else {}),
                                 "idempotencyKey": key, **body}, db))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


async def settled(db):
    """Indexing is queued for a worker; run what is queued."""
    from commonindex.workers.jobs import drain

    await drain(_PoolOf(db))


async def job_of(db, key):
    """The newest indexing job for `key`, as the page reads it."""
    row = await db.fetchrow("select state, progress, error from jobs where kind = 'code_index' and key = $1"
                            " order by created_at desc limit 1", key)
    progress = json.loads(row["progress"]) if isinstance(row["progress"], str) else row["progress"]
    return {**progress, "state": {"done": "ready", "failed": "failed"}.get(row["state"], "indexing"),
            "error": row["error"]}


async def test_a_clone_under_an_allowed_folder_is_indexed_and_readable(db, tmp_path, monkeypatch):
    from commonindex.gateway import codeindex

    monkeypatch.setenv("COMMONINDEX_CODE_ROOTS", str(tmp_path))
    repo = clone(tmp_path)
    status, out = await index(db, repo)
    assert status == 200 and out["job"]["state"] == "indexing"
    assert [j["state"] for j in (await codeindex.jobs(_PoolOf(db), 'pay'))] == ["indexing"]
    await settled(db)

    job = (await job_of(db, str(repo.resolve())))
    assert job["state"] == "ready" and job["result"]["indexed"] == 1
    assert (await codeindex.jobs(_PoolOf(db), 'pay')) == []   # done, so no longer something to wait on
    path = await db.fetchval("select title from objects where type = 'code_file'")
    assert path == "ledger/post.py"
    assert await db.fetchval("select count(*) from objects where type = 'code_repo'") == 1
    # Whoever indexed it can read it — the grant the script also writes.
    assert await db.fetchval(
        "select count(*) from grants where subject = 'maya' and relation = 'read'"
        " and resource = 'object:' || $1", job["result"]["repo_id"]) == 1


async def test_nothing_is_indexed_until_the_operator_names_the_folders(db, tmp_path, monkeypatch):
    monkeypatch.delenv("COMMONINDEX_CODE_ROOTS", raising=False)
    status, out = await index(db, clone(tmp_path))
    assert status == 422 and out["error"]["code"] == "indexing_off"
    assert "COMMONINDEX_CODE_ROOTS" in out["error"]["message"]
    assert "repository URL" in out["error"]["message"]   # and what works instead


async def test_nothing_outside_the_listed_folders_whatever_the_path_says(db, tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    monkeypatch.setenv("COMMONINDEX_CODE_ROOTS", str(allowed))
    outside = clone(tmp_path, "secrets")
    for path in (outside, allowed / ".." / "secrets"):
        status, out = await index(db, path)
        assert status == 403 and out["error"]["code"] == "outside_roots", path


async def test_a_folder_that_is_not_a_clone_is_refused(db, tmp_path, monkeypatch):
    monkeypatch.setenv("COMMONINDEX_CODE_ROOTS", str(tmp_path))
    (tmp_path / "notes").mkdir()
    status, out = await index(db, tmp_path / "notes")
    assert status == 422 and out["error"]["code"] == "not_a_clone"


async def test_a_failure_is_kept_and_said(db, tmp_path, monkeypatch):
    from commonindex.gateway import codeindex

    monkeypatch.setenv("COMMONINDEX_CODE_ROOTS", str(tmp_path))
    empty = tmp_path / "empty"
    empty.mkdir()
    git_init(empty)
    await index(db, empty)
    await settled(db)
    failed = (await codeindex.jobs(_PoolOf(db), 'pay'))
    assert [j["state"] for j in failed] == ["failed"] and failed[0]["error"]


# ── by URL ──────────────────────────────────────────────────────────────


@pytest.fixture
def cloned_from(tmp_path, monkeypatch):
    """`fetch_clone` without the network: the "remote" is a local clone, copied
    to where the gateway keeps its clones, with an https origin as a real
    clone would have. Returns what each call was asked for."""
    import shutil

    from commonindex.gateway import codeindex

    monkeypatch.setenv("COMMONINDEX_CODE_CLONES", str(tmp_path / "clones"))
    source = clone(tmp_path, "upstream")
    asked: list[dict] = []

    async def fake(url, dest, branch, token):
        asked.append({"url": url, "dest": dest, "branch": branch, "token": token})
        if dest.exists():
            return                    # a re-index: the real one fetches into it
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, dest)
        subprocess.run(["git", "remote", "add", "origin", url], cwd=dest, check=True)  # noqa: ASYNC221 - test fixture

    monkeypatch.setattr(codeindex, "fetch_clone", fake)
    monkeypatch.setattr("commonindex.adapters.model.check_base_url", lambda url, **_: None)
    return asked


async def test_a_repository_url_is_cloned_indexed_and_readable(db, tmp_path, cloned_from, monkeypatch):
    """No COMMONINDEX_CODE_ROOTS: a URL needs no folder the operator listed."""

    monkeypatch.delenv("COMMONINDEX_CODE_ROOTS", raising=False)
    status, out = await index(db, url="github.com/example/ledger")
    assert status == 200 and out["job"]["repo"] == "github.com/example/ledger"
    await settled(db)

    assert cloned_from[0]["url"] == "https://github.com/example/ledger.git"
    assert cloned_from[0]["dest"] == tmp_path / "clones" / "github.com" / "example" / "ledger"
    job = (await job_of(db, "https://github.com/example/ledger.git"))
    assert job["state"] == "ready", job
    assert job["result"]["repo"] == "example/ledger"     # named by its remote, as the script names it
    assert await db.fetchval("select title from objects where type = 'code_file'") == "ledger/post.py"
    assert await db.fetchval(
        "select count(*) from grants where subject = 'maya' and relation = 'read'"
        " and resource = 'object:' || $1", job["result"]["repo_id"]) == 1


async def test_a_private_repositorys_token_reaches_the_clone_and_nowhere_else(db, cloned_from):

    status, out = await index(db, url="https://github.com/example/ledger", token="ghp_secret",
                              branch="main")
    assert status == 200 and "ghp_secret" not in json.dumps(out)
    await settled(db)
    assert cloned_from[0]["token"] == "ghp_secret" and cloned_from[0]["branch"] == "main"
    rows = await db.fetch("select payload::text, progress::text, error, secret from jobs")
    assert "ghp_secret" not in json.dumps([dict(r) for r in rows], default=str)
    assert all(r["secret"] is None for r in rows)


async def test_the_shard_is_built_when_zoekt_is_in_use_and_its_absence_is_said(db, cloned_from, monkeypatch):
    from commonindex.gateway import codeindex
    from commonindex.workers import zoektindex

    monkeypatch.setenv("COMMONINDEX_ZOEKT_URL", "http://127.0.0.1:6070")
    built = []

    async def build(path, branch):
        built.append((path.name, branch))

    monkeypatch.setattr(zoektindex, "build_shard", build)
    await index(db, url="github.com/example/ledger")
    await settled(db)
    assert built == [("ledger", "main")]
    assert (await job_of(db, "https://github.com/example/ledger.git"))["zoekt"] == "built"

    async def unavailable(path, branch):
        raise zoektindex.ShardUnavailable("no Zoekt indexer here")

    monkeypatch.setattr(zoektindex, "build_shard", unavailable)
    await index(db, url="github.com/example/ledger", key="again")
    await settled(db)
    failed = (await codeindex.jobs(_PoolOf(db), 'pay'))
    assert failed[0]["state"] == "failed" and "not into Zoekt" in failed[0]["error"]


@pytest.mark.parametrize(("url", "why"), [
    ("http://github.com/example/ledger", "https"),
    ("https://me:ghp_x@github.com/example/ledger", "own field"),
    ("https://github.com/example", "owner and a repository"),
    ("https://github.com/example/ledger?x=1", "query"),
    ("https://127.0.0.1/example/ledger", "not a model provider|inside the network"),
    ("https://10.0.0.8/example/ledger", "inside the network"),
    ("https://localhost/example/ledger", "not a model provider"),
    ("https://169.254.169.254/latest/meta", "inside the network"),
])
async def test_a_url_the_gateway_should_not_dial_is_refused(db, url, why):
    import re

    status, out = await index(db, url=url)
    assert status == 422 and out["error"]["code"] == "bad_url", out
    assert re.search(why, out["error"]["message"]), out["error"]["message"]


async def test_a_url_and_a_folder_together_or_a_token_without_a_url_are_refused(db, tmp_path):
    status, out = await index(db, tmp_path, url="github.com/example/ledger")
    assert status == 422 and out["error"]["code"] == "url_or_path"
    status, out = await index(db, tmp_path, token="ghp_x")
    assert status == 422 and out["error"]["code"] == "token_without_url"
    status, out = await index(db, url="github.com/example/ledger", branch="--upload-pack=x")
    assert status == 422 and out["error"]["code"] == "bad_branch"


def test_git_runs_without_the_operators_config_and_with_the_token_off_argv():
    """A credential helper in the operator's config would clone a private
    repository with the operator's access instead of the caller's."""
    import base64

    from commonindex.gateway.codeindex import _git_env

    env = _git_env("ghp_secret")
    assert env["GIT_CONFIG_GLOBAL"] == __import__("os").devnull and env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert env["GIT_ALLOW_PROTOCOL"] == "https" and env["GIT_TERMINAL_PROMPT"] == "0"
    pairs = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"]
             for i in range(int(env["GIT_CONFIG_COUNT"]))}
    assert pairs["credential.helper"] == "" and pairs["http.followRedirects"] == "false"
    assert pairs["http.extraHeader"] == "Authorization: Basic " + base64.b64encode(
        b"x-access-token:ghp_secret").decode()
    assert "http.extraHeader" not in {_git_env(None).get(f"GIT_CONFIG_KEY_{i}") for i in range(3)}



def test_indexing_and_writing_code_records_are_an_admin_s():
    """`code.index` needed admin, but the generated `coderepos.propose` and
    `codefiles.propose` needed only propose — a contributor could write a file
    straight into code search."""
    from commonindex.gateway.app import REGISTRY

    for name in ("code.index", "coderepos.propose", "codefiles.propose"):
        assert REGISTRY.get(name).relation == "admin", name
    assert REGISTRY.get("docs.propose").relation == "propose"


def test_build_and_schema_files_are_indexed():
    from commonindex.workers.connectors.localgit import MAX_FILE_BYTES, indexable, language_of

    for path in ("Makefile", "docker/targets/server.Dockerfile", "Dockerfile",
                 "schema/cassandra/temporal/schema.cql", "cmd/tools/gendynamicconfig/dynamic_config.tmpl"):
        assert indexable(path), path
    assert language_of("Makefile") == "makefile" and language_of("schema.cql") == "sql"
    assert not indexable("assets/logo.svg") and not indexable("go.sum")
    assert MAX_FILE_BYTES >= 300_000        # a large repository's 270 KB handler tests are source


# ── indexed again on a schedule (commonindex/workers/coderefresh.py) ──────

URL = "https://github.com/example/ledger.git"


async def due_now(db):
    """Every source is past its interval: as if the hour had gone by."""
    await db.execute("update code_sources set refreshed_at = now() - interval '2 hours'")


async def refresh(db):
    from commonindex.workers.coderefresh import queue_due

    queued = await queue_due(_PoolOf(db))
    await settled(db)
    return queued


def commit_upstream(cloned_from_dest, path, text):
    """A new commit on the branch: the fake fetch leaves the clone as it is,
    so it is made in the clone, which is what a real fetch would bring."""
    (cloned_from_dest / path).write_text(text)
    for args in (["add", "."], ["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-q", "-m", "next"]):
        subprocess.run(["git", *args], cwd=cloned_from_dest, check=True, capture_output=True)


async def test_a_repository_indexed_by_url_is_indexed_again_when_due(db, cloned_from):
    await index(db, url="github.com/example/ledger")
    await settled(db)
    commit_upstream(cloned_from[0]["dest"], "ledger/post.py", "def post_journal_line(amount):\n    return amount\n")

    assert await refresh(db) == 0                      # not due yet
    await due_now(db)
    assert await refresh(db) == 1

    assert len(cloned_from) == 2 and cloned_from[1]["url"] == URL    # fetched again
    body = await db.fetchval("select props->>'body' from objects where title = 'ledger/post.py'")
    assert "post_journal_line" in body
    job = await job_of(db, URL)
    assert job["state"] == "ready" and job["refresh"] and job["result"]["indexed"] == 1


async def test_a_refresh_grants_nothing_an_admin_took_away(db, cloned_from):
    await index(db, url="github.com/example/ledger")
    await settled(db)
    await db.execute("delete from grants where subject = 'maya' and resource like 'object:code_repo-%'")
    await due_now(db)

    await refresh(db)

    assert await db.fetchval("select count(*) from grants where resource like 'object:code_repo-%'") == 0


async def test_a_failed_index_is_not_scheduled(db, tmp_path, monkeypatch):
    from commonindex.gateway import codeindex

    async def refuse(url, dest, branch, token):
        raise codeindex.CloneError("repository not found")

    monkeypatch.setattr(codeindex, "fetch_clone", refuse)
    monkeypatch.setattr("commonindex.adapters.model.check_base_url", lambda url, **_: None)
    await index(db, url="github.com/example/typo")
    await settled(db)

    assert await db.fetchval("select count(*) from code_sources") == 0


async def test_one_refresh_at_a_time_and_none_when_turned_off(db, cloned_from, monkeypatch):
    from commonindex.workers.coderefresh import queue_due

    await index(db, url="github.com/example/ledger")
    await settled(db)
    await due_now(db)
    assert await queue_due(_PoolOf(db)) == 1
    await due_now(db)
    assert await queue_due(_PoolOf(db)) == 0           # the first is still queued
    await settled(db)

    monkeypatch.setenv("COMMONINDEX_CODE_REFRESH_SECONDS", "0")
    await due_now(db)
    assert await queue_due(_PoolOf(db)) == 0


async def test_a_private_repositorys_token_is_kept_encrypted_for_the_refresh(db, cloned_from, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("COMMONINDEX_SECRET_KEY", Fernet.generate_key().decode())
    await index(db, url="https://github.com/example/ledger", token="ghp_secret")
    await settled(db)
    kept = await db.fetchval("select token from code_sources")
    assert kept and b"ghp_secret" not in bytes(kept)

    await index(db, url="https://github.com/example/ledger", key="k2")   # again, without the token
    await settled(db)
    await due_now(db)
    await refresh(db)

    assert [c["token"] for c in cloned_from] == ["ghp_secret", None, "ghp_secret"]
    rows = await db.fetch("select payload::text, progress::text, error, secret from jobs")
    assert "ghp_secret" not in json.dumps([dict(r) for r in rows], default=str)


async def test_keep_token_false_forgets_it_and_no_key_never_keeps_it(db, cloned_from, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("COMMONINDEX_SECRET_KEY", Fernet.generate_key().decode())
    await index(db, url="https://github.com/example/ledger", token="ghp_secret")
    await settled(db)
    await index(db, url="https://github.com/example/ledger", token="ghp_secret", keep_token=False, key="k2")
    await settled(db)
    assert await db.fetchval("select token from code_sources") is None

    monkeypatch.delenv("COMMONINDEX_SECRET_KEY")
    await index(db, url="https://github.com/example/ledger", token="ghp_secret", key="k3")
    await settled(db)
    assert await db.fetchval("select token from code_sources") is None


async def test_a_folder_under_the_roots_is_refreshed_too(db, tmp_path, monkeypatch):
    monkeypatch.setenv("COMMONINDEX_CODE_ROOTS", str(tmp_path))
    repo = clone(tmp_path)
    await index(db, repo)
    await settled(db)
    commit_upstream(repo, "ledger/post.py", "def post_journal_line(amount):\n    return amount\n")
    await due_now(db)

    assert await refresh(db) == 1
    assert "post_journal_line" in await db.fetchval(
        "select props->>'body' from objects where title = 'ledger/post.py'")
