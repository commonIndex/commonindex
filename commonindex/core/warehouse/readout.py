"""Compile a readout query.

One GROUP BY returning (n, Σx, Σx²) per variation. That is sufficient for both
tests in `stats`, and it means the warehouse does the aggregation — which is
what it is for, and the difference between a readout that works on a billion
exposures and one that does not.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import Dataset, UndeclaredDimension, Window
from .build import Compiled, quote
from .dialects import EngineSpec

#: How several rows for one unit become one observation.
UNIT_AGGS = {"sum": "SUM", "max": "MAX", "min": "MIN", "avg": "AVG", "count": "COUNT"}


@dataclass(slots=True)
class Spec:
    """What to read out. Deliberately not a Query: a readout groups by the
    variation column and needs second moments, neither of which a panel does."""

    dataset_id: str
    #: The column naming the arm each unit was exposed to.
    variation: str
    #: The per-unit outcome. For a proportion this is 0/1.
    outcome: str
    #: A 0/1 outcome needs no Σx² — its variance is p(1−p) exactly.
    binary: bool = True
    window: Window | None = None

    #: The column identifying the unit of randomisation — usually a user.
    #:
    #: Without it the outer COUNT counts ROWS, and a dataset with several rows
    #: per user makes every standard error wrong in the dangerous direction.
    #: Measured on 20,000 users triplicated: identical lift, an interval 1.73x
    #: too narrow, and a p-value 5.5 million times too small. No error, no
    #: warning — just a result that says ship.
    unit: str | None = None
    #: How that unit's rows collapse to one observation.
    unit_agg: str = "sum"
    #: Cap each unit's value before aggregating — winsorization at the unit
    #: level, which is only expressible once there IS a unit level.
    cap: float | None = None
    #: Split every arm by a second dimension — platform, plan, new-vs-returning.
    #:
    #: One query, grouped by both, rather than one readout per cohort: the arms
    #: of a cohort have to be compared against each other, not against the whole
    #: population, and summing the cohorts back up recovers the overall numbers
    #: exactly, so the overall reading costs nothing extra.
    cohort: str | None = None

    #: Whether a unit with no matching outcome rows counts as zero.
    #:
    #: For "revenue per exposed user" it does: they were exposed and spent
    #: nothing. For a latency guardrail where a null means missing
    #: instrumentation it does not, and imputing zero understates by however
    #: much is missing. The choice was previously unmade rather than made.
    null_is_zero: bool = True


def build(spec_e: EngineSpec, ds: Dataset, s: Spec) -> Compiled:
    """SELECT variation, COUNT(*), SUM(x), [SUM(x*x)] GROUP BY variation."""
    declared = {d.name: d.column for d in ds.dimensions}
    for col in (s.variation, s.outcome):
        if col not in declared:
            # The same rule the panel builder applies. An experiment is not an
            # exemption from it: a readout naming a column the dataset does not
            # declare is a readout of something else.
            raise UndeclaredDimension(col)

    if s.unit and s.unit not in declared:
        raise UndeclaredDimension(s.unit)
    if s.cohort and s.cohort not in declared:
        raise UndeclaredDimension(s.cohort)
    if s.unit_agg not in UNIT_AGGS:
        raise ValueError(f"unit_agg must be one of {sorted(UNIT_AGGS)}")

    d = spec_e.sqlglot_dialect
    var, out = quote(declared[s.variation], d), quote(declared[s.outcome], d)
    # A yes/no outcome (converted, retained) is summed as 1/0. SUM(boolean) is
    # an error in Postgres, so a boolean column could not be an outcome at all.
    kind = next((x.kind for x in ds.dimensions if x.name == s.outcome), None)
    if getattr(kind, "value", kind) == "bool":
        out = f"CASE WHEN {out} THEN 1 ELSE 0 END"
    coh = quote(declared[s.cohort], d) if s.cohort else None

    src = f"({ds.physical}) AS src" if ds.is_virtual else quote(ds.physical, d)
    params: dict = {}
    where = ""
    if ds.time_column:
        if s.window is None:
            raise ValueError(
                f"{ds.id} declares a time column, so a readout must carry a window")
        tc = quote(ds.time_column, d)
        where = f" WHERE {tc} >= :start AND {tc} < :end"
        params = {"start": s.window.start, "end": s.window.end}

    if s.unit:
        # Collapse to one observation per unit FIRST, then aggregate the arms.
        # This is the level at which capping is expressible and at which a count
        # counts what the experiment randomised.
        unit_col = quote(declared[s.unit], d)
        value = f"{UNIT_AGGS[s.unit_agg]}({out})"
        if s.null_is_zero:
            value = f"COALESCE({value}, 0)"
        if s.cap is not None:
            # Emitted through sqlglot rather than written out, because the
            # comment that used to be here — "LEAST is in every dialect" — was
            # wrong. SQLite has no LEAST at all and errors with "no such
            # function", so capping was broken there and nothing caught it
            # because no test used a cap. sqlglot knows the local spelling:
            # MIN on SQLite, a null-guarded CASE on DuckDB, LEAST elsewhere.
            import sqlglot
            from sqlglot import exp as X

            value = X.Least(
                this=sqlglot.parse_one(value, dialect=d),
                expressions=[X.Literal.number(float(s.cap))],
            ).sql(dialect=d)
        # The cohort travels through the per-unit collapse, otherwise a unit
        # would be pooled across cohorts before either is counted.
        coh_sel = f", {coh} AS cohort" if coh else ""
        coh_grp = f", {coh}" if coh else ""
        inner = (f"SELECT {var} AS variation{coh_sel}, {value} AS v"
                 f" FROM {src}{where} GROUP BY {var}{coh_grp}, {unit_col}")
        src, where = f"({inner}) AS per_unit", ""
        # The window is bound on the inner query; the outer one adds nothing.
        var, out = "variation", "v"
        if coh:
            coh = "cohort"

    cols = [f"{var} AS variation"]
    if coh:
        cols.append(f"{coh} AS cohort")
    cols += ["COUNT(*) AS n", f"SUM({out}) AS total"]
    if not s.binary:
        cols.append(f"SUM({out} * {out}) AS sum_sq")
    sql = f"SELECT {', '.join(cols)} FROM {src}{where}"

    # Ordered so the control is first when named conventionally, and stable
    # otherwise — a readout that reorders its arms between runs reads as
    # movement that did not happen.
    group = f"{var}, {coh}" if coh else var
    sql += f" GROUP BY {group} ORDER BY {group}"
    return Compiled(sql=sql, params=params)


def build_many(spec_e: EngineSpec, ds: Dataset, specs: list[Spec]) -> Compiled:
    """Every outcome of one readout in a single pass over the table.

    `build` reads one outcome per query, so a readout of twenty-three metrics
    scanned the experiment's table twenty-four times — linear in the metrics and
    in the rows, which on a warehouse of any size is the difference between a
    page that opens and one that does not. Everything but the outcome is shared
    across a readout (dataset, arm column, unit, window, cohort, how a unit's
    rows collapse), so one GROUP BY can carry every outcome's Σx and Σx² side by
    side: column `total_<i>` and `sum_sq_<i>` for the i-th spec, and one `n`,
    which is the same for all of them because it counts units (or rows), never
    outcome values.

    The per-outcome SQL is exactly `build`'s — the same boolean cast, the same
    per-unit collapse, cap and null rule — so the numbers cannot differ.
    """
    if not specs:
        raise ValueError("no outcomes to read")
    first = specs[0]
    shared = ("dataset_id", "variation", "window", "unit", "unit_agg", "cap", "cohort", "null_is_zero")
    for s in specs[1:]:
        for f in shared:
            if getattr(s, f) != getattr(first, f):
                raise ValueError(f"outcomes read together must share {f}")

    declared = {d.name: d.column for d in ds.dimensions}
    for col in [first.variation, *(s.outcome for s in specs)]:
        if col not in declared:
            raise UndeclaredDimension(col)
    if first.unit and first.unit not in declared:
        raise UndeclaredDimension(first.unit)
    if first.cohort and first.cohort not in declared:
        raise UndeclaredDimension(first.cohort)
    if first.unit_agg not in UNIT_AGGS:
        raise ValueError(f"unit_agg must be one of {sorted(UNIT_AGGS)}")

    d = spec_e.sqlglot_dialect
    var = quote(declared[first.variation], d)
    outs = [_outcome_sql(ds, declared, s.outcome, d) for s in specs]
    coh = quote(declared[first.cohort], d) if first.cohort else None

    src = f"({ds.physical}) AS src" if ds.is_virtual else quote(ds.physical, d)
    params: dict = {}
    where = ""
    if ds.time_column:
        if first.window is None:
            raise ValueError(
                f"{ds.id} declares a time column, so a readout must carry a window")
        tc = quote(ds.time_column, d)
        where = f" WHERE {tc} >= :start AND {tc} < :end"
        params = {"start": first.window.start, "end": first.window.end}

    if first.unit:
        unit_col = quote(declared[first.unit], d)
        values = ", ".join(f"{_unit_value(first, o, d)} AS v{i}" for i, o in enumerate(outs))
        coh_sel = f", {coh} AS cohort" if coh else ""
        coh_grp = f", {coh}" if coh else ""
        inner = (f"SELECT {var} AS variation{coh_sel}, {values}"
                 f" FROM {src}{where} GROUP BY {var}{coh_grp}, {unit_col}")
        src, where = f"({inner}) AS per_unit", ""
        var = "variation"
        outs = [f"v{i}" for i in range(len(specs))]
        if coh:
            coh = "cohort"

    cols = [f"{var} AS variation"]
    if coh:
        cols.append(f"{coh} AS cohort")
    cols.append("COUNT(*) AS n")
    for i, (s, o) in enumerate(zip(specs, outs, strict=True)):
        cols.append(f"SUM({o}) AS total_{i}")
        if not s.binary:
            cols.append(f"SUM({o} * {o}) AS sum_sq_{i}")
    group = f"{var}, {coh}" if coh else var
    sql = f"SELECT {', '.join(cols)} FROM {src}{where} GROUP BY {group} ORDER BY {group}"
    return Compiled(sql=sql, params=params)


def _outcome_sql(ds: Dataset, declared: dict, outcome: str, d) -> str:
    """The outcome column, with a yes/no column summed as 1/0 — `build`'s rule."""
    out = quote(declared[outcome], d)
    kind = next((x.kind for x in ds.dimensions if x.name == outcome), None)
    if getattr(kind, "value", kind) == "bool":
        out = f"CASE WHEN {out} THEN 1 ELSE 0 END"
    return out


