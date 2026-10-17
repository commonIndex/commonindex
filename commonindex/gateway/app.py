"""The FastAPI app: one POST route per registered operation.

Nothing is hand-registered. The route table comes from ``ops.Registry``, which is
the same object the MCP manifest is built from — so a person and an agent reach
the identical surface, and tests/test_parity.py fails the build if they diverge.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from commonindex.adapters import codemd
from commonindex.adapters.zoekt import Zoekt
from commonindex.core.authz import Denied
from commonindex.core.authz import ops as sharing_ops
from commonindex.core.authz.store import PgChecker
from commonindex.core.conversation import ops as conversation_ops
from commonindex.core.generation import ops as generation_ops
from commonindex.core.grouping import ops as project_ops
from commonindex.core.ops import Registry, register_type_ops
from commonindex.core.registry.types import load_dir
from commonindex.core.render import ops as video_ops
from commonindex.core.render import page_ops as artifact_ops
from commonindex.core.retrieval import ops as retrieval_ops
from commonindex.core.warehouse import Filter, Query, TimeGrain, UnratifiedMetric
from commonindex.core.warehouse import ops as warehouse_ops
from commonindex.core.warehouse.build import OPS, BadFilter, coerce_values
from commonindex.core.warehouse.dashboard import previous, resolve_range
from commonindex.core.warehouse.series import shape
from commonindex.core.warehouse.sources.eventlog import (
    METRICS_BY_ID,
    SEED_METRICS,
    EventLogSource,
)
from commonindex.core.warehouse.store import PgDashboardStore, PgMetricRegistry
from commonindex.core.workflow import ops as task_ops
from commonindex.gateway import (
    access,
    agents,
    artifacts,
    async_ops,
    authoring,
    codeindex,
    codesearch,
    context,
    counts,
    dashboard_assist,
    designs,
    docs,
    events,
    experiment_assist,
    experiments,
    keys,
    link_previews,
    members,
    messages,
    projects,
    search,
    sharing,
    signin,
    tasks,
    tokens,
    video_assist,
    videos,
)
from commonindex.gateway.auth import SpaceMismatch, actor_of, authorize, space_of
from commonindex.gateway.authoring import NoSuchDashboard
from commonindex.gateway.collections import register_type_routes
from commonindex.gateway.http import routes
from commonindex.gateway.llm import LlmUnavailable, OpenAICompatibleEmbedder, OpenAICompatibleLlm

DSN = os.environ.get("COMMONINDEX_DSN", "postgresql://localhost/commonindex_test")
#: The dev client. Nothing else is allowed, because a dashboard endpoint that
#: answers any origin is a dashboard endpoint that answers a phishing page.
ORIGINS = os.environ.get("COMMONINDEX_ORIGINS", "http://localhost:5173").split(",")

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncpg

    state["pool"] = await asyncpg.create_pool(DSN, min_size=1, max_size=8)
    state["metrics"] = PgMetricRegistry(_PoolProxy(state["pool"]))
    state["dashboards"] = PgDashboardStore(_PoolProxy(state["pool"]))
    state["metrics"] = _CombinedRegistry(PgMetricRegistry(_PoolProxy(state["pool"])),
                                        _SeedRegistry())
    state["source"] = EventLogSource(_PoolProxy(state["pool"]), state["metrics"])
    # The check every operation makes. Held on state so the middleware can fail
    # closed when it is absent rather than serving unchecked.
    state["checker"] = PgChecker(_PoolProxy(state["pool"]))
    state["llm"] = OpenAICompatibleLlm.from_env()
    # None when COMMONINDEX_EMBED_* is unset: docs then index for words only and
    # are found by meaning once a model is configured and they are next saved.
    state["embedder"] = OpenAICompatibleEmbedder.from_env()
    # None when COMMONINDEX_ZOEKT_URL is unset, and the search path degrades to
    # the Postgres leg rather than failing. A missing sidecar should make
    # search worse and say so, not make it unavailable.
    state["zoekt"] = Zoekt.from_env()
    state["registry"] = REGISTRY
    app.state.commonindex = state
    # The first admin, when the deployment names one.
    await signin.bootstrap(state["pool"])
    # The search index's catch-up: an item a save did not index is re-indexed
    # within a sweep. One sweeper runs across every gateway (an advisory lock).
    from commonindex.workers.indexer import keep_up

    # The job worker boots this app for its state, not to serve: it runs none
    # of the loops a gateway does (commonindex/workers/jobs.py sets this).
    serving = not os.environ.get("COMMONINDEX_JOB_PROCESS")
    loop = asyncio.get_running_loop()
    tasks = []
    if serving:
        tasks.append(loop.create_task(keep_up(state["pool"])))
        # And vectors for what the sweep rewrote, when there is a model to make them.
        from commonindex.gateway.docindex import embed_up

        if state.get("embedder"):
            tasks.append(loop.create_task(embed_up(state["pool"], state["embedder"])))
        # Changes to conversations, pushed to open pages (commonindex/gateway/events.py).
        from commonindex.gateway.events import Hub, listen

        state["hub"] = Hub()
        tasks.append(loop.create_task(listen(DSN, state["hub"])))
        # Background jobs (commonindex/workers/jobs.py): run here unless a separate
        # worker does (COMMONINDEX_WORKER=external).
        from commonindex.workers import jobs as job_queue

        if job_queue.inline():
            tasks.append(loop.create_task(job_queue.work(state["pool"], DSN)))
    yield
    for task in tasks:
        task.cancel()
    await state["pool"].close()


class _PoolProxy:
    """asyncpg pools expose fetch/fetchrow/execute directly; this keeps the
    store code written against a connection-shaped object."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def fetch(self, sql, *args):
        return await self._pool.fetch(sql, *args)

    async def fetchrow(self, sql, *args):
        return await self._pool.fetchrow(sql, *args)

    async def fetchval(self, sql, *args):
        return await self._pool.fetchval(sql, *args)

    async def execute(self, sql, *args):
        return await self._pool.execute(sql, *args)


class _SeedRegistry:
    """The platform's own metrics ship with the code rather than the database.

    They still go through the registry interface, so a workspace can supersede
    one by ratifying its own definition — which is why this is a registry and not
    a dict lookup at the call site.
    """

    async def resolve(self, space_id: str, metric_id: str):
        m = METRICS_BY_ID.get(metric_id)
        if m is None:
            raise LookupError(metric_id)
        return m

    async def resolve_version(self, space_id: str, metric_id: str, version: int):
        # Shipped definitions carry version 1 and never move, so pinning one is
        # the same lookup with a version guard rather than a different path.
        m = METRICS_BY_ID.get(metric_id)
        if m is None or m.version != version:
            raise LookupError(f"{metric_id} v{version}")
        return m

    async def all_for(self, space_id: str, dataset_id: str | None = None):
        return [m for m in SEED_METRICS if dataset_id in (None, m.dataset_id)]

    async def all_definitions(self, space_id: str, dataset_id: str | None = None):
        # Everything shipped is ratified by construction, so the two agree here.
        return await self.all_for(space_id, dataset_id)


