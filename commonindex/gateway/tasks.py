"""The board: tasks, and the verbs that move them.

A task moves ready → in progress → in review → done, and only through a verb
that knows what the move means — who may make it, what it has to carry, and
who has to hear about it. A board that let any client write `state` was a
board where an agent could file its own work as done.

Two things make a board with agents on it different from a kanban board, and
both are enforced here rather than suggested:

* **An agent takes only a task whose definition of done is written down.** It
  checks its work against the criteria before filing, so without them there is
  nothing to check — `tasks.start` and `tasks.hand` refuse, and say so.
* **Work pools in review, in front of a person.** Agents do not procrastinate,
  so the constraint is the human who has to say yes. The one who did the work
  cannot accept it; an admin may accept their own only by saying why.

Handing a task to an agent is an `asked` event — the one `agents.ask` writes —
so it reaches the agent through `agents.inbox`, and the run it starts with
`runs.start` is the run the board shows. Nothing here runs an agent: this
platform holds identity, tools and the record, not a runtime.

Every step is a revision, with the author and a note, so a task's history reads
as one story — filed, handed over, asked, answered, filed for review, sent back,
accepted — and every mutation is idempotent on its key.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.gateway import sharing
from commonindex.gateway.collections import replayed
from commonindex.workers.indexer import index_object

router = APIRouter()

STATES = ("ready", "flight", "review", "done")
RELS = ("caused", "touches", "depends")
#: Written by the verbs, never by a create or an edit. Refused rather than
#: ignored, so a caller learns which verb it wanted.
SERVER_MANAGED = ("state", "assignee", "moved_at", "question", "produced", "review", "ask_seq")
MAX_CRITERIA = 12
MAX_TEXT = 4000
KEEP_REVISIONS = 200


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def _now() -> datetime:
    return datetime.now(tz=UTC)


def _props(row) -> dict[str, Any]:
    p = row["props"]
    return dict(json.loads(p) if isinstance(p, str) else (p or {}))


def _text(value: Any, limit: int = MAX_TEXT) -> str | None:
    """Trimmed text, or None for nothing. Over the limit is the caller's error."""
    if value is None:
        return None
    s = str(value).strip()
    return s[:limit] if s else None


_TYPE = None


def _task_type():
    global _TYPE
    if _TYPE is None:
        from commonindex.core.registry.types import load_dir

        root = Path(__file__).resolve().parent.parent.parent / "types"
        _TYPE = next(t for t in load_dir(root) if t.id == "task")
    return _TYPE


# ── reading ───────────────────────────────────────────────────────────────


async def _task(conn, task_id: str, space: str):
    return await conn.fetchrow(
        "select id, key, title, props, current_rev, created_by, created_at, updated_at"
        "  from objects where id = $1 and space_id = $2 and type = 'task'"
        "   and deleted_at is null", task_id, space)


def agent_ready(p: dict[str, Any]) -> str | None:
    """Why no agent may take this task, or None when one may."""
    if p.get("human_only"):
        return f"it needs a person: {p['human_only']}"
    if not p.get("criteria"):
        return ("it has no definition of done — an agent checks its work against it "
                "before filing, so without one there is nothing to check")
    return None


async def _holds(req: Request, conn, actor: str, relation: str, space: str) -> bool:
    from commonindex.core.authz import Denied
    from commonindex.core.authz.store import PgChecker

    checker = req.app.state.commonindex.get("checker") or PgChecker(conn)
    try:
        await checker.require(actor, relation, f"space:{space}")
        return True
    except Denied:
        return False


async def _caller(req: Request, conn, actor: str, space: str) -> dict[str, Any]:
    row = await conn.fetchrow("select display, kind from actors where id = $1", actor)
    return {"id": actor, "name": row["display"] if row else actor,
            "kind": row["kind"] if row else "human",
            "may": {rel: await _holds(req, conn, actor, rel, space)
                    for rel in ("propose", "merge", "admin")}}


def _you(task: dict[str, Any], me: dict[str, Any]) -> dict[str, bool]:
    """What the caller may do to this task, from the same rules the verbs apply —
    so a page offers only what the gateway would accept."""
    may, state = me["may"], task["state"]
    own = (task.get("assignee") or {}).get("id") == me["id"]
    asked_by = ((task.get("question") or {}).get("by") or {}).get("id")
    ready_for_agents = task["agent_ready"]
    return {
        "own": own,
        "may_start": state == "ready" and may["propose"]
                     and (me["kind"] != "agent" or ready_for_agents),
        "may_hand": state == "ready" and may["propose"] and ready_for_agents,
        # Ready: anyone who can work here says who it is for. In progress: it
        # changes hands only from the one working it, or someone who can merge.
        "may_assign": may["propose"] and (state == "ready" or (state == "flight" and (own or may["merge"]))),
        "may_release": state == "flight" and may["propose"] and (own or may["merge"]),
        "may_submit": state == "flight" and may["propose"] and own,
        "may_accept": state == "review" and may["merge"] and not own,
        "may_self_accept": state == "review" and own and may["admin"],
        "may_send_back": state == "review" and may["merge"],
        "may_ask": state == "flight" and own and may["propose"] and not task.get("question"),
        "may_answer": bool(task.get("question")) and may["propose"] and asked_by != me["id"],
        "may_edit": state in ("ready", "flight") and may["propose"],
        "may_delete": may["propose"] and (task["created_by"]["id"] == me["id"] or may["merge"]),
    }


