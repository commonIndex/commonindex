"""The filter bar, and the panels it cannot reach.

A dashboard spans datasets and warehouses, so "filter by region" is not a
question every panel on it can be asked — one may not have the column, and one
may carry its own SELECT with no declared columns at all.

BI tools often settle this by making the author scope each filter to a set of charts
by hand. The scoping is then invisible on the rendered page: a dashboard where
two of six panels ignored the filter looks exactly like one where all six
honoured it, and "these are the EMEA numbers" gets said about a card showing
the worldwide total.

So the dataset answers it, and the panel says which it did.
"""

from __future__ import annotations

import pytest

from commonindex.core.warehouse import ColKind, Dataset, Dimension, Result
from commonindex.gateway import app as appmod


class Recording:
    """Records the QUERY, not just the call — the filter reaching the compiler
    is the thing under test, and a source that only counts calls cannot see it.
    """

    def __init__(self, dataset: Dataset) -> None:
        self.ds = dataset
        self.seen: list = []

    async def _dataset(self, _id):
        return self.ds

    async def run(self, q, as_principal=""):
        self.seen.append(q)
        return Result(columns=[("bucket", ColKind.TIME), ("value", ColKind.NUMBER)],
                      rows=[["d1", 1.0]])


def dataset(ds_id: str, *columns: str, unfilterable: str = "") -> Dataset:
    return Dataset(
        id=ds_id, connection_id="c", physical=ds_id, time_column="ts",
        dimensions=[Dimension(name=c, column=c, kind=ColKind.STRING,
                              filterable=c != unfilterable)
                    for c in columns],
    )


def panel(pid: str, dataset_id: str, **over):
    return {"id": pid, "title": pid, "mark": "line", "dataset_id": dataset_id,
            "metric_id": "agent_acceptance", "dimensions": [], "grain": "day",
            "filters": [], "limit": 0, "sort": "bucket", "connection_id": None,
            **over}


class Req:
    def __init__(self, body):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": appmod.state})()})()

    async def json(self):
        return self._body


@pytest.fixture
def board(monkeypatch):
    """Two panels on two datasets: one has `region`, one does not. That is the
    ordinary case on any dashboard wide enough to be worth filtering."""
    wide = Recording(dataset("d.wide", "region", "arm"))
    narrow = Recording(dataset("d.narrow", "arm"))
    by_conn = {"conn-wide": wide, "conn-narrow": narrow}

    dash = {"id": "dash-1", "title": "Board", "connection_id": "conn-wide",
            "dataset_id": "d.wide",
            "panels": [panel("p-wide", "d.wide"),
                       panel("p-narrow", "d.narrow", connection_id="conn-narrow")]}

    async def load(_id, space):
        return dash

    async def source_for(d, space):
        return wide

    async def source(state, conn_id, space="pay"):
        return by_conn[conn_id], {}

    class Metrics:
        async def resolve(self, space, mid):
            from commonindex.core.warehouse.metrics import Metric

            return Metric(id=mid, version=1, space_id=space, label=mid,
                          expr="AVG(x)", dataset_id="d", unit="pct",
                          better="up", status="ratified")

    monkeypatch.setattr(appmod, "_load_dashboard", load)
    # Rendering, not access, is what these test; access has its own tests.
    from commonindex.gateway import sharing

    async def allowed(*_a, **_k):
        return None

    monkeypatch.setattr(sharing, "guard", allowed)
    monkeypatch.setattr(appmod, "_source_for", source_for)
    monkeypatch.setattr(appmod.authoring, "_source", source)
    monkeypatch.setitem(appmod.state, "metrics", Metrics())
    return wide, narrow, dash


def emea():
    return {"dashboard_id": "dash-1", "range": "30d",
            "filters": [{"dimension": "region", "op": "eq", "values": ["emea"]}]}


# ── it reaches the query ────────────────────────────────────────────────


