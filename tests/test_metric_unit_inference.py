"""Offline regression tests: numeric token totals must never imply dollars."""
from types import SimpleNamespace

import pytest

from commonindex.gateway.authoring import _definition


@pytest.mark.parametrize("agg,column,expected", [
    ("sum", "total_tokens", "count"),
    ("sum", "cost_tokens", "count"),
    ("sum", "total_requests", "count"),
    ("sum", "cost_usd", "currency"),
    ("sum", "revenue", "currency"),
    ("count", "cost_usd", "count"),
    ("count_distinct", "amount", "count"),
    ("ratio", "total_tokens", "pct"),
])
def test_inferred_units(agg, column, expected):
    ds = SimpleNamespace(id="test", dimensions=[SimpleNamespace(name=n) for n in [column, "requests"]])
    _, unit, _ = _definition({"agg": agg, "column": column, "denominator": "requests"}, ds)
    assert unit == expected


def test_explicit_unit_remains_authoritative():
    ds = SimpleNamespace(id="test", dimensions=[SimpleNamespace(name="amount")])
    assert _definition({"agg": "sum", "column": "amount", "unit": "count"}, ds)[1] == "count"