class _CombinedRegistry:
    """The workspace's own metrics, then the ones that ship with the platform.

    Order matters and is the point: a workspace that ratifies its own definition
    of ``agent_acceptance`` supersedes ours. The seeded definitions are a
    starting position, not a reserved namespace.
    """

    def __init__(self, stored, seeded) -> None:
        self._stored, self._seeded = stored, seeded

    async def resolve(self, space_id: str, metric_id: str):
        try:
            return await self._stored.resolve(space_id, metric_id)
        except LookupError:
            return await self._seeded.resolve(space_id, metric_id)

    async def resolve_version(self, space_id: str, metric_id: str, version: int):
        try:
            return await self._stored.resolve_version(space_id, metric_id, version)
        except LookupError:
            return await self._seeded.resolve_version(space_id, metric_id, version)

    async def all_for(self, space_id: str, dataset_id: str | None = None):
        return await self._merge(self._stored.all_for, self._seeded.all_for,
                                 space_id, dataset_id)

    async def all_definitions(self, space_id: str, dataset_id: str | None = None):
        return await self._merge(self._stored.all_definitions,
                                 self._seeded.all_definitions, space_id, dataset_id)

    async def _merge(self, stored_fn, seeded_fn, space_id, dataset_id):
        """The precedence rule, in one place.

        It was written twice — here and again at the skill's loader, which
        merged on top of a function that already merged. Two implementations of
        one rule is how they come to disagree, which is the argument this whole
        platform makes about metric definitions, applied to its own code.
        """
        stored = await stored_fn(space_id, dataset_id)
        seen = {m.id for m in stored}
        return stored + [m for m in await seeded_fn(space_id, dataset_id)
                         if m.id not in seen]


#: The object types this gateway serves. Loaded once and used for BOTH the
#: operation registry and the route table — the app previously passed [] here
#: while the parity test loaded all five, so the two were asserting parity over
#: registries that were never the same object.
TYPES = load_dir(Path(__file__).resolve().parent.parent.parent / "types")


def build_registry() -> Registry:
    reg = Registry()
    register_type_ops(reg, TYPES)
    warehouse_ops.register(reg)
    retrieval_ops.register(reg)
    sharing_ops.register(reg, link_previews.KINDS)
    generation_ops.register(reg)
    task_ops.register(reg)
    project_ops.register(reg)
    conversation_ops.register(reg)
    video_ops.register(reg)
    artifact_ops.register(reg)
    return reg


app = FastAPI(title="CommonIndex", lifespan=lifespan)


@app.exception_handler(SpaceMismatch)
async def _space_mismatch(request: Request, exc: SpaceMismatch):
    """A body naming a space other than the one the grant was checked against.

    403 rather than 422: this is not a malformed request, it is a request for a
    scope the caller does not hold. Refused rather than silently substituted,
    because giving somebody a different scope than they asked for and saying
    nothing is the same failure one layer up.
    """
    return JSONResponse(status_code=403,
                        content={"error": {"code": "space_mismatch",
                                           "message": str(exc), "field": "space_id"}})
# Order matters and is the reverse of the reading order: `add_middleware`
# inserts at position 0, so the LAST registered is the OUTERMOST. CORS has to be
# outside the authorization check — otherwise a 401 or 403 returns without CORS
# headers, the browser refuses to let the page read it, and a precise "you need
# a propose grant" surfaces in the console as an opaque network failure.
# Inside authorize (registered before it): short keys in id fields, once the
# caller and space are known. authorize itself never reads a body.
app.middleware("http")(keys.resolve_keys)
app.middleware("http")(authorize)
app.add_middleware(
    # Credentials, because a signed-in browser's session is a cookie; the
    # origins stay an explicit list, which is what makes that safe.
    CORSMiddleware, allow_origins=ORIGINS, allow_credentials=True,
    allow_methods=["POST", "GET"], allow_headers=["*"],
)

REGISTRY = build_registry()
app.include_router(authoring.router)
app.include_router(dashboard_assist.router)
app.include_router(experiment_assist.router)
app.include_router(counts.router)
app.include_router(async_ops.router)
app.include_router(events.router)
app.include_router(experiments.router)
app.include_router(access.router)
app.include_router(sharing.router)
app.include_router(link_previews.router)
app.include_router(members.router)
app.include_router(signin.router)
app.include_router(tokens.router)
app.include_router(videos.router)
app.include_router(video_assist.router)
app.include_router(artifacts.router)
app.include_router(agents.router)
app.include_router(designs.router)
app.include_router(docs.router)
app.include_router(tasks.router)
app.include_router(projects.router)
app.include_router(messages.router)
app.include_router(search.router)
app.include_router(context.router)
app.include_router(codeindex.router)


@app.get("/api/v1/_ops")
async def list_ops():
    """What this gateway serves. The same list the MCP manifest is built from —
    useful for confirming by eye that the two surfaces really are one."""
    return {
        "operations": [
            {"name": op.name, "relation": op.relation, "mutating": op.mutating,
             # What a CLI needs to offer help and build a call: the same
             # description and input schema an MCP client is given.
             "description": op.description, "input_schema": op.input_schema}
            for op in REGISTRY.all()
        ],
        "routes": sorted(routes(REGISTRY)),
    }


