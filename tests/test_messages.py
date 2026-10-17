"""Comments and channels, against a real database.

The rules worth a test each:

* a conversation is about a subject, threads are one level deep, and a reply
  to a reply joins its root;
* a mention resolves to an actor, and mentioning an agent asks it in its
  inbox — or says why not — and the thread shows it waiting until it answers;
* only the author edits; the author or a merger deletes, and a deleted message
  that replies hang from stays as a marker;
* a retry answers instead of posting twice.
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
        insert into actors (id, kind, display) values ('rhea', 'human', 'Rhea'), ('vic', 'human', 'Vic');
        insert into grants (id, subject, relation, resource, granted_by) values
            ('g-maya', 'maya', 'admin', 'space:pay', 'maya'),
            ('g-rhea', 'rhea', 'merge', 'space:pay', 'maya'),
            ('g-vic', 'vic', 'propose', 'space:pay', 'maya'),
            ('g-scribe', 'scribe', 'propose', 'space:pay', 'maya');
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
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": actor})(),
                                    "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {
            "commonindex": {"pool": _PoolOf(conn)}})()})()

    async def json(self):
        return self._body

    async def body(self):
        return json.dumps(self._body).encode()


async def call(db, op, actor="maya", **body):
    from commonindex.gateway import agents, messages

    handler = getattr(messages, op.replace(".", "_"), None) or getattr(agents, op.replace(".", "_"))
    if op.split(".")[1] in ("post", "edit", "delete", "propose", "start", "read"):
        body.setdefault("idempotencyKey", f"k-{next(_KEYS)}")
    out = await handler(_Req(body, db, actor))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


async def post(db, actor="maya", subject="doc-1", **body):
    status, out = await call(db, "messages.post", actor, subject_id=subject, **body)
    assert status == 200, out
    return out


async def thread(db, actor="maya", subject="doc-1"):
    _, out = await call(db, "messages.list", actor, subject_id=subject)
    return out


# ── conversation ──────────────────────────────────────────────────────────


async def test_a_comment_is_about_its_subject_and_names_who_it_mentions(db):
    out = await post(db, body="Why does refund_rate drop on the 12th, @rhea? cc @nobody")
    m = out["message"]
    assert m["author"] == {"id": "maya", "name": "Maya", "kind": "human"}
    # A handle that is not an actor stays text, and is not a mention.
    assert [x["id"] for x in m["mentions"]] == ["rhea"]
    t = await thread(db)
    assert t["subject"]["id"] == "doc-1" and [x["id"] for x in t["messages"]] == [m["id"]]


async def test_threads_are_one_level_deep(db):
    root = (await post(db, body="first"))["message"]
    reply = (await post(db, "rhea", body="answer", parent_id=root["id"]))["message"]
    deeper = (await post(db, body="answer to the answer", parent_id=reply["id"]))["message"]
    assert reply["parent_id"] == root["id"]
    assert deeper["parent_id"] == root["id"]


async def test_a_reply_answers_something_said_about_the_same_subject(db):
    await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                     " values ('doc-2', 'pay', 'doc', 'D-2', 'Other', 'maya')")
    root = (await post(db, body="here"))["message"]
    status, out = await call(db, "messages.post", subject_id="doc-2", body="there", parent_id=root["id"])
    assert status == 422 and out["error"]["code"] == "wrong_subject"


async def test_a_conversation_needs_a_subject_and_something_said(db):
    status, out = await call(db, "messages.post", subject_id="nope", body="hi")
    assert status == 404
    status, out = await call(db, "messages.post", subject_id="doc-1", body="   ")
    assert status == 422 and out["error"]["code"] == "empty"


async def test_a_retry_answers_instead_of_posting_twice(db):
    first = await post(db, body="once", idempotencyKey="same")
    again = await post(db, body="once", idempotencyKey="same")
    assert again["already"] is True and again["message"]["id"] == first["message"]["id"]
    assert len((await thread(db))["messages"]) == 1


# ── mentioning agents ─────────────────────────────────────────────────────


async def test_mentioning_an_agent_asks_it_and_the_thread_waits_for_its_answer(db):
    out = await post(db, body="@scribe can you check the spec against the handler?")
    assert out["asked"] == ["scribe"] and out["not_asked"] == []
    m = out["message"]

    # It is in the agent's own inbox, pointing at the thread to answer in.
    _, inbox = await call(db, "agents.inbox", "scribe")
    ask = next(a for a in inbox["asks"] if (a["object"] or {}).get("id") == "doc-1")
    assert "check the spec" in ask["note"] and f"parent_id={m['id']}" in ask["note"]

    t = await thread(db)
    assert [a["id"] for a in t["waiting"][m["id"]]] == ["scribe"]

    await post(db, "scribe", body="Checked — the spec says 3, the handler 5.", parent_id=m["id"])
    assert (await thread(db))["waiting"] == {}


async def test_an_agent_that_could_not_answer_is_reported_not_asked(db):
    out = await post(db, body="@triage thoughts?")
    assert out["asked"] == []
    assert out["not_asked"][0]["id"] == "triage" and "no propose grant" in out["not_asked"][0]["why"]
    assert await db.fetchval("select count(*) from events where verb = 'asked'") == 0


async def test_an_edit_asks_only_the_newly_mentioned(db):
    m = (await post(db, body="first draft @scribe"))["message"]
    await db.execute("insert into grants (id, subject, relation, resource, granted_by)"
                     " values ('g-triage', 'triage', 'propose', 'space:pay', 'maya')")
    _, out = await call(db, "messages.edit", message_id=m["id"], body="now @scribe and @triage")
    assert out["asked"] == ["triage"]
    assert out["message"]["edited_at"] is not None
    assert [x["id"] for x in out["message"]["mentions"]] == ["scribe", "triage"]


# ── editing and deleting ──────────────────────────────────────────────────


async def test_only_the_author_edits(db):
    m = (await post(db, body="mine"))["message"]
    status, out = await call(db, "messages.edit", "rhea", message_id=m["id"], body="yours now")
    assert status == 403 and out["error"]["code"] == "not_yours"


async def test_the_author_or_a_merger_deletes_and_a_marker_keeps_the_replies_anchored(db):
    root = (await post(db, "vic", body="question"))["message"]
    await post(db, "rhea", body="answer", parent_id=root["id"])
    lone = (await post(db, "vic", body="aside"))["message"]

    status, _ = await call(db, "messages.delete", "scribe", message_id=root["id"])
    assert status == 403
    await call(db, "messages.delete", "rhea", message_id=root["id"])   # a merger may
    await call(db, "messages.delete", "vic", message_id=lone["id"])     # the author may

    t = await thread(db)
    ids = [m["id"] for m in t["messages"]]
    assert root["id"] in ids and lone["id"] not in ids
    marker = next(m for m in t["messages"] if m["id"] == root["id"])
    assert marker["deleted"] is True and marker["body"] is None
    _, counts = await call(db, "messages.counts", subject_ids=["doc-1"])
    assert counts["counts"]["doc-1"] == 1


async def test_what_mentions_me(db):
    await post(db, body="@rhea have a look")
    await post(db, body="nothing for anyone")
    _, out = await call(db, "messages.mentions", "rhea")
    assert [m["message"]["body"] for m in out["mentions"]] == ["@rhea have a look"]
    assert out["mentions"][0]["subject"]["id"] == "doc-1"


# ── channels ──────────────────────────────────────────────────────────────


async def test_a_channel_is_a_place_to_talk_named_like_a_handle(db):
    status, out = await call(db, "channels.propose", name="Refund Incidents")
    assert status == 422 and out["error"]["code"] == "bad_name"
    _, out = await call(db, "channels.propose", name="refund-incidents", topic="as they happen")
    channel = out["channel"]
    assert channel["name"] == "refund-incidents" and channel["messages"] == 0
    status, out = await call(db, "channels.propose", name="refund-incidents")
    assert status == 409 and out["error"]["code"] == "name_taken"

    await post(db, subject=channel["id"], body="EU retries are spiking — @scribe watch the runbook")
    _, listed = await call(db, "channels.list")
    row = next(c for c in listed["channels"] if c["id"] == channel["id"])
    assert row["messages"] == 1 and row["last"]["author"]["id"] == "maya"
    assert "EU retries" in row["last"]["body"]


# ── notifications ─────────────────────────────────────────────────────────


async def notes(db, actor="maya"):
    _, out = await call(db, "messages.notifications", actor)
    return out


async def test_notified_of_mentions_and_of_replies_in_my_threads_never_of_myself(db):
    root = (await post(db, "maya", body="Why does refund_rate drop on the 12th?"))["message"]
    await post(db, "rhea", body="The dedupe fix landed that day.", parent_id=root["id"])
    await post(db, "vic", body="@maya the finance view agrees")
    await post(db, "vic", body="unrelated, in a thread maya is not in")
    await post(db, "maya", body="thanks both")

    out = await notes(db)
    got = [(n["kind"], n["message"]["body"]) for n in out["notifications"]]
    assert got == [("mention", "@maya the finance view agrees"),
                   ("reply", "The dedupe fix landed that day.")]
    assert out["unread"] == 2 and all(n["unread"] for n in out["notifications"])
    assert out["notifications"][0]["subject"]["id"] == "doc-1"


async def test_an_agent_answering_my_comment_is_a_notification(db):
    root = (await post(db, "maya", body="@scribe check the spec?"))["message"]
    await post(db, "scribe", body="Checked — it says 3.", parent_id=root["id"])
    out = await notes(db)
    assert out["notifications"][0]["kind"] == "reply"
    assert out["notifications"][0]["message"]["author"]["id"] == "scribe"


async def test_reading_a_conversation_clears_it_until_something_new_arrives(db):
    await post(db, "rhea", body="@maya one")
    await call(db, "messages.read", subject_id="doc-1")
    out = await notes(db)
    assert out["unread"] == 0 and out["notifications"][0]["unread"] is False
    await post(db, "rhea", body="@maya two")
    assert (await notes(db))["unread"] == 1


async def test_mark_everything_read(db):
    await db.execute("insert into objects (id, space_id, type, key, title, created_by)"
                     " values ('doc-2', 'pay', 'doc', 'D-2', 'Other', 'maya')")
    await post(db, "rhea", body="@maya here")
    await post(db, "rhea", subject="doc-2", body="@maya and here")
    _, out = await call(db, "messages.read", all=True)
    assert sorted(out["read"]) == ["doc-1", "doc-2"]
    assert (await notes(db))["unread"] == 0


async def test_unread_per_conversation_counts_only_what_others_said(db):
    _, ch = await call(db, "channels.propose", name="refund-incidents")
    cid = ch["channel"]["id"]
    await post(db, "maya", subject=cid, body="mine does not count")
    await post(db, "rhea", subject=cid, body="one")
    await post(db, "vic", subject=cid, body="two")
    _, out = await call(db, "messages.unread", subject_ids=[cid, "doc-1"])
    assert out["unread"] == {cid: 2, "doc-1": 0}
    await call(db, "messages.read", subject_ids=[cid])
    _, out = await call(db, "messages.unread", subject_ids=[cid])
    assert out["unread"] == {cid: 0}


# ── agents and skills ─────────────────────────────────────────────────────


async def test_an_agent_is_talked_about_as_itself(db):
    out = await post(db, subject="scribe", body="Its runbook answers are a week stale — @scribe re-read it?")
    t = await thread(db, subject="scribe")
    assert t["subject"] == {"id": "scribe", "type": "agent", "key": None, "title": "Scribe"}
    assert [m["id"] for m in t["messages"]] == [out["message"]["id"]]
    # Asked in its own conversation, its inbox says what the ask is about.
    _, inbox = await call(db, "agents.inbox", "scribe")
    assert inbox["asks"][0]["object"] == {"id": "scribe", "type": "agent", "title": "Scribe"}
    # And it is a conversation like any other to have read.
    await post(db, "rhea", subject="scribe", body="@maya agreed")
    _, read = await call(db, "messages.read", subject_ids=["scribe", "skill-nobody-mentioned"])
    assert read["read"] == ["scribe"]


async def test_a_skill_is_named_by_its_first_comment(db):
    declared = {"type": "skill", "title": "Doc drift sync", "key": "SK-109"}
    status, _ = await call(db, "messages.list", subject_id="skill-109")
    assert status == 404
    # Before anyone has said anything it is an empty conversation — and
    # reading it writes nothing.
    _, t = await call(db, "messages.list", subject_id="skill-109", subject=declared)
    assert t == {"subject": {"id": "skill-109", **declared}, "messages": [], "waiting": {}}
    assert await db.fetchval("select count(*) from conversation_subjects") == 0

    status, first = await call(db, "messages.post", subject_id="skill-109", subject=declared,
                               body="@rhea is this still installed on triage?")
    assert status == 200
    # Found from now on without being named, and a later name does not rename it.
    await call(db, "messages.post", "rhea", subject_id="skill-109",
               subject={**declared, "title": "Renamed"}, body="It is.",
               parent_id=first["message"]["id"])
    t = await thread(db, subject="skill-109")
    assert t["subject"]["title"] == "Doc drift sync" and len(t["messages"]) == 2
    _, notes_for_rhea = await call(db, "messages.notifications", "rhea")
    assert notes_for_rhea["notifications"][0]["subject"] == {"id": "skill-109", **declared}


async def test_only_a_skill_is_taken_on_the_callers_word(db):
    status, out = await call(db, "messages.post", subject_id="dash-9",
                             subject={"type": "dashboard", "title": "Made up"}, body="hi")
    assert status == 422 and out["error"]["code"] == "not_declarable"
    status, out = await call(db, "messages.post", subject_id="not a skill",
                             subject={"type": "skill", "title": "X"}, body="hi")
    assert status == 422 and out["error"]["code"] == "bad_subject"
    # Something that exists is what it is, whatever the caller calls it.
    status, _ = await call(db, "messages.post", subject_id="doc-1",
                           subject={"type": "skill", "title": "Not a doc"}, body="hi")
    assert status == 200 and (await thread(db))["subject"]["type"] == "doc"
    assert await db.fetchval("select count(*) from conversation_subjects") == 0


# ── a channel's settings ────────────────────────────────────────────────


async def _open(db, name, **extra):
    status, out = await call(db, "channels.propose", "maya", name=name, **extra)
    assert status == 200, out
    return out["channel"]["id"]


async def _named(db, actor):
    _, out = await call(db, "channels.list", actor)
    return [c["name"] for c in out["channels"]]


async def test_a_private_channel_is_for_the_people_in_it(db):
    from commonindex.gateway.sharing import items_share

    cid = await _open(db, "leadership", private=True)
    assert "leadership" in await _named(db, "maya") and "leadership" not in await _named(db, "vic")
    status, _ = await call(db, "messages.list", "vic", subject_id=cid)
    assert status == 404                                          # not "not yours": not there
    status, _ = await call(db, "messages.post", "vic", subject_id=cid, body="hello?")
    assert status == 404
    await db.execute("update actors set email = 'vic@example.test' where id = 'vic'")
    req = _Req({"id": cid, "email": "vic@example.test", "role": "edit", "idempotencyKey": "s"}, db, "maya")
    await items_share(req)
    assert "leadership" in await _named(db, "vic")
    status, _ = await call(db, "messages.post", "vic", subject_id=cid, body="thanks for adding me")
    assert status == 200


async def test_a_channel_is_renamed_and_its_topic_changed(db):
    from commonindex.gateway.messages import channels_update

    cid = await _open(db, "launch", topic="the launch")
    out = await channels_update(_Req({"channel_id": cid, "name": "launch-2026", "topic": "Q4 launch",
                                      "idempotencyKey": "u"}, db, "maya"))
    assert (out["channel"]["name"], out["channel"]["topic"]) == ("launch-2026", "Q4 launch")
    await _open(db, "taken")
    clash = await channels_update(_Req({"channel_id": cid, "name": "taken", "idempotencyKey": "u2"}, db, "maya"))
    assert clash.status_code == 409


async def test_an_archived_channel_is_kept_and_closed(db):
    from commonindex.gateway.messages import channels_archive

    cid = await _open(db, "old-project")
    await call(db, "messages.post", "maya", subject_id=cid, body="the last word")
    out = await channels_archive(_Req({"channel_id": cid, "idempotencyKey": "a"}, db, "maya"))
    assert out["channel"]["archived"] and "old-project" not in await _named(db, "maya")
    status, _ = await call(db, "messages.list", "maya", subject_id=cid)
    assert status == 200                                          # still readable
    status, out = await call(db, "messages.post", "maya", subject_id=cid, body="anyone?")
    assert (status, out["error"]["code"]) == (409, "archived")
    _, listed = await call(db, "channels.list", "maya", archived=True)
    assert "old-project" in [c["name"] for c in listed["channels"]]
    await channels_archive(_Req({"channel_id": cid, "archived": False, "idempotencyKey": "b"}, db, "maya"))
    assert "old-project" in await _named(db, "maya")


async def test_only_its_owners_or_an_admin_archive_a_channel(db):
    from commonindex.gateway.messages import channels_archive

    cid = await _open(db, "everyone")                             # public, by workspace role
    refused = await channels_archive(_Req({"channel_id": cid, "idempotencyKey": "a"}, db, "vic"))
    assert refused.status_code == 403


# ── updates ───────────────────────────────────────────────────────────────


async def test_an_update_is_read_apart_from_the_comments_and_tags_like_one(db):
    """A task's Updates tab: dated notes on how the work is going, with people
    and agents tagged the same way a comment tags them — and not mixed into the
    conversation, nor counted as comments."""
    await post(db, body="Looks right to me")
    up = await post(db, kind="update", body="Invoices moved to the new service. @rhea please verify, @scribe re-run the checks")
    assert up["message"]["kind"] == "update"
    assert [m["id"] for m in up["message"]["mentions"]] == ["rhea", "scribe"]
    assert up["asked"] == ["scribe"]                       # the agent is asked in its inbox
    comments = await thread(db)
    assert [m["body"] for m in comments["messages"]] == ["Looks right to me"]
    _, updates = await call(db, "messages.list", subject_id="doc-1", kind="update")
    assert [m["kind"] for m in updates["messages"]] == ["update"]
    _, counts = await call(db, "messages.counts", subject_ids=["doc-1"])
    assert counts["counts"]["doc-1"] == 1


async def test_an_update_is_not_a_reply_and_a_kind_is_one_of_two(db):
    first = await post(db, kind="update", body="Started")
    status, out = await call(db, "messages.post", subject_id="doc-1", kind="update", body="x",
                             parent_id=first["message"]["id"])
    assert status == 422 and out["error"]["code"] == "update_reply"
    status, out = await call(db, "messages.post", subject_id="doc-1", kind="memo", body="x")
    assert status == 422 and out["error"]["code"] == "bad_kind"


async def test_a_page_is_the_newest_conversations_each_whole(db):
    """A thread read whole on every poll cost more the longer a channel ran."""
    first = await post(db, body="first")
    for i in range(4):
        await post(db, body=f"later {i}")
    await post(db, body="a reply to the first", parent_id=first["message"]["id"])
    status, page = await call(db, "messages.list", subject_id="doc-1", limit=2)
    assert status == 200 and page["more_before"] is True
    assert [m["body"] for m in page["messages"]] == ["later 2", "later 3"]
    status, older = await call(db, "messages.list", subject_id="doc-1", limit=10,
                               before=page["messages"][0]["id"])
    bodies = [m["body"] for m in older["messages"]]
    # The first conversation comes whole: its reply with it, though the reply is
    # newer than the page — oldest first, as a thread is read.
    assert bodies == ["first", "later 0", "later 1", "a reply to the first"]
    assert older["more_before"] is False


async def test_since_brings_only_what_changed_deletions_included(db):
    kept = await post(db, body="kept")
    gone = await post(db, body="gone")
    _, page = await call(db, "messages.list", subject_id="doc-1")
    since = page["now"]
    new = await post(db, body="new")
    await call(db, "messages.edit", message_id=kept["message"]["id"], body="kept, edited")
    await call(db, "messages.delete", message_id=gone["message"]["id"])
    _, changed = await call(db, "messages.list", subject_id="doc-1", since=since)
    got = {m["id"]: m for m in changed["messages"]}
    assert set(got) == {kept["message"]["id"], gone["message"]["id"], new["message"]["id"]}
    assert got[kept["message"]["id"]]["body"] == "kept, edited"
    assert got[gone["message"]["id"]]["deleted"] is True
    assert changed["since"] and changed["now"] >= since


async def test_a_change_is_announced_with_who_may_read_it_never_what_was_said(db):
    heard = []
    listener = await asyncpg.connect(DSN)
    try:
        await listener.add_listener("commonindex_messages", lambda *a: heard.append(json.loads(a[-1])))
        await post(db, body="a secret plan")
        import asyncio
        for _ in range(50):
            if heard:
                break
            await asyncio.sleep(0.05)
    finally:
        await listener.close()
    assert heard and heard[0]["subject_id"] == "doc-1" and heard[0]["space"] == "pay"
    assert heard[0]["acl"] and "a secret plan" not in json.dumps(heard[0])
