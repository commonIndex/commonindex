"""Who may see and change one dashboard, doc or design, against a real database.

Every permission was a workspace's, so anything anyone made, everyone saw and
could edit. What is defended: a new item is private to its creator; it is
shared by email, with members only, to view or to edit; viewing is not editing;
only owners share; opening it to the workspace makes the workspace's roles
apply; an item keeps an owner; and its comments follow it.
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
    await conn.execute("""
        insert into actors (id, kind, display, email) values
          ('rhea', 'human', 'Rhea', 'rhea@example.test'), ('gus', 'human', 'Gus', 'gus@elsewhere.test');
        update actors set email = 'maya@example.test' where id = 'maya';
        insert into grants (id, subject, relation, resource, granted_by) values
          ('g-maya', 'maya', 'propose', 'space:pay', 'maya'),
          ('g-rhea', 'rhea', 'read', 'space:pay', 'maya');
    """)
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

    def __getattr__(self, name):
        return getattr(self._conn, name)


class _Req:
    def __init__(self, body, conn, actor):
        self._body = body
        space = body.pop("_space", "pay")   # the space the middleware authorised
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": actor})(), "space": space})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {"pool": _PoolOf(conn)}})()})()

    async def json(self):
        return self._body

    async def body(self):
        return json.dumps(self._body).encode()


async def call(db, handler, actor="maya", **body):
    body.setdefault("idempotencyKey", f"k-{next(_KEYS)}")
    out = await handler(_Req(body, db, actor))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


def _doc_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "doc")


async def new_doc(db, actor="maya", title="Refund runbook"):
    from commonindex.gateway.collections import make_propose

    status, out = await call(db, make_propose(_doc_type()), actor, title=title, freshness="fresh",
                             body={"type": "doc", "content": [{"type": "paragraph"}]})
    assert status == 200, out
    return out["id"]


async def listed(db, actor):
    from commonindex.gateway.collections import make_list

    _, out = await call(db, make_list(_doc_type()), actor)
    return [d["id"] for d in out["docs"]]


async def opened(db, actor, doc_id):
    from commonindex.gateway.collections import make_get

    status, _ = await call(db, make_get(_doc_type()), actor, id=doc_id)
    return status


async def revise(db, actor, doc_id):
    from commonindex.gateway.docs import docs_revise

    status, _ = await call(db, docs_revise, actor, doc_id=doc_id, title="Edited")
    return status


async def test_a_new_item_is_its_creator_s_alone(db):
    from commonindex.gateway.sharing import items_access

    doc = await new_doc(db)
    assert doc in await listed(db, "maya")
    assert doc not in await listed(db, "rhea")
    assert await opened(db, "rhea", doc) == 404       # not "not yours": it does not exist
    _, access = await call(db, items_access, "maya", id=doc)
    assert (access["visibility"], access["you"]) == ("private", "manage")
    assert [(p["id"], p["role"]) for p in access["people"]] == [("maya", "owner")]


async def test_shared_to_view_is_seen_and_not_edited(db):
    from commonindex.gateway.sharing import items_share

    doc = await new_doc(db)
    status, _ = await call(db, items_share, "maya", id=doc, email="RHEA@example.test", role="view")
    assert status == 200
    assert doc in await listed(db, "rhea") and await opened(db, "rhea", doc) == 200
    assert await revise(db, "rhea", doc) == 403
    await call(db, items_share, "maya", id=doc, email="rhea@example.test", role="edit")
    assert await revise(db, "rhea", doc) == 200       # a reader of the workspace, an editor of this


async def test_only_members_and_only_owners(db):
    from commonindex.gateway.sharing import items_share

    doc = await new_doc(db)
    status, out = await call(db, items_share, "maya", id=doc, email="gus@elsewhere.test", role="view")
    assert (status, out["error"]["code"]) == (422, "not_a_member")
    status, out = await call(db, items_share, "maya", id=doc, email="nobody@example.test", role="view")
    assert status == 422
    await call(db, items_share, "maya", id=doc, email="rhea@example.test", role="edit")
    status, out = await call(db, items_share, "rhea", id=doc, email="maya@example.test", role="view")
    assert (status, out["error"]["code"]) == (403, "not_allowed")   # editors do not manage access


async def test_open_to_the_workspace_and_back(db):
    from commonindex.gateway.sharing import items_set_visibility

    doc = await new_doc(db)
    await call(db, items_set_visibility, "maya", id=doc, visibility="workspace")
    assert doc in await listed(db, "rhea")
    assert await revise(db, "rhea", doc) == 403       # Rhea only reads the workspace
    await call(db, items_set_visibility, "maya", id=doc, visibility="private")
    assert doc not in await listed(db, "rhea")
    # Search follows: the chunks carry the item's keys.
    keys = await db.fetchval("select array_agg(distinct k) from chunks, unnest(acl_keys) k where object_id = $1", doc)
    assert keys == ["admins:pay", f"object:{doc}"]


async def test_an_item_keeps_an_owner(db):
    from commonindex.gateway.sharing import items_share, items_unshare

    doc = await new_doc(db)
    status, out = await call(db, items_unshare, "maya", id=doc, person_id="maya")
    assert (status, out["error"]["code"]) == (409, "last_owner")
    await call(db, items_share, "maya", id=doc, email="rhea@example.test", role="view")
    status, out = await call(db, items_unshare, "maya", id=doc, email="rhea@example.test")
    assert status == 200 and [p["id"] for p in out["people"]] == ["maya"]
    assert doc not in await listed(db, "rhea")


async def test_the_conversation_follows_the_item(db):
    from commonindex.gateway.messages import messages_list, messages_post

    doc = await new_doc(db)
    status, _ = await call(db, messages_post, "rhea", subject_id=doc, body="what is this?")
    assert status == 404
    status, _ = await call(db, messages_list, "rhea", subject_id=doc)
    assert status == 404
    status, _ = await call(db, messages_list, "maya", subject_id=doc)
    assert status == 200


async def test_everyone_in_the_workspace_can_view_or_edit(db):
    from commonindex.gateway.sharing import items_access, items_set_visibility

    doc = await new_doc(db)
    await call(db, items_set_visibility, "maya", id=doc, visibility="workspace", role="view")
    assert doc in await listed(db, "rhea") and await revise(db, "rhea", doc) == 403
    await call(db, items_set_visibility, "maya", id=doc, visibility="workspace", role="edit")
    assert await revise(db, "rhea", doc) == 200       # a reader of the workspace edits this one
    _, access = await call(db, items_access, "rhea", id=doc)
    assert (access["general"], access["you"]) == ("edit", "edit")


async def test_what_an_agent_makes_is_the_workspace_s(db):
    # An agent cannot share, so an item private to one would be seen by no one.
    from commonindex.gateway.sharing import items_access

    doc = await new_doc(db, actor="scribe", title="Nightly digest")
    assert doc in await listed(db, "rhea") and doc in await listed(db, "maya")
    _, access = await call(db, items_access, "maya", id=doc)
    assert (access["visibility"], access["general"]) == ("workspace", "role")


async def test_taking_away_nobody_s_access_says_so(db):
    from commonindex.gateway.sharing import items_unshare

    doc = await new_doc(db)
    status, out = await call(db, items_unshare, "maya", id=doc, email="nobody@example.test")
    assert (status, out["error"]["code"]) == (404, "unknown_person")


async def test_an_id_from_another_workspace_is_not_taken_over(db):
    # Ids are global: proposing one that growth holds must not make it pay's
    # caller's private item.
    from commonindex.gateway.collections import make_propose

    await db.execute("insert into objects (id, space_id, type, title, created_by, acl_keys)"
                     " values ('doc-g', 'growth', 'doc', 'Growth plan', 'maya', '{space:growth}')")
    status, out = await call(db, make_propose(_doc_type()), "rhea", id="doc-g", title="Mine now",
                             freshness="fresh", body={"type": "doc", "content": [{"type": "paragraph"}]})
    assert (status, out["error"]["code"]) == (409, "id_taken")
    assert await db.fetchval("select acl_keys from objects where id = 'doc-g'") == ["space:growth", "admins:growth"]
    assert not await db.fetchval("select count(*) from grants where resource = 'object:doc-g'")


async def test_whoever_narrows_an_ownerless_item_owns_it(db):
    # An item from before owners, managed through the workspace role: made
    # private, it was seen by no one — not even the admin who did it.
    from commonindex.gateway.sharing import items_access, items_set_visibility

    await db.execute("update grants set relation = 'admin' where id = 'g-maya';"
                     " insert into objects (id, space_id, type, title, created_by, acl_keys)"
                     " values ('doc-old', 'pay', 'doc', 'Old notes', 'maya', '{space:pay}')")
    status, _ = await call(db, items_set_visibility, "maya", id="doc-old", visibility="private")
    assert status == 200
    _, access = await call(db, items_access, "maya", id="doc-old")
    assert (access["visibility"], access["you"]) == ("private", "manage")


async def test_a_reviewer_still_deletes_a_dashboard_governed_by_roles(db):
    from commonindex.gateway.sharing import item, may_delete

    await db.execute("update grants set relation = 'merge' where id = 'g-maya';"
                     " insert into objects (id, space_id, type, title, created_by, acl_keys)"
                     " values ('dash-old', 'pay', 'dashboard', 'Old', 'maya', '{space:pay}')")
    row = await item(db, "dash-old", "pay")
    assert await may_delete(db, "maya", "pay", row)
    assert not await may_delete(db, "rhea", "pay", row)


async def test_no_word_of_a_private_item_reaches_someone_who_cannot_see_it(db):
    # Mentioned on a doc they cannot open, they are not told what was said.
    from commonindex.gateway.designs import designs_references
    from commonindex.gateway.messages import messages_mentions, messages_notifications

    doc = await new_doc(db)
    await db.execute("insert into messages (id, space_id, subject_id, author_id, body, mentions)"
                     " values ('m-1', 'pay', $1, 'maya', 'rhea, the refund numbers are wrong', '{rhea}')", doc)
    _, out = await call(db, messages_mentions, "rhea")
    assert out["mentions"] == []
    _, out = await call(db, messages_notifications, "rhea")
    assert (out["notifications"], out["unread"]) == ([], 0)

    await db.execute("insert into objects (id, space_id, type, title, props, created_by, acl_keys)"
                     " values ('des-1', 'pay', 'design', 'Refund screen', $1::jsonb, 'maya', '{space:pay}')",
                     json.dumps({"sources": [doc]}))
    _, out = await call(db, designs_references, "rhea", design_id="des-1")
    assert out["references"][0]["unresolved"] and out["references"][0]["title"] is None


async def test_a_task_never_names_a_private_item_it_links_to(db):
    # Tasks are the workspace's; what one came from may not be. Its title was
    # on every task card and panel, for everyone on the board.
    from commonindex.gateway.tasks import (
        tasks_get,
        tasks_link,
        tasks_linked,
        tasks_list,
        tasks_propose,
    )

    doc = await new_doc(db, title="Layoff plan")
    _, made = await call(db, tasks_propose, title="Update the plan")
    task = made["task"]["id"]
    assert (await call(db, tasks_link, task_id=task, object_id=doc, rel="caused"))[0] == 200

    _, mine = await call(db, tasks_get, "maya", task_id=task)
    assert mine["task"]["links"][0]["object"]["title"] == "Layoff plan"

    _, theirs = await call(db, tasks_get, "rhea", task_id=task)
    seen = theirs["task"]["links"][0]["object"]
    assert seen == {"id": doc, "type": "doc", "key": None, "title": None, "available": False}
    _, board = await call(db, tasks_list, "rhea")
    assert "Layoff plan" not in json.dumps(board)
    status, _ = await call(db, tasks_linked, "rhea", object_id=doc)
    assert status == 404
    assert (await call(db, tasks_linked, "maya", object_id=doc))[1]["total"] == 1


async def test_a_private_dashboard_s_panels_and_metrics_go_with_it(db):
    # A panel's title is its metric's name: a private dashboard's are its own.
    from commonindex.gateway.sharing import follow, hidden_metrics

    await db.execute("""
        insert into connections (id, space_id, name, kind, created_by) values ('c1', 'pay', 'wh', 'postgres', 'maya');
        insert into datasets (id, space_id, connection_id, name, physical, created_by)
          values ('ds1', 'pay', 'c1', 'refunds', 'public.refunds', 'maya');
        insert into objects (id, space_id, type, title, created_by, acl_keys) values
          ('dash-p', 'pay', 'dashboard', 'Secret', 'maya', '{object:dash-p}'),
          ('dash-o', 'pay', 'dashboard', 'Open', 'maya', '{space:pay}'),
          ('dash-p-p0', 'pay', 'panel', 'Layoff count', 'maya', '{space:pay}'),
          ('dash-o-p0', 'pay', 'panel', 'Refund rate', 'maya', '{space:pay}');
        insert into metrics (id, version, space_id, dataset_id, label, expr, created_by) values
          ('dash-p.layoffs', 1, 'pay', 'ds1', 'Layoff count', 'count(*)', 'maya'),
          ('dash-o.rate', 1, 'pay', 'ds1', 'Refund rate', 'avg(x)', 'maya');
        insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id, metric_version) values
          ('dash-p-p0', 'dash-p', 'ds1', 'dash-p.layoffs', 1),
          ('dash-o-p0', 'dash-o', 'ds1', 'dash-o.rate', 1);
    """)
    await follow(db, "dash-p")
    assert await db.fetchval("select acl_keys from objects where id = 'dash-p-p0'") == ["object:dash-p", "admins:pay"]
    assert await hidden_metrics(db, "pay", ["space:pay"]) == {"dash-p.layoffs"}
    assert await hidden_metrics(db, "pay", ["space:pay", "object:dash-p"]) == set()


# ── the workspace's admin ────────────────────────────────────────────────


async def _admin(db, actor="ana"):
    await db.execute("insert into actors (id, kind, display, email) values ($1, 'human', 'Ana', 'ana@example.test')",
                     actor)
    await db.execute("insert into grants (id, subject, relation, resource, granted_by)"
                     " values ('g-' || $1, $1, 'admin', 'space:pay', $1)", actor)


async def test_the_admin_manages_a_members_private_item(db):
    from commonindex.gateway.sharing import items_access, items_set_visibility, items_share

    await _admin(db)
    doc = await new_doc(db)                               # Maya's, private
    assert doc not in await listed(db, "rhea")            # a member still does not see it
    assert doc in await listed(db, "ana")                 # the admin does
    _, access = await call(db, items_access, "ana", id=doc)
    assert access["you"] == "manage"
    status, _ = await call(db, items_set_visibility, "ana", id=doc, visibility="workspace")
    assert status == 200 and doc in await listed(db, "rhea")
    status, _ = await call(db, items_share, "ana", id=doc, email="gus@elsewhere.test", role="view")
    assert status != 403


async def test_a_removed_members_private_items_are_still_the_admins(db):
    # Before, removing a member left their private items reachable by nobody.
    from commonindex.gateway.sharing import items_access

    await _admin(db)
    doc = await new_doc(db)
    await db.execute("delete from grants where subject = 'maya'")
    _, access = await call(db, items_access, "ana", id=doc)
    assert access["you"] == "manage"


async def test_only_an_admin_holds_the_admin_key(db):
    from commonindex.core.authz.store import PgChecker

    await _admin(db)
    assert "admins:pay" in await PgChecker(db).acl_keys_for("ana")
    assert "admins:pay" not in await PgChecker(db).acl_keys_for("maya")
    assert "admins:pay" not in await PgChecker(db).acl_keys_for("rhea")
