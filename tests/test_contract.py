"""Pre-registration: what the contract owns, and what it refuses.

The contract exists for one reason — so the primary question is settled before
the data is visible. Every test here is about a way that guarantee could be
quietly lost: an override that looks like a parameter, a metric that moves under
the experiment, a reading choice mistaken for a measurement choice.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from commonindex.gateway.authoring import FREE, FROZEN, _compliance, _merge_contract

#: Inside any readout's default window, whatever today is. These were dated
#: 2026-08-20 and read "the last 30 days", so they failed on 19 September
#: without a line of code changing.
_RECENT = (datetime.now(tz=UTC) - timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")

CONTRACT = {
    "connection_id": "conn-1",
    "dataset_id": "public.exposures",
    "variation": "arm",
    "unit": "user_id",
    "control": "control",
    "outcome": "converted",
    "binary": True,
    "weights": {"control": 0.5, "variant": 0.5},
    "metric_id": "checkout_conv",
    "metric_version": 3,
    "alpha": 0.01,
    "mde": 0.02,
    "planned_days": 14,
    "registered_at": "2026-08-20T00:00:00+00:00",
    "guardrails": [
        {"outcome": "latency_ms", "metric_id": "p95_latency",
         "metric_version": 7, "binary": False},
    ],
}


# ── what the contract supplies ──────────────────────────────────────────


def test_a_bare_request_is_answered_entirely_from_the_contract():
    body, _, _ = _merge_contract({"experiment_id": "e1"}, CONTRACT)

    assert body["connection_id"] == "conn-1"
    assert body["dataset_id"] == "public.exposures"
    assert body["variation"] == "arm"
    assert body["unit"] == "user_id"
    assert body["outcome"] == "converted"
    assert body["control"] == "control"
    assert body["binary"] is True
    assert body["alpha"] == 0.01
    assert body["weights"] == {"control": 0.5, "variant": 0.5}


def test_guardrails_become_outcome_columns_in_registered_order():
    body, _, _ = _merge_contract({}, CONTRACT)
    assert [g["outcome"] for g in body["guardrails"]] == ["latency_ms"]


def test_a_guardrail_keeps_its_shape_and_direction():
    # Names alone read a rise in support contacts as "better".
    contract = {**CONTRACT, "guardrails": [
        {"outcome": "contacted_support", "binary": True, "better": "down"}]}
    body, _, _ = _merge_contract({}, contract)
    assert body["guardrails"] == [
        {"outcome": "contacted_support", "binary": True, "better": "down"}]


def test_every_cited_definition_carries_its_pinned_version():
    """The pin is the whole difference from a dashboard. A dashboard citing an
    id follows the current ratified meaning; an experiment must answer the
    question it registered, with the definition in force at the time."""
    body, pins, _ = _merge_contract({}, CONTRACT)
    assert body["metric_ids"] == {"converted": "checkout_conv",
                                  "latency_ms": "p95_latency"}
    assert pins == {"converted": 3, "latency_ms": 7}


def test_a_contract_without_versions_pins_nothing():
    """An older contract that named a metric but no version still resolves —
    against whatever is ratified — rather than failing."""
    bare = {**CONTRACT, "metric_version": None, "guardrails": []}
    del bare["metric_version"]
    body, pins, _ = _merge_contract({}, bare)
    assert body["metric_ids"] == {"converted": "checkout_conv"}
    assert pins == {}


# ── what it refuses ─────────────────────────────────────────────────────


@pytest.mark.parametrize("field,value", [
    ("outcome", "revenue"),
    ("dataset_id", "public.other"),
    ("variation", "bucket"),
    ("unit", "session_id"),
    ("binary", False),
    ("control", "variant"),
    ("alpha", 0.2),
    ("weights", {"control": 0.9, "variant": 0.1}),
    ("guardrails", ["something_new"]),
    ("metric_ids", {"converted": "a_kinder_metric"}),
    ("connection_id", "conn-2"),
])
def test_every_measurement_choice_is_refused(field, value):
    """Each of these changes WHAT is measured. Being able to change one after
    seeing the numbers is the entire p-hacking surface: swap the outcome column
    and the readout answers a question nobody registered, with no trace."""
    with pytest.raises(ValueError, match=field):
        _merge_contract({"experiment_id": "e1", field: value}, CONTRACT)


def test_the_refusal_names_the_field_so_a_caller_can_correct_itself():
    with pytest.raises(ValueError) as e:
        _merge_contract({"outcome": "revenue"}, CONTRACT)
    assert str(e.value) == "outcome"


@pytest.mark.parametrize("field,value", [
    ("range", "7d"),
])
def test_every_reading_choice_is_allowed(field, value):
    """A reading choice is one that cannot change the answer. `range` is the
    honest example: looking at a shorter window shows fewer data, and shows it
    with a wider interval, which is the correct consequence rather than a
    better one."""
    body, _, _ = _merge_contract({"experiment_id": "e1", field: value}, CONTRACT)
    assert body[field] == value


@pytest.mark.parametrize("field,value", [
    ("sequential", False),
    ("tuning", 20_000),
    ("threshold", 1e-300),
])
def test_a_field_that_can_change_the_answer_is_not_a_reading_choice(field, value):
    """These three were FREE, under a comment saying they "change how the
    evidence is READ, not what is measured" and that "neither can turn a null
    result into a positive one". The second half was false.

    See the numeric proof below. A field that can move the verdict belongs to
    the contract whatever it is called.
    """
    with pytest.raises(ValueError) as e:
        _merge_contract({"experiment_id": "e1", field: value}, CONTRACT)
    assert str(e.value) == field


def test_reading_a_sequence_as_a_fixed_interval_turns_a_null_into_a_win():
    """The proof, not the assertion.

    Same counts, same alpha, one flag. `verdict` reads only the interval, so
    this is the whole distance between "we did not learn anything" and "ship
    it" — available at read time, after the numbers were visible, and recorded
    nowhere.
    """
    from commonindex.core.inference.stats import Arm, compare, verdict

    a, b = Arm("control", 10_000, 1000), Arm("variant", 10_000, 1089)
    seq = compare(a, b, binary=True, sequential=True)
    fixed = compare(a, b, binary=True, sequential=False)

    assert verdict(seq, "up") == "no difference detected"
    assert verdict(fixed, "up") == "better"
    # And the sequence is the WIDER of the two, which is what buys the right to
    # look whenever you like.
    assert (seq.lift_ci[1] - seq.lift_ci[0]) > (fixed.lift_ci[1] - fixed.lift_ci[0])


def test_an_srm_threshold_of_zero_means_zero():
    """`float(body.get("threshold") or DEFAULT)` substituted the default for 0
    — the one value meaning "never call this split broken". It was the single
    thing the parameter could not express."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring._srm_check)
    assert "raw is None else float(raw)" in src