async def _present_many(conn, space: str, rows, keys: list[str]) -> list[dict[str, Any]]:
    """Tasks as a page reads them: people by name, links resolved, the agent's run
    joined in, and how long each has sat where it is.

    `keys` are the reader's permission keys. Tasks are the workspace's, but what
    one links to may be private: a link the reader cannot open says only that
    it is there, never the item's title — which would otherwise be read off any
    task by everyone on the board."""
    if not rows:
        return []
    props = {r["id"]: _props(r) for r in rows}
    ids = [r["id"] for r in rows]

    people: set[str] = {r["created_by"] for r in rows}
    for p in props.values():
        people |= {p.get("assignee"), (p.get("question") or {}).get("by"),
                   (p.get("review") or {}).get("submitted_by"),
                   (p.get("review") or {}).get("decided_by")}
    names = {a["id"]: {"id": a["id"], "name": a["display"], "kind": a["kind"]}
             for a in await conn.fetch(
                 "select id, display, kind from actors where id = any($1::text[])",
                 [x for x in people if x])}

    def who(actor_id):
        if not actor_id:
            return None
        return names.get(actor_id) or {"id": actor_id, "name": actor_id, "kind": "human"}

    links: dict[str, list] = {}
    for e in await conn.fetch(
        "select e.src, e.rel, o.id, o.type, o.key, o.title, o.acl_keys && $3::text[] as visible"
        "  from edges e join objects o on o.id = e.dst"
        " where e.src = any($1::text[]) and e.rel = any($2::text[])"
        "   and o.deleted_at is null order by e.created_at, o.id", ids, list(RELS), keys):
        links.setdefault(e["src"], []).append(
            {"rel": e["rel"], "object": {"id": e["id"], "type": e["type"],
                                         "key": e["key"], "title": e["title"]} if e["visible"]
             else {"id": e["id"], "type": e["type"], "key": None, "title": None, "available": False}})

    # The projects each is in, for the chips on its card and the board's filter.
    projects: dict[str, list] = {}
    for e in await conn.fetch(
        "select e.src, p.id, p.key, p.title, p.props from edges e"
        "  join objects p on p.id = e.dst and p.type = 'project' and p.deleted_at is null"
        " where e.src = any($1::text[]) and e.rel = 'in_project' order by p.title", ids):
        pp = _props(e)
        projects.setdefault(e["src"], []).append(
            {"id": e["id"], "key": e["key"], "title": pp.get("title") or e["title"],
             "color": pp.get("color") or "blue", "status": pp.get("status") or "active"})

    seqs = [p["ask_seq"] for p in props.values() if p.get("ask_seq") is not None]
    runs = {r["trigger_seq"]: r for r in await conn.fetch(
        "select id, trigger_seq, status, started_at, ended_at, cost_usd, cost_tokens"
        "  from runs where space_id = $1 and trigger_seq = any($2::bigint[])",
        space, seqs)} if seqs else {}

    now = _now()
    out = []
    for r in rows:
        p = props[r["id"]]
        moved = p.get("moved_at")
        moved_at = datetime.fromisoformat(moved) if moved else r["updated_at"]
        run = runs.get(p.get("ask_seq")) if p.get("ask_seq") is not None else None
        assignee = who(p.get("assignee"))
        q = p.get("question")
        review = dict(p.get("review") or {}) or None
        if review:
            review["submitted_by"] = who(review.get("submitted_by"))
            review["decided_by"] = who(review.get("decided_by"))
        not_ready = agent_ready(p)
        out.append({
            "id": r["id"], "key": r["key"], "title": p.get("title") or r["title"],
            "detail": p.get("detail"), "state": p.get("state") or "ready",
            "origin": p.get("origin") or "filed",
            "criteria": [{"text": c.get("text"), "met": c.get("met")}
                         for c in p.get("criteria") or []],
            "human_only": p.get("human_only"),
            "agent_ready": not_ready is None, "not_agent_ready": not_ready,
            "assignee": assignee,
            "created_by": who(r["created_by"]),
            "created_at": r["created_at"].isoformat(),
            "moved_at": moved_at.isoformat(),
            "in_state_s": max(0, int((now - moved_at).total_seconds())),
            "question": {"text": q.get("text"), "by": who(q.get("by")), "at": q.get("at")}
                        if q else None,
            "produced": p.get("produced"),
            "review": review,
            # Asked and not yet picked up: the agent reads its inbox when it next
            # connects, and until then the honest status is "waiting for it".
            "asked": bool(assignee and assignee["kind"] == "agent"
                          and p.get("ask_seq") is not None and run is None),
            "run": {"id": run["id"], "status": run["status"],
                    "started_at": run["started_at"].isoformat(),
                    "ended_at": run["ended_at"].isoformat() if run["ended_at"] else None,
                    "seconds": int(((run["ended_at"] or now) - run["started_at"]).total_seconds()),
                    "cost_usd": float(run["cost_usd"] or 0),
                    "cost_tokens": int(run["cost_tokens"] or 0)} if run else None,
            "links": links.get(r["id"], []),
            "projects": projects.get(r["id"], []),
            "rev": r["current_rev"],
            "updated_at": r["updated_at"].isoformat(),
        })
    return out


async def _presented(req: Request, conn, space: str, actor: str, task_id: str):
    row = await _task(conn, task_id, space)
    task = (await _present_many(conn, space, [row], await sharing.keys(req, conn)))[0]
    task["you"] = _you(task, await _caller(req, conn, actor, space))
    return task


