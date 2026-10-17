"""Export the semantic layer as Apache Ossie.

Ossie (incubating, formerly Open Semantic Interchange) is a vendor-neutral
specification for exchanging semantic metadata between analytics, BI and AI
tools. Its pitch — "stop redefining Revenue in every dashboard" — is the
argument the metric registry here makes, so the mapping is close:

    Ossie                 here
    ─────────────────     ────────────────────────────────────────
    semantic model        a space
    dataset               a row in `datasets` (table or saved query)
    field                 a declared dimension
    metric                a RATIFIED row in `metrics`
    relationship          not modelled — see below

The first version of this module did not conform. It invented `spec_version`
instead of `version`, made `semantic_model` a mapping where the schema says
array, used `table`/`sql` instead of `source`, wrote flat expression strings
where the schema wants `{dialects: [{dialect, expression}]}`, and prefixed
non-spec keys with `x-` — an OpenAPI convention that Ossie does not share. The
schema sets ``additionalProperties: false`` at every level, so all of those
were hard rejections rather than tolerated extras. tests/test_semantic_context.py
now validates the output against the published schema, which is the check that
would have caught it.

Ossie's own escape hatch is ``custom_extensions: [{vendor_name, data}]``, and
its ``ai_context`` is a first-class place for instructions, synonyms and
examples — which is exactly where a dataset's grain, caveats and query corpus
belong. Nothing here needs to be smuggled in.
"""

from __future__ import annotations

from typing import Any

#: The spec version the schema pins. Not a choice: the schema declares
#: ``"const": "0.2.0.dev0"``, so any other value fails validation.
SPEC_VERSION = "0.2.0.dev0"

VENDOR = "commonindex"


def ext(data: dict[str, Any]) -> list[dict[str, str]]:
    """A CustomExtension. `data` is typed as a JSON *string* in the schema, not
    an object — so it is serialised rather than nested, which is the difference
    between a valid document and one a consumer rejects."""
    import json

    return [{"vendor_name": VENDOR, "data": json.dumps(data, default=str)}]

#: Ossie's DataType enum, from ours. Ours are deliberately few — time, number,
#: string is all the query builder needs to decide what a column can do — so
#: this widens rather than narrows, and anything unrecognised becomes Opaque
#: rather than silently becoming a String it may not be.
_DATATYPE = {"time": "DateTimeTz", "number": "Decimal", "string": "String"}


#: Ossie's dialect enum. Postgres, DuckDB and SQLite are not in it, so they map
#: to ANSI_SQL — which slightly over-claims, since a Postgres `DATE_TRUNC` is not
#: ANSI. ANSI_SQL is the only generic option the enum offers, and naming the
#: engine in the vendor extension is where the precise answer lives.
_DIALECT = {
    "postgres": "ANSI_SQL", "duckdb": "ANSI_SQL", "sqlite": "ANSI_SQL",
    "snowflake": "SNOWFLAKE", "bigquery": "BIGQUERY",
}


def expr(sql: str, dialect: str) -> dict[str, Any]:
    """An Ossie Expression: one SQL string per dialect it is valid in.

    We emit exactly one, because a metric expression here is authored against a
    single connection and has never been checked anywhere else. Claiming it is
    valid in dialects nobody has run it in is the sort of unearned portability
    an interchange format makes very easy to assert.
    """
    return {"dialects": [{"dialect": _DIALECT.get(dialect, "ANSI_SQL"),
                          "expression": sql}]}


