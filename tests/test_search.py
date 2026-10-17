"""Workspace search, against a real database.

The palette searched samples generated in the browser and nothing else, so a
dashboard somebody had made here could not be found by its own name. The rules
worth a test each:

* a half-typed title finds what it names — every word, each as a prefix;
* a key is found as it is written, and ahead of anything that merely mentions it;
* a doc is found by any sentence in it, and says where it matched;
* a task by its detail, a channel by its topic, an agent by its name;
* what was said is found by its words, naming what it was about;
* nothing from another space, nothing deleted, nothing that is not a page.
"""

from __future__ import annotations

import json

import pytest
from db import DSN, reset, seed

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

BODY = {"type": "doc", "content": [{"type": "paragraph", "content": [
    {"type": "text", "text": "Refunds retry three times before paging the on-call engineer."}]}]}


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    rows = [
        ("dash-1", "pay", "dashboard", "DASH-1", "Two warehouses", {}),
        ("dash-6", "pay", "dashboard", "DASH-6", "Analyst throughput", {}),
        ("doc-2", "pay", "doc", "D-2", "Retry policy", {"title": "Retry policy", "body": BODY}),
        ("task-1", "pay", "task", "T-109", "Reconcile the refund flow spec",
         {"title": "Reconcile the refund flow spec", "detail": "Check the handler against what shipped"}),
        ("ch-1", "pay", "channel", "CH-1", "refund-incidents",
         {"name": "refund-incidents", "topic": "Incidents as they happen"}),
        ("exp-1", "pay", "experiment", "EXP-1", "Checkout progress bar",
         {"name": "Checkout progress bar", "hypothesis": "A visible progress bar reduces abandonment"}),
        ("dash-g", "growth", "dashboard", "DASH-9", "Two warehouses, growth", {}),
        ("panel-1", "pay", "panel", None, "Two warehouses panel", {}),
    ]
    for oid, space, typ, key, title, props in rows:
        await conn.execute(
            "insert into objects (id, space_id, type, key, title, props, created_by)"
            " values ($1,$2,$3,$4,$5,$6::jsonb,'maya')", oid, space, typ, key, title, json.dumps(props))
    await conn.execute(
        "insert into objects (id, space_id, type, key, title, created_by, deleted_at)"
        " values ('dash-7', 'pay', 'dashboard', 'DASH-7', 'Two warehouses, retired', 'maya', now())")
    await conn.execute("""
        insert into grants (id, subject, relation, resource, granted_by) values
          ('g-maya', 'maya', 'propose', 'space:pay', 'maya');
    """)
    await conn.execute("""
        insert into messages (id, space_id, subject_id, author_id, body) values
          ('m1', 'pay', 'doc-1', 'maya', 'The runbook says three retries, the handler five.'),
          ('m2', 'pay', 'doc-1', 'maya', 'An old runbook note');
        update messages set deleted_at = now() where id = 'm2';
    """)
    # Indexed the way a save indexes them.
    from commonindex.workers.indexer import sweep

    while await sweep(conn):
        pass
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
    def __init__(self, body, conn, **commonindex):
        self._body = body
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": "maya"})(),
                                    "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {
            "commonindex": {"pool": _PoolOf(conn), **commonindex}})()})()

    async def json(self):
        return self._body


async def find(db, q, actor="maya", **body):
    from commonindex.gateway.search import search_query

    req = _Req({"q": q, **body}, db)
    req.state.principal.actor_id = actor
    return (await search_query(req))["hits"]


def plain(snippet):
    """A snippet without the marks around its matched words."""
    return (snippet or "").replace("«", "").replace("»", "")


def ids(hits):
    return [h["id"] for h in hits]


async def test_a_half_typed_title_finds_what_it_names(db):
    # Not the other space's, not the deleted one, not the panel inside a dashboard.
    assert ids(await find(db, "Two ware")) == ["dash-1"]


