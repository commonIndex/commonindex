from __future__ import annotations

import json

from commonindex.core.ops import Registry
from commonindex.core.retrieval.ops import register
from commonindex.gateway.access import RESOURCE
from commonindex.gateway.app import (
    _answer_and_diagram,
    _context_pack,
    _evidence_note,
    _valid_flow,
)
from commonindex.workers.codecontext import split_code
from commonindex.workers.codequery import _acl_keys
from commonindex.workers.connectors import Record
from commonindex.workers.connectors.git import RepoRef


def test_code_chunks_keep_complete_lines_and_citations():
    chunks = split_code("one\ntwo\nthree\n", max_chars=8)

    assert [(chunk.body, chunk.start_line, chunk.end_line) for chunk in chunks] == [
        ("one\ntwo\n", 1, 2), ("three\n", 3, 3),
    ]


def test_code_chunker_keeps_one_oversized_line_together():
    chunks = split_code("x" * 20 + "\n", max_chars=8)

    assert len(chunks) == 1
    assert chunks[0].start_line == chunks[0].end_line == 1


def test_code_operations_are_exposed_to_mcp_from_the_registry():
    registry = Registry()
    register(registry)

    assert {"code.query", "code.get_file", "code.context", "code.ask"} <= {
        operation.name for operation in registry.all()
    }


def test_diagram_is_data_not_model_authored_markup():
    flow = _valid_flow({
        "title": "Index flow",
        "nodes": [{"id": "pull", "label": "Pull", "kind": "worker"},
                  {"id": "search", "label": "Search", "kind": "api"}],
        "edges": [{"from": "pull", "to": "search", "label": "indexes"}],
    })

    assert flow is not None and flow["nodes"][0]["label"] == "Pull"
    assert _valid_flow({"title": "bad", "nodes": [], "edges": []}) is None


def test_diagram_response_falls_back_safely_when_a_small_model_ignores_json():
    answer, diagram = _answer_and_diagram("plain answer", want_diagram=True)

    assert answer == "plain answer" and diagram is None


def test_a_model_that_fences_its_json_is_still_honouring_the_contract():
    """Observed on the first real `include_diagram` call, from
    qwen2.5-coder:1.5b: the JSON came back inside ```json. Read as a refusal, the
    reader got a block of JSON where the answer belonged and the diagram the
    model *did* return was thrown away."""
    answer, diagram = _answer_and_diagram(
        '```json\n{"answer": "It starts in checkout.py.",'
        ' "diagram": {"title": "t", "nodes": [{"id": "a", "label": "A"}], "edges": []}}\n```',
        want_diagram=True)

    assert answer == "It starts in checkout.py."
    assert diagram is not None and diagram["nodes"][0]["label"] == "A"


def test_prose_around_a_fenced_answer_does_not_defeat_it():
    answer, _ = _answer_and_diagram(
        'Sure — here is the JSON:\n\n```\n{"answer": "One row per file.", "diagram": null}\n```',
        want_diagram=True)

    assert answer == "One row per file."


def test_a_fence_that_is_not_json_is_still_just_the_answer():
    """The fallback has to survive the fence being part of the prose — a code
    example in an answer is the normal case, not a malformed contract."""
    raw = 'The handler is:\n\n```python\ndef place_order():\n    pass\n```'
    answer, diagram = _answer_and_diagram(raw, want_diagram=True)

    assert answer == raw and diagram is None


def _result(hits, **kw):
    base = {"query": "q", "hits": hits, "engine": "zoekt", "searched_repos": ["a/b"],
            "selected_repos": [{"repo": "a/b", "files": 1, "score": 1.0}],
            "unindexed_repos": [], "unknown_repos": [], "withheld_repos": 0,
            "routing": "r", "degraded": None, "truncated": False}
    return {**base, **kw}


def test_the_context_pack_keeps_the_two_reasons_for_seeing_less_apart():
    """"It did not fit the budget" and "it was outside the repositories you
    named" are different facts with different fixes, and a single `withheld`
    count conflates them."""
    pack = _context_pack(_result(
        [{"snippet": "x" * 100, "citation": "a/b/f.py:L1-L2"},
         {"snippet": "y" * 100, "citation": "a/b/g.py:L1-L2"}],
        withheld_repos=3), max_chars=100)

    assert len(pack["context"]) == 1
    assert pack["withheld"] == 1          # our character budget
    assert pack["withheld_repos"] == 3    # the caller's own repo filter


