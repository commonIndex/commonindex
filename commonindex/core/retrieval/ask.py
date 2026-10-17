"""Answer a question from the workspace by searching it the way a person would.

The model has two tools and a step budget. Each turn it asks for one thing:
search with some words (and filters), read an item a search turned up, or
answer. It learns the workspace's own words from what it reads and searches
again with them — which closes the gap between how a question is asked and
how its answer was written. That is the job embeddings would otherwise do; here
the model does it over a keyword index, searching and reading the way a
person would, instead of a vector database.

The protocol is JSON in plain text, not a provider's tool-calling API, so any
chat model behind an OpenAI-compatible endpoint can drive it. An answer may
cite only what the model actually saw: a citation it invents is dropped.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol

#: How much of one observation the model is shown. A long doc is read a
#: section at a time by searching again, not pasted whole.
OBSERVATION_CHARS = 6_000

SYSTEM = """You answer questions about this workspace — its docs, tasks, dashboards, \
experiments, designs, channels and the conversations about them — by searching it, \
the way a person would: search, read what looks relevant, learn the words this \
workspace actually uses, search again with them, and answer only from what you read.

Reply with exactly one JSON object each turn and nothing else:
  {{"search": "a few words", "types": [...], "author": "person id", "since": "YYYY-MM-DD", "within": "id"}}
      types, author, since and within are optional. types narrow it: dashboard, doc,
      experiment, design, task, channel, message, agent, code, metric, dataset, run —
      what agents were asked — and history, what things said before they were edited.
      within searches one conversation.
  {{"read": "an id from a search result"}}
      reading a dashboard also gives what its panels show now.
  {{"answer": "your answer in markdown, to the person who asked", "cite": ["id", ...]}}

