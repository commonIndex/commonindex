"""An experiment's life after registration: start, stop, decide — and plan.

`types/experiment.json` has always listed draft → running → readout → shipped |
killed, and the detail page has always promised "hypothesis → contract →
readout → decision". Nothing moved an experiment between those states, so the
last step did not exist: every live experiment sat at "running · day 0"
forever, and "why did we ship?" pointed at a readout nobody could connect to
the decision it justified.

Who may do what follows the rest of the platform:

* start and stop need `propose` — they are facts about traffic, and the owner
  (or their agent) is who knows them;
* deciding needs `merge`, like merging a pull request or ratifying a metric: it
  is the step other people act on;
* a decision cites the recorded readout it was made on and is written as a
  decision object, so the justification survives the warehouse moving on;
* shipping on a readout whose sample-ratio check failed is refused. The numbers
  in it are confounded; killing or iterating on them is still allowed, since
  stopping a broken experiment is exactly what should happen.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request

from commonindex.gateway.auth import actor_of, space_of
from commonindex.gateway.authoring import (
    NoSuchConnection,
    _error,
    _known_actor,
    _source,
    _when,
)
from commonindex.workers.indexer import index_object

router = APIRouter()

#: Statuses an experiment can be in before a decision, and after one.
OPEN = ("draft", "running", "readout")
#: "iterate" is not a kill: this version is not shipped, the idea goes on to
#: a follow-up. Counted as killed, it inflated the kill count and hid the loop.
DECIDED = {"ship": "shipped", "kill": "killed", "iterate": "iterated"}


def progress(props: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Day N of M, worked out from the dates rather than stored.

    `day` was a stored field nothing ever updated, so every live experiment
    said "day 0/14" for as long as it ran.
    """
    now = now or datetime.now(tz=UTC)
    planned = int(props.get("days") or (props.get("contract") or {}).get("planned_days") or 14)
    started = _when(props.get("started_at"))
    if started is None:
        return {"day": 0, "days": planned, "started_at": None, "ends_at": None,
                "due": False, "stopped_at": props.get("stopped_at")}
    stopped = _when(props.get("stopped_at"))
    end = min(stopped or now, now)
    day = max(0, math.floor((end - started).total_seconds() / 86400))
    ends_at = started + timedelta(days=planned)
    status = props.get("status") or "draft"
    return {"day": day, "days": planned, "started_at": started.isoformat(),
            "ends_at": ends_at.isoformat(), "stopped_at": props.get("stopped_at"),
            # Reached its planned length and still nobody has decided.
            "due": status in ("running", "readout") and day >= planned}


def attention(props: dict[str, Any], prog: dict[str, Any]) -> list[str]:
    """Why this experiment needs somebody, in words — the reasons Review lists."""
    status = props.get("status") or "draft"
    out = []
    if status not in OPEN:
        return out
    if prog["due"]:
        out.append(f"reached its planned {prog['days']} days — decide")
    if status == "readout":
        out.append("stopped and waiting for a decision")
    if props.get("srm_passed") is False:
        out.append("the last readout's sample-ratio check failed")
    if props.get("guardrail") == "breach":
        out.append("a guardrail got worse")
    if status in ("running", "readout") and not props.get("contract"):
        out.append("no contract, so it cannot be read out")
    return out


async def _experiment(conn, experiment_id: str, space: str):
    row = await conn.fetchrow(
        "select id, title, props from objects where id = $1 and space_id = $2"
        "   and type = 'experiment' and deleted_at is null", experiment_id, space)
    if row is None:
        return None, None
    props = row["props"]
    props = json.loads(props) if isinstance(props, str) else dict(props or {})
    return row, props


async def _save(conn, experiment_id: str, props: dict[str, Any]) -> None:
    await conn.execute(
        "update objects set props = $2::jsonb, updated_at = now() where id = $1",
        experiment_id, json.dumps(props))
    await index_object(conn, experiment_id)


def _body_id(body: dict) -> str:
    return (body.get("experiment_id") or "").strip()


