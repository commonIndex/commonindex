"""Comments on objects, and channels — one conversation model for both.

A message is about a subject: any object in the space. A comment on a
dashboard has the dashboard as its subject; a message in a channel has the
channel, which is an object of type `channel`. Threads are one level deep.
Two things people talk about are not objects, and are subjects too: an agent,
which is its actor, and a skill, which the gateway does not store — the first
comment on one names it (`conversation_subjects`).

Mentions are how a conversation reaches someone. `@id` in a body is resolved
to an actor when the message is written. A mentioned agent is also asked — an
`asked` event naming the message, the same record `agents.ask` writes — so it
finds the thread in `agents.inbox` and answers with `messages.post`. Until it
does, the thread says it was asked and is waiting: read off the events and the
replies, never a flag somebody has to remember to clear.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.workers.indexer import index_object

router = APIRouter()

MENTION = re.compile(r"@([A-Za-z0-9][\w.-]*)")
MAX_BODY = 8000
CHANNEL_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def _body_text(value: Any) -> str | None:
    s = str(value or "").strip()
    return s or None


async def _holds(req: Request, conn, actor: str, relation: str, space: str) -> bool:
    from commonindex.core.authz import Denied
    from commonindex.core.authz.store import PgChecker

    checker = req.app.state.commonindex.get("checker") or PgChecker(conn)
    try:
        await checker.require(actor, relation, f"space:{space}")
        return True
    except Denied:
        return False


#: A skill's id, as the Skills collection writes it: `skill-109`,
#: `skill-warehouse-context`. Checked because a skill is the one subject the
#: gateway takes on the caller's word.
SKILL_ID = re.compile(r"^skill-[a-z0-9][a-z0-9-]{0,79}$")


async def _subjects(conn, ids, space: str, *, deleted: bool = False) -> dict[str, dict]:
    """What each id is, as something to talk about: an object in the space,
    else an agent — its actor — else a skill somebody has talked about here.
    `deleted` keeps deleted objects, for naming what a notification was about."""
    ids = [i for i in dict.fromkeys(ids) if i]
    if not ids:
        return {}
    out = {r["id"]: dict(r) for r in await conn.fetch(
        "select id, type, key, title from objects where id = any($1::text[]) and space_id = $2"
        "   and ($3 or deleted_at is null)", ids, space, deleted)}
    rest = [i for i in ids if i not in out]
    if rest:
        out.update({r["id"]: {"id": r["id"], "type": "agent", "key": None, "title": r["display"]}
                    for r in await conn.fetch(
                        "select id, display from actors where kind = 'agent'"
                        "   and id = any($1::text[])", rest)})
        rest = [i for i in rest if i not in out]
    if rest:
        out.update({r["id"]: dict(r) for r in await conn.fetch(
            "select id, type, key, title from conversation_subjects"
            " where space_id = $1 and id = any($2::text[])", space, rest)})
    return out


async def _subject(conn, subject_id: str, space: str):
    return (await _subjects(conn, [subject_id], space)).get(subject_id)


async def _private(req: Request, conn, subject: dict | None, space: str):
    """The conversation about a dashboard, doc or design is for the people who
    can see it: anyone else is told it does not exist."""
    from commonindex.gateway import sharing

    if subject is None or subject.get("type") not in sharing.SHARED:
        return None
    _, refused = await sharing.require(req, conn, subject["id"], space, "view")
    return refused


def _declared(subject_id: str, value: Any) -> tuple[dict | None, JSONResponse | None]:
    """A skill the gateway has not heard of, as the caller names it. Only a
    skill: an object or an agent is looked up, never taken on anyone's word."""
    if not isinstance(value, dict):
        return None, None
    if value.get("type") != "skill":
        return None, _error(422, "not_declarable",
                            "only a skill is named by the caller — anything else is looked up, "
                            "and this one was not found", "subject")
    title = _body_text(value.get("title"))
    if not SKILL_ID.match(subject_id) or not title or len(title) > 200:
        return None, _error(422, "bad_subject",
                            "a skill is named by an id like skill-12 and a title under 200 "
                            "characters", "subject")
    key = _body_text(value.get("key"))
    return {"id": subject_id, "type": "skill", "key": key[:40] if key else None,
            "title": title}, None


