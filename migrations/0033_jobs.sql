-- Background work, run by a worker rather than inside the web server
-- (commonindex/workers/jobs.py): video renders, page snapshots, code indexing.
create table jobs (
  id            text primary key,
  kind          text not null,
  -- What the job is about, for "already running" — a repository's path, say.
  key           text,
  space_id      text,
  payload       jsonb not null default '{}',
  -- A secret the job needs (a clone token), encrypted with COMMONINDEX_SECRET_KEY,
  -- and wiped when the job ends.
  secret        bytea,
  state         text not null default 'queued'
                check (state in ('queued', 'running', 'done', 'failed')),
  progress      jsonb not null default '{}',
  error         text,
  attempts      int not null default 0,
  max_attempts  int not null default 1,
  run_after     timestamptz not null default now(),
  locked_at     timestamptz,
  worker        text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index jobs_queued on jobs (kind, created_at) where state = 'queued';
create index jobs_running on jobs (kind, locked_at) where state = 'running';
create index jobs_by_key on jobs (kind, key, created_at desc);
