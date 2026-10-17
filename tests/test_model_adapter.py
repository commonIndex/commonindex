"""The structured model call over an OpenAI-compatible endpoint.

Defended: a design (or any structured object) can come from OpenAI, Ollama or
any server that speaks /chat/completions — the schema goes as a JSON-schema
response format, a configured reasoning effort is sent, a key is sent when
there is one, the object comes back parsed, and an answer cut off at the
ceiling is Truncated, not a JSON error about a missing brace.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest


@pytest.fixture
def server():
    state = {"seen": [], "headers": [], "reply": {"title": "Refund review"}, "finish": "stop", "fence": False}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            state["seen"].append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            state["headers"].append(dict(self.headers))
            text = json.dumps(state["reply"])
            if state["fence"]:
                text = f"```json\n{text}\n```"
            out = json.dumps({"choices": [{"message": {"content": text}, "finish_reason": state["finish"]}],
                              "usage": {"prompt_tokens": 12, "completion_tokens": 7}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *_):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}/v1", state
    srv.shutdown()


SCHEMA = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}


async def test_a_local_model_answers_with_the_object(server, monkeypatch):
    from commonindex.adapters.model import Provider, generate

    url, state = server
    monkeypatch.setenv("COMMONINDEX_MODEL_REASONING_EFFORT", "none")
    obj, usage = await generate(Provider(kind="local", api_key="", model="qwen3.5:9b", base_url=url),
                                system="You design screens.", prompt="a refund review screen", schema=SCHEMA, max_tokens=900)
    assert obj == {"title": "Refund review"}
    assert usage == {"input_tokens": 12, "output_tokens": 7, "model": "qwen3.5:9b"}
    sent = state["seen"][-1]
    assert sent["response_format"]["json_schema"]["schema"] == SCHEMA
    assert sent["reasoning_effort"] == "none" and sent["max_tokens"] == 900
    assert [m["role"] for m in sent["messages"]] == ["system", "user"]
    assert "authorization" not in {k.lower() for k in state["headers"][-1]}             # local: no key to send


async def test_a_key_is_sent_a_fence_is_tolerated_and_a_cut_off_answer_is_truncated(server, monkeypatch):
    from commonindex.adapters.model import Provider, Truncated, generate

    url, state = server
    monkeypatch.delenv("COMMONINDEX_MODEL_REASONING_EFFORT", raising=False)
    provider = Provider(kind="openai-compatible", api_key="sk-test", model="gpt-x", base_url=url)
    state["fence"] = True
    obj, _ = await generate(provider, system="s", prompt="p", schema=SCHEMA)
    assert obj == {"title": "Refund review"}
    assert {k.lower(): v for k, v in state["headers"][-1].items()}.get("authorization") == "Bearer sk-test"
    assert "reasoning_effort" not in state["seen"][-1]
    state["finish"] = "length"
    with pytest.raises(Truncated):
        await generate(provider, system="s", prompt="p", schema=SCHEMA)


def test_a_local_provider_needs_no_key_and_defaults_to_ollama(monkeypatch):
    from commonindex.adapters.model import LOCAL_BASE_URL, configured

    monkeypatch.setenv("COMMONINDEX_MODEL_PROVIDER", "local")
    monkeypatch.delenv("COMMONINDEX_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("COMMONINDEX_MODEL_BASE_URL", raising=False)
    monkeypatch.setenv("COMMONINDEX_MODEL_ID", "qwen3.5:9b")
    p = configured()
    assert (p.kind, p.model, p.base_url) == ("local", "qwen3.5:9b", None)
    assert LOCAL_BASE_URL == "http://localhost:11434/v1"


def test_a_named_local_host_may_be_private_and_nothing_else_is(monkeypatch):
    """From inside a container, host.docker.internal is the machine running
    Docker — a private address. A local provider may reach it only when the
    operator names it; metadata stays blocked whatever is named."""
    import socket

    from commonindex.adapters import model

    def resolve(host, *_):
        ip = {"host.docker.internal": "192.168.65.254", "intranet.example": "10.0.0.5",
              "metadata.local": "169.254.169.254"}[host]
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 0))]

    monkeypatch.setattr(model.socket, "getaddrinfo", resolve)
    with pytest.raises(model.Blocked):
        model.check_base_url("http://host.docker.internal:11434/v1", allow_loopback=True)
    model.check_base_url("http://host.docker.internal:11434/v1", allow_loopback=True,
                         private_hosts=("host.docker.internal",))
    with pytest.raises(model.Blocked):     # named, but not the host asked for
        model.check_base_url("http://intranet.example/v1", allow_loopback=True, private_hosts=("host.docker.internal",))
    with pytest.raises(model.Blocked):     # named, but link-local: never
        model.check_base_url("http://metadata.local/v1", allow_loopback=True, private_hosts=("metadata.local",))

    monkeypatch.setenv("COMMONINDEX_MODEL_PROVIDER", "local")
    monkeypatch.setenv("COMMONINDEX_MODEL_BASE_URL", "http://host.docker.internal:11434/v1")
    monkeypatch.delenv("COMMONINDEX_MODEL_LOCAL_HOSTS", raising=False)
    with pytest.raises(model.Blocked):
        model.configured()
    monkeypatch.setenv("COMMONINDEX_MODEL_LOCAL_HOSTS", "host.docker.internal")
    assert model.configured().base_url == "http://host.docker.internal:11434/v1"
