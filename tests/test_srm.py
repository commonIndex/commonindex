"""Sample ratio mismatch: the check, its threshold, and the two traps.

The traps are what these tests are really for. Both produce a confident,
plausible number that is wrong in a direction nobody questions:

  - counting ROWS instead of units, which multiplies the statistic by the
    rows-per-unit factor and fails a split that is exactly even;
  - checking a DESIGNED uneven split against an assumed even one, which fails
    every single time and teaches the team to dismiss the alarm.
"""

from __future__ import annotations

import math

import pytest

from commonindex.core.inference.srm import (
    DEFAULT_THRESHOLD,
    check_srm,
    chi_square_sf,
)

# ── the distribution ────────────────────────────────────────────────────


@pytest.mark.parametrize("x", [0.5, 1.0, 3.0, 7.5, 20.0, 60.0, 200.0])
def test_chi_square_tail_matches_its_closed_form(x):
    """df=1 and df=2 have exact analytic tails. No table, no tolerance fudge.

    df=2 is exp(-x/2); df=1 is erfc(sqrt(x/2)). Checking against these rather
    than published critical values means the assertion is exact to machine
    precision instead of to the four digits a table prints.
    """
    assert chi_square_sf(x, 2) == pytest.approx(math.exp(-x / 2), rel=1e-12)
    assert chi_square_sf(x, 1) == pytest.approx(math.erfc(math.sqrt(x / 2)), rel=1e-11)


def test_chi_square_far_tail_does_not_cancel_to_zero():
    """The continued fraction converges on the tail directly.

    Computing it as 1 - P(a,x) would return exactly 0.0 here, turning "one in
    1e-44" into "impossible" — and an SRM p-value of 0.0 is the one number a
    reader cannot calibrate against.
    """
    p = chi_square_sf(200.0, 1)
    assert 0.0 < p < 1e-40


def test_chi_square_rejects_nonsense():
    assert math.isnan(chi_square_sf(5.0, 0))
    assert chi_square_sf(0.0, 3) == 1.0
    assert chi_square_sf(-1.0, 3) == 1.0


# ── the check ───────────────────────────────────────────────────────────


def test_an_even_split_passes():
    r = check_srm({"control": 10_000, "variant": 10_000})
    assert r.passed
    assert r.statistic == pytest.approx(0.0)
    assert r.p_value == pytest.approx(1.0)
    assert r.total == 20_000


def test_a_real_mismatch_fails_and_names_the_arm():
    """500 users out of 20,000 — a 5% deviation, which is enormous at this n."""
    r = check_srm({"control": 10_500, "variant": 9_500})
    assert not r.passed
    assert r.statistic == pytest.approx(50.0)
    assert r.p_value < 1e-11
    # Which arm to look at first. A bare p-value does not say.
    assert r.worst == "control"
    assert {a.name: a.expected for a in r.arms} == {
        "control": 10_000.0, "variant": 10_000.0}


def test_the_threshold_is_0_001_not_0_05():
    """The whole reason the alarm stays believable.

    This split sits between the two critical values: it would be "significant"
    at 0.05 and is not at 0.001. Since a readout is polled, a 0.05 threshold
    fires on a healthy 50/50 test about once every twenty checks — which is how
    a team learns to ignore the one alarm that must never be ignored.
    """
    r = check_srm({"control": 10_173, "variant": 9_827})
    assert r.statistic == pytest.approx(5.9858, abs=1e-3)
    assert 0.001 < r.p_value < 0.05
    assert r.passed, "must not fire at the effect-test threshold"
    assert not check_srm({"control": 10_173, "variant": 9_827},
                         threshold=0.05).passed


def test_default_threshold_is_what_the_module_documents():
    assert DEFAULT_THRESHOLD == 0.001


# ── trap one: rows are not units ────────────────────────────────────────


def test_counting_rows_instead_of_units_inflates_the_statistic_linearly():
    """Three rows per user, same split, three times the chi-square.

    This is the measured consequence of omitting `unit`: the deviation and the
    expectation both scale by k, so the statistic — a squared deviation over an
    expectation — scales by k too. A borderline-fine split becomes a screaming
    failure with no error and no warning.
    """
    per_unit = check_srm({"control": 10_173, "variant": 9_827})
    per_row = check_srm({"control": 3 * 10_173, "variant": 3 * 9_827})

    assert per_row.statistic == pytest.approx(3.0 * per_unit.statistic, rel=1e-9)
    assert per_unit.passed and not per_row.passed, (
        "the identical split must not change verdict because rows were counted")


