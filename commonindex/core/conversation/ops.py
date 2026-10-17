"""The conversation verbs, registered into the one operation registry.

A message is about a subject — any object in the space, a channel included,
an agent (by its actor id), or a skill — and may answer another message, one
level deep. `@id` in a body mentions that
actor; mentioning an agent also asks it, as an `asked` event it reads through
`agents.inbox`, and it answers with `messages.post` in the same thread. The
thread shows it as asked and waiting until it does.
"""

from __future__ import annotations

from commonindex.core.ops import Op, Registry

_KEY = {"idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}}

#: How a caller names a skill nobody has talked about yet — the one subject the
#: gateway cannot look up, since it does not store skills. Ignored once found.
_DECLARED = {
    "type": "object",
    "description": ("Only for a skill with no conversation yet: what it is. An object or "
                    "an agent is looked up by `subject_id` and needs none."),
    "properties": {"type": {"type": "string", "enum": ["skill"]},
                   "title": {"type": "string"}, "key": {"type": "string"}},
    "required": ["type", "title"],
}


_KIND = {"enum": ["comment", "update"],
         "description": "comment (the default): the conversation about it. update: a dated "
                        "note on how the work is going, listed apart."}

def register(reg: Registry) -> None:
    register_channels(reg)
    reg.register(Op(
        name="messages.list",
        relation="read",
        description=(
            "The conversation about one object, oldest first, with replies naming the "
            "message they answer: the newest `limit` (100) top-level messages, each with "
            "all its replies; `more_before` says there are older ones — pass the oldest "
            "message's id as `before` for the page before. Pass a previous answer's `now` "
            "as `since` for only what was created, edited or deleted after it. `waiting` "
            "lists, per message, the agents it mentioned that have not answered in its "
            "thread since — which is how a reader knows an agent was asked and has not replied."
        ),
        input_schema={"type": "object",
                      "properties": {"subject_id": {"type": "string"}, "subject": _DECLARED,
                                     "kind": _KIND, "space_id": {"type": "string"},
                                     "limit": {"type": "integer"},
                                     "before": {"type": "string", "description": "a message id"},
                                     "since": {"type": "string", "format": "date-time"}},
                      "required": ["subject_id"]},
    ))

    reg.register(Op(
        name="messages.counts",
        relation="read",
        description="How many messages each of several objects has, for headers and lists.",
        input_schema={"type": "object",
                      "properties": {"subject_ids": {"type": "array", "items": {"type": "string"}},
                                     "space_id": {"type": "string"}},
                      "required": ["subject_ids"]},
    ))

    reg.register(Op(
        name="messages.post",
        relation="propose",
        mutating=True,
        description=(
            "Say something about an object — a comment, or a message in a channel. "
            "Pass `parent_id` to answer a message; an answer to an answer joins its "
            "thread. `@id` mentions a person or an agent; an agent mentioned is "
            "asked in its inbox, and one with no propose grant here is reported "
            "back rather than asked, because it could not answer. `kind: update` "
            "posts a dated update on the work (a task's Updates) rather than a "
            "comment; an update is not a reply to anything."
        ),
        input_schema={"type": "object",
                      "properties": {"subject_id": {"type": "string"},
                                     "subject": _DECLARED,
                                     "body": {"type": "string"}, "kind": _KIND,
                                     "parent_id": {"type": "string"}, **_KEY},
                      "required": ["subject_id", "body", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="messages.edit",
        relation="propose",
        mutating=True,
        description=(
            "Change your own message. Anyone newly mentioned is asked as if the "
            "message were new; the edit is marked as one."
        ),
        input_schema={"type": "object",
                      "properties": {"message_id": {"type": "string"},
                                     "body": {"type": "string"}, **_KEY},
                      "required": ["message_id", "body", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="messages.delete",
        relation="propose",
        mutating=True,
        description=(
            "Delete a message: your own, or anyone's if you can merge here. One "
            "that replies answer stays as a marker, so the answers still read as "
            "answers to something."
        ),
        input_schema={"type": "object",
                      "properties": {"message_id": {"type": "string"}, **_KEY},
                      "required": ["message_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="messages.mentions",
        relation="read",
        description="The recent messages that mention the caller, newest first, with what each is about.",
        input_schema={"type": "object",
                      "properties": {"limit": {"type": "integer"}, "space_id": {"type": "string"}}},
    ))

    reg.register(Op(
        name="messages.notifications",
        relation="read",
        description=(
            "What wants the caller's attention in conversations: messages that "
            "mention them, and replies in threads they have written in — an "
            "agent answering their comment included. Newest first, each marked "
            "unread if it is newer than the caller last read that conversation."
        ),
        input_schema={"type": "object",
                      "properties": {"limit": {"type": "integer"}, "space_id": {"type": "string"}}},
    ))

    reg.register(Op(
        name="messages.unread",
        relation="read",
        description=(
            "How many messages by others each conversation has that the caller "
            "has not read — for a channel list's badges."
        ),
        input_schema={"type": "object",
                      "properties": {"subject_ids": {"type": "array", "items": {"type": "string"}},
                                     "space_id": {"type": "string"}},
                      "required": ["subject_ids"]},
    ))

    reg.register(Op(
        name="messages.read",
        relation="read",
        mutating=True,
        description=(
            "Mark conversations read for the caller, up to now: one (`subject_id`), "
            "several (`subject_ids`), or every one with a notification (`all`). "
            "Changes only the caller's own read line, so reading is enough to do it."
        ),
        input_schema={"type": "object",
                      "properties": {"subject_id": {"type": "string"},
                                     "subject_ids": {"type": "array", "items": {"type": "string"}},
                                     "all": {"type": "boolean"}, **_KEY},
                      "required": ["idempotencyKey"]},
    ))


def register_channels(reg: Registry) -> None:
    """A channel's settings. `channels.list` and `channels.propose` are the
    type's own; whether a channel is private, and who is in a private one, is
    `items.set_visibility` and `items.share`, as for any shared item."""
    reg.register(Op(
        name="channels.update",
        relation="read",
        mutating=True,
        description="Rename a channel or change its topic. Anyone who may edit the channel.",
        input_schema={"type": "object",
                      "properties": {"channel_id": {"type": "string"},
                                     "name": {"type": "string", "description": "lowercase-with-hyphens, unique"},
                                     "topic": {"type": "string"}, **_KEY},
                      "required": ["channel_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="channels.archive",
        relation="read",
        mutating=True,
        description=("Archive a channel (kept and readable, closed to new messages), or bring it back with "
                     "`archived: false`. Its owners, or for a public channel a workspace admin."),
        input_schema={"type": "object",
                      "properties": {"channel_id": {"type": "string"}, "archived": {"type": "boolean"}, **_KEY},
                      "required": ["channel_id", "idempotencyKey"]},
    ))