@router.post("/api/v1/tasks.list")
async def tasks_list(req: Request):
    """The board: every task in the space, with what each column needs to say —
    how long review has waited, which agent runs are live, who is asking."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json() if await req.body() else {}
    space, actor = space_of(req, body), actor_of(req)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select id, key, title, props, current_rev, created_by, created_at, updated_at"
            "  from objects where space_id = $1 and type = 'task' and deleted_at is null"
            " order by updated_at desc, id limit 500", space)
        every = await _present_many(conn, space, rows, await sharing.keys(req, conn))
        me = await _caller(req, conn, actor, space)

    for t in every:
        t["you"] = _you(t, me)
    shown = every
    for facet in ("state", "origin"):
        if body.get(facet):
            shown = [t for t in shown if t[facet] == body[facet]]
    if body.get("assignee"):
        shown = [t for t in shown if (t["assignee"] or {}).get("id") == body["assignee"]]
    return {
        "tasks": shown, "total": len(shown),
        "counts": {s: sum(1 for t in every if t["state"] == s) for s in STATES},
        # The number the board exists to show: the oldest thing waiting on a person.
        "review_oldest_s": max((t["in_state_s"] for t in every if t["state"] == "review"),
                               default=0),
        "running": sum(1 for t in every if t["run"] and t["run"]["status"] == "running"),
        "asking": sum(1 for t in every if t["question"]),
        "you": me,
    }


@router.post("/api/v1/tasks.linked")
async def tasks_linked(req: Request):
    """The tasks linked to one object, newest first, each with how it is linked."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    object_id = str(body.get("object_id") or "").strip()
    if not object_id:
        return _error(422, "no_object", "say which object's tasks to read", "object_id")
    # The work on an item is read from the item's page, by someone who can see it.
    if refused := await sharing.guard(req, object_id, space, "view", "object_id"):
        return refused
    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select o.id, o.key, o.title, o.props, o.current_rev, o.created_by, o.created_at,"
            "       o.updated_at, e.rel"
            "  from edges e join objects o on o.id = e.src"
            " where e.dst = $1 and e.rel = any($2::text[]) and o.type = 'task'"
            "   and o.space_id = $3 and o.deleted_at is null"
            " order by o.updated_at desc, o.id limit 100", object_id, list(RELS), space)
        # One task can be linked twice (it came from this and touches it): once here.
        rels: dict[str, list[str]] = {}
        for r in rows:
            rels.setdefault(r["id"], []).append(r["rel"])
        unique = list({r["id"]: r for r in rows}.values())
        tasks = await _present_many(conn, space, unique, await sharing.keys(req, conn))
        me = await _caller(req, conn, actor, space)
    for t in tasks:
        t["you"] = _you(t, me)
        t["rel"] = rels[t["id"]]
    return {"object_id": object_id, "tasks": tasks, "total": len(tasks)}


