"""Offline catalogue checks: no database fixture or running browser required."""

import json
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parents[1]
FILES = sorted((ROOT / "designs").glob("*.json"))
STARTERS = [path for path in FILES if path.name.startswith("starter-")]
SCHEMA = json.loads((ROOT / "types/design.json").read_text())["schema"]


def elements(screen):
    for element in screen.get("elements", []):
        yield element
        yield from element.get("children", [])


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.stem)
def test_catalogue_schema_and_metadata(path):
    design = json.loads(path.read_text())
    jsonschema.validate(design, SCHEMA)
    assert design["template_kind"] == ("layout" if path in STARTERS else "system")
    assert len(design["description"]) > 20
    assert design["state"] == "approved"


@pytest.mark.parametrize("path", STARTERS, ids=lambda path: path.stem)
def test_starter_screen_bounds_and_container_content(path):
    design = json.loads(path.read_text())
    errors = []
    for screen in design["spec"]["screens"]:
        for element in screen["elements"]:
            label = f'{screen["id"]}/{element["id"]}'
            for coord, extent in (("x", "w"), ("y", "h")):
                if not 0 <= element[coord] <= screen[extent] - element[extent]:
                    errors.append(f"{label} exceeds screen {extent}")
            children = element.get("children", [])
            if not children:
                continue
            assert all("x" not in child and "y" not in child for child in children)
            # Match the renderer's border-box flex containers, including chrome.
            border_w = 2 if element["role"] in ("card", "list") else 0
            border_h = border_w or (1 if element["role"] in ("nav", "tabbar") else 0)
            inner = {"w": element["w"] - 2 * element.get("pad", 0) - border_w,
                     "h": element["h"] - 2 * element.get("pad", 0) - border_h}
            axis = "w" if element.get("layout") == "row" else "h"
            cross = "h" if axis == "w" else "w"
            used = sum(child[axis] for child in children)
            used += (len(children) - 1) * element.get("gap", 8)
            if used > inner[axis]:
                errors.append(f"{label} children need {used}{axis}, available {inner[axis]}")
            if any(child[cross] > inner[cross] for child in children):
                errors.append(f"{label} child exceeds inner {cross} ({inner[cross]})")
    assert not errors, "\n".join(errors)


@pytest.mark.parametrize("path", STARTERS, ids=lambda path: path.stem)
def test_starter_ids_citations_and_complete_prototype_flow(path):
    design = json.loads(path.read_text())
    screens = design["spec"]["screens"]
    ids = {screen["id"] for screen in screens}
    assert len(ids) == len(screens) >= 2
    links = {}
    for screen in screens:
        all_elements = list(elements(screen))
        assert len({element["id"] for element in all_elements}) == len(all_elements)
        links[screen["id"]] = {element["goto"] for element in all_elements if element.get("goto")}
        assert links[screen["id"]] <= ids
        for element in all_elements:
            assert element.get("cites") in design["spec"]["tokens"]
            assert element["role"] != "image", "Starters should not ship blank image placeholders"
            if element["role"] in ("list", "nav", "tabbar", "card"):
                assert element.get("children"), "Use editable content, not renderer placeholder rows"
    reachable = {screens[0]["id"]}
    while True:
        expanded = reachable | set().union(*(links[sid] for sid in reachable))
        if expanded == reachable:
            break
        reachable = expanded
    assert reachable == ids, "Every screen must be reachable from the opening screen"


def test_templates_load_even_into_a_database_seeded_before_they_existed():
    """The seed returns early once a workspace has its history. Templates loaded
    after that return never reached a database seeded before they were added —
    Docker's Designs tab said 'No starter layouts are available yet' with ten in
    the repo. They load before it, and idempotently."""
    from pathlib import Path

    src = (Path(__file__).resolve().parents[1] / "scripts" / "seed_dev.py").read_text()
    assert src.index('(ROOT / "designs").glob("*.json")') < src.index("already seeded; leave the history alone")
    assert "on conflict (id) do nothing" in src[src.index('(ROOT / "designs")'):]
