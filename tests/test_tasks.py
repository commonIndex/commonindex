"""The board's backend, against a real database.

What is worth defending is the set of rules that make a board with agents on it
different from a kanban board — each one here is a test, because each one is a
shortcut somebody will reach for:

* state moves only through a verb, never by writing the field;
* no agent takes a task whose definition of done is not written down;
* handing work to an agent is an ask it reads in its own inbox, and the run it
  starts is the run the board shows;
* the one who did the work does not accept it;
* every step is a revision, and a retry answers instead of refusing.
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
        insert into actors (id, kind, display) values
            ('rhea', 'human', 'Rhea'), ('vic', 'human', 'Vic');
        insert into grants (id, subject, relation, resource, granted_by) values
            ('g-maya', 'maya', 'admin', 'space:pay', 'maya'),
            ('g-rhea', 'rhea', 'merge', 'space:pay', 'maya'),
            ('g-vic', 'vic', 'read', 'space:pay', 'maya'),
            ('g-scribe', 'scribe', 'propose', 'space:pay', 'maya');
    """)
    try:
        yield conn
    finally:
        await conn.close()


class _PoolOf:
    """One connection wearing a pool's interface — the handlers acquire, the
    test holds a single connection so its writes are visible to its reads."""

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


async def call(db, verb, actor="maya", **body):
    """(status, payload) for one verb, with a fresh idempotency key unless the
    test is exercising the key itself."""
    from commonindex.gateway import agents, tasks

    handler = (getattr(tasks, f"tasks_{verb}", None) or getattr(agents, verb.replace(".", "_")))
    body.setdefault("idempotencyKey", f"k-{next(_KEYS)}")
    out = await handler(_Req(body, db, actor))
    if hasattr(out, "status_code"):
        return out.status_code, json.loads(out.body)
    return 200, out


async def filed(db, actor="maya", criteria=("the numbers match",), **over):
    status, out = await call(db, "propose", actor, title="Sync the retry ceiling",
                             criteria=list(criteria), **over)
    assert status == 200, out
    return out["task"]


async def kinds(db, task_id):
    rows = await db.fetch("select delta->>'kind' k from revisions where object_id = $1"
                          " order by rev", task_id)
    return [r["k"] for r in rows]


# ── filing ────────────────────────────────────────────────────────────────


async def test_a_task_is_filed_ready_with_a_key_and_a_first_revision(db):
    status, out = await call(db, "propose", title="  Document the idempotency contract ",
                             criteria=["covers retries", "covers retries", "  ", "cites D-12"],
                             idempotencyKey="file-1")
    task = out["task"]
    assert status == 200 and out["created"] is True
    assert task["state"] == "ready" and task["assignee"] is None
    assert task["title"] == "Document the idempotency contract"
    assert task["key"].startswith("T-") and task["origin"] == "filed"
    # Blank lines dropped, a repeated check kept once.
    assert [c["text"] for c in task["criteria"]] == ["covers retries", "cites D-12"]
    assert await kinds(db, task["id"]) == ["create"]

    again = await call(db, "propose", title="whatever", idempotencyKey="file-1")
    assert again[1]["created"] is False and again[1]["task"]["id"] == task["id"]


async def test_an_agent_files_a_task_as_triggered(db):
    task = await filed(db, actor="scribe")
    assert task["origin"] == "triggered"


async def test_state_is_moved_by_verbs_never_written(db):
    status, out = await call(db, "propose", title="Done already", state="done")
    assert status == 422 and out["error"]["code"] == "governed_field"
    task = await filed(db)
    status, out = await call(db, "revise", task_id=task["id"], assignee="maya")
    assert status == 422 and out["error"]["field"] == "assignee"


# ── a person's work ───────────────────────────────────────────────────────


