-- A share link: a random token that lets anyone holding it read ONE object,
-- as it is now, without an account. Revoking sets revoked_at; the row stays so
-- the history of who shared what survives the link.
--
-- The token is stored as issued, not hashed, unlike actor_tokens. An actor
-- token is a credential that acts; this one only reads the object it names,
-- and the person who shared it has to be able to see and copy the link again
-- tomorrow — which a hash cannot give back.
create table shares (
  token       text primary key,
  object_id   text not null references objects(id) on delete cascade,
  space_id    text not null references spaces(id),
  created_by  text not null references actors(id),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
-- At most one live link per object: sharing twice returns the same link.
create unique index shares_one_live on shares (object_id) where revoked_at is null;
