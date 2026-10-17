"""AI on an experiment: explain its readout, draft a decision, write it up.

The statistics stay where they are. The model is handed the readout the engine
computed — values, intervals, verdicts, the split check — and asked only for
words around it. Two things are checked in code, not trusted to a prompt:

- every number it writes must be one the readout holds (a 9B model will
  otherwise round, invert or invent), and
- its recommendation must be one the verdicts allow: never "ship" with a
  guardrail that got worse or a target that did not get better, and nothing
  but "iterate" when the split check failed.

A reply that breaks either is sent back with the rule it broke, as the
dashboard assistant does; one that still breaks it is refused rather than shown.

The write-up is not the model's: it is built from the readout by code, so a doc
that records why something shipped cannot say anything the numbers did not.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.adapters.model import Blocked, Truncated, Unconfigured, configured, generate
from commonindex.gateway.auth import space_of
from commonindex.gateway.authoring import _error
from commonindex.gateway.llm import LlmTruncated, budget

router = APIRouter()
#: An answer and one correction, told every rule the first broke.
ATTEMPTS = 2
#: Summaries already written, by space, experiment and the readout they read.
#: The page asks for one on every load; a local model takes 15-20 seconds,
#: and the numbers have usually not changed since the last person looked.
#: Keyed by the facts themselves, so new data or a new day writes a new one.
_SUMMARIES: OrderedDict[tuple[str, str, str], dict] = OrderedDict()
_WRITING: dict[tuple[str, str, str], asyncio.Future] = {}
_KEEP = 256

TEXT = {"type": "string", "minLength": 1, "maxLength": 240}
SUMMARY_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "headline": {"type": "string", "minLength": 1, "maxLength": 160},
        "summary": {"type": "string", "minLength": 1, "maxLength": 900},
        "recommendation": {"enum": ["ship", "kill", "iterate", "keep_running"]},
        "reasons": {"type": "array", "items": TEXT, "minItems": 1, "maxItems": 4},
        "next_steps": {"type": "array", "items": TEXT, "maxItems": 3},
    },
    "required": ["headline", "summary", "recommendation", "reasons"],
}
RATIONALE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"rationale": {"type": "string", "minLength": 1, "maxLength": 700}},
    "required": ["rationale"],
}

RULES = """Rules:
- Use only numbers that appear in the facts, written as they appear there (a rate is already a percentage).
- The verdict on each metric is given; never contradict it. "no difference detected" is not a win or a loss —
  do not call it significant, a trend, or directional.
