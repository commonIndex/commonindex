"""A small agent: it reads its inbox, answers where it was asked, and files the
work it is handed.

This platform holds identity and tools, not a runtime. An agent is a process
somebody else runs, connecting with its own token — and until one connects,
every ask waits: a mention reads "asked, waiting", a handed task sits at
"Working". Nothing in the repository ever claimed an ask, so every one waited
forever. This is the reference agent: a loop over the same operations any
agent calls, over HTTP with its own token, so it is authorised, refused and
recorded exactly as a person is.

What it does with each ask in its inbox:

* claims it (`runs.start`) — one run per ask, so two runners never both answer;
* a mention: reads the thread and answers in it;
* a handed task: does the work as text on the task and files it for review,
  saying for each criterion whether the work meets it (`tasks.submit`) — or,
  when it needs a person, stops and asks on the task (`tasks.question`);
* a direct ask: answers in the comments on what it was about, or on its own
  page when it was about nothing in particular, naming whoever asked;
* says how it went (`runs.finish`). A model that fails is said where the
  answer would have gone, not swallowed: whoever is waiting learns there will
  not be one, and a handed task goes back to the board.

It writes with a model — the gateway's own OpenAI-compatible settings,
COMMONINDEX_LLM_BASE_URL, COMMONINDEX_LLM_MODEL and COMMONINDEX_LLM_API_KEY — and refuses
to start without one rather than answer with nothing behind it. A local model
works the same way: `make agent-run` reads .env.local, so the Qwen on this
machine (docs/local-model.md) is what it writes with, and every answer says
which model wrote it.

    make agent-run TOKEN=ci_...
    uv run python -m commonindex.reference_agent --token ci_... [--gateway http://localhost:8000]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from commonindex.core.retrieval.ask import Answer
from commonindex.core.retrieval.ask import ask as search_and_answer
from commonindex.gateway.llm import LlmUnavailable, OpenAICompatibleLlm


class Refused(RuntimeError):
    """The gateway said no: a code to act on, and why."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.status, self.code = status, code


class Gateway(Protocol):
    async def call(self, op: str, body: dict[str, Any]) -> dict[str, Any]: ...


class Model(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int = ...,
                       require_finished: bool = ...) -> str: ...


@dataclass
class HttpGateway:
    """The gateway over HTTP, as this agent — its token and nobody else's."""

    base_url: str
    token: str
    timeout: float = 30.0

    async def call(self, op: str, body: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(body).encode()
        headers = {"content-type": "application/json", "authorization": f"Bearer {self.token}"}

        def send() -> dict[str, Any]:
            request = Request(f"{self.base_url.rstrip('/')}/api/v1/{op}", data, headers,
                              method="POST")
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read() or b"{}")
            except HTTPError as error:
                try:
                    err = json.loads(error.read() or b"{}").get("error") or {}
                except ValueError:
                    err = {}
                raise Refused(error.code, err.get("code") or f"http_{error.code}",
                              err.get("message") or str(error)) from error
            except (URLError, TimeoutError) as error:
                raise Refused(0, "unreachable",
                              f"the gateway at {self.base_url} did not answer") from error

        return await asyncio.to_thread(send)


SYSTEM = """You are {name}, an agent in a shared workspace where people and agents \
work together: dashboards, docs, experiments, designs, tasks, and the conversations \
about them.

Answer what you were asked, where you were asked it, as a colleague would: plainly, \
briefly, to the person who asked. Use only what you are shown. Never invent a number, \
a result, a name or a link you were not given — if you need something you do not \
have, say exactly what, and who could give it to you. Do not @mention agents."""

#: A handed task comes back as JSON, so the work, the criteria and a question
#: arrive as separate things the gateway can check.
TASK_REPLY = """Do the work as text. Then reply with JSON only, nothing around it:
{"work": "the work itself, in markdown",
 "criteria_met": [true or false for each criterion above, in order — true only if the work you wrote meets it],
 "question": null, or the one thing a person must answer before the work can be done}"""


