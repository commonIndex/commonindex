"""The same experiment, read out on every engine we can actually run.

Dashboards had cross-engine tests from the start; the readout never did. It ran
on SQLite in `test_srm.py` and on Postgres by hand, and everything else was
assumed — which is how `LEAST` stayed in the cap for months with a comment
claiming it was "in every dialect here". SQLite has no LEAST at all, so
winsorization errored with "no such function", and no test used a cap.

Two kinds of check:

  - EXECUTED, on every engine with a local driver. Identical rows in, identical
    summary statistics out. A dialect difference that changes a number is the
    one that matters, and it can only be caught by running.
  - COMPILED, for BigQuery and Snowflake. No driver here and no credentials in
    CI, but the emitted SQL can still be parsed back in the target dialect,
    which catches a Postgres-ism reaching a warehouse nobody can test against.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from commonindex.core.warehouse import ColKind, Dataset, Dimension, Window
from commonindex.core.warehouse.dialects import SPECS
from commonindex.core.warehouse.readout import Spec, build, counts

sa = pytest.importorskip("sqlalchemy")
pytestmark = pytest.mark.integration

NOW = datetime(2026, 8, 22, tzinfo=UTC)
W = Window(NOW - timedelta(days=30), NOW)

#: Two arms, two rows for one user, one row outside the window, one null
#: outcome. Small enough to reason about by hand and shaped to exercise every
#: branch the compiler has: the per-unit collapse, the cap, the null, the
#: window bound.
ROWS = [
    ("2026-08-20 10:00:00", "u1", "control", 10.0),
    ("2026-08-20 11:00:00", "u1", "control", 15.0),   # same unit, second row
    ("2026-08-20 12:00:00", "u2", "control", None),   # null outcome
    ("2026-08-21 09:00:00", "u3", "variant", 900.0),  # above any cap
    ("2026-08-21 10:00:00", "u4", "variant", 40.0),
    ("2025-01-01 09:00:00", "u5", "variant", 5.0),    # outside the window
]

DS = Dataset(
    id="exposures", connection_id="c1", physical="exposures", time_column="ts",
    dimensions=[Dimension("arm", "arm", ColKind.STRING),
                Dimension("user", "user_id", ColKind.STRING),
                Dimension("rev", "revenue", ColKind.NUMBER)])


async def seed(engine, table: str = "exposures") -> None:
    # timestamptz on Postgres, matching the real exposure tables and the
    # timezone-aware window every query carries. A naive column makes asyncpg
    # refuse the bind outright — "can't subtract offset-naive and offset-aware".
    col = "timestamptz" if is_async(engine) else "timestamp"
    await execute(engine, f"create table {table} (ts {col}, user_id varchar,"
                          f" arm varchar, revenue double precision)")
    for ts, uid, arm, rev in ROWS:
        await execute(engine, f"insert into {table} values (:ts,:u,:a,:r)",
                      {"ts": _ts(engine, ts), "u": uid, "a": arm, "r": rev})


def _ts(engine, s: str):
    """asyncpg binds a datetime, not a string — and an aware one, to match the
    column and the window."""
    return datetime.fromisoformat(s).replace(tzinfo=UTC) if is_async(engine) else s


def engines(tmp_path) -> dict[str, object]:
    """Every engine with a driver on this machine.

    Postgres goes over asyncpg, because that is the only Postgres driver this
    project has and the one the gateway itself uses — reaching for psycopg2
    here would test a path the application never takes, and add a dependency
    to do it.
    """
    out: dict[str, object] = {
        "sqlite": sa.create_engine(f"sqlite:///{tmp_path/'w.sqlite'}"),
    }
    try:
        import duckdb_engine  # noqa: F401
        out["duckdb"] = sa.create_engine(f"duckdb:///{tmp_path/'w.duckdb'}")
    except ImportError:
        pass

    dsn = os.environ.get("COMMONINDEX_TEST_DSN", "postgresql://localhost/commonindex_test")
    try:
        import asyncpg  # noqa: F401
        from sqlalchemy.ext.asyncio import create_async_engine

        out["postgres"] = create_async_engine(
            dsn.replace("postgresql://", "postgresql+asyncpg://"))
    except ImportError:
        pass
    return out


def is_async(engine) -> bool:
    return type(engine).__name__.startswith("AsyncEngine")


async def execute(engine, sql: str, params: dict | None = None) -> list[dict]:
    """One call for both driver shapes, so every test below reads the same
    whether the engine underneath it is sync or async."""
    if is_async(engine):
        async with engine.begin() as c:
            res = await c.execute(sa.text(sql), params or {})
            return [dict(r) for r in res.mappings().all()] if res.returns_rows else []
    with engine.begin() as c:
        res = c.execute(sa.text(sql), params or {})
        return [dict(r) for r in res.mappings().all()] if res.returns_rows else []


@pytest.fixture
async def ready(tmp_path):
    es = engines(tmp_path)
    made = {}
    for name, e in es.items():
        # A uniquely named table on the shared Postgres, dropped after: the
        # integration database is not this test's to reset.
        table = "exposures" if name != "postgres" else f"exp_dialect_{os.getpid()}"
        try:
            if name == "postgres":
                await execute(e, f"drop table if exists {table}")
            await seed(e, table)
        except Exception as exc:  # noqa: BLE001 - an unreachable engine is not a failure
            # Reported rather than swallowed: an engine that quietly drops out
            # turns a cross-engine test into a single-engine one, which is the
            # failure mode this whole file exists to prevent.
            print(f"skipping {name}: {exc}")
            continue
        made[name] = (e, table)
    yield made
    for name, (e, table) in made.items():
        if name == "postgres":
            await execute(e, f"drop table if exists {table}")
        if is_async(e):
            await e.dispose()
        else:
            e.dispose()


async def run(engine, compiled) -> list[dict]:
    return await execute(engine, compiled.sql, compiled.params)


def spec(**kw) -> Spec:
    base = {"dataset_id": "exposures", "variation": "arm", "outcome": "rev",
            "binary": False, "unit": "user", "unit_agg": "sum", "window": W}
    return Spec(**{**base, **kw})


def dataset_for(table: str) -> Dataset:
    from dataclasses import replace
    return replace(DS, physical=table)


# ── the same question, every engine ─────────────────────────────────────


async def test_at_least_two_engines_are_actually_being_compared(ready):
    """A cross-engine test that silently runs on one engine proves nothing."""
    assert len(ready) >= 2, f"only {list(ready)} available"


async def test_every_engine_returns_the_same_summary_statistics(ready):
    """The readout is (n, Σx, Σx²) per arm. If two engines disagree about
    those, they disagree about the lift and the interval built on them."""
    seen = {}
    for name, (engine, table) in ready.items():
        rows = await run(engine, build(SPECS[name], dataset_for(table), spec()))
        seen[name] = {r["variation"]: (int(r["n"]), float(r["total"]),
                                       round(float(r["sum_sq"]), 6)) for r in rows}

    first = next(iter(seen))
    for other, rows in seen.items():
        assert rows == seen[first], (
            f"{other} and {first} disagree:\n  {other}: {rows}\n  {first}: {seen[first]}")

    # And the values are the ones worked out by hand: u1's two rows collapse to
    # 25, u2's null becomes 0, u5 is outside the window.
    assert seen[first]["control"] == (2, 25.0, 625.0)
    assert seen[first]["variant"] == (2, 940.0, 811600.0)


async def test_capping_works_on_every_engine(ready):
    """The branch that was broken. SQLite has no LEAST, so this errored with
    "no such function" rather than returning a wrong number — invisible until
    somebody registered a cap."""
    for name, (engine, table) in ready.items():
        rows = await run(engine, build(SPECS[name], dataset_for(table), spec(cap=100.0)))
        by = {r["variation"]: float(r["total"]) for r in rows}
        # u3's 900 is capped to 100, so variant totals 140 rather than 940.
        assert by["variant"] == 140.0, f"{name} capped to {by['variant']}"
        assert by["control"] == 25.0, name


async def test_a_null_outcome_counts_as_zero_or_not_on_every_engine(ready):
    for name, (engine, table) in ready.items():
        ds = dataset_for(table)
        zero = await run(engine, build(SPECS[name], ds, spec(null_is_zero=True)))
        keep = await run(engine, build(SPECS[name], ds, spec(null_is_zero=False)))
        # u2 has no revenue. Imputed it is a third control unit at 0; left
        # alone it still counts as a unit, with a null that SUM skips.
        assert {r["variation"]: int(r["n"]) for r in zero}["control"] == 2, name
        assert {r["variation"]: int(r["n"]) for r in keep}["control"] == 2, name


@pytest.mark.parametrize("agg,expected", [("sum", 25.0), ("max", 15.0),
                                          ("min", 10.0), ("avg", 12.5)])
async def test_every_unit_agg_agrees_across_engines(ready, agg, expected):
    """u1 has two rows, 10 and 15 — the only unit where the collapse is
    visible."""
    for name, (engine, table) in ready.items():
        rows = await run(engine, build(SPECS[name], dataset_for(table), spec(unit_agg=agg)))
        by = {r["variation"]: float(r["total"]) for r in rows}
        # control is u1 (collapsed) plus u2 (null -> 0).
        assert by["control"] == pytest.approx(expected), f"{name}/{agg}"


async def test_the_assignment_count_agrees_across_engines(ready):
    """`counts` feeds the sample-ratio check, and a dialect that counted rows
    where another counted units would fail it on one engine and pass on the
    other for the same data."""
    for name, (engine, table) in ready.items():
        rows = await run(engine, counts(SPECS[name], dataset_for(table), "arm",
                                  unit="user", window=W))
        by = {r["variation"]: int(r["n"]) for r in rows}
        assert by == {"control": 2, "variant": 2}, name

        # Without a unit it counts rows, everywhere.
        rows = await run(engine, counts(SPECS[name], dataset_for(table), "arm", window=W))
        assert {r["variation"]: int(r["n"]) for r in rows} == {"control": 3, "variant": 2}, name


async def test_a_binary_outcome_needs_no_second_moment_on_any_engine(ready):
    for name, (engine, table) in ready.items():
        rows = await run(engine, build(SPECS[name], dataset_for(table), spec(binary=True)))
        assert "sum_sq" not in rows[0], f"{name} asked for a second moment"


# ── the engines we cannot run ───────────────────────────────────────────


@pytest.mark.parametrize("engine", ["bigquery", "snowflake"])
@pytest.mark.parametrize("kw", [{}, {"cap": 100.0}, {"binary": True},
                                {"unit": None}, {"unit_agg": "avg"}])
def test_the_untestable_engines_still_emit_parseable_sql(engine, kw):
    """No driver here and no credentials in CI, so this cannot execute. It can
    still parse the emitted SQL back in the target dialect, which is what
    catches a Postgres-ism reaching a warehouse nobody can try."""
    import sqlglot

    compiled = build(SPECS[engine], DS, spec(**kw))
    parsed = sqlglot.parse(compiled.sql, dialect=SPECS[engine].sqlglot_dialect)
    assert len(parsed) == 1 and parsed[0] is not None


@pytest.mark.parametrize("engine", ["bigquery", "snowflake", "postgres", "duckdb", "sqlite"])
def test_the_cap_is_spelled_the_way_each_engine_spells_it(engine):
    """LEAST is not universal — SQLite has no such function — and the comment
    that said it was is why this went unnoticed."""
    sql = build(SPECS[engine], DS, spec(cap=100.0)).sql
    if engine == "sqlite":
        assert "MIN(" in sql and "LEAST(" not in sql
    else:
        assert "LEAST(" in sql


@pytest.mark.parametrize("engine,quote", [("bigquery", "`arm`"), ("snowflake", '"arm"'),
                                          ("postgres", '"arm"'), ("sqlite", '"arm"')])
def test_identifiers_are_quoted_the_way_each_engine_quotes_them(engine, quote):
    assert quote in build(SPECS[engine], DS, spec()).sql


# ── connecting to more than one kind of database ────────────────────────


@pytest.mark.parametrize("kind,dsn,want_async", [
    ("postgres",  "postgresql+asyncpg://localhost/x", True),
    ("sqlite",    "sqlite+aiosqlite:///:memory:",     True),
    ("duckdb",    "duckdb:///:memory:",               False),
    ("bigquery",  "bigquery://project/dataset",       False),
    ("snowflake", "snowflake://u:p@acct/db/schema",   False),
])
def test_the_engine_built_matches_the_driver(kind, dsn, want_async, monkeypatch):
    """`_engine` built an async engine for every connection while only Postgres
    and SQLite have async drivers, so creating a DuckDB, BigQuery or Snowflake
    connection failed at the probe with "the asyncio extension requires an
    async driver". Five engines were offered by the schema, the operation and
    the UI, and two of them worked.

    This asserts what `_make_engine` RETURNS. The version before it compared
    `kind in ASYNC_DRIVERS` to the expected flag, which restates the constant
    and would have passed just as happily against the broken code.
    """
    from commonindex.gateway.authoring import _make_engine

    if kind == "bigquery":
        # With the bigquery extra installed, its dialect looks up Google
        # credentials as the engine is built, and a test machine has none.
        try:
            import google.auth
            from google.auth.credentials import AnonymousCredentials
        except ImportError:
            pass
        else:
            monkeypatch.setattr(google.auth, "default", lambda *a, **k: (AnonymousCredentials(), "project"))
    try:
        e = _make_engine(dsn, kind)
    except (ModuleNotFoundError, sa.exc.NoSuchModuleError) as exc:
        # SQLAlchemy raises its own NoSuchModuleError for a dialect it cannot
        # load, which is not a ModuleNotFoundError — so catching only the
        # latter turned "BigQuery is not installed here" into a red test.
        pytest.skip(f"no driver for {kind}: {exc}")
    try:
        assert type(e).__name__.startswith("Async") is want_async
    finally:
        if not want_async:
            e.dispose()


def test_a_sync_engine_is_built_for_a_sync_driver(tmp_path):
    from commonindex.gateway.authoring import _make_engine

    e = _make_engine(f"duckdb:///{tmp_path/'x.duckdb'}", "duckdb")
    try:
        assert not type(e).__name__.startswith("Async")
        with e.connect() as c:
            assert c.execute(sa.text("select 1")).scalar() == 1
    finally:
        e.dispose()


def test_an_async_engine_is_built_for_an_async_driver(tmp_path):
    pytest.importorskip("aiosqlite")
    from commonindex.gateway.authoring import _make_engine

    e = _make_engine(f"sqlite+aiosqlite:///{tmp_path/'x.sqlite'}", "sqlite")
    assert type(e).__name__.startswith("Async")


async def test_the_probe_works_on_both_driver_shapes(tmp_path):
    """It ran `async with engine.connect()` unconditionally, and then disposed
    with `await engine.dispose()` — which returns None on a sync engine, so
    even a successful sync probe raised from the `finally`."""
    pytest.importorskip("aiosqlite")
    import duckdb

    from commonindex.gateway.authoring import _probe

    # A database that EXISTS, because a read-only connection is now probed
    # read-only and will not conjure one. See the test below for why.
    duckdb.connect(str(tmp_path / "a.duckdb")).close()
    ok, detail = await _probe(f"duckdb:///{tmp_path/'a.duckdb'}", None, "duckdb")
    assert ok, detail

    # sqlite's async driver, for the other branch of the same function.
    (tmp_path / "a.sqlite").touch()
    ok, detail = await _probe(f"sqlite+aiosqlite:///{tmp_path/'a.sqlite'}", None, "sqlite")
    assert ok, detail


async def test_a_read_only_file_database_is_not_created_by_checking_it(tmp_path):
    """`direct.py` says read-only is enforced at the warehouse and that
    `Connection.read_only` is documentation — right for anything with a server
    to hold the grant, and there is no server here. The file IS the database,
    so how it is opened is the only control there is.

    Left read-write, DuckDB and SQLite CREATE a database at a path that does
    not exist. A typo'd path became an empty warehouse, `connections.check`
    went green against the database it had just made, and every panel then
    failed with "table does not exist" — the connection page saying the
    connection was fine the whole time.
    """
    from commonindex.gateway.authoring import _probe

    missing = tmp_path / "typo.duckdb"
    ok, detail = await _probe(f"duckdb:///{missing}", None, "duckdb", read_only=True)
    assert ok is False
    assert "does not exist" in detail
    assert not missing.exists(), "checking a connection created the database"


async def test_a_writable_file_database_may_still_be_created(tmp_path):
    """The guard is tied to the connection's own declaration, not to the
    engine: a connection someone deliberately marked writable behaves as it
    always did."""
    from commonindex.gateway.authoring import _probe

    made = tmp_path / "scratch.duckdb"
    ok, detail = await _probe(f"duckdb:///{made}", None, "duckdb", read_only=False)
    assert ok, detail
    assert made.exists()


async def test_the_probe_still_reports_a_failure_rather_than_raising(tmp_path):
    from commonindex.gateway.authoring import _probe

    ok, detail = await _probe("duckdb:////nonexistent/dir/x.duckdb", None, "duckdb")
    assert ok is False and detail


# ── engines added by naming a dialect ───────────────────────────────────

ADDED = ["mysql", "mariadb", "redshift", "clickhouse", "databricks", "trino", "mssql"]


@pytest.mark.parametrize("engine", ADDED)
@pytest.mark.parametrize("kw", [{}, {"cap": 100.0}, {"binary": True},
                                {"unit": None}, {"unit_agg": "avg"}])
def test_an_added_engine_emits_sql_its_own_parser_accepts(engine, kw):
    """What is actually claimed for these. None has been run against a live
    server here, so the assertion is that the compiler emits SQL the target
    dialect parses — not that a connection works."""
    import sqlglot

    compiled = build(SPECS[engine], DS, spec(**kw))
    parsed = sqlglot.parse(compiled.sql, dialect=SPECS[engine].sqlglot_dialect)
    assert len(parsed) == 1 and parsed[0] is not None


@pytest.mark.parametrize("engine", ADDED)
def test_an_added_engine_truncates_the_way_its_own_dialect_does(engine):
    """The grains come from sqlglot rather than from someone's memory, which is
    the lesson LEAST taught. MySQL is the case that proves it needed learning:
    it has no DATE_TRUNC, and the correct form is a DATE_ADD over a
    TIMESTAMPDIFF that nobody would write by hand."""
    from commonindex.core.warehouse import TimeGrain

    day = SPECS[engine].grains[TimeGrain.DAY].format(col='"ts"')
    assert "{col}" not in day
    if engine in ("mysql", "mariadb"):
        assert "DATE_TRUNC" not in day, "MySQL has no DATE_TRUNC"
        assert "TIMESTAMPDIFF" in day
    elif engine == "clickhouse":
        assert "dateTrunc" in day       # ClickHouse is case-sensitive here
    elif engine == "mssql":
        assert "DATETRUNC" in day       # no underscore
    else:
        assert "DATE_TRUNC" in day


@pytest.mark.parametrize("engine", ADDED)
def test_an_added_engine_has_a_driver_named_for_it(engine):
    """A dialect the compiler can emit and no driver to open is a kind the UI
    offers and the gateway cannot use. Naming the driver does not install it —
    that is a deployment question — but the mapping has to exist."""
    from commonindex.gateway.authoring import _DRIVERS

    assert engine in _DRIVERS


def test_every_offered_kind_has_a_spec_and_a_driver():
    """The three lists — what the operation offers, what the compiler can emit,
    and what a connection can be opened with — drift apart quietly otherwise."""
    from commonindex.gateway.app import REGISTRY
    from commonindex.gateway.authoring import _DRIVERS

    offered = set(REGISTRY.get("connections.create").input_schema["properties"]["kind"]["enum"])
    assert offered <= set(SPECS), f"offered with no spec: {sorted(offered - set(SPECS))}"
    assert offered <= set(_DRIVERS), f"offered with no driver: {sorted(offered - set(_DRIVERS))}"


@pytest.mark.parametrize("engine", ADDED)
def test_an_added_engine_is_not_claimed_to_be_async(engine):
    """Only Postgres and SQLite have async drivers here. Claiming otherwise is
    what broke DuckDB, BigQuery and Snowflake at the probe."""
    from commonindex.core.warehouse.dialects import ASYNC_DRIVERS

    assert engine not in ASYNC_DRIVERS


# ── a value the author typed, rendered into a stored definition ─────────────


def test_a_literal_is_escaped_for_the_dialect_it_will_run_on():
    """`_literal` called `.sql()` with no dialect, three lines under a
    docstring saying sqlglot "escapes for the target dialect".

    With no dialect it renders in sqlglot's own, which doubles a quote. That is
    correct for Postgres, DuckDB, SQLite, Trino and T-SQL, and an injection on
    every engine that treats a backslash as an escape — the value below closed
    the literal early and the rest became code, in an expression STORED as a
    metric definition and re-run for every viewer.
    """
    import sqlglot

    from commonindex.gateway.authoring import _literal

    hostile = "x\\' OR 1=1 -- "
    # Driven off the spec table, so a dialect added later is covered the day it
    # is added rather than the day somebody remembers this list.
    for dialect in sorted({s.sqlglot_dialect for s in SPECS.values()}):
        stmt = (f"SELECT AVG(CASE WHEN arm = {_literal(hostile, dialect)}"
                " THEN 1.0 ELSE 0.0 END) FROM t")
        parsed = sqlglot.parse(stmt, read=dialect)
        assert len(parsed) == 1, f"{dialect}: {stmt}"
        # The value stayed a value: nothing outside the literal became syntax.
        assert "OR 1=1" not in parsed[0].sql(dialect=dialect).replace(
            _literal(hostile, dialect), ""), dialect


APOSTROPHE = "Women" + chr(39) + "s"


def test_an_apostrophe_survives_on_every_engine():
    """The benign version of the same bug, and the commoner one: `Women's`
    rendered as `''` and BigQuery rejects adjacent string literals."""
    import sqlglot

    from commonindex.gateway.authoring import _literal

    for dialect in sorted({s.sqlglot_dialect for s in SPECS.values()}):
        stmt = "SELECT " + _literal(APOSTROPHE, dialect) + " AS x"
        assert sqlglot.parse_one(stmt, read=dialect).sql(dialect=dialect), dialect


# ── statements that have to parse on the engine they are sent to ────────────


def _parses(stmt: str, dialect: str) -> bool:
    import sqlglot

    try:
        sqlglot.parse_one(stmt, read=dialect)
        return True
    except Exception:  # noqa: BLE001 - a tokenizer error is the answer
        return False


def test_a_like_filter_parses_on_every_engine():
    """`ESCAPE '\\'` is an unterminated literal on more than half of these.

    A backslash inside a string literal is itself an escape on MySQL, MariaDB,
    BigQuery, Snowflake, Redshift, ClickHouse and Databricks, so the escape
    character escaped its own closing quote and the literal swallowed the rest
    of the statement. Any `contains` or `starts_with` filter — both offered by
    the dashboard filter bar — on any of those eight engines.
    """
    from commonindex.core.warehouse.build import ESCAPE

    assert ESCAPE != "\\", "the whole point"
    stmt = f"SELECT a FROM t WHERE c LIKE '%x%' ESCAPE '{ESCAPE}'"
    for dialect in sorted({s.sqlglot_dialect for s in SPECS.values()}):
        assert _parses(stmt, dialect), f"{dialect}: {stmt}"


def test_a_row_limit_parses_on_every_engine():
    """T-SQL has no LIMIT; the bound is `SELECT TOP n`."""
    for name, spec in SPECS.items():
        stmt = spec.limit("SELECT a FROM t", 10)
        assert _parses(stmt, spec.sqlglot_dialect), f"{name}: {stmt}"


def test_the_session_preamble_parses_on_every_engine():
    """One hard-coded `SET LOCAL statement_timeout` — Postgres syntax — was
    emitted for every engine whose `caps.impersonation` was true, in the same
    transaction as the query. BigQuery, Snowflake, Trino and MSSQL have no such
    statement, so the panel died before its SQL was sent."""
    from commonindex.core.warehouse.sources.direct import DirectWarehouseSource

    class _Conn:
        impersonation = True

    for name, spec in SPECS.items():
        src = DirectWarehouseSource.__new__(DirectWarehouseSource)
        src._spec, src._conn = spec, _Conn()
        for stmt in DirectWarehouseSource._session_setup(src, "alice"):
            assert _parses(stmt, spec.sqlglot_dialect), f"{name}: {stmt}"


def test_an_engine_with_no_in_band_timeout_sends_no_timeout_statement():
    """Rather than sending one that does not parse. BigQuery bounds a job
    through its API, Databricks has no session statement, T-SQL's is a client
    setting — none of them is a statement this can emit, and saying so is
    better than emitting Postgres at them."""
    from commonindex.core.warehouse.dialects import TIMEOUTS

    for dialect in ("bigquery", "databricks", "tsql", "duckdb", "sqlite"):
        assert dialect not in TIMEOUTS


def test_only_engines_that_can_switch_role_in_sql_are_asked_to():
    """`SET LOCAL ROLE` is Postgres and Redshift. Snowflake, BigQuery and Trino
    impersonate outside the SQL session, and emitting a statement at them was
    the same mistake as the timeout."""
    from commonindex.core.warehouse.dialects import ROLES

    assert set(ROLES) == {"postgres", "redshift"}


# ── the type names each driver actually reports ─────────────────────────────


def test_each_engine_recognises_its_own_spelling_of_a_float():
    """Postgres spells it `double precision` and DuckDB spells the same thing
    `DOUBLE`. Only the first was in the table, so every DuckDB float came back
    a STRING — which is both halves of the mistake at once: a string column is
    not offered as a measure in the panel builder, and IS offered as a slicer
    in the filter picker.
    """
    from commonindex.core.warehouse import ColKind

    spellings = {
        "duckdb": "DOUBLE", "mysql": "double", "mariadb": "double",
        "snowflake": "FLOAT", "bigquery": "FLOAT64", "postgres": "double precision",
        "redshift": "double precision", "clickhouse": "Float64",
        "databricks": "double", "trino": "double", "mssql": "float",
        "sqlite": "REAL",
    }
    for engine, native in spellings.items():
        assert SPECS[engine].kind_of(native) is ColKind.NUMBER, f"{engine}: {native}"


def test_each_engine_recognises_its_own_spelling_of_a_timestamp():
    """A column not recognised as temporal cannot be a dataset's time column,
    so the table gets no time axis and every panel on it loses its grain."""
    from commonindex.core.warehouse import ColKind

    spellings = {
        "postgres": "timestamptz", "duckdb": "TIMESTAMP", "mysql": "datetime",
        "snowflake": "TIMESTAMP_NTZ", "bigquery": "TIMESTAMP", "mssql": "datetime2",
        "clickhouse": "DateTime64", "databricks": "timestamp", "trino": "timestamp",
        "redshift": "timestamp", "sqlite": "DATETIME",
    }
    for engine, native in spellings.items():
        assert SPECS[engine].kind_of(native) is ColKind.TIME, f"{engine}: {native}"


def test_an_integer_is_a_number_on_every_engine():
    from commonindex.core.warehouse import ColKind

    for engine, native in {"mssql": "int", "mysql": "tinyint", "duckdb": "BIGINT",
                           "clickhouse": "UInt32", "snowflake": "NUMBER",
                           "postgres": "int4", "bigquery": "INT64"}.items():
        assert SPECS[engine].kind_of(native) is ColKind.NUMBER, f"{engine}: {native}"
