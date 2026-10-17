-- A panel that carries its own query.
--
-- Everything else on a dashboard cites a ratified definition, and that rule is
-- the point of the metric registry: a chart with its own inline aggregate is
-- how six charts come to mean six different things by "refund rate". This is
-- the deliberate exception, asked for and added.
--
-- What keeps it honest is the machinery that already exists rather than a new
-- rule. A SQL panel cites no definition, so `dashboards.render` computes
-- `certified: false` for the dashboard holding it — and that is TRUE, not a
-- penalty: nobody has stood behind this number. The panel says so on its own
-- face, the dashboard says so in its badge, and the generated skill tells an
-- agent the same thing. The escape hatch is available and it is not silent.
--
-- The SQL is stored, so it is inspectable, diffable and reviewable — which is
-- the difference between an escape hatch and a hole.
alter table panel_bindings
  add column sql text;

-- Cheap to ask "which panels carry their own query", which is the
-- recertification question for this feature.
create index if not exists panel_bindings_sql
  on panel_bindings (dashboard_id) where sql is not null;

-- `mark` is constrained to the shapes the renderer knows, which is right — a
-- typo should not reach the grid. One more shape: `sql`, a panel that carries
-- its own query.
--
-- Rewritten in full rather than appended to, so the list is readable in one
-- place. `heatmap` is the stored spelling and `heat` is what the client calls
-- the same thing; both are kept because dropping either silently rejects
-- panels that already exist.
alter table panel_bindings drop constraint if exists panel_bindings_mark_check;
alter table panel_bindings add constraint panel_bindings_mark_check
  check (mark in ('stat', 'line', 'area', 'bar', 'stacked',
                  'heatmap', 'heat', 'table', 'sql'));

-- And it cites no metric, so it stores none.
--
-- This was the hole under the feature. `panels.add` writes a definition for
-- every panel that does not cite one, so a SQL panel — which cites nothing by
-- construction — was silently DEFINING a metric named after its title, and
-- ratifying it if the author held the grant. The dashboard then listed as
-- certified while the dashboard page itself said uncertified, and the registry
-- filled with one-off definitions nobody wrote on purpose. Exactly the drift
-- the registry exists to prevent, produced by the escape hatch meant to be
-- honest about not being in it.
--
-- Null is the accurate value: there is no definition. The composite foreign
-- key is MATCH SIMPLE, so a null metric_id satisfies it without weakening the
-- guarantee for every panel that does cite one.
alter table panel_bindings alter column metric_id     drop not null;
alter table panel_bindings alter column metric_version drop not null;

-- Either both or neither: a version pinning nothing, or a metric pinned to no
-- version, would both read as a binding while being unresolvable.
alter table panel_bindings add constraint panel_bindings_metric_pair
  check ((metric_id is null) = (metric_version is null));

-- A panel is one or the other. Carrying a query AND citing a definition would
-- leave two answers to "where does this number come from" with no rule for
-- which wins.
alter table panel_bindings add constraint panel_bindings_sql_xor_metric
  check ((sql is null) <> (metric_id is null));

-- And it names its own tables, so it binds to no dataset either.
--
-- Same shape as the metric above, one level down. `panels.add` resolves the
-- dashboard's dataset against the panel's connection; for an inline query that
-- dataset is not the thing being read and need not exist there at all. A SQL
-- panel pointed at a SECOND warehouse was refused with "unknown dataset"
-- naming a table that exists — in a different database — which is the same
-- failure per-panel connections were added to fix.
alter table panel_bindings alter column dataset_id drop not null;
alter table panel_bindings add constraint panel_bindings_dataset_or_sql
  check (dataset_id is not null or sql is not null);
