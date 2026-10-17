"""Turning a Result into what a chart consumes.

The panel decides the mark; this decides the shape. Kept separate from rendering
so that the table view and the chart view are provably the same numbers — a chart
that disagrees with its own table is a bug people find in production and never
trust the tool again after.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import Result


@dataclass(slots=True)
class Series:
    """One line, area or column group."""

    name: str
    points: list[tuple[Any, float | None]] = field(default_factory=list)


@dataclass(slots=True)
class Shaped:
    """A Result reorganised for drawing, plus everything a reader needs to judge
    it: the unit, which direction is good, and when it was fetched."""

    series: list[Series]
    unit: str | None = None
    better: str | None = None
    fetched: datetime | None = None
    from_cache: bool = False

    @property
    def is_empty(self) -> bool:
        return not any(s.points for s in self.series)


def shape(result: Result, unit: str | None = None, better: str | None = None) -> Shaped:
    """Pivot a columnar result into series.

    The convention comes from the query builder: the time bucket is named
    ``bucket`` when a grain was requested, the measure is always ``value``, and
    anything else is a dimension the rows should be split by.

    A result with no dimension column is one series. With one, it is one series
    per distinct value — which is what a stacked or multi-line panel draws.
    """
    names = [c[0] for c in result.columns]
    if "value" not in names:
        return Shaped(series=[], unit=unit, better=better,
                      fetched=result.fetched, from_cache=result.from_cache)

    vi = names.index("value")
    bi = names.index("bucket") if "bucket" in names else None
    dims = [i for i, n in enumerate(names) if i != vi and i != bi]

    buckets: dict[str, Series] = {}
    for row in result.rows:
        # Series name is the dimension combination; with no dimensions every row
        # belongs to one unnamed series.
        label = " · ".join(str(row[i]) for i in dims) if dims else "value"
        x = row[bi] if bi is not None else label
        buckets.setdefault(label, Series(name=label)).points.append((x, row[vi]))

    return Shaped(
        series=list(buckets.values()),
        unit=unit,
        better=better,
        fetched=result.fetched,
        from_cache=result.from_cache,
    )


def verdict(current: float, previous: float | None, better: str | None) -> str | None:
    """Whether a change is good, computed from the metric rather than typed in.

    ``better`` comes off the ratified definition, so a panel cannot claim a fall
    in error rate is bad because whoever built it picked the wrong arrow. Returns
    None when there is no prior window to compare against — which is honest, and
    better than showing a zero.
    """
    if previous is None or previous == 0 or better is None:
        return None
    delta = (current - previous) / previous
    if delta == 0:
        return "flat"
    rose = delta > 0
    return "good" if rose == (better == "up") else "bad"
