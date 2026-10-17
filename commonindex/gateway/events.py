"""Changes, pushed: an open page hears that a conversation changed, at once.

A thread asked every 15 seconds whether anything was new, and the unread
counts and notifications every 30 — for every open browser, whether or not
anything had happened. Now a change to a conversation is announced in
Postgres (`pg_notify`, messages.py) and passed to each open page whose reader
may see that conversation, which then asks for just what changed.

**What is pushed is which conversation, never what was said.** A page fetches
the change through `messages.list`, so everything a reader sees still goes
through the same access checks. The push is also filtered by the same keys a
list uses (`acl_keys && the reader's keys`), so not even the existence of a
private conversation reaches someone it is not shared with.

**It works across gateways.** Every gateway LISTENs; Postgres delivers each
NOTIFY to all of them, and each passes it to its own open pages.

**A page that cannot hold a stream still works.** It goes on polling, less often.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from commonindex.gateway.messages import CHANNEL

log = logging.getLogger(__name__)
router = APIRouter()

#: Seconds between keep-alive comments, under every proxy's idle timeout.
KEEPALIVE = 20.0


class Hub:
    """The open pages in this gateway, and what each may hear."""

    def __init__(self) -> None:
        self._subs: dict[int, tuple[str, frozenset[str], asyncio.Queue]] = {}

    def add(self, space: str, keys: list[str]) -> tuple[int, asyncio.Queue]:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        sid = id(q)
        self._subs[sid] = (space, frozenset(keys), q)
        return sid, q

    def remove(self, sid: int) -> None:
        self._subs.pop(sid, None)

    def publish(self, payload: dict[str, Any]) -> None:
        acl = set(payload.get("acl") or [])
        for space, keys, q in list(self._subs.values()):
            if payload.get("space") == space and keys & acl:
                try:
                    q.put_nowait(payload.get("subject_id"))
                except asyncio.QueueFull:
                    pass  # a page this far behind will catch up on its next read

    def __len__(self) -> int:
        return len(self._subs)


async def listen(dsn: str, hub: Hub) -> None:
    """Hold a LISTEN connection for as long as the gateway runs, reconnecting
    when it drops — a lost connection must not silently end every push."""
    import asyncpg

    wait = 1.0
    while True:
        conn = None
        try:
            conn = await asyncpg.connect(dsn)

            def heard(_conn, _pid, _channel, payload: str) -> None:
                try:
                    hub.publish(json.loads(payload))
                except ValueError:
                    log.warning("unreadable change announcement: %r", payload[:200])

            await conn.add_listener(CHANNEL, heard)
            wait = 1.0
            while not conn.is_closed():
                await asyncio.sleep(10)
                await conn.execute("select 1")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - reconnect, never die
            log.warning("change listener lost its connection (%r); reconnecting", e)
        finally:
            if conn is not None and not conn.is_closed():
                await conn.close()
        await asyncio.sleep(wait)
        wait = min(wait * 2, 30.0)


def _deny(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "field": None}})


@router.get("/events")
async def events(req: Request):
    """A stream of `message` events — `{"subject_id": …}` — for the
    conversations this caller may read, with a keep-alive comment between."""
    from commonindex.core.authz import Denied
    from commonindex.core.authz.store import NoSuchToken
    from commonindex.gateway import sharing, signin

    state = req.app.state.commonindex
    hub: Hub | None = state.get("hub")
    if hub is None:
        return _deny(503, "no_events", "this gateway is not pushing changes; poll instead")
    # Not under /api/v1, so the authorization middleware does not see it: the
    # same three checks it makes, made here.
    try:
        principal = await signin.resolve(req, state["checker"], state.get("pool"))
    except NoSuchToken as e:
        return _deny(401, "bad_credentials", str(e))
    if principal is None:
        return _deny(401, "no_credentials", "sign in to hear about changes")
    if signin.cross_site(req, principal):
        return _deny(403, "cross_site", "a signed-in browser's requests are taken only from this app")
    space = req.headers.get("x-commonindex-space") or signin.space()
    try:
        await state["checker"].require(principal.actor_id, "read", f"space:{space}")
    except Denied as e:
        return _deny(403, "denied", str(e))
    req.state.principal = principal
    req.state.space = space
    async with state["pool"].acquire() as conn:
        keys = await sharing.keys(req, conn)

    sid, q = hub.add(space, keys)

    async def stream():
        try:
            yield "retry: 5000\n\nevent: ready\ndata: {}\n\n"
            while True:
                try:
                    subject = await asyncio.wait_for(q.get(), KEEPALIVE)
                except TimeoutError:
                    if await req.is_disconnected():
                        return
                    yield ": keep-alive\n\n"
                    continue
                yield f"event: message\ndata: {json.dumps({'subject_id': subject})}\n\n"
        finally:
            hub.remove(sid)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
