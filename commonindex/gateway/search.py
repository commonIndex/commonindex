"""Search the workspace: find a thing by what it is called, or by what it says.

It worked out every item's keywords on every search — correct, and four
seconds at 300,000 chunks. It now reads stored indexes, the way code search
has Zoekt, and filters by the caller's permission keys:

* quick find — a trigram index on each item's key and title (0022), so a
  fragment ("arehous") or a typo ("warehuses") finds it as you type, the way
  jumping to a file works in code search;
* content — `chunks`, which the indexer keeps for every type on each save:
  words matched in their forms ("refunds" finds "refund"), each chunk's
  heading weighted above its body, every word a prefix because the last one is
  always half-typed, and a snippet with the matching words marked, made only
  for the results returned;
* what was said — a word index on messages, each naming what it was about;
* agents, by name;
* what a page shows that is stored beside it — a dashboard's panels, an
  experiment's registration, readouts and decisions — indexed as sections of
  the item (commonindex/workers/parts.py), so the result is the page;
* code, by what its lines say, from code search's own chunks;
* the definitions — metrics and datasets — by their names and descriptions;
* agents' runs, by what each was asked;
* earlier versions, by what an item said before it was edited.

A dashboard's current numbers are not indexed: they would be stale by the next
load. Reading a dashboard runs it, and says them.

Three operations: `search.query` finds, `search.read` opens one item the way
the index holds it — its sections, its conversation, its links — and
`workspace.ask` answers a question by doing both, several times, the way a
person would (commonindex/core/retrieval/ask.py). Search and read are the grep and
the read of this workspace; an agent over MCP uses them the same way.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

#: The collections a person opens a page for. Panels, readouts and decisions
#: are found through the thing they belong to, as sections of it.
SEARCHABLE = ("dashboard", "doc", "experiment", "design", "task", "channel")

#: What is found beside the items, each from its own index, in this order,
#: and how many of each a search shows — unless it asked for that kind alone,
#: when it pages. Code comes last and fewest: it matches nearly any word, and
#: Code query is where it is searched properly.
BESIDE = {"agent": 5, "message": 8, "metric": 5, "dataset": 3, "run": 3, "code": 3, "history": 3}

#: The word indexes 0023 built, repeated exactly: an expression index is used
#: only by a query that says the same expression.
_METRIC_WORDS = ("to_tsvector('english', m.label || ' ' || m.description || ' '"
                 " || coalesce(m.unit, '') || ' ' || m.expr)")
_DATASET_WORDS = ("to_tsvector('english', translate(d.name, '._-', '   ') || ' ' || d.description"
                  " || ' ' || d.caveats || ' ' || d.grain_note)")
_ASKED_WORDS = ("to_tsvector('english', coalesce(e.payload->>'agent', '') || ' '"
                " || coalesce(e.payload->>'note', ''))")

#: How long reading a dashboard waits for its panels to run.
NUMBERS_SECONDS = 10

#: How close a misspelling may be, 1 being the same word. Measured on this
#: workspace's titles: real typos score 0.58-0.71 ("recocile" → Reconcile,
#: "warehuses" → warehouses) and a different word 0.5 ("retries" → entries).
TYPO = 0.55

#: The marks around matched words in a snippet; the palette renders them.
HEADLINE = "StartSel=«, StopSel=», MaxWords=28, MinWords=10, MaxFragments=1, ShortWord=2"

#: Conversations shown beside the items, unless they are what was asked for.
MESSAGES = 8

#: How much of one item a read returns. An agent reads more by searching
#: within it; a person opens the page.
READ_CHARS = 12_000

_FIND = "(coalesce(o.key, '') || ' ' || o.title)"


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def _like(q: str) -> str:
    """The query as a literal inside LIKE: its wildcards are text."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def _keys(req: Request, db, actor: str) -> list[str]:
    from commonindex.core.authz.store import PgChecker

    checker = req.app.state.commonindex.get("checker") or PgChecker(db)
    return await checker.acl_keys_for(actor)


@dataclass(frozen=True, slots=True)
class Filters:
    #: None is everything: every searchable type, and conversations and agents.
    #: Named, it is those — "message" and "agent" among them to include those.
    types: tuple[str, ...] | None = None
    #: Who wrote it: an item's creator, a message's author.
    author: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    #: One conversation — the messages about this item, or in this channel.
    within: str | None = None
    offset: int = 0
    limit: int = 20

    def objects(self) -> list[str]:
        if self.within:
            return []
        return [t for t in (self.types or SEARCHABLE) if t in SEARCHABLE]

    def alone(self, kind: str) -> bool:
        """Asked for this kind and nothing else: it pages, the way items do."""
        return self.types == (kind,) or (kind == "message" and bool(self.within))

    def wants(self, kind: str) -> bool:
        if self.within:
            return kind == "message"
        if self.types is not None and kind not in self.types:
            return False
        if self.author and kind in ("code", "history"):
            return False   # nobody is on record as having written these
        # Beside the items, a kind shows on the first page only.
        return self.alone(kind) or not self.offset

    def cap(self, kind: str) -> int:
        return self.limit if self.alone(kind) else min(BESIDE[kind], self.limit)

    def skip(self, kind: str) -> int:
        return self.offset if self.alone(kind) else 0


