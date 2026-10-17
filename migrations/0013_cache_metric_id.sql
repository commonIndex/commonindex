-- What a cached result was computed from.
--
-- `PgQueryCache.invalidate_metric` deletes "everything computed from a metric"
-- and matched on `result::text like '%metric_id%'` — against a payload that
-- `put` writes as `{"columns": …, "rows": …}`. The metric id is not in it, so
-- the delete matched nothing and always returned zero. The docstring above it
-- states exactly what that costs: "without it, changing what a number means
-- leaves the old number on screen until a TTL expires — which is precisely the
-- drift the registry exists to prevent, reappearing one layer down."
--
-- The comment justifying the LIKE says the metric id is "one of its inputs"
-- and the key "is a hash". Both true, and neither makes a hash searchable by
-- its inputs. A column does.
alter table query_cache add column metric_id text;

create index if not exists query_cache_metric
  on query_cache (space_id, metric_id);
