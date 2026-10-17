"""A v1 read-only connector on the shared ingestion contract."""

from __future__ import annotations

from collections.abc import Callable

from . import ACL, Record, Stream


class Connector:
    async def discover(self) -> list[Stream]:
        raise NotImplementedError

    async def pull(self, stream: str, cursor: str | None) -> tuple[list[Record], str | None]:
        raise NotImplementedError

    async def subscribe(self, hook: Callable[[Record], None]) -> None:
        raise NotImplementedError

    async def fetch(self, external_id: str) -> Record:
        raise NotImplementedError

    async def pull_acls(self) -> list[ACL]:
        raise NotImplementedError
