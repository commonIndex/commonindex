"""Granting, revoking, and asking who can do what.

Authorization shipped enforceable and not administrable: the only way to change
a permission was a SQL statement, which means in practice permissions do not get
changed. The interesting part is not `grant` — it is that `Grant` carries expiry
and last-used, so the two questions nobody can usually answer become ordinary
reads:

  - what expires this month, and
  - what was granted and has never once been exercised.

The second is the safest revocation there is, and it only exists because
`require` stamps the grant that satisfied each check.

Every operation here needs `admin`, checked by the same middleware as everything
else — there is no separate administrative door.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.core.authz.store import RANK

router = APIRouter()

#: A resource is a kind and an id — `space:pay`, `object:doc-42`. Constrained
#: because a grant on a malformed resource is a grant that silently never
#: matches, and a caller would have no way to see that.
RESOURCE = re.compile(r"^(space|object):[A-Za-z0-9_.:-]{1,120}$")


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message,
                                           "field": field}})


@router.post("/api/v1/access.list")
async def access_list(req: Request):
    """Who can do what — and, for each grant, whether it has ever been used.

    This is the recertification query. A reviewer asked to approve access
    normally sees a list of names and has no way to tell a load-bearing grant
    from one issued for a migration that finished last year; `used` and
    `expires_in_days` are what make that difference visible.
    """
    state = req.app.state.commonindex
    body = await req.json() if await req.body() else {}
    now = datetime.now(tz=UTC)

    rows = await state["pool"].fetch(
        "select g.id, g.subject, g.relation, g.resource, g.namespace,"
        "       g.granted_by, g.expires_at, g.last_used, g.created_at,"
        "       a.kind, a.trust_tier"
        "  from grants g left join actors a on a.id = g.subject"
        " where ($1::text is null or g.subject = $1)"
        "   and ($2::text is null or g.resource = $2)"
        " order by g.subject, g.relation",
        body.get("subject"), body.get("resource"))

    out = []
    for r in rows:
        expired = r["expires_at"] is not None and r["expires_at"] <= now
        out.append({
            "id": r["id"], "subject": r["subject"], "relation": r["relation"],
            "resource": r["resource"],
            # Empty for a native grant, "src:slack" for an imported one — the
            # two live in one table on purpose, never as a second mechanism.
            "namespace": r["namespace"] or "",
            "actor_kind": r["kind"], "trust_tier": r["trust_tier"],
            "granted_by": r["granted_by"],
            "granted_at": r["created_at"].isoformat(),
            "expires_at": r["expires_at"].isoformat() if r["expires_at"] else None,
            "expires_in_days": (
                (r["expires_at"] - now).days if r["expires_at"] else None),
            "expired": expired,
            "last_used": r["last_used"].isoformat() if r["last_used"] else None,
            # The revocation queue, in one field.
            "never_used": r["last_used"] is None,
            "idle_days": ((now - r["last_used"]).days if r["last_used"]
                          else (now - r["created_at"]).days),
        })

    if body.get("never_used"):
        out = [g for g in out if g["never_used"]]
    return {"grants": out, "total": len(out),
            "never_used": sum(1 for g in out if g["never_used"]),
            "expired": sum(1 for g in out if g["expired"])}


@router.post("/api/v1/access.grant")
async def access_grant(req: Request):
    """Give an actor a relation on a resource.

    `days` is encouraged rather than required, but a grant with no expiry is
    reported as such by `access.list` — permanent access is a decision somebody
    should be able to see, not the default that happens when nobody chose.
    """
    from commonindex.gateway.auth import actor_of

    state = req.app.state.commonindex
    body = await req.json()
    subject = (body.get("subject") or "").strip()
    relation = (body.get("relation") or "").strip()
    resource = (body.get("resource") or "").strip()

    if relation not in RANK:
        return _error(422, "unknown_relation",
                      f"{relation!r} is not a relation any grant can hold; "
                      f"the model defines {sorted(RANK)}", "relation")
    if not RESOURCE.match(resource):
        return _error(422, "bad_resource",
                      f"{resource!r} is not a resource — expected space:<id> or "
                      "object:<id>. A grant on a malformed resource matches "
                      "nothing and looks granted.", "resource")

    async with state["pool"].acquire() as conn:
        if await conn.fetchrow("select 1 from actors where id = $1", subject) is None:
            return _error(404, "unknown_actor",
                          f"no actor {subject!r} to grant to", "subject")

        days = body.get("days")
        gid = f"g-{subject}-{relation}-{resource.replace(':', '-')}"
        row = await conn.fetchrow(
            "insert into grants (id, subject, relation, resource, granted_by,"
            " expires_at) values ($1,$2,$3,$4,$5,"
            "   case when $6::int is null then null"
            "        else now() + ($6 || ' days')::interval end)"
            " on conflict (id) do update set expires_at = excluded.expires_at,"
            "   granted_by = excluded.granted_by"
            " returning id, expires_at, (xmax = 0) as created",
            gid, subject, relation, resource, actor_of(req), days)

    return {"id": row["id"], "subject": subject, "relation": relation,
            "resource": resource, "created": row["created"],
            "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None}


@router.post("/api/v1/access.revoke")
async def access_revoke(req: Request):
    """Take a grant away. Idempotent — revoking twice is not an error, because
    the caller's intent is satisfied either way."""
    state = req.app.state.commonindex
    body = await req.json()
    gid = body.get("id")
    if not gid:
        return _error(422, "missing_id", "pass the grant id from access.list", "id")

    row = await state["pool"].fetchrow(
        "delete from grants where id = $1 returning subject, relation, resource", gid)
    if row is None:
        return {"id": gid, "revoked": False, "already": True}
    return {"id": gid, "revoked": True, "subject": row["subject"],
            "relation": row["relation"], "resource": row["resource"]}


