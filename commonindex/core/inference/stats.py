"""The statistics an experiment readout needs, from the standard library.

No scipy here, and that is a choice rather than a constraint: the whole of what
an A/B readout needs is a normal CDF, a t CDF, and the delta method, and pulling
a numerical stack in for three functions makes them harder to check, not easier.
Everything below is a pure function over summary statistics — count, sum, sum of
squares per arm — so it is testable against published values without a database
or a warehouse.

**Summary statistics, not rows.** A readout never needs the individual
observations: (n, Σx, Σx²) per variation is sufficient for both tests here, and
it is one GROUP BY rather than a scan into the process. It also means the
warehouse does the aggregation, which is what it is for.

A note on what this deliberately does NOT do. There is no peeking correction, no
CUPED, and no multiple-comparison adjustment across metrics. Each of those
changes the number, and shipping one silently would be worse than not having it:
`Readout.caveats` names the ones that apply so a reader knows what the interval
does and does not account for.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field, replace

#: The smallest p-value reported. Below this the tail has underflowed and the
#: honest statement is "smaller than this", not zero.
MIN_P = 1e-300


@dataclass(frozen=True, slots=True)
class Arm:
    """One variation, as the warehouse summarised it."""

    name: str
    #: Units exposed — users, sessions, whatever the exposure table counts.
    n: int
    #: Σx over those units. For a 0/1 outcome this is the number of conversions.
    total: float
    #: Σx². Absent for a proportion, where it equals `total` because x² = x.
    sum_sq: float | None = None

    @property
    def mean(self) -> float:
        return self.total / self.n if self.n else 0.0

    def variance(self, *, binary: bool) -> float:
        """Sample variance of the per-unit outcome.

        For a 0/1 outcome this is p(1-p) exactly, which is why a proportion
        needs no Σx² — and asking the warehouse for one would be arithmetic it
        should not have to do.
        """
        if self.n < 2:
            return 0.0
        if binary:
            p = self.mean
            return p * (1 - p) * self.n / (self.n - 1)
        if self.sum_sq is None:
            raise ValueError(f"{self.name}: a mean metric needs sum_sq")
        # Σx² − n·x̄², over n−1. Computed this way rather than from residuals
        # because the warehouse can only give us the sums.
        ss = self.sum_sq - self.n * self.mean ** 2
        return max(ss, 0.0) / (self.n - 1)


@dataclass(frozen=True, slots=True)
class Comparison:
    variation: str
    baseline: str
    n: int
    baseline_n: int
    mean: float
    baseline_mean: float
    #: Relative change, as a fraction. 0.07 is a 7% lift.
    lift: float | None
    lift_ci: tuple[float, float] | None
    p_value: float | None
    statistic: float | None
    test: str
    #: Set when the numbers are real but the test could not be run — an empty
    #: arm, a zero baseline. Saying which beats returning a null and letting the
    #: reader guess whether it is "no effect" or "no answer".
    undecidable: str | None = None


@dataclass(frozen=True, slots=True)
class Readout:
    metric: str
    better: str
    comparisons: list[Comparison]
    alpha: float
    caveats: list[str] = field(default_factory=list)


# ── distributions ───────────────────────────────────────────────────────

def normal_cdf(z: float) -> float:
    """Exact to machine precision — `erf` is in the standard library."""
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _continued_fraction(terms, *, rel: float = 1e-15, most: int = 400) -> float:
    """Evaluate 1 / (1 + t1 / (1 + t2 / (1 + ...))) for the coefficients `terms`.

    The modified Lentz algorithm (Thompson & Barnett, 1986): the value is
    built as a product of ratios of successive convergents, so it never
    forms the convergents themselves and cannot overflow; a ratio that would
    divide by zero is nudged off it instead.
    """
    floor = 1e-300
    value = num = 1.0          # f_0 = b_0 = 1, and C_0 = f_0
    den = 0.0                  # D_0
    for t in itertools.islice(terms, most):
        den = 1.0 + t * den
        den = 1.0 / (den if abs(den) > floor else floor)
        num = 1.0 + t / num
        num = num if abs(num) > floor else floor
        step = num * den
        value *= step
        if abs(step - 1.0) < rel:
            break
    return 1.0 / value


def _beta_terms(a: float, b: float, x: float):
    """The coefficients d_1, d_2, ... of the incomplete beta's continued
    fraction, DLMF 8.17.22: d_2m = m(b-m)x / ((a+2m-1)(a+2m)) and
    d_2m+1 = -(a+m)(a+b+m)x / ((a+2m)(a+2m+1))."""
    yield -(a + b) * x / (a + 1.0)          # d_1, the m = 0 case of the odd form
    for m in itertools.count(1):
        yield m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
        yield -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))


def betainc(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
             + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1.0) / (a + b + 2.0):
        return math.exp(lbeta) * _continued_fraction(_beta_terms(a, b, x)) / a
    return 1.0 - math.exp(lbeta) * _continued_fraction(_beta_terms(b, a, 1.0 - x)) / b


def student_t_sf(t: float, df: float) -> float:
    """P(T > |t|) — one tail of Student's t."""
    if df <= 0:
        return float("nan")
    return 0.5 * betainc(df / 2.0, 0.5, df / (df + t * t))


