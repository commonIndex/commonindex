"""Offline schema checks for inspector fields, including container children."""

import json
from pathlib import Path

import jsonschema
import pytest

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / "types/design.json").read_text())["schema"]


def design(fields, nested):
    element = {"id": "text", "role": "body", "text": "First line\nSecond line", **fields}
    if nested:
        element = {"id": "container", "role": "card", "children": [element]}
    return {"title": "Inspector", "surface": "web", "spec": {"screens": [
        {"id": "screen", "name": "Screen", "w": 1280, "h": 900, "elements": [element]}
    ]}}


@pytest.mark.parametrize("nested", [False, True])
def test_typography_round_trip(nested):
    fields = {"textStyle": "font.size.body", "fontSize": 24, "fontWeight": 680,
              "lineHeight": 1.6, "textAlign": "center"}
    payload = design(fields, nested)
    jsonschema.validate(json.loads(json.dumps(payload)), SCHEMA)
    jsonschema.validate(design({}, nested), SCHEMA)


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("fields", [
    {"fontSize": 0}, {"fontSize": 241}, {"fontSize": "24px"},
    {"fontWeight": 99}, {"fontWeight": 901}, {"fontWeight": 600.5},
    {"lineHeight": 0.7}, {"lineHeight": 3.1}, {"textAlign": "diagonal"},
    {"textStyle": 24},
])
def test_rejects_invalid_typography(fields, nested):
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(design(fields, nested), SCHEMA)


@pytest.mark.parametrize("nested", [False, True])
def test_a_shift_inside_a_container_round_trips(nested):
    # Arrow keys shift a row's child a few pixels without taking it out of the row.
    jsonschema.validate(design({"dx": -11, "dy": 2.5}, nested), SCHEMA)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(design({"dx": "4px"}, nested), SCHEMA)