async def test_a_key_is_found_as_written_and_first(db):
    assert ids(await find(db, "DASH-6"))[0] == "dash-6"
    assert ids(await find(db, "t-109")) == ["task-1"]
    # A title that is the query outranks one that merely mentions its words.
    assert ids(await find(db, "Refund spec"))[:2] == ["doc-1", "task-1"]


async def test_a_doc_is_found_by_a_sentence_in_it_and_shows_where(db):
    hit = next(h for h in await find(db, "paging on-call") if h["id"] == "doc-2")
    assert hit["type"] == "doc" and "paging the on-call" in plain(hit["snippet"])
    assert "«paging»" in hit["snippet"]   # the matched words, marked


async def test_a_match_in_the_title_shows_no_snippet(db):
    # "Analyst" is only in the title: a snippet would repeat the key beneath it.
    hit = next(h for h in await find(db, "analyst thro") if h["id"] == "dash-6")
    assert hit["snippet"] is None


async def test_a_task_by_its_detail_a_channel_by_its_topic_an_agent_by_its_name(db):
    assert ids(await find(db, "handler shipped")) == ["task-1"]
    exp = await find(db, "abandonment")
    assert ids(exp) == ["exp-1"] and "reduces abandonment" in plain(exp[0]["snippet"])
    assert ids(await find(db, "incidents happen")) == ["ch-1"]
    agent = await find(db, "scrib")
    assert [(h["kind"], h["id"], h["title"]) for h in agent] == [("agent", "scribe", "Scribe")]


async def test_what_was_said_is_found_naming_what_it_was_about(db):
    said = [h for h in await find(db, "runbook") if h["kind"] == "message"]
    assert ids(said) == ["m1"]   # the deleted note is not found
    assert said[0]["subject"] == {"id": "doc-1", "type": "doc", "key": "D-1", "title": "Refund spec"}
    assert said[0]["author"]["id"] == "maya" and "runbook" in said[0]["snippet"]


async def test_nothing_to_search_for_finds_nothing(db):
    assert await find(db, "   ") == []
    assert await find(db, "— · —") == []


async def test_only_the_types_asked_for(db):
    assert ids(await find(db, "two", types=["doc"])) == []
    assert ids(await find(db, "two", types=["dashboard", "not-a-type"])) == ["dash-1"]



# ── the stored indexes ───────────────────────────────────────────────────


async def test_quick_find_takes_a_fragment_or_a_typo(db):
    assert ids(await find(db, "arehous")) == ["dash-1"]
    assert ids(await find(db, "Two warehuses"))[0] == "dash-1"


async def test_content_matches_the_forms_of_a_word(db):
    # "retried" and the doc's "retry" are the same word.
    assert "doc-2" in ids(await find(db, "retried"))


async def test_a_section_heading_outranks_a_passing_mention(db):
    from commonindex.workers.indexer import index_object

    def tree(*blocks):
        return {"type": "doc", "content": list(blocks)}

    def para(text):
        return {"type": "paragraph", "content": [{"type": "text", "text": text}]}

    rows = [
        ("doc-3", "Deploy guide", tree(para("How we ship."),
                                        {"type": "heading", "attrs": {"level": 2},
                                         "content": [{"type": "text", "text": "Rollback"}]},
                                        para("Revert the release tag."))),
        ("doc-4", "Release notes", tree(para("Nothing needed a rollback this week."))),
    ]
    for oid, title, body in rows:
        await db.execute("insert into objects (id, space_id, type, title, props, created_by)"
                         " values ($1, 'pay', 'doc', $2, $3::jsonb, 'maya')",
                         oid, title, json.dumps({"title": title, "body": body}))
        await index_object(db, oid)
    assert ids(await find(db, "rollback"))[:2] == ["doc-3", "doc-4"]