#: A dashboard filter is a READING choice, not a measurement one — the same
#: distinction an experiment contract draws between FROZEN and FREE. Slicing a
#: dashboard to one region does not change what "refund rate" means, so it does
#: not touch certification. It does change what the numbers say, which is why
#: every panel reports the filters it actually applied.
def _dash_filters(raw: Any) -> list[dict]:
    """Parse the dashboard filter bar, refusing anything that is not an operator.

    Same rule as a stored panel filter: the operator is a key of ``OPS`` and
    never a fragment, and the value is bound, so nothing a reader types reaches
    the statement as SQL. The DIMENSION is not checked here, because which
    columns exist is a per-panel question on a dashboard that spans datasets.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise _BadFilter("filters must be a list", "filters")
    out = []
    for i, f in enumerate(raw):
        if not isinstance(f, dict):
            raise _BadFilter("each filter is an object", f"filters[{i}]")
        dim, op = f.get("dimension"), f.get("op", "eq")
        if not isinstance(dim, str) or not dim:
            raise _BadFilter("a filter needs a dimension", f"filters[{i}].dimension")
        if op not in OPS:
            raise _BadFilter(f"{op!r} is not an operator; expected one of {sorted(OPS)}",
                             f"filters[{i}].op")
        vals = f.get("values")
        if vals is None:
            vals = [] if f.get("value") is None else [f["value"]]
        if not isinstance(vals, list):
            raise _BadFilter("values must be a list", f"filters[{i}].values")
        # Which panels this filter is for, when the dataset's answer is not the
        # one you want. Absent means every panel whose dataset has the column,
        # which is right almost always: two tables sharing a column NAME that
        # means two different things is the case it exists for.
        only = f.get("panels")
        if only is not None and not (isinstance(only, list)
                                     and all(isinstance(p, str) for p in only)):
            raise _BadFilter("panels is a list of panel ids", f"filters[{i}].panels")
        # Arity, here rather than at compile time. `between` with three values
        # reached every panel, failed each one, and the dashboard came back
        # UNCERTIFIED — telling the reader that seven panels were "bound to a
        # metric nobody has ratified" when the actual problem was a typo in the
        # filter box.
        _, arity = OPS[op]
        if arity >= 0 and len(vals) != arity:
            raise _BadFilter(
                f"{op} needs exactly {arity} value{'' if arity == 1 else 's'}, "
                f"got {len(vals)}", f"filters[{i}].values")
        if arity < 0 and not vals:
            raise _BadFilter(f"{op} needs at least one value", f"filters[{i}].values")
        out.append({"dimension": dim, "op": op, "values": list(vals),
                    **({"panels": list(only)} if only is not None else {})})
    return out


class _BadFilter(ValueError):
    def __init__(self, msg: str, field: str):
        super().__init__(msg)
        self.field = field


@app.post("/api/v1/dashboards.render")
async def render(req: Request):
    """Run every panel on a dashboard against ONE window.

    The certification is returned alongside, so a panel bound to an unratified
    metric can say so on its own face rather than looking like the trustworthy
    ones.
    """
    body = await req.json()
    space = space_of(req, body)
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, body.get("dashboard_id"), space, "view", "dashboard_id"):
        return refused
    return await render_dashboard(body, space)


async def render_dashboard(body: dict[str, Any], space: str):
    """The render, for a caller that is not a request: search reads a
    dashboard's current numbers this way when it is opened for an answer."""
    rng = body.get("range") or "30d"
    try:
        window = resolve_range(rng, datetime.now(tz=UTC))
    except ValueError as e:
        return _error(422, "bad_range", str(e), "range")
    # The same panels over the window just before, for "compared with the
    # previous period". Twice the queries, so only when asked.
    compare = previous(window) if body.get("compare") else None
    try:
        bar = _dash_filters(body.get("filters"))
    except _BadFilter as e:
        return _error(422, "bad_filter", str(e), e.field)

    try:
        dash = await _load_dashboard(body.get("dashboard_id", ""), space)
    except NoSuchDashboard as e:
        return _error(404, "unknown_dashboard", f"no dashboard {e}", "dashboard_id")
    # The slice the dashboard OPENS on, when the reader has not asked for one.
    # `"filters" in body` rather than a truthiness check: an empty list is a
    # reader deliberately clearing the default, and `or` would silently put it
    # back — so "show me everything" would be the one thing they could not say.
    saved = _dash_filters(dash.get("filters"))
    if "filters" not in body:
        bar = saved

    default_source = await _source_for(dash, space)
    out, unratified, failed = [], [], []
    filterable: set[str] = set()
    kinds: dict[str, str] = {}

    # One source per DISTINCT connection, resolved lazily and reused across the
    # panels that share it — a dashboard with six panels on one warehouse still
    # builds one source, and a panel on another gets its own.
    sources: dict[str, Any] = {}

    async def scope(panel: dict, src, dataset_id: str) -> tuple[list[Filter], list[dict]]:
        """Split the filter bar into what this panel can answer and what it cannot.

        A dashboard spans datasets and warehouses, so "filter by region" is not
        a question every panel on it can be asked — one may not have the column
        at all. BI tools often settle this by making the author scope each filter to
        a set of charts by hand; the scoping is then invisible on the rendered
        page, and a dashboard where two of six panels quietly ignored the
        filter looks exactly like one where all six honoured it.

        Here the dataset answers it, and the panel SAYS which it did. A filter
        that could not be applied is reported on the panel that skipped it, so
        "these numbers are for EMEA" is never claimed by a card that is showing
        the total.
        """
        if panel.get("sql"):
            # An arbitrary SELECT has no declared dimensions to match against,
            # and rewriting someone's statement to add a predicate is a
            # different query than the one they reviewed.
            return [], [{**f, "why": "this panel carries its own query"} for f in bar]
        try:
            ds = await src._dataset(dataset_id)
        except Exception:  # noqa: BLE001 - the panel's own error path reports this
            return [], [{**f, "why": "this panel's dataset could not be read"} for f in bar]
        by_name = {d.name: d for d in ds.dimensions if d.filterable}
        declared = set(by_name)
        # The KIND travels with the name. Without it the picker offers
        # `contains` on a float and `between` on a status column, and a reader
        # has to know the schema to tell which of thirteen operators means
        # anything for the column they just chose.
        for d in by_name.values():
            kinds.setdefault(d.name, d.kind.value if hasattr(d.kind, "value") else str(d.kind))
        # The time column is not offered, because the range control already
        # owns that axis. Two controls on one axis is the failure the single
        # range control exists to prevent — a filter of ts >= X under a window
        # of 30d gives a page where the caption and the data disagree and
        # neither is wrong.
        declared.discard(ds.time_column or "")
        # What this dashboard can be sliced by at all. Collected here rather
        # than introspected again for the picker: the render has already
        # resolved every dataset, and a second answer to a question already
        # answered is a second answer that can disagree.
        filterable.update(declared)
        keep, skip = [], []
        for f in bar:
            # An explicit scope narrows what the dataset would have allowed; it
            # never widens it. A filter aimed at a panel whose table lacks the
            # column is still skipped, and still says which dataset lacked it —
            # scoping is a way to ask for less, not a way to override the
            # schema.
            if f.get("panels") is not None and panel["id"] not in f["panels"]:
                skip.append({**f, "why": "this filter was scoped to other panels"})
                continue
            if f["dimension"] in declared:
                # A form posts strings and the driver does not accept them for a
                # numeric column, so every numeric filter the bar offered failed
                # at execution — as a driver error on the panel, not as "that is
                # not a number" where it was typed.
                vals = coerce_values(f["values"], by_name[f["dimension"]].kind,
                                     f["dimension"])
                keep.append(Filter(dimension=f["dimension"], op=f["op"], values=vals))
            else:
                skip.append({**f, "why": f"{ds.id} has no filterable column "
                                        f"{f['dimension']!r}"})
        return keep, skip

    async def source_for_panel(panel: dict):
        conn_id = panel.get("connection_id")
        if not conn_id:
            return default_source
        if conn_id not in sources:
            sources[conn_id] = (await authoring._source(state, conn_id, space))[0]
        return sources[conn_id]

    for panel, q in _queries(dash, window):
        q.space_id = space

        # A panel carrying its own query never reaches the registry, because
        # there is no definition to resolve — that is the whole trade. It is
        # counted as unratified, so the dashboard's `certified` badge goes
        # false, which is true: nobody has stood behind this number.
        if panel.get("sql"):
            unratified.append(panel["id"])
            _, skipped = await scope(panel, None, "")
            try:
                src = await source_for_panel(panel)
                cols, rows = await authoring._run_sql(
                    src, panel["sql"], panel.get("limit") or 200)
            except Exception as e:  # noqa: BLE001 - the author's SQL is the cause
                out.append({"panel": panel, "error": authoring._db_message(e),
                            "sql": panel["sql"],
                            **({"connection_id": panel["connection_id"]}
                               if panel.get("connection_id") else {})})
                continue
            out.append({
                "panel": panel, "label": panel["title"],
                "unit": None, "better": None,
                # Rows rather than a series: an arbitrary SELECT has no metric
                # and no guaranteed shape, so it is returned as it came back.
                "columns": cols, "rows": rows,
                "sql": panel["sql"],
                "filters_applied": [], "filters_skipped": skipped,
                **({"connection_id": panel["connection_id"]}
                   if panel.get("connection_id") else {}),
            })
            continue

        try:
            metric = await state["metrics"].resolve(space, q.metric_id)
        except LookupError:
            unratified.append(panel["id"])
            out.append({"panel": panel, "error": f"no metric {q.metric_id}"})
            continue
        try:
            source = await source_for_panel(panel)
            keep, skipped = await scope(panel, source, q.dataset_id)
        except BadFilter as e:
            return _error(422, "bad_filter", str(e), "filters")
        try:
            # The bar is ADDED to what the panel already stores. A stored filter
            # is part of what the panel is; the bar is what the reader asked on
            # top of it — so a panel scoped to EU cannot be widened by a reader
            # asking for every region, which is the honest reading of both.
            q.filters = [*q.filters, *keep]
            result = await source.run(q, as_principal="")
        except Exception as e:  # noqa: BLE001 - one bad panel must not take the page
            # This was `except (UnratifiedMetric, UndeclaredDimension)`, so a
            # dropped table, a revoked grant, a statement timeout or a deleted
            # connection 500'd the whole dashboard — including every healthy
            # panel on it. A panel that cannot answer says so in its own card;
            # that is the entire point of returning per-panel errors.
            # The panel fails visibly rather than being hidden, because a
            # missing panel reads as "nothing to report" and a failing one reads
            # as "nobody has agreed what this means yet".
            # An unratified definition and a dropped table are different
            # facts, and this counted both as "unratified" — so a statement
            # timeout, a revoked grant or a typo'd filter turned the certified
            # badge off and told the reader nobody had ratified the metric.
            #
            # Certification is a claim about DEFINITIONS. A query that failed
            # today does not un-ratify the definition it cites; it means the
            # dashboard is not showing what it claims, which is a different
            # sentence and gets its own list.
            (unratified if isinstance(e, UnratifiedMetric) else failed).append(panel["id"])
            # Which warehouse it failed against. "relation does not exist" is a
            # different problem depending on which database was asked, and on a
            # dashboard spanning two it is the first thing you need.
            out.append({"panel": panel, "error": str(e), "status": metric.status,
                        **({"connection_id": panel["connection_id"]}
                           if panel.get("connection_id") else {})})
            continue
        s = shape(result, unit=metric.unit, better=metric.better)
        before = None
        if compare is not None:
            try:
                q.window = compare
                earlier = shape(await source.run(q, as_principal=""), unit=metric.unit, better=metric.better)
                before = [{"name": x.name, "points": x.points} for x in earlier.series]
            except Exception:  # noqa: BLE001 - no comparison is not a failed panel
                before = None
        out.append({
            "panel": panel,
            "label": metric.label,
            "unit": s.unit, "better": s.better,
            "series": [{"name": x.name, "points": x.points} for x in s.series],
            **({"previous": before} if before is not None else {}),
            # What this card is actually showing. A dashboard filtered to one
            # region where a panel could not honour it is the failure mode this
            # exists to make visible.
            "filters_applied": [{"dimension": f.dimension, "op": f.op, "values": f.values}
                                for f in keep],
            "filters_skipped": skipped,
            # Which warehouse this number came from. Only set where the panel
            # reads something other than the dashboard's own connection, so a
            # single-warehouse dashboard says nothing about it.
            **({"connection_id": panel["connection_id"]}
               if panel.get("connection_id") else {}),
        })

    return {
        "dashboard": {"id": dash["id"], "title": dash["title"], "range": rng,
                      "connection_id": dash.get("connection_id"),
                      # Needed to scope which definitions may be cited: a metric's
                      # expression is written in one dataset's column names.
                      "dataset_id": dash.get("dataset_id")},
        # Computed from the panels, never stored on the dashboard — a badge you
        # can set by hand is a badge that outlives the thing it certified.
        "certified": not unratified and bool(out),
        "unratified": unratified,
        # Panels that could not run. Kept apart from `unratified` because the
        # two need different sentences and different fixes: one is waiting on a
        # person, the other on a warehouse.
        "failed": failed,
        "panels": out,
        "window_days": max(1, round((window.end - window.start) / timedelta(days=1))),
        "window": {"start": window.start.isoformat(), "end": window.end.isoformat()},
        **({"previous_window": {"start": compare.start.isoformat(), "end": compare.end.isoformat()}}
           if compare else {}),
        # Echoed, so what produced these numbers travels with them — into the
        # UI, into a readout record, and into an agent's context. A number
        # without the slice it was taken under is not reproducible.
        "filters": bar,
        # What the dashboard opens on, so the UI can say "this is the page's
        # own slice" rather than showing it as something the reader typed.
        "default_filters": saved,
        # The columns this dashboard can be sliced by — the union across its
        # panels' datasets, each with the kind that decides which operators
        # mean anything for it. Offering a column no panel has produces a
        # filter every card reports as skipped, which reads as a bug in the
        # dashboard rather than a bad pick.
        "filterable": [{"name": n, "kind": kinds.get(n, "string")}
                       for n in sorted(filterable)],
        # The headline version of the per-panel detail: how many cards on this
        # page are NOT showing what the filter bar says they are.
        "filters_partial": sorted(
            p["panel"]["id"] for p in out if p.get("filters_skipped")),
    }


