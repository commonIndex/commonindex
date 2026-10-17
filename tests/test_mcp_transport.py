"""The MCP transport: one dispatch path, and the context that goes with it.

Two properties are being defended. That an agent reaches exactly the surface a
person reaches — same handler, same validation, same typed errors — because a
second dispatch implementation is a second place for the two to drift, which is
the whole defect the parity tests exist to catch. And that a tool call is not
the only thing an agent gets: an agent that can call `experiments.readout` but
does not know a failed sample-ratio check invalidates the response will narrate
a confounded lift confidently.
"""

from __future__ import annotations

import json

import mcp.types as t
import pytest

from commonindex.core.ops import Op, Registry
from commonindex.gateway.mcp_server import SCHEME, build_server, call_asgi


async def handler(server, method, params=None):
    return await server.get_request_handler(method).handler(None, params)


# ── the in-process dispatch ─────────────────────────────────────────────


def stub_app(status: int, body: bytes, seen: dict | None = None):
    """A minimal ASGI app, so the dispatcher is tested without a database."""

    async def app(scope, receive, send):
        if seen is not None:
            seen["path"] = scope["path"]
            seen["method"] = scope["method"]
            chunks = b""
            while True:
                msg = await receive()
                if msg["type"] != "http.request":
                    break
                chunks += msg.get("body", b"")
                if not msg.get("more_body"):
                    break
            seen["body"] = chunks
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})

    return app


async def test_the_dispatcher_posts_the_arguments_to_the_operation_path():
    seen: dict = {}
    status, body = await call_asgi(
        stub_app(200, b'{"ok": true}', seen), "/api/v1/metrics.list", {"space_id": "pay"})

    assert status == 200 and body == {"ok": True}
    assert seen["method"] == "POST"
    assert seen["path"] == "/api/v1/metrics.list"
    assert json.loads(seen["body"]) == {"space_id": "pay"}


async def test_a_non_json_response_does_not_crash_the_transport():
    """A gateway that returns HTML on an unexpected error would otherwise take
    the whole MCP session down with a JSONDecodeError."""
    status, body = await call_asgi(stub_app(500, b"<html>boom</html>"), "/api/v1/x", {})
    assert status == 500
    assert body["error"]["code"] == "unparseable"
    assert "boom" in body["error"]["message"]


async def test_an_empty_response_body_is_not_an_error():
    status, body = await call_asgi(stub_app(204, b""), "/api/v1/x", {})
    assert status == 204 and body is None


# ── tools ───────────────────────────────────────────────────────────────


def registry_of(*names: str) -> Registry:
    reg = Registry()
    for n in names:
        reg.register(Op(name=n, relation="read", description=f"does {n}",
                        input_schema={"type": "object",
                                      "properties": {"space_id": {"type": "string"}}}))
    return reg


async def test_the_tool_list_is_the_operation_registry_exactly():
    """Not "roughly the same count" — the same names. Two emitters that agree
    on how many things exist and disagree about which is the failure mode this
    codebase already shipped once."""
    reg = registry_of("a.one", "b.two", "c.three")
    listed = await handler(build_server(stub_app(200, b"{}"), reg), "tools/list")

    assert {x.name for x in listed.tools} == {op.name for op in reg.all()}
    assert all(x.input_schema for x in listed.tools), "a tool with no schema is argument-less"
    assert all(x.description for x in listed.tools)


async def test_a_tool_call_reaches_the_gateway_at_the_operation_path():
    seen: dict = {}
    server = build_server(stub_app(200, b'{"metrics": []}', seen), registry_of("metrics.list"))
    out = await handler(server, "tools/call",
                        t.CallToolRequestParams(name="metrics.list", arguments={"space_id": "s"}))

    assert seen["path"] == "/api/v1/metrics.list"
    assert json.loads(seen["body"]) == {"space_id": "s"}
    assert out.is_error is False
    assert json.loads(out.content[0].text) == {"metrics": []}


async def test_a_code_answer_comes_back_as_markdown_with_the_diagram_drawn():
    """A JSON blob is not a readable answer, and the flow in it is not a visible
    diagram. The code operations render to markdown for exactly this hop — the
    client that shows the result is showing it to a person."""
    body = json.dumps({
        "answer": "Checkout posts to the orders handler.",
        "citations": ["example/storefront/app/checkout.py:L10-L48"],
        "model": "qwen2.5-coder:1.5b",
        "diagram": {"title": "Order placement",
                    "nodes": [{"id": "ui", "label": "Checkout", "kind": "ui"},
                              {"id": "db", "label": "orders", "kind": "store"}],
                    "edges": [{"from": "ui", "to": "db", "label": "insert"}]},
        "context": {"query": "how does order placement work", "context": [{}],
                    "selected_repos": [{"repo": "example/storefront"}],
                    "searched_repos": ["example/storefront"], "engine": "zoekt",
                    "routing": "searched 1 readable repository; 1 answered"},
    }).encode()
    server = build_server(stub_app(200, body), registry_of("code.ask"))
    out = await handler(server, "tools/call",
                        t.CallToolRequestParams(name="code.ask", arguments={"q": "x"}))

    text = out.content[0].text
    assert out.is_error is False
    assert text.startswith("# how does order placement work")
    assert "```mermaid\nflowchart TD" in text
    assert "example/storefront/app/checkout.py:L10-L48" in text