def t_critical(df: float, alpha: float) -> float:
    """Two-sided critical value, by bisection on the survival function.

    Bisection rather than an inverse: the survival function is monotone and
    cheap, forty iterations is exact to 1e-12, and an approximation formula
    would be one more thing to be subtly wrong about.
    """
    lo, hi = 0.0, 1000.0
    target = alpha / 2.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if student_t_sf(mid, df) > target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


# ── always-valid intervals ──────────────────────────────────────────────
# A fixed-horizon interval is valid for ONE look. Look daily and the real
# false-positive rate goes from the designed 5% to roughly 26%; monitor
# continuously and it passes 30%.
#
# That is a footnote for a human, who gets bored, and a design flaw for an
# agent, which does not. An agent asked to watch an experiment will call the
# readout every hour forever, and a fixed-horizon p-value under that regime is
# a false-positive generator with a caveat attached.
#
# The fix is a confidence SEQUENCE: an interval valid at every sample size
# simultaneously, so peeking costs nothing because there is no privileged
# moment to peek at. Asymptotic Confidence Sequences, Waudby-Smith et al.
# (2023), close kin to Howard et
# al.'s generalized anytime-valid inference.
#
# It takes the same summary statistics. The whole difference is the multiplier
# on the standard error: t_critical for one look, seq_multiplier for any number.

#: Where you expect to decide. The interval is tightest here and valid
#: everywhere; a common default.
DEFAULT_TUNING = 5000


def seq_rho(alpha: float, tuning: int) -> float:
    """ρ, the parameter that decides where the sequence is tightest."""
    a = -2.0 * math.log(alpha)
    return math.sqrt((a + math.log(a + 1.0)) / tuning)


def seq_multiplier(n_total: int, alpha: float = 0.05,
                   tuning: int = DEFAULT_TUNING) -> float:
    """What replaces the t critical value when the interval must hold at
    every look.

        √N · √[ 2(Nρ² + 1) / (N²ρ²) · log( √(Nρ² + 1) / α ) ]

    It grows like √log N — slowly, and without bound. That unbounded growth is
    the honest price: an interval that may be inspected infinitely often cannot
    also shrink to the fixed-horizon width, and anything claiming otherwise is
    selling a free lunch.
    """
    if n_total <= 0:
        return float("inf")
    rho2 = seq_rho(alpha, tuning) ** 2
    nr = n_total * rho2
    inner = (2.0 * (nr + 1.0)) / (n_total ** 2 * rho2) * math.log(math.sqrt(nr + 1.0) / alpha)
    return math.sqrt(n_total) * math.sqrt(inner)


# ── the tests ───────────────────────────────────────────────────────────

