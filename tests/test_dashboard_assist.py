"""AI dashboard proposals: metadata only, no provider, database or writes."""

import copy
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from jsonschema import ValidationError

from commonindex.core.authz import Denied
from commonindex.core.warehouse import ColKind, Dataset, Dimension, TimeGrain
from commonindex.gateway import dashboard_assist as ai
from commonindex.gateway.auth import SpaceMismatch
from commonindex.gateway.llm import LlmTruncated

PANEL = {"title": "Total events", "agg": "count", "mark": "stat", "grain": "none"}
ANSWER = {"title": "Activity", "summary": "Counts events, not unique users.", "panels": [PANEL]}


def dataset():
    return Dataset("public.events", "c1", "secret-source-query", time_column="ts",
                   grains=[TimeGrain.DAY, TimeGrain.WEEK, TimeGrain.MONTH], dimensions=[
                       Dimension("ts", "ts", ColKind.TIME),
                       Dimension("amount", "amount", ColKind.NUMBER, groupable=False),
                       Dimension("quantity", "quantity", ColKind.NUMBER, groupable=False),
                       Dimension("status", "status", ColKind.STRING),
                   ])


class Req:
    def __init__(self, llm=None, **state):
        self.body = {"connection_id": "c1", "dataset_id": "public.events",
                     "instruction": "Show an activity overview", "time_column": "ts", "range": "30d"}
        # No pool: any accidental database access beyond the source lookup fails.
        self.app = SimpleNamespace(state=SimpleNamespace(commonindex={"llm": llm, **state}))
        self.state = SimpleNamespace(space="permitted")

    async def json(self):
        return self.body


def model(answer=ANSWER):
    return SimpleNamespace(model="test-model", complete=AsyncMock(return_value=json.dumps(answer)))


@pytest.fixture(autouse=True)
def source(monkeypatch):
    src = SimpleNamespace(_dataset=AsyncMock(return_value=dataset()),
                          _spec=SimpleNamespace(sqlglot_dialect="postgres"), preview=AsyncMock())
    lookup = AsyncMock(return_value=(src, {"dsn": "secret-dsn", "secret_ref": "secret-key"}))
    monkeypatch.setattr(ai, "_source", lookup)
    return lookup


async def test_proposal_uses_only_authorized_metadata_and_does_not_query(source):
    llm = model()
    result = await ai.dashboards_generate(Req(llm=llm))
    assert result["panels"] == [PANEL]
    assert result["model"] == "test-model"
    assert result["range"] == "30d" and result["time_column"] == "ts"
    assert "nothing was saved" in result["note"]
    assert source.call_args.args[-1] == "permitted"
    source.return_value[0].preview.assert_not_called()
    messages = llm.complete.call_args.args[0]
    prompt = json.loads(messages[1]["content"])
    assert prompt["source"]["columns"][1] == {"name": "amount", "kind": "number", "groupable": False}
    assert "secret" not in json.dumps(messages)
    assert llm.complete.call_args.kwargs["require_finished"] is True
    assert llm.complete.call_args.kwargs["response_schema"] == ai.SCHEMA


async def test_saved_sql_uses_output_columns_not_query_text(source):
    source.return_value[0]._dataset.return_value.is_virtual = True
    llm = model()
    assert (await ai.dashboards_generate(Req(llm=llm)))["panels"] == [PANEL]
    assert "secret-source-query" not in str(llm.complete.call_args)


async def test_foreign_source_or_space_cannot_reach_model(source):
    llm = model()
    source.side_effect = ai.NoSuchConnection("foreign")
    assert (await ai.dashboards_generate(Req(llm=llm))).status_code == 404
    llm.complete.assert_not_called()
    source.reset_mock()
    req = Req(llm=llm)
    req.body["space_id"] = "foreign"
    with pytest.raises(SpaceMismatch):
        await ai.dashboards_generate(req)
    source.assert_not_called()


@pytest.mark.parametrize("field,value", [
    ("instruction", " "), ("instruction", []), ("instruction", "x" * 4001),
    ("connection_id", 42), ("dataset_id", ""), ("range", []), ("range", "10000d"),
    ("time_column", {}),
])
async def test_invalid_input_fails_before_lookup_or_model(field, value, source):
    req = Req(llm=model())
    req.body[field] = value
    assert (await ai.dashboards_generate(req)).status_code == 422
    source.assert_not_called()
    req.app.state.commonindex["llm"].complete.assert_not_called()