def test_a_null_override_is_not_an_override():
    """Clients serialise absent fields as null. Treating that as an attempt to
    change the outcome would make the contract unusable from any typed client."""
    body, _, _ = _merge_contract({"outcome": None, "weights": None}, CONTRACT)
    assert body["outcome"] == "converted"


def test_frozen_and_free_do_not_overlap():
    """A field in both lists would be silently frozen or silently free
    depending on which check ran first."""
    assert not set(FROZEN) & set(FREE)


# ── what it reports to somebody who was not there ───────────────────────


def _at(days_ago: int) -> str:
    return (datetime.now(tz=UTC) - timedelta(days=days_ago)).isoformat()


def test_reading_before_the_registered_duration_is_flagged():
    notes = _compliance({}, {**CONTRACT, "registered_at": _at(3), "planned_days": 14})
    assert any("day 3 of a planned 14" in n for n in notes)
    # And it says why that matters, rather than only that it happened.
    assert any("not yet a null result" in n for n in notes)


def test_reading_long_after_it_is_flagged_too():
    """A test left running is not more evidence; it is a different population."""
    notes = _compliance({}, {**CONTRACT, "registered_at": _at(40), "planned_days": 14})
    assert any("more than twice" in n for n in notes)


def test_running_to_plan_earns_no_note():
    notes = _compliance({}, {**CONTRACT, "registered_at": _at(15), "planned_days": 14})
    assert not any("planned" in n for n in notes)


