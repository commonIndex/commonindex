from __future__ import annotations

from typing import Any, Protocol

from .types import ObjectType, RelationType


class UnknownType(Exception):
    """A type that is absent or not ratified."""


class UnknownFacet(Exception):
    """A filter named a field the type does not declare.

    Rejected, never ignored. An ignored filter silently returns the wrong rows,
    and it is how an agent and a person come to disagree about what a collection
    contains.
    """


class Registry(Protocol):
    """Read on the hot path of every write and every list, which is why
    object_types earns typed columns rather than living in objects."""

    def get(self, type_id: str) -> ObjectType: ...

    def all(self) -> list[ObjectType]: ...

    def relation(self, relation_id: str) -> RelationType: ...

    def validate(self, t: ObjectType, props: dict[str, Any]) -> None:
        """Check props against the type's JSON Schema.

        Raises with the offending field named, so a 422 can point at it and an
        agent can correct itself rather than retry blindly.
        """
        ...
