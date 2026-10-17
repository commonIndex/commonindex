"""Three lists of aggregates, which had drifted apart.

`ratio` and `share` exist because "refund rate" is the example this product
uses to explain itself — in the schema comments, in the UI copy, and in the
argument for having a metric registry at all. The comment above them in
`authoring.py` says so: "a dashboard tool whose headline example it cannot
build is not finished."

Neither authoring surface offered either one. The wizard listed six of the
eight and the add-panel form listed five, having also quietly lost
`count_distinct`. So the headline example was buildable through the API and
not through the product.

Exactly the failure `test_mark_lists_agree.py` catches one field over, and the
same answer: read the client's list out of the source and compare.
"""

from __future__ import annotations

import re
from pathlib import Path

from commonindex.core.ops import Registry
from commonindex.core.warehouse.ops import register
from commonindex.gateway.authoring import AGGS, NEEDS_DEN, NEEDS_VALUE

ROOT = Path(__file__).resolve().parent.parent
AGGS_TS = ROOT / "web/src/data/aggs.ts"


def offered_by_the_client() -> list[str]:
    src = AGGS_TS.read_text()
    block = re.search(r"export const AGGS: AggOption\[\] = \[(.*?)\n\]", src, re.DOTALL)
    assert block, "the AGGS list has moved; this test needs updating with it"
    return re.findall(r"id: '([a-z_]+)'", block.group(1))


def _flagged(flag: str) -> set[str]:
    """Which client entries carry a given flag, read off the source."""
    src = AGGS_TS.read_text()
    block = re.search(r"export const AGGS: AggOption\[\] = \[(.*?)\n\]", src, re.DOTALL)
    out = set()
    for entry in re.split(r"\n  \{|\n  \},?", block.group(1)):
        m = re.search(r"id: '([a-z_]+)'", entry)
        if m and re.search(rf"\b{flag}: true", entry):
            out.add(m.group(1))
    return out


def test_the_client_offers_every_aggregate_the_server_can_compile():
    assert set(offered_by_the_client()) == set(AGGS)


def test_the_headline_example_is_buildable_from_the_product():
    """Not only through the API. This is the assertion the file exists for."""
    offered = offered_by_the_client()
    assert "ratio" in offered and "share" in offered


def test_the_schema_an_agent_reads_offers_the_same_set():
    reg = Registry()
    register(reg)
    schema = reg.get("panels.preview").input_schema["properties"]["agg"]
    assert set(schema["enum"]) == set(AGGS)


def test_the_client_knows_which_aggregates_need_a_second_column():
    """`ratio` without a denominator compiles to a division by nothing. The
    form has to know, or it offers to save a panel the server will refuse."""
    assert _flagged("denominator") == NEEDS_DEN


def test_the_client_knows_which_aggregates_need_a_value_to_match():
    assert _flagged("value") == NEEDS_VALUE


def test_an_aggregate_over_no_column_is_only_count():
    """Everything else names a column, and a form that hides the column picker
    for one of them silently sends `column: undefined`."""
    src = AGGS_TS.read_text()
    block = re.search(r"export const AGGS: AggOption\[\] = \[(.*?)\n\]", src, re.DOTALL)
    no_col = {m.group(1) for entry in re.split(r"\n  \{", block.group(1))
              if (m := re.search(r"id: '([a-z_]+)'", entry)) and "column: false" in entry}
    assert no_col == {"count"}
