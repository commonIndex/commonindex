-- A message is a comment (the conversation about an item) or an update (a
-- dated note on how the work is going — a task's Updates tab). Same table, same
-- mentions, same permissions: an update is a message that is read apart.
alter table messages add column if not exists kind text not null default 'comment'
  check (kind in ('comment', 'update'));
create index if not exists messages_subject_kind on messages (space_id, subject_id, kind, created_at);