- A guardrail whose verdict is "worse" is a regression: name it before any improvement.
- If direction_assumed is true for a metric, say its direction was assumed.
- If the split check failed, no lift can be read: say the assignment must be fixed first.
- If many metrics were compared, do not single out one "better" guardrail as the story.
- If still_running is true, the experiment is still running: never say it ended or stopped.
- Plain words for a product team. No markdown, no headings, no emoji."""

EXPLAIN_SYSTEM = f"""You explain an A/B test readout that a statistics engine has already computed.
Return JSON matching the schema: a one-line headline, a 2-4 sentence summary, a recommendation
(ship, kill, iterate, or keep_running), up to four reasons, and up to three next steps.
{RULES}"""

RATIONALE_SYSTEM = f"""You draft the rationale a person will record with their decision on an A/B test.
The decision is theirs and is given; write 2-4 sentences explaining it from the readout, in the first
person plural ("we"). If the readout argues against the decision (for example shipping with a guardrail
that got worse), say plainly what is being accepted and why it might be acceptable — do not hide it.
{RULES}"""


class _As:
    """The same caller asking for something else: the same app, the same
    grants, a different body. Lets this module use the readout and docs
    handlers as they are, rather than a second copy of their rules."""

    def __init__(self, req: Request, body: dict):
        self._req, self._body = req, body

    def __getattr__(self, name: str) -> Any:
        return getattr(self._req, name)

    async def json(self) -> dict:
        return self._body

    async def body(self) -> bytes:
        return json.dumps(self._body).encode()


def _humanise(name: str) -> str:
    return name.replace("_", " ").strip().capitalize()


def _r(x: float | None, n: int = 1) -> float | None:
    return None if x is None else round(float(x), n)


def facts_of(record: dict, readout: dict) -> dict:
    """The readout, shaped for a model to read and for its numbers to be held to:
    a rate as a percentage, a change as a percentage, an interval as two."""
    exp = record.get("experiment") or {}
    prog = record.get("progress") or {}
    srm = readout.get("srm") or {}
    metrics, counted = [], 0
    for r in readout.get("results") or []:
        label = r.get("metric_label") or _humanise(r.get("outcome", ""))
        if r.get("error"):
            metrics.append({"metric": label, "role": r.get("role"), "error": "could not be read"})
            continue
        rate = bool(r.get("binary"))
        if r.get("role") != "guardrail":
            counted = sum(int(a.get("n") or 0) for a in r.get("arms") or [])
        rows = []
        for c in r.get("comparisons") or []:
            scale = 100 if rate else 1
            rows.append({
                "arm": c.get("variation"), "baseline": c.get("baseline"),
                "control_value": _r(c.get("baseline_mean", 0) * scale, 1 if rate else 2),
                "arm_value": _r(c.get("mean", 0) * scale, 1 if rate else 2),
                "change_pct": None if c.get("lift") is None else _r(c["lift"] * 100),
                "absolute_change": _r((c.get("mean", 0) - c.get("baseline_mean", 0)) * scale, 1 if rate else 2),
                "interval_pct": None if not c.get("lift_ci") else [_r(c["lift_ci"][0] * 100), _r(c["lift_ci"][1] * 100)],
                "verdict": "not comparable — the split check failed" if c.get("invalidated_by") else c.get("verdict"),
            })
        metrics.append({"metric": label, "role": r.get("role") or "target",
                        "better": r.get("better") or "up", "direction_assumed": bool(r.get("direction_assumed")),
                        "measured_as": "rate, in percent" if rate else "amount", "results": rows})
    return {
        "experiment": exp.get("title") or exp.get("name") or exp.get("id"),
        "hypothesis": exp.get("hypothesis"),
        # Said outright: given only "day 12 of 14", the model wrote that the
        # experiment "ended early on day 12" while it was still running.
        "status": exp.get("status") or "running",
        "still_running": (exp.get("status") or "running") == "running" and not exp.get("stopped_at"),
        "day": prog.get("day"), "planned_days": prog.get("days"),
        "units_counted": counted,
        "split_check": None if not srm.get("ran") else
        {"passed": bool(srm.get("passed")), "p_value": srm.get("p_value"), "threshold": srm.get("threshold"),
         # Said in words: left to compare 1.47e-30 with 0.001 itself, the model
         # wrote "far above the threshold" for a split that failed by being below it.
         "reading": ("held: the p-value is above the threshold, so the arms are comparable" if srm.get("passed")
                     else "failed: the p-value is below the threshold, so the arms are not comparable")},
        "metrics_compared": sum(len(m.get("results") or []) for m in metrics),
        "metrics": metrics,
        "notes": [*(readout.get("contract_notes") or []), *(readout.get("caveats") or [])][:6],
    }


def allowed(facts: dict) -> set[str]:
    """Which recommendations the verdicts permit. Decided here, not by the model:
    a summary that says "ship" over a payment-failure regression is worse than
    no summary at all."""
    split = facts.get("split_check")
    if split and not split["passed"]:
        return {"iterate"}
    verdicts = [(m.get("role"), r.get("verdict")) for m in facts["metrics"] for r in m.get("results") or []]
    target_better = any(role != "guardrail" and v == "better" for role, v in verdicts)
    target_decided = any(role != "guardrail" and v in ("better", "worse") for role, v in verdicts)
    guard_worse = any(role == "guardrail" and v == "worse" for role, v in verdicts)
    out = {"kill", "iterate"}
    if target_better and not guard_worse:
        out.add("ship")
    day, planned = facts.get("day"), facts.get("planned_days")
    if not target_decided or (day is not None and planned is not None and day < planned):
        out.add("keep_running")
    return out


_NUMBER = re.compile(r"(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?")


def _known(facts: dict) -> list[float]:
    """Every number a reply may use: the facts' own, and the small counts a
    sentence needs ("two guardrails", "day 3")."""
    out: list[float] = list(range(11))

    def walk(x: Any) -> None:
        if isinstance(x, bool) or x is None:
            return
        if isinstance(x, (int, float)):
            out.append(float(x))
            out.append(abs(float(x)))
        elif isinstance(x, str):
            out.extend(float(n.replace(",", "")) for n in _NUMBER.findall(x) if n.replace(",", "").lstrip("+-"))
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(facts)
    return out


_POINTS = re.compile(r"([-+]?\d+(?:\.\d+)?)\s*(?:pp\b|percentage[- ]points?)", re.IGNORECASE)


def _close(x: float, known: list[float]) -> bool:
    return any(abs(abs(k) - x) <= max(0.051, 0.006 * abs(k)) for k in known)


def unknown_numbers(text: str, facts: dict) -> list[str]:
    """Numbers in `text` that the readout does not hold, within rounding.

    "Percentage points" is held to the absolute changes alone: the model wrote
    "activation improved by 11.5 percentage points" for a +11.5% relative lift
    whose absolute change was 4.6 — a number the readout holds, in the wrong unit.
    """
    points = [abs(r["absolute_change"]) for m in facts.get("metrics") or []
              if str(m.get("measured_as", "")).startswith("rate")
              for r in m.get("results") or [] if r.get("absolute_change") is not None]
    bad = [f"{m.group(1)} percentage points" for m in _POINTS.finditer(text)
           if not _close(abs(float(m.group(1))), points)]
    text = _POINTS.sub(" ", text)
    known = _known(facts)
    for raw in _NUMBER.findall(text):
        try:
            x = abs(float(raw.replace(",", "")))
        except ValueError:
            continue
        if not _close(x, known):
            bad.append(raw)
    return bad


_MOVED = re.compile(r"\b(increas\w*|decreas\w*|rose|rises?|rising|grew|grows?|growing|fell|falls?|falling|"
                    r"drop\w*|declin\w*|improv\w*|worsen\w*|boost\w*|higher|lower|gain\w*|jump\w*|spik\w*|"
                    r"reduc\w*|up|down)\b", re.IGNORECASE)
_STEADY = re.compile(r"no (?:clear |significant |detectable |real )?(?:difference|change|effect)|unchanged|flat|"
                     r"did not|didn't|does not|doesn't|not (?:move|change)|neither|inconclusive", re.IGNORECASE)
_UNIT_WORDS = {"usd", "ms", "s", "pct", "7d", "30d"}


def _names(label: str) -> set[str]:
    words = [w for w in label.lower().replace("_", " ").split() if w not in _UNIT_WORDS]
    base = " ".join(words)
    out = {base, *([f"average {base[4:]}"] if base.startswith("avg ") else [])}
    return {n for n in out if len(n) >= 4}


def misread_metrics(text: str, facts: dict) -> list[str]:
    """Metrics the engine found no difference on that `text` says moved.

    A number check cannot see this: "the experiment also increased payment
    failures, error counts, and average item prices" quotes no number, and
    average item price was "no difference detected". Read per sentence; a
    sentence that says the metric did not move ("no difference", "unchanged")
    is left alone.
    """
    flat = [m["metric"] for m in facts.get("metrics") or [] if m.get("results")
            and all(r.get("verdict") == "no difference detected" for r in m["results"])]
    bad: list[str] = []
    for sentence in re.split(r"(?<=[.;!?])\s+|\n", text):
        low = sentence.lower()
        if not _MOVED.search(low) or _STEADY.search(low):
            continue
        bad += [m for m in flat if any(n in low for n in _names(m)) and m not in bad]
    return bad


_ABOVE = re.compile(r"\b(above|exceed\w*|higher than|greater than|over)\b", re.IGNORECASE)
_BELOW = re.compile(r"\b(below|under|less than|lower than|smaller than)\b", re.IGNORECASE)


def split_slip(text: str, facts: dict) -> str:
    """The split check's p-value put on the wrong side of its threshold."""
    split = facts.get("split_check")
    if not split:
        return ""
    for sentence in re.split(r"(?<=[.;!?])\s+|\n", text):
        if "threshold" not in sentence.lower():
            continue
        if not split["passed"] and _ABOVE.search(sentence) and not _BELOW.search(sentence):
            return "the split check failed because its p-value is BELOW the threshold, not above it"
        if split["passed"] and _BELOW.search(sentence) and not _ABOVE.search(sentence):
            return "the split check held because its p-value is ABOVE the threshold, not below it"
    return ""


