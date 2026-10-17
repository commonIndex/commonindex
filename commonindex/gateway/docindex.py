"""Vectors for doc chunks, and doc search by meaning as well as by word.

`chunks` is written by one indexer (commonindex/workers/indexer.py): a doc is a
chunk per section, headed "Title › Section", keyed with the doc's own
permission keys so a private doc stays private in every search. This module
never writes a chunk. It fills `embedding` on the ones that lack it — outside
the save's transaction, because a call to a model must not hold a lock — and
searches them by meaning beside the words.

The indexer carries a vector across a rewrite when a chunk's text is
unchanged, so an autosave that touched one paragraph embeds one section.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

log = logging.getLogger(__name__)

#: Which chunks get vectors. Docs are what Code Query cites beside code; other
#: types are found by words through `search.query`.
EMBEDDED_TYPES = ("doc",)

#: Reciprocal-rank fusion's constant. 60 is the value from the original paper
#: and what every hybrid-search system copies; it flattens the difference
#: between rank 1 and rank 3 so neither leg dominates on its own.
RRF_K = 60


def _vec(v: list[float]) -> str:
    """pgvector's text form. asyncpg has no codec for `vector` unless one is
    registered on every connection; the text form with a cast needs none."""
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


def _embed_text(heading: str | None, body: str) -> str:
    return f"{heading}\n\n{body}" if heading else body


async def embed_missing(pool, embedder, *, object_id: str | None = None,
                        batch: int = 32) -> int:
    """Fill `embedding` on chunks that have none. Returns how many were filled.

    The update names the chunk's text as well as its id, so a vector computed
    for text a newer save has since replaced is dropped rather than written
    onto the new text.
    """
    if embedder is None:
        return 0
    args: list[Any] = [list(EMBEDDED_TYPES), batch]
    where = "object_type = any($1::text[]) and embedding is null"
    if object_id:
        args.append(object_id)
        where += " and object_id = $3"
    rows = await pool.fetch(f"select id, heading, body from chunks where {where}"
                            f" order by id limit $2", *args)
    if not rows:
        return 0
    vectors = await embedder.embed([_embed_text(r["heading"], r["body"]) for r in rows])
    filled = 0
    for r, v in zip(rows, vectors):
        done = await pool.execute(
            "update chunks set embedding = $2::vector where id = $1 and body = $3"
            " and embedding is null", r["id"], _vec(v), r["body"])
        filled += done.endswith(" 1")
    return filled


async def embed_object(state: dict, object_id: str) -> dict[str, Any]:
    """After a save: vectors for whatever the indexer just rewrote. Never fails
    the save — a section without a vector is still found by its words, and the
    background loop fills it later."""
    embedder = state.get("embedder")
    if embedder is None:
        return {"vector": False}
    try:
        return {"vector": True, "embedded": await embed_missing(
            state["pool"], embedder, object_id=object_id, batch=200)}
    except Exception as e:  # noqa: BLE001
        log.warning("embedding %s failed: %r", object_id, e)
        return {"vector": True, "embedded": 0, "error": "embedding failed; retried in the background"}


async def embed_up(pool, embedder, every: float = 30.0) -> None:
    """Fill vectors now and then, forever: for chunks the indexer's sweep
    rewrote, and for any a failed save left without one."""
    while True:
        try:
            while await embed_missing(pool, embedder, batch=64):
                pass
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - a dead model is retried, never fatal
            log.warning("embedding sweep failed: %r", e)
        await asyncio.sleep(every)


def _words(q: str) -> str | None:
    """An OR of the question's words, for `to_tsquery`.

    Code search ANDs every term (`plainto_tsquery`), which suits an identifier
    and fails a question: "how do we roll back a refund deploy" matches no
    section containing all eight words. Ranking already rewards sections that
    match more of them. Only word characters get through, so nothing a caller
    types can be tsquery syntax.
    """
    words = re.findall(r"[A-Za-z0-9_]{2,}", q)[:24]
    return " | ".join(words) or None


async def search_docs(pool, embedder, *, q: str, space: str, acl_keys: list[str],
                      limit: int = 6, min_similarity: float = 0.55) -> dict[str, Any]:
    """Hybrid search over doc sections: words and meaning, fused by rank.

    The vector leg has a similarity floor. Nearest-neighbour search always
    returns neighbours, however far away — without a floor every question in
    Code Query would arrive with some doc attached, relevant or not.
    """
    ranked: dict[int, dict[str, Any]] = {}

    def add(rows, leg: str) -> None:
        for rank, r in enumerate(rows):
            hit = ranked.setdefault(r["id"], {**dict(r), "score": 0.0, "matched": []})
            hit["score"] += 1.0 / (RRF_K + rank + 1)
            hit["matched"].append(leg)

    cols = "c.id, c.object_id, c.heading, c.body, o.key, o.title"
    base = (" from chunks c join objects o on o.id = c.object_id"
            " where c.space_id = $1 and c.object_type = 'doc' and c.acl_keys && $2"
            "   and o.deleted_at is null")
    words = _words(q)
    if words:
        add(await pool.fetch(
            f"select {cols}{base} and c.tsv @@ to_tsquery('english', $3)"
            " order by ts_rank_cd(c.tsv, to_tsquery('english', $3)) desc limit 20",
            space, acl_keys, words), "text")

    degraded = None
    if embedder is None:
        degraded = "no embedding model is configured, so docs were matched by words only"
    else:
        try:
            [qv] = await embedder.embed([q], query=True)
            add(await pool.fetch(
                f"select * from (select {cols}, 1 - (c.embedding <=> $3::vector) as similarity"
                f"{base} and c.embedding is not null order by c.embedding <=> $3::vector"
                " limit 20) v where similarity >= $4",
                space, acl_keys, _vec(qv), min_similarity), "vector")
        except Exception as e:  # noqa: BLE001 - a dead embedder must not kill the text leg
            degraded = f"the embedding model failed ({e}), so docs were matched by words only"

    hits = []
    # Equal fused scores are common — each leg's first hit scores the same —
    # and a tie goes to the meaning match. The word leg ORs every term, so its
    # top hit can rest on one incidental word ("back" in "rolling back" for a
    # question about money back); the vector leg's top hit cannot.
    for h in sorted(ranked.values(), key=lambda h: (-h["score"], "vector" not in h["matched"]))[:limit]:
        heading = h["heading"] or h["title"] or ""
        _, sep, section = heading.partition(" › ")
        hits.append({"object_id": h["object_id"], "key": h["key"], "title": h["title"],
                     "section": section if sep else "", "snippet": (h["body"] or "").strip()[:1_500],
                     "score": round(h["score"], 5), "matched": h["matched"],
                     "citation": f"doc:{h['key']} {heading}"})
    return {"query": q, "hits": hits, "degraded": degraded}
