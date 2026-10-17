"""Building a dashboard from a table, as operations.

This is the path a person takes in the UI — pick a connection, pick a table,
pick a number, see it, save it — and the same four operations an agent calls to
do it unattended. There is no separate authoring API.

The rule that shapes all of it: **a panel never carries its own definition.**
Letting a chart define an adhoc metric inline is how six charts
come to mean six different things by "refund rate". Here the last step of
creating a dashboard writes each definition into the metric registry as a
*proposed* version, and the panel cites its id. The dashboard is therefore born
uncertified, and says so — which is the correct state for numbers nobody has
reviewed yet, and the thing a BI tool has no way to express.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections import OrderedDict
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import ArgumentError, SQLAlchemyError

from commonindex.core.warehouse import (
    ColKind,
    Connection,
    Dataset,
    Dimension,
    Filter,
    Query,
    TimeGrain,
    UndeclaredDimension,
    Window,
)
from commonindex.core.warehouse.build import OPS, BadFilter, coerce_values, quote
from commonindex.core.warehouse.dashboard import RANGES
from commonindex.core.warehouse.series import shape
from commonindex.core.warehouse.sources.direct import DirectWarehouseSource
from commonindex.gateway import secrets
from commonindex.gateway.auth import actor_of, space_of
from commonindex.workers.indexer import index_object, index_users_of

router = APIRouter()

#: The aggregates offered. A closed set, not a free-text expression box: every
#: one of these is rendered into SQL, so the moment it is open text the endpoint
#: is a query console with a chart on top.
AGGS: dict[str, str] = {
    "count": "COUNT(*)",
    "sum": "SUM({col})",
    "avg": "AVG({col})",
    "min": "MIN({col})",
    "max": "MAX({col})",
    "count_distinct": "COUNT(DISTINCT {col})",
    # ── the two that make a RATE expressible ─────────────────────────────
    # "Refund rate" is the example this product uses to explain itself, in the
    # schema comments and in the UI copy, and until now the builder could not
    # express it: six aggregates, none of them a division. A dashboard tool
    # whose headline example it cannot build is not finished.
    #
    # `* 1.0` rather than a cast, because CAST syntax differs per engine and
    # this does not; NULLIF so an empty denominator is null rather than a
    # division error that takes the panel down.
    "ratio": "SUM({col}) * 1.0 / NULLIF(SUM({den}), 0)",
    # The share of rows matching a value — "what fraction were refunds".
    "share": "AVG(CASE WHEN {col} = {lit} THEN 1.0 ELSE 0.0 END)",
}

#: Aggregates needing a second column, and ones needing a literal value.
NEEDS_DEN = {"ratio"}
NEEDS_VALUE = {"share"}

#: Columns whose name suggests money. A guess, offered as a default the author
#: can override — never applied silently, because a mislabelled unit is a
#: wrong number that looks right.
_CURRENCY = re.compile(r"(?:^|_)(?:cost|price|amount|revenue|spend|usd)(?:_|$)", re.IGNORECASE)
_COUNT_UNIT = re.compile(r"(?:^|_)(?:tokens?|counts?|bytes?)(?:_|$)", re.IGNORECASE)


def _with_secret(dsn: str, password: str | None):
    """Put the credential back for the length of one connect.

    Parsed and rebuilt, never spliced. The string version — inserting
    ``:password@`` before the first ``@`` — broke on ordinary passwords, and
    broke silently:

      ``p@ss``      → password ``p``, host ``ss@localhost`` → reported as a bad host
      ``abc%2fdef`` → password ``abc/def``, because the URL is percent-decoded
      any, no user  → no ``@`` in the DSN at all, so the password vanished and
                      the probe SUCCEEDED against a trust-auth database,
                      saving a connection whose credential is never used

    ``URL.set`` percent-encodes the password itself and cannot be confused by
    what is in it.
    """
    from sqlalchemy.engine import make_url

    url = make_url(dsn)
    return url.set(password=password) if password else url


def _engine(state: dict, conn_id: str, dsn: str, kind: str, read_only: bool = False):
    """One engine per connection, kept for the process.

    Introspection opens a connection per call and a wizard introspects on every
    step; without this the third step of the flow is slower than the query it is
    building.

    The ENGINE has to match the driver. This built an async engine for every
    connection while only Postgres and SQLite have async drivers — so a DuckDB,
    BigQuery or Snowflake connection failed at creation with "the asyncio
    extension requires an async driver". Five engines were offered by the
    schema, the operation and the UI, and two of them worked.
    `DirectWarehouseSource` has always handled both shapes; it was only ever
    handed one.
    """
    cache = state.setdefault("engines", {})
    if conn_id not in cache:
        cache[conn_id] = _make_engine(dsn, kind, read_only,
                                      pool_size=2, max_overflow=2)
    return cache[conn_id]


#: Engines whose database is a FILE, with no server behind it.
#:
#: `direct.py` states the rule for everything else, and is right about it:
#: read-only is enforced at the warehouse, the connection user holds SELECT and
#: nothing else, and `Connection.read_only` is documentation rather than a
#: control. A SQL generator promising not to write is not a security boundary.
#:
#: That argument assumes a warehouse to hold the grant. These have none. There
#: is no server, no role and no GRANT to write — the file IS the database, and
#: how it is opened is the only control there is. So the stated principle had
#: no mechanism here, and the consequence was worse than a missing guarantee:
#: opened read-write, DuckDB and SQLite CREATE a database at a path that does
#: not exist. A typo'd path became an empty warehouse, `connections.check`
#: passed against it, and every panel then failed with "table does not exist".
FILE_BACKED = {"duckdb", "sqlite"}


def _read_only_args(kind: str, read_only: bool) -> dict:
    """How to open a file-backed database without being able to write to it."""
    if not read_only or kind not in FILE_BACKED:
        return {}
    if kind == "duckdb":
        # Also refuses to create one, which is the half that turns a bad path
        # into an error instead of an empty database.
        return {"connect_args": {"read_only": True}}
    # SQLite says it in the URL rather than in connect_args.
    return {}


def _read_only_dsn(dsn: str, kind: str, read_only: bool) -> str:
    if read_only and kind == "sqlite" and "mode=ro" not in dsn:
        sep = "&" if "?" in dsn else "?"
        return f"{dsn}{sep}mode=ro&uri=true"
    return dsn


def _make_engine(dsn: str, kind: str, read_only: bool = False, **kw):
    """Async where the driver is async, sync where it is not."""
    from commonindex.core.warehouse.dialects import ASYNC_DRIVERS

    dsn = _read_only_dsn(dsn, kind, read_only)
    if kind in ASYNC_DRIVERS:
        from sqlalchemy.ext.asyncio import create_async_engine

        return create_async_engine(dsn, **kw)
    from sqlalchemy import create_engine

    # A sync driver gets no async pool arguments: duckdb_engine and the
    # BigQuery dialect manage their own connections and reject the extras.
    return create_engine(dsn, **_read_only_args(kind, read_only))


async def _source(state: dict, conn_id: str, space: str) -> tuple[DirectWarehouseSource, dict]:
    """Open a connection, scoped to the space the caller holds a grant for.

    The lookup was `where id = $1`. A connection id is not a secret — it is in
    every dashboard row, every panel binding and every skill file — and this
    decrypted the stored credential and opened the warehouse for any id at all.
    """
    row = await state["pool"].fetchrow(
        "select id, space_id, name, kind, dsn, secret_ref, impersonation, read_only"
        " from connections where id = $1 and space_id = $2", conn_id, space)
    if row is None:
        raise NoSuchConnection(conn_id)
    conn = Connection(
        id=row["id"], space_id=row["space_id"], kind=row["kind"], dsn=row["dsn"],
        impersonation=row["impersonation"], read_only=row["read_only"],
    )
    password = await secrets.get(state["pool"], row["secret_ref"])
    src = DirectWarehouseSource(conn, state["metrics"],
                                _engine(state, conn_id,
                                        _with_secret(row["dsn"], password), row["kind"],
                                        row["read_only"]),
                                declared=await _declared(state, conn_id),
                                hidden=app_tables() if is_platform_db(row["dsn"]) else frozenset())
    return src, dict(row)


def app_tables() -> frozenset[str]:
    """The platform's own tables, read off its migrations so a new one is
    covered the day it is added rather than the day somebody remembers."""
    global _APP_TABLES
    if _APP_TABLES is None:
        from pathlib import Path

        found: set[str] = set()
        for f in sorted((Path(__file__).resolve().parents[2] / "migrations").glob("*.sql")):
            found |= {m.lower() for m in re.findall(
                r"(?i)create\s+table\s+(?:if\s+not\s+exists\s+)?(?:\w+\.)?\"?(\w+)\"?", f.read_text())}
        _APP_TABLES = frozenset(found)
    return _APP_TABLES


_APP_TABLES: frozenset[str] | None = None


def is_platform_db(dsn: str | None) -> bool:
    """Whether a connection points at the database this gateway runs on.

    "Platform Postgres" is that database, registered as a warehouse so a new
    workspace has real tables to chart. Through it, `select * from sessions`
    read everyone's sign-in sessions: same host, same database, same login. So
    on that connection the app's own tables are not tables anybody may chart.
    """
    if not dsn:
        return False
    from sqlalchemy.engine import make_url

    from commonindex.gateway.app import DSN as own
    try:
        a, b = make_url(dsn), make_url(own)
    except Exception:  # noqa: BLE001 - an unparseable DSN is not ours
        return False
    def key(u):
        host = (u.host or "localhost").lower()
        return ("localhost" if host in ("127.0.0.1", "::1") else host, u.port or 5432, (u.database or "").lower())
    return key(a) == key(b)


async def _may_ratify(conn, actor_id: str) -> tuple[bool, str]:
    """Whether this author's own new definitions arrive ratified.

    Ratification exists so two dashboards cannot quietly disagree about "refund
    rate". That bites when someone ELSE's dashboard cites your metric, or when
    you change one people already quote — not on your own brand-new dashboard,
    where you are the only party and the approval is a formality you grant
    yourself in one click. A rubber stamp is not governance; it is a step that
    teaches nothing and trains people to click through the one that matters.

    So the question is not "was this ratified" but "may this author stand behind
    their own work", which is what ``trust_tier`` already answers. A person can.
    A propose-only agent cannot, and its panels arrive proposed — which is the
    case the pending state was designed for and the only one where it means
    anything.
    """
    row = await conn.fetchrow(
        "select kind, trust_tier from actors where id = $1", actor_id)
    if row is None:
        return False, f"no actor {actor_id}"
    if row["kind"] == "human":
        return True, "authored by a person"
    if row["trust_tier"] == "autonomous":
        return True, "authored by an autonomous agent"
    return False, f"{actor_id} is {row['trust_tier']}"


async def _known_actor(conn, actor_id: str) -> str | None:
    """Why the actor is unusable, or None if it is fine.

    `objects.created_by` is a foreign key into `actors`, so an absent or unknown
    actor was a raw ForeignKeyViolationError and an HTTP 500 — which tells a
    caller nothing it can correct. There is no authentication yet, so this
    checks that the claimed identity EXISTS; it cannot check that the caller is
    who they say they are.
    """
    if not actor_id:
        return "no actor_id given, and every write is attributed to someone"
    row = await conn.fetchrow("select id from actors where id = $1", actor_id)
    if row is None:
        return f"no actor {actor_id!r} — writes are attributed, so the id must exist"
    return None


async def _declared(state: dict, conn_id: str) -> dict[str, Dataset]:
    """Datasets registered against this connection.

    Loaded on every call rather than cached: registering one is how an author
    fixes a wrong time column, and a cache here would make that fix take a
    restart to appear.
    """
    rows = await state["pool"].fetch(
        "select id, physical, is_virtual, time_column, grains, dimensions from datasets"
        " where connection_id = $1", conn_id)
    out: dict[str, Dataset] = {}
    for r in rows:
        dims = r["dimensions"]
        if isinstance(dims, str):
            dims = json.loads(dims)
        out[r["id"]] = Dataset(
            id=r["id"], connection_id=conn_id, physical=r["physical"],
            # Dropped here, the saved query would be quoted as a table name.
            is_virtual=r["is_virtual"],
            time_column=r["time_column"],
            grains=[TimeGrain(g) for g in (r["grains"] or [])],
            dimensions=[Dimension(d["name"], d.get("column", d["name"]),
                                  ColKind(d.get("kind", "string")),
                                  # Absent on rows written before these were
                                  # stored: fall back to what introspection
                                  # would have decided, not to a bare True.
                                  filterable=d.get("filterable", _default_filterable(
                                      ColKind(d.get("kind", "string")))),
                                  groupable=d.get("groupable", _default_groupable(
                                      ColKind(d.get("kind", "string")))))
                        for d in (dims or [])],
        )
    return out


@router.post("/api/v1/connections.list")
async def connections_list(req: Request):
    """What a panel can be built on.

    ``dsn`` is returned and the secret is not, because they are stored apart:
    the DSN carries host and database, the credential lives behind
    ``secret_ref``. A connection object that could leak a password would be
    indexed for retrieval like every other object, and an indexed credential is
    an exfiltrated one.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    rows = await state["pool"].fetch(
        "select id, name, kind, dsn, read_only, impersonation, checked_at, last_error"
        " from connections where space_id = $1 order by name", space)
    return {"connections": [{
        "id": r["id"], "name": r["name"], "kind": r["kind"],
        # host and database only — never the credential
        "dsn": _redact(r["dsn"]),
        "read_only": r["read_only"], "impersonation": r["impersonation"],
        "checked_at": r["checked_at"].isoformat() if r["checked_at"] else None,
        "last_error": r["last_error"],
    } for r in rows]}


#: What a DSN looks like per engine. SQLAlchemy needs the driver named in the
#: scheme, and the async/sync split is already decided by ``ASYNC_DRIVERS`` —
#: this only has to agree with it.
#: kind -> SQLAlchemy driver. The driver is what has to be installed; the
#: dialect is what the compiler emits, and they are not the same list — a
#: connection can be described here and still fail to open because nobody
#: `pip install`ed its DBAPI, which is the honest failure and the one
#: `connections.create` reports.
_DRIVERS = {
    "postgres": "postgresql+asyncpg",
    "bigquery": "bigquery",
    "snowflake": "snowflake",
    "duckdb": "duckdb",
    "sqlite": "sqlite+aiosqlite",
    # Added by naming a dialect. None has been run against a live server here,
    # so what is claimed is that the SQL compiles and parses in-dialect.
    "mysql": "mysql+pymysql",
    "mariadb": "mysql+pymysql",
    "redshift": "redshift+psycopg2",
    "clickhouse": "clickhouse+native",
    "databricks": "databricks",
    "trino": "trino",
    "mssql": "mssql+pyodbc",
}


@router.post("/api/v1/connections.create")
async def connections_create(req: Request):
    """Register a warehouse, credential and all.

    The password is taken once, encrypted, and stored in ``connection_secrets``
    — which is not an object and is not in the graph, because objects get
    chunked and embedded and a credential in a vector index is a credential in
    somebody's context window. What lands on the connection row is a handle.

    The connection is opened before it is saved. A row that has never
    successfully connected is worse than no row: it looks usable in the picker
    and fails on the first panel someone builds on it.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    actor = actor_of(req)
    kind = body.get("kind", "postgres")
    if kind not in _DRIVERS:
        return _error(422, "bad_kind", f"kind must be one of {sorted(_DRIVERS)}", "kind")
    # Named before they are read: a missing one was a KeyError, so a 500.
    for field in ("name", "idempotencyKey"):
        if not str(body.get(field) or "").strip():
            return _error(422, f"missing_{field}", f"{field} is required", field)

    conn_id = f"conn-{_slug(body['name'])[:24]}-{hashlib.sha256(body['idempotencyKey'].encode()).hexdigest()[:6]}"
    dsn = _dsn(kind, body)

    secret_ref = None
    if body.get("password"):
        try:
            secret_ref = await secrets.put(state["pool"], conn_id, body["password"], actor)
        except secrets.MissingKey as e:
            return _error(500, "no_secret_key", str(e), None)

    ok, detail = await _probe(dsn, await secrets.get(state["pool"], secret_ref),
                              kind, body.get("read_only", True))
    if not ok:
        return _error(422, "cannot_connect", detail, "host")

    await state["pool"].execute(
        "insert into connections (id, space_id, name, kind, dsn, secret_ref,"
        " impersonation, read_only, status, created_by, checked_at)"
        " values ($1,$2,$3,$4,$5,$6,$7,true,'ok',$8,now())"
        " on conflict (id) do update set name = excluded.name, dsn = excluded.dsn,"
        " secret_ref = excluded.secret_ref, status = 'ok', checked_at = now(),"
        " last_error = null",
        conn_id, space, body["name"], kind, dsn, secret_ref,
        bool(body.get("impersonation")), actor)

    return {"connection_id": conn_id, "name": body["name"], "kind": kind,
            "dsn": _redact(dsn), "status": "ok", "detail": detail}


@router.post("/api/v1/connections.check")
async def connections_check(req: Request):
    """Open a stored connection and record what happened.

    This operation has been in the registry — and therefore in the MCP manifest
    an agent reads — since dashboards were built, with nothing serving it. The
    parity test compares operation names to *route names derived from the
    registry*, so a missing handler was invisible to it; tests/test_parity.py
    now checks the app's own route table instead.
    """
    state = req.app.state.commonindex
    body = await req.json()
    row = await state["pool"].fetchrow(
        "select id, dsn, secret_ref, kind, read_only from connections where id = $1",
        body.get("connection_id", ""))
    if row is None:
        return _error(404, "unknown_connection",
                      f"no connection {body.get('connection_id')}", "connection_id")

    ok, detail = await _probe(row["dsn"],
                              await secrets.get(state["pool"], row["secret_ref"]),
                              row["kind"], row["read_only"])
    await state["pool"].execute(
        "update connections set status = $2, checked_at = now(), last_error = $3"
        " where id = $1", row["id"], "ok" if ok else "failed", None if ok else detail)
    return {"connection_id": row["id"], "ok": ok, "detail": detail}


def _dsn(kind: str, body: dict) -> str:
    """Host and database only. The password is deliberately absent — it goes to
    the secret store and is injected at connect time.

    Built with ``URL.create`` so a host, database or username containing a
    reserved character produces a correct URL rather than a plausible wrong one.
    """
    from sqlalchemy.engine import URL

    drv, db = _DRIVERS[kind], body["database"]
    if kind in ("sqlite", "duckdb"):
        return str(URL.create(drv, database=db))
    return str(URL.create(
        drv, username=body.get("user") or None,
        host=body.get("host") or "localhost",
        port=body.get("port") or None, database=db))


async def _probe(dsn: str, password: str | None, kind: str,
                 read_only: bool = True) -> tuple[bool, str]:
    """Open it and run the cheapest statement there is.

    Connecting is not enough: credentials can be accepted by a pooler that then
    refuses every query, and a connection that authenticates but cannot SELECT
    is exactly as useless as one that does not connect.

    Probed the SAME way the panels will open it. Checking a file-backed
    database read-write and then reading it read-only means the check passed
    against a database it had just created — which is how a typo'd DuckDB path
    became a green connection and a dashboard where every panel said "table
    does not exist".
    """
    from sqlalchemy import text

    from commonindex.core.warehouse.dialects import ASYNC_DRIVERS

    url = _with_secret(dsn, password)
    engine = None
    try:
        engine = _make_engine(url, kind, read_only, pool_pre_ping=True)
        if kind in ASYNC_DRIVERS:
            async with engine.connect() as c:
                await c.execute(text("select 1"))
        else:
            # A sync driver blocks, so it goes to a thread rather than stalling
            # the event loop while somebody's warehouse decides to answer.
            import anyio

            def probe():
                with engine.connect() as c:
                    c.execute(text("select 1"))

            await anyio.to_thread.run_sync(probe)
        return True, "connected and ran a query"
    except Exception as e:  # noqa: BLE001 - see below
        # Deliberately broad, and this is the case that earns it. The whole
        # point of the function is to open a connection someone just typed in,
        # against a driver chosen at runtime, and every driver raises its own
        # hierarchy: a wrong database name arrives as
        # asyncpg.InvalidCatalogNameError, which is not a SQLAlchemyError
        # because it is raised during connect, before SQLAlchemy wraps anything.
        # Enumerating those hierarchies means importing five drivers to catch
        # their exceptions, and getting the list wrong means a 500 where the
        # operator should have seen "database does not exist".
        return False, str(getattr(e, "__cause__", None) or e).split("\n")[0][:220]
    finally:
        if engine is not None:
            # A sync engine's dispose() returns None, so awaiting it is a
            # TypeError — and it lands in the `finally`, which turns a
            # successful probe into a 500.
            closed = engine.dispose()
            if closed is not None:
                await closed


@router.post("/api/v1/datasets.introspect")
async def datasets_introspect(req: Request):
    """Discover what a connection can be queried on.

    None of this is hand-written per engine — it is SQLAlchemy's Inspector,
    which is the half of the warehouse problem it solves outright and the
    reason ``dialects.py`` carries only the residue. What the engine spec adds
    is ``kind_of``: mapping each driver's type names onto time / number /
    string, which is what decides whether a column can be a grain, a measure or
    a slice.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    if missing := _need(body, "connection_id"):
        return missing
    try:
        src, row = await _source(state, body["connection_id"], space)
    except NoSuchConnection as e:
        return _error(404, "unknown_connection", f"no connection {e}", "connection_id")

    discovered = await src.datasets()
    # A saved query is a dataset like any other, and belongs in the same list —
    # putting virtual datasets on their own screen is how a person ends up not
    # knowing one already exists and writing it again.
    declared = await _declared(state, body["connection_id"])
    virtual = [d for d in declared.values() if d.is_virtual]
    seen = {d.id for d in virtual}
    return {"connection": {"id": row["id"], "name": row["name"], "kind": row["kind"]},
            "datasets": [_dataset_json(d) for d in virtual]
                        + [_dataset_json(d) for d in discovered if d.id not in seen]}


