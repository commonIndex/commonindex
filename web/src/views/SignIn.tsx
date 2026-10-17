import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authConfig, emailStart, emailVerify, signIn, ssoStart, type AuthConfig } from '../data/gateway'
import { LogoMark } from '../components/LogoMark'
import './signin.css'

/** Why a sign-in came back without signing anyone in, in words. */
function why(code: string, provider: string): string {
  return ({
    not_invited: `That ${provider} account isn’t in this workspace yet. Ask a workspace admin to invite your email.`,
    email_unverified: `${provider} hasn’t verified that email address, so it can’t be used to sign in here.`,
    sso_stale: 'That sign-in took too long, or began in another browser. Try again.',
    sso_refused: `Sign-in was cancelled at ${provider}.`,
    sso_failed: `${provider} sign-in couldn’t be verified. Try again, or ask an admin.`,
    sso_off: 'That way of signing in isn’t set up for this workspace.',
  } as Record<string, string>)[code] ?? 'Sign-in didn’t work. Try again.'
}

function KeyMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="5.5" cy="10.5" r="3" /><path d="M7.6 8.4 13.5 2.5M11.5 4.5l2 2M10 6l1.5 1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Signing in, the way other tools do it: with Google or the company's
 *  account, or with a code sent to your email. A link an admin sent still
 *  works (#code=…), and so does the one in the email (#email=…) — both
 *  fragments, so never in a server's logs. */
export function SignIn() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<{ email: string; minutes: number } | null>(null)
  const [code, setCode] = useState('')
  const [link, setLink] = useState('')
  const [showLink, setShowLink] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const m = config?.methods

  const run = async (work: () => Promise<unknown>, then?: () => void) => {
    setBusy(true); setErr(null)
    try { await work(); (then ?? (() => { window.history.replaceState(null, '', '/signin'); navigate('/', { replace: true }) }))() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const send = (address: string) => run(async () => {
    const r = await emailStart(address.trim())
    setSentTo({ email: r.email, minutes: r.minutes }); setCode('')
  }, () => {})

  useEffect(() => {
    authConfig().then(setConfig).catch(() => setConfig({ methods: { google: false, sso: null, email: false, proxy: false, code: true } }))
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const fromEmail = hash.get('email')
    const fromLink = hash.get('code') ?? hash.get('token')
    if (fromEmail) run(() => emailVerify({ link: fromEmail }))
    else if (fromLink) { setLink(fromLink); setShowLink(true); run(() => signIn(fromLink)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const code = q.get('error')
    const provider = q.get('provider') === 'google' ? 'Google' : (m?.sso?.name ?? 'your identity provider')
    if (code && config) setErr(why(code, provider))
  }, [config, m])

  const providers = !!m && (m.google || !!m.sso)
  const codeOnly = !!m && m.code

  return (
    <div className="signin">
      <div className="signin-card">
        <span className="logo"><LogoMark size={22} />CommonIndex</span>
        {!m ? <p>Loading…</p> : sentTo ? (
          <form className="signin-email signin-code" onSubmit={e => { e.preventDefault(); run(() => emailVerify({ email: sentTo.email, code })) }}>
            <h1>Check your email</h1>
            <p>We sent a 6-digit code to <b className="signin-sent">{sentTo.email}</b>. It works for {sentTo.minutes} minutes —
              or click the link in the email instead.</p>
            <label className="signin-field">Code
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))} aria-label="6-digit code" />
            </label>
            <button type="submit" className="btn action" disabled={busy || code.length !== 6}>
              {busy ? 'Signing in…' : 'Sign in'}</button>
            <div className="signin-links">
              <button type="button" className="signin-link" onClick={() => { setSentTo(null); setErr(null) }}>Use a different email</button>
              <button type="button" className="signin-link" disabled={busy || resent}
                onClick={() => { setResent(true); send(sentTo.email) }}>{resent ? 'Sent again' : 'Resend code'}</button>
            </div>
          </form>
        ) : (
          <>
            <h1>Sign in to your workspace</h1>
            {providers && (
              <div className="signin-providers">
                {/* Google's own button, unmodified: their branding guidelines say how a
                    "Sign in with Google" button looks, and their assets are it
                    (public/brand/google, from Google's sign-in branding bundle). */}
                {m.google && <button type="button" className="signin-google" aria-label="Sign in with Google"
                  onClick={() => window.location.assign(ssoStart('google'))}>
                  <img src="/brand/google/signin-light.png" width={180} height={40} alt=""
                    srcSet="/brand/google/signin-light@2x.png 2x, /brand/google/signin-light@3x.png 3x" /></button>}
                {m.sso && <button type="button" className="signin-provider" onClick={() => window.location.assign(ssoStart('sso'))}>
                  <KeyMark />Continue with {m.sso.name}</button>}
              </div>
            )}
            {providers && m.email && <div className="signin-or">or</div>}
            {m.email && (
              <form className="signin-email" onSubmit={e => { e.preventDefault(); send(email) }}>
                <label className="signin-field">Email
                  <input type="email" autoComplete="email" value={email} placeholder="you@example.com"
                    onChange={e => setEmail(e.target.value)} autoFocus={!providers} />
                </label>
                <button type="submit" className="btn action" disabled={busy || !email.trim()}>
                  {busy ? 'Sending…' : 'Continue with email'}</button>
              </form>
            )}
            {m.proxy && !providers && !m.email && (
              <>
                <p>This workspace signs you in through your company’s network. Open it through your
                  company’s link — no password needed here.</p>
                <button type="button" className="btn action" onClick={() => navigate('/', { replace: true })}>Try again</button>
              </>
            )}
            {(codeOnly || showLink) ? (
              <form className="signin-email" onSubmit={e => { e.preventDefault(); run(() => signIn(link)) }}>
                {codeOnly && <p>Open the sign-in link an admin sent you, or paste it here.</p>}
                <label className="signin-field">Sign-in link
                  <input type="password" autoComplete="off" value={link} placeholder="Paste the link or code"
                    onChange={e => setLink(e.target.value.replace(/^.*#(code|token)=/, ''))} autoFocus={codeOnly} />
                </label>
                <button type="submit" className={`btn${codeOnly ? ' action' : ''}`} disabled={busy || !link.trim()}>
                  {busy ? 'Signing in…' : 'Sign in with link'}</button>
              </form>
            ) : (
              <button type="button" className="signin-link" onClick={() => setShowLink(true)}>Have a sign-in link from an admin?</button>
            )}
          </>
        )}
        {err && <p className="signin-err" role="alert">{err}</p>}
        {!sentTo && <p className="signin-note">Not in yet? Ask a workspace admin to invite you.</p>}
      </div>
    </div>
  )
}
