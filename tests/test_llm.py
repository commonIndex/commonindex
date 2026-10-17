"""What the gateway sends to an OpenAI-compatible model.

Defended: a reasoning effort, when configured, is sent as `reasoning_effort` —
a thinking model on Ollama otherwise spends its whole budget on hidden
reasoning and answers with nothing — and when it is not, the field is never
sent, so a provider that does not know it never sees it.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest


@pytest.fixture
def model_server():
    seen: list[dict] = []
    slow = {"seconds": 0.0}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            import time

            time.sleep(slow["seconds"])
            seen.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            body = json.dumps({"choices": [{"message": {"content": "Approved."}, "finish_reason": "stop"}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/v1", seen, slow
    server.shutdown()


async def test_reasoning_effort_is_sent_only_when_configured(model_server, monkeypatch):
    from commonindex.gateway.llm import OpenAICompatibleLlm

    url, seen, _ = model_server
    monkeypatch.setenv("COMMONINDEX_LLM_BASE_URL", url)
    monkeypatch.setenv("COMMONINDEX_LLM_MODEL", "qwen3.5:9b")
    monkeypatch.delenv("COMMONINDEX_LLM_REASONING_EFFORT", raising=False)
    assert await OpenAICompatibleLlm.from_env().complete([{"role": "user", "content": "hi"}]) == "Approved."
    assert "reasoning_effort" not in seen[-1]

    monkeypatch.setenv("COMMONINDEX_LLM_REASONING_EFFORT", "none")
    llm = OpenAICompatibleLlm.from_env()
    await llm.complete([{"role": "user", "content": "hi"}])
    assert seen[-1]["reasoning_effort"] == "none" and seen[-1]["model"] == "qwen3.5:9b"


async def test_a_slow_model_says_it_was_slow_not_missing(model_server):
    from commonindex.gateway.llm import LlmUnavailable, OpenAICompatibleLlm

    url, _, slow = model_server
    slow["seconds"] = 1.5
    with pytest.raises(LlmUnavailable, match="took longer than 1 seconds"):
        await OpenAICompatibleLlm(url, "qwen3.5:9b", None, timeout_seconds=1).complete([{"role": "user", "content": "hi"}])
    with pytest.raises(LlmUnavailable, match="is unavailable"):
        await OpenAICompatibleLlm("http://127.0.0.1:9/v1", "m", None, timeout_seconds=1).complete([{"role": "user", "content": "hi"}])


async def test_structured_output_is_opt_in_and_keeps_prose_calls_unchanged(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from commonindex.gateway import llm as adapter

    seen = []

    def reply(request, **kwargs):
        seen.append(json.loads(request.data))
        return nullcontext(SimpleNamespace(read=lambda: json.dumps({
            "choices": [{"message": {"content": '{"title":"Overview"}'}, "finish_reason": "stop"}]
        }).encode()))

    monkeypatch.setattr(adapter, "urlopen", reply)
    model = adapter.OpenAICompatibleLlm("https://example.invalid/v1", "test", None)
    schema = {"type": "object", "properties": {"title": {"type": "string"}}}
    messages = [{"role": "user", "content": "Return a title as JSON"}]
    await model.complete(messages, response_schema=schema, require_finished=True)
    assert seen[-1]["response_format"] == {
        "type": "json_schema", "json_schema": {"name": "result", "schema": schema, "strict": False}}
    await model.complete(messages)
    assert "response_format" not in seen[-1]
