"""The shared ingestion contract.

Differences between SaaS APIs are overwhelmingly configuration — auth style,
cursor shape, rate limit, field names — not logic. So there is one contract and a
declarative mapping per source. v1 implements exactly two: Slack and GitHub, both
read-only.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(slots=True)
class Stream:
    name: str
    #: The registry entry this stream maps into. The mapping is DATA, not code:
    #: a ticket from two different trackers is a work_item either way, with different props,
    #: and neither earns an object type of its own.
    canonical_type: str


@dataclass(slots=True)
class Record:
    id: str
    stream: str
    props: dict[str, Any] = field(default_factory=dict)
    #: A derived cache of the tuples from ``pull_acls`` — never a source of
    #: truth. Flattening imported ACLs is the leak this package's own docstring
    #: warns about, so the distinction is stated rather than implied.
    acl_keys: list[str] = field(default_factory=list)
    #: Retained verbatim — the field nobody mapped is exactly the one an agent
    #: will be asked about.
    unmapped: dict[str, Any] = field(default_factory=dict)
    #: This record is gone at the source. Not a write — a deletion is content
    #: like any other update, and a connector with no way to say "this no longer
    #: exists" leaves deleted rows searchable forever, which is both a wrong
    #: answer and a leak. The ingest side turns this into a tombstone.
    deleted: bool = False


@dataclass(slots=True)
class ACL:
    subject: str
    relation: str
    resource: str
    #: rule 5: modelled, never inherited.
    anyone_with_link: bool = False


class Connector(Protocol):
    """Five methods.

    There is deliberately no ``write``. Read-only is a principle, not a connector
    setting — it makes a class of incident impossible, because an agent cannot
    delete anything in a source system when no write path exists.
    """

    async def discover(self) -> list[Stream]: ...

    async def pull(self, stream: str, cursor: str | None) -> tuple[list[Record], str | None]:
        """Backfill and catch-up. Backfill is replay: bounded, resumable,
        observable — the same machinery as standing up a new read model."""
        ...

    async def subscribe(self, hook: Callable[[Record], None]) -> None:
        """Steady state. Poll if the source has no webhook."""
        ...

    async def fetch(self, external_id: str) -> Record:
        """One record at its current version, for repair."""
        ...

    async def pull_acls(self) -> list[ACL]:
        """Separate from content on purpose — a shorter cadence, because
        permissions change more often. N1 rule 2."""
        ...
