"""An experiment visit reads the warehouse once, not twice.

The page reads the readout; the AI summary beside it then needed the same
readout to check its kept answer still matched, and read the warehouse again.
The page's readout is now kept a minute, per caller, for the AI only.
"""

from __future__ import annotations

import pytest

from commonindex.gateway import authoring


class _Req:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def engine(monkeypatch):
    calls = []
    who = {"actor": "alex"}

    async def read(req):
        calls.append(await req.json())
        return {"results": [], "n": len(calls)}
    monkeypatch.setattr(authoring, "_experiments_readout", read)
    monkeypatch.setattr(authoring, "actor_of", lambda req: who["actor"])
    monkeypatch.setattr(authoring, "space_of", lambda req, body: "pay")
    authoring._RECENT.clear()
    yield calls, who
    authoring._RECENT.clear()


async def test_the_ai_reuses_the_page_readout(engine):
    calls, _ = engine
    page = await authoring.experiments_readout(_Req({"experiment_id": "exp-1", "range": "30d"}))
    assert authoring.recent_readout(_Req({}), {"experiment_id": "exp-1"}) == page
    assert len(calls) == 1


async def test_refresh_still_reads_the_warehouse(engine):
    calls, _ = engine
    await authoring.experiments_readout(_Req({"experiment_id": "exp-1"}))
    again = await authoring.experiments_readout(_Req({"experiment_id": "exp-1"}))
    assert len(calls) == 2 and again["n"] == 2


async def test_a_recorded_readout_is_not_kept_and_nobody_else_gets_one(engine):
    _, who = engine
    await authoring.experiments_readout(_Req({"experiment_id": "exp-1", "record": True}))
    assert authoring.recent_readout(_Req({}), {"experiment_id": "exp-1"}) is None
    await authoring.experiments_readout(_Req({"experiment_id": "exp-1"}))
    who["actor"] = "someone-else"
    assert authoring.recent_readout(_Req({}), {"experiment_id": "exp-1"}) is None


async def test_it_goes_stale_after_a_minute(engine, monkeypatch):
    await authoring.experiments_readout(_Req({"experiment_id": "exp-1"}))
    now = authoring.time.monotonic()
    monkeypatch.setattr(authoring.time, "monotonic", lambda: now + 61)
    assert authoring.recent_readout(_Req({}), {"experiment_id": "exp-1"}) is None