async def _actors(conn, ids) -> dict[str, dict]:
    ids = [i for i in dict.fromkeys(ids) if i]
    if not ids:
        return {}
    return {r["id"]: {"id": r["id"], "name": r["display"], "kind": r["kind"]}
            for r in await conn.fetch(
                "select id, display, kind from actors where id = any($1::text[])", ids)}


def _mentioned(text: str) -> list[str]:
    """The handles in a body, in the order they appear, each once."""
    return list(dict.fromkeys(MENTION.findall(text)))


async def _present(conn, rows, me: str, may_merge: bool) -> list[dict]:
    people = await _actors(conn, [r["author_id"] for r in rows]
                           + [m for r in rows for m in (r["mentions"] or [])])

    def who(i):
        return people.get(i) or {"id": i, "name": i, "kind": "human"}

    out = []
    for r in rows:
        gone = r["deleted_at"] is not None
        out.append({
            "id": r["id"], "parent_id": r["parent_id"], "author": who(r["author_id"]),
            "kind": r.get("kind") or "comment",
            "body": None if gone else r["body"],
            "mentions": [] if gone else [who(m) for m in r["mentions"] or []],
            "created_at": r["created_at"].isoformat(),
            "edited_at": r["edited_at"].isoformat() if r["edited_at"] else None,
            "deleted": gone,
            "you": {"may_edit": not gone and r["author_id"] == me,
                    "may_delete": not gone and (r["author_id"] == me or may_merge)},
        })
    return out


_COLUMNS = ("select id, subject_id, parent_id, author_id, body, mentions, created_at,"
            " edited_at, deleted_at, kind from messages")
#: What a message is: the conversation about an item, or a dated update on it.
KINDS = ("comment", "update")

#: The Postgres channel a change to a conversation is announced on. It carries
#: only which conversation changed and who may read it — never what was said —
#: and commonindex/gateway/events.py passes it to each open browser that may.
CHANNEL = "commonindex_messages"


async def _announce(conn, space: str, subject_id: str) -> None:
    """Say that a conversation changed. Inside a transaction it is sent on
    commit, so a reader is never told about a message it cannot yet read."""
    acl = await conn.fetchval("select acl_keys from objects where id = $1", subject_id)
    await conn.execute("select pg_notify($1, $2)", CHANNEL, json.dumps(
        {"space": space, "subject_id": subject_id, "acl": list(acl or [f"space:{space}"])}))


async def _waiting(conn, space: str, rows) -> dict[str, list[dict]]:
    """Per message, the agents it asked that have not answered in its thread
    since. Asked is what the events say; answered is a reply by that agent in
    the same thread, after the message."""
    ids = [r["id"] for r in rows if r["deleted_at"] is None]
    if not ids:
        return {}
    asked = await conn.fetch(
        "select payload->>'message_id' as message_id, payload->>'agent' as agent from events"
        " where space_id = $1 and verb = 'asked' and payload->>'message_id' = any($2::text[])",
        space, ids)
    if not asked:
        return {}
    by_id = {r["id"]: r for r in rows}
    root = {r["id"]: (r["parent_id"] or r["id"]) for r in rows}
    agents = await _actors(conn, [a["agent"] for a in asked])
    out: dict[str, list[dict]] = {}
    for a in asked:
        m = by_id.get(a["message_id"])
        if m is None or m["deleted_at"] is not None:
            continue
        answered = any(r["author_id"] == a["agent"] and root[r["id"]] == root[m["id"]]
                       and r["created_at"] > m["created_at"] and r["deleted_at"] is None
                       for r in rows)
        if (not answered and a["agent"] in agents
                and all(x["id"] != a["agent"] for x in out.get(m["id"], []))):
            out.setdefault(m["id"], []).append(agents[a["agent"]])
    return out