async def _ask(state: dict, system: str, prompt: str, schema: dict,
               refused: tuple[str, str] | None) -> tuple[dict, str | None]:
    again = ("" if refused is None else
             f"\n\nYour previous answer was refused: {refused[1]}. Return the corrected complete JSON.")
    llm = state.get("llm")
    if llm is not None:
        messages = [{"role": "system", "content": system + "\nOutput schema: " + json.dumps(schema)},
                    {"role": "user", "content": prompt}]
        if refused is not None:
            messages += [{"role": "assistant", "content": refused[0]},
                         {"role": "user", "content": again.strip()}]
        raw = await asyncio.wait_for(llm.complete(messages, max_tokens=2000, require_finished=True,
                                                  response_schema=schema), timeout=budget(llm))
        raw = raw.strip()
        if raw.startswith("```") and raw.endswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(raw), llm.model
    gen = state.get("generate")
    kwargs = {"system": system, "prompt": prompt + again, "schema": schema, "max_tokens": 2000}
    answer, usage = await asyncio.wait_for(gen(**kwargs) if gen else generate(configured(), **kwargs),
                                           timeout=budget(state.get("llm")))
    return answer, usage.get("model")


async def _checked(state: dict, system: str, prompt: str, schema: dict, check) -> tuple[dict | None, str | None, str]:
    """Ask, check in code, and ask once more with the reason if it failed.
    Returns the answer (None when it never passed), the model, and the last reason."""
    from jsonschema import Draft202012Validator

    refused, model, why = None, None, ""
    for _attempt in range(ATTEMPTS):
        answer, model = await _ask(state, system, prompt, schema, refused)
        errors = [e.message for e in Draft202012Validator(schema).iter_errors(answer)]
        why = "; ".join(errors[:3]) if errors else check(answer)
        if not why:
            return answer, model, ""
        refused = (json.dumps(answer)[:12000], why)
    return None, model, why


