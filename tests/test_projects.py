"""Projects: one tag across every kind of work.

Defended: anything can be put in a project and an item may be in several; a
project gathers tasks, docs and the rest and counts its tasks by state; a
private item in a project is counted for everyone and named only to whom it
is shared with; filing an item into a project takes edit on the item; an
archived project takes nothing new; an update retried with its key writes once.
"""

from __future__ import annotations

import pytest
from test_sharing import _PoolOf, _Req, call, db, new_doc  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


async def new_project(db, title="Legacy billing → new services", **props):  # noqa: F811
    from commonindex.gateway.app import TYPES
    from commonindex.gateway.collections import make_propose

    t = next(t for t in TYPES if t.id == "project")
    status, out = await call(db, make_propose(t), "maya", title=title, color="violet", status="active", **props)
    assert status == 200, out
    return out["id"]


async def new_task(db, title):  # noqa: F811
    from commonindex.gateway.tasks import tasks_propose

    _, out = await call(db, tasks_propose, "maya", title=title)
    return out["task"]


async def test_a_project_gathers_tasks_and_docs_and_counts_its_tasks(db):  # noqa: F811
    from commonindex.gateway.projects import (
        projects_items,
        projects_list,
        projects_of,
        projects_tag,
    )
    from commonindex.gateway.tasks import tasks_start

    proj = await new_project(db)
    other = await new_project(db, title="Q4 reliability")
    a, b = await new_task(db, "Move invoices off the monolith"), await new_task(db, "Move refunds off the monolith")
    doc = await new_doc(db, title="Cut-over plan")
    for oid in (a["id"], b["id"], doc):
        assert (await call(db, projects_tag, project_id=proj, object_id=oid))[0] == 200
    again = await call(db, projects_tag, project_id=proj, object_id=a["id"])
    assert again[1]["already"] is True                                         # tagging twice is a no-op
    await call(db, projects_tag, project_id=other, object_id=a["id"])          # one item, two projects
    await call(db, tasks_start, "maya", task_id=b["id"])

    _, out = await call(db, projects_items, project_id=proj)
    assert sorted(out["items"]) == ["doc", "task"]
    assert {t["title"] for t in out["items"]["task"]} == {a["title"], b["title"]}
    assert (out["tasks"]["ready"], out["tasks"]["flight"], out["tasks"]["total"]) == (1, 1, 2)
    _, listed = await call(db, projects_list)
    mine = next(p for p in listed["projects"] if p["id"] == proj)
    assert (mine["items"], mine["tasks"]) == (3, {"total": 2, "done": 0})
    assert mine["kinds"] == {"task": 2, "doc": 1}
    assert {x["title"] for x in mine["recent"]} <= {a["title"], b["title"], "Cut-over plan"} and len(mine["recent"]) == 3
    _, of = await call(db, projects_of, object_ids=[a["id"], doc])
    assert {p["title"] for p in of["projects"][a["id"]]} == {"Legacy billing → new services", "Q4 reliability"}
    assert [p["id"] for p in of["projects"][doc]] == [proj]


async def test_a_private_item_in_a_project_is_counted_not_named(db):  # noqa: F811
    from commonindex.gateway.projects import (
        projects_items,
        projects_list,
        projects_of,
        projects_tag,
    )

    proj = await new_project(db)
    doc = await new_doc(db, title="Layoff plan")                               # maya's, private
    await call(db, projects_tag, project_id=proj, object_id=doc)
    _, theirs = await call(db, projects_items, "rhea", project_id=proj)
    assert theirs["items"] == {} and theirs["hidden"] == 1
    _, listed = await call(db, projects_list, "rhea")
    card = next(p for p in listed["projects"] if p["id"] == proj)
    assert card["kinds"] == {"doc": 1} and card["recent"] == []                 # counted, not named
    _, of = await call(db, projects_of, "rhea", object_ids=[doc])
    assert of["projects"][doc] == []


async def test_filing_an_item_into_a_project_takes_edit_on_it(db):  # noqa: F811
    from commonindex.gateway.projects import projects_tag, projects_untag

    proj = await new_project(db)
    doc = await new_doc(db)
    status, _ = await call(db, projects_tag, "rhea", project_id=proj, object_id=doc)
    assert status in (403, 404)
    status, out = await call(db, projects_tag, project_id=proj, object_id=await new_project(db, title="X"))
    assert status == 422 and out["error"]["code"] == "project_in_project"
    await call(db, projects_tag, project_id=proj, object_id=doc)
    _, out = await call(db, projects_untag, project_id=proj, object_id=doc)
    assert out["tagged"] is False and out["already"] is False


async def test_an_archived_project_takes_nothing_new_and_an_update_retried_writes_once(db):  # noqa: F811
    from commonindex.gateway.projects import projects_tag, projects_update

    proj = await new_project(db)
    first = await call(db, projects_update, project_id=proj, status="archived", idempotencyKey="arch-1")
    again = await call(db, projects_update, project_id=proj, status="archived", idempotencyKey="arch-1")
    assert first[1]["project"]["status"] == "archived" and again[1]["replayed"]
    assert await db.fetchval("select count(*) from revisions where object_id = $1", proj) == 1
    task = await new_task(db, "Late work")
    status, out = await call(db, projects_tag, project_id=proj, object_id=task["id"])
    assert status == 409 and out["error"]["code"] == "archived"
    status, out = await call(db, projects_update, project_id=proj, title="   ")
    assert status == 422