Search with different words when a search finds nothing useful. Read before you \
answer. Cite every item your answer relies on, by the ids you saw. Never invent a \
fact, a number or a name. You see only what is shared with you, so when you find \
nothing, say that nothing YOU CAN SEE says it — and that something not shared with \
you would not show up — never that the workspace has no such thing. You have \
{steps} steps."""

LAST_STEP = ('That was your last step. Answer now, from what you have read, as '
             '{"answer": "…", "cite": ["id", …]}.')


class Tools(Protocol):
    async def search(self, q: str, **filters: Any) -> dict[str, Any]: ...

    async def read(self, item_id: str) -> dict[str, Any] | None: ...


class Model(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int = ...,
                       require_finished: bool = ...) -> str: ...


@dataclass(slots=True)
class Step:
    kind: str                 # search | read
    detail: str               # the words searched, or the id read
    found: int = 0            # results, or 1 when a read found the item
    label: str | None = None  # what was read, as a person would name it


@dataclass(slots=True)
class Answer:
    text: str
    citations: list[dict[str, Any]] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)


def action_in(text: str) -> dict[str, Any] | None:
    """The first JSON object in a reply, however much prose surrounds it."""
    start = text.find("{")
    while start >= 0:
        try:
            value, _ = json.JSONDecoder().raw_decode(text[start:])
            return value if isinstance(value, dict) else None
        except ValueError:
            start = text.find("{", start + 1)
    return None


def _clip(text: str) -> str:
    return text if len(text) <= OBSERVATION_CHARS else text[:OBSERVATION_CHARS] + "\n… (cut)"


def _label(item: dict[str, Any]) -> str:
    key = f" {item['key']}" if item.get("key") else ""
    return f"[{item.get('type', 'item')}{key}] {item.get('title') or ''}".strip()


def _name(item: dict[str, Any]) -> str:
    """What a person calls an item: its key and its title."""
    return " ".join(p for p in (item.get("key"), item.get("title")) if p) or item.get("type") or "item"


def _seen_from(hits: list[dict[str, Any]], seen: dict[str, dict[str, Any]]) -> None:
    for h in hits:
        if h.get("kind") == "message" and h.get("subject"):
            # A message is cited as the conversation it is in.
            seen.setdefault(h["id"], h["subject"])
            seen.setdefault(h["subject"]["id"], h["subject"])
        elif h.get("kind") == "run" and h.get("agent"):
            # A run is cited as the agent that ran it: that is its page.
            agent = {"id": h["agent"]["id"], "type": "agent", "key": None, "title": h["agent"]["name"]}
            seen.setdefault(h["id"], agent)
        elif h.get("id"):
            seen.setdefault(h["id"], {k: h.get(k) for k in ("id", "type", "key", "title")})


def search_note(q: str, result: dict[str, Any]) -> str:
    hits = result.get("hits") or []
    if not hits:
        return f'Nothing matched "{q}". Try other words — the ones this workspace uses.'
    lines = [f'{len(hits)} results for "{q}"{" (more exist: narrow it)" if result.get("more") else ""}:']
    for h in hits:
        snippet = (h.get("snippet") or "").replace("«", "").replace("»", "")
        kind, day = h.get("kind"), (h.get("at") or "")[:10]
        if kind == "message":
            s = h.get("subject") or {}
            who = (h.get("author") or {}).get("name", "someone")
            lines.append(f"- {h['id']} message by {who} in {_label(s)} ({day}), "
                         f"conversation id {s.get('id')}: {snippet}")
        elif kind == "code":
            first, last = h.get("lines") or [None, None]
            lines.append(f"- {h['id']} code {h.get('title')} in {h.get('repo') or 'a repository'}, "
                         f"lines {first}-{last}: {snippet}")
        elif kind == "run":
            asked = (h.get("asked_by") or {}).get("name")
            lines.append(f"- {h['id']} run by {h.get('title')} ({h.get('status')}, {day})"
                         + (f", asked by {asked}" if asked else "") + f": {snippet}")
        elif kind == "history":
            lines.append(f"- {h['id']} {_label(h)} said this until {day}, and no longer does: {snippet}")
        else:
            # A definition says where it is charted.
            on = ", ".join(d.get("title") or "" for d in h.get("used_on") or [])
            lines.append(f"- {h['id']} {_label(h)}" + (f" ({h['status']})" if h.get("status") else "")
                         + (f", charted on {on}" if on else "") + (f": {snippet}" if snippet else ""))
    return _clip("\n".join(lines))


def read_note(item_id: str, item: dict[str, Any] | None) -> str:
    if item is None:
        return f"No item {item_id!r} that you may read. Use an id from a search result."
    lines = [f"{_label(item)} (id {item['id']}), updated {(item.get('updated_at') or '')[:10]}"]
    for section in item.get("sections") or []:
        lines += [f"## {section.get('heading') or item.get('title')}", section.get("text") or ""]
    if item.get("comments"):
        lines.append("Conversation:")
        lines += [f"- {c['author']['name']} ({c['at'][:10]}): {c['text']}" for c in item["comments"]]
    if item.get("links"):
        lines.append("Linked:")
        lines += [f"- {link['rel']} {_label(link)} (id {link['id']})" for link in item["links"]]
    if item.get("history"):
        lines.append("What it said before its last edits:")
        lines += [f"- until {(h.get('until') or '')[:10]}, {h.get('heading') or 'text'}: {h.get('text')}"
                  for h in item["history"]]
    return _clip("\n".join(lines))


async def ask(question: str, model: Model, tools: Tools, *, steps: int = 6,
              context: str | None = None, persona: str | None = None) -> Answer:
    """Search, read and search again until the model answers, or its steps run out.
    `persona` goes ahead of the instructions — who is answering, in what voice."""
    system = (f"{persona}\n\n" if persona else "") + SYSTEM.format(steps=steps)
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": (f"{context}\n\n" if context else "") + question}]
    seen: dict[str, dict[str, Any]] = {}
    trail: list[Step] = []

    def answered(action: dict[str, Any]) -> Answer:
        cites, out = action.get("cite") or [], []
        for cid in cites if isinstance(cites, list) else []:
            item = seen.get(str(cid))
            if item and all(item.get("id") != o.get("id") for o in out):
                out.append(item)
        return Answer(str(action.get("answer") or "").strip(), out, trail)

    for _ in range(steps):
        reply = await model.complete(messages, max_tokens=900)
        action = action_in(reply)
        if action is None:
            # Prose instead of an action: that is its answer, uncited.
            return Answer(reply.strip(), [], trail)
        if "answer" in action:
            return answered(action)
        if action.get("search"):
            q = str(action["search"])[:200]
            filters = {k: action[k] for k in ("types", "author", "since", "within") if action.get(k)}
            result = await tools.search(q, **filters)
            _seen_from(result.get("hits") or [], seen)
            trail.append(Step("search", q, len(result.get("hits") or [])))
            note = search_note(q, result)
        elif action.get("read"):
            item_id = str(action["read"])
            item = await tools.read(item_id)
            if item is not None:
                seen.setdefault(item["id"], {k: item.get(k) for k in ("id", "type", "key", "title")})
            trail.append(Step("read", item_id, 1 if item else 0, _name(item) if item else None))
            note = read_note(item_id, item)
        else:
            note = 'Reply with one JSON object: {"search": …}, {"read": …} or {"answer": …, "cite": […]}.'
        messages += [{"role": "assistant", "content": reply}, {"role": "user", "content": note}]

    messages.append({"role": "user", "content": LAST_STEP})
    reply = await model.complete(messages, max_tokens=900)
    return answered(action_in(reply) or {"answer": reply})
