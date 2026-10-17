"""The verbs that put items into a group and read a group back.

A group here is an item of its own that other items point at with one edge
each, so it gathers every kind of work at once — and an item may be in
several. `list`, `get` and `propose` for the group's own type are generated
from it; these are the rest.
"""

from __future__ import annotations

from commonindex.core.ops import Op, Registry

_KEY = {"idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}}
_GROUP = {"type": "string", "description": "The group's id, from projects.list."}
_ITEM = {"type": "string", "description": "Any item's id: a task, doc, design, video, experiment, dashboard."}


def register(reg: Registry) -> None:
    reg.register(Op(
        name="projects.update",
        relation="propose",
        mutating=True,
        description=(
            "Rename a project, or change its description, color or status. "
            "Archived projects are kept and still listed, but no longer offered "
            "when tagging."
        ),
        input_schema={"type": "object", "properties": {
            "project_id": _GROUP, **_KEY,
            "title": {"type": "string", "minLength": 1, "maxLength": 120},
            "description": {"type": ["string", "null"], "maxLength": 2000},
            "color": {"enum": ["blue", "green", "amber", "red", "violet", "teal", "gray"]},
            "status": {"enum": ["active", "done", "archived"]},
        }, "required": ["project_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="projects.tag",
        relation="propose",
        mutating=True,
        description=(
            "Put an item in a project. Any kind of item, and an item may be in "
            "several projects; tagging one already in it is a no-op. Needs edit "
            "on the item."
        ),
        input_schema={"type": "object", "properties": {"project_id": _GROUP, "object_id": _ITEM, **_KEY},
                      "required": ["project_id", "object_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="projects.untag",
        relation="propose",
        mutating=True,
        description="Take an item out of a project. The item itself is untouched.",
        input_schema={"type": "object", "properties": {"project_id": _GROUP, "object_id": _ITEM, **_KEY},
                      "required": ["project_id", "object_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="projects.items",
        relation="read",
        description=(
            "Everything in a project that you can see, newest first, grouped by "
            "kind, with the tasks counted by state so progress reads at a glance. "
            "Items not shared with you are counted in `hidden`, never named."
        ),
        input_schema={"type": "object", "properties": {"project_id": _GROUP, "space_id": {"type": "string"}},
                      "required": ["project_id"]},
    ))
    reg.register(Op(
        name="projects.of",
        relation="read",
        description="Which projects each of up to 200 items is in — for the chips on a list of cards.",
        input_schema={"type": "object", "properties": {
            "object_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 200},
            "space_id": {"type": "string"},
        }, "required": ["object_ids"]},
    ))