def _model_error(error: Exception, what: str) -> JSONResponse:
    if isinstance(error, (Truncated, LlmTruncated)):
        return _error(502, "model_truncated", f"The {what} was cut off. Try again.")
    if isinstance(error, (Unconfigured, Blocked)):
        return _error(503, "model_unconfigured", f"The AI {what} needs a configured model. Set "
                      "COMMONINDEX_LLM_BASE_URL / COMMONINDEX_LLM_MODEL, or COMMONINDEX_MODEL_PROVIDER and its credentials.")
    if isinstance(error, (json.JSONDecodeError, AttributeError, TypeError, asyncio.TimeoutError)):
        return _error(502, "model_output_invalid", f"The model returned an unreadable {what}. Try again.")
    ref = secrets.token_hex(4)
    logging.getLogger(__name__).warning("experiment assist failed [%s]: %s", ref, type(error).__name__)
    return _error(502, "model_failed", f"The model could not write the {what} (ref {ref}). Try again.")


async def _read(req: Request, experiment_id: str) -> tuple[dict, dict] | JSONResponse:
    """The experiment and its readout, as this caller may see them."""
    from commonindex.gateway.authoring import experiments_get, experiments_readout, recent_readout

    record = await experiments_get(_As(req, {"experiment_id": experiment_id}))
    if isinstance(record, JSONResponse):
        return record
    if not record.get("pre_registered"):
        return _error(422, "not_pre_registered", "Register this experiment before asking AI about its readout.",
                      "experiment_id")
    # The page beside this has usually just read it: reuse that for a minute
    # rather than read the warehouse a second time per visit.
    readout = recent_readout(req, {"experiment_id": experiment_id}) \
        or await experiments_readout(_As(req, {"experiment_id": experiment_id}))
    if isinstance(readout, JSONResponse):
        return readout
    return record, readout


def _experiment_id(body: Any) -> str | None:
    if isinstance(body, dict) and isinstance(body.get("experiment_id"), str) and body["experiment_id"].strip():
        return body["experiment_id"].strip()
    return None