@app.post("/api/v1/columns.values")
async def column_values(req: Request):
    """What a column actually contains, so a filter can be CHOSEN.

    The filter bar made you type the value blind: to slice by region you had to
    already know the column holds `emea` and not `EMEA` or `eu-west`. Every
    other blank on this page is picked from a list the data supplies, and this
    one — the one where a typo returns an empty chart rather than an error —
    was free text.

    Bounded, and bounded on purpose. `build.py` states the rule: an unbounded
    scan of a warehouse fact table is how a dashboard becomes a billing
    incident. So this is a GROUP BY with a LIMIT, over the dashboard's own
    window where the dataset has a time column, and it says when it truncated
    rather than presenting the top 200 as the whole set.

    A number gets its range instead of its values. The distinct values of a
    float are not a list anyone wants; what a reader needs to write
    `amount > 100` is to know that the column runs from 3 to 30.
    """
    body = await req.json()
    try:
        space = space_of(req, body)
    except SpaceMismatch as e:
        return _error(403, "space_mismatch", str(e), "space_id")
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, body.get("dashboard_id"), space, "view", "dashboard_id"):
        return refused
    column = body.get("column")
    if not column:
        return _error(422, "no_column", "name the column to read", "column")
    rng = body.get("range") or "30d"
    try:
        since = resolve_range(rng, datetime.now(tz=UTC)).start
    except ValueError as e:
        return _error(422, "bad_range", str(e), "range")
    limit = min(int(body.get("limit") or 200), 500)

    try:
        dash = await _load_dashboard(body.get("dashboard_id", ""), space)
    except NoSuchDashboard as e:
        return _error(404, "unknown_dashboard", f"no dashboard {e}", "dashboard_id")

    default_source = await _source_for(dash, space)

    # One read per DATASET that declares the column, not one per panel: six
    # panels on one table is one question, and asking it six times is six scans.
    seen: dict[tuple[str, str], Any] = {}
    for panel in dash["panels"]:
        if panel.get("sql") or not panel.get("dataset_id"):
            continue
        conn_id = panel.get("connection_id") or dash.get("connection_id") or ""
        seen.setdefault((conn_id, panel["dataset_id"]), panel)

    values: dict[Any, int] = {}
    lo = hi = None
    kind = "string"
    read_from: list[str] = []
    truncated = False
    errors: list[str] = []

    for (conn_id, ds_id), panel in seen.items():
        try:
            src = (default_source if not panel.get("connection_id")
                   else (await authoring._source(state, conn_id, space))[0])
            ds = await src._dataset(ds_id)
        except Exception as e:  # noqa: BLE001 - one bad dataset must not lose the rest
            errors.append(f"{ds_id}: {authoring._db_message(e)}")
            continue
        dim = next((d for d in ds.dimensions if d.name == column and d.filterable), None)
        if dim is None:
            continue
        kind = dim.kind.value if hasattr(dim.kind, "value") else str(dim.kind)
        try:
            got, more, bounds = await authoring._distinct(
                src, ds, dim, limit, since if ds.time_column else None)
        except Exception as e:  # noqa: BLE001 - same
            errors.append(f"{ds_id}: {authoring._db_message(e)}")
            continue
        read_from.append(ds_id)
        truncated = truncated or more
        if bounds is not None:
            b_lo, b_hi = bounds
            lo = b_lo if lo is None else min(lo, b_lo)
            hi = b_hi if hi is None else max(hi, b_hi)
        for v, n in got:
            values[v] = values.get(v, 0) + n

    if not read_from and not errors:
        return _error(404, "unknown_column",
                      f"no panel on this dashboard reads a column called {column!r}",
                      "column")

    ranked = sorted(values.items(), key=lambda kv: (-kv[1], str(kv[0])))[:limit]
    return {
        "column": column, "kind": kind, "range": rng,
        "values": [{"value": v, "rows": n} for v, n in ranked],
        # A number's range, where a list of distinct floats is not a list
        # anybody wants.
        "min": lo, "max": hi,
        # Which datasets answered. A dashboard spans them, and a value present
        # in one is not necessarily present in another — so the panels that do
        # not have it will still report the filter as skipped.
        "from": sorted(read_from),
        # Said out loud rather than presenting the top N as the whole set.
        "truncated": truncated,
        "errors": errors,
    }