async def test_a_bar_filter_reaches_the_compiled_query(board):
    wide, _, _ = board
    await appmod.render(Req(emea()))
    (q,) = wide.seen
    assert [(f.dimension, f.op, f.values) for f in q.filters] == [("region", "eq", ["emea"])]


async def test_the_bar_adds_to_what_the_panel_stores_rather_than_replacing_it(board, monkeypatch):
    """A stored filter is part of what the panel IS; the bar is what the reader
    asked on top. A panel scoped to one arm cannot be widened by a reader asking
    for every region — that would silently change the panel's own definition."""
    wide, _, dash = board
    dash["panels"][0]["filters"] = [{"dimension": "arm", "op": "eq", "values": ["control"]}]
    await appmod.render(Req(emea()))
    (q,) = wide.seen
    assert [f.dimension for f in q.filters] == ["arm", "region"]


# ── and says where it could not ─────────────────────────────────────────


async def test_a_panel_whose_dataset_lacks_the_column_says_so(board):
    """The failure this exists to prevent: the narrow panel renders a total
    while the page says it is showing EMEA."""
    _, narrow, _ = board
    out = await appmod.render(Req(emea()))
    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-narrow")
    assert got["filters_applied"] == []
    assert got["filters_skipped"][0]["dimension"] == "region"
    assert "d.narrow" in got["filters_skipped"][0]["why"]
    # And it still rendered — a panel that cannot be filtered is not an error.
    assert narrow.seen and "series" in got


async def test_the_panel_that_could_honour_it_reports_it_applied(board):
    out = await appmod.render(Req(emea()))
    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-wide")
    assert got["filters_applied"] == [{"dimension": "region", "op": "eq", "values": ["emea"]}]
    assert got["filters_skipped"] == []


async def test_the_dashboard_names_every_panel_that_could_not_honour_the_bar(board):
    """The headline version: how many cards on this page are NOT showing what
    the filter bar says they are. One number a reader can check at a glance."""
    out = await appmod.render(Req(emea()))
    assert out["filters_partial"] == ["p-narrow"]


async def test_an_unfiltered_render_claims_nothing(board):
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert out["filters"] == []
    assert out["filters_partial"] == []
    assert all(p["filters_applied"] == [] for p in out["panels"])


async def test_the_filters_travel_with_the_numbers(board):
    """A number without the slice it was taken under is not reproducible. The
    echo is what carries it into a readout record and into an agent's context."""
    out = await appmod.render(Req(emea()))
    assert out["filters"] == [{"dimension": "region", "op": "eq", "values": ["emea"]}]


async def test_a_column_the_dataset_declares_unfilterable_is_not_filtered_on(board, monkeypatch):
    """`filterable` is a declaration about the column — a high-cardinality id,
    say. Honouring the bar anyway would compile a predicate the dataset said
    not to."""
    wide, _, _ = board
    wide.ds = dataset("d.wide", "region", "arm", unfilterable="region")
    out = await appmod.render(Req(emea()))
    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-wide")
    assert got["filters_applied"] == []
    assert got["filters_skipped"][0]["dimension"] == "region"


# ── and refuses what is not a filter ────────────────────────────────────


@pytest.mark.parametrize("bad, field", [
    ({"filters": "region=emea"}, "filters"),
    ({"filters": [{"dimension": "region", "op": "OR 1=1"}]}, "filters[0].op"),
    ({"filters": [{"op": "eq", "values": ["x"]}]}, "filters[0].dimension"),
    ({"filters": [{"dimension": "region", "op": "eq", "values": "emea"}]},
     "filters[0].values"),
])
async def test_a_filter_that_is_not_one_is_refused_by_field(board, bad, field):
    """The operator is a name from a closed table, never a fragment — so a
    reader, or an agent composing a filter, cannot compose a predicate."""
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d", **bad}))
    assert out.status_code == 422
    import json

    assert json.loads(out.body)["error"]["field"] == field


