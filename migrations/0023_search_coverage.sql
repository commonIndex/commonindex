-- 0023: the rest of the workspace, searchable.
--
-- 0022 indexed each item by its own fields. Much of what a page shows is
-- stored beside it — a dashboard's panels and the definitions they chart, an
-- experiment's registration, readouts and decisions — so a dashboard was found
-- by its title and nothing else. The indexer now folds those in as sections of
-- the item (commonindex/workers/parts.py). That needs every item indexed again:
-- `scheme` says which indexer wrote a chunk, and the sweep rebuilds whatever
-- an older one wrote.
--
-- What an item no longer says is kept in `chunk_history`, so an earlier
-- version can be searched: the text as it stood before each round of edits,
-- and when it stopped being true. It carries no permission keys of its own:
-- who may read an earlier version is whoever may read the item now, so search
-- checks the item's keys, which a change of access updates in one place.
--
-- And word indexes on what search now reads directly: metric definitions,
-- datasets, and what agents were asked — the runs that answered.

alter table chunks add column scheme smallint not null default 0;

create table chunk_history (
  id          bigserial primary key,
  object_id   text not null references objects(id) on delete cascade,
  space_id    text not null references spaces(id),
  object_type text not null,
  heading     text,
  body        text not null,
  said_until  timestamptz not null default now(),
  tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A')
    || setweight(to_tsvector('english', body), 'B')) stored
);
create index chunk_history_tsv on chunk_history using gin (tsv);
create index chunk_history_object on chunk_history (object_id, said_until desc);

-- The expressions below are the ones search.py matches with, word for word:
-- an expression index is used only by a query that repeats it.
create index metrics_words on metrics using gin (to_tsvector('english',
  label || ' ' || description || ' ' || coalesce(unit, '') || ' ' || expr));

create index datasets_words on datasets using gin (to_tsvector('english',
  translate(name, '._-', '   ') || ' ' || description || ' ' || caveats || ' ' || grain_note));

create index events_asked_words on events using gin (to_tsvector('english',
  coalesce(payload->>'agent', '') || ' ' || coalesce(payload->>'note', '')))
  where verb = 'asked';