async def test_an_operation_with_no_markdown_rendering_still_answers_in_json():
    """The rendering is opt-in per operation. Everything else must keep the shape
    an agent already parses — a half-converted surface is worse than either."""
    server = build_server(stub_app(200, b'{"metrics": [{"id": "m"}]}'), registry_of("metrics.list"))
    out = await handler(server, "tools/call",
                        t.CallToolRequestParams(name="metrics.list", arguments={}))

    assert json.loads(out.content[0].text) == {"metrics": [{"id": "m"}]}


async def test_a_failed_code_call_keeps_its_typed_error_rather_than_being_prettified():
    """The code and the offending field are the actionable part of a failure.
    Markdown around them would only bury it, so an error is not rendered."""
    server = build_server(stub_app(422, b'{"error": {"code": "missing_query", "field": "q"}}'),
                          registry_of("code.search"))
    out = await handler(server, "tools/call",
                        t.CallToolRequestParams(name="code.search", arguments={}))

    assert out.is_error is True
    assert json.loads(out.content[0].text)["error"]["field"] == "q"


async def test_a_typed_error_survives_as_content_rather_than_being_erased():
    """The gateway answers a bad request with a code and the offending field so
    an agent can correct itself. Turning that into a protocol-level failure
    would throw away the only part it can act on."""
    body = b'{"error": {"code": "unratified_metric", "message": "no", "field": "metric_ids"}}'
    server = build_server(stub_app(422, body), registry_of("experiments.readout"))
    out = await handler(server, "tools/call",
                        t.CallToolRequestParams(name="experiments.readout", arguments={}))

    assert out.is_error is True
    payload = json.loads(out.content[0].text)
    assert payload["error"]["code"] == "unratified_metric"
    assert payload["error"]["field"] == "metric_ids"


async def test_an_unknown_tool_says_what_is_served_instead_of_failing_blankly():
    server = build_server(stub_app(200, b"{}"), registry_of("a.one", "b.two"))
    out = await handler(server, "tools/call",
                        t.CallToolRequestParams(name="does.not.exist", arguments={}))

    assert out.is_error is True
    assert "does.not.exist" in out.content[0].text
    assert "tools/list" in out.content[0].text


async def test_the_dispatcher_never_invents_a_path_for_an_unregistered_name():
    """Without the guard this would POST to /api/v1/<anything> and surface a
    bare 404 as though the operation existed and had failed."""
    seen: dict = {}
    server = build_server(stub_app(404, b'{"detail":"Not Found"}', seen), registry_of("a.one"))
    await handler(server, "tools/call",
                  t.CallToolRequestParams(name="../../etc/passwd", arguments={}))
    assert "path" not in seen, "an unregistered name must not reach the app at all"


# ── resources: the context, not just the tools ──────────────────────────


SKILL = json.dumps({"name": "warehouse-context", "files": {
    "SKILL.md": "# Warehouse context",
    "references/experiments.md": "# Experiments\n\nsrm first.",
    "references/public-orders.md": "# orders",
}}).encode()


async def test_the_generated_skill_is_published_as_resources():
    """An agent that can call the tools and does not know how to read a readout
    will report a confounded lift as a win. The context ships with the tools."""
    server = build_server(stub_app(200, SKILL), registry_of("context.skill"))
    listed = await handler(server, "resources/list")

    uris = {str(r.uri) for r in listed.resources}
    assert f"{SCHEME}SKILL.md" in uris
    assert f"{SCHEME}references/experiments.md" in uris
    assert all(r.description for r in listed.resources), "a bare filename is not a description"


async def test_a_resource_reads_back_its_contents():
    server = build_server(stub_app(200, SKILL), registry_of("context.skill"))
    out = await handler(server, "resources/read", t.ReadResourceRequestParams(
        uri=f"{SCHEME}references/experiments.md"))

    assert out.contents[0].text == "# Experiments\n\nsrm first."
    assert out.contents[0].mime_type == "text/markdown"


async def test_an_unknown_resource_lists_what_is_published():
    server = build_server(stub_app(200, SKILL), registry_of("context.skill"))
    out = await handler(server, "resources/read",
                        t.ReadResourceRequestParams(uri=f"{SCHEME}nope.md"))
    text = out.contents[0].text
    assert "no resource" in text and "SKILL.md" in text


async def test_a_gateway_that_cannot_generate_the_skill_lists_nothing_rather_than_failing():
    """Resources are context, not a dependency. A space with no datasets should
    still serve its tools."""
    server = build_server(stub_app(500, b"boom"), registry_of("context.skill"))
    listed = await handler(server, "resources/list")
    assert [str(resource.uri) for resource in listed.resources] == [
        f"{SCHEME}references/code-query.md"
    ]


async def test_the_server_carries_instructions_that_name_the_rules():
    server = build_server(stub_app(200, b"{}"), registry_of("a.one"))
    opts = server.create_initialization_options()
    assert opts.instructions
    assert "ratified" in opts.instructions
    assert "pre-registered" in opts.instructions


# ── the surfaces agree ──────────────────────────────────────────────────


def test_the_mcp_tools_are_the_apps_operations_and_all_have_routes():
    """The parity claim, from the MCP side: every tool an agent is offered is
    an operation this app actually serves."""
    from commonindex.gateway.app import REGISTRY, app

    served = set(app.openapi()["paths"])
    names = {op.name for op in REGISTRY.all()}
    missing = [n for n in names if f"/api/v1/{n}" not in served]
    assert not missing, f"tools offered with no route: {missing}"


@pytest.mark.parametrize("name", ["experiments.readout", "experiments.srm",
                                  "context.skill", "metrics.list"])
def test_the_operations_an_agent_needs_are_actually_offered(name):
    from commonindex.gateway.app import REGISTRY

    assert REGISTRY.get(name) is not None