def test_repos_outside_the_question_are_not_reported_to_the_model_as_unreadable():
    """`withheld_repos` counts READABLE repositories the caller's own `repos`
    filter excluded. Told they were unreadable, a model reports a permissions
    problem to someone who simply asked about one repository."""
    note = _evidence_note(_context_pack(
        _result([{"snippet": "s", "citation": "c"}], withheld_repos=2), max_chars=1000))

    assert "cannot read" not in note
    assert "named the ones to search" in note and "2 other readable" in note


def test_the_context_pack_carries_routing_through_to_the_answer():
    """An answer built on one repo out of six is a weaker claim than the same
    answer built on all six. Dropping routing here makes them indistinguishable."""
    pack = _context_pack(_result([{"snippet": "s", "citation": "c"}]), max_chars=1000)

    assert pack["selected_repos"] and pack["searched_repos"] == ["a/b"]
    assert pack["routing"] == "r" and pack["engine"] == "zoekt"


def test_the_model_is_told_how_much_it_was_actually_shown():
    note = _evidence_note(_context_pack(
        _result([{"snippet": "s", "citation": "c"}]), max_chars=1000))

    assert "1 file excerpt(s)" in note and "out of 1 searched" in note


def test_a_degraded_index_is_stated_to_the_model_not_just_logged():
    """A small model will narrate a confident flow from weak evidence unless the
    weakness is in front of it."""
    note = _evidence_note(_context_pack(
        _result([{"snippet": "s", "citation": "c"}], degraded="zoekt down"),
        max_chars=1000))

    assert "UNAVAILABLE" in note


def test_the_model_is_warned_that_unindexed_repos_prove_nothing():
    note = _evidence_note(_context_pack(
        _result([{"snippet": "s", "citation": "c"}], unindexed_repos=["a/c"]),
        max_chars=1000))

    assert "absence of results there means nothing" in note and "a/c" in note


def test_a_repo_acl_key_is_a_resource_access_grant_will_accept():
    """A grant on a malformed resource is written, matches nothing, and reads as
    granted — so the ingest side and the admin side must agree on the spelling.
    A branch name with a slash is the case that breaks it."""
    ref = RepoRef(org="example", repo="Storefront", branch="release/2024-06")

    assert ref.repo_id == "code_repo-example-storefront-release-2024-06"
    assert RESOURCE.match(ref.acl_key)


def test_code_files_carry_the_repo_key_and_not_the_space_key():
    """`acl_keys && keys` is an overlap test, so every extra key widens access.
    Carrying `space:pay` alongside the repo key would make the repo grant
    decorative — anyone in the space would read the repo either way."""
    ref = RepoRef(org="example", repo="storefront", branch="main")

    keys = _acl_keys(ref, Record(id="a.py", stream=ref.stream_name))

    assert keys == ["object:code_repo-example-storefront-main"]


def test_imported_source_acls_widen_the_repo_key_rather_than_replacing_it():
    """The ACL crawl is still unimplemented. When it lands it must not be able
    to drop the repo key, or a file becomes unreadable by its own indexer."""
    ref = RepoRef(org="example", repo="storefront", branch="main")

    keys = _acl_keys(ref, Record(id="a.py", stream=ref.stream_name,
                                 acl_keys=["github:team:example/payments"]))

    assert keys == ["github:team:example/payments", "object:code_repo-example-storefront-main"]


class _Req:
    """Enough Request for a handler called directly — `space_of` and `actor_of`
    are both written to tolerate exactly this (see their docstrings)."""

    def __init__(self, body: dict) -> None:
        self._body = body
        self.state = type("S", (), {"space": "pay", "principal": None})()

    async def json(self):
        return self._body

    async def body(self):
        return b"{}"


class _ExplodingLlm:
    model = "must-not-be-called"

    async def complete(self, messages, **_):  # pragma: no cover - the point is it does not run
        raise AssertionError("code.ask called the model with no evidence")


