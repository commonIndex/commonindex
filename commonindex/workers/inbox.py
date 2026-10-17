"""Maintains a read model from the log. Materialised from events, never written
by hand, so it cannot drift from the truth it summarises."""

from commonindex.core.eventlog import Event


class Worker:
    name = "inbox"

    async def handle(self, e: Event) -> None:
        raise NotImplementedError
