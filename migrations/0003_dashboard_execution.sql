-- Makes the seeded platform metrics actually resolvable, and indexes the
-- columns the dashboard tier groups by.

-- ── the bug ─────────────────────────────────────────────────────────────
-- The undo_after_merge metric shipped referencing proposals.undone, which does
-- not exist. It is the number that matters most for trust — acceptance measures
-- whether work was taken, this measures whether taking it was right — so it
-- gets a real column rather than a quiet removal.
--
-- Set when a merge is reversed. Nullable because most merges are never undone,
-- and a boolean would lose WHEN, which is what makes "undone within a day" and
-- "undone three months later" distinguishable.
alter table proposals add column undone_at timestamptz;
alter table proposals add column undone_by text references actors(id);

-- ── indexes the dashboard tier needs ────────────────────────────────────
-- Every tier-C panel groups proposals by a time bucket within a space, and the
-- window is always bounded, so this is the shape of every query the event-log
-- source issues.
create index on proposals (space_id, created_at desc);
create index on proposals (space_id, author_id, created_at desc);
-- undo_after_merge scans only merged rows, which are a minority
create index on proposals (space_id, created_at) where status = 'merged';

create index on runs (space_id, started_at desc);
create index on runs (space_id, agent_id, started_at desc);

-- ── panels are objects, dashboards are objects ──────────────────────────
-- panel_bindings already carries the metric binding. This is the ordering a
-- dashboard renders its panels in, which is presentation rather than provenance
-- and so belongs on the row.
alter table panel_bindings add column position int not null default 0;
alter table panel_bindings add column mark text not null default 'line'
  check (mark in ('stat','line','area','bar','stacked','heatmap','table'));
alter table panel_bindings add column title text not null default '';

-- ── cache lookup ────────────────────────────────────────────────────────
-- query_cache is read by key on every panel render, and swept by expiry. The
-- key is already the primary key; this is the sweep.
create index on query_cache (space_id, expires_at);
