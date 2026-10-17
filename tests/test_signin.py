"""Signing in, against a real database and a fake identity provider.

An invitation link was a token, and the token was the person's password for
good. Defended now:

* a sign-in code buys a session once, and not after it expires;
* a session ends when its person signs out, or an admin signs them out;
* single sign-on: the round trip checks state, PKCE, signature, audience and
  nonce, finds the person by email, and only a member — or someone whose
  domain may join — gets in;
* the trusted proxy is believed only when the request provably came through it;
* a signed-in browser's request from another site is refused;
* the first admin is made from the environment, with a link to sign in once;
* a token for the CLI is made from a signed-in browser, never with a token.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.parse
from base64 import urlsafe_b64encode
from http.cookies import SimpleCookie

import pytest
from db import DSN, reset, seed

asyncpg = pytest.importorskip("asyncpg")
jwt = pytest.importorskip("jwt")
pytestmark = pytest.mark.integration

ENV = ["COMMONINDEX_SIGN_IN", "COMMONINDEX_GOOGLE_CLIENT_ID", "COMMONINDEX_GOOGLE_CLIENT_SECRET", "COMMONINDEX_SMTP_HOST", "COMMONINDEX_MAIL_LOG",
       "COMMONINDEX_SSO_ISSUER", "COMMONINDEX_SSO_CLIENT_ID", "COMMONINDEX_SSO_CLIENT_SECRET", "COMMONINDEX_SSO_NAME",
       "COMMONINDEX_JOIN_DOMAINS", "COMMONINDEX_JOIN_ROLE", "COMMONINDEX_PROXY_EMAIL_HEADER", "COMMONINDEX_PROXY_SECRET",
       "COMMONINDEX_PROXY_IPS", "COMMONINDEX_ADMIN_EMAIL", "COMMONINDEX_SPACE", "COMMONINDEX_PUBLIC_URL", "COMMONINDEX_GATEWAY_URL"]


@pytest.fixture
async def db(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    await conn.execute("""
        update actors set email = 'maya@example.test' where id = 'maya';
        insert into grants (id, subject, relation, resource, granted_by)
          values ('g-maya', 'maya', 'admin', 'space:pay', 'maya');
    """)
    from commonindex.gateway import signin

    signin._DISCOVERY.clear()
    signin._MODE.clear()
    try:
        yield conn
    finally:
        await conn.close()


class _PoolOf:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Held:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_):
                return False

        return _Held()

    def __getattr__(self, name):
        return getattr(self._conn, name)


class _Req:
    def __init__(self, conn, *, body=None, cookies=None, headers=None, query=None, client="10.0.0.9",
                 principal=None):
        from starlette.datastructures import Headers, QueryParams

        self._body = body or {}
        self.cookies = cookies or {}
        self.headers = Headers(headers or {})
        self.query_params = QueryParams(query or {})
        self.client = type("C", (), {"host": client})()
        self.state = type("S", (), {"principal": principal, "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {"pool": _PoolOf(conn)}})()})()

    async def json(self):
        return self._body


def cookies_of(response) -> dict[str, str]:
    jar = SimpleCookie()
    for name, value in response.raw_headers:
        if name.decode() == "set-cookie":
            jar.load(value.decode())
    return {k: m.value for k, m in jar.items()}


def body_of(response):
    return response.status_code, json.loads(response.body)


async def invite(db, email="rhea@example.test"):
    from commonindex.gateway.members import members_invite

    req = _Req(db, body={"name": "Rhea", "email": email, "role": "viewer", "idempotencyKey": "k"},
               principal=type("P", (), {"actor_id": "maya", "via": "session"})())
    req.state.space = "pay"
    out = await members_invite(req)
    return out if isinstance(out, dict) else json.loads(out.body)


# ── codes and sessions ──────────────────────────────────────────────────


async def test_a_sign_in_code_buys_a_session_once(db):
    from commonindex.gateway.signin import COOKIE, auth_redeem, session_principal

    code = (await invite(db))["token"]
    response = await auth_redeem(_Req(db, body={"code": code}))
    assert response.status_code == 200
    secret = cookies_of(response)[COOKIE]
    assert (await session_principal(db, secret)).actor_id == "rhea"
    status, out = body_of(await auth_redeem(_Req(db, body={"code": code})))   # a second time
    assert (status, out["error"]["code"]) == (401, "bad_code")


async def test_an_expired_code_buys_nothing(db):
    from commonindex.gateway.signin import auth_redeem

    code = (await invite(db))["token"]
    await db.execute("update sign_in_codes set expires_at = now() - interval '1 minute'")
    status, _ = body_of(await auth_redeem(_Req(db, body={"code": code})))
    assert status == 401


async def test_signing_out_ends_the_session_on_the_server(db):
    from commonindex.gateway.signin import COOKIE, auth_logout, session_principal, start_session

    secret = await start_session(db, "maya", "code")
    response = await auth_logout(_Req(db, cookies={COOKIE: secret}))
    assert response.status_code == 200 and await session_principal(db, secret) is None


async def test_a_session_ends_on_its_date(db):
    from commonindex.gateway.signin import session_principal, start_session

    secret = await start_session(db, "maya", "code")
    await db.execute("update sessions set expires_at = now() - interval '1 second'")
    assert await session_principal(db, secret) is None


# ── single sign-on ──────────────────────────────────────────────────────

ISSUER = "https://idp.example.test"


@pytest.fixture
def idp(monkeypatch):
    """An OIDC provider that signs with a real key, so verification is real."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    from commonindex.gateway import signin

    monkeypatch.setenv("COMMONINDEX_SSO_ISSUER", ISSUER)
    monkeypatch.setenv("COMMONINDEX_SSO_CLIENT_ID", "commonindex-app")
    monkeypatch.setenv("COMMONINDEX_SSO_CLIENT_SECRET", "s3cret")
    monkeypatch.setenv("COMMONINDEX_SSO_NAME", "Okta")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())) | {"kid": "k1", "use": "sig"}

    class Idp:
        def __init__(self):
            self.claims, self.seen, self.signing_key = {}, [], key

        def token(self, nonce):
            now = int(time.time())
            claims = {"iss": ISSUER, "aud": "commonindex-app", "sub": "u-1", "email": "maya@example.test",
                      "email_verified": True, "name": "Maya", "iat": now, "exp": now + 300, "nonce": nonce}
            claims.update(self.claims)
            return jwt.encode(claims, self.signing_key, "RS256", headers={"kid": "k1"})

    fake = Idp()

    async def http(url, data=None, auth=None):
        fake.seen.append((url, data, auth))
        if url.endswith("/.well-known/openid-configuration"):
            return {"issuer": ISSUER, "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token", "jwks_uri": f"{ISSUER}/keys"}
        if url == f"{ISSUER}/keys":
            return {"keys": [public]}
        if url == f"{ISSUER}/token":
            return {"id_token": fake.token(fake.nonce), "access_token": "at"}
        raise AssertionError(url)

    monkeypatch.setattr(signin, "http", http)
    return fake


