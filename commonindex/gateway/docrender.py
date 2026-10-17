"""A doc as one self-contained HTML page: the share link and the download.

Rendered from the block tree, node by node, with every string escaped — so the
page is exactly as safe as the tree, and the tree has no field markup fits in.
Nothing here runs script: the page carries a CSP forbidding it, a collapsed
section is a native `<details>`, and links and images are allowed only on
http(s) (plus mailto for links). It is a document, not an app.

An embedded artifact is HTML that runs, so here it is its snapshot — an image
the gateway took — with a link to open it live, and only when whoever the page
is drawn for may see it (`artifacts.embeds` decides, before this is called).
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from html import escape
from typing import Any
from urllib.parse import urlparse

from commonindex.gateway.docdiagram import render_svg

#: No script from anywhere, styles only inline, images from the web. A shared
#: page is opened by people who never signed in, so it gets the strictest
#: policy that still draws the doc.
CSP = ("default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

#: The embeds the page being drawn may show: ref -> title, image and url, or
#: None for one it may not. Set by render_page for the length of one render.
_EMBEDS: ContextVar[dict[str, Any] | None] = ContextVar("embeds", default=None)

_MARKS = {"bold": "strong", "italic": "em", "underline": "u", "strike": "s", "code": "code"}


def _url(raw: Any, schemes: tuple[str, ...]) -> str | None:
    u = str(raw or "").strip()
    try:
        return u if urlparse(u).scheme.lower() in schemes else None
    except ValueError:
        return None


def _text(node: dict) -> str:
    out = escape(node.get("text") or "")
    for mark in node.get("marks") or []:
        kind = mark.get("type")
        if kind in _MARKS:
            tag = _MARKS[kind]
            out = f"<{tag}>{out}</{tag}>"
        elif kind == "link":
            href = _url((mark.get("attrs") or {}).get("href"), ("http", "https", "mailto"))
            if href:
                out = (f'<a href="{escape(href)}" rel="noopener noreferrer nofollow" '
                       f'target="_blank">{out}</a>')
    return out


def _span(value: Any) -> str:
    """A colspan/rowspan, which must be a small positive integer or nothing."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return ""
    return str(n) if 1 < n <= 50 else ""


def _kids(node: dict) -> str:
    return "".join(render_node(c) for c in node.get("content") or [])


def _embed(ref: str) -> str:
    if not ref:
        return ""   # an embed still being made in the editor
    seen = (_EMBEDS.get() or {}).get(ref)
    if not seen:
        return ('<figure class="embed none"><div>An embedded artifact that is not shared with you, '
                "or no longer exists.</div></figure>")
    title = escape(str(seen.get("title") or "Artifact"))
    url = _url(seen.get("url"), ("http", "https"))
    link = (f'<a href="{escape(url)}" rel="noopener noreferrer nofollow" target="_blank">Open live</a>'
            if url else "")
    image = str(seen.get("image") or "")
    shot = (f'<img src="{escape(image)}" alt="{title}" loading="lazy">'
            if image.startswith("data:image/png;base64,") else
            '<div class="embed-wait">No snapshot yet.</div>')
    return f'<figure class="embed">{shot}<figcaption><span>{title}</span>{link}</figcaption></figure>'


