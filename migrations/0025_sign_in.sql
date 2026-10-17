-- Signing in, for people.
--
-- A person signed in with the token in their invitation link, and that token
-- was their password from then on: it never expired, signing out only forgot
-- it in one browser, and anyone who saw the link in a chat could be them.
-- Tokens stay, for what they are good at — an agent, the CLI, an MCP client —
-- and people get what a browser should have instead:
--
-- * a session: a cookie holding a random secret, only its hash stored here,
--   ending on its date or when it is revoked (signing out revokes it);
-- * a sign-in code: what an invitation link carries now — used once, and
--   only until it expires, and it buys a session, not a password;
-- * a code sent to their email, as most tools now sign people in: six
--   digits to type, or the link beside them to click — short-lived, tied to
--   the address, and only so many guesses;
-- * a sign-in with Google, or the company's own identity provider (OIDC),
--   whose round trip is remembered here between leaving and coming back.

create table sessions (
  id          text primary key,
  actor_id    text not null references actors(id) on delete cascade,
  secret_hash text not null unique,
  -- How it began: an invitation link, a code sent to their email, or
  -- single sign-on (Google or the company's identity provider).
  via         text not null check (via in ('code', 'email', 'sso')),
  user_agent  text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_used   timestamptz,
  revoked_at  timestamptz
);
create index sessions_by_actor on sessions (actor_id);

create table sign_in_codes (
  id          text primary key,
  actor_id    text not null references actors(id) on delete cascade,
  code_hash   text not null unique,
  created_by  text not null references actors(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index sign_in_codes_by_actor on sign_in_codes (actor_id);

-- A sign-in in flight at the identity provider: the state it must come back
-- with (hashed), the nonce its ID token must carry, the PKCE verifier, and
-- where in the app to land. Used once; a stale one is worthless.
create table sso_logins (
  state_hash  text primary key,
  provider    text not null,
  nonce       text not null,
  verifier    text not null,
  return_to   text not null default '/',
  created_at  timestamptz not null default now()
);

-- A code sent to someone's email to sign in with. The six digits are few, so
-- they count only with the address they were sent to and for a handful of
-- guesses; the link sent with them is long enough to stand alone.
create table email_sign_ins (
  id          text primary key,
  email       text not null,
  code_hash   text not null,
  link_hash   text not null unique,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index email_sign_ins_by_email on email_sign_ins (lower(email), created_at);
