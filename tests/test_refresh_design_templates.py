"""Exercise the local refresh safety gate without touching a database."""

from copy import deepcopy

import pytest

from scripts.refresh_design_templates import ORIGINALS, decision, fingerprint


@pytest.fixture
def original(monkeypatch):
    props = {"title": "Starter · Example", "state": "approved", "cites": [],
             "surface": "web", "spec": {"screens": []}}
    monkeypatch.setitem(ORIGINALS, "example.json", fingerprint(props))
    return {"title": props["title"], "props": props, "deleted_at": None, "current_rev": 1}


def desired(original):
    return {**deepcopy(original["props"]), "template_kind": "layout",
            "description": "An improved starter", "spec": {"screens": [{"id": "new"}]}}


def test_only_known_exact_original_is_updated(original):
    assert decision("example.json", desired(original), [original]) == "update"
    assert decision("unknown.json", desired(original), [original]).startswith("skip:")


@pytest.mark.parametrize("change", ["deleted", "revised", "title", "spec", "description"])
def test_user_changes_are_never_overwritten(original, change):
    target = desired(original)
    if change == "deleted":
        original["deleted_at"] = "today"
    elif change == "revised":
        original["current_rev"] = 2
    elif change == "title":
        original["title"] = "My custom template"
    elif change == "spec":
        original["props"]["spec"]["screens"].append({"id": "custom"})
    else:
        original["props"]["description"] = "My own catalogue copy"
    assert decision("example.json", target, [original]).startswith("skip:")


def test_duplicate_matches_are_ambiguous(original):
    assert decision("example.json", desired(original), [original, original]) == "skip: ambiguous matches"


def test_rerun_is_unchanged_and_preserves_extra_props(original):
    target = desired(original)
    original.update(current_rev=2, props={**target, "sources": ["doc-1"]})
    assert decision("example.json", target, [original]) == "unchanged"


def test_missing_originals_are_not_recreated(original):
    assert decision("example.json", desired(original), []) == "skip: missing original"
    assert decision("starter-dashboard.json", desired(original), []) == "create"
    assert decision("starter-review.json", desired(original), []) == "create"