def _when(value: Any, field: str) -> datetime | None:
    if not value:
        return None
    try:
        at = datetime.fromisoformat(str(value))
    except ValueError as e:
        raise ValueError(f"{field} is a date like 2026-09-01") from e
    return at if at.tzinfo else at.replace(tzinfo=UTC)


def filters_from(body: dict[str, Any]) -> Filters:
    types = body.get("types")
    return Filters(
        types=tuple(str(t) for t in types) if isinstance(types, list) and types else None,
        author=str(body["author"]).strip() or None if body.get("author") else None,
        since=_when(body.get("since"), "since"), until=_when(body.get("until"), "until"),
        within=str(body["within"]).strip() or None if body.get("within") else None,
        offset=max(0, int(body.get("offset") or 0)),
        limit=max(1, min(int(body.get("limit") or 20), 50)),
    )


async def find(conn, *, space: str, keys: list[str], q: str, f: Filters,
               any_word: bool = False) -> dict[str, Any]:
    """Items, agents and messages matching `q` that these keys may read, best first.

    Every word must match — a search box's rule, so a half-typed query
    narrows. `any_word` is a question's rule instead: an item matches on any
    of its words, and the more of them it holds the higher it ranks, since
    "why do partial refunds matter for refund rate" is not written anywhere
    whole."""
    from commonindex.gateway.messages import _actors, _subjects

    q = " ".join(q.split())[:200]
    if not q or not keys:
        return {"q": q, "hits": [], "more": False}
    kinds = f.objects()
    window = f.offset + f.limit + 1
    # Every word a prefix, parsed the way the index was: english stems, so the
    # query and the chunks agree on what a word is.
    # A question's words are whole: "back" is not "background". Prefixes are
    # for a search box, where the last word is still being typed.
    tsq = await conn.fetchval(
        "select string_agg(quote_literal(l) || $3, $2)"
        "  from unnest(tsvector_to_array(to_tsvector('english', $1))) l",
        q, " | " if any_word else " & ", "" if any_word else ":*")

    def by(a: int) -> str:
        """Who made it and when it changed, as parameters $a, $a+1 and $a+2."""
        return (f" and (${a}::text is null or o.created_by = ${a})"
                f" and (${a + 1}::timestamptz is null or o.updated_at >= ${a + 1})"
                f" and (${a + 2}::timestamptz is null or o.updated_at < ${a + 2})")

    found: list[Any] = []
    content: list[Any] = []
    if kinds:
        async with conn.transaction():
            await conn.execute(f"set local pg_trgm.word_similarity_threshold = {TYPO}")
            found = await conn.fetch(
                f"select o.id, o.type, o.key, o.title, o.updated_at,"
                f"       lower(coalesce(o.key, '')) = lower($2) as exact,"
                f"       lower(o.title) like lower($3) || '%' escape '\\' as prefix,"
                f"       {_FIND} ilike '%' || $3 || '%' escape '\\' as substr,"
                f"       word_similarity($2, {_FIND}) + similarity($2, {_FIND}) as closeness"
                f"  from objects o"
                f" where o.space_id = $1 and o.deleted_at is null and o.type = any($4::text[])"
                f"   and o.acl_keys && $5 {by(6)}"
                f"   and ({_FIND} ilike '%' || $3 || '%' escape '\\' or $2 <% {_FIND})"
                # Among titles that match, the one closest to the whole query
                # first: "Two warehouses" before a task that merely mentions it.
                f" order by exact desc, prefix desc, substr desc, closeness desc, o.updated_at desc"
                f" limit $9",
                space, q, _like(q), kinds, keys, f.author, f.since, f.until, window)
        if tsq:
            # The best chunk of each item, then snippets for those alone —
            # ts_headline reads the whole text, so it runs on what is shown.
            content = await conn.fetch(
                "with hits as ("
                "  select c.id, c.object_id, ts_rank(c.tsv, to_tsquery('english', $2)) as rank,"
                "         o.type, o.key, o.title, o.updated_at"
                "    from chunks c join objects o on o.id = c.object_id and o.deleted_at is null"
                "   where c.space_id = $1 and c.object_type = any($3::text[]) and c.acl_keys && $4"
                f"    and c.tsv @@ to_tsquery('english', $2) {by(5)}"
                "   order by rank desc limit 400),"
                " best as (select distinct on (object_id) * from hits order by object_id, rank desc),"
                " top as (select * from best order by rank desc, updated_at desc limit $8)"
                " select t.*, regexp_replace(ts_headline('english', c.body, to_tsquery('english', $2),"
                f"        '{HEADLINE}'), '\\s+', ' ', 'g') as snippet"
                "   from top t join chunks c on c.id = t.id order by t.rank desc, t.updated_at desc",
                space, tsq, kinds, keys, f.author, f.since, f.until, window)

    said: list[Any] = []
    said_limit = f.cap("message")
    if tsq and f.wants("message"):
        said = await conn.fetch(
            "with hits as ("
            "  select m.id, m.subject_id, m.author_id, m.body, m.created_at from messages m"
            "    left join objects o on o.id = m.subject_id"
            "   where m.space_id = $1 and m.deleted_at is null"
            "     and to_tsvector('english', m.body) @@ to_tsquery('english', $2)"
            "     and (o.id is null or (o.deleted_at is null and o.acl_keys && $3))"
            "     and ($4::text is null or m.author_id = $4)"
            "     and ($5::timestamptz is null or m.created_at >= $5)"
            "     and ($6::timestamptz is null or m.created_at < $6)"
            "     and ($7::text is null or m.subject_id = $7)"
            "   order by m.created_at desc limit $8 offset $9)"
            " select h.id, h.subject_id, h.author_id, h.created_at,"
            "        regexp_replace(ts_headline('english', h.body, to_tsquery('english', $2),"
            f"          '{HEADLINE}'), '\\s+', ' ', 'g') as snippet"
            "   from hits h order by h.created_at desc",
            space, tsq, keys, f.author, f.since, f.until, f.within, said_limit + 1, f.skip("message"))

    agents: list[Any] = []
    if f.wants("agent") and not f.author:
        agents = await conn.fetch(
            "select id, display from actors where kind = 'agent'"
            "   and (display ilike '%' || $1 || '%' escape '\\' or id ilike '%' || $1 || '%' escape '\\')"
            " order by display limit $2 offset $3", _like(q), f.cap("agent") + 1, f.skip("agent"))
    subjects = await _subjects(conn, [m["subject_id"] for m in said], space, deleted=False)
    authors = await _actors(conn, [m["author_id"] for m in said])

    ranked: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(o, object_id: str, snippet: str | None) -> None:
        if object_id in seen:
            return
        seen.add(object_id)
        ranked.append({"kind": "object", "type": o["type"], "id": object_id, "key": o["key"],
                       "title": o["title"], "snippet": snippet,
                       "at": o["updated_at"].isoformat() if o["updated_at"] else None})

    # What the name says outright, then what the content says, then what the
    # name only nearly says: a typo match is the fallback, never ahead of a
    # page that actually contains the words.
    named = [o for o in found if o["exact"] or o["prefix"] or o["substr"]]
    for o in named:
        add(o, o["id"], None)   # found by name: the title says itself
    for o in content:
        # A snippet with nothing marked matched in the heading — the title,
        # already on the result — and would only repeat the chunk's first words.
        add(o, o["object_id"], o["snippet"] if "«" in (o["snippet"] or "") else None)
    for o in found:
        if o not in named:
            add(o, o["id"], None)
    hits = ranked[f.offset:f.offset + f.limit]

    beside: dict[str, list[dict[str, Any]]] = {
        "agent": [{"kind": "agent", "type": "agent", "id": a["id"], "key": None,
                   "title": a["display"], "snippet": None, "at": None} for a in agents],
        "message": [],
    }
    for m in said:
        subject = subjects.get(m["subject_id"])
        if subject is None:
            continue
        who = authors.get(m["author_id"]) or {"id": m["author_id"], "name": m["author_id"], "kind": "human"}
        beside["message"].append({
            "kind": "message", "type": "message", "id": m["id"], "key": None,
            "title": subject["title"], "snippet": m["snippet"],
            "at": m["created_at"].isoformat(), "author": who,
            "subject": {k: subject[k] for k in ("id", "type", "key", "title")},
        })
    # The space's definitions are its members': a metric has no keys of its own.
    member = f"space:{space}" in keys
    beside["metric"] = (await _metrics(conn, space, keys, tsq, f)
                        if tsq and member and f.wants("metric") else [])
    beside["dataset"] = await _datasets(conn, space, tsq, f) if tsq and member and f.wants("dataset") else []
    beside["run"] = await _runs(conn, space, keys, tsq, f) if tsq and f.wants("run") else []
    beside["code"] = await _code(conn, space, keys, tsq, f) if tsq and f.wants("code") else []

    more = len(ranked) > f.offset + f.limit or any(len(v) > f.cap(k) for k, v in beside.items())
    for kind, found_beside in beside.items():
        hits += found_beside[:f.cap(kind)]
    if tsq and f.wants("history"):
        # Earlier versions of what is not already here: the page itself is the
        # better result when it still says it.
        earlier = await _history(conn, space, keys, tsq, f, {h["id"] for h in hits})
        more = more or len(earlier) > f.cap("history")
        hits += earlier[:f.cap("history")]
    return {"q": q, "hits": hits, "more": more}


