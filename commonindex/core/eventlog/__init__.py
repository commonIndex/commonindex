"""The append-only log and its consumers.

The one rule: the log is the only writer of indexes. Nothing indexes on its own
schedule; every consumer tails the same per-space, totally-ordered log.
"""

from .consumer import Consumer, replay, run
from .log import Event, Tx, append

__all__ = ["Consumer", "Event", "Tx", "append", "replay", "run"]