def _dataset_json(d) -> dict[str, Any]:
    cols = [{"name": c.name, "kind": c.kind.value if hasattr(c.kind, "value") else str(c.kind)}
            for c in d.dimensions]
    return {
        "id": d.id, "physical": d.physical, "is_virtual": d.is_virtual,
        # A table with no temporal column cannot carry a grain. Saying so here
        # is what lets the UI grey out "by day" instead of offering it and
        # failing at query time.
        "time_column": d.time_column,
        "grains": [g.value for g in d.grains],
        # Every temporal column, not just the default. Introspection picks the
        # first one it meets, which on a table carrying both created_at and
        # decided_at is a coin toss — and bucketing a proposal by when it was
        # decided rather than when it was filed is a different chart, not a
        # cosmetic difference. So the author chooses.
        "times": [c["name"] for c in cols if c["kind"] == ColKind.TIME.value],
        "columns": cols,
        "measures": [c["name"] for c in cols if c["kind"] == ColKind.NUMBER.value],
        "slices": [c["name"] for c in cols if c["kind"] == ColKind.STRING.value],
    }


@router.post("/api/v1/dashboards.list")
async def dashboards_list(req: Request):
    """Every dashboard in the space, with its certification recomputed.

    ``dashboards.list`` is NOT registered by this module. Every collection gets
    list/get/propose from the type registry, and ``dashboard`` is a collection —
    registering it here as well is precisely the shortcut tests/test_parity.py
    exists to catch, and it caught it. This is the handler for the operation the
    type registration already declares.

    Recomputed on read, not stored: a badge written at save time survives the
    metric being deprecated underneath it, and a stale certification is worse
    than none — it is a claim of review that no longer holds.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway import sharing

    can_see = await sharing.keys(req, state["pool"])
    rows = await state["pool"].fetch(
        """
        select o.id, o.key, o.title, o.props, o.updated_at, o.created_by,
               ('space:' || o.space_id) = any(o.acl_keys)               as workspace,
               (select c.name from connections c
                 where c.id = o.props->>'connection_id' and c.space_id = o.space_id)
                                                                      as connection_name,
               count(b.panel_id)                                       as panels,
               -- A panel with its own query cites nothing, so the left join
               -- yields no row and `m.status <> 'ratified'` is NULL — not
               -- false. Without naming it here the list called a dashboard
               -- certified that its own page reported uncertified.
               count(*) filter (where b.sql is not null
                                   or m.status is distinct from 'ratified')
                                                                      as unratified,
               -- How many of those carry their OWN query. The detail page has
               -- said "2 panels carry their own query" since the SQL panel was
               -- added, while this list called the same panels an "unratified
               -- metric" — and they cite no metric at all, which is the point
               -- of them.
               count(*) filter (where b.sql is not null)              as queries,
               array_remove(array_agg(distinct b.metric_id), null)     as metric_ids,
               jsonb_object_agg(b.metric_id, coalesce(m.label, b.metric_id)
                                order by b.metric_version)
                 filter (where b.metric_id is not null)               as metric_labels,
               count(distinct b.metric_id)
                 filter (where b.sql is null and m.status = 'ratified') as approved_metrics,
               -- A thumbnail needs layout metadata, never a warehouse query,
               -- SQL text, credentials, filters, or another reader's results.
               jsonb_agg(jsonb_build_object(
                   'id', b.panel_id, 'title', b.title, 'mark', b.mark,
                   'span', b.span, 'col', b.col, 'height', b.height
               ) order by b.position, b.panel_id)                      as preview_panels
          from objects o
          join panel_bindings b on b.dashboard_id = o.id
          -- Rendering follows the current ratified definition, not the version
          -- recorded when the panel was first created. The badge must agree.
          left join lateral (
              select definition.* from metrics definition
               where definition.id = b.metric_id
                 and definition.space_id in (o.space_id, '*')
               order by (definition.status = 'ratified') desc,
                        (definition.space_id = '*'), definition.version desc
               limit 1
          ) m on true
         where o.space_id = $1 and o.type = 'dashboard' and o.deleted_at is null
           and o.acl_keys && $2
         group by o.id order by o.updated_at desc
        """, space, can_see)
    return {"dashboards": [{
        "id": r["id"], "key": r["key"], "title": r["title"],
        "visibility": "workspace" if r["workspace"] else "private",
        "panel_count": r["panels"],
        "certified": r["unratified"] == 0,
        "unratified": r["unratified"],
        "queries": r["queries"],
        "metrics": list(r["metric_ids"] or []),
        "metric_labels": (json.loads(r["metric_labels"])
                          if isinstance(r["metric_labels"], str)
                          else (r["metric_labels"] or {})),
        "approved_metrics": r["approved_metrics"],
        "connection_name": r["connection_name"],
        "preview_panels": (json.loads(r["preview_panels"])
                           if isinstance(r["preview_panels"], str)
                           else (r["preview_panels"] or []))[:12],
        "owner": r["created_by"],
        "connection_id": (json.loads(r["props"]) if isinstance(r["props"], str)
                          else (r["props"] or {})).get("connection_id"),
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    } for r in rows]}


@router.post("/api/v1/panels.preview")
async def panels_preview(req: Request):
    """Run a definition that does not exist yet.

    Everything the author typed is validated against what was introspected
    before it reaches SQL: the aggregate comes from a closed set, and the
    column and the slice must be columns this dataset actually declares. That
    is the same rule the query builder applies to dimensions, applied one step
    earlier — an authoring endpoint that interpolates a free-text column into
    ``SUM(...)`` is a SQL injection with a chart on top.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    if missing := _need(body, "connection_id"):
        return missing
    try:
        src, _ = await _source(state, body["connection_id"], space)
    except NoSuchConnection as e:
        return _error(404, "unknown_connection", f"no connection {e}", "connection_id")

    try:
        ds = await src._dataset(body["dataset_id"])
    except LookupError:
        return _error(404, "unknown_dataset", f"no dataset {body['dataset_id']}", "dataset_id")

    try:
        ds = _retime(ds, body.get("time_column"))
        expr, unit, better = _definition(body, ds, src._spec.sqlglot_dialect)
        q = _draft_query(body, ds)
    except _Invalid as e:
        return _error(422, e.code, str(e), e.field)

    draft = _Draft(expr=expr, unit=unit, better=better)
    try:
        result = await src.preview(draft, q, as_principal="", dataset=ds)
    except SQLAlchemyError as e:
        # A failure here is the author's choice, not the platform's: an
        # aggregate the column's type will not take, a table the connection
        # cannot read. It comes back as a 422 naming the cause rather than a
        # 500, so the wizard can show it next to the control that caused it.
        return _error(422, "query_failed", str(e).split("\n")[0][:400], None)

    s = shape(result, unit=unit, better=better)
    return {
        "expr": expr, "unit": s.unit, "better": s.better,
        "rows": len(result.rows),
        "series": [{"name": x.name, "points": x.points} for x in s.series],
    }


@router.post("/api/v1/dashboards.create")
async def dashboards_create(req: Request):
    """Write the dashboard down.

    In one transaction, and in this order, because each row references the one
    before it: the dataset is registered so dimensions are *declared* rather
    than accepted at query time, each panel's definition becomes a proposed
    metric version, the dashboard and its panels become objects, and the
    bindings cite metric id **and version**.

    The dashboard comes back uncertified. That is not an omission to fix later
    — it is the difference between this and a BI tool. Someone has to stand
    behind what these numbers mean before they are quoted as if reviewed, and
    until they do, every panel says so on its own face.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    if missing := _need(body, "connection_id"):
        return missing
    author = actor_of(req)

    try:
        src, conn_row = await _source(state, body["connection_id"], space)
        ds = await src._dataset(body["dataset_id"])
    except (NoSuchConnection, LookupError) as e:
        # _dataset raises a plain LookupError for an unknown table, which is a
        # real 404 too — but it is named separately so the two cannot merge.
        return _error(404, "unknown_target", str(e), None)
    try:
        ds = _retime(ds, body.get("time_column"))
    except _Invalid as e:
        return _error(422, e.code, str(e), e.field)

    panels_in = body.get("panels") or []
    if not panels_in:
        return _error(422, "no_panels", "a dashboard needs at least one panel", "panels")

    prepared, seen = [], set()
    for i, p in enumerate(panels_in):
        try:
            expr, unit, better = _definition(p, ds, src._spec.sqlglot_dialect)
            # Only panels.preview ran these, so a dashboard could be created with
            # a dimension the table does not have or a grain TimeGrain cannot
            # parse. It returned 200, and then every render 500'd on the
            # generator inside the `for` header — killing the whole dashboard,
            # with no update or delete operation to recover it. A permanent
            # 500 reachable only by hand-editing Postgres.
            _check_binding(p, ds)
        except _Invalid as e:
            return _error(422, e.code, str(e), f"panels[{i}].{e.field}")

        # Metric ids come from the title, so two panels sharing one collide on
        # the (id, version) primary key and 500. Trivially reachable: every
        # column-less count is auto-titled "Rows".
        mid = _slug(p["title"])
        if mid in seen:
            return _error(422, "duplicate_panel_title",
                          f"two panels are both called {p['title']!r}; each panel's "
                          "definition is stored under its own id, so the titles have "
                          "to differ", f"panels[{i}].title")
        seen.add(mid)
        prepared.append((p, expr, unit, better))

    # The id is readable and the idempotency lives in a suffix, rather than the
    # whole id being a slug of the retry token. `dash-ws_by_id` for a dashboard
    # called "Actors" is what that produced.
    digest = hashlib.sha256(body["idempotencyKey"].encode()).hexdigest()[:8]
    dash_id = f"dash-{_slug(body['title'])[:24]}-{digest}"

    async with state["pool"].acquire() as conn, conn.transaction():
        may, why = await _may_ratify(conn, author)
        # Replaying the same key returns the same dashboard rather than a
        # second copy — the retry an agent makes after a timeout must not
        # double-create.
        existing = await conn.fetchval("select id from objects where id = $1", dash_id)
        if existing:
            return {"dashboard_id": existing, "created": False}

        # `on conflict (id) do nothing` silently discarded the author's chosen
        # time column whenever anyone had already registered this table — and
        # since a declared dataset outranks introspection at render time, the
        # saved dashboard then bucketed by somebody else's column and showed
        # different numbers than the preview that was approved. Refusing is the
        # honest answer: a registered dataset is a shared declaration, and the
        # second author silently losing to the first is the exact class of
        # disagreement this whole feature exists to prevent.
        prior = await conn.fetchval(
            "select time_column from datasets where id = $1", ds.id)
        if prior is not None and prior != ds.time_column:
            return _error(
                409, "dataset_already_declared",
                f"{ds.id} is already registered with time column {prior!r}, not "
                f"{ds.time_column!r}. Two dashboards on one table must agree on which "
                "column is its timeline, or they will quote different numbers for the "
                "same window.", "time_column")

        await conn.execute(
            "insert into datasets (id, space_id, connection_id, name, physical,"
            " time_column, grains, dimensions, created_by) values"
            " ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) on conflict (id) do update set"
            " dimensions = excluded.dimensions, updated_at = now()",
            ds.id, space, conn_row["id"], ds.id, ds.physical, ds.time_column,
            [g.value for g in ds.grains],
            _dims_json(ds), author,
        )

        await conn.execute(
            "insert into objects (id, space_id, type, key, title, props, created_by)"
            " values ($1,$2,'dashboard',$3,$4,$5::jsonb,$6)",
            dash_id, space, await _next_key(conn, space), body["title"],
            json.dumps({"connection_id": conn_row["id"], "dataset_id": ds.id}), author,
        )
        from commonindex.gateway.sharing import make_private

        # Private to its creator until it is shared.
        await make_private(conn, dash_id, author)

        # The decision is the act of pressing Create. It is written down as an
        # object either way, so "who agreed this number means this, and when" is
        # a query rather than an archaeology exercise — the same record a
        # separate ratification click would have produced.
        decision_id = f"dec-{dash_id}" if may else None
        if decision_id:
            await conn.execute(
                "insert into objects (id, space_id, type, title, props, created_by)"
                " values ($1,$2,'decision',$3,$4::jsonb,$5)",
                decision_id, space, f"Create {body['title']}",
                json.dumps({"why": why, "dashboard_id": dash_id}), author)

        for i, (p, expr, unit, better) in enumerate(prepared):
            metric_id = f"{dash_id}.{_slug(p['title'])}"
            await conn.execute(
                "insert into metrics (id, version, space_id, dataset_id, label, expr,"
                " unit, better, status, ratified_by, created_by)"
                " values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                metric_id, space, ds.id, p["title"], expr, unit, better,
                "ratified" if may else "proposed", decision_id, author)

            panel_id = f"{dash_id}-p{i}"
            await conn.execute(
                "insert into objects (id, space_id, type, title, props, created_by)"
                " values ($1,$2,'panel',$3,'{}'::jsonb,$4)",
                panel_id, space, p["title"], author)
            await conn.execute(
                "insert into panel_bindings (panel_id, dashboard_id, dataset_id,"
                " metric_id, metric_version, dimensions, grain, position, mark, title,"
                " filters, row_limit, sort)"
                " values ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
                panel_id, dash_id, ds.id, metric_id,
                [p["dimension"]] if p.get("dimension") else [],
                p.get("grain") or "day", i, p.get("mark") or "line", p["title"],
                json.dumps(p.get("filters") or []),
                p.get("limit") or 0, p.get("sort") or "bucket")
        from commonindex.gateway.sharing import follow

        await follow(conn, dash_id)
        # Indexed with its panels, which are most of what it is searched by.
        await index_object(conn, dash_id)

    n = len(prepared)
    return {
        "dashboard_id": dash_id, "created": True,
        "certified": may,
        "unratified": [] if may else [f"{dash_id}.{_slug(p['title'])}" for p, *_ in prepared],
        "authority": why,
        "message": (
            f"{n} definition{'' if n == 1 else 's'} written and ratified — {why}."
            if may else
            f"{n} definition{'' if n == 1 else 's'} written as proposed metrics, because {why}. "
            "A person has to stand behind them before they resolve."
        ),
    }


# ── shared validation ───────────────────────────────────────────────────

class NoSuchDashboard(LookupError):
    """Its own type for the same reason as NoSuchConnection: ``except
    LookupError`` also catches a KeyError from the row it just fetched."""


class NoSuchConnection(LookupError):
    """Its own type, not a bare LookupError.

    ``KeyError`` is a ``LookupError``, so ``except LookupError`` also catches a
    misspelled column on the row it just fetched — and reports it as "no
    connection 'secret_ref'", which sends whoever reads it looking for a
    connection by that name. A handler that turns one bug into a confident
    wrong answer about a different bug is worse than one that crashes.
    """


class _Invalid(Exception):
    def __init__(self, code: str, message: str, field: str | None = None):
        super().__init__(message)
        self.code, self.field = code, field


class _Draft:
    """A definition being authored. Has an expression and deliberately no id —
    which is what makes it unstorable and unciteable from a saved panel."""

    __slots__ = ("better", "expr", "id", "unit", "version")

    def __init__(self, expr: str, unit: str | None, better: str | None):
        self.id, self.version = "__draft__", 0
        self.expr, self.unit, self.better = expr, unit, better


def _definition(p: dict, ds, dialect: str | None = None) -> tuple[str, str | None, str | None]:
    """Turn the author's choices into an expression, checked against the table."""
    agg = p.get("agg", "count")
    if agg not in AGGS:
        raise _Invalid("bad_agg", f"agg must be one of {sorted(AGGS)}", "agg")

    declared = {d.name: d for d in ds.dimensions}
    col = p.get("column")

    def need(name: str, field: str) -> str:
        if not name:
            raise _Invalid("column_required", f"{agg} needs a {field}", field)
        if name not in declared:
            raise _Invalid("undeclared_column", f"{name} is not a column of {ds.id}", field)
        return name

    if agg == "count":
        expr = AGGS["count"]
    elif agg in NEEDS_DEN:
        expr = AGGS[agg].format(col=need(col, "column"),
                                den=need(p.get("denominator"), "denominator"))
    elif agg in NEEDS_VALUE:
        value = p.get("value")
        if value is None or value == "":
            raise _Invalid("value_required", f"{agg} needs a value to match", "value")
        # A literal, so it lives inside the stored metric expression rather than
        # as a bind parameter the registry has nowhere to keep. Rendered by
        # sqlglot, which escapes for the target dialect — never by f-string,
        # which is how a value containing a quote becomes an injection.
        expr = AGGS[agg].format(col=need(col, "column"),
                                lit=_literal(value, dialect))
    else:
        expr = AGGS[agg].format(col=need(col, "column"))

    unit = p.get("unit")
    if unit is None:
        # A ratio and a share are fractions of one, which is a percentage.
        unit = ("count" if agg in ("count", "count_distinct")
                else "pct" if agg in ("ratio", "share")
                else "count" if (col and _COUNT_UNIT.search(col))
                else "currency" if (col and _CURRENCY.search(col)) else "count")
    better = p.get("better") or ("down" if unit in ("currency", "duration") else "up")
    return expr, unit, better


