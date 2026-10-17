"""A person's own tokens, for the tools they run as themselves.

Signing in is a browser's; a CLI or an MCP client needs a token. A person
makes one here, from a signed-in browser — never with another token, so a
token that leaks cannot mint its own replacements — and it expires.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.core.authz.store import hash_token

router = APIRouter()


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "field": field}})


def _iso(at):
    return at.isoformat() if at else None


@router.post("/api/v1/tokens.list")
async def tokens_list(req: Request):
    """The caller's own tokens."""
    actor = req.state.principal.actor_id
    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select id, label, created_at, last_used, expires_at from actor_tokens"
            " where actor_id = $1 order by created_at desc", actor)
    return {"tokens": [{"id": r["id"], "label": r["label"], "created_at": _iso(r["created_at"]),
                        "last_used": _iso(r["last_used"]), "expires_at": _iso(r["expires_at"])} for r in rows]}


@router.post("/api/v1/tokens.create")
async def tokens_create(req: Request):
    """A token for the caller's own CLI or MCP client, shown once."""
    principal = req.state.principal
    if principal.via == "token":
        return _error(403, "needs_sign_in", "make tokens from a signed-in browser — a token cannot mint tokens")
    body = await req.json()
    label = " ".join(str(body.get("label") or "").split())[:80]
    if not label:
        return _error(422, "no_label", "say what it is for, so you can tell your tokens apart", "label")
    try:
        days = max(1, min(int(body.get("days") or 90), 365))
    except (TypeError, ValueError):
        return _error(422, "bad_days", "days is a number from 1 to 365", "days")
    token = "ci_" + secrets.token_urlsafe(32)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "insert into actor_tokens (id, actor_id, token_hash, label, created_by, expires_at)"
            " values ($1,$2,$3,$4,$2, now() + make_interval(days => $5)) returning id, expires_at",
            "tok-" + secrets.token_hex(6), principal.actor_id, hash_token(token), label, days)
    return {"id": row["id"], "label": label, "token": token, "expires_at": _iso(row["expires_at"]),
            "token_note": "shown once and never stored — only its SHA-256 is"}


@router.post("/api/v1/tokens.revoke")
async def tokens_revoke(req: Request):
    """Stop one of the caller's tokens working."""
    body = await req.json()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        gone = await conn.fetchval("delete from actor_tokens where id = $1 and actor_id = $2 returning id",
                                   str(body.get("id") or ""), req.state.principal.actor_id)
    if gone is None:
        return _error(404, "unknown_token", "no token of yours with that id", "id")
    return {"revoked": gone}
