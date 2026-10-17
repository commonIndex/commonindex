"""Sample ratio mismatch — did the assignment itself work?

This is the first question a readout must answer and the only one that can
invalidate every other number on the page. An experiment designed to split
traffic 50/50 that delivered 50.4/49.6 did not "run slightly unevenly": something
decided which users reached which arm, and whatever that something was, it also
decided who is in the data. Bots filtered from one arm, a redirect that drops
slow connections, a flag evaluated before the user object loads — each produces a
small ratio deviation and an arbitrarily large bias in the outcome.

So the finding is not "the split is a bit off". It is **the comparison is not
between comparable groups**, and a lift computed across it is measuring the
filter, not the change.

Two things about the threshold, both deliberate:

**0.001, not 0.05.** SRM is checked on every readout, and a readout is polled.
At 0.05 a healthy 50/50 experiment fails roughly one check in twenty, so an
agent watching hourly raises a false alarm most days and the team learns to
ignore it. 0.001 is the threshold large experimentation programmes settled on and
commonly ship; it costs almost nothing in detection because real
SRM is usually enormous, and it buys an alarm people still believe.

**Counts are UNITS, not rows.** Chi-square scales linearly in N, so counting
rows in a dataset with several rows per user multiplies the statistic by the
rows-per-user factor and reports catastrophic SRM for a perfectly even split.
This is the same defect that made every standard error wrong before `Spec.unit`
existed, and it is worse here, because the statistic has no offsetting term.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

#: The alarm threshold. See the module docstring — this is 0.001 rather than the
#: 0.05 used for effect tests, because this check runs on every poll.
DEFAULT_THRESHOLD = 0.001

#: Below this expected count the chi-square approximation is not trustworthy and
#: the check reports that rather than a number nobody should act on.
MIN_EXPECTED = 5.0

_EPS = 3e-16
_FPMIN = 1e-300
_ITMAX = 300


def _gser(a: float, x: float) -> float:
    """The series for P(a, x), the regularised LOWER incomplete gamma."""
    ap, total = a, 1.0 / a
    term = total
    for _ in range(_ITMAX):
        ap += 1.0
        term *= x / ap
        total += term
        if abs(term) < abs(total) * _EPS:
            break
    return total * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _gcf(a: float, x: float) -> float:
    """The continued fraction for Q(a, x), by modified Lentz.

    Same method as `betainc` in `stats` — converging on the tail directly rather
    than subtracting it from one, which is what keeps the far tail accurate
    instead of cancelling to zero.
    """
    b, c, d = x + 1.0 - a, 1.0 / _FPMIN, 1.0 / (x + 1.0 - a)
    h = d
    for i in range(1, _ITMAX + 1):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = b + an / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < _EPS:
            break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def chi_square_sf(x: float, df: int) -> float:
    """P(X² > x) — the upper tail of the chi-square distribution.

    Q(df/2, x/2), by series below the crossover and continued fraction above it.
    """
    if df <= 0:
        return float("nan")
    if x <= 0.0:
        return 1.0
    a, xx = df / 2.0, x / 2.0
    return 1.0 - _gser(a, xx) if xx < a + 1.0 else _gcf(a, xx)


@dataclass(frozen=True, slots=True)
class ArmCount:
    """One arm's delivered share against its designed share."""

    name: str
    observed: int
    expected: float

    @property
    def ratio(self) -> float:
        """Observed over expected. 1.0 is exactly as designed."""
        return self.observed / self.expected if self.expected else float("nan")


@dataclass(frozen=True, slots=True)
class SRM:
    passed: bool
    p_value: float
    statistic: float
    df: int
    threshold: float
    arms: tuple[ArmCount, ...]
    #: The arm furthest from its design — where to look first, which a bare
    #: p-value does not tell you.
    #:
    #: By standardised residual, ties broken toward the OVER-represented arm.
    #: The tie-break is not cosmetic: with two arms and an even split the two
    #: residuals are identical by construction, so without it this named
    #: whichever row the warehouse happened to return first, and an analyst
    #: reading it would go hunting in an arm the evidence does not single out.
    #: "Which arm got more than it should have" is both well defined and the
    #: conventional way to state the finding.
    worst: str | None = None
    #: Set when the result should not be acted on as stated.
    note: str | None = None

    @property
    def total(self) -> int:
        return sum(a.observed for a in self.arms)


def check_srm(
    counts: Mapping[str, int] | Sequence[tuple[str, int]],
    weights: Mapping[str, float] | None = None,
    threshold: float = DEFAULT_THRESHOLD,
) -> SRM:
    """Chi-square goodness of fit against the designed split.

    `weights` is the split the experiment was DESIGNED for, and passing it is not
    optional for anything but an even split: a deliberate 90/10 holdout checked
    against an assumed 50/50 fails every time, which trains the team to dismiss
    the one alarm that must never be dismissed.
    """
    items = list(counts.items() if isinstance(counts, Mapping) else counts)
    if len(items) < 2:
        raise ValueError(f"SRM needs at least two arms; got {len(items)}")
    for name, n in items:
        if n < 0:
            raise ValueError(f"arm {name!r} has a negative count")

    total = sum(n for _, n in items)
    if total == 0:
        return SRM(passed=True, p_value=float("nan"), statistic=float("nan"),
                   df=len(items) - 1, threshold=threshold,
                   arms=tuple(ArmCount(name, 0, 0.0) for name, _ in items),
                   note="no exposures yet, so the split cannot be checked")

    if weights is None:
        share = {name: 1.0 / len(items) for name, _ in items}
    else:
        missing = {n for n, _ in items} ^ set(weights)
        if missing:
            raise ValueError(
                f"weights must name exactly the arms present; differs by {sorted(missing)}")
        if any(w <= 0 for w in weights.values()):
            raise ValueError("every designed weight must be positive")
        denom = sum(weights.values())
        share = {name: weights[name] / denom for name, _ in items}

    arms, stat = [], 0.0
    for name, n in items:
        expected = total * share[name]
        arms.append(ArmCount(name=name, observed=n, expected=expected))
        stat += (n - expected) ** 2 / expected

    # Largest residual; on a tie, the arm that received MORE than its design.
    # See ``SRM.worst`` — the tie is the normal case for a two-arm even split,
    # not an edge case.
    worst = max(arms, key=lambda a: ((a.observed - a.expected) ** 2 / a.expected,
                                     a.observed - a.expected)).name

    df = len(items) - 1
    p = chi_square_sf(stat, df)

    note = None
    if min(a.expected for a in arms) < MIN_EXPECTED:
        # Reported rather than silently returned: under this many expected
        # observations the chi-square approximation is poor, so "passed" here
        # means "too early to tell", which is a different claim.
        note = (f"the smallest expected count is {min(a.expected for a in arms):.1f}, "
                f"below {MIN_EXPECTED:g} — too few exposures for this test to mean much yet")

    return SRM(passed=p >= threshold, p_value=p, statistic=stat, df=df,
               threshold=threshold, arms=tuple(arms), worst=worst, note=note)
