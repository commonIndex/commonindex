"""Provider-neutral answer synthesis for Code Query.

Any server exposing OpenAI-compatible chat completions works here: llama.cpp,
Ollama's compatible endpoint, vLLM, and hosted providers.  Keeping the HTTP
contract small avoids coupling code retrieval to a particular model SDK.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class LlmUnavailable(RuntimeError):
    pass


class LlmTruncated(LlmUnavailable):
    """The model stopped at the token ceiling. Distinguished for callers that
    apply the answer as a replacement: a cut-off rewrite of a document is the
    document with its end deleted, which is worse than no answer at all."""


@dataclass(frozen=True, slots=True)
class OpenAICompatibleLlm:
    base_url: str
    model: str
    api_key: str | None
    timeout_seconds: float = 45.0
    #: Sent as `reasoning_effort` when set. A thinking model (Qwen3.5 on
    #: Ollama, observed) otherwise spends its whole token budget on hidden
    #: reasoning and returns an empty answer cut off at the ceiling — `none`
    #: turns that off. Unset, nothing is sent, so providers that do not know
    #: the field never see it.
    reasoning_effort: str | None = None

    @classmethod
    def from_env(cls) -> OpenAICompatibleLlm | None:
        base_url = os.environ.get("COMMONINDEX_LLM_BASE_URL", "").rstrip("/")
        model = os.environ.get("COMMONINDEX_LLM_MODEL", "")
        if not base_url or not model:
            return None
        return cls(base_url, model, os.environ.get("COMMONINDEX_LLM_API_KEY"),
                   float(os.environ.get("COMMONINDEX_LLM_TIMEOUT_SECONDS", "45")),
                   os.environ.get("COMMONINDEX_LLM_REASONING_EFFORT") or None)

    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int = 1_800,
                       require_finished: bool = False,
                       response_schema: dict[str, Any] | None = None) -> str:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
        }
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        if response_schema is not None:
            # Opt-in only: existing prose callers keep their wire contract.
            # Like the design adapter, allow optional fields (strict mode
            # requires every property). Callers still validate the full output.
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "result", "schema": response_schema, "strict": False},
            }
        payload = json.dumps(body).encode()
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"

        def send() -> str:
            request = Request(f"{self.base_url}/chat/completions", payload, headers, method="POST")
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    data = json.loads(response.read())
            except HTTPError as error:
                raise LlmUnavailable(f"model endpoint returned HTTP {error.code}") from error
            except (URLError, TimeoutError) as error:
                # A slow model and a missing one need different fixes, so they
                # are told apart: a local model writing a whole page can run
                # past the limit while being perfectly reachable.
                if isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError):
                    raise LlmUnavailable(
                        f"the model took longer than {self.timeout_seconds:.0f} seconds to answer — ask for "
                        "something shorter, or raise COMMONINDEX_LLM_TIMEOUT_SECONDS") from error
                raise LlmUnavailable("model endpoint is unavailable") from error
            try:
                choice = data["choices"][0]
                content = choice["message"]["content"]
            except (KeyError, IndexError, TypeError) as error:
                raise LlmUnavailable("model endpoint returned no chat completion") from error
            if require_finished and choice.get("finish_reason") == "length":
                raise LlmTruncated(
                    f"the model reached its {max_tokens}-token ceiling before finishing")
            return content

        return await asyncio.to_thread(send)


#: The width of `chunks.embedding` (migration 0019). A model returning any
#: other length is refused at the first call rather than written, because a
#: vector of the wrong width is an insert error at best and, padded or cut to
#: fit, a silently meaningless similarity at worst.
EMBED_DIMS = 768


@dataclass(frozen=True, slots=True)
class OpenAICompatibleEmbedder:
    """`/embeddings` on any OpenAI-compatible server — Ollama's included.

    The prefixes exist because some models are trained with task markers:
    nomic-embed-text expects `search_document: ` on what is stored and
    `search_query: ` on what is asked, and scores noticeably worse without.
    They are configuration rather than code because they belong to the model.
    """

    base_url: str
    model: str
    api_key: str | None
    doc_prefix: str = ""
    query_prefix: str = ""
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls) -> OpenAICompatibleEmbedder | None:
        base_url = os.environ.get("COMMONINDEX_EMBED_BASE_URL", "").rstrip("/")
        model = os.environ.get("COMMONINDEX_EMBED_MODEL", "")
        if not base_url or not model:
            return None
        return cls(base_url, model, os.environ.get("COMMONINDEX_EMBED_API_KEY"),
                   os.environ.get("COMMONINDEX_EMBED_DOC_PREFIX", ""),
                   os.environ.get("COMMONINDEX_EMBED_QUERY_PREFIX", ""),
                   float(os.environ.get("COMMONINDEX_EMBED_TIMEOUT_SECONDS", "30")))

    async def embed(self, texts: list[str], *, query: bool = False) -> list[list[float]]:
        if not texts:
            return []
        prefix = self.query_prefix if query else self.doc_prefix
        payload = json.dumps({"model": self.model,
                              "input": [prefix + t for t in texts]}).encode()
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"

        def send() -> list[list[float]]:
            request = Request(f"{self.base_url}/embeddings", payload, headers, method="POST")
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    data = json.loads(response.read())
            except HTTPError as error:
                raise LlmUnavailable(f"embedding endpoint returned HTTP {error.code}") from error
            except (URLError, TimeoutError) as error:
                raise LlmUnavailable("embedding endpoint is unavailable") from error
            try:
                rows = sorted(data["data"], key=lambda r: r.get("index", 0))
                vectors = [[float(x) for x in r["embedding"]] for r in rows]
            except (KeyError, TypeError, ValueError) as error:
                raise LlmUnavailable("embedding endpoint returned no vectors") from error
            if len(vectors) != len(texts):
                raise LlmUnavailable(f"asked for {len(texts)} vectors, got {len(vectors)}")
            for v in vectors:
                if len(v) != EMBED_DIMS:
                    raise LlmUnavailable(
                        f"{self.model} returns {len(v)}-dimensional vectors and "
                        f"chunks.embedding holds {EMBED_DIMS}. Use a {EMBED_DIMS}-dim "
                        "model or migrate the column.")
            return vectors

        return await asyncio.to_thread(send)


def budget(llm) -> float:
    """How long a caller waits on a model call: the model's own configured
    timeout plus a margin, not a fixed two minutes. A local 9B model drafting
    a video took 126 seconds and was cut off at 120, while it was configured
    to be given 420 (COMMONINDEX_LLM_TIMEOUT_SECONDS / COMMONINDEX_MODEL_TIMEOUT_SECONDS)."""
    import os

    configured = getattr(llm, "timeout_seconds", None) if llm is not None else None
    if configured is None:
        try:
            configured = float(os.environ.get("COMMONINDEX_MODEL_TIMEOUT_SECONDS") or 120)
        except ValueError:
            configured = 120.0
    return float(configured) + 15.0
