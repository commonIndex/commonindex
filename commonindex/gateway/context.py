"""Everything the workspace holds about one question, in one call.

Search finds and read opens, a step at a time, which is right for an agent
that wants to steer — and a round trip per item for one that only wants to
know what is here. And search asks every word to match, which a question
never does: "why do partial refunds matter for refund rate" is written
nowhere whole.

This gathers instead. The question is searched both ways — every word, then
any word, the items holding more of them first — and each item found is read
in full, as `search.read` reads it: its text, the latest of its conversation,
its links, what it said before its last edits, and a dashboard's numbers now.
Then one hop out: what those items link to, read the same way. Beside them,
the comments, definitions, agents' runs and code the question matched.

No model reads it here. The pack is for whoever asked — an agent over MCP
reasons over it with its own model — so it works on a gateway with none
configured, and nothing is summarised away before the asker sees it. It is
bounded: a budget in characters, spent best match first, and whatever did
not fit is named in `left_out` so it can be read next.

Permissions are search's and read's own: the caller's keys filter every
statement, so a private item is neither in the pack nor in `left_out`.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request

from commonindex.gateway.search import SEARCHABLE, Filters, _error, _keys, find, read

router = APIRouter()

#: Characters of context by default, and at most. A budget, not a page size:
#: an agent's window is the scarce thing, and characters are what fill it.
BUDGET, MAX_BUDGET = 40_000, 150_000
#: Items read in full by default, and at most; then up to LINKED more, one hop out.
ITEMS, MAX_ITEMS, LINKED = 8, 20, 4
#: Items holding too little of the question to read, named all the same.
WEAKER = 6
#: An item trimmed below this is not worth its heading: it is left out instead.
FLOOR = 1_500


def _size(value: Any) -> int:
    return len(json.dumps(value, default=str))


def _fit(item: dict[str, Any], room: int) -> dict[str, Any] | None:
    """The item within `room` characters, its sections cut evenly — or None."""
    if _size(item) <= room:
        return item
    if room < FLOOR:
        return None
    sections = item.get("sections") or []
    over = _size(item) - room
    text = sum(len(s.get("text") or "") for s in sections) or 1
    keep = max(0.0, 1 - (over + 200) / text)
    item = {**item, "sections": [{**s, "text": (s.get("text") or "")[:int(len(s.get("text") or "") * keep)]
                                  + " … (cut to fit — read it whole with search.read)"} for s in sections]}
    return item if _size(item) <= room else None


def _brief(hit: dict[str, Any], why: str) -> dict[str, Any]:
    return {"id": hit["id"], "type": hit["type"], "key": hit.get("key"), "title": hit.get("title"), "why": why}


async def _terms(conn, q: str) -> list[str]:
    """The question's words as the index holds them: stems, no filler."""
    return list(await conn.fetchval(
        "select coalesce(array_agg(l), '{}') from unnest(tsvector_to_array(to_tsvector('english', $1))) l", q))


async def _held(conn, terms: list[str], ids: list[str]) -> dict[str, int]:
    """For each item, how many of the terms its name or any section holds."""
    if not terms or not ids:
        return {}
    rows = await conn.fetch(
        "select o.id, (select count(*) from unnest($2::text[]) t"
        "               where to_tsvector('english', coalesce(o.key, '') || ' ' || o.title)"
        "                       @@ to_tsquery('english', quote_literal(t))"
        "                  or exists (select 1 from chunks c where c.object_id = o.id"
        "                              and c.tsv @@ to_tsquery('english', quote_literal(t)))) as n"
        "  from objects o where o.id = any($1::text[])", ids, terms)
    return {r["id"]: r["n"] for r in rows}


async def _said(conn, terms: list[str], texts: list[str]) -> list[int]:
    """The same count for hits that are text — a comment, a definition, a line of code."""
    if not terms or not texts:
        return [0] * len(texts)
    rows = await conn.fetch(
        "select u.ord, (select count(*) from unnest($2::text[]) t"
        "               where to_tsvector('english', u.x) @@ to_tsquery('english', quote_literal(t))) as n"
        "  from unnest($1::text[]) with ordinality as u(x, ord) order by u.ord", texts, terms)
    return [r["n"] for r in rows]


