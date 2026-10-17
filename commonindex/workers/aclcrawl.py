"""Imports source permissions. N1, in force from connector #1.

The part of the system where a shortcut is unrecoverable. Flattening imported
ACLs is how products in this category leak, and the failure is never retrieval
quality — it is a contractor reading the board deck.
"""

from __future__ import annotations

from datetime import datetime, timedelta

#: Permissions move faster than content and are rarely webhooked, so they are
#: crawled on their own, shorter cadence. N1 rule 2.
CONTENT_CADENCE = timedelta(minutes=15)
ACL_CADENCE = timedelta(minutes=5)


class Crawler:
    name = "aclcrawl"

    async def crawl(self, source: str) -> None:
        """Pull a source's ACLs and write them as tuples.

        rule 1 · a namespace per source, beside the native tuples
        rule 5 · "anyone with the link" modelled explicitly, never approximated
                 through ReBAC inheritance
        """
        raise NotImplementedError


def retrievable(crawled_at: datetime, limit: timedelta) -> bool:
    """rule 3 · fail closed.

    Past the limit this source's chunks drop out of retrieval entirely. A visibly
    incomplete answer is recoverable; a leak is not.

    rule 4 · sensitive sources — HR, finance, legal — are additionally
    re-verified against the source itself at read time, accepting the latency.
    """
    return datetime.now(tz=crawled_at.tzinfo) - crawled_at <= limit
