"""Editing a dashboard with AI proposes; it does not save.

The model sees the current panels and the source's columns, and returns what to
add, remove or redefine. Every panel it proposes is held to the same checks as a
generated dashboard, and an id it invents is sent back rather than applied.
"""

from __future__ import annotations

import json

import pytest

from commonindex.core.warehouse import ColKind, Dataset, Dimension, TimeGrain
from commonindex.core.warehouse.dialects import SPECS
from commonindex.gateway import authoring
from commonindex.gateway import dashboard_assist as da

DS = Dataset(id="public.orders", connection_id="c1", physical="public.orders", time_column="created_at",
             grains=[TimeGrain.DAY, TimeGrain.WEEK],
             dimensions=[Dimension("channel", "channel", ColKind.STRING),
                         Dimension("region", "region", ColKind.STRING),
                         Dimension("amount_usd", "amount_usd", ColKind.NUMBER),
                         Dimension("created_at", "created_at", ColKind.TIME)])
PANELS = [{"panel_id": "p0", "title": "Orders", "mark": "stat", "grain": "none", "dimensions": [], "sql": None,
           "expr": "count(*)"},
          {"panel_id": "p1", "title": "Revenue per day", "mark": "line", "grain": "day", "dimensions": [],
           "sql": None, "expr": "sum(amount_usd)"}]


class _Llm:
    model = "stub"

    def __init__(self, *answers):
        self.answers, self.seen = list(answers), []

    async def complete(self, messages, **_):
        self.seen.append(messages)
        return json.dumps(self.answers.pop(0))


class _Pool:
    async def fetch(self, *_):
        return PANELS


class _Req:
    def __init__(self, body, llm):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": {"llm": llm, "pool": _Pool()}})()})()
        self.state = type("T", (), {})()

    async def json(self):
        return self._body


@pytest.fixture(autouse=True)
def _dashboard(monkeypatch):
    class Src:
        _spec = SPECS["postgres"]

        async def _dataset(self, _id):
            return DS

    async def row(state, did, space):
        return {"id": did, "title": "Payments"}, {"connection_id": "c1", "dataset_id": "public.orders"}

    async def source(state, cid, space):
        return Src(), {}

    async def allow(*_a, **_k):
        return None

    monkeypatch.setattr(authoring, "_dashboard_row", row)
    monkeypatch.setattr(da, "_source", source)
    from commonindex.gateway import sharing
    monkeypatch.setattr(sharing, "guard", allow)


BAR = {"title": "Revenue by region", "mark": "bar", "agg": "sum", "column": "amount_usd", "grain": "none",
       "dimension": "region", "sort": "value_desc"}


async def test_it_proposes_and_saves_nothing():
    llm = _Llm({"summary": "Adds revenue by region; revenue per day becomes bars.", "add": [BAR],
                "replace": [{"panel_id": "p1", "panel": {"title": "Revenue per day", "mark": "bar", "agg": "sum",
                                                         "column": "amount_usd", "grain": "day"}}]})
    out = await da.dashboards_ai_edit(_Req({"dashboard_id": "d1", "instruction": "add revenue by region; bars for revenue"}, llm))
    assert out["add"][0]["title"] == "Revenue by region"
    assert out["replace"][0]["panel_id"] == "p1" and out["titles"]["p1"] == "Revenue per day"
    assert "Nothing was changed" in out["note"]
    sent = json.loads(llm.seen[0][1]["content"])
    assert [p["id"] for p in sent["dashboard"]["panels"]] == ["p0", "p1"]      # it saw the dashboard


async def test_an_invented_panel_id_is_sent_back():
    llm = _Llm({"summary": "x", "remove": ["p9"]}, {"summary": "Removes Orders.", "remove": ["p0"]})
    out = await da.dashboards_ai_edit(_Req({"dashboard_id": "d1", "instruction": "remove orders"}, llm))
    assert out["remove"] == ["p0"]
    assert "not panel ids on this dashboard" in llm.seen[1][-1]["content"]


async def test_a_panel_the_source_cannot_answer_is_refused():
    bad = {"summary": "x", "add": [{"title": "Sum of channel", "mark": "bar", "agg": "sum", "column": "channel",
                                    "grain": "none"}]}
    out = await da.dashboards_ai_edit(_Req({"dashboard_id": "d1", "instruction": "sum the channel"}, _Llm(bad, bad, bad)))
    assert out.status_code == 502 and b"numeric column" in out.body
    assert b"Numeric columns (for sum/avg/min/max): amount_usd" in out.body   # told what is allowed


async def test_a_sum_without_its_column_is_mended_when_only_one_column_could_be_meant():
    no_col = {"summary": "Revenue by region.", "add": [{"title": "Revenue by region", "mark": "bar", "agg": "sum",
                                                       "grain": "none", "dimension": "region"}]}
    out = await da.dashboards_ai_edit(_Req({"dashboard_id": "d1", "instruction": "revenue by region"}, _Llm(no_col)))
    assert out["add"][0]["column"] == "amount_usd"