async def test_code_ask_never_reaches_the_model_without_evidence(monkeypatch):
    """The guard this rests on is load-bearing, and was observed failing when
    bypassed: handed zero sources, a 1.5B local model produced a fluent,
    fully fabricated description of an order-placement flow — correct-looking
    prose about code that was never read. An answer with no retrieved source is
    not a worse answer, it is a different product.
    """
    from commonindex.gateway import app as gateway

    monkeypatch.setitem(gateway.state, "llm", _ExplodingLlm())
    monkeypatch.setattr(gateway, "_code_search", _empty_search)

    response = await gateway.code_ask(_Req({"q": "how does order placement work"}))

    assert response["citations"] == [] and response["model"] is None
    assert "No readable indexed code matched" in response["answer"]


async def _empty_search(req, body, limit=None):
    return _result([], selected_repos=[], searched_repos=[],
                   routing="caller has no readable repositories")


class _StubLlm:
    """A model that honours the JSON contract, so the wiring below is what is
    being tested rather than a small model's compliance with it."""

    model = "stub-coder"

    async def complete(self, messages, **_):
        return json.dumps({
            "answer": "Checkout posts to the orders handler.",
            "diagram": {"title": "Order placement",
                        "nodes": [{"id": "ui", "label": "Checkout", "kind": "ui"},
                                  {"id": "db", "label": "orders", "kind": "store"}],
                        "edges": [{"from": "ui", "to": "db", "label": "insert"}]},
        })


async def test_code_ask_answers_as_a_markdown_document_with_the_flow_drawn(monkeypatch):
    """`answer` stays exactly what the model said; `markdown` is the same answer
    as a document. Both, because a caller post-processing the prose should not
    have to strip our formatting off first, and a caller displaying it should not
    have to invent the formatting."""
    from commonindex.gateway import app as gateway

    async def found(req, body, limit=None):
        return _result([{"snippet": "def place_order():\n    pass",
                         "citation": "example/storefront/app/checkout.py:L10-L48"}],
                       query="how does order placement work")

    monkeypatch.setitem(gateway.state, "llm", _StubLlm())
    monkeypatch.setattr(gateway, "_code_search", found)

    response = await gateway.code_ask(_Req({"q": "how does order placement work",
                                            "include_diagram": True}))

    assert response["answer"] == "Checkout posts to the orders handler."
    document = response["markdown"]
    assert document.startswith("# how does order placement work")
    assert "## Answer" in document
    assert "```mermaid\nflowchart TD" in document
    assert '[("orders")]' in document          # the store is drawn as a store
    assert "- `example/storefront/app/checkout.py:L10-L48`" in document
    assert "| Routing | r |" in document


async def test_an_answer_with_nothing_to_say_is_still_a_document(monkeypatch):
    """The empty response is the one whose whole value is the explanation of why
    it is empty. A client that renders `markdown` would otherwise show nothing at
    all on exactly that response."""
    from commonindex.gateway import app as gateway

    async def nothing(req, body, limit=None):
        return _result([], query="anything", selected_repos=[], searched_repos=[],
                       routing="caller has no readable repositories")

    monkeypatch.setitem(gateway.state, "llm", _ExplodingLlm())
    monkeypatch.setattr(gateway, "_code_search", nothing)

    response = await gateway.code_ask(_Req({"q": "anything"}))

    assert response["markdown"].startswith("# anything")
    assert "caller has no readable repositories" in response["markdown"]


async def test_code_ask_explains_why_there_was_nothing(monkeypatch):
    """"Nothing matched", "nothing is indexed" and "you cannot read any of it"
    are three different problems with three different fixes, and an empty answer
    that does not say which sends the reader to the wrong one."""
    from commonindex.gateway import app as gateway

    async def degraded_search(req, body, limit=None):
        return _result([], selected_repos=[], routing="searched 2; none matched",
                       degraded="zoekt unavailable, using postgres full-text: down")

    monkeypatch.setitem(gateway.state, "llm", _ExplodingLlm())
    monkeypatch.setattr(gateway, "_code_search", degraded_search)

    response = await gateway.code_ask(_Req({"q": "anything"}))

    assert "searched 2; none matched" in response["answer"]
    assert "zoekt unavailable" in response["answer"]


def test_a_requested_diagram_is_required_and_its_shape_goes_to_the_model():
    """Offered "null or a flow", a local model returned null every time and the
    toggle drew nothing, without a word."""
    from commonindex.gateway import app as appmod

    assert appmod._ASK_SCHEMA["required"] == ["answer", "diagram"]
    src = __import__("inspect").getsource(appmod.code_ask)
    assert "REQUIRED" in src and "response_schema" in src and "No flow diagram" in src
