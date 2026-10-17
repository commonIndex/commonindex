"""The sidebar's numbers come from the same lists the pages show, counted once.

Counting moved from the browser — which downloaded every list to count it — to
the gateway. These hold the rules it counted by: real rows only, "needs a
decision" by the gateway's own reasons, stale docs, dashboards with proposals.
"""

from __future__ import annotations

import pytest

from commonindex.gateway import counts


class _Req:
    async def json(self):
        return {}

    async def body(self):
        return b""


ANSWERS = {
    "experiments.list": {"experiments": [
        {"status": "running", "attention": ["reached its planned 14 days — decide"]},
        {"status": "running", "attention": []},
        {"status": "readout", "attention": None},
        {"status": "shipped", "attention": []},
    ]},
    "tasks.list": {"total": 5, "counts": {"review": 2, "flight": 1, "ready": 2}},
    "docs.list": {"docs": [{"freshness": "stale"}, {"freshness": "fresh"}, {}]},
    "dashboards.list": {"dashboards": [{"proposals": 1}, {"proposals": 0}, {}]},
    "context.skill": {"name": "warehouse-context"},
}


@pytest.fixture
def answered(monkeypatch):
    async def ask(req, op, body=None):
        return ANSWERS.get(op)
    monkeypatch.setattr(counts, "_ask", ask)


async def test_counts_follow_the_lists(answered):
    out = await counts.workspace_counts(_Req())
    assert out["experiments"] == {"total": 4, "running": 2, "readout": 2}
    assert out["tasks"] == {"total": 5, "review": 2, "flight": 1}
    assert out["docs"] == {"total": 3, "stale": 1}
    assert out["dashboards"] == {"total": 3, "proposals": 1}
    assert out["skills"] == {"total": 1, "installed": 1, "proposed": 0}


async def test_a_list_that_refused_counts_nothing(monkeypatch):
    async def ask(req, op, body=None):
        return None
    monkeypatch.setattr(counts, "_ask", ask)
    out = await counts.workspace_counts(_Req())
    assert out["experiments"]["total"] == 0 and out["skills"]["total"] == 0 and out["tasks"]["total"] == 0


def test_every_list_it_counts_is_found_on_the_real_app():
    # The first version looked only at app.routes, which in this FastAPI holds
    # included routers nested — so it found docs.list alone, counted every
    # other collection as zero, and the stubbed tests above could not tell.
    from commonindex.gateway.app import app

    class _R:
        pass
    req = _R()
    req.app = app
    for op in ("experiments.list", "tasks.list", "docs.list", "dashboards.list", "context.skill"):
        assert counts._handler(req, f"/api/v1/{op}") is not None, op
