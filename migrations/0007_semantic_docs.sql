-- Reference documentation, on the objects it describes.
--
-- An analytics agent goes wrong in three ways: concept-to-entity ambiguity,
-- staleness, and retrieval failure. The second and third are structural — but
-- the first is a documentation gap, and it is the one that needs a human to
-- write a sentence. Good reference docs carry table grain, scope, required
-- filters and gotchas, written for retrieval rather than for a wiki.
--
-- Stored beside the definition rather than in a separate repo, because a doc
-- that lives somewhere else is a doc that goes stale — which is failure mode
-- two, reintroduced by where you put the fix for failure mode one.
alter table datasets
  -- what one row IS. "one proposal" vs "one proposal per reviewer" is the
  -- difference between a correct count and a plausible wrong one.
  add column grain_note  text not null default '',
  add column description text not null default '',
  -- Predicates that must be applied for the numbers to mean anything —
  -- "required filters". Advisory here, and surfaced to whoever
  -- builds a panel, rather than silently welded into the source.
  add column caveats     text not null default '';

alter table metrics
  add column description text not null default '';
