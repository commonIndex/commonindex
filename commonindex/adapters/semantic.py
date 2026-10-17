"""Tier A — the customer's own semantic layer, over MCP.

Lives in ``commonindex.adapters`` rather than ``commonindex.core`` because it is the one query
source that names third-party products. The isolation guard caught it there,
which was correct: a mapping of Cube and dbt response keys is vendor knowledge,
and core is defined by not having any.

The preferred tier, and the one F4 names: *"NL→query binds to a semantic-layer
adapter (dbt metrics / Cube) before SQL generation; execution is read-only MCP
against the customer's warehouse."*

What makes it preferable is not convenience. **We hold no warehouse credentials
at all.** The semantic layer executes with the caller's own permissions already
applied, which removes the hardest problem in the category rather than solving
it — no ACL mirroring, no impersonation to arrange, no ``secret_ref`` to protect.

Structurally this is a federated source: queried at read time, never stored, the source's own check applied.
"""

from __future__ import annotations

from datetime import UTC, datetime

from commonindex.core.warehouse import (
    Capabilities,
    ColKind,
    Dataset,
    Dimension,
    Query,
    Result,
    TimeGrain,
)

#: A federated read has a deadline. Partial, labelled results beat a dashboard
#: that hangs on someone else's warehouse — the same rule the federated retrieval
#: path follows.
DEADLINE_S = 20

#: How the three vendors name the same three questions. The difference is a
#: mapping, not a subclass — the same lesson as the connector category models.
DIALECTS = {
    "semantic-cube": {
        "list": "meta",
        "run": "load",
        "metric_key": "measures",
        "dim_key": "dimensions",
    },
    "semantic-dbt": {
        "list": "list_metrics",
        "run": "query",
        "metric_key": "metrics",
        "dim_key": "dimensions",
    },
    "semantic-superset": {
        "list": "list_metrics",
        "run": "query",
        "metric_key": "metrics",
        "dim_key": "dimensions",
        # Some semantic layers' MCP services also offer get_compatible_dimensions, which
        # answers "what may this metric be sliced by" directly rather than
        # requiring the whole catalogue.
        "compatible": "get_compatible_dimensions",
    },
}

_GRAIN = {
    TimeGrain.SECOND: "second", TimeGrain.MINUTE: "minute", TimeGrain.HOUR: "hour",
    TimeGrain.DAY: "day", TimeGrain.WEEK: "week", TimeGrain.MONTH: "month",
    TimeGrain.QUARTER: "quarter", TimeGrain.YEAR: "year",
}


class SemanticLayerSource:
    """One adapter for Cube, dbt and a customer's own BI tool's MCP service.

    They differ in how they expose themselves — Cube presents cubes as
    pseudo-tables over the Postgres wire protocol, dbt exposes a manifest,
    a BI tool may ship an MCP service — but all three answer the same three
    questions: what metrics exist, what may they be sliced by, and run this.
    """

    kind = "semantic"

    def __init__(self, mcp_client, endpoint: str, flavour: str = "semantic-cube") -> None:
        self._mcp = mcp_client
        self._endpoint = endpoint
        self._d = DIALECTS[flavour]

    async def datasets(self) -> list[Dataset]:
        """Discover metrics and their compatible dimensions."""
        meta = await self._mcp.call(self._endpoint, self._d["list"], {}, timeout=DEADLINE_S)
        out: list[Dataset] = []
        for cube in meta.get("cubes", [meta]):
            dims = [
                Dimension(d["name"], d["name"], _kind(d.get("type")))
                for d in cube.get(self._d["dim_key"], [])
            ]
            time_dims = [d for d in dims if d.kind is ColKind.TIME]
            out.append(Dataset(
                id=cube.get("name", "default"),
                connection_id=self._endpoint,
                physical=cube.get("name", "default"),
                time_column=time_dims[0].column if time_dims else None,
                grains=list(_GRAIN) if time_dims else [],
                dimensions=dims,
                metric_ids=[m["name"] for m in cube.get(self._d["metric_key"], [])],
            ))
        return out

    async def run(self, q: Query, as_principal: str, acl_keys: list[str] | None = None) -> Result:
        """Hand the resolved query over and let them generate the SQL.

        No metric resolution here, deliberately: the semantic layer IS the
        registry for its own metrics, and re-resolving against ours would be two
        definitions of the same number — the exact drift this design exists to
        prevent. What we do enforce is that the metric is one the layer actually
        published, so a panel cannot cite something invented.

        ``as_principal`` is passed through so their RBAC and row-level security
        apply, which is the entire point of this tier. A layer that cannot accept
        a calling identity is not eligible for it.
        """
        payload = {
            "measures": [q.metric_id],
            "dimensions": list(q.dimensions),
            "timeDimensions": [{
                "dimension": "__time",
                "granularity": _GRAIN.get(q.grain),
                "dateRange": [q.window.start.isoformat(), q.window.end.isoformat()],
            }] if q.window and q.grain is not TimeGrain.NONE else [],
            "filters": [
                {"member": f.dimension, "operator": f.op, "values": [str(v) for v in f.values]}
                for f in q.filters
            ],
            "limit": q.limit or None,
        }
        raw = await self._mcp.call(
            self._endpoint, self._d["run"], payload,
            as_principal=as_principal, timeout=DEADLINE_S,
        )
        return _to_result(raw, q)

    def caps(self) -> Capabilities:
        # Impersonation is required here, not optional: a semantic layer that
        # executes everything as one service account gives us the
        # shared-principal problem with an extra hop.
        return Capabilities(impersonation=True, cancel=False)


def _kind(t: str | None) -> ColKind:
    return {
        "time": ColKind.TIME, "number": ColKind.NUMBER, "boolean": ColKind.BOOL,
    }.get((t or "").lower(), ColKind.STRING)


def _to_result(raw: dict, q: Query) -> Result:
    """Map the layer's row dicts into a columnar Result.

    Their key for the measure is the metric id, so it is renamed to ``value``
    here — every consumer downstream, chart and table alike, reads one shape.
    """
    columns: list[tuple[str, ColKind]] = []
    if q.grain is not TimeGrain.NONE:
        columns.append(("bucket", ColKind.TIME))
    columns += [(d, ColKind.STRING) for d in q.dimensions]
    columns.append(("value", ColKind.NUMBER))

    rows = []
    for r in raw.get("data", []):
        row = []
        if q.grain is not TimeGrain.NONE:
            row.append(r.get("__time") or r.get("bucket"))
        row += [r.get(d) for d in q.dimensions]
        row.append(_num(r.get(q.metric_id)))
        rows.append(row)

    return Result(columns=columns, rows=rows, fetched=datetime.now(tz=UTC))

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
