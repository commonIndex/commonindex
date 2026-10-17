"""list / get / propose for every ratified object type, from one loop.

``register_type_ops`` has always generated three operations per type. Nothing
served them: the dev app registered ``register_type_ops(reg, [])`` with the
comment "no object types loaded in this dev app yet", so the type system existed
in the parity test and nowhere a caller could reach.

This is the other half. The same list of types drives both, in the same shape as
the registration loop, which is what stops the two drifting: a type that
contributes operations contributes routes, or neither.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from commonindex.core.registry.types import ObjectType
from commonindex.gateway.auth import space_of
from commonindex.workers.indexer import index_object


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def _props(row) -> dict[str, Any]:
    p = row["props"]
    return json.loads(p) if isinstance(p, str) else (p or {})


def _present(row) -> dict[str, Any]:
    """Props flattened under the real columns.

    A type's schema describes the props, so `status`, `owner` and the rest read
    as top-level fields — which is how every caller wants them and how the
    facets already name them. The stored columns win on a name clash, because a
    props key called `id` must not be able to shadow the object's identity.
    """
    out = {**_props(row),
           "id": row["id"], "key": row["key"], "title": row["title"],
           "name": row["title"],
           "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None}
    # The revision, when the query asked for it. Without it a caller cannot say
    # which version it is holding, so it cannot write conditionally and it
    # cannot put the revision in a file it exports — both of which had been
    # worked around client-side by reading the history instead.
    if "current_rev" in row:
        out["current_rev"] = row["current_rev"]
    return out


def _preview_design(item: dict) -> None:
    """A design as a gallery card needs it: its first screen to draw, and the
    names and count of the rest. The whole spec of every design came with the
    list — 355KB for nineteen — when only a template is ever used whole from
    it (the picker previews and copies every screen), so templates keep theirs.
    """
    spec = item.get("spec")
    if item.get("template_kind") or not isinstance(spec, dict):
        return
    screens = spec.get("screens") or []
    item["screen_count"] = len(screens)
    item["screen_names"] = [s.get("name", "") for s in screens if isinstance(s, dict)]
    item["spec"] = {**spec, "screens": screens[:1]}


def make_list(t: ObjectType):
    enum_facets = {f.field: set(f.values or ()) for f in t.facets if f.kind == "enum"}

    async def handler(req: Request):
        state = req.app.state.commonindex
        body = await req.json() if await req.body() else {}
        space = space_of(req, body)
        limit = min(int(body.get("limit") or 100), 500)

        from commonindex.gateway import sharing

        async with state["pool"].acquire() as conn:
            # Only what the caller may see: a private item is listed for the
            # people it is shared with, and no one else.
            rows = await conn.fetch(
                # current_rev too: without it every doc card read "rev 1", a doc
                # revised four times included.
                "select id, key, title, props, updated_at, acl_keys, current_rev from objects"
                " where space_id = $1 and type = $2 and deleted_at is null and acl_keys && $4"
                " order by updated_at desc, id limit $3", space, t.id, limit, await sharing.keys(req, conn))

        out = []
        for r in rows:
            item = _present(r)
            item["visibility"] = "workspace" if f"space:{space}" in (r["acl_keys"] or []) else "private"
            # Facets filter in the application rather than in SQL because they
            # address props, and a JSONB predicate per facet would have to be
            # built from the same declaration anyway.
            keep = True
            for field in enum_facets:
                want = body.get(field)
                if want and item.get(field) != want:
                    keep = False
                    break
            if keep:
                if body.get("preview") and t.id == "design":
                    _preview_design(item)
                out.append(item)
        return {t.plural.lower(): out, "total": len(out)}

    handler.__name__ = f"{t.plural.lower()}_list"
    return handler


def make_get(t: ObjectType):
    async def handler(req: Request):
        state = req.app.state.commonindex
        body = await req.json()
        space = space_of(req, body)
        oid = body.get("id") or body.get(f"{t.id}_id")
        if not oid:
            return _error(422, "missing_id", f"pass the {t.label.lower()}'s id", "id")
        from commonindex.gateway import sharing

        async with state["pool"].acquire() as conn:
            row = await conn.fetchrow(
                "select id, key, title, props, updated_at, current_rev from objects"
                " where id = $1 and space_id = $2 and type = $3 and deleted_at is null"
                "   and acl_keys && $4", oid, space, t.id, await sharing.keys(req, conn))
        if row is None:
            return _error(404, f"unknown_{t.id}", f"no {t.id} {oid}", "id")
        return {t.id: _present(row)}

    handler.__name__ = f"{t.plural.lower()}_get"
    return handler


async def replayed(conn, object_id: str, key: str) -> int | None:
    """The revision this idempotency key already wrote, if it did. A save
    checks it first, so a retry after a timeout answers with what landed
    instead of writing it twice."""
    return await conn.fetchval(
        "select rev from revisions where object_id = $1 and delta->>'key' = $2",
        object_id, key)


def _schema_violation(t: ObjectType, props: dict) -> tuple[str, str] | None:
    """Check props against the type's own schema, and say where it broke.

    `ObjectType.schema` calls itself "the constraint jsonb otherwise lacks" and
    was not one: `propose` read `required` to see that fields were present and
    then wrote whatever shape it was handed. A design whose `spec` was a string,
    a task whose `state` was none of its four — both went in.

    It matters most for the types whose whole claim is their shape. A design is
    a spec and never markup; that was true because the schema has no field to
    put markup in, which only holds if something reads the schema.
    """
    from jsonschema import Draft202012Validator

    errors = sorted(Draft202012Validator(t.schema).iter_errors(props),
                    key=lambda e: list(e.path))
    if not errors:
        return None
    e = errors[0]
    where = ".".join(str(p) for p in e.path) or t.id
    field = str(e.path[0]) if e.path else None
    return f"{where}: {e.message}", field or t.id


#: Per type, the fields review owns and the value a new object must start at.
GOVERNED: dict[str, dict[str, Any]] = {"design": {"state": "draft", "review": None},
                                       # A render is the gateway's to report, never the caller's to claim.
                                       "video": {"state": "draft", "render": None}}


def make_propose(t: ObjectType):
    required = list(t.schema.get("required", []))

    async def handler(req: Request):
        state = req.app.state.commonindex
        body = await req.json()
        space = space_of(req, body)
        from commonindex.gateway.auth import actor_of

        actor = actor_of(req)
        key = body.get("idempotencyKey")
        if not key:
            return _error(422, "missing_idempotency_key",
                          "a mutation needs an idempotency key so a retry after a "
                          "timeout does not write twice", "idempotencyKey")

        props = {k: v for k, v in body.items()
                 if k not in ("space_id", "actor_id", "idempotencyKey", "id")}
        missing = [f for f in required if props.get(f) in (None, "")]
        if missing:
            return _error(422, "incomplete",
                          f"a {t.label.lower()} needs {', '.join(missing)}", missing[0])

        violation = _schema_violation(t, props)
        if violation:
            why, field = violation
            return _error(422, "invalid_props",
                          f"this does not match the {t.label.lower()} type — {why}", field)

        # A new object starts where review starts. Proposing one already
        # "approved" needed only `propose`, which made approving a formality
        # anyone could skip by creating instead of asking.
        for f, start in GOVERNED.get(t.id, {}).items():
            if props.get(f) not in (None, start):
                return _error(422, "governed_field",
                              f"a new {t.label.lower()} starts with {f} = {start!r}; "
                              "it changes only through review", f)

        # The key IS the identity, so a retry lands on the same row and the
        # insert is genuinely idempotent rather than deduplicated afterwards.
        oid = body.get("id") or (
            f"{t.id}-{hashlib.sha256(f'{space}:{key}'.encode()).hexdigest()[:12]}")
        title = str(props.get(t.presenting.title) or props.get("name") or oid)

        async with state["pool"].acquire() as conn:
            # objects.created_by is a foreign key into actors, so an unknown id
            # is a 500 from the driver rather than something a caller can fix.
            from commonindex.gateway.authoring import _known_actor

            why = await _known_actor(conn, actor)
            if why:
                return _error(422, "unknown_actor", why, "actor_id")

            # Ids are global: one another space holds is not this caller's to
            # land on, retry or not.
            existing = await conn.fetchrow("select id, space_id from objects where id = $1", oid)
            if existing is not None and existing["space_id"] != space:
                return _error(409, "id_taken", f"{oid!r} is already in use — choose another id", "id")
            if existing is None:
                # The space's own counter, not a scan of existing keys. Deriving
                # the next number by stripping non-digits from every key in the
                # space is both racy and wrong the moment two types share it.
                from commonindex.gateway.authoring import _next_key

                key_ = await _next_key(conn, space, t.id[:3].upper())
                inserted = await conn.fetchval(
                    "insert into objects (id, space_id, type, key, title, props,"
                    " created_by) values ($1,$2,$3,$4,$5,$6::jsonb,$7)"
                    " on conflict (id) do nothing returning id",
                    oid, space, t.id, key_, title, json.dumps(props), actor)
                from commonindex.gateway.sharing import SHARED, make_private

                if inserted and t.id in SHARED:
                    # Private to its creator until it is shared — only the row
                    # this call made: a concurrent insert of the same id won.
                    await make_private(conn, oid, actor)
                await index_object(conn, oid)
        return {"id": oid, "type": t.id, "created": existing is None,
                "at": datetime.now(tz=UTC).isoformat()}

    handler.__name__ = f"{t.plural.lower()}_propose"
    return handler


def register_type_routes(app, types: list[ObjectType], *routers) -> None:
    """One route per generated operation, skipping names already served.

    The skip is the point rather than a workaround: an operation like
    ``experiments.list`` knows what a pre-registered contract is, in a way a
    generic handler cannot, so where a purpose-built route exists it wins and
    the generic one is not registered on top of it.

    Routers that were ``include_router``-ed must be passed explicitly. FastAPI
    stores an included router as one opaque object rather than flattening its
    paths into ``app.routes``, so reading ``app.routes`` alone found none of
    them and every purpose-built route was shadowed by a generic duplicate.
    Reaching into the private attribute that does hold them would work until it
    is renamed in a patch release; naming the routers is stable.
    """
    served = {getattr(r, "path", "") for r in app.routes}
    for r in routers:
        served |= {getattr(x, "path", "") for x in r.routes}
    for t in types:
        if t.status != "ratified" or t.store != "graph":
            continue
        stem = t.plural.lower()
        for verb, factory in (("list", make_list), ("get", make_get),
                              ("propose", make_propose)):
            path = f"/api/v1/{stem}.{verb}"
            if path in served:
                continue
            app.add_api_route(path, factory(t), methods=["POST"])
