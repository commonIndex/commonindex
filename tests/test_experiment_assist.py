"""AI on an experiment holds to the readout.

The model writes words; code decides what it may say. A summary that ships over
a payment-failure regression, or quotes a number the engine never produced, is
sent back once with the rule it broke and refused if it breaks it again.
"""

from __future__ import annotations

import json

import pytest

from commonindex.gateway import experiment_assist as ea


def _cmp(arm, base, mean, lift, ci, verdict, **kw):
    return {"variation": arm, "baseline": "control", "baseline_mean": base, "mean": mean,
            "lift": lift, "lift_ci": ci, "verdict": verdict, **kw}


RECORD = {
    "experiment": {"id": "exp-1", "key": "EXP-1", "title": "One-page checkout", "status": "running",
                   "hypothesis": "One page raises conversion."},
    "contract": {"outcome": "converted", "dataset_id": "public.exp", "variation": "variant",
                 "control": "control", "unit": "user_id", "planned_days": 14, "mde": 0.1,
                 "guardrails": [{"outcome": "payment_failed", "better": "down"}]},
    "progress": {"day": 14, "days": 14},
    "pre_registered": True,
}
READOUT = {
    "srm": {"ran": True, "passed": True, "p_value": 0.9, "threshold": 0.001},
    "results": [
        {"outcome": "converted", "role": "target", "binary": True, "better": "up", "direction_assumed": True,
         "arms": [{"name": "control", "n": 10000}, {"name": "one_page", "n": 10000}],
         "comparisons": [_cmp("one_page", 0.104, 0.117, 0.121, [-0.02, 0.261], "no difference detected")]},
        {"outcome": "payment_failed", "role": "guardrail", "binary": True, "better": "down",
         "direction_assumed": False, "metric_label": "Payment failed",
         "comparisons": [_cmp("one_page", 0.032, 0.047, 0.435, [0.2, 0.67], "worse")]},
    ],
    "contract_notes": [], "caveats": [],
}


def test_facts_give_rates_as_percentages_and_every_verdict():
    f = ea.facts_of(RECORD, READOUT)
    target, guard = f["metrics"]
    assert target["results"][0]["control_value"] == 10.4 and target["results"][0]["arm_value"] == 11.7
    assert target["results"][0]["change_pct"] == 12.1 and target["results"][0]["absolute_change"] == 1.3
    assert guard["results"][0]["verdict"] == "worse" and guard["better"] == "down"
    assert f["units_counted"] == 20000


def test_a_guardrail_that_got_worse_rules_out_ship():
    assert "ship" not in ea.allowed(ea.facts_of(RECORD, READOUT))


def test_a_failed_split_allows_only_iterate():
    broken = {**READOUT, "srm": {"ran": True, "passed": False, "p_value": 1e-30, "threshold": 0.001}}
    assert ea.allowed(ea.facts_of(RECORD, broken)) == {"iterate"}


def test_a_clean_win_may_ship():
    win = {**READOUT, "results": [
        {**READOUT["results"][0], "comparisons": [_cmp("one_page", 0.104, 0.13, 0.25, [0.1, 0.4], "better")]},
        {**READOUT["results"][1], "comparisons": [_cmp("one_page", 0.032, 0.031, -0.03, [-0.2, 0.1],
                                                       "no difference detected")]}]}
    assert "ship" in ea.allowed(ea.facts_of(RECORD, win))


def test_numbers_must_be_the_readouts():
    f = ea.facts_of(RECORD, READOUT)
    assert ea.unknown_numbers("Conversion rose 12.1% (10.4% to 11.7%); payment failures rose 43.5%.", f) == []
    assert ea.unknown_numbers("Conversion rose 18%.", f) == ["18"]


def test_percentage_points_are_the_absolute_change_not_the_relative_one():
    f = ea.facts_of(RECORD, READOUT)
    assert ea.unknown_numbers("Conversion rose 1.3 percentage points (+12.1%).", f) == []
    assert ea.unknown_numbers("Conversion rose 12.1 percentage points.", f) == ["12.1 percentage points"]
    assert ea.unknown_numbers("up 12.1pp", f) == ["12.1 percentage points"]


class _Llm:
    model = "stub"

    def __init__(self, *answers):
        self.answers, self.seen = list(answers), []

    async def complete(self, messages, **_):
        self.seen.append(messages)
        return json.dumps(self.answers.pop(0))


class _Req:
    def __init__(self, body, llm):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": {"llm": llm}})()})()
        self.state = type("T", (), {})()

    async def json(self):
        return self._body


GOOD = {"headline": "Don't ship: payment failures rose 43.5%.",
        "summary": "Conversion rose 12.1% but the interval spans zero. Payment failures rose 43.5%.",
        "recommendation": "iterate", "reasons": ["Payment failed is worse."], "next_steps": ["Fix payments."]}


@pytest.fixture(autouse=True)
def _no_cached_summaries():
    ea._SUMMARIES.clear()
    yield
    ea._SUMMARIES.clear()