def _literal(value, dialect: str | None = None) -> str:
    """A SQL literal for a value the author typed.

    The dialect is the whole point and it was not being passed. `.sql()` with
    no dialect renders in sqlglot's own, which doubles a quote — correct for
    Postgres, DuckDB, SQLite, Trino and T-SQL, and an injection everywhere
    else. MySQL, MariaDB, BigQuery, Snowflake, Redshift, ClickHouse and
    Databricks all treat a backslash as an escape, so a value of

        x\' OR 1=1 --

    rendered as `'x\'' OR 1=1 -- '`, where the backslash escapes the closing
    quote and the rest is code. Reachable at `read` through `panels.preview`
    and STORED at `propose` through `panels.add`, where it becomes a definition
    that re-runs for every viewer.

    The benign version of the same bug is commoner: a value containing an
    apostrophe — `Women's` — renders as `''` and BigQuery rejects it outright.
    """
    import sqlglot

    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return sqlglot.exp.Literal.string(str(value)).sql(dialect=dialect)


def _retime(ds, time_column: str | None):
    """Honour an author's choice of time column, checked against the table."""
    if not time_column or time_column == ds.time_column:
        return ds
    kinds = {d.name: d.kind for d in ds.dimensions}
    if kinds.get(time_column) is not ColKind.TIME:
        raise _Invalid("bad_time_column",
                       f"{time_column} is not a temporal column of {ds.id}", "time_column")
    return replace(ds, time_column=time_column)


SORTS = {"bucket", "value_desc", "value_asc"}
MAX_LIMIT = 5000


def _filters(p: dict, ds) -> list[Filter]:
    """Parse and check the WHERE clause.

    The operator is a key of ``build.OPS`` and never a fragment, the column must
    be one the dataset declares, and the arity is checked there — so nothing an
    author types reaches the statement except as a bound value.
    """
    declared = {d.name: d for d in ds.dimensions}
    out: list[Filter] = []
    for i, f in enumerate(p.get("filters") or []):
        dim, op = f.get("dimension"), f.get("op", "eq")
        if dim not in declared:
            raise _Invalid("undeclared_dimension",
                           f"{dim} is not a column of {ds.id}", f"filters[{i}].dimension")
        if op not in OPS:
            raise _Invalid("bad_operator",
                           f"{op!r} is not an operator; expected one of {sorted(OPS)}",
                           f"filters[{i}].op")
        vals = f.get("values")
        if vals is None:
            vals = [] if f.get("value") is None else [f["value"]]
        # Same coercion the dashboard filter bar uses: a stored filter is
        # authored through the same JSON body, so `"100"` for a numeric column
        # arrives here too and fails on the driver rather than on the form.
        try:
            vals = coerce_values(list(vals), declared[dim].kind, dim)
        except BadFilter as e:
            raise _Invalid("bad_filter_value", str(e), f"filters[{i}].values") from None
        out.append(Filter(dimension=dim, op=op, values=vals))
    return out


def _check_binding(p: dict, ds) -> None:
    """The half of validation that only lived on the preview path."""
    declared = {d.name for d in ds.dimensions}
    dim = p.get("dimension")
    if dim and dim not in declared:
        raise _Invalid("undeclared_dimension", f"{dim} is not a column of {ds.id}", "dimension")

    _filters(p, ds)

    sort = p.get("sort") or "bucket"
    if sort not in SORTS:
        raise _Invalid("bad_sort", f"sort must be one of {sorted(SORTS)}", "sort")
    limit = p.get("limit") or 0
    if not isinstance(limit, int) or limit < 0 or limit > MAX_LIMIT:
        raise _Invalid("bad_limit", f"limit must be an integer from 0 to {MAX_LIMIT}", "limit")
    if limit and sort == "bucket" and (p.get("grain") or "day") != "none":
        # A LIMIT on a chronological ordering truncates the timeline rather than
        # taking a top N — you get the oldest N buckets, which is never what
        # anyone means by "top 10".
        raise _Invalid("limit_needs_a_ranking",
                       "a row limit on a time series takes the oldest N buckets, not the "
                       "top N; sort by value, or drop the time bucket", "sort")
    grain = p.get("grain") or "day"
    try:
        g = TimeGrain.parse(grain)
    except ValueError:
        raise _Invalid("bad_grain", f"{grain!r} is not a time grain", "grain") from None
    if g is not TimeGrain.NONE and not ds.time_column:
        raise _Invalid("no_time_column",
                       f"{ds.id} has no temporal column, so it cannot be bucketed by time",
                       "grain")


def _draft_query(body: dict, ds) -> Query:
    # The same checks the create path runs. They were split — preview validated
    # the dimension and the grain, create validated the measure — so each path
    # accepted something the other refused, and the preview happily showed a
    # chart that could not be saved.
    _check_binding(body, ds)

    dim = body.get("dimension")
    grain = TimeGrain.parse(body.get("grain", "day"))
    if grain is not TimeGrain.NONE and not ds.time_column:
        raise _Invalid("no_time_column",
                       f"{ds.id} has no temporal column, so it cannot be bucketed by time",
                       "grain")

    rng = body.get("range", "30d")
    if rng not in RANGES:
        raise _Invalid("bad_range", f"range must be one of {sorted(RANGES)}", "range")
    now = datetime.now(tz=UTC)
    return Query(
        metric_id="__draft__", dataset_id=ds.id,
        dimensions=[dim] if dim else [], grain=grain,
        filters=_filters(body, ds),
        limit=body.get("limit") or 0,
        order=body.get("sort") or "bucket",
        # Bounded even in preview: an unbounded scan of a customer's fact table
        # is a billing incident whether or not anyone saved the panel.
        window=Window(now - RANGES[rng], now) if ds.time_column else None,
    )


def _default_filterable(kind: ColKind) -> bool:
    """Whether a column of this kind can appear in a WHERE clause.

    Almost all of them can. This returned False for numbers, and the reasoning
    said in as many words that "what a reader wants from a numeric column is
    `>` or `between`" — and then removed every numeric column from the picker,
    so `amount > 100` became unreachable from the UI. That is a whole class of
    filter, and one BI tools ship a dedicated control for.

    The real complaint was never that numbers cannot be filtered. It was that
    `amount = 12.5` is a useless EQUALITY and that a picker listing every
    measure buries the two or three columns anybody slices by. Neither is
    fixed by refusing; both are fixed by grouping the picker and offering
    comparison operators rather than equality — which is what the client does
    with the kinds this now reports.
    """
    return True


def _default_groupable(kind: ColKind) -> bool:
    """Whether a column of this kind can be a GROUP BY dimension.

    This is where the number genuinely does not belong: grouping by a float
    produces one bucket per distinct value, which is a chart with ten thousand
    series. Filtering and grouping were being decided by one flag, and the
    argument for this one was used to justify both.
    """
    return kind is not ColKind.NUMBER


def _dims_json(ds) -> str:
    """The declared columns, as stored.

    `filterable` and `groupable` were written nowhere and read nowhere, so
    `Dimension` fell back to its `True` default on every load and `if
    d.filterable` in the render was always true. The filter picker therefore
    offered the MEASURES as slicers — `amount`, `latency_ms`, `refunded` — and
    picking one is legal and useless.
    """
    return json.dumps([{"name": d.name, "column": d.column,
                        "kind": d.kind.value if hasattr(d.kind, "value") else str(d.kind),
                        "filterable": d.filterable, "groupable": d.groupable}
                       for d in ds.dimensions])


def _redact(dsn: str) -> str:
    """Drop the password, keep the username.

    The old pattern took everything between ``//`` and ``@``, which removed the
    user as well — so a read-only connection and a superuser connection to the
    same database rendered as the identical string in the picker, and the one
    thing an operator most needs to see before building on a connection was the
    one thing hidden.
    """
    from sqlalchemy.engine import make_url

    try:
        return make_url(dsn).render_as_string(hide_password=True)
    except (ArgumentError, ValueError):
        return re.sub(r"//[^/@]*@", "//", dsn or "")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:40] or "x"


async def _next_key(conn, space: str, prefix: str = "DASH") -> str:
    """A short, sequential, human-quotable key — DASH-7, not DASH-WS_BY_ID.

    The prefix follows the type. It was hardcoded to DASH, so the first
    registered experiment was filed as DASH-10 and read, correctly, as a
    dashboard to anybody scanning the column.

    Taken from the space's own counter, which is what makes it unique under the
    partial unique index on (space_id, key) without the key having to encode
    anything. Two dashboards can share a title; they cannot share a number.
    """
    await conn.execute(
        "insert into space_seq (space_id) values ($1) on conflict (space_id) do nothing", space)
    n = await conn.fetchval(
        "update space_seq set next_seq = next_seq + 1 where space_id = $1"
        " returning next_seq - 1", space)
    return f"{prefix}-{n}"


def _error(status: int, code: str, message: str, field: str | None = None,
           **extra):
    """An error a caller can act on.

    `extra` carries whatever the specific failure knows that the four standard
    fields cannot hold — a parse error's line and column, say, which the editor
    can point at instead of making somebody re-read their own query.
    """
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "field": field,
                           **{k: v for k, v in extra.items() if v is not None}}})


def _need(body: Any, *fields: str) -> JSONResponse | None:
    """A typed refusal for the first required field the body lacks.

    Read as `body["x"]`, a missing field raised a KeyError: a 500 to a browser,
    and over MCP a protocol failure in place of the result an agent could act
    on — found by calling every read-only tool with nothing at all."""
    for f in fields:
        if not isinstance(body, dict) or body.get(f) in (None, ""):
            return _error(422, "missing_field", f"{f} is required", f)
    return None


# ── virtual datasets ────────────────────────────────────────────────────
# The one place this design bends toward SQL in a dashboard.
#
# Two things get conflated under "SQL in a dashboard" and only one of them is
# the problem. An **adhoc metric** is SQL
# for the measure, written inline on one chart, bypassing the registry — that is
# how six charts come to mean six things by "refund rate", and it stays refused.
# A **virtual dataset** is SQL that stands in for a table: it decides which rows
# exist, not what any number means. Metrics on it are ratified like any other.
#
# So the SQL lives in the FROM clause, never in the aggregate.

#: How many rows a preview returns. Enough to see the shape, few enough that a
#: mistyped join does not stream a million rows into a browser.
PREVIEW_ROWS = 25


class BadSQL(Exception):
    def __init__(self, message: str, detail: str = "", at: dict | None = None):
        super().__init__(message)
        self.detail = detail
        #: Where in the statement, when the parser knows. sqlglot reports the
        #: line, the column and the token it choked on, and all three were
        #: being flattened into "could not parse that SQL" — which tells an
        #: author their query is wrong and not where, in an editor that could
        #: point straight at it.
        self.at = at


