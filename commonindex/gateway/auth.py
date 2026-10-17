"""One authorization check per operation, at the gateway.

`authz/__init__` has described this since the first commit and nothing
implemented it. Every operation declares the relation it needs; the middleware
below is what finally reads it.

Two things it deliberately does NOT do:

**No bypass flag.** A `COMMONINDEX_AUTH=off` switch is how a convenience becomes a
CVE — the codebase already made that argument about the secret key, which is
generated per run rather than defaulted. A dev machine seeds a token instead.

**Who is asking** is `signin.resolve`'s question: a person's session cookie,
a bearer token (agents, the CLI, MCP), or the company's trusted proxy.

**No fallback to the request body.** `actor_id` in a body is what this replaces,
so accepting it "when no token is present" would leave the hole open and hide
it. An operation that writes gets its actor from the token or it does not run.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from commonindex.core.authz import Denied
from commonindex.core.authz.store import NoSuchToken

#: Paths that answer before a caller could have credentials. Kept to exactly
#: what a client needs to discover how to authenticate — everything else,
#: including every read, requires a grant.
OPEN = ("/api/v1/_ops",)

PREFIX = "/api/v1/"


def _deny(status: int, code: str, message: str):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message,
                                           "field": None}})


async def authorize(request: Request, call_next):
    """Resolve the caller, then check the relation its operation declares."""
    path = request.url.path
    if not path.startswith(PREFIX) or path in OPEN:
        return await call_next(request)

    state = getattr(request.app.state, "commonindex", None)
    checker = (state or {}).get("checker")
    if checker is None:
        # Fail closed. A gateway whose checker failed to build must not serve
        # the operations it cannot check.
        return _deny(503, "authz_unavailable",
                     "the authorization checker is not available, so no operation "
                     "can be served")

    from commonindex.gateway import signin

    try:
        principal = await signin.resolve(request, checker, state.get("pool"))
    except NoSuchToken as e:
        return _deny(401, "bad_credentials", str(e))
    if principal is None:
        return _deny(401, "no_credentials",
                     "sign in, or send `Authorization: Bearer <token>`. An actor id in "
                     "the request body is not a credential — it is the caller naming itself.")
    if signin.cross_site(request, principal):
        return _deny(403, "cross_site",
                     "this request came from another site, and a signed-in browser's "
                     "requests are taken only from this app")

    op = request.app.state.commonindex["registry"].get(path[len(PREFIX):])
    if op is None:
        return await call_next(request)

    # The deployment's workspace (COMMONINDEX_SPACE) unless the request names one.
    # It was the literal "pay" — the demo's workspace — so a deployment that
    # named its own signed its admin in and then refused every request they made.
    space = request.headers.get("x-commonindex-space") or signin.space()
    # An edit to one item asks only that the caller is in the workspace; the
    # handler asks whether they may edit THAT item (commonindex/gateway/sharing.py),
    # since an item can be shared for editing with someone who only reads the
    # rest of the workspace.
    from commonindex.gateway.sharing import ITEM_EDITS

    relation = "read" if op.name in ITEM_EDITS else op.relation
    try:
        await checker.require(principal.actor_id, relation, f"space:{space}")
    except Denied as e:
        return _deny(403, "denied", str(e))

    # The authenticated identity, for handlers that attribute writes. Set on the
    # request rather than merged into the body so a handler cannot be written to
    # prefer a body value by accident.
    request.state.principal = principal
    # And the space that grant was checked against, for exactly the same
    # reason. It was not stored, so handlers scoped their data by
    # `body["space_id"]` while the grant had been checked against the HEADER —
    # two caller-controlled inputs answering one question, and nothing making
    # them agree. Sending a foreign space in the body rendered another tenant's
    # dashboard and executed its inline SQL; sending it in the header was
    # correctly refused.
    request.state.space = space
    # A slow operation asked for as `Prefer: respond-async` is queued, now that
    # the caller is known to hold it, and answered with where to find it.
    from commonindex.gateway import async_ops

    if op.name in async_ops.ASYNC_OPS and async_ops.wants_async(request):
        return await async_ops.defer(request, op.name, principal, space)
    return await call_next(request)


class SpaceMismatch(Exception):
    """A body naming a space other than the one the grant was checked against.

    Refused rather than ignored. Silently substituting the authorized space
    would give a caller a different scope than they asked for and tell them
    nothing — which is the same failure as reading the body's, one layer up.
    """

    def __init__(self, asked: str, authorized: str) -> None:
        super().__init__(
            f"this request is authorized for space {authorized!r} and the body asks "
            f"for {asked!r}. The space comes from the x-commonindex-space header, which "
            "is what the grant was checked against.")


def space_of(req: Request, body: dict | None = None) -> str:
    """The space this request was AUTHORIZED for.

    Handlers use this instead of `body["space_id"]`, which was the caller
    naming a scope rather than holding a grant for one.
    """
    # Two steps, because a request that never went through the middleware has
    # no `state` at all — the in-process tests construct one, and so does any
    # handler called directly.
    state = getattr(req, "state", None)
    from commonindex.gateway.signin import space as configured

    space = getattr(state, "space", None) or configured()
    if body is not None:
        asked = body.get("space_id")
        if asked is not None and asked != space:
            raise SpaceMismatch(asked, space)
    return space


def actor_of(req: Request) -> str:
    """The authenticated actor. Handlers use this instead of body['actor_id'],
    which was the caller naming itself."""
    principal = getattr(req.state, "principal", None)
    return principal.actor_id if principal else ""