def to_ossie(space: str, datasets: list[dict], metrics: list[dict],
             dialect: str = "postgres", corpus: dict[str, list[dict]] | None = None
             ) -> dict[str, Any]:
    """Build the document. Plain dicts in, plain dict out — no database, no core
    imports, so it is testable against the published schema directly."""
    corpus = corpus or {}
    ratified = [m for m in metrics if m.get("status") == "ratified"]

    out_datasets = []
    for d in datasets:
        fields = []
        for dim in d.get("dimensions") or []:
            name = dim.get("name")
            if not name:
                # A dimension with no name cannot be referenced by anything, and
                # raising here would 500 a whole export over one bad row.
                continue
            f: dict[str, Any] = {
                "name": name,
                "expression": expr(dim.get("column") or name, dialect),
                "datatype": _DATATYPE.get(dim.get("kind"), "Opaque"),
            }
            # `time_column` is a COLUMN name; a dimension carries name and column
            # separately. Compare against the column, or a declared dataset whose
            # dimension is aliased would mark the wrong field as the timeline.
            if (dim.get("column") or name) == d.get("time_column"):
                f["dimension"] = {"is_time": True}
            fields.append(f)

        entry: dict[str, Any] = {
            "name": d["id"],
            # A saved query and a table are both "source" — the schema says
            # "physical table/view or query", so the distinction that matters
            # here is carried in the extension rather than by inventing a key.
            "source": d["physical"],
            "fields": fields,
        }
        if d.get("description"):
            entry["description"] = d["description"]

        ai = _ai_context(
            instructions=" ".join(x for x in (d.get("grain_note"), d.get("caveats")) if x))
        if ai:
            entry["ai_context"] = ai

        x = {"is_virtual": bool(d.get("is_virtual"))}
        if d.get("time_column"):
            x["time_column"] = d["time_column"]
        if d.get("grains"):
            x["time_grains"] = [str(g) for g in d["grains"]]
        entry["custom_extensions"] = ext(x)
        out_datasets.append(entry)

    known = {d["id"] for d in datasets}
    out_metrics = []
    for m in ratified:
        ds = m.get("dataset_id")
        mm: dict[str, Any] = {"name": m["id"], "expression": expr(m["expr"], dialect)}
        if m.get("description"):
            mm["description"] = m["description"]
        ai = _ai_context(
            instructions=m.get("description") or "",
            examples=[_example(u) for u in (corpus.get(m["id"]) or [])[:4]])
        if ai:
            mm["ai_context"] = ai
        mm["custom_extensions"] = ext({
            "dataset": ds,
            # A ratified metric with no dataset cannot be compiled against
            # anything. Saying so beats dropping it silently, which is what the
            # first version did — twice, in two different places.
            "orphaned": ds is None or ds not in known,
            "unit": m.get("unit"), "better": m.get("better"),
            "ratified_by": m.get("ratified_by"), "version": m.get("version"),
        })
        out_metrics.append(mm)

    model: dict[str, Any] = {
        "name": space,
        "description": f"Ratified semantic layer for the {space} workspace.",
        "datasets": out_datasets,
    }
    if out_metrics:
        model["metrics"] = out_metrics
    model["custom_extensions"] = ext({
        "omitted_unratified": [m["id"] for m in metrics if m.get("status") == "proposed"],
        "omitted_deprecated": [m["id"] for m in metrics if m.get("status") == "deprecated"],
        "notes": [
            ("Only ratified definitions are exported. An interchange format is "
             "where an unreviewed number would escape into another tool looking "
             "reviewed, so the withheld ids are listed here rather than dropped."),
            ("Relationships are not modelled: a dataset here is one table or one "
             "saved query, and a join is written into a virtual dataset."),
        ],
    })
    # `datasets` has minItems: 1, so a space with none cannot produce a valid
    # model. Returning an empty list of models is the honest shape.
    return {"version": SPEC_VERSION,
            "semantic_model": [model] if out_datasets else []}


def _ai_context(instructions: str = "", examples: list[str] | None = None):
    ctx: dict[str, Any] = {}
    if instructions:
        ctx["instructions"] = instructions
    if examples:
        ctx["examples"] = [e for e in examples if e]
    return ctx or None


def _example(u: dict) -> str:
    """One reviewed panel, as a sentence. These are the query corpus: not a
    sample of what people tried, but what was reviewed and kept."""
    bits = [f"drawn as a {u.get('mark', 'line')}"]
    if u.get("grain") and u["grain"] != "none":
        bits.append(f"bucketed by {u['grain']}")
    if u.get("dimensions"):
        bits.append(f"split by {', '.join(u['dimensions'])}")
    for f in (u.get("filters") or []):
        bits.append(f"filtered where {f.get('dimension')} {f.get('op', 'eq')} "
                    f"{', '.join(map(str, f.get('values') or []))}")
    return "; ".join(bits)


def dump(doc: dict[str, Any]) -> str:
    import yaml

    def plain(v):
        # asyncpg returns numeric as Decimal, which safe_dump refuses. Nothing
        # currently selected is numeric, and "currently" is why this is here.
        from decimal import Decimal

        if isinstance(v, Decimal):
            return float(v)
        if isinstance(v, dict):
            return {k: plain(x) for k, x in v.items()}
        if isinstance(v, list):
            return [plain(x) for x in v]
        return v

    return yaml.safe_dump(plain(doc), sort_keys=False, width=100, allow_unicode=True)
