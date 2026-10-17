"""How a person signs in, and how the gateway knows who is asking.

Four ways in, and the request says which:

* **A session cookie.** What a browser holds once its person has signed in:
  a random secret, only its hash stored, ending on its date or when revoked.
* **A bearer token.** For what is not a person at a browser: an agent, the
  CLI, an MCP client. Minted for an agent, or by a signed-in person for their
  own tools (`tokens.create`).
* **The company's network gateway.** Behind a proxy that has already signed
  the person in (Google IAP, Cloudflare Access, oauth2-proxy), the gateway
  takes the email it passes on. Only when the request provably came through
  that proxy: a shared secret it adds, or the address it sends from.
* **Nothing yet**, which is a 401, and the web app's sign-in page.

A session begins with a sign-in code (what an invitation link carries — used
once, and only until it expires) or with single sign-on through the company's
identity provider (OIDC). Either way the person is found by email, and only
if they are in the workspace — or their email's domain is one the workspace
lets join on its own.

Settings come from the environment, read when used, so a deployment changes
them without code:

    COMMONINDEX_PUBLIC_URL        where the web app is (http://localhost:5173)
    COMMONINDEX_GATEWAY_URL       where this gateway is, as a browser reaches it
    COMMONINDEX_SPACE             the workspace people join (pay)
    COMMONINDEX_SESSION_DAYS      how long a session lasts (14)
    COMMONINDEX_INVITE_DAYS       how long a sign-in code lasts (7)
    COMMONINDEX_ADMIN_EMAIL       the first admin, made on start if missing
    COMMONINDEX_SSO_ISSUER        the identity provider (an OIDC issuer URL)
    COMMONINDEX_SSO_CLIENT_ID     ... and this app's registration with it
    COMMONINDEX_SSO_CLIENT_SECRET
    COMMONINDEX_SSO_NAME          what the button says ("Okta", "Microsoft")
    COMMONINDEX_JOIN_DOMAINS      email domains that may join on their own
    COMMONINDEX_JOIN_ROLE         the role they join with (contributor)
    COMMONINDEX_PROXY_EMAIL_HEADER  the header a trusted proxy puts the email in
    COMMONINDEX_PROXY_SECRET      ... a secret it adds as X-CommonIndex-Proxy-Secret
    COMMONINDEX_PROXY_IPS         ... or the addresses it sends from (CIDRs)
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from commonindex.core.authz.store import Principal, hash_token

log = logging.getLogger("commonindex.signin")
router = APIRouter()

COOKIE = "ci_session"
#: The browser's half of a single sign-on in flight: the state it must come back with.
SSO_COOKIE = "ci_sso"
#: How long a single sign-on may take between leaving and coming back.
SSO_SECONDS = 600
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ROLES = {"viewer": "read", "contributor": "propose", "reviewer": "merge", "admin": "admin"}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def public_url() -> str:
    return _env("COMMONINDEX_PUBLIC_URL", "http://localhost:5173").rstrip("/")


def gateway_url() -> str:
    return _env("COMMONINDEX_GATEWAY_URL", "http://localhost:8000").rstrip("/")


def space() -> str:
    return _env("COMMONINDEX_SPACE", "pay")


def _days(name: str, default: int) -> int:
    try:
        return max(1, int(_env(name, str(default))))
    except ValueError:
        return default


# ── configuration, as the sign-in page needs to know it ─────────────────


@dataclass(frozen=True)
class Provider:
    """An OpenID Connect identity provider people sign in with."""

    id: str
    issuer: str
    client_id: str
    client_secret: str
    name: str
    #: The issuer values its ID tokens may carry. Google's say either form.
    issuers: tuple[str, ...] = ()


GOOGLE = "https://accounts.google.com"


def providers() -> dict[str, Provider]:
    """Google, when this app is registered with it, and the company's own
    identity provider, when one is named — either, both or neither."""
    found: dict[str, Provider] = {}
    if _env("COMMONINDEX_GOOGLE_CLIENT_ID"):
        found["google"] = Provider("google", GOOGLE, _env("COMMONINDEX_GOOGLE_CLIENT_ID"),
                                   _env("COMMONINDEX_GOOGLE_CLIENT_SECRET"), "Google",
                                   (GOOGLE, "accounts.google.com"))
    issuer, client = _env("COMMONINDEX_SSO_ISSUER"), _env("COMMONINDEX_SSO_CLIENT_ID")
    if issuer and client:
        found["sso"] = Provider("sso", issuer.rstrip("/"), client, _env("COMMONINDEX_SSO_CLIENT_SECRET"),
                                _env("COMMONINDEX_SSO_NAME") or "your company account")
    return found


def sso() -> Provider | None:
    """The company's own identity provider, if one is set up."""
    return providers().get("sso")


