"""People in a workspace, against a real database.

A person was a row somebody inserted and a token somebody minted on the box.
Defended: inviting makes the person, their role and a sign-in token that
works; an email already in the workspace is not invited twice; a workspace
keeps an admin; removing someone keeps their work — what only they owned
passes to whoever removed them — and a reissued token replaces the old one.
"""

from __future__ import annotations

import itertools
import json

import pytest
from db import DSN, reset, seed

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

_KEYS = itertools.count()


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    await conn.execute("insert into grants (id, subject, relation, resource, granted_by)"
                       " values ('g-maya', 'maya', 'admin', 'space:pay', 'maya')")
    try:
        yield conn
    finally:
        await conn.close()


class _PoolOf:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Held:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_):
                return False

        return _Held()


class _Req:
    def __init__(self, body, conn, actor="maya"):
        self._body = body
        space = body.pop("_space", "pay")   # the space the middleware authorised
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": actor})(), "space": space})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {"pool": _PoolOf(conn)}})()})()

    async def json(self):
        return self._body


async def call(db, handler, actor="maya", **body):
    body.setdefault("idempotencyKey", f"k-{next(_KEYS)}")
    out = await handler(_Req(body, db, actor))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


async def test_an_invitation_makes_a_member_who_can_sign_in(db):
    from commonindex.core.authz.store import NoSuchToken, PgChecker
    from commonindex.gateway.members import members_invite, members_list
    from commonindex.gateway.signin import session_principal, start_session

    status, out = await call(db, members_invite, name="Rhea Kapoor", email="Rhea@Example.test", role="contributor")
    assert status == 200 and out["person_id"] == "rhea" and out["token"].startswith("ehc_")
    assert out["link"].endswith(out["token"]) and out["sign_in"]["method"] == "code"
    # A sign-in code, not a credential: it buys a session once (test_signin).
    with pytest.raises(NoSuchToken):
        await PgChecker(db).principal(out["token"])
    assert (await session_principal(db, await start_session(db, "rhea", "code"))).actor_id == "rhea"
    _, listed = await call(db, members_list)
    assert {(m["id"], m["role"]) for m in listed["members"]} >= {("rhea", "contributor"), ("maya", "admin")}
    status, again = await call(db, members_invite, name="Rhea", email="rhea@example.test", role="viewer")
    assert (status, again["error"]["code"]) == (409, "already_member")


async def test_a_workspace_keeps_an_admin(db):
    from commonindex.gateway.members import members_remove, members_set_role

    status, out = await call(db, members_set_role, person_id="maya", role="viewer")
    assert (status, out["error"]["code"]) == (409, "last_admin")
    status, out = await call(db, members_remove, person_id="maya")
    assert (status, out["error"]["code"]) == (409, "last_admin")


async def test_removing_someone_keeps_their_work(db):
    from commonindex.gateway.members import members_invite, members_remove

    await call(db, members_invite, name="Rhea", email="rhea@example.test", role="contributor")
    await db.execute(
        "insert into objects (id, space_id, type, title, created_by, acl_keys) values"
        " ('doc-r', 'pay', 'doc', 'Rhea''s notes', 'rhea', '{object:doc-r}');"
        " insert into grants (id, subject, relation, resource, granted_by) values"
        " ('g-own', 'rhea', 'admin', 'object:doc-r', 'rhea')")
    status, out = await call(db, members_remove, person_id="rhea")
    assert status == 200 and out["items_passed_to_you"] == 1
    owners = [r["subject"] for r in await db.fetch(
        "select subject from grants where resource = 'object:doc-r' and relation = 'admin'")]
    assert owners == ["maya"]
    assert not await db.fetchval("select count(*) from grants where subject = 'rhea'")
    assert not await db.fetchval("select count(*) from actor_tokens where actor_id = 'rhea'")


