-- How wide a panel is, decided by a person rather than by a heuristic.
--
-- `span` has always existed on the client and never been stored: `spanFor` in
-- Dashboards.tsx derives it from the mark and the number of charts — a stat
-- takes 3 of 12, a table 6, a lone chart the full 12, and everything else half.
-- That is a decent guess and it is only a guess. It cannot know that the
-- heatmap is the point of the page and the two stat tiles beside it are
-- footnotes, and there was no way to tell it.
--
-- Null means "use the heuristic", which is what every existing panel wants:
-- nobody has said otherwise, and defaulting to a number would silently freeze
-- today's guess as tomorrow's decision.
alter table panel_bindings add column span smallint;

-- The grid is twelve columns. A panel wider than the grid is not a panel that
-- renders wrongly — it is one the CSS clamps, so the stored number and the
-- drawn width disagree, which is worse.
alter table panel_bindings add constraint panel_bindings_span_check
  check (span is null or (span >= 2 and span <= 12));
