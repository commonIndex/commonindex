-- CommonIndex · initial schema.
--
-- Sixteen tables, one database. Not a scaling compromise: a database per
-- collection makes the edges table impossible, and cross-collection provenance
-- is the product.
--
-- Companion: backend/mvp-schema.md, backend/ontology.md.

create extension if not exists vector;

-- ── tenancy and identity ────────────────────────────────────────────────
create table spaces (
  id          text primary key,
  org_id      text not null,
  name        text not null,
  policy      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- Humans and agents in ONE table. The product tenet as a DDL constraint: if
-- agents ever get their own table, every downstream query grows a branch.
create table actors (
  id          text primary key,
  kind        text not null check (kind in ('human','agent')),
  display     text not null,
  owner_id    text references actors(id),
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

-- ── the graph ───────────────────────────────────────────────────────────
create table objects (
  id           text primary key,
  space_id     text not null references spaces(id),
  type         text not null,
  key          text,
  title        text not null,
  props        jsonb not null default '{}',
  current_rev  int  not null default 1,

  -- Denormalised permission handle. Added because N1 rules 3 and 4 put a
  -- per-object permission filter on the read path, and graph traversal needs
  -- one too: without this, a one-hop expansion authorises row by row, which is
  -- acceptable over tens of edges and wrong over hundreds.
  -- Maintained by the aclcrawl worker. (Gap found in mvp-schema.md.)
  acl_keys     text[] not null default '{}',

  created_by   text not null references actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz          -- tombstone; recovery is replay
);

create unique index on objects (space_id, key) where key is not null;
-- the index every collection list hits
create index on objects (space_id, type, updated_at desc) where deleted_at is null;
create index on objects using gin (props jsonb_path_ops);
create index on objects using gin (acl_keys);

-- Provenance only. Containment is a foreign key on the child: a panel belongs
-- to exactly one dashboard and is written knowing it.
create table edges (
  src        text not null references objects(id),
  rel        text not null,
  dst        text not null references objects(id),
  created_by text not null references actors(id),
  confidence real,             -- null = declared; set = inferred by the linker
  created_at timestamptz not null default now(),
  primary key (src, rel, dst)
);
create index on edges (dst, rel);   -- traversal works in both directions

create table revisions (
  object_id  text not null references objects(id),
  rev        int  not null,
  author_id  text not null references actors(id),
  delta      jsonb not null,
  ts         timestamptz not null default now(),
  primary key (object_id, rev)
);

-- ── the log ─────────────────────────────────────────────────────────────
create table events (
  space_id   text not null references spaces(id),
  seq        bigint not null,
  actor_id   text not null references actors(id),
  verb       text not null,
  object_id  text,
  payload    jsonb not null default '{}',
  ts         timestamptz not null default now(),
  primary key (space_id, seq)
);

-- Per-space ordering without a broker. The UPDATE takes a row lock, which
-- serialises writes WITHIN a space and not across them — the reason the space
-- is the unit of scale.
create table space_seq (
  space_id text primary key references spaces(id),
  next_seq bigint not null default 1
);

-- ── the registry ────────────────────────────────────────────────────────
-- A type is data. The UI, the API, the MCP manifest and the indexer are all
-- projections of these rows.
create table object_types (
  id          text primary key,
  space_id    text references spaces(id),   -- null = built-in, everywhere
  label       text not null,
  plural      text not null,
  schema      jsonb not null,
  presenting  jsonb not null default '{}',
  facets      jsonb not null default '[]',
  measures    jsonb not null default '[]',
  prose       jsonb not null default '[]',  -- THE embedding policy
  version     int  not null default 1,
  status      text not null default 'proposed'
              check (status in ('proposed','ratified','deprecated')),
  ratified_by text references objects(id),
  created_at  timestamptz not null default now()
);
create index on object_types (space_id) where status = 'ratified';

create table relation_types (
  id          text primary key,
  src_type    text not null references object_types(id),
  rel         text not null,
  dst_type    text not null references object_types(id),
  cardinality text not null check (cardinality in ('one','many')),
  label       text not null,
  inverse     text not null,
  status      text not null default 'proposed'
);
create index on relation_types (src_type);
create index on relation_types (dst_type);

-- ── review, access, runs ────────────────────────────────────────────────
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
  -- the learning signal; an unexplained rejection teaches the skill nothing
  reject_reason text check (reject_reason in ('merits','scope','needs-decision')),
  -- groups N proposals that are one edit in N places
  pattern_key   text,
  receipt       jsonb,   -- the context pack that produced it, incl. what dropped
  decided_by    text references actors(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on proposals (space_id, status, created_at desc);
create index on proposals (pattern_key) where status = 'pending';

-- Two dimensions an ordinary ACL lacks: expiry and budget. Namespace is empty
-- for native grants and 'src:<source>' for imported ones — N1 rule 1.
create table grants (
  id         text primary key,
  subject    text not null references actors(id),
  relation   text not null,
  resource   text not null,
  namespace  text not null default '',
  granted_by text not null references actors(id),
  expires_at timestamptz,
  budget_usd numeric,
  last_used  timestamptz,
  created_at timestamptz not null default now()
);
create index on grants (subject, relation);
create index on grants (resource);
create index on grants (namespace) where namespace <> '';

create table runs (
  id            text primary key,
  space_id      text not null references spaces(id),
  agent_id      text not null references actors(id),
  trigger_seq   bigint,
  status        text not null check (status in ('running','done','blocked','asking')),
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

-- ── retrieval, in the same database ─────────────────────────────────────
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
  updated_at timestamptz not null default now(),
  unique (object_id, rev, ord)
);
create index on chunks using gin (tsv);
create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks using gin (acl_keys);

-- NATS with the queue replaced by a cursor. Same replay semantics, no broker.
create table consumer_offsets (
  consumer  text not null,
  space_id  text not null references spaces(id),
  last_seq  bigint not null default 0,
  primary key (consumer, space_id)
);
