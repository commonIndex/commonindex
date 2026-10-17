-- A workspace's admins can see and manage everything in it.
--
-- A private item answered only to grants on itself, so the workspace admin
-- could not open, publish, re-share or delete a member's private doc,
-- dashboard, design, video or channel — and once that member was removed,
-- nobody could, ever. An admin is the workspace's superuser now.
--
-- Every item carries the key `admins:<space>` beside its own keys, and every
-- admin of that space holds it (PgChecker.acl_keys_for). Lists, search and
-- pushed changes all filter on `acl_keys && the reader's keys`, so they show
-- admins everything with no special case; the access check
-- (sharing.level) gives an admin "manage". Enforced here, by trigger, so no
-- path that writes an item's keys can leave the admin key out.
--
-- The trigger runs after objects_default_acl (triggers run in name order):
-- an item given no keys still opens to its space first, and only then gains
-- the admin key — which on its own would have made it private.

create function acl_admin_key() returns trigger language plpgsql as $$
begin
  if not (('admins:' || new.space_id) = any(new.acl_keys)) then
    new.acl_keys := new.acl_keys || ('admins:' || new.space_id);
  end if;
  return new;
end
$$;

create trigger objects_zz_admin_key before insert or update on objects
  for each row execute function acl_admin_key();

create trigger chunks_zz_admin_key before insert or update on chunks
  for each row execute function acl_admin_key();

update objects set acl_keys = acl_keys || ('admins:' || space_id)
  where not (('admins:' || space_id) = any(acl_keys));
update chunks set acl_keys = acl_keys || ('admins:' || space_id)
  where not (('admins:' || space_id) = any(acl_keys));
