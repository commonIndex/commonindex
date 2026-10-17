-- 0022: search indexes for everything that is not code.
--
-- Search worked out its keywords at query time, reading every item's text on
-- every keystroke: fine at a few hundred items, four seconds at 300,000. This
-- stores them. Two indexes, the way code search has Zoekt's trigrams for
-- jumping to a file and word search for its contents:
--
--   * quick find — a trigram index on each item's key and title, so ⌘K
--     matches a fragment ("arehous") or a typo ("warehuses") as you type;
--   * content — `chunks` for every type, not only code, with each chunk's
--     heading weighted above its body, and a word index on messages.
--
-- And a permission key on every item. `acl_keys` has been empty on everything
-- but code files since 0001, so no search could filter by it. Each item now
-- carries at least its space's key; an item given keys of its own (a code
-- file, a private import) keeps them.

create extension if not exists pg_trgm;

update objects set acl_keys = array['space:' || space_id] where acl_keys = '{}';

create function objects_default_acl() returns trigger language plpgsql as $$
begin
  if new.acl_keys is null or new.acl_keys = '{}' then
    new.acl_keys := array['space:' || new.space_id];
  end if;
  return new;
end
$$;

create trigger objects_default_acl before insert or update on objects
  for each row execute function objects_default_acl();

create index objects_find_trgm on objects
  using gin ((coalesce(key, '') || ' ' || title) gin_trgm_ops) where deleted_at is null;

-- A chunk's heading — the item's title, or "Doc title › Section" — ranks above
-- its body. The keyword column is regenerated from both, which also rebuilds it
-- for the code chunks already here: their heading is empty, so they rank as
-- before.
alter table chunks add column heading text;
alter table chunks drop column tsv;
alter table chunks add column tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(heading, '')), 'A')
  || setweight(to_tsvector('english', body), 'B')) stored;
create index chunks_tsv on chunks using gin (tsv);

create index messages_words on messages
  using gin (to_tsvector('english', body)) where deleted_at is null;
