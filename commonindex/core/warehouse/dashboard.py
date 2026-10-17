"""The dashboard aggregate — panels under one range control.

One control scopes every panel below it, so the tiles and the charts can never
quote different windows. That is not a convenience: a dashboard whose KPI tile
shows last-7-days beside a chart showing last-30 is the everyday way a team ends
up arguing about a number that was never in dispute.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from . import Query, Window
from .panel import Certification, Panel, certify

#: What the range control offers. Deliberately few — every extra option is
#: another way for two people to be looking at different periods while believing
#: they are looking at the same dashboard.
#: The shapes a panel can be stored as.
#:
#: There were four lists of these — the CHECK constraint, the schema an agent
#: reads, the client's wire mapping, and the dropdown an author picks from —
#: and they had drifted apart. `stacked`, `heatmap` and `table` render
#: correctly, are accepted by the database and are mapped by the client, and
#: neither authoring surface offered them: three working chart types nobody
#: could choose. This is the list; everything else derives from it.
MARKS: tuple[str, ...] = (
    "stat", "line", "area", "bar", "stacked", "heatmap", "table", "sql",
    # Three more readings of the numbers a panel already holds: the share each
    # series takes of the whole, one number against the range it has been in,
    # and the table with its margins. See 0016 for the two that were left out
    # and why — a gantt needs a start and an end per row, which is a different
    # query rather than a different drawing of this one.
    "pie", "gauge", "pivot",
)

#: The subset an author picks from a menu.
#:
#: `sql` is missing on purpose — a panel carrying its own query is chosen by
#: writing one, not by picking a shape, and offering it here would ask somebody
#: to select "sql" and then wonder where to type it.
AUTHORABLE_MARKS: tuple[str, ...] = tuple(m for m in MARKS if m != "sql")

#: The windows a dashboard can be read over.
#:
#: One control for the whole page, so a tile and the chart above it can never
#: quote different periods — that part was right and is unchanged. What was
#: wrong is that three was the whole list: no yesterday, no "this quarter
#: against last", no year. A reader who wanted a fortnight had to pick 7 and be
#: wrong or 30 and be wrong, which is how people end up exporting to a
#: spreadsheet and doing it there, where nothing is certified at all.
RANGES: dict[str, timedelta] = {
    "1d": timedelta(days=1),
    "7d": timedelta(days=7),
    "14d": timedelta(days=14),
    "30d": timedelta(days=30),
    "60d": timedelta(days=60),
    "90d": timedelta(days=90),
    "180d": timedelta(days=180),
    "365d": timedelta(days=365),
}


#: From the start of this month, quarter or year until now.
TO_DATE = ("mtd", "qtd", "ytd")

#: A named span of days, both ends included: `2026-08-01..2026-08-31`.
_SPAN = re.compile(r"^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$")

#: The longest span that can be named. Longer is an export, not a reading, and
#: a window is what keeps a dashboard from scanning a fact table whole.
LONGEST = timedelta(days=3 * 366)


def resolve_range(key: str | None, now: datetime) -> Window:
    """The window a range names: a preset (`30d`), a calendar period to date
    (`mtd`, `qtd`, `ytd`), or a span of dates, both ends included. Days start
    at midnight UTC. Raises ValueError, in words a reader can act on."""
    key = key or "30d"
    if key in RANGES:
        return Window(now - RANGES[key], now)
    if key in TO_DATE:
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if key == "qtd":
            start = start.replace(month=(now.month - 1) // 3 * 3 + 1)
        elif key == "ytd":
            start = start.replace(month=1)
        return Window(start, now)
    m = _SPAN.match(key)
    if not m:
        raise ValueError(f"range is one of {', '.join(RANGES)}, {', '.join(TO_DATE)}, "
                         "or dates like 2026-08-01..2026-08-31")
    try:
        start = datetime.fromisoformat(m[1]).replace(tzinfo=UTC)
        end = datetime.fromisoformat(m[2]).replace(tzinfo=UTC) + timedelta(days=1)
    except ValueError as e:
        raise ValueError(f"{key} names a day that does not exist") from e
    if end <= start:
        raise ValueError("a range ends on or after the day it starts")
    if end - start > LONGEST:
        raise ValueError("a range spans at most three years")
    return Window(start, end)


def previous(w: Window) -> Window:
    """The window of the same length that ends where this one starts."""
    return Window(w.start - (w.end - w.start), w.start)


@dataclass(slots=True)
class Dashboard:
    id: str
    space_id: str
    title: str
    panels: list[Panel] = field(default_factory=list)
    default_range: str = "30d"

    def window(self, now: datetime, range_key: str | None = None) -> Window:
        span = RANGES[range_key or self.default_range]
        return Window(start=now - span, end=now)

    def queries(self, now: datetime, range_key: str | None = None) -> list[tuple[Panel, Query]]:
        """Compile every panel against ONE window.

        Returning pairs rather than a dict keeps panel order, and returning the
        panel alongside its query means the caller cannot accidentally render a
        result under the wrong panel — a mismatch nobody would notice until the
        numbers were already in a slide.
        """
        w = self.window(now, range_key)
        return [(p, p.to_query(w)) for p in self.panels]

    def certification(self, ratified_ids: set[str]) -> Certification:
        return certify(self.panels, ratified_ids)

    @property
    def metric_ids(self) -> list[str]:
        """Every definition this dashboard depends on, deduplicated in order.

        This is what makes "changing a metric re-renders every panel citing it"
        a query rather than a search.
        """
        seen: dict[str, None] = {}
        for p in self.panels:
            seen.setdefault(p.metric_id, None)
        return list(seen)
