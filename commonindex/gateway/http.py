"""HTTP routes, generated from the operation registry.

One operation, one route: POST /api/v1/<operation.name>.
"""

from __future__ import annotations

from dataclasses import dataclass

from commonindex.core.ops import Op, Registry


@dataclass(slots=True)
class Error:
    """Typed, not status-only, so an agent can correct itself rather than retry
    blindly. A schema violation returns 422 naming the field."""

    code: str
    message: str
    field: str | None = None


def routes(reg: Registry) -> dict[str, Op]:
    """Build the table. Nothing is hand-registered: an operation that exists is
    reachable, and one that does not, is not.

    Reads ``reg.all()`` and nothing else — the same input the MCP manifest reads.
    """
    if not reg.all():
        raise ValueError("empty operation registry")
    return {f"POST /api/v1/{op.name}": op for op in reg.all()}