@dataclass(frozen=True)
class Proxy:
    header: str
    secret: str
    networks: tuple[Any, ...]


def proxy() -> Proxy | None:
    """The trusted proxy, when one is configured AND can be told apart from
    anyone else. A header alone is not enough: if the gateway can be reached
    without the proxy, anyone could send it and be anyone."""
    header = _env("COMMONINDEX_PROXY_EMAIL_HEADER")
    if not header:
        return None
    secret = _env("COMMONINDEX_PROXY_SECRET")
    networks = []
    for cidr in filter(None, (c.strip() for c in _env("COMMONINDEX_PROXY_IPS").split(","))):
        try:
            networks.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            log.error("COMMONINDEX_PROXY_IPS: %r is not an address or network; ignored", cidr)
    if not secret and not networks:
        log.error("COMMONINDEX_PROXY_EMAIL_HEADER is set without COMMONINDEX_PROXY_SECRET or "
                  "COMMONINDEX_PROXY_IPS — proxy sign-in stays off, since nothing would tell the "
                  "proxy's requests from anyone else's")
        return None
    return Proxy(header, secret, tuple(networks))


def join_domains() -> set[str]:
    return {d.strip().lower().lstrip("@") for d in _env("COMMONINDEX_JOIN_DOMAINS").split(",") if d.strip()}


def join_role() -> str:
    role = _env("COMMONINDEX_JOIN_ROLE", "contributor")
    return role if role in ROLES and role != "admin" else "contributor"


def methods() -> dict[str, Any]:
    from commonindex.gateway import mailer

    found, p, email = providers(), proxy(), mailer.configured()
    s = found.get("sso")
    return {"google": "google" in found,
            "sso": {"name": s.name} if s else None,
            "email": email,
            "proxy": bool(p),
            # A link to send is how an invitation signs someone in when
            # nothing else can.
            "code": not found and not p and not email}


def signs_in_without_link() -> str | None:
    """How an invited person signs in when no link is needed, or None."""
    m = methods()
    return ("google" if m["google"] else "sso" if m["sso"] else "email" if m["email"]
            else "proxy" if m["proxy"] else None)


@router.get("/auth/config")
async def auth_config():
    """How to sign in here — asked before anyone has."""
    return {"methods": methods(), "join_domains": sorted(join_domains())}


# ── people, found by email ──────────────────────────────────────────────


async def member_by_email(conn, email: str, in_space: str) -> Any:
    return await conn.fetchrow(
        "select a.id, a.kind, a.trust_tier from actors a"
        " where lower(a.email) = lower($1) and a.kind = 'human'"
        "   and exists (select 1 from grants g where g.subject = a.id and g.resource = $2"
        "                and (g.expires_at is null or g.expires_at > now()))",
        email, f"space:{in_space}")


async def _join(conn, email: str, name: str, in_space: str) -> Any:
    """Someone whose domain may join on their own, made a member now."""
    from commonindex.gateway.members import _slug

    existing = await conn.fetchrow("select id from actors where lower(email) = lower($1)", email)
    async with conn.transaction():
        if existing:
            person = existing["id"]
        else:
            base = _slug(email.split("@")[0])
            person = base
            n = 1
            while await conn.fetchval("select 1 from actors where id = $1", person):
                n += 1
                person = f"{base}-{n}"
            await conn.execute("insert into actors (id, kind, display, email) values ($1, 'human', $2, $3)",
                               person, name or email.split("@")[0], email)
        await conn.execute(
            "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,$3,$4,$2)"
            " on conflict (id) do nothing",
            f"g-{person}-{in_space}", person, ROLES[join_role()], f"space:{in_space}")
    return await member_by_email(conn, email, in_space)


async def person_for(conn, email: str, name: str = "") -> Any:
    """The member this email belongs to, joining them if their domain may."""
    email = email.strip()
    if not EMAIL.match(email):
        return None
    found = await member_by_email(conn, email, space())
    if found is None and email.rsplit("@", 1)[-1].lower() in join_domains():
        found = await _join(conn, email, name, space())
    return found