async def test_unknown_time_column_and_large_sources_are_actionable(source):
    req = Req(llm=model())
    req.body["time_column"] = "missing"
    assert (await ai.dashboards_generate(req)).status_code == 422
    req.app.state.commonindex["llm"].complete.assert_not_called()
    source.return_value[0]._dataset.return_value.dimensions *= 1000
    assert (await ai.dashboards_generate(Req(llm=model()))).status_code == 422


@pytest.mark.parametrize("patch", [
    {"agg": "sql"}, {"column": "missing"}, {"dimension": "missing"},
    {"agg": "sum", "column": "status"}, {"agg": "sum"},
    {"agg": "ratio", "column": "amount", "denominator": "status"},
    {"agg": "share", "column": "status"},
    {"value": float("nan")}, {"value": float("inf")},
    {"mark": "sql", "sql": "DROP TABLE events"}, {"mark": "bogus"},
    {"grain": "hour"}, {"dimension": "amount"}, {"mark": "line"},
    {"mark": "stat", "grain": "day"}, {"mark": "pie"},
    {"mark": "bar", "grain": "day", "limit": 10},
    {"sort": "random()"}, {"limit": 500000}, {"unit": "USD"}, {"title": " "},
    {"column": "ts"}, {"denominator": "amount"}, {"value": "paid"},
    {"unit": "currency"}, {"agg": "sum", "column": "amount", "mark": "line", "grain": "day", "dimension": "ts"},
    {"filters": [{"dimension": "status", "values": ["paid"]}]},
])
async def test_invalid_or_unsupported_panels_are_rejected_as_a_unit(patch):
    answer = {**ANSWER, "panels": [{**PANEL, **patch}]}
    response = await ai.dashboards_generate(Req(llm=model(answer)))
    assert response.status_code == 502
    assert json.loads(response.body)["error"]["code"] == "model_output_invalid"


@pytest.mark.parametrize("panels", [[PANEL] * 7, [PANEL, {**PANEL, "title": "Total events!"}], "invalid"])
def test_unbounded_duplicate_or_malformed_panels_are_rejected(panels):
    with pytest.raises((ValueError, ValidationError)):
        ai.validate_proposal({**ANSWER, "panels": panels}, dataset(), "postgres", "30d")


def test_useful_aggregations_validate_and_missing_data_can_be_explained():
    panels = [
        {"title": "Trend", "agg": "sum", "column": "amount", "mark": "line", "grain": "day"},
        {"title": "Ratio", "agg": "ratio", "column": "amount", "denominator": "quantity", "mark": "stat", "grain": "none"},
        {"title": "Paid share", "agg": "share", "column": "status", "value": "paid", "mark": "stat", "grain": "none"},
        {"title": "Categories", "agg": "count", "dimension": "status", "mark": "bar", "grain": "none", "sort": "value_desc", "limit": 10},
    ]
    assert ai.validate_proposal({**ANSWER, "panels": panels}, dataset(), "postgres", "60d")["panels"] == panels
    assert ai.validate_proposal({**ANSWER, "panels": []}, dataset(), "postgres", "30d")["panels"] == []
    ds = dataset()
    ds.time_column = None
    with pytest.raises(ValueError, match="panel 'Trend': .*no temporal column"):
        ai.validate_proposal({**ANSWER, "panels": [panels[0]]}, ds, "postgres", "30d")


async def test_fallback_generator_and_unconfigured_model(monkeypatch):
    gen = AsyncMock(return_value=(copy.deepcopy(ANSWER), {"model": "configured-model"}))
    assert (await ai.dashboards_generate(Req(generate=gen)))["model"] == "configured-model"
    assert gen.call_args.kwargs["schema"] == ai.SCHEMA
    monkeypatch.delenv("COMMONINDEX_MODEL_PROVIDER", raising=False)
    response = await ai.dashboards_generate(Req())
    assert response.status_code == 503
    assert "build panels manually" in json.loads(response.body)["error"]["message"]


@pytest.mark.parametrize("failure", [LlmTruncated("private"), RuntimeError("secret-key"), TimeoutError("private")])
async def test_provider_failure_is_safe(failure, caplog):
    llm = model()
    llm.complete.side_effect = failure
    result = await ai.dashboards_generate(Req(llm=llm))
    assert result.status_code == 502
    assert "private" not in result.body.decode() + caplog.text
    assert "secret-key" not in result.body.decode() + caplog.text


async def test_non_json_or_truncated_output_is_not_a_proposal():
    llm = model()
    llm.complete.return_value = "not json"
    assert (await ai.dashboards_generate(Req(llm=llm))).status_code == 502
    llm.complete.return_value = '```json\n' + json.dumps(ANSWER) + '\n```'
    assert (await ai.dashboards_generate(Req(llm=llm)))["panels"] == [PANEL]


