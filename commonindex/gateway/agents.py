"""Agents, as objects rather than as a page of numbers.

The platform has had real agent identity for a while: an `actors` row with a
kind and a trust tier, bearer tokens that are hashed and revocable, ReBAC grants
per space, and `_may_ratify` reading the tier so an agent's definitions arrive
PROPOSED where a person's arrive ratified. All of that works and is enforced on
every operation.

What it did not have was any way to SEE it. There were no agent operations at
all — an agent existed if somebody had run `mint_token.py` on the box — and the
agents page was generated in the browser: acceptance, cost, what it was
watching, all of it fiction. A governance page that invents its own numbers is
worse than no page, because it answers the auditor's question wrongly and
confidently.

So these read what is actually there and nothing else. Where the record is
empty — an agent with no owner, an agent that has never used its token — the
answer is that it is empty, which is the finding.
"""

from __future__ import annotations

import json
import re
import secrets

from asyncpg.exceptions import UniqueViolationError
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.core.authz.store import RANK, hash_token

# The same pattern `access.py` validates grant resources with. Imported
# rather than copied: two regexes for one rule is how a grant comes to be
# accepted by one door and refused by the other.
from commonindex.gateway.access import RESOURCE

router = APIRouter()

#: An actor id is a handle: it appears in `created_by` on everything the agent
#: makes, in grant subjects, and in the MCP config a client is given. Loose
#: enough to be a name, tight enough that it never needs quoting.
ACTOR_ID = re.compile(r"^[a-z][a-z0-9_-]{1,38}[a-z0-9]$")

#: What the schema allows, restated here so a bad tier is refused with the list
#: rather than as a constraint violation naming a constraint.
TIERS = ("propose-only", "auto-merge-minor", "autonomous")


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message,
                                           "field": field}})


async def _agents(pool, space: str, only: str | None = None) -> list[dict]:
    """Every agent, with what the record actually says about it.

    Four reads rather than four-per-agent: a page listing twenty agents should
    not be twenty round trips, and each of these is a single indexed scan.
    """
    rows = await pool.fetch(
        "select a.id, a.display, a.trust_tier, a.owner_id, a.created_at,"
        "       o.display as owner_display, o.kind as owner_kind"
        "  from actors a left join actors o on o.id = a.owner_id"
        " where a.kind = 'agent' and ($1::text is null or a.id = $1)"
        " order by a.id", only)
    if not rows:
        return []
    ids = [r["id"] for r in rows]

    # Grants in THIS space. An agent may hold them in several; the caller is
    # authorized for one, and showing the others would be reporting a scope
    # they cannot check.
    grants: dict[str, list[dict]] = {}
    for g in await pool.fetch(
        "select subject, relation, resource, expires_at, last_used from grants"
        " where subject = any($1::text[]) and resource = $2"
        " order by resource, relation", ids, f"space:{space}",
    ):
        grants.setdefault(g["subject"], []).append({
            "relation": g["relation"], "resource": g["resource"],
            "expires_at": g["expires_at"], "last_used": g["last_used"],
        })

    # Tokens: how many, and when one was last used. Never the token, which is
    # stored as a hash precisely so that a read like this cannot leak it.
    tokens: dict[str, dict] = {}
    for t in await pool.fetch(
        "select actor_id, count(*) as n, max(last_used) as last_used,"
        "       min(expires_at) filter (where expires_at is not null) as next_expiry"
        "  from actor_tokens where actor_id = any($1::text[]) group by actor_id", ids,
    ):
        tokens[t["actor_id"]] = {"count": t["n"], "last_used": t["last_used"],
                                 "next_expiry": t["next_expiry"]}

    # What it has actually authored here. `objects.created_by` is the record of
    # authorship the whole platform writes; this is that record read back,
    # rather than an acceptance rate computed from nothing.
    authored: dict[str, dict[str, int]] = {}
    for o in await pool.fetch(
        "select created_by, type, count(*) as n from objects"
        " where created_by = any($1::text[]) and space_id = $2 and deleted_at is null"
        " group by created_by, type", ids, space,
    ):
        authored.setdefault(o["created_by"], {})[o["type"]] = o["n"]

    # Definitions, and how many of those anybody stood behind. `ratified_by` is
    # a DECISION id rather than an actor — the decision is the thing with an
    # owner — so this counts the metric rows, not who ratified them.
    defined: dict[str, dict[str, int]] = {}
    for m in await pool.fetch(
        "select created_by, count(*) as n,"
        "       count(*) filter (where status = 'ratified') as ratified"
        "  from metrics where created_by = any($1::text[]) and space_id = $2"
        " group by created_by", ids, space,
    ):
        defined[m["created_by"]] = {"metrics": m["n"], "ratified": m["ratified"]}

    out = []
    for r in rows:
        held = grants.get(r["id"], [])
        out.append({
            "id": r["id"], "display": r["display"], "trust_tier": r["trust_tier"],
            # Null is a real answer and the page says so. An agent nobody
            # answers for is the finding, not a blank to be filled in with the
            # first plausible name.
            "owner": ({"id": r["owner_id"], "display": r["owner_display"],
                       "kind": r["owner_kind"]} if r["owner_id"] else None),
            "created_at": r["created_at"],
            "grants": held,
            # The one-line version of the grants, because "what may this agent
            # do here" is the question the page is for.
            "may": sorted({g["relation"] for g in held}) or [],
            "tokens": tokens.get(r["id"], {"count": 0, "last_used": None,
                                           "next_expiry": None}),
            "authored": authored.get(r["id"], {}),
            "defined": defined.get(r["id"], {"metrics": 0, "ratified": 0}),
            # Stated rather than left to be inferred from the tier: this is the
            # rule `_may_ratify` applies, and it is the whole difference an
            # agent's trust tier makes today.
            "may_ratify_own_work": r["trust_tier"] == "autonomous",
        })
    return out


