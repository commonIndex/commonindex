"""The platform from a terminal.

The command line names no operation: it reads the gateway's own listing, so
what it can do is what the registry serves. Defended here: a field is JSON when
it parses as JSON and text otherwise; a write gets an idempotency key unless
one is given; a missing field is named before anything is sent; help is built
from the operation's own schema; and a refusal is said in a line, exit 1.
"""

from __future__ import annotations

import json

import pytest

from commonindex import cli

OPS = [
    {"name": "search.query", "relation": "read", "mutating": False,
     "description": "Find anything. Every word must match.",
     "input_schema": {"type": "object", "required": ["q"],
                      "properties": {"q": {"type": "string"},
                                     "limit": {"type": "integer", "description": "How many."}}}},
    {"name": "docs.create", "relation": "propose", "mutating": True, "description": "Write a doc.",
     "input_schema": {"type": "object", "required": ["title", "idempotencyKey"],
                      "properties": {"title": {"type": "string"}, "idempotencyKey": {"type": "string"}}}},
]


@pytest.fixture
def gateway(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(cli, "CONFIG", tmp_path / "cli.json")

    def request(cfg, method, path, body=None):
        calls.append((method, path, body))
        if path == "/api/v1/_ops":
            return {"operations": OPS}
        if path == "/api/v1/docs.create" and body.get("title") == "":
            raise cli.CliError("422 empty_title (title): say what the doc is called")
        return {"ok": True, "echo": body}

    monkeypatch.setattr(cli, "_request", request)
    return calls


def test_fields_are_json_when_they_parse_and_text_otherwise():
    assert cli.parse_fields(["limit=5", "q=refund rate", "types=[\"doc\"]", "on=true"]) == {
        "limit": 5, "q": "refund rate", "types": ["doc"], "on": True}
    with pytest.raises(cli.CliError):
        cli.parse_fields(["nonsense"])


def test_a_call_sends_its_fields(gateway, capsys):
    assert cli.main(["search.query", "q=latency", "limit=2", "--compact"]) == 0
    assert gateway[-1] == ("POST", "/api/v1/search.query", {"q": "latency", "limit": 2})
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_a_write_gets_an_idempotency_key_unless_given(gateway):
    cli.main(["docs.create", "title=Runbook"])
    assert gateway[-1][2]["idempotencyKey"].startswith("cli-")
    cli.main(["docs.create", "title=Runbook", "idempotencyKey=mine"])
    assert gateway[-1][2]["idempotencyKey"] == "mine"


def test_a_missing_field_is_named_before_anything_is_sent(gateway, capsys):
    assert cli.main(["search.query", "limit=2"]) == 1
    assert "search.query needs q" in capsys.readouterr().err
    assert all(path != "/api/v1/search.query" for _, path, _ in gateway)


def test_help_comes_from_the_operation_s_own_schema(gateway, capsys):
    assert cli.main(["help", "search.query"]) == 0
    out = capsys.readouterr().out
    assert "q (required)  string" in out and "limit  integer — How many." in out


def test_a_refusal_is_one_line_and_exit_1(gateway, capsys):
    assert cli.main(["docs.create", "title="]) == 1
    assert capsys.readouterr().err.strip() == "commonindex: 422 empty_title (title): say what the doc is called"


def test_an_unknown_operation_suggests_its_neighbours(gateway, capsys):
    assert cli.main(["search.find", "q=x"]) == 1
    assert "did you mean search.query" in capsys.readouterr().err