async def test_nothing_the_caller_may_not_read(db):
    from commonindex.workers.indexer import index_object

    await db.execute("insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
                     " values ('doc-9', 'pay', 'doc', 'D-9', 'Board deck', 'maya', '{object:doc-9}')")
    await index_object(db, "doc-9")
    assert await find(db, "Board deck") == []
    await db.execute("insert into grants (id, subject, relation, resource, granted_by)"
                     " values ('g-deck', 'maya', 'read', 'object:doc-9', 'maya')")
    assert ids(await find(db, "Board deck")) == ["doc-9"]


async def test_a_title_that_is_the_query_beats_one_that_mentions_it(db):
    await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                     " values ('task-9', 'pay', 'task', 'T-9', 'Fix the spend panel on Two warehouses', 'maya')")
    from commonindex.workers.indexer import index_object

    await index_object(db, "task-9")
    assert ids(await find(db, "arehous"))[:2] == ["dash-1", "task-9"]


async def test_a_near_miss_is_a_fallback_not_a_match(db):
    from commonindex.workers.indexer import index_object

    await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                     " values ('task-8', 'pay', 'task', 'T-8', 'Changelog entries for the releases', 'maya')")
    await index_object(db, "task-8")
    found = ids(await find(db, "retries"))
    # "retries" is a different word from "entries"; the doc that says "retry" is the answer.
    assert "doc-2" in found and "task-8" not in found


# ── tools for an agent: filters, pages, reading ──────────────────────────


async def query(db, **body):
    from commonindex.gateway.search import search_query

    out = await search_query(_Req(body, db))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


async def test_an_agent_narrows_by_author_date_and_conversation(db):
    await db.execute("""
        insert into actors (id, kind, display) values ('rhea', 'human', 'Rhea');
        insert into messages (id, space_id, subject_id, author_id, body, created_at) values
          ('m3', 'pay', 'ch-1', 'rhea', 'The runbook is stale again', now() - interval '40 days'),
          ('m4', 'pay', 'ch-1', 'maya', 'Fixed the runbook this morning', now());
    """)
    _, out = await query(db, q="runbook", author="rhea")
    assert [h["id"] for h in out["hits"] if h["kind"] == "message"] == ["m3"]
    _, out = await query(db, q="runbook", since="2026-01-01", within="ch-1")
    said = [h["id"] for h in out["hits"]]
    assert "m4" in said and "m1" not in said          # only that conversation
    assert all(h["kind"] == "message" for h in out["hits"])
    status, out = await query(db, q="runbook", since="last tuesday")
    assert status == 422 and out["error"]["code"] == "bad_filter"


async def test_a_page_at_a_time(db):
    for i in range(5):
        await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                         " values ($1, 'pay', 'task', $2, $3, 'maya')", f"t-{i}", f"T-{i}", f"Paging probe {i}")
    from commonindex.workers.indexer import sweep

    while await sweep(db):
        pass
    _, first = await query(db, q="paging probe", limit=2, types=["task"])
    _, second = await query(db, q="paging probe", limit=2, offset=2, types=["task"])
    assert first["more"] and len(first["hits"]) == 2 and len(second["hits"]) == 2
    assert not {h["id"] for h in first["hits"]} & {h["id"] for h in second["hits"]}


async def test_reading_an_item_the_way_the_index_holds_it(db):
    from commonindex.gateway.search import search_read

    await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                     " values ('task-2', 'pay', 'task', 'T-2', 'Fix retries', 'maya');"
                     " insert into edges (src, rel, dst, created_by) values ('task-2', 'caused', 'doc-2', 'maya');"
                     " insert into messages (id, space_id, subject_id, author_id, body)"
                     "   values ('m5', 'pay', 'doc-2', 'maya', 'Three retries is the spec')")
    out = await search_read(_Req({"id": "doc-2"}, db))
    item = out["item"]
    assert item["title"] == "Retry policy" and "paging the on-call" in item["sections"][-1]["text"]
    assert [c["text"] for c in item["comments"]] == ["Three retries is the spec"]
    assert item["links"] == [{"rel": "caused", "direction": "in", "id": "task-2", "type": "task",
                              "key": "T-2", "title": "Fix retries"}]
    # What the caller may not read is not there at all.
    await db.execute("update objects set acl_keys = '{object:doc-2}' where id = 'doc-2'")
    missing = await search_read(_Req({"id": "doc-2"}, db))
    assert missing.status_code == 404