@router.post("/api/v1/access.tokens")
async def access_tokens(req: Request):
    """The credentials in circulation, never their secrets.

    A token's value is not stored — only its hash — so this can say who holds
    one, when it was last used and when it lapses, and nothing that would let
    the reader use it.
    """
    state = req.app.state.commonindex
    body = await req.json() if await req.body() else {}
    now = datetime.now(tz=UTC)

    rows = await state["pool"].fetch(
        "select t.id, t.actor_id, t.label, t.expires_at, t.last_used, t.created_at,"
        "       a.kind, a.trust_tier from actor_tokens t"
        "  join actors a on a.id = t.actor_id"
        " where ($1::text is null or t.actor_id = $1)"
        " order by t.actor_id, t.created_at desc", body.get("actor_id"))

    return {"tokens": [{
        "id": r["id"], "actor_id": r["actor_id"], "label": r["label"],
        "actor_kind": r["kind"], "trust_tier": r["trust_tier"],
        "created_at": r["created_at"].isoformat(),
        "expires_at": r["expires_at"].isoformat() if r["expires_at"] else None,
        "expired": r["expires_at"] is not None and r["expires_at"] <= now,
        "last_used": r["last_used"].isoformat() if r["last_used"] else None,
        "never_used": r["last_used"] is None,
    } for r in rows], "total": len(rows)}


@router.post("/api/v1/access.revoke_token")
async def access_revoke_token(req: Request):
    """Kill a credential. The actor keeps its grants; only this token stops
    working, which is the difference between losing a laptop and leaving."""
    state = req.app.state.commonindex
    body = await req.json()
    tid = body.get("id")
    if not tid:
        return _error(422, "missing_id", "pass the token id from access.tokens", "id")
    row = await state["pool"].fetchrow(
        "delete from actor_tokens where id = $1 returning actor_id, label", tid)
    if row is None:
        return {"id": tid, "revoked": False, "already": True}
    return {"id": tid, "revoked": True, "actor_id": row["actor_id"],
            "label": row["label"]}


@router.post("/api/v1/actors.me")
async def actors_me(req: Request):
    """Who the caller is and what they hold here — so a page can say "mine"
    about the signed-in person, and offer only what the gateway would allow,
    instead of hardcoding a name."""
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    row = await state["pool"].fetchrow(
        "select id, kind, display, trust_tier from actors where id = $1", actor)
    grants = await state["pool"].fetch(
        "select relation, expires_at from grants where subject = $1 and resource = $2",
        actor, f"space:{space}")
    now = datetime.now(tz=UTC)
    best = max((RANK.get(g["relation"], 0) for g in grants
                if g["expires_at"] is None or g["expires_at"] > now), default=0)
    held = [r for r, rank in sorted(RANK.items(), key=lambda kv: kv[1]) if 0 < rank <= best]
    principal = getattr(req.state, "principal", None)
    return {"id": actor, "display": (row["display"] if row else None) or actor,
            "kind": row["kind"] if row else None, "space": space, "may": held,
            # How this request was signed in: a session, a token, the proxy,
            # or "local" — no sign-in, on the gateway's own computer.
            "via": getattr(principal, "via", None)}
