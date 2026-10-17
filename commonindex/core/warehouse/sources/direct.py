"""Tier B — a direct warehouse connection.

The fallback, for customers with no semantic layer. Here we do hold credentials,
so two rules apply that the other tiers do not need.

**Read-only is enforced at the warehouse, not by us.** The connection user has
SELECT and nothing else. ``Connection.read_only`` is documentation; the grant is
the control. A SQL generator that promises not to write is not a security
boundary.

**Impersonation happens at connect time.** Postgres via ``SET LOCAL ROLE``,
BigQuery via service-account impersonation or per-user OAuth, Snowflake via a
secondary role. Where the warehouse cannot, the connection is marked
shared-principal and every panel bound to it inherits that marking visibly — we
do not append predicates to compensate, which is what string-built row-level
security does and why it leaks.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime

from .. import (
    Capabilities,
    ColKind,
    Connection,
    Dataset,
    Dimension,
    Query,
    Result,
    TimeGrain,
)
from ..build import build
from ..dialects import ASYNC_DRIVERS, SPECS, EngineSpec
from ..metrics import Registry as MetricRegistry
from ..metrics import require_ratified

#: Applied to every statement. A dashboard panel that has not answered in half a
#: minute is not going to be read anyway, and an unbounded query against a
#: customer's warehouse is their bill, not ours to spend.
STATEMENT_TIMEOUT_S = 30


class DirectWarehouseSource:
    kind = "direct"

    def __init__(self, conn: Connection, metrics: MetricRegistry, engine=None,
                 declared: dict[str, Dataset] | None = None,
                 hidden: frozenset[str] = frozenset()) -> None:
        self._conn = conn
        self._metrics = metrics
        self._engine = engine  # a SQLAlchemy engine, opened with the resolved secret
        self._spec: EngineSpec = SPECS[conn.kind]
        #: Datasets someone has registered, which outrank what introspection
        #: reports. See ``_dataset`` for why that direction and not the other.
        self._declared = declared or {}
        #: Tables this connection may not read, by bare name. Set when the
        #: connection is the platform's own database, where they are the app's
        #: sessions, sign-in codes and tokens, not anybody's analytics.
        self.hidden = hidden

    def is_hidden(self, name: str) -> bool:
        """Whether `name` — `table`, `schema.table`, quoted or not — is one of
        the tables this connection may not read."""
        if not self.hidden or not name:
            return False
        bare = name.replace('"', "").replace("`", "").strip().split(".")[-1].lower()
        return bare in self.hidden

    @property
    def is_async(self) -> bool:
        """Whether this dialect has an async SQLAlchemy driver.

        Most analytical warehouses do NOT: BigQuery, Snowflake and DuckDB are all
        sync-only, and Postgres and SQLite are the exceptions. So the async path
        is the special case here, not the default — the reverse of what "any of
        fifty engines" suggests.
        """
        return self._spec.name in ASYNC_DRIVERS

    async def _do(self, fn):
        """Run one unit of work on whichever kind of engine this is.

        A sync dialect goes to a worker thread rather than blocking the loop.
        That is not a workaround: SQLAlchemy's sync engines hold the GIL only
        while marshalling, and the driver releases it over the socket, so a
        thread per in-flight query is the correct shape for a handful of
        concurrent dashboard panels.
        """
        if self.is_async:
            async with self._engine.connect() as c:
                return await fn(c)
        return await asyncio.to_thread(self._sync, fn)

    def _sync(self, fn):
        with self._engine.connect() as c:
            return fn(c)

    async def datasets(self) -> list[Dataset]:
        """Introspect via SQLAlchemy's Inspector.

        This is the half of the problem SQLAlchemy solves outright, and the
        reason ``dialects`` carries only the residue: schema and column discovery
        is uniform across every engine with a dialect, without us writing any of
        it.
        """
        from sqlalchemy import inspect

        def collect(conn):
            insp = inspect(conn)
            out: list[Dataset] = []
            for schema in insp.get_schema_names():
                if schema in _SYSTEM_SCHEMAS:
                    continue
                for table in insp.get_table_names(schema=schema):
                    if self.is_hidden(table):
                        continue
                    out.append(self._to_dataset(schema, table,
                                                insp.get_columns(table, schema=schema)))
            return out

        if self.is_async:
            async def run_it(c):
                return await c.run_sync(collect)
            return await self._do(run_it)
        return await self._do(collect)

    def _to_dataset(self, schema: str, table: str, cols: list[dict]) -> Dataset:
        dims: list[Dimension] = []
        time_col: str | None = None
        for c in cols:
            kind = self._spec.kind_of(str(c["type"]))
            # The first temporal column becomes the default time column. A
            # dataset with none cannot carry a grain, and the query builder
            # refuses rather than silently dropping it.
            if kind is ColKind.TIME and time_col is None:
                time_col = c["name"]
            # A measure can be FILTERED — `amount > 100` is the commonest
            # thing anyone asks of one — and cannot be GROUPED BY, because
            # grouping on a float gives one bucket per distinct value. These
            # were one flag, and the argument for the second was used to
            # justify refusing the first.
            dims.append(Dimension(c["name"], c["name"], kind,
                                  filterable=True,
                                  groupable=kind is not ColKind.NUMBER))
        return Dataset(
            id=f"{schema}.{table}",
            connection_id=self._conn.id,
            physical=f"{schema}.{table}" if schema else table,
            time_column=time_col,
            grains=[g for g in self._spec.grains] if time_col else [],
            dimensions=dims,
        )

    async def run(self, q: Query, as_principal: str, acl_keys: list[str] | None = None) -> Result:
        """Resolve the metric, compile, execute.

        Resolution happens here rather than in the caller so that no path exists
        which reaches SQL generation with an unratified definition.
        """
        metric = await require_ratified(self._metrics, self._conn.space_id, q.metric_id)
        return await self._execute(metric, q, as_principal)

    async def preview(self, draft, q: Query, as_principal: str, dataset: Dataset | None = None) -> Result:
        """Run a definition that is being AUTHORED, not one that is stored.

        The authoring path is the single exception to "nothing reaches SQL
        unratified", and it is a deliberate one: someone building a panel has to
        see the number before proposing it, and a definition that cannot be run
        until it is ratified can only be ratified blind.

        What keeps that from being a hole is where the exception lives. ``run``
        takes a metric *id* and can only turn it into an expression through the
        registry; ``preview`` takes the expression directly and has no id to
        store. A saved panel cites an id, so it is never served from here — the
        draft has to be written down and go through ratification first, at which
        point it renders through ``run`` like everything else.

        ``dataset`` overrides what introspection reports. The authoring flow
        needs it because introspection picks the FIRST temporal column it meets,
        and a table carrying both ``created_at`` and ``decided_at`` gives no
        signal about which one the author meant — bucketing by the wrong one is
        a different chart, not a cosmetic difference. Only the authoring path
        may substitute one; ``run`` resolves the stored dataset and cannot.
        """
        return await self._execute(draft, q, as_principal, dataset)

    async def _execute(self, metric, q: Query, as_principal: str,
                       dataset: Dataset | None = None) -> Result:
        from sqlalchemy import text

        dataset = dataset or await self._dataset(q.dataset_id)
        # SQL and its bind values come back together. They used to be built in
        # two places — the statement here, the parameters below — so an operator
        # that binds a different number of values broke one half silently.
        compiled = build(self._spec, dataset, metric, q)
        sql, params = compiled.sql, compiled.params

        setup = self._session_setup(as_principal)

        def execute(conn):
            # One transaction, so SET LOCAL scopes to this statement and cannot
            # leak an impersonated role onto a pooled connection's next user.
            with conn.begin():
                for stmt in setup:
                    conn.execute(text(stmt))
                return conn.execute(text(sql), params).mappings().all()

        async def execute_async(conn):
            async with conn.begin():
                for stmt in setup:
                    await conn.execute(text(stmt))
                return (await conn.execute(text(sql), params)).mappings().all()

        rows = await (self._do(execute_async) if self.is_async else self._do(execute))
        return _to_result(rows, q, dataset)

    def _session_setup(self, as_principal: str) -> list[str]:
        """Per-connection preamble.

        Only emitted where the dialect supports it. SQLite and DuckDB have no
        roles and no statement timeout, so the list is empty and the connection
        is honestly the shared principal — which the panel already says.
        """
        stmts = []
        # Two capabilities, read off two fields. Both used to come off
        # `caps.impersonation`, which meant one hard-coded Postgres statement
        # was sent to BigQuery, Snowflake, Trino and MSSQL — in the SAME
        # transaction as the query, so the panel died before its SQL was sent —
        # while MySQL, MariaDB and ClickHouse got no bound at all.
        if self._spec.timeout_sql:
            stmts.append(self._spec.timeout_sql(STATEMENT_TIMEOUT_S))
        if self._conn.impersonation and as_principal and self._spec.role_sql:
            stmts.append(self._spec.role_sql(as_principal.replace('"', '""')))
        return stmts

    async def _dataset(self, dataset_id: str) -> Dataset:
        """A declared dataset wins over a discovered one.

        Introspection describes the table as it is today and makes two choices
        it has no basis for: which temporal column is *the* time column, and
        which columns are legitimate to slice by. Registering a dataset is where
        someone answers both. If discovery outranked the registration, adding a
        column to the table would silently re-point every panel built on it —
        which is the failure the ``datasets`` row exists to prevent.
        """
        if self.is_hidden(dataset_id) or (dataset_id in self._declared
                                          and self.is_hidden(self._declared[dataset_id].physical)):
            raise LookupError(f"unknown dataset {dataset_id}")
        if dataset_id in self._declared:
            return self._declared[dataset_id]
        for d in await self.datasets():
            if d.id == dataset_id:
                return d
        raise LookupError(f"unknown dataset {dataset_id}")

    def caps(self) -> Capabilities:
        caps = self._spec.caps
        # A warehouse that CAN impersonate still does not, unless this
        # connection was configured for it.
        if not self._conn.impersonation:
            caps = replace(caps, impersonation=False)
        return caps


_SYSTEM_SCHEMAS = {"information_schema", "pg_catalog", "pg_toast"}


def _to_result(rows, q: Query, dataset: Dataset) -> Result:
    columns: list[tuple[str, ColKind]] = []
    if q.grain is not TimeGrain.NONE:
        columns.append(("bucket", ColKind.TIME))
    kinds = {d.name: d.kind for d in dataset.dimensions}
    for name in q.dimensions:
        columns.append((name, kinds.get(name, ColKind.STRING)))
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