def _need(terms: int, best: int) -> int:
    """How many of the question's words an item must hold to be about it.

    One or two words: one, the item holding most of them first. Three or more:
    two at least, and half of what the best match holds — so a question one
    common word away from everything ("… chart …") is not answered with
    everything, and one nothing here is about is answered with nothing."""
    if terms <= 2:
        return 1
    return max(2, -(-best // 2))


async def gather(conn, *, space: str, keys: list[str], q: str, items: int = ITEMS,
                 budget: int = BUDGET, numbers: bool = True) -> dict[str, Any]:
    """The context pack for `q`: see the module docstring."""
    every = await find(conn, space=space, keys=keys, q=q, f=Filters(limit=items))
    some = await find(conn, space=space, keys=keys, q=q, f=Filters(limit=items * 2), any_word=True)

    objects: list[dict[str, Any]] = []
    beside: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, str]] = set()
    for hit in [*every["hits"], *some["hits"]]:
        mark = (hit["kind"], hit["id"])
        if mark in seen:
            continue
        seen.add(mark)
        if hit["kind"] == "object":
            objects.append(hit)
        else:
            beside.setdefault(hit["kind"], []).append(hit)

    # How much of the question each candidate holds. A match on any word is
    # a match on "the" of a question, near enough: an item has to hold enough
    # of it to be about it, and the more it holds the earlier it is read.
    terms = await _terms(conn, q)
    strict = {(h["kind"], h["id"]) for h in every["hits"]}
    held = await _held(conn, terms, [h["id"] for h in objects])
    said = await _said(conn, terms, [f"{h.get('title') or ''} {h.get('snippet') or ''}"
                                      for hits in beside.values() for h in hits])
    need = _need(len(terms), max([*held.values(), *said, 0]))
    about = [h for h in objects if ("object", h["id"]) in strict or held.get(h["id"], 0) >= need]
    # Below the bar is not nothing: named, not read, so the asker knows it is there.
    weaker = [_brief(h, f"holds {held.get(h['id'], 0)} of the question's {len(terms)} words")
              for h in sorted((h for h in objects if h not in about), key=lambda h: -held.get(h["id"], 0))
              if held.get(h["id"], 0)][:WEAKER]
    objects = sorted(about, key=lambda h: (("object", h["id"]) not in strict, -held.get(h["id"], 0)))
    n = iter(said)
    beside = {k: [h for h in hits if next(n) >= need or (k, h["id"]) in strict] for k, hits in beside.items()}
    # A key asked for as written is a lookup: that item and what it links to.
    named = [h for h in every["hits"] if h["kind"] == "object" and (h.get("key") or "").lower() == q.lower()]
    if named:
        objects, weaker, beside = named[:1], [], {}

    pack: list[dict[str, Any]] = []
    left: list[dict[str, Any]] = []
    used = 0

    async def take(item_id: str, why: str, snippet: str | None = None) -> str:
        """"taken", "no_room", or "unreadable" — not something read opens (a
        readout is read as part of its experiment) or not the caller's."""
        nonlocal used
        item = await read(conn, space=space, keys=keys, item_id=item_id, numbers=numbers)
        if item is None:
            return "unreadable"
        fitted = _fit({**item, "why": why, **({"matched": snippet} if snippet else {})}, budget - used)
        if fitted is None:
            return "no_room"
        used += _size(fitted)
        pack.append(fitted)
        return "taken"

    for hit in objects:
        if len(pack) >= items or await take(hit["id"], "matched", hit.get("snippet")) == "no_room":
            left.append(_brief(hit, "matched"))

    # One hop out: what the items found point at, or are pointed at by, is
    # usually the rest of the story — the decision on an experiment, the task
    # a doc was written for.
    have = {i["id"] for i in pack} | {i["id"] for i in left}
    linked = 0
    matched = pack[:]   # one hop: what is read here is not followed in turn
    for item in matched:
        for link in item.get("links") or []:
            if link["id"] in have or link["type"] not in SEARCHABLE:
                continue   # a readout, a decision: read as part of what it is about
            have.add(link["id"])
            why = f"linked from {item.get('key') or item['id']} ({link['rel']})"
            if linked >= LINKED:
                left.append(_brief(link, why))
                continue
            taken = await take(link["id"], why)
            if taken == "taken":
                linked += 1
            elif taken == "no_room":
                left.append(_brief(link, why))

    # Definitions the question names, read in full: they are short, and a
    # number is only as good as what it was defined to count. One copy of each:
    # a definition every dashboard re-declared reads the same each time.
    definitions, same = [], set()
    for hit in [*beside.get("metric", []), *beside.get("dataset", [])]:
        item = await read(conn, space=space, keys=keys, item_id=hit["id"])
        twin = json.dumps([item["title"], (item["sections"] or [{}])[0]], default=str) if item else None
        if twin in same:
            continue
        same.add(twin)
        if item is not None and used + _size(item) <= budget:
            used += _size(item)
            definitions.append(item)
        else:
            left.append(_brief(hit, "definition"))

    def lines(kind: str) -> list[dict[str, Any]]:
        nonlocal used
        out = []
        for hit in beside.get(kind, []):
            if used + _size(hit) > budget:
                left.append(_brief(hit, kind))
                continue
            used += _size(hit)
            out.append(hit)
        return out

    return {
        "q": q,
        "items": pack,
        "definitions": definitions,
        "conversations": lines("message"),
        "runs": lines("run"),
        "code": lines("code"),
        "earlier": lines("history"),
        "agents": lines("agent"),
        "left_out": left,
        "weaker": [w for w in weaker if w["id"] not in {i["id"] for i in pack}],   # unless read by a link
        "chars": used,
        "complete": not left,
    }


@router.post("/api/v1/workspace.context")
async def workspace_context(req: Request):
    """Everything the workspace holds about one question, read and bounded."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    q = " ".join(str(body.get("q") or "").split())[:1_000]
    if not q:
        return _error(422, "no_question", "say what you want the context for", "q")
    try:
        items = max(1, min(int(body.get("items") or ITEMS), MAX_ITEMS))
        budget = max(5_000, min(int(body.get("max_chars") or BUDGET), MAX_BUDGET))
    except (TypeError, ValueError):
        return _error(422, "bad_limit", "items and max_chars are numbers", "items")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        keys = await _keys(req, conn, actor)
        return await gather(conn, space=space, keys=keys, q=q, items=items, budget=budget,
                            numbers=body.get("numbers", True) is not False)
