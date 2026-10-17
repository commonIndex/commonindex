-- 0019: messages — comments on objects, and what is said in channels.
--
-- One table for both, because both are a message about a subject: a comment is
-- about a dashboard, a doc or a task; a channel message is about the channel,
-- which is an object like any other. So a conversation can be found from the
-- thing it is about, and the thing can be found from the conversation.
--
-- Threads are one level deep. A reply names the message it answers, and a
-- reply to a reply is filed under its root — a comment thread is a
-- conversation, not a tree anyone has to navigate.
--
-- Mentions are stored as actor ids, resolved when the message is written, so
-- "what was I tagged in" is an index lookup rather than a text search. When an
-- agent is mentioned it is also asked, as an `asked` event naming this message
-- — which is how its inbox, and the thread's "waiting for a reply", know.
create table messages (
  id          text primary key,
  space_id    text not null references spaces(id),
  subject_id  text not null references objects(id),
  parent_id   text references messages(id),
  author_id   text not null references actors(id),
  body        text not null,
  mentions    text[] not null default '{}',
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  -- A tombstone. A deleted message that anchors replies stays as a marker so
  -- the replies still read as answers to something.
  deleted_at  timestamptz
);

create index messages_by_subject on messages (subject_id, created_at);
create index messages_by_mention on messages using gin (mentions);
