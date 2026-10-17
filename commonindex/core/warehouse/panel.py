"""Panels and dashboard certification.

A panel is a spec — a mark, a window and a binding to a ratified metric object.
It is never a saved query carrying its own copy of a definition, which is the one
thing that stops two dashboards quietly disagreeing about the same number.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from . import Query, TimeGrain


class Mark(StrEnum):
    """How a panel draws. Deliberately small — a mark is a rendering choice, and
    growing this list is not how the product gets better."""

    STAT = "stat"
    LINE = "line"
    AREA = "area"
    BAR = "bar"
    STACKED = "stacked"
    HEATMAP = "heatmap"
    TABLE = "table"


@dataclass(slots=True)
class Panel:
    """Belongs to exactly one dashboard, and is written knowing it — so that link
    is a foreign key on this row, not an edge. Containment, not provenance."""

    id: str
    dashboard_id: str
    title: str
    mark: Mark
    dataset_id: str
    #: The binding. An id and the version it was reviewed against — resolution
    #: still takes the current ratified version, so changing a definition
    #: re-renders this panel rather than leaving it on an old meaning.
    metric_id: str
    metric_version: int
    dimensions: list[str] = field(default_factory=list)
    grain: TimeGrain = TimeGrain.DAY
    span: int = 6

    def to_query(self, window) -> Query:
        """Compile to the dialect-free query.

        ``window`` comes from the dashboard's single range control and is passed
        in rather than stored, which is what makes it impossible for two panels
        on one dashboard to quote different periods.
        """
        return Query(
            metric_id=self.metric_id,
            dataset_id=self.dataset_id,
            dimensions=list(self.dimensions),
            grain=self.grain,
            window=window,
        )


@dataclass(slots=True)
class Certification:
    """Computed from the panels, never set by hand.

    A badge someone can toggle is a badge that means nothing. This is derived on
    read, so a metric being deprecated tomorrow un-certifies the dashboard
    tomorrow, with no job to run and nobody to remember.
    """

    certified: bool
    total: int
    unratified: list[str] = field(default_factory=list)

    @property
    def reason(self) -> str:
        if self.certified:
            return "every panel cites a ratified definition"
        n = len(self.unratified)
        return f"{n} panel{'' if n == 1 else 's'} bound to a metric nobody has ratified"


def certify(panels: list[Panel], ratified_ids: set[str]) -> Certification:
    """A dashboard is certified when every panel cites a ratified definition.

    The panels that fail say so on their own face rather than looking exactly
    like the trustworthy ones — which is the difference between a dashboard you
    can act on and one you have to go and check.
    """
    unratified = [p.id for p in panels if p.metric_id not in ratified_ids]
    return Certification(
        certified=not unratified and bool(panels),
        total=len(panels),
        unratified=unratified,
    )
