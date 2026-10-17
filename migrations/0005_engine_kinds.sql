-- The wizard offers DuckDB and SQLite, the op schema accepts them, the driver
-- table has DSNs for them — and the check constraint from 0002 rejects both, so
-- picking either probed successfully and then 500'd on the insert.
--
-- Widening the constraint rather than narrowing the wizard: both engines are
-- already proven by tests/test_warehouses.py, and SQLite is deliberately the
-- stress case there because it has no DATE_TRUNC.
alter table connections drop constraint connections_kind_check;
alter table connections add constraint connections_kind_check check (kind in (
  'semantic-cube', 'semantic-dbt', 'semantic-superset',
  'postgres', 'bigquery', 'snowflake', 'duckdb', 'sqlite',
  'eventlog'
));
