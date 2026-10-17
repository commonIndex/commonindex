# Signing in

People sign in once, in a browser, and get a **session**: a secure cookie
that lasts 14 days, and ends earlier when they sign out or an admin signs them
out. Tools such as the CLI, MCP clients and agents use **tokens** instead.

Choose how people sign in when you deploy. The gateway reads these settings
from its environment.

## 1. The first admin

A fresh install has nobody in it. Name the first admin:

```sh
COMMONINDEX_ADMIN_EMAIL=ana@example.com      # made admin on start, if not already
COMMONINDEX_ADMIN_NAME="Ana Ruiz"         # optional
COMMONINDEX_SPACE=example                    # the workspace id (default: pay)
COMMONINDEX_SPACE_NAME="Example Co"             # optional
```

On start, the gateway creates the workspace and makes that person its admin.
If single sign-on and the proxy are both off, the gateway also logs a one-time
sign-in link. The link works once and expires after a day. To make an admin by
hand, or to get a new link:

```sh
uv run python scripts/create_admin.py ana@example.com --name "Ana Ruiz"
```

## 2. Sign-in, or no sign-in on this computer

An admin chooses this under **Workspace → Sign-in**:

- **Everyone signs in.** This is the default. People use the methods below.
- **No sign-in on this computer.** Whoever uses the app on the computer running
  the gateway is signed in as the admin who turned this on, with no sign-in
  page. It's for running it on your own, demos and trying it out.

  It only applies to requests that come from that computer itself: a loopback
  address, no proxy forwarding headers, and a `Host` of `localhost`. A
  request from anywhere else still needs a sign-in, so a gateway that
  becomes reachable on a network isn't left open. Requests from another site
  in your browser are refused. If that admin stops being an admin, the mode
  lapses.

A deployment can fix the choice with `COMMONINDEX_SIGN_IN=required` (or `local`).
The page then shows it as set by the deployment. Use `required` for any
shared install.

The same page lists each way to sign in, whether it's on, the settings that
turn it on, and the redirect URL to give Google or your identity provider.

## 3. Choose how people sign in

The sign-in page offers what is set up, the way most tools do: **Continue with
Google**, **Continue with <your company account>**, then **or**, and an email
box. Turn on any combination of these.

### Continue with Google

Create an OAuth client ID ("Web application") in the Google Cloud console,
with this authorized redirect URI:

    https://<gateway>/auth/sso/callback

```sh
COMMONINDEX_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
COMMONINDEX_GOOGLE_CLIENT_SECRET=...
```

People are matched by their Google email. Only members get in, unless their
domain may join (section 3), so a personal Gmail account can't join a company
workspace.

### Continue with email (a code, no password)

Enter an email address, receive a 6-digit code and a one-click link, and sign
in with either. The code is tied to that address, works for 10 minutes, allows
5 guesses, and can be requested at most 5 times an hour. The page answers the
same way whether or not the address is a member, so it can't be used to find
out who is in the workspace. There are no passwords to leak, reuse or reset.

This needs a way to send email. Any SMTP service works (Gmail, Amazon SES,
SendGrid, Postmark, Resend or a company relay):

```sh
COMMONINDEX_SMTP_HOST=smtp.sendgrid.net
COMMONINDEX_SMTP_PORT=587                 # 587 STARTTLS, or 465 TLS
COMMONINDEX_SMTP_USER=apikey
COMMONINDEX_SMTP_PASSWORD=...
COMMONINDEX_MAIL_FROM="Example Co <no-reply@example.com>"
```

With email set up, inviting someone also emails them the invitation, so
nothing needs copying by hand. On a developer's machine, `make dev-gateway`
sets `COMMONINDEX_MAIL_LOG=1`, which writes emails to the gateway's log instead of
sending them. Never turn that on in a deployment.

### Your company's identity provider

Use the company's identity provider: Okta, Microsoft Entra ID, Google
Workspace, Auth0, Keycloak or any other OpenID Connect provider. Register this
app with the provider, with this redirect URL:

    https://<gateway>/auth/sso/callback

Then set:

```sh
COMMONINDEX_SSO_ISSUER=https://example.okta.com          # the provider's issuer URL
COMMONINDEX_SSO_CLIENT_ID=...
COMMONINDEX_SSO_CLIENT_SECRET=...
COMMONINDEX_SSO_NAME="Okta"                           # the button says "Sign in with Okta"
COMMONINDEX_PUBLIC_URL=https://commonindex.example.com       # where the web app is
```

`docker-compose.prod.yml` sets `COMMONINDEX_GATEWAY_URL`, where browsers reach
the gateway, to the same address: its web server passes `/auth/` to the
gateway. Set it yourself only if the gateway has an address of its own, and
then without a path: the callback is `<that address>/auth/sso/callback`.

The sign-in page then shows "Sign in with Okta". The gateway matches the person
by email, and lets them in only if they're a member of the workspace, unless
you let their email domain join (see section 3).

The gateway checks each sign-in fully: the state is tied to the browser, PKCE
is used, and the ID token's signature, issuer, audience, expiry and nonce must
all be valid. It refuses an email the provider hasn't verified.

### Your company's network gateway (behind a VPC)

If a proxy in front of the app already signs people in (Google IAP, Cloudflare
Access, oauth2-proxy, an ingress with auth), the platform can use the email it
passes on. People don't see a sign-in page at all.

```sh
COMMONINDEX_PROXY_EMAIL_HEADER=X-Goog-Authenticated-User-Email   # or X-Forwarded-Email, …
# and at least one way to prove a request came through the proxy:
COMMONINDEX_PROXY_SECRET=...          # the proxy adds X-CommonIndex-Proxy-Secret: <this>
COMMONINDEX_PROXY_IPS=10.8.0.0/16     # and/or: the addresses the proxy sends from
```

Proxy sign-in stays off unless a secret or address list is set. Without one,
anyone who could reach the gateway directly could send the header and sign in
as anyone. Google IAP's `accounts.google.com:` prefix on the email is handled.

### Sign-in links (no identity provider)

If none of the above is set up, an invitation gives the admin a sign-in link
to send. It works once and expires after 7 days (`COMMONINDEX_INVITE_DAYS`). It
starts a session, so it never becomes a permanent password. If someone loses
access, an admin uses **New sign-in link** in Members.

## 4. Letting people join without an invitation

```sh
COMMONINDEX_JOIN_DOMAINS=example.com,example.co.uk
COMMONINDEX_JOIN_ROLE=contributor     # viewer, contributor or reviewer (never admin)
```

Anyone who signs in with Google, single sign-on, an emailed code or the proxy,
with an email on these domains, joins the workspace with that role. They join
only after showing the address is theirs. Everyone else needs an invitation.

## 5. Tools: the CLI and MCP

A signed-in person makes tokens for their own tools under **Tokens for CLI &
MCP**, in the account menu. Each token expires (7 to 365 days) and is shown
once. A token can't be used to make more tokens.

```sh
commonindex login --url https://commonindex.example.com/api --token ci_…
```

For an MCP client, put the token in `COMMONINDEX_TOKEN` (`make mcp-config` prints
an example).

## Sessions

| Setting | Default |
|---|---|
| `COMMONINDEX_SESSION_DAYS` | 14 |
| `COMMONINDEX_INVITE_DAYS` | 7 |
| `COMMONINDEX_ORIGINS` | The web app's origin. Requests from a signed-in browser are accepted only from here, which stops other sites acting on someone's behalf. |

- **Signing out** ends the session on the server.
- **New sign-in link** in Members signs the person out everywhere.
- **Removing someone** from their last workspace ends their sessions and
  tokens.
