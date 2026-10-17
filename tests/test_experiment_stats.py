"""The statistics, checked against published values.

Every function here is a pure function over summary statistics, so it can be
checked without a warehouse — and it has to be, because a readout is a number
somebody will act on and there is no failing test in production for "the
interval was slightly too narrow".
"""

from __future__ import annotations

import math

import pytest

from commonindex.core.inference.stats import (
    Arm,
    betainc,
    compare,
    normal_cdf,
    student_t_sf,
    t_critical,
    verdict,
)

# ── the distributions, against known values ─────────────────────────────

@pytest.mark.parametrize("z,expected", [
    (0.0, 0.5), (1.0, 0.8413447461), (1.959963985, 0.975),
    (-1.0, 0.1586552539), (2.575829304, 0.995),
])
def test_normal_cdf_matches_the_tables(z, expected):
    assert normal_cdf(z) == pytest.approx(expected, abs=1e-9)


@pytest.mark.parametrize("t,df,expected", [
    # Two-sided p = 0.05 at these df, so one tail is 0.025.
    (12.706, 1, 0.025), (2.776, 4, 0.025), (2.228, 10, 0.025),
    (1.9600, 1e7, 0.025),   # converges on the normal
])
def test_student_t_matches_the_tables(t, df, expected):
    assert student_t_sf(t, df) == pytest.approx(expected, abs=5e-5)


def test_t_critical_inverts_the_survival_function():
    for df in (1, 5, 30, 500):
        c = t_critical(df, 0.05)
        assert student_t_sf(c, df) == pytest.approx(0.025, abs=1e-9)


def test_incomplete_beta_is_symmetric():
    """I_x(a,b) = 1 − I_{1−x}(b,a). The continued fraction is evaluated from
    two different branches either side of the switchover, so this checks they
    agree where they meet."""
    for a, b, x in [(0.5, 2.0, 0.3), (3.0, 4.0, 0.6), (2.0, 2.0, 0.5)]:
        assert betainc(a, b, x) == pytest.approx(1 - betainc(b, a, 1 - x), abs=1e-12)


# ── the tests themselves ────────────────────────────────────────────────

#: Reference output from an independent production implementation of this
#: exact split, on identical summary statistics. Baked in as constants so the
#: comparison is permanent without that implementation becoming a dependency.
#:
#: (lift, (ci_lo, ci_hi), p_value)
GBSTATS = {
    "prop_fixed": (0.16947472745292358, (0.07668634838552525, 0.2622631065203219),
                   0.00034438099808808964),
    "prop_seq": (0.16947472745292358, (0.02144026836530813, 0.31750918654053906),
                 0.01146783324682995),
    "prop_null": (0.010000000000000009, (-0.12244748763274446, 0.14244748763274448),
                  0.8823442453827881),
    "prop_small": (0.1999999999999999, (-0.012610195631474613, 0.4126101956314744),
                   0.0652170765292297),
    "mean_fixed": (0.024536805207811818, (0.0015101833155499941, 0.04756342710007364),
                   0.036754600097489876),
    "mean_seq": (0.024536805207811818, (-0.011426579916430708, 0.060500190332054345),
                 0.5276461137444824),
}

#: Proportions diverge by one deliberate choice: the reference uses the POPULATION
#: variance p(1−p), this uses the unbiased sample variance p(1−p)·n/(n−1).
#: Verified to account for the whole gap — swapping the formula closes it from
#: 4.6e-6 to 2.6e-8. The unbiased estimator is the better default and the
#: difference is far below display precision.
#:
#: The tolerance is derived rather than picked. The two variances differ by a
#: factor n/(n−1), so the halfwidths differ by √(n/(n−1)) − 1 ≈ 1/(2n) — which
#: means the bound must SCALE WITH n, and asserting it does is a stronger claim
#: than "the numbers are close": it says the divergence has exactly the
#: predicted form and no other component. Measured 4.6e-6 at n=10,000 and
#: 5.3e-5 at n=2,000 — a 5x change for a 5x change in n.
EXACT = 5e-9      # means share a variance formula and agree to 1e-12


def bessel_bound(n_per_arm: int, halfwidth: float) -> float:
    return halfwidth / n_per_arm