async def go_round(db, idp, *, return_to="/docs", cookie=True):
    """Start, 'sign in at the provider', and come back. The callback's response."""
    from commonindex.gateway.signin import SSO_COOKIE, sso_callback, sso_start

    start = await sso_start(_Req(db, query={"return_to": return_to}))
    where = urllib.parse.urlparse(start.headers["location"])
    q = dict(urllib.parse.parse_qsl(where.query))
    idp.nonce, idp.challenge = q["nonce"], q["code_challenge"]
    state = cookies_of(start)[SSO_COOKIE] if cookie else "someone-else's"
    return q, await sso_callback(_Req(db, query={"state": q["state"], "code": "auth-code"},
                                      cookies={SSO_COOKIE: state}))


async def test_single_sign_on_signs_a_member_in(db, idp):
    from commonindex.gateway.signin import COOKIE, session_principal

    q, back = await go_round(db, idp)
    assert q["code_challenge_method"] == "S256" and q["redirect_uri"].endswith("/auth/sso/callback")
    assert back.headers["location"] == "http://localhost:5173/docs"
    assert (await session_principal(db, cookies_of(back)[COOKIE])).actor_id == "maya"
    # PKCE: what the provider was sent hashes to what it was shown.
    _, sent, auth = next(s for s in idp.seen if s[0].endswith("/token"))
    verifier = hashlib.sha256(sent["code_verifier"].encode()).digest()
    assert urlsafe_b64encode(verifier).rstrip(b"=").decode() == idp.challenge and auth == ("commonindex-app", "s3cret")