@app.post("/api/v1/metrics.ratify")
async def metrics_ratify(req: Request):
    """Stand behind a definition.

    Not a settings toggle: it writes a decision object, points the metric at it,
    and deprecates whatever held the badge before in the same transaction. Every
    panel citing the id re-renders against the new meaning — which is the whole
    reason a panel cites an id instead of carrying its own copy.
    """
    body = await req.json()
    space = space_of(req, body)
    metric_id = str(body.get("metric_id") or "").strip()
    if not metric_id:
        return _error(422, "missing_metric_id", "metric_id is required", "metric_id")
    actor = actor_of(req)

    async with state["pool"].acquire() as conn:
        # THE check, and it was missing entirely. _may_ratify gated
        # dashboards.create and nothing else, so a propose-only agent correctly
        # refused at create could turn round and ratify its own definition here
        # in one call — voiding the proposed/ratified distinction the feature
        # exists for. The old default actor was "analyst", a real agent row, so
        # omitting the field ratified as somebody rather than failing.
        may, why = await authoring._may_ratify(conn, actor)
        if not may:
            return _error(403, "may_not_ratify",
                          f"{why} — ratifying is standing behind a definition, which is "
                          "not something a propose-only agent can do for its own work",
                          "actor_id")

        row = await conn.fetchrow(
            "select version, status, label from metrics where id = $1 and space_id = $2"
            " order by version desc limit 1", metric_id, space)
        if row is None:
            return _error(404, "unknown_metric", f"no metric {metric_id}", "metric_id")

        # Ratify the version the reviewer actually read. Without this, a version
        # written between their reading it and their clicking gets the approval
        # meant for the one they saw — the one failure mode a review step must
        # not have. The op schema has always declared this argument; the handler
        # ignored it and took `order by version desc`.
        want = body.get("version")
        if want is not None and want != row["version"]:
            return _error(409, "version_moved",
                          f"{metric_id} is now at version {row['version']}, not {want};"
                          " re-read it before ratifying", "version")
        if row["status"] == "ratified":
            return {"metric_id": metric_id, "version": row["version"], "already": True}

        decision_id = f"dec-{metric_id}-v{row['version']}"
        async with conn.transaction():
            await conn.execute(
                "insert into objects (id, space_id, type, title, props, created_by)"
                " values ($1,$2,'decision',$3,$4::jsonb,$5) on conflict (id) do nothing",
                decision_id, space, f"Ratify {row['label']}",
                json.dumps({"why": why, "metric_id": metric_id}), actor)
            await conn.execute(
                "update metrics set status = 'deprecated'"
                " where id = $1 and space_id = $2 and status = 'ratified'", metric_id, space)
            await conn.execute(
                "update metrics set status = 'ratified', ratified_by = $3"
                " where id = $1 and space_id = $2 and version = $4",
                metric_id, space, decision_id, row["version"])
            # A panel's section says whether anyone stands behind its number.
            from commonindex.workers.indexer import index_users_of

            await index_users_of(conn, metric_id)

    return {"metric_id": metric_id, "version": row["version"],
            "decision_id": decision_id, "authority": why, "already": False}


async def _source_for(dash: dict, space: str):
    """Which engine answers this dashboard.

    A dashboard built on a warehouse connection goes through the direct source
    and its engine spec; the platform's own metrics go through the event-log
    source. Both satisfy the same protocol, which is why ``render`` above does
    not branch on it beyond this line.
    """
    conn_id = dash.get("connection_id")
    if not conn_id:
        return state["source"]
    src, _ = await authoring._source(state, conn_id, space)
    return src


@app.post("/api/v1/panels.query")
async def panel_query(req: Request):
    """One panel, by its id, over the dashboard's range — exactly as the
    dashboard renders it, so a panel read alone (an agent checking one number)
    can never disagree with the same panel on the page.

    It read a `metric_id` its schema never offered and answered only the
    platform's seeded metrics, so every call through the documented contract
    was a 500."""
    body = await req.json()
    space = space_of(req, body)
    panel_id = str(body.get("panel_id") or "").strip()
    if not panel_id:
        return _error(422, "no_panel", "say which panel to run", "panel_id")
    dashboard_id = await state["pool"].fetchval(
        "select pb.dashboard_id from panel_bindings pb join objects o on o.id = pb.dashboard_id"
        " where pb.panel_id = $1 and o.space_id = $2 and o.deleted_at is null", panel_id, space)
    if dashboard_id is None:
        return _error(404, "unknown_panel", f"no panel {panel_id}", "panel_id")
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, dashboard_id, space, "view", "panel_id"):
        return refused
    out = await render_dashboard({"dashboard_id": dashboard_id, "range": body.get("range")}, space)
    if not isinstance(out, dict):
        return out
    panel = next((p for p in out["panels"] if p["panel"]["id"] == panel_id), None)
    if panel is None:
        return _error(404, "unknown_panel", f"no panel {panel_id}", "panel_id")
    return {"dashboard_id": dashboard_id, "range": out["dashboard"]["range"],
            "certified": panel_id not in out["unratified"], **panel}


@app.post("/api/v1/metrics.list")
async def metrics_list(req: Request):
    """Definitions available to cite.

    This read only ever consulted the SEEDED metrics — the ones shipped with
    the code — so everything a workspace had actually authored was invisible to
    it. That made "reuse an existing definition" impossible to offer, which is
    why every new dashboard wrote its own.

    Scoped by dataset when asked, because a metric's expression is written in
    one dataset's column names and citing it from another is a query that
    cannot compile.
    """
    body = await req.json()
    space = space_of(req, body)
    ms = await state["metrics"].all_for(space, body.get("dataset_id"))
    from commonindex.gateway import sharing

    async with state["pool"].acquire() as conn:
        hidden = await sharing.hidden_metrics(conn, space, await sharing.keys(req, conn))
    return {"metrics": [
        {"id": m.id, "version": m.version, "label": m.label, "expr": m.expr,
         "unit": m.unit, "better": m.better, "dataset": m.dataset_id,
         "status": m.status} for m in ms if m.id not in hidden
    ]}


@app.post("/api/v1/code.query")
async def code_query(req: Request):
    """Lexical search over indexed code, ACL-filtered to the caller.

    The tsvector leg of context-plane.md's hybrid retrieval — chunks.embedding
    has no writer yet (nothing in this codebase produces one), so this is not
    the fused result and says so in its own response rather than presenting a
    partial answer as a complete one. ACL filtering is the clause on the same
    statement, per context-plane.md's rule, not a step applied after.
    """
    return await _code_search(req, await req.json())


def _repo_scope(body: dict[str, Any]) -> list[str] | None:
    """`repos` is the current spelling; `repo_id` was the old single-value one.
    Both are accepted so code.query keeps working, and neither is required —
    omitting them is what triggers automatic routing."""
    repos = body.get("repos")
    if isinstance(repos, str):
        repos = [repos]
    if not repos and body.get("repo_id"):
        repos = [body["repo_id"]]
    return [str(r) for r in repos] if repos else None