class _Script:
    model = "script"

    def __init__(self, *replies):
        self.replies = list(replies)

    async def complete(self, messages, *, max_tokens=900, require_finished=False):
        return self.replies.pop(0)


async def test_asking_the_workspace_searches_reads_and_cites(db):
    from commonindex.gateway.search import workspace_ask

    model = _Script(json.dumps({"search": "paging on-call"}), json.dumps({"read": "doc-2"}),
                    json.dumps({"answer": "Refunds retry three times, then page on-call.", "cite": ["doc-2"]}))
    out = await workspace_ask(_Req({"q": "When does a refund page someone?"}, db, llm=model))
    assert out["answer"].startswith("Refunds retry three times")
    assert out["citations"] == [{"id": "doc-2", "type": "doc", "key": "D-2", "title": "Retry policy"}]
    assert [s["kind"] for s in out["steps"]] == ["search", "read"]


async def test_asking_without_a_model_says_how_to_have_one(db):
    from commonindex.gateway.search import workspace_ask

    out = await workspace_ask(_Req({"q": "anything?"}, db))
    assert out.status_code == 422 and json.loads(out.body)["error"]["code"] == "no_model"


# ── the rest of the workspace: parts, code, definitions, runs, history ───


WAREHOUSE = """
    insert into connections (id, space_id, name, kind, created_by) values ('conn-1', 'pay', 'warehouse', 'postgres', 'maya');
    insert into datasets (id, space_id, connection_id, name, physical, created_by, description, caveats)
      values ('public.refund_orders', 'pay', 'conn-1', 'public.refund_orders', 'public.refund_orders', 'maya',
              'One row per order that asked for its money back', 'EU rows land a day late');
    insert into metrics (id, version, space_id, dataset_id, label, expr, unit, status, created_by, description)
      values ('refund_rate', 1, 'pay', 'public.refund_orders', 'Refund rate', 'avg(refunded)', '%', 'ratified', 'maya',
              'Share of orders refunded within thirty days');
    insert into objects (id, space_id, type, title, created_by) values ('dash-1-p0', 'pay', 'panel', 'Refund rate', 'maya');
    insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id, metric_version, position, mark, title)
      values ('dash-1-p0', 'dash-1', 'public.refund_orders', 'refund_rate', 1, 0, 'line', 'Refund rate');
"""

CODE = """
    insert into objects (id, space_id, type, title, props, created_by, acl_keys) values
      ('code_repo-1', 'pay', 'code_repo', 'example/payments', '{}', 'maya', '{space:pay}'),
      ('code_file-1', 'pay', 'code_file', 'refunds/retry.py', '{"repo_id": "code_repo-1"}', 'maya', '{space:pay}'),
      ('code_file-2', 'pay', 'code_file', 'vault/retry.py', '{}', 'maya', '{object:repo-vault}');
    insert into chunks (object_id, space_id, object_type, rev, ord, body, acl_keys, start_line, end_line) values
      ('code_file-1', 'pay', 'code_file', 1, 0, 'MAX_REFUND_RETRIES = 3  # the ceiling every spec quotes',
       '{space:pay}', 10, 12),
      ('code_file-2', 'pay', 'code_file', 1, 0, 'MAX_REFUND_RETRIES = 9  # a ceiling nobody may see',
       '{object:repo-vault}', 1, 1);
"""