@router.post("/api/v1/experiments.start")
async def experiments_start(req: Request):
    """Say when traffic began. Every readout reads from here on."""
    state = req.app.state.commonindex
    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key",
                      "idempotencyKey")
    now = datetime.now(tz=UTC)
    started = _when(body.get("started_at")) if body.get("started_at") else now
    if started is None:
        return _error(422, "bad_date", "started_at must be an ISO date or date-time", "started_at")
    if started > now + timedelta(minutes=5):
        return _error(422, "future_start",
                      "an experiment cannot have started in the future — start it when "
                      "traffic begins", "started_at")
    async with state["pool"].acquire() as conn:
        row, props = await _experiment(conn, _body_id(body), space)
        if row is None:
            return _error(404, "unknown_experiment", f"no experiment {_body_id(body)}", "experiment_id")
        if not props.get("contract"):
            return _error(422, "not_pre_registered",
                          "register a contract before starting — an experiment that starts "
                          "without one has nothing to be held to", "experiment_id")
        status = props.get("status") or "draft"
        if props.get("started_at") and status == "running":
            return {"experiment_id": row["id"], "status": "running",
                    "started_at": props["started_at"], "already": True}

        # An experiment stopped before its dates were ever recorded — every one
        # that predates this operation. Its dates can be written once, stop
        # included, and it stays stopped. Changing dates already on record is
        # refused: moving the window after the numbers are visible is the
        # choice pre-registration exists to take away.
        if status == "readout":
            if props.get("started_at"):
                return _error(409, "dates_on_record",
                              f"{row['id']} already has its dates on record; they are "
                              "not moved after the numbers have been seen", "started_at")
            stopped = _when(body.get("stopped_at")) if body.get("stopped_at") else None
            if body.get("stopped_at") and stopped is None:
                return _error(422, "bad_date", "stopped_at must be an ISO date or date-time",
                              "stopped_at")
            if stopped is not None and not started <= stopped <= now + timedelta(minutes=5):
                return _error(422, "bad_dates",
                              "stopped_at must fall between started_at and now", "stopped_at")
            props.update({"started_at": started.isoformat(), "started_by": actor,
                          # Recorded as written after the fact, so a reader can
                          # tell a start somebody reported from one noted live.
                          "dates_recorded": {"at": now.isoformat(), "by": actor}})
            if stopped is not None:
                props["stopped_at"] = stopped.isoformat()
            await _save(conn, row["id"], props)
            return {"experiment_id": row["id"], "status": "readout",
                    "started_at": started.isoformat(),
                    "stopped_at": props.get("stopped_at"), "already": False}

        if body.get("stopped_at"):
            return _error(422, "not_stopped",
                          "only an experiment that has already stopped takes a stop date "
                          "here — stop a running one with experiments.stop", "stopped_at")
        if status not in ("draft", "running"):
            return _error(409, "not_startable", f"{row['id']} is {status}", "experiment_id")
        props.update({"status": "running", "started_at": started.isoformat(),
                      "started_by": actor})
        await _save(conn, row["id"], props)
    return {"experiment_id": row["id"], "status": "running",
            "started_at": started.isoformat(), "already": False}


@router.post("/api/v1/experiments.extent")
async def experiments_extent(req: Request):
    """When traffic in the experiment's table starts and ends.

    For an experiment whose dates were never recorded, this is the best
    evidence of when it ran, and a far better default than today — which is
    what a date field falls back to, and which would have read nothing.
    """
    from sqlalchemy import text as sa_text

    from commonindex.core.warehouse.readout import extent

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    async with state["pool"].acquire() as conn:
        row, props = await _experiment(conn, _body_id(body), space)
    if row is None:
        return _error(404, "unknown_experiment", f"no experiment {_body_id(body)}", "experiment_id")
    contract = props.get("contract") or {}
    if not contract.get("connection_id") or not contract.get("dataset_id"):
        return _error(422, "not_pre_registered", "no contract names a table to read",
                      "experiment_id")
    try:
        src, _ = await _source(state, contract["connection_id"], space)
        ds = await src._dataset(contract["dataset_id"])
        compiled = extent(src._spec, ds)
    except (NoSuchConnection, LookupError) as e:
        return _error(404, "unknown_target", str(e), None)
    except ValueError as e:
        return _error(422, "no_time_column", str(e), None)

    def go(c):
        return c.execute(sa_text(compiled.sql), compiled.params).mappings().first()

    async def go_async(c):
        return (await c.execute(sa_text(compiled.sql), compiled.params)).mappings().first()

    try:
        got = await (src._do(go_async) if src.is_async else src._do(go))
    except Exception as e:  # noqa: BLE001 - the author's dataset is the cause
        return _error(422, "unreadable", str(e), None)

    def iso(v):
        if v is None:
            return None
        if isinstance(v, str):
            return v
        return (v if v.tzinfo else v.replace(tzinfo=UTC)).isoformat()

    return {"experiment_id": row["id"], "first_seen": iso(got["first_seen"]) if got else None,
            "last_seen": iso(got["last_seen"]) if got else None,
            "rows": int(got["n"] or 0) if got else 0}


