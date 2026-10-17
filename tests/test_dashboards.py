"""Dashboard logic that is pure enough to test without a database.

Certification and metric refusal are the two places where the product's claim —
that two dashboards cannot quietly disagree about a number — is either true or
not. Both are worth holding down with tests before there is any execution code to
hide behind.
"""

from __future__ import annotations

from datetime import UTC

import pytest

from commonindex.core.warehouse import TimeGrain, UnratifiedMetric, Window
from commonindex.core.warehouse.metrics import Metric, require_ratified
from commonindex.core.warehouse.panel import Mark, Panel, certify


def panel(pid: str, metric_id: str) -> Panel:
    return Panel(
        id=pid, dashboard_id="d1", title=pid, mark=Mark.LINE,
        dataset_id="platform.agent_work", metric_id=metric_id, metric_version=1,
    )


class FakeRegistry:
    def __init__(self, metrics: dict[str, Metric]) -> None:
        self._m = metrics

    async def resolve(self, space_id: str, metric_id: str) -> Metric:
        return self._m[metric_id]

    async def all_for(self, space_id: str, dataset_id: str | None = None):
        return list(self._m.values())


def make(status: str) -> Metric:
    return Metric(
        id="refund_rate", version=1, space_id="s", label="Refund rate",
        expr="SUM(refunds)/COUNT(*)", status=status,
    )


# ── certification ──────────────────────────────────────────────────────


def test_certified_when_every_panel_cites_a_ratified_metric():
    c = certify([panel("p1", "agent_acceptance"), panel("p2", "run_cost")],
                {"agent_acceptance", "run_cost"})
    assert c.certified
    assert c.total == 2
    assert c.unratified == []


def test_one_unratified_panel_uncertifies_the_dashboard():
    """And names which panel, so it can say so on its own face rather than
    looking exactly like the trustworthy ones."""
    c = certify([panel("p1", "agent_acceptance"), panel("p2", "made_up")],
                {"agent_acceptance"})
    assert not c.certified
    assert c.unratified == ["p2"]
    assert "1 panel bound to a metric nobody has ratified" in c.reason


def test_an_empty_dashboard_is_not_certified():
    """Vacuous truth is the wrong answer here: a dashboard with no panels has
    not demonstrated anything, and a green badge on it would be a lie."""
    assert not certify([], {"agent_acceptance"}).certified


def test_certification_is_recomputed_not_stored():
    """Deprecating a metric un-certifies every dashboard citing it, with no job
    to run and nobody to remember."""
    panels = [panel("p1", "refund_rate")]
    assert certify(panels, {"refund_rate"}).certified
    assert not certify(panels, set()).certified  # the metric was deprecated


# ── metric resolution ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ratified_metric_resolves():
    m = await require_ratified(FakeRegistry({"refund_rate": make("ratified")}), "s", "refund_rate")
    assert m.expr


@pytest.mark.parametrize("status", ["proposed", "deprecated"])
@pytest.mark.asyncio
async def test_unratified_metric_refuses_at_query_time(status: str):
    """Checked on the query path, not at panel-save time.

    A metric can be deprecated after a panel is built, and the panel must start
    failing visibly rather than keep serving a definition nobody stands behind.
    """
    reg = FakeRegistry({"refund_rate": make(status)})
    with pytest.raises(UnratifiedMetric):
        await require_ratified(reg, "s", "refund_rate")


# ── panel compilation ──────────────────────────────────────────────────


def test_panel_takes_its_window_from_the_dashboard():
    """The window is passed in, never stored on the panel — which is what makes
    it impossible for two panels on one dashboard to quote different periods."""
    from datetime import datetime

    w = Window(datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 2, 1, tzinfo=UTC))
    q = panel("p1", "agent_acceptance").to_query(w)
    assert q.window is w
    assert q.metric_id == "agent_acceptance"
    assert q.grain is TimeGrain.DAY
    assert not hasattr(Panel, "window")


# ── the two views of the registry ───────────────────────────────────────
# `all_for` answers the QUERY path: what may be compiled into SQL, which is
# ratified definitions only. `all_definitions` answers the GOVERNANCE path: what
# may be reviewed, which is everything. For a long time only the first existed,
# so anything needing to show a proposed definition went around the registry to
# raw SQL — and the skill came to describe a set of definitions the resolver did
# not have.

class _Stored:
    def __init__(self, metrics): self._m = metrics
    async def all_for(self, space_id, dataset_id=None):
        return [m for m in self._m if m.status == "ratified"
                and dataset_id in (None, m.dataset_id)]
    async def all_definitions(self, space_id, dataset_id=None):
        return [m for m in self._m if dataset_id in (None, m.dataset_id)]


def _m(mid, status="ratified", dataset="d"):
    from commonindex.core.warehouse.metrics import Metric
    return Metric(id=mid, version=1, space_id="pay", label=mid, expr="COUNT(*)",
                  dataset_id=dataset, status=status)


@pytest.mark.asyncio
async def test_the_query_view_hides_what_the_governance_view_shows():
    from commonindex.gateway.app import _CombinedRegistry, _SeedRegistry

    reg = _CombinedRegistry(_Stored([_m("a"), _m("b", "proposed"), _m("c", "deprecated")]),
                            _SeedRegistry())
    # Scoped to this dataset, so the platform's own seeded metrics — which come
    # through both views and are ratified by construction — do not blur it.
    query = {m.id for m in await reg.all_for("pay", "d")}
    governance = {m.id for m in await reg.all_definitions("pay", "d")}
    assert query == {"a"}, "an unratified definition must not reach the query path"
    assert governance == {"a", "b", "c"}, "the review path must see everything"


@pytest.mark.asyncio
async def test_precedence_is_implemented_once_and_holds_for_both_views():
    """A workspace definition supersedes a seeded one of the same id. The rule
    was written twice — once in the registry and again in the skill's loader,
    which merged on top of a function that already merged. Two implementations
    of one rule is how they come to disagree, which is the argument this
    platform makes about metrics, applied to its own code."""
    from commonindex.core.warehouse.sources.eventlog import SEED_METRICS
    from commonindex.gateway.app import _CombinedRegistry, _SeedRegistry

    shadowed = SEED_METRICS[0].id
    reg = _CombinedRegistry(_Stored([_m(shadowed), _m(shadowed, "proposed")]), _SeedRegistry())
    for view in (reg.all_for, reg.all_definitions):
        got = [m for m in await view("pay") if m.id == shadowed]
        assert all(m.expr == "COUNT(*)" for m in got), (
            f"{view.__name__} returned the seeded definition over the workspace's own")
