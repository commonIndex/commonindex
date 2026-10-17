"""The same panel against three different warehouses.

Postgres over an async driver, DuckDB and SQLite over sync ones — which is the
split that matters, because BigQuery and Snowflake are sync-only too, so the sync
path is the one most real warehouses take.

Cloud warehouses cannot be proved here for the obvious reason. What these tests
do establish is that the abstraction is not quietly Postgres-shaped: SQLite has
no DATE_TRUNC at all, so if the grain interface leaked an assumption, it would
fail here.
"""

from __future__ import annotations

import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from commonindex.core.warehouse import (
    ColKind,
    Connection,
    Dataset,
    Dimension,
    Query,
    TimeGrain,
    Window,
)
from commonindex.core.warehouse.build import build
from commonindex.core.warehouse.dialects import ASYNC_DRIVERS, SPECS
from commonindex.core.warehouse.metrics import Metric
from commonindex.core.warehouse.sources.direct import DirectWarehouseSource

sa = pytest.importorskip("sqlalchemy")
pytestmark = pytest.mark.integration

#: A day after the newest fixture row, so the window genuinely contains it. An
#: earlier draft used 08-21 and the 08-21T09:00 row fell outside a window ending
#: at 08-21T00:00 — the code was right and the test was wrong, which is the
#: failure mode a window bound is supposed to have.
NOW = datetime(2026, 8, 22, tzinfo=UTC)
W = Window(NOW - timedelta(days=30), NOW)

#: A tiny fact table, created identically everywhere. Four rows across two days
#: and two regions, with one row outside the window.
ROWS = [
    ("2026-08-20 10:00:00", "emea", 10.0),
    ("2026-08-20 14:00:00", "emea", 20.0),
    ("2026-08-21 09:00:00", "amer", 5.0),
    ("2025-01-01 09:00:00", "emea", 999.0),   # outside every window under test
]

REVENUE = Metric(id="revenue", version=1, space_id="s", label="Revenue",
                 expr="SUM(amount)", unit="currency", better="up", status="ratified")


class OneMetric:
    async def resolve(self, space_id, metric_id):
        return REVENUE

    async def all_for(self, space_id, dataset_id=None):
        return [REVENUE]


def dataset_for(physical: str) -> Dataset:
    return Dataset(
        id=physical, connection_id="c1", physical=physical, time_column="ts",
        grains=list(TimeGrain),
        dimensions=[Dimension("region", "region", ColKind.STRING),
                    Dimension("amount", "amount", ColKind.NUMBER)],
    )


def make_source(kind: str, url: str, physical: str) -> DirectWarehouseSource:
    conn = Connection(id="c1", space_id="s", kind=kind, dsn=url)
    if kind in ASYNC_DRIVERS:
        from sqlalchemy.ext.asyncio import create_async_engine
        engine = create_async_engine(url)
    else:
        engine = sa.create_engine(url)
    src = DirectWarehouseSource(conn, OneMetric(), engine=engine)
    # Datasets are declared rather than introspected here so the test is about
    # execution; introspection has its own test below.
    ds = dataset_for(physical)
    src._dataset = lambda _id: _return(ds)
    return src


async def _return(v):
    return v


def seed_sync(engine, table: str) -> None:
    with engine.begin() as c:
        c.execute(sa.text(f"create table {table} (ts timestamp, region varchar, amount double)"))
        for ts, region, amt in ROWS:
            c.execute(sa.text(f"insert into {table} values ('{ts}', '{region}', {amt})"))


# ── the three we can actually run ──────────────────────────────────────


@pytest.fixture
def duckdb_source(tmp_path):
    pytest.importorskip("duckdb_engine")
    url = f"duckdb:///{tmp_path/'w.duckdb'}"
    engine = sa.create_engine(url)
    seed_sync(engine, "sales")
    return make_source("duckdb", url, "sales"), engine


@pytest.fixture
def sqlite_source(tmp_path):
    url = f"sqlite:///{tmp_path/'w.sqlite'}"
    engine = sa.create_engine(url)
    seed_sync(engine, "sales")
    # aiosqlite for the async path; falls back to the sync engine if absent
    pytest.importorskip("aiosqlite")
    from sqlalchemy.ext.asyncio import create_async_engine
    src = make_source("sqlite", f"sqlite+aiosqlite:///{tmp_path/'w.sqlite'}", "sales")
    src._engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path/'w.sqlite'}")
    return src, engine