def _iso(at: Any) -> str | None:
    return at.isoformat() if at else None


async def _code(conn, space: str, keys: list[str], tsq: str, f: Filters) -> list[dict[str, Any]]:
    """Code files by what their lines say — code search's chunks, a snippet
    from the best of each file, and the lines it spans."""
    rows = await conn.fetch(
        "with hits as ("
        "  select c.id, c.object_id, ts_rank(c.tsv, to_tsquery('english', $2)) as rank"
        "    from chunks c join objects o on o.id = c.object_id and o.deleted_at is null"
        "   where c.space_id = $1 and c.object_type = 'code_file' and c.acl_keys && $3"
        "     and c.tsv @@ to_tsquery('english', $2)"
        "   order by rank desc limit 400),"
        " best as (select distinct on (object_id) * from hits order by object_id, rank desc),"
        " top as (select * from best order by rank desc limit $4 offset $5)"
        " select t.object_id, c.start_line, c.end_line, o.title, o.updated_at, r.title as repo,"
        "        regexp_replace(ts_headline('english', c.body, to_tsquery('english', $2),"
        f"          '{HEADLINE}'), '\\s+', ' ', 'g') as snippet"
        "   from top t join chunks c on c.id = t.id join objects o on o.id = t.object_id"
        "   left join objects r on r.id = o.props->>'repo_id'"
        "  order by t.rank desc",
        space, tsq, keys, f.cap("code") + 1, f.skip("code"))
    return [{"kind": "code", "type": "code_file", "id": r["object_id"], "key": None, "title": r["title"],
             "snippet": r["snippet"], "at": _iso(r["updated_at"]), "repo": r["repo"],
             "lines": [r["start_line"], r["end_line"]]} for r in rows]