@router.post("/api/v1/experiments.explain")
async def experiments_explain(req: Request):
    """A plain-language summary of the readout and a recommendation the verdicts allow."""
    body = await req.json()
    eid = _experiment_id(body)
    if not eid:
        return _error(422, "bad_input", "Name the experiment.", "experiment_id")
    got = await _read(req, eid)
    if isinstance(got, JSONResponse):
        return got
    record, readout = got
    facts = facts_of(record, readout)
    key = (space_of(req, body), eid, hashlib.sha256(json.dumps(facts, sort_keys=True, default=str).encode()).hexdigest())
    if not body.get("fresh"):
        if key in _SUMMARIES:
            _SUMMARIES.move_to_end(key)
            return {**_SUMMARIES[key], "cached": True}
        # Two readers opening the page together share one model call.
        if key in _WRITING:
            out = await asyncio.shield(_WRITING[key])
            return {**out, "cached": True} if isinstance(out, dict) else out
    pending = asyncio.get_running_loop().create_future()
    _WRITING[key] = pending
    try:
        out = await _explain(req, facts)
        if isinstance(out, dict):
            _SUMMARIES[key] = out
            while len(_SUMMARIES) > _KEEP:
                _SUMMARIES.popitem(last=False)
        pending.set_result(out)
        return out
    except BaseException as error:
        pending.set_exception(error)
        pending.exception()          # retrieved, so an unawaited future does not warn
        raise
    finally:
        _WRITING.pop(key, None)


async def _explain(req: Request, facts: dict):
    permitted = allowed(facts)
    prompt = json.dumps({"allowed_recommendations": sorted(permitted), "facts": facts})

    def check(answer: dict) -> str:
        reasons = []
        if answer.get("recommendation") not in permitted:
            reasons.append(f"recommendation must be one of {sorted(permitted)} given these verdicts")
        text = " ".join([answer.get("headline", ""), answer.get("summary", ""),
                         *answer.get("reasons", []), *answer.get("next_steps", [])])
        if bad := unknown_numbers(text, facts):
            reasons.append(f"these numbers are not in the readout: {', '.join(bad[:6])} — use only the facts' numbers; "
                           "percentage points are only the absolute_change values, change_pct is a relative %")
        if moved := misread_metrics(text, facts):
            reasons.append(f"{', '.join(moved[:6])}: the verdict is no difference detected — do not say it rose, fell, "
                           "improved or worsened; say it did not change, or leave it out")
        if slip := split_slip(text, facts):
            reasons.append(slip)
        return "; ".join(reasons)

    try:
        answer, model, why = await _checked(req.app.state.commonindex, EXPLAIN_SYSTEM, prompt, SUMMARY_SCHEMA, check)
    except Exception as error:  # noqa: BLE001 - provider errors are reported without their text
        return _model_error(error, "summary")
    if answer is None:
        return _error(502, "model_output_unchecked",
                      f"The AI summary did not hold to the readout ({why[:300]}), so it is not shown. Try again.")
    return {**answer, "allowed": sorted(permitted), "model": model,
            "checked": "every number and the recommendation were checked against this readout",
            "read_at": datetime.now(tz=UTC).isoformat()}


@router.post("/api/v1/experiments.draft_rationale")
async def experiments_draft_rationale(req: Request):
    """A rationale for the decision the person chose, drafted from the readout.
    Nothing is recorded: the draft lands in the decision form for them to edit."""
    body = await req.json()
    eid = _experiment_id(body)
    if not eid:
        return _error(422, "bad_input", "Name the experiment.", "experiment_id")
    decision = body.get("decision") if isinstance(body, dict) else None
    if decision not in ("ship", "kill", "iterate"):
        return _error(422, "bad_decision", "decision must be ship, kill or iterate", "decision")
    got = await _read(req, eid)
    if isinstance(got, JSONResponse):
        return got
    record, readout = got
    facts = facts_of(record, readout)
    prompt = json.dumps({"decision": decision, "facts": facts})

    def check(answer: dict) -> str:
        reasons = []
        if bad := unknown_numbers(answer.get("rationale", ""), facts):
            reasons.append(f"these numbers are not in the readout: {', '.join(bad[:6])} — use only the facts' numbers")
        if moved := misread_metrics(answer.get("rationale", ""), facts):
            reasons.append(f"{', '.join(moved[:6])}: the verdict is no difference detected — do not say it moved")
        if slip := split_slip(answer.get("rationale", ""), facts):
            reasons.append(slip)
        return "; ".join(reasons)

    try:
        answer, model, why = await _checked(req.app.state.commonindex, RATIONALE_SYSTEM, prompt, RATIONALE_SCHEMA, check)
    except Exception as error:  # noqa: BLE001
        return _model_error(error, "draft")
    if answer is None:
        return _error(502, "model_output_unchecked",
                      f"The draft did not hold to the readout ({why[:300]}). Write it yourself or try again.")
    return {"rationale": answer["rationale"], "decision": decision, "model": model,
            "note": "A draft. Nothing was recorded; edit it before you decide."}


