"""The reference agent, against a real database and the real handlers.

Nothing in the repository ever claimed an ask, so every mention of an agent
read "asked, waiting" forever and every handed task sat at "Working". The
runner is the loop that closes that. What is defended, one test each:

* a mention is answered in its thread, and the thread stops waiting;
* a handed task is done on the task and filed for review, criterion by
  criterion — an answer the model did not give counts as not met;
* a task that needs a person stops and asks on the task;
* a direct ask is answered where it was about — or on the agent's own page —
  naming who asked;
* a model that fails is said where the answer would have gone, and a handed
  task goes back to the board;
* a reply never asks another agent, and an ask is answered once.
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
        insert into actors (id, kind, display) values ('rhea', 'human', 'Rhea');
        insert into grants (id, subject, relation, resource, granted_by) values
            ('g-maya', 'maya', 'admin', 'space:pay', 'maya'),
            ('g-rhea', 'rhea', 'merge', 'space:pay', 'maya'),
            ('g-scribe', 'scribe', 'propose', 'space:pay', 'maya'),
            ('g-triage', 'triage', 'propose', 'space:pay', 'maya');
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


def _handler(op):
    from commonindex.gateway import access, agents, messages, search, tasks

    area, verb = op.split(".")
    module = {"agents": agents, "runs": agents, "actors": access, "messages": messages,
              "tasks": tasks, "search": search}[area]
    return getattr(module, f"{area}_{verb}")


class HandlerGateway:
    """The gateway's own handlers, called as an actor — every refusal the HTTP
    route would give, without the socket. JSON in and out, as over the wire."""

    def __init__(self, conn, actor):
        self.conn, self.actor, self.calls = conn, actor, []

    async def call(self, op, body):
        from commonindex.reference_agent import Refused

        self.calls.append(op)
        out = await _handler(op)(_Req(json.loads(json.dumps(body)), self.conn, self.actor))
        if hasattr(out, "status_code"):
            payload = json.loads(out.body)
            if out.status_code >= 400:
                err = payload.get("error") or {}
                raise Refused(out.status_code, err.get("code", ""), err.get("message", ""))
            return payload
        return json.loads(json.dumps(out, default=str))


class Model:
    """Answers what it is told to, and keeps what it was shown."""

    def __init__(self, *answers, fails=False):
        self.answers, self.fails, self.prompts = list(answers), fails, []

    async def complete(self, messages, *, max_tokens=900, require_finished=False):
        from commonindex.gateway.llm import LlmUnavailable

        self.prompts.append(messages[-1]["content"])
        if self.fails:
            raise LlmUnavailable("model endpoint returned HTTP 503")
        return self.answers.pop(0)


async def call(db, op, actor="maya", **body):
    body.setdefault("idempotencyKey", f"k-{next(_KEYS)}")
    out = await _handler(op)(_Req(body, db, actor))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


def runner(db, model, agent="scribe"):
    from commonindex.reference_agent import Runner

    return Runner(HandlerGateway(db, agent), model)


async def thread(db, subject):
    _, out = await call(db, "messages.list", subject_id=subject)
    return out


async def test_a_mention_is_answered_in_its_thread_and_it_stops_waiting(db):
    _, asked = await call(db, "messages.post", subject_id="doc-1",
                          body="@scribe does the spec say 3 retries or 5?")
    root = asked["message"]["id"]
    assert (await thread(db, "doc-1"))["waiting"]
    model = Model("The spec says 3; the handler does 5 since #341.")

    done = await runner(db, model).once()

    assert [(d["kind"], d["status"]) for d in done] == [("mention", "done")]
    t = await thread(db, "doc-1")
    answer = t["messages"][-1]
    assert answer["author"]["id"] == "scribe" and answer["parent_id"] == root
    assert answer["body"] == "The spec says 3; the handler does 5 since #341."
    assert t["waiting"] == {}
    # It was shown the thread it answered in.
    assert "does the spec say 3 retries or 5?" in model.prompts[0]
    assert await db.fetchval("select status from runs") == "done"


async def test_an_answer_says_which_model_wrote_it(db):
    """Run on a laptop with a local model or against a provider's: whoever
    reads the answer can tell which, because the runner says under it."""
    await call(db, "messages.post", subject_id="doc-1", body="@scribe how many retries?")
    model = Model("Three.")
    model.model = "qwen3.5:9b"

    await runner(db, model).once()

    answer = (await thread(db, "doc-1"))["messages"][-1]
    assert answer["body"] == "Three.\n\n— written with qwen3.5:9b"


async def test_a_handed_task_is_done_on_the_task_and_filed_criterion_by_criterion(db):
    _, out = await call(db, "tasks.propose", title="Draft the 2.4 changelog",
                        criteria=["lists every merged PR", "says what broke"])
    task = out["task"]
    await call(db, "tasks.hand", task_id=task["id"], agent_id="scribe", note="Keep it short.")
    # The model answered one criterion of two: the other counts as not met.
    model = Model("Nothing in the workspace bears on it yet.",
                  json.dumps({"work": "## 2.4\n- Refund retries capped at 3", "criteria_met": [True],
                              "question": None}))

    done = await runner(db, model).once()

    assert [(d["kind"], d["status"]) for d in done] == [("task", "done")]
    _, got = await call(db, "tasks.get", task_id=task["id"])
    filed = got["task"]
    assert filed["state"] == "review" and [c["met"] for c in filed["criteria"]] == [True, False]
    assert filed["produced"]["label"] == "Written in the task's comments"
    comment = (await thread(db, task["id"]))["messages"][-1]
    assert comment["author"]["id"] == "scribe" and comment["body"].startswith("## 2.4")
    # It looked first, then worked from what it was told and what it found.
    assert "Draft the 2.4 changelog" in model.prompts[0]
    assert "Keep it short." in model.prompts[1] and "lists every merged PR" in model.prompts[1]


async def test_a_task_that_needs_a_person_stops_and_asks_on_the_task(db):
    _, out = await call(db, "tasks.propose", title="Sync the retry ceiling", criteria=["one number"])
    await call(db, "tasks.hand", task_id=out["task"]["id"], agent_id="scribe")
    model = Model("The workspace does not say which number wins.",
                  '{"work": "", "criteria_met": [], "question": "D-12 says 3, the code 5 — which wins?"}')

    done = await runner(db, model).once()

    assert done[0]["status"] == "asking"
    _, got = await call(db, "tasks.get", task_id=out["task"]["id"])
    assert got["task"]["question"]["text"] == "D-12 says 3, the code 5 — which wins?"
    assert got["task"]["state"] == "flight"


async def test_a_direct_ask_is_answered_where_it_was_about_naming_who_asked(db):
    await call(db, "agents.ask", agent_id="scribe", object_id="doc-1", note="Is this spec current?")
    await call(db, "agents.ask", "rhea", agent_id="scribe", note="What can you do for me?")
    model = Model("It was last verified against the handler on the 12th.",
                  "I answer questions about docs and file changes to them.")

    await runner(db, model).once()

    on_doc = (await thread(db, "doc-1"))["messages"][-1]
    assert on_doc["body"].startswith("@maya It was last verified")
    assert [m["id"] for m in on_doc["mentions"]] == ["maya"]
    on_self = (await thread(db, "scribe"))["messages"][-1]
    assert on_self["body"].startswith("@rhea I answer questions")


async def test_a_model_that_fails_is_said_and_a_handed_task_goes_back(db):
    await call(db, "messages.post", subject_id="doc-1", body="@scribe anything?")
    _, out = await call(db, "tasks.propose", title="Tidy the runbook", criteria=["one page"])
    await call(db, "tasks.hand", task_id=out["task"]["id"], agent_id="scribe")

    done = await runner(db, Model(fails=True)).once()

    assert sorted(d["status"] for d in done) == ["blocked", "blocked"]
    said = (await thread(db, "doc-1"))["messages"][-1]
    assert said["author"]["id"] == "scribe" and "did not respond" in said["body"]
    _, got = await call(db, "tasks.get", task_id=out["task"]["id"])
    assert got["task"]["state"] == "ready" and got["task"]["assignee"] is None


async def test_a_reply_never_asks_another_agent_and_an_ask_is_answered_once(db):
    await call(db, "messages.post", subject_id="doc-1", body="@scribe who owns this?")
    first = runner(db, Model("Ask @triage — or @maya, who wrote it."))
    await first.once()
    reply = (await thread(db, "doc-1"))["messages"][-1]
    assert reply["body"] == "Ask triage — or @maya, who wrote it."
    assert await db.fetchval("select count(*) from events where verb = 'asked'"
                             " and payload->>'agent' = 'triage'") == 0
    # A second runner finds nothing left: the run already answers it.
    assert await runner(db, Model()).once() == []


async def test_a_mention_is_answered_from_what_the_agent_found_in_the_workspace(db):
    from commonindex.workers.indexer import index_object

    await db.execute("update objects set props = $1::jsonb where id = 'doc-1'", json.dumps({
        "title": "Refund spec", "body": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Refunds retry three times."}]}]}}))
    await index_object(db, "doc-1")
    await call(db, "messages.post", subject_id="doc-1", body="@scribe how many times do we retry?")
    model = Model(json.dumps({"search": "retry"}), json.dumps({"read": "doc-1"}),
                  json.dumps({"answer": "Three times.", "cite": ["doc-1"]}))

    await runner(db, model).once()

    reply = (await thread(db, "doc-1"))["messages"][-1]
    assert reply["author"]["id"] == "scribe"
    assert reply["body"] == "Three times.\n\nSources: D-1 Refund spec"
    # It was shown what it read.
    assert any("Refunds retry three times." in p for p in model.prompts)


def test_an_empty_answer_says_what_the_agent_can_see():
    """Told to say "nothing I can see", a 9B model still wrote "the only
    document in the workspace is…" about the 4 of 22 docs shared with it — so
    the runner says the scope itself, as a fact, under any answer that came up
    empty, and leaves every other answer alone."""
    from commonindex.reference_agent import scoped

    empty = "I searched for a document containing tables, but I cannot find one."
    assert scoped(empty, 4).endswith(
        "I can only see what is shared with me (4 docs). If you mean a private doc, "
        "share it with the workspace and ask again.")
    assert scoped("The workspace does not say which number wins.", 1).count("(1 doc)") == 1
    assert scoped("Three times, then on-call is paged.", 4) == "Three times, then on-call is paged."
