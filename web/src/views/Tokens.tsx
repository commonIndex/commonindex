import { useCallback, useEffect, useState } from 'react'
import { GATEWAY, createToken, listTokens, revokeToken, type PersonalToken } from '../data/gateway'
import { useToast } from '../components/Shell'
import { Pick } from '../components/ShareButton'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const day = (at: string | null) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null)

/** Tokens for the tools a person runs as themselves — the CLI, an MCP
 *  client. Made here, in a signed-in browser; each one shown once. */
export function TokensView() {
  const [tokens, setTokens] = useState<PersonalToken[] | null>(null)
  const [label, setLabel] = useState('')
  const [days, setDays] = useState(90)
  const [made, setMade] = useState<{ label: string; token: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const toast = useToast()

  const load = useCallback(() => listTokens().then(r => setTokens(r.tokens)).catch(e => setErr(message(e))), [])
  useEffect(() => { load() }, [load])

  return (
    <div className="collection members-page workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Tokens for CLI &amp; MCP</h1>
          <p className="coll-sub">A token lets a tool act as you. Make one per tool, so you can revoke one without the rest.</p>
        </div>
      </header>
      <div className="dash-collection-shell">
        <form style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', margin: '8px 0 20px' }} onSubmit={async e => {
          e.preventDefault()
          setErr(null)
          try {
            const r = await createToken(label.trim(), days)
            setMade({ label: r.label, token: r.token }); setCopied(false); setLabel(''); load()
          } catch (x) { setErr(message(x)) }
        }}>
          <label className="invite-field" style={{ flex: '1 1 260px', margin: 0 }}>What it’s for
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Laptop CLI, coding agent…" />
          </label>
          <div className="invite-field" style={{ margin: 0 }}>Expires
            <Pick value={String(days)} label="Expires" onChange={v => setDays(Number(v))}
              options={[7, 30, 90, 365].map(d => [String(d), `in ${d} days`] as [string, string])} />
          </div>
          <button type="submit" className="btn action" disabled={!label.trim()}>Make token</button>
        </form>
        {err && <p className="share-err" role="alert">{err}</p>}

        {made && (
          <section className="share-note" aria-label="New token" style={{ margin: '0 0 20px' }}>
            <p><b>{made.label}</b> — copy it now. It is shown only once.</p>
            <div className="invite-link"><code>{made.token}</code>
              <button type="button" className="btn action" onClick={async () => {
                try { await navigator.clipboard.writeText(made.token); setCopied(true) } catch { /* select it by hand */ }
              }}>{copied ? 'Copied' : 'Copy'}</button></div>
            <p>CLI: <code>commonindex login --url {GATEWAY || window.location.origin} --token &lt;token&gt;</code></p>
            <p>MCP: set <code>COMMONINDEX_TOKEN</code> to it in your client’s config (<code>make mcp-config</code> prints one).</p>
          </section>
        )}

        {!tokens ? <p className="share-note">Loading…</p> : tokens.length === 0
          ? <p className="share-note">No tokens yet.</p>
          : (
            <ul className="members-list" aria-label="Your tokens">
              {tokens.map(t => (
                <li key={t.id}>
                  <span className="share-who">
                    <b>{t.label || 'Unnamed'}</b>
                    <span>Made {day(t.created_at)}{t.expires_at ? ` · expires ${day(t.expires_at)}` : ' · never expires'}</span>
                  </span>
                  <span className="members-seen">{t.last_used ? `Last used ${day(t.last_used)}` : 'Never used'}</span>
                  <button type="button" className="btn" onClick={async () => {
                    if (!window.confirm(`Revoke “${t.label}”? Anything using it stops working now.`)) return
                    try { await revokeToken(t.id); toast(`“${t.label}” was revoked`); load() } catch (x) { toast(message(x)) }
                  }}>Revoke</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}
