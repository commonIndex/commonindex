"""The object graph: one objects table, one edges table.

Every thing in the workspace is an Object. They differ only in ``props``, which
the type registry validates. Nothing here knows the name of any collection.
"""

from .edge import Edge, Linked, Neighbourhood
from .object import ListQuery, Object, Store

__all__ = ["Edge", "Linked", "ListQuery", "Neighbourhood", "Object", "Store"]
