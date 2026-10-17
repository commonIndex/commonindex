-- A readout, kept as what was said and when.
--
-- Readouts are recomputed on every read and that stays true: a stored number
-- outlives the definition that produced it, which is the argument this platform
-- makes everywhere else. `dashboards.render` computes `certified` rather than
-- storing it for exactly that reason — "a badge you can set by hand is a badge
-- that outlives the thing it certified".
--
-- A recorded readout is a different object from a cached one. It is never
-- served in place of recomputing; it answers a question recomputation cannot:
-- what did this say on the day somebody shipped on it. Without that, "why did
-- we ship?" has no answer a year later, and the readout that justified a
-- decision is gone the moment the data moves.
--
-- So: written only when a caller asks for it (`record: true`), immutable once
-- written, and timestamped.
--
-- ── why the metric reference is in props and not an edge ───────────────
--
-- `edges.src` and `edges.dst` both reference `objects(id)`, so an edge can only
-- join two objects. Metrics and datasets live in their own tables with their own
-- lifecycles, so `readout --measures--> metric` is not expressible, and neither
-- are eight of the ten relations `types/*.json` currently declares
-- (`dashboard.cites.metric`, `metric.defined_on.dataset`, and the rest). That
-- gap is why `edges` has never held a row.
--
-- Rather than drop the foreign key to make the graph accept anything, the
-- references stay in props and are indexed. `readout --for--> experiment` IS
-- object-to-object and is written as a real edge.
create index if not exists objects_props_gin
  on objects using gin (props jsonb_path_ops);

-- The common traversal: every readout for one experiment, newest first.
create index if not exists objects_readout_experiment
  on objects ((props->>'experiment_id'), created_at desc)
  where type = 'readout' and deleted_at is null;