class GatewayTools:
    """The workspace's search and read, as this agent — what it may read and no more."""

    def __init__(self, gateway: Gateway) -> None:
        self._gateway = gateway

    async def search(self, q: str, **filters: Any) -> dict[str, Any]:
        return await self._gateway.call("search.query", {"q": q, "limit": 8, **filters})

    async def read(self, item_id: str) -> dict[str, Any] | None:
        try:
            return (await self._gateway.call("search.read", {"id": item_id}))["item"]
        except Refused as refused:
            if refused.status == 404:
                return None
            raise


def sourced(answer: Answer) -> str:
    """The answer, and under it what it rests on, by key and title."""
    if not answer.citations:
        return answer.text
    named = " · ".join(f"{c.get('key') or c.get('type')} {c.get('title') or ''}".strip()
                       for c in answer.citations)
    return f"{answer.text}\n\nSources: {named}"


#: How an answer says it came up empty. Matched rather than trusted to the
#: model: told to say "nothing I can see", a 9B model still wrote "the only
#: document in the workspace is…" about the 4 of 22 docs shared with it.
_EMPTY = re.compile(r"(can ?not|could ?n[o']t|unable to|did ?n[o']t) find|"
                    r"does not (say|contain|mention|have)|no (such|matching|relevant) |"
                    r"(nothing|no document|no doc)s? (in|on|about)|not found", re.IGNORECASE)


def scoped(text: str, visible: int | None) -> str:
    """An answer that found nothing, with what the agent could see said under
    it — as a fact the runner knows, not a sentence the model may soften."""
    if not _EMPTY.search(text):
        return text
    seen = f" ({visible} doc{'s' if visible != 1 else ''})" if visible is not None else ""
    return (f"{text}\n\nI can only see what is shared with me{seen}. If you mean a private "
            "doc, share it with the workspace and ask again.")


