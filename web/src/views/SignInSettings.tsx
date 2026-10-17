import { useCallback, useEffect, useState } from 'react'
import { GatewayError, setSignInMode, signInSettings, type SignInMethod, type SignInMode, type SignInSettings } from '../data/gateway'
import { useToast } from '../components/Shell'
import './settings.css'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

const MODES: { id: SignInMode; label: string; says: string }[] = [
  { id: 'required', label: 'Everyone signs in',
    says: 'People sign in with the methods below. For a team, and for anything others can reach.' },
  { id: 'local', label: 'No sign-in on this computer',
    says: 'Whoever uses the app on the computer running it is signed in as you, without a sign-in page. Anyone on another computer still signs in. For trying it out, demos, or using it on your own.' },
]

const METHODS: { id: keyof SignInSettings['methods']; label: string; says: string; redirect?: boolean }[] = [
  { id: 'google', label: 'Sign in with Google', says: 'People sign in with their Google account, matched by email.', redirect: true },
  { id: 'sso', label: 'Company single sign-on', says: 'Okta, Microsoft Entra ID, or any OpenID Connect provider.', redirect: true },
  { id: 'email', label: 'Email code', says: 'A 6-digit code and a one-click link, sent to their email. No passwords.' },
  { id: 'proxy', label: 'Company network', says: 'A proxy that already signed people in — Google IAP, Cloudflare Access, oauth2-proxy.' },
  { id: 'link', label: 'Sign-in links', says: 'When nothing else is on: an invitation gives you a one-time link to send.' },
]

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return <button type="button" className="btn" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setDone(true) } catch { /* select it by hand */ }
  }}>{done ? 'Copied' : 'Copy'}</button>
}

function Method({ m, info, redirect }: { m: (typeof METHODS)[number]; info: SignInMethod; redirect: string }) {
  const name = m.id === 'sso' && info.name ? `${m.label} (${info.name})` : m.label
  return (
    <li className="signin-method">
      <div className="signin-method-head">
        <b>{name}</b>
        <span className={`signin-state${info.on ? ' on' : ''}`}>{info.on ? (info.log_only ? 'On — log only' : 'On') : 'Off'}</span>
      </div>
      <p>{m.says}</p>
      {info.log_only && <p className="signin-warn">Emails are written to the server log, not sent — for development only.
        Set <code>COMMONINDEX_SMTP_HOST</code> and the rest to send them.</p>}
      {!info.on && info.settings && <p className="signin-how">To turn it on, set {info.settings.map((v, i) =>
        <span key={v}>{i > 0 && ', '}<code>{v}</code></span>)} on the gateway. Steps: <code>docs/sign-in.md</code>.</p>}
      {m.redirect && (
        <div className="signin-redirect">
          <span>Redirect URL to give {m.id === 'google' ? 'Google' : 'your provider'}</span>
          <div className="invite-link"><code>{redirect}</code><Copy text={redirect} /></div>
        </div>
      )}
    </li>
  )
}

/** How people get into this workspace: whether they sign in at all on this
 *  computer, and which ways in are on. An admin's page. */
export function SignInSettingsView() {
  const [settings, setSettings] = useState<SignInSettings | null>(null)
  const [denied, setDenied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const load = useCallback(() => signInSettings().then(setSettings).catch(e => {
    if (e instanceof GatewayError && e.code === 'denied') setDenied(true); else setErr(message(e))
  }), [])
  useEffect(() => { load() }, [load])

  const choose = async (mode: SignInMode) => {
    if (!settings || mode === settings.mode || busy) return
    if (mode === 'local' && !window.confirm('Anyone using the app on the computer running it will be signed in as you, with no sign-in page. Continue?')) return
    setBusy(true)
    try {
      setSettings(await setSignInMode(mode))
      toast(mode === 'local' ? 'No sign-in needed on this computer now' : 'Everyone signs in now')
    } catch (e) { toast(message(e)) } finally { setBusy(false) }
  }

  if (denied) {
    return <div className="collection members-page workspace-collection"><header className="dash-collection-header dash-collection-shell">
      <div><h1 className="coll-title">Sign-in</h1><p className="coll-sub">Only workspace admins can change how people sign in.</p></div>
    </header></div>
  }
  return (
    <div className="collection members-page workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Sign-in</h1>
          <p className="coll-sub">How people get into this workspace.</p>
        </div>
      </header>
      <div className="dash-collection-shell signin-settings">
        {err && <div className="dash-load-error" role="alert"><span>{err}</span><button className="tool" onClick={load}>Retry</button></div>}
        {!settings ? <p className="share-note">Loading…</p> : <>
          <section aria-labelledby="who-signs-in">
            <h2 id="who-signs-in">Who needs to sign in</h2>
            <fieldset className="invite-roles" disabled={settings.locked || busy}>
              <legend className="visually-hidden">Sign-in mode</legend>
              {MODES.map(m => (
                <label key={m.id} className={settings.mode === m.id ? 'on' : ''}>
                  <input type="radio" name="mode" value={m.id} checked={settings.mode === m.id} onChange={() => choose(m.id)} />
                  <span><b>{m.label}</b><span>{m.says}</span></span>
                </label>
              ))}
            </fieldset>
            {settings.locked && <p className="signin-how">Set by this deployment (<code>COMMONINDEX_SIGN_IN</code>), so it can’t be changed here.</p>}
            {settings.mode === 'local' && <p className="signin-how">
              This computer is signed in as <b>{settings.as_name ?? settings.as}</b>.
              {!settings.this_computer && ' You’re on a different computer, so you still sign in here.'}</p>}
          </section>

          <section aria-labelledby="ways-in">
            <h2 id="ways-in">Ways to sign in</h2>
            <ul className="signin-methods">
              {METHODS.map(m => <Method key={m.id} m={m} info={settings.methods[m.id]} redirect={settings.redirect_url} />)}
            </ul>
            <p className="signin-how">{settings.join_domains.length
              ? <>People with an email at {settings.join_domains.map((d, i) => <span key={d}>{i > 0 && ', '}<b>{d}</b></span>)} can join on their own; everyone else needs an invitation.</>
              : <>Only invited people can sign in. To let a company domain join on its own, set <code>COMMONINDEX_JOIN_DOMAINS</code>.</>}</p>
          </section>
        </>}
      </div>
    </div>
  )
}
