"""Put a working board on the dev database — through the verbs, not around them.

Every task here is filed, handed over, started, asked about, filed for review
and accepted by calling the same handlers the gateway serves, as the actor who
would really do it: so each card got where it is the way a real one would, with
the history, events and runs that implies. Only the clock is moved afterwards,
so a review that "waited five days" reads that way.

    uv run python scripts/seed_tasks.py            # add the board (safe to re-run)
    uv run python scripts/seed_tasks.py --remove   # take it off again

Like seed_dev.py, this is the dev database (COMMONINDEX_DEV_DSN), never the one the
tests reset.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

DSN = os.environ.get("COMMONINDEX_DEV_DSN", "postgresql://localhost/commonindex_dev")
SPACE = "pay"


class _Pool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Held:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_):
                return False

        return _Held()


class _Req:
    """What a handler reads from a request that already passed the gateway's
    authorization check — which is why every actor used here holds a grant."""

    def __init__(self, conn, actor, body):
        self._body = body
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": actor})(),
                                    "space": SPACE})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {"pool": _Pool(conn)}})()})()

    async def json(self):
        return self._body

    async def body(self):
        return json.dumps(self._body).encode()


class Board:
    def __init__(self, conn):
        self.conn = conn
        self.n = 0

    async def do(self, verb, actor, **body):
        from commonindex.gateway import agents, tasks

        self.n += 1
        body.setdefault("idempotencyKey", f"seed-step-{body.get('task_id', 'x')}-{self.n}")
        handler = getattr(tasks, f"tasks_{verb}", None) or getattr(agents, verb)
        out = await handler(_Req(self.conn, actor, body))
        if hasattr(out, "status_code"):
            raise SystemExit(f"{verb} as {actor} failed: {json.loads(out.body)['error']}")
        return out

    async def file(self, slug, actor, title, criteria=(), human_only=None, detail=None):
        out = await self.do("propose", actor, idempotencyKey=f"seed:{slug}", title=title,
                            criteria=list(criteria), human_only=human_only, detail=detail)
        return out["task"], out["created"]

    async def rev(self, task_id):
        return await self.conn.fetchval("select current_rev from objects where id = $1", task_id)

    async def run(self, agent, task_id, *, finish=None, cost=0.0, minutes=0.0):
        """The agent reads its inbox and claims the ask for this task."""
        inbox = await self.do("runs_start", agent, trigger_seq=await self.conn.fetchval(
            "select (props->>'ask_seq')::bigint from objects where id = $1", task_id))
        await self.conn.execute(
            "update runs set started_at = now() - make_interval(secs => $2) where id = $1",
            inbox["run_id"], minutes * 60)
        if finish:
            await self.do("runs_finish", agent, run_id=inbox["run_id"], status=finish,
                          cost_usd=cost, cost_tokens=int(cost * 40_000))
        return inbox["run_id"]

    async def link(self, task_id, object_id, rel):
        if await self.conn.fetchval("select 1 from objects where id = $1 and space_id = $2"
                                    "   and deleted_at is null", object_id, SPACE):
            await self.do("link", "alex", task_id=task_id, object_id=object_id, rel=rel)

    async def age(self, task_id, filed_days, moved_days):
        """Spread the history between when it was filed and when it last moved."""
        revs = [r["rev"] for r in await self.conn.fetch(
            "select rev from revisions where object_id = $1 order by rev", task_id)]
        for i, rev in enumerate(revs):
            f = i / max(1, len(revs) - 1)
            days = filed_days + (moved_days - filed_days) * f
            await self.conn.execute(
                "update revisions set ts = now() - make_interval(secs => $3)"
                " where object_id = $1 and rev = $2", task_id, rev, days * 86400)
        moved = (datetime.now(tz=UTC) - timedelta(days=moved_days)).isoformat()
        props = json.loads(await self.conn.fetchval("select props from objects where id = $1", task_id))
        props["moved_at"] = moved
        for k in ("submitted_at", "decided_at"):
            if (props.get("review") or {}).get(k):
                props["review"][k] = moved
        if props.get("question"):
            props["question"]["at"] = moved
        await self.conn.execute(
            "update objects set props = $2::jsonb, created_at = now() - make_interval(secs => $3),"
            " updated_at = now() - make_interval(secs => $4) where id = $1",
            task_id, json.dumps(props), filed_days * 86400, moved_days * 86400)


async def seed(conn) -> None:
    b = Board(conn)
    # a real experiment and dashboard to hang provenance on, where the dev
    # database has them
    exp = await conn.fetchval("select id from objects where space_id = $1 and type = 'experiment'"
                              "   and deleted_at is null order by created_at limit 1", SPACE)
    dash = await conn.fetchval("select id from objects where space_id = $1 and type = 'dashboard'"
                               "   and deleted_at is null order by created_at limit 1", SPACE)

    # ── ready ──
    t, new = await b.file("retry-ceiling", "scribe", "Sync the retry ceiling across the payments specs",
                          ["Every spec citing the retry handler states the same number",
                           "The number matches whichever source the D-12 conflict resolves to",
                           "Each edit cites the PR that changed it"])
    if new:
        await b.age(t["id"], 1, 1)
    t, new = await b.file("partial-refunds", "maya", "Decide whether partial refunds count in refund_rate",
                          human_only="A ratification, not a task — finance and product each own a live "
                                     "definition and someone with standing has to choose.")
    if new:
        if dash:
            await b.link(t["id"], dash, "touches")
        await b.age(t["id"], 4, 4)
    t, new = await b.file("changelog-24", "alex", "Draft the changelog for the 2.4 release train",
                          ["One entry per release that reached live",
                           "Each entry cites its release and PRs",
                           "Rolled-back releases are excluded"])
    if new:
        await b.age(t["id"], 0.2, 0.2)
    t, new = await b.file("support-interviews", "maya", "Interview three support leads about refund escalations",
                          human_only="Talking to people. No amount of context makes this agent work.")
    if new:
        await b.age(t["id"], 2, 2)

    # ── in progress ──
    t, new = await b.file("close-flags", "alex", "Close flags whose experiment decided over 30 days ago",
                          ["Every closed flag names the experiment that decided it",
                           "No flag with live traffic on the losing arm is touched",
                           "Call sites are listed in the proposal"])
    if new:
        if exp:
            await b.link(t["id"], exp, "caused")
        await b.do("hand", "alex", task_id=t["id"], agent_id="triage", if_rev=await b.rev(t["id"]))
        await b.age(t["id"], 1, 0.01)
        await b.run("triage", t["id"], minutes=4.2)
    t, new = await b.file("incident-actions", "maya", "Extract action items from the incident review call",
                          ["Each item is anchored to the timestamp it was agreed at",
                           "Each has a named owner from the transcript",
                           "Nothing is filed that was not stated as a commitment"])
    if new:
        await b.do("hand", "maya", task_id=t["id"], agent_id="scribe", if_rev=await b.rev(t["id"]),
                   note="The call recording is in the incident doc.")
        await b.age(t["id"], 0.5, 0.01)
        await b.run("scribe", t["id"], minutes=1.8)
    t, new = await b.file("reconcile-spec", "alex", "Reconcile the refund flow spec with what shipped",
                          ["The spec matches the merged handler",
                           "The retry number is consistent with the ratified decision"])
    if new:
        await b.do("hand", "alex", task_id=t["id"], agent_id="scribe", if_rev=await b.rev(t["id"]))
        await b.run("scribe", t["id"], finish="asking", cost=0.64, minutes=18)
        await b.do("question", "scribe", task_id=t["id"],
                   question="D-12 says three retries and the merged handler does five. Which one "
                            "should the spec state?")
        await b.age(t["id"], 1, 0.08)
    t, new = await b.file("guest-onboarding", "maya", "Rewrite the guest checkout onboarding for the new flow",
                          ["Covers the three entry points the redesign added",
                           "A new engineer can land a change after reading it"])
    if new:
        await b.do("start", "maya", task_id=t["id"])
        await b.age(t["id"], 3, 2)

    # ── in review ──
    t, new = await b.file("nine-specs", "scribe", "Sync nine specs after the retry handler changed",
                          ["Every affected spec is updated",
                           "The ratified exception in D-31 is left alone",
                           "Each edit cites the triggering PR"])
    if new:
        await b.do("hand", "alex", task_id=t["id"], agent_id="scribe", if_rev=await b.rev(t["id"]))
        await b.run("scribe", t["id"], finish="done", cost=0.41, minutes=12)
        await b.do("submit", "scribe", task_id=t["id"], criteria_met=[True, True, True],
                   produced={"label": "9 spec edits, one proposal"},
                   note="D-31's exception spec is untouched.")
        await b.age(t["id"], 3, 2)
    t, new = await b.file("weekly-changelog", "alex", "Changelog entries for the releases that shipped this week",
                          ["One entry per live release", "The rolled-back release is excluded"])
    if new:
        await b.do("hand", "alex", task_id=t["id"], agent_id="analyst", if_rev=await b.rev(t["id"]))
        await b.run("analyst", t["id"], finish="done", cost=0.12, minutes=3)
        await b.do("submit", "analyst", task_id=t["id"], criteria_met=[True, True],
                   produced={"label": "4 changelog entries"})
        await b.age(t["id"], 2, 1)
    t, new = await b.file("funnel", "maya", "Instrument the checkout drop-off funnel",
                          ["Each step of checkout emits one event", "The funnel dashboard reads them"])
    if new:
        if exp:
            await b.link(t["id"], exp, "touches")
        if dash:
            await b.link(t["id"], dash, "depends")
        await b.do("start", "maya", task_id=t["id"])
        await b.do("submit", "maya", task_id=t["id"], criteria_met=[True, False],
                   note="The dashboard needs one more metric ratified before it can read the last step.")
        await b.age(t["id"], 8, 5)
    t, new = await b.file("stale-flags", "alex", "Close stale flags from decided experiments",
                          ["Only flags whose experiment decided are closed",
                           "Each closure cites the decision"])
    if new:
        await b.do("hand", "alex", task_id=t["id"], agent_id="triage", if_rev=await b.rev(t["id"]))
        await b.run("triage", t["id"], finish="done", cost=0.22, minutes=6)
        await b.do("submit", "triage", task_id=t["id"], criteria_met=[True, True],
                   produced={"label": "3 flags closed"})
        await b.age(t["id"], 4, 3)

    # ── done ──
    t, new = await b.file("idempotency-doc", "alex", "Document the idempotency contract for webhooks",
                          ["Covers retries and duplicate deliveries", "Cites the ratified decision"])
    if new:
        await b.do("hand", "alex", task_id=t["id"], agent_id="scribe", if_rev=await b.rev(t["id"]))
        await b.run("scribe", t["id"], finish="done", cost=0.3, minutes=9)
        await b.do("submit", "scribe", task_id=t["id"], criteria_met=[True, True],
                   produced={"label": "Webhook idempotency doc"})
        await b.do("accept", "maya", task_id=t["id"], if_rev=await b.rev(t["id"]))
        await b.age(t["id"], 6, 4)
    t, new = await b.file("express-lane", "maya", "Ship express lane to 100% after the readout",
                          ["The readout recorded a ship decision", "The flag is at 100% everywhere"])
    if new:
        await b.do("start", "maya", task_id=t["id"])
        await b.do("submit", "maya", task_id=t["id"], criteria_met=[True, True])
        await b.do("accept", "alex", task_id=t["id"], if_rev=await b.rev(t["id"]))
        await b.age(t["id"], 9, 6)

    n = await conn.fetchval("select count(*) from objects where space_id = $1 and type = 'task'"
                            "   and deleted_at is null", SPACE)
    print(f"  board has {n} tasks")


SLUGS = ["retry-ceiling", "partial-refunds", "changelog-24", "support-interviews", "close-flags",
         "incident-actions", "reconcile-spec", "guest-onboarding", "nine-specs", "weekly-changelog",
         "funnel", "stale-flags", "idempotency-doc", "express-lane"]


async def remove(conn) -> None:
    """Hard-delete the seeded tasks, with the asks and runs they caused.

    A dev reset, and the one place anything here deletes from the event log:
    left behind, the seeded asks would sit in the agents' inboxes pointing at
    tasks that no longer exist.
    """
    ids = [f"task-{hashlib.sha256(f'{SPACE}:seed:{s}'.encode()).hexdigest()[:12]}" for s in SLUGS]
    async with conn.transaction():
        await conn.execute(
            "delete from runs where space_id = $1 and trigger_seq in (select seq from events"
            " where space_id = $1 and object_id = any($2::text[]))", SPACE, ids)
        await conn.execute("delete from events where space_id = $1 and object_id = any($2::text[])",
                           SPACE, ids)
        await conn.execute("delete from edges where src = any($1::text[])", ids)
        await conn.execute("delete from revisions where object_id = any($1::text[])", ids)
        n = await conn.fetchval("with d as (delete from objects where id = any($1::text[])"
                                " returning 1) select count(*) from d", ids)
    print(f"  removed {n} seeded tasks")


async def main() -> None:
    import asyncpg

    ap = argparse.ArgumentParser()
    ap.add_argument("--remove", action="store_true")
    args = ap.parse_args()
    conn = await asyncpg.connect(DSN)
    try:
        await (remove(conn) if args.remove else seed(conn))
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
