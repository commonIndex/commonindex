"""The residue SQLAlchemy does not cover.

BI tools keep a per-engine spec directory of 50+ files *despite* SQLAlchemy,
because SQLAlchemy gives you connection, pooling, introspection and basic SQL
emission — and not time grains, analytics type mappings, capability flags or
error mapping. That residue is this module, and it is small.

Everything else — opening connections, discovering schemas, quoting, qualifying,
rendering literals, LIMIT — comes from SQLAlchemy and sqlglot. The Go version had
to hand-write all of it per warehouse; this is the concrete payoff of the
language decision.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import cache

from . import Capabilities, ColKind, TimeGrain

#: Grains a calendar names. Their buckets come back as the warehouse's own
#: calendar DATE, finer ones as its wall-clock time. A truncated timestamp with
#: a time zone reaches Python in UTC, so a day the warehouse counted in Kolkata
#: arrived as 18:30 on the day before — and every chart, export and answer
#: named each day one day early. Cast in the warehouse, a day is the day it
#: counted, in the time zone it counted it in.
CALENDAR = frozenset({TimeGrain.DAY, TimeGrain.WEEK, TimeGrain.MONTH, TimeGrain.QUARTER,
                      TimeGrain.YEAR})


@cache
def _cast(dialect: str, to: str) -> str:
    """``CAST({x} AS <to>)`` the way this engine spells it — BigQuery's local
    time is a DATETIME, SQL Server's a DATETIME2."""
    import sqlglot

    rendered = sqlglot.transpile(f"SELECT CAST(__x__ AS {to})", read="postgres",
                                 write=dialect or "postgres")[0]
    return rendered[len("SELECT "):].replace("__x__", "{x}")


@dataclass(frozen=True, slots=True)
class EngineSpec:
    """One per warehouse. Four fields, where Go needed nine methods."""

    name: str

    #: The single biggest difference between warehouses, and the most
    #: basic thing a spec must support. ``{col}`` is
    #: substituted; a missing grain falls back to the bare column.
    grains: dict[TimeGrain, str]

    #: Native type name -> generic kind, for introspection results.
    types: dict[str, ColKind]

    caps: Capabilities

    #: Rendered by sqlglot, so only the dialect NAME is needed here.
    sqlglot_dialect: str = ""

    #: How this engine is told to stop after N seconds, or None where it has no
    #: in-band way to be told.
    #:
    #: This was one hard-coded line — `SET LOCAL statement_timeout` — emitted
    #: for every engine whose `caps.impersonation` was true. That is Postgres
    #: syntax. BigQuery, Snowflake, Trino and MSSQL have no such statement, and
    #: the preamble runs in the SAME transaction as the query, so on those four
    #: every panel died before its SQL was sent. Meanwhile MySQL, MariaDB,
    #: ClickHouse and Databricks — which mostly DO have a timeout — got none,
    #: because they do not impersonate. Two unrelated capabilities were being
    #: read off one flag.
    timeout_sql: Callable[[int], str] | None = None

    #: How a session becomes the calling user, or None where it cannot.
    role_sql: Callable[[str], str] | None = None

    #: Whether a truncated bucket is cast to the warehouse's calendar date or
    #: wall-clock time. False where the grains already return text, as SQLite's
    #: do.
    local_buckets: bool = True

    def bucket(self, grain: TimeGrain, col: str) -> str:
        expr = self.grains.get(grain)
        if expr is None:
            return col
        truncated = expr.format(col=col)
        if not self.local_buckets:
            return truncated
        return _cast(self.sqlglot_dialect, "DATE" if grain in CALENDAR else "TIMESTAMP").replace(
            "{x}", truncated)

    def kind_of(self, native: str) -> ColKind:
        return self.types.get(native.lower(), ColKind.STRING)

    def limit(self, sql: str, n: int) -> str:
        """Bound the rows returned.

        A suffix on almost every engine and a SELECT-clause keyword on T-SQL,
        which has no LIMIT at all. Appending ` LIMIT n` regardless made every
        limited panel, every SQL preview and every inline-SQL panel a syntax
        error on MSSQL.
        """
        if self.sqlglot_dialect == "tsql":
            head, _, rest = sql.partition("SELECT ")
            return f"{head}SELECT TOP {n} {rest}"
        return f"{sql} LIMIT {n}"


