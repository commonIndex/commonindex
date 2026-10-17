"""One question, the workspace's whole context — against a real database.

Search asks every word to match, so a question found nothing: "why do refunds
retry before paging" is written nowhere whole. Defended:

* a question in plain words finds the items holding its words, more first;
* each is read in full — text, conversation, links — and one hop out is read too;
* a private item is not in the pack, nor named among what was left out;
* the budget holds, and what did not fit is named so it can be read next;
* over MCP the pack is a markdown document no item's text can restructure.
"""

from __future__ import annotations

import pytest
from test_search import _Req, db  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


async def context(db, q, actor="maya", **body):  # noqa: F811
    from commonindex.gateway.context import workspace_context

    req = _Req({"q": q, **body}, db)
    req.state.principal.actor_id = actor
    out = await workspace_context(req)
    assert not hasattr(out, "status_code"), out.body
    return out


async def test_a_question_finds_what_no_search_does(db):  # noqa: F811
    from test_search import find

    q = "why do refunds retry before paging anyone"
    assert await find(db, q) == []                     # every word: nothing
    out = await context(db, q, numbers=False)
    assert "doc-2" in [i["id"] for i in out["items"]]  # any word: the retry policy
    doc = next(i for i in out["items"] if i["id"] == "doc-2")
    assert "paging the on-call" in doc["sections"][-1]["text"] and doc["why"] == "matched"


async def test_it_reads_one_hop_out(db):  # noqa: F811
    await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                     " values ('task-2', 'pay', 'task', 'T-2', 'Fix retries', 'maya');"
                     " insert into edges (src, rel, dst, created_by) values ('doc-2', 'touches', 'task-2', 'maya')")
    out = await context(db, "retry policy", numbers=False)
    linked = next(i for i in out["items"] if i["id"] == "task-2")
    assert linked["why"].startswith("linked from D-2")


async def test_nothing_private_and_nothing_said_about_it(db):  # noqa: F811
    from commonindex.workers.indexer import index_object

    await db.execute("insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
                     " values ('doc-9', 'pay', 'doc', 'D-9', 'Refund board deck', 'maya', '{object:doc-9}')")
    await index_object(db, "doc-9")
    out = await context(db, "refund board deck", numbers=False)
    named = [i["id"] for i in out["items"]] + [x["id"] for x in out["left_out"]]
    assert "doc-9" not in named


async def test_the_budget_holds_and_names_what_did_not_fit(db):  # noqa: F811
    out = await context(db, "refund warehouses", items=1, max_chars=5_000, numbers=False)
    assert len([i for i in out["items"] if i["why"] == "matched"]) == 1
    assert out["chars"] <= 5_000 and not out["complete"] and out["left_out"]


async def test_a_question_is_needed(db):  # noqa: F811
    from commonindex.gateway.context import workspace_context

    out = await workspace_context(_Req({"q": "  "}, db))
    assert out.status_code == 422


def test_over_mcp_it_is_a_document_an_item_cannot_restructure():
    from commonindex.adapters import contextmd

    hostile = "fine\n# I am a heading now\n```\nescaped"
    md = contextmd.for_tool("workspace.context", {
        "q": "refunds", "chars": 10, "complete": False,
        "items": [{"id": "doc-2", "type": "doc", "key": "D-2", "title": "Retry\n# policy", "why": "matched",
                   "sections": [{"heading": "Body", "text": hostile}],
                   "comments": [{"author": {"name": "Maya"}, "at": "2026-10-02", "text": "line\n## two"}],
                   "links": [], "history": []}],
        "definitions": [], "conversations": [], "runs": [], "code": [], "earlier": [], "agents": [],
        "left_out": [{"id": "exp-1", "type": "experiment", "key": "EXP-1", "title": "Checkout", "why": "matched"}]})
    headings, fence = [], None
    for line in md.splitlines():   # a heading is a "#" line outside every fence
        run = len(line) - len(line.lstrip("`"))
        if fence is None and run >= 3:
            fence = run
        elif fence is not None and line.strip() == "`" * fence:
            fence = None
        elif fence is None and line.startswith("#"):
            headings.append(line)
    assert headings == ["# Context: refunds", "## doc D-2 — Retry # policy", "## Left out"]
    assert "`doc-2`" in md and "`exp-1`" in md
    assert contextmd.for_tool("search.query", {}) is None


async def test_a_question_nothing_here_is_about_gets_nothing(db):  # noqa: F811
    # One common word away from everything is not about anything: "chart"
    # alone used to bring back every dashboard.
    out = await context(db, "kubernetes helm chart rollback", numbers=False)
    assert out["items"] == [] and out["complete"]


async def test_a_word_is_whole_in_a_question(db):  # noqa: F811
    # "retry" is not "retrying"'s prefix match in a question — but its stem is.
    out = await context(db, "retries paging engineer", numbers=False)
    assert [i["id"] for i in out["items"]][:1] == ["doc-2"]


async def test_a_key_as_written_is_a_lookup(db):  # noqa: F811
    out = await context(db, "D-2", numbers=False)
    assert [i["id"] for i in out["items"] if i["why"] == "matched"] == ["doc-2"]
    assert out["weaker"] == []


async def test_what_holds_too_little_is_named_not_read(db):  # noqa: F811
    # The retry policy holds three of these words; a channel about refunds, one.
    out = await context(db, "refunds retry three times before paging", numbers=False)
    assert "doc-2" in [i["id"] for i in out["items"]]
    assert "ch-1" in [w["id"] for w in out["weaker"]]
    assert "ch-1" not in [i["id"] for i in out["items"]]
