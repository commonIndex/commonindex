from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass(slots=True)
class Object:
    """One row in the objects table.

    Adding a collection adds rows here and a registry entry — never a table, and
    never a branch in this module.
    """

    id: str
    space_id: str
    type: str  # a registry key — one of the entries under types/
    key: str | None
    title: str
    props: dict[str, Any]
    current_rev: int

    #: The denormalised permission handle every read filters on, so a list or a
    #: traversal filters inside the statement that scans rather than authorising
    #: row by row. Native keys are computed in the write transaction; imported
    #: ones are maintained by the aclcrawl worker.
    acl_keys: list[str] = field(default_factory=list)

    created_by: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None

    #: A tombstone. Nothing is ever hard-deleted: recovery is replay, and an edge
    #: into a deleted object must still resolve.
    deleted_at: datetime | None = None


@dataclass(slots=True)
class ListQuery:
    """What a collection list is.

    Filters are validated against the type's declared facets before reaching the
    store — an unknown key raises rather than being ignored, which is also what
    makes the generated MCP arguments typed.
    """

    space_id: str
    type: str
    filters: dict[str, Any] = field(default_factory=dict)
    cursor: str | None = None
    limit: int = 60
    text: str | None = None


class Store(Protocol):
    """The read side.

    Every method takes the caller's ACL keys because there is no unfiltered read
    path — not for a person, not for an agent.
    """

    async def get(self, object_id: str, acl_keys: list[str]) -> Object | None: ...

    async def list(self, q: ListQuery, acl_keys: list[str]) -> tuple[list[Object], str | None]: ...