# ── sessions ────────────────────────────────────────────────────────────


async def start_session(conn, actor_id: str, via: str, user_agent: str = "") -> str:
    secret = "ehs_" + secrets.token_urlsafe(32)
    await conn.execute(
        "insert into sessions (id, actor_id, secret_hash, via, user_agent, expires_at)"
        " values ($1,$2,$3,$4,$5, now() + make_interval(days => $6))",
        "ses-" + secrets.token_hex(8), actor_id, hash_token(secret), via, user_agent[:300],
        _days("COMMONINDEX_SESSION_DAYS", 14))
    return secret


async def session_principal(conn, secret: str) -> Principal | None:
    row = await conn.fetchrow(
        "select s.id, s.actor_id, a.kind, a.trust_tier from sessions s join actors a on a.id = s.actor_id"
        " where s.secret_hash = $1 and s.revoked_at is null and s.expires_at > now()",
        hash_token(secret))
    if row is None:
        return None
    await conn.execute("update sessions set last_used = now() where id = $1", row["id"])
    return Principal(actor_id=row["actor_id"], kind=row["kind"], trust_tier=row["trust_tier"],
                     token_id=row["id"], via="session")


async def end_sessions(conn, actor_id: str) -> None:
    """Every session this person has, and every code not yet used: signed out everywhere."""
    await conn.execute("update sessions set revoked_at = now() where actor_id = $1 and revoked_at is null",
                       actor_id)
    await conn.execute("delete from sign_in_codes where actor_id = $1 and used_at is null", actor_id)


def _cookie(response, secret: str) -> None:
    response.set_cookie(COOKIE, secret, max_age=_days("COMMONINDEX_SESSION_DAYS", 14) * 86400,
                        httponly=True, secure=public_url().startswith("https://"), samesite="lax", path="/")


# ── sign-in codes ───────────────────────────────────────────────────────


async def issue_code(conn, actor_id: str, by: str, days: int | None = None) -> tuple[str, datetime]:
    """A code that signs this person in once, until it expires."""
    code = "ehc_" + secrets.token_urlsafe(24)
    expires = await conn.fetchval(
        "insert into sign_in_codes (id, actor_id, code_hash, created_by, expires_at)"
        " values ($1,$2,$3,$4, now() + make_interval(days => $5)) returning expires_at",
        "sic-" + secrets.token_hex(8), actor_id, hash_token(code), by,
        days or _days("COMMONINDEX_INVITE_DAYS", 7))
    return code, expires


def sign_in_link(code: str) -> str:
    return f"{public_url()}/signin#code={urllib.parse.quote(code)}"


@router.post("/auth/redeem")
async def auth_redeem(req: Request):
    """Trade a sign-in code for a session. A code works once."""
    try:
        body = await req.json()
    except ValueError:
        body = {}
    code = str(body.get("code") or "").strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "update sign_in_codes set used_at = now()"
            " where code_hash = $1 and used_at is null and expires_at > now()"
            " returning actor_id", hash_token(code)) if code else None
        if row is None:
            return _error(401, "bad_code", "that sign-in link has been used or has expired — "
                                           "ask an admin for a new one")
        secret = await start_session(conn, row["actor_id"], "code", req.headers.get("user-agent", ""))
        who = await conn.fetchrow("select id, display from actors where id = $1", row["actor_id"])
    response = JSONResponse({"id": who["id"], "display": who["display"]})
    _cookie(response, secret)
    return response


@router.post("/auth/logout")
async def auth_logout(req: Request):
    """End this browser's session, on the server, not only in the browser."""
    secret = req.cookies.get(COOKIE)
    if secret:
        async with req.app.state.commonindex["pool"].acquire() as conn:
            await conn.execute("update sessions set revoked_at = now() where secret_hash = $1",
                               hash_token(secret))
    response = JSONResponse({"signed_out": True})
    response.delete_cookie(COOKIE, path="/")
    return response


# ── single sign-on (OIDC, authorization code with PKCE) ──────────────────


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _fetch(url: str, data: dict[str, str] | None = None, auth: tuple[str, str] | None = None) -> Any:
    headers = {"accept": "application/json"}
    payload = None
    if data is not None:
        payload = urllib.parse.urlencode(data).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    if auth:
        headers["authorization"] = "Basic " + base64.b64encode(
            f"{urllib.parse.quote(auth[0])}:{urllib.parse.quote(auth[1])}".encode()).decode()
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=15) as r:
        return json.loads(r.read())