async def test_registered_permission_is_enforced_before_handler(monkeypatch, source):
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register
    from commonindex.gateway import auth, signin

    registry = Registry()
    register(registry)
    op = registry.get("dashboards.generate")
    assert op.relation == "propose" and not op.mutating
    req = Req(llm=model())
    checker = SimpleNamespace(require=AsyncMock(side_effect=Denied("viewer cannot propose")))
    req.app.state.commonindex.update(checker=checker, registry=registry)
    req.url = SimpleNamespace(path="/api/v1/dashboards.generate")
    req.headers = {"x-commonindex-space": "permitted"}
    monkeypatch.setattr(signin, "resolve", AsyncMock(return_value=SimpleNamespace(actor_id="viewer")))
    monkeypatch.setattr(signin, "cross_site", lambda *_: False)
    handler = AsyncMock()
    response = await auth.authorize(req, handler)
    assert response.status_code == 403
    checker.require.assert_awaited_once_with("viewer", "propose", "space:permitted")
    handler.assert_not_called()
    source.assert_not_called()


@pytest.mark.integration
@pytest.mark.skipif(os.environ.get("COMMONINDEX_DASHBOARD_MODEL_SMOKE") != "1",
                    reason="opt-in: invokes the configured model with synthetic metadata only")
async def test_real_model_with_synthetic_metadata(source, monkeypatch):
    from commonindex.gateway.llm import OpenAICompatibleLlm

    validate = ai.validate_proposal
    observed = []

    def capture(answer, *args):
        # Safe to report only in this opt-in test: all metadata is synthetic.
        observed.append(answer)
        return validate(answer, *args)

    monkeypatch.setattr(ai, "validate_proposal", capture)
    req = Req(llm=OpenAICompatibleLlm.from_env())
    req.body["instruction"] = (
        "Create exactly two panels: a total count of events as a number, and the daily "
        "sum of amount as a line chart. Amount is a plain count, not currency. No grouping or filters.")
    result = await ai.dashboards_generate(req)
    if not isinstance(result, dict):
        print(json.dumps(observed, indent=2))
    assert isinstance(result, dict), (getattr(result, "body", b"").decode(), observed)
    assert len(result["panels"]) == 2
    assert {p["agg"] for p in result["panels"]} == {"count", "sum"}
    source.return_value[0].preview.assert_not_called()


async def test_one_wrong_panel_is_named_back_to_the_model_and_corrected_once():
    # A 9B model summed a text id for "runs per day" nearly every time, and the
    # whole proposal was refused with nothing to go on: generation never worked.
    wrong = {**ANSWER, "panels": [{"title": "Runs", "mark": "line", "agg": "sum", "column": "status", "grain": "day"}]}
    llm = model()
    llm.complete.side_effect = [json.dumps(wrong), json.dumps(ANSWER)]
    result = await ai.dashboards_generate(Req(llm=llm))
    assert result["panels"] == [PANEL]
    assert llm.complete.call_count == 2
    retry = llm.complete.call_args.args[0]
    assert retry[-2] == {"role": "assistant", "content": json.dumps(wrong)}
    assert "'Runs': this aggregate needs a numeric column" in retry[-1]["content"]


async def test_still_wrong_after_one_correction_says_which_rule():
    wrong = {**ANSWER, "panels": [{**PANEL, "unit": "currency"}]}
    llm = model(wrong)
    response = await ai.dashboards_generate(Req(llm=llm))
    assert response.status_code == 502 and llm.complete.call_count == ai.ATTEMPTS
    assert "counts must use a plain-number format" in json.loads(response.body)["error"]["message"]


async def test_a_schema_refusal_is_described_without_quoting_the_output():
    # jsonschema's own message carries the whole instance; only path and rule go back.
    wrong = {**ANSWER, "panels": [{**PANEL, "mark": "secret-mark"}]}
    llm = model(wrong)
    response = await ai.dashboards_generate(Req(llm=llm))
    message = json.loads(response.body)["error"]["message"]
    assert "panels/0/mark" in message and "secret-mark" not in message


def test_every_wrong_panel_is_named_not_only_the_first():
    panels = [{**PANEL, "unit": "currency"}, {**PANEL, "title": "Fine"},
              {"title": "Bad sum", "mark": "stat", "agg": "sum", "column": "status", "grain": "none"}]
    with pytest.raises(ValueError) as caught:
        ai.validate_proposal({**ANSWER, "panels": panels}, dataset(), "postgres", "30d")
    assert "'Total events': counts" in str(caught.value) and "'Bad sum': this aggregate" in str(caught.value)
    assert "'Fine'" not in str(caught.value)