async def _ask_mentioned(req, conn, space: str, actor: str, subject, message_id: str,
                         thread_id: str, text: str, mentions: list[str], key: str,
                         skip: set[str] = frozenset()):
    """Ask each mentioned agent, in its inbox, to look at this thread. An agent
    that could not answer — no propose grant here — is reported, not asked."""
    from commonindex.gateway.agents import _next_seq

    agents = await conn.fetch(
        "select id, display from actors where kind = 'agent' and id = any($1::text[])",
        [m for m in mentions if m not in skip and m != actor])
    asked, not_asked = [], []
    author = await conn.fetchval("select display from actors where id = $1", actor) or actor
    for a in agents:
        if not await _holds(req, conn, a["id"], "propose", space):
            not_asked.append({"id": a["id"],
                              "why": "it holds no propose grant here, so it could not reply"})
            continue
        note = (f"{author} mentioned you in the conversation about {subject['title']}"
                f" ({subject['type']}{' ' + subject['key'] if subject['key'] else ''}):\n\n"
                f"{text}\n\nAnswer in the thread: messages.post with subject_id={subject['id']}"
                f" and parent_id={thread_id}.")
        await conn.execute(
            "insert into space_seq (space_id) values ($1) on conflict (space_id) do nothing", space)
        seq = await _next_seq(conn, space)
        await conn.execute(
            "insert into events (space_id, seq, actor_id, verb, object_id, payload)"
            " values ($1,$2,$3,'asked',$4,$5::jsonb)",
            space, seq, actor, subject["id"],
            json.dumps({"agent": a["id"], "note": note, "key": f"{key}:{a['id']}",
                        "message_id": message_id, "thread_id": thread_id}))
        asked.append(a["id"])
    return asked, not_asked


# ── reading ───────────────────────────────────────────────────────────────


def _seen(alias: str, keys: str) -> str:
    """A message about a dashboard, doc or design is read only by the people
    who can see it — in a feed, a count or a mention, as on the item's page.
    `keys` is the placeholder holding the caller's permission keys."""
    from commonindex.gateway.sharing import SHARED

    types = ", ".join(f"'{t}'" for t in SHARED)
    return (f" and not exists (select 1 from objects o where o.id = {alias}subject_id"
            f" and o.type in ({types}) and not (o.acl_keys && {keys}::text[]))")


