"""Maintains `chunks` — the stored search index — for every type but code.

No collection name appears here: what to index is read from each type's
``prose`` list, and a type declaring none is skipped. A field holding a block
tree is split into sections at its headings, each section a chunk headed
"Title › Section"; anything else is text. A prose entry may be a path into a
structured field — ``criteria.text``, ``review.note``, ``spec..text`` (at any
depth) — and what it names is a section of its own, headed by the field's
title. What the page shows that is stored beside the item — a dashboard's
panels, an experiment's readouts — the type names as ``parts``, read by
commonindex/workers/parts.py and indexed as sections too. Code files are chunked
by the code worker, by line, so a result can cite its lines — they are left
alone here.

What a save takes out of an item is kept in ``chunk_history``: the text as it
stood before each round of edits, so an earlier version can be searched.

Called three ways, all through `index_object`:

* on save, inside the save's own transaction, so an edit is searchable the
  moment it commits;
* by `sweep`, which re-indexes any item whose chunks are older than it — the
  catch-up for a write that did not call it — kept running by the gateway;
* by ``python -m commonindex.workers.indexer``: sweep until nothing is left, the
  backfill (``make index-backfill``).

The index is derived, never the record: delete every chunk, sweep, and it is
rebuilt.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import timedelta
from functools import cache
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Types whose chunks another writer owns. Code is chunked by line where it is
#: pulled, so its citations can name lines; re-chunking it here would lose them.
OWNED_ELSEWHERE = frozenset({"code_file"})

#: A chunk's size, in characters: about 200 words — long enough to carry a
#: thought, short enough that a snippet from it is about what matched.
CHUNK_CHARS = 1_200

#: One sweeper at a time, however many gateways run.
_LOCK = 0x5EA4C8

#: Which indexer wrote a chunk. One written by an older scheme is stale, so a
#: change to what items are indexed by rebuilds the index on the next sweep.
#: 1: structured fields by path, and parts.
SCHEME = 1

#: Edits this close together are one round: the history keeps what a section
#: said before the round began, not every keystroke an editor autosaved.
ROUND = timedelta(minutes=10)

#: Earlier versions kept per item; the oldest go first.
HISTORY = 100


@cache
def _types() -> dict[str, Any]:
    from commonindex.core.registry.types import load_dir

    return {t.id: t for t in load_dir(Path(__file__).resolve().parents[2] / "types")}


def indexed_types() -> list[str]:
    """Every type this indexer keeps: stored in the graph, with prose to index."""
    return sorted(t.id for t in _types().values()
                  if t.store == "graph" and t.prose and t.id not in OWNED_ELSEWHERE)


# ── turning an item into chunks ──────────────────────────────────────────


def _walk(value: Any, steps: list[str]):
    """What a prose path names. A list is walked item by item, and an empty
    step — from ``..`` — finds the next name at any depth below."""
    if not steps:
        yield value
        return
    if isinstance(value, list):
        for v in value:
            yield from _walk(v, steps)
        return
    if steps[0] == "":
        yield from _walk(value, steps[1:])
        if isinstance(value, dict):
            for v in value.values():
                if isinstance(v, (dict, list)):
                    yield from _walk(v, steps)
        return
    if isinstance(value, dict):
        yield from _walk(value.get(steps[0]), steps[1:])


def _heading(type_: Any, field: str) -> str:
    """A structured field's section heading: the title its schema gives it."""
    spec = (type_.schema.get("properties") or {}).get(field) or {}
    return spec.get("title") or field.replace("_", " ").capitalize()


def _is_tree(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("content"), list)


def _inline(node: Any) -> str:
    """The text of one node and everything in it, on one line. Text runs join
    as they are — the editor splits a word where its formatting changes, so a
    space between runs would split "re**fund**" into two words — and blocks
    join with a space."""
    if not isinstance(node, dict):
        return ""
    if isinstance(node.get("text"), str):
        return node["text"]
    children = [c for c in node.get("content") or [] if isinstance(c, dict)]
    if all("text" in c or c.get("type") == "hardBreak" for c in children):
        return "".join(c.get("text", " ") for c in children).strip()
    return " ".join(t for t in (_inline(c) for c in children) if t).strip()


