"""A slow operation, answered later: `Prefer: respond-async`.

An answer from a model takes tens of seconds — longer on a laptop's — and the
request waited for it. Behind a load balancer that cuts requests at 60 seconds
(the common default) the answer was lost, and the model's work with it.

A caller that sends `Prefer: respond-async` (RFC 7240) to one of ASYNC_OPS is
authorized exactly as it would be, then answered at once with `202` and a job
id; the operation runs as a job (commonindex/workers/jobs.py) — the same handler,
as the same caller — and `jobs.get` returns its answer, to that caller only.
A caller that does not ask gets the answer directly, as before: MCP clients and
scripts are unchanged.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

#: The operations that wait on a model, which a browser asks for this way.
ASYNC_OPS = frozenset({
    "experiments.explain", "experiments.draft_rationale",
    "dashboards.ai_edit", "dashboards.generate", "designs.generate",
    "docs.assist", "videos.assist", "artifacts.draft",
    "workspace.ask", "code.ask",
})


def wants_async(request: Request) -> bool:
    return "respond-async" in (request.headers.get("prefer") or "").lower()


async def defer(request: Request, op_name: str, principal, space: str) -> JSONResponse:
    """Queue the operation as the caller and say where its answer will be."""
    from commonindex.workers.jobs import enqueue

    raw = await request.body()
    try:
        body = json.loads(raw) if raw else {}
    except ValueError:
        return JSONResponse(status_code=422, content={"error": {
            "code": "bad_json", "message": "the body is not JSON", "field": None}})
    who = {"actor_id": principal.actor_id, "kind": principal.kind, "trust_tier": principal.trust_tier,
           "token_id": principal.token_id, "via": principal.via}
    async with request.app.state.commonindex["pool"].acquire() as conn:
        job_id = await enqueue(conn, "op", {"op": op_name, "body": body, "principal": who},
                               space=space, actor=principal.actor_id)
    return JSONResponse(status_code=202, content={"job_id": job_id, "state": "queued", "op": op_name},
                        headers={"Preference-Applied": "respond-async"})


async def run_op(pool, job: dict[str, Any]) -> None:
    """Run the queued operation through its own handler, as whoever asked."""
    from starlette.requests import Request as StarletteRequest

    from commonindex.core.authz.store import Principal
    from commonindex.gateway.app import app
    from commonindex.gateway.counts import _routes

    p = job["payload"]
    path = f"/api/v1/{p['op']}"
    endpoint = next((r.endpoint for r in _routes(app.routes)
                     if getattr(r, "path", None) == path and getattr(r, "endpoint", None)), None)
    if endpoint is None:
        raise RuntimeError(f"no operation {p['op']!r}")
    payload = json.dumps(p["body"]).encode()
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": payload, "more_body": False}

    space = await pool.fetchval("select space_id from jobs where id = $1", job["id"])
    scope = {"type": "http", "method": "POST", "path": path, "raw_path": path.encode(),
             "query_string": b"", "headers": [(b"content-type", b"application/json")],
             "app": app, "client": ("job", 0), "server": ("job", 0), "scheme": "http",
             "state": {"principal": Principal(**p["principal"]), "space": space}}
    out = await endpoint(StarletteRequest(scope, receive))
    if isinstance(out, JSONResponse):
        status, body = out.status_code, json.loads(out.body or b"null")
    else:
        status, body = 200, json.loads(json.dumps(out, default=str))
    await pool.execute("update jobs set result = $2::jsonb where id = $1", job["id"],
                       json.dumps({"status": status, "body": body}, default=str))


@router.post("/api/v1/jobs.get")
async def jobs_get(req: Request):
    """Where a job you started stands, and its answer once it has one."""
    from commonindex.gateway.auth import actor_of

    body = await req.json()
    job_id = str(body.get("job_id") or "").strip()
    if not job_id:
        return JSONResponse(status_code=422, content={"error": {
            "code": "missing_field", "message": "job_id is required", "field": "job_id"}})
    row = await req.app.state.commonindex["pool"].fetchrow(
        "select id, kind, state, result, error, progress, created_at, finished_at from jobs"
        " where id = $1 and actor_id = $2", job_id, actor_of(req))
    if row is None:
        # Someone else's job reads as no job: its existence is not yours to learn.
        return JSONResponse(status_code=404, content={"error": {
            "code": "unknown_job", "message": f"no job {job_id!r}", "field": "job_id"}})

    def parsed(v):
        return json.loads(v) if isinstance(v, str) else v

    out: dict[str, Any] = {"job_id": row["id"], "state": row["state"],
                           "progress": parsed(row["progress"]) or {},
                           "created_at": row["created_at"].isoformat(),
                           "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None}
    if row["state"] == "done":
        out["result"] = parsed(row["result"])
    if row["state"] == "failed":
        out["error"] = row["error"]
    return out