def check_sql(sql: str, dialect: str | None, hidden: frozenset[str] = frozenset()) -> str:
    """Refuse anything that is not exactly one SELECT.

    This is a guard, NOT the security boundary. The boundary is the grant: the
    connection user has SELECT and nothing else, which is what actually stops a
    DROP — a parser that promises to reject one is a promise, and the warehouse
    refusing is a control. This exists so an operator finds out at save time
    rather than from a failed query, and so a second statement smuggled past a
    comment is rejected before it reaches a connection whose grants might be
    wider than they should be.
    """
    import sqlglot

    text = sql.strip().rstrip(";").strip()
    if not text:
        raise BadSQL("write a SELECT statement")
    try:
        statements = [s for s in sqlglot.parse(text, read=dialect) if s is not None]
    except Exception as e:  # noqa: BLE001 - any parse failure is the author's to fix
        got = (getattr(e, "errors", None) or [{}])[0]
        at = ({"line": got["line"], "col": got["col"],
               "token": got.get("highlight") or ""}
              if got.get("line") else None)
        raise BadSQL(
            got.get("description") or "could not parse that SQL",
            str(e).split("\n")[0][:200], at) from None

    if len(statements) != 1:
        raise BadSQL(
            f"one statement, not {len(statements)} — a dataset is a single query",
            "; ".join(type(s).__name__.lower() for s in statements))
    from sqlglot import exp

    tree = statements[0]

    # A set operation IS a query, and one of the commonest shapes a saved query
    # takes. Checking the top-level node's class name refused every UNION,
    # INTERSECT and EXCEPT — unreachable through `datasets.preview_sql`,
    # `datasets.create_virtual` and inline-SQL panels alike — while accepting
    # two forms that write.
    if not isinstance(tree, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        kind = type(tree).__name__.upper()
        raise BadSQL(
            f"a dataset must be a query, and this is "
            f"{'an' if kind[0] in 'AEIOU' else 'a'} {kind}",
            "the connection is read-only; this would be refused by the warehouse too")

    # Two forms that are `Select` nodes and still write. Postgres happens to
    # reject both once `_run_sql` wraps them in a subquery, which is an accident
    # of the wrapper rather than anything this guard was doing.
    writes = sorted({type(n).__name__.upper() for n in tree.walk()
                     if isinstance(n, (exp.Insert, exp.Update, exp.Delete, exp.Drop,
                                       exp.Create, exp.Alter, exp.Command))})
    if writes:
        raise BadSQL(
            f"a dataset only reads, and this contains {' and '.join(writes)}",
            "a writing statement inside a CTE is still a writing statement")
    if tree.args.get("into"):
        raise BadSQL(
            "a dataset only reads, and SELECT ... INTO creates a table",
            "drop the INTO clause")
    if hidden:
        # The platform's own tables, read through the platform's own database.
        # Names a WITH clause defines are the author's, not the app's.
        ctes = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
        used = sorted({t.name.lower() for t in tree.find_all(exp.Table)
                       if t.name and t.name.lower() in hidden and t.name.lower() not in ctes})
        if used:
            raise BadSQL(
                f"{', '.join(used)} {'is' if len(used) == 1 else 'are'} the platform's own "
                f"{'table' if len(used) == 1 else 'tables'}, not data to chart",
                "this connection is the platform's database; its own tables are not readable through it")
        # And the server underneath it. The platform's login can be a
        # superuser, and `select pg_read_file('/etc/passwd')` is a SELECT.
        system = sorted({t.db.lower() for t in tree.find_all(exp.Table)
                         if (t.db or "").lower() in ("pg_catalog", "information_schema")}
                        | {t.name.lower() for t in tree.find_all(exp.Table)
                           if t.name.lower().startswith("pg_") and not t.db})
        calls = sorted({(f.name or f.sql_name() or "").lower() for f in tree.find_all(exp.Func)}
                       & _ADMIN_FUNCS
                       | {(f.name or "").lower() for f in tree.find_all(exp.Anonymous)
                          if (f.name or "").lower().startswith(("pg_", "lo_", "dblink"))})
        if system or calls:
            raise BadSQL(
                f"{', '.join(system + calls)} {'is' if len(system + calls) == 1 else 'are'} the "
                "database server's own, not data to chart",
                "this connection is the platform's database; its system catalogs and admin "
                "functions are not reachable through it")
    return text


#: Server functions a SELECT can call that read or reach outside the data.
_ADMIN_FUNCS = frozenset({"current_setting", "set_config", "version", "inet_server_addr",
                          "inet_server_port", "query_to_xml", "table_to_xml", "cursor_to_xml"})


def _kind_of(values: list) -> ColKind:
    """Infer a column's kind from the values that came back.

    Deliberately from data rather than from the driver's type codes: those are
    per-driver, and a virtual dataset's columns are expressions whose declared
    type is often whatever the engine inferred anyway. A column that is empty or
    all-null reads as a string, which is the kind that constrains least — it can
    be sliced by, and cannot be summed or bucketed, which is the correct
    conservative answer when nothing is known.
    """
    from datetime import date, datetime
    from decimal import Decimal

    seen = [v for v in values if v is not None]
    if not seen:
        return ColKind.STRING
    if all(isinstance(v, (datetime, date)) for v in seen):
        return ColKind.TIME
    if all(isinstance(v, (int, float, Decimal)) and not isinstance(v, bool) for v in seen):
        return ColKind.NUMBER
    return ColKind.STRING


async def _run_sql(src, sql: str, limit: int) -> tuple[list[str], list[list]]:
    """Execute a candidate query, bounded."""
    from sqlalchemy import text as sa_text

    # Through the spec, because T-SQL has no LIMIT — it was appended anyway,
    # so on MSSQL every SQL preview, every saved query and every inline-SQL
    # panel was a syntax error before it reached the warehouse.
    wrapped = src._spec.limit(f"SELECT * FROM ({sql}) AS src", int(limit))

    def go(conn):
        r = conn.execute(sa_text(wrapped))
        return list(r.keys()), [list(row) for row in r.fetchall()]

    async def go_async(conn):
        r = await conn.execute(sa_text(wrapped))
        return list(r.keys()), [list(row) for row in r.fetchall()]

    return await (src._do(go_async) if src.is_async else src._do(go))


@router.post("/api/v1/datasets.preview_sql")
async def datasets_preview_sql(req: Request):
    """See what a query returns before saving it as a dataset."""
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    if missing := _need(body, "connection_id"):
        return missing
    try:
        src, _ = await _source(state, body["connection_id"], space)
    except NoSuchConnection as e:
        return _error(404, "unknown_connection", f"no connection {e}", "connection_id")

    try:
        sql = check_sql(body["sql"], src._spec.sqlglot_dialect, src.hidden)
    except BadSQL as e:
        return _error(422, "bad_sql", str(e), "sql",
                      detail=e.detail, at=e.at)

    limit = min(int(body.get("limit") or PREVIEW_ROWS), 200)
    try:
        cols, rows = await _run_sql(src, sql, limit)
    except Exception as e:  # noqa: BLE001 - the author's query is the cause
        return _error(422, "query_failed", _db_message(e), "sql")

    kinds = [_kind_of([r[i] for r in rows]) for i in range(len(cols))]
    return {
        "columns": [{"name": c, "kind": k.value} for c, k in zip(cols, kinds, strict=True)],
        "rows": [[_jsonable(v) for v in r] for r in rows],
        "row_count": len(rows),
        "truncated": len(rows) >= limit,
        "times": [c for c, k in zip(cols, kinds, strict=True) if k is ColKind.TIME],
    }


@router.post("/api/v1/datasets.create_virtual")
async def datasets_create_virtual(req: Request):
    """Save a SELECT as something panels can be built on.

    The columns are discovered by running it, exactly as introspection
    discovers a table's — so the declared-dimension rule that stops a panel
    naming a column the source does not have applies here unchanged.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    if missing := _need(body, "connection_id"):
        return missing
    actor = actor_of(req)

    try:
        src, conn_row = await _source(state, body["connection_id"], space)
    except NoSuchConnection as e:
        return _error(404, "unknown_connection", f"no connection {e}", "connection_id")

    try:
        sql = check_sql(body["sql"], src._spec.sqlglot_dialect, src.hidden)
    except BadSQL as e:
        return _error(422, "bad_sql", str(e), "sql",
                      detail=e.detail, at=e.at)

    try:
        cols, rows = await _run_sql(src, sql, PREVIEW_ROWS)
    except Exception as e:  # noqa: BLE001
        return _error(422, "query_failed", _db_message(e), "sql")
    if not cols:
        return _error(422, "no_columns", "that query returns no columns", "sql")

    kinds = [_kind_of([r[i] for r in rows]) for i in range(len(cols))]
    times = [c for c, k in zip(cols, kinds, strict=True) if k is ColKind.TIME]

    time_column = body.get("time_column")
    if time_column and time_column not in times:
        return _error(422, "bad_time_column",
                      f"{time_column} is not a temporal column of this query"
                      f"{'; found ' + ', '.join(times) if times else ' (it returns none)'}",
                      "time_column")
    time_column = time_column or (times[0] if times else None)

    ds_id = f"sql.{_slug(body['name'])[:40]}"
    dims = json.dumps([{"name": c, "column": c, "kind": k.value}
                       for c, k in zip(cols, kinds, strict=True)])
    grains = [g.value for g in src._spec.grains] if time_column else []

    await state["pool"].execute(
        "insert into datasets (id, space_id, connection_id, name, physical, is_virtual,"
        " time_column, grains, dimensions, created_by) values"
        " ($1,$2,$3,$4,$5,true,$6,$7,$8::jsonb,$9)"
        " on conflict (id) do update set physical = excluded.physical,"
        " time_column = excluded.time_column, grains = excluded.grains,"
        " dimensions = excluded.dimensions, updated_at = now()",
        ds_id, space, conn_row["id"], body["name"], sql, time_column, grains, dims, actor)

    return {
        "dataset_id": ds_id, "name": body["name"], "is_virtual": True,
        "time_column": time_column,
        "columns": [{"name": c, "kind": k.value} for c, k in zip(cols, kinds, strict=True)],
        "sampled_rows": len(rows),
    }


def _db_message(e: Exception) -> str:
    """The warehouse's complaint, without the Python wrapping around it.

    SQLAlchemy stringifies an asyncpg error as
    ``<class 'asyncpg.exceptions.UndefinedTableError'>: relation "x" does not
    exist``. The half after the colon is what an author needs; the half before
    it is an implementation detail of our driver stack shown to someone
    debugging their own SQL.
    """
    text = str(getattr(e, "__cause__", None) or e).split("\n")[0]
    return re.sub(r"^<class '[^']+'>:\s*", "", text).strip()[:300]


def _jsonable(v):
    from datetime import date, datetime
    from decimal import Decimal

    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


# ── editing a dashboard that already exists ─────────────────────────────
# The gap an adversarial review named and the last conversation made concrete:
# nothing created could be changed or removed. A wrong grain was a permanent
# 500, a typo in a title was permanent, and a dashboard built to try something
# out could only be abandoned in place.

async def _dashboard_row(state: dict, dashboard_id: str, space: str):
    row = await state["pool"].fetchrow(
        "select id, title, props from objects"
        " where id = $1 and space_id = $2 and type = 'dashboard' and deleted_at is null",
        dashboard_id, space)
    if row is None:
        raise NoSuchDashboard(dashboard_id)
    props = row["props"]
    if isinstance(props, str):
        props = json.loads(props)
    return row, (props or {})


@router.post("/api/v1/dashboards.update")
async def dashboards_update(req: Request):
    """Rename, and set the slice this dashboard opens on.

    Panels are edited through panels.add and panels.remove, so this stays two
    small things rather than a general-purpose object writer.

    The default filters are the difference between "I sliced this to EMEA" and
    "this dashboard is about EMEA". The first is a reading choice and lives in
    the URL; the second is a property of the page, and every reader re-typing
    it is how two people end up looking at different numbers under one title.
    It is still a READING choice — it does not touch certification, because
    slicing does not change what a metric means — it is just one somebody made
    on everyone's behalf, and said so.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, body.get("dashboard_id"), space, "edit", "dashboard_id"):
        return refused
    try:
        row, props = await _dashboard_row(state, body["dashboard_id"], space)
    except NoSuchDashboard as e:
        return _error(404, "unknown_dashboard", f"no dashboard {e}", "dashboard_id")

    sets, args = [], []
    if "title" in body:
        title = (body.get("title") or "").strip()
        if not title:
            return _error(422, "title_required", "a dashboard needs a title", "title")
        args.append(title)
        sets.append(f"title = ${len(args) + 1}")

    if "filters" in body:
        try:
            # The same parser the render uses, so a default that would be
            # refused at read time is refused at save time instead — a
            # dashboard cannot be saved into a state where it will not open.
            from commonindex.gateway.app import _dash_filters

            defaults = _dash_filters(body.get("filters"))
        except Exception as e:  # noqa: BLE001 - _BadFilter carries the field
            return _error(422, "bad_filter", str(e), getattr(e, "field", "filters"))
        props = {**props, "filters": defaults}
        args.append(json.dumps(props))
        sets.append(f"props = ${len(args) + 1}::jsonb")

    if not sets:
        return _error(422, "nothing_to_update",
                      "pass a title or filters", "title")

    await state["pool"].execute(
        f"update objects set {', '.join(sets)}, updated_at = now(),"
        " current_rev = current_rev + 1 where id = $1", row["id"], *args)
    await index_object(state["pool"], row["id"])
    return {"dashboard_id": row["id"], "title": body.get("title", row["title"]),
            "filters": props.get("filters", [])}


@router.post("/api/v1/dashboards.delete")
async def dashboards_delete(req: Request):
    """Tombstone, not DELETE.

    ``objects.deleted_at`` is a tombstone and recovery is replay — the schema
    says so at the column. Every read path already filters on it, so setting it
    is the whole operation.

    The metric definitions are deliberately left behind. A definition can be
    cited by panels on other dashboards, and even when it is not, deleting one
    is a governance act with its own decision — not a side effect of tidying a
    page away.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway import sharing

    async with state["pool"].acquire() as conn:
        item, refused = await sharing.require(req, conn, body.get("dashboard_id"), space, "view", "dashboard_id")
        if refused:
            return refused
        if not await sharing.may_delete(conn, actor_of(req), space, item):
            return _error(403, "not_allowed", "only its owners can delete this dashboard", "dashboard_id")
    try:
        row, _ = await _dashboard_row(state, body["dashboard_id"], space)
    except NoSuchDashboard as e:
        return _error(404, "unknown_dashboard", f"no dashboard {e}", "dashboard_id")

    async with state["pool"].acquire() as conn, conn.transaction():
        panels = await conn.fetch(
            "select panel_id from panel_bindings where dashboard_id = $1", row["id"])
        await conn.execute(
            "update objects set deleted_at = now() where id = any($1::text[])",
            [row["id"], *[p["panel_id"] for p in panels]])
        await index_object(conn, row["id"])
    return {"dashboard_id": row["id"], "deleted": True, "panels_removed": len(panels)}


@router.post("/api/v1/panels.add")
async def panels_add(req: Request):
    """Add a panel to a dashboard that already exists.

    ``metric_id`` is the important argument. Without it, every panel anywhere
    writes a NEW definition, and at N dashboards the registry holds N rows that
    all say ``COUNT(*)`` — the exact drift a metric registry exists to prevent,
    reintroduced by the authoring tool. Citing an existing definition is what
    makes "one number, one meaning" true in practice rather than in principle.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, body.get("dashboard_id"), space, "edit", "dashboard_id"):
        return refused
    author = actor_of(req)

    try:
        row, props = await _dashboard_row(state, body["dashboard_id"], space)
    except NoSuchDashboard as e:
        return _error(404, "unknown_dashboard", f"no dashboard {e}", "dashboard_id")

    # A panel may carry its own query instead of citing a definition. Checked
    # here rather than at render, so the author finds out while they are still
    # looking at it — and through the same guard `datasets.create_virtual`
    # uses, which refuses anything that is not exactly one SELECT.
    raw_sql = (body.get("sql") or "").strip()

    # A panel may name its own CONNECTION as well as its own dataset, and the
    # dataset has to be resolved against whichever it will actually read. This
    # validated against the dashboard's connection either way, so a panel on a
    # second warehouse was refused with "unknown dataset" naming a table that
    # exists — in a different database.
    dash_conn = props.get("connection_id")
    conn_id = body.get("connection_id") or dash_conn
    # A panel may name its OWN dataset. panel_bindings has carried dataset_id
    # per row since 0002; this handler pinned every panel to the dashboard's
    # default, so a dashboard could never mix a table with a saved query — and
    # "add a panel with SQL" had no path at all once you were past the wizard.
    ds_id = body.get("dataset_id") or props.get("dataset_id")
    # A panel carrying its own query names its own tables, so it binds to no
    # dataset — and resolving one anyway is not a harmless extra check. The
    # dashboard's dataset was looked up against the PANEL's connection, so a
    # SQL panel pointed at a second warehouse was refused with "unknown
    # dataset" naming a table that exists in a different database: exactly the
    # failure per-panel connections were added to fix, reintroduced one level
    # down. The connection is still required — the query has to run somewhere.
    if not conn_id or (not ds_id and not raw_sql):
        return _error(422, "not_editable",
                      "this dashboard has no stored connection, so a panel cannot be "
                      "compiled against it", "dashboard_id")
    ds = None
    try:
        src, _ = await _source(state, conn_id, space)
        if raw_sql:
            try:
                raw_sql = check_sql(raw_sql, src._spec.sqlglot_dialect, src.hidden)
            except BadSQL as e:
                return _error(422, "bad_sql", str(e), "sql",
                              detail=e.detail, at=e.at)
        else:
            ds = await src._dataset(ds_id)
    except (NoSuchConnection, LookupError) as e:
        return _error(404, "unknown_target", str(e), None)

    # A panel carrying its own query binds to nothing: there is no aggregate to
    # validate, no column for it to be over, and no grain it buckets into. The
    # statement already decided all three. Checking them anyway rejected the
    # panel for the shape of fields that have no meaning on it — `agg` is the
    # one the bench actually sent, and `bad_agg` was the answer.
    if not raw_sql:
        try:
            _check_binding(body, ds)
        except _Invalid as e:
            return _error(422, e.code, str(e), e.field)

    cited = body.get("metric_id")
    if raw_sql and cited:
        # Two answers to "where does this number come from" and no rule for
        # which wins. The database refuses this too; saying so here names the
        # field instead of surfacing a constraint violation.
        return _error(422, "sql_and_metric",
                      "a panel either carries its own query or cites a definition, "
                      "not both", "metric_id")
    async with state["pool"].acquire() as conn, conn.transaction():
        # Register the dataset before anything cites it. `dashboards.create`
        # does this for the tables it introspects; panels.add assumed the row
        # already existed, which held while every panel read the dashboard's
        # own connection and stopped holding the moment one could read another.
        # The metric written below has a foreign key to it, so without this the
        # insert fails with a constraint violation naming a table that exists —
        # in a different database.
        # Nothing to register for a panel that named its own tables.
        if ds is not None:
            await conn.execute(
                "insert into datasets (id, space_id, connection_id, name, physical,"
                " is_virtual, time_column, grains, dimensions, created_by) values"
                " ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) on conflict (id) do update"
                " set dimensions = excluded.dimensions, updated_at = now()",
                ds.id, space, conn_id, ds.id, ds.physical, ds.is_virtual,
                ds.time_column, [g.value for g in ds.grains], _dims_json(ds), author)

        if raw_sql:
            # It cites nothing, so it stores nothing. Writing a definition here
            # is what made a dashboard holding a SQL panel list as CERTIFIED
            # while its own page said otherwise — and quietly filled the
            # registry with one-off metrics nobody wrote on purpose.
            metric_id, version = None, None
        elif cited:
            m = await conn.fetchrow(
                "select id, version, status from metrics where id = $1 and space_id = $2"
                " order by version desc limit 1", cited, space)
            if m is None:
                return _error(404, "unknown_metric", f"no metric {cited}", "metric_id")
            metric_id, version = m["id"], m["version"]
        else:
            try:
                expr, unit, better = _definition(body, ds,
                                                 src._spec.sqlglot_dialect)
            except _Invalid as e:
                return _error(422, e.code, str(e), e.field)
            metric_id = f"{row['id']}.{_slug(body['title'])}"
            if await conn.fetchval("select 1 from metrics where id = $1", metric_id):
                return _error(409, "metric_exists",
                              f"{row['title']} already has a panel called {body['title']!r}; "
                              "each definition is stored under its own id", "title")
            may, why = await _may_ratify(conn, author)
            decision_id = f"dec-{metric_id}" if may else None
            if decision_id:
                await conn.execute(
                    "insert into objects (id, space_id, type, title, props, created_by)"
                    " values ($1,$2,'decision',$3,$4::jsonb,$5) on conflict (id) do nothing",
                    decision_id, space, f"Define {body['title']}",
                    json.dumps({"why": why, "metric_id": metric_id}), author)
            await conn.execute(
                "insert into metrics (id, version, space_id, dataset_id, label, expr,"
                " unit, better, status, ratified_by, created_by)"
                " values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                metric_id, space, ds.id, body["title"], expr, unit, better,
                "ratified" if may else "proposed", decision_id, author)
            version = 1

        position = await conn.fetchval(
            "select coalesce(max(position), -1) + 1 from panel_bindings"
            " where dashboard_id = $1", row["id"])
        panel_id = f"{row['id']}-p{position}-{hashlib.sha256(body['idempotencyKey'].encode()).hexdigest()[:6]}"
        await conn.execute(
            "insert into objects (id, space_id, type, title, props, created_by)"
            " values ($1,$2,'panel',$3,'{}'::jsonb,$4) on conflict (id) do nothing",
            panel_id, space, body["title"], author)
        await conn.execute(
            "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
            " metric_version, dimensions, grain, position, mark, title, filters, row_limit,"
            " sort, connection_id, sql)"
            " values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)",
            panel_id, row["id"], ds.id if ds is not None else None, metric_id, version,
            [body["dimension"]] if body.get("dimension") else [],
            body.get("grain") or "day", position, body.get("mark") or "line", body["title"],
            json.dumps(body.get("filters") or []), body.get("limit") or 0,
            body.get("sort") or "bucket",
            # Recorded only when it differs from the dashboard's, so a
            # single-warehouse dashboard stays free of per-panel bookkeeping
            # and null keeps meaning "whatever the dashboard reads".
            # `.get`, and only when one was actually named: the key is absent
            # on every panel that reads the dashboard's own warehouse, and
            # `body["connection_id"]` raised a KeyError on all of them because
            # None != the dashboard's id is True.
            conn_id if body.get("connection_id") and conn_id != dash_conn else None,
            raw_sql or None)
        from commonindex.gateway.sharing import follow

        await follow(conn, row["id"])
        await conn.execute(
            "update objects set updated_at = now() where id = $1", row["id"])
        await index_object(conn, row["id"])

    return {"panel_id": panel_id, "dashboard_id": row["id"],
            "metric_id": metric_id, "cited_existing": bool(cited)}


