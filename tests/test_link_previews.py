"""Viewer-specific link cards: metadata only, never a public/stored unfurl."""

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from commonindex.gateway.auth import SpaceMismatch
from commonindex.gateway.link_previews import _card, _document_blocks, items_previews


class Pool:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


class Req:
    def __init__(self, items, conn=None, actor="maya", checker=None):
        self.payload = {"items": items}
        self.state = SimpleNamespace(space="pay", principal=SimpleNamespace(actor_id=actor))
        self.app = SimpleNamespace(state=SimpleNamespace(commonindex={"pool": Pool(conn)}))
        if checker is not None:
            self.app.state.commonindex["checker"] = checker

    async def json(self):
        return self.payload


def row(kind, props):
    return {"id": "item", "type": kind, "key": "KEY-1", "title": "An item", "props": props}


@pytest.mark.parametrize("items", [None, {}, [], ["doc"], [{"id": "d", "type": []}],
    [{"id": "d", "type": "unsupported"}], [{"id": " ", "type": "doc"}],
    [{"id": "a" * 201, "type": "doc"}], [{"id": "d", "type": "doc"}] * 25])
async def test_invalid_references_never_reach_storage(items):
    assert (await items_previews(Req(items))).status_code == 422


async def test_invalid_body_and_foreign_workspace():
    req = Req([])
    req.payload = []
    assert (await items_previews(req)).status_code == 422
    req.payload = {"items": [{"id": "d", "type": "doc"}], "space_id": "foreign"}
    with pytest.raises(SpaceMismatch):
        await items_previews(req)


def test_previews_have_bounded_allowlisted_fields_never_source_or_secrets():
    for kind, props in [
        ("doc", {"body": {"type": "doc", "content": [{"type": "text", "text": "x" * 500}]}}),
        ("experiment", {"hypothesis": "Hypothesis", "status": "running"}),
        ("design", {"description": "Layout", "surface": "web", "screen_count": 2}),
        ("video", {"brief": "Launch", "format": "landscape", "state": "ready"}),
        ("artifact", {"description": "Demo"}), ("task", {"detail": "Work", "state": "review"}),
        ("channel", {"topic": "Team updates", "archived": True}),
        ("code_file", {"path": "src/main.py", "language": "python"}),
    ]:
        props.update({"html": "SECRET", "composition": "SECRET", "sql": "SECRET", "token": "SECRET"})
        card = _card(row(kind, props))
        assert card["available"] is True
        assert len(card["summary"]) <= 240
        assert "SECRET" not in json.dumps(card)
    design = _card(row("design", {"screen_count": 2, "surface": "web"}))
    assert design["detail"] == "2 screens · web"
    dashboard = _card(row("dashboard", {"panel_count": 999, "certified": True}), panels=3)
    assert dashboard["detail"] == "3 panels"
    assert not dashboard["status"]  # No fabricated certification.


async def test_batched_read_is_acl_scoped_deduplicated_and_wrong_type_is_unavailable():
    conn = SimpleNamespace(fetch=AsyncMock(return_value=[row("doc", {"body": {}})]))
    checker = SimpleNamespace(acl_keys_for=AsyncMock(return_value=["space:pay"]))
    refs = [{"type": "doc", "id": "item"}, {"type": "video", "id": "item"},
            {"type": "doc", "id": "missing"}, {"type": "doc", "id": "item"}]
    out = await items_previews(Req(refs, conn, checker=checker))
    assert len(out["items"]) == 3
    assert out["items"][0]["available"] is True
    assert out["items"][1:] == [{"type": "video", "id": "item", "available": False},
                               {"type": "doc", "id": "missing", "available": False}]
    sql, space, ids, keys = conn.fetch.call_args.args
    assert space == "pay" and keys == ["space:pay"]
    assert set(ids) == {"item", "missing"}
    assert "deleted_at is null" in sql and "acl_keys &&" in sql and "space_id = $1" in sql
    checker.acl_keys_for.assert_awaited_once_with("maya")


