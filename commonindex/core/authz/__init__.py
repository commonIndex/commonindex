"""Relationship-based authorization over the same graph the product exposes.

One check per operation at the gateway — never per field, which is why the API is
RPC-shaped rather than a query language.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


class Denied(Exception):
    pass


@dataclass(slots=True)
class Grant:
    """A tuple with two dimensions an ordinary ACL lacks: expiry and budget.

    That is what turns recertification into a query and makes "never used in its
    whole window" the easiest revocation in the queue.
    """

    id: str
    #: An actor id for native grants. Imported grants often have no actor at all
    #: — an external user, a group, a channel, or "anyone with the link" — so
    #: subject is a free string and the FK to actors was dropped. The Go skeleton
    #: kept that FK, which the review caught: N1 rules 1 and 5 had no storage.
    subject: str
    relation: str  # read | propose | merge | admin
    resource: str  # space:payments | object:doc-42

    #: Empty for native grants, "src:slack" for imported ones. N1 rule 1:
    #: imported ACLs become tuples beside native ones, never a second mechanism.
    namespace: str = ""

    granted_by: str | None = None
    expires_at: datetime | None = None
    budget_usd: float | None = None
    last_used: datetime | None = None

    #: N1 rule 5. Modelled explicitly, never approximated through inheritance —
    #: this is the classic oversharing bug in the category.
    anyone_with_link: bool = False


class Checker(Protocol):
    async def require(self, actor_id: str, relation: str, resource: str) -> None:
        """The single check every operation makes before its handler runs."""
        ...

    async def acl_keys_for(self, actor_id: str) -> list[str]:
        """The reverse expansion — what this subject can see.

        Used to pre-filter reads inside the scanning statement. Cheap enough to
        be a product feature: rendering the workspace as one agent sees it is
        this call plus a renderer.
        """
        ...

    async def recheck(self, actor_id: str, object_ids: list[str]) -> list[str]:
        """Re-verify retrieved results against a consistency token, closing the
        window between a revoked grant and a stale index."""
        ...

    async def retrievable(self, source: str) -> bool:
        """Whether a source's imported permissions are fresh enough to serve.

        N1 rule 3: past the staleness limit this returns False and the source's
        chunks drop out of retrieval entirely. Fail closed — a visibly incomplete
        answer is recoverable; a leak is not.
        """
        ...