@pytest.mark.parametrize("case,arms,binary,sequential", [
    ("prop_fixed", ((10000, 1009), (10000, 1180)), True, False),
    ("prop_seq", ((10000, 1009), (10000, 1180)), True, True),
    ("prop_null", ((4000, 400), (4000, 404)), True, False),
    ("prop_small", ((2000, 200), (2000, 240)), True, False),
    ("mean_fixed", ((5000, 99850.0, 2650000.0), (5000, 102300.0, 2780000.0)), False, False),
    ("mean_seq", ((5000, 99850.0, 2650000.0), (5000, 102300.0, 2780000.0)), False, True),
])
def test_it_agrees_with_growthbooks_reference_implementation(case, arms, binary, sequential):
    """The strongest check available: the same summary statistics through a
    production engine.

    This is worth more than agreement with a textbook formula, because it
    exercises the whole pipeline — variance, Welch degrees of freedom, the delta
    method, the t quantile, and the always-valid multiplier — against something
    thousands of companies decide on.
    """
    lift, (lo, hi), pv = GBSTATS[case]
    c = compare(Arm("control", *arms[0]), Arm("variant", *arms[1]),
                binary=binary, sequential=sequential)
    tol = (bessel_bound(arms[0][0], (hi - lo) / 2) if binary else EXACT)
    assert c.lift == pytest.approx(lift, abs=EXACT), "the point estimate needs no variance"
    assert c.lift_ci[0] == pytest.approx(lo, abs=tol)
    assert c.lift_ci[1] == pytest.approx(hi, abs=tol)
    if not sequential:
        # The sequential p-value is a different object in the reference — anytime-valid
        # rather than fixed-horizon — and this does not claim to reproduce it.
        # The INTERVAL is what decides here, and it matches.
        assert c.p_value == pytest.approx(pv, rel=2e-3)


def test_the_p_value_and_the_interval_test_the_same_quantity():
    """They did not. The p-value tested the ABSOLUTE difference while the
    interval covered the RELATIVE lift, so near the boundary they contradicted
    each other: at 300 vs 350 of 3000, p = 0.0378 beside a 95% interval of
    [-0.003, +0.337]. The reference makes the same choice, and matching it closed a
    2e-4 gap to 4e-9."""
    for arms in [((3000, 300), (3000, 350)), ((4000, 400), (4000, 404)),
                 ((10000, 1009), (10000, 1180))]:
        c = compare(Arm("c", *arms[0]), Arm("v", *arms[1]), binary=True)
        significant = c.p_value < 0.05
        excludes_zero = not (c.lift_ci[0] <= 0 <= c.lift_ci[1])
        assert significant == excludes_zero, (arms, c.p_value, c.lift_ci)


def test_the_lift_interval_brackets_the_estimate_and_excludes_zero_when_significant():
    c = compare(Arm("control", 5000, 500), Arm("variant", 5000, 600), binary=True)
    lo, hi = c.lift_ci
    assert lo < c.lift < hi
    assert lo > 0, "a significant improvement should not have zero in its interval"
    assert c.p_value < 0.05


def test_a_null_result_has_an_interval_that_contains_zero():
    c = compare(Arm("control", 4000, 400), Arm("variant", 4000, 404), binary=True)
    lo, hi = c.lift_ci
    assert lo < 0 < hi
    assert c.p_value > 0.05


def test_a_mean_metric_uses_the_sum_of_squares():
    """Σx² is the only way to get variance out of a GROUP BY, and a mean metric
    is undecidable without it."""
    control = Arm("control", 100, total=500.0, sum_sq=3000.0)   # x̄ = 5
    variant = Arm("variant", 100, total=600.0, sum_sq=4200.0)   # x̄ = 6
    c = compare(control, variant, binary=False)
    assert c.mean == 6.0 and c.baseline_mean == 5.0
    assert c.lift == pytest.approx(0.2)
    assert c.p_value is not None

    with pytest.raises(ValueError, match="sum_sq"):
        Arm("x", 10, 5.0).variance(binary=False)


def test_the_binary_variance_is_exactly_p_times_one_minus_p():
    a = Arm("a", 1000, 250)
    assert a.variance(binary=True) == pytest.approx(0.25 * 0.75 * 1000 / 999)


