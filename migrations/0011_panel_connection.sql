-- A panel may read a different warehouse from its dashboard.
--
-- `connection_id` lived only on the dashboard, and the reason given for that
-- was wrong: that a query cannot join a Postgres table to a Snowflake one. True
-- of one panel, and irrelevant to a dashboard — `dashboards.render` runs one
-- query per panel and assembles the results in the application, so a dashboard
-- was never a single query and never needed to be.
--
-- Null means "whatever the dashboard reads", which is what every existing panel
-- means today, so this needs no backfill and a dashboard on one warehouse
-- carries no per-panel bookkeeping.
alter table panel_bindings
  add column connection_id text references connections(id);

-- The lookup render does per panel.
create index if not exists panel_bindings_connection
  on panel_bindings (connection_id) where connection_id is not null;
