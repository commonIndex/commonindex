"""The type contract. Six parts, each with at least two consumers — that test is
what stops the registry becoming a dumping ground."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Kind = Literal["enum", "actor", "date", "number"]
Status = Literal["proposed", "ratified", "deprecated"]


@dataclass(frozen=True, slots=True)
class Presenting:
    """How a row shows itself. Read by every list view, the command palette,
    search results, and an agent's summariser."""

    key: str
    title: str
    subtitle: list[str] = field(default_factory=list)
    preview: str = ""
    status: str | None = None


@dataclass(frozen=True, slots=True)
class Facet:
    """The ONLY legal filter keys.

    ``values`` carries the domain. The Go skeleton omitted it, which the review
    caught: without a domain the generated MCP arguments cannot actually be
    typed, so the parity claim was unachievable.
    """

    field: str
    kind: Kind
    values: list[str] = field(default_factory=list)
    attention: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class Measure:
    name: str
    field: str
    agg: Literal["sum", "avg", "count"]
    unit: str | None = None
    better: Literal["up", "down"] | None = None


@dataclass(frozen=True, slots=True)
class ObjectType:
    id: str
    label: str
    plural: str

    #: JSON Schema for props — the constraint jsonb otherwise lacks.
    schema: dict[str, Any]

    presenting: Presenting
    facets: list[Facet] = field(default_factory=list)
    measures: list[Measure] = field(default_factory=list)

    #: Which fields are natural language. THIS IS THE EMBEDDING POLICY.
    #: Empty means nothing here is embedded — correct for releases, runs,
    #: events and grants.
    prose: list[str] = field(default_factory=list)

    #: What the item's page shows that is stored beside it — a dashboard's
    #: panels, an experiment's readouts — indexed as sections of the item.
    #: Each names a reader in commonindex/workers/parts.py.
    parts: list[str] = field(default_factory=list)

    #: Ids into relation_types: legal PROVENANCE edges only. Anything a type
    #: merely contains is a foreign key on the child and needs no entry.
    relations: list[str] = field(default_factory=list)

    version: int = 1
    status: Status = "proposed"
    #: Where instances live. "graph" means the shared objects table, and is the
    #: default. "registry" means the type keeps its own versioned store with its
    #: own lifecycle — a metric is proposed, ratified and deprecated in the
    #: metrics table, and is never a row in `objects`.
    #:
    #: This is not a detail. Generated list/get/propose operations address the
    #: graph, so generating them for a registry-backed type produces handlers
    #: that answer confidently about the wrong table: `metrics.get` reported a
    #: ratified definition as missing because it looked for an object that has
    #: never existed.
    store: str = "graph"
    #: The relation `<plural>.propose` needs. Most items anyone who can propose
    #: may make; a type whose instances are written by a pipeline names a
    #: stronger one, so its generated propose is not a side door around it.
    propose_relation: str = "propose"



@dataclass(frozen=True, slots=True)
class RelationType:
    """Which edges are legal between which types. The linker checks against this,
    which is what stops inference inventing relationships."""

    id: str
    src_type: str
    rel: str
    dst_type: str
    cardinality: Literal["one", "many"]
    label: str
    inverse: str
    status: Status = "proposed"


def load_dir(path) -> list[ObjectType]:
    """Read every type declaration in a directory.

    Lived in the parity test, which meant the test knew about a set of types the
    application had never loaded — the app registered `register_type_ops(reg,
    [])` and the test registered five types, so the two were asserting parity
    over different registries. One loader, both callers.
    """
    import json
    from pathlib import Path

    out = []
    for f in sorted(Path(path).glob("*.json")):
        d = json.loads(f.read_text())
        out.append(ObjectType(
            id=d["id"], label=d["label"], plural=d["plural"], schema=d["schema"],
            presenting=Presenting(**d["presenting"]),
            facets=[Facet(**x) for x in d.get("facets", [])],
            measures=[Measure(**m) for m in d.get("measures", [])],
            prose=d.get("prose", []), parts=d.get("parts", []), relations=d.get("relations", []),
            version=d.get("version", 1), status=d.get("status", "proposed"),
            store=d.get("store", "graph"), propose_relation=d.get("propose_relation", "propose"),
        ))
    return out
