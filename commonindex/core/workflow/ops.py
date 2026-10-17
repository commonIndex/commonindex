"""The task verbs, registered into the one operation registry.

Same shape as `commonindex/core/generation/ops.py`: each definition names the
relation it needs, and the gateway serves it over HTTP and MCP from this one
list. `tasks.list`, `tasks.get` and `tasks.propose` are generated from the type
and served by purpose-built handlers that know what a task's state means.

The rules the descriptions state are the rules the handlers enforce — an agent
reading these over MCP is reading the contract, not a summary of it.
"""

from __future__ import annotations

from commonindex.core.ops import Op, Registry

_TASK = {"task_id": {"type": "string"}, "space_id": {"type": "string"},
         "idempotencyKey": {"type": "string"}}
_IF_REV = {"if_rev": {"type": "integer",
                      "description": "The revision you last read. Refused with 409 if the "
                                     "task has moved since, so a decision lands on what "
                                     "you saw."}}


def _mutation(**props) -> dict:
    return {"type": "object", "properties": {**_TASK, **props},
            "required": ["task_id", "idempotencyKey"]}


def register(reg: Registry) -> None:
    reg.register(Op(
        name="tasks.revise",
        relation="propose",
        mutating=True,
        description=(
            "Change a task's title, detail, definition of done or why it needs a "
            "person. Only while it is ready or in progress: a task in review is "
            "judged as it was filed, so changing it there would move the goalposts "
            "under the reviewer."
        ),
        input_schema=_mutation(
            **_IF_REV,
            title={"type": "string"},
            detail={"type": ["string", "null"]},
            criteria={"type": "array", "items": {"type": "string"},
                      "description": "The definition of done, one check per item. "
                                     "Replaces the list; a criterion whose text is "
                                     "unchanged keeps its answer."},
            human_only={"type": ["string", "null"],
                        "description": "Why this needs a person; null to allow agents."},
        ),
    ))

    reg.register(Op(
        name="tasks.start",
        relation="propose",
        mutating=True,
        description=(
            "Take a ready task yourself: it moves to in progress, assigned to you. "
            "An agent may take only a task whose definition of done is written "
            "down and which does not need a person."
        ),
        input_schema=_mutation(**_IF_REV),
    ))

    reg.register(Op(
        name="tasks.hand",
        relation="propose",
        mutating=True,
        description=(
            "Hand a ready task to an agent. Recorded as an `asked` event for that "
            "agent — the same one `agents.ask` writes — so it appears in the "
            "agent's `agents.inbox` and its run is claimed with `runs.start`. "
            "Refused when the task has no definition of done, needs a person, or "
            "the agent holds no propose grant in this space."
        ),
        input_schema={**_mutation(
            **_IF_REV,
            agent_id={"type": "string"},
            note={"type": "string", "description": "Anything the agent should know "
                                                   "beyond the task itself."},
        ), "required": ["task_id", "agent_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.assign",
        relation="propose",
        mutating=True,
        description=(
            "Say who works a task: a person in the workspace or an agent, by actor "
            "id, or null for nobody. A person on a ready task is who it is for; it "
            "stays ready until they start it. An in-progress task changes hands "
            "only from its assignee, or anyone who can merge here. An agent is a "
            "hand-over (see tasks.hand) and needs a ready task an agent can take."
        ),
        input_schema={**_mutation(
            **_IF_REV,
            assignee_id={"type": ["string", "null"],
                         "description": "An actor id from members.list or agents.list; null to unassign."},
            note={"type": "string"},
        ), "required": ["task_id", "assignee_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.release",
        relation="propose",
        mutating=True,
        description=(
            "Give an in-progress task back: it returns to ready, unassigned. Its "
            "assignee may release it, and so may anyone who can merge here."
        ),
        input_schema=_mutation(**_IF_REV, note={"type": "string"}),
    ))

    reg.register(Op(
        name="tasks.submit",
        relation="propose",
        mutating=True,
        description=(
            "File your work for review. Only the assignee may. Answer every "
            "criterion — `criteria_met` is one true or false per criterion, in "
            "order — because the reviewer judges the work against them, and a "
            "criterion nobody checked reads as one that passed."
        ),
        input_schema=_mutation(
            **_IF_REV,
            criteria_met={"type": "array", "items": {"type": "boolean"}},
            produced={"type": "object",
                      "description": "What the work produced: a label, and the object "
                                     "or the link it lives at.",
                      "properties": {"label": {"type": "string"},
                                     "object_id": {"type": "string"},
                                     "url": {"type": "string"}}},
            note={"type": "string"},
        ),
    ))

    reg.register(Op(
        name="tasks.accept",
        relation="merge",
        mutating=True,
        description=(
            "Accept work in review: the task is done. Not by the one who did it — "
            "an admin may accept their own work only by saying why, which is "
            "recorded. `if_rev` is required: an acceptance is for the version you "
            "read."
        ),
        input_schema={**_mutation(**_IF_REV, note={"type": "string"},
                                  self_accept={"type": "boolean"}),
                      "required": ["task_id", "if_rev", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.send_back",
        relation="merge",
        mutating=True,
        description=(
            "Return work in review to the one doing it, saying what to change. The "
            "task goes back in progress; an agent assignee is asked again with "
            "your note, so it reaches its inbox."
        ),
        input_schema={**_mutation(**_IF_REV, note={"type": "string"}),
                      "required": ["task_id", "note", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.question",
        relation="propose",
        mutating=True,
        description=(
            "Stop and ask a person, on a task you are working. Stopping to ask is a "
            "right answer, not a failure: the question shows on the board until "
            "someone answers it with `tasks.answer`."
        ),
        input_schema={**_mutation(question={"type": "string"}),
                      "required": ["task_id", "question", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.answer",
        relation="propose",
        mutating=True,
        description=(
            "Answer the question on a task. An agent assignee is asked again with "
            "the question and your answer, so its next run starts from it."
        ),
        input_schema={**_mutation(answer={"type": "string"}),
                      "required": ["task_id", "answer", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.link",
        relation="propose",
        mutating=True,
        description=(
            "Record how a task relates to another object: `caused` (it came from "
            "it), `touches` (the work changes it) or `depends` (the work needs it "
            "settled first). The edge type is the information."
        ),
        input_schema={**_mutation(object_id={"type": "string"},
                                  rel={"type": "string",
                                       "enum": ["caused", "touches", "depends"]}),
                      "required": ["task_id", "object_id", "rel", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.unlink",
        relation="propose",
        mutating=True,
        description="Remove a relation recorded with `tasks.link`.",
        input_schema={**_mutation(object_id={"type": "string"},
                                  rel={"type": "string",
                                       "enum": ["caused", "touches", "depends"]}),
                      "required": ["task_id", "object_id", "rel", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="tasks.linked",
        relation="read",
        description=(
            "The tasks linked to one object — what came from it, what touches it, "
            "what waits on it — for the object's own page, so the work about a "
            "thing is found from the thing. Each task says how it is linked (`rel`)."
        ),
        input_schema={"type": "object",
                      "properties": {"object_id": {"type": "string"},
                                     "space_id": {"type": "string"}},
                      "required": ["object_id"]},
    ))

    reg.register(Op(
        name="tasks.delete",
        relation="propose",
        mutating=True,
        description=(
            "Take a task off the board. Its creator may, and so may anyone who can "
            "merge here. A tombstone rather than an erasure — the history stays."
        ),
        input_schema=_mutation(),
    ))