async def test_a_way_back_another_browser_began_is_refused(db, idp):
    _, back = await go_round(db, idp, cookie=False)
    assert "/signin?error=sso_stale" in back.headers["location"]


async def test_a_token_for_another_app_or_sign_in_is_refused(db, idp):
    idp.claims = {"aud": "some-other-app"}
    _, back = await go_round(db, idp)
    assert "/signin?error=sso_failed" in back.headers["location"]
    idp.claims = {"iss": "https://some-other-idp.test"}      # signed by the right key, from elsewhere
    _, back = await go_round(db, idp)
    assert "/signin?error=sso_failed" in back.headers["location"]
    idp.claims = {"nonce": "replayed"}
    _, back = await go_round(db, idp)
    assert "/signin?error=sso_failed" in back.headers["location"]


async def test_a_token_signed_with_another_key_is_refused(db, idp):
    from cryptography.hazmat.primitives.asymmetric import rsa

    idp.signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    _, back = await go_round(db, idp)
    assert "/signin?error=sso_failed" in back.headers["location"]


async def test_someone_not_invited_is_not_let_in(db, idp):
    idp.claims = {"email": "stranger@elsewhere.test"}
    _, back = await go_round(db, idp)
    assert "/signin?error=not_invited" in back.headers["location"]
    idp.claims = {"email_verified": False}
    _, back = await go_round(db, idp)
    assert "/signin?error=email_unverified" in back.headers["location"]


async def test_a_domain_the_workspace_lets_join_joins(db, idp, monkeypatch):
    monkeypatch.setenv("COMMONINDEX_JOIN_DOMAINS", "example.test")
    idp.claims = {"email": "ana@example.test", "name": "Ana Ruiz"}
    _, back = await go_round(db, idp, return_to="//evil.test")   # and no landing elsewhere
    assert back.headers["location"] == "http://localhost:5173/"
    row = await db.fetchrow("select a.display, g.relation from actors a join grants g on g.subject = a.id"
                            " where a.email = 'ana@example.test' and g.resource = 'space:pay'")
    assert (row["display"], row["relation"]) == ("Ana Ruiz", "propose")


async def test_with_single_sign_on_an_invitation_has_nothing_to_send(db, idp):
    out = await invite(db)
    assert out["token"] is None and out["sign_in"] == {"method": "sso", "name": "Okta"}


# ── the trusted proxy ───────────────────────────────────────────────────


async def test_the_proxy_is_believed_only_when_it_is_the_proxy(db, monkeypatch):
    from commonindex.gateway.signin import proxy, resolve

    monkeypatch.setenv("COMMONINDEX_PROXY_EMAIL_HEADER", "X-Goog-Authenticated-User-Email")
    assert proxy() is None   # a header and nothing to prove the proxy sent it: off
    monkeypatch.setenv("COMMONINDEX_PROXY_SECRET", "between-us")
    header = {"X-Goog-Authenticated-User-Email": "accounts.google.com:maya@example.test"}
    found = await resolve(_Req(db, headers=header | {"X-CommonIndex-Proxy-Secret": "between-us"}), None, _PoolOf(db))
    assert (found.actor_id, found.via) == ("maya", "proxy")
    assert await resolve(_Req(db, headers=header), None, _PoolOf(db)) is None
    monkeypatch.delenv("COMMONINDEX_PROXY_SECRET")
    monkeypatch.setenv("COMMONINDEX_PROXY_IPS", "10.1.0.0/16")
    assert await resolve(_Req(db, headers=header, client="10.1.4.2"), None, _PoolOf(db))
    assert await resolve(_Req(db, headers=header, client="203.0.113.7"), None, _PoolOf(db)) is None


async def test_with_a_proxy_only_members_get_in(db, monkeypatch):
    from commonindex.gateway.signin import resolve

    monkeypatch.setenv("COMMONINDEX_PROXY_EMAIL_HEADER", "X-Forwarded-Email")
    monkeypatch.setenv("COMMONINDEX_PROXY_SECRET", "between-us")
    req = _Req(db, headers={"X-Forwarded-Email": "stranger@example.test", "X-CommonIndex-Proxy-Secret": "between-us"})
    assert await resolve(req, None, _PoolOf(db)) is None


