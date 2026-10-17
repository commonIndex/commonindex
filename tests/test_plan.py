"""Sizing an experiment before it starts."""

from __future__ import annotations

import pytest

from commonindex.core.inference.plan import plan


def test_the_fixed_horizon_size_is_the_textbook_one():
    """10% → 11% at alpha 0.05 and 80% power: about 14,750 per arm, the number
    every sample-size calculator gives."""
    p = plan(baseline=0.10, mde=0.10, sequential=False)
    assert 14_700 <= p.per_arm["control"] <= 14_800
    assert p.per_arm["control"] == p.per_arm["variant"]


def test_the_readouts_default_interval_needs_more_units_than_the_textbook():
    """Quoting the fixed-horizon size for an always-valid readout would promise
    power it does not have."""
    fixed = plan(baseline=0.10, mde=0.10, sequential=False)
    seq = plan(baseline=0.10, mde=0.10, sequential=True)
    assert seq.total > fixed.total


def test_the_sequential_size_is_the_smallest_that_clears_the_boundary():
    from statistics import NormalDist

    from commonindex.core.inference.stats import seq_multiplier

    p = plan(baseline=0.10, mde=0.10, sequential=True)
    z = NormalDist().inv_cdf(0.8)
    v = 0.1 * 0.9 + 0.11 * 0.89

    def clears(n):
        return 0.01 >= (seq_multiplier(n) + z) * (v / (n / 2)) ** 0.5

    assert clears(p.total) and not clears(p.total - 20)


def test_days_follow_from_daily_traffic():
    p = plan(baseline=0.10, mde=0.10, sequential=False, daily_units=1_000)
    assert p.days == -(-p.total // 1_000)


def test_an_uneven_split_sizes_the_thin_arm():
    even = plan(baseline=0.10, mde=0.10, sequential=False)
    holdout = plan(baseline=0.10, mde=0.10, sequential=False,
                   weights={"control": 0.9, "variant": 0.1})
    assert holdout.total > even.total
    assert holdout.per_arm["variant"] < holdout.per_arm["control"]


def test_an_amount_needs_its_spread():
    with pytest.raises(ValueError, match="standard deviation"):
        plan(baseline=40.0, mde=0.05, binary=False)
    p = plan(baseline=40.0, mde=0.05, binary=False, sd=30.0, sequential=False)
    assert p.total > 0


@pytest.mark.parametrize("kw, msg", [
    ({"baseline": 0.0, "mde": 0.1}, "zero baseline"),
    ({"baseline": 1.2, "mde": 0.1}, "between 0 and 1"),
    ({"baseline": 0.95, "mde": 0.1}, "leaves the 0 to 1 range"),
    ({"baseline": 0.1, "mde": 0.0}, "zero cannot be detected"),
])
def test_impossible_plans_say_why(kw, msg):
    with pytest.raises(ValueError, match=msg):
        plan(**kw)
