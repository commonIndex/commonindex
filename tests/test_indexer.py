"""The search index for everything but code, against a real database.

Search read every item's text on every keystroke. It now reads `chunks`, which
this indexer keeps. What is defended: an item becomes chunks the way its type
says — its own chunk under its title, and a chunk per section of a block tree,
headed "Title › Section" — carrying its permission keys; a save indexes in its
own transaction, so an edit is searchable the moment it commits; a deleted
item leaves the index; code's line-numbered chunks are left alone; and a sweep
catches whatever a save did not index.
"""

from __future__ import annotations

import itertools
import json

import pytest
from db import DSN, reset, seed

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

_KEYS = itertools.count()

DOC = {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "Refunds "},
                                      {"type": "text", "text": "re", "marks": [{"type": "bold"}]},
                                      {"type": "text", "text": "try three times."}]},
    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Retries"}]},
    {"type": "bulletList", "content": [
        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "EU waits 5 minutes"}]}]},
        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "US waits 1 minute"}]}]}]},
]}


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    await conn.execute("""
        insert into grants (id, subject, relation, resource, granted_by) values
          ('g-maya', 'maya', 'admin', 'space:pay', 'maya');
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
    def __init__(self, body, conn, actor="maya"):
        self._body = body
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": actor})(),
                                    "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {
            "commonindex": {"pool": _PoolOf(conn)}})()})()

    async def json(self):
        return self._body

    async def body(self):
        return json.dumps(self._body).encode()


async def call(db, handler, **body):
    body.setdefault("idempotencyKey", f"k-{next(_KEYS)}")
    out = await handler(_Req(body, db))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


async def chunks(db, object_id):
    return [(r["heading"], r["body"], list(r["acl_keys"])) for r in await db.fetch(
        "select heading, body, acl_keys from chunks where object_id = $1 order by ord", object_id)]


async def test_a_doc_is_its_own_chunk_and_one_per_section(db):
    from commonindex.workers.indexer import index_object

    await db.execute("insert into objects (id, space_id, type, key, title, props, created_by)"
                     " values ('doc-2', 'pay', 'doc', 'D-2', 'Refund spec', $1::jsonb, 'maya')",
                     json.dumps({"title": "Refund spec", "body": DOC}))
    assert await index_object(db, "doc-2") == 3
    assert await chunks(db, "doc-2") == [
        ("Refund spec", "D-2", ["space:pay", "admins:pay"]),
        # A word split where its formatting changes is still one word.
        ("Refund spec", "Refunds retry three times.", ["space:pay", "admins:pay"]),
        ("Refund spec › Retries", "EU waits 5 minutes\nUS waits 1 minute", ["space:pay", "admins:pay"]),
    ]


async def test_a_save_indexes_in_its_own_transaction(db):
    from commonindex.gateway import messages, tasks

    _, out = await call(db, tasks.tasks_propose, title="Sync the retry ceiling",
                             detail="Every spec should say 3", criteria=["one number"])
    task = out["task"]
    assert await chunks(db, task["id"]) == [
        ("Sync the retry ceiling", f"{task['key']}\nEvery spec should say 3", ["space:pay", "admins:pay"]),
        ("Sync the retry ceiling › Definition of done", "one number", ["space:pay", "admins:pay"])]
    await call(db, tasks.tasks_revise, task_id=task["id"], if_rev=task["rev"], title="Cap retries at 3")
    assert (await chunks(db, task["id"]))[0][0] == "Cap retries at 3"
    await call(db, tasks.tasks_delete, task_id=task["id"])
    assert await chunks(db, task["id"]) == []

    _, ch = await call(db, messages.channels_propose, name="refund-incidents", topic="as they happen")
    assert (await chunks(db, ch["channel"]["id"]))[0][0] == "refund-incidents"


async def test_a_doc_edit_is_searchable_when_it_commits(db):
    from commonindex.gateway import docs

    await db.execute("insert into objects (id, space_id, type, title, props, created_by)"
                     " values ('doc-5', 'pay', 'doc', 'Untitled', '{}'::jsonb, 'maya')")
    status, out = await call(db, docs.docs_revise, doc_id="doc-5", title="Runbook", body=DOC)
    assert status == 200, out
    assert [h for h, _, _ in await chunks(db, "doc-5")] == ["Runbook", "Runbook", "Runbook › Retries"]


async def test_code_chunks_are_left_to_the_code_worker(db):
    from commonindex.workers.indexer import index_object

    await db.execute("""
        insert into objects (id, space_id, type, title, created_by, acl_keys)
          values ('code_file-x', 'pay', 'code_file', 'app.py', 'maya', '{object:repo-1}');
        insert into chunks (object_id, space_id, object_type, rev, ord, body, acl_keys, start_line, end_line)
          values ('code_file-x', 'pay', 'code_file', 1, 0, 'def post(): pass', '{object:repo-1}', 1, 1);
    """)
    assert await index_object(db, "code_file-x") == 0
    assert await db.fetchval("select start_line from chunks where object_id = 'code_file-x'") == 1


async def test_every_item_carries_a_permission_key(db):
    await db.execute("insert into objects (id, space_id, type, title, created_by)"
                     " values ('dash-1', 'pay', 'dashboard', 'Two warehouses', 'maya')")
    assert await db.fetchval("select acl_keys from objects where id = 'dash-1'") == ["space:pay", "admins:pay"]
    await db.execute("insert into objects (id, space_id, type, title, created_by, acl_keys)"
                     " values ('doc-9', 'pay', 'doc', 'Board deck', 'maya', '{object:doc-9}')")
    # Keys of its own are kept, not widened to the space.
    assert await db.fetchval("select acl_keys from objects where id = 'doc-9'") == ["object:doc-9", "admins:pay"]


async def test_a_sweep_catches_what_a_save_did_not_index(db):
    from commonindex.workers.indexer import sweep

    await db.execute("insert into objects (id, space_id, type, title, created_by)"
                     " values ('dash-1', 'pay', 'dashboard', 'Two warehouses', 'maya')")
    assert await sweep(db) >= 1   # doc-1 from the seed, and this one
    assert await sweep(db) == 0   # nothing left
    # Renamed without indexing — a write path that forgot.
    await db.execute("update objects set title = 'Three warehouses', updated_at = now() + interval '1 second'"
                     " where id = 'dash-1'")
    assert await sweep(db) == 1
    assert (await chunks(db, "dash-1"))[0][0] == "Three warehouses"
    await db.execute("update objects set deleted_at = now() where id = 'dash-1'")
    assert await sweep(db) == 1 and await chunks(db, "dash-1") == []


# ── what a page shows beyond its own fields ──────────────────────────────


def test_every_part_and_path_a_type_names_exists():
    from commonindex.workers.indexer import _types
    from commonindex.workers.parts import PARTS

    named = {p for t in _types().values() for p in t.parts}
    assert named and named <= set(PARTS)
    for t in _types().values():
        fields = t.schema.get("properties") or {}
        for path in t.prose:
            assert path.split(".")[0] in {"title", *fields}, (t.id, path)


async def test_structured_fields_are_sections_of_their_own(db):
    from commonindex.workers.indexer import index_object

    await db.execute("insert into objects (id, space_id, type, key, title, props, created_by)"
                     " values ('task-9', 'pay', 'task', 'T-9', 'Cap retries', $1::jsonb, 'maya')",
                     json.dumps({"title": "Cap retries", "detail": "Three everywhere",
                                 "criteria": [{"text": "Every spec says three", "met": None},
                                              {"text": "The handler agrees", "met": None}],
                                 "review": {"note": "Nine specs edited", "decision": "sent_back",
                                            "decision_note": "The EU runbook still says five"}}))
    await index_object(db, "task-9")
    assert await chunks(db, "task-9") == [
        ("Cap retries", "T-9\nThree everywhere", ["space:pay", "admins:pay"]),
        ("Cap retries › Definition of done", "Every spec says three\nThe handler agrees", ["space:pay", "admins:pay"]),
        ("Cap retries › Review", "Nine specs edited\nThe EU runbook still says five", ["space:pay", "admins:pay"]),
    ]


async def test_a_design_is_found_by_the_words_on_its_screens(db):
    from commonindex.workers.indexer import index_object

    spec = {"screens": [{"id": "s1", "name": "Payment", "elements": [
        {"id": "e1", "role": "title", "text": "Review your order"},
        {"id": "e2", "role": "group", "children": [{"id": "e3", "role": "button", "text": "Pay now"}]},
        {"id": "e4", "role": "button", "text": "Pay now"}]}]}
    await db.execute("insert into objects (id, space_id, type, key, title, props, created_by)"
                     " values ('des-1', 'pay', 'design', 'DES-1', 'Checkout redesign', $1::jsonb, 'maya')",
                     json.dumps({"title": "Checkout redesign", "description": "The last step before paying",
                                 "spec": spec}))
    await index_object(db, "des-1")
    assert [(h, b) for h, b, _ in await chunks(db, "des-1")] == [
        ("Checkout redesign", "DES-1\nThe last step before paying"),
        # Every screen's words, at any depth, and a repeated label once.
        ("Checkout redesign › Screens", "Payment\nReview your order\nPay now"),
    ]


WAREHOUSE = """
    insert into connections (id, space_id, name, kind, created_by) values ('conn-1', 'pay', 'warehouse', 'postgres', 'maya');
    insert into datasets (id, space_id, connection_id, name, physical, created_by, description)
      values ('public.orders', 'pay', 'conn-1', 'public.orders', 'public.orders', 'maya', 'One row per order');
    insert into objects (id, space_id, type, title, props, created_by) values
      ('dec-m', 'pay', 'decision', 'Define Refund rate', '{"why": "authored by a person", "metric_id": "refund_rate"}', 'maya'),
      ('dec-d', 'pay', 'decision', 'Create Refunds', '{"why": "authored by a person", "dashboard_id": "dash-2"}', 'maya'),
      ('dash-2', 'pay', 'dashboard', 'Refunds', '{}', 'maya'),
      ('dash-2-p0', 'pay', 'panel', 'Refund rate', '{}', 'maya');
    insert into metrics (id, version, space_id, dataset_id, label, expr, unit, status, ratified_by, created_by, description)
      values ('refund_rate', 1, 'pay', 'public.orders', 'Refund rate', 'avg(refunded)', '%', 'ratified', 'dec-m', 'maya',
              'Share of orders refunded within 30 days'),
             ('conversion', 1, 'pay', 'public.orders', 'Checkout conversion', 'avg(converted)', '%', 'ratified', null, 'maya', '');
    insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id, metric_version, dimensions, position, mark, title)
      values ('dash-2-p0', 'dash-2', 'public.orders', 'refund_rate', 1, '{region}', 0, 'line', 'Refund rate');