@router.post("/api/v1/agents.list")
async def agents_list(req: Request):
    """Every agent, and what the record says about each."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json() if await req.body() else {}
    return {"agents": await _agents(state["pool"], space_of(req, body))}


@router.post("/api/v1/agents.get")
async def agents_get(req: Request):
    """One agent, with the grants and the authorship in full."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    agent_id = body.get("agent_id")
    if not agent_id:
        return _error(422, "no_agent", "name the agent to read", "agent_id")

    got = await _agents(state["pool"], space_of(req, body), agent_id)
    if not got:
        return _error(404, "unknown_agent", f"no agent {agent_id}", "agent_id")
    agent = got[0]

    # The most recent things it made, which is the honest version of an
    # activity feed until `events` is written to — that table has existed since
    # 0001 and has never had a row put in it.
    agent["recent"] = [
        {"id": r["id"], "type": r["type"], "title": r["title"],
         "created_at": r["created_at"]}
        for r in await state["pool"].fetch(
            "select id, type, title, created_at from objects"
            " where created_by = $1 and space_id = $2 and deleted_at is null"
            " order by created_at desc limit 20",
            agent_id, space_of(req, body))
    ]
    return {"agent": agent}


@router.post("/api/v1/people.list")
async def people_list(req: Request):
    """The humans, because an agent has to name one to exist.

    Its own operation rather than a field on `agents.list`: "who could answer
    for this" is a question about people, and answering it inside the agents
    response would mean every reader of that response carries a roster they did
    not ask for.
    """
    state = req.app.state.commonindex
    rows = await state["pool"].fetch(
        "select a.id, a.display, a.email, count(o.id) as agents_owned"
        "  from actors a left join actors o on o.owner_id = a.id and o.kind = 'agent'"
        " where a.kind = 'human' group by a.id, a.display, a.email order by a.display")
    return {"people": [
        {"id": r["id"], "display": r["display"], "email": r["email"],
         # How many agents this person already answers for. Accountability that
         # is spread across one person is a name on a form, not an arrangement.
         "agents_owned": r["agents_owned"]}
        for r in rows]}


