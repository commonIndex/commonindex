"""Projects: a tag with a page.

A project is an item of its own, open to the whole workspace, and anything
in the space is put in one by an `in_project` edge from it to the project —
a task, a doc, a design, a video, an experiment, a dashboard. One project
gathers every kind of work for a piece of it (a migration off a legacy
system: a task per service, the plan doc, the cut-over dashboard), and an
item may be in several.

What a reader may open inside a project is still each item's own sharing: a
private doc in a project is counted for everyone, and named only to the
people it is shared with.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request

from commonindex.gateway import sharing
from commonindex.gateway.auth import actor_of, space_of
from commonindex.gateway.collections import _props, _schema_violation, replayed
from commonindex.gateway.sharing import _error
from commonindex.workers.indexer import index_object

router = APIRouter()

REL = "in_project"
FIELDS = ("title", "description", "color", "status")
STATES = ("ready", "flight", "review", "done")


def _project_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "project")


def _card(row) -> dict[str, Any]:
    p = _props(row)
    return {"id": row["id"], "key": row["key"], "title": p.get("title") or row["title"],
            "description": p.get("description"), "color": p.get("color") or "blue",
            "status": p.get("status") or "active"}


async def _project(conn, project_id: str, space: str):
    return await conn.fetchrow(
        "select id, key, title, props, current_rev, updated_at from objects"
        " where id = $1 and space_id = $2 and type = 'project' and deleted_at is null",
        project_id, space)


@router.post("/api/v1/projects.list")
async def projects_list(req: Request):
    """Every project, active first, each with how much is in it and how far
    its tasks have got — counted over everything, named nowhere."""
    body = await req.json() if await req.body() else {}
    space = space_of(req, body)
    want = body.get("status")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select p.id, p.key, p.title, p.props, p.updated_at,"
            "       count(o.id) as items,"
            "       count(o.id) filter (where o.type = 'task') as tasks,"
            "       count(o.id) filter (where o.type = 'task' and o.props->>'state' = 'done') as done"
            "  from objects p"
            "  left join edges e on e.dst = p.id and e.rel = $2"
            "  left join objects o on o.id = e.src and o.deleted_at is null"
            " where p.space_id = $1 and p.type = 'project' and p.deleted_at is null"
            " group by p.id order by p.updated_at desc, p.id", space, REL)
        # What is in each, by kind, and the newest few by name — each named
        # only to a reader it is shared with; the rest are in the counts alone.
        kinds = await conn.fetch(
            "select e.dst as project, o.type, count(*) as n from edges e join objects o on o.id = e.src"
            " where e.rel = $1 and o.deleted_at is null and o.space_id = $2 group by 1, 2", REL, space)
        recent = await conn.fetch(
            "select project, id, type, key, title from ("
            "  select e.dst as project, o.id, o.type, o.key, o.title,"
            "         row_number() over (partition by e.dst order by o.updated_at desc, o.id) as n"
            "    from edges e join objects o on o.id = e.src"
            "   where e.rel = $1 and o.deleted_at is null and o.space_id = $2 and o.acl_keys && $3::text[]) x"
            " where n <= 3 order by project, n", REL, space, await sharing.keys(req, conn))
    by_kind: dict[str, dict[str, int]] = {}
    for k in kinds:
        by_kind.setdefault(k["project"], {})[k["type"]] = k["n"]
    newest: dict[str, list[dict[str, Any]]] = {}
    for x in recent:
        newest.setdefault(x["project"], []).append(
            {"id": x["id"], "type": x["type"], "key": x["key"], "title": x["title"]})
    out = []
    for r in rows:
        card = {**_card(r), "items": r["items"], "tasks": {"total": r["tasks"], "done": r["done"]},
                "kinds": by_kind.get(r["id"], {}), "recent": newest.get(r["id"], []),
                "updated_at": r["updated_at"].isoformat()}
        if not want or card["status"] == want:
            out.append(card)
    order = {"active": 0, "done": 1, "archived": 2}
    out.sort(key=lambda c: order.get(c["status"], 3))
    return {"projects": out, "total": len(out)}


@router.post("/api/v1/projects.update")
async def projects_update(req: Request):
    """Rename a project, or change its description, color or status — a
    revision like any other edit, and a retry answers with the one it wrote."""
    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    key = body.get("idempotencyKey")
    if not key:
        return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key", "idempotencyKey")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _project(conn, str(body.get("project_id") or ""), space)
        if row is None:
            return _error(404, "unknown_project", f"no project {body.get('project_id')!r}", "project_id")
        props = _props(row)
        if (done := await replayed(conn, row["id"], key)) is not None:
            return {"project": _card(row), "rev": done, "replayed": True}
        for f in FIELDS:
            if f in body:
                props[f] = body[f].strip() if isinstance(body[f], str) and f == "title" else body[f]
        if violation := _schema_violation(_project_type(), props):
            why, field = violation
            return _error(422, "invalid_props", f"this does not match the project type — {why}", field)
        rev = int(row["current_rev"] or 1) + 1
        async with conn.transaction():
            await conn.execute(
                "insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
                row["id"], rev, actor, json.dumps({"props": props, "kind": "update", "key": key}))
            await conn.execute(
                "update objects set props = $2::jsonb, title = $3, current_rev = $4, updated_at = now()"
                " where id = $1", row["id"], json.dumps(props), props["title"], rev)
            await index_object(conn, row["id"])
        row = await _project(conn, row["id"], space)
    return {"project": _card(row), "rev": rev}


async def _tag(req: Request, add: bool):
    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key", "idempotencyKey")
    project_id = str(body.get("project_id") or "").strip()
    object_id = str(body.get("object_id") or "").strip()
    # Putting an item in a project changes how it is filed: the same edit its
    # own sharing allows, so a doc shared to view cannot be filed by its reader.
    if refused := await sharing.guard(req, object_id, space, "edit", "object_id"):
        return refused
    async with req.app.state.commonindex["pool"].acquire() as conn:
        project = await _project(conn, project_id, space)
        if project is None:
            return _error(404, "unknown_project", f"no project {project_id!r}", "project_id")
        kind = await conn.fetchval("select type from objects where id = $1", object_id)
        if kind == "project":
            return _error(422, "project_in_project", "a project is not put in another project", "object_id")
        if add:
            if (_props(project).get("status") or "active") == "archived":
                return _error(409, "archived", f"{project['title']} is archived — make it active "
                              "again to add to it", "project_id")
            wrote = await conn.fetchval(
                "insert into edges (src, rel, dst, created_by) values ($1,$2,$3,$4)"
                " on conflict do nothing returning 1", object_id, REL, project_id, actor)
        else:
            wrote = await conn.fetchval(
                "delete from edges where src = $1 and rel = $2 and dst = $3 returning 1",
                object_id, REL, project_id)
        if wrote:
            await conn.execute("update objects set updated_at = now() where id = $1", project_id)
    return {"project_id": project_id, "object_id": object_id, "tagged": add, "already": not wrote}


@router.post("/api/v1/projects.tag")
async def projects_tag(req: Request):
    """Put an item in a project."""
    return await _tag(req, True)


@router.post("/api/v1/projects.untag")
async def projects_untag(req: Request):
    """Take an item out of a project."""
    return await _tag(req, False)


def _status(kind: str, p: dict[str, Any]) -> str | None:
    """The one word an item's card shows: a task's state, a design's review."""
    for field in ("state", "status", "freshness"):
        if isinstance(p.get(field), str):
            return p[field]
    return None


