"""People in a workspace: inviting them, their roles, and letting them go.

A person was a row someone inserted and a token someone minted on the box,
so a workspace could not take anyone in from its own pages. A member is a
person with a grant on the space; their role is that grant:

* Viewer — reads (read)
* Contributor — writes, proposes changes (propose)
* Reviewer — approves and merges what others propose (merge)
* Admin — everything, including who is in the workspace (admin)

Inviting takes a name, an email and a role, and makes the person, their role
and a sign-in token in one transaction — the token shown once, as an agent's
is. Removing someone takes their access away and keeps their work: anything
only they owned passes to whoever removed them, so nothing is left without an
owner.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.core.authz.store import RANK
from commonindex.gateway import mailer, signin
from commonindex.gateway.sharing import grant_id, lock

router = APIRouter()

ROLES = {"viewer": "read", "contributor": "propose", "reviewer": "merge", "admin": "admin"}
ROLE_OF = {v: k for k, v in ROLES.items()}
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def _who(req: Request) -> tuple[str, str]:
    from commonindex.gateway.auth import actor_of, space_of

    return actor_of(req), space_of(req, {})


async def _members(conn, space: str) -> list[dict]:
    rows = await conn.fetch(
        "select a.id, a.display, a.email, a.created_at, g.relation,"
        "       (select max(t.last_used) from actor_tokens t where t.actor_id = a.id) as last_seen"
        "  from actors a join grants g on g.subject = a.id and g.resource = $1"
        "   and (g.expires_at is null or g.expires_at > now())"
        " where a.kind = 'human' order by a.display", f"space:{space}")
    best: dict[str, dict] = {}
    for r in rows:
        if r["id"] in best and RANK.get(best[r["id"]]["relation"], 0) >= RANK.get(r["relation"], 0):
            continue
        best[r["id"]] = dict(r)
    return [{"id": r["id"], "name": r["display"], "email": r["email"],
             "role": ROLE_OF.get(r["relation"], "viewer"),
             "joined": r["created_at"].isoformat() if r["created_at"] else None,
             "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None}
            for r in best.values()]


async def _set_role(conn, person: str, role: str, space: str, by: str) -> None:
    resource = f"space:{space}"
    await conn.execute("delete from grants where subject = $1 and resource = $2", person, resource)
    await conn.execute(
        "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,$3,$4,$5)",
        f"g-{person}-{space}", person, ROLES[role], resource, by)


async def _admins(conn, space: str) -> list[str]:
    return [r["subject"] for r in await conn.fetch(
        "select distinct g.subject from grants g join actors a on a.id = g.subject and a.kind = 'human'"
        " where g.resource = $1 and g.relation = 'admin' and (g.expires_at is null or g.expires_at > now())",
        f"space:{space}")]


async def _elsewhere(conn, person: str, space: str) -> bool:
    """Whether this person can reach anything outside this workspace. A token
    is the person's, not the workspace's: one minted here signs them in
    everywhere they belong, so this workspace's admin may mint it only for
    someone who belongs nowhere else."""
    return bool(await conn.fetchval(
        "select 1 from grants g where g.subject = $1 and g.resource <> $2"
        "   and not (g.resource like 'object:%'"
        "            and exists (select 1 from objects o where 'object:' || o.id = g.resource"
        "                         and o.space_id = $3))"
        " limit 1", person, f"space:{space}", space))


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "person"


@router.post("/api/v1/members.list")
async def members_list(req: Request):
    """Everyone in the workspace, their role, and when they were last here."""
    actor, space = _who(req)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        members = await _members(conn, space)
    you = next((m for m in members if m["id"] == actor), None)
    return {"members": members, "you": {"id": actor, "role": you["role"] if you else None}}


@router.post("/api/v1/members.invite")
async def members_invite(req: Request):
    """Bring someone into the workspace: a name, an email and a role.

    How they get in follows how this deployment signs people in. With single
    sign-on or a trusted proxy they sign in with their company account, found
    by this email — nothing to send. Otherwise a sign-in link, shown once:
    it works once and expires, and buys a session, never a password."""
    body = await req.json()
    actor, space = _who(req)
    name, email = str(body.get("name") or "").strip(), str(body.get("email") or "").strip()
    role = body.get("role") or "contributor"
    if not name:
        return _error(422, "no_name", "say what to call them", "name")
    if not EMAIL.match(email):
        return _error(422, "bad_email", "that is not an email address", "email")
    if role not in ROLES:
        return _error(422, "bad_role", "role is viewer, contributor, reviewer or admin", "role")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        existing = await conn.fetchrow("select id, kind from actors where lower(email) = lower($1)", email)
        if existing and any(m["id"] == existing["id"] for m in await _members(conn, space)):
            return _error(409, "already_member", f"{email} is already in this workspace", "email")
        how = signin.methods()
        async with conn.transaction():
            token = expires = None
            if existing:
                person = existing["id"]   # someone who was here before, or in another workspace
                # Already signed in somewhere, or belongs somewhere else: they
                # are added, and keep the sign-in they have — a link made here
                # would sign them in to their every workspace.
                mint = not await _elsewhere(conn, person, space) and not await _signs_in(conn, person)
            else:
                mint = True
                base, person = _slug(email.split("@")[0]), None
                for n in range(50):
                    candidate = base if n == 0 else f"{base}-{n + 1}"
                    if not await conn.fetchval("select 1 from actors where id = $1", candidate):
                        person = candidate
                        break
                await conn.execute(
                    "insert into actors (id, kind, display, email) values ($1, 'human', $2, $3)",
                    person, name, email)
            await _set_role(conn, person, role, space, actor)
            if mint and how["code"]:
                token, expires = await signin.issue_code(conn, person, actor)
    method = signin.signs_in_without_link() or ("code" if token else "existing")
    # Told by email, where email can be sent: who asked, where to go, and how
    # to get in — never a credential, unless a link is the only way in.
    emailed = await mailer.send(email, f"You're invited to {_space_name()}", _invitation(
        name, await _name_of(req, actor), method, signin.sign_in_link(token) if token else None))
    return {"person_id": person, "name": name, "email": email, "role": role, "emailed": emailed,
            # `token` is the one-time sign-in code, kept under its old name for
            # the clients that build the link from it.
            "token": token, "link": signin.sign_in_link(token) if token else None,
            "expires_at": expires.isoformat() if expires else None,
            "sign_in": {"method": method, "name": "Google" if method == "google" else (how["sso"] or {}).get("name")},
            "token_note": _NOTES[method]}


_NOTES = {
    "code": "a sign-in link, shown once: it works once and expires — never stored, only its hash",
    "google": "they sign in with Google, using this email — nothing to send",
    "email": "they sign in with a code sent to this email — nothing to send",
    "sso": "they sign in with single sign-on, using this email — nothing to send",
    "proxy": "they sign in through your company's network gateway, using this email — nothing to send",
    "existing": "they already have a sign-in; they will see this workspace with it",
}


def _space_name() -> str:
    import os

    return os.environ.get("COMMONINDEX_SPACE_NAME", "").strip() or "the workspace"


async def _name_of(req: Request, actor: str) -> str:
    async with req.app.state.commonindex["pool"].acquire() as conn:
        return await conn.fetchval("select display from actors where id = $1", actor) or actor


def _invitation(name: str, by: str, method: str, link: str | None) -> str:
    how = {
        "google": "Sign in with Google, using this email address.",
        "sso": "Sign in with your company account.",
        "email": "Enter this email address and we'll send you a code.",
        "proxy": "Open it through your company's network — no password needed.",
        "existing": "Sign in the way you already do.",
    }.get(method)
    where = link or f"{signin.public_url()}/signin"
    lines = [f"Hi {name},", "", f"{by} invited you to {_space_name()}.", ""]
    lines += [f"Sign in here (the link works once, for {signin._days('COMMONINDEX_INVITE_DAYS', 7)} days):", where] \
        if link else [how or "", where]
    return "\n".join(lines)


async def _signs_in(conn, person: str) -> bool:
    """Whether this person can already sign in: a session, a code, a token."""
    return bool(await conn.fetchval(
        "select 1 from sessions where actor_id = $1 and revoked_at is null and expires_at > now()"
        " union all select 1 from sign_in_codes where actor_id = $1 and used_at is null and expires_at > now()"
        " union all select 1 from actor_tokens where actor_id = $1 limit 1", person))


@router.post("/api/v1/members.set_role")
async def members_set_role(req: Request):
    """Change what someone may do in the workspace. It keeps an admin."""
    body = await req.json()
    actor, space = _who(req)
    person, role = body.get("person_id"), body.get("role")
    if role not in ROLES:
        return _error(422, "bad_role", "role is viewer, contributor, reviewer or admin", "role")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        if not any(m["id"] == person for m in await _members(conn, space)):
            return _error(404, "not_a_member", f"{person!r} is not in this workspace", "person_id")
        async with conn.transaction():
            # One change to who is admin at a time: two admins demoting each
            # other at once would otherwise each see the other remain.
            await lock(conn, f"admins:{space}")
            if role != "admin" and await _admins(conn, space) == [person]:
                return _error(409, "last_admin",
                              "a workspace keeps at least one admin — make someone else admin first", "role")
            await _set_role(conn, person, role, space, actor)
        return {"members": await _members(conn, space)}


@router.post("/api/v1/members.remove")
async def members_remove(req: Request):
    """Take someone out of the workspace. Their work stays: what only they
    owned passes to whoever removed them."""
    body = await req.json()
    actor, space = _who(req)
    person = body.get("person_id")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        if not any(m["id"] == person for m in await _members(conn, space)):
            return _error(404, "not_a_member", f"{person!r} is not in this workspace", "person_id")
        if person == actor and await _admins(conn, space) != [person]:
            # What only they owned would pass to them, and go with them.
            return _error(409, "cannot_remove_yourself", "another admin has to remove you", "person_id")
        async with conn.transaction():
            await lock(conn, f"admins:{space}")
            if await _admins(conn, space) == [person]:
                return _error(409, "last_admin", "a workspace keeps at least one admin", "person_id")
            # Items in this space that only they owned.
            orphans = [r["resource"] for r in await conn.fetch(
                "select g.resource from grants g join objects o on 'object:' || o.id = g.resource"
                " where g.subject = $1 and g.relation = 'admin' and o.space_id = $2 and o.deleted_at is null"
                "   and not exists (select 1 from grants h where h.resource = g.resource and h.relation = 'admin'"
                "                    and h.subject <> $1)", person, space)]
            for resource in orphans:
                await conn.execute(
                    "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,'admin',$3,$2)"
                    " on conflict (id) do update set relation = 'admin', expires_at = null",
                    grant_id(resource, actor), actor, resource)   # the id a share uses: one grant each
            await conn.execute(
                "delete from grants where subject = $1 and (resource = $2 or resource in"
                " (select 'object:' || id from objects where space_id = $3))", person, f"space:{space}", space)
            # Signed out of this workspace: a person in no other workspace has no use for a token.
            others = await conn.fetchval(
                "select count(*) from grants where subject = $1 and resource like 'space:%'", person)
            if not others:
                await conn.execute("delete from actor_tokens where actor_id = $1", person)
                await signin.end_sessions(conn, person)
        return {"removed": person, "items_passed_to_you": len(orphans), "members": await _members(conn, space)}


@router.post("/api/v1/members.new_token")
async def members_new_token(req: Request):
    """Sign someone out everywhere and give them a new way in: a one-time
    sign-in link — or, where people sign in with their company account,
    nothing to send. Their old sessions, links and tokens stop working."""
    body = await req.json()
    actor, space = _who(req)
    person = body.get("person_id")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        if not any(m["id"] == person for m in await _members(conn, space)):
            return _error(404, "not_a_member", f"{person!r} is not in this workspace", "person_id")
        if await _elsewhere(conn, person, space):
            return _error(409, "in_other_workspaces",
                          "they belong to other workspaces too, so their sign-in is not this workspace's to"
                          " replace", "person_id")
        how = signin.methods()
        token = expires = None
        async with conn.transaction():
            await conn.execute("delete from actor_tokens where actor_id = $1", person)
            await signin.end_sessions(conn, person)
            if how["code"]:
                token, expires = await signin.issue_code(conn, person, actor)
    method = signin.signs_in_without_link() or "code"
    return {"person_id": person, "token": token, "link": signin.sign_in_link(token) if token else None,
            "expires_at": expires.isoformat() if expires else None,
            "sign_in": {"method": method, "name": "Google" if method == "google" else (how["sso"] or {}).get("name")},
            "token_note": ("a sign-in link, shown once — their previous sign-in no longer works" if token else
                           "signed out everywhere; they sign in again with their company account")}
