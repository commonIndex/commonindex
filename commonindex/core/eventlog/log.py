from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass(slots=True)
class Event:
    space_id: str
    seq: int
    actor_id: str
    verb: str  # object.create | proposal.file | proposal.merge | trust.promote
    object_id: str | None
    payload: dict[str, Any] = field(default_factory=dict)
    ts: datetime | None = None


class Tx(Protocol):
    """A real protocol, not an alias.

    The Go skeleton had ``type Tx = any``, which the review correctly flagged:
    ``append(None, event)`` type-checked, so the signature could not express the
    invariant its own docstring insisted on.
    """

    async def execute(self, sql: str, *args: Any) -> Any: ...

    async def fetchrow(self, sql: str, *args: Any) -> Any: ...


async def append(tx: Tx, e: Event) -> int:
    """Write an event inside a caller-supplied transaction.

    It takes a transaction rather than opening one on purpose: the entity write
    and its event MUST share a transaction. If they do not, there is no later
    mechanism that can make them agree, and every other guarantee rests on it.

    The sequence number comes from a row lock on ``space_seq``, which serialises
    writes WITHIN a space and not across them — the reason the space is the unit
    of scale.
    """
    raise NotImplementedError