# ── the cases that produce no answer, and say so ────────────────────────

@pytest.mark.parametrize("control,variant,why", [
    (Arm("c", 1, 0), Arm("v", 100, 10), "fewer than two"),
    (Arm("c", 100, 0), Arm("v", 100, 0), "no variance"),
])
def test_an_impossible_comparison_says_why_rather_than_returning_null(control, variant, why):
    """A null p-value reads as 'no effect'. These are 'no answer', and the
    difference matters to whoever is deciding whether to ship."""
    c = compare(control, variant, binary=True)
    assert c.undecidable and why in c.undecidable
    assert verdict(c, "up") == "no answer"


def test_a_zero_baseline_keeps_the_p_value_but_refuses_a_relative_lift():
    c = compare(Arm("c", 500, 0), Arm("v", 500, 25), binary=True)
    assert c.lift is None
    assert "relative lift is undefined" in c.undecidable
    # The absolute difference is real and significant, and is not thrown away.
    assert c.p_value is not None and c.p_value < 0.05


# ── direction ───────────────────────────────────────────────────────────

def test_the_same_movement_is_a_win_or_a_loss_depending_on_the_metric():
    """The reason a verdict cannot be read off a p-value. A significant increase
    is a win on conversion and a regression on latency, and a readout that does
    not know which will congratulate you for the wrong one."""
    up = compare(Arm("c", 5000, 500), Arm("v", 5000, 600), binary=True)
    assert verdict(up, "up") == "better"
    assert verdict(up, "down") == "worse"


def test_an_insignificant_movement_is_not_a_win_in_either_direction():
    c = compare(Arm("c", 4000, 400), Arm("v", 4000, 404), binary=True)
    assert verdict(c, "up") == verdict(c, "down") == "no difference detected"


def test_swapping_the_arms_asks_a_different_question():
    """Not a symmetry violation — the relative lift is defined AGAINST the
    control, so +20% above control and −16.7% below variant are two true
    statements about the same data and are not each other's negation.

    The reference is asymmetric here in exactly the same way and for the same reason:
    control=200/variant=240 gives p 0.0652, and the reverse gives p 0.0269.
    A test asserting equality would be encoding an assumption that only holds
    for the ABSOLUTE difference.
    """
    a = compare(Arm("c", 2000, 200), Arm("v", 2000, 240), binary=True)
    b = compare(Arm("v", 2000, 240), Arm("c", 2000, 200), binary=True)
    assert a.lift == pytest.approx(0.20)
    assert b.lift == pytest.approx(-1 / 6)
    assert math.copysign(1, a.statistic) == -math.copysign(1, b.statistic)
    assert a.p_value != b.p_value


# ── the readout query ───────────────────────────────────────────────────
# One GROUP BY returning (n, Σx, Σx²) per arm — sufficient for both tests, and
# it leaves the aggregation in the warehouse, which is the difference between a
# readout that works on a billion exposures and one that does not.

from datetime import UTC, datetime

from commonindex.core.warehouse import (
    ColKind,
    Dataset,
    Dimension,
    UndeclaredDimension,
    Window,
)
from commonindex.core.warehouse.dialects import SPECS
from commonindex.core.warehouse.readout import (
    Spec,
    pick_control,
)
from commonindex.core.warehouse.readout import (
    build as build_readout,
)

EXPOSURE = Dataset(
    id="sql.exp", connection_id="c", is_virtual=True,
    physical="SELECT user_id, variation, exposed_at, converted FROM exp",
    time_column="exposed_at",
    dimensions=[Dimension("variation", "variation", ColKind.STRING),
                Dimension("converted", "converted", ColKind.NUMBER),
                Dimension("exposed_at", "exposed_at", ColKind.TIME)])
WINDOW = Window(datetime(2026, 1, 1, tzinfo=UTC),
                datetime(2026, 2, 1, tzinfo=UTC))


def test_a_binary_outcome_needs_no_sum_of_squares():
    """Its variance is p(1−p) exactly, so asking the warehouse for Σx² is
    arithmetic it should not have to do."""
    sql = build_readout(SPECS["postgres"], EXPOSURE,
                        Spec("sql.exp", "variation", "converted", binary=True,
                             window=WINDOW)).sql
    assert "SUM(\"converted\")" in sql
    assert "sum_sq" not in sql


