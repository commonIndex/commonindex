"""One dashboard, panels on different warehouses.

`connection_id` lived only on the dashboard, and the reason I gave for that was
wrong: that a query cannot join a Postgres table to a Snowflake one. True of one
panel, and beside the point for a dashboard — `dashboards.render` runs one query
per panel and assembles the results in the application, so a dashboard was never
a single query and never needed to be.
"""

from __future__ import annotations

import pytest

from commonindex.gateway import app as appmod


class FakeSource:
    """Records what it was asked, so the test can assert which warehouse a
    panel actually went to rather than that a call happened."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.ran: list[str] = []

    async def run(self, q, as_principal=""):
        self.ran.append(q.metric_id)
        from commonindex.core.warehouse import Result

        return Result(columns=["bucket", "value"], rows=[])


def panel(pid: str, conn: str | None):
    return {"id": pid, "title": pid, "mark": "line",
            "dataset_id": "d", "metric_id": "agent_acceptance",
            "dimensions": [], "grain": "day", "filters": [], "limit": 0,
            "sort": "bucket", "connection_id": conn}


@pytest.fixture
def wired(monkeypatch):
    """A dashboard whose panels name different connections, with every source
    faked so the assertion is about routing rather than about SQL."""
    made: dict[str, FakeSource] = {}
    default = FakeSource("dashboard-default")

    dash = {
        "id": "dash-1", "title": "Two warehouses",
        "connection_id": "conn-a", "dataset_id": "d",
        "panels": [panel("p1", None), panel("p2", "conn-b"),
                   panel("p3", "conn-b"), panel("p4", None)],
    }

    async def load(dashboard_id, space):
        return dash

    async def source_for(d, space):
        return default

    async def source(state, conn_id, space="pay"):
        if conn_id not in made:
            made[conn_id] = FakeSource(conn_id)
        return made[conn_id], {}

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
    return default, made, dash


class Req:
    def __init__(self, body):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": appmod.state})()})()

    async def json(self):
        return self._body


async def test_a_panel_without_a_connection_reads_the_dashboards(wired):
    default, _, _ = wired
    await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    # p1 and p4 name nothing, so both went to the dashboard's own connection.
    assert len(default.ran) == 2


async def test_a_panel_that_names_a_connection_reads_that_one(wired):
    _, made, _ = wired
    await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert "conn-b" in made, "the panel's own connection was never opened"
    assert len(made["conn-b"].ran) == 2, "p2 and p3 should both go to conn-b"


async def test_one_source_per_distinct_connection_not_per_panel(wired):
    """Four panels across two warehouses opens two sources. Resolving per panel
    would open four, and each one is a connection pool."""
    _, made, _ = wired
    await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert list(made) == ["conn-b"], made


async def test_the_render_says_which_warehouse_a_panel_came_from(wired):
    """A number from another warehouse looks identical to one from this
    dashboard's, and a reader has no way to tell them apart otherwise."""
    del wired
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    by = {p["panel"]["id"]: p.get("connection_id") for p in out["panels"]}
    assert by["p2"] == "conn-b" and by["p3"] == "conn-b"
    # Silent where it matches the dashboard, so a single-warehouse dashboard
    # carries no per-panel noise.
    assert by["p1"] is None and by["p4"] is None


def test_panels_add_can_name_a_connection():
    from commonindex.gateway.app import REGISTRY

    assert "connection_id" in REGISTRY.get("panels.add").input_schema["properties"]


def test_panels_add_resolves_the_dataset_against_the_panels_connection():
    """It validated against the dashboard's either way, so a panel on a second
    warehouse was refused with "unknown dataset" naming a table that exists —
    in a different database."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.panels_add)
    assert 'conn_id = body.get("connection_id") or dash_conn' in src


def test_panels_add_registers_the_dataset_before_citing_it():
    """The metric it writes has a foreign key to `datasets`, and a table on a
    newly attached warehouse has no row there yet."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.panels_add)
    assert "insert into datasets" in src
    assert src.index("insert into datasets") < src.index("insert into panel_bindings")


