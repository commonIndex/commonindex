"""Writes provenance edges by tailing the log.

Where most edges come from, and it needs no user action: an event arrives, the
linker reads the object, and looks for connections the rest of the graph implies.
A merged PR touching a path eight docs cite becomes eight edges.

Inference precision is the whole risk of the graph design — a linker that writes
plausible-but-wrong edges degrades every downstream answer at once, and quietly.
Start the floor high.
"""

from commonindex.core.eventlog import Event

#: Below this, the linker files a proposal instead of writing an edge. It does
#: not guess and it does not silently write.
FLOOR = 0.85


class Linker:
    name = "linker"

    async def handle(self, e: Event) -> None:
        # candidates -> score -> above FLOOR: write the edge with its confidence
        #                        below FLOOR: file a proposal, a human decides
        # every edge checked against relation_types before it is written
        raise NotImplementedError
