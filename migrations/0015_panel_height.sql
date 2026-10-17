-- How tall a panel is.
--
-- 0014 made width a decision instead of a heuristic and stopped there, so a
-- panel could be made wider and never taller. The two are not interchangeable:
-- a heatmap with seven columns and two rows wants width, and a table of thirty
-- rows wants height, and widening the table only moves its scrollbar.
--
-- Stored as the height of the PLOT area in pixels rather than as grid rows.
-- The grid's rows are auto-sized to their content, so a row unit would be a
-- unit whose size depends on what happens to be in the row beside it — the
-- number stored on Monday would mean something different on Tuesday.
--
-- Null means the default, for the same reason it does for `span`: nobody has
-- said, and writing today's constant into the column would freeze it.
alter table panel_bindings add column height smallint;

-- Below about 160px a time series is a strip — the comment on PLOT_H says 208
-- was already too short to read a line in — and past 900 the panel is taller
-- than the viewport it is read in.
alter table panel_bindings add constraint panel_bindings_height_check
  check (height is null or (height >= 160 and height <= 900));
