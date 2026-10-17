# Context plane — how everything gets indexed so agents and LLMs can fetch context

> **Design record.** This document records design reasoning from mid-2026. Parts of it describe plans that changed or were not built (for example SpiceDB, Temporal, Firecracker and GraphQL). For what exists today, see [backend/README.md](README.md), the code, and [docs/development.md](../docs/development.md).

Companion to `DESIGN.md` §4 (event log) and §8 (search). This is the pipeline that turns
"one workspace" into "one queryable context" — the property the whole product bet rests on.

## The one rule

**The event log is the only writer of indexes.** Nothing indexes on its own schedule;
every consumer tails the same per-space, totally-ordered log. That gives three properties
for free: indexes can never disagree with the truth, any index can be dropped and rebuilt
by replay, and freshness is a measurable lag (target: event → searchable p95 < 2s).

```
mutation → Postgres (entities + event, one tx)
                │  outbox → NATS JetStream
                ▼
   ┌── indexer: lexical (Tantivy/BM25) ──┐
   ├── indexer: vector (pgvector → turbopuffer at scale)
   ├── entity linker → provenance edges  ├──▶  retrieval API (search.query, context.pack)
   ├── read models (inbox, counts, boards)         │
   └── agent scheduler (trigger matching)          ▼
                                        humans (⌘K) + agents (MCP) — same API
```

## Chunking: each object type has its own recipe

Indexing "everything" naively produces garbage retrieval. Chunk by what the object *is*:

| Object | Chunk unit | Extra fields indexed |
| --- | --- | --- |
| Doc | block/section (CRDT blocks give natural boundaries) | freshness state, owner, pending-proposal flag |
| Thread/message | sliding window of ~10 turns, overlap 2 | channel, participants, linked objects |
| PR | description + per-file hunk summaries | repo, checks state, linked decision/task |
| Experiment | the structured card itself (hypothesis, metric, readout) | status, metric ref, guardrail state |
| Decision / policy | full text (they're small and dense) | ratification state, quorum, supersedes |
| Meeting | transcript segments by speaker turn + timestamp | anchored extractions |
| Run/trace | step summaries, tool names | agent, trigger, outcome |

Every chunk carries: `space_id`, `object_id`, `object_type`, `rev`, `acl_keys`, `updated_at`.
The vector store is only ever chunk + metadata; the object store remains the truth.

## Retrieval: hybrid, ACL-filtered, provenance-expanded

`search.query` runs BM25 and vector search in parallel, fuses (RRF), then reranks the
top ~50 with a small cross-encoder. Two things make it CommonIndex-shaped rather than generic RAG:

1. **ACL at every layer.** Chunks carry ACL keys; the query is pre-filtered to what the
   caller can see, then re-verified against SpiceDB at read time (new-enemy safety).
   An agent's search results are automatically scoped to its grants — same code path as a human's.
2. **Graph expansion.** After retrieval, expand one hop along provenance edges: a hit on a
   PR pulls its linked decision, spec section, and thread. The graph is what makes the
   answer *complete* rather than just similar. Drifted state surfaces explicitly: if a spec
   has a pending sync proposal, the answer says so instead of silently picking a side.

## context.pack — the endpoint agents actually live on

Search answers questions; agents mostly need *working sets*. `context.pack(object_id, budget_tokens)`
assembles, within a token budget and in priority order:

1. The object itself at current rev (or the proposal delta under review)
2. Its 1-hop provenance neighborhood (linked decisions, threads, PRs, metrics)
3. Recent relevant events (what changed here lately, who did it)
4. Ratified definitions any numbers depend on (metric registry entries)

Everything arrives with object IDs and revs — so anything the agent writes back (a proposal,
a comment) can cite exactly what it read. This is the difference between "agent with a search
tool" and "agent that inhabits the workspace": context is structured, budgeted, and citable,
not scraped.

## Freshness, backfill, cost

- **Freshness SLO:** event → index-visible p95 < 2s. The indexer is just another consumer;
  lag is monitored per space like any queue.
- **New index or schema change:** stand up the new indexer, replay the log from zero into it,
  cut over reads. No migrations of derived data, ever.
- **Cost control:** embeddings are computed once per chunk-rev (content-hashed); re-embedding
  only on change. Cheap embedding models for long-tail objects, better ones for docs/decisions.
- **Erasure:** GDPR deletes tombstone the object and delete its chunks by `object_id`;
  crypto-shredding covers blobs (per DESIGN.md §4).

## Why not "just put it all in one big vector DB"

Because the queries that matter are half-structural: "the *ratified* definition of refund_rate,"
"specs whose sync proposal is *pending*," "what did *this agent* touch last week." Pure
similarity search can't answer those; the metadata filters and provenance edges can. The vector
index (turbopuffer-class at scale) is one leg of retrieval — the graph and the event log are
the other two, and the fusion of the three is the moat.
