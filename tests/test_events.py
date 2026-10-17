"""Pushed changes reach only the pages that may see them.

A page hears which conversation changed — never what was said — and only when
its reader holds one of the keys the conversation is readable by, in the same
workspace: the rule every list applies.
"""

from __future__ import annotations

from commonindex.gateway.events import Hub


def test_a_reader_hears_only_what_they_may_read():
    hub = Hub()
    _, mine = hub.add("pay", ["space:pay", "user:maya"])
    _, other = hub.add("pay", ["user:vic"])
    _, elsewhere = hub.add("ops", ["space:ops"])
    hub.publish({"space": "pay", "subject_id": "doc-1", "acl": ["space:pay"]})
    hub.publish({"space": "pay", "subject_id": "doc-private", "acl": ["user:maya"]})
    assert [mine.get_nowait(), mine.get_nowait()] == ["doc-1", "doc-private"]
    assert other.empty() and elsewhere.empty()


def test_a_page_that_left_hears_nothing_more():
    hub = Hub()
    sid, q = hub.add("pay", ["space:pay"])
    hub.remove(sid)
    hub.publish({"space": "pay", "subject_id": "doc-1", "acl": ["space:pay"]})
    assert q.empty() and len(hub) == 0


def test_a_page_far_behind_is_dropped_from_not_blocked_on():
    hub = Hub()
    _, q = hub.add("pay", ["space:pay"])
    for i in range(300):
        hub.publish({"space": "pay", "subject_id": f"doc-{i}", "acl": ["space:pay"]})
    assert q.qsize() == 256
