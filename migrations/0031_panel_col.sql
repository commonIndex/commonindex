-- Where a panel starts across the dashboard's twelve columns. Null keeps the
-- flow: each panel after the last. Set, a panel sits at that column in its row,
-- so a gap is somewhere the author put it rather than wherever the next panel
-- happened not to fit.
alter table panel_bindings add column if not exists col smallint
  check (col is null or col between 1 and 12);