async def test_a_person_starts_files_and_someone_else_accepts(db):
    task = await filed(db, criteria=("every spec states the same number", "each edit cites #341"))
    _, out = await call(db, "start", task_id=task["id"])
    assert out["task"]["state"] == "flight" and out["task"]["assignee"]["id"] == "maya"

    _, out = await call(db, "submit", task_id=task["id"], criteria_met=[True, False],
                        produced={"label": "9 spec edits", "object_id": "doc-1"},
                        note="one spec still cites the old number")
    task = out["task"]
    assert task["state"] == "review"
    assert [c["met"] for c in task["criteria"]] == [True, False]
    assert task["produced"]["object_id"] == "doc-1"
    assert task["review"]["submitted_by"]["id"] == "maya"

    # The one who did it does not accept it.
    status, out = await call(db, "accept", task_id=task["id"], if_rev=task["rev"])
    assert status == 403 and out["error"]["code"] == "own_work"

    _, out = await call(db, "accept", "rhea", task_id=task["id"], if_rev=task["rev"])
    assert out["task"]["state"] == "done"
    assert out["task"]["review"]["decided_by"]["id"] == "rhea"
    assert await kinds(db, task["id"]) == ["create", "start", "submit", "accept"]


async def test_filing_answers_every_criterion(db):
    task = await filed(db, criteria=("a", "b"))
    await call(db, "start", task_id=task["id"])
    for met in (None, [True], [True, None], "yes"):
        status, out = await call(db, "submit", task_id=task["id"], criteria_met=met)
        assert status == 422 and out["error"]["code"] == "unanswered_criteria", met


async def test_only_the_one_working_it_files_it(db):
    task = await filed(db)
    await call(db, "start", task_id=task["id"])
    status, out = await call(db, "submit", "rhea", task_id=task["id"], criteria_met=[True])
    assert status == 403 and out["error"]["code"] == "not_yours"


async def test_an_admin_accepts_their_own_work_only_by_saying_why(db):
    task = await filed(db)
    await call(db, "start", task_id=task["id"])
    _, out = await call(db, "submit", task_id=task["id"], criteria_met=[True])
    rev = out["task"]["rev"]
    status, out = await call(db, "accept", task_id=task["id"], if_rev=rev, self_accept=True)
    assert status == 422 and out["error"]["code"] == "reason_required"
    _, out = await call(db, "accept", task_id=task["id"], if_rev=rev, self_accept=True,
                        note="only reviewer is out this week")
    assert out["task"]["state"] == "done" and out["task"]["review"]["self_accepted"] is True


async def test_rhea_who_is_no_admin_cannot_accept_her_own(db):
    task = await filed(db, actor="rhea")
    await call(db, "start", "rhea", task_id=task["id"])
    _, out = await call(db, "submit", "rhea", task_id=task["id"], criteria_met=[True])
    status, out = await call(db, "accept", "rhea", task_id=task["id"], if_rev=out["task"]["rev"],
                             self_accept=True, note="trust me")
    assert status == 403 and out["error"]["field"] == "self_accept"


async def test_an_acceptance_is_for_the_revision_that_was_read(db):
    task = await filed(db)
    await call(db, "start", task_id=task["id"])
    _, out = await call(db, "submit", task_id=task["id"], criteria_met=[True])
    status, body = await call(db, "accept", "rhea", task_id=task["id"])
    assert status == 422 and body["error"]["code"] == "missing_if_rev"
    status, body = await call(db, "accept", "rhea", task_id=task["id"],
                              if_rev=out["task"]["rev"] - 1)
    assert status == 409 and body["error"]["code"] == "stale_revision"


async def test_a_task_moves_only_along_the_board(db):
    task = await filed(db)
    status, out = await call(db, "submit", task_id=task["id"], criteria_met=[True])
    assert status == 409 and out["error"]["code"] == "wrong_state"
    assert "ready" in out["error"]["message"]
    status, _ = await call(db, "accept", "rhea", task_id=task["id"], if_rev=task["rev"])
    assert status == 409