async def test_duckdb_runs_through_the_sync_path(duckdb_source):
    """DuckDB's SQLAlchemy dialect is sync-only, as BigQuery's and Snowflake's
    are — so this is the path most real warehouses take."""
    src, _ = duckdb_source
    assert src.is_async is False
    r = await src.run(Query(metric_id="revenue", dataset_id="sales", grain=TimeGrain.NONE,
                            window=W), as_principal="")
    assert r.rows[0][-1] == pytest.approx(35.0)   # 999 is outside the window


async def test_sqlite_runs_through_the_async_path(sqlite_source):
    src, _ = sqlite_source
    assert src.is_async is True
    r = await src.run(Query(metric_id="revenue", dataset_id="sales", grain=TimeGrain.NONE,
                            window=W), as_principal="")
    assert r.rows[0][-1] == pytest.approx(35.0)


async def test_sqlite_buckets_by_day_without_date_trunc(sqlite_source):
    """The point of including SQLite: it has no DATE_TRUNC, so a grain interface
    that had quietly assumed Postgres would fail right here."""
    src, _ = sqlite_source
    r = await src.run(Query(metric_id="revenue", dataset_id="sales", grain=TimeGrain.DAY,
                            window=W), as_principal="")
    assert len(r.rows) == 2                       # two days inside the window
    assert sorted(v for _, v in ((row[0], row[-1]) for row in r.rows)) == [5.0, 30.0]


async def test_duckdb_and_sqlite_agree_on_the_same_question(duckdb_source, sqlite_source):
    """Two engines, two entirely different grain expressions, one answer. This is
    what the dialect layer is for."""
    d, _ = duckdb_source
    s, _ = sqlite_source
    q = Query(metric_id="revenue", dataset_id="sales", grain=TimeGrain.DAY, window=W)
    dr = await d.run(q, as_principal="")
    sr = await s.run(q, as_principal="")
    assert sorted(r[-1] for r in dr.rows) == sorted(r[-1] for r in sr.rows)


async def test_grouping_by_a_dimension_works_on_both(duckdb_source, sqlite_source):
    q = Query(metric_id="revenue", dataset_id="sales", grain=TimeGrain.NONE,
              window=W, dimensions=["region"])
    for src, _ in (duckdb_source, sqlite_source):
        r = await src.run(q, as_principal="")
        assert {row[0]: row[-1] for row in r.rows} == {"emea": 30.0, "amer": 5.0}


async def test_introspection_finds_the_table_and_its_time_column(duckdb_source):
    """The half SQLAlchemy solves outright — no dialect code of ours involved."""
    src, _ = duckdb_source
    src._dataset = DirectWarehouseSource._dataset.__get__(src)  # restore the real one
    found = [d for d in await src.datasets() if d.physical.endswith("sales")]
    assert found, "introspection found no sales table"
    ds = found[0]
    assert ds.time_column == "ts"
    assert {d.name for d in ds.dimensions} >= {"ts", "region", "amount"}


# ── what the dialect table claims, checked ─────────────────────────────


@pytest.mark.parametrize("name", sorted(SPECS))
def test_every_spec_covers_every_grain(name):
    """A missing grain silently falls back to the bare column, which is a wrong
    chart rather than an error — so absence is checked rather than trusted."""
    spec = SPECS[name]
    for g in TimeGrain:
        if g is TimeGrain.NONE:
            assert spec.bucket(g, "ts") == "ts"
        else:
            assert spec.bucket(g, "ts") != "ts", f"{name} has no {g.value} grain"


@pytest.mark.parametrize("name", sorted(SPECS))
def test_engines_without_roles_do_not_claim_impersonation(name):
    """SQLite and DuckDB have no roles. Claiming otherwise would mark a panel as
    caller-scoped when it is running as whoever opened the connection."""
    if name in {"sqlite", "duckdb"}:
        assert SPECS[name].caps.impersonation is False


# ── datasets that carry no time column ──────────────────────────────────
# Dimension tables — memberships, relation types, a lookup of statuses. They are
# perfectly queryable and they broke, because the builder emitted the time
# predicate unconditionally and produced `WHERE None >= :start`. Found by
# sweeping every table on a real connection through the authoring preview: six
# of twenty-one came back 422.

def _timeless() -> Dataset:
    return Dataset(
        id="public.memberships", connection_id="c", physical="public.memberships",
        time_column=None, grains=[],
        dimensions=[Dimension("role", "role", ColKind.STRING)],
    )


def test_a_dataset_without_a_time_column_compiles():
    sql = build(SPECS["postgres"], _timeless(), Metric(
        id="m", version=1, space_id="pay", label="Rows", expr="COUNT(*)"),
        Query(metric_id="m", dataset_id="public.memberships", grain=TimeGrain.NONE)).sql
    assert "WHERE" not in sql, sql
    assert "None" not in sql, sql