@router.post("/api/v1/experiments.stop")
async def experiments_stop(req: Request):
    """Stop traffic being counted; readouts read up to here."""
    state = req.app.state.commonindex
    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key",
                      "idempotencyKey")
    now = datetime.now(tz=UTC)
    async with state["pool"].acquire() as conn:
        row, props = await _experiment(conn, _body_id(body), space)
        if row is None:
            return _error(404, "unknown_experiment", f"no experiment {_body_id(body)}", "experiment_id")
        status = props.get("status") or "draft"
        if status == "readout":
            return {"experiment_id": row["id"], "status": "readout",
                    "stopped_at": props.get("stopped_at"), "already": True}
        if status != "running":
            return _error(409, "not_running", f"{row['id']} is {status}; only a running "
                          "experiment can be stopped", "experiment_id")
        props.update({"status": "readout", "stopped_at": now.isoformat(), "stopped_by": actor,
                      **({"stop_reason": body["reason"]} if body.get("reason") else {})})
        await _save(conn, row["id"], props)
    return {"experiment_id": row["id"], "status": "readout", "stopped_at": now.isoformat(),
            "already": False}


@router.post("/api/v1/experiments.decide")
async def experiments_decide(req: Request):
    """Ship, kill or iterate — on the record, citing what it was decided on."""
    state = req.app.state.commonindex
    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key",
                      "idempotencyKey")
    outcome = body.get("decision")
    if outcome not in DECIDED:
        return _error(422, "bad_decision", "decision must be ship, kill or iterate", "decision")
    rationale = (body.get("rationale") or "").strip()
    if not rationale:
        return _error(422, "reason_required",
                      "say why — a decision without a reason is the thing nobody can "
                      "answer a year later", "rationale")
    now = datetime.now(tz=UTC)
    async with state["pool"].acquire() as conn:
        why = await _known_actor(conn, actor)
        if why:
            return _error(422, "unknown_actor", why, "actor_id")
        row, props = await _experiment(conn, _body_id(body), space)
        if row is None:
            return _error(404, "unknown_experiment", f"no experiment {_body_id(body)}", "experiment_id")
        status = props.get("status") or "draft"
        if status not in ("running", "readout"):
            return _error(409, "not_decidable",
                          f"{row['id']} is {status}; only a running or stopped experiment "
                          "can be decided", "experiment_id")

        readout_id = body.get("readout_id") or props.get("last_readout")
        readout = None
        if readout_id:
            got = await conn.fetchrow(
                "select id, props from objects where id = $1 and space_id = $2"
                "   and type = 'readout' and props->>'experiment_id' = $3",
                readout_id, space, row["id"])
            if got is None:
                return _error(404, "unknown_readout",
                              f"no recorded readout {readout_id} for {row['id']}", "readout_id")
            readout = json.loads(got["props"]) if isinstance(got["props"], str) else got["props"]
        elif outcome == "ship":
            # Shipping is the decision people act on; it has to point at numbers.
            return _error(409, "no_readout",
                          "record a readout before shipping — a ship decision cites the "
                          "numbers it was made on", "readout_id")

        srm = (readout or {}).get("srm") or {}
        if outcome == "ship" and srm.get("ran") and not srm.get("passed"):
            return _error(409, "srm_failed",
                          "that readout's sample-ratio check failed, so its numbers are "
                          "confounded with whatever broke the split. Kill or iterate, or "
                          "fix the assignment and read it again.", "readout_id")

        decision_id = f"dec-{row['id']}-{now:%Y%m%d%H%M%S}"
        async with conn.transaction():
            await conn.execute(
                "insert into objects (id, space_id, type, title, props, created_by)"
                " values ($1,$2,'decision',$3,$4::jsonb,$5) on conflict (id) do nothing",
                decision_id, space, f"{outcome.capitalize()} {row['title']}",
                json.dumps({"experiment_id": row["id"], "decision": outcome,
                            "rationale": rationale, "readout_id": readout_id,
                            "lift": props.get("lift")}), actor)
            await conn.execute(
                "insert into edges (src, rel, dst, created_by) values ($1,'decides',$2,$3)"
                " on conflict do nothing", decision_id, row["id"], actor)
            if readout_id:
                await conn.execute(
                    "insert into edges (src, rel, dst, created_by) values ($1,'cites',$2,$3)"
                    " on conflict do nothing", decision_id, readout_id, actor)
            props.update({
                "status": DECIDED[outcome],
                "stopped_at": props.get("stopped_at") or now.isoformat(),
                "decision": {"outcome": outcome, "rationale": rationale, "by": actor,
                             "at": now.isoformat(), "readout_id": readout_id,
                             "decision_id": decision_id, "lift": props.get("lift"),
                             # Whether the numbers it was made on can be read at
                             # all. A kill on a broken split carries a lift that
                             # measures the breakage, not the change.
                             "srm_passed": srm.get("passed") if srm.get("ran") else None},
            })
            await _save(conn, row["id"], props)
    return {"experiment_id": row["id"], "status": DECIDED[outcome],
            "decision_id": decision_id, "readout_id": readout_id}


