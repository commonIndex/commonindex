"""A gallery reads each design's first screen, not every screen of every one."""

from commonindex.gateway.collections import _preview_design


def _design(n, **over):
    return {"title": "D", "spec": {"tokens": {"color.bg": "#fff"},
                                   "screens": [{"id": f"s{i}", "name": f"Screen {i}"} for i in range(n)]}, **over}


def test_a_design_keeps_its_first_screen_and_says_what_else_there_is():
    d = _design(3)
    _preview_design(d)
    assert [s["id"] for s in d["spec"]["screens"]] == ["s0"]
    assert d["spec"]["tokens"] == {"color.bg": "#fff"}
    assert d["screen_count"] == 3 and d["screen_names"] == ["Screen 0", "Screen 1", "Screen 2"]


def test_a_template_stays_whole_for_the_picker():
    d = _design(4, template_kind="layout")
    _preview_design(d)
    assert len(d["spec"]["screens"]) == 4 and "screen_count" not in d
