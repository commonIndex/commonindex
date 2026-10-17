"""Over MCP an agent gets a result it can act on — never a protocol failure.

Every read-only tool was called with nothing at all; four handlers read a
required field as `body["x"]` and raised, which reached the agent as an MCP
protocol error instead of a typed refusal, and `experiments.get` refused the
`id` its own schema asks for.
"""

from __future__ import annotations

from commonindex.gateway import mcp_server


async def test_an_unhandled_error_comes_back_as_a_typed_result():
    async def app(scope, receive, send):
        raise KeyError("connection_id")
    status, body = await mcp_server.call_asgi(app, "/api/v1/datasets.introspect", {})
    assert status == 500
    assert body["error"]["code"] == "internal" and "datasets.introspect" in body["error"]["message"]


def test_required_fields_are_refused_by_name():
    from commonindex.gateway.authoring import _need

    refused = _need({}, "connection_id")
    assert refused.status_code == 422 and b"connection_id is required" in refused.body
    assert _need({"connection_id": "c1"}, "connection_id") is None