@router.post("/api/v1/projects.items")
async def projects_items(req: Request):
    """Everything in a project the reader can see, grouped by kind; tasks
    counted by state over all of them; the rest only counted."""
    body = await req.json()
    space = space_of(req, body)
    project_id = str(body.get("project_id") or "").strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        project = await _project(conn, project_id, space)
        if project is None:
            return _error(404, "unknown_project", f"no project {project_id!r}", "project_id")
        keys = await sharing.keys(req, conn)
        rows = await conn.fetch(
            "select o.id, o.type, o.key, o.title, o.props, o.updated_at, o.acl_keys && $3::text[] as visible,"
            "       a.id as assignee_id, a.display as assignee_name, a.kind as assignee_kind"
            "  from edges e join objects o on o.id = e.src"
            "  left join actors a on a.id = o.props->>'assignee'"
            " where e.dst = $1 and e.rel = $2 and o.space_id = $4 and o.deleted_at is null"
            " order by o.updated_at desc, o.id", project_id, REL, keys, space)
    items: dict[str, list[dict[str, Any]]] = {}
    tasks = dict.fromkeys(STATES, 0)
    hidden = 0
    for r in rows:
        p = _props(r)
        if r["type"] == "task":
            tasks[p.get("state") or "ready"] = tasks.get(p.get("state") or "ready", 0) + 1
        if not r["visible"]:
            hidden += 1
            continue
        item = {"id": r["id"], "type": r["type"], "key": r["key"], "title": p.get("title") or p.get("name")
                or r["title"], "status": _status(r["type"], p), "updated_at": r["updated_at"].isoformat()}
        if r["type"] == "task":
            item["assignee"] = ({"id": r["assignee_id"], "name": r["assignee_name"], "kind": r["assignee_kind"]}
                                if r["assignee_id"] else None)
        items.setdefault(r["type"], []).append(item)
    return {"project": _card(project), "items": items,
            "tasks": {**tasks, "total": sum(tasks.values())}, "hidden": hidden}


@router.post("/api/v1/projects.of")
async def projects_of(req: Request):
    """Which projects each item is in — only for items the reader can see."""
    body = await req.json()
    space = space_of(req, body)
    ids = body.get("object_ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 200 or not all(isinstance(i, str) for i in ids):
        return _error(422, "bad_ids", "pass 1–200 item ids", "object_ids")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select e.src, p.id, p.key, p.title, p.props from edges e"
            "  join objects o on o.id = e.src and o.acl_keys && $4::text[] and o.deleted_at is null"
            "  join objects p on p.id = e.dst and p.type = 'project' and p.deleted_at is null"
            " where e.src = any($1::text[]) and e.rel = $2 and p.space_id = $3"
            " order by p.title", ids, REL, space, await sharing.keys(req, conn))
    out: dict[str, list[dict[str, Any]]] = {i: [] for i in ids}
    for r in rows:
        out[r["src"]].append(_card(r))
    return {"projects": out}