def test_a_timeless_dataset_still_refuses_a_grain():
    """Losing the window must not also lose the rule that a grain needs a column
    to bucket on — otherwise this fix trades one silent wrong answer for another."""
    with pytest.raises(ValueError, match="no time column"):
        build(SPECS["postgres"], _timeless(), Metric(
            id="m", version=1, space_id="pay", label="Rows", expr="COUNT(*)"),
            Query(metric_id="m", dataset_id="public.memberships", grain=TimeGrain.DAY))


def test_a_dataset_with_a_time_column_cannot_skip_the_window():
    """The billing-incident guard, kept exactly where it can be enforced: a
    caller may not turn a bounded fact table into a full scan by omitting the
    window."""
    ds = Dataset(id="public.runs", connection_id="c", physical="public.runs",
                 time_column="started_at", grains=[TimeGrain.DAY],
                 dimensions=[Dimension("agent_id", "agent_id", ColKind.STRING)])
    with pytest.raises(ValueError, match="must carry a window"):
        build(SPECS["postgres"], ds, Metric(
            id="m", version=1, space_id="pay", label="Cost", expr="SUM(cost_usd)"),
            Query(metric_id="m", dataset_id="public.runs", grain=TimeGrain.DAY, window=None))


# ── identifier quoting ──────────────────────────────────────────────────
# Three comments in build.py claimed sqlglot transpiled the finished statement
# and handled quoting. It was never called: `grep -rn sqlglot commonindex/` returned
# only those comments. So a mixed-case table silently became lowercase and a
# column named after a keyword was a syntax error, both reported with no field.

def _awkward() -> Dataset:
    return Dataset(
        id="public.Orders", connection_id="c", physical="public.Orders",
        time_column="order", grains=[TimeGrain.DAY],
        dimensions=[Dimension("order", "order", ColKind.TIME),
                    Dimension("group", "group", ColKind.STRING)],
    )


@pytest.mark.parametrize("engine,expect", [
    ("postgres", '"public"."Orders"'),
    ("sqlite", '"public"."Orders"'),
    ("bigquery", "`public`.`Orders`"),
])
def test_identifiers_are_quoted_per_dialect(engine, expect):
    sql = build(SPECS[engine], _awkward(), Metric(
        id="m", version=1, space_id="pay", label="n", expr="COUNT(*)"),
        Query(metric_id="m", dataset_id="public.Orders", dimensions=["group"],
              grain=TimeGrain.DAY,
              window=Window(datetime(2026, 1, 1, tzinfo=UTC),
                            datetime(2026, 2, 1, tzinfo=UTC)))).sql
    assert expect in sql, sql
    # A dotted name is quoted part by part; quoting it whole names a table with
    # a dot in it, which is a different and non-existent table.
    assert '"public.Orders"' not in sql and "`public.Orders`" not in sql, sql


def test_a_keyword_column_survives_a_real_engine():
    """SQLite, because it actually runs here and `order` and `group` are
    reserved there too. An unquoted identifier is a syntax error, not a subtly
    wrong answer, so this fails loudly if the quoting regresses."""
    import sqlalchemy as sa

    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "t.db"
        eng = sa.create_engine(f"sqlite:///{path}")
        with eng.begin() as c:
            c.execute(sa.text('create table "Orders" ("order" text, "group" text)'))
            c.execute(sa.text('insert into "Orders" values (\'2026-01-05\', \'a\')'))

        ds = Dataset(id="Orders", connection_id="c", physical="Orders",
                     time_column="order", grains=[TimeGrain.DAY],
                     dimensions=[Dimension("order", "order", ColKind.TIME),
                                 Dimension("group", "group", ColKind.STRING)])
        c9 = build(SPECS["sqlite"], ds, Metric(
            id="m", version=1, space_id="pay", label="n", expr="COUNT(*)"),
            Query(metric_id="m", dataset_id="Orders", dimensions=["group"],
                  grain=TimeGrain.NONE,
                  window=Window(datetime(2026, 1, 1, tzinfo=UTC),
                                datetime(2026, 2, 1, tzinfo=UTC))))
        with eng.begin() as c:
            rows = c.execute(sa.text(c9.sql), c9.params).all()
        assert rows == [("a", 1)], rows


# ── virtual datasets ────────────────────────────────────────────────────
# The schema has carried `is_virtual` since migration 0002, with the comment
# "a physical table, or a saved query (a "virtual dataset")". The builder
# never read it, so `physical` was always quoted as an identifier and a saved
# query would have compiled to FROM "select ... from proposals".

