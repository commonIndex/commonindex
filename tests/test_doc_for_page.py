"""A doc made into a page keeps its words.

"Make full page" started from a stock template because the doc's own render
was refused by the page store: it holds a CSP meta naming https:, and any link,
outside image or address in the text is "a URL". for_page makes the render
something the store accepts without dropping anything a reader sees.
"""

from commonindex.gateway import docrender
from commonindex.gateway.videos import forbidden


def _text(t, marks=None):
    return {"type": "text", "text": t, **({"marks": marks} if marks else {})}


BODY = {"type": "doc", "content": [
    {"type": "heading", "attrs": {"level": 2}, "content": [_text("Refund not received")]},
    {"type": "paragraph", "content": [
        _text("See "),
        _text("the policy", [{"type": "link", "attrs": {"href": "https://example.com/refunds"}}]),
        _text(" or write to https://help.example.com today."),
    ]},
    {"type": "image", "attrs": {"src": "https://cdn.example.com/flow.png", "alt": "refund flow"}},
]}


def test_the_share_render_is_what_the_page_store_refused():
    html = docrender.render_page(title="Support macros", body=BODY, rev=3)
    assert forbidden(html) is not None


def test_for_page_is_accepted_and_keeps_every_word():
    html = docrender.for_page(docrender.render_page(title="Support macros", body=BODY, rev=3))
    assert forbidden(html) is None
    assert "Support macros" in html and "Refund not received" in html
    assert "the policy" in html and "example.com/refunds" in html     # where it pointed, as text
    assert "help.example.com" in html                                   # the address still reads
    assert "[image: refund flow]" in html
    assert "Read-only" not in html and "rev 3" not in html              # share-page furniture goes
