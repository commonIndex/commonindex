"""Small, viewer-authorized cards for workspace links. No URL fetching, renders,
warehouse queries or stored unfurls: access is checked again on every read.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from commonindex.gateway import sharing
from commonindex.gateway.auth import space_of
from commonindex.gateway.collections import _props
from commonindex.gateway.docs import excerpt
from commonindex.gateway.sharing import _error

router = APIRouter()
KINDS = frozenset({"doc", "dashboard", "experiment", "design", "video", "artifact",
                   "task", "channel", "code_file", "agent", "skill"})
MAX_ITEMS = 24


def _text(value, limit=240):
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _document_blocks(body):
    """A bounded, inert sketch of the actual opening blocks, never document
    HTML, image URLs or scripts. Embed refs are private intermediates which
    items_previews resolves against the viewer's ACL before returning them.
    """
    blocks, budget, visited = [], 4800, 0

    def children(node):
        value = node.get("content")
        return value[:40] if isinstance(value, list) else []

    def plain(node):
        parts, stack, seen = [], [node], 0
        while stack and seen < 100:
            current = stack.pop()
            seen += 1
            if not isinstance(current, dict):
                continue
            if isinstance(current.get("text"), str):
                parts.append(current["text"][:600])
            stack.extend(reversed(children(current)))
        return " ".join(parts)

    def take(value, limit=480):
        nonlocal budget
        if budget <= 0:
            return ""
        text = _text(value, min(limit, budget))
        budget -= len(text)
        return text

    def walk(node, depth=0):
        nonlocal visited
        if not isinstance(node, dict) or depth > 12 or visited >= 180 or len(blocks) >= 12 or budget <= 0:
            return
        visited += 1
        kind = node.get("type")
        if not isinstance(kind, str):
            kind = None
        if kind in {"heading", "paragraph", "blockquote", "codeBlock", "text"}:
            text = take(plain(node))
            if text:
                blocks.append({"kind": {"blockquote": "quote", "codeBlock": "code", "text": "paragraph"}
                               .get(kind, kind), "text": text})
        elif kind in {"bulletList", "orderedList", "taskList"}:
            items = []
            for child in children(node)[:6]:
                if not isinstance(child, dict):
                    continue
                text = take(plain(child), 200)
                if text:
                    attrs = child.get("attrs") or {}
                    if kind == "taskList":
                        text = ("☑ " if isinstance(attrs, dict) and attrs.get("checked") else "☐ ") + text
                    items.append(text)
            if items:
                blocks.append({"kind": "list", "ordered": kind == "orderedList", "items": items})
        elif kind == "table":
            rows = []
            for row in children(node)[:5]:
                if isinstance(row, dict):
                    cells = [take(plain(cell), 120) for cell in children(row)[:4]]
                    if cells:
                        rows.append(cells)
            if rows:
                blocks.append({"kind": "table", "rows": rows})
        elif kind == "horizontalRule":
            blocks.append({"kind": "divider"})
        elif kind in {"image", "embed"}:
            attrs = node.get("attrs")
            attrs = attrs if isinstance(attrs, dict) else {}
            if kind == "embed" and isinstance(attrs.get("ref"), str) and 0 < len(attrs["ref"]) <= 200:
                blocks.append({"kind": "embed", "ref": attrs["ref"]})
            else:
                blocks.append({"kind": "notice", "text": take(attrs.get("alt"), 120) or
                               ("Image in this document" if kind == "image" else "Embedded content")})
        else:
            for child in children(node):
                walk(child, depth + 1)

    walk(body)
    return blocks


def _card(row, panels: int = 0):
    p, kind = _props(row), row["type"]
    status = _text(p.get("freshness") if kind == "doc" else
                   p.get("status") if kind == "experiment" else p.get("state"), 40)
    summary = _text(p.get({"experiment": "hypothesis", "video": "brief", "task": "detail",
                          "channel": "topic", "code_file": "path"}.get(kind, "description")))
    detail = ""
    if kind == "doc":
        summary = excerpt(p.get("body"), limit=240)
    elif kind == "dashboard":
        # Derived from bindings, not caller-authored props or cached values.
        detail = f"{panels} panel{'s' if panels != 1 else ''}"
        summary = "Explore the metrics, charts and filters in this dashboard."
        status = ""  # Certification needs metric resolution; do not guess it.
    elif kind == "design":
        n = p.get("screen_count") or 0
        detail = f"{n} screen{'s' if n != 1 else ''}"
        surface = _text(p.get("surface"), 30)
        if surface:
            detail += f" · {surface}"
    elif kind == "video":
        detail = _text(p.get("format"), 30)
    elif kind == "channel" and p.get("archived"):
        status = "archived"
    elif kind == "code_file":
        detail = _text(p.get("language"), 30)
    card = {"id": row["id"], "type": kind, "available": True,
            "title": _text(row["title"], 200), "key": _text(row["key"], 40),
            "summary": summary, "status": status, "detail": detail}
    if kind == "doc":
        card["document"] = {"blocks": _document_blocks(p.get("body"))}
    return card


@router.post("/api/v1/items.previews")
async def items_previews(req: Request):
    body = await req.json()
    if not isinstance(body, dict):
        return _error(422, "bad_items", "Pass up to 24 item references.", "items")
    space = space_of(req, body)
    items = body.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS or any(
        not isinstance(i, dict) or not isinstance(i.get("type"), str) or i["type"] not in KINDS
        or not isinstance(i.get("id"), str) or not 1 <= len(i["id"].strip()) <= 200
        for i in items
    ):
        return _error(422, "bad_items", "Pass 1–24 supported item references with an id and type.", "items")
    refs = list(dict.fromkeys((i["type"], i["id"]) for i in items))
    cards = {}
    async with req.app.state.commonindex["pool"].acquire() as conn:
        keys = await sharing.keys(req, conn)
        rows = await conn.fetch(
            "select id, type, key, title, jsonb_build_object("
            " 'freshness', props->'freshness', 'status', props->'status', 'state', props->'state',"
            " 'description', props->'description', 'hypothesis', props->'hypothesis',"
            " 'brief', props->'brief', 'detail', props->'detail', 'topic', props->'topic',"
            " 'path', props->'path', 'surface', props->'surface', 'format', props->'format',"
            " 'archived', props->'archived', 'language', props->'language',"
            " 'body', case when type = 'doc' then props->'body' end,"
            " 'screen_count', case when jsonb_typeof(props#>'{spec,screens}') = 'array'"
            " then jsonb_array_length(props#>'{spec,screens}') else 0 end) as props from objects"
            " where space_id = $1 and id = any($2::text[]) and deleted_at is null"
            " and acl_keys && $3::text[]", space, [i[1] for i in refs], keys)
        visible = [r for r in rows if (r["type"], r["id"]) in refs]
        dashboards = [r["id"] for r in visible if r["type"] == "dashboard"]
        counts = {r["dashboard_id"]: r["n"] for r in await conn.fetch(
            "select pb.dashboard_id, count(*) as n from panel_bindings pb"
            " join objects p on p.id = pb.panel_id"
            " where pb.dashboard_id = any($1::text[]) and p.deleted_at is null"
            " and p.space_id = $2 and p.acl_keys && $3::text[] group by pb.dashboard_id",
            dashboards, space, keys)} if dashboards else {}
        for row in visible:
            cards[(row["type"], row["id"])] = _card(row, counts.get(row["id"], 0))
        embedded = [block for card in cards.values() for block in card.get("document", {}).get("blocks", [])
                    if block["kind"] == "embed"]
        if embedded:
            # A public doc can embed a private artifact: the doc's permission
            # does not grant access to that artifact or its saved screenshot.
            snapshots = {r["id"]: r for r in await conn.fetch(
                "select id, props->'snapshot'->>'status' as status,"
                " props->'snapshot'->>'job' as version from objects"
                " where id = any($1::text[]) and type = 'artifact' and space_id = $2"
                " and deleted_at is null and acl_keys && $3::text[]",
                list(dict.fromkeys(b["ref"] for b in embedded)), space, keys)}
            for block in embedded:
                ref = block.pop("ref")
                snapshot = snapshots.get(ref)
                if snapshot is not None and snapshot["status"] == "ready":
                    block.update(kind="snapshot", artifact_id=ref, version=snapshot["version"] or "")
                else:
                    block.update(kind="notice", text="Embedded preview unavailable")
        agents = [id_ for kind, id_ in refs if kind == "agent"]
        if agents:
            # Only agents with an active grant here, never identities from another workspace.
            for r in await conn.fetch(
                "select a.id, a.display from actors a where a.kind = 'agent'"
                " and a.id = any($1::text[]) and exists (select 1 from grants g"
                " where g.subject = a.id and g.resource = $2"
                " and (g.expires_at is null or g.expires_at > now()))", agents, f"space:{space}"):
                cards[("agent", r["id"])] = {
                    "id": r["id"], "type": "agent", "available": True,
                    "title": _text(r["display"], 200), "summary": "View this agent and its work in this workspace.",
                    "key": "", "status": "", "detail": ""}
        # This generated skill is always part of the workspace. Do not invent
        # metadata for frontend-only sample skills or trust conversation declarations.
        if ("skill", "skill-warehouse-context") in refs:
            cards[("skill", "skill-warehouse-context")] = {
                "id": "skill-warehouse-context", "type": "skill", "available": True,
                "title": "What this warehouse holds and what its numbers mean",
                "summary": "Datasets, metric definitions and how they are used in dashboards.",
                "key": "SK-CTX", "status": "generated", "detail": ""}
    # Unknown, deleted, wrong-type and forbidden all have exactly the same shape.
    return {"items": [cards.get((kind, id_), {"id": id_, "type": kind, "available": False})
                      for kind, id_ in refs]}
