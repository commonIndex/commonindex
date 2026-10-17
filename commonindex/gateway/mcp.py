"""The agent-facing tool manifest, from the same registry the routes come from.

Both emitters consume ``reg.all()``. Per-type operations are registered into that
registry by ``ops.register_type_ops`` rather than synthesised here, which is what
keeps the two surfaces identical by construction.
"""

from __future__ import annotations

from dataclasses import dataclass

from commonindex.core.ops import Registry


@dataclass(slots=True)
class Tool:
    name: str
    description: str
    input_schema: dict


def build(reg: Registry) -> list[Tool]:
    return [
        Tool(name=op.name, description=op.description, input_schema=op.input_schema)
        for op in reg.all()
    ]