async def _code_search(req: Request, body: dict[str, Any], limit: int | None = None) -> dict:
    """The one retrieval implementation behind every code operation.

    Routing, ACL filtering and the Postgres re-check all live in
    gateway/codesearch.py; this is the HTTP shell around it. Keeping a single
    implementation is the point — two search paths is how the MCP surface and
    the UI start disagreeing about what a caller can see.
    """
    q = (body.get("q") or "").strip()
    if not q:
        return _error(422, "missing_query", "pass q", "q")
    # The space the grant was checked against, not the one the body asks for:
    # the middleware authorises against the `x-commonindex-space` header, so taking
    # the scope from the body is two caller-controlled inputs answering one
    # question. `test_no_handler_takes_its_space_from_the_request_body` exists
    # to keep exactly this shut.
    acl_keys = await state["checker"].acl_keys_for(actor_of(req))
    return await codesearch.search(
        state["pool"], state.get("zoekt"), q=q, space=space_of(req, body),
        acl_keys=acl_keys, repos=_repo_scope(body),
        path_glob=body.get("path_glob"), language=body.get("language"),
        limit=limit if limit is not None else int(body.get("limit") or 20))


@app.post("/api/v1/code.search")
async def code_search(req: Request):
    """Search every repository the caller may read, routing automatically.

    The response carries `selected_repos`, `searched_repos` and `routing` beside
    the hits, because a caller who cannot see which repositories answered cannot
    tell a thin result from a complete one — and will present the first as the
    second.
    """
    return await _code_search(req, await req.json())


@app.post("/api/v1/code.list_repos")
async def code_list_repos(req: Request):
    body = await req.json() if await req.body() else {}
    acl_keys = await state["checker"].acl_keys_for(actor_of(req))
    listed = await codesearch.list_repos(state["pool"], space_of(req, body), acl_keys)
    # What is being indexed from the page right now, and what failed — so the
    # page can say "indexing" rather than "nothing indexed". Indexing a URL is
    # open to any admin; a folder, only where the operator listed roots.
    try:
        await state["checker"].require(actor_of(req), "admin", f"space:{space_of(req, body)}")
        admin = True
    except Denied:
        admin = False
    # Indexing is an admin's, and so is its queue: a private repository being
    # indexed is named here before anyone has been granted read on it.
    return {**listed, "indexing": await codeindex.jobs(state["pool"], space_of(req, body)) if admin else [],
            "may_index": admin,
            "may_index_paths": admin and bool(codeindex.roots())}


@app.post("/api/v1/code.find_symbol")
async def code_find_symbol(req: Request):
    body = await req.json()
    name = (body.get("name") or "").strip()
    if not name:
        return _error(422, "missing_name", "pass name", "name")
    acl_keys = await state["checker"].acl_keys_for(actor_of(req))
    return await codesearch.find_symbol(
        state["pool"], state.get("zoekt"), name=name, space=space_of(req, body),
        acl_keys=acl_keys, repos=_repo_scope(body),
        limit=int(body.get("limit") or 20))


@app.post("/api/v1/code.find_references")
async def code_find_references(req: Request):
    body = await req.json()
    name = (body.get("name") or "").strip()
    if not name:
        return _error(422, "missing_name", "pass name", "name")
    acl_keys = await state["checker"].acl_keys_for(actor_of(req))
    return await codesearch.find_references(
        state["pool"], state.get("zoekt"), name=name, space=space_of(req, body),
        acl_keys=acl_keys, repos=_repo_scope(body),
        limit=int(body.get("limit") or 40))


def _citation(repo_id: str, path: str, start_line: int | None, end_line: int | None) -> str:
    if start_line is None or end_line is None:
        return f"{repo_id}/{path}"
    return f"{repo_id}/{path}:L{start_line}-L{end_line}"


@app.post("/api/v1/code.get_file")
async def code_get_file(req: Request):
    body = await req.json()
    object_id = (body.get("object_id") or "").strip()
    if not object_id:
        return _error(422, "missing_object_id", "pass object_id", "object_id")
    space = space_of(req, body)
    acl_keys = await state["checker"].acl_keys_for(actor_of(req))
    # The repo row is joined for its slug, so this cites `example/storefront/...`
    # like search does rather than `code_repo-example-storefront-main/...`. Two
    # spellings of one citation is a real cost: the MCP guide tells a model to
    # cite what it retrieved, and a reader cannot tell the two forms name the
    # same file. The ACL predicate stays on the file, which is what authorises
    # the read — the repo row only contributes a title the caller can already see.
    row = await state["pool"].fetchrow(
        "select f.id, f.title as path, f.props->>'repo_id' as repo_id,"
        " coalesce(r.title, f.props->>'repo_id') as repo,"
        " f.props->>'sha' as sha, f.props->>'body' as body"
        " from objects f left join objects r on r.id = f.props->>'repo_id'"
        " where f.id = $1 and f.space_id = $2 and f.type = 'code_file'"
        " and f.deleted_at is null and f.acl_keys && $3", object_id, space, acl_keys)
    if row is None:
        return _error(404, "code_file_not_found", "no readable indexed code file", "object_id")
    lines = (row["body"] or "").splitlines(keepends=True)
    start = max(1, int(body.get("start_line") or 1))
    end = min(len(lines), int(body.get("end_line") or len(lines)))
    if end < start:
        return _error(422, "bad_line_range", "end_line must be at least start_line", "end_line")
    text = "".join(lines[start - 1:end])
    max_chars = min(int(body.get("max_chars") or 16_000), 50_000)
    truncated = len(text) > max_chars
    return {"object_id": row["id"], "repo_id": row["repo_id"], "repo": row["repo"],
            "path": row["path"], "sha": row["sha"], "start_line": start, "end_line": end,
            "body": text[:max_chars], "truncated": truncated,
            "citation": _citation(row["repo"], row["path"], start, end)}


def _context_pack(result: dict, max_chars: int) -> dict:
    """Fit routed hits into a character budget, keeping what routing decided.

    There were two of these, differing only in which key held the budget — so
    the hosted answer and the MCP pack could drift apart while both looked
    correct. One implementation, two callers.

    The routing fields travel with the pack rather than being dropped into the
    search response and forgotten. An answer built on a degraded index, or on
    one repository out of six, is a different claim from the same answer built
    on everything, and the model — and the reader — need to be told which.
    """
    remaining = max(0, min(max_chars, 50_000))
    context, budgeted = [], 0
    for hit in result["hits"]:
        if remaining <= 0:
            break
        snippet = hit["snippet"][:remaining]
        context.append({**hit, "snippet": snippet,
                        "truncated": len(snippet) < len(hit["snippet"])})
        remaining -= len(snippet)
        budgeted += 1
    return {
        "query": result["query"],
        "engine": result.get("engine"),
        "context": context,
        # Two different reasons a caller is not seeing everything, kept apart:
        # one is our budget, the other is their permissions.
        "withheld": max(0, len(result["hits"]) - budgeted),
        "withheld_repos": result.get("withheld_repos", 0),
        "searched_repos": result.get("searched_repos", []),
        "selected_repos": result.get("selected_repos", []),
        "unindexed_repos": result.get("unindexed_repos", []),
        "unknown_repos": result.get("unknown_repos", []),
        "routing": result.get("routing"),
        "degraded": result.get("degraded"),
        "truncated": result.get("truncated", False),
    }


@app.post("/api/v1/code.context")
async def code_context(req: Request):
    body = await req.json()
    result = await _code_search(req, body, limit=20)
    if isinstance(result, JSONResponse):
        return result
    pack = _context_pack(result, int(body.get("max_chars") or 24_000))
    pack["docs"] = await _doc_context(req, body, pack["query"])
    return pack


