"""A save retried after a timeout is answered, not written twice.

Every save asks for an idempotency key; docs, designs and artifacts asked for
one and then ignored it, so a client retrying a save that had landed wrote a
second revision of the same change. Defended: the same key is the same save —
one revision, and the retry answers with it (not as a stale-revision refusal,
which is what its own first attempt would otherwise make it look like).
"""

from __future__ import annotations

import json

import pytest
from test_sharing import _doc_type, call, db, new_doc  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration


async def _revisions(db, object_id):  # noqa: F811
    return await db.fetchval("select count(*) from revisions where object_id = $1", object_id)


async def test_a_doc_save_retried_with_its_key_writes_once(db):  # noqa: F811
    from commonindex.gateway.docs import docs_revise

    doc = await new_doc(db)
    body = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "v2"}]}]}
    first = await call(db, docs_revise, doc_id=doc, if_rev=1, body=body, idempotencyKey="save-1")
    count = await _revisions(db, doc)
    again = await call(db, docs_revise, doc_id=doc, if_rev=1, body=body, idempotencyKey="save-1")
    assert first[0] == again[0] == 200
    assert again[1]["rev"] == first[1]["rev"] and again[1]["replayed"]
    assert await _revisions(db, doc) == count
    # A different key is a different save.
    other = await call(db, docs_revise, doc_id=doc, body=body, idempotencyKey="save-2")
    assert other[1]["rev"] == first[1]["rev"] + 1


async def test_a_design_save_retried_with_its_key_writes_once(db):  # noqa: F811
    from commonindex.gateway.designs import designs_revise

    await db.execute("insert into objects (id, space_id, type, title, props, created_by, acl_keys)"
                     " values ('des-r', 'pay', 'design', 'Refund screen', $1::jsonb, 'maya', '{space:pay}')",
                     json.dumps({"title": "Refund screen", "surface": "web", "spec": {"screens": []}}))
    first = await call(db, designs_revise, design_id="des-r", title="Refund screen v2", idempotencyKey="d-1")
    again = await call(db, designs_revise, design_id="des-r", title="Refund screen v2", idempotencyKey="d-1")
    assert first[0] == again[0] == 200, (first, again)
    assert again[1]["rev"] == first[1]["rev"] and again[1]["replayed"]
    assert await _revisions(db, "des-r") == 1


async def test_an_artifact_save_retried_with_its_key_writes_once(db):  # noqa: F811
    from commonindex.gateway.artifacts import artifacts_propose, artifacts_save

    _, made = await call(db, artifacts_propose, title="Refund chart", html="<p>one</p>")
    art = made["id"]
    first = await call(db, artifacts_save, artifact_id=art, html="<p>two</p>", idempotencyKey="a-1")
    again = await call(db, artifacts_save, artifact_id=art, html="<p>two</p>", idempotencyKey="a-1")
    assert first[0] == again[0] == 200, (first, again)
    assert again[1]["rev"] == first[1]["rev"] and again[1]["replayed"]
    assert await _revisions(db, art) == 1
