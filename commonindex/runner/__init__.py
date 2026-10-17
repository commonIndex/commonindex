"""Supervises agent runs.

Most agent work is never dispatched: the scheduler matches events against trigger
subscriptions, so an agent fires because something happened. Assignment is the
exception path, not the main one.

NOTE on the language decision: this is the weakest fit for Python in the estate.
Firecracker is supervised over a REST API on a unix socket, so it is workable,
but the orchestration ecosystem is Go-heavy. If one component is ever carved back
out to Go, it is this one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum


class Status(StrEnum):
    RUNNING = "running"
    DONE = "done"
    BLOCKED = "blocked"
    #: A PAUSED run, not a failed one. Ambiguity costs a minute of a human's
    #: attention instead of a dead run and a manual redo.
    ASKING = "asking"


@dataclass(slots=True)
class Run:
    id: str
    space_id: str
    agent_id: str
    trigger_seq: int | None
    status: Status
    cost_tokens: int = 0
    cost_usd: float = 0.0
    started_at: datetime | None = None
    ended_at: datetime | None = None


@dataclass(slots=True)
class Evidence:
    source: str
    ref: str
    says: str


@dataclass(slots=True)
class Question:
    """What an agent files instead of guessing.

    It carries the conflicting evidence that stopped it — that is the question's
    whole value, and what shows the agent was right to stop.
    """

    run_id: str
    doing: str
    question: str
    conflict: list[Evidence] = field(default_factory=list)
    options: list[str] = field(default_factory=list)
    #: The durable object the answer becomes — a superseding decision, a
    #: catalogue entry. Not a chat reply, or the same question is asked again
    #: next week.
    persists_to: str = ""


async def execute(trigger_seq: int) -> None:
    """Boot a sandbox for one triggered run.

    Two details carry the weight: the token is minted from the agent's OWN tuples
    and expires in minutes, so a leaked token is bounded in scope and time; and
    egress permits the MCP gateway, allow-listed connectors and model providers,
    and nothing else.

    Budget is checked at ADMISSION, before the sandbox boots — a runaway agent is
    bounded by not starting, not by cleanup.
    """
    raise NotImplementedError
