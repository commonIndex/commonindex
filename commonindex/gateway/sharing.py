"""Who may see and change one dashboard, doc or design.

Every permission was a workspace's: a grant on `space:pay` let a person see
and edit everything in it. Each item now says who it is for.

* Private, the default for a new item: its permission key is `object:<id>`,
  so only people granted on that resource see it — the creator, as owner, and
  whoever it is shared with.
* Workspace: its key is `space:<space>`, as every item was before. Everyone in
  the workspace sees it, and edits it as their workspace role allows.

A share is a grant on `object:<id>`: view (read), edit (propose) or owner
(admin, which also manages who else has access). Shared only with people
already in the workspace, by email — an email recognises a member, it never
makes one.

One function answers "what may this person do with this item", and every read
and every edit asks it, so a list, a page, a comment thread and a search agree.
A person who may not see an item is told it does not exist: saying "not yours"
is most of a leak.
"""

from __future__ import annotations

import hashlib
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.core.authz.store import RANK

router = APIRouter()

#: The items that can be private and shared. A channel too: private, it is
#: for the people added to it, and its messages with it.
SHARED = ("dashboard", "doc", "design", "channel", "video", "artifact")

#: What each role is as a relation. Owner manages access as well as editing.
ROLES = {"view": "read", "edit": "propose", "owner": "admin"}
ROLE_OF = {v: k for k, v in ROLES.items()}

#: Item edits: the middleware asks only that the caller is in the workspace,
#: and the handler asks this module whether they may edit this item — a person
#: who may read the workspace can be an item's editor.
ITEM_EDITS = frozenset({
    "docs.revise", "designs.revise", "designs.request_review",
    "dashboards.update", "dashboards.delete", "panels.add", "panels.remove",
    "panels.resize", "panels.reorder",
    "items.share", "items.unshare", "items.set_visibility",
    "channels.update", "channels.archive",
    "videos.save", "videos.render", "videos.delete",
    "artifacts.save", "artifacts.delete",
})

LEVELS = ("none", "view", "edit", "manage")


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def _actor(req: Request) -> str:
    from commonindex.gateway.auth import actor_of

    return actor_of(req)


def _space(req: Request, body: dict) -> str:
    from commonindex.gateway.auth import space_of

    return space_of(req, body)


async def _ranks(conn, actor: str, resources: list[str]) -> dict[str, int]:
    rows = await conn.fetch(
        "select resource, relation from grants where subject = $1 and resource = any($2::text[])"
        "   and (expires_at is null or expires_at > now())", actor, resources)
    best: dict[str, int] = {}
    for r in rows:
        best[r["resource"]] = max(best.get(r["resource"], 0), RANK.get(r["relation"], 0))
    return best


async def level(conn, actor: str, space: str, row: Any) -> str:
    """What this person may do with this item: none, view, edit or manage."""
    obj, ws = f"object:{row['id']}", f"space:{space}"
    ranks = await _ranks(conn, actor, [obj, ws])
    mine, member = ranks.get(obj, 0), ranks.get(ws, 0)
    # A private item answers only to grants on itself. One opened to the
    # workspace gives every member what its general access says — view or
    # edit — or, opened before that choice existed, their workspace role.
    rank = mine
    # The workspace's admin manages everything in it, private or not — so
    # nothing is ever left that nobody can reach, not even a removed member's.
    if member >= RANK["admin"]:
        return "manage"
    if ws in (row["acl_keys"] or []) and member:
        general = row["general_access"]
        rank = max(rank, member if general is None
                   else RANK["propose"] if general == "edit" else RANK["read"])
    if rank >= RANK["admin"]:
        return "manage"
    if rank >= RANK["propose"]:
        return "edit"
    return "view" if rank >= RANK["read"] else "none"


async def item(conn, object_id: str, space: str):
    return await conn.fetchrow(
        "select id, type, key, title, created_by, acl_keys, general_access from objects"
        " where id = $1 and space_id = $2 and deleted_at is null", object_id, space)