def test_document_background_uses_actual_blocks_without_active_html_or_image_urls():
    def block(kind, text):
        return {"type": kind, "content": [{"type": "text", "text": text}]}
    body = {"type": "doc", "content": [
        block("heading", "Launch plan"), block("paragraph", "Ship the workspace in October."),
        {"type": "bulletList", "content": [block("listItem", "Invite the pilot team")]},
        {"type": "table", "content": [{"type": "tableRow", "content": [
            block("tableHeader", "Owner"), block("tableCell", "Maya")]}]},
        block("blockquote", "Keep the launch small"), block("codeBlock", "SELECT 1"),
        {"type": "horizontalRule"},
        {"type": "image", "attrs": {"src": "https://private.test/secret", "alt": "Launch screenshot", "onerror": "SECRET"}},
    ]}
    assert _document_blocks(body) == [
        {"kind": "heading", "text": "Launch plan"},
        {"kind": "paragraph", "text": "Ship the workspace in October."},
        {"kind": "list", "ordered": False, "items": ["Invite the pilot team"]},
        {"kind": "table", "rows": [["Owner", "Maya"]]},
        {"kind": "quote", "text": "Keep the launch small"},
        {"kind": "code", "text": "SELECT 1"}, {"kind": "divider"},
        {"kind": "notice", "text": "Launch screenshot"},
    ]
    assert "private.test" not in json.dumps(_card(row("doc", {"body": body})))


def test_document_background_limits_size_and_handles_malformed_nodes():
    assert _document_blocks(None) == []
    assert _document_blocks({"type": [], "content": "not a list"}) == []
    assert _document_blocks({"type": "embed", "attrs": []}) == [{"kind": "notice", "text": "Embedded content"}]
    body = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "x" * 10000}]}] * 200}
    blocks = _document_blocks(body)
    assert len(blocks) <= 12
    assert sum(len(b["text"]) for b in blocks) <= 4800
    assert all(len(b["text"]) <= 480 for b in blocks)
    assert _document_blocks({"type": "taskList", "content": [
        {"type": "taskItem", "attrs": {"checked": True}, "content": [{"type": "text", "text": "Done"}]}]
    }) == [{"kind": "list", "ordered": False, "items": ["☑ Done"]}]


@pytest.mark.parametrize("snapshot", [None, {"id": "embedded", "status": "queued", "version": "v1"},
    {"id": "embedded", "status": "ready", "version": "v1"}])
async def test_embedded_preview_requires_independent_authorization_and_ready_snapshot(snapshot):
    conn = SimpleNamespace(fetch=AsyncMock(side_effect=[
        [row("doc", {"body": {"type": "doc", "content": [{"type": "embed", "attrs": {"ref": "embedded"}}]}})],
        [snapshot] if snapshot else [],
    ]))
    checker = SimpleNamespace(acl_keys_for=AsyncMock(return_value=["space:pay"]))
    out = await items_previews(Req([{"id": "item", "type": "doc"}], conn, checker=checker))
    blocks = out["items"][0]["document"]["blocks"]
    assert blocks == ([{"kind": "snapshot", "artifact_id": "embedded", "version": "v1"}]
                      if snapshot and snapshot["status"] == "ready"
                      else [{"kind": "notice", "text": "Embedded preview unavailable"}])
    sql, ids, space, keys = conn.fetch.call_args.args
    assert ids == ["embedded"] and space == "pay" and keys == ["space:pay"]
    assert "type = 'artifact'" in sql and "acl_keys &&" in sql and "deleted_at is null" in sql


