"""Background work runs once, survives its worker, and keeps no secret.

Renders, snapshots and code indexing ran inside the web server: a restart lost
them halfway, and code indexing's progress lived in that one process's memory.
"""

from __future__ import annotations

import pytest
from db import DSN, reset

from commonindex.workers import jobs

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    try:
        yield conn
    finally:
        await conn.close()


@pytest.fixture
def kind(monkeypatch):
    ran = []

    async def run(pool, job, secret):
        ran.append((job["payload"]["n"], secret))
        if job["payload"].get("fail"):
            raise RuntimeError(f"broke using {secret}")

    monkeypatch.setitem(jobs.KINDS, "test", jobs.Kind(run, timeout=60, at_once=1, attempts=2))
    return ran


async def test_a_job_is_claimed_once(db, kind):
    await jobs.enqueue(db, "test", {"n": 1})
    first = await jobs._claim(db, "test", "a")
    assert first and first["attempts"] == 1
    assert await jobs._claim(db, "test", "b") is None


async def test_a_job_whose_worker_died_goes_back_then_fails(db, kind):
    jid = await jobs.enqueue(db, "test", {"n": 1})
    await jobs._claim(db, "test", "a")
    await db.execute("update jobs set locked_at = now() - interval '2 minutes' where id = $1", jid)
    await jobs._reap(db)
    assert await db.fetchval("select state from jobs where id = $1", jid) == "queued"
    await jobs._claim(db, "test", "b")                       # its second and last try
    await db.execute("update jobs set locked_at = now() - interval '2 minutes' where id = $1", jid)
    await jobs._reap(db)
    state, error = await db.fetchrow("select state, error from jobs where id = $1", jid)
    assert state == "failed" and "did not finish" in error


async def test_a_failure_is_said_and_the_secret_is_neither_kept_nor_repeated(db, kind, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("COMMONINDEX_SECRET_KEY", Fernet.generate_key().decode())
    jid = await jobs.enqueue(db, "test", {"n": 1, "fail": True}, secret="ghp_secret")
    assert await db.fetchval("select secret is not null from jobs where id = $1", jid)  # sealed, not plain
    assert b"ghp_secret" not in bytes(await db.fetchval("select secret from jobs where id = $1", jid))
    assert await jobs.drain(db) == 1
    assert kind == [(1, "ghp_secret")]                        # the job got it
    state, error, secret = await db.fetchrow("select state, error, secret from jobs where id = $1", jid)
    assert state == "failed" and "***" in error and "ghp_secret" not in error and secret is None


async def test_with_a_separate_worker_and_no_key_a_secret_is_refused(db, kind, monkeypatch):
    monkeypatch.delenv("COMMONINDEX_SECRET_KEY", raising=False)
    monkeypatch.setenv("COMMONINDEX_WORKER", "external")
    with pytest.raises(jobs.NoWayToKeepSecret):
        await jobs.enqueue(db, "test", {"n": 1}, secret="ghp_secret")
