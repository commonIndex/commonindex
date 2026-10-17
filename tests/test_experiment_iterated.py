"""'Iterate' is its own outcome, not a kill.

It means this version is not shipped and the idea goes on to a follow-up.
Recorded as 'killed', it inflated the kill count and hid the loop.
"""

from __future__ import annotations

import json
from pathlib import Path

from commonindex.gateway import experiments as ex


def test_iterate_is_recorded_as_iterated():
    assert ex.DECIDED == {"ship": "shipped", "kill": "killed", "iterate": "iterated"}


class _Pool:
    def __init__(self, rows):
        self.rows = rows

    async def fetch(self, *_):
        return [{"props": json.dumps(r)} for r in self.rows]


class _Req:
    def __init__(self, rows):
        self.app = type("A", (), {"state": type("S", (), {"commonindex": {"pool": _Pool(rows)}})()})()
        self.state = type("T", (), {})()

    async def json(self):
        return {}


async def test_the_program_counts_iterations_apart_and_ship_rate_over_all_decided():
    rows = [{"status": "shipped", "metric": "conv"}, {"status": "killed", "metric": "conv"},
            {"status": "iterated", "metric": "conv"}, {"status": "iterated", "metric": "aov"},
            {"status": "running"}]
    out = await ex.experiments_program(_Req(rows))
    assert (out["decided"], out["shipped"], out["killed"], out["iterated"]) == (4, 1, 1, 2)
    assert out["winRate"] == 25                     # shipped of everything decided
    conv = next(m for m in out["byMetric"] if m["metric"] == "conv")
    assert conv == {"metric": "conv", "shipped": 1, "killed": 1, "iterated": 1, "rate": 33}


def test_the_migration_moves_only_iterate_decisions():
    sql = (Path(__file__).resolve().parents[1] / "migrations" / "0030_experiment_iterated.sql").read_text()
    assert "props->>'status' = 'killed'" in sql and "props->'decision'->>'outcome' = 'iterate'" in sql
