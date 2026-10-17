"""The Checker, implemented.

`authz/__init__` has declared this protocol since the first commit — "one check
per operation at the gateway" — with no implementation behind it. Every
operation declared the relation it needs and nothing ever read it, so the
`grants` table stayed empty and `actor_id` arrived in the request body as a
string the caller chose for itself.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime

from . import Denied

#: Relations are ordered, not a set of independent flags. A grant of `propose`
#: satisfies an operation that needs `read`, so the check compares rank rather
#: than equality — otherwise every actor would need one grant per relation and
#: the missing one would be discovered as a denial in production.
RANK = {"read": 1, "propose": 2, "merge": 3, "admin": 4}


def hash_token(token: str) -> str:
    """What is stored. The token itself never is, so a dump of the table does
    not let the reader authenticate as anyone."""
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class Principal:
    """Who the caller actually is, as opposed to who they said they were."""

    actor_id: str
    kind: str
    trust_tier: str
    token_id: str
    #: How it was established: "token" (a bearer token: an agent, the CLI, an
    #: MCP client), "session" (a person's browser, signed in) or "proxy" (the
    #: company's network gateway vouching for them).
    via: str = "token"


class NoSuchToken(Exception):
    """Presented credential does not resolve to an actor."""


class PgChecker:
    def __init__(self, db) -> None:
        self._db = db

    async def principal(self, token: str) -> Principal:
        """Resolve a bearer token to the actor it belongs to.

        Expiry is checked here rather than by a sweep, so a token that lapses
        stops working at the next call instead of whenever a job next runs.
        """
        row = await self._db.fetchrow(
            "select t.id, t.actor_id, t.expires_at, a.kind, a.trust_tier"
            "  from actor_tokens t join actors a on a.id = t.actor_id"
            " where t.token_hash = $1", hash_token(token))
        if row is None:
            raise NoSuchToken("token does not resolve to an actor")
        if row["expires_at"] is not None and row["expires_at"] <= datetime.now(tz=UTC):
            raise NoSuchToken(f"token expired at {row['expires_at']:%Y-%m-%d}")
        # Deliberately not awaited on the hot path's critical section: last_used
        # is what makes "granted and never used" a query, and losing one write
        # to a crash is cheaper than adding a round trip to every request.
        await self._db.execute(
            "update actor_tokens set last_used = now() where id = $1", row["id"])
        return Principal(actor_id=row["actor_id"], kind=row["kind"],
                         trust_tier=row["trust_tier"], token_id=row["id"])

    async def require(self, actor_id: str, relation: str, resource: str) -> None:
        """The single check every operation makes before its handler runs."""
        need = RANK.get(relation)
        if need is None:
            # An operation asking for a relation the model does not define is a
            # bug in the operation, and failing closed is the only safe reading.
            raise Denied(f"unknown relation {relation!r}")

        rows = await self._db.fetch(
            "select id, relation, expires_at from grants"
            " where subject = $1 and resource = $2", actor_id, resource)
        now = datetime.now(tz=UTC)
        best, used = 0, None
        for r in rows:
            if r["expires_at"] is not None and r["expires_at"] <= now:
                continue
            rank = RANK.get(r["relation"], 0)
            if rank > best:
                best, used = rank, r["id"]
        if best < need:
            raise Denied(
                f"{actor_id} needs {relation} on {resource} and has "
                + (f"only {[r['relation'] for r in rows]}" if rows else "no grant"))

        # Stamp the grant that actually satisfied the check, not merely the
        # token. Without this every grant reads "never used" however busy it is,
        # and "granted in March, never once exercised" — the easiest and safest
        # revocation there is — cannot be asked at all.
        if used is not None:
            await self._db.execute(
                "update grants set last_used = now() where id = $1", used)

    async def acl_keys_for(self, actor_id: str) -> list[str]:
        """What this subject can see — the reverse expansion, for pre-filtering
        reads inside the scanning statement."""
        rows = await self._db.fetch(
            "select resource, relation from grants where subject = $1"
            "   and (expires_at is null or expires_at > now())", actor_id)
        keys = {r["resource"] for r in rows}
        # A workspace's admins see everything in it: every item carries
        # `admins:<space>` (migration 0035), and its admins hold that key.
        keys |= {"admins:" + r["resource"].removeprefix("space:") for r in rows
                 if r["relation"] == "admin" and r["resource"].startswith("space:")}
        return sorted(keys)