def _unit_value(s: Spec, out: str, d) -> str:
    """One unit's rows collapsed to one observation — `build`'s rule."""
    value = f"{UNIT_AGGS[s.unit_agg]}({out})"
    if s.null_is_zero:
        value = f"COALESCE({value}, 0)"
    if s.cap is not None:
        import sqlglot
        from sqlglot import exp as X

        value = X.Least(
            this=sqlglot.parse_one(value, dialect=d),
            expressions=[X.Literal.number(float(s.cap))],
        ).sql(dialect=d)
    return value


#: Names treated as the control arm when one is not named explicitly. A readout
#: has to compare against something, and guessing wrong silently inverts every
#: lift on the page.
CONTROL_NAMES = ("control", "0", "a", "baseline", "off", "false")


def pick_control(names: list[str], explicit: str | None = None) -> str:
    if explicit:
        if explicit not in names:
            raise ValueError(f"no arm called {explicit!r}; found {names}")
        return explicit
    for candidate in CONTROL_NAMES:
        for n in names:
            if n.lower() == candidate:
                return n
    return names[0]


def counts(spec_e: EngineSpec, ds: Dataset, variation: str, *,
           unit: str | None = None, window: Window | None = None) -> Compiled:
    """SELECT variation, COUNT(*) GROUP BY variation — for the SRM check.

    Separate from `build` because it needs no outcome column. An SRM check is
    the one thing worth asking BEFORE choosing what to measure, and requiring an
    outcome to ask it would mean the cheapest, most important query could only
    be run as part of the most expensive one.

    `unit` is honoured for the same reason it exists in `Spec`, and it matters
    more here: a chi-square statistic scales linearly in N, so counting rows in
    a dataset with k rows per user multiplies it by k and reports a catastrophic
    mismatch for a split that is exactly even.
    """
    declared = {d.name: d.column for d in ds.dimensions}
    if variation not in declared:
        raise UndeclaredDimension(variation)
    if unit and unit not in declared:
        raise UndeclaredDimension(unit)

    d = spec_e.sqlglot_dialect
    var = quote(declared[variation], d)
    src = f"({ds.physical}) AS src" if ds.is_virtual else quote(ds.physical, d)

    params: dict = {}
    where = ""
    if ds.time_column:
        if window is None:
            raise ValueError(
                f"{ds.id} declares a time column, so a count must carry a window")
        tc = quote(ds.time_column, d)
        where = f" WHERE {tc} >= :start AND {tc} < :end"
        params = {"start": window.start, "end": window.end}

    if unit:
        inner = (f"SELECT {var} AS variation FROM {src}{where}"
                 f" GROUP BY {var}, {quote(declared[unit], d)}")
        return Compiled(
            sql=f"SELECT variation, COUNT(*) AS n FROM ({inner}) AS per_unit"
                " GROUP BY variation ORDER BY variation",
            params=params)

    return Compiled(
        sql=f"SELECT {var} AS variation, COUNT(*) AS n FROM {src}{where}"
            f" GROUP BY {var} ORDER BY {var}",
        params=params)


