"""Tier C — the platform's own numbers, straight off the event log.

Built first on purpose. It needs no credentials, no dialect and no external
system, so it proves panel → metric → dataset → query → result end to end against
data we already own. It is also the tier an external BI tool cannot serve at all, which is
what demonstrates the panel model is genuinely source-agnostic.

Every metric here is derived from tables the platform already maintains:
``events``, ``runs``, ``proposals``. Nothing is stored twice.
"""

from __future__ import annotations

from datetime import UTC, datetime

from .. import (
    Capabilities,
    ColKind,
    Dataset,
    Dimension,
    Query,
    Result,
    TimeGrain,
    UndeclaredDimension,
)
from ..dialects import POSTGRES
from ..metrics import Metric, require_ratified
from ..metrics import Registry as MetricRegistry

#: The datasets this tier exposes. Fixed rather than introspected, because the
#: platform's own schema is not a customer's to change.
AGENT_WORK = Dataset(
    id="platform.agent_work",
    connection_id="platform",
    physical="proposals",
    time_column="created_at",
    grains=[TimeGrain.HOUR, TimeGrain.DAY, TimeGrain.WEEK, TimeGrain.MONTH],
    dimensions=[
        Dimension("author", "author_id", ColKind.STRING),
        Dimension("space", "space_id", ColKind.STRING),
        Dimension("outcome", "status", ColKind.STRING),
        Dimension("reason", "reject_reason", ColKind.STRING),
    ],
)

RUNS = Dataset(
    id="platform.runs",
    connection_id="platform",
    physical="runs",
    time_column="started_at",
    grains=[TimeGrain.HOUR, TimeGrain.DAY, TimeGrain.WEEK],
    dimensions=[
        Dimension("agent", "agent_id", ColKind.STRING),
        Dimension("space", "space_id", ColKind.STRING),
        Dimension("state", "status", ColKind.STRING),
    ],
)

DATASETS = [AGENT_WORK, RUNS]

#: Seeded ratified definitions. These ship with the platform rather than being
#: authored per workspace, because they measure the platform itself — but they
#: still go through the same registry and the same ratification path, so a
#: workspace can supersede one if it disagrees with the definition.
SEED_METRICS = [
    Metric(
        id="agent_acceptance",
        version=1,
        space_id="*",
        label="Agent acceptance rate",
        # Share of an agent's proposals merged. The headline trust number.
        expr="COUNT(*) FILTER (WHERE status = 'merged')::float / NULLIF(COUNT(*), 0)",
        dataset_id="platform.agent_work",
        unit="pct",
        better="up",
        status="ratified",
    ),
    Metric(
        id="undo_after_merge",
        version=1,
        space_id="*",
        label="Undone after merge",
        # The number that matters most: acceptance measures whether work was
        # taken, this measures whether taking it was right.
        expr="COUNT(*) FILTER (WHERE undone_at IS NOT NULL)::float / NULLIF(COUNT(*) FILTER (WHERE status = 'merged'), 0)",
        dataset_id="platform.agent_work",
        unit="pct",
        better="down",
        status="ratified",
    ),
    Metric(
        id="review_latency_p50",
        version=1,
        space_id="*",
        label="Median review wait",
        # How long a human takes to decide. The constraint the whole seam is
        # about — agent capacity is elastic, this is not.
        expr="PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM decided_at - created_at))",
        dataset_id="platform.agent_work",
        unit="duration",
        better="down",
        status="ratified",
    ),
    Metric(
        id="run_cost",
        version=1,
        space_id="*",
        label="Agent run cost",
        expr="SUM(cost_usd)",
        dataset_id="platform.runs",
        unit="currency",
        better="down",
        status="ratified",
    ),
]


#: Named explicitly rather than "BY_ID": an earlier draft had one ambiguous name
#: here and the dev gateway imported it expecting metrics, which failed at
#: runtime rather than at import.
DATASETS_BY_ID = {d.id: d for d in DATASETS}