@router.post("/api/v1/experiments.plan")
async def experiments_plan(req: Request):
    """Units and days needed to see the effect — from the table when it can."""
    from sqlalchemy import text as sa_text

    from commonindex.core.inference.plan import plan as size
    from commonindex.core.warehouse import UndeclaredDimension, Window
    from commonindex.core.warehouse.readout import Spec
    from commonindex.core.warehouse.readout import build as build_readout

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    said = body.get("binary")
    binary = bool(said) if said is not None else True
    baseline, sd, daily = body.get("baseline"), body.get("sd"), body.get("daily_units")
    measured: dict[str, Any] = {}

    # Read what the table already knows: traffic per day, and the outcome's
    # current level. A plan built on a guessed baseline is a guess.
    # Needs the arm column too: the readout's query groups by it. A table for an
    # experiment that has not started yet has none, and then the author's own
    # numbers are the plan.
    if (body.get("connection_id") and body.get("dataset_id") and body.get("outcome")
            and body.get("variation")):
        try:
            src, _ = await _source(state, body["connection_id"], space)
            ds = await src._dataset(body["dataset_id"])
        except (NoSuchConnection, LookupError) as e:
            return _error(404, "unknown_target", str(e), None)
        if said is None:
            # Unsaid, the column says: assuming 0/1 sized revenue per user as a
            # proportion and refused it, so the page lost its "needed".
            from commonindex.core.warehouse import ColKind
            kind = next((d.kind for d in ds.dimensions if d.name == body["outcome"]), None)
            if kind is ColKind.NUMBER:
                binary = False
        lookback = int(body.get("lookback_days") or 14)
        now = datetime.now(tz=UTC)
        spec = Spec(dataset_id=ds.id, variation=body["variation"],
                    outcome=body["outcome"], cohort=None, unit=body.get("unit"),
                    unit_agg=body.get("unit_agg") or "sum", cap=body.get("cap"),
                    null_is_zero=bool(body.get("null_is_zero", True)),
                    binary=binary,
                    window=Window(now - timedelta(days=lookback), now) if ds.time_column else None)
        try:
            compiled = build_readout(src._spec, ds, spec)

            def go(conn, _c=compiled):
                return conn.execute(sa_text(_c.sql), _c.params).mappings().all()

            async def go_async(conn, _c=compiled):
                return (await conn.execute(sa_text(_c.sql), _c.params)).mappings().all()

            rows = await (src._do(go_async) if src.is_async else src._do(go))
        except (UndeclaredDimension, ValueError) as e:
            return _error(422, "unplannable", str(e), None)
        except Exception as e:  # noqa: BLE001 - the author's dataset is the cause
            return _error(422, "unplannable", str(e), None)
        if not sum(int(r["n"] or 0) for r in rows) and spec.window is not None:
            # Nothing recent — a table whose experiment has finished, say. The
            # baseline can still be read from all of it; the daily traffic
            # cannot, so it is left unknown rather than guessed.
            spec = replace(spec, window=Window(datetime(1970, 1, 1, tzinfo=UTC), now))
            try:
                again = build_readout(src._spec, ds, spec)
                rows = await (src._do(lambda c: go_async(c, again)) if src.is_async
                              else src._do(lambda c: go(c, again)))
            except Exception as e:  # noqa: BLE001 - the author's dataset is the cause
                return _error(422, "unplannable", str(e), None)
            measured["note"] = (f"no traffic in the last {lookback} days, so the baseline "
                                "is read from the whole table and the days are left open")
            lookback_used = None
        else:
            lookback_used = lookback
        control = body.get("control")
        use = [r for r in rows if control and str(r["variation"]) == control] or list(rows)
        n = sum(int(r["n"]) for r in use)
        total = sum(float(r["total"] or 0) for r in use)
        if n:
            mean = total / n
            measured["baseline"] = mean
            if not binary and all(r.get("sum_sq") is not None for r in use):
                ss = sum(float(r["sum_sq"]) for r in use)
                measured["sd"] = math.sqrt(max(ss / n - mean * mean, 0.0))
        all_n = sum(int(r["n"]) for r in rows)
        if ds.time_column and all_n and lookback_used:
            measured["daily_units"] = all_n / lookback_used
        measured["lookback_days"] = lookback_used if ds.time_column else None
        baseline = baseline if baseline is not None else measured.get("baseline")
        sd = sd if sd is not None else measured.get("sd")
        daily = daily if daily is not None else measured.get("daily_units")

    if baseline is None or body.get("mde") is None:
        return _error(422, "incomplete_plan",
                      "a plan needs a baseline (or a table to read one from) and an mde",
                      "baseline" if baseline is None else "mde")
    try:
        p = size(baseline=float(baseline), mde=float(body["mde"]),
                 alpha=float(body.get("alpha") or 0.05), power=float(body.get("power") or 0.8),
                 binary=binary, sd=float(sd) if sd is not None else None,
                 weights=body.get("weights") or None, control=body.get("control") or "control",
                 sequential=bool(body.get("sequential", True)),
                 daily_units=float(daily) if daily else None)
    except ValueError as e:
        return _error(422, "unplannable", str(e), None)
    planned = body.get("planned_days")
    return {
        "per_arm": p.per_arm, "total": p.total, "delta": p.delta,
        "sequential": p.sequential, "days": p.days, "assumptions": p.assumptions,
        "measured": measured,
        # The comparison the plan exists to make.
        # Unknown, not "no", when the traffic could not be measured.
        **({"enough": None if p.days is None else p.days <= int(planned),
            "planned_days": int(planned)} if planned else {}),
    }