async def test_the_assignee_or_a_merger_gives_it_back(db):
    task = await filed(db, actor="rhea")
    await call(db, "start", "rhea", task_id=task["id"])
    status, out = await call(db, "release", "scribe", task_id=task["id"])
    assert status == 403 and out["error"]["code"] == "not_yours"
    _, out = await call(db, "release", "maya", task_id=task["id"], note="reassigning")
    assert out["task"]["state"] == "ready" and out["task"]["assignee"] is None


async def test_a_retry_answers_instead_of_refusing(db):
    task = await filed(db)
    first = await call(db, "start", task_id=task["id"], idempotencyKey="go")
    again = await call(db, "start", task_id=task["id"], idempotencyKey="go")
    assert again[0] == 200 and again[1]["already"] is True
    assert again[1]["rev"] == first[1]["rev"]
    # A different key is a different request, and the task has already moved.
    status, _ = await call(db, "start", task_id=task["id"], idempotencyKey="go-again")
    assert status == 409


# ── handing work to an agent ──────────────────────────────────────────────


async def test_no_agent_takes_a_task_without_a_definition_of_done(db):
    bare = await filed(db, criteria=())
    status, out = await call(db, "hand", task_id=bare["id"], agent_id="scribe")
    assert status == 422 and out["error"]["code"] == "no_criteria"
    status, out = await call(db, "start", "scribe", task_id=bare["id"])
    assert status == 422 and out["error"]["code"] == "not_agent_ready"
    assert bare["agent_ready"] is False and "definition of done" in bare["not_agent_ready"]

    people = await filed(db, human_only="talking to support leads")
    status, out = await call(db, "hand", task_id=people["id"], agent_id="scribe")
    assert status == 422 and out["error"]["code"] == "needs_a_person"

    # A person can still take either.
    status, _ = await call(db, "start", task_id=bare["id"])
    assert status == 200


async def test_an_agent_with_no_grant_here_cannot_be_handed_work(db):
    task = await filed(db)
    status, out = await call(db, "hand", task_id=task["id"], agent_id="triage")
    assert status == 422 and out["error"]["code"] == "agent_cannot_file"
    status, out = await call(db, "hand", task_id=task["id"], agent_id="rhea")
    assert status == 404 and out["error"]["code"] == "unknown_agent"


async def test_handing_over_is_an_ask_the_agent_reads_and_the_run_the_board_shows(db):
    task = await filed(db, criteria=("every spec states the same number",))
    _, out = await call(db, "hand", task_id=task["id"], agent_id="scribe", note="D-12 wins")
    handed = out["task"]
    assert handed["state"] == "flight" and handed["assignee"]["id"] == "scribe"
    assert handed["asked"] is True and handed["run"] is None

    # The agent's own inbox has it, with the definition of done in the note.
    _, inbox = await call(db, "agents.inbox", "scribe")
    ask = next(a for a in inbox["asks"] if (a["object"] or {}).get("id") == task["id"])
    assert "every spec states the same number" in ask["note"] and "D-12 wins" in ask["note"]

    await call(db, "runs.start", "scribe", trigger_seq=ask["seq"])
    _, board = await call(db, "list")
    shown = next(t for t in board["tasks"] if t["id"] == task["id"])
    assert shown["asked"] is False and shown["run"]["status"] == "running"
    assert board["running"] == 1


async def test_an_agent_that_stops_to_ask_is_answered_and_asked_again(db):
    task = await filed(db)
    _, out = await call(db, "hand", task_id=task["id"], agent_id="scribe")
    first_seq = await db.fetchval("select (props->>'ask_seq')::bigint from objects where id = $1",
                                  task["id"])
    _, out = await call(db, "question", "scribe", task_id=task["id"],
                        question="D-12 says 3 retries and the code says 5 — which wins?")
    assert out["task"]["question"]["by"]["id"] == "scribe"
    status, _ = await call(db, "question", "scribe", task_id=task["id"], question="and?")
    assert status == 409

    status, body = await call(db, "answer", "scribe", task_id=task["id"], answer="5")
    assert status == 422 and body["error"]["code"] == "own_question"
    _, out = await call(db, "answer", task_id=task["id"], answer="The code — D-12 is stale.")
    assert out["task"]["question"] is None
    seq = await db.fetchval("select (props->>'ask_seq')::bigint from objects where id = $1",
                            task["id"])
    assert seq != first_seq
    note = await db.fetchval("select payload->>'note' from events where seq = $1"
                             " and space_id = 'pay'", seq)
    assert "which wins?" in note and "D-12 is stale" in note