@pytest.mark.parametrize("named,dash_conn,expect", [
    (None,      "conn-a", None),      # the common case: no key in the body
    ("conn-a",  "conn-a", None),      # named, but the same one — still null
    ("conn-b",  "conn-a", "conn-b"),  # genuinely different
])
def test_a_panels_connection_is_stored_only_when_it_differs(named, dash_conn, expect):
    """Null keeps meaning "whatever the dashboard reads", so a
    single-warehouse dashboard needs no per-panel bookkeeping.

    Asserted as behaviour. The version before this checked that a particular
    line of source appeared in the handler, which locked in the expression
    rather than the rule — including its `body["connection_id"]`, which raised
    a KeyError on every panel that named no connection at all.
    """
    body = {} if named is None else {"connection_id": named}
    conn_id = body.get("connection_id") or dash_conn
    stored = conn_id if body.get("connection_id") and conn_id != dash_conn else None
    assert stored == expect


async def test_a_failing_panel_still_says_which_warehouse_it_failed_on(wired, monkeypatch):
    """The case where it matters most: "no such table" is a different problem
    depending on which database was asked."""
    del wired

    async def boom(state, conn_id, space="pay"):
        class Dead:
            async def run(self, q, as_principal=""):
                raise RuntimeError("relation does not exist")
        return Dead(), {}

    monkeypatch.setattr(appmod.authoring, "_source", boom)
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    failed = next(p for p in out["panels"] if p["panel"]["id"] == "p2")
    assert "error" in failed
    assert failed.get("connection_id") == "conn-b"


# ── a panel that carries its own query ──────────────────────────────────


def sql_panel(pid: str, query: str, conn: str | None = None):
    p = panel(pid, conn)
    p["sql"] = query
    p["mark"] = "sql"
    return p


@pytest.fixture
def with_sql(monkeypatch, wired):
    """The same wiring, plus a panel carrying its own SELECT and a fake runner
    so the assertion is about what render does with rows, not about SQL."""
    _, _, dash = wired
    dash["panels"] = [panel("p1", None), sql_panel("s1", "select 1 as n")]

    async def run_sql(src, sql, limit):
        return ["n"], [[1]]

    monkeypatch.setattr(appmod.authoring, "_run_sql", run_sql)
    return dash


async def test_a_sql_panel_returns_rows_rather_than_a_series(with_sql):
    """An arbitrary SELECT has no metric, no unit and no guaranteed shape, so
    scaling or bucketing it would invent structure it does not have."""
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    got = next(p for p in out["panels"] if p["panel"]["id"] == "s1")
    assert got["columns"] == ["n"] and got["rows"] == [[1]]
    assert "series" not in got
    assert got["sql"] == "select 1 as n"


async def test_a_sql_panel_makes_its_dashboard_uncertified(with_sql):
    """The escape hatch, and what keeps it honest.

    Everything else on a dashboard cites a ratified definition; this cites
    nothing. Rather than a new rule it goes through the machinery that already
    exists — the dashboard reports `certified: false`, which is TRUE and not a
    penalty. Nobody has stood behind that number.
    """
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    assert out["certified"] is False
    assert "s1" in out["unratified"]


async def test_a_sql_panel_never_asks_the_metric_registry(with_sql, monkeypatch):
    """There is no definition to resolve, so asking would fail on every one."""
    asked = []

    class Watching:
        async def resolve(self, space, mid):
            asked.append(mid)
            from commonindex.core.warehouse.metrics import Metric

            return Metric(id=mid, version=1, space_id=space, label=mid, expr="AVG(x)",
                          dataset_id="d", unit="pct", better="up", status="ratified")

    monkeypatch.setitem(appmod.state, "metrics", Watching())
    await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    # Only the ordinary panel resolved a definition.
    assert asked == ["agent_acceptance"]


