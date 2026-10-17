"""Bring-your-own-key access to a language model.

The platform holds no model credential of its own. `DESIGN.md` §9 already says
so — "BYO keys per org" — and it is the same posture the agent work landed on:
this is a surface, not a runtime. What changes here is only that a single
request/response to a model is not a durable agent run. It has no lease, no
retry loop, no resumption and no tools; it is closer to `panels.preview`, which
compiles a query, runs it and returns rows, than to an agent that works for an
hour. That distinction is the whole licence for this module to exist.

Configuration is environment-first because a per-org credential belongs in
`connection_secrets` — which already does envelope encryption — and putting it
there means a migration, an op and a UI that cannot be tested until a key
exists. The shape below is the part that does not change when it moves.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlparse

#: Hostnames that never reach a model provider, whatever the config says. The
#: loopback names are separated because `allow_loopback` may relax THOSE and
#: nothing else — the first version gated the whole set on that flag, so a
#: local provider also unblocked the cloud metadata endpoint.
_LOOPBACK_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost"}
_NEVER = {"metadata.google.internal", "metadata.goog", "instance-data"}

#: Not private by `ipaddress`, but routed inside somebody's network all the
#: same: RFC 6598 carrier-grade NAT, which is what EKS and GKE pod networks and
#: Tailscale use.
_CGNAT = ipaddress.ip_network("100.64.0.0/10")

DEFAULT_MODEL = "claude-opus-5"


class Unconfigured(Exception):
    """No model provider is set up. Distinguished from a failed call, because
    the fix is different: one is an operator setting a variable, the other is a
    provider being down."""


class Truncated(Exception):
    """The answer stopped at the token ceiling, so the JSON is incomplete."""


class Blocked(Exception):
    """A base URL that must not be dialled."""


@dataclass(frozen=True, slots=True)
class Provider:
    kind: str           # "anthropic" | "openai-compatible" | "local"
    #: repr suppressed: a dataclass prints its fields, so one logging.exception
    #: touching a Provider would put the org's key in the log.
    api_key: str = field(repr=False)
    model: str = ""
    base_url: str | None = None


def configured() -> Provider:
    """Read the provider from the environment, or say precisely what is missing.

    An error that names the variable is the difference between an operator
    fixing this in a minute and filing a bug that says "AI does not work".
    """
    kind = (os.environ.get("COMMONINDEX_MODEL_PROVIDER") or "").strip().lower()
    if not kind:
        raise Unconfigured(
            "no model provider is configured. Set COMMONINDEX_MODEL_PROVIDER "
            "(anthropic | openai-compatible | local), COMMONINDEX_MODEL_API_KEY, and "
            "optionally COMMONINDEX_MODEL_ID and COMMONINDEX_MODEL_BASE_URL. The platform "
            "holds no key of its own: the org brings one.")
    if kind not in ("anthropic", "openai-compatible", "local"):
        raise Unconfigured(
            f"COMMONINDEX_MODEL_PROVIDER is {kind!r}; expected anthropic, "
            "openai-compatible or local")

    key = (os.environ.get("COMMONINDEX_MODEL_API_KEY") or "").strip()
    if not key and kind != "local":
        raise Unconfigured("COMMONINDEX_MODEL_API_KEY is empty")

    base = (os.environ.get("COMMONINDEX_MODEL_BASE_URL") or "").strip() or None
    if base:
        check_base_url(base, allow_loopback=kind == "local",
                       private_hosts=_local_hosts() if kind == "local" else ())
    return Provider(kind=kind, api_key=key, base_url=base,
                    model=(os.environ.get("COMMONINDEX_MODEL_ID") or DEFAULT_MODEL).strip())


def _local_hosts() -> tuple[str, ...]:
    """Hosts the operator has named as where a local model runs, though they
    resolve to a private address — `host.docker.internal`, from inside a
    container, is the machine running Docker. Named one by one, so a local
    provider does not open every private address to the gateway."""
    raw = os.environ.get("COMMONINDEX_MODEL_LOCAL_HOSTS") or ""
    return tuple(h.strip().lower() for h in raw.split(",") if h.strip())


def check_base_url(url: str, *, allow_loopback: bool = False,
                   private_hosts: tuple[str, ...] = ()) -> None:
    """Refuse a base URL that points back inside the network.

    A BYOK proxy that dials whatever it is handed is a confused deputy: the
    caller supplies the address and the gateway supplies the network position,
    so `169.254.169.254` reads cloud metadata with the platform's credentials
    rather than the caller's. Loopback is permitted only for an explicitly local
    provider, which is how a self-hosted model on the same box is meant to work.

    Honest limit: this checks the host as written and, when it resolves, the
    address it resolves to right now. A name that resolves differently between
    this check and the request is not covered — closing that needs the
    connection itself to be pinned, which belongs in the HTTP client.
    """
    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        raise Blocked(f"{u.scheme or url!r} is not an http(s) URL")
    if u.scheme == "http" and not allow_loopback:
        # The credential travels in a header. Cleartext to a public host hands
        # it to anything on the path.
        raise Blocked("a remote model provider must be https")
    host = (u.hostname or "").lower()
    if not host:
        raise Blocked("no host in the base URL")
    if host in _NEVER:
        raise Blocked(f"{host} is not a model provider")
    if host in _LOOPBACK_NAMES and not allow_loopback:
        raise Blocked(f"{host} is not a model provider")

    try:
        candidates = [str(ipaddress.ip_address(host))]
    except ValueError:
        try:
            candidates = [a[4][0] for a in socket.getaddrinfo(host, None)]
        except OSError as e:
            # Fail CLOSED. The first version set candidates = [] here and fell
            # out of the loop returning normally, so any host that did not
            # resolve at check time — a transient resolver failure, split-horizon
            # DNS, or an attacker-timed NXDOMAIN — was allowed outright, and the
            # SDK then resolved it independently.
            raise Blocked(f"{host} does not resolve, so it cannot be checked") from e

    if not candidates:
        raise Blocked(f"{host} resolved to no address")

    for addr in candidates:
        ip = ipaddress.ip_address(addr)
        mapped = ip.ipv4_mapped if getattr(ip, "ipv4_mapped", None) else ip
        if mapped.is_loopback and allow_loopback:
            continue
        # A host the operator named as their local model's, on a private
        # address — never a link-local one: 169.254.169.254 is the metadata
        # endpoint, and naming it does not make it a model.
        if (host in private_hosts and mapped.is_private and not mapped.is_link_local
                and not mapped.is_loopback):
            continue
        if (mapped.is_private or mapped.is_loopback or mapped.is_link_local
                or mapped.is_reserved or mapped.is_multicast or mapped.is_unspecified
                or (mapped.version == 4 and mapped in _CGNAT)):
            raise Blocked(
                f"{host} is inside the network. A model provider is an external "
                "service; set COMMONINDEX_MODEL_PROVIDER=local if you are genuinely "
                "running one on this host.")


class Generator(Protocol):
    """One structured call: a prompt in, an object matching `schema` out.

    A protocol rather than a function so tests can supply a generator that
    returns a canned object. Everything above this line is then covered without
    a key, a network or a bill — which is the only reason any of it is tested.
    """

    async def __call__(self, *, system: str, prompt: str, schema: dict[str, Any],
                       max_tokens: int = 8000) -> tuple[dict[str, Any], dict[str, int]]:
        ...


async def generate(provider: Provider, *, system: str, prompt: str,
                   schema: dict[str, Any], max_tokens: int = 32000,
                   ) -> tuple[dict[str, Any], dict[str, int]]:
    """Ask the model for an object that matches `schema`.

    Structured outputs make the response conform to the schema, which is what
    removes the "parse the model's markdown and hope" step every generative-UI
    tool otherwise has. It does NOT make the object true — the caller validates
    the result anyway, because a generator is not a place to put a constraint.
    """
    if provider.kind != "anthropic":
        return await _generate_openai(provider, system=system, prompt=prompt,
                                      schema=schema, max_tokens=max_tokens)
    try:
        import anthropic
    except ModuleNotFoundError as e:  # pragma: no cover - depends on the extra
        raise Unconfigured(
            "the anthropic SDK is not installed. It is an optional dependency: "
            "`uv sync --extra model`, which is declared in pyproject.") from e

    client = anthropic.AsyncAnthropic(
        api_key=provider.api_key,
        **({"base_url": provider.base_url} if provider.base_url else {}))
    # Streamed because a six-screen spec is several thousand tokens of JSON
    # before any thinking, and thinking is on by default. A non-streaming call
    # with a low ceiling returns TRUNCATED JSON, which surfaces to the caller as
    # a json.loads error about a missing delimiter — a message that says nothing
    # about the real cause.
    async with client.messages.stream(
        model=provider.model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    ) as stream:
        msg = await stream.get_final_message()

    if getattr(msg, "stop_reason", None) == "max_tokens":
        raise Truncated(
            f"the model reached the {max_tokens}-token ceiling before finishing "
            "the spec. Ask for fewer screens.")
    import json

    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    usage = {"input_tokens": getattr(msg.usage, "input_tokens", 0),
             "output_tokens": getattr(msg.usage, "output_tokens", 0),
             "model": provider.model}
    return json.loads(text), usage


#: Where a `local` provider is when no base URL is given: Ollama's
#: OpenAI-compatible endpoint, which is what docs/local-model.md sets up.
LOCAL_BASE_URL = "http://localhost:11434/v1"


async def _generate_openai(provider: Provider, *, system: str, prompt: str,
                           schema: dict[str, Any], max_tokens: int,
                           ) -> tuple[dict[str, Any], dict[str, int]]:
    """The same structured call over `/chat/completions` — OpenAI, or any
    server that speaks it (Ollama, vLLM, LM Studio). `response_format` with a
    JSON schema is what makes the answer conform, as `output_config` does for
    Anthropic; a server that cannot honour it says so with a 400.

    `COMMONINDEX_MODEL_REASONING_EFFORT=none` turns a thinking model's hidden
    reasoning off — Qwen3.5 on Ollama otherwise spends the budget on it — and
    `COMMONINDEX_MODEL_TIMEOUT_SECONDS` gives a slow local model room (a design is
    several thousand tokens of JSON).
    """
    import asyncio
    import json
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    base = (provider.base_url or (LOCAL_BASE_URL if provider.kind == "local" else "")).rstrip("/")
    if not base:
        raise Unconfigured("COMMONINDEX_MODEL_BASE_URL is needed for an openai-compatible provider")
    body: dict[str, Any] = {
        "model": provider.model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        # Not strict: strict mode rejects any schema with an optional property
        # or without additionalProperties: false, and the platform's schemas
        # have both. The caller validates the object regardless.
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "result", "schema": schema, "strict": False}},
    }
    if effort := (os.environ.get("COMMONINDEX_MODEL_REASONING_EFFORT") or "").strip():
        body["reasoning_effort"] = effort
    headers = {"content-type": "application/json"}
    if provider.api_key:
        headers["authorization"] = f"Bearer {provider.api_key}"
    timeout = float(os.environ.get("COMMONINDEX_MODEL_TIMEOUT_SECONDS") or 600)

    def send() -> dict[str, Any]:
        request = Request(f"{base}/chat/completions", json.dumps(body).encode(), headers, method="POST")
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except HTTPError as error:
            raise RuntimeError(f"model endpoint returned HTTP {error.code}") from error
        except (URLError, TimeoutError) as error:
            timed_out = isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError)
            why = f"the model took longer than {timeout:.0f} seconds" if timed_out else "model endpoint is unavailable"
            raise RuntimeError(why) from error

    data = await asyncio.to_thread(send)
    try:
        choice = data["choices"][0]
        text = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("model endpoint returned no chat completion") from error
    if choice.get("finish_reason") == "length":
        raise Truncated(
            f"the model reached the {max_tokens}-token ceiling before finishing "
            "the spec. Ask for fewer screens.")
    text = text.strip()
    # Some servers wrap the object in a fence despite the response format.
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    usage = data.get("usage") or {}
    return json.loads(text), {"input_tokens": usage.get("prompt_tokens", 0),
                              "output_tokens": usage.get("completion_tokens", 0),
                              "model": provider.model}
