"""A slow operation, answered later — to the one who asked, as them.

An answer from a model can outlast a load balancer's 60-second limit. Asked for
with `Prefer: respond-async`, it is queued and its answer kept for its caller.
"""

from __future__ import annotations

import json

import pytest
from db import DSN, reset, seed

from commonindex.core.authz.store import Principal

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


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


@pytest.fixture
async def db(monkeypatch):
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    from commonindex.gateway.app import app

    monkeypatch.setattr(app.state, "commonindex", {"pool": _PoolOf(conn)}, raising=False)
    try:
        yield conn
    finally:
        await conn.close()


class _Req:
    def __init__(self, body, conn, actor="maya", prefer="respond-async"):
        self._raw = json.dumps(body).encode()
        self.headers = {"prefer": prefer}
        self.state = type("S", (), {"principal": Principal(actor, "human", "standard", "t1", "session"),
                                    "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {"pool": _PoolOf(conn)}})()})()

    async def body(self):
        return self._raw

    async def json(self):
        return json.loads(self._raw)


async def test_it_is_queued_as_the_caller_and_answered_to_them_alone(db):
    from commonindex.gateway import async_ops

    asked = _Req({"job_id": "job-nope"}, db)
    out = await async_ops.defer(asked, "jobs.get", asked.state.principal, "pay")
    assert out.status_code == 202
    job_id = json.loads(out.body)["job_id"]
    payload, actor = await db.fetchrow("select payload, actor_id from jobs where id = $1", job_id)
    assert actor == "maya" and json.loads(payload)["principal"]["actor_id"] == "maya"

    # Run it the way the worker does: the real handler, as maya.
    from commonindex.workers.jobs import drain
    assert await drain(_PoolOf(db), ("op",)) == 1
    got = await async_ops.jobs_get(_Req({"job_id": job_id}, db))
    assert got["state"] == "done"
    # jobs.get for an unknown id, run as maya: her handler's own 404, kept as the answer.
    assert got["result"]["status"] == 404 and got["result"]["body"]["error"]["code"] == "unknown_job"


async def test_someone_elses_job_is_no_job(db):
    from commonindex.gateway import async_ops

    asked = _Req({}, db)
    job_id = json.loads((await async_ops.defer(asked, "jobs.get", asked.state.principal, "pay")).body)["job_id"]
    other = await async_ops.jobs_get(_Req({"job_id": job_id}, db, actor="vic"))
    assert other.status_code == 404


def test_only_a_caller_who_asks_is_answered_later():
    from commonindex.gateway import async_ops

    def asking(prefer):
        return type("R", (), {"headers": {"prefer": prefer}})()
    assert not async_ops.wants_async(asking("return=minimal"))
    assert async_ops.wants_async(asking("respond-async, wait=5"))
    assert "experiments.explain" in async_ops.ASYNC_OPS and "experiments.readout" not in async_ops.ASYNC_OPS