async def test_a_sql_panel_reports_the_bar_as_skipped_rather_than_ignoring_it(board, monkeypatch):
    """Rewriting somebody's statement to add a predicate is a different query
    than the one they reviewed. Not applying it is right; not SAYING so is the
    bug."""
    _, _, dash = board
    dash["panels"] = [panel("p-sql", "d.wide", sql="select 1", mark="sql")]

    async def run_sql(src, sql, limit):
        return ["n"], [[1]]

    monkeypatch.setattr(appmod.authoring, "_run_sql", run_sql)
    out = await appmod.render(Req(emea()))
    got = out["panels"][0]
    assert got["filters_applied"] == []
    assert got["filters_skipped"][0]["why"] == "this panel carries its own query"
    assert out["filters_partial"] == ["p-sql"]


# ── what the picker is allowed to offer ─────────────────────────────────


async def test_the_render_says_which_columns_the_dashboard_can_be_sliced_by(board):
    """The union across the panels' datasets. The picker reads this rather than
    introspecting again — a second answer to a question the render already
    answered is a second answer that can disagree."""
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert [c["name"] for c in out["filterable"]] == ["arm", "region"]


async def test_a_column_no_panel_can_filter_on_is_not_offered(board):
    """Otherwise the picker offers a column that every card then reports as
    skipped, which reads as a broken dashboard rather than a bad pick."""
    wide, _, _ = board
    wide.ds = dataset("d.wide", "region", "arm", unfilterable="region")
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert [c["name"] for c in out["filterable"]] == ["arm"]


async def test_the_column_list_is_computed_even_with_no_filter_applied(board):
    """It gates the picker, so computing it only when a filter is already set
    would mean the first filter could never be added."""
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert out["filters"] == [] and out["filterable"]


async def test_the_time_column_is_not_offered_as_a_filter(board):
    """The range control already owns that axis. Two controls on one axis is
    the failure a single range control exists to prevent: `ts >= X` under a
    window of 30d gives a page whose caption and data disagree, with neither
    of them wrong."""
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert "ts" not in [c["name"] for c in out["filterable"]]


async def test_filtering_on_the_time_column_is_still_reported_not_silently_dropped(board):
    """Not offered is not the same as forbidden — an agent may still send it.
    It is skipped like any column the dataset does not offer, and said so."""
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "ts", "op": "gte", "values": ["2026-01-01"]}]}))
    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-wide")
    assert got["filters_applied"] == []
    assert got["filters_skipped"][0]["dimension"] == "ts"


# ── a reading choice cannot un-certify a dashboard ──────────────────────


async def test_a_malformed_filter_is_refused_before_any_panel_runs(board):
    """It reached every panel, failed each one, and the dashboard came back
    UNCERTIFIED — so the page told the reader that its panels were bound to a
    metric nobody had ratified, when the actual problem was a typo in the
    filter box. Arity is checked where the filter is parsed now."""
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "region", "op": "between", "values": ["a", "b", "c"]}]}))
    assert out.status_code == 422
    import json

    err = json.loads(out.body)["error"]
    assert err["code"] == "bad_filter" and err["field"] == "filters[0].values"
    assert "exactly 2" in err["message"]


async def test_an_operator_that_binds_no_value_takes_none(board):
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "region", "op": "is_null", "values": []}]}))
    assert "panels" in out


async def test_a_panel_that_could_not_run_is_not_called_unratified(board, monkeypatch):
    """Certification is a claim about DEFINITIONS. A dropped table, a statement
    timeout or a revoked grant does not un-ratify the definition a panel cites
    — it means the dashboard is not showing what it claims, which is a
    different sentence with a different fix."""
    wide, _, _ = board

    async def boom(q, as_principal=""):
        raise RuntimeError('relation "gone" does not exist')

    monkeypatch.setattr(wide, "run", boom)
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert out["unratified"] == []
    assert "p-wide" in out["failed"]