RUNS = """
    insert into objects (id, space_id, type, key, title, created_by, acl_keys)
      values ('doc-sealed', 'pay', 'doc', 'D-9', 'Sealed', 'maya', '{object:doc-sealed}');
    insert into events (space_id, seq, actor_id, verb, object_id, payload) values
      ('pay', 901, 'maya', 'asked', 'dash-1', '{"agent": "scribe", "note": "Why did the refund rate jump on the 12th?"}'),
      ('pay', 902, 'maya', 'asked', 'doc-sealed', '{"agent": "scribe", "note": "Why did the refund rate jump, privately?"}');
    insert into runs (id, space_id, agent_id, trigger_seq, status, started_at) values
      ('run-1', 'pay', 'scribe', 901, 'done', now() - interval '2 hours'),
      ('run-2', 'pay', 'scribe', 902, 'done', now() - interval '1 hour');
"""


async def test_a_dashboard_is_found_by_what_its_panels_chart(db):
    from commonindex.workers.indexer import index_object

    await db.execute(WAREHOUSE)
    await index_object(db, "dash-1")
    top = (await find(db, "refunded within thirty days"))[0]
    assert (top["kind"], top["id"]) == ("object", "dash-1") and "thirty" in plain(top["snippet"])


async def test_definitions_are_found_and_say_where_they_are_charted(db):
    await db.execute(WAREHOUSE)
    hits = await find(db, "money back")
    assert [h["id"] for h in hits if h["kind"] == "dataset"] == ["public.refund_orders"]
    metric = (await find(db, "refund rate", types=["metric"]))[0]
    assert (metric["id"], metric["status"]) == ("refund_rate", "ratified")
    assert [d["id"] for d in metric["used_on"]] == ["dash-1"]
    # A space's definitions are its members': someone from another space finds none.
    await db.execute("insert into actors (id, kind, display) values ('gus', 'human', 'Gus');"
                     " insert into grants (id, subject, relation, resource, granted_by)"
                     "   values ('g-gus', 'gus', 'read', 'space:growth', 'maya')")
    assert await find(db, "refund rate", actor="gus", types=["metric", "dataset"]) == []


async def test_code_is_found_by_what_its_lines_say(db):
    await db.execute(CODE)
    code = [h for h in await find(db, "refund retries ceiling") if h["kind"] == "code"]
    # The file in a repository nobody granted stays out.
    assert [(h["id"], h["title"], h["repo"], h["lines"]) for h in code] == [
        ("code_file-1", "refunds/retry.py", "example/payments", [10, 12])]


async def test_runs_are_found_by_what_the_agent_was_asked(db):
    await db.execute(RUNS)
    runs = [h for h in await find(db, "refund rate jump") if h["kind"] == "run"]
    # The one about a doc Maya cannot read is not shown to her.
    assert [(h["id"], h["title"], h["status"], h["asked_by"]["name"]) for h in runs] == [
        ("run-1", "Scribe", "done", "Maya")]
    assert await find(db, "refund rate jump", author="triage", types=["run"]) == []


async def test_one_kind_alone_pages(db):
    await db.execute(RUNS)
    await db.execute("update objects set acl_keys = '{space:pay}' where id = 'doc-sealed'")
    _, first = await query(db, q="refund rate jump", types=["run"], limit=1)
    _, second = await query(db, q="refund rate jump", types=["run"], limit=1, offset=1)
    assert first["more"] and [h["id"] for h in first["hits"]] == ["run-2"]
    assert [h["id"] for h in second["hits"]] == ["run-1"]


async def test_an_earlier_version_is_found_by_what_it_said(db):
    from commonindex.workers.indexer import index_object

    edited = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "Refunds retry twice before paging finance."}]}]}
    await db.execute("update objects set props = $1::jsonb where id = 'doc-2'",
                     json.dumps({"title": "Retry policy", "body": edited}))
    await index_object(db, "doc-2")
    earlier = [h for h in await find(db, "on-call engineer") if h["kind"] == "history"]
    assert [(h["id"], h["type"]) for h in earlier] == [("doc-2", "doc")]
    assert "on-call engineer" in plain(earlier[0]["snippet"])
    # Where the page still says it, the page is the result — not its past.
    hits = await find(db, "refunds retry")
    assert ("object", "doc-2") in [(h["kind"], h["id"]) for h in hits]
    assert "history" not in {h["kind"] for h in hits}