def extent(spec_e: EngineSpec, ds: Dataset) -> Compiled:
    """The first and last time the table recorded anything.

    Unwindowed on purpose: this is how the dates of an experiment registered
    after the fact are found, and a window would presume the answer.
    """
    if not ds.time_column:
        raise ValueError(f"{ds.id} declares no time column, so it has no dates to read")
    d = spec_e.sqlglot_dialect
    src = f"({ds.physical}) AS src" if ds.is_virtual else quote(ds.physical, d)
    tc = quote(ds.time_column, d)
    return Compiled(
        sql=f"SELECT MIN({tc}) AS first_seen, MAX({tc}) AS last_seen, COUNT(*) AS n FROM {src}",
        params={})


def honours(expr: str | None, outcome: str, dialect: str | None = None) -> bool:
    """Whether a readout can compute what this metric's expression says.

    A readout is (n, Σx, Σx²) per arm — sums over ROWS — so the only definition
    it can reproduce exactly is the mean of the outcome column. `AVG(converted)`
    it honours; `AVG(CASE WHEN refunded = 1 THEN 0 ELSE converted END)` it does
    not, and the difference is not academic: measured on 8,000 users, a panel
    citing that definition read a +27.1% lift while a readout citing the SAME id
    read +33.2%.

    That is the exact drift the registry exists to prevent, arriving through the
    registry itself, so the answer is to refuse the binding rather than let two
    surfaces quietly disagree about one id.

    The real fix is a metric that separates its row-level value from its
    aggregate — `expr` conflates them, which is why there is nothing here to
    sum. Until then this refuses precisely the cases it cannot honour.
    """
    if not expr:
        return False
    import sqlglot
    from sqlglot import exp as X

    try:
        tree = sqlglot.parse_one(expr, dialect=dialect)
    except Exception:  # noqa: BLE001 - an unparseable expression is not honoured
        return False
    if not isinstance(tree, X.Avg):
        return False
    inner = tree.this
    if not isinstance(inner, X.Column):
        return False
    return inner.name.lower() == outcome.lower()
