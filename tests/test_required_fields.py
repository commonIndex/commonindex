"""A missing required field is a typed 422 naming the field, never a 500.

Found by calling every operation with an empty body: these two read a
required field with body["..."], so leaving it out was a KeyError and an
"Internal Server Error" with nothing to act on.
"""

from __future__ import annotations

import json

import pytest


class _Req:
    def __init__(self, body):
        self._body = body
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": "maya"})(), "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {}})()})()
        self.headers = {}

    async def json(self):
        return self._body


async def _call(handler, body):
    out = await handler(_Req(body))
    return out.status_code, json.loads(out.body)


@pytest.mark.parametrize("body, field", [({}, "metric_id"), ({"metric_id": "  "}, "metric_id")])
async def test_ratify_without_a_metric_names_the_field(body, field):
    from commonindex.gateway.app import metrics_ratify

    status, out = await _call(metrics_ratify, body)
    assert status == 422 and out["error"]["field"] == field


@pytest.mark.parametrize("body, field", [({}, "name"), ({"name": "Warehouse"}, "idempotencyKey")])
async def test_a_connection_without_a_name_or_key_names_the_field(body, field):
    from commonindex.gateway.authoring import connections_create

    status, out = await _call(connections_create, body)
    assert status == 422 and out["error"]["field"] == field