def render_node(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    t = node.get("type")
    attrs = node.get("attrs") or {}
    if t == "text":
        return _text(node)
    if t == "hardBreak":
        return "<br>"
    if t == "paragraph":
        return f"<p>{_kids(node)}</p>"
    if t == "heading":
        level = attrs.get("level") if attrs.get("level") in (1, 2, 3) else 2
        return f"<h{level}>{_kids(node)}</h{level}>"
    if t == "bulletList":
        return f"<ul>{_kids(node)}</ul>"
    if t == "orderedList":
        try:
            start = int(attrs.get("start") or 1)
        except (TypeError, ValueError):
            start = 1
        return f'<ol start="{start}">{_kids(node)}</ol>' if start != 1 else f"<ol>{_kids(node)}</ol>"
    if t == "listItem":
        return f"<li>{_kids(node)}</li>"
    if t == "taskList":
        return f'<ul class="tasks">{_kids(node)}</ul>'
    if t == "taskItem":
        done = bool(attrs.get("checked"))
        box = '<input type="checkbox" disabled{}>'.format(" checked" if done else "")
        return f'<li class="{"done" if done else ""}">{box}<div>{_kids(node)}</div></li>'
    if t == "codeBlock":
        raw = "".join(c.get("text") or "" for c in node.get("content") or [])
        if str(attrs.get("language") or "").lower() == "mermaid":
            svg = render_svg(raw)
            if svg:
                return f'<figure class="diagram">{svg}</figure>'
        return f"<pre><code>{escape(raw)}</code></pre>"
    if t == "blockquote":
        return f"<blockquote>{_kids(node)}</blockquote>"
    if t == "horizontalRule":
        return "<hr>"
    if t == "image":
        src = _url(attrs.get("src"), ("http", "https"))
        if not src:
            return ""
        return f'<img src="{escape(src)}" alt="{escape(str(attrs.get("alt") or ""))}" loading="lazy">'
    if t == "embed":
        return _embed(str(attrs.get("ref") or ""))
    if t == "table":
        return f'<div class="table"><table>{_kids(node)}</table></div>'
    if t == "tableRow":
        return f"<tr>{_kids(node)}</tr>"
    if t in ("tableHeader", "tableCell"):
        tag = "th" if t == "tableHeader" else "td"
        span = "".join(f' {k}="{v}"' for k, v in (("colspan", _span(attrs.get("colspan"))),
                                                  ("rowspan", _span(attrs.get("rowspan")))) if v)
        return f"<{tag}{span}>{_kids(node)}</{tag}>"
    if t == "details":
        return f"<details open>{_kids(node)}</details>"
    if t == "detailsSummary":
        return f"<summary>{_kids(node)}</summary>"
    if t == "detailsContent":
        return f'<div class="details-body">{_kids(node)}</div>'
    # An unknown node cannot get past the type's schema; if one ever does, its
    # text survives and its markup does not.
    return _kids(node)


STYLE = """
:root { --bg:#f2efe9; --paper:#fffdf9; --text:#1b1a16; --text2:#56544b; --muted:#8a877b;
  --rule:#dcd6c8; --border:#d0cabb; --sunk:#e9e5da; --accent:#1a5bd0; --ink:#23211c;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#161512; --paper:#1d1c18; --text:#ebe7dc;
  --text2:#b9b4a6; --muted:#8a877b; --rule:#34322b; --border:#3d3a32; --sunk:#2a2823;
  --accent:#7aa7ff; --ink:#f2efe9; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.7 var(--sans);
  -webkit-font-smoothing:antialiased; }
main { max-width:760px; margin:40px auto; padding:48px 56px; background:var(--paper);
  border:1px solid var(--rule); border-radius:14px; }
@media (max-width:720px) { main { margin:0; padding:28px 16px; border:0; border-radius:0; } }
h1,h2,h3 { font-family:var(--serif); color:var(--ink); line-height:1.25; letter-spacing:-.01em; }
header h1 { font-size:40px; margin:0 0 6px; font-weight:600; }
.meta { color:var(--muted); font-size:13px; margin-bottom:28px; }
article h1 { font-size:28px; margin:1.3em 0 .4em; } article h2 { font-size:22px; margin:1.2em 0 .4em; }
article h3 { font-size:18px; margin:1.1em 0 .3em; }
p { margin:.6em 0; } a { color:var(--accent); text-underline-offset:2px; }
ul,ol { padding-left:1.5em; } li > p { margin:.15em 0; }
ul.tasks { list-style:none; padding-left:.2em; } ul.tasks li { display:flex; gap:9px; }
ul.tasks input { margin-top:.45em; } ul.tasks li.done > div { color:var(--muted); text-decoration:line-through; }
blockquote { margin:.8em 0; border-left:3px solid var(--border); padding-left:14px; color:var(--text2); }
code { font-family:var(--mono); font-size:.86em; background:var(--sunk); padding:1px 5px; border-radius:4px; }
pre { font-family:var(--mono); font-size:13px; line-height:1.55; background:#23211c; color:#f2efe9;
  padding:12px 14px; border-radius:8px; overflow-x:auto; } pre code { background:none; padding:0; color:inherit; }
hr { border:0; border-top:1px solid var(--rule); margin:1.6em 0; }
img { max-width:100%; border-radius:8px; }
.table { overflow-x:auto; margin:1em 0; } table { border-collapse:collapse; width:100%; font-size:14px; }
th,td { border:1px solid var(--border); padding:6px 9px; text-align:left; vertical-align:top; }
th { background:var(--sunk); } th > p, td > p { margin:0; }
details { margin:.6em 0; } summary { cursor:pointer; font-weight:600; } .details-body { padding-left:1.2em; }
figure.diagram { margin:1.2em 0; overflow-x:auto; text-align:center; }
figure.diagram svg { max-width:100%; height:auto; font:12.5px var(--sans); }
.flow .s { fill:var(--paper); stroke:var(--text2); stroke-width:1.2; }
.flow .r { stroke:var(--text2); } .flow .t { fill:var(--text); }
.flow .e { fill:none; stroke:var(--muted); stroke-width:1.4; } .flow .e.d { stroke-dasharray:5 4; }
.flow .h { fill:var(--muted); } .flow .el { fill:var(--text2); font-size:11px; }
figure.embed { margin:1.2em 0; border:1px solid var(--rule); border-radius:10px; overflow:hidden; }
figure.embed img { display:block; width:100%; border-radius:0; background:#fff; }
figure.embed figcaption { display:flex; justify-content:space-between; gap:12px; padding:7px 12px;
  font-size:12.5px; color:var(--muted); border-top:1px solid var(--rule); background:var(--sunk); }
figure.embed.none div, .embed-wait { padding:18px 14px; color:var(--muted); font-size:13px; }
footer { margin-top:40px; padding-top:14px; border-top:1px solid var(--rule); color:var(--muted); font-size:12px; }
"""


def render_page(*, title: str, body: Any, updated: str | None = None, rev: int | None = None,
                source: str = "CommonIndex", embeds: dict[str, Any] | None = None) -> str:
    """The whole page. `updated` is an ISO timestamp, shown as its date;
    `embeds` is what each embedded artifact may show (artifacts.embeds)."""
    token = _EMBEDS.set(embeds or {})
    try:
        return _page(title=title, body=body, updated=updated, rev=rev, source=source)
    finally:
        _EMBEDS.reset(token)


def _page(*, title: str, body: Any, updated: str | None, rev: int | None, source: str) -> str:
    meta = []
    if updated:
        meta.append(f"Updated {escape(updated[:10])}")
    if rev:
        meta.append(f"rev {int(rev)}")
    t = escape(title or "Untitled")
    return (
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'
        '<meta name="robots" content="noindex">'
        f"<title>{t}</title><style>{STYLE}</style></head><body><main>"
        f"<header><h1>{t}</h1><div class=\"meta\">{' · '.join(meta)}</div></header>"
        f"<article>{_kids(body) if isinstance(body, dict) else ''}</article>"
        f"<footer>Shared from {escape(source)}. Read-only.</footer>"
        "</main></body></html>\n")


_SCHEME = re.compile(r"\b(https?|wss?|ftp|file|blob)(\s*):", re.IGNORECASE)


def for_page(html: str) -> str:
    """The rendered doc as the start of an editable page.

    The page store runs HTML in a frame and refuses anything that could reach
    outside it — an address anywhere, even in text — so "Make full page" fell
    back to a stock template and the doc's own words were lost. Here nothing
    is lost that a reader sees: a link keeps its words and shows where it
    pointed, an image from elsewhere becomes its description, and an address
    written in the text still reads as one, its colon an entity so no live
    address is left in the markup. The share-page furniture (the read-only
    footer, the revision it was rendered at) goes: this is a page now.
    """
    html = re.sub(r"<meta\s+http-equiv=[^>]*>", "", html, flags=re.IGNORECASE)
    html = re.sub(r"<footer>.*?</footer>", "", html, flags=re.DOTALL)
    html = re.sub(r'<div class="meta">.*?</div>', "", html, count=1, flags=re.DOTALL)

    def img(m: re.Match) -> str:
        tag = m.group(0)
        if re.search(r'src="data:', tag):
            return tag
        alt = re.search(r'alt="([^"]*)"', tag)
        return f'<span class="gone">[image{": " + alt.group(1) if alt and alt.group(1) else ""}]</span>'

    html = re.sub(r"<img\b[^>]*>", img, html)
    html = re.sub(r'<a href="([^"]*)"[^>]*>(.*?)</a>',
                  lambda m: f'{m.group(2)} <span class="gone">({m.group(1)})</span>',
                  html, flags=re.DOTALL)
    return _SCHEME.sub(lambda m: f"{m.group(1)}{m.group(2)}&#58;", html)