@pytest.fixture
def read(monkeypatch):
    async def _read(req, eid):
        return RECORD, READOUT
    monkeypatch.setattr(ea, "_read", _read)


async def test_explain_sends_a_ship_over_a_regression_back_once(read):
    shipping = {**GOOD, "recommendation": "ship"}
    llm = _Llm(shipping, GOOD)
    out = await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, llm))
    assert out["recommendation"] == "iterate"
    assert "ship" not in out["allowed"]
    told = llm.seen[1][-1]["content"]
    assert "recommendation must be one of" in told


async def test_explain_refuses_a_summary_that_keeps_inventing_numbers(read):
    invented = {**GOOD, "summary": "Conversion rose 18%."}
    out = await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, _Llm(invented, invented)))
    assert out.status_code == 502
    assert b"model_output_unchecked" in out.body


async def test_a_rationale_is_drafted_for_the_chosen_decision(read):
    llm = _Llm({"rationale": "We are iterating: payment failures rose 43.5% while conversion is unclear."})
    out = await ea.experiments_draft_rationale(_Req({"experiment_id": "exp-1", "decision": "iterate"}, llm))
    assert out["decision"] == "iterate" and "43.5%" in out["rationale"]
    assert json.loads(llm.seen[0][1]["content"])["decision"] == "iterate"


def test_the_write_up_is_the_readouts_numbers_not_the_models():
    body = ea.write_up_body(RECORD, READOUT, summary=GOOD)
    text = json.dumps(body)
    assert "One page raises conversion." in text
    assert "10.4%" in text and "11.7%" in text and "+12.1%" in text
    assert "Payment failed" in text and "worse" in text and "lower is better" in text
    assert "Drafted by AI and checked against the readout." in text
    assert "Not decided yet." in text
    assert any(n["type"] == "table" for n in body["content"])


FLAT_PRICE = {**READOUT, "results": [*READOUT["results"],
    {"outcome": "avg_item_price", "role": "guardrail", "binary": False, "better": "up", "direction_assumed": False,
     "metric_label": "Avg item price",
     "comparisons": [_cmp("one_page", 29.89, 30.12, 0.008, [-0.02, 0.03], "no difference detected")]}]}


def test_a_metric_with_no_difference_may_not_be_said_to_have_moved():
    f = ea.facts_of(RECORD, FLAT_PRICE)
    said = "The experiment also increased payment failures, error counts, and average item prices."
    assert ea.misread_metrics(said, f) == ["Avg item price"]
    # Said not to have moved, or a metric that did move: both fine.
    assert ea.misread_metrics("Average item price was unchanged.", f) == []
    assert ea.misread_metrics("Payment failures increased.", f) == []
    # The target with no difference, said to have risen.
    assert ea.misread_metrics("Converted rose.", f) == ["Converted"]


async def test_explain_sends_a_moved_flat_metric_back(monkeypatch):
    async def _read(req, eid):
        return RECORD, FLAT_PRICE
    monkeypatch.setattr(ea, "_read", _read)
    wrong = {**GOOD, "summary": "Payment failures rose 43.5% and average item prices increased."}
    llm = _Llm(wrong, GOOD)
    out = await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, llm))
    assert out["recommendation"] == "iterate"
    assert "Avg item price: the verdict is no difference detected" in llm.seen[1][-1]["content"]


def test_the_write_up_names_the_arms_not_the_column():
    readout = {**READOUT, "results": [{**READOUT["results"][0], "control": "control"}, READOUT["results"][1]]}
    text = json.dumps(ea.write_up_body(RECORD, readout))
    assert "Arms: one_page vs control (from variant)" in text


def test_a_failed_split_is_below_its_threshold_not_above():
    broken = ea.facts_of(RECORD, {**READOUT, "srm": {"ran": True, "passed": False, "p_value": 1.47e-30,
                                                      "threshold": 0.001}})
    assert "not comparable" in broken["split_check"]["reading"]
    said = "The split check failed with a p-value of 1.47e-30, which is far above the threshold of 0.001."
    assert "BELOW" in ea.split_slip(said, broken)
    assert ea.split_slip("Its p-value of 1.47e-30 is far below the 0.001 threshold.", broken) == ""


async def test_a_summary_of_the_same_readout_is_not_written_twice(read):
    # The page asks on every load; the model is called once per readout.
    llm = _Llm(GOOD, {**GOOD, "headline": "A fresh one."})
    first = await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, llm))
    again = await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, llm))
    assert len(llm.seen) == 1
    assert again["headline"] == first["headline"] and again["cached"] is True
    fresh = await ea.experiments_explain(_Req({"experiment_id": "exp-1", "fresh": True}, llm))
    assert len(llm.seen) == 2 and fresh["headline"] == "A fresh one."


async def test_a_refused_summary_is_not_kept(read):
    invented = {**GOOD, "summary": "Conversion rose 18%."}
    llm = _Llm(invented, invented, GOOD)
    assert (await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, llm))).status_code == 502
    out = await ea.experiments_explain(_Req({"experiment_id": "exp-1"}, llm))
    assert out["recommendation"] == "iterate" and "cached" not in out