async def test_a_metric_nobody_ratified_still_counts_as_unratified(board, monkeypatch):
    """The other half: this one IS a claim about definitions, and it is the
    reason `certified` exists."""
    from commonindex.core.warehouse import UnratifiedMetric

    wide, _, _ = board

    async def unratified(q, as_principal=""):
        raise UnratifiedMetric("m.conversion")

    monkeypatch.setattr(wide, "run", unratified)
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert "p-wide" in out["unratified"]
    assert out["certified"] is False


async def test_a_measure_can_be_filtered_but_not_grouped_by(board):
    """These were one flag, and the argument for the second was used to refuse
    the first: `amount > 100` is the commonest thing anyone asks of a measure,
    and every numeric column had been removed from the picker to prevent
    `amount = 12.5`. Grouping is where the number genuinely does not belong —
    one bucket per distinct value is a chart with ten thousand series."""
    from commonindex.core.warehouse import ColKind, Dimension

    wide, _, _ = board
    wide.ds.dimensions.append(
        Dimension(name="amount", column="amount", kind=ColKind.NUMBER,
                  filterable=True, groupable=False))
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert "amount" in [c["name"] for c in out["filterable"]]


async def test_the_picker_is_told_each_column_s_kind(board):
    """Without it the picker offers `contains` on a float and `between` on a
    status column, and a reader has to know the schema to tell which of
    thirteen operators means anything for the column they just chose."""
    from commonindex.core.warehouse import ColKind, Dimension

    wide, _, _ = board
    wide.ds.dimensions.append(
        Dimension(name="amount", column="amount", kind=ColKind.NUMBER))
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    by = {c["name"]: c["kind"] for c in out["filterable"]}
    assert by["amount"] == "number"
    assert by["region"] == "string"


async def test_a_numeric_range_reaches_the_query(board):
    """Two filters on ONE column, which is what a range IS. They AND, like
    every other pair — and both have to survive scoping to get there."""
    from commonindex.core.warehouse import ColKind, Dimension

    wide, _, _ = board
    wide.ds.dimensions.append(
        Dimension(name="amount", column="amount", kind=ColKind.NUMBER))
    await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "amount", "op": "gt", "values": [100]},
                    {"dimension": "amount", "op": "lt", "values": [500]}]}))
    (q,) = wide.seen
    assert [(f.dimension, f.op, f.values) for f in q.filters] == [
        ("amount", "gt", [100]), ("amount", "lt", [500])]


def test_introspection_declares_measures_groupable_but_not_filterable_no():
    """Where the default is decided, for every table nobody has registered."""
    import inspect

    from commonindex.core.warehouse.sources import direct

    src = inspect.getsource(direct.DirectWarehouseSource)
    assert "filterable=True," in src
    assert "groupable=kind is not ColKind.NUMBER" in src