"""


async def test_a_dashboard_is_indexed_with_its_panels(db):
    from commonindex.workers.indexer import index_object

    await db.execute(WAREHOUSE)
    await index_object(db, "dash-2")
    said = {h: b for h, b, _ in await chunks(db, "dash-2")}
    assert list(said) == ["Refunds", "Refunds › Panel: Refund rate", "Refunds › Decisions"]
    assert said["Refunds › Panel: Refund rate"] == (
        "A line chart of Refund rate (%) by region, per day. Share of orders refunded within 30 days"
        " Defined as avg(refunded) on public.orders. Ratified: authored by a person.")
    assert said["Refunds › Decisions"].startswith("Create Refunds: authored by a person — maya, ")


async def test_a_definition_change_reindexes_what_charts_it(db):
    from commonindex.workers.indexer import index_object, index_users_of

    await db.execute(WAREHOUSE)
    await index_object(db, "dash-2")
    await db.execute("update metrics set description = 'Refunded within 14 days' where id = 'refund_rate'")
    assert await index_users_of(db, "refund_rate") == 1
    said = {h: b for h, b, _ in await chunks(db, "dash-2")}
    assert "Refunded within 14 days" in said["Refunds › Panel: Refund rate"]


async def test_an_experiment_is_indexed_with_its_registration_readouts_and_decisions(db):
    from commonindex.workers.indexer import index_object

    await db.execute(WAREHOUSE)
    contract = {"metric_id": "conversion", "outcome": "converted", "unit": "user_id",
                "weights": {"control": 0.5, "variant": 0.5}, "planned_days": 14, "mde": 0.02, "alpha": 0.05,
                "guardrails": [{"metric_id": "refund_rate", "outcome": "refunded"}],
                "registered_by": "maya", "registered_at": "2026-08-27T09:00:00+00:00"}
    readout = {"results": [{"metric_label": "Checkout conversion", "outcome": "converted", "role": "target",
                            "binary": True,
                            "arms": [{"name": "control", "n": 4000, "mean": 0.0975},
                                     {"name": "variant", "n": 4000, "mean": 0.1295}],
                            "comparisons": [{"variation": "variant", "baseline": "control", "lift": 0.3316,
                                             "lift_ci": [0.0749, 0.5883], "verdict": "better"}]}],
               "srm": {"ran": True, "passed": True}, "recorded_by": "maya"}
    await db.execute(
        "insert into objects (id, space_id, type, key, title, props, created_by) values"
        " ('exp-2', 'pay', 'experiment', 'EXP-2', 'Trust badge', $1::jsonb, 'maya'),"
        " ('ro-1', 'pay', 'readout', 'RO-1', 'Trust badge — 2026-08-31 13:40', $2::jsonb, 'maya'),"
        " ('dec-2', 'pay', 'decision', null, 'Ship Trust badge', $3::jsonb, 'maya')",
        json.dumps({"name": "Trust badge", "hypothesis": "A badge at checkout reassures buyers",
                    "contract": contract}),
        json.dumps(readout), json.dumps({"decision": "ship", "rationale": "Conversion up a third, refunds flat"}))
    await db.execute("insert into edges (src, rel, dst, created_by) values ('ro-1', 'for', 'exp-2', 'maya'),"
                     " ('dec-2', 'decides', 'exp-2', 'maya')")
    await index_object(db, "exp-2")
    said = {h: b for h, b, _ in await chunks(db, "exp-2")}
    assert list(said) == ["Trust badge", "Trust badge › Registration", "Trust badge › Readout 2026-08-31 13:40",
                          "Trust badge › Decisions"]
    assert said["Trust badge › Registration"] == (
        "Measures Checkout conversion per user_id. Split control 50.0%, variant 50.0%."
        " Planned for 14 days to detect a 2.0% change at alpha 0.05. Guardrails: Refund rate."
        " Registered by maya on 2026-08-27.")
    assert said["Trust badge › Readout 2026-08-31 13:40"] == (
        "Checkout conversion: variant vs control +33.2%, interval +7.5% to +58.8%: better."
        " Arms: control 9.8% (n=4,000), variant 13.0% (n=4,000).\n"
        "The sample ratio check passed.\nRecorded by maya.")
    assert said["Trust badge › Decisions"].startswith("Ship Trust badge: Conversion up a third, refunds flat — maya")


async def test_what_an_edit_takes_out_is_kept_once_per_round(db):
    from commonindex.workers.indexer import index_object

    def doc(text):
        return json.dumps({"title": "Runbook", "body": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}]}})

    async def edit(text):
        await db.execute("update objects set props = $1::jsonb where id = 'doc-7'", doc(text))
        await index_object(db, "doc-7")

    async def kept():
        return [r["body"] for r in await db.fetch(
            "select body from chunk_history where object_id = 'doc-7' order by id")]

    await db.execute("insert into objects (id, space_id, type, key, title, props, created_by)"
                     " values ('doc-7', 'pay', 'doc', 'D-7', 'Runbook', $1::jsonb, 'maya')",
                     doc("Refunds retry five times."))
    await index_object(db, "doc-7")
    assert await kept() == []
    await edit("Refunds retry three times.")
    assert await kept() == ["Refunds retry five times."]
    await edit("Refunds retry twice.")        # the same round of edits
    assert await kept() == ["Refunds retry five times."]
    await db.execute("update chunk_history set said_until = said_until - interval '1 hour'")
    await edit("Refunds retry once.")         # a round later
    assert await kept() == ["Refunds retry five times.", "Refunds retry twice."]


async def test_a_new_scheme_rebuilds_the_index_without_calling_it_an_edit(db):
    from commonindex.workers.indexer import sweep

    while await sweep(db):
        pass
    await db.execute("update chunks set scheme = 0, body = body || ' (as an older indexer wrote it)'")
    assert await sweep(db) >= 1
    assert await db.fetchval("select count(*) from chunks where scheme = 0") == 0
    assert await db.fetchval("select count(*) from chunk_history") == 0
