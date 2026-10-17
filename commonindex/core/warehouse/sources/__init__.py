"""The three execution tiers.

    A  semantic — the customer's own semantic layer, over MCP. Preferred,
       because we hold no warehouse credentials at all. Implemented in
       commonindex.adapters, since it is the one source that names vendors.
    B  direct   — a warehouse connection, using an EngineSpec.
    C  eventlog — the platform's own numbers. No warehouse, no credentials,
       no dialect. Built first, because it proves the whole model against data
       we already own.
"""

from .direct import DirectWarehouseSource
from .eventlog import EventLogSource

#: SemanticLayerSource is deliberately absent: it names third-party vendors,
#: so it lives in commonindex.adapters. Import it from there.
__all__ = ["DirectWarehouseSource", "EventLogSource"]