@router.post("/api/v1/panels.remove")
async def panels_remove(req: Request):
    """Take a panel off a dashboard.

    The binding goes and the panel object is tombstoned; the metric survives,
    for the same reason it survives a deleted dashboard.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    panel_id = body.get("panel_id", "")
    from commonindex.gateway.sharing import guard

    # Found through a dashboard in the caller's own space, and one they may
    # edit — it removed a panel by id from any space.
    dashboard_id = await state["pool"].fetchval(
        "select pb.dashboard_id from panel_bindings pb join objects o on o.id = pb.dashboard_id"
        " where pb.panel_id = $1 and o.space_id = $2", panel_id, space)
    if dashboard_id is None:
        return _error(404, "unknown_panel", f"no panel {panel_id}", "panel_id")
    if refused := await guard(req, dashboard_id, space, "edit", "panel_id"):
        return refused

    async with state["pool"].acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "select dashboard_id, metric_id from panel_bindings where panel_id = $1", panel_id)
        if row is None:
            return _error(404, "unknown_panel", f"no panel {panel_id}", "panel_id")
        await conn.execute("delete from panel_bindings where panel_id = $1", panel_id)
        await conn.execute(
            "update objects set deleted_at = now() where id = $1", panel_id)
        await conn.execute(
            "update objects set updated_at = now() where id = $1", row["dashboard_id"])
        await index_object(conn, row["dashboard_id"])
    return {"panel_id": panel_id, "dashboard_id": row["dashboard_id"],
            "metric_kept": row["metric_id"]}


# ── the semantic layer, as something else can read ──────────────────────
# Two projections of one registry. Apache Ossie is the interchange another BI
# tool reads; the skill is what an agent reads. Both are generated on request
# rather than stored, which is the whole point: staleness is one of the three
# ways an analytics agent goes wrong, and the usual fix — a documentation
# repo with CI holding it consistent — is a second copy that can disagree with
# the first. There is nothing here to disagree.

#: Caps on what one request will assemble. Neither read had a limit, so a space
#: with 500 datasets produced a megabyte of JSON in memory, and the usage query
#: fetched every binding in the space to render four per metric.
MAX_DATASETS = 200
MAX_CORPUS = 500


async def _semantic(state: dict, space: str, connection_id: str | None):
    """Read the datasets, their definitions, and how those are actually used."""
    args: list = [space]
    where = "where d.space_id = $1"
    if connection_id:
        args.append(connection_id)
        where += " and d.connection_id = $2"

    ds_rows = await state["pool"].fetch(
        "select d.id, d.connection_id, d.name, d.physical, d.is_virtual, d.time_column,"
        " d.grains, d.dimensions, d.description, d.grain_note, d.caveats,"
        " d.profile, d.profiled_at"
        f" from datasets d {where} order by d.id", *args)
    datasets = []
    for r in ds_rows:
        dims = r["dimensions"]
        if isinstance(dims, str):
            dims = json.loads(dims)
        prof = r["profile"]
        datasets.append({**dict(r), "dimensions": dims or [],
                         "grains": list(r["grains"] or []),
                         "profile": json.loads(prof) if isinstance(prof, str) else prof})

    ids = [d["id"] for d in datasets]
    keep = set(ids)
    # Through the registry, not around it. This used to be raw SQL on `metrics`
    # plus a second merge for the seeded ones — so the skill described a set of
    # definitions the resolver did not have, and the precedence rule existed in
    # two places. `all_definitions` is the governance view the protocol was
    # missing; `all_for` remains the query view.
    metrics = [
        {"id": m.id, "version": m.version, "dataset_id": m.dataset_id,
         "label": m.label, "expr": m.expr, "unit": m.unit, "better": m.better,
         "status": m.status, "ratified_by": m.ratified_by, "description": ""}
        for m in await state["metrics"].all_definitions(space)
    ]
    # Definitions the resolver will answer to, on datasets this space has not
    # registered — the platform's own seeded metrics, which live on an internal
    # source. Filtering them out left the skill claiming to list "the ratified
    # definitions" while `metrics.resolve` answered to ids it never mentioned,
    # which is the retrieval failure this file exists to prevent. They are
    # carried through and marked, so the reader knows the boundary.
    for m in metrics:
        m["undescribed"] = m["dataset_id"] is None or m["dataset_id"] not in keep

    # How each definition is actually asked. Every row is a panel someone
    # reviewed and kept — a corpus of real questions, not a query log.
    usage = []
    for r in await state["pool"].fetch(
        # b.dataset_id, so an example can be attributed to the dataset it
        # actually ran against. A cited metric can be bound to a panel on a
        # different dataset, and without this that panel was presented as how
        # this data is queried, though the query never touched it.
        "select b.metric_id, b.dataset_id, b.mark, b.grain, b.dimensions, b.filters,"
        " o.title as dashboard"
        " from panel_bindings b join objects o on o.id = b.dashboard_id"
        " where o.space_id = $1 and o.deleted_at is null and b.dataset_id = any($2::text[])"
        " order by o.updated_at desc limit $3", space, ids, MAX_CORPUS):
        f = r["filters"]
        usage.append({**dict(r), "dimensions": list(r["dimensions"] or []),
                      "filters": json.loads(f) if isinstance(f, str) else (f or [])})

    # The experiments, with what each one COMMITTED to measuring. An agent
    # asked to review a readout needs the contract more than it needs the
    # numbers: without it there is nothing to compare the readout against, and
    # "is this sound?" collapses into a matter of opinion.
    experiments = []
    for r in await state["pool"].fetch(
        "select id, title, props from objects"
        " where space_id = $1 and type = 'experiment' and deleted_at is null"
        " order by updated_at desc limit $2", space, MAX_CORPUS):
        props = json.loads(r["props"]) if isinstance(r["props"], str) else (r["props"] or {})
        experiments.append({
            "id": r["id"], "title": r["title"],
            "status": props.get("status") or "draft",
            "hypothesis": props.get("hypothesis") or "",
            "owner": props.get("owner") or "",
            "contract": props.get("contract") or None,
            "amendments": len(props.get("amendments") or []),
            # Where it is in its life, so an agent reads a stopped experiment as
            # stopped and does not recommend shipping one that has been killed.
            "progress": _exp_progress(props),
            "attention": _exp_attention(props),
            "decision": props.get("decision") or None,
        })
    return datasets, metrics, usage, experiments


def _exp_progress(props: dict) -> dict:
    from commonindex.gateway.experiments import progress
    return progress(props)


def _exp_attention(props: dict) -> list[str]:
    from commonindex.gateway.experiments import attention, progress
    return attention(props, progress(props))


@router.post("/api/v1/semantic.export")
async def semantic_export(req: Request):
    """The semantic layer as Apache Ossie YAML."""
    from commonindex.adapters import ossie

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    # Experiments are deliberately dropped here: Ossie describes a semantic
    # model — datasets, metrics, their expressions — and an experiment is not
    # part of that vocabulary. The skill is where they belong.
    datasets, metrics, usage, _ = await _semantic(
        state, space, body.get("connection_id"))
    corpus: dict[str, list[dict]] = {}
    for u in usage:
        corpus.setdefault(u["metric_id"], []).append(u)
    doc = ossie.to_ossie(space, datasets, metrics, corpus=corpus)
    return {
        "spec": "apache-ossie", "spec_version": ossie.SPEC_VERSION,
        "yaml": ossie.dump(doc), "document": doc,
        "datasets": len(datasets),
        "metrics": len([m for m in metrics if m["status"] == "ratified"]),
        # Counted apart. A deprecated version is a superseded definition, not an
        # unreviewed one, and reporting them together made a retired metric look
        # like something withheld for lacking review.
        "omitted_unratified": len([m for m in metrics if m["status"] == "proposed"]),
        "omitted_deprecated": len([m for m in metrics if m["status"] == "deprecated"]),
    }


def _public_address(req: Request) -> str:
    """Where an agent reaches this gateway: the deployment's public URL, else
    the address this request came in on. It was always localhost:8000, which
    is only right for one way of running it in development."""
    import os

    public = os.environ.get("COMMONINDEX_PUBLIC_URL", "").strip().rstrip("/")
    return public or str(req.base_url).rstrip("/")


@router.post("/api/v1/context.skill")
async def context_skill(req: Request):
    """The Agent Skill for this warehouse."""
    from commonindex.adapters import dataskill

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    datasets, metrics, usage, experiments = await _semantic(
        state, space, body.get("connection_id"))
    files = dataskill.build(space, datasets, metrics, usage,
                            experiments=experiments,
                            gateway=body.get("gateway") or _public_address(req))
    if body.get("zip"):
        # The folder a skill is installed as: <name>/SKILL.md and the rest.
        import io
        import zipfile

        from fastapi.responses import Response

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for path, text in sorted(files.items()):
                z.writestr(f"{dataskill.SKILL_NAME}/{path}", text)
        return Response(buf.getvalue(), media_type="application/zip", headers={
            "content-disposition": f'attachment; filename="{dataskill.SKILL_NAME}.zip"'})
    return dataskill.as_bundle(files)


#: A documentation field is long-form prose, not unbounded. The cap is here
#: because these strings reach a model's instruction context, and "how much
#: untrusted text can one row inject" should have an answer.
MAX_DOC = 2000


@router.post("/api/v1/datasets.describe")
async def datasets_describe(req: Request):
    """Write the reference documentation a generator cannot produce.

    Migration 0007 added `grain_note`, `description` and `caveats` and nothing
    could write them — so the one part of the context that needs a human had no
    authoring path, and would in practice be filled in by psql. That is the
    second copy of the truth this design argues against, arriving through the
    back door.

    Grain is the field that earns its place: whether one row is one event or one
    event per participant is the difference between a correct count and a
    plausible wrong one, and no schema states it.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)

    def doc(key: str) -> str | None:
        v = body.get(key)
        return None if v is None else str(v)[:MAX_DOC]

    out: dict[str, Any] = {}
    ds_id = body.get("dataset_id")
    if ds_id:
        row = await state["pool"].fetchrow(
            "update datasets set"
            " grain_note  = coalesce($3, grain_note),"
            " description = coalesce($4, description),"
            " caveats     = coalesce($5, caveats),"
            " updated_at  = now()"
            " where id = $1 and space_id = $2 returning id, grain_note, description, caveats",
            ds_id, space, doc("grain_note"), doc("description"), doc("caveats"))
        if row is None:
            return _error(404, "unknown_dataset", f"no dataset {ds_id}", "dataset_id")
        out["dataset"] = dict(row)

    m_id = body.get("metric_id")
    if m_id:
        row = await state["pool"].fetchrow(
            "update metrics set description = coalesce($3, description)"
            " where id = $1 and space_id = $2 returning id, description",
            m_id, space, doc("metric_description"))
        if row is None:
            return _error(404, "unknown_metric", f"no metric {m_id}", "metric_id")
        out["metric"] = dict(row)
        await index_users_of(state["pool"], m_id)

    if not out:
        return _error(422, "nothing_to_write",
                      "pass a dataset_id or a metric_id", "dataset_id")
    return out


# ── profiling: what the data actually holds ─────────────────────────────

#: Above this many distinct values a column is not a category, and listing them
#: is a wall of text rather than a hint. Naming the count is still useful — it
#: tells an agent the column is an identifier, not something to group by.
MAX_CATEGORY = 40
#: Columns to profile per dataset. Each costs a GROUP BY over the source.
MAX_PROFILED_COLUMNS = 10


async def _distinct(src, ds, dim, limit: int, since):
    """The values a column takes, or — for a number — the range it spans.

    The same scan `datasets.profile` runs, on demand for one column instead of
    stored for ten. Bounded the same way and for the same reason: `build.py`
    says an unbounded scan of a fact table is how a dashboard becomes a billing
    incident, and a filter picker is the last place that should be true, since
    it fires while somebody is still deciding what to ask.

    Returns (values, truncated, bounds). `bounds` is None unless the column is
    a number, where the distinct values of a float are not a list anyone wants
    and what a reader needs is that it runs from 3 to 30.
    """
    from sqlalchemy import text as sa_text

    dialect = src._spec.sqlglot_dialect
    source = f"({ds.physical})" if ds.is_virtual else quote(ds.physical, dialect)
    col = quote(dim.column, dialect)
    where, binds = "", {}
    if since is not None and ds.time_column:
        where = f" WHERE {quote(ds.time_column, dialect)} >= :since"
        binds["since"] = since

    numeric = (dim.kind.value if hasattr(dim.kind, "value") else str(dim.kind)) == "number"
    if numeric:
        stmt = f"SELECT MIN({col}) AS lo, MAX({col}) AS hi FROM {source} AS s{where}"
    else:
        # One more than asked for, so "there are exactly this many" and "there
        # are at least this many" are distinguishable.
        stmt = (f"SELECT {col} AS v, COUNT(*) AS n FROM {source} AS s{where}"
                f" GROUP BY {col} ORDER BY n DESC")
        stmt = src._spec.limit(stmt, limit + 1)

    def go(conn):
        rows = conn.execute(sa_text(stmt), binds).all()
        if numeric:
            r = rows[0] if rows else (None, None)
            return [], False, (r[0], r[1]) if r[0] is not None else None
        return ([(v, n) for v, n in rows[:limit]], len(rows) > limit, None)

    async def go_async(conn):
        return await conn.run_sync(lambda c: go(c))

    return await (src._do(go_async) if src.is_async else src._do(go))


@router.post("/api/v1/datasets.profile")
async def datasets_profile(req: Request):
    """Scan a dataset and record its shape.

    The reference docs this feeds carry grain and gotchas already — both need a
    human. Scope does not: row count, the period covered, and the values each
    categorical column takes are all derivable, and the last one is the
    difference between a filter that works and one that matches nothing.

    Bounded and explicit rather than done on every skill read: profiling scans
    the customer's warehouse, and that is their bill.
    """
    from sqlalchemy import text as sa_text

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    if missing := _need(body, "connection_id"):
        return missing
    try:
        src, _ = await _source(state, body["connection_id"], space)
    except NoSuchConnection as e:
        return _error(404, "unknown_connection", f"no connection {e}", "connection_id")

    wanted = [body["dataset_id"]] if body.get("dataset_id") else None
    declared = await _declared(state, body["connection_id"])
    targets = [d for d in declared.values() if wanted is None or d.id in wanted]
    if wanted and not targets:
        return _error(404, "unknown_dataset", f"no dataset {wanted[0]}", "dataset_id")

    dialect = src._spec.sqlglot_dialect
    rng = body.get("range", "90d")
    if rng not in RANGES:
        return _error(422, "bad_range", f"range must be one of {sorted(RANGES)}", "range")
    since = datetime.now(tz=UTC) - RANGES[rng]
    done = []
    for ds in targets:
        source = f"({ds.physical})" if ds.is_virtual else quote(ds.physical, dialect)
        cats = [d for d in ds.dimensions if d.kind is ColKind.STRING][:MAX_PROFILED_COLUMNS]

        # Bounded, which it was not. `build.py` states the rule this was
        # breaking — "an unbounded scan of a warehouse fact table is how a
        # dashboard becomes a billing incident, so a caller cannot opt out by
        # omitting the window" — and this ran one COUNT(*) plus up to ten
        # GROUP BYs across all of history, on a `read` grant.
        #
        # A profile of the recent window is also the more useful artefact: what
        # a column takes NOW is what a slicer offers, and a value last seen
        # three years ago is not a slice anyone wants. The window is stored
        # with the profile so nobody reads it as all-time.
        where = ""
        if ds.time_column:
            tc = quote(ds.time_column, dialect)
            where = f" WHERE {tc} >= :since"
            head = (f"SELECT COUNT(*) AS n, MIN({tc}) AS lo, MAX({tc}) AS hi"
                    f" FROM {source} AS s{where}")
        else:
            head = f"SELECT COUNT(*) AS n FROM {source} AS s"

        def go(conn, _head=head, _cats=cats, _src=source, _w=where):
            binds = {"since": since} if _w else {}
            row = conn.execute(sa_text(_head), binds).mappings().first()
            out = {"rows": row["n"], "from": row.get("lo"), "to": row.get("hi"),
                   # What this profile covers. Without it a reader cannot tell
                   # a column with three values from a column whose other
                   # forty stopped appearing last year.
                   "window": rng if _w else "all time — this dataset has no time column",
                   "columns": {}}
            for c in _cats:
                col = quote(c.column, dialect)
                r = conn.execute(sa_text(
                    f"SELECT {col} AS v, COUNT(*) AS n FROM {_src} AS s{_w}"
                    f" GROUP BY {col} ORDER BY n DESC LIMIT {MAX_CATEGORY + 1}"),
                    binds).all()
                out["columns"][c.name] = {
                    "distinct": len(r),
                    "capped": len(r) > MAX_CATEGORY,
                    "values": [[_jsonable(v), n] for v, n in r[:MAX_CATEGORY]],
                }
            return out

        async def go_async(conn, _go=go):
            return await conn.run_sync(lambda sync_conn: _go(sync_conn))

        try:
            prof = await (src._do(go_async) if src.is_async else src._do(go))
        except Exception as e:  # noqa: BLE001 - one bad dataset must not stop the rest
            done.append({"dataset_id": ds.id, "error": _db_message(e)})
            continue

        await state["pool"].execute(
            "update datasets set profile = $3::jsonb, profiled_at = now()"
            " where id = $1 and space_id = $2",
            ds.id, space, json.dumps(prof, default=str))
        done.append({"dataset_id": ds.id, "rows": prof["rows"],
                     "columns_profiled": len(prof["columns"])})

    return {"profiled": done}


# ── experiment readouts ─────────────────────────────────────────────────

#: The last readouts read for the page, briefly, for the AI beside it. Opening
#: an experiment read the warehouse twice — once for the page and again inside
#: experiments.explain, only to check its kept summary still matched — so the
#: cost of a visit was two full readouts. Keyed by who asked, where, and what,
#: so one caller never gets another's rows. Only `recent_readout` reads it; the
#: readout op itself always reads the warehouse, so Refresh means refresh.
_RECENT: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_RECENT_S = 60.0
_RECENT_KEEP = 128


def _recent_key(req: Request, body: dict) -> tuple | None:
    """Who asked, where, and what — or None when there is no caller to key by,
    in which case nothing is kept: a readout is never shared without one."""
    try:
        return (actor_of(req), space_of(req, body), body.get("experiment_id"), body.get("range") or "30d")
    except Exception:  # noqa: BLE001
        return None


def recent_readout(req: Request, body: dict) -> dict | None:
    """This caller's readout of the same experiment from the last minute, if any."""
    key = _recent_key(req, body)
    hit = _RECENT.get(key) if key else None
    if hit and time.monotonic() - hit[0] < _RECENT_S:
        return hit[1]
    return None


@router.post("/api/v1/experiments.readout")
async def experiments_readout(req: Request):
    """Split a dataset by variation, aggregate, and test the difference — and
    keep it a minute for the AI on the same page (see `_RECENT`)."""
    body = await req.json()
    keep = bool(body.get("experiment_id")) and not body.get("record")
    key = _recent_key(req, body) if keep else None
    out = await _experiments_readout(req)
    if key and isinstance(out, dict):
        _RECENT[key] = (time.monotonic(), out)
        _RECENT.move_to_end(key)
        while len(_RECENT) > _RECENT_KEEP:
            _RECENT.popitem(last=False)
    return out