@router.post("/api/v1/messages.list")
async def messages_list(req: Request):
    """The conversation about one object."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    subject_id = (body.get("subject_id") or "").strip()
    if not subject_id:
        return _error(422, "missing_subject", "say which object the conversation is about",
                      "subject_id")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        subject = await _subject(conn, subject_id, space)
        if (refused := await _private(req, conn, subject, space)) is not None:
            return refused
        if subject is None:
            # A skill nobody has talked about yet is an empty conversation, named
            # as the caller names it. Reading writes nothing; the first comment does.
            declared, bad = _declared(subject_id, body.get("subject"))
            if bad:
                return bad
            if declared is None:
                return _error(404, "unknown_subject", f"no object {subject_id!r}", "subject_id")
            return {"subject": declared, "messages": [], "waiting": {}}
        kind = body.get("kind") or "comment"
        if kind not in KINDS:
            return _error(422, "bad_kind", "a message is a comment or an update", "kind")
        # The whole conversation came back on every read, and an open thread
        # read it every 15 seconds: a busy channel cost more the longer it ran.
        # Now a page of the newest conversations, each whole with its replies
        # (`limit`, older with `before`), or only what changed (`since`).
        now = await conn.fetchval("select now()")
        where = " where subject_id = $1 and space_id = $2 and kind = $3"
        more_before = False
        since = _when(body.get("since"))
        if body.get("since") is not None and since is None:
            return _error(422, "bad_since", "since is a timestamp from a previous answer's `now`", "since")
        if since is not None:
            # Created, edited or deleted since — deletions included, so a reader
            # can take a message away; and the threads those changes are in,
            # whose "waiting for a reply" may have moved with them.
            rows = await conn.fetch(
                _COLUMNS + where + " and greatest(created_at, coalesce(edited_at, created_at),"
                " coalesce(deleted_at, created_at)) > $4 order by created_at, id",
                subject_id, space, kind, since)
            roots = {r["parent_id"] for r in rows if r["parent_id"]} - {r["id"] for r in rows}
            if roots:
                rows = sorted([*rows, *await conn.fetch(_COLUMNS + " where id = any($1::text[])", list(roots))],
                              key=lambda r: (r["created_at"], r["id"]))
        else:
            limit = max(1, min(int(body.get("limit") or PAGE), 500))
            before = None
            if body.get("before"):
                before = await conn.fetchrow("select created_at, id from messages where id = $1 and subject_id = $2",
                                             body["before"], subject_id)
                if before is None:
                    return _error(404, "unknown_message", f"no message {body['before']!r} here", "before")
            top = await conn.fetch(
                _COLUMNS + where + " and parent_id is null"
                + (" and (created_at, id) < ($5, $6)" if before else "")
                + " order by created_at desc, id desc limit $4",
                subject_id, space, kind, limit + 1, *((before["created_at"], before["id"]) if before else ()))
            more_before = len(top) > limit
            top = list(reversed(top[:limit]))
            replies = await conn.fetch(_COLUMNS + " where parent_id = any($1::text[]) and kind = $2"
                                       " order by created_at, id", [r["id"] for r in top], kind) if top else []
            rows = sorted([*top, *replies], key=lambda r: (r["created_at"], r["id"]))
            # A deleted message stays only as a marker for the replies it anchors.
            anchors = {r["parent_id"] for r in rows if r["parent_id"] and r["deleted_at"] is None}
            rows = [r for r in rows if r["deleted_at"] is None or r["id"] in anchors]
        may_merge = await _holds(req, conn, actor, "merge", space)
        messages = await _present(conn, rows, actor, may_merge)
        waiting = await _waiting(conn, space, rows)
    out = {"subject": {"id": subject["id"], "type": subject["type"], "key": subject["key"],
                       "title": subject["title"]},
           "messages": messages, "waiting": waiting, "now": now.isoformat()}
    if since is not None:
        out["since"] = since.isoformat()
    else:
        out["more_before"] = more_before
    return out


#: Conversations per page: each comes whole, with its replies.
PAGE = 100


def _when(value: Any):
    """A timestamp from a previous answer, or None."""
    from datetime import datetime

    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


@router.post("/api/v1/messages.counts")
async def messages_counts(req: Request):
    """Message counts for several objects at once."""
    from commonindex.gateway.auth import space_of

    body = await req.json()
    space = space_of(req, body)
    ids = [str(i) for i in (body.get("subject_ids") or [])][:500]
    from commonindex.gateway import sharing

    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select subject_id, count(*) as n from messages where space_id = $1"
            "   and subject_id = any($2::text[]) and deleted_at is null and kind = 'comment'" + _seen("", "$3")
            + " group by subject_id", space, ids, await sharing.keys(req, conn))
    counts = {i: 0 for i in ids}
    counts.update({r["subject_id"]: int(r["n"]) for r in rows})
    return {"counts": counts}


@router.post("/api/v1/messages.mentions")
async def messages_mentions(req: Request):
    """Recent messages that mention the caller."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json() if await req.body() else {}
    space, actor = space_of(req, body), actor_of(req)
    limit = max(1, min(int(body.get("limit") or 50), 200))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        from commonindex.gateway import sharing

        rows = await conn.fetch(
            _COLUMNS + " where space_id = $1 and $2 = any(mentions) and deleted_at is null" + _seen("", "$4")
            + " order by created_at desc limit $3", space, actor, limit, await sharing.keys(req, conn))
        subjects = await _subjects(conn, [r["subject_id"] for r in rows], space, deleted=True)
        messages = await _present(conn, rows, actor, False)
    return {"mentions": [
        {"message": m, "subject": {k: subjects[r["subject_id"]][k] for k in ("id", "type", "key", "title")}
                                   if r["subject_id"] in subjects else None}
        for m, r in zip(messages, rows)]}


# ── notifications ─────────────────────────────────────────────────────────

# What wants someone's attention, as one query over messages: a message by
# somebody else that mentions them, or that replies in a thread they have
# written in. Read state is one line per conversation (message_reads), so a
# notification is unread while it is newer than that line.
_NOTIFIED = """
    with mine as (
      select distinct coalesce(parent_id, id) as root from messages
       where space_id = $1 and author_id = $2 and deleted_at is null
    )
    select m.id, m.subject_id, m.parent_id, m.author_id, m.body, m.mentions, m.created_at,
           m.edited_at, m.deleted_at, ($2 = any(m.mentions)) as mentioned,
           (r.read_at is null or m.created_at > r.read_at) as unread
      from messages m
      left join message_reads r on r.actor_id = $2 and r.subject_id = m.subject_id
     where m.space_id = $1 and m.author_id <> $2 and m.deleted_at is null
       and ($2 = any(m.mentions) or m.parent_id in (select root from mine))
"""


