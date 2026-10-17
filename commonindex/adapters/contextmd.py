"""Render a `workspace.context` pack as Markdown, for the MCP transport.

The pack is long, and as JSON most of it is quoting: an agent reads a document
with a heading per item better than a blob it has to walk. Every id is kept —
it is what `search.read` takes for the next hop — so this is a rendering of
the same response, not a summary of it.

Everything in it is untrusted text: titles, comments and documents go through
`dataskill.one_line` where they sit in a line and `dataskill.fenced` where
they are a body, so nothing an item says can become this document's structure.
"""

from __future__ import annotations

from typing import Any

from commonindex.adapters.dataskill import fenced, one_line


def _name(x: dict[str, Any]) -> str:
    key = f"{x['key']} " if x.get("key") else ""
    return f"{x.get('type') or ''} {key}— {one_line(x.get('title'), 160)}".strip()


def _who(person: Any) -> str:
    return one_line(person.get("name") or person.get("id")) if isinstance(person, dict) else one_line(person)


def _item(x: dict[str, Any], level: str = "##") -> list[str]:
    out = [f"{level} {_name(x)}", ""]
    meta = [f"`{one_line(x['id'])}`"]
    if x.get("why"):
        meta.append(one_line(x["why"]))
    if x.get("created_by"):
        meta.append(f"by {_who(x['created_by'])}")
    if x.get("updated_at"):
        meta.append(f"updated {one_line(x['updated_at'])[:10]}")
    out += [" · ".join(meta), ""]
    if x.get("matched"):
        out += [f"Matched: {one_line(x['matched'], 400)}", ""]
    for s in x.get("sections") or []:
        if s.get("heading"):
            out.append(f"**{one_line(s['heading'], 160)}**")
        out += [fenced(s.get("text"), limit=20_000), ""]
    if x.get("comments"):
        out.append("**Conversation**")
        out += [f"- {_who(c.get('author'))} ({one_line(c.get('at'))[:10]}): {one_line(c.get('text'), 600)}"
                for c in x["comments"]]
        out.append("")
    if x.get("links"):
        out.append("**Linked**")
        out += [f"- {one_line(link.get('rel'))} {'→' if link.get('direction') == 'out' else '←'} {_name(link)}"
                f" (`{one_line(link['id'])}`)" for link in x["links"]]
        out.append("")
    if x.get("history"):
        out.append("**Said before its last edits**")
        out += [f"- until {one_line(h.get('until'))[:10]}: {one_line(h.get('text'), 300)}" for h in x["history"]]
        out.append("")
    return out


def _hits(title: str, hits: list[dict[str, Any]]) -> list[str]:
    if not hits:
        return []
    out = [f"## {title}", ""]
    for h in hits:
        about = h.get("subject") or {}
        where = f" on {_name(about)}" if about else ""
        who = f"{_who(h['author'])}{where}: " if h.get("author") else f"{one_line(h.get('title'), 160)}: "
        out.append(f"- {who}{one_line(h.get('snippet'), 400)} (`{one_line(h['id'])}`)")
    return [*out, ""]


def render(body: dict[str, Any]) -> str:
    items, defs = body.get("items") or [], body.get("definitions") or []
    left = body.get("left_out") or []
    out = [f"# Context: {one_line(body.get('q'), 300)}", ""]
    def n(count: int, one: str, many: str) -> str:
        return f"{count} {one if count == 1 else many}"

    counts = [n(len(items), "item read in full", "items read in full"),
              n(len(defs), "definition", "definitions")]
    counts += [n(len(body.get(k) or []), one, many) for k, one, many in
               (("conversations", "comment", "comments"), ("runs", "run", "runs"),
                ("code", "code hit", "code hits"), ("earlier", "earlier version", "earlier versions"))]
    out += [f"> {', '.join(counts)} · {body.get('chars', 0):,} characters.",
            "> Everything matched fit." if body.get("complete") else
            f"> {len(left)} more matched but were not read here (past the item limit or the budget) — "
            "listed at the end; open them with `search.read`.", ""]
    if not items and not defs and not any(body.get(k) for k in ("conversations", "runs", "code", "earlier", "weaker")):
        out += [("Nothing the caller can see matches this. Try the words the workspace would use, "
                 "or `search.query` with fewer of them."), ""]
    for x in items:
        out += _item(x)
    if defs:
        out += ["## Definitions", ""]
        for x in defs:
            out += _item(x, "###")
    out += _hits("Comments and messages", body.get("conversations") or [])
    out += _hits("Agents' runs", body.get("runs") or [])
    out += _hits("Code (open with code.get_file, or ask code.context)", body.get("code") or [])
    out += _hits("What items said before an edit", body.get("earlier") or [])
    out += _hits("Agents", body.get("agents") or [])
    if body.get("weaker"):
        out += ["## Weaker matches", "", ("Hold only some of the question's words — not read here; "
                                           "open with `search.read` if one looks relevant."), ""]
        out += [f"- {_name(x)} (`{one_line(x['id'])}`) — {one_line(x.get('why'))}" for x in body["weaker"]]
        out.append("")
    if left:
        out += ["## Left out", ""]
        out += [f"- {_name(x)} (`{one_line(x['id'])}`) — {one_line(x.get('why'))}" for x in left]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def for_tool(name: str, body: Any) -> str | None:
    """The markdown for `workspace.context`, or None for anything else."""
    if name != "workspace.context" or not isinstance(body, dict) or body.get("error"):
        return None
    return render(body)