class EventLogSource:
    """Executes against the platform's own Postgres.

    Impersonation is trivially true here and means something slightly different
    from the other tiers: there is no second system to impersonate into, so the
    caller's ACL keys filter the same way every other read in the platform does.
    """

    kind = "eventlog"

    def __init__(self, db, metrics: MetricRegistry) -> None:
        self._db = db
        self._metrics = metrics

    async def datasets(self) -> list[Dataset]:
        return list(DATASETS)

    async def run(self, q: Query, as_principal: str, acl_keys: list[str] | None = None) -> Result:
        """Resolve, compile, execute.

        Resolution happens here rather than in the caller so no path exists that
        reaches SQL generation with an unratified definition — the same rule the
        direct tier follows, for the same reason.
        """
        metric = await require_ratified(self._metrics, q.space_id or "*", q.metric_id)
        dataset = DATASETS_BY_ID.get(q.dataset_id)
        if dataset is None:
            raise UndeclaredDimension(f"unknown dataset {q.dataset_id}")

        sql, params = compile_query(POSTGRES, dataset, metric, q, acl_keys or [])
        rows = await self._db.fetch(sql, *params)
        return to_result(rows, q, dataset)

    def caps(self) -> Capabilities:
        return Capabilities(cancel=True, impersonation=True)


def compile_query(
    spec, dataset: Dataset, metric, q: Query, acl_keys: list[str]
) -> tuple[str, list]:
    """Build parameterised SQL for the platform's own tables.

    Separate from ``build`` in build.py because this tier is not generic: it
    knows the platform's schema, so it can add the space scope and the ACL
    predicate that a customer warehouse has no equivalent of.

    Values are always bound. The window is always closed. Neither is negotiable:
    an unbounded scan of ``events`` is the largest table in the system, and
    string-built predicates leak table shape even on a read-only connection.
    """
    select: list[str] = []
    group: list[str] = []

    if q.grain is not TimeGrain.NONE:
        bucket = spec.bucket(q.grain, dataset.time_column)
        select.append(f"{bucket} AS bucket")
        group.append(bucket)

    declared = {d.name: d.column for d in dataset.dimensions}
    for name in q.dimensions:
        if name not in declared:
            raise UndeclaredDimension(name)
        select.append(f"{declared[name]} AS {name}")
        # Group by the expression, never the alias — correct on every engine, so
        # no capability branch is needed here or in build.py.
        group.append(declared[name])

    select.append(f"{metric.expr} AS value")

    params: list = []
    where: list[str] = []

    # Space scope first: it is the partition key and the most selective
    # predicate the planner will see.
    if q.space_id:
        params.append(q.space_id)
        where.append(f"space_id = ${len(params)}")

    if q.window is not None:
        params.append(q.window.start)
        where.append(f"{dataset.time_column} >= ${len(params)}")
        params.append(q.window.end)
        where.append(f"{dataset.time_column} < ${len(params)}")

    for f in q.filters:
        if f.dimension not in declared:
            raise UndeclaredDimension(f.dimension)
        params.append(f.values[0] if len(f.values) == 1 else f.values)
        op = "= ANY(" if len(f.values) > 1 else "= "
        close = ")" if len(f.values) > 1 else ""
        where.append(f"{declared[f.dimension]} {op}${len(params)}{close}")

    sql = f"SELECT {', '.join(select)} FROM {dataset.physical}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    if group:
        sql += " GROUP BY " + ", ".join(group) + " ORDER BY " + group[0]
    if q.limit:
        sql += f" LIMIT {q.limit}"
    return sql, params


def to_result(rows, q: Query, dataset: Dataset) -> Result:
    """Map driver rows into a columnar Result.

    Column order mirrors the SELECT list, so ``shape`` can find ``bucket`` and
    ``value`` by name without the two modules agreeing on anything else.
    """
    columns: list[tuple[str, ColKind]] = []
    if q.grain is not TimeGrain.NONE:
        columns.append(("bucket", ColKind.TIME))
    kinds = {d.name: d.kind for d in dataset.dimensions}
    for name in q.dimensions:
        columns.append((name, kinds[name]))
    columns.append(("value", ColKind.NUMBER))

    names = [c[0] for c in columns]
    return Result(
        columns=columns,
        rows=[[_num(r[n]) for n in names] for r in rows],
        fetched=datetime.now(tz=UTC),
    )

def _num(v):
    """Coerce driver numerics to float at the Result boundary.

    Postgres ``numeric`` arrives as ``decimal.Decimal``, which is correct for
    money and wrong for everything downstream: Decimal will not do arithmetic
    with float, so verdict() raises on a currency metric, and the cache
    serialises it with ``default=str`` — so an uncached read returns a number and
    a cached read returns a string. Found by the integration suite; no unit test
    would have, because the driver is the thing that produces it.
    """
    from decimal import Decimal

    return float(v) if isinstance(v, Decimal) else v


#: The seeded platform definitions, by id.
METRICS_BY_ID = {m.id: m for m in SEED_METRICS}
