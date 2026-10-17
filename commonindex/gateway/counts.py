"""The sidebar's numbers, in one call.

The sidebar counted by fetching every list it shows a number for — all
experiments, the whole board, every doc, every dashboard and the context
skill — about 120KB on a first load, to draw six small numbers. This asks the
same handlers, as the same caller, and returns only the counts: the rules for
what may be seen and what "needs a decision" stay in one place, and the page
downloads a few hundred bytes.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()


class _As:
    """The same caller asking for something else."""

    def __init__(self, req: Request, body: dict):
        self._req, self._body = req, body

    def __getattr__(self, name: str) -> Any:
        return getattr(self._req, name)

    async def json(self) -> dict:
        return self._body

    async def body(self) -> bytes:
        return b"{}" if self._body else b""


def _routes(routes):
    """Every route, including those inside included routers — which this
    FastAPI keeps nested rather than copying onto the app, so a flat look at
    `app.routes` found only the routes added to the app itself."""
    for route in routes:
        yield route
        nested = getattr(route, "original_router", None) or getattr(route, "router", None)
        inner = getattr(route, "routes", None) or getattr(nested, "routes", None)
        if inner:
            yield from _routes(inner)


def _handler(req: Request, path: str):
    for route in _routes(req.app.routes):
        if getattr(route, "path", None) == path and getattr(route, "endpoint", None):
            return route.endpoint
    return None


async def _ask(req: Request, op: str, body: dict | None = None) -> dict | None:
    """Another op's answer for this caller, or None when it refused or is absent."""
    handler = _handler(req, f"/api/v1/{op}")
    if handler is None:
        return None
    try:
        out = await handler(_As(req, dict(body or {})))
    except Exception:  # noqa: BLE001 — a count that cannot be read is not shown
        return None
    return None if isinstance(out, JSONResponse) else out


@router.post("/api/v1/workspace.counts")
async def workspace_counts(req: Request):
    """How many of each thing this caller can see, and how many need them."""
    # The caller's own space, as each list works it out — nothing from the body.
    exps = await _ask(req, "experiments.list", {"limit": 500})
    board = await _ask(req, "tasks.list")
    docs = await _ask(req, "docs.list", {"limit": 500})
    dashes = await _ask(req, "dashboards.list")
    skill = await _ask(req, "context.skill")

    e = (exps or {}).get("experiments") or []
    d = (docs or {}).get("docs") or []
    b = (dashes or {}).get("dashboards") or []
    t = (board or {}).get("counts") or {}
    return {
        "experiments": {
            "total": len(e),
            "running": sum(1 for x in e if x.get("status") == "running"),
            # Needing a decision, by the gateway's own reasons where it gives any.
            "readout": sum(1 for x in e if (x.get("attention") or [])
                           or (x.get("attention") is None and x.get("status") == "readout")),
        },
        "docs": {"total": len(d), "stale": sum(1 for x in d if x.get("freshness") == "stale")},
        "dashboards": {"total": len(b), "proposals": sum(1 for x in b if (x.get("proposals") or 0) > 0)},
        "tasks": {"total": (board or {}).get("total", 0), "review": t.get("review", 0), "flight": t.get("flight", 0)},
        # The generated context skill is the one skill there is: present when
        # the registry can be read.
        "skills": {"total": 1 if skill else 0, "installed": 1 if skill else 0, "proposed": 0},
    }
