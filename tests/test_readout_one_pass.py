"""Every outcome of a readout in one pass, with the same numbers as one at a time.

A twenty-three metric readout ran twenty-four queries over the same table. The
batched query must agree with the per-outcome one to the last digit, for every
way a readout can be shaped — per unit or per row, capped, nulls kept or zeroed,
split by cohort, yes/no outcomes and means side by side.
"""

from __future__ import annotations

import random

import pytest
import sqlalchemy as sa

from commonindex.core.warehouse import ColKind, Dataset, Dimension
from commonindex.core.warehouse.dialects import SPECS
from commonindex.core.warehouse.readout import Spec, build, build_many

DS = Dataset(
    id="e", connection_id="c", is_virtual=False, physical="exp",
    dimensions=[Dimension("arm", "arm", ColKind.STRING), Dimension("user_id", "user_id", ColKind.STRING),
                Dimension("platform", "platform", ColKind.STRING),
                Dimension("converted", "converted", ColKind.BOOL),
                Dimension("revenue", "revenue", ColKind.NUMBER),
                Dimension("clicks", "clicks", ColKind.NUMBER)])


@pytest.fixture(scope="module")
def engine():
    e = sa.create_engine("sqlite://")
    rnd = random.Random(7)
    with e.begin() as c:
        c.execute(sa.text("create table exp (arm text, user_id text, platform text,"
                          " converted boolean, revenue real, clicks real)"))
        rows = []
        for u in range(300):
            arm = "control" if u % 2 else "variant"
            for _ in range(rnd.randint(1, 3)):          # several rows per user
                rows.append({"a": arm, "u": f"u{u}", "p": rnd.choice(["ios", "web"]),
                             "c": rnd.random() < 0.2, "r": round(rnd.uniform(0, 90), 2),
                             "k": None if rnd.random() < 0.3 else rnd.randint(0, 9)})
        c.execute(sa.text("insert into exp values (:a, :u, :p, :c, :r, :k)"), rows)
    return e


def _run(engine, compiled):
    with engine.connect() as c:
        return [dict(r) for r in c.execute(sa.text(compiled.sql), compiled.params).mappings()]


SHAPES = [
    {"unit": "user_id"},
    {"unit": "user_id", "unit_agg": "max", "cap": 50.0, "null_is_zero": False},
    {"unit": None},
    {"unit": "user_id", "cohort": "platform"},
]


@pytest.mark.parametrize("shape", SHAPES)
def test_one_pass_agrees_with_one_query_per_outcome(engine, shape):
    outcomes = [("converted", True), ("revenue", False), ("clicks", False)]
    specs = [Spec("e", "arm", o, binary=b, **shape) for o, b in outcomes]
    together = _run(engine, build_many(SPECS["sqlite"], DS, specs))
    key = (lambda r: (r["variation"], r["cohort"])) if shape.get("cohort") else (lambda r: r["variation"])
    for i, s in enumerate(specs):
        alone = {key(r): r for r in _run(engine, build(SPECS["sqlite"], DS, s))}
        assert len(alone) == len(together)
        for r in together:
            a = alone[key(r)]
            assert r["n"] == a["n"]
            assert r[f"total_{i}"] == pytest.approx(a["total"])
            if not s.binary:
                assert r[f"sum_sq_{i}"] == pytest.approx(a["sum_sq"])


def test_outcomes_read_together_must_share_everything_else():
    with pytest.raises(ValueError, match="share unit"):
        build_many(SPECS["sqlite"], DS, [Spec("e", "arm", "revenue", unit="user_id"),
                                         Spec("e", "arm", "clicks", unit=None)])