async def test_work_sent_back_needs_a_reason_and_reaches_the_agent(db):
    task = await filed(db)
    await call(db, "hand", task_id=task["id"], agent_id="scribe")
    _, out = await call(db, "submit", "scribe", task_id=task["id"], criteria_met=[False])
    status, body = await call(db, "send_back", "rhea", task_id=task["id"])
    assert status == 422 and body["error"]["code"] == "reason_required"

    _, out = await call(db, "send_back", "rhea", task_id=task["id"],
                        note="Two specs still say 3.")
    assert out["task"]["state"] == "flight" and out["task"]["assignee"]["id"] == "scribe"
    assert out["task"]["review"]["decision"] == "sent_back"
    _, inbox = await call(db, "agents.inbox", "scribe")
    assert any("Two specs still say 3." in a["note"] for a in inbox["asks"])


async def test_an_agent_working_it_keeps_its_definition_of_done(db):
    task = await filed(db)
    await call(db, "hand", task_id=task["id"], agent_id="scribe")
    status, out = await call(db, "revise", task_id=task["id"], criteria=[])
    assert status == 409 and out["error"]["code"] == "agent_working"
    # Rewording a criterion is fine; its answer is dropped because the check changed.
    status, out = await call(db, "revise", task_id=task["id"], criteria=["the numbers agree"])
    assert status == 200 and out["task"]["criteria"] == [{"text": "the numbers agree", "met": None}]


async def test_routes_say_who_could_take_it_and_why(db):
    task = await filed(db)
    _, out = await call(db, "get", task_id=task["id"])
    routes = {r["agent"]["id"]: r for r in out["task"]["routes"]}
    assert routes["scribe"]["can"] is True and routes["scribe"]["needs"] is None
    assert routes["triage"]["can"] is False and routes["triage"]["needs"] == "propose"
    assert "no grant" in routes["triage"]["why"]

    bare = await filed(db, criteria=())
    _, out = await call(db, "get", task_id=bare["id"])
    assert not any(r["can"] for r in out["task"]["routes"])


# ── the board ─────────────────────────────────────────────────────────────


async def test_the_board_counts_what_waits_on_people(db):
    waiting = await filed(db)
    await call(db, "start", task_id=waiting["id"])
    await call(db, "submit", task_id=waiting["id"], criteria_met=[True])
    await filed(db)
    # Filed for review three days ago.
    await db.execute("update objects set props = jsonb_set(props, '{moved_at}',"
                     " to_jsonb((now() - interval '3 days')::text)) where id = $1",
                     waiting["id"])
    _, board = await call(db, "list", "rhea")
    assert board["counts"] == {"ready": 1, "flight": 0, "review": 1, "done": 0}
    assert board["review_oldest_s"] >= 3 * 86400 - 60
    shown = next(t for t in board["tasks"] if t["id"] == waiting["id"])
    assert shown["you"]["may_accept"] is True and shown["you"]["may_submit"] is False
    assert board["you"]["may"] == {"propose": True, "merge": True, "admin": False}

    _, only = await call(db, "list", state="review")
    assert [t["id"] for t in only["tasks"]] == [waiting["id"]]