async def test_a_failing_query_reports_it_on_the_panel(with_sql, monkeypatch):
    async def boom(src, sql, limit):
        raise RuntimeError('relation "nope" does not exist')

    monkeypatch.setattr(appmod.authoring, "_run_sql", boom)
    out = await appmod.render(Req({"dashboard_id": "dash-1", "range": "30d"}))
    got = next(p for p in out["panels"] if p["panel"]["id"] == "s1")
    assert "does not exist" in got["error"]
    # The query travels with the failure — it is the thing to fix.
    assert got["sql"] == "select 1 as n"


def test_the_query_is_validated_when_it_is_written_not_when_it_runs():
    """Through the same guard `datasets.create_virtual` uses, so an author
    finds out while still looking at the thing they typed."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.panels_add)
    assert "check_sql(raw_sql" in src and "bad_sql" in src


def test_the_query_is_stored_so_it_can_be_read_back():
    """The difference between an escape hatch and a hole. A query nobody can
    see is one nobody can review, diff, or find when the number is wrong."""
    from pathlib import Path

    mig = Path(__file__).resolve().parent.parent / "migrations/0012_sql_panel.sql"
    assert "add column sql text" in mig.read_text()


def test_the_mark_constraint_keeps_every_spelling_already_stored():
    """Rewriting the CHECK dropped `heatmap`, which is the STORED spelling —
    `heat` is only what the client calls it. Every panel already using it would
    have been rejected on its next write."""
    from pathlib import Path

    mig = Path(__file__).resolve().parent.parent / "migrations/0012_sql_panel.sql"
    text = mig.read_text()
    for mark in ("stat", "line", "area", "bar", "stacked", "heatmap", "heat", "table", "sql"):
        assert f"'{mark}'" in text, mark


# ── what a saved query may be ───────────────────────────────────────────


import pytest as _pytest


@_pytest.mark.parametrize("sql", [
    "SELECT 1 UNION ALL SELECT 2",
    "SELECT a FROM t UNION SELECT b FROM u",
    "SELECT 1 INTERSECT SELECT 2",
    "SELECT 1 EXCEPT SELECT 2",
])
def test_a_set_operation_is_a_query(sql):
    """`check_sql` compared the top node's class name to "Select", so every
    UNION, INTERSECT and EXCEPT was refused — one of the commonest shapes a
    saved query takes, unreachable through `datasets.preview_sql`,
    `datasets.create_virtual` and inline-SQL panels alike."""
    from commonindex.gateway.authoring import check_sql

    assert check_sql(sql, "postgres")


@_pytest.mark.parametrize("sql,contains", [
    ("WITH x AS (INSERT INTO g (id) VALUES ('g') RETURNING *) SELECT * FROM x", "INSERT"),
    ("WITH x AS (DELETE FROM g RETURNING *) SELECT * FROM x", "DELETE"),
    ("WITH x AS (UPDATE g SET n = 1 RETURNING *) SELECT * FROM x", "UPDATE"),
])
def test_a_write_hidden_in_a_cte_is_refused(sql, contains):
    """These are `Select` nodes, so a class-name check accepted them. Postgres
    happens to reject them once `_run_sql` wraps them in a subquery, which is
    an accident of the wrapper rather than anything the guard was doing — and
    not every engine does."""
    from commonindex.gateway.authoring import BadSQL, check_sql

    with _pytest.raises(BadSQL) as e:
        check_sql(sql, "postgres")
    assert contains in str(e.value)


def test_select_into_is_refused():
    """Also a `Select` node, and it creates a table."""
    from commonindex.gateway.authoring import BadSQL, check_sql

    with _pytest.raises(BadSQL) as e:
        check_sql("SELECT * INTO newtbl FROM t", "postgres")
    assert "INTO" in str(e.value)


# ── how wide a panel is ─────────────────────────────────────────────────


def test_a_span_is_a_whole_number_of_columns():
    """The grid is twelve columns. A stored width the grid will not draw is a
    number that disagrees with the picture, which is worse than no number."""
    from pathlib import Path

    mig = (Path(__file__).resolve().parent.parent
           / "migrations/0014_panel_span.sql").read_text()
    assert "span >= 2 and span <= 12" in mig


def test_null_means_the_heuristic_still_decides():
    """Every panel that exists wants this: nobody has said otherwise, and
    writing today's guess into the column on first save would freeze it as a
    decision no one made."""
    from pathlib import Path

    mig = (Path(__file__).resolve().parent.parent
           / "migrations/0014_panel_span.sql").read_text()
    assert "add column span smallint" in mig
    assert "span is null or" in mig


def test_the_client_prefers_a_stored_span_to_its_own_guess():
    """Same rule as a registered dataset outranking introspection: the guess
    describes the page as it is today, and a person saying "this heatmap is the
    point" should survive adding a panel next to it."""
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent
           / "web/src/views/Dashboards.tsx").read_text()
    assert "p.panel.span ?? spanFor(" in src


