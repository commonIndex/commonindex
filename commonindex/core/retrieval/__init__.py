"""The context plane: chunk, embed, search, pack.

Three legs, and the vector index is only one. Most questions worth asking a
workspace are half-structural — "the RATIFIED definition", "specs whose sync
proposal is PENDING", "what did THIS agent touch last week" — and pure similarity
cannot answer any of them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol


@dataclass(slots=True)
class Chunk:
    """The indexed unit.

    Which fields of an object become chunks is read from the type's ``prose``
    list, so this module contains no branch over collection names and never will.
    """

    id: int
    object_id: str
    space_id: str
    #: Carried so half-structural filters do not need a join back to objects on
    #: every hit. context-plane.md specifies it; the Go migration omitted it.
    object_type: str
    rev: int
    ord: int
    body: str
    acl_keys: list[str] = field(default_factory=list)

    #: None when the type declares no prose. Releases, runs, events and grants
    #: are indexed lexically and structurally, never embedded — the first two
    #: because they are the highest-volume tables with almost no semantic value,
    #: grants on principle, because a similarity index over permission data leaks
    #: the shape of the access model.
    embedding: list[float] | None = None

    #: Which model produced the embedding. Prose and code use different models,
    #: so one fixed column and one shared ANN graph would score a prose query
    #: against code vectors.
    model: str | None = None

    updated_at: datetime | None = None


@dataclass(slots=True)
class Hit:
    object_id: str
    score: float
    lexical: bool = False
    vector: bool = False


@dataclass(slots=True)
class Item:
    kind: str
    ref: str
    tokens: int
    body: str
    rev: int | None = None


class Searcher(Protocol):
    async def query(
        self, q: str, space_id: str, acl_keys: list[str], limit: int = 20
    ) -> list[Hit]:
        """Run lexical and vector in PARALLEL, in the SAME statements that apply
        the caller's ACL keys, then fuse with RRF, rerank the top ~50, re-verify,
        and expand one hop along edges.

        The ACL filter is a clause, not a step. That is the whole reason vectors
        live in this database: split across services and the pre-filter degrades
        into an application-level join against a key set.
        """
        ...


async def pack(
    object_id: str, budget_tokens: int, acl_keys: list[str]
) -> tuple[list[Item], list[Item]]:
    """Assemble a working set inside a token budget — the endpoint agents live on.

    Priority order is the contract, not a sort:

    1. the object at current rev
    2. its one-hop provenance neighbourhood
    3. recent events on it
    4. ratified definitions any of its numbers depend on

    Returns ``(kept, dropped)``. What does not fit is returned, not discarded:
    the caller stores it with any proposal the run produces, which is what makes
    a wrong edit diagnosable instead of mysterious.

    Token counting must be exact for the dropped set to mean anything. This is
    one of the reasons the platform is Python — tiktoken and the HF tokenizers
    are first-party here, and an approximate budget makes the receipt a guess.
    """
    raise NotImplementedError
