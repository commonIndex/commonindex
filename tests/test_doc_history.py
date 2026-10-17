"""A doc's history holds what it was created as.

A doc made by propose — an agent over MCP, an import — has no revision of its
own. Defended: the first change keeps the original, once, so History can bring
it back (turning a doc into a full page replaces its body, and says so).
"""

from __future__ import annotations

import json

import pytest
from test_sharing import _doc_type, _PoolOf, _Req, call, db  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


def _para(text):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


async def test_the_first_change_keeps_what_the_doc_was_created_as(db):  # noqa: F811
    from commonindex.gateway.collections import make_propose
    from commonindex.gateway.docs import docs_revise

    _, made = await call(db, make_propose(_doc_type()), "maya", title="Q4 launch", freshness="fresh",
                         body=_para("Notes for the Q4 launch."))
    doc = made["id"]
    assert await db.fetchval("select count(*) from revisions where object_id = $1", doc) == 0

    status, out = await call(db, docs_revise, "maya", doc_id=doc, if_rev=1, note="made a full page",
                             body={"type": "doc", "content": [{"type": "embed", "attrs": {"ref": "artifact-1"}}]})
    assert (status, out["rev"]) == (200, 2)
    rows = await db.fetch("select rev, author_id, delta from revisions where object_id = $1 order by rev", doc)
    first = json.loads(rows[0]["delta"])
    assert [r["rev"] for r in rows] == [1, 2]
    assert (rows[0]["author_id"], first["note"]) == ("maya", "as created")
    assert "Notes for the Q4 launch." in json.dumps(first["props"]["body"])          # it can be restored

    await call(db, docs_revise, "maya", doc_id=doc, if_rev=2, body=_para("again"))
    revs = [r["rev"] for r in await db.fetch("select rev from revisions where object_id = $1 order by rev", doc)]
    assert revs == [1, 2, 3]                                                          # kept once, not every time


async def test_a_doc_made_by_propose_has_the_excerpt_its_card_shows(db):  # noqa: F811
    # Revise derived it and propose never did: every doc an agent wrote read
    # "Empty — open it to start writing." in the list.
    from commonindex.gateway.docs import docs_propose

    _, made = await call(db, docs_propose, "maya", title="Refund runbook", freshness="fresh",
                         body=_para("Refunds under 100 are approved automatically."))
    got = await db.fetchval("select props->>'excerpt' from objects where id = $1", made["id"])
    assert got == "Refunds under 100 are approved automatically."


async def test_the_list_says_which_revision_each_doc_is_at(db):  # noqa: F811
    # The list query never selected current_rev, so every card read "rev 1" —
    # a doc revised four times included.
    from commonindex.gateway.collections import make_list, make_propose
    from commonindex.gateway.docs import docs_revise

    _, made = await call(db, make_propose(_doc_type()), "maya", title="Weekly review", freshness="fresh",
                         body=_para("first"))
    await call(db, docs_revise, "maya", doc_id=made["id"], if_rev=1, body=_para("second"))
    _, listed = await call(db, make_list(_doc_type()), "maya")
    row = next(d for d in listed["docs"] if d["id"] == made["id"])
    assert row["current_rev"] == 2
