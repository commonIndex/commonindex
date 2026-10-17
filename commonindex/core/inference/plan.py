"""How many units an experiment needs, before it starts.

Everything else in this package answers "what happened". This answers the
question that has to come first — "can this experiment even tell us?" — which
nothing asked. An author could pre-register a 2% effect over 14 days on a page
with 300 visitors a day, and find out three weeks later that "no difference
detected" was the only answer the design could ever have produced.

Two regimes, because the readout has two. The fixed-horizon size is the
textbook formula and is what one look at the end needs. The sequential size is
what the readout's DEFAULT needs: an always-valid interval is wider at every n,
so it takes more units to exclude zero, and quoting the textbook number for a
sequential readout would promise power it does not have. That size is found
numerically with the readout's own multiplier, so the plan and the readout can
never disagree about what the interval will be.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist

from commonindex.core.inference.stats import DEFAULT_TUNING, seq_multiplier

_Z = NormalDist()


@dataclass(frozen=True, slots=True)
class Plan:
    #: Units per arm, keyed by arm; the control first.
    per_arm: dict[str, int]
    total: int
    #: The absolute difference the relative MDE works out to.
    delta: float
    sequential: bool
    #: Days at the given daily traffic, or None when traffic is unknown.
    days: int | None
    #: What the arithmetic assumed, in words, for the page to show.
    assumptions: list[str]


def _variances(baseline: float, mde: float, *, binary: bool, sd: float | None) -> tuple[float, float]:
    if binary:
        if not 0.0 < baseline < 1.0:
            raise ValueError("a 0/1 outcome needs a baseline rate strictly between 0 and 1")
        treated = baseline * (1.0 + mde)
        if not 0.0 < treated < 1.0:
            raise ValueError(f"a {mde:+.0%} change on {baseline:.1%} leaves the 0 to 1 range")
        return baseline * (1 - baseline), treated * (1 - treated)
    if sd is None or sd <= 0:
        raise ValueError("an amount needs its standard deviation per unit (sd)")
    return sd * sd, sd * sd


def plan(*, baseline: float, mde: float, alpha: float = 0.05, power: float = 0.8,
         binary: bool = True, sd: float | None = None,
         weights: dict[str, float] | None = None, control: str = "control",
         sequential: bool = True, tuning: int = DEFAULT_TUNING,
         daily_units: float | None = None) -> Plan:
    """Units needed to detect a RELATIVE change of `mde` on `baseline`.

    `mde` is on the readout's `lift` scale: 0.02 is a 2% lift, not two points.
    Weights are the designed split; an even two-arm split when absent.
    """
    if mde == 0:
        raise ValueError("an effect of zero cannot be detected by any sample")
    if not 0 < alpha < 1 or not 0 < power < 1:
        raise ValueError("alpha and power must be between 0 and 1")
    if baseline == 0:
        raise ValueError("relative lift is undefined against a zero baseline")

    weights = weights or {control: 0.5, "variant": 0.5}
    total_w = sum(weights.values())
    if control not in weights or len(weights) < 2 or total_w <= 0:
        raise ValueError("weights must name the control and at least one variant")
    share = {k: v / total_w for k, v in weights.items()}

    v_c, v_t = _variances(baseline, mde, binary=binary, sd=sd)
    delta = abs(baseline * mde)
    z_beta = _Z.inv_cdf(power)
    # The smallest variant share decides: every arm is compared against the
    # control, and the thinnest comparison is the one that must still see it.
    thin = min(v for k, v in share.items() if k != control)

    def se(n_total: float) -> float:
        return math.sqrt(v_c / (n_total * share[control]) + v_t / (n_total * thin))

    if not sequential:
        z_alpha = _Z.inv_cdf(1 - alpha / 2)
        n_total = (z_alpha + z_beta) ** 2 * (v_c / share[control] + v_t / thin) / delta ** 2
        n_total = math.ceil(n_total)
    else:
        # Smallest N where the effect clears the always-valid boundary with the
        # asked-for power: delta >= (multiplier(N) + z_beta) * se(N). The left
        # side is fixed and the right falls monotonically, so bisect.
        def enough(n: int) -> bool:
            return delta >= (seq_multiplier(n, alpha, tuning) + z_beta) * se(n)

        lo, hi = 4, 8
        while not enough(hi):
            hi *= 2
            if hi > 10 ** 10:
                raise ValueError("no sample this side of ten billion units detects that effect")
        while hi - lo > 1:
            mid = (lo + hi) // 2
            lo, hi = (lo, mid) if enough(mid) else (mid, hi)
        n_total = hi

    per_arm = {k: math.ceil(n_total * share[k]) for k in [control, *[a for a in share if a != control]]}
    total = sum(per_arm.values())
    days = math.ceil(total / daily_units) if daily_units and daily_units > 0 else None
    assumptions = [
        (f"{'always-valid (sequential)' if sequential else 'one look at the end (fixed horizon)'}"
         f" interval at alpha {alpha:g}, {power:.0%} power"),
        f"baseline {baseline:.2%}" if binary else f"baseline {baseline:,.4g}, sd {sd:,.4g} per unit",
        f"a {mde:+.1%} relative change ({delta:,.4g} absolute)",
        "split " + " / ".join(f"{k} {v:.0%}" for k, v in share.items()),
    ]
    if daily_units:
        assumptions.append(f"about {daily_units:,.0f} new units a day across all arms")
    return Plan(per_arm=per_arm, total=total, delta=delta, sequential=sequential,
                days=days, assumptions=assumptions)