@router.post("/api/v1/experiments.program")
async def experiments_program(req: Request):
    """The portfolio, grouped from the experiments this space really holds.

    The program page used to compute this in the browser over 240 generated
    rows plus the real ones, so its ship rate and median win described data
    that did not exist.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    rows = await state["pool"].fetch(
        "select props from objects where space_id = $1 and type = 'experiment'"
        "   and deleted_at is null", space)
    exps = [json.loads(r["props"]) if isinstance(r["props"], str) else (r["props"] or {})
            for r in rows]
    now = datetime.now(tz=UTC)

    def status(e):
        return e.get("status") or "draft"

    def improvement(e):
        d = e.get("decision") or {}
        if d.get("srm_passed") is False:
            return None        # a lift off a broken split is not an effect size
        lift = d.get("lift", e.get("lift"))
        if lift is None or not e.get("better"):
            return None
        return lift if e["better"] == "up" else -lift

    def median(xs):
        xs = sorted(xs)
        if not xs:
            return 0
        m = len(xs) // 2
        return xs[m] if len(xs) % 2 else round((xs[m - 1] + xs[m]) / 2, 1)

    decided = [e for e in exps if status(e) in ("shipped", "killed", "iterated")]
    shipped = [e for e in decided if status(e) == "shipped"]
    killed = [e for e in decided if status(e) == "killed"]
    iterated = [e for e in decided if status(e) == "iterated"]
    unshipped = killed + iterated
    by_metric: dict[str, dict[str, int]] = {}
    for e in decided:
        # The cited definition, or else the column it measured: a bar labelled
        # "—" said nothing about what the decided tests were trying to move.
        name = e.get("metric") or ((e.get("contract") or {}).get("outcome")) or "no metric named"
        m = by_metric.setdefault(name, {"shipped": 0, "killed": 0, "iterated": 0})
        m[status(e)] += 1
    edges = [-15, -10, -5, 0, 5, 10, 15]
    dist = []
    for i, lo in enumerate([-math.inf, *edges]):
        hi = edges[i] if i < len(edges) else math.inf
        label = (f"≤{edges[0]}" if lo == -math.inf else f"≥+{lo}" if hi == math.inf
                 else f"+{lo}" if lo > 0 else str(lo))

        def inside(e, lo=lo, hi=hi):
            v = improvement(e)
            return v is not None and lo <= v < hi

        dist.append({"label": label, "lo": edges[0] - 5 if lo == -math.inf else lo,
                     "shipped": sum(1 for e in shipped if inside(e)),
                     "killed": sum(1 for e in killed if inside(e)),
                     "iterated": sum(1 for e in iterated if inside(e))})
    return {
        "total": len(exps),
        "draft": sum(1 for e in exps if status(e) == "draft"),
        "running": sum(1 for e in exps if status(e) == "running"),
        "readout": sum(1 for e in exps if status(e) == "readout"),
        "attention": sum(1 for e in exps if attention(e, progress(e, now))),
        "decided": len(decided), "shipped": len(shipped), "killed": len(killed),
        "iterated": len(iterated),
        "winRate": round(len(shipped) / len(decided) * 100) if decided else 0,
        "medianWin": median([v for e in shipped if (v := improvement(e)) is not None]),
        "medianLoss": median([v for e in unshipped if (v := improvement(e)) is not None]),
        "medianRun": median([progress(e, now)["day"] or int(e.get("days") or 0) for e in decided]),
        "byMetric": sorted(
            [{"metric": k, **v, "rate": round(v["shipped"] / (v["shipped"] + v["killed"] + v["iterated"]) * 100)}
             for k, v in by_metric.items()],
            key=lambda r: -(r["shipped"] + r["killed"] + r["iterated"])),
        "dist": dist,
    }


@router.post("/api/v1/experiments.references")
async def experiments_references(req: Request):
    """What points at this experiment.

    The decisions made on it and the readouts recorded for it are edges into it;
    a design drawn from it lists it in its `sources`. None of that was visible
    from the experiment, so "what did we build on this result?" meant searching
    everything else for its id.
    """
    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    eid = _body_id(body)
    async with state["pool"].acquire() as conn:
        row, _ = await _experiment(conn, eid, space)
        if row is None:
            return _error(404, "unknown_experiment", f"no experiment {eid}", "experiment_id")
        edges = await conn.fetch(
            "select o.id, o.type, o.key, o.title, o.created_by, o.created_at, e.rel"
            "  from edges e join objects o on o.id = e.src"
            " where e.dst = $1 and o.space_id = $2 and o.deleted_at is null"
            " order by o.created_at desc limit 200", eid, space)
        cited = await conn.fetch(
            "select id, type, key, title, created_by, created_at, 'sources' as rel"
            "  from objects where space_id = $1 and deleted_at is null"
            "   and id <> $2 and props->'sources' ? $2"
            " order by created_at desc limit 200", space, eid)
    seen: set[str] = set()
    out: dict[str, list[dict[str, Any]]] = {"decisions": [], "readouts": [], "cited_by": []}
    for r in [*edges, *cited]:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        item = {"id": r["id"], "type": r["type"], "key": r["key"], "title": r["title"],
                "by": r["created_by"], "at": r["created_at"].isoformat(), "rel": r["rel"]}
        bucket = ("decisions" if r["type"] == "decision"
                  else "readouts" if r["type"] == "readout" else "cited_by")
        out[bucket].append(item)
    return {"experiment_id": eid, **out,
            "total": sum(len(v) for v in out.values())}