async def _experiments_readout(req: Request):
    """Split a dataset by variation, aggregate, and test the difference.

    The model is the standard one — exposure joined to outcome, aggregated per arm,
    statistics over the summary — because that model is right and warehouse
    native. What is different is the metric: this reads a column the DATASET
    declares, and the dataset is the same registry object a dashboard reads, so
    an experiment and a dashboard measuring "activation" cannot drift apart.
    The join lives in the saved query, which is why no new machinery is needed.
    """
    from sqlalchemy import text as sa_text

    from commonindex.core.inference import Arm, compare, verdict
    from commonindex.core.inference.stats import DEFAULT_TUNING
    from commonindex.core.warehouse.readout import Spec, pick_control
    from commonindex.core.warehouse.readout import build as build_readout
    from commonindex.core.warehouse.readout import build_many as build_readout_many

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)

    # A pre-registered experiment answers from its contract, not from whatever
    # the caller passed. That is the difference between a readout and a query:
    # the primary question was settled before the data existed, and nothing in
    # this request can move it.
    contract, exp, notes = None, None, []
    if body.get("experiment_id"):
        try:
            exp, contract = await _contract_for(state, body["experiment_id"], space)
        except LookupError:
            return _error(404, "unknown_experiment",
                          f"no experiment {body['experiment_id']}", "experiment_id")
        except NotPreRegistered:
            return _error(422, "not_pre_registered",
                          f"{body['experiment_id']} carries no contract, so there is "
                          "nothing to hold the readout to. Register one before "
                          "reading it out.", "experiment_id")
        try:
            body, pins, notes = _merge_contract(body, contract, exp)
        except ValueError as e:
            return _error(409, "contract_override",
                          f"{e} is fixed by the pre-registration and cannot be "
                          "overridden on a readout — being able to change it after "
                          "seeing the numbers is the whole reason the contract "
                          "exists. Amend the experiment if it is genuinely wrong.",
                          str(e))
    else:
        pins = {}

    alpha = float(body.get("alpha") or 0.05)
    # Default ON, which is the opposite of every fixed-horizon tool — because
    # the caller here is usually an agent, and an agent watching an experiment
    # calls this every hour forever. Daily peeking takes the real false-positive
    # rate from 5% to about 26%; continuous monitoring passes 30%. A caveat in a
    # JSON response does not stop a loop, so the default has to be the safe one.
    sequential = bool(body.get("sequential", True))
    tuning = int(body.get("tuning") or DEFAULT_TUNING)

    missing = [f for f in ("connection_id", "dataset_id", "variation", "outcome")
               if not body.get(f)]
    if missing:
        # Reached by asking for a readout with neither a contract nor the
        # arguments to build one. A KeyError here was a 500 that told an agent
        # nothing it could act on.
        return _error(422, "incomplete_readout",
                      f"missing {', '.join(missing)} — either pass experiment_id to "
                      "inherit a pre-registered contract, or name all four directly",
                      missing[0])

    try:
        src, _ = await _source(state, body["connection_id"], space)
        ds = await src._dataset(body["dataset_id"])
    except (NoSuchConnection, LookupError) as e:
        return _error(404, "unknown_target", str(e), None)

    rng = body.get("range", "30d")
    if rng not in RANGES:
        return _error(422, "bad_range", f"range must be one of {sorted(RANGES)}", "range")
    now = datetime.now(tz=UTC)
    win_start, win_end, win_basis, win_note = _window_for(exp, rng, now)
    window = Window(win_start, win_end) if ds.time_column else None

    guards = [g if isinstance(g, dict) else {"outcome": g} for g in body.get("guardrails") or []]
    shape = {g["outcome"]: g for g in guards}
    outcomes = [body["outcome"], *(g["outcome"] for g in guards)]
    kinds = {d.name: d.kind for d in ds.dimensions}

    def is_binary(i: int, outcome: str) -> bool:
        """Said, or else read off the column. Defaulting to 0/1 made revenue a
        proportion, and the readout then refused it as one that left 0..1."""
        said = body.get("binary") if i == 0 else shape[outcome].get("binary")
        if said is not None:
            return bool(said)
        kind = kinds.get(outcome)
        if kind is ColKind.BOOL:
            return True
        if kind is ColKind.NUMBER:
            return False
        # A guardrail is usually a different shape from the target — a rate
        # against a duration — so only the first is assumed binary.
        return i == 0

    # Which way is good. This cannot be inferred and must not be assumed: the
    # same significant movement is a win on conversion and a regression on
    # latency, and a readout that guesses will congratulate you for the wrong
    # one. Citing a ratified definition answers it — `better` is a property
    # somebody stood behind — and where none is cited the response says the
    # direction was assumed rather than quietly using it.
    cited = body.get("metric_ids") or {}
    directions: dict[str, dict] = {}
    for outcome in outcomes:
        mid = cited.get(outcome)
        if not mid:
            said = (shape.get(outcome) or {}).get("better")
            directions[outcome] = {"better": said or "up", "id": None, "said": bool(said)}
            continue
        want = pins.get(outcome)
        if want is not None:
            # The version in force at registration, even if it has since been
            # superseded. Following the current ratified definition instead
            # would silently re-aim the experiment at a different question.
            try:
                m = await state["metrics"].resolve_version(space, mid, want)
            except LookupError:
                return _error(404, "unknown_metric_version",
                              f"the contract pins {mid} at v{want}, which no longer "
                              "exists in this space", "metric_ids")
            try:
                current = await state["metrics"].resolve(space, mid)
                if current.version != want:
                    notes.append(
                        f"{mid} is pinned at v{want} by the contract; v{current.version} "
                        "is what is ratified today. The readout uses the pinned one, "
                        "so this experiment and a dashboard citing the same metric "
                        "will legitimately differ.")
            except LookupError:
                pass
        else:
            try:
                m = await state["metrics"].resolve(space, mid)
            except LookupError:
                return _error(404, "unknown_metric", f"no metric {mid}", "metric_ids")
            if m.status != "ratified":
                return _error(422, "unratified_metric",
                              f"{mid} is {m.status}; a readout may only cite a definition "
                              "somebody has stood behind", "metric_ids")
        directions[outcome] = {
            "better": m.better or "up", "id": m.id, "label": m.label,
            "version": m.version, "status": m.status, "unit": m.unit,
            "expr": m.expr,
        }

    # Before anything is measured. The randomiser is the only thing making the
    # arms comparable, so if the delivered split does not match the designed one
    # then something else also chose who landed where -- and every lift below is
    # measuring that something. Run once here rather than per outcome: it is a
    # property of the assignment, not of what you chose to measure.
    srm = await _srm_check(src, ds, body, now, window=window)
    assignment_broken = srm.get("ran") and not srm["passed"]

    results = []

    async def _fetch(compiled):
        def go(conn, _c=compiled):
            return conn.execute(sa_text(_c.sql), _c.params).mappings().all()

        async def go_async(conn, _c=compiled):
            return (await conn.execute(sa_text(_c.sql), _c.params)).mappings().all()

        return await (src._do(go_async) if src.is_async else src._do(go))

    specs = [Spec(dataset_id=ds.id, variation=body["variation"], outcome=outcome,
                  cohort=body.get("cohort") or None,
                  unit=body.get("unit"), unit_agg=body.get("unit_agg") or "sum",
                  cap=body.get("cap"),
                  null_is_zero=bool(body.get("null_is_zero", True)),
                  binary=is_binary(i, outcome),
                  window=window) for i, outcome in enumerate(outcomes)]

    # Every outcome in one pass over the table, rather than one query each:
    # twenty-three metrics were twenty-three scans. The numbers are the same
    # (tests/test_readout_one_pass.py); if the combined query fails, each
    # outcome is read on its own below, so an error still lands on the outcome
    # that caused it.
    together: dict[str, list[dict]] = {}
    readable = []
    for sp in specs:
        try:
            build_readout(src._spec, ds, sp)
            readable.append(sp)
        except (UndeclaredDimension, ValueError):
            pass
    if len(readable) > 1:
        try:
            batch = await _fetch(build_readout_many(src._spec, ds, readable))
            for j, sp in enumerate(readable):
                together[sp.outcome] = [
                    {"variation": r["variation"], **({"cohort": r["cohort"]} if sp.cohort else {}),
                     "n": r["n"], "total": r[f"total_{j}"],
                     "sum_sq": r.get(f"sum_sq_{j}")} for r in batch]
        except Exception:  # noqa: BLE001 - read them one by one instead
            together = {}

    for i, outcome in enumerate(outcomes):
        spec = specs[i]
        try:
            compiled = build_readout(src._spec, ds, spec)
        except (UndeclaredDimension, ValueError) as e:
            results.append({"outcome": outcome, "error": str(e)})
            continue

        if outcome in together:
            rows = together[outcome]
        else:
            try:
                rows = await _fetch(compiled)
            except Exception as e:  # noqa: BLE001 - the author's dataset is the cause
                results.append({"outcome": outcome, "error": _db_message(e)})
                continue

        def _arm(r) -> Arm:
            return Arm(name=str(r["variation"]), n=int(r["n"]),
                       total=float(r["total"] or 0),
                       sum_sq=float(r["sum_sq"]) if r.get("sum_sq") is not None else None)

        # With a cohort the query returns one row per (arm, cohort). Summing
        # those back up is exact for n, Σx and Σx², so the overall reading costs
        # no second query — and every cohort is compared against its own
        # control, never against the whole population.
        cohort_arms: dict[str, list[Arm]] = {}
        if spec.cohort:
            for r in rows:
                cohort_arms.setdefault(str(r["cohort"]), []).append(_arm(r))
            pooled: dict[str, Arm] = {}
            for arms_in_cohort in cohort_arms.values():
                for a in arms_in_cohort:
                    p = pooled.get(a.name)
                    pooled[a.name] = a if p is None else Arm(
                        name=a.name, n=p.n + a.n, total=p.total + a.total,
                        sum_sq=None if p.sum_sq is None or a.sum_sq is None
                        else p.sum_sq + a.sum_sq)
            arms = sorted(pooled.values(), key=lambda a: a.name)
        else:
            arms = [_arm(r) for r in rows]
        if len(arms) < 2:
            results.append({"outcome": outcome,
                            "error": f"only {len(arms)} arm(s); a readout needs at least two"})
            continue

        try:
            control_name = pick_control([a.name for a in arms], body.get("control"))
        except ValueError as e:
            return _error(422, "unknown_control", str(e), "control")
        control = next(a for a in arms if a.name == control_name)

        def _cmp_row(c, better, alpha):
            """One comparison, shaped once — a cohort's row and the overall row
            are the same fields or a reader cannot compare them."""
            return {
                "variation": c.variation, "baseline": c.baseline,
                "n": c.n, "baseline_n": c.baseline_n,
                "mean": c.mean, "baseline_mean": c.baseline_mean,
                "lift": c.lift, "lift_ci": list(c.lift_ci) if c.lift_ci else None,
                "p_value": c.p_value, "test": c.test,
                "undecidable": c.undecidable,
                "verdict": verdict(c, better, alpha),
            }

        d = directions[outcome]
        better, cited_id = d["better"], d["id"]
        comparisons = []
        for a in arms:
            if a.name == control_name:
                continue
            c = compare(control, a, binary=spec.binary, alpha=alpha,
                        sequential=sequential, tuning=tuning)
            row = _cmp_row(c, better, alpha)
            if assignment_broken:
                # The interval is still returned, because diagnosing an SRM
                # needs to see which way the arms moved. But the verdict is the
                # field an agent reads to decide, and there is no lift here that
                # anyone should act on -- so it says so, in the same vocabulary
                # `undecidable` already uses.
                row["verdict"] = "no answer"
                row["invalidated_by"] = "srm"
            comparisons.append(row)
        results.append({
            "outcome": outcome, "role": "target" if i == 0 else "guardrail",
            # Where this number came from. One flat dataset is what the readout
            # queries, but it was assembled from several tables and a reader is
            # entitled to know which.
            **({"source": (body.get("sources") or {}).get(outcome)}
               if (body.get("sources") or {}).get(outcome) else {}),
            "cites": cited_id,
            # The human name, so a reader is not left decoding an id. Absent when
            # nothing was cited, which the page reports rather than papering over.
            "metric_label": d.get("label"),
            "metric_version": d.get("version"),
            "metric_status": d.get("status"),
            "metric_expr": d.get("expr"),
            "unit": d.get("unit"),
            "better": better,
            "direction_assumed": cited_id is None and not d.get("said"),
            "control": control_name, "binary": spec.binary,
            "arms": [{"name": a.name, "n": a.n, "mean": a.mean} for a in arms],
            "comparisons": comparisons,
            # Each cohort compared against its own control. A cohort too small
            # to hold two arms is reported as such rather than dropped, because
            # a segment silently missing from a breakdown reads as a segment
            # that was not affected.
            **({"cohorts": [
                {"cohort": name,
                 "arms": [{"name": a.name, "n": a.n, "mean": a.mean} for a in sorted(cas, key=lambda a: a.name)],
                 **({"comparisons": [
                        _cmp_row(compare(cc, a, binary=spec.binary, alpha=alpha,
                                         sequential=sequential, tuning=tuning), better, alpha)
                        for a in sorted(cas, key=lambda a: a.name) if a.name != control_name]}
                    if (cc := next((a for a in cas if a.name == control_name), None)) is not None
                    else {"error": f"no {control_name} arm in this cohort"}),
                 }
                for name, cas in sorted(cohort_arms.items())]}
               if spec.cohort else {}),
        })

    payload = {
        "dataset_id": ds.id, "range": rng if win_basis == "range" else None,
        # What was read, stated rather than implied by a range name.
        # With the reason when it is not the experiment's own: a note about
        # WHICH DAYS were read, kept apart from the notes comparing this
        # reading with the contract.
        "window": {"start": win_start.isoformat(), "end": win_end.isoformat(),
                   "basis": win_basis, "applied": window is not None,
                   **({"note": win_note} if win_note else {})},
        "alpha": alpha,
        "sequential": sequential,
        **({"tuning": tuning} if sequential else {}),
        "srm": srm,
        # Whether anything constrained this readout, and what. A reader can tell
        # a pre-registered result from an exploratory one without asking.
        "pre_registered": contract is not None,
        **({"experiment": {"id": exp["id"], "title": exp["title"],
                           "registered_at": contract.get("registered_at"),
                           "planned_days": contract.get("planned_days"),
                           "mde": contract.get("mde")}}
           if contract else {}),
        **({"contract_notes": notes} if notes else {}),
        "results": results,
        # Named rather than assumed. Each of these changes the number, and a
        # readout that silently omits one is an interval that does not mean what
        # it says.
        "caveats": [
            # First, and unconditionally first: nothing below means anything if
            # the arms were not comparable to begin with.
            *([(f"SAMPLE RATIO MISMATCH (p={srm['p_value']:.2e}, threshold "
                f"{srm['threshold']:g}). The delivered split does not match the "
                "designed one, so the arms are not comparable and every lift "
                "below is confounded with whatever caused the imbalance. "
                f"Furthest from its design: {srm['worst']!r}. Diagnose the "
                "assignment before reading any number here.")]
              if assignment_broken else []),
            *([f"The sample-ratio check could not run: {srm['error']}."]
              if not srm.get("ran") else []),
            *([srm["warning"]] if srm.get("warning") else []),
            *([srm["note"]] if srm.get("note") else []),
            *([("Always-valid intervals (Waudby-Smith et al. 2023): valid at every "
                f"sample size, so this may be read as often as you like. Tuned for ~{tuning} "
                "observations, where it is tightest. It is wider than a one-look interval, "
                "and that width is what buys the freedom to look.")]
              if sequential else
              [("FIXED-HORIZON interval: valid for ONE look. Reading it repeatedly takes "
                "the real false-positive rate from 5% to roughly 26% daily, and past 30% "
                "under continuous monitoring. Do not poll this.")]),
            ("No variance reduction (CUPED) and no multiple-comparison adjustment "
             "across metrics."),
            *([] if body.get("unit") else
              [("No unit column given, so n counts ROWS. If this dataset has more "
                "than one row per user, every interval below is too narrow and "
                "every p-value too small. Pass `unit` to fix it.")]),
            *([] if all(r.get("cites") for r in results if "error" not in r) else
              [("Some outcomes cite no ratified definition, so 'better' was assumed "
                "to be up for those. Pass metric_ids to make the direction a "
                "property somebody stood behind.")]),
        ],
    }

    # Recording is deliberate, never automatic. A readout is recomputed on every
    # page load, and writing a row for each would turn an audit trail into a
    # traffic log. What is worth keeping is what somebody read at the moment
    # they decided something.
    if body.get("record"):
        recorded, err = await _record_readout(state, space, body, exp, payload,
                                             actor_of(req))
        if err:
            return err
        payload["recorded"] = recorded

    return payload


# ── sample ratio mismatch ───────────────────────────────────────────────

async def _srm_check(src, ds, body: dict, now: datetime, *, window=None) -> dict:
    """Count units per arm and test the split against the designed one.

    Shared by ``experiments.srm`` and ``experiments.readout`` so the two cannot
    give different answers to the same question — the same reason a panel cites
    a metric id instead of carrying its own copy of the expression.

    Returns a dict rather than raising, because in the readout this is one
    section of a larger response: a check that cannot run must say why on its
    own face without taking the readout down with it.
    """
    from sqlalchemy import text as sa_text

    from commonindex.core.inference.srm import DEFAULT_THRESHOLD, check_srm
    from commonindex.core.warehouse.readout import counts as build_counts

    rng = body.get("range", "30d")
    # `is None`, not `or`. `float(0 or DEFAULT)` silently substituted the
    # default for a threshold of 0 — the one value that means "never call this
    # split broken", which is a legitimate thing to ask for and was the one
    # thing that could not be said.
    raw = body.get("threshold")
    threshold = DEFAULT_THRESHOLD if raw is None else float(raw)
    unit = body.get("unit")

    try:
        compiled = build_counts(
            src._spec, ds, body["variation"], unit=unit,
            # The readout's own window when it has one, so the split checked is
            # the split the numbers below were computed on.
            window=window if window is not None
            else (Window(now - RANGES[rng], now) if ds.time_column else None))
    except (UndeclaredDimension, ValueError) as e:
        return {"ran": False, "error": str(e)}

    def go(conn, _c=compiled):
        return conn.execute(sa_text(_c.sql), _c.params).mappings().all()

    async def go_async(conn, _c=compiled):
        return (await conn.execute(sa_text(_c.sql), _c.params)).mappings().all()

    try:
        rows = await (src._do(go_async) if src.is_async else src._do(go))
    except Exception as e:  # noqa: BLE001 - the author's dataset is the cause
        return {"ran": False, "error": _db_message(e)}

    observed = [(str(r["variation"]), int(r["n"])) for r in rows]
    if len(observed) < 2:
        return {"ran": False,
                "error": f"only {len(observed)} arm(s); a split needs at least two"}

    weights = body.get("weights") or None
    if weights is not None:
        try:
            weights = {str(k): float(v) for k, v in weights.items()}
        except (TypeError, ValueError, AttributeError):
            return {"ran": False, "error": "weights must be an object of arm -> number"}

    try:
        result = check_srm(observed, weights=weights, threshold=threshold)
    except ValueError as e:
        return {"ran": False, "error": str(e)}

    out = {
        "ran": True,
        "passed": result.passed,
        "p_value": result.p_value,
        "statistic": result.statistic,
        "df": result.df,
        "threshold": result.threshold,
        "total": result.total,
        "counted": "units" if unit else "rows",
        "arms": [{"name": a.name, "observed": a.observed,
                  "expected": round(a.expected, 2), "ratio": round(a.ratio, 5)}
                 for a in result.arms],
        "worst": result.worst,
    }
    if result.note:
        out["note"] = result.note
    if not unit:
        # Not a footnote. Counting rows inflates the statistic by the rows-per-
        # unit factor, so this is the difference between a real alarm and one
        # manufactured by the query.
        out["warning"] = (
            "counted ROWS, not units — pass `unit` (the column the experiment "
            "randomised on). A chi-square scales linearly in N, so k rows per "
            "unit multiplies the statistic by k and fails an even split.")
    if weights is None:
        out["assumed_even_split"] = True
    return out