def test_a_mean_outcome_asks_for_the_second_moment():
    sql = build_readout(SPECS["postgres"], EXPOSURE,
                        Spec("sql.exp", "variation", "converted", binary=False,
                             window=WINDOW)).sql
    assert "AS sum_sq" in sql


def test_the_saved_query_becomes_a_subquery_and_the_window_is_bound():
    c = build_readout(SPECS["postgres"], EXPOSURE,
                      Spec("sql.exp", "variation", "converted", window=WINDOW))
    assert "FROM (SELECT user_id" in c.sql and ") AS src" in c.sql
    assert set(c.params) == {"start", "end"}


def test_a_column_the_dataset_does_not_declare_is_refused():
    """The same rule the panel builder applies. An experiment is not an
    exemption from it: reading out a column the dataset never declared is a
    readout of something else."""
    with pytest.raises(UndeclaredDimension):
        build_readout(SPECS["postgres"], EXPOSURE,
                      Spec("sql.exp", "variation", "not_a_column", window=WINDOW))


def test_a_dataset_with_a_timeline_must_carry_a_window():
    with pytest.raises(ValueError, match="must carry a window"):
        build_readout(SPECS["postgres"], EXPOSURE,
                      Spec("sql.exp", "variation", "converted", window=None))


@pytest.mark.parametrize("names,expected", [
    (["variant", "control"], "control"),
    (["b", "a"], "a"),
    (["treatment", "baseline"], "baseline"),
    (["1", "0"], "0"),
    (["arm-x", "arm-y"], "arm-x"),          # nothing conventional; first, stably
])
def test_the_control_arm_is_picked_conventionally(names, expected):
    """Guessing wrong silently inverts every lift on the page, so the rule is
    written down rather than left to row order."""
    assert pick_control(names) == expected


def test_an_explicit_control_that_does_not_exist_is_an_error_not_a_fallback():
    with pytest.raises(ValueError, match="no arm called"):
        pick_control(["control", "variant"], "kontrol")


# ── the degenerate variant ──────────────────────────────────────────────

def test_a_variant_constant_at_zero_gets_no_interval_rather_than_a_zero_width_one():
    """The realistic broken-feature case: it shipped and converted nobody.

    Both delta-method terms vanish together — the variant's variance is nil, and
    the control's term is multiplied by μv² = 0 — while the `se_sq` guard does
    not fire, because the CONTROL still has variance. This returned a 95%
    interval of width exactly 0.0 with `undecidable` unset and a confident
    verdict, in precisely the case where an honest interval matters most.
    """
    c = compare(Arm("control", 1000, 100), Arm("variant", 1000, 0), binary=True)
    assert c.lift == -1.0, "the point estimate is real and is kept"
    assert c.lift_ci is None
    assert "constant at zero" in c.undecidable
    assert verdict(c, "up") == "no answer"


def test_a_variant_constant_at_a_nonzero_value_keeps_its_interval():
    """Not the same case. The control's variance alone is a real answer, and
    refusing here would throw away a usable result."""
    c = compare(Arm("c", 1000, 5000.0, 30000.0), Arm("v", 1000, 6000.0, 36000.0),
                binary=False)
    assert c.lift_ci is not None
    assert c.lift_ci[0] < c.lift < c.lift_ci[1]


def test_a_p_value_is_floored_rather_than_reported_as_zero():
    """The tail underflows for a large |t|. "p = 0.0" claims a certainty no
    finite sample supports; a reader should see a bound."""
    c = compare(Arm("c", 1000, 5000.0, 30000.0), Arm("v", 1000, 0.0, 0.0), binary=False)
    assert c.p_value > 0
    assert c.p_value <= 1e-300


# ── one row per unit ────────────────────────────────────────────────────

