"""Answering from the workspace by searching it, several times.

The model is given search and read and a step budget, and must answer only
from what it read. What is defended: it can search, read what it found, search
again with the words it learned, and answer; a citation it did not see is
dropped; prose instead of an action is taken as its answer; when the steps run
out it is asked to answer with what it has; and the reply parser finds the
action however much prose surrounds it.
"""

from __future__ import annotations

import json

from commonindex.core.retrieval.ask import action_in, ask, read_note, search_note


class Script:
    """A model that says what it is told to, in order, and keeps what it was shown."""

    def __init__(self, *replies):
        self.replies, self.shown = list(replies), []

    async def complete(self, messages, *, max_tokens=900, require_finished=False):
        self.shown.append(messages[-1]["content"])
        return self.replies.pop(0)


class Workspace:
    def __init__(self):
        self.searched, self.read_ids = [], []

    async def search(self, q, **filters):
        self.searched.append((q, filters))
        if "retry" in q:
            return {"hits": [{"kind": "object", "type": "doc", "id": "doc-1", "key": "DOC-1",
                              "title": "Refund spec", "snippet": "Refunds «retry» three times"}],
                    "more": False}
        return {"hits": [], "more": False}

    async def read(self, item_id):
        self.read_ids.append(item_id)
        if item_id != "doc-1":
            return None
        return {"id": "doc-1", "type": "doc", "key": "DOC-1", "title": "Refund spec",
                "updated_at": "2026-09-20T00:00:00Z",
                "sections": [{"heading": "Refund spec › Retries", "text": "EU waits 5 minutes"}],
                "comments": [], "links": []}


def act(**kw):
    return json.dumps(kw)


async def test_it_searches_learns_the_words_reads_and_answers_from_what_it_read():
    model = Script(act(search="how often do refunds get resubmitted"),   # the asker's words: nothing
                   act(search="refund retry"),                          # the workspace's words
                   act(read="doc-1"),
                   act(answer="Three times; the EU waits 5 minutes between tries.", cite=["doc-1", "made-up"]))
    ws = Workspace()
    answer = await ask("How often are refunds resubmitted?", model, ws)
    assert answer.text.startswith("Three times")
    # Only what it saw can be cited.
    assert answer.citations == [{"id": "doc-1", "type": "doc", "key": "DOC-1", "title": "Refund spec"}]
    assert [(s.kind, s.detail, s.found) for s in answer.steps] == [
        ("search", "how often do refunds get resubmitted", 0), ("search", "refund retry", 1),
        ("read", "doc-1", 1)]
    assert answer.steps[-1].label == "DOC-1 Refund spec"   # named, for the person watching
    # It was told the first search found nothing, and shown what it read.
    assert "Nothing matched" in model.shown[1] and "EU waits 5 minutes" in model.shown[3]


async def test_filters_reach_the_search():
    ws = Workspace()
    await ask("q", Script(act(search="retry", types=["doc"], since="2026-09-01"), act(answer="ok")), ws)
    assert ws.searched == [("retry", {"types": ["doc"], "since": "2026-09-01"})]


async def test_prose_instead_of_an_action_is_its_answer():
    answer = await ask("q", Script("I don't need to search: it's Tuesday."), Workspace())
    assert answer.text == "I don't need to search: it's Tuesday." and answer.citations == []


async def test_out_of_steps_it_answers_with_what_it_has():
    model = Script(act(search="retry"), act(search="retry again"), act(answer="From what I read: three.", cite=["doc-1"]))
    answer = await ask("q", model, Workspace(), steps=2)
    assert answer.text == "From what I read: three." and answer.citations[0]["id"] == "doc-1"
    assert "last step" in model.shown[-1]


def test_the_action_is_found_among_prose_and_braces():
    assert action_in('Sure — {"search": "refund"} is next.') == {"search": "refund"}
    assert action_in('{"answer": "use {curly} braces", "cite": []}')["answer"] == "use {curly} braces"
    assert action_in("no action here") is None
    assert action_in('{not json} then {"read": "doc-1"}') == {"read": "doc-1"}