async def require(req: Request, conn, object_id: str, space: str, need: str, field: str = "id"):
    """(row, None) when the caller may `need` this item, else (None, refusal).
    Not seeing it reads as not existing; seeing and not editing says so."""
    row = await item(conn, object_id or "", space)
    have = await level(conn, _actor(req), space, row) if row is not None else "none"
    if row is None or have == "none":
        return None, _error(404, "unknown_item", f"no item {object_id!r} you can see", field)
    if LEVELS.index(have) < LEVELS.index(need):
        return None, _error(403, "not_allowed",
                            {"edit": "you can view this but not edit it — ask its owner to share it with you to edit",
                             "manage": "only its owners can change who has access"}[need], field)
    return row, None


async def guard(req: Request, object_id: str | None, space: str, need: str, field: str = "id"):
    """The refusal when the caller may not `need` this item, else None."""
    async with req.app.state.commonindex["pool"].acquire() as conn:
        _, err = await require(req, conn, object_id or "", space, need, field)
    return err


async def keys(req: Request, conn) -> list[str]:
    """The permission keys the caller holds: what a list may show them."""
    from commonindex.core.authz.store import PgChecker

    checker = req.app.state.commonindex.get("checker") or PgChecker(conn)
    return await checker.acl_keys_for(_actor(req))


def grant_id(resource: str, subject: str) -> str:
    return "g-" + hashlib.sha256(f"{resource}:{subject}".encode()).hexdigest()[:20]


async def make_private(conn, object_id: str, owner: str) -> None:
    """A new item: only its creator, as owner, until it is shared.

    A person's only. What an agent makes is for the workspace that runs it —
    an agent cannot share, so private to one would be seen by no one — and
    stays open to every member by their role."""
    if await conn.fetchval("select kind from actors where id = $1", owner) != "human":
        return
    resource = f"object:{object_id}"
    # Only an item its creator made: never one someone else's id points at.
    if not await conn.fetchval("update objects set acl_keys = array[$2::text]"
                               " where id = $1 and created_by = $3 returning id", object_id, resource, owner):
        return
    await conn.execute(
        "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,'admin',$3,$2)"
        " on conflict (id) do update set relation = 'admin', expires_at = null",
        grant_id(resource, owner), owner, resource)


async def lock(conn, name: str) -> None:
    """Serialise changes to one thing for the rest of this transaction."""
    await conn.execute("select pg_advisory_xact_lock(hashtext($1))", name)


async def follow(conn, dashboard_id: str) -> None:
    """A dashboard's panels are seen by whoever sees the dashboard."""
    await conn.execute(
        "update objects p set acl_keys = d.acl_keys from panel_bindings pb, objects d"
        " where pb.dashboard_id = $1 and p.id = pb.panel_id and d.id = pb.dashboard_id", dashboard_id)


async def hidden_metrics(conn, space: str, keys: list[str]) -> set[str]:
    """Metrics charted only on dashboards the caller cannot see: their names
    are those dashboards' panel titles. A metric on no dashboard, or on one
    they can see, is the workspace's to reuse."""
    return {r["metric_id"] for r in await conn.fetch(
        "select pb.metric_id from panel_bindings pb join objects o on o.id = pb.dashboard_id"
        " where o.space_id = $1 and o.deleted_at is null"
        " group by pb.metric_id having not bool_or(o.acl_keys && $2::text[])", space, keys)}


async def may_delete(conn, actor: str, space: str, row: Any) -> bool:
    """Its owners — or, on an item still governed by workspace roles, whoever
    could delete before items had owners: a reviewer or an admin."""
    if await level(conn, actor, space, row) == "manage":
        return True
    if f"space:{space}" in (row["acl_keys"] or []) and row["general_access"] is None:
        return (await _ranks(conn, actor, [f"space:{space}"])).get(f"space:{space}", 0) >= RANK["merge"]
    return False


