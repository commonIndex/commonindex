"""Sharing one item: who may see it and who may change it.

An item is private to the people it is shared with, or open to its whole
workspace. A share is a grant on the item itself — view, edit or owner — made
by email, with members of the workspace only. Owners manage access; anyone who
can see an item can see who else can.
"""

from __future__ import annotations

from collections.abc import Iterable

from commonindex.core.ops import Op, Registry

_ID = {"type": "string", "description": "The item's id."}


def register(reg: Registry, preview_kinds: Iterable[str] = ()) -> None:
    """`preview_kinds` are the item types a link preview can be asked for. They
    are the gateway's to name, not core's: core knows items, not collections."""
    kind = {"enum": sorted(preview_kinds)} if preview_kinds else {"type": "string", "minLength": 1}
    register_members(reg)
    register_tokens(reg)
    register_signin(reg)
    reg.register(Op(
        name="items.previews",
        relation="read",
        description="Small link-preview cards, checked against the reader's item permissions. No queries or writes.",
        input_schema={"type": "object", "properties": {
            "space_id": {"type": "string"},
            "items": {"type": "array", "minItems": 1, "maxItems": 24,
                      "items": {"type": "object", "properties": {
                          "id": {"type": "string", "minLength": 1, "maxLength": 200},
                          "type": kind},
                                "required": ["id", "type"]}}}, "required": ["items"]},
    ))
    reg.register(Op(
        name="items.access",
        relation="read",
        description=(
            "Who can see and change one item, and what the caller may do with it: "
            "`visibility` is private (only the people listed) or workspace (everyone "
            "in it); `you` is none, view, edit or manage."
        ),
        input_schema={"type": "object", "properties": {"id": _ID, "space_id": {"type": "string"}},
                      "required": ["id"]},
    ))
    reg.register(Op(
        name="items.share",
        relation="read",
        mutating=True,
        description=(
            "Give a member of the workspace access to one item, by their email: view, "
            "edit, or owner (edits and manages who else has access). Only an item's "
            "owners can share it. An email that is not a member's is refused."
        ),
        input_schema={"type": "object",
                      "properties": {"id": _ID, "email": {"type": "string"},
                                     "role": {"enum": ["view", "edit", "owner"]},
                                     "idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}},
                      "required": ["id", "email", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="items.unshare",
        relation="read",
        mutating=True,
        description="Take one person's access to an item away, by id or email. An item keeps at least one owner.",
        input_schema={"type": "object",
                      "properties": {"id": _ID, "person_id": {"type": "string"}, "email": {"type": "string"},
                                     "idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}},
                      "required": ["id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="items.set_visibility",
        relation="read",
        mutating=True,
        description=(
            "Make an item private — only the people it is shared with — or open it to "
            "everyone in the workspace to view or to edit. People shared with directly "
            "keep what they were given. Owners only."
        ),
        input_schema={"type": "object",
                      "properties": {"id": _ID, "visibility": {"enum": ["private", "workspace"]},
                                     "role": {"enum": ["view", "edit"],
                                              "description": "What everyone in the workspace may do "
                                                             "when it is open. Default view."},
                                     "idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}},
                      "required": ["id", "visibility", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="people.set_email",
        relation="admin",
        mutating=True,
        description="Record a person's email, so items can be shared with them by it.",
        input_schema={"type": "object",
                      "properties": {"person_id": {"type": "string"}, "email": {"type": "string"},
                                     "idempotencyKey": {"type": "string"}},
                      "required": ["person_id", "email", "idempotencyKey"]},
    ))


_ROLE = {"enum": ["viewer", "contributor", "reviewer", "admin"],
         "description": "viewer reads; contributor writes and proposes; reviewer also approves "
                        "and merges; admin also manages who is in the workspace."}
_KEY = {"type": "string"}


def register_members(reg: Registry) -> None:
    reg.register(Op(
        name="members.list",
        relation="admin",
        description="Everyone in the workspace: name, email, role, and when they were last here. Admins only.",
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))
    reg.register(Op(
        name="members.invite",
        relation="admin",
        mutating=True,
        description=(
            "Bring someone into the workspace by name, email and role. Returns a sign-in "
            "token for them, shown once and never again — send it to them."
        ),
        input_schema={"type": "object",
                      "properties": {"name": {"type": "string"}, "email": {"type": "string"},
                                     "role": _ROLE, "idempotencyKey": _KEY},
                      "required": ["name", "email", "role", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="members.set_role",
        relation="admin",
        mutating=True,
        description="Change someone's role in the workspace. A workspace keeps at least one admin.",
        input_schema={"type": "object",
                      "properties": {"person_id": {"type": "string"}, "role": _ROLE, "idempotencyKey": _KEY},
                      "required": ["person_id", "role", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="members.remove",
        relation="admin",
        mutating=True,
        description=(
            "Take someone out of the workspace. Their work stays: anything only they "
            "owned passes to whoever removed them."
        ),
        input_schema={"type": "object",
                      "properties": {"person_id": {"type": "string"}, "idempotencyKey": _KEY},
                      "required": ["person_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="members.new_token",
        relation="admin",
        mutating=True,
        description="A fresh sign-in token for someone who lost theirs; their old ones stop working. Shown once.",
        input_schema={"type": "object",
                      "properties": {"person_id": {"type": "string"}, "idempotencyKey": _KEY},
                      "required": ["person_id", "idempotencyKey"]},
    ))


def register_tokens(reg: Registry) -> None:
    """A person's own tokens, for their CLI and MCP clients."""
    reg.register(Op(
        name="tokens.list",
        relation="read",
        description="Your tokens for the CLI and MCP clients: label, when made, when last used, when they expire.",
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))
    reg.register(Op(
        name="tokens.create",
        relation="read",
        mutating=True,
        description=("A token for your own CLI or MCP client, shown once. Only from a signed-in browser: "
                     "a token cannot mint more tokens. Expires in `days` (1-365, default 90)."),
        input_schema={"type": "object",
                      "properties": {"label": {"type": "string", "description": "What it is for: 'laptop CLI'."},
                                     "days": {"type": "integer", "minimum": 1, "maximum": 365},
                                     "idempotencyKey": _KEY, "space_id": {"type": "string"}},
                      "required": ["label", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="tokens.revoke",
        relation="read",
        mutating=True,
        description="Stop one of your tokens working, now.",
        input_schema={"type": "object",
                      "properties": {"id": {"type": "string"}, "idempotencyKey": _KEY,
                                     "space_id": {"type": "string"}},
                      "required": ["id", "idempotencyKey"]},
    ))


def register_signin(reg: Registry) -> None:
    """How people sign in here, for its admins."""
    reg.register(Op(
        name="signin.settings",
        relation="admin",
        description=("How people sign in to this workspace: whether a sign-in is required or the gateway's own "
                     "computer is signed in automatically (local mode), and each method — Google, company SSO, "
                     "an emailed code, a trusted proxy, sign-in links — on, or the settings that turn it on."),
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))
    reg.register(Op(
        name="signin.set_mode",
        relation="admin",
        mutating=True,
        description=("Require a sign-in (`required`), or sign in whoever uses the app on the gateway's own "
                     "computer as you (`local`). Requests from anywhere else always sign in."),
        input_schema={"type": "object",
                      "properties": {"mode": {"enum": ["required", "local"]}, "idempotencyKey": _KEY,
                                     "space_id": {"type": "string"}},
                      "required": ["mode", "idempotencyKey"]},
    ))
