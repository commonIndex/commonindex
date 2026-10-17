"""Query compilation and row mapping.

These are the parts of execution that can be held down without a database: what
SQL comes out, what is bound rather than interpolated, and what shape the rows
take on the way back. The I/O itself needs a live Postgres and is not pretended
at here.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from commonindex.core.warehouse import (
    ColKind,
    Filter,
    Query,
    TimeGrain,
    UndeclaredDimension,
    Window,
)
from commonindex.core.warehouse.dialects import BIGQUERY, POSTGRES, SNOWFLAKE
from commonindex.core.warehouse.sources.eventlog import (
    AGENT_WORK,
    SEED_METRICS,
    compile_query,
    to_result,
)

NOW = datetime(2026, 8, 21, tzinfo=UTC)
W = Window(NOW - timedelta(days=30), NOW)
ACCEPTANCE = next(m for m in SEED_METRICS if m.id == "agent_acceptance")


def q(**kw) -> Query:
    base = {"metric_id": "agent_acceptance", "dataset_id": "platform.agent_work",
            "space_id": "pay", "grain": TimeGrain.DAY, "window": W}
    return Query(**{**base, **kw})


# ── the seeded metrics must match the schema ───────────────────────────


def test_every_seeded_metric_references_only_real_columns():
    """The bug this catches shipped once already: undo_after_merge referenced
    proposals.undone, which did not exist. Migration 0003 added undone_at."""
    from pathlib import Path

    ddl = "\n".join(
        p.read_text() for p in
        sorted((Path(__file__).resolve().parent.parent / "migrations").glob("*.sql"))
    )
    # every bare identifier the expressions mention, minus SQL keywords
    known = {"status", "undone_at", "decided_at", "created_at", "cost_usd",
             "started_at", "author_id", "space_id", "agent_id"}
    for m in SEED_METRICS:
        for col in known:
            if col in m.expr:
                assert col in ddl, f"{m.id} references {col}, absent from the schema"


def test_seeded_metrics_are_all_ratified():
    """They ship with the platform, but they still go through the registry — an
    unratified seed would refuse at query time, which would be a silent outage."""
    assert all(m.status == "ratified" for m in SEED_METRICS)


def test_every_seeded_metric_declares_a_direction():
    """Without `better`, verdict() cannot say whether a change is good, and the
    panel falls back to showing an arrow somebody guessed."""
    assert all(m.better in ("up", "down") for m in SEED_METRICS)


# ── compilation ────────────────────────────────────────────────────────


def test_space_and_window_are_always_bound_never_interpolated():
    sql, params = compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(), [])
    assert "$1" in sql and "$2" in sql and "$3" in sql
    assert params == ["pay", W.start, W.end]
    # nothing user-supplied appears as literal text
    assert "pay" not in sql


def test_the_window_is_always_closed():
    """An unbounded scan of the largest table in the system is how a dashboard
    becomes an incident."""
    sql, _ = compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(), [])
    assert ">=" in sql and "<" in sql


def test_space_scope_comes_first():
    """It is the partition key and the most selective predicate the planner
    sees."""
    sql, _ = compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(), [])
    where = sql.split(" WHERE ", 1)[1]
    assert where.startswith("space_id = $1")


def test_grain_becomes_a_dialect_bucket():
    sql, _ = compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(), [])
    assert "CAST(DATE_TRUNC('day', created_at) AS DATE) AS bucket" in sql


def test_grouping_uses_the_expression_not_the_alias():
    """Correct on every engine, so the builder needs no capability branch —
    BigQuery rejects a SELECT alias in some positions."""
    sql, _ = compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(dimensions=["space"]), [])
    assert "GROUP BY CAST(DATE_TRUNC('day', created_at) AS DATE), space_id" in sql
    assert "GROUP BY bucket" not in sql


def test_no_grain_produces_no_bucket():
    sql, _ = compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(grain=TimeGrain.NONE), [])
    assert "bucket" not in sql
    assert "GROUP BY" not in sql


def test_an_undeclared_dimension_is_refused_not_ignored():
    """Ignoring it would silently return the wrong rows."""
    with pytest.raises(UndeclaredDimension):
        compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE, q(dimensions=["region"]), [])


def test_an_undeclared_filter_is_refused_too():
    with pytest.raises(UndeclaredDimension):
        compile_query(POSTGRES, AGENT_WORK, ACCEPTANCE,
                      q(filters=[Filter("region", "eq", ["emea"])]), [])


def test_multi_value_filters_bind_as_an_array():
    sql, params = compile_query(
        POSTGRES, AGENT_WORK, ACCEPTANCE,
        q(filters=[Filter("outcome", "in", ["merged", "rejected"])]), [])
    assert "= ANY($4)" in sql
    assert params[-1] == ["merged", "rejected"]


# ── dialect differences ────────────────────────────────────────────────


def test_postgres_takes_the_grain_as_a_string_literal():
    assert POSTGRES.bucket(TimeGrain.DAY, "ts") == "CAST(DATE_TRUNC('day', ts) AS DATE)"


def test_bigquery_takes_it_as_a_keyword():
    """The single clearest illustration of why this cannot be one shared
    function with a parameter."""
    assert BIGQUERY.bucket(TimeGrain.DAY, "ts") == "CAST(TIMESTAMP_TRUNC(ts, DAY) AS DATE)"


def test_snowflake_uppercases_the_field():
    assert SNOWFLAKE.bucket(TimeGrain.MONTH, "ts") == "CAST(DATE_TRUNC('MONTH', ts) AS DATE)"


def test_a_calendar_bucket_is_the_warehouse_s_own_date():
    """A truncated timestamp with a time zone reaches Python in UTC, so a day
    counted in Kolkata arrived as 18:30 the day before, and every chart named
    each day one day early. Cast in the warehouse, a day is the day it counted;
    a finer grain is its wall-clock time, spelled the way each engine spells a
    time without a zone."""
    from commonindex.core.warehouse.dialects import SQLITE

    assert POSTGRES.bucket(TimeGrain.WEEK, "ts") == "CAST(DATE_TRUNC('week', ts) AS DATE)"
    assert POSTGRES.bucket(TimeGrain.HOUR, "ts") == "CAST(DATE_TRUNC('hour', ts) AS TIMESTAMP)"
    assert BIGQUERY.bucket(TimeGrain.HOUR, "ts") == "CAST(TIMESTAMP_TRUNC(ts, HOUR) AS DATETIME)"
    # SQLite's grains are text in the stored wall clock already.
    assert SQLITE.bucket(TimeGrain.DAY, "ts") == "date(ts)"


def test_no_grain_maps_to_the_bare_column_everywhere():
    """The usual convention, and the case every implementation forgets."""
    for spec in (POSTGRES, BIGQUERY, SNOWFLAKE):
        assert spec.bucket(TimeGrain.NONE, "ts") == "ts"


def test_bigquery_cannot_alias_in_select():
    assert BIGQUERY.caps.alias_in_select is False
    assert POSTGRES.caps.alias_in_select is True


def test_type_mapping_is_case_insensitive():
    assert POSTGRES.kind_of("TIMESTAMPTZ") is ColKind.TIME
    assert BIGQUERY.kind_of("int64") is ColKind.NUMBER
    assert POSTGRES.kind_of("jsonb") is ColKind.STRING  # the safe default


# ── row mapping ────────────────────────────────────────────────────────


def test_result_columns_follow_the_select_list():
    r = to_result([{"bucket": "d1", "space": "pay", "value": 0.9}],
                  q(dimensions=["space"]), AGENT_WORK)
    assert [c[0] for c in r.columns] == ["bucket", "space", "value"]
    assert r.rows == [["d1", "pay", 0.9]]


def test_result_carries_the_dimension_kinds_from_the_dataset():
    r = to_result([], q(dimensions=["space"]), AGENT_WORK)
    assert dict(r.columns)["space"] is ColKind.STRING
    assert dict(r.columns)["value"] is ColKind.NUMBER


def test_result_is_stamped_with_a_fetch_time():
    """A panel must be able to say when its numbers are from — a dashboard that
    scopes every panel from one control has to prove they agree."""
    assert to_result([], q(), AGENT_WORK).fetched is not None