def test_a_saved_query_becomes_a_subquery_not_an_identifier():
    ds = Dataset(
        id="sql.wait", connection_id="c", is_virtual=True,
        physical="SELECT author_id, decided_at - created_at AS wait FROM proposals",
        time_column=None,
        dimensions=[Dimension("author_id", "author_id", ColKind.STRING)])
    sql = build(SPECS["postgres"], ds, Metric(
        id="m", version=1, space_id="pay", label="n", expr="COUNT(*)"),
        Query(metric_id="m", dataset_id="sql.wait", dimensions=["author_id"],
              grain=TimeGrain.NONE)).sql
    assert "FROM (SELECT author_id" in sql, sql
    assert ") AS src" in sql, sql
    # The failure this guards against: the whole query quoted as a table name.
    assert '"SELECT' not in sql, sql


def test_a_saved_query_runs_on_a_real_engine():
    """SQLite again, because it executes here. Proves the subquery form is
    valid SQL and that the window and grouping apply to it like a table."""
    import sqlalchemy as sa

    with tempfile.TemporaryDirectory() as d:
        eng = sa.create_engine(f"sqlite:///{Path(d) / 't.db'}")
        with eng.begin() as c:
            c.execute(sa.text("create table runs (agent text, cost real, ok int)"))
            for row in [("a", 1.0, 1), ("a", 2.0, 0), ("b", 4.0, 1)]:
                c.execute(sa.text("insert into runs values (:a,:c,:o)"),
                          {"a": row[0], "c": row[1], "o": row[2]})

        ds = Dataset(id="sql.ok", connection_id="c", is_virtual=True,
                     physical="SELECT agent, cost FROM runs WHERE ok = 1",
                     time_column=None,
                     dimensions=[Dimension("agent", "agent", ColKind.STRING),
                                 Dimension("cost", "cost", ColKind.NUMBER)])
        c9 = build(SPECS["sqlite"], ds, Metric(
            id="m", version=1, space_id="pay", label="spend", expr="SUM(cost)"),
            Query(metric_id="m", dataset_id="sql.ok", dimensions=["agent"],
                  grain=TimeGrain.NONE, order="value_desc"))
        with eng.begin() as c:
            rows = c.execute(sa.text(c9.sql), c9.params).all()
        # Only the ok=1 rows: b=4.0 then a=1.0, ranked by the measure.
        assert rows == [("b", 4.0), ("a", 1.0)], rows


@pytest.mark.parametrize("sql,ok", [
    ("select a from t", True),
    ("with x as (select 1) select * from x", True),
    ("select 1; drop table t", False),
    ("drop table t", False),
    ("insert into t values (1)", False),
    ("update t set a = 1", False),
    ("delete from t", False),
    ("select * from t -- ; drop table x", True),
])
def test_only_one_select_is_accepted(sql, ok):
    """The guard in front of a saved query.

    Not the security boundary — the connection user holds SELECT and nothing
    else, and that grant is what actually refuses a DROP. This exists so the
    author is told at save time, and so a second statement hidden behind a
    comment never reaches a connection whose grants might be wider than they
    should be.
    """
    from commonindex.gateway.authoring import BadSQL, check_sql

    if ok:
        assert check_sql(sql, "postgres")
    else:
        with pytest.raises(BadSQL):
            check_sql(sql, "postgres")


async def test_a_day_is_the_day_the_warehouse_counted_in_its_own_time_zone():
    """A Kolkata warehouse truncates to Kolkata midnight, and a timestamp with a
    time zone reaches Python in UTC — 18:30 on the day before. Charts named
    every day a day early. The bucket is now the warehouse's own calendar date."""
    pytest.importorskip("asyncpg")
    from db import DSN
    from sqlalchemy.ext.asyncio import create_async_engine

    url = DSN.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(url, connect_args={"server_settings": {"timezone": "Asia/Kolkata"}})
    try:
        async with engine.begin() as c:
            await c.execute(sa.text("drop table if exists tz_sales"))
            await c.execute(sa.text("create table tz_sales (ts timestamptz, region text, amount float8)"))
            # 01:30 on the 21st in Kolkata; 20:00 on the 20th in UTC.
            await c.execute(sa.text("insert into tz_sales values ('2026-08-20T20:00:00Z', 'apac', 7)"))
    except Exception as e:  # noqa: BLE001
        await engine.dispose()
        pytest.skip(f"no database at {DSN}: {e}")
    try:
        src = make_source("postgres", url, "tz_sales")
        src._engine = engine
        r = await src.run(Query(metric_id="revenue", dataset_id="tz_sales", grain=TimeGrain.DAY,
                                window=W), as_principal="")
        assert [tuple(row) for row in r.rows] == [(date(2026, 8, 21), 7.0)]
    finally:
        async with engine.begin() as c:
            await c.execute(sa.text("drop table if exists tz_sales"))
        await engine.dispose()
