"""Vendor-specific implementations of core protocols.

Nothing in ``commonindex.core`` may name a third-party product. This package is where
that knowledge lives instead — Cube's response keys, dbt's manifest shape,
a BI tool's MCP tool names.

The boundary was found rather than designed: the semantic-layer source started in
``core/warehouse/sources`` and the isolation guard failed on its vendor field
mappings. The guard was right — a dict of Cube and dbt key names is exactly what
core is supposed not to contain, and the same reasoning that keeps collection
names out keeps vendor names out.
"""

from .semantic import SemanticLayerSource

__all__ = ["SemanticLayerSource"]