# ── trap two: a designed uneven split ───────────────────────────────────


def test_a_designed_90_10_holdout_passes_against_its_own_design():
    r = check_srm({"control": 18_000, "variant": 2_000},
                  weights={"control": 0.9, "variant": 0.1})
    assert r.passed
    assert r.statistic == pytest.approx(0.0)


def test_the_same_holdout_fails_when_an_even_split_is_assumed():
    """The false alarm that trains people to dismiss real ones."""
    r = check_srm({"control": 18_000, "variant": 2_000})
    assert not r.passed
    assert r.p_value < 1e-100


def test_weights_need_not_be_normalised():
    """9:1 and 0.9:0.1 are the same design; requiring one form is a trap of
    its own."""
    a = check_srm({"c": 18_000, "v": 2_000}, weights={"c": 9, "v": 1})
    b = check_srm({"c": 18_000, "v": 2_000}, weights={"c": 0.9, "v": 0.1})
    assert a.statistic == pytest.approx(b.statistic)
    assert a.passed and b.passed


def test_weights_must_name_exactly_the_arms_present():
    """A weight for an arm that vanished, or an arm with no weight, means the
    design and the data disagree about what the experiment IS."""
    with pytest.raises(ValueError, match="differs by"):
        check_srm({"c": 100, "v": 100}, weights={"c": 0.5})
    with pytest.raises(ValueError, match="differs by"):
        check_srm({"c": 100, "v": 100}, weights={"c": 0.4, "v": 0.4, "gone": 0.2})


def test_a_zero_weight_is_refused_rather_than_dividing_by_zero():
    with pytest.raises(ValueError, match="positive"):
        check_srm({"c": 100, "v": 100}, weights={"c": 1.0, "v": 0.0})


# ── saying "too early" instead of "fine" ────────────────────────────────


def test_too_few_exposures_is_reported_not_silently_passed():
    """Chi-square needs about five expected per cell. Below that, "passed"
    means "this test cannot see anything yet", which is a different claim and
    is made explicitly."""
    r = check_srm({"control": 3, "variant": 2})
    assert r.passed
    assert r.note and "too few exposures" in r.note


def test_a_healthy_size_carries_no_note():
    assert check_srm({"control": 5_000, "variant": 5_000}).note is None


def test_no_exposures_yet_is_not_an_error():
    """A readout called the minute an experiment starts must not 500."""
    r = check_srm({"control": 0, "variant": 0})
    assert r.passed
    assert math.isnan(r.p_value)
    assert r.note and "no exposures" in r.note


def test_three_arms_use_two_degrees_of_freedom():
    r = check_srm({"a": 1_000, "b": 1_000, "c": 1_000})
    assert r.df == 2
    assert r.passed


def test_needs_at_least_two_arms():
    with pytest.raises(ValueError, match="at least two"):
        check_srm({"control": 100})


def test_negative_counts_are_refused():
    with pytest.raises(ValueError, match="negative"):
        check_srm({"control": 100, "variant": -1})


def test_ratio_reports_delivered_over_designed():
    r = check_srm({"control": 11_000, "variant": 9_000})
    by_name = {a.name: a for a in r.arms}
    assert by_name["control"].ratio == pytest.approx(1.1)
    assert by_name["variant"].ratio == pytest.approx(0.9)


# ── the same trap, in real SQL ──────────────────────────────────────────
#
# Everything above proves the arithmetic handles rows-vs-units. These prove the
# QUERY does, which is where the bug would actually live.

sa = pytest.importorskip("sqlalchemy")

from datetime import UTC, datetime, timedelta