def test_a_missing_mde_is_reported_because_it_changes_what_null_means():
    notes = _compliance({}, {k: v for k, v in CONTRACT.items() if k != "mde"})
    assert any("too small to see" in n for n in notes)


def test_a_missing_unit_is_reported_as_counting_rows():
    notes = _compliance({}, {k: v for k, v in CONTRACT.items() if k != "unit"})
    assert any("ROWS" in n for n in notes)


def test_a_missing_split_is_reported_as_assumed_even():
    notes = _compliance({}, {k: v for k, v in CONTRACT.items() if k != "weights"})
    assert any("even split was assumed" in n for n in notes)


def test_a_complete_contract_read_on_time_is_quiet():
    """A checker that always has something to say is one nobody reads."""
    assert _compliance({}, {**CONTRACT, "registered_at": _at(15)}) == []


def test_an_unparseable_timestamp_does_not_take_the_readout_down():
    """Registration timestamps come from stored JSON, which is not a guarantee
    that they parse."""
    notes = _compliance({}, {**CONTRACT, "registered_at": "whenever"})
    assert isinstance(notes, list)


# ── the handler path ────────────────────────────────────────────────────

sa = pytest.importorskip("sqlalchemy")


class _Pool:
    """Just the one call `_contract_for` makes."""

    def __init__(self, row):
        self._row = row

    async def fetchrow(self, sql, *args):
        return self._row


class _Req:
    def __init__(self, body, state):
        self._body = body
        self.app = type("A", (), {"state": type("S", (), {"commonindex": state})()})()

    async def json(self):
        return self._body


async def _return(v):
    return v


def _state(tmp_path, monkeypatch, contract, *, rows=None, status="running", extra=None):
    """A source over throwaway SQLite plus a pool that returns one experiment."""
    import json as _json

    pytest.importorskip("aiosqlite")
    from sqlalchemy.ext.asyncio import create_async_engine

    from commonindex.core.warehouse import ColKind, Connection, Dataset, Dimension
    from commonindex.core.warehouse.dialects import SPECS
    from commonindex.core.warehouse.sources.direct import DirectWarehouseSource
    from commonindex.gateway import authoring

    rows = rows or (
        [(_RECENT, f"c{i}", "control", 1 if i < 100 else 0) for i in range(1000)]
        + [(_RECENT, f"v{i}", "variant", 1 if i < 200 else 0) for i in range(1000)])

    url = f"sqlite:///{tmp_path/'c.sqlite'}"
    engine = sa.create_engine(url)
    with engine.begin() as c:
        c.execute(sa.text("create table exposures"
                          " (ts timestamp, user_id varchar, arm varchar, converted int)"))
        c.execute(sa.text("insert into exposures values (:ts,:uid,:arm,:conv)"),
                  [{"ts": t, "uid": u, "arm": a, "conv": v} for t, u, a, v in rows])

    ds = Dataset(id="exposures", connection_id="c1", physical="exposures",
                 time_column="ts",
                 dimensions=[Dimension("arm", "arm", ColKind.STRING),
                             Dimension("user_id", "user_id", ColKind.STRING),
                             Dimension("converted", "converted", ColKind.NUMBER)])

    class _Metrics:
        async def resolve(self, space, mid):
            raise LookupError(mid)

        async def resolve_version(self, space, mid, version):
            raise LookupError(mid)

    src = DirectWarehouseSource(
        Connection(id="c1", space_id="s", kind="sqlite", dsn=url), _Metrics(),
        engine=create_async_engine(url.replace("sqlite://", "sqlite+aiosqlite://")))
    src._spec = SPECS["sqlite"]
    src._dataset = lambda _id, _ds=ds: _return(_ds)

    async def _fake_source(state, conn_id, space="pay"):
        return src, {}

    monkeypatch.setattr(authoring, "_source", _fake_source)

    props = {"status": status, "hypothesis": "h", **(extra or {})}
    if contract is not None:
        props["contract"] = contract
    row = {"id": "exp-1", "title": "Checkout CTA", "props": _json.dumps(props)}
    return {"pool": _Pool(row), "metrics": _Metrics()}