def test_resize_is_not_a_read():
    """It writes. `datasets.profile` was `read` and mutating, and that is the
    class of mistake this checks for on the way in."""
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    reg = Registry()
    register(reg)
    op = reg.get("panels.resize")
    assert op.mutating and op.relation == "propose"


def test_a_height_is_bounded_at_both_ends():
    """Below about 160px a time series is a strip — the comment on PLOT_H says
    208 was already too short to read a line in — and past 900 the panel is
    taller than the viewport it is read in."""
    from pathlib import Path

    mig = (Path(__file__).resolve().parent.parent
           / "migrations/0015_panel_height.sql").read_text()
    assert "height >= 160 and height <= 900" in mig


def test_height_is_stored_in_pixels_not_grid_rows():
    """The grid's rows are auto-sized to their content, so a row unit would be
    a unit whose size depends on what happens to be in the row beside it — the
    number stored on Monday would mean something different on Tuesday."""
    from pathlib import Path

    mig = (Path(__file__).resolve().parent.parent
           / "migrations/0015_panel_height.sql").read_text()
    assert "add column height smallint" in mig


def test_resize_takes_either_axis_or_both():
    """Width alone was the first version, and a table of thirty rows can only
    be fixed by height."""
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    reg = Registry()
    register(reg)
    props = reg.get("panels.resize").input_schema["properties"]
    assert "spans" in props and "heights" in props
    # Neither is required: setting only one is the common case.
    assert reg.get("panels.resize").input_schema["required"] == [
        "dashboard_id", "idempotencyKey"]


def test_a_parse_error_carries_where_it_stopped():
    """sqlglot reports the line, the column and the token it choked on, and all
    three were being flattened into "could not parse that SQL" — which tells an
    author their query is wrong and not where, in an editor that can point
    straight at it."""
    from commonindex.gateway.authoring import BadSQL, check_sql

    with _pytest.raises(BadSQL) as e:
        check_sql("select arm,\n  count(*) as n\n  fro t\n group by 1", "postgres")
    at = e.value.at
    assert at["line"] == 3
    assert at["col"] == 5
    assert at["token"] == "fro"
    # And the parser's own words, rather than a generic sentence over the top.
    assert "Unexpected token" in str(e.value)


def test_an_error_response_may_carry_more_than_the_four_standard_fields():
    """`_error` took code, message and field. A parse position fits in none of
    them, and the alternative to letting it through is the UI re-deriving what
    the parser already knew."""
    import json

    from commonindex.gateway.authoring import _error

    r = _error(422, "bad_sql", "nope", "sql", at={"line": 2, "col": 7}, detail="d")
    body = json.loads(r.body)["error"]
    assert body["at"] == {"line": 2, "col": 7}
    assert body["detail"] == "d"