# Native type NAMES, as each driver reports them. Postgres spells a float
# `double precision` and DuckDB spells the same thing `DOUBLE`, and only the
# first was here — so every DuckDB float came back as a STRING. A column typed
# string is not offered as a measure in the panel builder and IS offered as a
# slicer in the filter picker, which is both halves of the mistake at once.
#
# Twelve engines were added by naming them, and this is the table that most
# needed widening when they were.
_TIME = ["timestamp", "timestamptz", "date", "time", "datetime",
         "timestamp with time zone", "timestamp without time zone",
         # T-SQL, Snowflake, ClickHouse, Databricks, BigQuery.
         "datetime2", "smalldatetime", "datetimeoffset",
         "timestamp_ntz", "timestamp_ltz", "timestamp_tz",
         "date32", "datetime64", "timestamp_micros"]
_NUM = ["int2", "int4", "int8", "integer", "bigint", "numeric", "float4",
        "float8", "real", "double precision", "int64", "float64", "bignumeric",
        # The spellings the other eleven engines use for the same things.
        "double", "float", "decimal", "dec", "fixed", "number",
        "int", "smallint", "tinyint", "mediumint", "hugeint",
        "utinyint", "usmallint", "uinteger", "ubigint",
        "long", "short", "byte", "money", "smallmoney",
        "float32", "float64", "int16", "int32",
        "uint8", "uint16", "uint32", "uint64",
        "int128", "uint128", "numeric64"]
_BOOL = ["bool", "boolean", "bit", "bool_"]


#: A statement bounding how long the engine will run, per dialect.
#:
#: Written out rather than derived, because there is nothing to derive from:
#: each is a different statement with a different unit, and four engines have
#: none at all. Naming the absent ones is the point — an engine with no entry
#: here runs unbounded, which is a fact about the deployment rather than an
#: omission in this table.
TIMEOUTS: dict[str, Callable[[int], str]] = {
    # Seconds, as an interval string.
    "postgres": lambda s: f"SET LOCAL statement_timeout = '{s}s'",
    # Milliseconds, and no LOCAL.
    "redshift": lambda s: f"SET statement_timeout TO {s * 1000}",
    # Milliseconds, and SELECT only — which is all this ever sends.
    "mysql": lambda s: f"SET SESSION max_execution_time = {s * 1000}",
    "snowflake": lambda s: f"ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = {s}",
    "clickhouse": lambda s: f"SET max_execution_time = {s}",
    "trino": lambda s: f"SET SESSION query_max_run_time = '{s}s'",
    # bigquery   — bounded per job through the API, not in SQL.
    # databricks — no session statement.
    # tsql       — a client-side command timeout, not a statement.
    # duckdb / sqlite — in-process; there is no server to tell.
}

#: How a session becomes the calling user. Postgres and Redshift only: the
#: others that claim impersonation do it OUTSIDE the SQL session — Snowflake
#: with a secondary role on the connection, BigQuery with service-account
#: impersonation, Trino with a header — none of which this file can emit as a
#: statement.
ROLES: dict[str, Callable[[str], str]] = {
    "postgres": lambda ident: f'SET LOCAL ROLE "{ident}"',
    "redshift": lambda ident: f'SET SESSION AUTHORIZATION "{ident}"',
}



def _types(extra: list[str] | None = None) -> dict[str, ColKind]:
    m = {n: ColKind.TIME for n in _TIME}
    m |= {n: ColKind.NUMBER for n in _NUM}
    m |= {n: ColKind.BOOL for n in _BOOL}
    # SQLite stores everything as one of five storage classes, so its column
    # types carry less information than elsewhere; callers pass the extras they
    # want treated as numeric rather than string.
    for n in extra or []:
        m.setdefault(n, ColKind.NUMBER)
    return m


