"""Compiles a dialect-free Query into SQL.

Written once and never learns which warehouse it targets: identifier quoting is
sqlglot's job, and only the EngineSpec's grains vary.

A note on what sqlglot does here and what it does not. Three comments in this
file used to claim it transpiled the finished statement into the target dialect.
It did not — it was never called at all, and the statement was returned exactly
as concatenated, so ``public.Orders`` reached Postgres as ``public.orders`` and a
column named ``order`` was a syntax error. Full transpilation is also not
available: sqlglot rewrites ``:start`` into ``%(start)s`` for Postgres, which
SQLAlchemy's ``text()`` does not bind. So it is used for the part that is
actually broken — quoting every identifier — and the grains stay the
EngineSpec's job.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import ColKind, Dataset, Query, TimeGrain, UndeclaredDimension, UnratifiedMetric
from .dialects import EngineSpec


def quote(name: str, dialect: str | None) -> str:
    """Quote an identifier the way this engine wants it.

    Dotted names are quoted part by part, so ``public.Orders`` becomes
    ``"public"."Orders"`` and not the single quoted string ``"public.Orders"``,
    which names a table with a dot in it.

    These names come from introspection, not from a request body — the request
    only chooses among them (``authoring._definition`` and ``_check_binding``
    reject anything the dataset does not declare). Quoting is therefore about
    correctness for reserved words and mixed case, and is a second line rather
    than the thing standing between the API and injection.
    """
    import sqlglot

    return ".".join(
        sqlglot.exp.to_identifier(part, quoted=True).sql(dialect=dialect)
        for part in name.split(".")
    )


#: Filter operators, as a closed table from a name to (SQL, how many values).
#:
#: ``Filter.op`` used to be interpolated straight into the statement, and its own
#: docstring said the values were ``eq | in | gt | lt | between | contains`` —
#: which rendered as ``status eq :f0``. Not a SQL operator, not valid, and never
#: exercised because nothing in the gateway ever built a Filter. A closed table
#: means the operator can never be caller-supplied text, and the arity is
#: declared next to it so a two-value operator cannot be handed one value.
OPS: dict[str, tuple[str, int]] = {
    "eq": ("=", 1), "ne": ("<>", 1),
    "gt": (">", 1), "gte": (">=", 1), "lt": ("<", 1), "lte": ("<=", 1),
    "in": ("IN", -1), "not_in": ("NOT IN", -1),
    "contains": ("LIKE", 1), "starts_with": ("LIKE", 1),
    "is_null": ("IS NULL", 0), "is_not_null": ("IS NOT NULL", 0),
    "between": ("BETWEEN", 2),
}


#: The LIKE escape character.
#:
#: Not a backslash. Inside a string literal a backslash is itself an escape on
#: more than half the engines here, so `ESCAPE '\'` terminated nothing and
#: consumed the rest of the statement.
ESCAPE = "!"


class BadFilter(ValueError):
    pass


def coerce_values(values: list, kind: ColKind, where: str) -> list:
    """Bring filter values to the column's declared type.

    A filter value arrives from an HTTP body, and a form posts strings. The
    driver does not: asyncpg refuses ``'100'`` for a numeric column with
    ``invalid input for query argument $3: '100' (must be real number)``, so
    every numeric filter the UI offered failed on execution rather than at the
    point somebody typed it. The dataset already declares the column's kind —
    it is what decides whether a column is a measure or a slice — so the
    conversion has an authority and does not have to guess.

    Deliberately narrow. This coerces a value to the type the column IS; it
    does not parse ``"last tuesday"`` or accept ``"1,000"``. A value that will
    not convert is the author's mistake and is named as one.
    """
    if kind is ColKind.NUMBER:
        out = []
        for v in values:
            if isinstance(v, bool) or not isinstance(v, str):
                out.append(v)
                continue
            try:
                out.append(int(v) if v.strip().lstrip("+-").isdigit() else float(v))
            except ValueError:
                raise BadFilter(f"{where} is a number, and {v!r} is not one") from None
        return out
    if kind is ColKind.BOOL:
        out = []
        for v in values:
            if isinstance(v, bool):
                out.append(v)
            elif isinstance(v, str) and v.strip().lower() in _TRUE | _FALSE:
                out.append(v.strip().lower() in _TRUE)
            else:
                raise BadFilter(f"{where} is true or false, and {v!r} is neither")
        return out
    # Strings and times pass through: a time column is not offered as a filter
    # (the range control owns that axis), and the drivers accept ISO text.
    return list(values)


_TRUE = {"true", "t", "yes", "y", "1"}
_FALSE = {"false", "f", "no", "n", "0"}


@dataclass(slots=True)
class Compiled:
    """SQL and the parameters it expects, produced together.

    They used to be produced apart — the statement here, the bind values in
    ``sources/direct.py`` — which is two implementations of one contract that
    only agree by inspection. Adding an operator that binds two values, or one
    that binds none, silently broke the other half.
    """

    sql: str
    params: dict


@dataclass(slots=True)
class Metric:
    """A resolved definition — a ratified version, already looked up."""

    id: str
    version: int
    expr: str
    unit: str | None = None
    better: str | None = None


def build(spec: EngineSpec, ds: Dataset, m: Metric, q: Query) -> Compiled:
    """Return SQL in ``spec``'s dialect.

    Two things are resolved BEFORE this, and neither belongs here: the metric id
    has become an expression by looking up a RATIFIED version, and every
    dimension has been checked against the dataset's declared list.
    """
    if not m.expr:
        raise UnratifiedMetric(q.metric_id)
    if q.grain is not TimeGrain.NONE and not ds.time_column:
        raise ValueError("grain requested but the dataset declares no time column")

    declared = {d.name: d.column for d in ds.dimensions}
    for name in q.dimensions:
        if name not in declared:
            raise UndeclaredDimension(name)

    dialect = spec.sqlglot_dialect
    select, group = [], []
    if q.grain is not TimeGrain.NONE:
        bucket = spec.bucket(q.grain, quote(ds.time_column, dialect))
        select.append(f"{bucket} AS bucket")
        group.append(bucket)
    for name in q.dimensions:
        col = quote(declared[name], dialect)
        select.append(f"{col} AS {quote(name, dialect)}")
        # Group by the EXPRESSION, never the alias: BigQuery rejects an alias in
        # some positions, so grouping by expression is correct everywhere and the
        # builder needs no capability branch.
        group.append(col)
    select.append(f"{m.expr} AS value")

    # A virtual dataset is a subquery, not an identifier. Quoting it as one
    # produced `FROM "select ... from proposals"` — a table whose name is a
    # whole query. The schema has carried `is_virtual` since 0002 and the
    # builder never read it.
    #
    # Note what does NOT change below: the window, the declared dimensions and
    # the ratified metric all apply to the subquery exactly as they apply to a
    # table. That is the point of putting the SQL here rather than in the
    # metric — where the rows come from is a different question from what the
    # number means, and only the second one needs ratifying.
    source = f"({ds.physical}) AS src" if ds.is_virtual else quote(ds.physical, dialect)
    sql = f"SELECT {', '.join(select)} FROM {source}"

    # Anything with a time column is bounded, and bounded by force: an
    # unbounded scan of a warehouse fact table is how a dashboard becomes a
    # billing incident, so a caller cannot opt out by omitting the window.
    #
    # A dataset with NO time column cannot be bounded at all, and pretending
    # otherwise emitted `WHERE None >= :start` — which is how a lookup table
    # became unqueryable rather than merely unbounded. Those are dimension
    # tables (memberships, relation types); they are small, and their size is a
    # property of the dataset rather than something this line can enforce.
    where = []
    if ds.time_column:
        if q.window is None:
            raise ValueError(
                f"{ds.id} declares a time column, so a query against it must carry a window")
        tc = quote(ds.time_column, dialect)
        where.append(f"{tc} >= :start AND {tc} < :end")
    # Values are bound, never interpolated — a read-only connection still leaks
    # the shape of a table through string-built predicates.
    params: dict = {}
    if q.window is not None:
        params |= {"start": q.window.start, "end": q.window.end}

    for i, f in enumerate(q.filters):
        if f.dimension not in declared:
            raise UndeclaredDimension(f.dimension)
        if f.op not in OPS:
            raise BadFilter(f"unknown operator {f.op!r}; expected one of {sorted(OPS)}")
        sql_op, arity = OPS[f.op]
        col = quote(declared[f.dimension], dialect)

        if arity == 0:
            where.append(f"{col} {sql_op}")
        elif arity == -1:
            if not f.values:
                raise BadFilter(f"{f.op} needs at least one value")
            # Expanded into one placeholder per value rather than binding a list.
            # SQLAlchemy's text() has no expanding parameter, so `IN :f0` with a
            # list binds the list AS ONE VALUE — a comparison against an array,
            # which in Postgres is a type error and elsewhere is silently false.
            names = [f"f{i}_{k}" for k in range(len(f.values))]
            where.append(f"{col} {sql_op} ({', '.join(':' + n for n in names)})")
            params |= dict(zip(names, f.values, strict=True))
        elif arity == 2:
            if len(f.values) != 2:
                raise BadFilter(f"{f.op} needs exactly two values, got {len(f.values)}")
            where.append(f"{col} {sql_op} :f{i}_lo AND :f{i}_hi")
            params[f"f{i}_lo"], params[f"f{i}_hi"] = f.values
        else:
            if len(f.values) != 1:
                raise BadFilter(f"{f.op} needs exactly one value, got {len(f.values)}")
            v = f.values[0]
            # The wildcards belong to the operator, not to the user's text — so a
            # value containing % or _ matches those characters rather than
            # turning into a wildcard the author did not ask for.
            if f.op in ("contains", "starts_with"):
                # `!`, not `\`. A backslash inside a string literal IS an escape
                # on MySQL, MariaDB, BigQuery, Snowflake, Redshift, ClickHouse
                # and Databricks, so `ESCAPE '\'` escaped its own closing quote
                # and the literal swallowed the rest of the statement — eight of
                # thirteen engines, on any `contains` or `starts_with` filter,
                # both of which the dashboard filter bar offers. `!` is not
                # special in a string literal anywhere and parses on all of them.
                esc = (str(v).replace(ESCAPE, ESCAPE * 2)
                       .replace("%", f"{ESCAPE}%").replace("_", f"{ESCAPE}_"))
                v = f"{esc}%" if f.op == "starts_with" else f"%{esc}%"
                where.append(f"{col} {sql_op} :f{i} ESCAPE '{ESCAPE}'")
            else:
                where.append(f"{col} {sql_op} :f{i}")
            params[f"f{i}"] = v

    if where:
        sql += " WHERE " + " AND ".join(where)

    if group:
        sql += " GROUP BY " + ", ".join(group)
        # Ordering by the first group expression is right for a timeline and
        # wrong for everything else: "top 10 agents by cost" needs the ORDER BY
        # on the measure, and without it a LIMIT returns an arbitrary ten.
        if q.order == "value_desc":
            sql += " ORDER BY value DESC"
        elif q.order == "value_asc":
            sql += " ORDER BY value ASC"
        else:
            sql += " ORDER BY " + group[0]
    elif q.order in ("value_desc", "value_asc"):
        sql += f" ORDER BY value {'DESC' if q.order == 'value_desc' else 'ASC'}"

    if q.limit:
        # An integer, formatted — never a bind parameter, because several
        # dialects will not take one in LIMIT. Coerced here so a string can
        # never reach the statement.
        #
        # T-SQL has no LIMIT: the bound goes in the SELECT clause as TOP n. It
        # was emitted as a suffix regardless, so on MSSQL every panel with a row
        # limit was a syntax error.
        sql = spec.limit(sql, int(q.limit))

    # Returned as built. Identifiers are already quoted per dialect above; the
    # statement is deliberately NOT round-tripped through sqlglot, because that
    # rewrites the bind placeholders (see the module docstring).
    return Compiled(sql=sql, params=params)