@router.post("/api/v1/experiments.srm")
async def experiments_srm(req: Request):
    """Did the assignment work? Ask before trusting any number in a readout.

    A sample ratio mismatch is not a data-quality nit. The randomiser is the
    only thing making two groups comparable; when the delivered split does not
    match the designed one, something else also chose who landed where, and the
    lift is measuring that something.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)

    rng = body.get("range", "30d")
    if rng not in RANGES:
        return _error(422, "bad_range", f"range must be one of {sorted(RANGES)}", "range")

    try:
        src, _ = await _source(state, body["connection_id"], space)
        ds = await src._dataset(body["dataset_id"])
    except (NoSuchConnection, LookupError) as e:
        return _error(404, "unknown_target", str(e), None)

    result = await _srm_check(src, ds, body, datetime.now(tz=UTC))
    if not result["ran"]:
        return _error(422, "srm_unavailable", result["error"], None)
    return {"dataset_id": ds.id, "range": rng, "srm": result}


# ── pre-registration ────────────────────────────────────────────────────

#: Fields the contract owns. A request may not override one, because being able
#: to is the whole p-hacking surface: switch the outcome column after seeing the
#: numbers and the readout answers a question nobody registered, with no trace
#: that it happened.
FROZEN = ("connection_id", "dataset_id", "variation", "unit", "outcome",
          "binary", "control", "weights", "alpha", "guardrails", "metric_ids",
          # These decide what the number IS, not how it is read. Revenue per
          # user summed and revenue per user averaged are different
          # experiments; a cap chosen after seeing which outliers landed in
          # which arm is p-hacking with extra steps.
          "unit_agg", "cap", "null_is_zero", "sources",
          # A cohort is the clearest case of all. Slicing after the fact is how
          # a null becomes "it worked for mobile users on the annual plan" —
          # every extra cut is another chance at a false positive, and the whole
          # test for FREE is that it cannot turn a null into a win. Naming the
          # cut in advance is what makes the answer mean anything.
          "cohort",
          # These three were FREE, under a comment saying they "change how the
          # evidence is READ, not what is measured" and that "neither can turn
          # a null result into a positive one". The second half was false, and
          # it is the half that matters.
          #
          # `sequential` selects the error-control regime. At n=10,000 with
          # 1000 vs 1089 conversions the confidence sequence gives
          # (-0.052, +0.230) and the fixed-horizon interval (+0.0005, +0.177) —
          # the same data reading "no difference detected" and "better", and
          # `verdict` reads only the interval. `tuning` sets where that
          # sequence is tightest, so it moves the same boundary more gently.
          #
          # `srm_threshold` is worse than either: an SRM failure OVERRIDES the
          # verdict with "no answer", so a threshold supplied at read time is a
          # way to make the override go away. Passing 1e-300 makes every split
          # pass.
          #
          # A reading choice is one that cannot change the answer. These change
          # the answer, so they belong to the contract.
          "sequential", "tuning", "threshold")

#: Fields a caller may still choose. These change how the evidence is READ, not
#: what is measured: which window to look at, and whether to record the result.
#: The test for this list is that nothing on it can turn a null into a win.
FREE = ("range", "space_id", "experiment_id",
        # Recording is an action taken on the result, not a measurement choice.
        # The actor is NOT here: identity comes from the bearer token, never
        # from the request.
        "record")


class NotPreRegistered(Exception):
    """The experiment exists but carries no contract."""


def _when(value) -> datetime | None:
    if not value:
        return None
    try:
        at = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=UTC)


def _window_for(exp: dict | None, rng: str, now: datetime):
    """The days a readout reads: the experiment's own, not the last N from now.

    A readout read "the last 30 days" whatever it was asked about. So an
    experiment read a month after it stopped read nothing, a running one read
    whatever happened before it started, and the same experiment gave a
    different answer every day for no reason but the calendar — which is how
    three tests on main failed on 19 September without a line of code
    changing. An experiment that has started reads from its start to its stop
    (or to now while it runs); `range` is for reading a table nobody
    registered.

    Returns (start, end, basis, note).
    """
    started = _when((exp or {}).get("started_at"))
    if started is not None:
        stopped = _when((exp or {}).get("stopped_at"))
        end = min(stopped or now, now)
        return started, end, "experiment", None
    note = None
    if exp is not None:
        days = RANGES[rng].days
        note = (f"No start date on record, so this read the last {days} days rather "
                "than the days the experiment ran. Record when it started — "
                "experiments.start — and every readout reads its own window.")
    return now - RANGES[rng], now, "range", note


async def _contract_for(state, experiment_id: str, space: str) -> tuple[dict, dict]:
    row = await state["pool"].fetchrow(
        "select id, title, props from objects"
        " where id = $1 and space_id = $2 and type = 'experiment'"
        "   and deleted_at is null", experiment_id, space)
    if row is None:
        raise LookupError(experiment_id)
    props = row["props"]
    props = json.loads(props) if isinstance(props, str) else (props or {})
    contract = props.get("contract")
    if not contract:
        raise NotPreRegistered(experiment_id)
    return {"id": row["id"], "title": row["title"], **props}, contract


def _merge_contract(body: dict, contract: dict,
                    exp: dict | None = None) -> tuple[dict, dict, list[str]]:
    """Build the effective request from the contract, refusing overrides.

    Returns (effective body, outcome -> pinned metric version, notes).
    Raises ValueError naming the offending field when the request tries to
    change something the contract owns.
    """
    for field in FROZEN:
        if field in body and body[field] is not None:
            raise ValueError(field)

    # A field in neither list is dropped, because the effective body is rebuilt
    # from FREE alone. That is silent and it bites: `record: true` was accepted,
    # discarded here, and the caller got a readout with no recording and no
    # error. Refusing is how the next parameter gets classified instead of
    # quietly doing nothing.
    unknown = sorted(set(body) - set(FROZEN) - set(FREE))
    if unknown == ["actor_id"]:
        # Worth its own message: it WAS an argument, and a caller still sending
        # it is asking to be attributed as somebody it named itself.
        raise ValueError(
            "actor_id — identity comes from the bearer token now, not the "
            "request body; sending it is asking to be attributed as an actor "
            "you named yourself")
    if unknown:
        raise ValueError(
            f"{', '.join(unknown)} — not part of the contract and not a reading "
            "choice, so it would be silently dropped")

    guardrails = contract.get("guardrails") or []
    effective = {
        **{k: v for k, v in body.items() if k in FREE},
        "connection_id": contract["connection_id"],
        "dataset_id": contract["dataset_id"],
        "variation": contract["variation"],
        "outcome": contract["outcome"],
        # With their shape and direction: the names alone made every guardrail
        # an amount where higher is better, so a rise in support contacts read
        # as "better".
        "guardrails": [{k: g[k] for k in ("outcome", "binary", "better") if g.get(k) is not None}
                       for g in guardrails],
    }
    for key in ("unit", "control", "weights", "binary", "alpha",
                "unit_agg", "cap", "null_is_zero", "cohort", "sources",
                "sequential", "tuning", "threshold"):
        if contract.get(key) is not None:
            effective[key] = contract[key]

    # outcome column -> ratified definition, and the version it was pinned at.
    cited, pins = {}, {}
    if contract.get("metric_id"):
        cited[contract["outcome"]] = contract["metric_id"]
        if contract.get("metric_version") is not None:
            pins[contract["outcome"]] = contract["metric_version"]
    for g in guardrails:
        if g.get("metric_id"):
            cited[g["outcome"]] = g["metric_id"]
            if g.get("metric_version") is not None:
                pins[g["outcome"]] = g["metric_version"]
    if cited:
        effective["metric_ids"] = cited

    return effective, pins, _compliance(body, contract, exp)


def _compliance(body: dict, contract: dict, exp: dict | None = None) -> list[str]:
    """What a reviewer who was not there would want flagged.

    Each of these is a comparison against something written down BEFORE the
    data existed, which is the only kind of check that can be made mechanically.
    None of them is fatal; all of them change how the result should be read.
    """
    notes: list[str] = []

    planned = contract.get("planned_days")
    # Counted from when traffic started, when that is known, and to the stop
    # once there is one. Counting from registration said "day 0" about an
    # experiment registered after seven weeks of traffic.
    started = (exp or {}).get("started_at") or contract.get("registered_at")
    if planned and started:
        try:
            start = datetime.fromisoformat(str(started))
            end = _when((exp or {}).get("stopped_at")) or datetime.now(tz=UTC)
            day = (end - start).days
            if day < planned:
                notes.append(
                    f"Read on day {day} of a planned {planned}. The interval is "
                    "always-valid so this is not peeking, but the experiment has "
                    "not run its registered course and a null result here is not "
                    "yet a null result.")
            elif day > planned * 2:
                notes.append(
                    f"Read on day {day} of a planned {planned} — more than twice "
                    "the registered duration. Whatever is being measured now "
                    "includes populations the registration did not anticipate.")
        except (TypeError, ValueError):
            pass

    if contract.get("mde") is None:
        notes.append(
            "No minimum detectable effect was registered, so 'no difference "
            "detected' cannot be distinguished from 'too small to see'.")
    if not contract.get("unit"):
        notes.append(
            "The contract names no unit of randomisation, so counts are ROWS. "
            "Every interval is too narrow if the dataset has more than one row "
            "per randomised unit.")
    if not contract.get("weights"):
        notes.append("No designed split registered; an even split was assumed.")
    return notes


@router.post("/api/v1/experiments.register")
async def experiments_register(req: Request):
    """Write the contract, before there is anything to see.

    Registration is the moment the experiment becomes answerable: it names the
    dataset, the arm column, the unit, the outcome, and pins the metric version
    in force right now. Everything is checked against the real dataset here
    rather than at readout, because a contract that cannot compile is not a
    commitment to anything.

    Amending a contract after the experiment is running is allowed and recorded.
    Silently amending it is not — which is the only distinction that matters,
    since the amendment itself is often legitimate and the concealment never is.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    actor = actor_of(req)
    contract = dict(body.get("contract") or {})

    missing = [f for f in ("connection_id", "dataset_id", "variation", "outcome")
               if not contract.get(f)]
    if missing:
        return _error(422, "incomplete_contract",
                      f"a contract must name {', '.join(missing)}", f"contract.{missing[0]}")

    try:
        src, _ = await _source(state, contract["connection_id"], space)
        ds = await src._dataset(contract["dataset_id"])
    except (NoSuchConnection, LookupError) as e:
        return _error(404, "unknown_target", str(e), "contract.dataset_id")

    # Every named column must exist in the dataset as declared. Catching this
    # now rather than at readout is the difference between "your registration
    # is wrong" and "your experiment produced no answer three weeks later".
    declared = {d.name for d in ds.dimensions}
    guardrails = contract.get("guardrails") or []
    for field in ("variation", "outcome", "unit", "control"):
        value = contract.get(field)
        if field == "control":
            continue          # an arm VALUE, not a column
        if value and value not in declared:
            return _error(422, "undeclared_column",
                          f"{value!r} is not a column {contract['dataset_id']} declares; "
                          f"it has {sorted(declared)[:8]}", f"contract.{field}")
    for i, g in enumerate(guardrails):
        if not g.get("outcome"):
            return _error(422, "incomplete_contract",
                          "every guardrail needs an outcome column",
                          f"contract.guardrails[{i}].outcome")
        if g["outcome"] not in declared:
            return _error(422, "undeclared_column",
                          f"guardrail {g['outcome']!r} is not a declared column",
                          f"contract.guardrails[{i}].outcome")

    # Pin whatever is ratified NOW. That is what pre-registration means: the
    # definition in force at the moment somebody committed to measuring it.
    from commonindex.core.warehouse.readout import honours

    async def _pin(metric_id: str, where: str, outcome: str):
        try:
            m = await state["metrics"].resolve(space, metric_id)
        except LookupError:
            return None, _error(404, "unknown_metric", f"no metric {metric_id}", where)
        if m.status != "ratified":
            return None, _error(422, "unratified_metric",
                                f"{metric_id} is {m.status}. An experiment cannot "
                                "pre-register a definition nobody has stood behind — "
                                "ratify it first, then register.", where)
        if m.dataset_id and m.dataset_id != contract["dataset_id"]:
            # A metric's expression is written in one dataset's column names, so
            # citing it from another is a query that cannot compile. Registration
            # accepted this silently and the mismatch only surfaced as a runtime
            # SQL error weeks later, on the one query nobody could afford to
            # have fail.
            return None, _error(422, "metric_dataset_mismatch",
                                f"{metric_id} is defined on {m.dataset_id!r}, but this "
                                f"experiment reads {contract['dataset_id']!r}. A metric's "
                                "expression is written in one dataset's column names and "
                                "cannot be evaluated against another.", where)
        if not honours(m.expr, outcome, src._spec.sqlglot_dialect):
            # A readout is sums over rows, so the only definition it reproduces
            # exactly is the mean of the outcome column. Binding anything else
            # would let a panel and a readout cite one id and compute different
            # numbers — measured at +27.1% against +33.2% on the same 8,000
            # users — which is the drift the registry exists to prevent,
            # arriving through the registry.
            return None, _error(422, "metric_not_readable",
                                f"{metric_id} is defined as `{m.expr}`, which a readout "
                                f"cannot reproduce: it aggregates `{outcome}` per arm as "
                                "a mean, so only a definition of the form "
                                f"AVG({outcome}) is honoured. A panel citing this id and "
                                "a readout citing it would compute different numbers.",
                                where)
        return m.version, None

    if contract.get("metric_id"):
        version, err = await _pin(contract["metric_id"], "contract.metric_id",
                                  contract["outcome"])
        if err:
            return err
        contract["metric_version"] = version
    for i, g in enumerate(guardrails):
        if g.get("metric_id"):
            version, err = await _pin(g["metric_id"],
                                      f"contract.guardrails[{i}].metric_id", g["outcome"])
            if err:
                return err
            g["metric_version"] = version

    exp_id = body.get("experiment_id") or f"exp-{_slug(body.get('name') or 'untitled')}"
    title = body.get("name") or exp_id

    async with state["pool"].acquire() as conn:
        why = await _known_actor(conn, actor)
        if why:
            return _error(422, "unknown_actor", why, "actor_id")

        row = await conn.fetchrow(
            "select props from objects where id = $1 and space_id = $2"
            "   and type = 'experiment' and deleted_at is null", exp_id, space)
        # An id made from the name lands on any experiment that shares it: a
        # second "Checkout" was refused as an amendment of the first. A new
        # experiment gets the next free id; changing an existing one still
        # takes its id, named, and amend.
        if row is not None and not body.get("experiment_id") and not body.get("amend"):
            existing = json.loads(row["props"]) if isinstance(row["props"], str) else (row["props"] or {})
            if existing.get("contract"):
                base, n = exp_id, 2
                while await conn.fetchval("select 1 from objects where id = $1", f"{base}-{n}"):
                    n += 1
                exp_id, row = f"{base}-{n}", None
        props = {}
        if row is not None:
            props = json.loads(row["props"]) if isinstance(row["props"], str) else (row["props"] or {})
            running = props.get("status") not in (None, "draft")
            if props.get("contract") and running and not body.get("amend"):
                return _error(409, "contract_frozen",
                              f"{exp_id} is {props.get('status')} and already carries a "
                              "contract. Changing what is measured after data exists is "
                              "the thing pre-registration prevents — pass amend:true to "
                              "do it on the record.", "amend")
            if props.get("contract") and body.get("amend"):
                # Kept, not overwritten. An amendment nobody can see is the same
                # as no contract at all.
                props.setdefault("amendments", []).append({
                    "at": datetime.now(tz=UTC).isoformat(),
                    "by": actor,
                    "why": body.get("amend_reason") or "",
                    "was": props["contract"],
                })

        # Registration may say the experiment is a draft or already running —
        # the wizard measures ones that are — and nothing further. `status` was
        # copied in under `propose`, so an experiment could be registered as
        # shipped: a decision nobody made, with nothing it was made on.
        asked = body.get("status")
        if asked is not None and asked not in ("draft", "running"):
            return _error(422, "governed_field",
                          f"register an experiment as draft or running, not {asked!r}; "
                          "stopping and deciding are experiments.stop and "
                          "experiments.decide", "status")
        started = _when(body.get("started_at")) if body.get("started_at") else None
        if body.get("started_at") and started is None:
            return _error(422, "bad_date", "started_at must be an ISO date", "started_at")
        if started and started > datetime.now(tz=UTC):
            return _error(422, "future_start", "an experiment cannot have started in the future",
                          "started_at")
        if started and not props.get("started_at"):
            props["started_at"] = started.isoformat()
            props["started_by"] = actor
        contract["registered_at"] = contract.get("registered_at") or \
            datetime.now(tz=UTC).isoformat()
        contract["registered_by"] = contract.get("registered_by") or actor
        props.update({
            "contract": contract,
            "status": props.get("status") or asked or ("running" if started else "draft"),
            "hypothesis": body.get("hypothesis") or props.get("hypothesis") or "",
            "owner": body.get("owner") or props.get("owner") or actor,
            "space": space,
            "metric": contract.get("metric_id") or props.get("metric") or "",
            "days": contract.get("planned_days") or props.get("days") or 14,
        })
        await conn.execute(
            "insert into objects (id, space_id, type, key, title, props, created_by)"
            " values ($1,$2,'experiment',$3,$4,$5::jsonb,$6)"
            " on conflict (id) do update set props = $5::jsonb, title = $4,"
            "   updated_at = now()",
            exp_id, space, await _next_key(conn, space, "EXP"), title,
            json.dumps(props), actor)
        await index_object(conn, exp_id)

    return {"experiment_id": exp_id, "title": title, "contract": contract,
            "amended": bool(row is not None and body.get("amend"))}


@router.post("/api/v1/experiments.list")
async def experiments_list(req: Request):
    """Experiments as objects, with whether each is actually answerable."""
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    limit = min(int(body.get("limit") or 100), 500)

    from commonindex.gateway.experiments import attention, progress

    rows = await state["pool"].fetch(
        "select id, key, title, props, updated_at, created_by from objects"
        " where space_id = $1 and type = 'experiment' and deleted_at is null"
        " order by updated_at desc limit $2", space, limit)

    out = []
    now = datetime.now(tz=UTC)
    for r in rows:
        props = json.loads(r["props"]) if isinstance(r["props"], str) else (r["props"] or {})
        status = props.get("status") or "draft"
        if body.get("status") and body["status"] != status:
            continue
        contract = props.get("contract") or {}
        prog = progress(props, now)
        out.append({
            "id": r["id"], "key": r["key"], "name": r["title"],
            "hypothesis": props.get("hypothesis", ""),
            "owner": props.get("owner", ""), "space": props.get("space", space),
            "metric": props.get("metric", ""), "status": status,
            # Worked out from the dates. The stored `day` never moved.
            "days": prog["days"], "day": prog["day"],
            "started_at": prog["started_at"], "ends_at": prog["ends_at"],
            "stopped_at": prog["stopped_at"],
            "attention": attention(props, prog),
            "srm_passed": props.get("srm_passed"),
            "lift_ci": props.get("lift_ci"),
            "units": props.get("units"),
            "verdict": props.get("verdict"),
            # The effect the contract said was worth acting on, for the band a
            # card draws around zero.
            "mde": contract.get("mde"),
            "owner_id": props.get("owner") or r["created_by"],
            "decision": props.get("decision"),
            "lift": props.get("lift"), "lift_at": props.get("lift_at"),
            # Which way is good for that cached lift. Without it a reader — or
            # the program view's distribution — cannot tell a win from a loss on
            # a metric where a fall is the good outcome.
            "better": props.get("better"),
            "guardrail": props.get("guardrail", "clean"),
            # The field the list exists to show: an experiment with no contract
            # cannot be read out at all, and that should be visible before
            # somebody spends three weeks on it.
            "pre_registered": bool(contract),
            "amendments": len(props.get("amendments") or []),
        })
    return {"experiments": out, "total": len(out)}


@router.post("/api/v1/experiments.get")
async def experiments_get(req: Request):
    """One experiment, contract and all."""
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    # `id` is what its tool schema says — the generic `<type>.get` shape — and
    # what an agent reading the schema sends; `experiment_id` is what every
    # other experiment operation takes. Either names it.
    if isinstance(body, dict) and not body.get("experiment_id") and body.get("id"):
        body = {**body, "experiment_id": body["id"]}
    if missing := _need(body, "experiment_id"):
        return missing
    try:
        exp, contract = await _contract_for(state, body["experiment_id"], space)
    except LookupError:
        return _error(404, "unknown_experiment",
                      f"no experiment {body['experiment_id']}", "experiment_id")
    except NotPreRegistered:
        row = await state["pool"].fetchrow(
            "select id, title, props from objects where id = $1 and space_id = $2",
            body["experiment_id"], space)
        props = json.loads(row["props"]) if isinstance(row["props"], str) else (row["props"] or {})
        return {"experiment": {"id": row["id"], "title": row["title"], **props},
                "contract": None, "pre_registered": False}
    from commonindex.gateway.experiments import attention, progress

    prog = progress(exp)
    return {"experiment": exp, "contract": contract, "pre_registered": True,
            "progress": prog, "attention": attention(exp, prog)}