async def http(url: str, data: dict[str, str] | None = None, auth: tuple[str, str] | None = None) -> Any:
    """One call to the identity provider, off the event loop. Replaced in tests."""
    return await asyncio.to_thread(_fetch, url, data, auth)


_DISCOVERY: dict[str, tuple[float, dict[str, Any]]] = {}


async def discover(issuer: str) -> dict[str, Any]:
    cached = _DISCOVERY.get(issuer)
    if cached and time.monotonic() - cached[0] < 3600:
        return cached[1]
    conf = await http(f"{issuer}/.well-known/openid-configuration")
    _DISCOVERY[issuer] = (time.monotonic(), conf)
    return conf


def _return_to(value: str | None) -> str:
    """Only a path in this app: never another site, never `//elsewhere`."""
    value = value or "/"
    return value if value.startswith("/") and not value.startswith("//") and "\\" not in value else "/"


def _back(path: str) -> RedirectResponse:
    return RedirectResponse(f"{public_url()}{path}", status_code=302)


@router.get("/auth/sso/start")
async def sso_start(req: Request):
    """Off to the identity provider, remembering how to recognise the way back."""
    found = providers()
    p = found.get(req.query_params.get("provider") or "sso") or (next(iter(found.values())) if found else None)
    if p is None:
        return _back("/signin?error=sso_off")
    conf = await discover(p.issuer)
    state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    async with req.app.state.commonindex["pool"].acquire() as conn:
        await conn.execute("delete from sso_logins where created_at < now() - make_interval(secs => $1)",
                           SSO_SECONDS)
        await conn.execute("insert into sso_logins (state_hash, provider, nonce, verifier, return_to)"
                           " values ($1,$2,$3,$4,$5)", hash_token(state), p.id, nonce, verifier,
                           _return_to(req.query_params.get("return_to")))
    query = urllib.parse.urlencode({
        "response_type": "code", "client_id": p.client_id, "redirect_uri": f"{gateway_url()}/auth/sso/callback",
        "scope": "openid email profile", "state": state, "nonce": nonce,
        "code_challenge": _b64(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
        # Google asks which account when there is more than one.
        **({"prompt": "select_account"} if p.id == "google" else {}),
    })
    response = RedirectResponse(f"{conf['authorization_endpoint']}?{query}", status_code=302)
    # Bound to this browser: a callback carrying a state some other browser
    # began is someone signing you in as them.
    response.set_cookie(SSO_COOKIE, state, max_age=SSO_SECONDS, httponly=True,
                        secure=gateway_url().startswith("https://"), samesite="lax", path="/auth/sso")
    return response


async def verify_id_token(p: Provider, conf: dict[str, Any], id_token: str, nonce: str) -> dict[str, Any]:
    """The ID token's claims, if its signature, issuer, audience, age and nonce hold."""
    import jwt

    header = jwt.get_unverified_header(id_token)
    keys = (await http(conf["jwks_uri"])).get("keys") or []
    key = next((k for k in keys if k.get("kid") == header.get("kid")), keys[0] if len(keys) == 1 else None)
    if key is None:
        raise ValueError("the identity provider's keys do not include the one this token was signed with")
    claims = jwt.decode(id_token, jwt.PyJWK(key).key,
                        algorithms=["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"],
                        audience=p.client_id, issuer=list(p.issuers) or conf.get("issuer", p.issuer), leeway=60,
                        options={"require": ["exp", "iat", "iss", "aud", "sub"]})
    if not hmac.compare_digest(str(claims.get("nonce") or ""), nonce):
        raise ValueError("the ID token is not for this sign-in")
    return claims


@router.get("/auth/sso/callback")
async def sso_callback(req: Request):
    """Back from the identity provider: check everything, then a session."""
    q = req.query_params
    if q.get("error"):
        return _back("/signin?error=sso_refused")
    state, code = q.get("state") or "", q.get("code") or ""
    if not state or not hmac.compare_digest(state, req.cookies.get(SSO_COOKIE) or ""):
        return _back("/signin?error=sso_stale")
    pool = req.app.state.commonindex["pool"]
    async with pool.acquire() as conn:
        login = await conn.fetchrow(
            "delete from sso_logins where state_hash = $1 and created_at > now() - make_interval(secs => $2)"
            " returning provider, nonce, verifier, return_to", hash_token(state), SSO_SECONDS)
    if login is None or not code:
        return _back("/signin?error=sso_stale")
    p = providers().get(login["provider"])
    if p is None:
        return _back("/signin?error=sso_off")
    try:
        conf = await discover(p.issuer)
        tokens = await http(conf["token_endpoint"], {
            "grant_type": "authorization_code", "code": code, "code_verifier": login["verifier"],
            "redirect_uri": f"{gateway_url()}/auth/sso/callback", "client_id": p.client_id,
        }, auth=(p.client_id, p.client_secret) if p.client_secret else None)
        claims = await verify_id_token(p, conf, tokens.get("id_token") or "", login["nonce"])
    except Exception as e:  # noqa: BLE001 - every failure here ends the same way, logged
        log.warning("sign-in with %s failed: %s", p.name, e)
        return _back(f"/signin?error=sso_failed&provider={p.id}")
    email = str(claims.get("email") or "")
    if claims.get("email_verified") is False:
        return _back(f"/signin?error=email_unverified&provider={p.id}")
    async with pool.acquire() as conn:
        person = await person_for(conn, email, str(claims.get("name") or ""))
        if person is None:
            return _back(f"/signin?error=not_invited&provider={p.id}")
        secret = await start_session(conn, person["id"], "sso", req.headers.get("user-agent", ""))
    response = _back(login["return_to"])
    response.delete_cookie(SSO_COOKIE, path="/auth/sso")
    _cookie(response, secret)
    return response


# ── a code sent to the person's email ───────────────────────────────────

#: How long an emailed code works, how many guesses it allows, and how many
#: may be asked for an address in an hour.
EMAIL_MINUTES, EMAIL_GUESSES, EMAIL_PER_HOUR = 10, 5, 5


def _email_hash(email: str, code: str) -> str:
    return hash_token(f"{email.strip().lower()}:{code.strip()}")


async def _may_sign_in(conn, email: str) -> bool:
    """A member, or an address whose domain may join. Nobody is made here:
    whoever asked has not yet shown the address is theirs."""
    if await member_by_email(conn, email, space()):
        return True
    return email.rsplit("@", 1)[-1].lower() in join_domains()


@router.post("/auth/email/start")
async def email_start(req: Request):
    """Send a sign-in code to this address — if it may sign in here.

    The answer is the same either way, so the page cannot be used to learn
    who is in the workspace."""
    from commonindex.gateway import mailer

    if not mailer.configured():
        return _error(503, "email_off", "signing in by email is not set up here")
    try:
        body = await req.json()
    except ValueError:
        body = {}
    email = str(body.get("email") or "").strip()
    if not EMAIL.match(email):
        return _error(422, "bad_email", "that is not an email address")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        recent = await conn.fetchval(
            "select count(*) from email_sign_ins where lower(email) = lower($1)"
            "   and created_at > now() - interval '1 hour'", email)
        if recent >= EMAIL_PER_HOUR:
            return _error(429, "too_many", "too many codes for this address — wait a while, then try again")
        if await _may_sign_in(conn, email):
            code = f"{secrets.randbelow(1_000_000):06d}"
            link = "ehe_" + secrets.token_urlsafe(24)
            await conn.execute(
                "insert into email_sign_ins (id, email, code_hash, link_hash, expires_at)"
                " values ($1,$2,$3,$4, now() + make_interval(mins => $5))",
                "esi-" + secrets.token_hex(8), email, _email_hash(email, code), hash_token(link), EMAIL_MINUTES)
            await mailer.send(email, f"Your sign-in code: {code}", (
                f"Your code to sign in to {_env('COMMONINDEX_SPACE_NAME', 'your workspace')}:\n\n"
                f"    {code}\n\n"
                f"Or open this link to sign in:\n{public_url()}/signin#email={urllib.parse.quote(link)}\n\n"
                f"It works once, for {EMAIL_MINUTES} minutes. If you didn't ask to sign in, ignore this email."))
        else:
            # Spend roughly the time a send would, so the answer's speed does
            # not say what its words do not.
            await asyncio.sleep(0.2)
    return {"sent": True, "email": email, "minutes": EMAIL_MINUTES}


@router.post("/auth/email/verify")
async def email_verify(req: Request):
    """The code typed, or the link clicked: a session."""
    try:
        body = await req.json()
    except ValueError:
        body = {}
    link, email, code = (str(body.get(k) or "").strip() for k in ("link", "email", "code"))
    async with req.app.state.commonindex["pool"].acquire() as conn:
        if link:
            row = await conn.fetchrow(
                "update email_sign_ins set used_at = now() where link_hash = $1 and used_at is null"
                "   and expires_at > now() returning email", hash_token(link))
        else:
            pending = await conn.fetchrow(
                "select id, code_hash, attempts from email_sign_ins where lower(email) = lower($1)"
                "   and used_at is null and expires_at > now() order by created_at desc limit 1", email)
            if pending is not None and pending["attempts"] >= EMAIL_GUESSES:
                return _error(429, "too_many_guesses", "too many wrong codes — ask for a new one")
            if pending is None or not hmac.compare_digest(pending["code_hash"], _email_hash(email, code)):
                if pending is not None:
                    await conn.execute("update email_sign_ins set attempts = attempts + 1 where id = $1",
                                       pending["id"])
                return _error(401, "bad_code", "that code isn't right, or has expired")
            row = await conn.fetchrow("update email_sign_ins set used_at = now() where id = $1 returning email",
                                      pending["id"])
        if row is None:
            return _error(401, "bad_code", "that sign-in link has been used or has expired — ask for a new code")
        person = await person_for(conn, row["email"])
        if person is None:
            return _error(403, "not_invited", "this address isn't in the workspace — ask an admin to invite you")
        secret = await start_session(conn, person["id"], "email", req.headers.get("user-agent", ""))
        who = await conn.fetchrow("select id, display from actors where id = $1", person["id"])
    response = JSONResponse({"id": who["id"], "display": who["display"]})
    _cookie(response, secret)
    return response


# ── the trusted proxy ───────────────────────────────────────────────────


def _from_proxy(req: Request, p: Proxy) -> bool:
    if p.secret and not hmac.compare_digest(req.headers.get("x-commonindex-proxy-secret", ""), p.secret):
        return False
    if p.networks:
        try:
            address = ipaddress.ip_address((req.client.host if req.client else "") or "")
        except ValueError:
            return False
        if not any(address in network for network in p.networks):
            return False
    return True


def proxy_email(value: str) -> str:
    """The email in a proxy's header. Google IAP prefixes it with the issuer
    (`accounts.google.com:ana@example.com`); others send it bare."""
    return value.strip().rsplit(":", 1)[-1].strip()


async def proxy_principal(req: Request, conn) -> Principal | None:
    p = proxy()
    value = req.headers.get(p.header, "") if p else ""
    if not p or not value or not _from_proxy(req, p):
        return None
    person = await person_for(conn, proxy_email(value))
    if person is None:
        return None
    return Principal(actor_id=person["id"], kind=person["kind"], trust_tier=person["trust_tier"],
                     token_id="proxy", via="proxy")


# ── no sign-in, on this computer ────────────────────────────────────────
#
# For one person running the app on their own machine — trying it, a demo —
# a sign-in is a chore. In local mode a request from the gateway's own
# computer is the admin who turned the mode on. Only such a request: one from
# anywhere else still signs in, so a gateway left reachable on a network is
# not left open. "From this computer" is strict, since every part of it can
# otherwise be borrowed: a loopback address, no proxy's forwarding headers (a
# reverse proxy on the same machine makes every visitor look local), and a
# Host that names this machine (a site whose domain points at 127.0.0.1 sends
# its own name). A browser page from another site is refused like any other
# cross-site request.

MODES = ("required", "local")
_LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1"}
_FORWARDED = ("x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "cf-connecting-ip")
_MODE: dict[str, Any] = {}


def is_local_request(req: Request) -> bool:
    try:
        if not ipaddress.ip_address((req.client.host if req.client else "") or "").is_loopback:
            return False
    except ValueError:
        return False
    if any(req.headers.get(h) for h in _FORWARDED):
        return False
    host = urllib.parse.urlsplit("//" + (req.headers.get("host") or "")).hostname or ""
    return host.lower() in _LOOPBACK_NAMES


async def sign_in_mode(conn) -> dict[str, Any]:
    """{"mode": "required" | "local", "as": actor or None, "locked": set by the deployment}."""
    fixed = _env("COMMONINDEX_SIGN_IN").lower()
    if fixed in MODES:
        who = None
        if fixed == "local":
            email = _env("COMMONINDEX_ADMIN_EMAIL")
            who = await conn.fetchval("select id from actors where lower(email) = lower($1)", email) if email else None
            who = who or await conn.fetchval(
                "select g.subject from grants g join actors a on a.id = g.subject and a.kind = 'human'"
                " where g.resource = $1 and g.relation = 'admin' order by g.subject limit 1", f"space:{space()}")
        return {"mode": fixed, "as": who, "locked": True}
    cached = _MODE.get("value")
    if cached is not None and time.monotonic() - _MODE["at"] < 5:
        return cached
    value = await conn.fetchval("select value from settings where key = 'sign_in'")
    value = json.loads(value) if isinstance(value, str) else (value or {})
    found = {"mode": value.get("mode") if value.get("mode") in MODES else "required",
             "as": value.get("as"), "locked": False}
    _MODE.update(value=found, at=time.monotonic())
    return found


async def local_principal(req: Request, conn) -> Principal | None:
    mode = await sign_in_mode(conn)
    if mode["mode"] != "local" or not mode["as"] or not is_local_request(req):
        return None
    # Still an admin here, or the mode lapses with them.
    row = await conn.fetchrow(
        "select a.id, a.kind, a.trust_tier from actors a join grants g on g.subject = a.id"
        " where a.id = $1 and g.resource = $2 and g.relation = 'admin'"
        "   and (g.expires_at is null or g.expires_at > now())", mode["as"], f"space:{space()}")
    if row is None:
        return None
    return Principal(actor_id=row["id"], kind=row["kind"], trust_tier=row["trust_tier"],
                     token_id="local", via="local")


@router.post("/api/v1/signin.settings")
async def signin_settings(req: Request):
    """How people sign in here: the mode, and each method — on, or how to turn it on."""
    from commonindex.gateway import mailer

    async with req.app.state.commonindex["pool"].acquire() as conn:
        mode = await sign_in_mode(conn)
        who = await conn.fetchval("select display from actors where id = $1", mode["as"]) if mode["as"] else None
    m, p = methods(), proxy()
    return {
        "mode": mode["mode"], "as": mode["as"], "as_name": who, "locked": mode["locked"],
        "this_computer": is_local_request(req),
        "redirect_url": f"{gateway_url()}/auth/sso/callback",
        "public_url": public_url(),
        "methods": {
            "google": {"on": m["google"], "settings": ["COMMONINDEX_GOOGLE_CLIENT_ID", "COMMONINDEX_GOOGLE_CLIENT_SECRET"]},
            "sso": {"on": bool(m["sso"]), "name": (m["sso"] or {}).get("name"),
                    "settings": ["COMMONINDEX_SSO_ISSUER", "COMMONINDEX_SSO_CLIENT_ID", "COMMONINDEX_SSO_CLIENT_SECRET",
                                 "COMMONINDEX_SSO_NAME"]},
            "email": {"on": m["email"], "log_only": m["email"] and not _env("COMMONINDEX_SMTP_HOST"),
                      "settings": ["COMMONINDEX_SMTP_HOST", "COMMONINDEX_SMTP_PORT", "COMMONINDEX_SMTP_USER",
                                   "COMMONINDEX_SMTP_PASSWORD", "COMMONINDEX_MAIL_FROM"]},
            "proxy": {"on": m["proxy"], "header": p.header if p else None,
                      "settings": ["COMMONINDEX_PROXY_EMAIL_HEADER", "COMMONINDEX_PROXY_SECRET", "COMMONINDEX_PROXY_IPS"]},
            "link": {"on": m["code"]},
        },
        "join_domains": sorted(join_domains()),
        "mail_configured": mailer.configured(),
    }


@router.post("/api/v1/signin.set_mode")
async def signin_set_mode(req: Request):
    """Require a sign-in, or not on this computer. An admin's; the admin who
    turns local mode on is who this computer is signed in as."""
    body = await req.json()
    mode = body.get("mode")
    if mode not in MODES:
        return _error(422, "bad_mode", "mode is required or local")
    actor = req.state.principal.actor_id
    async with req.app.state.commonindex["pool"].acquire() as conn:
        if (await sign_in_mode(conn))["locked"]:
            return _error(409, "locked", "this deployment sets COMMONINDEX_SIGN_IN, so the mode can't be changed here")
        await conn.execute(
            "insert into settings (key, value, updated_by) values ('sign_in', $1::jsonb, $2)"
            " on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by,"
            "   updated_at = now()",
            json.dumps({"mode": mode, "as": actor if mode == "local" else None}), actor)
    _MODE.clear()
    return await signin_settings(req)


# ── who is asking ───────────────────────────────────────────────────────


def allowed_origins() -> set[str]:
    from commonindex.gateway.app import ORIGINS

    return {o.rstrip("/") for o in ORIGINS} | {public_url()}


async def resolve(req: Request, checker, pool) -> Principal | None:
    """The caller, from a session, a bearer token or the trusted proxy — or None.

    A session first: a browser that has signed in is that person, whatever
    else it sends. Then a token, for agents and tools. Then the proxy.
    Raises NoSuchToken for a bearer token that does not resolve, so the
    caller hears that rather than a generic "sign in".
    """
    secret = req.cookies.get(COOKIE)
    if secret:
        async with pool.acquire() as conn:
            found = await session_principal(conn, secret)
        if found is not None:
            return found
    scheme, _, token = req.headers.get("authorization", "").partition(" ")
    if scheme.lower() == "bearer" and token.strip():
        return await checker.principal(token.strip())
    if pool is None:
        return None
    async with pool.acquire() as conn:
        if proxy() and (found := await proxy_principal(req, conn)) is not None:
            return found
        # Last: no credentials at all, which on this computer in local mode is enough.
        return await local_principal(req, conn)


def cross_site(req: Request, principal: Principal) -> bool:
    """A cookie or a proxy's header arrives with any request the browser
    makes, including one a hostile page makes. Such a request is refused
    unless it comes from this app; a token is sent on purpose, so is not."""
    if principal.via not in ("session", "proxy", "local"):
        return False
    origin = req.headers.get("origin")
    return bool(origin) and origin.rstrip("/") not in allowed_origins()


# ── the first admin ─────────────────────────────────────────────────────


async def ensure_admin(conn, email: str, name: str = "", in_space: str | None = None) -> tuple[str, bool]:
    """The workspace exists and this person is its admin. (id, made now)."""
    from commonindex.gateway.members import _slug

    in_space = in_space or space()
    await conn.execute("insert into spaces (id, org_id, name) values ($1, 'default', $2) on conflict (id) do nothing",
                       in_space, _env("COMMONINDEX_SPACE_NAME", "Workspace"))
    await conn.execute("insert into space_seq (space_id) values ($1) on conflict (space_id) do nothing", in_space)
    person = await conn.fetchval("select id from actors where lower(email) = lower($1)", email)
    made = person is None
    if made:
        base = _slug(email.split("@")[0])
        person, n = base, 1
        while await conn.fetchval("select 1 from actors where id = $1", person):
            n += 1
            person = f"{base}-{n}"
        await conn.execute("insert into actors (id, kind, display, email) values ($1, 'human', $2, $3)",
                           person, name or email.split("@")[0], email)
    resource = f"space:{in_space}"
    if not await conn.fetchval("select 1 from grants where subject = $1 and resource = $2 and relation = 'admin'",
                               person, resource):
        await conn.execute("delete from grants where subject = $1 and resource = $2", person, resource)
        await conn.execute(
            "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,'admin',$3,$2)",
            f"g-{person}-{in_space}", person, resource)
    return person, made


async def bootstrap(pool) -> None:
    """On start: the admin COMMONINDEX_ADMIN_EMAIL names, and — when no other way
    in is configured and they have never signed in — a link to sign in with,
    in the log, once."""
    email = _env("COMMONINDEX_ADMIN_EMAIL")
    if not email:
        return
    if not EMAIL.match(email):
        log.error("COMMONINDEX_ADMIN_EMAIL %r is not an email address; no admin made", email)
        return
    async with pool.acquire() as conn:
        person, made = await ensure_admin(conn, email, _env("COMMONINDEX_ADMIN_NAME"))
        if made:
            log.warning("made %s the admin of workspace %r", email, space())
        if methods()["code"] and not await conn.fetchval(
                "select 1 from sessions where actor_id = $1 union all"
                " select 1 from sign_in_codes where actor_id = $1 and used_at is null and expires_at > now()"
                " limit 1", person):
            code, expires = await issue_code(conn, person, person, days=1)
            log.warning("sign in as %s, once, before %s: %s", email,
                        expires.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC"), sign_in_link(code))


def _error(status: int, code: str, message: str):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "field": None}})