#: Inside any readout's default window, whatever today is. These were dated
#: 2026-08-20 and read "the last 30 days", so they failed on 19 September
#: without a line of code changing.
_RECENT = (datetime.now(tz=UTC) - timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")

from commonindex.core.warehouse import (
    ColKind,
    Connection,
    Dataset,
    Dimension,
    Window,
)
from commonindex.core.warehouse.dialects import SPECS
from commonindex.core.warehouse.readout import counts as build_counts

NOW = datetime.now(tz=UTC)
W = Window(NOW - timedelta(days=30), NOW)

#: 100 users per arm — a PERFECTLY even randomisation. But the variant arm has
#: three rows per user and the control one, which is what a join to an event
#: table does. Counting rows sees 100 against 300.
#:
#: Sized so the row-count distortion actually crosses the 0.001 threshold. An
#: earlier draft used six users per arm, where 6-vs-18 gives p=0.014 and
#: correctly PASSES — the check was right and the fixture was too small to
#: demonstrate anything, which is its own lesson about this threshold.
N_USERS = 100
EXPOSURES = (
    [(_RECENT, f"u{i}", "control") for i in range(N_USERS)]
    + [(_RECENT, f"v{i}", "variant") for i in range(N_USERS)] * 3
)


@pytest.fixture
def exposures(tmp_path):
    url = f"sqlite:///{tmp_path/'x.sqlite'}"
    engine = sa.create_engine(url)
    with engine.begin() as c:
        c.execute(sa.text(
            "create table exposures (ts timestamp, user_id varchar, arm varchar)"))
        c.execute(sa.text("insert into exposures values (:ts, :uid, :arm)"),
                  [{"ts": ts, "uid": uid, "arm": arm} for ts, uid, arm in EXPOSURES])
    ds = Dataset(
        id="exposures", connection_id="c1", physical="exposures", time_column="ts",
        dimensions=[Dimension("arm", "arm", ColKind.STRING),
                    Dimension("user_id", "user_id", ColKind.STRING)],
    )
    return engine, ds


def run_counts(engine, ds, **kw):
    compiled = build_counts(SPECS["sqlite"], ds, "arm", window=W, **kw)
    with engine.begin() as c:
        rows = c.execute(sa.text(compiled.sql), compiled.params).mappings().all()
    return {str(r["variation"]): int(r["n"]) for r in rows}


def test_sql_counts_units_when_given_a_unit_column(exposures):
    """100 users each way. The randomisation was exactly even and the check
    agrees."""
    engine, ds = exposures
    assert run_counts(engine, ds, unit="user_id") == {"control": N_USERS,
                                                      "variant": N_USERS}
    assert check_srm(run_counts(engine, ds, unit="user_id")).passed


def test_sql_without_a_unit_column_counts_rows_and_invents_a_mismatch(exposures):
    """The identical, perfectly randomised data — reported as a catastrophic
    SRM purely because the query counted rows.

    This is why `unit` is in the op schema and why its absence sets a warning on
    the response rather than a footnote in a doc.
    """
    engine, ds = exposures
    by_row = run_counts(engine, ds)
    assert by_row == {"control": N_USERS, "variant": 3 * N_USERS}

    broken = check_srm(by_row)
    assert not broken.passed
    assert broken.p_value < 1e-20, "not a borderline call — the query manufactured this"

    # The same rows, counted as the experiment randomised them.
    assert check_srm(run_counts(engine, ds, unit="user_id")).passed


def test_the_time_window_is_bound_not_interpolated(exposures):
    """Same rule as every other query here: values are parameters."""
    _, ds = exposures
    compiled = build_counts(SPECS["sqlite"], ds, "arm", unit="user_id", window=W)
    assert ":start" in compiled.sql and ":end" in compiled.sql
    assert set(compiled.params) == {"start", "end"}
    assert "2026" not in compiled.sql


def test_a_dataset_with_a_time_column_must_carry_a_window(exposures):
    _, ds = exposures
    with pytest.raises(ValueError, match="window"):
        build_counts(SPECS["sqlite"], ds, "arm", unit="user_id")


def test_an_undeclared_column_is_refused(exposures):
    """The same rule the panel builder applies. A check naming a column the
    dataset does not declare is a check of something else."""
    from commonindex.core.warehouse import UndeclaredDimension

    _, ds = exposures
    with pytest.raises(UndeclaredDimension):
        build_counts(SPECS["sqlite"], ds, "not_a_column", window=W)
    with pytest.raises(UndeclaredDimension):
        build_counts(SPECS["sqlite"], ds, "arm", unit="not_a_column", window=W)


# ── what a failed check does to the readout ─────────────────────────────


class _Req:
    """Just enough Request. The handler reads two things off it."""

    def __init__(self, body, state):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": state})()})()

    async def json(self):
        return self._body


def _source_over(tmp_path, name, rows, monkeypatch):
    """A DirectWarehouseSource over a throwaway SQLite file.

    Seeded over the sync engine and read over the async one: "sqlite" is in
    ASYNC_DRIVERS, so the source takes the async path regardless of which engine
    it is handed. Passing the sync one produced "'Connection' object does not
    support the asynchronous context manager protocol" — the source was right
    and the fixture was lying about its kind.
    """
    pytest.importorskip("aiosqlite")
    from sqlalchemy.ext.asyncio import create_async_engine

    from commonindex.core.warehouse.dialects import SPECS as _SPECS
    from commonindex.core.warehouse.sources.direct import DirectWarehouseSource
    from commonindex.gateway import authoring

    url = f"sqlite:///{tmp_path/name}"
    engine = sa.create_engine(url)
    with engine.begin() as c:
        c.execute(sa.text("create table exposures"
                          " (ts timestamp, user_id varchar, arm varchar, converted int)"))
        c.execute(sa.text("insert into exposures values (:ts,:uid,:arm,:conv)"),
                  [{"ts": t, "uid": u, "arm": a, "conv": v} for t, u, a, v in rows])

    ds = Dataset(
        id="exposures", connection_id="c1", physical="exposures", time_column="ts",
        dimensions=[Dimension("arm", "arm", ColKind.STRING),
                    Dimension("user_id", "user_id", ColKind.STRING),
                    Dimension("converted", "converted", ColKind.NUMBER)])

    class _Metrics:
        async def resolve(self, space, mid):
            raise LookupError(mid)

    src = DirectWarehouseSource(
        Connection(id="c1", space_id="s", kind="sqlite", dsn=url), _Metrics(),
        engine=create_async_engine(url.replace("sqlite://", "sqlite+aiosqlite://")))
    src._spec = _SPECS["sqlite"]
    src._dataset = lambda _id, _ds=ds: _return(_ds)

    async def _fake_source(state, conn_id, space="pay"):
        return src, {}

    monkeypatch.setattr(authoring, "_source", _fake_source)
    return {"metrics": _Metrics()}


async def _return(v):
    return v


def _arm(prefix, n, name, converters):
    return [(_RECENT, f"{prefix}{i}", name, 1 if i < converters else 0)
            for i in range(n)]


BODY = {"connection_id": "c1", "dataset_id": "exposures", "variation": "arm",
        "outcome": "converted", "unit": "user_id", "binary": True,
        "control": "control", "range": "30d"}


async def test_a_broken_assignment_collapses_every_verdict(tmp_path, monkeypatch):
    """The numbers survive for diagnosis; nothing survives as a decision.

    `verdict` is the field an agent reads to decide whether to ship. Here a
    1000/1200 split — 50/50 was designed — sits under a clean-looking 2x win.
    Without the check this reads "better" with a tight interval: a confident
    answer to a question that cannot be asked of this data.
    """
    from commonindex.gateway.authoring import experiments_readout

    state = _source_over(tmp_path, "broken.sqlite",
                         _arm("c", 1000, "control", 100) + _arm("v", 1200, "variant", 240),
                         monkeypatch)
    out = await experiments_readout(_Req(BODY, state))

    srm = out["srm"]
    assert srm["ran"] and not srm["passed"]
    assert srm["counted"] == "units"
    assert {a["name"]: a["observed"] for a in srm["arms"]} == {
        "control": 1000, "variant": 1200}

    comp = out["results"][0]["comparisons"][0]
    assert comp["verdict"] == "no answer"
    assert comp["invalidated_by"] == "srm"
    # The evidence stays — that is what diagnosing an SRM needs.
    assert comp["lift"] is not None and comp["lift"] > 0.5
    assert comp["lift_ci"] is not None

    # And it leads the caveats, above every statistical footnote.
    assert "SAMPLE RATIO MISMATCH" in out["caveats"][0]


async def test_a_clean_assignment_leaves_the_verdict_alone(tmp_path, monkeypatch):
    """The control case. A check that flags everything is not a check."""
    from commonindex.gateway.authoring import experiments_readout

    state = _source_over(tmp_path, "even.sqlite",
                         _arm("c", 1000, "control", 100) + _arm("v", 1000, "variant", 200),
                         monkeypatch)
    out = await experiments_readout(_Req(BODY, state))

    assert out["srm"]["passed"]
    comp = out["results"][0]["comparisons"][0]
    assert "invalidated_by" not in comp
    assert comp["verdict"] == "better"        # 10% -> 20% on 1000 a side
    assert not any("SAMPLE RATIO MISMATCH" in c for c in out["caveats"])


def test_worst_does_not_depend_on_the_row_order_the_warehouse_returned():
    """With two arms and an even split the residuals are EQUAL by construction,
    so a plain max() names whichever row arrived first. That sent a reader
    hunting in an arm the evidence does not single out."""
    a = check_srm({"variant": 9_500, "control": 10_500})
    b = check_srm({"control": 10_500, "variant": 9_500})
    assert a.worst == b.worst == "control"


def test_worst_names_the_over_represented_arm():
    """'Which arm got more than it should have' — well defined, and the lead an
    analyst actually follows."""
    assert check_srm({"control": 9_000, "variant": 11_000}).worst == "variant"
    assert check_srm({"control": 11_000, "variant": 9_000}).worst == "control"


def test_worst_still_finds_the_real_outlier_among_three_arms():
    """The tie-break must not override a genuine difference in residual: arm c
    is under-represented but by far the furthest from its design."""
    r = check_srm({"a": 10_100, "b": 10_100, "c": 8_000})
    assert r.worst == "c"


# ── one id, two compilers ───────────────────────────────────────────────


def test_a_readout_only_honours_the_mean_of_its_outcome_column():
    """The dashboard compiler emits the metric's expression; the readout emits
    SUM(column). They agree only when the expression IS the column's mean.

    Measured on 8,000 users before this check existed: a panel citing
    `AVG(CASE WHEN refunded = 1 THEN 0 ELSE converted END)` read a +27.1% lift
    while a readout citing the SAME metric id read +33.2%. Two surfaces, one id,
    different numbers — the drift the registry exists to prevent, arriving
    through the registry.
    """
    from commonindex.core.warehouse.readout import honours

    assert honours("AVG(converted)", "converted")
    assert honours('avg("converted")', "converted")
    assert honours("AVG(t.converted)", "converted")

    # Each of these computes something a readout cannot reproduce from sums.
    for expr in (
        "AVG(CASE WHEN refunded = 1 THEN 0.0 ELSE converted END)",
        "SUM(revenue) / NULLIF(SUM(orders), 0)",
        "COUNT(*)",
        "AVG(converted) * 100",
        "SUM(converted)",
    ):
        assert not honours(expr, "converted"), f"{expr} must not be honoured"


def test_a_definition_of_another_column_is_not_honoured():
    """The expression can be a perfectly good mean and still be the mean of the
    wrong thing."""
    from commonindex.core.warehouse.readout import honours

    assert not honours("AVG(refunded)", "converted")


def test_an_unparseable_expression_is_refused_rather_than_assumed():
    from commonindex.core.warehouse.readout import honours

    assert not honours("not sql at all (((", "converted")
    assert not honours(None, "converted")
    assert not honours("", "converted")


def test_an_amount_declared_as_a_proportion_says_which_it_is():
    """p(1-p) on a mean of 347,380 is a large negative variance, which reaches
    the constant-arms check and reports "no variance in either arm". True as
    arithmetic and useless as a diagnosis — the fault is the declaration, and a
    duration averaging six figures is not a proportion.
    """
    from commonindex.core.inference import Arm, compare

    c = compare(Arm("control", 2, 694759.88), Arm("variant", 2, 1220566.58), binary=True)
    assert c.lift is None
    assert c.undecidable is not None
    assert "0/1" in c.undecidable and "amount" in c.undecidable
    assert "no variance" not in c.undecidable


def test_a_real_proportion_is_untouched_by_that_check():
    from commonindex.core.inference import Arm, compare

    c = compare(Arm("control", 1000, 100), Arm("variant", 1000, 130), binary=True)
    assert c.undecidable is None
    assert c.lift == pytest.approx(0.3)


def test_a_genuinely_constant_pair_still_says_so():
    """The original message still applies where it is the right one."""
    from commonindex.core.inference import Arm, compare

    c = compare(Arm("control", 100, 0), Arm("variant", 100, 0), binary=True)
    assert c.undecidable == "no variance in either arm"
