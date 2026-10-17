"""Result caching, keyed so it cannot leak across principals.

Two people opening the same panel with the same range should cost one warehouse
query. That is the whole benefit, and it is easy — the hard part is the key.

A cache keyed only on the query is a cross-tenant leak wearing a performance
optimisation: every read in this platform is ACL-filtered per caller, so two
callers issuing an identical query legitimately get different rows. The key must
therefore include what the caller can see, not only what they asked for.

NOT WIRED. `PgQueryCache` is instantiated nowhere and `render` calls
`source.run` directly, so every dashboard open re-queries every panel. That is
a deliberate state to leave documented rather than discovered: wiring it would
make the dashboard's own claim — "every panel compiled to SQL and run against
<connection> when this page loaded" — false, and the freshness indicator beside
it would be reporting the cache's age as the warehouse's. Both would need to
change in the same commit that turns this on.

What was NOT deliberate is `invalidate_metric` matching a payload that never
contained the metric id, so it deleted nothing; that is fixed here, because a
cache whose invalidation does not work is worse wired than not wired at all.

"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

from . import Query, Result

#: Short by default. A dashboard is a decision aid, and a number that is fifteen
#: minutes stale is usually fine; one that is an hour stale gets quoted in a
#: meeting as if it were current.
DEFAULT_TTL = timedelta(minutes=15)


def key_for(q: Query, acl_keys: list[str], metric_version: int) -> str:
    """Derive a stable cache key.

    Three things go in, and each is load-bearing:

    * the resolved query — obviously
    * **the caller's ACL keys**, because identical queries from different
      principals return different rows
    * **the metric version**, so ratifying a new definition invalidates every
      cached result computed from the old one, rather than serving the old
      number until a TTL happens to expire
    """
    # Keys are hash inputs, not API surface, so they are named to avoid
    # colliding with collection names — core must not spell one, and a payload
    # key that happens to match today would silently stop matching if the
    # collection were renamed.
    payload = {
        "metric_id": q.metric_id,
        "metric_version": metric_version,
        "dataset_id": q.dataset_id,
        "dimensions": sorted(q.dimensions),
        "grain": str(q.grain),
        "window": [
            q.window.start.isoformat() if q.window else None,
            q.window.end.isoformat() if q.window else None,
        ],
        "filters": sorted(
            (f.dimension, f.op, [str(v) for v in f.values]) for f in q.filters
        ),
        "limit": q.limit,
        # sorted so two callers with the same grants share a key regardless of
        # the order their keys were expanded in
        "acl": sorted(acl_keys),
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


@dataclass(slots=True)
class Entry:
    key: str
    space_id: str
    acl_keys: list[str]
    result: Result
    fetched_at: datetime
    expires_at: datetime
    #: Which definition produced this. Stored so `invalidate_metric` can find
    #: it: the key is a hash with the metric id among its inputs, and a hash is
    #: not searchable by its inputs — which is why the LIKE that tried was
    #: matching a payload the id never appears in, and deleting nothing.
    metric_id: str | None = None


class Cache(Protocol):
    async def get(self, key: str) -> Entry | None: ...

    async def put(self, e: Entry) -> None: ...

    async def invalidate_metric(self, space_id: str, metric_id: str) -> int:
        """Drop everything computed from a metric.

        Called when a definition is ratified or deprecated. Without it, changing
        what a number means leaves the old number on screen until a TTL expires,
        which is exactly the drift the metric registry exists to prevent.
        """
        ...