@pytest.mark.integration
async def test_real_postgres_acl_isolation_revocation_expiry_and_panel_counts():
    """Connection-local temporary tables, no reset/migration of any user database."""
    import asyncpg
    from db import DSN

    try:
        conn = await asyncpg.connect(DSN)
    except (OSError, asyncpg.PostgresError) as exc:
        pytest.skip(f"Test Postgres unavailable: {type(exc).__name__}")
    try:
        await conn.execute("""
            create temporary table objects (id text, type text, space_id text, key text,
              title text, props jsonb default '{}', acl_keys text[], deleted_at timestamptz);
            create temporary table grants (subject text, resource text, expires_at timestamptz,
                                          relation text default 'read');
            create temporary table panel_bindings (dashboard_id text, panel_id text);
            create temporary table actors (id text, kind text, display text);
            insert into grants values ('maya', 'space:pay', null), ('reader', 'space:pay', null),
              ('maya', 'object:private', null), ('maya', 'object:foreign', null),
              ('reader', 'object:expired', now() - interval '1 second');
            insert into objects (id, type, space_id, key, title, props, acl_keys) values
              ('public', 'doc', 'pay', 'D-1', 'Public doc', '{"body":{"type":"paragraph","content":[{"type":"text","text":"Public content"}]}}', '{space:pay}'),
              ('private', 'doc', 'pay', 'D-2', 'Private doc', '{"body":{"text":"SECRET"}}', '{object:private}'),
              ('foreign', 'doc', 'other', 'D-3', 'Foreign doc', '{}', '{object:foreign}'),
              ('expired', 'doc', 'pay', 'D-4', 'Expired doc', '{}', '{object:expired}'),
              ('removed', 'doc', 'pay', 'D-5', 'Removed doc', '{}', '{space:pay}'),
              ('dashboard', 'dashboard', 'pay', 'DA-1', 'Team dashboard', '{"panel_count":99}', '{space:pay}'),
              ('panel', 'panel', 'pay', 'P-1', 'Team panel', '{}', '{space:pay}');
            update objects set deleted_at = now() where id = 'removed';
            insert into panel_bindings values ('dashboard', 'panel');
            insert into actors values ('worker', 'agent', 'Worker'), ('foreign-worker', 'agent', 'Foreign worker');
            insert into grants values ('worker', 'space:pay', null), ('foreign-worker', 'space:other', null);
        """)
        refs = [{"id": i, "type": "doc"} for i in ["public", "private", "foreign", "expired", "removed", "missing"]]
        out = (await items_previews(Req(refs, conn, actor="reader")))["items"]
        assert out[0]["summary"] == "Public content"
        assert out[0]["document"]["blocks"] == [{"kind": "paragraph", "text": "Public content"}]
        assert all(item == {**refs[i], "available": False} for i, item in enumerate(out) if i)
        assert "SECRET" not in json.dumps(out)
        owner = (await items_previews(Req(refs, conn)))["items"]
        assert owner[1]["summary"] == "SECRET"
        assert owner[2]["available"] is False  # Foreign even with an explicit object grant.
        await conn.execute("insert into grants values ('reader', 'object:private', null)")
        assert (await items_previews(Req(refs, conn, actor="reader")))["items"][1]["available"]
        await conn.execute("delete from grants where subject = 'reader' and resource = 'object:private'")
        assert not (await items_previews(Req(refs, conn, actor="reader")))["items"][1]["available"]
        more = [{"id": "dashboard", "type": "dashboard"}, {"id": "worker", "type": "agent"},
                {"id": "foreign-worker", "type": "agent"}, {"id": "skill-warehouse-context", "type": "skill"}]
        cards = (await items_previews(Req(more, conn)))["items"]
        assert cards[0]["detail"] == "1 panel"
        assert cards[1]["title"] == "Worker"
        assert cards[2] == {**more[2], "available": False}
        assert cards[3]["available"]
        # Sharing a doc must not implicitly share the embedded artifact image.
        await conn.execute("""
            insert into objects (id, type, space_id, key, title, props, acl_keys) values
              ('embed-doc', 'doc', 'pay', 'D-6', 'Page doc', '{"body":{"type":"embed","attrs":{"ref":"private-page"}}}', '{space:pay}'),
              ('private-page', 'artifact', 'pay', 'A-1', 'SECRET PAGE', '{"snapshot":{"status":"ready","job":"v1"},"html":"SECRET HTML"}', '{object:private-page}');
        """)
        embedded_ref = [{"id": "embed-doc", "type": "doc"}]
        hidden = [{"kind": "notice", "text": "Embedded preview unavailable"}]

        async def embedded_preview():
            return (await items_previews(Req(embedded_ref, conn, actor="reader")))["items"][0]["document"]["blocks"]

        assert await embedded_preview() == hidden
        await conn.execute("insert into grants values ('reader', 'object:private-page', null)")
        assert await embedded_preview() == [{"kind": "snapshot", "artifact_id": "private-page", "version": "v1"}]
        await conn.execute("update objects set space_id = 'other' where id = 'private-page'")
        assert await embedded_preview() == hidden
        await conn.execute("update objects set space_id = 'pay', deleted_at = now() where id = 'private-page'")
        assert await embedded_preview() == hidden
        await conn.execute("update objects set deleted_at = null where id = 'private-page'")
        await conn.execute("delete from grants where subject = 'reader' and resource = 'object:private-page'")
        assert await embedded_preview() == hidden
    finally:
        # Closing the connection drops only the temporary tables created above.
        await conn.close()
