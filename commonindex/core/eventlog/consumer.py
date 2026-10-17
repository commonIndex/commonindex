from __future__ import annotations

from typing import Any, Protocol

from .log import Event


class Consumer(Protocol):
    """A read-model builder.

    Every one is identical in shape: read your offset, take events above it in
    seq order, process, advance. This is NATS with the queue replaced by a
    cursor — same replay semantics, no broker to operate.
    """

    @property
    def name(self) -> str:
        """The key in consumer_offsets."""
        ...

    async def handle(self, e: Event) -> None:
        """Process one event.

        Must be idempotent: at-least-once is the contract, and a redelivery after
        a crash is normal.
        """
        ...


async def run(c: Consumer, db: Any) -> None:
    """Drive a consumer until cancelled.

    LISTEN/NOTIFY wakes it promptly; a slow poll is the fallback, so a missed
    notification costs latency rather than correctness.
    """
    raise NotImplementedError


async def replay(c: Consumer, db: Any, space_id: str) -> None:
    """Reset to zero and rebuild everything this consumer maintains.

    The property worth protecting: because inferred edges and every index are
    derived, a better linker or chunker improves the WHOLE history, not only what
    happens next.
    """
    raise NotImplementedError
