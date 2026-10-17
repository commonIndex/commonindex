-- Where a warehouse credential actually lives.
--
-- 0002 says `connections.secret_ref` is "a KMS handle, never the secret" and
-- then provides nowhere for the secret to go, so the only way to add a
-- connection was to write the password into the DSN by hand. This is the store
-- that reference points at.
--
-- Deliberately NOT an object. Objects are chunked, embedded and returned by
-- retrieval; a credential that becomes an object is a credential in a vector
-- index, and from there in some agent's context window. Nothing in commonindex/core
-- reads this table — only the connection opener does, at connect time.
create table connection_secrets (
  -- matches connections.secret_ref, as `local:<id>`
  id          text primary key,

  -- Envelope encryption: the payload is encrypted with a data key, and the data
  -- key never leaves the environment. In production this row holds a KMS
  -- ciphertext blob and the key lives in KMS; here the key comes from
  -- COMMONINDEX_SECRET_KEY. The difference is where the key is, not the shape.
  ciphertext  bytea not null,
  key_id      text not null default 'env',

  created_by  text not null references actors(id),
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz
);

-- A connection whose check has never passed should be visibly unusable rather
-- than silently failing on the first panel someone builds on it.
alter table connections add column status text not null default 'unchecked'
  check (status in ('unchecked', 'ok', 'failed'));