@router.post("/api/v1/agents.create")
async def agents_create(req: Request):
    """Bring an agent into existence: identity, permission, credential.

    Three steps, of which exactly one was reachable through the product.
    Creating the actor meant an INSERT; minting a token meant running
    `scripts/mint_token.py` on the box. Only `access.grant` — the middle step —
    was an operation. So permissions were administrable and identity was not,
    and the only agents that existed were the ones the seed made.

    All three in one transaction, because an agent with a token and no grant can
    authenticate and do nothing, and an agent with a grant and no token is a
    permission nobody holds. Neither half is a state worth being able to reach
    by a call that half-succeeded.

    The token comes back ONCE. Only its SHA-256 is stored, which is the same
    property `mint_token.py` states: a dump of `actor_tokens` must not let the
    reader authenticate as anyone. There is no operation that can show it again
    — replacing it is the only recovery, and that is the point.

    `scripts/mint_token.py` stays. You need a token before you can call an
    admin operation, so the bootstrap cannot itself require one.
    """
    from commonindex.gateway.auth import actor_of

    state = req.app.state.commonindex
    body = await req.json()
    agent_id = (body.get("agent_id") or "").strip()
    # Whoever creates an agent owns it, unless they name someone else. Making
    # one is an admin's operation, and admins manage every agent, so there is
    # no choice to put to the person filling in the form.
    owner_id = (body.get("owner_id") or "").strip() or actor_of(req)
    tier = (body.get("trust_tier") or "propose-only").strip()

    if not ACTOR_ID.match(agent_id):
        return _error(422, "bad_agent_id",
                      f"{agent_id!r} is not an id — lowercase letters, digits, "
                      "hyphen and underscore, 3 to 40 characters. It appears in "
                      "`created_by` on everything this agent makes.", "agent_id")
    if tier not in TIERS:
        return _error(422, "bad_trust_tier",
                      f"{tier!r} is not a tier; the model defines {list(TIERS)}",
                      "trust_tier")

    grant = body.get("grant") or {}
    relation = (grant.get("relation") or "").strip() if grant else ""
    resource = (grant.get("resource") or "").strip() if grant else ""
    if grant:
        if relation not in RANK:
            return _error(422, "unknown_relation",
                          f"{relation!r} is not a relation any grant can hold; "
                          f"the model defines {sorted(RANK)}", "grant.relation")
        if not RESOURCE.match(resource):
            return _error(422, "bad_resource",
                          f"{resource!r} is not a resource — expected space:<id> "
                          "or object:<id>", "grant.resource")

    async with state["pool"].acquire() as conn:
        owner = await conn.fetchrow(
            "select id, kind from actors where id = $1", owner_id)
        if owner is None:
            return _error(404, "unknown_owner",
                          f"no actor {owner_id!r} to answer for this agent",
                          "owner_id")
        if owner["kind"] != "human":
            # A CHECK cannot read another row, so the rule that an agent
            # answers to a PERSON lives here. Without it the accountability
            # chain can be a ring: two agents naming each other, and nobody
            # answering for either.
            return _error(422, "owner_not_human",
                          f"{owner_id!r} is an agent. An agent answers to a "
                          "person — otherwise the chain closes on itself and "
                          "nobody is accountable.", "owner_id")
        if await conn.fetchrow("select 1 from actors where id = $1", agent_id):
            return _error(409, "actor_exists",
                          f"{agent_id!r} already exists", "agent_id")

        token = "ci_" + secrets.token_urlsafe(32)
        async with conn.transaction():
            await conn.execute(
                "insert into actors (id, kind, display, owner_id, trust_tier)"
                " values ($1,'agent',$2,$3,$4)",
                agent_id, (body.get("display") or agent_id).strip(), owner_id, tier)
            if grant:
                await conn.execute(
                    "insert into grants (id, subject, relation, resource, granted_by,"
                    " expires_at) values ($1,$2,$3,$4,$5,"
                    "  case when $6::int is null then null"
                    "       else now() + ($6 || ' days')::interval end)",
                    f"g-{agent_id}-{relation}-{resource.replace(':', '-')}",
                    agent_id, relation, resource, actor_of(req), grant.get("days"))
            await conn.execute(
                "insert into actor_tokens (id, actor_id, token_hash, label,"
                " created_by, expires_at) values ($1,$2,$3,$4,$5,"
                "  case when $6::int is null then null"
                "       else now() + ($6 || ' days')::interval end)",
                "tok-" + secrets.token_hex(6), agent_id, hash_token(token),
                (body.get("token_label") or "created with the agent").strip(),
                actor_of(req), body.get("expires_days"))

    return {
        "agent_id": agent_id, "owner_id": owner_id, "trust_tier": tier,
        "granted": ({"relation": relation, "resource": resource} if grant else None),
        # Once. Said in the response so a caller that logs this knows what it
        # is logging.
        "token": token,
        "token_note": "shown once and never stored — only its SHA-256 is. "
                      "Replacing it is the only recovery.",
        "may_ratify_own_work": tier == "autonomous",
        "created_by": actor_of(req),
    }


