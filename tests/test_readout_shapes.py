"""What a readout assumes about an outcome it was not told about.

Two wrong guesses, both found by registering real experiments. Revenue with no
`binary` was read as a 0/1 rate, and the readout refused it as a proportion
outside 0..1. And a guardrail's `better: down` was dropped on the way from the
contract, so support contacts rising 45% read as "better".
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from commonindex.core.warehouse import ColKind, Connection, Dataset, Dimension

_RECENT = (datetime.now(tz=UTC) - timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")


class _Req:
    def __init__(self, body, state):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": state})()})()

    async def json(self):
        return self._body


async def _return(v):
    return v


def _source(tmp_path, monkeypatch):
    """4000 users an arm. The variant activates more (40% -> 45%), contacts
    support more (6% -> 9%), and spends more (20 -> 22 a head)."""
    pytest.importorskip("aiosqlite")
    from sqlalchemy.ext.asyncio import create_async_engine

    from commonindex.core.warehouse.dialects import SPECS
    from commonindex.core.warehouse.sources.direct import DirectWarehouseSource
    from commonindex.gateway import authoring

    rows = []
    for arm, act, sup, spend in (("control", 1600, 240, 20), ("variant", 1800, 360, 22)):
        for i in range(4000):
            # Spread around the mean so the arms have variance to test.
            rows.append({"ts": _RECENT, "uid": f"{arm}{i}", "arm": arm,
                         "act": int(i < act), "sup": int(i < sup),
                         "spend": spend + (i % 21) - 10})
    url = f"sqlite:///{tmp_path/'shapes.sqlite'}"
    with sa.create_engine(url).begin() as c:
        c.execute(sa.text("create table exposures (ts timestamp, user_id varchar, arm varchar,"
                          " activated int, contacted_support int, spend real)"))
        c.execute(sa.text("insert into exposures values (:ts,:uid,:arm,:act,:sup,:spend)"), rows)

    ds = Dataset(
        id="exposures", connection_id="c1", physical="exposures", time_column="ts",
        dimensions=[Dimension("arm", "arm", ColKind.STRING),
                    Dimension("user_id", "user_id", ColKind.STRING),
                    Dimension("activated", "activated", ColKind.BOOL),
                    Dimension("contacted_support", "contacted_support", ColKind.BOOL),
                    Dimension("spend", "spend", ColKind.NUMBER)])

    class _Metrics:
        async def resolve(self, space, mid):
            raise LookupError(mid)

    src = DirectWarehouseSource(
        Connection(id="c1", space_id="s", kind="sqlite", dsn=url), _Metrics(),
        engine=create_async_engine(url.replace("sqlite://", "sqlite+aiosqlite://")))
    src._spec = SPECS["sqlite"]
    src._dataset = lambda _id, _ds=ds: _return(_ds)

    async def _fake_source(state, conn_id, space="pay"):
        return src, {}

    monkeypatch.setattr(authoring, "_source", _fake_source)
    from commonindex.gateway import experiments
    monkeypatch.setattr(experiments, "_source", _fake_source)
    return {"metrics": _Metrics()}


BODY = {"connection_id": "c1", "dataset_id": "exposures", "variation": "arm",
        "unit": "user_id", "control": "control", "range": "30d"}


async def test_an_amount_nobody_called_binary_is_compared_as_an_amount(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    out = await experiments_readout(_Req({**BODY, "outcome": "spend"},
                                         _source(tmp_path, monkeypatch)))
    result = out["results"][0]
    assert result["binary"] is False
    comp = result["comparisons"][0]
    assert comp["undecidable"] is None
    assert "welch" in comp["test"]
    assert comp["lift"] == pytest.approx(0.10, abs=0.01)


async def test_a_yes_no_column_is_still_a_rate(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    out = await experiments_readout(_Req({**BODY, "outcome": "activated"},
                                         _source(tmp_path, monkeypatch)))
    assert out["results"][0]["binary"] is True
    assert "proportion" in out["results"][0]["comparisons"][0]["test"]


async def test_a_guardrail_that_should_fall_and_rose_is_worse(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    body = {**BODY, "outcome": "activated",
            "guardrails": [{"outcome": "contacted_support", "better": "down"}]}
    out = await experiments_readout(_Req(body, _source(tmp_path, monkeypatch)))
    guard = out["results"][1]
    assert guard["role"] == "guardrail"
    assert guard["better"] == "down"
    assert guard["direction_assumed"] is False
    # Read off the column: a yes/no, so a rate — not a Welch t on 0s and 1s.
    assert guard["binary"] is True
    assert guard["comparisons"][0]["verdict"] == "worse"


async def test_a_bare_guardrail_name_still_reads(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    body = {**BODY, "outcome": "activated", "guardrails": ["contacted_support"]}
    out = await experiments_readout(_Req(body, _source(tmp_path, monkeypatch)))
    guard = out["results"][1]
    assert guard["better"] == "up" and guard["direction_assumed"] is True


async def test_a_plan_for_an_amount_is_sized_as_an_amount(tmp_path, monkeypatch):
    """The page asked with binary defaulted to true, and the plan refused revenue
    as 'a 0/1 outcome needs a baseline rate strictly between 0 and 1'."""
    from commonindex.gateway.experiments import experiments_plan

    out = await experiments_plan(_Req({**BODY, "outcome": "spend", "mde": 0.05},
                                      _source(tmp_path, monkeypatch)))
    assert "error" not in out, out
    assert out["total"] > 0


async def test_a_plan_is_sized_on_the_capped_outcome_the_readout_reads(tmp_path, monkeypatch):
    """Sized without the contract's cap, a few whales asked for 595K users where
    the capped readout was already decisive on 6K."""
    from commonindex.gateway.experiments import experiments_plan

    state = _source(tmp_path, monkeypatch)
    body = {**BODY, "outcome": "spend", "mde": 0.05}
    raw = await experiments_plan(_Req(body, state))
    capped = await experiments_plan(_Req({**body, "cap": 15}, state))
    assert capped["total"] < raw["total"]


async def test_a_numeric_user_id_is_suggested_as_the_person(tmp_path, monkeypatch):
    """`user_id integer` is the commonest person column there is; reading only
    text columns, the setup form said "counting rows" over a table with one."""
    pytest.importorskip("aiosqlite")
    from sqlalchemy.ext.asyncio import create_async_engine

    from commonindex.core.warehouse.dialects import SPECS
    from commonindex.core.warehouse.sources.direct import DirectWarehouseSource
    from commonindex.gateway import authoring

    url = f"sqlite:///{tmp_path/'ids.sqlite'}"
    with sa.create_engine(url).begin() as c:
        c.execute(sa.text("create table exposures (ts timestamp, user_id integer, arm varchar, upgraded int)"))
        c.execute(sa.text("insert into exposures values (:ts,:uid,:arm,:up)"),
                  [{"ts": _RECENT, "uid": i, "arm": "control" if i % 2 else "variant", "up": int(i % 9 == 0)}
                   for i in range(600)])
    ds = Dataset(id="exposures", connection_id="c1", physical="exposures", time_column="ts",
                 dimensions=[Dimension("arm", "arm", ColKind.STRING),
                             Dimension("user_id", "user_id", ColKind.NUMBER),
                             Dimension("upgraded", "upgraded", ColKind.BOOL)])

    class _Metrics:
        async def resolve(self, space, mid):
            raise LookupError(mid)

        async def all_for(self, *_a, **_k):
            return []

    src = DirectWarehouseSource(Connection(id="c1", space_id="s", kind="sqlite", dsn=url), _Metrics(),
                                engine=create_async_engine(url.replace("sqlite://", "sqlite+aiosqlite://")))
    src._spec = SPECS["sqlite"]
    src._dataset = lambda _id, _ds=ds: _return(_ds)

    async def _fake_source(state, conn_id, space="pay"):
        return src, {}

    monkeypatch.setattr(authoring, "_source", _fake_source)
    out = await authoring.experiments_suggest(_Req({"connection_id": "c1", "dataset_id": "exposures"},
                                                   {"metrics": _Metrics()}))
    assert [u["column"] for u in out["units"]] == ["user_id"]
    assert [v["column"] for v in out["versions"]] == ["arm"]          # a number id is never a version
