"""The operation registry — one definition per operation, emitting every target.

The protocol is RPC over HTTP: an operation name IS its MCP tool name IS its
URL path (`POST /api/v1/<operation>`). An early design (backend/DESIGN.md §6)
planned GraphQL for the web client instead; it was not built, and another
emitter could join the others here without changing anything else.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from commonindex.core.registry import ObjectType

Handler = Callable[[Any, dict[str, Any]], Awaitable[Any]]


@dataclass(slots=True)
class Op:
    """One operation, defined once."""

    name: str  # "experiments.list" — also the MCP tool and the URL path
    #: The ReBAC relation checked before the handler runs. One check, per
    #: operation, at the gateway.
    relation: str
    description: str = ""
    #: JSON Schema for the input. The Go skeleton had no such field, so every
    #: registered operation reached agents as an argument-less tool.
    input_schema: dict[str, Any] = field(default_factory=dict)
    #: Mutating operations require an idempotency key and, for agents, pass a
    #: budget check at admission rather than being cleaned up afterwards.
    mutating: bool = False
    handler: Handler | None = None


class Registry:
    """Holds every operation. Every protocol target is generated from this one
    object, which is what makes UI/API parity structural."""

    def __init__(self) -> None:
        self._ops: dict[str, Op] = {}

    def register(self, op: Op) -> None:
        if op.name in self._ops:
            raise ValueError(f"duplicate operation {op.name}")
        self._ops[op.name] = op

    def all(self) -> list[Op]:
        return list(self._ops.values())

    def get(self, name: str) -> Op | None:
        return self._ops.get(name)


def register_type_ops(reg: Registry, types: list[ObjectType]) -> None:
    """Register list/get/propose for every ratified type INTO the one registry.

    This fixes the defect the review found in the Go skeleton: the MCP emitter
    synthesised per-type tools itself while the HTTP router only ever saw ops, so
    agents were offered three tools per collection that no route served. Parity
    was broken on day one, by the very code whose docstring promised it.

    Registering them here means both emitters read ``reg.all()`` and nothing
    else, so they cannot disagree.
    """
    for t in types:
        if t.status != "ratified":
            continue
        if t.store != "graph":
            # A registry-backed type keeps its own store and its own lifecycle,
            # so a generated list/get/propose over `objects` would address the
            # wrong table. Its operations are written by hand instead —
            # metrics.list and metrics.ratify know what a ratified version is.
            continue
        reg.register(Op(
            name=f"{t.plural.lower()}.list",
            relation="read",
            description=f"List {t.plural}.",
            input_schema=_facet_schema(t),
        ))
        reg.register(Op(
            name=f"{t.plural.lower()}.get",
            relation="read",
            input_schema={
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        ))
        reg.register(Op(
            name=f"{t.plural.lower()}.propose",
            relation=t.propose_relation,
            mutating=True,
            input_schema=_propose_schema(t),
        ))


def _facet_schema(t: ObjectType) -> dict[str, Any]:
    """Facets become typed arguments, with their value domains.

    An agent cannot filter on a field the interface has no chip for, and a person
    cannot see a column the agent cannot query — UI/API parity as a build
    artifact rather than a review checklist.
    """
    props: dict[str, Any] = {}
    for f in t.facets:
        if f.kind == "enum" and f.values:
            props[f.field] = {"type": "string", "enum": list(f.values)}
        elif f.kind == "number":
            props[f.field] = {"type": "number"}
        elif f.kind == "date":
            props[f.field] = {"type": "string", "format": "date-time"}
        else:
            props[f.field] = {"type": "string"}
    props["cursor"] = {"type": "string"}
    props["limit"] = {"type": "integer"}
    props["preview"] = {"type": "boolean", "description":
                        "Only what a gallery card needs, for a type that has a lighter form "
                        "of its items; ignored by the rest"}
    return {"type": "object", "properties": props}


def _propose_schema(t: ObjectType) -> dict[str, Any]:
    """The props schema plus the idempotency key every mutation requires."""
    props = dict(t.schema.get("properties", {}))
    props["idempotencyKey"] = {"type": "string"}
    out: dict[str, Any] = {
        "type": "object",
        "properties": props,
        "required": [*t.schema.get("required", []), "idempotencyKey"],
    }
    # A recursive type (a block tree) points into its own `$defs`. Copying the
    # properties without them hands every MCP client a `$ref` to nothing.
    if "$defs" in t.schema:
        out["$defs"] = t.schema["$defs"]
    return out
