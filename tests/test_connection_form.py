"""The connect-a-database form and the gateway agree about what exists.

Seven engines were added to the specs, the driver map and the operation schema,
and the screen kept offering five — because it carries its own hardcoded list.
Everything passed, nothing was visibly different, and the feature was announced.
The same shape as the refresh button that was never rendered.

This reads the list out of the TSX rather than trusting it, because the two
lists live in different languages and nothing else makes them meet.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

FORM = Path(__file__).resolve().parent.parent / "web/src/views/DashboardNew.tsx"


def offered_by_the_form() -> list[str]:
    src = FORM.read_text()
    block = re.search(r"const ENGINES = \[(.*?)\n\]", src, re.DOTALL)
    assert block, "the ENGINES list has moved; this test needs updating with it"
    return re.findall(r"id: '([a-z_]+)'", block.group(1))


def accepted_by_the_gateway() -> set[str]:
    from commonindex.gateway.app import REGISTRY

    return set(REGISTRY.get("connections.create").input_schema["properties"]["kind"]["enum"])


def test_the_form_offers_every_engine_the_gateway_accepts():
    missing = accepted_by_the_gateway() - set(offered_by_the_form())
    assert not missing, (
        f"the gateway accepts {sorted(missing)} and the form does not offer them — "
        "added to the backend and invisible to anybody using it")


def test_the_form_offers_nothing_the_gateway_would_refuse():
    """The other direction, which is worse: a choice that fails on submit."""
    extra = set(offered_by_the_form()) - accepted_by_the_gateway()
    assert not extra, f"the form offers {sorted(extra)}, which connections.create rejects"


def test_every_offered_engine_has_a_spec_and_a_driver():
    from commonindex.core.warehouse.dialects import SPECS
    from commonindex.gateway.authoring import _DRIVERS

    for kind in offered_by_the_form():
        assert kind in SPECS, f"{kind} is offered with no engine spec"
        assert kind in _DRIVERS, f"{kind} is offered with no driver"


def test_the_form_has_no_duplicates():
    ids = offered_by_the_form()
    assert len(ids) == len(set(ids)), ids


@pytest.mark.parametrize("kind,port", [
    ("postgres", 5432), ("mysql", 3306), ("mariadb", 3306),
    ("redshift", 5439), ("clickhouse", 9000), ("mssql", 1433),
])
def test_a_host_engine_carries_its_conventional_port(kind, port):
    """Typed from memory otherwise, and a wrong default is a connection that
    fails for a reason the message will not mention."""
    src = FORM.read_text()
    row = re.search(rf"id: '{kind}',[^}}]*", src)
    assert row and f"port: {port}" in row.group(0), row.group(0) if row else "missing"


@pytest.mark.parametrize("kind", ["duckdb", "sqlite"])
def test_a_file_engine_is_marked_as_one(kind):
    """Their "database" is a path, so the form asks for a file rather than a
    host and a port."""
    src = FORM.read_text()
    row = re.search(rf"id: '{kind}',[^}}]*", src)
    assert row and "file: true" in row.group(0)
