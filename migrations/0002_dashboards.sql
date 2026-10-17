-- F4 · the dashboard backend.
--
-- Three tables the initial migration was missing entirely, in dependency order.

-- ── connections ─────────────────────────────────────────────────────────
-- One per warehouse or semantic layer.
--
-- Note what is NOT here: credentials. The DSN carries host and database and no
-- secret; secret_ref points into the KMS-backed store. Credentials never enter
-- the object graph, because the object graph is indexed and an indexed
-- credential is an exfiltrated credential.
create table connections (
  id            text primary key,
  space_id      text not null references spaces(id),
  name          text not null,

  -- semantic layers are preferred: they execute with THEIR permissions and we
  -- hold no warehouse credentials at all
  kind          text not null check (kind in
                  ('semantic-cube','semantic-dbt','semantic-superset',
                   'postgres','bigquery','snowflake',
                   'eventlog')),

  dsn           text not null default '',
  secret_ref    text,                       -- KMS handle, never the secret

  -- Whether this source can run a query AS the calling user. Where false, every
  -- panel bound to it is visibly marked shared-principal. We never compensate by
  -- appending predicates — that is string-built row-level security, and a
  -- permission model built from string manipulation is the classic leak.
  impersonation boolean not null default false,

  -- read_only is asserted here and enforced at the warehouse by granting the
  -- connection user SELECT and nothing else. The flag is documentation; the
  -- grant is the control.
  read_only     boolean not null default true,

  created_by    text not null references actors(id),
  created_at    timestamptz not null default now(),
  checked_at    timestamptz,
  last_error    text
);
create index on connections (space_id, kind);

-- ── datasets ────────────────────────────────────────────────────────────
-- Where a number comes from. The metric registry says
-- what a number MEANS; a dataset says where it comes from and which dimensions
-- it can be sliced by. Without this, "refund rate by region" has a metric to
-- bind and no way to resolve `region`.
create table datasets (
  id            text primary key,
  space_id      text not null references spaces(id),
  connection_id text not null references connections(id),
  name          text not null,

  -- a physical table, or a saved query (a "virtual dataset")
  physical      text not null,
  is_virtual    boolean not null default false,

  time_column   text,
  grains        text[] not null default '{}',

  -- declared dimensions. A filter or group-by naming anything absent from here
  -- is rejected, never passed through — the same rule facets follow for objects.
  dimensions    jsonb not null default '[]',

  created_by    text not null references actors(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on datasets (space_id);
create index on datasets (connection_id);

-- ── metrics ─────────────────────────────────────────────────────────────
-- The registry DESIGN §14 has always specified and the schema never had.
--
-- Only ratified versions resolve at query time, so a natural-language question
-- cannot silently invent semantics. Versioned rather than mutated: changing a
-- definition supersedes it, and every panel citing the old version keeps
-- resolving until it is repointed.
create table metrics (
  id            text not null,
  version       int  not null default 1,
  space_id      text not null references spaces(id),
  dataset_id    text references datasets(id),

  label         text not null,
  expr          text not null,              -- the aggregate, in the source's terms
  unit          text,                       -- pct | currency | count | duration
  better        text check (better in ('up','down')),

  status        text not null default 'proposed'
                check (status in ('proposed','ratified','deprecated')),
  -- ratification is a decision object, so "who agreed this number means this,
  -- and when" is a query rather than an archaeology exercise
  ratified_by   text references objects(id),
  supersedes    int,

  created_by    text not null references actors(id),
  created_at    timestamptz not null default now(),
  primary key (id, version)
);
-- exactly one ratified version per metric per space, enforced rather than hoped
create unique index on metrics (space_id, id) where status = 'ratified';
create index on metrics (dataset_id);

-- ── panel bindings ──────────────────────────────────────────────────────
-- A panel is an object (type 'panel') and belongs to exactly one dashboard, so
-- that link is a foreign key rather than an edge — containment, not provenance.
--
-- This table is the binding a panel CANNOT carry inline. Permitting adhoc
-- metrics defined on a single chart is how six charts come to mean six
-- different things by "refund rate". A row here cites a metric version.
create table panel_bindings (
  panel_id      text primary key references objects(id) on delete cascade,
  dashboard_id  text not null references objects(id) on delete cascade,
  dataset_id    text not null references datasets(id),
  metric_id     text not null,
  metric_version int not null,
  dimensions    text[] not null default '{}',
  grain         text,
  foreign key (metric_id, metric_version) references metrics(id, version)
);
create index on panel_bindings (dashboard_id);
create index on panel_bindings (metric_id, metric_version);

-- ── result cache ────────────────────────────────────────────────────────
-- Keyed by a hash of the resolved query, so two people opening the same panel
-- with the same range cost one warehouse query. Cached rows carry the ACL keys
-- of the caller they were fetched for: a shared cache across principals is a
-- cross-tenant leak wearing a performance optimisation.
create table query_cache (
  key         text primary key,
  space_id    text not null references spaces(id),
  acl_keys    text[] not null,
  result      jsonb not null,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index on query_cache (expires_at);