async def _doc_context(req: Request, body: dict[str, Any], q: str) -> list[dict]:
    """Doc sections for a code question — the runbook or spec that explains
    what the code does, which the code alone cannot say. Kept beside the code
    context rather than mixed into it, so every count and routing note about
    files and repositories stays true. `include_docs: false` turns it off."""
    if body.get("include_docs") is False or not q:
        return []
    from commonindex.gateway.docindex import search_docs
    from commonindex.gateway.docs import MIN_SIMILARITY

    try:
        found = await search_docs(
            state["pool"], state.get("embedder"), q=q, space=space_of(req, body),
            acl_keys=await state["checker"].acl_keys_for(actor_of(req)),
            limit=4, min_similarity=MIN_SIMILARITY)
    except Exception:  # noqa: BLE001 - docs are extra context; code answers must not fail on them
        return []
    return found["hits"]


#: Prepended to the sources. The model is answering from a routed subset, not
#: from the codebase, and a model that does not know the difference will narrate
#: a complete flow from one file. Stated as facts about this retrieval rather
#: than as a general instruction, because a small model follows a concrete
#: "you were shown 2 files from 1 repository" far better than an abstraction.
def _evidence_note(pack: dict) -> str:
    lines = [(f"You were shown {len(pack['context'])} file excerpt(s) "
              f"from {len(pack['selected_repos'])} repository/repositories, "
              f"out of {len(pack['searched_repos'])} searched.")]
    if pack.get("docs"):
        lines.append(f"You were also shown {len(pack['docs'])} section(s) of workspace "
                     "documents, which describe intent, not necessarily what the code does.")
    if pack.get("degraded"):
        lines.append("The precise code index was UNAVAILABLE; these results come "
                     "from a weaker text search and may be incomplete.")
    if pack.get("withheld_repos"):
        # Said as what it is. Told "the user cannot read them", a model reports a
        # permissions problem to someone who simply asked for one repository.
        lines.append(f"{pack['withheld_repos']} other readable repository/repositories "
                     "were not searched, because the question named the ones to search.")
    if pack.get("unindexed_repos"):
        lines.append(f"Not yet indexed, so absence of results there means nothing: "
                     f"{', '.join(pack['unindexed_repos'])}.")
    if pack.get("truncated") or pack.get("withheld"):
        lines.append("More matches existed than were returned.")
    return " ".join(lines)


@app.post("/api/v1/code.ask")
async def code_ask(req: Request):
    """The hosted answer path: retrieve with the same routed search the MCP
    tools use, then send only that bounded, cited context to the model."""
    body = await req.json()
    result = await _code_search(req, body, limit=int(body.get("limit") or 20))
    if isinstance(result, JSONResponse):
        return result
    pack = _context_pack(result, int(body.get("max_context_chars") or 24_000))
    pack["docs"] = await _doc_context(req, body, pack["query"])

    if not pack["context"] and not pack["docs"]:
        # Why there is nothing matters more than that there is nothing: an
        # unreadable corpus, an unindexed one and a genuine absence are three
        # different problems with three different fixes.
        # The routing note is a lower-case fragment ("caller has no readable
        # repositories"), so it is the clause after a colon, not a sentence.
        routing = (pack["routing"] or "").strip().rstrip(".")
        reason = "No readable indexed code matched" + (f": {routing}" if routing else "")
        if pack.get("degraded"):
            reason += f" ({pack['degraded']})"
        reason += "."
        return {"answer": reason, "citations": [], "context": pack,
                "diagram": None, "model": None,
                # The empty answer is a document too. A client that renders
                # `markdown` would otherwise show nothing at all on the one
                # response whose whole value is the explanation of why it is
                # empty.
                "markdown": codemd.answer(question=pack["query"], text=reason, pack=pack)}

    llm = state.get("llm")
    if llm is None:
        return _error(503, "llm_unconfigured",
                      "set COMMONINDEX_LLM_BASE_URL and COMMONINDEX_LLM_MODEL to enable code.ask", None)

    want_diagram = bool(body.get("include_diagram"))
    sources = "\n\n".join(
        [f"SOURCE {item['citation']}\n{item['snippet']}" for item in pack["context"]]
        + [f"SOURCE {d['citation']}\n{d['snippet']}" for d in pack["docs"]])
    # Asked for, the diagram is required: offered "null or a flow", a small
    # model returned null every time, and the toggle drew nothing.
    diagram_instruction = (
        ' Return JSON with keys "answer" and "diagram". The diagram is REQUIRED: draw the '
        'flow the sources show — the calls or steps in order, 3 to 12 nodes — as title, '
        'nodes [{id,label,kind}] and edges [{from,to,label}], kind one of entry, step, '
        'decision, store, external. Only if the sources show no sequence at all, set '
        'diagram to null and say why in one sentence at the end of the answer. Do not '
        'return HTML, CSS, or SVG.'
        if want_diagram else " Return a concise answer with citations in the form [repo/path:Lx-Ly].")
    messages = [
        {"role": "system", "content":
            "You answer code questions ONLY from the supplied sources. Never invent "
            "files, symbols, or behavior. If the sources do not show a complete "
            "path, say what they do show and name what is missing — do not fill the "
            "gap with a plausible guess. Sources whose name starts with doc: are "
            "the workspace's own documents — specs, runbooks, decisions. Use them "
            "for intent and process and cite them the same way; the code is the "
            "authority on what actually happens." + diagram_instruction},
        {"role": "user", "content":
            f"Question: {pack['query']}\n\nRETRIEVAL NOTE: {_evidence_note(pack)}\n\n{sources}"},
    ]
    try:
        raw = await llm.complete(messages, **({"response_schema": _ASK_SCHEMA} if want_diagram else {}))
    except LlmUnavailable as error:
        return _error(502, "llm_unavailable", str(error), None)
    answer, diagram = _answer_and_diagram(raw, want_diagram)
    if want_diagram and diagram is None:
        # Said, not silent: the toggle was on and nothing was drawn.
        answer = (answer.rstrip() + "\n\n*No flow diagram: the model did not return one these "
                  "sources support. Ask about a specific path (\"how does X call Y\") to get one.*")
    citations = ([item["citation"] for item in pack["context"]]
                 + [d["citation"] for d in pack["docs"]])
    return {"answer": answer,
            "citations": citations,
            "context": pack, "diagram": diagram, "model": llm.model,
            # The same answer as a markdown document: the prose under a heading,
            # the validated flow as a ```mermaid fence, the citations as a list
            # and the routing as a table. `answer` stays exactly what the model
            # said, because a caller that wants to post-process the prose should
            # not have to strip our formatting back off it first.
            "markdown": codemd.answer(question=pack["query"], text=answer, flow=diagram,
                                      citations=citations, pack=pack, model=llm.model)}


