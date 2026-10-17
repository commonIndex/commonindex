-- Filters, ranking and a row limit on a panel binding.
--
-- `Query` has carried `filters` and `limit` since the first cut and nothing
-- could ever set them: no gateway operation accepted either, so every panel was
-- necessarily about the whole table. "Failed runs per day" was not expressible.
--
-- Stored on the binding rather than inside the metric expression, deliberately.
-- A metric says what a number MEANS and must mean the same thing everywhere it
-- is cited; "runs, but only the failed ones" is a question this panel asks, not
-- a different definition of a run. Baking the predicate into the expression is
-- how one workspace ends up with six metrics that are all `COUNT(*)` with
-- different WHERE clauses welded on.
alter table panel_bindings
  add column filters   jsonb not null default '[]',
  add column row_limit int   not null default 0,
  -- 'bucket' | 'value_desc' | 'value_asc'
  add column sort      text  not null default 'bucket'
              check (sort in ('bucket', 'value_desc', 'value_asc'));
