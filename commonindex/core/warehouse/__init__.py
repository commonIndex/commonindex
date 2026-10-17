"""The dashboard execution layer.

A panel is a spec, never SQL. It compiles to a dialect-free Query that every tier
consumes:

    Tier A  the customer's semantic layer (dbt, Cube, their BI tool) over MCP
            — preferred, because we hold no warehouse credentials at all
    Tier B  a direct warehouse connection
    Tier C  the event log — the platform's own numbers, no warehouse involved

WHY THIS PACKAGE IS SMALL. In Go this needed a hand-written engine spec per
warehouse, because Go has no SQLAlchemy. Here SQLAlchemy supplies connection,
pooling and introspection across fifty engines, and sqlglot transpiles dialects,
so what remains is the roughly forty percent SQLAlchemy does not cover — time
grains, analytics type mappings, capability flags and error mapping. BI tools
keep a per-engine directory for exactly that residue.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol


class TimeGrain(StrEnum):
    SECOND = "second"
    MINUTE = "minute"
    HOUR = "hour"
    DAY = "day"
    WEEK = "week"
    MONTH = "month"
    QUARTER = "quarter"
    YEAR = "year"
    #: Maps to the column directly — the usual convention, and the case every
    #: implementation forgets.
    NONE = ""

    @classmethod
    def parse(cls, v: str | None) -> TimeGrain:
        """Accept what a caller would plausibly send.

        The internal value of NONE is the empty string, which is convenient in
        SQL generation and a poor thing to put on a wire — so ``"none"``,
        ``null`` and ``""`` all mean the same here. Anything else raises, rather
        than silently degrading to no grain and returning a single number where
        a chart was expected.
        """
        if v in (None, "", "none", "null"):
            return cls.NONE
        return cls(v)


class ColKind(StrEnum):
    STRING = "string"
    NUMBER = "number"
    TIME = "time"
    BOOL = "bool"


@dataclass(slots=True)
class Window:
    start: datetime
    end: datetime


@dataclass(slots=True)
class Filter:
    dimension: str
    #: A key of ``build.OPS``, never a SQL fragment. See the table there for why.
    op: str
    values: list[Any] = field(default_factory=list)


@dataclass(slots=True)
class Query:
    """What a panel compiles to. Dialect-free on purpose: the same value goes to
    a semantic layer, to a SQL builder, or to the event log."""

    #: A ratified metric object, NEVER an inline expression.
    #:
    #: This one field is the whole difference from BI tools that permit adhoc
    #: metrics defined on a single chart. That is how six charts come to mean six
    #: different things by "refund rate" with no way to tell which the exec deck
    #: used.
    metric_id: str
    dataset_id: str
    #: The tenancy scope. Always applied by the event-log tier as the most
    #: selective predicate the planner sees; a customer warehouse has no
    #: equivalent, so tier B leaves it unset.
    space_id: str | None = None
    dimensions: list[str] = field(default_factory=list)
    grain: TimeGrain = TimeGrain.NONE
    #: Set by the ONE dashboard range control, so tiles and charts can never
    #: quote different periods.
    window: Window | None = None
    filters: list[Filter] = field(default_factory=list)
    limit: int = 0
    #: 'bucket' (chronological), 'value_desc' or 'value_asc'. A LIMIT without a
    #: deliberate ordering returns an arbitrary N, which is a top-N chart that
    #: is not showing the top of anything.
    order: str = "bucket"


@dataclass(slots=True)
class Dimension:
    name: str
    column: str
    kind: ColKind
    filterable: bool = True
    groupable: bool = True


@dataclass(slots=True)
class Dataset:
    """Where a number comes from.

    The metric registry says what a number MEANS; a dataset says where it comes
    from and which dimensions it can be sliced by. Without it, "refund rate by
    region" has a metric to bind and no way to resolve ``region``.
    """

    id: str
    connection_id: str
    #: A table name, or — when ``is_virtual`` — the SELECT that stands in for
    #: one: a "virtual dataset".
    physical: str
    #: Whether ``physical`` is a saved query rather than a table. It changes one
    #: line of SQL generation and nothing else: a virtual dataset is a FROM
    #: clause, so everything downstream (declared dimensions, ratified metrics,
    #: the window) applies to it identically.
    is_virtual: bool = False
    time_column: str | None = None
    grains: list[TimeGrain] = field(default_factory=list)
    dimensions: list[Dimension] = field(default_factory=list)
    metric_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class Capabilities:
    """Per-engine capability flags. They exist because query generation must
    degrade rather than fail: an engine without subqueries needs a different
    plan, not an error."""

    subqueries: bool = True
    joins: bool = True
    window_funcs: bool = True
    alias_in_select: bool = True
    cancel: bool = False
    max_dimensions: int = 0
    #: Whether the source can run a query AS the calling user. Where it can, we
    #: use it. Where it cannot, the connection is marked shared-principal and
    #: every panel bound to it inherits the marking visibly.
    #:
    #: We do NOT append predicates to compensate. String-built row-level security
    #: does exactly that, and a permission model built from string manipulation
    #: is the most common oversharing bug in BI.
    impersonation: bool = False


@dataclass(slots=True)
class Connection:
    """Stored configuration. Note what it does not contain: the credential.

    ``secret_ref`` is a handle into the KMS-backed store, resolved at connect
    time — the object graph is indexed, and an indexed credential is an
    exfiltrated credential.
    """

    id: str
    space_id: str
    kind: str
    dsn: str = ""  # host, port, database — no secret
    secret_ref: str | None = None
    read_only: bool = True
    impersonation: bool = False


@dataclass(slots=True)
class Result:
    columns: list[tuple[str, ColKind]]
    rows: list[list[Any]]
    from_cache: bool = False
    fetched: datetime | None = None


class Source(Protocol):
    """Executes a Query. One interface, three implementations."""

    @property
    def kind(self) -> str: ...

    async def datasets(self) -> list[Dataset]:
        """Introspection. Tier A reads the semantic layer's metadata (Cube's meta
        endpoint, dbt's manifest, a BI tool's list_metrics); tier B uses
        SQLAlchemy's Inspector; tier C returns a fixed set."""
        ...

    async def run(self, q: Query, as_principal: str) -> Result: ...

    def caps(self) -> Capabilities: ...


class UnratifiedMetric(Exception):
    """Only ratified definitions resolve at query time, so a natural-language
    question cannot silently invent semantics."""


class UndeclaredDimension(Exception):
    """Rejected upstream, never passed through."""
