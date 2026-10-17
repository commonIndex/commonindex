"""The write path. Agents propose by default; a merge is a reviewed decision.

Nothing here is irreversible, because undo is replay.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol


class Status(StrEnum):
    PENDING = "pending"
    MERGED = "merged"
    REJECTED = "rejected"


class RejectReason(StrEnum):
    """The learning signal.

    An unexplained rejection lowers an acceptance rate and teaches the skill
    nothing — and these three are genuinely different corrections, not shades of
    "no".
    """

    #: Becomes a negative case in the skill's eval set.
    MERITS = "merits"
    #: Narrows the trigger, not the edit.
    SCOPE = "scope"
    #: Raises a decision and re-queues the pattern behind it.
    NEEDS_DECISION = "needs-decision"


class DeltaKind(StrEnum):
    PROPS = "props"
    GITREF = "gitref"
    #: Reserved. Not written in v1 — CRDT sync is phase 2 — but kept in the check
    #: constraint so phase 2 is a grant of scope rather than a migration.
    CRDT = "crdt"


@dataclass(slots=True)
class ContextEntry:
    kind: str  # object | provenance | events | definition
    label: str
    ref: str
    tokens: int
    rev: int | None = None
    dropped: bool = False


@dataclass(slots=True)
class Receipt:
    """Show-your-work for an agent.

    The section that matters is the dropped entries. An agent that read the wrong
    thing is rare; an agent that never saw the object which would have changed
    its mind is the ordinary failure, and it is invisible everywhere else.
    """

    run_id: str
    model: str
    budget: int
    used: int
    entries: list[ContextEntry] = field(default_factory=list)

    #: Objects that matched retrieval but sat outside the agent's grants.
    #: Counted, never named — the count is not the leak.
    withheld: int = 0


@dataclass(slots=True)
class Proposal:
    id: str
    space_id: str
    target_id: str
    base_rev: int
    delta_kind: DeltaKind
    delta: dict[str, Any]
    author_id: str
    status: Status = Status.PENDING
    reject_reason: RejectReason | None = None

    #: Groups proposals that are one edit applied in N places, so the unit of
    #: review is the edit rather than the instance. None when it stands alone.
    pattern_key: str | None = None

    receipt: Receipt | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    created_at: datetime | None = None


class Grouper(Protocol):
    """Decides that N proposals are one edit applied in N places.

    The highest-risk component in v1, and its precision is load-bearing in a way
    most classifiers are not: a WRONG group is worse than no group, because
    grouping is an invitation to merge in bulk, and a reviewer burned once stops
    trusting every batch afterwards.

    Start conservative. A missed grouping costs a reviewer some repetition; a
    false grouping costs the surface its credibility.
    """

    def key(self, p: Proposal) -> str | None:
        """A stable pattern key, or None to stand alone. None is always safe."""
        ...

    def deviations(self, group: list[Proposal]) -> list[tuple[str, str]]:
        """(proposal_id, reason) for members that differ from the shared edit.

        Lifted out by name and excluded from the bulk action — a batch that
        quietly swallows its exceptions is the failure this design prevents.
        """
        ...


async def file(tx: Any, p: Proposal) -> None:
    """Write a proposal without touching the object."""
    raise NotImplementedError


async def merge(tx: Any, proposal_id: str, actor_id: str) -> None:
    """Apply the delta by kind, in one transaction with its event.

    Every change to an object has a proposal row behind it, INCLUDING an
    auto-merged one. That makes "was this reviewed, by whom, was it later undone"
    one query shape rather than three — and undo-after-merge, the number that
    matters most for trust, computable for every change.
    """
    raise NotImplementedError