@router.post("/api/v1/messages.notifications")
async def messages_notifications(req: Request):
    """Mentions of the caller and replies in their threads, newest first."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json() if await req.body() else {}
    space, actor = space_of(req, body), actor_of(req)
    limit = max(1, min(int(body.get("limit") or 30), 100))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        from commonindex.gateway import sharing

        keys = await sharing.keys(req, conn)
        notified = _NOTIFIED + _seen("m.", "$3")
        rows = await conn.fetch(notified + " order by m.created_at desc, m.id limit $4",
                                space, actor, keys, limit)
        unread = await conn.fetchval(f"select count(*) from ({notified}) n where n.unread",
                                     space, actor, keys)
        subjects = await _subjects(conn, [r["subject_id"] for r in rows], space, deleted=True)
        messages = await _present(conn, rows, actor, False)
    return {
        "unread": int(unread),
        "notifications": [{
            "kind": "mention" if r["mentioned"] else "reply",
            "unread": bool(r["unread"]),
            "message": m,
            "subject": ({k: subjects[r["subject_id"]][k] for k in ("id", "type", "key", "title")}
                        if r["subject_id"] in subjects else None),
        } for m, r in zip(messages, rows)],
    }


@router.post("/api/v1/messages.unread")
async def messages_unread(req: Request):
    """Unread counts per conversation, for the caller."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    ids = [str(i) for i in (body.get("subject_ids") or [])][:500]
    from commonindex.gateway import sharing

    async with req.app.state.commonindex["pool"].acquire() as conn:
        rows = await conn.fetch(
            "select m.subject_id, count(*) as n from messages m"
            "  left join message_reads r on r.actor_id = $2 and r.subject_id = m.subject_id"
            " where m.space_id = $1 and m.subject_id = any($3::text[]) and m.author_id <> $2"
            "   and m.deleted_at is null and (r.read_at is null or m.created_at > r.read_at)"
            + _seen("m.", "$4") + " group by m.subject_id", space, actor, ids, await sharing.keys(req, conn))
    counts = {i: 0 for i in ids}
    counts.update({r["subject_id"]: int(r["n"]) for r in rows})
    return {"unread": counts}