# ── the write-up: a doc built from the readout, not by the model ────────────

def _t(text: str, bold: bool = False) -> dict:
    return {"type": "text", "text": text, **({"marks": [{"type": "bold"}]} if bold else {})}


def _p(*parts: dict | str) -> dict:
    kids = [_t(x) if isinstance(x, str) else x for x in parts if x]
    return {"type": "paragraph", **({"content": kids} if kids else {})}


def _h(text: str, level: int = 2) -> dict:
    return {"type": "heading", "attrs": {"level": level}, "content": [_t(text)]}


def _ul(items: list[str]) -> dict:
    return {"type": "bulletList", "content": [{"type": "listItem", "content": [_p(i)]} for i in items if i]}


def _cell(text: str, header: bool = False) -> dict:
    return {"type": "tableHeader" if header else "tableCell", "content": [_p(text)]}


def _fmt(v: float | None, rate: bool) -> str:
    if v is None:
        return "—"
    return f"{v:.1f}%" if rate else f"{v:,.2f}".rstrip("0").rstrip(".")


def _arms_line(readout: dict, contract: dict) -> str:
    """The arms by name, as the readout found them — "one_page vs control",
    not the column they were read from."""
    target = next((r for r in readout.get("results") or [] if r.get("role") != "guardrail"), None) or {}
    control = target.get("control") or contract.get("control")
    others = [a["name"] for a in target.get("arms") or [] if a.get("name") != control]
    if not others:
        return f"Arms from {contract.get('variation')}, against {control or 'the control'}"
    return f"Arms: {', '.join(others)} vs {control} (from {contract.get('variation')})"


