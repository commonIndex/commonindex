"""The markdown rendering of a Code Query result, and the mermaid inside it.

Two properties are being defended.

The document must survive its own contents. A model's answer, a file body and a
repository name all land inside a markdown document here, and any of them can
contain a fence, a heading or a pipe — so the tests below are mostly about text
that would otherwise become structure and take the sections after it with it.

And the diagram must stay data. `code.ask` accepts a node/edge specification and
the server draws it; the point of moving to mermaid is that every viewer can
render the result, not that the model may now write the drawing. A ```mermaid
fence the validator never saw must therefore not be drawn — which is a property
of the renderer, tested here, rather than a promise in a docstring.
"""

from __future__ import annotations

import re

from commonindex.adapters import codemd

FLOW = {
    "title": "Order placement",
    "nodes": [{"id": "ui", "label": "Checkout page", "kind": "ui"},
              {"id": "api", "label": "POST /orders", "kind": "api"},
              {"id": "db", "label": "orders table", "kind": "store"}],
    "edges": [{"from": "ui", "to": "api", "label": "submits"},
              {"from": "api", "to": "db", "label": "insert"}],
}

PACK = {
    "query": "how does order placement work",
    "context": [{"citation": "example/storefront/app/checkout.py:L10-L48",
                 "snippet": "def place_order():\n    ...", "repo": "example/storefront",
                 "language": "python", "score": 240.0, "object_id": "code_file-abc",
                 "stale": False}],
    "selected_repos": [{"repo": "example/storefront", "files": 1, "score": 240.0}],
    "searched_repos": ["example/ledger", "example/storefront"],
    "unindexed_repos": [], "unknown_repos": [], "withheld_repos": 0,
    "engine": "zoekt", "routing": "searched 2 readable repositories; 1 answered",
    "degraded": None, "truncated": False,
}


# ── the diagram ─────────────────────────────────────────────────────────


def test_the_flow_becomes_a_mermaid_flowchart():
    text = codemd.mermaid(FLOW)

    assert text.startswith("flowchart TD")
    assert '%% title: Order placement' in text
    # Shape carries the kind: a store is drawn as a store, not as another box.
    assert '(["Checkout page"])' in text and '[("orders table")]' in text
    assert '-->|"submits"|' in text


def test_a_model_supplied_node_id_cannot_become_mermaid_syntax():
    """Ids are renumbered rather than filtered. A model id is a string like any
    other, and `x --> evil` in one would be a graph edge appearing where a name
    belongs."""
    text = codemd.mermaid({
        "title": "t",
        "nodes": [{"id": "a --> b", "label": "one", "kind": "step"},
                  {"id": 'q" ["x', "label": "two", "kind": "step"}],
        "edges": [{"from": "a --> b", "to": 'q" ["x', "label": "next"}]})

    assert "a --> b" not in text and 'q" ["x' not in text
    assert '  n0["one"]' in text and '  n1["two"]' in text
    assert '  n0 -->|"next"| n1' in text


def test_a_label_cannot_end_its_own_quote_or_open_a_line():
    """`"` ends a quoted mermaid label and `#` opens an entity, so those two are
    the escape. A newline would end the statement, so it does not survive."""
    text = codemd.mermaid({
        "title": "t", "edges": [],
        "nodes": [{"id": "n", "label": 'say "hi" #35 then\nnewline', "kind": "step"}]})

    assert text.count("\n") == 2  # header, title, one node — the label added none
    assert '"say #quot;hi#quot; #35;35 then newline"' in text


# ── the document ────────────────────────────────────────────────────────


def test_the_answer_document_carries_the_answer_diagram_sources_and_routing():
    doc = codemd.answer(question="How does order placement work?",
                        text="It starts in `checkout.py`.", flow=FLOW,
                        citations=["example/storefront/app/checkout.py:L10-L48"],
                        pack=PACK, model="qwen2.5-coder:1.5b")

    assert doc.startswith("# How does order placement work?")
    assert "## Answer" in doc and "It starts in `checkout.py`." in doc
    assert "```mermaid\nflowchart TD" in doc
    assert "## Sources" in doc
    assert "- `example/storefront/app/checkout.py:L10-L48`" in doc
    # How it was reached, in the document rather than beside it: a reader who
    # cannot see "1 of 2 repositories" reads a thin answer as a complete one.
    assert "| Routing | searched 2 readable repositories; 1 answered |" in doc
    assert "1 of 2 searched repositories" in doc


