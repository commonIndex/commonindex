-- Every agent has a human who answers for it.
--
-- `actors.owner_id` has existed since 0001 and is read in exactly zero places.
-- The UI type declares it — "the human answerable for this agent's conduct.
-- Every agent has one" — and nothing has ever required, set, or shown one. It
-- is the single field that makes an agent accountable to a person, and it was
-- decoration.
--
-- NOT VALID on purpose. The three agents that already exist have no owner, and
-- a migration that invents one would be worse than the gap: it would put a
-- name against conduct that person never agreed to answer for. So the
-- constraint binds every agent created from here on, the existing three stay
-- as they are, and the agents page shows them as unowned — which is a thing to
-- fix rather than a thing to hide.
alter table actors add constraint actors_agent_has_owner
  check (kind <> 'agent' or owner_id is not null) not valid;

-- An agent cannot answer for an agent. A CHECK cannot read another row, so the
-- rule lives in the handler and this index is what makes the lookup it does
-- cheap — and what lets "which agents does this person answer for" be a
-- question with an answer.
create index if not exists actors_owner on actors (owner_id) where owner_id is not null;
