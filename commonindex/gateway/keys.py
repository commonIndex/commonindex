"""Short keys in id fields: the app labels items DOC-33, EXP-31; operations take ids.

A middleware of its own, inside `authorize`: that one never reads a request
body (identity comes from the token or nowhere, and test_authz holds it to
that), and this one has to. It runs once the caller and their space are known,
and decides nothing about access: the operation checks the id it is given like
any other.
"""

from __future__ import annotations

import json
import re

from fastapi import Request


async def resolve_keys(request: Request, call_next):
    space = getattr(request.state, "space", None)
    if space and request.url.path.startswith("/api/v1/"):
        await _resolve_keys(request, space)
    return await call_next(request)


#: A short key as the app shows it: DOC-33, DASH-32, EXP-31, T-15.
_KEY = re.compile(r"[A-Z][A-Z0-9]{0,11}-\d{1,9}")


async def _resolve_keys(request: Request, space: str) -> None:
    """Let an id field take the short key the app shows.

    Every page labels its item with a key (DOC-33, EXP-31) and no operation
    accepted one: an agent, or a person pasting what they see, asked for
    `EXP-31` and was told there was no such experiment. A top-level `id` or
    `*_id` field holding exactly a key is swapped for the id of the object with
    that key in this space, before the operation runs. Nothing is decided here:
    the operation then checks access to that id like any other, and a key that
    names nothing is left as it was, to be refused by name.
    """
    if request.method != "POST" or "json" not in (request.headers.get("content-type") or ""):
        return
    raw = await request.body()
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return
    if not isinstance(body, dict):
        return
    keys = {k: v for k, v in body.items()
            if (k == "id" or k.endswith("_id")) and isinstance(v, str) and _KEY.fullmatch(v)}
    if not keys:
        return
    pool = request.app.state.commonindex.get("pool")
    if pool is None:
        return
    rows = await pool.fetch(
        "select key, id from objects where space_id = $1 and key = any($2::text[]) and deleted_at is null",
        space, list(set(keys.values())))
    found = {r["key"]: r["id"] for r in rows}
    if not any(v in found for v in keys.values()):
        return
    for k, v in keys.items():
        body[k] = found.get(v, v)
    new = json.dumps(body).encode()
    # Both: the cached body for anything that reads it again, and the stream
    # the route reads when it builds its own Request.
    request._body = new

    async def receive():
        return {"type": "http.request", "body": new, "more_body": False}

    request._receive = receive
