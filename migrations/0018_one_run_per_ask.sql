-- `runs.start` refuses a second claim by SELECTing for an existing run and
-- returning 409 if it finds one. That is a check followed by an insert with
-- nothing between them, so two workers that both read before either writes
-- both pass the check and both insert: two runs, two loops, one ask executed
-- twice. The handler's test called it twice in sequence, which proves the
-- check exists and not that it is a mutex.
--
-- The claim "one run per event" was made in the handler, in its tests and in
-- the commit that shipped it. This is the line that makes it true, and the
-- handler now catches the violation so the loser still gets its 409.
--
-- Partial, because a run with no trigger_seq is one nobody asked for — every
-- seeded run in the fixture is one — and those do not collide.
create unique index runs_one_per_ask
    on runs (space_id, trigger_seq)
 where trigger_seq is not null;
