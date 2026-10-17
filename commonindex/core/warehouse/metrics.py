"""Metric resolution — the gate every query passes through.

The registry says what a number MEANS. Only ratified versions resolve at query
time, so a natural-language question cannot silently invent semantics, and two
dashboards cannot quietly come to disagree about "refund rate".

This module is the reason a panel cannot carry its own copy of a definition: a
panel cites an id, and the only way to turn an id into an expression is to come
through here and find something ratified.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from . import UnratifiedMetric


@dataclass(frozen=True, slots=True)
class Metric:
    """A ratified definition, at one version."""

    id: str
    version: int
    space_id: str
    label: str
    #: The aggregate, in the source's own terms. Never assembled here — it is
    #: authored, reviewed and ratified as a whole.
    expr: str
    dataset_id: str | None = None
    unit: str | None = None
    #: Which direction of this metric is good, so a verdict can be computed
    #: rather than typed in by whoever built the panel.
    better: str | None = None
    status: str = "proposed"
    ratified_by: str | None = None
    supersedes: int | None = None


class Registry(Protocol):
    async def resolve(self, space_id: str, metric_id: str) -> Metric:
        """Return the ratified version, or raise.

        Deliberately has no ``version`` parameter. A panel binding stores the
        version it was reviewed against, but *resolution* always takes the
        current ratified one — that is what makes changing a definition
        re-render every panel citing it rather than leaving old panels quietly
        on old meanings.
        """
        ...

    async def all_for(self, space_id: str, dataset_id: str | None = None) -> list[Metric]:
        """Ratified definitions only — what may be QUERIED."""
        ...

    async def all_definitions(self, space_id: str,
                              dataset_id: str | None = None) -> list[Metric]:
        """Every definition, whatever its status — what may be REVIEWED.

        The query path and the governance path want different sets, and for a
        long time only the first existed. A caller that needed to see what was
        proposed had to go around the registry to raw SQL, which is how the
        skill came to describe a set of definitions the resolver did not have:
        two readers of one table, one of them slightly wrong.

        Anything shown to a person or a model as "the definitions" belongs
        here; anything about to be compiled into SQL belongs in ``all_for``.
        """
        ...


async def require_ratified(reg: Registry, space_id: str, metric_id: str) -> Metric:
    """Resolve, and refuse anything unratified.

    Called on the query path rather than at panel-save time on purpose: a metric
    can be deprecated after a panel is built, and the panel must start failing
    visibly rather than keep serving a definition nobody stands behind.
    """
    m = await reg.resolve(space_id, metric_id)
    if m.status != "ratified":
        raise UnratifiedMetric(
            f"{metric_id} is {m.status}; only ratified definitions resolve at query time"
        )
    return m