#: The shape asked of the model when a diagram is wanted, sent as its output
#: schema so a local model answers in it rather than around it.
_ASK_SCHEMA = {
    "type": "object", "required": ["answer", "diagram"],
    "properties": {
        "answer": {"type": "string"},
        "diagram": {"type": ["object", "null"], "required": ["title", "nodes", "edges"], "properties": {
            "title": {"type": "string"},
            "nodes": {"type": "array", "minItems": 1, "maxItems": 24, "items": {
                "type": "object", "required": ["id", "label"],
                "properties": {"id": {"type": "string"}, "label": {"type": "string"}, "kind": {"type": "string"}}}},
            "edges": {"type": "array", "maxItems": 48, "items": {
                "type": "object", "required": ["from", "to"],
                "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "label": {"type": "string"}}}},
        }},
    },
}


#: A fenced block, with or without an info string. A model told to "return JSON"
#: very often returns JSON inside ```json — observed from qwen2.5-coder:1.5b on
#: the first real `include_diagram` call — and that is not a refusal of the
#: contract, it is the contract wrapped in markdown.
_FENCED = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)


def _answer_and_diagram(raw: str, want_diagram: bool) -> tuple[str, dict | None]:
    """Split the model's reply into prose and a validated flow.

    Falls back to the raw text as the answer when the JSON contract was not
    honoured — a small model is expected to miss it, and a plain answer is a
    worse result rather than a failed one. The fence is unwrapped first: without
    that step the fallback showed the reader a block of JSON where the answer
    belonged, and dropped a diagram the model had actually returned.
    """
    if not want_diagram:
        return raw, None
    parsed: Any = None
    for candidate in (raw, *(match.group(1) for match in _FENCED.finditer(raw))):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        break
    if parsed is None:
        return raw, None
    answer = parsed.get("answer") if isinstance(parsed, dict) else None
    diagram = parsed.get("diagram") if isinstance(parsed, dict) else None
    return (answer if isinstance(answer, str) else raw), _valid_flow(diagram)


def _valid_flow(candidate: Any) -> dict | None:
    """Accept data for the trusted HTML/CSS renderer, never model-authored markup."""
    if not isinstance(candidate, dict) or not isinstance(candidate.get("title"), str):
        return None
    nodes = candidate.get("nodes")
    edges = candidate.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list) or not (1 <= len(nodes) <= 24):
        return None
    cleaned_nodes, ids = [], set()
    for node in nodes:
        if not isinstance(node, dict) or not all(isinstance(node.get(key), str) for key in ("id", "label")):
            return None
        if node["id"] in ids:
            return None
        ids.add(node["id"])
        cleaned_nodes.append({"id": node["id"][:80], "label": node["label"][:160],
                              "kind": str(node.get("kind", "step"))[:40]})
    cleaned_edges = []
    for edge in edges[:48]:
        if not isinstance(edge, dict) or edge.get("from") not in ids or edge.get("to") not in ids:
            return None
        cleaned_edges.append({"from": edge["from"], "to": edge["to"],
                              "label": str(edge.get("label", ""))[:120]})
    return {"title": candidate["title"][:160], "nodes": cleaned_nodes, "edges": cleaned_edges}


def _queries(dash: dict, window):
    for p in dash["panels"]:
        if p.get("sql"):
            # Nothing to compile — the panel IS the query. Yielded with a
            # placeholder so the render loop keeps one shape.
            yield p, Query(metric_id="", dataset_id=p.get("dataset_id") or "",
                           dimensions=[], grain=TimeGrain.parse(p.get("grain")),
                           window=window)
            continue
        yield p, Query(
            metric_id=p["metric_id"], dataset_id=p["dataset_id"],
            dimensions=p.get("dimensions", []),
            grain=TimeGrain.parse(p.get("grain")), window=window,
            # Stored on the binding, so a saved panel asks the same question it
            # asked in the preview — filters that only existed at author time
            # would make the two disagree silently.
            filters=[Filter(dimension=f["dimension"], op=f.get("op", "eq"),
                            values=f.get("values") or [])
                     for f in (p.get("filters") or [])],
            limit=p.get("limit") or 0, order=p.get("sort") or "bucket",
        )


async def _load_dashboard(dashboard_id: str, space: str) -> dict:
    """Read the dashboard and its panel bindings.

    Falls back to a built-in layout when nothing is stored, so the dev app is
    useful before anyone has authored one.
    """
    # Scoped by space, which it was not. Both queries keyed on `dashboard_id`
    # alone, so knowing an id was the whole of the authorization — and ids are
    # in every link, every export and every skill file. The grant check upstream
    # asks "may you read space X"; without this, the answer was used to hand
    # back a dashboard from space Y.
    head = await state["pool"].fetchrow(
        "select id, title, props from objects"
        " where id = $1 and space_id = $2 and type = 'dashboard'"
        " and deleted_at is null", dashboard_id, space)
    rows = await state["pool"].fetch(
        "select b.panel_id, b.title, b.mark, b.dataset_id, b.metric_id, b.dimensions,"
        " b.grain, b.span, b.col, b.height, b.position, b.filters, b.row_limit, b.sort,"
        " b.connection_id, b.sql"
        " from panel_bindings b join objects o on o.id = b.dashboard_id"
        " where b.dashboard_id = $1 and o.space_id = $2 order by b.position",
        dashboard_id, space)
    if rows:
        if head is None:
            raise NoSuchDashboard(dashboard_id)
        props = json.loads(head["props"]) if isinstance(head["props"], str) else (head["props"] or {})
        return {
            "id": head["id"], "title": head["title"],
            "connection_id": props.get("connection_id"),
            "dataset_id": props.get("dataset_id"),
            # The slice this dashboard opens on, set by whoever built it.
            "filters": props.get("filters") or [],
            "panels": [{
                "id": r["panel_id"], "title": r["title"], "mark": r["mark"],
                "dataset_id": r["dataset_id"], "metric_id": r["metric_id"],
                "dimensions": list(r["dimensions"] or []), "grain": r["grain"] or "day",
                # Null means nobody has said, and the client's heuristic decides.
                # Storing today's guess on first save would freeze it as a
                # decision no one made.
                "span": r["span"],
                "col": r["col"],
                "height": r["height"],
                "filters": json.loads(r["filters"]) if isinstance(r["filters"], str)
                           else (r["filters"] or []),
                "limit": r["row_limit"], "sort": r["sort"],
                # Null means "the dashboard's", which is what every panel meant
                # before a panel could differ.
                "connection_id": r["connection_id"],
                # Set only on a panel that carries its own query.
                "sql": r["sql"],
            } for r in rows],
        }
    # A dashboard nobody asked for is not a good default. Falling back here
    # meant `render {"dashboard_id": "typo"}` returned 200 and the platform's own
    # panels — so a broken link looked like a working dashboard about the wrong
    # thing. The built-in layout keeps its own id and is served only under it.
    if dashboard_id == _DEFAULT_DASHBOARD["id"]:
        return _DEFAULT_DASHBOARD
    raise NoSuchDashboard(dashboard_id)


_DEFAULT_DASHBOARD = {
    "id": "platform-health", "title": "Platform health",
    "panels": [
        {"id": "p-acceptance", "title": "Agent acceptance", "mark": "line",
         "dataset_id": "platform.agent_work", "metric_id": "agent_acceptance",
         "dimensions": [], "grain": "day"},
        {"id": "p-undo", "title": "Undone after merge", "mark": "stat",
         "dataset_id": "platform.agent_work", "metric_id": "undo_after_merge",
         "dimensions": [], "grain": "none"},
        {"id": "p-latency", "title": "Median review wait", "mark": "line",
         "dataset_id": "platform.agent_work", "metric_id": "review_latency_p50",
         "dimensions": [], "grain": "day"},
        {"id": "p-by-agent", "title": "Acceptance by author", "mark": "bar",
         "dataset_id": "platform.agent_work", "metric_id": "agent_acceptance",
         "dimensions": ["author"], "grain": "none"},
        {"id": "p-cost", "title": "Agent run cost", "mark": "area",
         "dataset_id": "platform.runs", "metric_id": "run_cost",
         "dimensions": [], "grain": "day"},
    ],
}


def _error(status: int, code: str, message: str, field: str | None = None):
    """Typed, not status-only — so an agent can correct itself rather than retry
    blindly, and a field-level violation names the field."""
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


# LAST, deliberately. Every purpose-built route above must already be registered
# for the skip to see it — a generic handler that shadows `metrics.list` would
# answer without knowing what a ratified definition is. Placing this mid-module
# silently shadowed the four routes declared below it.
register_type_routes(app, TYPES, authoring.router, access.router, tasks.router, messages.router, search.router,
                     codeindex.router, docs.router, artifacts.router, projects.router)
