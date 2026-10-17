-- 0021: conversations about things that are not objects — an agent, a skill.
--
-- A conversation was about an object, held to it by a foreign key. Two of the
-- collections people talk about are not objects: an agent is an actor, and
-- skills are not stored here at all. So a subject is now resolved rather than
-- joined — an object in the space, else an agent, else a skill somebody has
-- talked about — and the keys to `objects` go. `messages.post` resolves the
-- subject before it writes anything, which is the check the keys made.
--
-- An agent needs no row: its name is on its actor. A skill does, because
-- nothing here knows what one is called. The first comment on a skill names
-- it, and that name is what notifications and an agent's inbox show.
alter table messages drop constraint messages_subject_id_fkey;
alter table message_reads drop constraint message_reads_subject_id_fkey;

create table conversation_subjects (
  space_id    text not null references spaces(id),
  id          text not null,
  type        text not null check (type in ('skill')),
  key         text,
  title       text not null,
  created_by  text not null references actors(id),
  created_at  timestamptz not null default now(),
  primary key (space_id, id)
);