def _json_in(text: str) -> dict[str, Any]:
    """The first JSON object in a model's reply, or nothing."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        out = json.loads(text[start:end + 1])
    except ValueError:
        return {}
    return out if isinstance(out, dict) else {}


@dataclass
class Runner:
    gateway: Gateway
    model: Model
    me: dict[str, Any] = field(default_factory=dict)
    agents: set[str] = field(default_factory=set)

    async def introduce(self) -> None:
        """Who this is, and which handles are agents — so a reply never asks one."""
        self.me = await self.gateway.call("actors.me", {})
        if self.me.get("kind") != "agent":
            raise SystemExit(f"{self.me.get('id')!r} is not an agent — run this with an "
                             "agent's token")
        listed = await self.gateway.call("agents.list", {})
        self.agents = {a["id"] for a in listed.get("agents") or []}

    async def once(self) -> list[dict[str, Any]]:
        """Every ask in the inbox: claimed, answered, finished. What was done."""
        if not self.me:
            await self.introduce()
        inbox = await self.gateway.call("agents.inbox", {})
        done = []
        for ask in inbox.get("asks") or []:
            if (outcome := await self.handle(ask)) is not None:
                done.append(outcome)
        return done

    async def forever(self, every: float = 15.0) -> None:
        while True:
            try:
                for outcome in await self.once():
                    print(f"{self.me.get('id', '?')}: {outcome['kind']} (ask {outcome['seq']}): "
                          f"{outcome['status']}", flush=True)
            except Refused as refused:
                # A gateway restarting is a pause, not the end of the agent.
                print(f"the gateway did not answer: {refused}", file=sys.stderr, flush=True)
            await asyncio.sleep(every)

    async def handle(self, ask: dict[str, Any]) -> dict[str, Any] | None:
        try:
            run = await self.gateway.call("runs.start", {
                "trigger_seq": ask["seq"], "idempotencyKey": f"start:{ask['seq']}"})
        except Refused as refused:
            # Somebody else has it, or it was taken back: not this runner's.
            if refused.code in ("already_started", "withdrawn", "not_yours"):
                return None
            raise
        kind = ask.get("kind") or ("mention" if ask.get("thread") else "ask")
        try:
            if kind == "mention":
                status = await self.reply(ask)
            elif kind == "task":
                status = await self.work(ask)
            else:
                status = await self.answer(ask)
        except LlmUnavailable as failed:
            status = await self.cannot(ask, kind, f"I could not answer this — the model I write "
                                                  f"with did not respond ({failed}).")
        except Refused as refused:
            # The gateway said no midway — the task moved, a grant went. The run
            # ends blocked rather than reading as running forever.
            print(f"ask {ask['seq']}: {refused}", file=sys.stderr, flush=True)
            status = "blocked"
        await self.gateway.call("runs.finish", {
            "run_id": run["run_id"], "status": status, "idempotencyKey": f"finish:{run['run_id']}"})
        return {"seq": ask["seq"], "kind": kind, "run_id": run["run_id"], "status": status}

    # ── the three kinds of ask ────────────────────────────────────────────

    async def reply(self, ask: dict[str, Any]) -> str:
        """Answer a mention in the thread it was made in."""
        thread = ask["thread"]
        convo = await self.gateway.call("messages.list", {"subject_id": thread["subject_id"]})
        subject, root = convo["subject"], thread["parent_id"]
        said = [f"{m['author']['name']}: {m['body']}" for m in convo.get("messages") or []
                if not m.get("deleted") and root in (m["id"], m.get("parent_id"))]
        text = await self.scoped(sourced(await self.research(
            f"{ask['asked_by']} mentioned you in this conversation. Reply to the thread — "
            "search the workspace first if the answer is in it.",
            context=f"The conversation about {subject['type']} “{subject['title']}”:\n\n"
                    + "\n\n".join(said))))
        await self.post(thread["subject_id"], text, parent=root, key=f"reply:{ask['seq']}")
        return "done"

    async def work(self, ask: dict[str, Any]) -> str:
        """Do a handed task as text, and file it — or stop and ask a person."""
        task = (await self.gateway.call("tasks.get", {"task_id": ask["object"]["id"]}))["task"]
        criteria = [c["text"] for c in task.get("criteria") or []]
        convo = await self.gateway.call("messages.list", {"subject_id": task["id"]})
        said = [f"{m['author']['name']}: {m['body']}" for m in convo.get("messages") or []
                if not m.get("deleted")]
        # What the workspace already says about it, found the way a person
        # would find it — so the work starts from what is known.
        known = await self.research(
            f"What does this workspace already say that bears on {task['key']}: {task['title']}? "
            "Summarize it briefly with what you found, or say that it says nothing.", steps=4)
        prompt = (f"You were handed {task['key']}: {task['title']}\n\n"
                  + (f"{task['detail']}\n\n" if task.get("detail") else "")
                  + "Done means:\n" + "\n".join(f"{i + 1}. {c}" for i, c in enumerate(criteria))
                  + (f"\n\nWhat you were told when it was handed to you:\n{ask['note']}"
                     if ask.get("note") else "")
                  + ("\n\nThe conversation on the task so far:\n\n" + "\n\n".join(said)
                     if said else "")
                  + (f"\n\nWhat the workspace already says:\n{sourced(known)}" if known.text else "")
                  + "\n\n" + TASK_REPLY)
        plan = _json_in(await self.write(prompt, max_tokens=2400))
        question = str(plan.get("question") or "").strip()
        if question:
            await self.gateway.call("tasks.question", {
                "task_id": task["id"], "question": question, "if_rev": task["rev"],
                "idempotencyKey": f"question:{ask['seq']}"})
            return "asking"
        work = str(plan.get("work") or "").strip()
        if not work:
            return await self.cannot(ask, "task", "I could not do this: what I wrote came back in "
                                                  "a shape I could not file.")
        met = plan.get("criteria_met") if isinstance(plan.get("criteria_met"), list) else []
        # One true or false per criterion, as the gateway requires — and an
        # answer the model did not give is false: unchecked is not met.
        met = [met[i] is True if i < len(met) else False for i in range(len(criteria))]
        await self.post(task["id"], work, key=f"work:{ask['seq']}")
        await self.gateway.call("tasks.submit", {
            "task_id": task["id"], "if_rev": task["rev"], "criteria_met": met,
            "produced": {"label": "Written in the task's comments"},
            "idempotencyKey": f"submit:{ask['seq']}"})
        return "done"

    async def answer(self, ask: dict[str, Any]) -> str:
        """Answer a direct ask on what it was about — or on this agent's own
        page, when it was about nothing in particular — naming who asked."""
        about = ask.get("object")
        text = await self.scoped(sourced(await self.research(
            f"{ask['asked_by']} asked you: {ask.get('note') or '(no words — just your attention)'}"
            + (f"\n\nIt is about {about['type']} “{about['title']}”." if about else ""))))
        await self.post(about["id"] if about else self.me["id"], f"@{ask['asked_by']} {text}",
                        key=f"answer:{ask['seq']}")
        return "done"

    async def scoped(self, text: str) -> str:
        """`scoped`, with how many docs this agent can see counted now."""
        try:
            visible: int | None = len((await self.gateway.call("docs.list", {"limit": 500})).get("docs") or [])
        except Exception:  # noqa: BLE001 - the count is a courtesy; the answer goes out without it
            visible = None
        return scoped(text, visible)

    async def cannot(self, ask: dict[str, Any], kind: str, why: str) -> str:
        """Say, where the answer would have gone, that there will not be one."""
        if kind == "mention":
            await self.post(ask["thread"]["subject_id"], why, parent=ask["thread"]["parent_id"],
                            key=f"cannot:{ask['seq']}")
        elif kind == "task":
            await self.post(ask["object"]["id"], why, key=f"cannot:{ask['seq']}")
            # Back to the board, so a person can do it or hand it on.
            await self.gateway.call("tasks.release", {
                "task_id": ask["object"]["id"], "note": why,
                "idempotencyKey": f"release:{ask['seq']}"})
        else:
            about = ask.get("object")
            await self.post(about["id"] if about else self.me["id"], f"@{ask['asked_by']} {why}",
                            key=f"cannot:{ask['seq']}")
        return "blocked"

    # ── writing ───────────────────────────────────────────────────────────

    async def research(self, question: str, *, context: str | None = None,
                       steps: int = 5) -> Answer:
        """Search the workspace, read, search again, and answer from what was read."""
        name = self.me.get("display") or self.me.get("id") or "an agent"
        return await search_and_answer(question, self.model, GatewayTools(self.gateway), steps=steps,
                         context=context,
                         persona=f"You are {name}, an agent here. Write as a colleague would: "
                                 "plainly, briefly, to the person who asked. Do not @mention agents.")

    async def write(self, prompt: str, max_tokens: int = 900) -> str:
        name = self.me.get("display") or self.me.get("id") or "an agent"
        text = await self.model.complete(
            [{"role": "system", "content": SYSTEM.format(name=name)},
             {"role": "user", "content": prompt}], max_tokens=max_tokens)
        return (text or "").strip()

    async def post(self, subject_id: str, body: str, *, key: str,
                   parent: str | None = None) -> None:
        # A mention of an agent asks it, and two agents answering each other
        # would not stop. The name stays; the @ that would ask it goes.
        body = re.sub(r"@([A-Za-z0-9][\w.-]*)",
                      lambda m: m.group(1) if m.group(1) in self.agents else m.group(0), body)
        # Which model wrote it, said under it. A run records who answered and
        # when, not with what — and "is this the local Qwen or the cloud
        # model?" is the first thing anyone running their own asks.
        if written_with := getattr(self.model, "model", None):
            body = f"{body[:7800]}\n\n— written with {written_with}"
        await self.gateway.call("messages.post", {
            "subject_id": subject_id, "body": body[:7900], "idempotencyKey": key,
            **({"parent_id": parent} if parent else {})})


async def _ready(gateway_url: str, model: Model, agent: str, token: str | None,
                 *, mint: bool) -> Runner | None:
    """A runner for one agent, introduced — with a token kept on this machine,
    minted and kept the first time, and minted again once if the kept one has
    been revoked. None, with the reason printed, when it cannot run."""
    from commonindex import agent_tokens

    for attempt in range(2):
        if token is None and mint:
            try:
                token, held = await agent_tokens.mint(agent, label="local runner", agents_only=True)
            except LookupError as e:
                print(f"{agent}: {e}", file=sys.stderr, flush=True)
                return None
            where = agent_tokens.save(agent, token)
            print(f"{agent}: minted a token and kept it in {where} — "
                  f"{', '.join(held['grants']) or 'NO grants: it will be refused until it has one'}", flush=True)
        if token is None:
            print(f"{agent}: no token kept for it — run `make agent-run AGENT={agent}` once", file=sys.stderr)
            return None
        runner = Runner(HttpGateway(gateway_url, token), model)
        try:
            await runner.introduce()
            return runner
        except Refused as refused:
            if refused.status == 401 and mint and attempt == 0:
                print(f"{agent}: the kept token no longer works ({refused.code}) — minting a new one", flush=True)
                token = None
                continue
            print(f"{agent}: {refused}", file=sys.stderr, flush=True)
            return None
        except SystemExit as stop:
            print(f"{agent}: {stop}", file=sys.stderr, flush=True)
            return None
    return None


async def run_kept(gateway_url: str, model: Model, agents: dict[str, str | None], *,
                   every: float, once: bool, mint: bool) -> None:
    """Every agent named, side by side in one process."""
    runners = [r for r in await asyncio.gather(*(
        _ready(gateway_url, model, agent, token, mint=mint) for agent, token in agents.items())) if r]
    if not runners:
        sys.exit("no agent could start")
    names = ", ".join(r.me.get("id", "?") for r in runners)
    print(f"running {names} with {getattr(model, 'model', 'the model')} — "
          + ("reading inboxes once." if once else f"reading inboxes every {every:g}s. Ctrl-C stops."),
          flush=True)
    if once:
        for r in runners:
            for outcome in await r.once():
                print(f"{r.me.get('id')}: {outcome['kind']} (ask {outcome['seq']}): {outcome['status']}")
        return
    await asyncio.gather(*(r.forever(every) for r in runners))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--gateway", default=os.environ.get("COMMONINDEX_GATEWAY", "http://localhost:8000"))
    parser.add_argument("--token", default=os.environ.get("COMMONINDEX_AGENT_TOKEN"),
                        help="the agent's own token (or COMMONINDEX_AGENT_TOKEN)")
    parser.add_argument("--agent", action="append", default=[],
                        help="run this agent with the token kept on this machine, minting one the "
                             "first time (repeatable)")
    parser.add_argument("--all", action="store_true",
                        help="run every agent with a token kept on this machine")
    parser.add_argument("--every", type=float, default=15.0, help="seconds between inbox reads")
    parser.add_argument("--once", action="store_true", help="read the inbox once, then stop")
    args = parser.parse_args(argv)
    model = OpenAICompatibleLlm.from_env()
    if model is None:
        sys.exit("needs a model to write with: set COMMONINDEX_LLM_BASE_URL and COMMONINDEX_LLM_MODEL "
                 "(and COMMONINDEX_LLM_API_KEY) — the same settings the gateway's code query uses. "
                 "For the local Qwen, see docs/local-model.md.")
    if args.agent or args.all:
        from commonindex import agent_tokens

        agents: dict[str, str | None] = {a: agent_tokens.stored(a) for a in args.agent}
        if args.all:
            agents.update(agent_tokens.kept())
            if not agents:
                sys.exit(f"no agent tokens kept in {agent_tokens.token_dir()} — run one first: "
                         "make agent-run AGENT=<agent id>")
        asyncio.run(run_kept(args.gateway, model, agents, every=args.every, once=args.once,
                             mint=bool(args.agent)))
        return
    if not args.token:
        sys.exit("needs an agent: --agent <id> (a token is minted and kept for you), --all, "
                 "or --token / COMMONINDEX_AGENT_TOKEN.")
    runner = Runner(HttpGateway(args.gateway, args.token), model)
    if args.once:
        for outcome in asyncio.run(runner.once()):
            print(f"{outcome['kind']} (ask {outcome['seq']}): {outcome['status']}")
    else:
        asyncio.run(runner.forever(args.every))


if __name__ == "__main__":
    main()
