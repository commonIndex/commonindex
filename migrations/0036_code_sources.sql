-- Where each repository indexed from the page came from, so the job worker can
-- index it again on a schedule (commonindex/workers/coderefresh.py).
--
-- A repository added by URL was indexed once and then never again unless an
-- admin indexed it by hand, and a private one needed its token pasted each
-- time: the token was used for one clone and dropped. The token is kept here
-- now, encrypted with COMMONINDEX_SECRET_KEY like a warehouse credential, and
-- never returned by any operation. Without a key it is not kept, and a private
-- repository's refresh fails and says so.
create table code_sources (
  -- The URL's canonical form, or a folder's resolved path: the same key the
  -- page's indexing jobs use, so a refresh and a manual index never overlap.
  key           text not null,
  space_id      text not null references spaces(id) on delete cascade,
  url           text,
  path          text not null,
  branch        text,
  -- Who indexed it. A refresh runs as them, and grants nothing to anyone.
  actor_id      text not null references actors(id) on delete cascade,
  token         bytea,
  created_at    timestamptz not null default now(),
  refreshed_at  timestamptz not null default now(),
  primary key (space_id, key)
);
create index code_sources_due on code_sources (refreshed_at);
