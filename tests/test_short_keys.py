"""An id field takes the short key the app shows (DOC-33, EXP-31).

Every page labels its item with a key and no operation accepted one, so an
agent, or a person pasting what they see, was told the item did not exist.
"""

from __future__ import annotations

import json


class _Pool:
    def __init__(self, rows):
        self.rows, self.asked = rows, []

    async def fetch(self, sql, space, keys):
        self.asked.append((space, sorted(keys)))
        return [{"key": k, "id": i} for k, i in self.rows.items() if k in keys]


class _Req:
    def __init__(self, body, pool, method="POST", ctype="application/json"):
        self._body = json.dumps(body).encode() if not isinstance(body, bytes) else body
        self.method = method
        self.headers = {"content-type": ctype}
        self.app = type("A", (), {"state": type("S", (), {"commonindex": {"pool": pool}})()})()

    async def body(self):
        return self._body


async def _resolved(body, rows, **kw):
    from commonindex.gateway.keys import _resolve_keys

    pool = _Pool(rows)
    req = _Req(body, pool, **kw)
    await _resolve_keys(req, "pay")
    try:
        return json.loads(req._body), pool
    except ValueError:
        return req._body, pool


async def test_a_key_in_an_id_field_becomes_the_items_id():
    out, pool = await _resolved({"id": "DOC-33", "q": "DOC-33"}, {"DOC-33": "doc-45b7"})
    assert out == {"id": "doc-45b7", "q": "DOC-33"}          # only id fields; a search for the text is left alone
    assert pool.asked == [("pay", ["DOC-33"])]               # looked up in the caller's space only


async def test_every_id_field_and_only_whole_keys():
    out, _ = await _resolved({"experiment_id": "EXP-31", "subject_id": "CH-34", "doc_id": "doc-1", "metric_id": "m.conv",
                              "title": "EXP-31"}, {"EXP-31": "exp-x", "CH-34": "channel-y"})
    assert out == {"experiment_id": "exp-x", "subject_id": "channel-y", "doc_id": "doc-1", "metric_id": "m.conv",
                   "title": "EXP-31"}


async def test_a_key_that_names_nothing_is_left_to_be_refused_by_name():
    out, _ = await _resolved({"id": "DOC-99999"}, {})
    assert out == {"id": "DOC-99999"}


async def test_nothing_is_read_or_looked_up_without_a_key():
    out, pool = await _resolved({"id": "doc-45b7"}, {"DOC-33": "doc-45b7"})
    assert out == {"id": "doc-45b7"} and pool.asked == []
    out, pool = await _resolved(b"not json", {})
    assert out == b"not json" and pool.asked == []