@router.post("/api/v1/tasks.get")
async def tasks_get(req: Request):
    """One task with its history, and which agents could take it and why — the
    evidence either way, so a refusal says what is missing."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    task_id = (body.get("task_id") or body.get("id") or "").strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _task(conn, task_id, space)
        if row is None:
            return _error(404, "unknown_task", f"no task {task_id!r}", "task_id")
        task = (await _present_many(conn, space, [row], await sharing.keys(req, conn)))[0]
        task["you"] = _you(task, await _caller(req, conn, actor, space))
        task["history"] = await _history(conn, task_id)
        task["routes"] = await _routes(req, conn, space, task)
    return {"task": task}


async def _history(conn, task_id: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "select r.rev, r.author_id, r.delta, r.ts, a.display, a.kind from revisions r"
        "  left join actors a on a.id = r.author_id"
        " where r.object_id = $1 order by r.rev desc limit 60", task_id)
    out = []
    for r in rows:
        d = json.loads(r["delta"]) if isinstance(r["delta"], str) else dict(r["delta"])
        entry = {"rev": r["rev"], "kind": d.get("kind") or "edit", "note": d.get("note"),
                 "by": {"id": r["author_id"], "name": r["display"] or r["author_id"],
                        "kind": r["kind"] or "human"},
                 "at": r["ts"].isoformat()}
        for extra in ("to", "rel", "object", "question"):
            if d.get(extra) is not None:
                entry[extra] = d[extra]
        out.append(entry)
    return out


async def _routes(req: Request, conn, space: str, task: dict[str, Any]) -> list[dict]:
    """Which agents could take this, and the evidence. Not a dropdown of names:
    whether an agent may file work here is a grant, and how its work has gone is
    in the record."""
    agents = await conn.fetch(
        "select id, display, trust_tier from actors where kind = 'agent' order by display, id")
    record: dict[str, dict[str, int]] = {}
    for r in await conn.fetch(
        "select r.delta->'props'->>'assignee' as agent, r.delta->>'kind' as kind,"
        "       count(*) as n"
        "  from revisions r join objects o on o.id = r.object_id"
        " where o.space_id = $1 and o.type = 'task'"
        "   and r.delta->>'kind' in ('accept', 'send_back')"
        " group by 1, 2", space):
        record.setdefault(r["agent"], {})[r["kind"]] = int(r["n"])

    out = []
    for a in agents:
        files = await _holds(req, conn, a["id"], "propose", space)
        reads = files or await _holds(req, conn, a["id"], "read", space)
        seen = record.get(a["id"], {})
        done, back = seen.get("accept", 0), seen.get("send_back", 0)
        if files:
            why = (f"{done} accepted, {back} sent back on this board" if done or back
                   else "may file work here; no tasks on this board yet")
        elif reads:
            why = "may only read in this space, so it could not file the work"
        else:
            why = "holds no grant in this space"
        out.append({"agent": {"id": a["id"], "name": a["display"], "kind": "agent"},
                    "can": files and task["agent_ready"], "why": why,
                    "needs": None if files else "propose",
                    "accepted": done, "sent_back": back})
    # Those that could take it first; the rest keep their evidence.
    return sorted(out, key=lambda r: (not r["can"], r["needs"] is not None))


# ── writing ───────────────────────────────────────────────────────────────


async def _begin(req: Request):
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    if not str(body.get("idempotencyKey") or "").strip():
        return None, None, None, _error(
            422, "missing_idempotency_key",
            "a mutation needs an idempotency key so a retry after a timeout does not "
            "write twice", "idempotencyKey")
    return body, space_of(req, body), actor_of(req), None


def _moved(row, body) -> JSONResponse | None:
    at = int(row["current_rev"] or 1)
    want = body.get("if_rev")
    if want is not None and int(want) != at:
        return _error(409, "stale_revision",
                      f"this task is at rev {at} and you last read rev {want} — it "
                      "moved. Re-read it first.", "if_rev")
    return None


async def _replayed(conn, task_id: str, key: str) -> int | None:
    """The revision this key already wrote, if it did. Every verb checks it
    first, so a retry after a timeout answers instead of refusing a move that
    already happened."""
    return await replayed(conn, task_id, key)


async def _step(conn, row, props: dict[str, Any], actor: str, kind: str,
                note: str | None, key: str, **extra) -> int:
    """One step, one revision — the history is the record of how it moved."""
    rev = int(row["current_rev"] or 1) + 1
    await conn.execute(
        "insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
        row["id"], rev, actor,
        json.dumps({"props": props, "kind": kind, "note": note, "key": key,
                    **{k: v for k, v in extra.items() if v is not None}}))
    await conn.execute(
        "update objects set props = $2::jsonb, title = $3, current_rev = $4,"
        " updated_at = now() where id = $1",
        row["id"], json.dumps(props), props.get("title") or row["title"], rev)
    await index_object(conn, row["id"])
    await conn.execute(
        "delete from revisions where object_id = $1 and rev < ("
        "  select rev from revisions where object_id = $1"
        "   order by rev desc offset $2 limit 1)", row["id"], KEEP_REVISIONS - 1)
    return rev


async def _ask(conn, space: str, actor: str, agent: str, task_id: str, note: str,
               key: str) -> int:
    """An `asked` event for the agent — the record `agents.inbox` reads."""
    from commonindex.gateway.agents import _next_seq

    await conn.execute(
        "insert into space_seq (space_id) values ($1) on conflict (space_id) do nothing", space)
    seq = await _next_seq(conn, space)
    await conn.execute(
        "insert into events (space_id, seq, actor_id, verb, object_id, payload)"
        " values ($1,$2,$3,'asked',$4,$5::jsonb)",
        space, seq, actor, task_id, json.dumps({"agent": agent, "note": note, "key": key}))
    return seq


async def _withdraw(conn, space: str, actor: str, task_id: str, seq: int | None,
                    why: str) -> None:
    """Take back an ask the agent has not started, so it leaves its inbox.

    A `withdrawn` event rather than a deletion — the log is append-only. An ask
    already started is left alone: the run is the agent's, and a submit from a
    task it no longer holds is refused on its own terms.
    """
    if seq is None or await conn.fetchval(
            "select 1 from runs where space_id = $1 and trigger_seq = $2", space, seq):
        return
    from commonindex.gateway.agents import _next_seq

    await conn.execute(
        "insert into space_seq (space_id) values ($1) on conflict (space_id) do nothing", space)
    n = await _next_seq(conn, space)
    await conn.execute(
        "insert into events (space_id, seq, actor_id, verb, object_id, payload)"
        " values ($1,$2,$3,'withdrawn',$4,$5::jsonb)",
        space, n, actor, task_id, json.dumps({"ask": seq, "why": why}))


def _criteria_in(value: Any) -> tuple[list[str], JSONResponse | None]:
    """A definition of done, from strings or {text} objects — trimmed, blank lines
    dropped, a repeated check kept once."""
    if value is None:
        return [], None
    if not isinstance(value, list):
        return [], _error(422, "bad_criteria", "criteria is a list of checks", "criteria")
    out: list[str] = []
    for item in value:
        text = _text(item.get("text") if isinstance(item, dict) else item, 300)
        if text and text not in out:
            out.append(text)
    if len(out) > MAX_CRITERIA:
        return [], _error(422, "too_many_criteria",
                          f"{len(out)} checks is a task that wants splitting — keep it to "
                          f"{MAX_CRITERIA}", "criteria")
    return out, None


def _governed(body: dict[str, Any]) -> JSONResponse | None:
    for f in SERVER_MANAGED:
        if body.get(f) is not None:
            return _error(422, "governed_field",
                          f"`{f}` is set by the verbs, not written — a task moves with "
                          "tasks.start, tasks.hand, tasks.submit, tasks.accept or "
                          "tasks.send_back", f)
    return None


def _wrong_state(row_props: dict[str, Any], want: str | tuple[str, ...], doing: str):
    now = row_props.get("state") or "ready"
    wants = (want,) if isinstance(want, str) else want
    label = {"ready": "ready", "flight": "in progress", "review": "in review", "done": "done"}
    if now in wants:
        return None
    need = " or ".join(label[w] for w in wants)
    return _error(409, "wrong_state",
                  f"this task is {label.get(now, now)}; only one {need} can be {doing}",
                  "task_id")


async def _load(req: Request, conn, body, space: str):
    task_id = (body.get("task_id") or "").strip()
    row = await _task(conn, task_id, space)
    if row is None:
        return None, _error(404, "unknown_task", f"no task {task_id!r}", "task_id")
    return row, None


async def _done(req, conn, space, actor, row, rev, already=False):
    return {"task": await _presented(req, conn, space, actor, row["id"]), "rev": rev,
            "already": already}


@router.post("/api/v1/tasks.propose")
async def tasks_propose(req: Request):
    """File a task. It starts ready and unassigned; the verbs move it from there."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    if bad := _governed(body):
        return bad
    title = _text(body.get("title"), 1000)
    if not title:
        return _error(422, "incomplete", "a task needs a title", "title")
    if len(title) > 200:
        return _error(422, "title_too_long", "keep the title under 200 characters — the "
                      "detail is where the rest goes", "title")
    criteria, bad = _criteria_in(body.get("criteria"))
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    oid = f"task-{hashlib.sha256(f'{space}:{key}'.encode()).hexdigest()[:12]}"

    from commonindex.gateway.authoring import _known_actor, _next_key
    from commonindex.gateway.collections import _schema_violation

    async with req.app.state.commonindex["pool"].acquire() as conn:
        if why := await _known_actor(conn, actor):
            return _error(422, "unknown_actor", why, "actor_id")
        seen = await conn.fetchrow(
            "select deleted_at from objects where id = $1 and space_id = $2", oid, space)
        if seen is not None and seen["deleted_at"] is not None:
            return _error(409, "key_spent", "that key filed a task that has since been "
                          "deleted — file a new one with a new key", "idempotencyKey")
        if seen is not None:
            return {**await _done(req, conn, space, actor, {"id": oid}, None, True),
                    "created": False}
        kind = await conn.fetchval("select kind from actors where id = $1", actor)
        props = {"title": title, "detail": _text(body.get("detail")),
                 "criteria": [{"text": c, "met": None} for c in criteria],
                 "human_only": _text(body.get("human_only"), 500),
                 "state": "ready", "assignee": None,
                 "origin": "triggered" if kind == "agent" else "filed",
                 "moved_at": _now().isoformat(), "question": None, "produced": None,
                 "review": None, "ask_seq": None}
        if violation := _schema_violation(_task_type(), props):
            why, field = violation
            return _error(422, "invalid_props", f"this is not a task — {why}", field)
        async with conn.transaction():
            tkey = await _next_key(conn, space, "T")
            await conn.execute(
                "insert into objects (id, space_id, type, key, title, props, created_by)"
                " values ($1,$2,'task',$3,$4,$5::jsonb,$6)",
                oid, space, tkey, title, json.dumps(props), actor)
            await conn.execute(
                "insert into revisions (object_id, rev, author_id, delta)"
                " values ($1, 1, $2, $3::jsonb)", oid, actor,
                json.dumps({"props": props, "kind": "create", "note": None, "key": key}))
            await index_object(conn, oid)
        return {**await _done(req, conn, space, actor, {"id": oid}, 1), "created": True}


