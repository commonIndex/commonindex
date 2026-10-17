"""Four lists of chart shapes, which had drifted apart.

The CHECK constraint, the schema an agent reads, the client's wire mapping and
the menu an author picks from were four hand-kept copies. `stacked`, `heatmap`
and `table` render correctly, are accepted by the database and are mapped by
the client — and neither authoring surface offered them, so three working
chart types existed that nobody could choose.

This is the same failure as the connection form, which offered five engines
while the server supported twelve, and `test_connection_form.py` is the
precedent for catching it: read the client's list out of the source and
compare. A list nobody compares is a list that drifts.
"""

from __future__ import annotations

import re
from pathlib import Path

from commonindex.core.ops import Registry
from commonindex.core.warehouse.dashboard import AUTHORABLE_MARKS, MARKS
from commonindex.core.warehouse.ops import register

ROOT = Path(__file__).resolve().parent.parent
MARKS_TSX = ROOT / "web/src/components/marks.tsx"
MIGRATIONS = ROOT / "migrations"


def offered_by_the_client() -> list[str]:
    src = MARKS_TSX.read_text()
    block = re.search(r"export const MARKS: MarkOption\[\] = \[(.*?)\n\]", src, re.DOTALL)
    assert block, "the MARKS list has moved; this test needs updating with it"
    return re.findall(r"id: '([a-z]+)'", block.group(1))


def schema_marks(op: str) -> list[str]:
    reg = Registry()
    register(reg)
    props = reg.get(op).input_schema["properties"]
    node = props.get("mark") or props["panels"]["items"]["properties"]["mark"]
    return node["enum"]


def test_every_op_that_takes_a_mark_constrains_it_to_the_same_set():
    """Two of the three took `{"type": "string"}`, so a typo passed the schema
    and arrived at the database as a constraint violation naming a constraint."""
    for op in ("panels.preview", "panels.add", "dashboards.create"):
        assert schema_marks(op) == list(MARKS), op


def test_the_database_accepts_every_mark_the_schema_offers():
    """Otherwise the API accepts a panel the write then refuses.

    Read from the LAST migration that redefines the constraint, in filename
    order, which is how the database arrives at the one it is actually
    enforcing. Naming a migration by number pinned this to whichever file
    happened to define it the day the test was written, and it broke the next
    time a mark was added — which is the moment it should have been checking
    something.
    """
    latest = [m for m in sorted(MIGRATIONS.glob("*.sql"))
              if "panel_bindings_mark_check" in m.read_text()][-1]
    check = latest.read_text()
    allowed = set(re.findall(r"'([a-z]+)'", check.split("mark in (")[1].split(")")[0]))
    assert set(MARKS) <= allowed, f"{latest.name} is missing {set(MARKS) - allowed}"


def test_the_client_offers_every_mark_an_author_may_pick():
    """The bug this file exists for. `stacked`, `heatmap` and `table` were
    renderable, storable and unofferable.

    Compared as a SET: the menu's order is how a picker reads — commonest
    first, related shapes adjacent — and the server has no opinion about it.
    Asserting the order would fail every time somebody reordered a menu, which
    is how a test gets deleted rather than fixed.
    """
    offered = offered_by_the_client()
    assert set(offered) == set(AUTHORABLE_MARKS)
    assert len(offered) == len(set(offered)), "a shape is listed twice"


def test_sql_is_not_offered_as_a_shape():
    """A panel carrying its own query is chosen by writing one. Offering it in
    a shape menu asks somebody to pick "sql" and then wonder where to type it."""
    assert "sql" in MARKS and "sql" not in AUTHORABLE_MARKS
    assert "sql" not in offered_by_the_client()


def test_the_client_uses_the_servers_spelling_not_the_renderers():
    """`heatmap` is stored; `heat` is what the renderer branches on. The menu
    sends what the server stores, and `markKind` converts for rendering — one
    list typed in the renderer's vocabulary could not send `heatmap` at all."""
    assert "heatmap" in offered_by_the_client()
    assert "heat" not in offered_by_the_client()
    assert "markKind" in MARKS_TSX.read_text()