def test_an_unterminated_fence_in_the_answer_is_closed():
    """Left open it swallows every section after the answer — sources, diagram
    and routing all render as code, and the document looks truncated rather than
    malformed."""
    doc = codemd.answer(question="q", text="here it is:\n\n```python\nx = 1",
                        citations=["a/b/c.py:L1-L2"], pack=PACK)

    assert doc.count("```") % 2 == 0
    assert "## Sources" in doc


def test_a_heading_in_the_answer_cannot_open_a_section_of_its_own():
    """`## Sources` written by the model would put our next section inside its
    answer, which reads as the platform vouching for whatever follows."""
    doc = codemd.answer(question="q", text="# Overview\n\n## Sources\n\nmade up",
                        citations=["a/b/c.py:L1-L2"], pack=PACK)

    body = doc.split("## Answer")[1].split("\n## Sources")[0]
    assert "### Overview" in body and "#### Sources" in body
    assert body.count("\n## ") == 0


def test_a_model_authored_mermaid_fence_is_not_drawn_as_a_diagram():
    """The whole point of the structured flow is that the server draws only what
    it validated. A fence the model wrote itself renders as code — visible, and
    not presented as a checked picture."""
    doc = codemd.answer(question="q", text="```mermaid\nflowchart LR\nA-->B\n```",
                        flow=FLOW, pack=PACK)

    answer_section = doc.split("## Answer")[1].split("## Flow")[0]
    assert "```mermaid" not in answer_section
    assert "```text\nflowchart LR" in answer_section
    # and the validated one is still drawn
    assert "```mermaid\nflowchart TD" in doc


def test_a_degraded_index_is_a_callout_not_a_footnote():
    doc = codemd.answer(question="q", text="an answer", pack={**PACK, "degraded": "zoekt down"},
                        model="m")

    assert "> [!WARNING]" in doc and "zoekt down" in doc
    assert doc.index("[!WARNING]") < doc.index("## Answer")


def test_an_empty_answer_is_still_a_document():
    doc = codemd.answer(question="q", text="", pack=PACK)

    assert "## Answer" in doc and "The model returned nothing" in doc


# ── the retrieval renderings ────────────────────────────────────────────


def _search_body(**over) -> dict:
    return {"query": "place order", "engine": "zoekt",
            "routing": "searched 2 readable repositories; 1 answered",
            "searched_repos": ["example/ledger", "example/storefront"],
            "selected_repos": [{"repo": "example/storefront", "files": 1, "score": 240.0}],
            "hits": [{"citation": "example/storefront/app/checkout.py:L10-L48",
                      "repo": "example/storefront", "language": "python", "score": 240.0,
                      "object_id": "code_file-abc", "stale": False,
                      "snippet": "def place_order():\n    pass"}],
            **over}


def test_a_search_rendering_keeps_the_argument_for_the_next_hop():
    """`code.get_file` takes an object_id. A rendering that drops it forces a
    caller who needs more of the file to search again for something it was
    already handed."""
    doc = codemd.for_tool("code.search", _search_body())

    assert "`code_file-abc`" in doc
    assert "`example/storefront/app/checkout.py:L10-L48`" in doc
    assert "```python\ndef place_order():" in doc


def test_a_snippet_containing_a_fence_cannot_end_its_own_fence():
    doc = codemd.for_tool("code.search", _search_body(
        hits=[{"citation": "a/b/readme.md:L1-L3", "repo": "a/b", "score": 1.0,
               "snippet": "```sh\nmake code-index\n```"}]))

    assert doc.count("````") >= 2
    # Everything after the snippet is still document, not code.
    assert doc.rstrip().endswith("````")


def test_the_routing_summary_comes_before_the_first_snippet():
    """A caller needs to know that one of two repositories answered *before*
    reading an excerpt, because that changes what the excerpt is evidence of."""
    doc = codemd.for_tool("code.search", _search_body())

    assert doc.index("| Routing |") < doc.index("### 1.")


