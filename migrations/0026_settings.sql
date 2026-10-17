-- Settings an admin changes from the app rather than the deployment's
-- environment: one row per setting, its value, and who changed it last.
--
-- The first is how people sign in here — whether a sign-in is required, or
-- whoever uses the app on the gateway's own computer is signed in as the
-- admin who allowed it. An environment variable of the same meaning, where
-- set, wins, and the app shows the setting as fixed by the deployment.

create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  text references actors(id),
  updated_at  timestamptz not null default now()
);