def test_what_the_model_is_shown():
    note = search_note("retry", {"hits": [
        {"kind": "message", "id": "m1", "snippet": "the «retry» ceiling", "at": "2026-09-26T10:00:00Z",
         "author": {"name": "Maya"}, "subject": {"id": "ch-1", "type": "channel", "title": "refund-incidents"}}],
        "more": True})
    assert "m1 message by Maya in [channel] refund-incidents" in note and "conversation id ch-1" in note
    assert "the retry ceiling" in note and "more exist" in note
    assert "No item 'x'" in read_note("x", None)


def test_a_note_says_what_each_kind_of_result_is():
    note = search_note("refund", {"hits": [
        {"kind": "code", "type": "code_file", "id": "code_file-1", "key": None, "title": "refunds/retry.py",
         "repo": "example/payments", "lines": [10, 12], "snippet": "MAX_«REFUND»_RETRIES = 3"},
        {"kind": "metric", "type": "metric", "id": "refund_rate", "key": None, "title": "Refund rate",
         "status": "ratified", "used_on": [{"id": "dash-1", "title": "Two warehouses"}],
         "snippet": "Share of orders «refunded»"},
        {"kind": "run", "type": "run", "id": "run-1", "key": None, "title": "Scribe", "status": "done",
         "at": "2026-09-27T10:00:00+00:00", "agent": {"id": "scribe", "name": "Scribe"},
         "asked_by": {"name": "Maya"}, "snippet": "Why did the «refund» rate jump?"},
        {"kind": "history", "type": "doc", "id": "doc-2", "key": "D-2", "title": "Retry policy",
         "at": "2026-09-20T00:00:00+00:00", "snippet": "«Refunds» retry five times"}]})
    assert "- code_file-1 code refunds/retry.py in example/payments, lines 10-12: MAX_REFUND_RETRIES = 3" in note
    assert "- refund_rate [metric] Refund rate (ratified), charted on Two warehouses: Share of orders refunded" in note
    assert "- run-1 run by Scribe (done, 2026-09-27), asked by Maya: Why did the refund rate jump?" in note
    assert "- doc-2 [doc D-2] Retry policy said this until 2026-09-20, and no longer does: Refunds retry five times" in note


def test_a_read_says_what_the_item_said_before_its_edits():
    note = read_note("doc-2", {"id": "doc-2", "type": "doc", "key": "D-2", "title": "Retry policy",
                               "updated_at": "2026-09-27T00:00:00Z", "sections": [], "comments": [], "links": [],
                               "history": [{"heading": "Retry policy", "text": "Refunds retry five times",
                                            "until": "2026-09-20T00:00:00+00:00"}]})
    assert "What it said before its last edits:\n- until 2026-09-20, Retry policy: Refunds retry five times" in note


async def test_a_run_is_cited_as_the_agent_that_ran_it():
    class Runs:
        async def search(self, q, **filters):
            return {"hits": [{"kind": "run", "type": "run", "id": "run-1", "key": None, "title": "Scribe",
                              "status": "done", "agent": {"id": "scribe", "name": "Scribe"}, "snippet": "…"}]}

        async def read(self, item_id):
            return None

    model = Script(act(search="refund jump"), act(answer="Scribe looked into it.", cite=["run-1"]))
    answer = await ask("Who looked at the refund jump?", model, Runs())
    assert answer.citations == [{"id": "scribe", "type": "agent", "key": None, "title": "Scribe"}]


def test_an_empty_search_is_told_as_what_the_asker_can_see_not_the_whole_workspace():
    """Search covers only what is shared with whoever asks. An agent with 4 of
    22 docs answered "the workspace does not contain a document with tables"
    when two did — true of what it could see, false as said."""
    from commonindex.core.retrieval.ask import SYSTEM

    assert "nothing YOU CAN SEE says it" in SYSTEM
    assert "never that the workspace has no such thing" in SYSTEM
    assert "If the workspace does not say, answer that it does not say" not in SYSTEM
