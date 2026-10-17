-- What the data actually looks like.
--
-- Good reference docs carry table grain,
-- scope, required filters and gotchas. Grain and gotchas need a human and have
-- `grain_note`/`caveats`. Scope does not: how many rows, what period they cover,
-- and — the one that decides whether a filter works — what values each
-- categorical column actually takes.
--
-- Telling an agent that `status` is "sliceable" and stopping there means it
-- guesses the value. `status IN ('merged','rejected')` is the difference between
-- a filter that returns rows and one that silently returns none.
--
-- Stored rather than computed per read, and timestamped, because profiling
-- means scanning the customer's warehouse: doing that on every skill fetch is
-- their bill, not ours to spend. The as-of date is rendered with it, so the
-- reader knows how old the answer is instead of assuming it is live.
alter table datasets
  add column profile     jsonb,
  add column profiled_at timestamptz;