def test_the_unit_column_adds_an_inner_aggregation():
    """Without it the outer COUNT counts ROWS. On 20,000 users triplicated that
    is an identical lift, an interval 1.73x too narrow and a p-value 5.5 million
    times too small — with no error anywhere."""
    ds = Dataset(id="e", connection_id="c", is_virtual=True, physical="select * from e",
                 time_column="ts",
                 dimensions=[Dimension(n, n, k) for n, k in
                             [("variation", ColKind.STRING), ("user_id", ColKind.STRING),
                              ("revenue", ColKind.NUMBER), ("ts", ColKind.TIME)]])
    plain = build_readout(SPECS["postgres"], ds,
                          Spec("e", "variation", "revenue", binary=False, window=WINDOW)).sql
    assert "per_unit" not in plain

    per_unit = build_readout(SPECS["postgres"], ds,
                             Spec("e", "variation", "revenue", binary=False, window=WINDOW,
                                  unit="user_id")).sql
    assert 'GROUP BY "variation", "user_id"' in per_unit
    assert ") AS per_unit" in per_unit
    assert per_unit.count("GROUP BY") == 2


def test_capping_is_expressible_only_at_the_unit_level():
    """Winsorization needs a per-unit value to cap, which is why it was
    unreachable before there was an inner aggregation."""
    ds = Dataset(id="e", connection_id="c", is_virtual=True, physical="select * from e",
                 dimensions=[Dimension(n, n, k) for n, k in
                             [("variation", ColKind.STRING), ("user_id", ColKind.STRING),
                              ("revenue", ColKind.NUMBER)]])
    sql = build_readout(SPECS["postgres"], ds,
                        Spec("e", "variation", "revenue", binary=False,
                             unit="user_id", cap=500)).sql
    assert "LEAST(" in sql and "500.0" in sql


@pytest.mark.parametrize("null_is_zero,expected", [(True, "COALESCE"), (False, None)])
def test_the_null_convention_is_stated_rather_than_assumed(null_is_zero, expected):
    """A unit with no outcome rows is zero for revenue-per-exposed-user and
    missing for a latency guardrail. The choice was previously unmade."""
    ds = Dataset(id="e", connection_id="c", is_virtual=True, physical="select * from e",
                 dimensions=[Dimension(n, n, k) for n, k in
                             [("variation", ColKind.STRING), ("user_id", ColKind.STRING),
                              ("revenue", ColKind.NUMBER)]])
    sql = build_readout(SPECS["postgres"], ds,
                        Spec("e", "variation", "revenue", binary=False,
                             unit="user_id", null_is_zero=null_is_zero)).sql
    assert (expected in sql) if expected else ("COALESCE" not in sql)


def test_an_undeclared_unit_column_is_refused():
    ds = Dataset(id="e", connection_id="c", is_virtual=True, physical="select * from e",
                 dimensions=[Dimension("variation", "variation", ColKind.STRING),
                             Dimension("revenue", "revenue", ColKind.NUMBER)])
    with pytest.raises(UndeclaredDimension):
        build_readout(SPECS["postgres"], ds,
                      Spec("e", "variation", "revenue", unit="nope"))


# ── always-valid intervals ──────────────────────────────────────────────
# A fixed-horizon interval is valid for ONE look. Daily peeking takes the real
# false-positive rate from 5% to about 26%; continuous monitoring passes 30%.
# That is a footnote for a human, who gets bored, and a design flaw for an
# agent, which does not.

from commonindex.core.inference.stats import (
    DEFAULT_TUNING,
    seq_multiplier,
    seq_rho,
)


def test_the_sequential_interval_is_always_wider_than_the_one_look_interval():
    """It has to be. An interval you may inspect infinitely often cannot also be
    as tight as one you may inspect once; anything claiming otherwise is selling
    a free lunch."""
    for n in (100, 1_000, 5_000, 100_000, 10_000_000):
        assert seq_multiplier(n) > t_critical(n - 2, 0.05), n


def test_it_is_tightest_at_the_tuning_point():
    """The tuning parameter is 'where you expect to decide'. The sequence is
    valid everywhere and narrowest there, which is the whole point of being
    asked for it."""
    at = seq_multiplier(DEFAULT_TUNING)
    for n in (500, 2_000, 20_000, 500_000):
        assert seq_multiplier(n) > at, f"n={n} was tighter than the tuning point"


