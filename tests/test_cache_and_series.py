"""Cache keying and series shaping.

The cache tests are security tests wearing performance clothes: a key that omits
the caller's grants turns a shared cache into a cross-tenant leak.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from commonindex.core.warehouse import ColKind, Filter, Query, Result, TimeGrain, Window
from commonindex.core.warehouse.cache import key_for
from commonindex.core.warehouse.dashboard import RANGES, TO_DATE, Dashboard, previous, resolve_range
from commonindex.core.warehouse.panel import Mark, Panel
from commonindex.core.warehouse.series import shape, verdict

NOW = datetime(2026, 8, 21, tzinfo=UTC)
W = Window(NOW - timedelta(days=30), NOW)


def q(**kw) -> Query:
    base = {"metric_id": "agent_acceptance", "dataset_id": "platform.agent_work",
            "grain": TimeGrain.DAY, "window": W}
    return Query(**{**base, **kw})


# ── cache keying ───────────────────────────────────────────────────────


def test_same_query_same_grants_shares_a_key():
    assert key_for(q(), ["space:pay"], 1) == key_for(q(), ["space:pay"], 1)


def test_grant_order_does_not_change_the_key():
    """Two callers with the same grants must share a key regardless of the order
    the reverse expansion happened to return them in — otherwise the cache
    quietly never hits."""
    assert key_for(q(), ["a", "b"], 1) == key_for(q(), ["b", "a"], 1)


def test_different_grants_never_share_a_key():
    """THE security property. Identical queries from different principals return
    different rows, because every read is ACL-filtered per caller."""
    assert key_for(q(), ["space:pay"], 1) != key_for(q(), ["space:growth"], 1)


def test_a_narrower_caller_does_not_hit_a_broader_callers_entry():
    """The subset case, which is the one that actually leaks: an admin's cached
    result must not be served to someone holding fewer grants."""
    admin = key_for(q(), ["space:pay", "space:growth"], 1)
    limited = key_for(q(), ["space:pay"], 1)
    assert admin != limited


def test_ratifying_a_new_definition_invalidates_the_key():
    """Otherwise changing what a number means leaves the old number on screen
    until a TTL happens to expire."""
    assert key_for(q(), ["a"], 1) != key_for(q(), ["a"], 2)


def test_window_and_dimensions_and_filters_all_participate():
    base = key_for(q(), ["a"], 1)
    assert base != key_for(q(window=Window(NOW - timedelta(days=7), NOW)), ["a"], 1)
    assert base != key_for(q(dimensions=["space"]), ["a"], 1)
    assert base != key_for(q(filters=[Filter("space", "eq", ["pay"])]), ["a"], 1)
    assert base != key_for(q(grain=TimeGrain.WEEK), ["a"], 1)


def test_dimension_order_does_not_change_the_key():
    assert key_for(q(dimensions=["a", "b"]), ["x"], 1) == key_for(q(dimensions=["b", "a"]), ["x"], 1)


# ── one window for every panel ─────────────────────────────────────────


def make_dash() -> Dashboard:
    return Dashboard(
        id="d1", space_id="s", title="Refunds",
        panels=[
            Panel(id=f"p{i}", dashboard_id="d1", title=f"p{i}", mark=Mark.LINE,
                  dataset_id="platform.agent_work", metric_id=m, metric_version=1)
            for i, m in enumerate(["agent_acceptance", "run_cost", "agent_acceptance"])
        ],
    )


def test_every_panel_on_a_dashboard_gets_the_identical_window():
    """The whole reason the range control lives on the dashboard: a KPI tile
    showing 7 days beside a chart showing 30 is how a team ends up arguing about
    a number that was never in dispute."""
    windows = {(qq.window.start, qq.window.end) for _, qq in make_dash().queries(NOW)}
    assert len(windows) == 1


def test_range_control_changes_every_panel_together():
    seven = {(qq.window.start, qq.window.end) for _, qq in make_dash().queries(NOW, "7d")}
    thirty = {(qq.window.start, qq.window.end) for _, qq in make_dash().queries(NOW, "30d")}
    assert len(seven) == len(thirty) == 1
    assert seven != thirty


def test_queries_keep_panels_paired_with_their_own_query():
    """Returning pairs rather than a list means a caller cannot render a result
    under the wrong panel — a mismatch nobody notices until it is in a slide."""
    for p, qq in make_dash().queries(NOW):
        assert qq.metric_id == p.metric_id


def test_metric_ids_are_deduplicated_but_ordered():
    assert make_dash().metric_ids == ["agent_acceptance", "run_cost"]


def test_there_is_exactly_one_range_control():
    """This replaces `test_range_options_are_few_on_purpose`, which asserted
    the list was exactly {7d, 30d, 90d}.

    The intent behind that was right and the assertion was aimed at the wrong
    half of it. What stops a tile and the chart above it quoting different
    periods is that there is ONE control for the page — not that the control is
    stingy. Three options did not make the dashboard more coherent; it made a
    reader who wanted a fortnight pick 7 and be wrong or 30 and be wrong, and
    the ones who cared exported to a spreadsheet instead, where nothing is
    certified at all.

    So: still one control, still a closed set (a free-text duration is a
    parsing surface and an invitation to two panels disagreeing), and every
    entry a real duration.
    """
    assert all(v > timedelta(0) for v in RANGES.values())
    # Ordered, because the picker renders in dict order and a range control
    # that jumps 7 → 90 → 30 reads as broken.
    assert list(RANGES.values()) == sorted(RANGES.values())
    # The set an agent is offered is the set the server accepts. These were
    # hand-kept copies in two files and are now one.
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register
    reg = Registry(); register(reg)
    closed, span = reg.get("dashboards.render").input_schema["properties"]["range"]["anyOf"]
    assert closed["enum"] == [*RANGES, *TO_DATE]
    # A span of dates is still a closed form: a pattern, parsed strictly.
    assert span["pattern"].startswith("^") and span["pattern"].endswith("$")


def test_a_range_names_its_window():
    """Presets were the only windows, so "August" or "this month so far" meant
    picking 30d and being wrong. Calendar periods to date and named spans of
    days resolve here; anything else is refused in words a reader can act on."""
    now = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)
    assert resolve_range("7d", now) == Window(now - timedelta(days=7), now)
    assert resolve_range("mtd", now).start == datetime(2026, 9, 1, tzinfo=UTC)
    assert resolve_range("qtd", now).start == datetime(2026, 7, 1, tzinfo=UTC)
    assert resolve_range("ytd", now).start == datetime(2026, 1, 1, tzinfo=UTC)
    aug = resolve_range("2026-08-01..2026-08-31", now)
    assert (aug.start, aug.end) == (datetime(2026, 8, 1, tzinfo=UTC), datetime(2026, 9, 1, tzinfo=UTC))
    # The period before is the same length, ending where this one starts.
    assert previous(aug) == Window(datetime(2026, 7, 1, tzinfo=UTC), aug.start)
    for bad in ("30 days", "2026-08-31..2026-08-01", "2026-02-30..2026-03-01", "2020-01-01..2026-01-01"):
        with pytest.raises(ValueError):
            resolve_range(bad, now)


# ── series shaping ─────────────────────────────────────────────────────


def test_no_dimension_gives_one_series():
    r = Result(columns=[("bucket", ColKind.TIME), ("value", ColKind.NUMBER)],
               rows=[["d1", 1.0], ["d2", 2.0]])
    s = shape(r)
    assert len(s.series) == 1
    assert s.series[0].points == [("d1", 1.0), ("d2", 2.0)]


def test_one_dimension_splits_into_a_series_per_value():
    r = Result(columns=[("bucket", ColKind.TIME), ("space", ColKind.STRING), ("value", ColKind.NUMBER)],
               rows=[["d1", "pay", 1.0], ["d1", "growth", 5.0], ["d2", "pay", 2.0]])
    s = shape(r)
    assert {x.name for x in s.series} == {"pay", "growth"}
    assert dict(next(x for x in s.series if x.name == "pay").points) == {"d1": 1.0, "d2": 2.0}


def test_a_result_without_a_value_column_shapes_to_nothing_rather_than_raising():
    assert shape(Result(columns=[("bucket", ColKind.TIME)], rows=[["d1"]])).is_empty


def test_shaping_carries_unit_and_direction_from_the_definition():
    s = shape(Result(columns=[("value", ColKind.NUMBER)], rows=[[1.0]]), unit="pct", better="up")
    assert (s.unit, s.better) == ("pct", "up")


# ── verdict ────────────────────────────────────────────────────────────


def test_verdict_follows_the_ratified_direction_not_the_sign():
    """A fall in error rate is good. A panel cannot claim otherwise because
    whoever built it picked the wrong arrow."""
    assert verdict(5.0, 10.0, "down") == "good"
    assert verdict(10.0, 5.0, "down") == "bad"
    assert verdict(10.0, 5.0, "up") == "good"


def test_verdict_is_none_without_a_prior_window():
    """Honest, and better than showing a zero."""
    assert verdict(5.0, None, "up") is None
    assert verdict(5.0, 0.0, "up") is None