async def test_a_new_sign_in_link_signs_them_out_everywhere(db):
    from commonindex.gateway.members import members_invite, members_new_token
    from commonindex.gateway.signin import session_principal, start_session

    _, inv = await call(db, members_invite, name="Rhea", email="rhea@example.test", role="viewer")
    signed_in = await start_session(db, "rhea", "code")
    _, fresh = await call(db, members_new_token, person_id="rhea")
    assert fresh["token"].startswith("ehc_") and fresh["token"] != inv["token"]
    assert await session_principal(db, signed_in) is None             # that browser is signed out
    assert not await db.fetchval("select count(*) from sign_in_codes"
                                 " where actor_id = 'rhea' and used_at is null and id <> ("
                                 "   select id from sign_in_codes order by created_at desc limit 1)")


def test_only_admins_reach_members():
    # Who is in the workspace, and changing it, is an admin's: the middleware
    # refuses anyone else before a handler runs.
    from commonindex.core.authz.ops import register_members
    from commonindex.core.ops import Registry

    reg = Registry()
    register_members(reg)
    assert {op.name: op.relation for op in reg.all()} == dict.fromkeys(
        ["members.list", "members.invite", "members.set_role", "members.remove", "members.new_token"], "admin")


async def test_an_admin_does_not_remove_themself(db):
    # What only they owned would pass to them, and leave with them.
    from commonindex.gateway.members import members_invite, members_remove

    await call(db, members_invite, name="Rhea", email="rhea@example.test", role="admin")
    status, out = await call(db, members_remove, person_id="maya")
    assert (status, out["error"]["code"]) == (409, "cannot_remove_yourself")


async def test_items_passed_on_are_one_grant_each(db):
    # The remover already had view on it: they become its owner, not listed twice.
    from commonindex.gateway.members import members_invite, members_remove
    from commonindex.gateway.sharing import grant_id

    await call(db, members_invite, name="Rhea", email="rhea@example.test", role="contributor")
    await db.execute(
        "insert into objects (id, space_id, type, title, created_by, acl_keys) values"
        " ('doc-r', 'pay', 'doc', 'Rhea''s notes', 'rhea', '{object:doc-r}')")
    await db.execute(
        "insert into grants (id, subject, relation, resource, granted_by) values"
        " ('g-own', 'rhea', 'admin', 'object:doc-r', 'rhea'), ($1, 'maya', 'read', 'object:doc-r', 'rhea')",
        grant_id("object:doc-r", "maya"))
    await call(db, members_remove, person_id="rhea")
    assert [(r["subject"], r["relation"]) for r in await db.fetch(
        "select subject, relation from grants where resource = 'object:doc-r'")] == [("maya", "admin")]


async def test_another_workspace_s_admin_gets_no_sign_in_for_its_people(db):
    # A token is the person's, not the workspace's: one minted in growth for
    # maya would sign in as maya in pay, as pay's admin.
    from commonindex.gateway.members import members_invite, members_new_token
    from commonindex.gateway.sharing import people_set_email

    await db.execute("update actors set email = 'maya@example.test' where id = 'maya';"
                     " insert into actors (id, kind, display) values ('eve', 'human', 'Eve');"
                     " insert into grants (id, subject, relation, resource, granted_by)"
                     " values ('g-eve', 'eve', 'admin', 'space:growth', 'eve')")
    status, out = await call(db, members_invite, actor="eve", _space="growth",
                             name="Maya", email="maya@example.test", role="viewer")
    assert status == 200 and out["token"] is None
    assert not await db.fetchval("select count(*) from actor_tokens where actor_id = 'maya'")
    status, out = await call(db, members_new_token, actor="eve", _space="growth", person_id="maya")
    assert (status, out["error"]["code"]) == (409, "in_other_workspaces")
    status, out = await call(db, people_set_email, actor="eve", _space="growth",
                             person_id="maya", email="eve@evil.test")
    assert (status, out["error"]["code"]) == (403, "not_allowed")
    assert await db.fetchval("select email from actors where id = 'maya'") == "maya@example.test"