async def test_links_are_edges_and_show_on_the_task(db):
    task = await filed(db)
    _, out = await call(db, "link", task_id=task["id"], object_id="doc-1", rel="depends")
    assert out["task"]["links"] == [{"rel": "depends", "object": {
        "id": "doc-1", "type": "doc", "key": "D-1", "title": "Refund spec"}}]
    status, out = await call(db, "link", task_id=task["id"], object_id="doc-1", rel="owns")
    assert status == 422
    status, out = await call(db, "link", task_id=task["id"], object_id="nope", rel="caused")
    assert status == 404
    _, out = await call(db, "unlink", task_id=task["id"], object_id="doc-1", rel="depends")
    assert out["task"]["links"] == []
    _, got = await call(db, "get", task_id=task["id"])
    assert [h["kind"] for h in got["task"]["history"]][:2] == ["unlink", "link"]


async def test_taking_a_task_off_the_board_leaves_a_tombstone(db):
    task = await filed(db, idempotencyKey="to-delete")
    status, out = await call(db, "delete", "scribe", task_id=task["id"])
    assert status == 403
    _, out = await call(db, "delete", "rhea", task_id=task["id"])
    assert out["deleted"] is True
    _, board = await call(db, "list")
    assert task["id"] not in {t["id"] for t in board["tasks"]}
    assert await db.fetchval("select count(*) from revisions where object_id = $1",
                             task["id"]) == 1
    status, out = await call(db, "propose", title="again", idempotencyKey="to-delete")
    assert status == 409 and out["error"]["code"] == "key_spent"


async def test_giving_a_task_back_withdraws_the_ask_its_agent_had_not_started(db):
    """Left in the inbox, the agent would claim work that is no longer its own."""
    task = await filed(db)
    await call(db, "hand", task_id=task["id"], agent_id="scribe")
    seq = await db.fetchval("select (props->>'ask_seq')::bigint from objects where id = $1", task["id"])
    await call(db, "release", task_id=task["id"])

    _, inbox = await call(db, "agents.inbox", "scribe")
    assert all((a["object"] or {}).get("id") != task["id"] for a in inbox["asks"])
    status, out = await call(db, "runs.start", "scribe", trigger_seq=seq)
    assert status == 409 and out["error"]["code"] == "withdrawn"
    # Withdrawn by a later event, not erased: the log keeps both.
    assert await db.fetchval("select count(*) from events where object_id = $1"
                             "   and verb in ('asked', 'withdrawn')", task["id"]) == 2


async def test_an_answered_question_replaces_the_ask_rather_than_adding_one(db):
    task = await filed(db)
    await call(db, "hand", task_id=task["id"], agent_id="scribe")
    await call(db, "question", "scribe", task_id=task["id"], question="which number?")
    await call(db, "answer", task_id=task["id"], answer="five")
    _, inbox = await call(db, "agents.inbox", "scribe")
    mine = [a for a in inbox["asks"] if (a["object"] or {}).get("id") == task["id"]]
    assert len(mine) == 1 and "five" in mine[0]["note"]


async def test_an_ask_already_started_is_left_to_its_run(db):
    task = await filed(db)
    await call(db, "hand", task_id=task["id"], agent_id="scribe")
    seq = await db.fetchval("select (props->>'ask_seq')::bigint from objects where id = $1", task["id"])
    await call(db, "runs.start", "scribe", trigger_seq=seq)
    await call(db, "release", task_id=task["id"])
    assert await db.fetchval("select count(*) from events where object_id = $1"
                             "   and verb = 'withdrawn'", task["id"]) == 0
    # And the run cannot file work for a task it no longer holds.
    status, _ = await call(db, "submit", "scribe", task_id=task["id"], criteria_met=[True])
    assert status == 409


async def test_the_work_about_a_thing_is_found_from_the_thing(db):
    came, touches, elsewhere = await filed(db), await filed(db), await filed(db)
    await call(db, "link", task_id=came["id"], object_id="doc-1", rel="caused")
    await call(db, "link", task_id=touches["id"], object_id="doc-1", rel="touches")
    await call(db, "link", task_id=touches["id"], object_id="doc-1", rel="depends")
    _, out = await call(db, "linked", object_id="doc-1")
    got = {t["id"]: sorted(t["rel"]) for t in out["tasks"]}
    assert got == {came["id"]: ["caused"], touches["id"]: ["depends", "touches"]}
    assert elsewhere["id"] not in got and out["total"] == 2
    # A deleted task is no longer the work about anything.
    await call(db, "delete", task_id=came["id"])
    _, out = await call(db, "linked", object_id="doc-1")
    assert [t["id"] for t in out["tasks"]] == [touches["id"]]