@router.post("/api/v1/tasks.revise")
async def tasks_revise(req: Request):
    """Change what the task says, while it can still change."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    if bad := _governed(body):
        return bad
    key = str(body["idempotencyKey"]).strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if moved := _moved(row, body):
            return moved
        before = _props(row)
        if bad := _wrong_state(before, ("ready", "flight"), "changed — one in review is judged "
                                                             "as it was filed"):
            return bad
        p = dict(before)
        changed = []
        if "title" in body:
            title = _text(body.get("title"), 1000)
            if not title:
                return _error(422, "incomplete", "a task needs a title", "title")
            if len(title) > 200:
                return _error(422, "title_too_long", "keep the title under 200 characters",
                              "title")
            p["title"] = title
        if "detail" in body:
            p["detail"] = _text(body.get("detail"))
        if "criteria" in body:
            criteria, bad = _criteria_in(body.get("criteria"))
            if bad:
                return bad
            kept = {c.get("text"): c.get("met") for c in before.get("criteria") or []}
            p["criteria"] = [{"text": c, "met": kept.get(c)} for c in criteria]
        if "human_only" in body:
            p["human_only"] = _text(body.get("human_only"), 500)
        for f, label in (("title", "title"), ("detail", "detail"),
                         ("criteria", "definition of done"), ("human_only", "who can take it")):
            if p.get(f) != before.get(f):
                changed.append(label)
        if not changed:
            return await _done(req, conn, space, actor, row, row["current_rev"], True)
        # An agent is working to the definition it was handed. Taking that away
        # under it would leave a run checking itself against nothing.
        assignee = p.get("assignee")
        if assignee and (why := agent_ready(p)) and await conn.fetchval(
                "select kind from actors where id = $1", assignee) == "agent":
            return _error(409, "agent_working",
                          f"{assignee} is working this, and after this change {why}. Give "
                          "it back first (tasks.release), then change it.", "criteria")
        async with conn.transaction():
            rev = await _step(conn, row, p, actor, "edit", ", ".join(changed), key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.start")
async def tasks_start(req: Request):
    """Take a ready task yourself."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if moved := _moved(row, body):
            return moved
        p = _props(row)
        if bad := _wrong_state(p, "ready", "started"):
            return bad
        kind = await conn.fetchval("select kind from actors where id = $1", actor)
        if kind == "agent" and (why := agent_ready(p)):
            return _error(422, "not_agent_ready", f"an agent cannot take this: {why}",
                          "task_id")
        p.update(state="flight", assignee=actor, moved_at=_now().isoformat(),
                 question=None, ask_seq=None)
        async with conn.transaction():
            rev = await _step(conn, row, p, actor, "start", None, key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.hand")
async def tasks_hand(req: Request):
    """Hand a ready task to an agent, as an ask it will read in its inbox."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    agent = (body.get("agent_id") or "").strip()
    if not agent:
        return _error(422, "no_agent", "say which agent to hand it to", "agent_id")
    note = _text(body.get("note"))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if moved := _moved(row, body):
            return moved
        return await _hand(req, conn, space, actor, row, agent, note, key)


async def _hand(req, conn, space: str, actor: str, row, agent: str, note: str | None, key: str):
    """A ready task to an agent, as an ask in its inbox — for tasks.hand, and
    for tasks.assign when the one named is an agent."""
    p = _props(row)
    if bad := _wrong_state(p, "ready", "handed over"):
        return bad
    if why := agent_ready(p):
        code = "needs_a_person" if p.get("human_only") else "no_criteria"
        return _error(422, code, f"no agent can take this: {why}", "task_id")
    a = await conn.fetchrow("select kind, display from actors where id = $1", agent)
    if a is None or a["kind"] != "agent":
        return _error(404, "unknown_agent", f"no agent {agent!r}", "agent_id")
    if not await _holds(req, conn, agent, "propose", space):
        return _error(422, "agent_cannot_file",
                      f"{a['display']} holds no propose grant in this space, so it "
                      "could not file the work. Grant it propose here first.", "agent_id")
    done_means = "\n".join(f"- {c['text']}" for c in p.get("criteria") or [])
    ask = (f"{row['key']} — {p.get('title') or row['title']}\n\nDone means:\n{done_means}"
           + (f"\n\n{p['detail']}" if p.get("detail") else "")
           + (f"\n\nFrom {actor}: {note}" if note else "")
           + "\n\nClaim it with runs.start, and file it with tasks.submit.")
    async with conn.transaction():
        seq = await _ask(conn, space, actor, agent, row["id"], ask, key)
        p.update(state="flight", assignee=agent, moved_at=_now().isoformat(),
                 question=None, ask_seq=seq)
        rev = await _step(conn, row, p, actor, "hand", note, key, to=agent)
    return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.assign")
async def tasks_assign(req: Request):
    """Say who works a task: a person in the workspace, an agent, or nobody.

    A person on a ready task is who it is for — it stays ready until they
    start it. On a task in progress it changes hands, which only the one
    working it, or anyone who can merge, may do. An agent is a hand-over:
    the same ask, the same rules, so it needs a ready task an agent can take.
    """
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    who = body.get("assignee_id")
    who = who.strip() if isinstance(who, str) and who.strip() else None
    note = _text(body.get("note"))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if moved := _moved(row, body):
            return moved
        p = _props(row)
        if bad := _wrong_state(p, ("ready", "flight"), "assigned"):
            return bad
        if p.get("assignee") == who:
            return await _done(req, conn, space, actor, row, row["current_rev"], True)
        a = await conn.fetchrow("select kind, display from actors where id = $1", who) if who else None
        if who and a is None:
            return _error(404, "unknown_actor", f"no one called {who!r} here", "assignee_id")
        if a is not None and a["kind"] == "agent":
            if p.get("state") == "flight":
                # Passing work in progress to an agent is giving it back and
                # handing it over, in one step and by the same people who may
                # pass it on: its assignee, or someone who can merge here.
                if p.get("assignee") != actor and not await _holds(req, conn, actor, "merge", space):
                    return _error(403, "not_yours",
                                  f"{p.get('assignee')} is working this; they can pass it on, "
                                  "or anyone who can merge here", "task_id")
                if why := agent_ready(p):
                    code = "needs_a_person" if p.get("human_only") else "no_criteria"
                    return _error(422, code, f"no agent can take this: {why}", "task_id")
                pending = p.get("ask_seq")
                p.update(state="ready", assignee=None, moved_at=_now().isoformat(), question=None, ask_seq=None)
                async with conn.transaction():
                    await _withdraw(conn, space, actor, row["id"], pending, "the task was handed to an agent")
                    await _step(conn, row, p, actor, "release", note, f"{key}:release")
                row = await _task(conn, row["id"], space)
            return await _hand(req, conn, space, actor, row, who, note, key)
        if p.get("state") == "flight":
            if who is None:
                return _error(422, "use_release", "to take an in-progress task off its "
                              "assignee, give it back (tasks.release)", "assignee_id")
            if p.get("assignee") != actor and not await _holds(req, conn, actor, "merge", space):
                return _error(403, "not_yours",
                              f"{p.get('assignee')} is working this; they can pass it on, "
                              "or anyone who can merge here", "task_id")
        if who and not await _holds(req, conn, who, "propose", space):
            return _error(422, "cannot_work_here",
                          f"{a['display']} cannot work in this workspace — give them a "
                          "role that can propose first", "assignee_id")
        pending = p.get("ask_seq")
        p.update(assignee=who, question=None, ask_seq=None)
        async with conn.transaction():
            if pending is not None:
                await _withdraw(conn, space, actor, row["id"], pending, "the task was reassigned")
            rev = await _step(conn, row, p, actor, "assign", note, key, to=who)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.release")
async def tasks_release(req: Request):
    """Give an in-progress task back to ready."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if moved := _moved(row, body):
            return moved
        p = _props(row)
        if bad := _wrong_state(p, "flight", "given back"):
            return bad
        if p.get("assignee") != actor and not await _holds(req, conn, actor, "merge", space):
            return _error(403, "not_yours",
                          f"{p.get('assignee')} is working this; they can give it back, "
                          "or anyone who can merge here", "task_id")
        pending = p.get("ask_seq")
        p.update(state="ready", assignee=None, moved_at=_now().isoformat(),
                 question=None, ask_seq=None)
        async with conn.transaction():
            await _withdraw(conn, space, actor, row["id"], pending, "the task was given back")
            rev = await _step(conn, row, p, actor, "release", _text(body.get("note")), key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.submit")
async def tasks_submit(req: Request):
    """File your work for review, answering each criterion."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if moved := _moved(row, body):
            return moved
        p = _props(row)
        if bad := _wrong_state(p, "flight", "filed for review"):
            return bad
        if p.get("assignee") != actor:
            return _error(403, "not_yours",
                          f"only the one working it files it — {p.get('assignee')} is",
                          "task_id")
        criteria = p.get("criteria") or []
        met = body.get("criteria_met")
        if criteria:
            if (not isinstance(met, list) or len(met) != len(criteria)
                    or not all(isinstance(m, bool) for m in met)):
                return _error(422, "unanswered_criteria",
                              f"say for each of the {len(criteria)} criteria whether the "
                              "work meets it — true or false, in order. The reviewer judges "
                              "against them, and one nobody checked reads as one that "
                              "passed.", "criteria_met")
            p["criteria"] = [{"text": c.get("text"), "met": m} for c, m in zip(criteria, met)]
        produced = None
        if body.get("produced"):
            given = body["produced"]
            label = _text(given.get("label"), 200) if isinstance(given, dict) else None
            if not label:
                return _error(422, "bad_produced", "name what the work produced", "produced")
            object_id = _text(given.get("object_id"), 200)
            url = _text(given.get("url"), 1000)
            if object_id and await conn.fetchval(
                    "select 1 from objects where id = $1 and space_id = $2 and deleted_at is null",
                    object_id, space) is None:
                return _error(404, "unknown_object", f"no object {object_id!r}", "produced")
            if url and not url.startswith(("https://", "http://")):
                return _error(422, "bad_url", "a link is an http(s) address", "produced")
            produced = {"label": label, "object_id": object_id, "url": url}
        note = _text(body.get("note"))
        now = _now().isoformat()
        p.update(state="review", moved_at=now, question=None, produced=produced,
                 review={"submitted_by": actor, "submitted_at": now, "note": note})
        async with conn.transaction():
            rev = await _step(conn, row, p, actor, "submit", note, key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.accept")
async def tasks_accept(req: Request):
    """Accept the work in review, as it was when you read it."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    note = _text(body.get("note"))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if body.get("if_rev") is None:
            return _error(422, "missing_if_rev",
                          "say which revision you are accepting — an acceptance is for "
                          "the version you read, not whatever is there when it lands",
                          "if_rev")
        p = _props(row)
        if bad := _wrong_state(p, "review", "accepted"):
            return bad
        if moved := _moved(row, body):
            return moved
        own = p.get("assignee") == actor
        if own:
            if not body.get("self_accept"):
                return _error(403, "own_work",
                              "you did this work, so someone else must accept it. An admin "
                              "may accept their own by saying why.", "task_id")
            if not await _holds(req, conn, actor, "admin", space):
                return _error(403, "own_work", "only an admin may accept their own work",
                              "self_accept")
            if not note:
                return _error(422, "reason_required",
                              "accepting your own work needs a reason, which is recorded "
                              "on the task", "note")
        now = _now().isoformat()
        p.update(state="done", moved_at=now, question=None,
                 review={**(p.get("review") or {}), "decision": "accepted",
                         "decided_by": actor, "decided_at": now, "decision_note": note,
                         "self_accepted": own})
        async with conn.transaction():
            rev = await _step(conn, row, p, actor, "accept", note, key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.send_back")
async def tasks_send_back(req: Request):
    """Return the work in review, saying what to change."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    note = _text(body.get("note"))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        if not note:
            return _error(422, "reason_required",
                          "say what should change — work sent back without a reason is "
                          "work nobody knows how to fix", "note")
        p = _props(row)
        if bad := _wrong_state(p, "review", "sent back"):
            return bad
        if moved := _moved(row, body):
            return moved
        now = _now().isoformat()
        p.update(state="flight", moved_at=now,
                 review={**(p.get("review") or {}), "decision": "sent_back",
                         "decided_by": actor, "decided_at": now, "decision_note": note})
        async with conn.transaction():
            assignee = p.get("assignee")
            if assignee and await conn.fetchval(
                    "select kind from actors where id = $1", assignee) == "agent":
                await _withdraw(conn, space, actor, row["id"], p.get("ask_seq"),
                                "superseded by the send-back")
                p["ask_seq"] = await _ask(
                    conn, space, actor, assignee, row["id"],
                    f"{row['key']} — {p.get('title')} was sent back.\n\n{note}\n\n"
                    "Claim it with runs.start and file it again with tasks.submit.", key)
            rev = await _step(conn, row, p, actor, "send_back", note, key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.question")
async def tasks_question(req: Request):
    """Stop and ask a person, on a task you are working."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    text = _text(body.get("question"))
    if not text:
        return _error(422, "no_question", "say what you are asking", "question")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        p = _props(row)
        if bad := _wrong_state(p, "flight", "asked about"):
            return bad
        if p.get("assignee") != actor:
            return _error(403, "not_yours", "only the one working it asks on it", "task_id")
        if p.get("question"):
            return _error(409, "already_asking",
                          "there is an open question on this task; it is answered first",
                          "question")
        p["question"] = {"text": text, "by": actor, "at": _now().isoformat()}
        async with conn.transaction():
            rev = await _step(conn, row, p, actor, "question", text, key)
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.answer")
async def tasks_answer(req: Request):
    """Answer the question on a task; an agent is asked again with the answer."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    text = _text(body.get("answer"))
    if not text:
        return _error(422, "no_answer", "say what the answer is", "answer")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        p = _props(row)
        q = p.get("question")
        if not q:
            return _error(409, "no_question", "there is no open question on this task",
                          "task_id")
        if q.get("by") == actor:
            return _error(422, "own_question", "you asked this; a person answers it",
                          "answer")
        p["question"] = None
        async with conn.transaction():
            assignee = p.get("assignee")
            if assignee and await conn.fetchval(
                    "select kind from actors where id = $1", assignee) == "agent":
                await _withdraw(conn, space, actor, row["id"], p.get("ask_seq"),
                                "superseded by the answer")
                p["ask_seq"] = await _ask(
                    conn, space, actor, assignee, row["id"],
                    f"{row['key']} — you asked: {q.get('text')}\n\nAnswer: {text}\n\n"
                    "Claim it with runs.start and carry on.", key)
            rev = await _step(conn, row, p, actor, "answer", text, key,
                              question=q.get("text"))
        return await _done(req, conn, space, actor, row, rev)


async def _link(req: Request, add: bool):
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    key = str(body["idempotencyKey"]).strip()
    rel = (body.get("rel") or "").strip()
    object_id = (body.get("object_id") or "").strip()
    if rel not in RELS:
        return _error(422, "bad_rel", "a task is linked as caused, touches or depends", "rel")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, bad = await _load(req, conn, body, space)
        if bad:
            return bad
        if (rev := await _replayed(conn, row["id"], key)) is not None:
            return await _done(req, conn, space, actor, row, rev, True)
        other = await conn.fetchrow(
            "select id, type, key, title from objects where id = $1 and space_id = $2"
            "   and deleted_at is null", object_id, space)
        if other is None:
            return _error(404, "unknown_object", f"no object {object_id!r}", "object_id")
        if other["id"] == row["id"]:
            return _error(422, "self_link", "a task cannot relate to itself", "object_id")
        async with conn.transaction():
            if add:
                wrote = await conn.fetchval(
                    "insert into edges (src, rel, dst, created_by) values ($1,$2,$3,$4)"
                    " on conflict do nothing returning 1", row["id"], rel, other["id"], actor)
            else:
                wrote = await conn.fetchval(
                    "delete from edges where src = $1 and rel = $2 and dst = $3 returning 1",
                    row["id"], rel, other["id"])
            if not wrote:
                if add:
                    return await _done(req, conn, space, actor, row, row["current_rev"], True)
                return _error(404, "not_linked", "the task is not linked to that object "
                              "that way", "object_id")
            rev = await _step(conn, row, _props(row), actor, "link" if add else "unlink",
                              None, key, rel=rel,
                              object={"id": other["id"], "type": other["type"],
                                      "key": other["key"], "title": other["title"]})
        return await _done(req, conn, space, actor, row, rev)


@router.post("/api/v1/tasks.link")
async def tasks_link(req: Request):
    """Record how a task relates to another object."""
    return await _link(req, True)


@router.post("/api/v1/tasks.unlink")
async def tasks_unlink(req: Request):
    """Remove a relation recorded with tasks.link."""
    return await _link(req, False)


@router.post("/api/v1/tasks.delete")
async def tasks_delete(req: Request):
    """Take a task off the board — a tombstone, so its history stays."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    task_id = (body.get("task_id") or "").strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "select id, created_by, deleted_at, props from objects where id = $1"
            "   and space_id = $2 and type = 'task'", task_id, space)
        if row is None:
            return _error(404, "unknown_task", f"no task {task_id!r}", "task_id")
        if row["deleted_at"] is not None:
            return {"task_id": task_id, "deleted": True, "already": True}
        if row["created_by"] != actor and not await _holds(req, conn, actor, "merge", space):
            return _error(403, "not_yours", "the one who filed it can take it off the board, "
                          "or anyone who can merge here", "task_id")
        async with conn.transaction():
            await _withdraw(conn, space, actor, task_id, _props(row).get("ask_seq"),
                            "the task was deleted")
            await conn.execute("update objects set deleted_at = now(), updated_at = now()"
                               " where id = $1", task_id)
            await index_object(conn, task_id)
    return {"task_id": task_id, "deleted": True, "already": False}