def test_a_stale_hit_says_so_where_it_will_be_read():
    doc = codemd.for_tool("code.search", _search_body(
        hits=[{**_search_body()["hits"][0], "stale": True}]))

    assert doc.count("stale") >= 2  # the table row and the excerpt itself
    assert "code.get_file" in doc


def test_an_empty_search_distinguishes_nothing_found_from_nothing_indexed():
    doc = codemd.for_tool("code.search", _search_body(
        hits=[], selected_repos=[], unindexed_repos=["example/mobile"],
        routing="searched 2 readable repositories; none matched"))

    assert "silence from these means nothing yet" in doc
    assert "code.list_repos" in doc


def test_the_document_does_not_call_a_narrowed_search_a_permissions_problem():
    """The routing table is read by whoever is deciding how much to trust the
    answer. "2 repositories you cannot read" sends them to an access request;
    what actually happened is that they named the repository to search."""
    doc = codemd.answer(question="q", text="an answer",
                        pack={**PACK, "withheld_repos": 2}, model="m")

    assert "cannot read" not in doc
    assert "| Not searched | 2 other readable repository/repositories" in doc


def test_a_never_indexed_repository_is_called_out_in_the_listing():
    doc = codemd.for_tool("code.list_repos", {"repos": [
        {"repo": "example/storefront", "branch": "main", "provider": "git",
         "health": "ok", "last_indexed_at": None}]})

    assert "**never**" in doc and "proves nothing" in doc


def test_a_repository_name_cannot_split_its_own_table_row():
    doc = codemd.for_tool("code.list_repos", {"repos": [
        {"repo": "example/pipe|name", "branch": "main", "provider": "git",
         "health": "ok", "last_indexed_at": "2026-09-01"}]})

    row = next(line for line in doc.splitlines() if "pipe" in line)
    assert "\\|" in row, "the pipe is escaped rather than removed"
    # Five cells, not six: an unescaped pipe here would shift branch, provider
    # and health each one column left for that row alone.
    assert len(re.split(r"(?<!\\)\|", row.strip("|"))) == 5


def test_an_operation_with_no_renderer_keeps_its_json():
    """The MCP transport falls back to JSON on None, so "no renderer" has to be
    expressible — a markdown rendering of a response nobody wrote one for would
    be a worse copy of the JSON, not a better one."""
    assert codemd.for_tool("metrics.list", {"metrics": []}) is None
    assert codemd.for_tool("code.search", {"error": {"code": "missing_query"}}) is None


def test_get_file_is_rendered_with_its_language_and_its_line_range():
    doc = codemd.for_tool("code.get_file", {
        "object_id": "code_file-abc", "repo_id": "code_repo-example-storefront-main",
        "path": "app/checkout.py", "sha": "deadbeef", "start_line": 10, "end_line": 12,
        "body": "def place_order():\n    pass\n", "truncated": True,
        "citation": "example/storefront/app/checkout.py:L10-L12"})

    assert doc.startswith("# `example/storefront/app/checkout.py:L10-L12`")
    assert "```python" in doc and "lines 10–12" in doc
    assert "[!NOTE]" in doc and "prefix" in doc


def test_what_is_being_indexed_and_why_it_failed_reach_an_mcp_client():
    """An agent that asked for a repository to be indexed reads this list to
    know when it can search. Without the jobs it saw a list that never changed
    and could not tell "still cloning" from "refused"."""
    repo = {"repo": "example/ledger", "branch": "main", "provider": "github", "health": "ok",
            "last_indexed_at": "2026-10-10T08:00:00Z"}
    doc = codemd.repos({"repos": [repo], "indexing": [
        {"repo": "github.com/example/storefront", "state": "indexing", "step": "cloning"},
        {"repo": "github.com/example/private", "state": "failed", "step": "cloning",
         "error": "the repository needs credentials | add a token"}]})
    assert "## Being indexed" in doc
    assert re.search(r"`github.com/example/storefront` \| indexing \| cloning", doc)
    assert "needs credentials" in doc and "| failed |" in doc
    assert "## Being indexed" in codemd.repos({"repos": [], "indexing": [
        {"repo": "github.com/example/storefront", "state": "indexing", "step": "queued"}]})
    assert "Being indexed" not in codemd.repos({"repos": [repo], "indexing": []})