@router.post("/api/v1/messages.read")
async def messages_read(req: Request):
    """Mark conversations read for the caller, up to now."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    if not str(body.get("idempotencyKey") or "").strip():
        return _error(422, "missing_idempotency_key",
                      "a mutation needs an idempotency key so a retry after a timeout does not "
                      "write twice", "idempotencyKey")
    space, actor = space_of(req, body), actor_of(req)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        if body.get("all"):
            ids = [r["subject_id"] for r in await conn.fetch(
                f"select distinct subject_id from ({_NOTIFIED}) n where n.unread", space, actor)]
        else:
            ids = [str(i) for i in (body.get("subject_ids") or [])]
            if body.get("subject_id"):
                ids.append(str(body["subject_id"]))
        # Only conversations that exist here: a read line on a stranger's id
        # would be a row nobody can ever see a notification for. A deleted
        # object still counts, or what was said about it could never be cleared.
        ids = list(await _subjects(conn, ids, space, deleted=True))
        if ids:
            await conn.execute(
                "insert into message_reads (actor_id, subject_id, read_at)"
                " select $1, unnest($2::text[]), now()"
                " on conflict (actor_id, subject_id) do update set read_at = excluded.read_at",
                actor, ids)
    return {"read": ids}


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


async def _one(conn, message_id: str, space: str):
    return await conn.fetchrow(_COLUMNS + " where id = $1 and space_id = $2", message_id, space)


@router.post("/api/v1/messages.post")
async def messages_post(req: Request):
    """Say something about an object, or answer a message about it."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    subject_id = (body.get("subject_id") or "").strip()
    text = _body_text(body.get("body"))
    if not text:
        return _error(422, "empty", "say something", "body")
    if len(text) > MAX_BODY:
        return _error(422, "too_long", f"keep a message under {MAX_BODY} characters", "body")
    key = str(body["idempotencyKey"]).strip()
    kind = body.get("kind") or "comment"
    if kind not in KINDS:
        return _error(422, "bad_kind", "a message is a comment or an update", "kind")
    if kind == "update" and body.get("parent_id"):
        return _error(422, "update_reply", "an update stands on its own — comment on it instead", "parent_id")
    mid = f"msg-{hashlib.sha256(f'{space}:{key}'.encode()).hexdigest()[:16]}"

    from commonindex.gateway.authoring import _known_actor

    async with req.app.state.commonindex["pool"].acquire() as conn:
        if why := await _known_actor(conn, actor):
            return _error(422, "unknown_actor", why, "actor_id")
        if (again := await _one(conn, mid, space)) is not None:
            may_merge = await _holds(req, conn, actor, "merge", space)
            return {"message": (await _present(conn, [again], actor, may_merge))[0],
                    "asked": [], "not_asked": [], "already": True}
        subject = await _subject(conn, subject_id, space)
        if (refused := await _private(req, conn, subject, space)) is not None:
            return refused
        if subject is not None and subject.get("type") == "channel" and await conn.fetchval(
                "select coalesce((props->>'archived')::boolean, false) from objects where id = $1", subject["id"]):
            return _error(409, "archived", "this channel is archived — unarchive it to post here", "subject_id")
        declared = None
        if subject is None:
            declared, bad = _declared(subject_id, body.get("subject"))
            if bad:
                return bad
            if declared is None:
                return _error(404, "unknown_subject", f"no object {subject_id!r}", "subject_id")
            subject = declared
        parent_id, root = None, mid
        if body.get("parent_id"):
            parent = await _one(conn, str(body["parent_id"]), space)
            if parent is None:
                return _error(404, "unknown_parent", f"no message {body['parent_id']!r}", "parent_id")
            if parent["subject_id"] != subject_id:
                return _error(422, "wrong_subject",
                              "that message is about something else — answer it where it was said",
                              "parent_id")
            # One level deep: an answer to an answer joins the thread it is in.
            parent_id = root = parent["parent_id"] or parent["id"]
        handles = _mentioned(text)
        known = await _actors(conn, handles)
        mentions = [h for h in handles if h in known]
        async with conn.transaction():
            if declared is not None:
                # The first comment on a skill names it; a later one does not rename it.
                await conn.execute(
                    "insert into conversation_subjects (space_id, id, type, key, title, created_by)"
                    " values ($1,$2,$3,$4,$5,$6) on conflict (space_id, id) do nothing",
                    space, subject_id, declared["type"], declared["key"], declared["title"], actor)
            await conn.execute(
                "insert into messages (id, space_id, subject_id, parent_id, author_id, body, mentions, kind)"
                " values ($1,$2,$3,$4,$5,$6,$7::text[],$8)",
                mid, space, subject_id, parent_id, actor, text, mentions, kind)
            asked, not_asked = await _ask_mentioned(req, conn, space, actor, subject, mid, root,
                                                    text, mentions, key)
            await _announce(conn, space, subject_id)
        row = await _one(conn, mid, space)
        may_merge = await _holds(req, conn, actor, "merge", space)
        message = (await _present(conn, [row], actor, may_merge))[0]
    return {"message": message, "asked": asked, "not_asked": not_asked, "already": False}


@router.post("/api/v1/messages.edit")
async def messages_edit(req: Request):
    """Change your own message; anyone newly mentioned is asked."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    text = _body_text(body.get("body"))
    if not text:
        return _error(422, "empty", "a message cannot be edited to nothing — delete it instead", "body")
    if len(text) > MAX_BODY:
        return _error(422, "too_long", f"keep a message under {MAX_BODY} characters", "body")
    key = str(body["idempotencyKey"]).strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _one(conn, str(body.get("message_id") or ""), space)
        if row is None or row["deleted_at"] is not None:
            return _error(404, "unknown_message", f"no message {body.get('message_id')!r}", "message_id")
        if row["author_id"] != actor:
            return _error(403, "not_yours", "only the one who wrote a message edits it", "message_id")
        subject = await _subject(conn, row["subject_id"], space)
        handles = _mentioned(text)
        known = await _actors(conn, handles)
        mentions = [h for h in handles if h in known]
        async with conn.transaction():
            await conn.execute(
                "update messages set body = $2, mentions = $3::text[], edited_at = now() where id = $1",
                row["id"], text, mentions)
            asked, not_asked = [], []
            if subject is not None:
                asked, not_asked = await _ask_mentioned(
                    req, conn, space, actor, subject, row["id"], row["parent_id"] or row["id"],
                    text, mentions, key, skip=set(row["mentions"] or []))
            await _announce(conn, space, row["subject_id"])
        row = await _one(conn, row["id"], space)
        may_merge = await _holds(req, conn, actor, "merge", space)
        message = (await _present(conn, [row], actor, may_merge))[0]
    return {"message": message, "asked": asked, "not_asked": not_asked}


@router.post("/api/v1/messages.delete")
async def messages_delete(req: Request):
    """Delete a message — a tombstone, so replies to it still read as replies."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    message_id = str(body.get("message_id") or "")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _one(conn, message_id, space)
        if row is None:
            return _error(404, "unknown_message", f"no message {message_id!r}", "message_id")
        if row["deleted_at"] is not None:
            return {"message_id": message_id, "deleted": True, "already": True}
        if row["author_id"] != actor and not await _holds(req, conn, actor, "merge", space):
            return _error(403, "not_yours",
                          "the one who wrote it can delete it, or anyone who can merge here",
                          "message_id")
        async with conn.transaction():
            await conn.execute("update messages set deleted_at = now() where id = $1", message_id)
            await _announce(conn, space, row["subject_id"])
    return {"message_id": message_id, "deleted": True, "already": False}


