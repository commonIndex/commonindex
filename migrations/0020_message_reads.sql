-- 0020: what each person has read, per conversation.
--
-- One row per actor per subject — "Maya read the comments on this dashboard up
-- to here" — which is all unread needs: a message is unread for someone when it
-- is newer than their row for its subject, or there is no row. Notifications
-- are then a query over messages (mentions of you, replies in threads you are
-- in) with this as the read line, not a second table of copies to keep in step.
create table message_reads (
  actor_id    text not null references actors(id),
  subject_id  text not null references objects(id),
  read_at     timestamptz not null default now(),
  primary key (actor_id, subject_id)
);