# ── who is asking ───────────────────────────────────────────────────────


async def test_a_session_comes_before_a_token_and_a_bad_token_says_so(db):
    from commonindex.core.authz.store import NoSuchToken, PgChecker
    from commonindex.gateway.signin import COOKIE, resolve, start_session

    secret = await start_session(db, "maya", "code")
    found = await resolve(_Req(db, cookies={COOKIE: secret}, headers={"authorization": "Bearer ci_whatever"}),
                          PgChecker(db), _PoolOf(db))
    assert (found.actor_id, found.via) == ("maya", "session")
    with pytest.raises(NoSuchToken):
        await resolve(_Req(db, headers={"authorization": "Bearer ci_whatever"}), PgChecker(db), _PoolOf(db))
    assert await resolve(_Req(db), PgChecker(db), _PoolOf(db)) is None


def test_a_signed_in_browser_is_not_driven_from_another_site():
    from commonindex.core.authz.store import Principal
    from commonindex.gateway.signin import cross_site

    person = Principal("maya", "human", "standard", "ses-1", via="session")
    agent = Principal("scribe", "agent", "standard", "tok-1", via="token")
    req = _Req(None, headers={"origin": "https://evil.test"})
    assert cross_site(req, person) and not cross_site(req, agent)
    assert not cross_site(_Req(None, headers={"origin": "http://localhost:5173"}), person)


# ── the first admin ─────────────────────────────────────────────────────


async def test_the_first_admin_is_made_from_the_environment(db, monkeypatch):
    from commonindex.gateway.signin import bootstrap

    monkeypatch.setenv("COMMONINDEX_ADMIN_EMAIL", "founder@newco.test")
    monkeypatch.setenv("COMMONINDEX_SPACE", "newco")
    await bootstrap(_PoolOf(db))
    await bootstrap(_PoolOf(db))   # again, on the next start: nothing new
    assert await db.fetchval("select 1 from spaces where id = 'newco'")
    assert await db.fetchval("select relation from grants g join actors a on a.id = g.subject"
                             " where a.email = 'founder@newco.test' and g.resource = 'space:newco'") == "admin"
    assert await db.fetchval("select count(*) from sign_in_codes s join actors a on a.id = s.actor_id"
                             " where a.email = 'founder@newco.test'") == 1


# ── tokens for tools ────────────────────────────────────────────────────


async def test_a_token_for_the_cli_is_made_from_a_signed_in_browser(db):
    from commonindex.core.authz.store import PgChecker, Principal
    from commonindex.gateway.tokens import tokens_create, tokens_list, tokens_revoke

    as_token = Principal("maya", "human", "standard", "tok-x", via="token")
    status, out = body_of(await tokens_create(_Req(db, body={"label": "laptop"}, principal=as_token)))
    assert (status, out["error"]["code"]) == (403, "needs_sign_in")
    browser = Principal("maya", "human", "standard", "ses-x", via="session")
    made = await tokens_create(_Req(db, body={"label": "laptop CLI", "days": 30}, principal=browser))
    assert (await PgChecker(db).principal(made["token"])).actor_id == "maya"
    listed = await tokens_list(_Req(db, principal=browser))
    assert [t["label"] for t in listed["tokens"]] == ["laptop CLI"] and listed["tokens"][0]["expires_at"]
    await tokens_revoke(_Req(db, body={"id": made["id"]}, principal=browser))
    with pytest.raises(Exception):  # noqa: B017 - NoSuchToken
        await PgChecker(db).principal(made["token"])


# ── Google ──────────────────────────────────────────────────────────────


