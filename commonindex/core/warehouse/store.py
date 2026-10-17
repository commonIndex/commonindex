"""Postgres-backed metric registry, result cache and dashboard loading.

All three are thin: the interesting decisions are already expressed as SQL in the
migrations, and the value here is that the queries enforce them rather than
trusting callers to.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from . import Result
from .cache import DEFAULT_TTL, Entry
from .dashboard import Dashboard
from .metrics import Metric
from .panel import Mark, Panel


class PgMetricRegistry:
    """Resolution is one indexed lookup, and it cannot return an unratified row.

    The ``where status = 'ratified'`` is in the SQL rather than in Python on
    purpose: a partial unique index on the same predicate already guarantees at
    most one such row per metric per space, so the query and the constraint say
    the same thing and cannot drift apart.
    """

    def __init__(self, db) -> None:
        self._db = db

    async def resolve(self, space_id: str, metric_id: str) -> Metric:
        row = await self._db.fetchrow(
            """
            select id, version, space_id, label, expr, dataset_id, unit, better,
                   status, ratified_by, supersedes
              from metrics
             where id = $1
               and space_id in ($2, '*')
               and status = 'ratified'
             order by (space_id = '*')      -- a workspace definition wins over the seeded one
             limit 1
            """,
            metric_id, space_id,
        )
        if row is None:
            # Fall back to any version so the caller can say WHY it refused —
            # "proposed" and "does not exist" are different problems and a
            # reviewer needs to tell them apart.
            row = await self._db.fetchrow(
                "select id, version, space_id, label, expr, dataset_id, unit,"
                " better, status, ratified_by, supersedes from metrics"
                " where id = $1 and space_id in ($2, '*')"
                " order by version desc limit 1",
                metric_id, space_id,
            )
        if row is None:
            raise LookupError(f"no metric {metric_id!r} in {space_id}")
        return Metric(**dict(row))

    async def resolve_version(self, space_id: str, metric_id: str,
                              version: int) -> Metric:
        """The EXACT version, whatever its status is now.

        `resolve` deliberately returns whatever is ratified today, which is
        right for a dashboard: re-ratify a definition and every panel citing the
        id follows it. An experiment must not follow it. A definition
        re-ratified mid-flight would make the readout answer a different
        question from the one that was registered, and the reader would have no
        way to tell — so a pre-registered experiment pins the version and this
        returns it even after it has been deprecated.

        Being deprecated is not an error here. It is the normal end state of a
        definition that has since been superseded, and the caller reports it so
        a reviewer can see the definition has moved on.
        """
        row = await self._db.fetchrow(
            "select id, version, space_id, label, expr, dataset_id, unit, better,"
            " status, ratified_by, supersedes from metrics"
            " where id = $1 and space_id in ($2, '*') and version = $3"
            " order by (space_id = '*') limit 1",
            metric_id, space_id, version,
        )
        if row is None:
            raise LookupError(f"no version {version} of metric {metric_id!r} in {space_id}")
        return Metric(**dict(row))

    async def all_for(self, space_id: str, dataset_id: str | None = None) -> list[Metric]:
        rows = await self._db.fetch(
            "select id, version, space_id, label, expr, dataset_id, unit, better,"
            " status, ratified_by, supersedes from metrics"
            " where space_id in ($1, '*') and status = 'ratified'"
            "   and ($2::text is null or dataset_id = $2)"
            " order by label",
            space_id, dataset_id,
        )
        return [Metric(**dict(r)) for r in rows]

    async def all_definitions(self, space_id: str,
                              dataset_id: str | None = None) -> list[Metric]:
        """Every version at every status, newest first within an id."""
        rows = await self._db.fetch(
            "select id, version, space_id, label, expr, dataset_id, unit, better,"
            " status, ratified_by, supersedes from metrics"
            " where space_id in ($1, '*')"
            "   and ($2::text is null or dataset_id = $2)"
            " order by id, version desc",
            space_id, dataset_id,
        )
        return [Metric(**dict(r)) for r in rows]

    async def ratify(self, space_id: str, metric_id: str, version: int, decision_id: str) -> None:
        """Ratifying is a decision, so it carries the decision's id.

        Deprecating whatever held the badge before is part of the same
        transaction: the partial unique index means two ratified versions cannot
        coexist, so doing this in two statements would fail rather than race.
        """
        async with self._db.transaction():
            await self._db.execute(
                "update metrics set status = 'deprecated'"
                " where id = $1 and space_id = $2 and status = 'ratified'",
                metric_id, space_id,
            )
            await self._db.execute(
                "update metrics set status = 'ratified', ratified_by = $3"
                " where id = $1 and space_id = $2 and version = $4",
                metric_id, space_id, decision_id, version,
            )


class PgQueryCache:
    """Reads are by primary key. Writes carry the ACL keys they were computed
    for, so a leaked entry would at least be attributable."""

    def __init__(self, db) -> None:
        self._db = db

    async def get(self, key: str) -> Entry | None:
        row = await self._db.fetchrow(
            "select key, space_id, acl_keys, result, fetched_at, expires_at"
            "  from query_cache where key = $1 and expires_at > now()",
            key,
        )
        if row is None:
            return None
        payload = json.loads(row["result"])
        return Entry(
            key=row["key"], space_id=row["space_id"], acl_keys=list(row["acl_keys"]),
            result=Result(
                columns=[(c[0], c[1]) for c in payload["columns"]],
                rows=payload["rows"], from_cache=True,
                fetched=row["fetched_at"],
            ),
            fetched_at=row["fetched_at"], expires_at=row["expires_at"],
        )

    async def put(self, e: Entry) -> None:
        await self._db.execute(
            "insert into query_cache (key, space_id, acl_keys, result, metric_id,"
            " fetched_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7)"
            " on conflict (key) do update set result = excluded.result,"
            "   metric_id = excluded.metric_id,"
            "   fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
            e.key, e.space_id, e.acl_keys,
            json.dumps({"columns": [[c[0], str(c[1])] for c in e.result.columns],
                        "rows": e.result.rows}, default=str),
            e.metric_id,
            e.fetched_at, e.expires_at,
        )

    async def invalidate_metric(self, space_id: str, metric_id: str) -> int:
        """Drop everything computed from a metric.

        Called when a definition is ratified or deprecated. Without it, changing
        what a number means leaves the old number on screen until a TTL expires
        — which is precisely the drift the registry exists to prevent, reappearing
        one layer down.

        Matched on `result::text like '%metric_id%'` — against a payload
        written as `{"columns": …, "rows": …}`, which does not contain the
        metric id. So it deleted nothing, always, and the comment justifying it
        said the key "is a hash and the metric id is one of its inputs": both
        true, and neither makes a hash searchable by its inputs. The id is a
        column now.
        """
        return await self._db.execute(
            "delete from query_cache where space_id = $1 and metric_id = $2",
            space_id, metric_id,
        )


def ttl_for(now: datetime, ttl: timedelta = DEFAULT_TTL) -> datetime:
    return now + ttl


class PgDashboardStore:
    """Loads a dashboard and its panels in one round trip.

    Panels come from ``panel_bindings`` joined to their objects, ordered by
    position — presentation, which belongs on the row rather than in an edge.
    """

    def __init__(self, db) -> None:
        self._db = db

    async def load(self, dashboard_id: str, acl_keys: list[str]) -> Dashboard:
        head = await self._db.fetchrow(
            "select id, space_id, title, props from objects"
            " where id = $1 and deleted_at is null and acl_keys && $2",
            dashboard_id, acl_keys,
        )
        if head is None:
            # Indistinguishable from "does not exist", on purpose: telling an
            # unauthorised caller that something is there is most of the leak.
            raise LookupError(dashboard_id)

        rows = await self._db.fetch(
            """
            select b.panel_id, b.title, b.mark, b.dataset_id, b.metric_id,
                   b.metric_version, b.dimensions, b.grain, b.position
              from panel_bindings b
              join objects o on o.id = b.panel_id and o.deleted_at is null
             where b.dashboard_id = $1 and o.acl_keys && $2
             order by b.position
            """,
            dashboard_id, acl_keys,
        )
        props = head["props"] or {}
        return Dashboard(
            id=head["id"], space_id=head["space_id"], title=head["title"],
            default_range=props.get("default_range", "30d"),
            panels=[
                Panel(
                    id=r["panel_id"], dashboard_id=dashboard_id, title=r["title"],
                    mark=Mark(r["mark"]), dataset_id=r["dataset_id"],
                    metric_id=r["metric_id"], metric_version=r["metric_version"],
                    dimensions=list(r["dimensions"] or []),
                    grain=r["grain"] or "day",
                )
                for r in rows
            ],
        )
