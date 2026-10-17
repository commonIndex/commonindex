# MVP schema — one Postgres, fourteen tables

> **Design record.** This document records design reasoning from mid-2026. Parts of it describe plans that changed or were not built (for example SpiceDB, Temporal, Firecracker and GraphQL). For what exists today, see [backend/README.md](README.md), the code, and [docs/development.md](../docs/development.md).

Companion to `DESIGN.md` §3 (data model) and §4 (event log). That document describes the shape at
scale; this one is what to actually create on day one, and the rules for when to stop.

## The two questions, answered

**One database or one per collection?** One. Not as a scaling compromise — a database per
collection makes the `edges` table impossible, and cross-collection provenance edges *are* the
product. You cannot foreign-key a pull request to the doc it drifted, or a task to the decision it
depends on, across database boundaries. "Entire context in one place" is not a marketing line about
the UI; it is a statement about which rows can reference which other rows.

**One table per collection, or one table for all of them?** One table. Experiments, PRs, docs,
dashboards, skills, deploys, tasks and sources are all rows in `objects`, distinguished by a `type`
column. Three reasons, in order of weight:

1. **`edges` and `events` need one thing to point at.** With ten collection tables, every provenance
   edge needs a polymorphic reference and every join becomes a `UNION` over ten tables. With one,
   the edge is a foreign key.
2. **Adding an object type stops being a migration.** `DESIGN.md` §3 already commits to this for
   long-tail types; at MVP it should be true for every type, because you do not yet know which ones
   are hot.
3. **Search, inbox and permissions get written once.** A generic indexer over `objects` is one
   worker. Ten typed indexers is ten workers that drift.

The cost is real and worth naming: `jsonb` props have no column constraints, so validation lives in
the application. Accept that at MVP. Promote a hot field to a real column the day a query needs it —
that is a normal migration, and you will have evidence for it by then.

## The schema

Fourteen tables, three groups. Everything the product does lives here.

### Tenancy and identity

```sql
create table spaces (
  id          text primary key,
  org_id      text not null,
  name        text not null,
  policy      jsonb not null default '{}',      -- quorum rules, trust ceilings
  created_at  timestamptz not null default now()
);

-- Humans and agents in ONE table. This is the product tenet as a DDL constraint:
-- if agents ever get their own table, every downstream query grows a branch.
create table actors (
  id          text primary key,
  kind        text not null check (kind in ('human','agent')),
  display     text not null,
  owner_id    text references actors(id),        -- every agent has an answerable human
  trust_tier  text not null default 'propose-only'
              check (trust_tier in ('propose-only','auto-merge-minor','autonomous')),
  created_at  timestamptz not null default now()
);

create table memberships (
  actor_id  text not null references actors(id),
  space_id  text not null references spaces(id),
  role      text not null,
  primary key (actor_id, space_id)
);
```

### The graph

```sql
create table objects (
  id           text primary key,
  space_id     text not null references spaces(id),
  type         text not null,                    -- experiment | pr | doc | task | ...
  key          text,                             -- the human address: E-217, #341, T-118
  title        text not null,
  props        jsonb not null default '{}',
  current_rev  int  not null default 1,
  created_by   text not null references actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz                       -- tombstone; never a hard delete
);

create unique index on objects (space_id, key) where key is not null;
-- the index every collection list hits: one type, one space, newest first
create index on objects (space_id, type, updated_at desc) where deleted_at is null;
create index on objects using gin (props jsonb_path_ops);

-- Provenance. This table is why there is one database.
create table edges (
  src        text not null references objects(id),
  rel        text not null,      -- caused | touches | depends | produced | same_as
  dst        text not null references objects(id),
  created_by text not null references actors(id),
  confidence real,               -- null = deterministic; set when the linker inferred it
  created_at timestamptz not null default now(),
  primary key (src, rel, dst)
);
create index on edges (dst, rel);   -- traversal has to work in both directions

create table revisions (
  object_id  text not null references objects(id),
  rev        int  not null,
  author_id  text not null references actors(id),
  delta      jsonb not null,
  ts         timestamptz not null default now(),
  primary key (object_id, rev)
);
```

### The log

```sql
create table events (
  space_id   text not null references spaces(id),
  seq        bigint not null,
  actor_id   text not null references actors(id),
  verb       text not null,        -- object.create | proposal.merge | trust.promote
  object_id  text,
  payload    jsonb not null default '{}',
  ts         timestamptz not null default now(),
  primary key (space_id, seq)
);

-- Per-space ordering without a broker. The UPDATE takes a row lock, which
-- serialises writes *within* a space and not across them — exactly the
-- guarantee §4 asks for, and the reason the space is the unit of scale.
create table space_seq (
  space_id text primary key references spaces(id),
  next_seq bigint not null default 1
);
```

Every mutation is one transaction:

```sql
begin;
  update space_seq set next_seq = next_seq + 1
    where space_id = $1 returning next_seq - 1 as seq;
  update objects set props = $2, current_rev = current_rev + 1, updated_at = now()
    where id = $3;
  insert into revisions (object_id, rev, author_id, delta) values (...);
  insert into events (space_id, seq, actor_id, verb, object_id, payload) values (...);
commit;
```

If that transaction does not contain both the entity write and the event, the architecture is
already broken — there is no later point at which they can be made to agree.

