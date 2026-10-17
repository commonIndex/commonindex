-- 0024: a person has an email, so an item can be shared with them by it.
--
-- Sharing a dashboard, doc or design names people by email, and only people
-- already in the workspace: an email is how a person is recognised, never how
-- one is created. Unique regardless of case, because two actors answering to
-- one address would make "shared with maya@" mean whichever row came first.
-- Agents have none; they are shared with by being in the workspace.

alter table actors add column email text;
create unique index actors_email on actors (lower(email)) where email is not null;
alter table actors add constraint actors_email_human check (email is null or kind = 'human');

-- What everyone in the workspace may do with an item opened to it: view or
-- edit. Null on an item opened before this choice existed, where each member's
-- workspace role applies as it always did.
alter table objects add column general_access text
  check (general_access is null or general_access in ('view', 'edit'));