async def test_continue_with_google(db, monkeypatch):
    """Google is one more OpenID provider, with its own issuer and button."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    from commonindex.gateway import signin
    from commonindex.gateway.signin import (
        COOKIE,
        SSO_COOKIE,
        session_principal,
        sso_callback,
        sso_start,
    )

    monkeypatch.setenv("COMMONINDEX_GOOGLE_CLIENT_ID", "app.apps.googleusercontent.com")
    monkeypatch.setenv("COMMONINDEX_GOOGLE_CLIENT_SECRET", "g-secret")
    assert signin.methods()["google"] and not signin.methods()["code"]
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())) | {"kid": "g1"}
    seen = {}

    async def http(url, data=None, auth=None):
        if url.endswith("/.well-known/openid-configuration"):
            assert url.startswith("https://accounts.google.com/")
            return {"issuer": "https://accounts.google.com", "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
                    "token_endpoint": "https://oauth2.googleapis.com/token", "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs"}
        if url.endswith("/certs"):
            return {"keys": [public]}
        now = int(time.time())
        return {"id_token": jwt.encode({"iss": "accounts.google.com", "aud": "app.apps.googleusercontent.com",
                                        "sub": "g-1", "email": "maya@example.test", "email_verified": True,
                                        "iat": now, "exp": now + 300, "nonce": seen["nonce"]},
                                       key, "RS256", headers={"kid": "g1"})}

    monkeypatch.setattr(signin, "http", http)
    start = await sso_start(_Req(db, query={"provider": "google"}))
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(start.headers["location"]).query))
    assert start.headers["location"].startswith("https://accounts.google.com/") and q["prompt"] == "select_account"
    seen["nonce"] = q["nonce"]
    back = await sso_callback(_Req(db, query={"state": q["state"], "code": "c"},
                                   cookies={SSO_COOKIE: cookies_of(start)[SSO_COOKIE]}))
    # Google's tokens say their issuer without the scheme; that is still Google.
    assert (await session_principal(db, cookies_of(back)[COOKIE])).actor_id == "maya"


# ── a code sent to the person's email ───────────────────────────────────


@pytest.fixture
def mailbox(monkeypatch):
    from commonindex.gateway import mailer

    sent = []
    monkeypatch.setenv("COMMONINDEX_MAIL_LOG", "1")

    async def send(to, subject, text):
        sent.append((to, subject, text))
        return True

    monkeypatch.setattr(mailer, "send", send)
    return sent


def code_in(text):
    import re

    return re.search(r"\b(\d{6})\b", text).group(1)


async def test_a_code_by_email_signs_a_member_in(db, mailbox):
    from commonindex.gateway.signin import COOKIE, email_start, email_verify, session_principal

    out = await email_start(_Req(db, body={"email": "Maya@Example.test"}))
    assert out["sent"] and len(mailbox) == 1
    code = code_in(mailbox[0][2])
    wrong = await email_verify(_Req(db, body={"email": "maya@example.test", "code": "000000" if code != "000000" else "111111"}))
    assert wrong.status_code == 401
    response = await email_verify(_Req(db, body={"email": "maya@example.test", "code": code}))
    assert (await session_principal(db, cookies_of(response)[COOKIE])).actor_id == "maya"
    again = await email_verify(_Req(db, body={"email": "maya@example.test", "code": code}))
    assert again.status_code == 401                                        # once only


async def test_the_link_in_the_email_signs_in_too(db, mailbox):
    import re

    from commonindex.gateway.signin import email_start, email_verify

    await email_start(_Req(db, body={"email": "maya@example.test"}))
    link = urllib.parse.unquote(re.search(r"#email=(\S+)", mailbox[0][2]).group(1))
    assert (await email_verify(_Req(db, body={"link": link}))).status_code == 200


async def test_a_stranger_is_sent_nothing_and_told_nothing(db, mailbox):
    from commonindex.gateway.signin import email_start

    out = await email_start(_Req(db, body={"email": "stranger@elsewhere.test"}))
    assert out["sent"] and mailbox == []          # the same answer, and no email


async def test_five_wrong_guesses_and_the_code_is_done(db, mailbox):
    from commonindex.gateway.signin import email_start, email_verify

    await email_start(_Req(db, body={"email": "maya@example.test"}))
    code = code_in(mailbox[0][2])
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        await email_verify(_Req(db, body={"email": "maya@example.test", "code": wrong}))
    status, out = body_of(await email_verify(_Req(db, body={"email": "maya@example.test", "code": code})))
    assert (status, out["error"]["code"]) == (429, "too_many_guesses")


async def test_a_domain_that_may_join_joins_once_the_email_is_shown_theirs(db, mailbox, monkeypatch):
    from commonindex.gateway.signin import email_start, email_verify

    monkeypatch.setenv("COMMONINDEX_JOIN_DOMAINS", "example.test")
    await email_start(_Req(db, body={"email": "new@example.test"}))
    assert not await db.fetchval("select 1 from actors where email = 'new@example.test'")   # not yet
    await email_verify(_Req(db, body={"email": "new@example.test", "code": code_in(mailbox[0][2])}))
    assert await db.fetchval("select 1 from actors where email = 'new@example.test'")


async def test_with_email_sign_in_an_invitation_is_emailed_and_has_no_link(db, mailbox):
    out = await invite(db)
    assert out["token"] is None and out["sign_in"]["method"] == "email" and out["emailed"]
    to, _subject, text = mailbox[-1]
    assert to == "rhea@example.test" and "invited you" in text and "ehc_" not in text


# ── no sign-in, on this computer ────────────────────────────────────────

ON_THIS_COMPUTER = {"host": "localhost:8000"}


async def set_mode(db, mode, actor="maya"):
    from commonindex.core.authz.store import Principal
    from commonindex.gateway.signin import signin_set_mode

    out = await signin_set_mode(_Req(db, body={"mode": mode, "idempotencyKey": "m"}, client="127.0.0.1",
                                     principal=Principal(actor, "human", "standard", "ses", via="session")))
    return out if isinstance(out, dict) else json.loads(out.body)


async def local(db, *, client="127.0.0.1", headers=ON_THIS_COMPUTER):
    from commonindex.gateway.signin import resolve

    return await resolve(_Req(db, client=client, headers=headers), None, _PoolOf(db))


async def test_a_sign_in_is_required_until_an_admin_says_otherwise(db):
    assert await local(db) is None
    out = await set_mode(db, "local")
    assert (out["mode"], out["as"], out["locked"]) == ("local", "maya", False)
    found = await local(db)
    assert (found.actor_id, found.via) == ("maya", "local")
    await set_mode(db, "required")
    assert await local(db) is None


async def test_local_means_this_computer_and_nothing_that_looks_like_it(db):
    await set_mode(db, "local")
    assert await local(db, client="10.0.0.5") is None                                 # another machine
    assert await local(db, headers=ON_THIS_COMPUTER | {"x-forwarded-for": "203.0.113.9"}) is None   # via a proxy
    assert await local(db, headers={"host": "evil.test:8000"}) is None                # a domain pointed at 127.0.0.1
    assert await local(db, headers={"host": "[::1]:8000"}, client="::1")             # IPv6 loopback is local


def test_a_page_on_another_site_cannot_drive_this_computer():
    from commonindex.core.authz.store import Principal
    from commonindex.gateway.signin import cross_site

    me = Principal("maya", "human", "standard", "local", via="local")
    assert cross_site(_Req(None, headers={"origin": "https://evil.test"}), me)
    assert not cross_site(_Req(None, headers={"origin": "http://localhost:5173"}), me)


async def test_the_deployment_can_fix_the_mode(db, monkeypatch):
    monkeypatch.setenv("COMMONINDEX_SIGN_IN", "required")
    out = await set_mode(db, "local")
    assert out["error"]["code"] == "locked"
    assert await local(db) is None


async def test_local_mode_lapses_with_the_admin_who_turned_it_on(db):
    await set_mode(db, "local")
    await db.execute("update grants set relation = 'read' where id = 'g-maya'")
    assert await local(db) is None


async def test_the_settings_say_how_to_turn_each_method_on(db, monkeypatch):
    from commonindex.gateway.signin import signin_settings

    monkeypatch.setenv("COMMONINDEX_GATEWAY_URL", "https://commonindex.example.test/api")
    out = await signin_settings(_Req(db, client="127.0.0.1", headers=ON_THIS_COMPUTER))
    assert out["redirect_url"] == "https://commonindex.example.test/api/auth/sso/callback"
    assert out["methods"]["google"] == {"on": False, "settings": ["COMMONINDEX_GOOGLE_CLIENT_ID", "COMMONINDEX_GOOGLE_CLIENT_SECRET"]}
    assert out["this_computer"] and out["mode"] == "required"