### Review, access, runs

```sql
create table proposals (
  id            text primary key,
  space_id      text not null references spaces(id),
  target_id     text not null references objects(id),
  base_rev      int  not null,
  delta_kind    text not null check (delta_kind in ('props','crdt','gitref')),
  delta         jsonb not null,
  author_id     text not null references actors(id),
  status        text not null default 'pending'
                check (status in ('pending','merged','rejected')),
  reject_reason text check (reject_reason in ('merits','scope','needs-decision')),
  -- the grouping key that makes N proposals one review; null when it stands alone
  pattern_key   text,
  decided_by    text references actors(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on proposals (space_id, status, created_at desc);
create index on proposals (pattern_key) where status = 'pending';

-- MVP authz is a table with a recursive CTE, not SpiceDB. Two dimensions an
-- ordinary ACL lacks: expiry and budget.
create table grants (
  id         text primary key,
  subject    text not null references actors(id),
  relation   text not null,             -- read | propose | merge | admin
  resource   text not null,             -- space:payments | object:doc-42
  granted_by text not null references actors(id),
  expires_at timestamptz,
  budget_usd numeric,
  last_used  timestamptz,
  created_at timestamptz not null default now()
);
create index on grants (subject, relation);
create index on grants (resource);

create table runs (
  id            text primary key,
  space_id      text not null references spaces(id),
  agent_id      text not null references actors(id),
  trigger_seq   bigint,                 -- the event that fired it
  status        text not null,          -- running | done | blocked | asking
  cost_tokens   int  not null default 0,
  cost_usd      numeric not null default 0,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create table run_steps (
  run_id          text not null references runs(id),
  n               int  not null,
  tool            text not null,
  input_ref       text,
  output_ref      text,
  objects_touched text[],
  primary key (run_id, n)
);
```

### Retrieval, in the same database

```sql
create extension if not exists vector;

create table chunks (
  id         bigserial primary key,
  object_id  text not null references objects(id) on delete cascade,
  space_id   text not null references spaces(id),
  rev        int  not null,
  ord        int  not null,
  body       text not null,
  tsv        tsvector generated always as (to_tsvector('english', body)) stored,
  embedding  vector(1536),
  acl_keys   text[] not null,
  updated_at timestamptz not null default now()
);
create index on chunks using gin (tsv);
create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks using gin (acl_keys);
create index on chunks (object_id, rev);
```

Postgres full-text plus pgvector covers hybrid retrieval to roughly a million chunks. Tantivy and a
dedicated vector store are the second version, not the first.

### Fan-out without a broker

```sql
create table consumer_offsets (
  consumer  text not null,          -- indexer | linker | scheduler | inbox | scorecards
  space_id  text not null references spaces(id),
  last_seq  bigint not null default 0,
  primary key (consumer, space_id)
);
```

Each consumer loops: read its offset, select events above it in `seq` order, process, advance.
`LISTEN/NOTIFY` wakes it promptly; a slow poll is the fallback. This is NATS JetStream with the
queue replaced by a cursor — same replay semantics, no extra infrastructure. Swap in a real broker
when a consumer needs to scale out horizontally, which is a change to one loop.

## Every collection is a row

| Collection | `objects.type` | Notable props |
| --- | --- | --- |
| Experiments | `experiment` | metric, status, day, days, lift, guardrail, hypothesis |
| Pull requests | `pr` | repo, num, status, checks, summary |
| Docs | `doc` | freshness, excerpt, space |
| Dashboards | `dashboard` | certified, metrics[], headline |
| Panels | `panel` | kind, metric, expr, span — edge `panel →belongs_to→ dashboard` |
| Skills | `skill` | status, scopes[], tools[], acceptance |
| Deploys | `deploy` | env, tool, state, sha, stages[] |
| Tasks | `task` | state, criteria[], origin, human_only |
| Sources | `source` | tier, health, lag, maps[] |
| Access | — | `grants`, not `objects` — it is on the hot path of every request |

Access is the one deliberate exception. A grant is checked on every single operation, so it earns a
typed table with its own indexes rather than a `jsonb` lookup.

## When to stop being simple

Split only on evidence, and only in this order. Note that the first three are not really splits —
they are derived read models, so each can be rebuilt by replay and each is therefore reversible.

| Trigger | Move | Why it is safe |
| --- | --- | --- |
| `events` dominates disk | Partition by month or `space_id`, same database | Still one transaction with `objects` |
| Vector recall or memory suffers | Embeddings to a dedicated store | `chunks` is derived — drop and replay |
| Authz checks become the latency floor | SpiceDB | `grants` stays the source of truth |
| One space outgrows a node | Shard by `space_id` | The space was chosen as the unit for exactly this |

**Never split `objects`, `events` and `revisions` from each other.** They are written in one
transaction, and there is no later mechanism that can restore the guarantee that gives you. Every
other decision here is reversible; this one is not.

## What the read-only requirement removes

If connected systems are read-only and chat is deferred, the MVP does not need Yjs, a sync service,
websocket presence, or CRDT compaction into revisions. `delta_kind` keeps `crdt` in the check
constraint so the column does not need a migration later, but nothing writes it yet. That is roughly
a third of the original backend surface, deferred on the strength of one product decision.