def test_the_flags_survive_a_round_trip_through_storage():
    """`_dims_json` wrote name, column and kind. A dataset registered with a
    numeric column marked filterable came back filterable — and so did one
    marked unfilterable, because neither was stored."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring._dims_json)
    assert '"filterable": d.filterable' in src
    assert '"groupable": d.groupable' in src


# ── the slice a dashboard opens on ──────────────────────────────────────


async def test_a_dashboard_opens_on_its_own_slice(board):
    """The difference between "I sliced this to EMEA" and "this dashboard is
    about EMEA" is who it is true for. The second is a property of the page,
    and every reader re-typing it is how two people come to be looking at
    different numbers under one title."""
    wide, _, dash = board
    dash["filters"] = [{"dimension": "region", "op": "eq", "values": ["emea"]}]
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert out["filters"] == dash["filters"]
    assert out["default_filters"] == dash["filters"]
    (q,) = wide.seen
    assert [f.dimension for f in q.filters] == ["region"]


async def test_a_reader_can_clear_the_default(board):
    """`"filters" in body` rather than a truthiness check. An empty list is a
    reader deliberately asking for everything, and `or` would silently put the
    default back — making "show me all of it" the one thing they could not
    say."""
    wide, _, dash = board
    dash["filters"] = [{"dimension": "region", "op": "eq", "values": ["emea"]}]
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d", "filters": []}))
    assert out["filters"] == []
    # And the page still reports what it WOULD have opened on, so the UI can
    # say "you cleared this" rather than "there was never a filter".
    assert out["default_filters"] == dash["filters"]
    (q,) = wide.seen
    assert q.filters == []


async def test_a_readers_slice_replaces_the_default_rather_than_stacking(board):
    """Two filters on one column would be an AND nobody asked for."""
    wide, _, dash = board
    dash["filters"] = [{"dimension": "region", "op": "eq", "values": ["emea"]}]
    await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "region", "op": "eq", "values": ["apac"]}]}))
    (q,) = wide.seen
    assert [(f.dimension, f.values) for f in q.filters] == [("region", ["apac"])]


async def test_a_default_that_would_not_open_is_refused_when_it_is_saved():
    """Through the same parser the render uses, so a dashboard cannot be saved
    into a state where it will not open."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.dashboards_update)
    assert "_dash_filters" in src


# ── a dashboard over more than one table ────────────────────────────────
#
# This is the ordinary case, not the exotic one: `dash-two_warehouses` reads a
# Postgres table and a DuckDB file, and most real dashboards read several
# tables from one database. A filter names a COLUMN, and which panels have that
# column is a question about their datasets rather than about the filter.


async def test_a_column_both_datasets_have_is_applied_to_both(board):
    """`arm` is on the wide dataset and the narrow one. Nobody scoped the
    filter to either; the datasets answered."""
    wide, narrow, _ = board
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "arm", "op": "eq", "values": ["control"]}]}))
    assert out["filters_partial"] == []
    for src in (wide, narrow):
        (q,) = src.seen
        assert [f.dimension for f in q.filters] == ["arm"]


async def test_a_column_one_dataset_has_is_applied_only_there(board):
    """And the panels that could not take it say which dataset lacked it,
    rather than rendering an unsliced total under a page captioned EMEA."""
    wide, narrow, _ = board
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "region", "op": "eq", "values": ["emea"]}]}))

    (wq,) = wide.seen
    assert [f.dimension for f in wq.filters] == ["region"]
    (nq,) = narrow.seen
    assert nq.filters == [], "the narrow dataset has no region to filter on"

    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-narrow")
    assert "d.narrow" in got["filters_skipped"][0]["why"]
    assert out["filters_partial"] == ["p-narrow"]


async def test_the_picker_offers_the_union_of_every_dataset_s_columns(board):
    """Not the intersection. A dashboard over two tables is still worth
    filtering by a column only one of them has — that panel says so, and the
    other five are sliced."""
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert {c["name"] for c in out["filterable"]} == {"arm", "region"}


async def test_two_filters_can_land_on_different_datasets(board):
    """One for each table. Each panel takes the ones its dataset has, so the
    pair narrows the whole page without either being wrong anywhere."""
    wide, narrow, _ = board
    await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "arm", "op": "eq", "values": ["control"]},
                    {"dimension": "region", "op": "eq", "values": ["emea"]}]}))
    (wq,) = wide.seen
    assert [f.dimension for f in wq.filters] == ["arm", "region"]
    (nq,) = narrow.seen
    assert [f.dimension for f in nq.filters] == ["arm"]


