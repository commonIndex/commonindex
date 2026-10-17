-- An operation asked for with `Prefer: respond-async` runs as a job; its
-- answer is kept on the job for the one who asked (commonindex/gateway/async_ops.py).
alter table jobs add column if not exists actor_id text;
alter table jobs add column if not exists result jsonb;
create index if not exists jobs_by_actor on jobs (actor_id, created_at desc);