async def test_reading_what_is_not_a_page(db):
    from commonindex.gateway.search import search_read

    await db.execute(WAREHOUSE + CODE + RUNS)

    async def read(item_id):
        out = await search_read(_Req({"id": item_id}, db))
        return out["item"] if isinstance(out, dict) else None

    code = await read("code_file-1")
    assert (code["repo"], code["sections"][0]["heading"]) == ("example/payments", "lines 10–12")
    metric = await read("refund_rate")
    assert "avg(refunded)" in metric["sections"][0]["text"]
    assert [(link["rel"], link["id"]) for link in metric["links"]] == [("charted on", "dash-1")]
    dataset = await read("public.refund_orders")
    assert {"heading": "Caveats", "text": "EU rows land a day late"} in dataset["sections"]
    run = await read("run-1")
    assert run["sections"][0] == {"heading": "Asked", "text": "Why did the refund rate jump on the 12th?"}
    assert [link["id"] for link in run["links"]] == ["dash-1"]
    assert await read("run-2") is None   # asked about something Maya cannot read


async def test_reading_a_dashboard_runs_its_panels(db, monkeypatch):
    from commonindex.gateway import app as gateway
    from commonindex.gateway.search import search_read

    async def render(body, space):
        return {"panels": [
            {"panel": {"title": "Refund rate"}, "label": "Refund rate", "unit": "%",
             "series": [{"name": "", "points": [("2026-08-29", 1.9), ("2026-09-27", 2.4)]}]},
            {"panel": {"title": "Spend"}, "error": "the warehouse did not answer"},
            # Split by category, not time: each point is its category's value.
            {"panel": {"title": "By arm"}, "label": "Conversion by arm", "unit": None,
             "series": [{"name": "control", "points": [("control", 0.0973)]},
                        {"name": "variant", "points": [("variant", 0.13)]}]}]}

    monkeypatch.setattr(gateway, "render_dashboard", render)
    now = (await search_read(_Req({"id": "dash-1"}, db)))["item"]["sections"][-1]
    assert now == {"heading": "Numbers, last 30 days",
                   "text": "Refund rate: 2.4% on 2026-09-27, from 1.9% on 2026-08-29\n"
                           "Spend: could not run — the warehouse did not answer\n"
                           "Conversion by arm: control 0.0973, variant 0.13"}
    sections = (await search_read(_Req({"id": "dash-1", "numbers": False}, db)))["item"]["sections"]
    assert all(s["heading"] != now["heading"] for s in sections)


async def test_a_dashboard_quiet_lately_says_its_latest_number(db, monkeypatch):
    from commonindex.gateway import app as gateway
    from commonindex.gateway.search import search_read

    async def render(body, space):
        points = [] if body["range"] == "30d" else [("2026-06-01", 3.1)]
        return {"panels": [
            {"panel": {"id": "p0", "title": "Refund rate"}, "label": "Refund rate", "unit": "%",
             "series": [{"name": "", "points": points}]},
            # A panel of its own SQL reads no window, so it always has rows.
            {"panel": {"id": "p1", "title": "Arms"}, "label": "Arms", "columns": ["arm"], "rows": [["control"]]}]}

    monkeypatch.setattr(gateway, "render_dashboard", render)
    now = (await search_read(_Req({"id": "dash-1"}, db)))["item"]["sections"][-1]
    assert now == {"heading": "Numbers, last 30 days",
                   "text": "Refund rate: 3.1% on 2026-06-01 — nothing in the last 30 days\nArms: arm=control"}