async def _record_readout(state, space: str, body: dict, exp: dict | None,
                          payload: dict, actor: str) -> tuple[dict | None, Any]:
    """Keep what this readout said, as an object, with an edge to its experiment.

    Never served in place of recomputing — `experiments.readout` always goes to
    the warehouse. This answers the question recomputation cannot: what did the
    numbers say on the day somebody shipped on them. A year later "why did we
    ship?" is otherwise unanswerable, because the data has moved and the readout
    that justified the decision is gone.

    The metric references go in props rather than in edges. `edges.src`/`dst`
    both reference `objects(id)` and a metric is not an object, so
    `readout --measures--> metric` cannot be written without dropping the
    foreign key. `readout --for--> experiment` is object-to-object and IS an
    edge.
    """
    now = datetime.now(tz=UTC)

    cited = [
        {"outcome": r["outcome"], "metric_id": r.get("cites"),
         "version": r.get("metric_version"), "role": r.get("role"),
         "verdict": (r.get("comparisons") or [{}])[0].get("verdict")}
        for r in payload["results"] if "error" not in r
    ]
    props = {
        **payload,
        # Lifted out of the nested results so the GIN index can answer
        # "which readouts cite this definition" by containment.
        "experiment_id": body.get("experiment_id"),
        "metric_ids": [c["metric_id"] for c in cited if c["metric_id"]],
        "cited": cited,
        "recorded_at": now.isoformat(),
        "recorded_by": actor,
    }
    title = (f"{exp['title']} — {now:%Y-%m-%d %H:%M}" if exp
             else f"Readout — {now:%Y-%m-%d %H:%M}")
    # Unique per recording, and stable for one instant, so a double-submit
    # lands on the same row rather than writing two.
    rid = "readout-" + hashlib.sha256(
        f"{space}:{body.get('experiment_id')}:{now.isoformat()}".encode()).hexdigest()[:16]

    async with state["pool"].acquire() as conn:
        why = await _known_actor(conn, actor)
        if why:
            return None, _error(422, "unknown_actor",
                                f"{why} — a recorded readout is attributed", "actor_id")
        async with conn.transaction():
            await conn.execute(
                "insert into objects (id, space_id, type, key, title, props, created_by)"
                " values ($1,$2,'readout',$3,$4,$5::jsonb,$6)"
                " on conflict (id) do nothing",
                rid, space, await _next_key(conn, space, "RO"), title,
                json.dumps(props, default=str), actor)
            if body.get("experiment_id"):
                # Cache the headline on the experiment itself.
                #
                # `types/experiment.json` has described `lift` as "LAST OBSERVED
                # lift, cached so a list of 240 rows does not run 240 readouts"
                # since it was written, and nothing ever wrote it — so every
                # live row showed a dash, and the program view's effect
                # distribution and median win were seeded rows only.
                #
                # `better` rides along because orienting a lift needs to know
                # which direction is good, and that lives in the metric registry
                # rather than anywhere the reader of this cache can reach.
                # Without it a refund-rate win files as a loss.
                target = next((r for r in payload["results"]
                               if r.get("role") != "guardrail"), None)
                head = (target or {}).get("comparisons") or []
                lift = head[0].get("lift") if head else None
                ci = head[0].get("lift_ci") if head else None
                units = sum(a.get("n") or 0 for a in (target or {}).get("arms") or []) or None
                # The guardrail badge was a default nothing wrote, so every
                # list row said "clean" whatever its guardrails did. A breach
                # is a guardrail measured worse.
                verdicts = [c.get("verdict") for r in payload["results"]
                            if r.get("role") == "guardrail" for c in r.get("comparisons") or []]
                srm = payload.get("srm") or {}
                # The split check is not a guardrail; it has its own field.
                guardrail = "breach" if "worse" in verdicts else "clean"
                await conn.execute(
                    "update objects set props = props"
                    "   || jsonb_build_object('lift', $2::jsonb,"
                    "        'lift_at', $3::text, 'better', $4::text,"
                    "        'guardrail', $6::text, 'srm_passed', $7::jsonb,"
                    "        'last_readout', $8::text, 'lift_ci', $9::jsonb,"
                    "        'units', $10::jsonb, 'verdict', $11::text),"
                    "  updated_at = now()"
                    " where id = $1 and space_id = $5 and type = 'experiment'",
                    body["experiment_id"],
                    json.dumps(round(lift * 100, 1) if lift is not None else None),
                    now.isoformat(), (target or {}).get("better") or "up", space,
                    guardrail, json.dumps(srm.get("passed") if srm.get("ran") else None), rid,
                    # The interval travels with the lift. A card showing +4%
                    # without it cannot tell a result from a coin flip.
                    json.dumps([round(ci[0] * 100, 1), round(ci[1] * 100, 1)] if ci else None),
                    json.dumps(units), head[0].get("verdict") if head else None)

                # The one relation here that IS object-to-object.
                await conn.execute(
                    "insert into edges (src, rel, dst, created_by)"
                    " values ($1,'for',$2,$3) on conflict do nothing",
                    rid, body["experiment_id"], actor)
                # Its numbers become part of what the experiment is found by.
                await index_object(conn, body["experiment_id"])

    return {"id": rid, "at": now.isoformat(),
            "edges": ["for"] if body.get("experiment_id") else []}, None


@router.post("/api/v1/experiments.history")
async def experiments_history(req: Request):
    """What this experiment has said over time, newest first.

    The question a live readout cannot answer. Each row is what the numbers were
    when somebody recorded them, so a verdict that changed — or a sample-ratio
    check that started failing halfway through — is visible as a sequence rather
    than as a single current state.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    limit = min(int(body.get("limit") or 50), 200)

    rows = await state["pool"].fetch(
        "select id, key, title, props, created_at, created_by from objects"
        " where space_id = $1 and type = 'readout' and deleted_at is null"
        "   and ($2::text is null or props->>'experiment_id' = $2)"
        " order by created_at desc limit $3",
        space, body.get("experiment_id"), limit)

    out = []
    for r in rows:
        props = json.loads(r["props"]) if isinstance(r["props"], str) else (r["props"] or {})
        srm = props.get("srm") or {}
        out.append({
            "id": r["id"], "key": r["key"], "title": r["title"],
            "at": r["created_at"].isoformat(), "by": r["created_by"],
            "experiment_id": props.get("experiment_id"),
            "range": props.get("range"),
            "srm_passed": srm.get("passed"),
            "pre_registered": props.get("pre_registered"),
            # The shape a reader scans: one line per metric with its verdict.
            "cited": props.get("cited") or [],
            # The target's headline, so the history can be drawn as a line
            # with its interval rather than read as a list of verdicts.
            **_headline(props),
            "window": props.get("window"),
        })
    return {"readouts": out, "total": len(out)}


def _headline(props: dict) -> dict:
    target = next((r for r in props.get("results") or []
                   if r.get("role") != "guardrail" and "error" not in r), None)
    head = ((target or {}).get("comparisons") or [{}])[0]
    return {"lift": head.get("lift"), "lift_ci": head.get("lift_ci"),
            "verdict": head.get("verdict"),
            "n": sum(a.get("n") or 0 for a in (target or {}).get("arms") or []) or None}


#: An identifier, not something to measure.
_ID = re.compile(r"(?i)(^id$|_id$|^uuid$|_uuid$|_key$)")
#: A yes/no column that reads as the result of the experiment.
_OUTCOME = re.compile(r"(?i)(convert|conversion|success|retain|purchas|activat|signup|sign_up|clicked|completed|churn)")


@router.post("/api/v1/experiments.suggest")
async def experiments_suggest(req: Request):
    """Look at a table and say whether an experiment was recorded in it.

    The setup form was asking the author four questions about their own data —
    which column holds the version, which identifies the person, what to
    measure — and every one of them is answerable by looking. A version column
    holds a handful of values repeated many times; a person column is close to
    unique per row. That is one query, and asking instead of looking is how
    somebody ends up picking `author_id` and being told about scribe.

    One scan, all candidate columns at once, bounded by the dataset's own window
    where it has one. Deliberately NOT `datasets.profile`, which stores value
    histograms and is priced accordingly — this answers a single question and
    keeps nothing.
    """
    from sqlalchemy import text as sa_text

    from commonindex.core.warehouse.build import quote

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)

    try:
        src, _ = await _source(state, body["connection_id"], space)
        ds = await src._dataset(body["dataset_id"])
    except (NoSuchConnection, LookupError) as e:
        return _error(404, "unknown_target", str(e), None)

    strings = [d for d in ds.dimensions if d.kind == ColKind.STRING]
    numbers = [d for d in ds.dimensions if d.kind == ColKind.NUMBER]
    if not strings:
        return {"dataset_id": ds.id, "rows": 0, "versions": [], "units": [],
                "measures": [], "verdict": "no text columns, so nothing here names a version"}

    d = src._spec.sqlglot_dialect
    physical = f"({ds.physical}) AS src" if ds.is_virtual else quote(ds.physical, d)
    params: dict = {}
    where = ""
    rng = body.get("range", "30d")
    if ds.time_column:
        now = datetime.now(tz=UTC)
        tc = quote(ds.time_column, d)
        where = f" WHERE {tc} >= :start AND {tc} < :end"
        params = {"start": now - RANGES[rng], "end": now}

    # Ids that are numbers too: `user_id integer` is the commonest person
    # column there is, and reading only text columns said "counting rows" over
    # a table with one. Only ever a person column, never a version.
    ids = [c for c in numbers if _ID.search(c.name)][:6]
    picked = strings[:24] + ids   # one scan, but not an unbounded column list
    sel = ", ".join(f"COUNT(DISTINCT {quote(c.column, d)}) AS c{i}"
                    for i, c in enumerate(picked))
    sql = f"SELECT COUNT(*) AS n, {sel} FROM {physical}{where}"

    def go(conn):
        return conn.execute(sa_text(sql), params).mappings().first()

    async def go_async(conn):
        return (await conn.execute(sa_text(sql), params)).mappings().first()

    try:
        row = await (src._do(go_async) if src.is_async else src._do(go))
    except Exception as e:  # noqa: BLE001 - the author's table is the cause
        return _error(422, "cannot_read", _db_message(e), "dataset_id")

    rows = int(row["n"] or 0)
    versions, units = [], []
    for i, c in enumerate(picked):
        n = int(row[f"c{i}"] or 0)
        if n < 2 or rows == 0:
            continue
        share = n / rows
        # A version column: a few values, each covering many rows. The upper
        # bound on count matters more than the ratio — six arms is already
        # unusual, and sixty is a category.
        if 2 <= n <= 6 and share < 0.2 and c not in ids:
            versions.append({"column": c.name, "distinct": n, "share": round(share, 6)})
        # A person column: close to one row each. Not necessarily exactly one —
        # an exposure table often repeats a user across days.
        elif share > 0.4:
            units.append({"column": c.name, "distinct": n, "share": round(share, 6)})

    versions.sort(key=lambda v: v["distinct"])
    units.sort(key=lambda u: -u["share"])

    # A category column is shaped like an experiment arm and is not one:
    # `created_by` over 42 rows has three values covering the table evenly
    # enough to pass every structural test. Nothing in the shape separates
    # them, so this proposes rather than asserts, and says how sure it is —
    # a table too small to have run an experiment is the one signal that is
    # actually reliable.
    enough = rows >= 200

    # What is already defined on this table, so the measure can be offered by
    # name rather than as a column.
    defined = {}
    for m in await state["metrics"].all_for(space, ds.id):
        col = re.fullmatch(r"(?i)avg\(\s*\"?([a-z0-9_]+)\"?\s*\)", (m.expr or "").strip())
        if col and any(c.name == col.group(1) for c in numbers):
            defined[col.group(1)] = {"metric_id": m.id, "label": m.label,
                                     "better": m.better or "up", "expr": m.expr}

    # What an experiment can be judged on: numbers, and yes/no columns read as
    # a rate. Identifiers are not outcomes — `user_id` was offered beside
    # `revenue`, and alphabetical order put `revenue` ahead of `converted`,
    # which was not offered at all because it was a boolean.
    unit_names = {u["column"] for u in units}
    flags = [d for d in ds.dimensions if d.kind == ColKind.BOOL]
    measures = [{"column": c.name, "binary": c.kind == ColKind.BOOL, **(defined.get(c.name) or {})}
                for c in [*flags, *numbers]
                if c.name not in unit_names and not _ID.search(c.name)]
    measures.sort(key=lambda m: (0 if m.get("metric_id") else 1,
                                 0 if m["binary"] and _OUTCOME.search(m["column"]) else
                                 1 if m["binary"] else 2, m["column"]))

    return {
        "dataset_id": ds.id, "rows": rows,
        "versions": versions, "units": units, "measures": measures,
        "confident": bool(enough and len(versions) == 1 and units and measures),
        "verdict": (
            "no column holds a small set of repeated values, so nothing here names a version"
            if not versions else
            "nothing numeric to measure" if not measures else
            f"only {rows} rows — too few for this to be an experiment that has run"
            if not enough else
            f"{versions[0]['column']} looks like the version column"
            if len(versions) == 1 else
            "several columns could hold the version"),
    }


@router.post("/api/v1/panels.resize")
async def panels_resize(req: Request):
    """How wide and how tall a panel is, decided rather than guessed.

    `span` has always existed on the client and never been stored: it was
    derived from the mark and the number of charts on the page — a stat takes
    3 of 12, a table 6, a lone chart the full 12, everything else half. A
    decent guess, and only a guess. It cannot know that the heatmap is the
    point of the page and the two tiles beside it are footnotes, and there was
    no way to tell it.

    Null is kept as a real value meaning "use the heuristic", because that is
    what every panel nobody has resized actually wants. Writing today's guess
    into the column on first save would freeze it as a decision no one made.
    """
    from commonindex.gateway.auth import actor_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, body.get("dashboard_id"), space, "edit", "dashboard_id"):
        return refused
    dashboard_id = body.get("dashboard_id")
    spans = body.get("spans") or {}
    heights = body.get("heights") or {}
    cols = body.get("cols") or {}

    if not dashboard_id or not all(isinstance(x, dict) for x in (spans, heights, cols)):
        return _error(422, "bad_spans",
                      "pass dashboard_id, and spans, heights and/or cols as "
                      "{panel_id: number}", "spans")
    if not spans and not heights and not cols:
        return _error(422, "bad_spans", "pass a span, a height or a column to set", "spans")

    def _check(field: str, values: dict, lo: int, hi: int, unit: str):
        for pid, v in values.items():
            # `None` is allowed and means "back to the default" — the only way
            # to undo a resize without guessing what the default would be.
            if v is None:
                continue
            if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
                return _error(422, f"bad_{field}",
                              f"{pid}: a {field} is a whole number of {unit} from "
                              f"{lo} to {hi}, and this is {v!r}", f"{field}s")
        return None

    for err in (_check("span", spans, 2, 12, "columns"),
                _check("height", heights, 160, 900, "pixels"),
                _check("col", cols, 1, 12, "columns from the left")):
        if err is not None:
            return err

    async with state["pool"].acquire() as conn:
        try:
            await _dashboard_row(state, dashboard_id, space)
        except NoSuchDashboard:
            return _error(404, "unknown_dashboard", f"no dashboard {dashboard_id}",
                          "dashboard_id")

        held = {r["panel_id"] for r in await conn.fetch(
            "select panel_id from panel_bindings where dashboard_id = $1", dashboard_id)}
        unknown = [p for p in {**spans, **heights, **cols} if p not in held]
        if unknown:
            return _error(422, "unknown_panel",
                          f"{unknown[0]} is not on this dashboard", "spans")

        async with conn.transaction():
            for pid, span in spans.items():
                await conn.execute(
                    "update panel_bindings set span = $3"
                    " where dashboard_id = $1 and panel_id = $2",
                    dashboard_id, pid, span)
            for pid, height in heights.items():
                await conn.execute(
                    "update panel_bindings set height = $3"
                    " where dashboard_id = $1 and panel_id = $2",
                    dashboard_id, pid, height)
            for pid, col in cols.items():
                await conn.execute(
                    "update panel_bindings set col = $3"
                    " where dashboard_id = $1 and panel_id = $2",
                    dashboard_id, pid, col)
            await conn.execute(
                "update objects set updated_at = now() where id = $1", dashboard_id)

    return {"dashboard_id": dashboard_id, "spans": spans, "heights": heights, "cols": cols,
            "resized_by": actor_of(req)}


@router.post("/api/v1/panels.reorder")
async def panels_reorder(req: Request):
    """Put the panels in the order the author wants them read.

    `panel_bindings.position` has ordered the render since the first migration
    and was only ever assigned at insert, so a dashboard was stuck in the order
    its panels happened to be created — which is the order the author was
    thinking in while building, not the order anyone reads it in afterwards.

    The whole order arrives at once rather than a from/to pair. A drag is one
    intent, and applying it as a sequence of pairwise moves leaves a window
    where the stored order is neither the old one nor the new one.
    """
    from commonindex.gateway.auth import actor_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, body.get("dashboard_id"), space, "edit", "dashboard_id"):
        return refused
    dashboard_id = body.get("dashboard_id")
    order = body.get("panel_ids")

    if not dashboard_id or not isinstance(order, list) or not order:
        return _error(422, "bad_order",
                      "pass dashboard_id and panel_ids in the order you want them",
                      "panel_ids")
    if len(set(order)) != len(order):
        return _error(422, "bad_order", "panel_ids contains a duplicate", "panel_ids")

    async with state["pool"].acquire() as conn:
        try:
            await _dashboard_row(state, dashboard_id, space)
        except NoSuchDashboard:
            return _error(404, "unknown_dashboard", f"no dashboard {dashboard_id}",
                          "dashboard_id")

        held = {r["panel_id"] for r in await conn.fetch(
            "select panel_id from panel_bindings where dashboard_id = $1", dashboard_id)}
        unknown = [p for p in order if p not in held]
        if unknown:
            return _error(422, "unknown_panel",
                          f"{unknown[0]} is not on this dashboard", "panel_ids")
        missing = held - set(order)
        if missing:
            # A partial order would silently collapse the omitted panels onto
            # whatever position they already held, interleaving them with the
            # new one. Naming them is more useful than guessing.
            return _error(422, "incomplete_order",
                          f"{len(missing)} panel(s) left out: {sorted(missing)[:3]}. "
                          "Send the whole order.", "panel_ids")

        async with conn.transaction():
            # Two passes through a scratch range. Position has no unique index
            # today, but writing straight into the target values would still
            # pass through states where two panels share one — and a reader
            # ordering by position mid-write would see them swap places.
            await conn.execute(
                "update panel_bindings set position = position + $2"
                " where dashboard_id = $1", dashboard_id, len(order) + 1000)
            for i, pid in enumerate(order):
                await conn.execute(
                    "update panel_bindings set position = $3"
                    " where dashboard_id = $1 and panel_id = $2", dashboard_id, pid, i)

    return {"dashboard_id": dashboard_id, "panel_ids": order,
            "reordered_by": actor_of(req)}