#: Postgres takes the truncation field as a STRING LITERAL.
POSTGRES = EngineSpec(
    name="postgres",
    sqlglot_dialect="postgres",
    grains={g: f"DATE_TRUNC('{g.value}', {{col}})" for g in TimeGrain if g is not TimeGrain.NONE},
    types=_types(),
    caps=Capabilities(cancel=True, impersonation=True),  # SET LOCAL ROLE
    timeout_sql=TIMEOUTS.get("postgres"),
    role_sql=ROLES.get("postgres"),
)

#: BigQuery takes it as a KEYWORD, and has three truncation functions chosen by
#: the column's type — TIMESTAMP_TRUNC, DATETIME_TRUNC, DATE_TRUNC. Picking the
#: wrong one is a type error, not a wrong answer, so the caller must pass the
#: declared column type. Modelled here as a separate spec per time type rather
#: than pretending one expression covers it.
BIGQUERY = EngineSpec(
    name="bigquery",
    sqlglot_dialect="bigquery",
    grains={g: f"TIMESTAMP_TRUNC({{col}}, {g.value.upper()})"
            for g in TimeGrain if g is not TimeGrain.NONE},
    types=_types(),
    #: BigQuery will not accept a SELECT alias in WHERE.
    caps=Capabilities(alias_in_select=False, cancel=True, impersonation=True),
    timeout_sql=TIMEOUTS.get("bigquery"),
    role_sql=ROLES.get("bigquery"),
)

BIGQUERY_DATE = EngineSpec(
    name="bigquery-date",
    sqlglot_dialect="bigquery",
    grains={g: f"DATE_TRUNC({{col}}, {g.value.upper()})"
            for g in TimeGrain if g is not TimeGrain.NONE},
    types=_types(),
    caps=BIGQUERY.caps,
)

SNOWFLAKE = EngineSpec(
    name="snowflake",
    sqlglot_dialect="snowflake",
    grains={g: f"DATE_TRUNC('{g.value.upper()}', {{col}})"
            for g in TimeGrain if g is not TimeGrain.NONE},
    types=_types(),
    caps=Capabilities(cancel=True, impersonation=True),  # secondary roles
    timeout_sql=TIMEOUTS.get("snowflake"),
    role_sql=ROLES.get("snowflake"),
)

#: DuckDB speaks Postgres-compatible syntax, so its grains match — but its
#: SQLAlchemy dialect is SYNC ONLY, which is the constraint that actually shapes
#: the execution path. So are BigQuery's and Snowflake's. Async dialects are the
#: minority among analytical warehouses, not the norm.
DUCKDB = EngineSpec(
    name="duckdb",
    sqlglot_dialect="duckdb",
    grains={g: f"DATE_TRUNC('{g.value}', {{col}})" for g in TimeGrain if g is not TimeGrain.NONE},
    types=_types(),
    caps=Capabilities(cancel=False, impersonation=False),
    timeout_sql=TIMEOUTS.get("duckdb"),
    role_sql=ROLES.get("duckdb"),
)

#: SQLite has no DATE_TRUNC at all, which makes it the useful stress case: an
#: abstraction that survives strftime survives most things. Included as a real
#: option for small self-hosted deployments, and as proof the grain interface is
#: not quietly Postgres-shaped.
_SQLITE_GRAINS = {
    TimeGrain.SECOND: "strftime('%Y-%m-%dT%H:%M:%S', {col})",
    TimeGrain.MINUTE: "strftime('%Y-%m-%dT%H:%M:00', {col})",
    TimeGrain.HOUR: "strftime('%Y-%m-%dT%H:00:00', {col})",
    TimeGrain.DAY: "date({col})",
    # Monday-start, matching Postgres' DATE_TRUNC('week', …)
    TimeGrain.WEEK: "date({col}, 'weekday 0', '-6 days')",
    TimeGrain.MONTH: "strftime('%Y-%m-01', {col})",
    TimeGrain.QUARTER: (
        "date({col}, 'start of year', "
        "'+' || ((cast(strftime('%m', {col}) as integer) - 1) / 3) * 3 || ' months')"
    ),
    TimeGrain.YEAR: "strftime('%Y-01-01', {col})",
}

