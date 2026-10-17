"""`docs.assist` without a database or a model: what it sends, what it refuses,
and what it does to an answer before handing it back."""

from __future__ import annotations

import json

from commonindex.gateway.docs import HERE, clean, docs_assist, excerpt
from commonindex.gateway.llm import LlmTruncated


class _Req:
    def __init__(self, body, llm):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": {"llm": llm}})()})()

    async def json(self):
        return self._body


class _Llm:
    model = "stub-writer"

    def __init__(self, answer="", error=None):
        self.answer, self.error, self.calls = answer, error, []

    async def complete(self, messages, *, max_tokens=1_800, require_finished=False):
        self.calls.append({"messages": messages, "max_tokens": max_tokens,
                           "require_finished": require_finished})
        if self.error:
            raise self.error
        return self.answer


def _body(r):
    return json.loads(r.body)


async def test_a_whole_doc_edit_sends_the_doc_and_asks_for_all_of_it_back():
    llm = _Llm("# Plan\n\nShip it.")
    got = await docs_assist(_Req({"instruction": "tighten this",
                                  "markdown": "# Plan\n\nWe will ship it soon.",
                                  "title": "Plan"}, llm))

    assert got == {"markdown": "# Plan\n\nShip it.", "scope": "document",
                   "model": "stub-writer", "note": got["note"]}
    prompt = llm.calls[0]["messages"][1]["content"]
    assert "We will ship it soon." in prompt and "complete revised document" in prompt
    # A cut-off rewrite would delete the end of the doc, so it must be refused.
    assert llm.calls[0]["require_finished"] is True


async def test_a_selection_edit_returns_only_the_passage():
    llm = _Llm("Shorter.")
    got = await docs_assist(_Req({"instruction": "shorten", "markdown": "A. Long bit. C.",
                                  "selection": "Long bit."}, llm))
    assert got["scope"] == "selection" and got["markdown"] == "Shorter."
    prompt = llm.calls[0]["messages"][1]["content"]
    assert "<passage>\nLong bit.\n</passage>" in prompt
    # the rest of the doc is not sent: a small model handed it returns it
    assert "A. " not in prompt


async def test_the_cursor_is_explained_only_when_it_is_there():
    llm = _Llm("x")
    await docs_assist(_Req({"instruction": "add a summary",
                            "markdown": f"Intro\n\n{HERE}\n\nEnd"}, llm))
    assert "marks the author's cursor" in llm.calls[0]["messages"][1]["content"]

    await docs_assist(_Req({"instruction": "add a summary", "markdown": "Intro"}, llm))
    assert "cursor" not in llm.calls[1]["messages"][1]["content"]


async def test_a_truncated_answer_is_refused_not_applied():
    r = await docs_assist(_Req({"instruction": "expand", "markdown": "x"},
                               _Llm(error=LlmTruncated("ceiling"))))
    assert r.status_code == 502 and _body(r)["error"]["code"] == "model_truncated"


async def test_no_model_says_which_variables_to_set():
    r = await docs_assist(_Req({"instruction": "write"}, None))
    assert r.status_code == 503
    assert "COMMONINDEX_LLM_BASE_URL" in _body(r)["error"]["message"]


async def test_refusals_happen_before_the_model_is_called():
    llm = _Llm("never")
    for body, field in [({"instruction": " "}, "instruction"),
                        ({"instruction": "x", "markdown": "a" * 60_001}, "markdown"),
                        ({"instruction": "x", "markdown": ["not", "text"]}, "markdown")]:
        r = await docs_assist(_Req(body, llm))
        assert r.status_code == 422 and _body(r)["error"]["field"] == field
    assert llm.calls == []


def test_clean_unwraps_a_whole_answer_fence_but_keeps_code_blocks_inside():
    assert clean("```markdown\n# Hi\n\nThere\n```") == "# Hi\n\nThere"
    inner = "Run:\n\n```sh\nmake test\n```\n\nDone."
    assert clean(inner) == inner
    assert clean(f"Before {HERE}after") == "Before after"


def test_clean_keeps_only_the_tagged_answer_when_the_model_echoes_the_tags():
    assert clean("Sure!\n<passage>\nFixed text.\n</passage>\nHope that helps.") == "Fixed text."
    assert clean("Fixed text.\n[/passage]") == "Fixed text."


def test_the_excerpt_is_the_first_words_as_plain_text():
    body = {"type": "doc", "content": [
        {"type": "heading", "content": [{"type": "text", "text": "Title"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "word " * 100}]}]}
    got = excerpt(body)
    assert got.startswith("Title word word") and got.endswith("…") and len(got) <= 180
    assert excerpt({"type": "doc", "content": []}) == ""


# ── the shared page and the download ──────────────────────────────────


def _doc(*blocks):
    return {"type": "doc", "content": list(blocks)}


def _p(text, marks=None):
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return {"type": "paragraph", "content": [node]}