def compare(control: Arm, variant: Arm, *, binary: bool, alpha: float = 0.05,
            sequential: bool = False, tuning: int = DEFAULT_TUNING) -> Comparison:
    """Welch's t-test, which is also the right test for a proportion.

    Welch rather than Student because equal variances are an assumption nobody
    checks and a treatment that moves the mean usually moves the variance too.
    For a 0/1 outcome with the variance set to p(1−p), Welch reduces to the
    two-proportion z-test as n grows, so one code path serves both — and the
    t distribution is the more conservative of the two at small n.
    """
    base = Comparison(
        variation=variant.name, baseline=control.name,
        n=variant.n, baseline_n=control.n,
        mean=variant.mean, baseline_mean=control.mean,
        lift=None, lift_ci=None, p_value=None, statistic=None,
        test=("sequential-" if sequential else "")
             + ("welch-t" if not binary else "two-proportion"),
    )

    if control.n < 2 or variant.n < 2:
        return _undecidable(base, "an arm has fewer than two units")

    # A proportion lives in [0, 1], so a mean outside it means the outcome is
    # not one — and p(1-p) on a mean of 347,380 is a large NEGATIVE variance
    # that reaches the check below and reports itself as "no variance in either
    # arm". True as arithmetic, useless as a diagnosis: the fault is the
    # declaration, not the data, and only this branch can still say so.
    if binary:
        bad = [a.name for a in (control, variant) if not 0.0 <= a.mean <= 1.0]
        if bad:
            return _undecidable(base, (
                f"declared as a 0/1 outcome, but {' and '.join(bad)} "
                f"average{'s' if len(bad) == 1 else ''} "
                f"{', '.join(f'{a.mean:,.4g}' for a in (control, variant) if a.name in bad)}"
                " — a proportion cannot fall outside 0 to 1, so this is an amount"
                " and needs the mean test instead"))

    vc, vv = control.variance(binary=binary), variant.variance(binary=binary)
    se_sq = vc / control.n + vv / variant.n
    if se_sq <= 0:
        # Both arms constant. A real finding, and not one a t-test can express:
        # the difference is either exactly zero or infinitely significant.
        return _undecidable(base, "no variance in either arm")

    se = math.sqrt(se_sq)
    diff = variant.mean - control.mean
    t = diff / se
    # Welch–Satterthwaite.
    df_num = se_sq ** 2
    df_den = ((vc / control.n) ** 2 / (control.n - 1)
              + (vv / variant.n) ** 2 / (variant.n - 1))
    df = df_num / df_den if df_den > 0 else float(control.n + variant.n - 2)
    # Floored rather than reported as exactly zero. The tail underflows for a
    # large |t|, and "p = 0.0" claims certainty no finite sample supports —
    # a reader should see a bound, not an absolute.
    p = max(2.0 * student_t_sf(abs(t), df), MIN_P)

    if control.mean == 0:
        # Relative lift is undefined against a zero baseline; the absolute
        # difference and its p-value are still meaningful and are kept.
        return replace(base, p_value=p, statistic=t,
                       undecidable="baseline mean is zero, so relative lift is undefined")

    lift = diff / control.mean
    # Delta method for the ratio of two independent means:
    #   Var(μv/μc) ≈ Var(μv)/μc² + μv²·Var(μc)/μc⁴
    var_lift = (vv / variant.n) / control.mean ** 2 + \
        (variant.mean ** 2 * (vc / control.n)) / control.mean ** 4

    # The p-value is recomputed from the RELATIVE statistic, so that it tests
    # the same quantity the interval covers.
    #
    # It previously tested the absolute difference while the interval was for
    # the relative lift — two different statistics reported side by side. They
    # agree asymptotically and disagree near the boundary: measured at 300 vs
    # 350 of 3000, p = 0.0378 beside a 95% interval of [-0.003, +0.337].
    #
    # Checked against an independent reference implementation, which makes the
    # same choice: with this change the two agree to 4e-9 where they previously differed by 2e-4.
    if var_lift > 0:
        t = lift / math.sqrt(var_lift)
        p = max(2.0 * student_t_sf(abs(t), df), MIN_P)

    if var_lift <= 0:
        # Both terms vanish together only when the variant is constant AT ZERO:
        # its variance is nil, and the control term is multiplied by μv² = 0. The
        # `se_sq <= 0` guard above does not catch it, because the CONTROL still
        # has variance — so this returned a 95% interval of width exactly zero,
        # with `undecidable` unset and a confident verdict, in precisely the
        # case that matters most: the variant shipped and converted nobody.
        #
        # (A variant constant at a NON-zero value is fine and keeps its
        # interval: the control's variance alone is a real answer there.)
        return replace(base, lift=lift, p_value=p, statistic=t,
                       undecidable="the variant is constant at zero, so the relative "
                                   "lift has no sampling distribution to build an "
                                   "interval from")

    # The ONLY difference between a one-look interval and an any-look one.
    crit = (seq_multiplier(control.n + variant.n, alpha, tuning) if sequential
            else t_critical(df, alpha))
    half = crit * math.sqrt(var_lift)
    return replace(base, lift=lift, lift_ci=(lift - half, lift + half),
                   p_value=p, statistic=t)


def _undecidable(c: Comparison, why: str) -> Comparison:
    return replace(c, undecidable=why)


def verdict(c: Comparison, better: str, alpha: float = 0.05) -> str:
    """What the numbers say, in the metric's own terms.

    `better` is why this cannot be read off a p-value: the same significant
    movement is a win on conversion and a loss on latency, and a readout that
    does not know which is which will congratulate you for a regression.
    """
    if c.undecidable or c.lift is None or c.lift_ci is None:
        return "no answer"

    # The INTERVAL decides, in both modes, and never the p-value.
    #
    # Two reasons. Under a confidence sequence the p-value is still
    # fixed-horizon and would call a winner the anytime-valid interval does not
    # — reintroducing exactly the error the sequence exists to remove.
    #
    # And even on one look the two can disagree near the boundary: the p-value
    # tests the ABSOLUTE difference exactly, while the interval is a delta-method
    # approximation for the RELATIVE lift. Measured, at 300 vs 350 of 3000:
    # p = 0.0378, and a 95% interval of [-0.003, +0.337]. Reporting "better"
    # beside an interval containing zero asks a reader to believe the summary
    # over the evidence printed next to it, so the evidence wins.
    if c.lift_ci[0] <= 0 <= c.lift_ci[1]:
        return "no difference detected"
    improved = c.lift > 0 if better == "up" else c.lift < 0
    return "better" if improved else "worse"
