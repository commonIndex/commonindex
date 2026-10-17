-- Three more shapes, and the ones that were left out on purpose.
--
-- ADDED, because the data a panel already holds answers them:
--
--   pie    the share each series takes of the whole, which `bar` shows as
--          lengths and this shows as parts. A reader asking "how is it split"
--          is asking a different question from "which is biggest".
--   gauge  one number against the range it has actually been in. A gauge with
--          no target is a decoration, and the honest target here is the
--          window's own low and high — "where in its recent range is it now".
--   pivot  the table with its margins: a total per row and per column. That
--          is the whole difference between a table and a pivot table, and the
--          numbers for it are already on the panel.
--
-- NOT ADDED, and not oversights:
--
--   gantt  needs a START and an END per row. `Query` carries one metric, one
--          optional dimension and one time grain — a bar with two ends is a
--          different query, not a different drawing of this one.
--   radar  the same numbers as `pie` and `bar` with the axis bent into a
--          circle. It is harder to compare lengths on a polar axis than on a
--          straight one, so it would be a shape offered for parity that a
--          reader is worse off choosing.
alter table panel_bindings drop constraint if exists panel_bindings_mark_check;
alter table panel_bindings add constraint panel_bindings_mark_check
  check (mark in ('stat', 'line', 'area', 'bar', 'stacked',
                  'heatmap', 'heat', 'table', 'sql',
                  'pie', 'gauge', 'pivot'));