LIVE = {"connection_id": "c1", "dataset_id": "exposures", "variation": "arm",
        "unit": "user_id", "control": "control", "outcome": "converted",
        "binary": True, "alpha": 0.05, "mde": 0.02, "planned_days": 14,
        "weights": {"control": 0.5, "variant": 0.5}}


async def test_an_experiment_id_alone_produces_a_readout(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    state = _state(tmp_path, monkeypatch, LIVE)
    out = await experiments_readout(_Req({"experiment_id": "exp-1"}, state))

    assert out["pre_registered"] is True
    assert out["experiment"]["title"] == "Checkout CTA"
    assert out["experiment"]["planned_days"] == 14
    assert out["srm"]["passed"] and out["srm"]["counted"] == "units"
    assert out["results"][0]["comparisons"][0]["verdict"] == "better"


async def test_an_override_is_refused_with_the_field_named(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    state = _state(tmp_path, monkeypatch, LIVE)
    res = await experiments_readout(
        _Req({"experiment_id": "exp-1", "outcome": "user_id"}, state))

    import json as _json
    body = _json.loads(res.body)
    assert res.status_code == 409
    assert body["error"]["code"] == "contract_override"
    assert body["error"]["field"] == "outcome"


async def test_a_reading_choice_is_not_an_override(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    state = _state(tmp_path, monkeypatch, LIVE)
    out = await experiments_readout(
        _Req({"experiment_id": "exp-1", "range": "7d"}, state))
    assert out["range"] == "7d"
    # And the regime came from the contract, not from the request — which no
    # longer has a say in it.
    assert out["sequential"] is CONTRACT.get("sequential", True)


async def test_an_experiment_with_no_contract_is_refused_not_guessed(tmp_path, monkeypatch):
    """Falling back to the request arguments here would mean an experiment
    could be 'read out' against anything at all and still look official."""
    import json as _json

    from commonindex.gateway.authoring import experiments_readout

    state = _state(tmp_path, monkeypatch, None)
    res = await experiments_readout(_Req({"experiment_id": "exp-1"}, state))
    body = _json.loads(res.body)
    assert res.status_code == 422
    assert body["error"]["code"] == "not_pre_registered"


async def test_a_readout_with_neither_contract_nor_arguments_is_a_typed_error(tmp_path, monkeypatch):
    """Was a KeyError, so an agent got a 500 with nothing to correct."""
    import json as _json

    from commonindex.gateway.authoring import experiments_readout

    state = _state(tmp_path, monkeypatch, LIVE)
    res = await experiments_readout(_Req({}, state))
    body = _json.loads(res.body)
    assert res.status_code == 422
    assert body["error"]["code"] == "incomplete_readout"
    assert "experiment_id" in body["error"]["message"]


# ── every argument is classified ────────────────────────────────────────


def test_every_readout_argument_is_frozen_or_free():
    """The guard for the bug that shipped.

    `_merge_contract` rebuilds the effective request from FREE alone, so a
    field in neither list is dropped without a word. `record: true` was accepted
    by the schema, discarded here, and the caller got a readout with no
    recording and no error — a feature that appeared to work and did nothing.

    Adding an argument to the operation now fails this test until somebody
    decides whether it changes what is measured or only how it is read.
    """
    from commonindex.gateway.app import REGISTRY

    props = set(REGISTRY.get("experiments.readout").input_schema["properties"])
    unclassified = sorted(props - set(FROZEN) - set(FREE))
    assert not unclassified, (
        "arguments the contract merge would silently drop: "
        f"{unclassified} — add each to FROZEN (a measurement choice) or FREE "
        "(a reading choice)")


def test_an_unclassified_field_in_a_request_is_refused_not_dropped():
    with pytest.raises(ValueError, match="silently dropped"):
        _merge_contract({"experiment_id": "e1", "novel_argument": 1}, CONTRACT)


def test_recording_is_a_reading_choice_not_a_measurement_one():
    """Recording is an action taken on the result, not a change to what was
    measured, so it is not frozen."""
    body, _, _ = _merge_contract({"experiment_id": "e1", "record": True}, CONTRACT)
    assert body["record"] is True


def test_an_actor_id_in_the_body_is_refused_and_told_why():
    """It used to be an argument, and three handlers DEFAULTED it to a real
    named human when absent. Identity comes from the token now, so a caller
    still sending it is asking to be attributed as somebody it named itself."""
    with pytest.raises(ValueError, match="bearer token"):
        _merge_contract({"experiment_id": "e1", "actor_id": "alex"}, CONTRACT)


@pytest.mark.parametrize("field,value", [
    ("unit_agg", "avg"), ("cap", 500.0), ("null_is_zero", False)])
def test_the_aggregation_choices_come_from_the_contract(field, value):
    """Found by the classification test above, which is why it exists.

    These three decide what the number IS — revenue per user summed and revenue
    per user averaged are different experiments, and a cap chosen after seeing
    which outliers landed in which arm is p-hacking with extra steps. They were
    accepted by the operation schema and dropped by the merge, so a
    pre-registered experiment could not pin them and a request could not set
    them either.
    """
    contract = {**CONTRACT, field: value}
    body, _, _ = _merge_contract({"experiment_id": "e1"}, contract)
    assert body[field] == value

    with pytest.raises(ValueError, match=field):
        _merge_contract({"experiment_id": "e1", field: value}, CONTRACT)


# ── reading a table instead of asking about it ──────────────────────────


def test_the_suggestion_only_claims_confidence_on_a_table_big_enough():
    """A category column is shaped like an experiment arm and is not one.

    `created_by` over 42 rows has three values covering the table evenly enough
    to pass every structural test there is. Nothing in the shape separates them,
    so the one signal that is actually reliable — a table too small to have run
    an experiment — is the one that gates the claim.
    """
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.experiments_suggest)
    assert "rows >= 200" in src, "confidence must require a table of some size"
    assert '"confident"' in src


def test_the_suggestion_keeps_nothing():
    """Deliberately not `datasets.profile`, which stores value histograms and
    is priced accordingly. This answers one question and writes nothing."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.experiments_suggest)
    assert "insert into" not in src.lower()
    assert "update " not in src.lower()


def test_the_suggestion_reads_the_table_once():
    """One scan. A COUNT(DISTINCT) per column issued separately would be a
    query per column on the author's warehouse, for a hint."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.experiments_suggest)
    assert src.count("SELECT COUNT(*)") == 1
    assert "picked = strings[:24]" in src, "the column list must stay bounded"


# ── panel order ─────────────────────────────────────────────────────────


def test_reordering_takes_the_whole_order_not_a_pair():
    """A drag is one intent. Applying it as a sequence of pairwise moves leaves
    a window where the stored order is neither the old one nor the new one, and
    anything reading `order by position` mid-write sees panels swap places."""
    from commonindex.gateway.app import REGISTRY

    op = REGISTRY.get("panels.reorder")
    assert op is not None and op.mutating
    props = op.input_schema["properties"]
    assert props["panel_ids"]["type"] == "array"
    assert set(op.input_schema["required"]) == {"dashboard_id", "panel_ids", "idempotencyKey"}


def test_reordering_writes_through_a_scratch_range():
    """Position carries no unique index, but writing straight into the target
    values still passes through states where two panels share one."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.panels_reorder)
    assert "position = position + $2" in src, "no scratch pass"
    assert "async with conn.transaction()" in src, "the two passes must be atomic"


def test_reordering_refuses_a_partial_order():
    """Omitted panels would collapse onto whatever position they already held
    and interleave with the new ones."""
    import inspect

    from commonindex.gateway import authoring

    src = inspect.getsource(authoring.panels_reorder)
    assert "incomplete_order" in src
    assert "unknown_panel" in src


# ── the days a readout reads ────────────────────────────────────────────


def _ago(days: float) -> datetime:
    return datetime.now(tz=UTC) - timedelta(days=days)


def _rows(days_ago: float, prefix: str, n: int, conv_control: int, conv_variant: int):
    at = _ago(days_ago).strftime("%Y-%m-%d %H:%M:%S")
    return ([(at, f"{prefix}c{i}", "control", 1 if i < conv_control else 0) for i in range(n)]
            + [(at, f"{prefix}v{i}", "variant", 1 if i < conv_variant else 0) for i in range(n)])


def _units(out) -> int:
    return sum(a["n"] for a in out["results"][0]["arms"])


async def test_a_started_experiment_reads_from_its_start_not_the_last_30_days(tmp_path, monkeypatch):
    """Traffic from before the start is somebody else's traffic."""
    from commonindex.gateway.authoring import experiments_readout

    rows = _rows(20, "before", 500, 50, 50) + _rows(3, "during", 500, 50, 100)
    state = _state(tmp_path, monkeypatch, LIVE, rows=rows,
                   extra={"started_at": _ago(10).isoformat()})
    out = await experiments_readout(_Req({"experiment_id": "exp-1"}, state))
    assert out["window"]["basis"] == "experiment"
    assert _units(out) == 1000, "only the 1,000 units since the start"


async def test_a_stopped_experiment_reads_up_to_its_stop_and_no_further(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    rows = _rows(8, "during", 500, 50, 100) + _rows(1, "after", 500, 50, 50)
    state = _state(tmp_path, monkeypatch, LIVE, rows=rows, status="readout",
                   extra={"started_at": _ago(12).isoformat(), "stopped_at": _ago(4).isoformat()})
    out = await experiments_readout(_Req({"experiment_id": "exp-1"}, state))
    assert _units(out) == 1000, "late traffic must not move a result being decided on"


async def test_an_experiment_read_long_after_it_stopped_still_has_its_data(tmp_path, monkeypatch):
    """The bug in one line: read "the last 30 days" two months after stopping
    and the readout found nothing."""
    from commonindex.gateway.authoring import experiments_readout

    rows = _rows(70, "during", 500, 50, 100)
    state = _state(tmp_path, monkeypatch, LIVE, rows=rows, status="readout",
                   extra={"started_at": _ago(75).isoformat(), "stopped_at": _ago(60).isoformat()})
    out = await experiments_readout(_Req({"experiment_id": "exp-1"}, state))
    assert _units(out) == 1000
    assert out["srm"]["ran"] and out["srm"]["total"] == 1000, "the split check reads the same days"


async def test_without_a_start_it_reads_the_range_and_says_so(tmp_path, monkeypatch):
    from commonindex.gateway.authoring import experiments_readout

    state = _state(tmp_path, monkeypatch, LIVE)
    out = await experiments_readout(_Req({"experiment_id": "exp-1"}, state))
    assert out["window"]["basis"] == "range"
    # Which days were read is its own note, not one of the notes comparing
    # the reading with the contract.
    assert "No start date on record" in out["window"]["note"]
    assert not any("start date" in n for n in out.get("contract_notes") or [])


async def test_the_extent_says_when_the_tables_traffic_ran(tmp_path, monkeypatch):
    """The evidence for the dates of an experiment registered after the fact,
    read from the table rather than defaulted to today."""
    from commonindex.gateway import experiments

    rows = _rows(40, "early", 50, 5, 5) + _rows(12, "late", 50, 5, 5)
    state = _state(tmp_path, monkeypatch, LIVE, rows=rows)
    monkeypatch.setattr(experiments, "_source", authoring_source(monkeypatch))

    class _Held:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self.pool

        async def __aexit__(self, *_):
            return False

    state["pool"].acquire = lambda: _Held(state["pool"])
    out = await experiments.experiments_extent(_Req({"experiment_id": "exp-1"}, state))
    assert out["rows"] == 200
    assert out["first_seen"][:10] == _ago(40).strftime("%Y-%m-%d")
    assert out["last_seen"][:10] == _ago(12).strftime("%Y-%m-%d")


def authoring_source(monkeypatch):
    """The fake source _state installed on authoring, for modules that imported
    `_source` by name before the patch."""
    from commonindex.gateway import authoring
    return authoring._source



def test_the_suggested_outcome_is_the_yes_no_result_not_an_identifier():
    """Alphabetical among numbers put `revenue` first, offered `user_id` as an
    outcome, and left `converted` out because it was a boolean."""
    import inspect

    from commonindex.gateway import authoring

    assert authoring._OUTCOME.search("converted") and authoring._OUTCOME.search("is_retained")
    assert authoring._ID.search("user_id") and authoring._ID.search("id") and not authoring._ID.search("revenue")
    src = inspect.getsource(authoring.experiments_suggest)
    assert "ColKind.BOOL" in src and "_ID.search" in src