@router.post("/api/v1/agents.revoke")
async def agents_revoke(req: Request):
    """Turn an agent off: every token destroyed, every grant removed.

    The actor row STAYS. It is the attribution target for everything the agent
    ever made — `objects.created_by`, `metrics.created_by`, the decisions it is
    named in — and deleting it would either fail on a foreign key or, worse,
    cascade and take the record of what it did with it. An agent that can no
    longer authenticate and holds no permission is off. An agent whose history
    has been deleted is a governance hole wearing the word "revoked".
    """
    from commonindex.gateway.auth import actor_of

    state = req.app.state.commonindex
    body = await req.json()
    agent_id = (body.get("agent_id") or "").strip()

    async with state["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "select id, kind from actors where id = $1", agent_id)
        if row is None or row["kind"] != "agent":
            return _error(404, "unknown_agent", f"no agent {agent_id!r}", "agent_id")

        async with conn.transaction():
            tokens = await conn.fetchval(
                "with gone as (delete from actor_tokens where actor_id = $1"
                " returning 1) select count(*) from gone", agent_id)
            grants = await conn.fetchval(
                "with gone as (delete from grants where subject = $1"
                " returning 1) select count(*) from gone", agent_id)

    return {
        "agent_id": agent_id, "tokens_destroyed": tokens, "grants_removed": grants,
        # Said plainly, because "revoked" reads like "deleted" and this is not
        # that — and the difference is the whole point.
        "note": "the actor row is kept: it is what everything this agent made "
                "is attributed to.",
        "revoked_by": actor_of(req),
    }


# ── asking an agent to do something ─────────────────────────────────────────
#
# The flow was designed in the first migration and never built:
#
#     events (actor, verb, object, payload, seq)   ← zero rows, ever
#        ↓ trigger_seq
#     runs (agent, status: running | done | blocked | asking)   ← seeded only
#        ↓
#     run_steps (tool, input_ref, output_ref, objects_touched)  ← never
#
# `runs.trigger_seq` points at an event and `runs.status` includes `asking` —
# an agent that stopped to put a question to a person. The schema has been
# describing this shape for as long as it has existed.
#
# The platform does not execute anything, and this does not change that. It
# records the ASK, and an agent's runtime — whatever holds the token, an API
# model or something on a laptop — reads its inbox, starts a run against that
# event, and says how it went. The trigger is durable and the work is
# attributable; where the model runs stays none of the platform's business.


async def _next_seq(conn, space: str) -> int:
    """The next sequence number for this space.

    The UPDATE takes a row lock, which serialises writes within a space and not
    across them — 0001 says so at the table, and it is the reason the space is
    the unit of scale.
    """
    return await conn.fetchval(
        "update space_seq set next_seq = next_seq + 1 where space_id = $1"
        " returning next_seq - 1", space)


@router.post("/api/v1/agents.ask")
async def agents_ask(req: Request):
    """Ask an agent to do something about an object.

    Written as an EVENT rather than as a row in a queue of its own. The event
    log is append-only and already carries who acted, on what, and in what
    order; a parallel table would be a second history that agrees with the
    first until it does not.

    Nothing is started here. The agent reads this when it next connects — which
    is the only honest arrangement when the thing that runs it is a process
    this platform does not own and cannot wake.
    """
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    agent_id = (body.get("agent_id") or "").strip()
    object_id = (body.get("object_id") or "").strip()
    note = (body.get("note") or "").strip()

    if not note:
        return _error(422, "no_note",
                      "say what you are asking for. An agent reading `asked` with "
                      "no words has been tagged, not asked.", "note")

    async with state["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "select kind from actors where id = $1", agent_id)
        if row is None or row["kind"] != "agent":
            return _error(404, "unknown_agent", f"no agent {agent_id!r}", "agent_id")
        # An agent with no grant here can authenticate and do nothing, so an ask
        # it can never act on is worth refusing rather than leaving in an inbox
        # forever.
        if await conn.fetchval(
            "select 1 from grants where subject = $1 and resource = $2",
            agent_id, f"space:{space}",
        ) is None:
            return _error(422, "no_grant_here",
                          f"{agent_id!r} holds no grant in this space, so it could "
                          "not act on this. Grant it something first.", "agent_id")
        if object_id and await conn.fetchval(
            "select 1 from objects where id = $1 and space_id = $2 and deleted_at is null",
            object_id, space,
        ) is None:
            return _error(404, "unknown_object", f"no object {object_id!r}", "object_id")

        # The log is append-only, so a retry must not append again. The key
        # lives in the payload rather than in a column of its own: the event is
        # the record, and a dedupe table beside it would be a second history.
        key = (body.get("idempotencyKey") or "").strip()
        existing = await conn.fetchval(
            "select seq from events where space_id = $1 and verb = 'asked'"
            "   and payload->>'key' = $2", space, key)
        if existing is not None:
            return {"seq": existing, "agent_id": agent_id,
                    "object_id": object_id or None, "asked_by": actor_of(req),
                    "repeat": True,
                    "note": "already recorded under that key — asking twice does "
                            "not ask twice."}

        async with conn.transaction():
            seq = await _next_seq(conn, space)
            await conn.execute(
                "insert into events (space_id, seq, actor_id, verb, object_id, payload)"
                " values ($1,$2,$3,'asked',$4,$5::jsonb)",
                space, seq, actor_of(req), object_id or None,
                json.dumps({"agent": agent_id, "note": note, "key": key}))

    return {"seq": seq, "agent_id": agent_id, "object_id": object_id or None,
            "asked_by": actor_of(req), "repeat": False,
            "note": "recorded. Nothing runs until the agent next connects and "
                    "reads its inbox — this platform holds identity and tools, "
                    "not a runtime."}


@router.post("/api/v1/agents.inbox")
async def agents_inbox(req: Request):
    """What an agent has been asked and has not started.

    Defaults to the CALLER, which is the case that matters: an agent connects
    over MCP with its own token and asks what it should be doing. Naming
    another agent reads somebody else's queue, which a person watching them
    legitimately wants.

    "Not started" is the absence of a run against that event, rather than a
    flag on the ask — a status column would be a second place the truth lives,
    and `runs.trigger_seq` already says which event a run answers.

    Nor withdrawn: a task given back or re-asked takes its pending ask back with
    a `withdrawn` event of its own. The log is append-only, so an ask is never
    deleted — a later event answers it, the same way a run does.
    """
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json() if await req.body() else {}
    space = space_of(req, body)
    who = (body.get("agent_id") or actor_of(req) or "").strip()

    rows = await state["pool"].fetch(
        "select e.seq, e.actor_id, e.object_id, e.payload, e.ts,"
        "       o.title, o.type"
        "  from events e left join objects o on o.id = e.object_id"
        " where e.space_id = $1 and e.verb = 'asked'"
        "   and e.payload->>'agent' = $2"
        "   and not exists (select 1 from runs r"
        "                    where r.trigger_seq = e.seq and r.space_id = e.space_id)"
        "   and not exists (select 1 from events w"
        "                    where w.space_id = e.space_id and w.verb = 'withdrawn'"
        "                      and (w.payload->>'ask')::bigint = e.seq)"
        " order by e.seq limit 100", space, who)

    # An ask from a conversation about an agent or a skill names no object;
    # say what it is about the way the conversation does.
    from commonindex.gateway.messages import _subjects

    about = await _subjects(state["pool"], [r["object_id"] for r in rows if r["object_id"]
                                            and r["type"] is None], space, deleted=True)

    def subject(r):
        s = about.get(r["object_id"]) or r
        return {"id": r["object_id"], "type": s["type"], "title": s["title"]}

    def ask(r):
        p = json.loads(r["payload"]) if isinstance(r["payload"], str) else r["payload"]
        obj = subject(r) if r["object_id"] else None
        # What kind of ask it is, said rather than left to be parsed out of the
        # note: a mention names the thread to answer in, a handed task is the
        # task, and anything else was asked directly.
        thread = ({"subject_id": r["object_id"], "message_id": p["message_id"],
                   "parent_id": p.get("thread_id") or p["message_id"]}
                  if p.get("message_id") else None)
        kind = "mention" if thread else "task" if obj and obj["type"] == "task" else "ask"
        return {"seq": r["seq"], "kind": kind, "asked_by": r["actor_id"], "asked_at": r["ts"],
                "note": p.get("note"), "object": obj, "thread": thread}

    return {"agent_id": who, "asks": [ask(r) for r in rows]}


@router.post("/api/v1/runs.start")
async def runs_start(req: Request):
    """Claim an ask. One run per event, which is what stops two workers on the
    same ask both thinking they have it."""
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    seq = body.get("trigger_seq")
    who = actor_of(req)

    async with state["pool"].acquire() as conn:
        ev = await conn.fetchrow(
            "select payload from events where space_id = $1 and seq = $2 and verb = 'asked'",
            space, seq)
        if ev is None:
            return _error(404, "unknown_ask", f"no ask at seq {seq}", "trigger_seq")
        payload = json.loads(ev["payload"]) if isinstance(ev["payload"], str) else ev["payload"]
        if payload.get("agent") != who:
            # Not an authorization check — the grant already did that. This is
            # about whose queue it was in, which the grant cannot express.
            return _error(403, "not_yours",
                          f"that was asked of {payload.get('agent')!r}, not you",
                          "trigger_seq")
        if await conn.fetchval(
            "select id from runs where space_id = $1 and trigger_seq = $2", space, seq,
        ) is not None:
            return _error(409, "already_started",
                          "a run already answers that ask", "trigger_seq")
        why = await conn.fetchval(
            "select payload->>'why' from events where space_id = $1 and verb = 'withdrawn'"
            "   and (payload->>'ask')::bigint = $2", space, seq)
        if why is not None:
            return _error(409, "withdrawn",
                          f"that ask was withdrawn ({why}) — read your inbox again",
                          "trigger_seq")

        run_id = "run-" + secrets.token_hex(6)
        try:
            await conn.execute(
                "insert into runs (id, space_id, agent_id, trigger_seq, status)"
                " values ($1,$2,$3,$4,'running')", run_id, space, who, seq)
        except UniqueViolationError:
            # The SELECT above is a check, not a lock: two workers that both read
            # before either writes both pass it. `runs_one_per_ask` (0018) is what
            # actually makes one run per ask true, and this is the loser of that
            # race getting the same answer it would have got a millisecond earlier.
            return _error(409, "already_started",
                          "a run already answers that ask", "trigger_seq")

    return {"run_id": run_id, "trigger_seq": seq, "status": "running"}


@router.post("/api/v1/runs.finish")
async def runs_finish(req: Request):
    """Say how it went, and what it cost.

    `asking` is a real ending and not a failure: an agent that stopped to put a
    question to a person has done the right thing, and the status has said so
    since 0001.
    """
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    run_id = (body.get("run_id") or "").strip()
    status = (body.get("status") or "").strip()

    if status not in ("done", "blocked", "asking"):
        return _error(422, "bad_status",
                      "a run ends done, blocked, or asking — `asking` being an "
                      "agent that stopped to put a question to a person, which "
                      "is a right answer and not a failure", "status")

    async with state["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "select agent_id, status from runs where id = $1 and space_id = $2",
            run_id, space)
        if row is None:
            return _error(404, "unknown_run", f"no run {run_id!r}", "run_id")
        if row["agent_id"] != actor_of(req):
            return _error(403, "not_yours", "that is not your run", "run_id")
        if row["status"] != "running":
            return _error(409, "already_finished",
                          f"that run already ended {row['status']}", "run_id")
        await conn.execute(
            "update runs set status = $2, ended_at = now(),"
            " cost_tokens = $3, cost_usd = $4 where id = $1",
            run_id, status, int(body.get("cost_tokens") or 0),
            body.get("cost_usd") or 0)

    return {"run_id": run_id, "status": status}