async def _reindex(conn, object_id: str) -> None:
    # Chunks carry the item's keys, so search follows a change of access.
    from commonindex.workers.indexer import index_object

    await index_object(conn, object_id)


# ── the routes ────────────────────────────────────────────────────────────


async def _people(conn, object_id: str, space: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "select g.subject, g.relation, a.display, a.email, a.kind from grants g"
        "  join actors a on a.id = g.subject"
        " where g.resource = $1 and (g.expires_at is null or g.expires_at > now())"
        " order by (g.relation = 'admin') desc, a.display", f"object:{object_id}")
    return [{"id": r["subject"], "name": r["display"], "email": r["email"], "kind": r["kind"],
             "role": ROLE_OF.get(r["relation"], "edit")} for r in rows]


@router.post("/api/v1/items.access")
async def items_access(req: Request):
    """Who can see and change this item, and what the caller may do with it."""
    body = await req.json()
    space = _space(req, body)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, err = await require(req, conn, body.get("id"), space, "view")
        if err:
            return err
        you = await level(conn, _actor(req), space, row)
        open_ = f"space:{space}" in (row["acl_keys"] or [])
        return {"id": row["id"], "type": row["type"], "title": row["title"],
                "visibility": "workspace" if open_ else "private",
                # What everyone in the workspace may do when it is open: view,
                # edit, or "role" — each member's workspace role.
                "general": (row["general_access"] or "role") if open_ else None,
                "you": you, "people": await _people(conn, row["id"], space)}


async def _member_by_email(conn, email: str, space: str):
    return await conn.fetchrow(
        "select a.id, a.display, a.email from actors a"
        " where lower(a.email) = lower($1) and a.kind = 'human'"
        "   and exists (select 1 from grants g where g.subject = a.id and g.resource = $2"
        "                and (g.expires_at is null or g.expires_at > now()))",
        email.strip(), f"space:{space}")


@router.post("/api/v1/items.share")
async def items_share(req: Request):
    """Give a workspace member view, edit or owner access to this item, by email."""
    body = await req.json()
    space = _space(req, body)
    role = body.get("role") or "view"
    if role not in ROLES:
        return _error(422, "bad_role", "role is view, edit or owner", "role")
    email = str(body.get("email") or "").strip()
    if "@" not in email:
        return _error(422, "bad_email", "say who to share with, by their email", "email")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, err = await require(req, conn, body.get("id"), space, "manage")
        if err:
            return err
        person = await _member_by_email(conn, email, space)
        if person is None:
            return _error(422, "not_a_member",
                          f"{email} is not in this workspace — items can be shared only with members",
                          "email")
        resource = f"object:{row['id']}"
        async with conn.transaction():
            await lock(conn, resource)
            owners = await conn.fetch("select subject from grants where resource = $1 and relation = 'admin'"
                                      "   and (expires_at is null or expires_at > now())", resource)
            if role != "owner" and [o["subject"] for o in owners] == [person["id"]]:
                return _error(409, "last_owner", "an item keeps at least one owner — add another owner first",
                              "role")
            await conn.execute(
                "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,$3,$4,$5)"
                " on conflict (id) do update set relation = excluded.relation, expires_at = null",
                grant_id(resource, person["id"]), person["id"], ROLES[role], resource, _actor(req))
        return {"id": row["id"], "people": await _people(conn, row["id"], space)}