# ── channels ──────────────────────────────────────────────────────────────


async def _channels(conn, space: str, keys: list[str], only: str | None = None,
                    archived: bool = False) -> list[dict]:
    """The channels these keys may see: every public one, and the private ones
    they were added to. Archived ones only when asked for, or by id."""
    rows = await conn.fetch(
        "select o.id, o.key, o.props, o.created_at, ('space:' || o.space_id) = any(o.acl_keys) as public,"
        "       (select count(*) from messages m where m.subject_id = o.id and m.deleted_at is null) as n,"
        "       l.author_id, l.body, l.created_at as last_at"
        "  from objects o"
        "  left join lateral (select author_id, body, created_at from messages m"
        "                      where m.subject_id = o.id and m.deleted_at is null"
        "                      order by created_at desc limit 1) l on true"
        " where o.space_id = $1 and o.type = 'channel' and o.deleted_at is null"
        "   and ($2::text is null or o.id = $2) and o.acl_keys && $3"
        "   and ($2::text is not null or $4 or coalesce((o.props->>'archived')::boolean, false) = false)"
        " order by coalesce(l.created_at, o.created_at) desc, o.id", space, only, keys, archived)
    authors = await _actors(conn, [r["author_id"] for r in rows])
    out = []
    for r in rows:
        p = json.loads(r["props"]) if isinstance(r["props"], str) else dict(r["props"] or {})
        out.append({
            "id": r["id"], "key": r["key"], "name": p.get("name"), "topic": p.get("topic"),
            "visibility": "workspace" if r["public"] else "private",
            "archived": bool(p.get("archived")),
            "messages": int(r["n"]),
            "last_at": r["last_at"].isoformat() if r["last_at"] else None,
            "last": {"author": authors.get(r["author_id"]) or {"id": r["author_id"], "name": r["author_id"], "kind": "human"},
                     "body": (r["body"] or "")[:200]} if r["author_id"] else None,
        })
    return out


@router.post("/api/v1/channels.list")
async def channels_list(req: Request):
    """Every channel in the space, most recently active first."""
    from commonindex.gateway import sharing
    from commonindex.gateway.auth import space_of

    body = await req.json() if await req.body() else {}
    space = space_of(req, body)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        channels = await _channels(conn, space, await sharing.keys(req, conn),
                                   archived=body.get("archived") is True)
    return {"channels": channels, "total": len(channels)}