def test_it_widens_like_the_square_root_of_a_logarithm():
    """Slowly, and without bound. Growing faster would make long experiments
    unusable; not growing at all would make the guarantee false."""
    a, b = seq_multiplier(10_000), seq_multiplier(10_000_000)
    assert b > a
    # A thousandfold more data widens it by well under half.
    assert b / a < 1.5, b / a


def test_rho_falls_as_the_tuning_point_moves_out():
    assert seq_rho(0.05, 1_000) > seq_rho(0.05, 5_000) > seq_rho(0.05, 100_000)


def test_a_sequential_verdict_reads_the_interval_not_the_p_value():
    """Under a confidence sequence the p-value is still fixed-horizon, and would
    declare a winner the anytime-valid interval does not. Letting it decide would
    reintroduce the exact error the sequence exists to remove."""
    # Chosen to sit between the two rules: significant on one look, not on any.
    control = Arm("control", 3000, 300)
    variant = Arm("variant", 3000, 350)

    one = compare(control, variant, binary=True)
    seq = compare(control, variant, binary=True, sequential=True)

    assert one.lift_ci[1] - one.lift_ci[0] < seq.lift_ci[1] - seq.lift_ci[0]
    assert seq.p_value == one.p_value, "the p-value itself is unchanged"
    assert seq.lift_ci[1] - seq.lift_ci[0] > one.lift_ci[1] - one.lift_ci[0]
    assert seq.lift_ci[0] < 0 < seq.lift_ci[1], "the anytime interval spans zero"
    assert verdict(seq, "up") == "no difference detected"


def test_a_verdict_never_contradicts_the_interval_printed_beside_it():
    """Measured at 300 vs 350 of 3000: p = 0.0378, and a 95% interval of
    [-0.003, +0.337]. The p-value tests the absolute difference exactly; the
    interval is a delta-method approximation for the relative lift, and near the
    boundary they disagree. Reporting "better" beside an interval containing
    zero asks a reader to believe the summary over the evidence next to it."""
    c = compare(Arm("control", 3000, 300), Arm("variant", 3000, 350), binary=True)
    assert c.lift_ci[0] < 0 < c.lift_ci[1]
    assert c.p_value >= 0.05, "and the p-value now agrees, rather than contradicting"
    assert verdict(c, "up") == "no difference detected"


def test_the_test_name_says_which_kind_of_interval_it_is():
    """A reader comparing two readouts needs to know whether they were computed
    under the same rule."""
    assert compare(Arm("c", 500, 50), Arm("v", 500, 60), binary=True).test == "two-proportion"
    assert compare(Arm("c", 500, 50), Arm("v", 500, 60), binary=True,
                   sequential=True).test == "sequential-two-proportion"


def test_a_real_effect_survives_the_wider_interval():
    """The seeded 10% vs 12% on 20,000 exposures. Sequential should still call
    it — otherwise the correction would be so conservative as to be useless."""
    seq = compare(Arm("control", 10000, 1009), Arm("variant", 10000, 1180),
                  binary=True, sequential=True)
    assert seq.lift_ci[0] > 0
    assert verdict(seq, "up") == "better"


FLAGGED = Dataset(
    id="public.exp_checkout", connection_id="c", is_virtual=False, physical="public.exp_checkout",
    time_column="exposed_at",
    dimensions=[Dimension("variant", "variant", ColKind.STRING),
                Dimension("converted", "converted", ColKind.BOOL),
                Dimension("exposed_at", "exposed_at", ColKind.TIME)])


@pytest.mark.parametrize("engine", ["postgres", "bigquery", "snowflake", "duckdb", "sqlite"])
def test_a_yes_no_column_is_an_outcome_summed_as_one_or_zero(engine):
    """SUM(boolean) is an error in Postgres, so `converted` could not be an
    experiment's outcome at all — the form offered `revenue` instead."""
    import sqlglot

    if engine not in SPECS:
        pytest.skip(f"no {engine} spec")
    sql = build_readout(SPECS[engine], FLAGGED,
                        Spec("public.exp_checkout", "variant", "converted", binary=True, window=WINDOW)).sql
    assert "CASE WHEN" in sql and "THEN 1 ELSE 0 END" in sql
    sqlglot.parse_one(sql.replace(":start", "'2026-01-01'").replace(":end", "'2026-02-01'"),
                      read=SPECS[engine].sqlglot_dialect)