@router.post("/api/v1/items.unshare")
async def items_unshare(req: Request):
    """Take someone's access to this item away. An item keeps at least one owner."""
    body = await req.json()
    space = _space(req, body)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, err = await require(req, conn, body.get("id"), space, "manage")
        if err:
            return err
        who = body.get("person_id")
        if not who and body.get("email"):
            who = await conn.fetchval("select id from actors where lower(email) = lower($1)",
                                      str(body["email"]).strip())
        if not who:
            return _error(404, "unknown_person", "say whose access to take away, by person_id or email",
                          "person_id")
        resource = f"object:{row['id']}"
        async with conn.transaction():
            # One change to an item's owners at a time: two owners removing
            # each other at once would otherwise both see the other remain.
            await lock(conn, resource)
            owners = await conn.fetch("select subject from grants where resource = $1 and relation = 'admin'"
                                      "   and (expires_at is null or expires_at > now())", resource)
            if [o["subject"] for o in owners] == [who]:
                return _error(409, "last_owner", "an item keeps at least one owner — add another owner first",
                              "person_id")
            await conn.execute("delete from grants where resource = $1 and subject = $2", resource, who)
        return {"id": row["id"], "people": await _people(conn, row["id"], space)}


@router.post("/api/v1/items.set_visibility")
async def items_set_visibility(req: Request):
    """Private (only the people it is shared with) or the whole workspace."""
    body = await req.json()
    space = _space(req, body)
    visibility = body.get("visibility")
    if visibility not in ("private", "workspace"):
        return _error(422, "bad_visibility", "visibility is private or workspace", "visibility")
    role = body.get("role") or "view"
    if role not in ("view", "edit"):
        return _error(422, "bad_role", "everyone in the workspace can view or edit", "role")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, err = await require(req, conn, body.get("id"), space, "manage")
        if err:
            return err
        key = f"space:{space}" if visibility == "workspace" else f"object:{row['id']}"
        resource = f"object:{row['id']}"
        async with conn.transaction():
            await conn.execute("update objects set acl_keys = array[$2::text], general_access = $3 where id = $1",
                               row["id"], key, role if visibility == "workspace" else None)
            # An item made before items had owners (or by an agent) is managed
            # through the workspace role. Narrowing it would leave it with no
            # one to manage it — or, private, no one to see it: whoever narrows
            # it becomes its owner.
            if not await conn.fetchval("select 1 from grants where resource = $1 and relation = 'admin'"
                                       "   and (expires_at is null or expires_at > now())", resource):
                actor = _actor(req)
                await conn.execute(
                    "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,'admin',$3,$2)"
                    " on conflict (id) do update set relation = 'admin', expires_at = null",
                    grant_id(resource, actor), actor, resource)
            await follow(conn, row["id"])
            await _reindex(conn, row["id"])
        return {"id": row["id"], "visibility": visibility,
                "general": role if visibility == "workspace" else None}


@router.post("/api/v1/people.set_email")
async def people_set_email(req: Request):
    """Record a person's email, so items can be shared with them by it."""
    body = await req.json()
    email = str(body.get("email") or "").strip() or None
    if email is not None and "@" not in email:
        return _error(422, "bad_email", "that is not an email address", "email")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        from commonindex.gateway.members import _elsewhere

        space = _space(req, body)
        person = await conn.fetchrow(
            "select a.id, a.kind from actors a where a.id = $1 and exists (select 1 from grants g"
            " where g.subject = a.id and g.resource = $2)", body.get("person_id"), f"space:{space}")
        if person is None or person["kind"] != "human":
            return _error(404, "unknown_person", "no one in this workspace with that id", "person_id")
        # An email is how a person is found in every workspace they are in:
        # one workspace's admin sets it only for someone who is in no other.
        if person["id"] != _actor(req) and await _elsewhere(conn, person["id"], space):
            return _error(403, "not_allowed", "they belong to other workspaces too, so only they can change"
                          " their email", "person_id")
        taken = email and await conn.fetchval(
            "select id from actors where lower(email) = lower($1) and id <> $2", email, person["id"])
        if taken:
            return _error(409, "email_taken", f"{email} already belongs to {taken}", "email")
        await conn.execute("update actors set email = $2 where id = $1", person["id"], email)
    return {"person_id": person["id"], "email": email}