# ── assigning ─────────────────────────────────────────────────────────────


async def test_a_ready_task_is_assigned_to_a_person_and_stays_ready(db):
    task = await filed(db)
    _, out = await call(db, "assign", task_id=task["id"], assignee_id="rhea")
    assigned = out["task"]
    assert assigned["assignee"]["id"] == "rhea" and assigned["state"] == "ready"
    # Who it is for starts it; it is theirs.
    _, out = await call(db, "start", "rhea", task_id=task["id"])
    assert out["task"]["state"] == "flight" and out["task"]["assignee"]["id"] == "rhea"
    # Unassigning an in-progress task is giving it back, not this.
    status, out = await call(db, "assign", task_id=task["id"], assignee_id=None)
    assert status == 422 and out["error"]["code"] == "use_release"


async def test_someone_who_cannot_work_here_is_not_assigned(db):
    task = await filed(db)
    status, out = await call(db, "assign", task_id=task["id"], assignee_id="vic")
    assert status == 422 and out["error"]["code"] == "cannot_work_here"
    status, out = await call(db, "assign", task_id=task["id"], assignee_id="nobody")
    assert status == 404


async def test_assigning_an_agent_is_handing_it_over(db):
    task = await filed(db, criteria=("every spec states the same number",))
    _, out = await call(db, "assign", task_id=task["id"], assignee_id="scribe")
    assert out["task"]["state"] == "flight" and out["task"]["asked"] is True
    _, inbox = await call(db, "agents.inbox", "scribe")
    assert any((a["object"] or {}).get("id") == task["id"] for a in inbox["asks"])
    # Passing it to a person withdraws the ask it never started.
    _, out = await call(db, "assign", task_id=task["id"], assignee_id="rhea")
    assert out["task"]["assignee"]["id"] == "rhea" and out["task"]["asked"] is False
    _, inbox = await call(db, "agents.inbox", "scribe")
    assert not any((a["object"] or {}).get("id") == task["id"] for a in inbox["asks"])


async def test_an_agent_is_not_assigned_work_it_could_not_check(db):
    task = await filed(db, criteria=())
    status, out = await call(db, "assign", task_id=task["id"], assignee_id="scribe")
    assert status == 422 and out["error"]["code"] == "no_criteria"


async def test_work_in_progress_changes_hands_only_from_its_assignee_or_a_merger(db):
    task = await filed(db)
    await call(db, "start", "rhea", task_id=task["id"])
    await db.execute("insert into grants (id, subject, relation, resource, granted_by)"
                     " values ('g-vic2', 'vic', 'propose', 'space:pay', 'maya')")
    status, out = await call(db, "assign", "vic", task_id=task["id"], assignee_id="vic")
    assert status == 403 and out["error"]["code"] == "not_yours"
    _, out = await call(db, "assign", "rhea", task_id=task["id"], assignee_id="maya")
    assert out["task"]["assignee"]["id"] == "maya" and out["task"]["state"] == "flight"
    assert await kinds(db, task["id"]) == ["create", "start", "assign"]



async def test_work_in_progress_is_handed_to_an_agent_by_whoever_may_pass_it_on(db):
    task = await filed(db, criteria=("the numbers match",))
    await call(db, "start", "rhea", task_id=task["id"])
    _, out = await call(db, "assign", "rhea", task_id=task["id"], assignee_id="scribe")
    assert out["task"]["assignee"]["id"] == "scribe" and out["task"]["asked"] is True
    assert await kinds(db, task["id"]) == ["create", "start", "release", "hand"]