async def _used_on(conn, keys: list[str], metric_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """The dashboards charting each metric, that these keys may read."""
    out: dict[str, list[dict[str, Any]]] = {}
    if not metric_ids:
        return out
    for r in await conn.fetch(
            "select distinct pb.metric_id, o.id, o.key, o.title from panel_bindings pb"
            "  join objects o on o.id = pb.dashboard_id and o.deleted_at is null and o.acl_keys && $2"
            " where pb.metric_id = any($1::text[]) order by pb.metric_id, o.title", metric_ids, keys):
        on = out.setdefault(r["metric_id"], [])
        if len(on) < 3:
            on.append({"id": r["id"], "type": "dashboard", "key": r["key"], "title": r["title"]})
    return out


async def _metrics(conn, space: str, keys: list[str], tsq: str, f: Filters) -> list[dict[str, Any]]:
    """Definitions by their name, description or expression — the latest
    version of each, and where it is charted."""
    rows = await conn.fetch(
        f"select m.id, m.label, m.status, m.created_at,"
        f"       ts_rank({_METRIC_WORDS}, to_tsquery('english', $2)) as rank,"
        f"       regexp_replace(ts_headline('english', m.label || '. ' || m.description || ' ' || m.expr,"
        f"         to_tsquery('english', $2), '{HEADLINE}'), '\\s+', ' ', 'g') as snippet"
        f"  from metrics m"
        f" where m.space_id in ($1, '*') and {_METRIC_WORDS} @@ to_tsquery('english', $2)"
        f"   and m.version = (select max(x.version) from metrics x"
        f"                     where x.id = m.id and x.space_id = m.space_id)"
        f"   and ($3::text is null or m.created_by = $3)"
        f"   and ($4::timestamptz is null or m.created_at >= $4)"
        f"   and ($5::timestamptz is null or m.created_at < $5)"
        f" order by rank desc, m.label limit $6 offset $7",
        space, tsq, f.author, f.since, f.until, f.cap("metric") + 1, f.skip("metric"))
    from commonindex.gateway.sharing import hidden_metrics

    # Named after the panel of a dashboard the caller cannot see: not found.
    hidden = await hidden_metrics(conn, space, keys)
    rows = [r for r in rows if r["id"] not in hidden]
    used = await _used_on(conn, keys, [r["id"] for r in rows])
    return [{"kind": "metric", "type": "metric", "id": r["id"], "key": None, "title": r["label"],
             "snippet": r["snippet"], "at": _iso(r["created_at"]), "status": r["status"],
             "used_on": used.get(r["id"], [])} for r in rows]


async def _datasets(conn, space: str, tsq: str, f: Filters) -> list[dict[str, Any]]:
    """Tables the warehouse declares, by name, description and caveats."""
    rows = await conn.fetch(
        f"select d.id, d.name, d.updated_at,"
        f"       ts_rank({_DATASET_WORDS}, to_tsquery('english', $2)) as rank,"
        f"       regexp_replace(ts_headline('english', translate(d.name, '._-', '   ') || '. '"
        f"         || d.description || ' ' || d.caveats, to_tsquery('english', $2), '{HEADLINE}'),"
        f"         '\\s+', ' ', 'g') as snippet"
        f"  from datasets d"
        f" where d.space_id in ($1, '*') and {_DATASET_WORDS} @@ to_tsquery('english', $2)"
        f"   and ($3::text is null or d.created_by = $3)"
        f"   and ($4::timestamptz is null or d.updated_at >= $4)"
        f"   and ($5::timestamptz is null or d.updated_at < $5)"
        f" order by rank desc, d.name limit $6 offset $7",
        space, tsq, f.author, f.since, f.until, f.cap("dataset") + 1, f.skip("dataset"))
    return [{"kind": "dataset", "type": "dataset", "id": r["id"], "key": None, "title": r["name"],
             "snippet": r["snippet"], "at": _iso(r["updated_at"])} for r in rows]


#: An ask is readable by whoever may read what it was about: the item it names,
#: and the thread it was made in. ($3 is the reader's keys.)
_ASK_READABLE = (
    "(e.object_id is null or exists (select 1 from objects so where so.id = e.object_id"
    "   and so.deleted_at is null and so.acl_keys && $3))"
    " and (e.payload->>'thread_id' is null or not exists (select 1 from messages mm"
    "   join objects so on so.id = mm.subject_id"
    "  where mm.id = e.payload->>'thread_id' and (so.deleted_at is not null or not so.acl_keys && $3)))")


async def _runs(conn, space: str, keys: list[str], tsq: str, f: Filters) -> list[dict[str, Any]]:
    """Agents' runs, by what each was asked — the author filter is the agent."""
    from commonindex.gateway.messages import _actors

    rows = await conn.fetch(
        f"select r.id, r.agent_id, r.status, r.started_at, e.actor_id as asked_by,"
        f"       regexp_replace(ts_headline('english', coalesce(e.payload->>'note', ''),"
        f"         to_tsquery('english', $2), '{HEADLINE}'), '\\s+', ' ', 'g') as snippet"
        f"  from events e join runs r on r.space_id = e.space_id and r.trigger_seq = e.seq"
        f" where e.space_id = $1 and e.verb = 'asked' and {_ASKED_WORDS} @@ to_tsquery('english', $2)"
        f"   and {_ASK_READABLE}"
        f"   and ($4::text is null or r.agent_id = $4)"
        f"   and ($5::timestamptz is null or r.started_at >= $5)"
        f"   and ($6::timestamptz is null or r.started_at < $6)"
        f" order by r.started_at desc nulls last limit $7 offset $8",
        space, tsq, keys, f.author, f.since, f.until, f.cap("run") + 1, f.skip("run"))
    people = await _actors(conn, [x for r in rows for x in (r["agent_id"], r["asked_by"]) if x])

    def who(actor_id):
        return people.get(actor_id) or {"id": actor_id, "name": actor_id, "kind": "agent"}

    return [{"kind": "run", "type": "run", "id": r["id"], "key": None, "title": who(r["agent_id"])["name"],
             "snippet": r["snippet"], "at": _iso(r["started_at"]), "status": r["status"],
             "agent": who(r["agent_id"]), "asked_by": who(r["asked_by"]) if r["asked_by"] else None}
            for r in rows]


async def _history(conn, space: str, keys: list[str], tsq: str, f: Filters,
                   shown: set[str]) -> list[dict[str, Any]]:
    """Items by what they said before an edit, and when they stopped saying it."""
    rows = await conn.fetch(
        "with hits as ("
        "  select h.id, h.object_id, ts_rank(h.tsv, to_tsquery('english', $2)) as rank"
        "    from chunk_history h join objects o on o.id = h.object_id and o.deleted_at is null"
        "   where h.space_id = $1 and o.acl_keys && $3 and o.type = any($4::text[])"
        "     and h.tsv @@ to_tsquery('english', $2) and not (h.object_id = any($5::text[]))"
        "     and ($6::timestamptz is null or h.said_until >= $6)"
        "     and ($7::timestamptz is null or h.said_until < $7)"
        "   order by rank desc limit 400),"
        " best as (select distinct on (object_id) * from hits order by object_id, rank desc),"
        " top as (select * from best order by rank desc limit $8 offset $9)"
        " select t.object_id, h.said_until, o.type, o.key, o.title,"
        "        regexp_replace(ts_headline('english', h.body, to_tsquery('english', $2),"
        f"          '{HEADLINE}'), '\\s+', ' ', 'g') as snippet"
        "   from top t join chunk_history h on h.id = t.id join objects o on o.id = t.object_id"
        "  order by t.rank desc",
        space, tsq, keys, f.objects() or list(SEARCHABLE), [] if f.alone("history") else sorted(shown),
        f.since, f.until, f.cap("history") + 1, f.skip("history"))
    return [{"kind": "history", "type": r["type"], "id": r["object_id"], "key": r["key"],
             "title": r["title"], "snippet": r["snippet"], "at": _iso(r["said_until"])} for r in rows]


async def read(conn, *, space: str, keys: list[str], item_id: str,
               comments: int = 12, numbers: bool = False) -> dict[str, Any] | None:
    """One item as the index holds it, if these keys may read it: its sections,
    the latest of its conversation, what is linked to it, and what it said
    before its last edits. A dashboard read with `numbers` runs its panels and
    says what they show now. A code file, a definition — metric or dataset —
    and a run are read too, each the way it is stored."""
    from commonindex.gateway.messages import _actors

    row = await conn.fetchrow(
        "select id, type, key, title, created_by, updated_at, props->>'repo_id' as repo_id from objects"
        " where id = $1 and space_id = $2 and deleted_at is null and acl_keys && $3"
        "   and type = any($4::text[])", item_id, space, keys, [*SEARCHABLE, "code_file"])
    if row is None:
        member = f"space:{space}" in keys
        return (await _read_run(conn, space, keys, item_id)
                or (member and await _read_metric(conn, space, keys, item_id))
                or (member and await _read_dataset(conn, space, item_id))
                or None)
    if row["type"] == "code_file":
        return await _read_code(conn, row, keys)
    sections, used = [], 0
    for c in await conn.fetch("select heading, body from chunks where object_id = $1 order by ord", item_id):
        if used >= READ_CHARS:
            sections.append({"heading": None, "text": "… (more — search within it)"})
            break
        text = c["body"][:READ_CHARS - used]
        used += len(text)
        sections.append({"heading": c["heading"], "text": text})
    if numbers and row["type"] == "dashboard":
        sections.append(await _numbers(space, item_id))
    said = await conn.fetch(
        "select id, author_id, body, created_at from messages"
        " where subject_id = $1 and space_id = $2 and deleted_at is null"
        " order by created_at desc limit $3", item_id, space, comments)
    links = await conn.fetch(
        "select e.rel, 'out' as direction, o.id, o.type, o.key, o.title from edges e"
        "  join objects o on o.id = e.dst and o.deleted_at is null and o.acl_keys && $2"
        " where e.src = $1"
        " union all "
        "select e.rel, 'in', o.id, o.type, o.key, o.title from edges e"
        "  join objects o on o.id = e.src and o.deleted_at is null and o.acl_keys && $2"
        " where e.dst = $1 limit 20", item_id, keys)
    earlier = await conn.fetch(
        "select heading, body, said_until from chunk_history where object_id = $1"
        " order by said_until desc limit 5", item_id)
    people = await _actors(conn, [row["created_by"], *[m["author_id"] for m in said]])

    def who(actor_id):
        return people.get(actor_id) or {"id": actor_id, "name": actor_id, "kind": "human"}

    return {
        "id": row["id"], "type": row["type"], "key": row["key"], "title": row["title"],
        "created_by": who(row["created_by"]),
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "sections": sections,
        "comments": [{"id": m["id"], "author": who(m["author_id"]), "text": m["body"],
                      "at": m["created_at"].isoformat()} for m in reversed(said)],
        "links": [{k: r[k] for k in ("rel", "direction", "id", "type", "key", "title")} for r in links],
        # What it said until an edit took it out: the latest first.
        "history": [{"heading": h["heading"], "text": h["body"][:600], "until": _iso(h["said_until"])}
                    for h in earlier],
    }


def _has_data(p: dict[str, Any]) -> bool:
    return bool(p.get("rows")) or any(pt[1] is not None for s in p.get("series") or []
                                      for pt in s.get("points") or [])


def _panel_now(p: dict[str, Any], days: int = 30, note: str = "") -> list[str]:
    """What one panel shows: a line per series, its latest value and when, and
    where the window began — or, for a panel split by category rather than by
    time, each category's value on one line."""
    from commonindex.workers.parts import number

    label = p.get("label") or (p.get("panel") or {}).get("title") or "A panel"
    if p.get("error"):
        return [f"{label}: could not run — {str(p['error']).splitlines()[0][:240]}"]
    if p.get("rows") is not None:
        cols, rows = p.get("columns") or [], p["rows"]
        shown = "; ".join(", ".join(f"{c}={v}" for c, v in zip(cols, r, strict=False)) for r in rows[:3])
        return [f"{label}: {shown or 'no rows'}" + (f" … {len(rows)} rows" if len(rows) > 3 else "")]
    unit = p.get("unit")
    lines, categories = [], []
    for series in (p.get("series") or [])[:8]:
        points = [pt for pt in series.get("points") or [] if pt[1] is not None]
        if not points:
            continue
        # A panel with no split is one series, named "value".
        name = "" if series.get("name") in (None, "", "value") else series["name"]
        (t0, v0), (t1, v1) = points[0], points[-1]
        if t1 == (series.get("name") or ""):   # no time bucket: the point is the category's value
            categories.append(f"{name} {number(v1, unit)}".strip())
            continue
        since = f", from {number(v0, unit)} on {str(t0)[:10]}" if len(points) > 1 else ""
        lines.append(f"{label}{f' ({name})' if name else ''}: {number(v1, unit)} on {str(t1)[:10]}{since}{note}")
    if categories:
        lines.append(f"{label}: {', '.join(categories)}{note}")
    return lines or [f"{label}: no data in the last {days} days"]


async def _render(space: str, dashboard_id: str, days: int) -> dict[str, Any] | str:
    from commonindex.gateway.app import render_dashboard

    try:
        out = await asyncio.wait_for(
            render_dashboard({"dashboard_id": dashboard_id, "range": f"{days}d"}, space), NUMBERS_SECONDS)
    except Exception as e:  # noqa: BLE001 - a warehouse that cannot answer is said, not raised
        return f"The panels could not be run: {e}"
    return out if isinstance(out, dict) else "The panels could not be run."


async def _numbers(space: str, dashboard_id: str) -> dict[str, str]:
    """What a dashboard's panels show, run as its page runs them, over the
    last 30 days. A panel with nothing in those says its latest number from
    the last year instead: the latest number known is an answer, and an empty
    window is not."""
    heading = "Numbers, last 30 days"
    out = await _render(space, dashboard_id, 30)
    if isinstance(out, str):
        return {"heading": heading, "text": out}
    panels = out.get("panels") or []
    wider: dict[Any, dict[str, Any]] = {}
    if any(not p.get("error") and not _has_data(p) for p in panels):
        year = await _render(space, dashboard_id, 365)
        if isinstance(year, dict):
            wider = {(p.get("panel") or {}).get("id"): p for p in year.get("panels") or [] if _has_data(p)}
    lines: list[str] = []
    for p in panels:
        latest = wider.get((p.get("panel") or {}).get("id")) if not _has_data(p) else None
        lines += _panel_now(latest, 365, " — nothing in the last 30 days") if latest else _panel_now(p)
    return {"heading": heading, "text": "\n".join(lines) or "It has no panels."}


def _day(at: Any) -> str:
    return str(at or "")[:10]


async def _read_code(conn, row, keys: list[str]) -> dict[str, Any]:
    sections, used = [], 0
    for c in await conn.fetch(
            "select start_line, end_line, body from chunks where object_id = $1 and acl_keys && $2"
            " order by start_line nulls last, ord", row["id"], keys):
        if used >= READ_CHARS:
            sections.append({"heading": None, "text": "… (more — search within it)"})
            break
        text = c["body"][:READ_CHARS - used]
        used += len(text)
        lines = f"lines {c['start_line']}–{c['end_line']}" if c["start_line"] else None
        sections.append({"heading": lines, "text": text})
    repo = await conn.fetchval("select title from objects where id = $1", row["repo_id"]) if row["repo_id"] else None
    return {"id": row["id"], "type": "code_file", "key": None, "title": row["title"], "repo": repo,
            "created_by": None, "updated_at": _iso(row["updated_at"]), "sections": sections,
            "comments": [], "links": [], "history": []}


async def _read_metric(conn, space: str, keys: list[str], metric_id: str) -> dict[str, Any] | None:
    from commonindex.gateway.messages import _actors

    versions = await conn.fetch(
        "select version, label, expr, unit, better, status, description, created_by, created_at, dataset_id"
        "  from metrics where id = $1 and space_id in ($2, '*') order by version desc", metric_id, space)
    if not versions:
        return None
    m = versions[0]
    said = [f"{m['label']} = {m['expr']}" + (f", in {m['unit']}" if m["unit"] else "")
            + (f"; {m['better']} is better" if m["better"] else "")
            + (f"; on {m['dataset_id']}" if m["dataset_id"] else "") + "."]
    if m["description"]:
        said.append(m["description"])
    used = (await _used_on(conn, keys, [metric_id])).get(metric_id, [])
    measured = await conn.fetch(
        "select id, key, title from objects where type = 'experiment' and deleted_at is null"
        "   and space_id = $2 and acl_keys && $3"
        "   and (props->'contract'->>'metric_id' = $1"
        "        or props->'contract'->'guardrails' @> jsonb_build_array(jsonb_build_object('metric_id', $1::text)))",
        metric_id, space, keys)
    people = await _actors(conn, [m["created_by"]])
    return {
        "id": metric_id, "type": "metric", "key": None, "title": m["label"],
        "created_by": people.get(m["created_by"]) or {"id": m["created_by"], "name": m["created_by"], "kind": "human"},
        "updated_at": _iso(m["created_at"]),
        "sections": [{"heading": "Definition", "text": " ".join(said)},
                     {"heading": "Versions", "text": "\n".join(
                         f"v{v['version']} {v['status']}: {v['expr']} — {v['created_by']}, {_day(v['created_at'])}"
                         for v in versions[:10])}],
        "comments": [],
        "links": [*({"rel": "charted on", "direction": "in", **d} for d in used),
                  *({"rel": "measured by", "direction": "in", "id": e["id"], "type": "experiment",
                     "key": e["key"], "title": e["title"]} for e in measured)],
        "history": [],
    }


async def _read_dataset(conn, space: str, dataset_id: str) -> dict[str, Any] | None:
    d = await conn.fetchrow(
        "select id, name, time_column, grains, dimensions, description, caveats, grain_note, updated_at"
        "  from datasets where id = $1 and space_id in ($2, '*')", dataset_id, space)
    if d is None:
        return None
    dims = json.loads(d["dimensions"]) if isinstance(d["dimensions"], str) else (d["dimensions"] or [])
    defined = await conn.fetch(
        "select distinct on (id) id, label from metrics where dataset_id = $1 order by id, version desc", dataset_id)
    grain = " ".join(x for x in (
        f"Time column {d['time_column']}." if d["time_column"] else "",
        f"Grains: {', '.join(d['grains'])}." if d["grains"] else "",
        d["grain_note"] or "") if x)
    sections = [s for s in (
        {"heading": "Description", "text": d["description"]},
        {"heading": "Caveats", "text": d["caveats"]},
        {"heading": "Grain", "text": grain},
        {"heading": "Columns", "text": ", ".join(f"{x.get('name')} ({x.get('kind')})"
                                                for x in dims if isinstance(x, dict))},
        {"heading": "Definitions on it", "text": "\n".join(f"{m['label']} ({m['id']})" for m in defined)},
    ) if s["text"]]
    return {"id": d["id"], "type": "dataset", "key": None, "title": d["name"], "created_by": None,
            "updated_at": _iso(d["updated_at"]), "sections": sections, "comments": [], "links": [],
            "history": []}


async def _read_run(conn, space: str, keys: list[str], run_id: str) -> dict[str, Any] | None:
    from commonindex.gateway.messages import _actors

    r = await conn.fetchrow(
        "select r.id, r.agent_id, r.status, r.started_at, r.ended_at, r.cost_tokens, r.cost_usd,"
        "       e.actor_id as asked_by, e.object_id, e.payload"
        "  from runs r left join events e on e.space_id = r.space_id and e.seq = r.trigger_seq"
        "   and e.verb = 'asked'"
        f" where r.id = $1 and r.space_id = $2 and (e.seq is null or ({_ASK_READABLE}))",
        run_id, space, keys)
    if r is None:
        return None
    payload = json.loads(r["payload"]) if isinstance(r["payload"], str) else dict(r["payload"] or {})
    thread = payload.get("thread_id")
    said = await conn.fetch(
        "select id, author_id, body, created_at from messages where (id = $1 or parent_id = $1)"
        "   and deleted_at is null order by created_at limit 12", thread) if thread else []
    about = await conn.fetchrow(
        "select id, type, key, title from objects where id = $1 and deleted_at is null and acl_keys && $2",
        r["object_id"], keys) if r["object_id"] else None
    people = await _actors(conn, [r["agent_id"], r["asked_by"], *[m["author_id"] for m in said]])

    def who(actor_id):
        return people.get(actor_id) or {"id": actor_id, "name": actor_id, "kind": "human"}

    ran = [f"{r['status']}.", f"Started {_iso(r['started_at'])}." if r["started_at"] else "",
           f"Ended {_iso(r['ended_at'])}." if r["ended_at"] else "",
           f"Used {r['cost_tokens']:,} tokens." if r["cost_tokens"] else "",
           f"Asked by {who(r['asked_by'])['name']}." if r["asked_by"] else "Not started by an ask."]
    return {
        "id": r["id"], "type": "run", "key": None, "title": f"{who(r['agent_id'])['name']} run",
        "created_by": who(r["agent_id"]), "updated_at": _iso(r["ended_at"] or r["started_at"]),
        "sections": [s for s in ({"heading": "Asked", "text": payload.get("note") or ""},
                                 {"heading": "Run", "text": " ".join(x for x in ran if x)}) if s["text"]],
        "comments": [{"id": m["id"], "author": who(m["author_id"]), "text": m["body"],
                      "at": m["created_at"].isoformat()} for m in said],
        "links": [{"rel": "about", "direction": "out", **dict(about)}] if about else [],
        "history": [],
    }


# ── the routes ────────────────────────────────────────────────────────────


@router.post("/api/v1/search.query")
async def search_query(req: Request):
    """Objects, agents and conversations matching `q`, best first."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    try:
        f = filters_from(body)
    except ValueError as e:
        return _error(422, "bad_filter", str(e), "since")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        keys = await _keys(req, conn, actor)
        return await find(conn, space=space, keys=keys, q=str(body.get("q") or ""), f=f)


@router.post("/api/v1/search.read")
async def search_read(req: Request):
    """One item, as the index holds it."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    item_id = str(body.get("id") or "").strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        keys = await _keys(req, conn, actor)
        item = await read(conn, space=space, keys=keys, item_id=item_id,
                          numbers=body.get("numbers", True) is not False) if item_id else None
    if item is None:
        # Not there and not yours read the same: saying which is most of a leak.
        return _error(404, "unknown_item", f"no item {item_id!r} you can read", "id")
    return {"item": item}


class _Tools:
    """search and read, for the ask loop, as the caller."""

    def __init__(self, conn, space: str, keys: list[str]) -> None:
        self._conn, self._space, self._keys = conn, space, keys

    async def search(self, q: str, **filters: Any) -> dict[str, Any]:
        try:
            f = filters_from({**filters, "limit": 8})
        except ValueError:
            f = Filters(limit=8)
        return await find(self._conn, space=self._space, keys=self._keys, q=q, f=f)

    async def read(self, item_id: str) -> dict[str, Any] | None:
        return await read(self._conn, space=self._space, keys=self._keys, item_id=item_id, numbers=True)


@router.post("/api/v1/workspace.ask")
async def workspace_ask(req: Request):
    """Answer a question from the workspace: search, read, search again, cite."""
    from commonindex.core.retrieval.ask import ask
    from commonindex.gateway.auth import actor_of, space_of
    from commonindex.gateway.llm import LlmUnavailable

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    question = " ".join(str(body.get("q") or "").split())[:1_000]
    if not question:
        return _error(422, "no_question", "ask something", "q")
    model = req.app.state.commonindex.get("llm")
    if model is None:
        return _error(422, "no_model",
                      "asking needs a model to read with — set COMMONINDEX_LLM_BASE_URL and "
                      "COMMONINDEX_LLM_MODEL on the gateway. Search works without one.", None)
    steps = max(1, min(int(body.get("steps") or 6), 10))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        keys = await _keys(req, conn, actor)
        try:
            answer = await ask(question, model, _Tools(conn, space, keys), steps=steps)
        except LlmUnavailable as e:
            return _error(503, "model_unavailable", f"the model did not answer: {e}", None)
    return {"q": question, "answer": answer.text, "citations": answer.citations,
            "steps": [asdict(s) for s in answer.steps], "model": getattr(model, "model", None)}
