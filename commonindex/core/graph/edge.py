from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from .object import Object


@dataclass(slots=True)
class Edge:
    """A provenance link between two objects.

    Containment is NOT an edge. A panel belongs to exactly one dashboard and is
    written knowing it — that is a foreign key on the child, with the integrity
    and cascade delete that come free. An edge is for what is discovered later,
    may be one of many, and carries its own author and confidence.
    """

    src: str
    rel: str  # caused | touches | depends | same_as | supersedes
    dst: str

    #: None for a declared edge, set for an inferred one — so a human assertion
    #: outranks a scored guess forever. Ordering relies on it: NULLS FIRST is
    #: correct rather than sloppy.
    confidence: float | None = None

    created_by: str = ""  # an actor id, or "linker"
    created_at: datetime | None = None


@dataclass(slots=True)
class Linked:
    """An edge already joined to the object on its far end.

    The join is where the permission filter applies, and it returns nothing
    rather than a redacted placeholder — a stub tells you something exists, which
    for a graph is most of the leak.
    """

    rel: str
    confidence: float | None
    object: Object


class Neighbourhood(Protocol):
    async def one_hop(
        self, object_id: str, acl_keys: list[str], limit: int = 50
    ) -> list[Linked]:
        """One hop out, in both directions.

        One hop is a product decision, not a limitation: two hops from a busy
        decision object reaches most of the workspace and no context budget holds
        it.
        """
        ...