SQLITE = EngineSpec(
    name="sqlite",
    sqlglot_dialect="sqlite",
    grains=_SQLITE_GRAINS,
    # strftime and date() already return the stored wall clock, as text.
    local_buckets=False,
    types=_types(["text", "integer", "real", "numeric", "blob"]),
    caps=Capabilities(
        # SQLite has no roles, so a connection is always the shared principal —
        # and a panel bound to it must say so rather than us pretending.
        impersonation=False,
        cancel=False,
    ),
    timeout_sql=TIMEOUTS.get("sqlite"),
    role_sql=ROLES.get("sqlite"),
)


def _grains_via_sqlglot(dialect: str) -> dict[TimeGrain, str]:
    """Ask sqlglot how this engine truncates a timestamp.

    Written out by hand for the first six engines, which is how `LEAST` ended
    up in the cap under a comment claiming it was universal — SQLite has no
    LEAST at all. sqlglot already carries every spelling and is the thing that
    renders the rest of the query, so an added engine is a dialect name rather
    than a table of SQL somebody has to be right about.

    MySQL is the case that proves it: it has no DATE_TRUNC, and sqlglot emits
    the DATE_ADD/TIMESTAMPDIFF form nobody would reach for from memory.
    """
    import sqlglot

    out: dict[TimeGrain, str] = {}
    for g in TimeGrain:
        if g is TimeGrain.NONE:
            continue
        # A placeholder that survives a parse and is unambiguous to substitute.
        rendered = sqlglot.transpile(
            f"SELECT DATE_TRUNC('{g.value}', __col__)",
            read="postgres", write=dialect)[0]
        expr = rendered[len("SELECT "):]
        out[g] = expr.replace("__col__", "{col}")
    return out


def _spec(name: str, dialect: str, *, impersonation: bool = False,
          cancel: bool = False, extra_types: list[str] | None = None) -> EngineSpec:
    """One more engine: a name, a sqlglot dialect, and what it can be trusted
    to do. Everything else is derived."""
    return EngineSpec(
        name=name, sqlglot_dialect=dialect,
        grains=_grains_via_sqlglot(dialect),
        types=_types(extra_types),
        caps=Capabilities(impersonation=impersonation, cancel=cancel),
        timeout_sql=TIMEOUTS.get(dialect),
        role_sql=ROLES.get(dialect),
    )


#: Engines added by naming them. None of these has been run against a live
#: server here — the SQL is compiled and parsed back in-dialect, and that is
#: all these are claimed to be until somebody connects one.
MYSQL = _spec("mysql", "mysql", cancel=True)
MARIADB = _spec("mariadb", "mysql", cancel=True)
REDSHIFT = _spec("redshift", "redshift", impersonation=True, cancel=True)
CLICKHOUSE = _spec("clickhouse", "clickhouse", cancel=True)
DATABRICKS = _spec("databricks", "databricks", cancel=True)
TRINO = _spec("trino", "trino", impersonation=True, cancel=True)
MSSQL = _spec("mssql", "tsql", impersonation=True, cancel=True)


#: Which dialects have an ASYNC SQLAlchemy driver. The minority, and the reason
#: DirectWarehouseSource cannot assume one: Postgres and SQLite do, while
#: BigQuery, Snowflake and DuckDB are sync-only and must run in a thread.
ASYNC_DRIVERS = {"postgres", "sqlite"}

SPECS: dict[str, EngineSpec] = {
    s.name: s for s in (POSTGRES, BIGQUERY, BIGQUERY_DATE, SNOWFLAKE, DUCKDB, SQLITE,
                        MYSQL, MARIADB, REDSHIFT, CLICKHOUSE, DATABRICKS, TRINO, MSSQL)
}