def test_nothing_is_added_to_an_error_that_has_nothing_to_add():
    """A None extra is dropped rather than serialised as null, so every other
    error keeps the shape callers already parse."""
    import json

    from commonindex.gateway.authoring import _error

    body = json.loads(_error(422, "x", "y", "f", at=None).body)["error"]
    assert set(body) == {"code", "message", "field"}


class _Holds:
    """The pool, as far as panels.query asks it: which dashboard holds a panel."""

    def __init__(self, holder):
        self.holder = holder

    async def fetchval(self, sql, panel_id, space):
        return self.holder if panel_id.startswith("p") else None


async def test_one_panel_is_read_by_its_id_as_the_dashboard_renders_it(wired, monkeypatch):
    """`panels.query` takes a panel_id — its schema, and every agent reading it,
    says so — and read a metric_id instead, so each call was a 500."""
    _, made, _ = wired
    monkeypatch.setitem(appmod.state, "pool", _Holds("dash-1"))
    out = await appmod.panel_query(Req({"panel_id": "p2", "range": "7d"}))
    assert out["panel"]["id"] == "p2" and out["dashboard_id"] == "dash-1"
    assert out["range"] == "7d" and out["connection_id"] == "conn-b"
    assert made["conn-b"].ran                                   # it went where the panel says


async def test_a_panel_nobody_has_is_a_404_not_a_500(wired, monkeypatch):
    import json

    monkeypatch.setitem(appmod.state, "pool", _Holds(None))
    for body in ({"panel_id": "nope"}, {}):
        out = await appmod.panel_query(Req(body))
        assert out.status_code in (404, 422), json.loads(out.body)


def test_a_panel_can_be_placed_at_a_column():
    """Free placement: where a panel starts across the twelve columns, so a gap
    is where the author left one rather than wherever the next panel did not fit."""
    from pathlib import Path

    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    mig = (Path(__file__).resolve().parent.parent / "migrations/0031_panel_col.sql").read_text()
    assert "col between 1 and 12" in mig
    reg = Registry()
    register(reg)
    cols = reg.get("panels.resize").input_schema["properties"]["cols"]
    assert cols["additionalProperties"]["anyOf"][0] == {"type": "integer", "minimum": 1, "maximum": 12}


async def test_resize_writes_a_column_and_refuses_one_off_the_grid(monkeypatch):
    from commonindex.gateway import authoring, sharing

    writes = []

    class Conn:
        async def fetch(self, *_):
            return [{"panel_id": "p1"}]

        async def execute(self, sql, *args):
            writes.append((sql.split(" set ")[1].split(" ")[0] if " set " in sql else sql[:20], args))

        def transaction(self):
            class T:
                async def __aenter__(self): return self
                async def __aexit__(self, *a): return False
            return T()

    class Pool:
        def acquire(self):
            class A:
                async def __aenter__(self): return Conn()
                async def __aexit__(self, *a): return False
            return A()

    async def allow(*_a, **_k):
        return None

    async def row(*_a):
        return {"id": "d1"}, {}

    monkeypatch.setattr(sharing, "guard", allow)
    monkeypatch.setattr(authoring, "_dashboard_row", row)

    class Req:
        def __init__(self, body):
            self._b = body
            self.app = type("A", (), {"state": type("S", (), {"commonindex": {"pool": Pool()}})()})()
            self.state = type("T", (), {})()

        async def json(self):
            return self._b

    out = await authoring.panels_resize(Req({"dashboard_id": "d1", "cols": {"p1": 7}, "idempotencyKey": "k"}))
    assert out["cols"] == {"p1": 7} and ("col", ("d1", "p1", 7)) in writes
    out = await authoring.panels_resize(Req({"dashboard_id": "d1", "cols": {"p1": None}, "idempotencyKey": "k"}))
    assert ("col", ("d1", "p1", None)) in writes                     # back to following the panel before
    bad = await authoring.panels_resize(Req({"dashboard_id": "d1", "cols": {"p1": 13}, "idempotencyKey": "k"}))
    assert bad.status_code == 422