@router.post("/api/v1/channels.propose")
async def channels_propose(req: Request):
    """Open a channel. Its name is a handle: lowercase words joined by hyphens,
    unique in the space, so `#refund-incidents` means one place."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    name = str(body.get("name") or "").strip().lower()
    if not CHANNEL_NAME.match(name):
        return _error(422, "bad_name",
                      "a channel name is 2–40 lowercase letters, digits and hyphens, "
                      "starting with a letter or digit", "name")
    topic = _body_text(body.get("topic"))
    if topic and len(topic) > 200:
        return _error(422, "topic_too_long", "keep the topic under 200 characters", "topic")
    key = str(body["idempotencyKey"]).strip()
    cid = f"channel-{hashlib.sha256(f'{space}:{key}'.encode()).hexdigest()[:12]}"

    from commonindex.gateway.authoring import _known_actor, _next_key

    async with req.app.state.commonindex["pool"].acquire() as conn:
        if why := await _known_actor(conn, actor):
            return _error(422, "unknown_actor", why, "actor_id")
        from commonindex.gateway import sharing

        if await conn.fetchval("select 1 from objects where id = $1", cid):
            mine = await sharing.keys(req, conn)
            return {"channel": (await _channels(conn, space, mine, cid) or [None])[0], "created": False}
        taken = await conn.fetchval(
            "select id from objects where space_id = $1 and type = 'channel' and deleted_at is null"
            "   and props->>'name' = $2", space, name)
        if taken:
            return _error(409, "name_taken", f"#{name} already exists here", "name")
        props = {"name": name, "topic": topic}
        async with conn.transaction():
            ckey = await _next_key(conn, space, "CH")
            await conn.execute(
                "insert into objects (id, space_id, type, key, title, props, created_by)"
                " values ($1,$2,'channel',$3,$4,$5::jsonb,$6)",
                cid, space, ckey, name, json.dumps(props), actor)
            await conn.execute(
                "insert into revisions (object_id, rev, author_id, delta) values ($1, 1, $2, $3::jsonb)",
                cid, actor, json.dumps({"props": props, "kind": "create", "note": None, "key": key}))
            if body.get("private") is True:
                # For the people added to it, starting with whoever opened it.
                await sharing.make_private(conn, cid, actor)
            await index_object(conn, cid)
        channel = (await _channels(conn, space, await sharing.keys(req, conn), cid))[0]
    return {"channel": channel, "created": True}


async def _channel(req: Request, conn, space: str, need: str):
    """(row, props, None), or the refusal: unknown and invisible read alike."""
    from commonindex.gateway import sharing

    body = await req.json()
    row, refused = await sharing.require(req, conn, body.get("channel_id"), space, need, "channel_id")
    if refused:
        return None, None, refused
    if row["type"] != "channel":
        return None, None, _error(404, "unknown_channel", "no such channel", "channel_id")
    props = await conn.fetchval("select props from objects where id = $1", row["id"])
    props = json.loads(props) if isinstance(props, str) else dict(props or {})
    return row, props, None


async def _save(conn, row, props: dict, actor: str, kind: str) -> None:
    rev = await conn.fetchval("select coalesce(max(rev), 0) + 1 from revisions where object_id = $1", row["id"])
    await conn.execute("update objects set props = $2::jsonb, title = $3, updated_at = now() where id = $1",
                       row["id"], json.dumps(props), props.get("name") or row["title"])
    await conn.execute("insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
                       row["id"], rev, actor, json.dumps({"props": props, "kind": kind}))
    await index_object(conn, row["id"])


@router.post("/api/v1/channels.update")
async def channels_update(req: Request):
    """Rename a channel, or change its topic. Anyone who may edit it."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, props, refused = await _channel(req, conn, space, "edit")
        if refused:
            return refused
        if "name" in body:
            name = str(body.get("name") or "").strip().lower()
            if not CHANNEL_NAME.match(name):
                return _error(422, "bad_name", "a channel name is 2–40 lowercase letters, digits and hyphens, "
                                               "starting with a letter or digit", "name")
            if await conn.fetchval(
                    "select 1 from objects where space_id = $1 and type = 'channel' and deleted_at is null"
                    "   and props->>'name' = $2 and id <> $3", space, name, row["id"]):
                return _error(409, "name_taken", f"#{name} already exists here", "name")
            props["name"] = name
        if "topic" in body:
            topic = _body_text(body.get("topic"))
            if topic and len(topic) > 200:
                return _error(422, "topic_too_long", "keep the topic under 200 characters", "topic")
            props["topic"] = topic
        async with conn.transaction():
            await _save(conn, row, props, actor, "update")
        from commonindex.gateway import sharing

        return {"channel": (await _channels(conn, space, await sharing.keys(req, conn), row["id"]))[0]}


@router.post("/api/v1/channels.archive")
async def channels_archive(req: Request):
    """Archive a channel — kept, readable, closed to new messages — or bring
    it back. Its owners, or for a public channel a workspace admin."""
    body, space, actor, bad = await _begin(req)
    if bad:
        return bad
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, props, refused = await _channel(req, conn, space, "manage")
        if refused:
            return refused
        props["archived"] = body.get("archived", True) is not False
        async with conn.transaction():
            await _save(conn, row, props, actor, "archive" if props["archived"] else "unarchive")
        from commonindex.gateway import sharing

        return {"channel": (await _channels(conn, space, await sharing.keys(req, conn), row["id"]))[0]}
