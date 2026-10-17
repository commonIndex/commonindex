"""What an item's page shows that is stored beside it, as text to index.

A dashboard's page is its panels — which definition each charts, and how —
and an experiment's is its registration, its readouts and the decisions made
on them. None of that is in the item's own fields, so indexing only those
found a dashboard by its title and nothing else. A type names its parts
(`parts` in its declaration); each is read here and indexed as sections of the
item — "Two warehouses › Panel: Latency" — so a result opens the page that
shows it.

A number is indexed only where it is a record: a readout's lift is what was
measured then, and stays true. A dashboard's current values are not — they
would be stale by the next load — and are read live instead (search.read).
"""

from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)

#: The latest readouts an experiment is indexed with; earlier ones are in its
#: history on the page.
READOUTS = 10
DECISIONS = 20

#: How a panel draws, as a reader would name it.
MARKS = {"line": "line chart", "area": "area chart", "bar": "bar chart", "stacked": "stacked bar chart",
         "pie": "pie chart", "table": "table", "pivot": "pivot table", "gauge": "gauge",
         "heatmap": "heatmap", "sql": "table"}


def _a(noun: str) -> str:
    return f"{'An' if noun[:1] in 'aeiou' else 'A'} {noun}"


def _props(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return json.loads(value)
    return dict(value or {})


def _day(at: Any) -> str:
    return str(at or "")[:10]


def _pct(x: Any, signed: bool = True) -> str:
    if not isinstance(x, (int, float)):
        return "?"
    return f"{x * 100:+.1f}%" if signed else f"{x * 100:.1f}%"


def number(x: Any, unit: str | None = None) -> str:
    """A value as a reader would say it: 12,400 / 3.25 ms / 0.0412."""
    if not isinstance(x, (int, float)):
        return "?"
    text = (f"{x:,.0f}" if abs(x) >= 1000 else f"{x:.2f}".rstrip("0").rstrip(".") if abs(x) >= 1
            else f"{x:.3g}")
    return f"{text}%" if unit == "%" else f"{text} {unit}" if unit else text


def _said(x: Any) -> str:
    """A note, whichever shape it was stored in."""
    if isinstance(x, dict):
        return str(x.get("text") or x.get("note") or x.get("message") or "")
    return str(x or "")


# ── the readers ──────────────────────────────────────────────────────────


async def panels(db, row, props) -> list[tuple[str, str]]:
    """Each panel: what it charts, how, from what — and whether anyone stands
    behind the definition."""
    out = []
    for r in await db.fetch("""
            select pb.title, pb.mark, pb.dimensions, pb.grain, pb.sql,
                   m.label, m.expr, m.unit, m.description, m.status,
                   d.name as dataset, dec.props as decided
              from panel_bindings pb
              join objects p on p.id = pb.panel_id and p.deleted_at is null
              -- Dashboard rendering follows the approved definition. Search
              -- context must not keep describing a deprecated display unit.
              left join lateral (
                  select definition.* from metrics definition
                   where definition.id = pb.metric_id
                     and definition.space_id in (p.space_id, '*')
                   order by (definition.status = 'ratified') desc,
                            (definition.space_id = '*'), definition.version desc
                   limit 1
              ) m on true
              left join datasets d on d.id = pb.dataset_id
              left join objects dec on dec.id = m.ratified_by
             where pb.dashboard_id = $1
             order by pb.position""", row["id"]):
        drawn = MARKS.get(r["mark"] or "", f"{r['mark']} chart" if r["mark"] else "line chart")
        if r["sql"]:
            text = (f"{_a(MARKS.get(r['mark'] or 'sql', 'table'))} of rows from its own SQL, which cites "
                    f"no ratified definition:\n{r['sql'][:1500]}")
        else:
            by = f" by {', '.join(r['dimensions'])}" if r["dimensions"] else ""
            unit = f" ({r['unit']})" if r["unit"] else ""
            said = [f"{_a(drawn)} of {r['label'] or r['title']}{unit}{by}, per {r['grain'] or 'day'}."]
            if r["description"]:
                said.append(r["description"])
            if r["expr"]:
                said.append(f"Defined as {r['expr']}" + (f" on {r['dataset']}." if r["dataset"] else "."))
            if r["status"] == "ratified":
                why = _props(r["decided"]).get("why") if r["decided"] else None
                said.append(f"Ratified: {why}." if why else "Ratified.")
            elif r["status"]:
                said.append(f"Its definition is {r['status']}, not ratified.")
            text = " ".join(said)
        out.append((f"Panel: {r['title']}", text))
    return out


async def registration(db, row, props) -> list[tuple[str, str]]:
    """What an experiment was registered to measure, before any data was seen."""
    c = props.get("contract") or {}
    if not c:
        return []
    guards = c.get("guardrails") or []
    ids = [i for i in (c.get("metric_id"), *(g.get("metric_id") for g in guards)) if i]
    labels = {r["id"]: r["label"] for r in await db.fetch(
        "select distinct on (id) id, label from metrics where id = any($1::text[])"
        " order by id, version desc", ids)} if ids else {}

    def named(metric_id, outcome):
        return labels.get(metric_id) or outcome or metric_id or "?"

    said = [f"Measures {named(c.get('metric_id'), c.get('outcome'))}"
            + (f" per {c['unit']}" if c.get("unit") else "") + "."]
    if c.get("weights"):
        said.append("Split " + ", ".join(f"{arm} {_pct(w, signed=False)}"
                                          for arm, w in c["weights"].items()) + ".")
    plan = [f"for {c['planned_days']} days"] if c.get("planned_days") else []
    if isinstance(c.get("mde"), (int, float)):
        plan.append(f"to detect a {_pct(c['mde'], signed=False)} change")
    if plan:
        said.append("Planned " + " ".join(plan)
                    + (f" at alpha {c['alpha']}" if c.get("alpha") else "") + ".")
    if guards:
        said.append("Guardrails: " + ", ".join(named(g.get("metric_id"), g.get("outcome"))
                                               for g in guards) + ".")
    if c.get("registered_by"):
        said.append(f"Registered by {c['registered_by']} on {_day(c.get('registered_at'))}.")
    return [("Registration", " ".join(said))]


def readout_text(p: dict[str, Any]) -> str:
    """A recorded readout, as a reader would summarise it: each outcome's
    lift and interval, the arms, and whether the split held."""
    said = []
    for res in p.get("results") or []:
        label = res.get("metric_label") or res.get("outcome") or "the outcome"
        if "error" in res:
            said.append(f"{label}: could not be read — {res['error']}.")
            continue
        role = " (guardrail)" if res.get("role") == "guardrail" else ""
        unit, binary = res.get("unit"), res.get("binary")

        def mean(v, binary=binary, unit=unit):
            return _pct(v, signed=False) if binary else number(v, unit)

        compared = []
        for c in res.get("comparisons") or []:
            ci = c.get("lift_ci")
            span = f", interval {_pct(ci[0])} to {_pct(ci[1])}" if ci and len(ci) == 2 else ""
            compared.append(f"{c.get('variation')} vs {c.get('baseline')} {_pct(c.get('lift'))}"
                            f"{span}: {c.get('verdict') or 'no verdict'}")
        arms = ", ".join(f"{a.get('name')} {mean(a.get('mean'))}"
                         + (f" (n={a['n']:,})" if isinstance(a.get("n"), int) else "")
                         for a in res.get("arms") or [])
        said.append(f"{label}{role}: " + ("; ".join(compared) or "no comparison")
                    + (f". Arms: {arms}." if arms else "."))
    srm = p.get("srm") or {}
    if srm.get("ran"):
        said.append("The sample ratio check passed." if srm.get("passed")
                    else f"The sample ratio check failed — look at {srm.get('worst')}.")
    said += [t for t in (_said(n) for n in p.get("contract_notes") or []) if t]
    said += [t for t in (_said(n) for n in p.get("caveats") or []) if t]
    if p.get("recorded_by"):
        said.append(f"Recorded by {p['recorded_by']}.")
    return "\n".join(said)


async def readouts(db, row, props) -> list[tuple[str, str]]:
    out = []
    for r in await db.fetch("""
            select r.title, r.props, r.created_at from edges e
              join objects r on r.id = e.src and r.type = 'readout' and r.deleted_at is null
             where e.dst = $1 and e.rel = 'for'
             order by r.created_at desc limit $2""", row["id"], READOUTS):
        when = r["title"].rsplit(" — ", 1)[-1] if " — " in (r["title"] or "") else _day(r["created_at"])
        text = readout_text(_props(r["props"]))
        if text:
            out.append((f"Readout {when}", text))
    return out


async def decisions(db, row, props) -> list[tuple[str, str]]:
    """What was decided about the item, why, by whom and when — ship or kill,
    an approval, the creation of a dashboard."""
    lines = []
    for r in await db.fetch("""
            select d.title, d.props, d.created_by, d.created_at from objects d
             where d.type = 'decision' and d.deleted_at is null and d.space_id = $2
               and (d.props->>'experiment_id' = $1 or d.props->>'design_id' = $1
                    or d.props->>'dashboard_id' = $1
                    or exists (select 1 from edges e where e.src = d.id and e.rel = 'decides'
                                                        and e.dst = $1))
             order by d.created_at desc limit $3""", row["id"], row["space_id"], DECISIONS):
        p = _props(r["props"])
        why = p.get("rationale") or p.get("why")
        lines.append(f"{r['title']}" + (f": {why}" if why else "")
                     + f" — {r['created_by']}, {_day(r['created_at'])}.")
    return [("Decisions", "\n".join(lines))] if lines else []


PARTS = {"panels": panels, "registration": registration, "readouts": readouts,
         "decisions": decisions}


async def sections(db, row, props, names: list[str]) -> list[tuple[str, str]]:
    """(heading, text) for each part a type names, in the order it names them."""
    out: list[tuple[str, str]] = []
    for name in names:
        reader = PARTS.get(name)
        if reader is None:   # a declaration naming a reader that does not exist
            log.warning("type %s names a part %r with no reader", row["type"], name)
            continue
        out += await reader(db, row, props)
    return out