def write_up_body(record: dict, readout: dict, summary: dict | None = None) -> dict:
    """The experiment as a doc: what was asked, how, what the numbers said and
    what was decided. Every figure is the readout's."""
    exp = record.get("experiment") or {}
    contract = record.get("contract") or {}
    facts = facts_of(record, readout)
    blocks: list[dict] = [_p(_t(f"{exp.get('key') or exp.get('id')}", True),
                             f" · {exp.get('status') or 'running'}"
                             + (f" · day {facts['day']} of {facts['planned_days']}" if facts.get("day") is not None else "")
                             + f" · read {datetime.now(tz=UTC):%b %-d, %Y}")]
    blocks += [_h("Hypothesis"), _p(exp.get("hypothesis") or "No hypothesis was written down.")]

    guards = contract.get("guardrails") or []
    setup = [
        f"Target: {contract.get('outcome')} from {contract.get('dataset_id')}",
        _arms_line(readout, contract),
        f"Randomised on {contract.get('unit')}" if contract.get("unit") else "No unit of randomisation named",
        f"Planned {contract.get('planned_days')} days" if contract.get("planned_days") else "No duration registered",
        f"Worth detecting: {round(contract['mde'] * 100, 1)}% relative" if contract.get("mde") else "No minimum effect registered",
        f"{len(guards)} guardrail{'s' if len(guards) != 1 else ''}" if guards else "No guardrails",
    ]
    blocks += [_h("Setup"), _ul(setup)]

    if summary:
        blocks += [_h("Summary"), _p(_t("Drafted by AI and checked against the readout. ", True), summary.get("summary", ""))]
        if summary.get("reasons"):
            blocks.append(_ul(summary["reasons"]))

    rows = [{"type": "tableRow", "content": [_cell(h, True) for h in
                                              ("Metric", "Role", "Control", "Variant", "Change", "Verdict")]}]
    for m in facts["metrics"]:
        if m.get("error"):
            rows.append({"type": "tableRow", "content": [_cell(m["metric"]), _cell(m.get("role") or ""),
                                                         _cell("—"), _cell("—"), _cell("—"), _cell("could not be read")]})
            continue
        rate = m["measured_as"].startswith("rate")
        for c in m["results"]:
            change = "—" if c["change_pct"] is None else f"{'▲' if c['change_pct'] > 0 else '▼' if c['change_pct'] < 0 else ''} {c['change_pct']:+.1f}%"
            rows.append({"type": "tableRow", "content": [
                _cell(m["metric"] + (f" ({c['arm']})" if len(m["results"]) > 1 else "")),
                _cell(f"{m['role']} · {'lower' if m['better'] == 'down' else 'higher'} is better"
                      + (" (assumed)" if m["direction_assumed"] else "")),
                _cell(_fmt(c["control_value"], rate)), _cell(_fmt(c["arm_value"], rate)),
                _cell(change.strip()), _cell(c["verdict"] or "—")]})
    blocks += [_h("Results"), {"type": "table", "content": rows}]

    split = facts.get("split_check")
    if split:
        blocks.append(_p(_t("Split check: ", True), "held." if split["passed"] else
                         "failed — the arms are not comparable, so no lift above can be acted on."))
    if facts["metrics_compared"] >= 3:
        blocks.append(_p(f"{facts['metrics_compared']} comparisons, not adjusted for each other."))
    if facts["notes"]:
        blocks += [_h("Notes"), _ul(facts["notes"])]

    decision = exp.get("decision")
    blocks.append(_h("Decision"))
    if isinstance(decision, dict) and decision.get("outcome"):
        blocks.append(_p(_t(str(decision["outcome"]).capitalize(), True),
                         f" — {decision.get('rationale') or 'no rationale recorded'}"
                         + (f" ({decision['by']})" if decision.get("by") else "")))
    else:
        blocks.append(_p("Not decided yet."))
    return {"type": "doc", "content": blocks}


@router.post("/api/v1/experiments.write_up")
async def experiments_write_up(req: Request):
    """The experiment as a doc, filed in the experiment's projects."""
    from commonindex.gateway.docs import docs_propose
    from commonindex.gateway.projects import REL, _tag

    body = await req.json()
    eid = _experiment_id(body)
    if not eid:
        return _error(422, "bad_input", "Name the experiment.", "experiment_id")
    if not isinstance(body.get("idempotencyKey"), str) or not body["idempotencyKey"]:
        return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key", "idempotencyKey")
    summary = body.get("summary")
    if summary is not None and (not isinstance(summary, dict) or not isinstance(summary.get("summary"), str)
                                or len(json.dumps(summary)) > 4000):
        return _error(422, "bad_summary", "summary must be the object experiments.explain returned", "summary")
    got = await _read(req, eid)
    if isinstance(got, JSONResponse):
        return got
    record, readout = got
    exp = record.get("experiment") or {}
    # The key a person knows it by (EXP-684), not the id the API uses.
    async with req.app.state.commonindex["pool"].acquire() as conn:
        key = await conn.fetchval("select key from objects where id = $1", eid)
    if key:
        record = {**record, "experiment": {**exp, "key": key}}
    made = await docs_propose(_As(req, {
        "title": f"{exp.get('title') or eid} — write-up", "freshness": "fresh",
        "body": write_up_body(record, readout, summary), "idempotencyKey": body["idempotencyKey"]}))
    if isinstance(made, JSONResponse):
        return made
    doc_id = made.get("id") or made.get("doc_id")
    # Filed where the experiment is: a write-up nobody can find from the
    # project it belongs to is a doc in the wrong place.
    space = space_of(req, body)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        projects = [r["dst"] for r in await conn.fetch(
            "select e.dst from edges e join objects p on p.id = e.dst and p.space_id = $3"
            " where e.src = $1 and e.rel = $2", eid, REL, space)]
    for pid in projects:
        await _tag(_As(req, {"project_id": pid, "object_id": doc_id,
                             "idempotencyKey": f"{body['idempotencyKey']}-{pid}"}), True)
    return {"doc_id": doc_id, "key": made.get("key"), "projects": projects}