async def test_the_value_list_unions_the_datasets_and_names_them(board, monkeypatch):
    """A column two datasets share can hold different values in each. The list
    is the union — and it says which datasets it read, because a value present
    in one is not necessarily present in the other, and the panel reading the
    other will show nothing rather than an error."""
    async def distinct(src, ds, dim, limit, since):
        vals = ([("control", 10), ("variant", 12)] if ds.id == "d.wide"
                else [("control", 3), ("holdout", 4)])
        return vals, False, None

    monkeypatch.setattr(appmod.authoring, "_distinct", distinct)
    out = await appmod.column_values(Req({"dashboard_id": "dash-1", "column": "arm"}))
    assert out["from"] == ["d.narrow", "d.wide"]
    got = {v["value"]: v["rows"] for v in out["values"]}
    # `control` is in both, so its counts add up; `holdout` exists in one.
    assert got == {"control": 13, "variant": 12, "holdout": 4}


async def test_the_value_list_reads_each_dataset_once_not_each_panel(board, monkeypatch):
    """Six panels on one table is one question. Asking it per panel is six
    scans of a warehouse fact table to populate a menu."""
    _, _, dash = board
    dash["panels"] = [panel("p1", "d.wide"), panel("p2", "d.wide"),
                      panel("p3", "d.wide")]
    reads = []

    async def distinct(src, ds, dim, limit, since):
        reads.append(ds.id)
        return [("emea", 1)], False, None

    monkeypatch.setattr(appmod.authoring, "_distinct", distinct)
    await appmod.column_values(Req({"dashboard_id": "dash-1", "column": "region"}))
    assert reads == ["d.wide"]


# ── scoping a filter by hand ────────────────────────────────────────────
#
# The automatic answer is right almost always. This is for the case it is not:
# two tables that share a column NAME meaning two different things, where
# "apply it everywhere the column exists" applies it somewhere wrong.


async def test_a_scoped_filter_reaches_only_the_panels_named(board):
    wide, narrow, _ = board
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "arm", "op": "eq", "values": ["control"],
                     "panels": ["p-wide"]}]}))
    (wq,) = wide.seen
    assert [f.dimension for f in wq.filters] == ["arm"]
    (nq,) = narrow.seen
    assert nq.filters == [], "the narrow panel was not in scope"

    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-narrow")
    assert got["filters_skipped"][0]["why"] == "this filter was scoped to other panels"


async def test_scoping_narrows_and_never_widens(board):
    """A filter aimed at a panel whose table lacks the column is still skipped,
    and still names the dataset that lacked it. Scoping is a way to ask for
    less, not a way to override the schema — otherwise it is a setting that
    compiles a column that is not there."""
    _, narrow, _ = board
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "region", "op": "eq", "values": ["emea"],
                     "panels": ["p-wide", "p-narrow"]}]}))
    (nq,) = narrow.seen
    assert nq.filters == []
    got = next(p for p in out["panels"] if p["panel"]["id"] == "p-narrow")
    assert "d.narrow" in got["filters_skipped"][0]["why"]


async def test_an_unscoped_filter_still_reaches_everything_that_has_the_column(board):
    """The default did not change. Absent scope means the dataset decides,
    which is what makes this an override rather than a requirement."""
    wide, narrow, _ = board
    await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "arm", "op": "eq", "values": ["control"]}]}))
    assert [f.dimension for f in wide.seen[0].filters] == ["arm"]
    assert [f.dimension for f in narrow.seen[0].filters] == ["arm"]


async def test_a_scope_that_is_not_a_list_of_ids_is_refused_by_field(board):
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "arm", "op": "eq", "values": ["x"], "panels": "p-wide"}]}))
    assert out.status_code == 422
    import json

    assert json.loads(out.body)["error"]["field"] == "filters[0].panels"


async def test_the_scope_travels_with_the_numbers(board):
    """Echoed like the rest of the filter, so a readout record and an agent
    both see which panels it was meant for."""
    out = await appmod.render(Req({
        "dashboard_id": "dash-1", "range": "30d",
        "filters": [{"dimension": "arm", "op": "eq", "values": ["control"],
                     "panels": ["p-wide"]}]}))
    assert out["filters"][0]["panels"] == ["p-wide"]
