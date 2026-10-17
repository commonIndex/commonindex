-- Identity that is not self-asserted.
--
-- Every operation took `actor_id` from the request body. `metrics.ratify`
-- checked that actor's trust tier before allowing a ratification — a real check
-- against a value the caller chose for itself, which is not a check at all. Any
-- caller could ratify as anybody, and once the MCP transport shipped that was
-- true for every agent on 36 operations.
--
-- A token maps to an actor. The token itself is never stored: only its SHA-256,
-- so a dump of this table does not let the reader authenticate as anyone. That
-- also means a lost token cannot be recovered, only replaced, which is the
-- correct trade.
create table actor_tokens (
  id         text primary key,
  actor_id   text not null references actors(id) on delete cascade,
  -- Hex SHA-256 of the bearer token. Unique so two actors cannot share one.
  token_hash text not null unique,
  label      text not null default '',
  expires_at timestamptz,
  last_used  timestamptz,
  created_at timestamptz not null default now(),
  created_by text not null references actors(id)
);
create index on actor_tokens (actor_id);

-- ── grants ────────────────────────────────────────────────────────────
--
-- `commonindex/core/authz` has declared a Checker protocol since the first commit
-- ("one check per operation at the gateway") with no implementation, and this
-- table has never held a row. Every operation declares the relation it needs
-- and nothing read it except the /_ops listing.
--
-- Relations are ordered: admin > merge > propose > read. A grant of `propose`
-- satisfies an operation needing `read`, which is why the check compares rank
-- rather than equality.
insert into grants (id, subject, relation, resource, granted_by)
select 'g-bootstrap-' || a.id, a.id,
       case when a.kind = 'human' then 'admin' else 'propose' end,
       'space:pay', a.id
from actors a
on conflict (id) do nothing;