def test_every_string_in_a_shared_page_is_escaped():
    from commonindex.gateway.docrender import render_page

    page = render_page(title="<script>alert(1)</script>", body=_doc(
        _p('<img src=x onerror="alert(2)">'),
        {"type": "codeBlock", "content": [{"type": "text", "text": "</code><script>x</script>"}]}))
    assert "<script>alert" not in page and "<img src=x" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page


def test_only_web_links_and_images_survive():
    from commonindex.gateway.docrender import render_page

    page = render_page(title="t", body=_doc(
        _p("bad", [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}]),
        _p("good", [{"type": "link", "attrs": {"href": "https://example.com"}}]),
        {"type": "image", "attrs": {"src": "javascript:alert(1)"}},
        {"type": "image", "attrs": {"src": "https://example.com/a.png", "alt": '"><b>'}}))
    assert "javascript:" not in page
    assert 'href="https://example.com"' in page
    assert 'src="https://example.com/a.png"' in page and 'alt="&quot;&gt;&lt;b&gt;"' in page


def test_the_page_forbids_script_and_draws_every_block():
    from commonindex.gateway.docrender import CSP, render_page

    page = render_page(title="Plan", rev=3, updated="2026-09-26T08:00:00", body=_doc(
        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Steps"}]},
        {"type": "taskList", "content": [{"type": "taskItem", "attrs": {"checked": True},
                                          "content": [_p("ship")]}]},
        {"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableHeader", "attrs": {"colspan": "2;x"}, "content": [_p("a")]}]}]},
        {"type": "details", "content": [
            {"type": "detailsSummary", "content": [{"type": "text", "text": "More"}]},
            {"type": "detailsContent", "content": [_p("hidden")]}]}))
    assert f'content="{CSP}"' in page and "script-src" not in CSP and "default-src 'none'" in CSP
    assert "<h2>Steps</h2>" in page and "checked" in page and "<th>" in page
    assert "<details open><summary>More</summary>" in page
    assert "Updated 2026-09-26 · rev 3" in page


# ── searching docs ────────────────────────────────────────────────────


def test_a_question_becomes_an_or_of_its_words_and_nothing_else():
    from commonindex.gateway.docindex import _words

    assert _words("how do we roll back?") == "how | do | we | roll | back"
    assert _words("a & !b:* | (c)") is None or "&" not in _words("a & !b:* | (c)")
    assert _words("!!!") is None


def test_an_unclosed_markdown_wrapper_is_still_unwrapped():
    """Observed: ```markdown opened, never closed, and the editor inserted the
    whole answer as one code block."""
    assert clean("```markdown\n# Flow\n\nText.") == "# Flow\n\nText."
    inner = "```markdown\n# Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.\n```"
    assert clean(inner) == "# Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter."


def test_an_answer_that_is_a_diagram_keeps_its_fence():
    diagram = "```mermaid\nflowchart TD\n  A[Rectangle 1] --> B[Rectangle 2]\n```"
    assert clean(diagram) == diagram


def test_the_prompt_asks_for_diagrams_as_mermaid_and_offers_no_placeholder_to_copy():
    from commonindex.gateway.docs import SYSTEM

    assert "```mermaid" in SYSTEM and "ASCII" in SYSTEM
    assert "[owner]" not in SYSTEM


def test_a_mermaid_block_is_drawn_as_svg_on_the_shared_page():
    from commonindex.gateway.docrender import render_page

    src = 'flowchart LR\n  A[Rectangle 1] --> B[Rectangle 2]\n  B -->|"<b>x</b>"| C{{Done?}}'
    page = render_page(title="t", body=_doc(
        {"type": "codeBlock", "attrs": {"language": "mermaid"}, "content": [{"type": "text", "text": src}]}))
    assert '<figure class="diagram"><svg' in page
    assert ">Rectangle 1</text>" in page and ">Rectangle 2</text>" in page
    assert page.count('marker-end="url(#ah)"') == 2
    assert "<b>x</b>" not in page and "&lt;b&gt;x&lt;/b&gt;" in page
    assert "<script" not in page


def test_a_block_that_is_not_a_flowchart_stays_code():
    from commonindex.gateway.docrender import render_page

    page = render_page(title="t", body=_doc(
        {"type": "codeBlock", "attrs": {"language": "mermaid"},
         "content": [{"type": "text", "text": "sequenceDiagram\n  A->>B: hi"}]}))
    assert "<svg" not in page and "sequenceDiagram" in page


def test_the_diagram_parser_reads_chains_labels_and_dashes_like_the_web_one():
    from commonindex.gateway.docdiagram import parse

    direction, nodes, edges = parse("graph TD\n  A[Ask] -- yes --> B([Pay]) -.-> C\n  C --> A")
    assert direction == "TD" and [n.id for n in nodes] == ["A", "B", "C"]
    assert [(e.src, e.dst, e.label, e.dashed) for e in edges] == [
        ("A", "B", "yes", False), ("B", "C", "", True), ("C", "A", "", False)]
    assert nodes[1].shape == "stadium"
    assert parse("not a diagram") is None