def _sections(tree: dict) -> list[tuple[str | None, str]]:
    """A block tree as (heading, text) sections: every heading starts one."""
    out: list[tuple[str | None, list[str]]] = [(None, [])]
    for node in tree.get("content") or []:
        if not isinstance(node, dict):
            continue
        if node.get("type") == "heading":
            out.append((_inline(node) or None, []))
            continue
        # A list or a table is several blocks; each keeps its own line.
        blocks = node.get("content") if node.get("type") in {
            "bulletList", "orderedList", "taskList", "table"} else [node]
        for block in blocks or []:
            text = _inline(block)
            if text:
                out[-1][1].append(text)
    return [(heading, "\n".join(lines)) for heading, lines in out if lines or heading]


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(t for t in (_text(v) for v in value) if t)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _split(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """At paragraph boundaries, then sentence boundaries, never mid-word."""
    if len(text) <= limit:
        return [text] if text.strip() else []
    pieces, current = [], ""
    for para in re.split(r"\n+", text):
        parts = [para] if len(para) <= limit else re.split(r"(?<=[.!?])\s+", para)
        for part in parts:
            if current and len(current) + len(part) + 1 > limit:
                pieces.append(current)
                current = ""
            while len(part) > limit:   # one sentence longer than a chunk
                cut = part.rfind(" ", 0, limit)
                cut = cut if cut > 0 else limit
                pieces.append(part[:cut])
                part = part[cut:].lstrip()
            current = f"{current}\n{part}" if current else part
    if current.strip():
        pieces.append(current)
    return pieces


def chunks_for(row: Any, type_: Any, props: dict[str, Any],
               parts: list[tuple[str, str]] = ()) -> list[tuple[str, str]]:
    """(heading, body) chunks for one item, from the fields its type lists and
    the `parts` read for it.

    The first chunk is the item itself — its key and its short fields under its
    title — so every item is findable by what it is called. A block tree adds a
    chunk per section, headed "Title › Section"; a structured field, and each
    part, a section headed the same way.
    """
    title = (row["title"] or "").strip()
    short: list[str] = []
    sections: list[tuple[str | None, str]] = []
    fielded: dict[str, list[str]] = {}
    for field in type_.prose:
        if "." in field:
            top, *steps = field.split(".")
            said = [t for t in (_text(v) for v in _walk(props.get(top), steps)) if t]
            fielded.setdefault(top, []).extend(said)
            continue
        value = title if field == "title" else props.get(field)
        if _is_tree(value):
            sections += _sections(value)
            continue
        text = _text(value)
        if text and text != title:
            short.append(text)
    lead = "\n".join(p for p in (row["key"] or "", *short) if p) or title or "(untitled)"
    out = [(title, piece) for piece in _split(lead)] or [(title, title or "(untitled)")]
    for heading, text in sections:
        head = f"{title} › {heading}" if heading else title
        out += [(head, piece) for piece in _split(text)]
    for top, said in fielded.items():
        # A design repeats its button labels on every screen: once is enough.
        text = "\n".join(dict.fromkeys(said))
        out += [(f"{title} › {_heading(type_, top)}", piece) for piece in _split(text)]
    for heading, text in parts:
        out += [(f"{title} › {heading}", piece) for piece in _split(text)]
    return out


# ── writing them ─────────────────────────────────────────────────────────


async def index_object(db, object_id: str) -> int:
    """Rewrite one item's chunks from what it says now. Returns how many.

    Pass the connection a save is using, inside its transaction, and the index
    commits with the edit. A deleted item loses its chunks.
    """
    if not hasattr(db, "transaction") and hasattr(db, "acquire"):
        async with db.acquire() as conn:
            return await index_object(conn, object_id)
    from commonindex.workers import parts

    row = await db.fetchrow(
        "select id, space_id, type, key, title, props, current_rev, acl_keys, deleted_at"
        "  from objects where id = $1", object_id)
    if row is None or row["type"] not in indexed_types():
        return 0
    async with db.transaction():
        # What it said before — as this scheme indexes it: a new scheme saying
        # the same thing differently is not an edit.
        before = await db.fetch(
            "select heading, body from chunks where object_id = $1 and scheme = $2", object_id, SCHEME)
        # Vectors are computed outside this transaction (gateway/docindex.py),
        # so a rewrite must not throw them away: a chunk whose heading and text
        # are unchanged keeps its vector, and an autosave that touched one
        # paragraph costs one embedding rather than the whole doc's.
        vectors = {(r["heading"], r["body"]): r["v"] for r in await db.fetch(
            "select heading, body, embedding::text as v from chunks"
            " where object_id = $1 and embedding is not null", object_id)}
        await db.execute("delete from chunks where object_id = $1", object_id)
        if row["deleted_at"] is not None:
            return 0
        props = json.loads(row["props"]) if isinstance(row["props"], str) else dict(row["props"] or {})
        keys = list(row["acl_keys"] or []) or [f"space:{row['space_id']}"]
        type_ = _types()[row["type"]]
        pieces = chunks_for(row, type_, props, await parts.sections(db, row, props, type_.parts))
        await db.executemany(
            "insert into chunks (object_id, space_id, object_type, rev, ord, heading, body, acl_keys, scheme,"
            " embedding) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)",
            [(row["id"], row["space_id"], row["type"], row["current_rev"], i, heading, body, keys, SCHEME,
              vectors.get((heading, body))) for i, (heading, body) in enumerate(pieces)])
        await _keep_what_changed(db, row, before, pieces)
    return len(pieces)


async def _keep_what_changed(db, row, before, pieces) -> int:
    """File what the item said and no longer says, once per round of edits."""
    says = {body for _, body in pieces}
    gone = list(dict.fromkeys((r["heading"], r["body"]) for r in before if r["body"] not in says))
    if not gone:
        return 0
    # Kept already this round: that is the text from before the round began.
    recent = {r["heading"] for r in await db.fetch(
        "select distinct heading from chunk_history where object_id = $1 and said_until > now() - $2::interval",
        row["id"], ROUND)}
    keep = [(heading, body) for heading, body in gone if heading not in recent]
    if keep:
        await db.executemany(
            "insert into chunk_history (object_id, space_id, object_type, heading, body)"
            " values ($1,$2,$3,$4,$5)",
            [(row["id"], row["space_id"], row["type"], heading, body) for heading, body in keep])
        await db.execute(
            "delete from chunk_history where id in (select id from chunk_history where object_id = $1"
            " order by said_until desc, id desc offset $2)", row["id"], HISTORY)
    return len(keep)


async def index_users_of(db, metric_id: str) -> int:
    """Re-index what shows a metric — the dashboards charting it and the
    experiments registered on it — after its definition changed."""
    ids = [r["id"] for r in await db.fetch("""
        select distinct pb.dashboard_id as id from panel_bindings pb where pb.metric_id = $1
        union
        select o.id from objects o
         where o.type = 'experiment' and o.deleted_at is null
           and (o.props->'contract'->>'metric_id' = $1
                or o.props->'contract'->'guardrails' @> jsonb_build_array(jsonb_build_object('metric_id', $1::text)))
        """, metric_id)]
    for object_id in ids:
        await index_object(db, object_id)
    return len(ids)


#: Items whose chunks are older than they are — or missing, or written by an
#: older scheme, or belonging to something since deleted.
_STALE = """
    select o.id from objects o
     where o.type = any($1::text[])
       and ((o.deleted_at is null and not exists (
               select 1 from chunks c where c.object_id = o.id and c.rev = o.current_rev
                  and c.updated_at >= o.updated_at and c.scheme = $3))
         or (o.deleted_at is not null and exists (select 1 from chunks c where c.object_id = o.id)))
     order by o.updated_at desc
     limit $2
"""


async def sweep(db, batch: int = 200) -> int:
    """Re-index up to `batch` stale items; how many there were."""
    ids = [r["id"] for r in await db.fetch(_STALE, indexed_types(), batch, SCHEME)]
    for object_id in ids:
        await index_object(db, object_id)
    return len(ids)


async def keep_up(pool, every: float = 30.0) -> None:
    """Sweep now and then, forever — one sweeper across every gateway."""
    while True:
        try:
            async with pool.acquire() as conn:
                if await conn.fetchval("select pg_try_advisory_lock($1)", _LOCK):
                    try:
                        while await sweep(conn):
                            pass
                    finally:
                        await conn.execute("select pg_advisory_unlock($1)", _LOCK)
        except asyncio.CancelledError:
            raise
        except Exception:   # a failed sweep is retried, never fatal to the gateway
            log.exception("search index sweep failed")
        await asyncio.sleep(every)


class Indexer:
    """The same work as an event-log consumer, for when every write logs one."""

    name = "indexer"

    def __init__(self, db) -> None:
        self._db = db

    async def handle(self, e) -> None:
        if e.object_id:
            await index_object(self._db, e.object_id)


async def _backfill() -> None:
    import asyncpg

    conn = await asyncpg.connect(os.environ["COMMONINDEX_DSN"])
    try:
        total = 0
        while n := await sweep(conn, batch=500):
            total += n
            print(f"indexed {total} items…", flush=True)
        chunks = await conn.fetchval("select count(*) from chunks where object_type <> 'code_file'")
        print(f"done: {total} items re-indexed; {chunks} chunks for everything but code")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(_backfill())
