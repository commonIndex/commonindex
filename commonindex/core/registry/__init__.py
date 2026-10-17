"""The type registry — the semantic layer for objects.

A type is data, not code. Everything that presents, queries, indexes or describes
a collection is generated from a registry entry, which is why adding a collection
is a JSON file rather than a service.
"""

from .registry import Registry, UnknownFacet, UnknownType
from .types import Facet, Measure, ObjectType, Presenting, RelationType

__all__ = [
    "Facet",
    "Measure",
    "ObjectType",
    "Presenting",
    "Registry",
    "RelationType",
    "UnknownFacet",
    "UnknownType",
]
