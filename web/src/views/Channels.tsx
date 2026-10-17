import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { archiveChannel, createChannel, GatewayError, listChannelsLive, updateChannel, type WireChannel } from '../data/gateway'
import { ShareButton } from '../components/ShareButton'
import './channels.css'
import { Thread } from '../components/discussion/Thread'
import { agoText, Face } from '../components/TaskCard'
import { GalleryResults } from '../components/Gallery'

const since = (at: string) => agoText(Math.max(0, (Date.now() - Date.parse(at)) / 1000))
/** Channel names read like handles: lowercase, words joined by hyphens. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-/, '').slice(0, 40)

function Lock() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  )
}

function NewChannel({ onCreated, onCancel }: { onCreated: (c: WireChannel) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [secret, setSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const clean = name.replace(/-$/, '')
  return (
    <form className="chl-new" onSubmit={async e => {
      e.preventDefault()
      if (clean.length < 2 || busy) return
      setBusy(true); setErr(null)
      try { onCreated((await createChannel(clean, topic.trim() || undefined, secret)).channel) }
      catch (x) { setErr(x instanceof GatewayError ? x.message : String(x)); setBusy(false) }
    }}>
      <label className="tp-field">
        <span>Name</span>
        <div className="chl-new-name"><span>#</span>
          <input autoFocus value={name} onChange={e => setName(slug(e.target.value))} placeholder="refund-incidents" maxLength={40} />
        </div>
      </label>
      <label className="tp-field">
        <span>What it is for <em>optional</em></span>
        <input value={topic} onChange={e => setTopic(e.target.value)} maxLength={200}
          placeholder="Refund incidents as they happen — the postmortem goes on the doc" />
      </label>
      <label className="chl-private">
        <input type="checkbox" checked={secret} onChange={e => setSecret(e.target.checked)} />
        <span><b>Private</b> — only people you add can see it and its messages</span>
      </label>
      <div className="tp-actions">
        <button className="btn primary" disabled={clean.length < 2 || busy}>{busy ? 'Creating…' : 'Create channel'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {err && <p className="p-warn" role="alert">{err}</p>}
    </form>
  )
}

export function ChannelsIndex() {
  const [channels, setChannels] = useState<WireChannel[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [archived, setArchived] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    setErr(null); setChannels(null)
    listChannelsLive({ archived })
      .then(r => { if (alive) setChannels(r.channels) })
      .catch(e => { if (alive) { setErr(e instanceof Error ? e.message : String(e)); setChannels([]) } })
    return () => { alive = false }
  }, [attempt, archived])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (channels ?? [])
      .filter(c => !needle || `${c.name} ${c.topic ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.last_at ?? '').localeCompare(a.last_at ?? '') || a.name.localeCompare(b.name))
  }, [channels, q])

  return (
    <div className="collection dashboard-collection workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Channels <span className="total">{channels === null ? 'Loading…' : err ? 'Unavailable' : channels.length}</span></h1>
          <p className="coll-sub">Keep team and topic conversations together. Discuss a specific doc, dashboard, or experiment in its comments.</p>
        </div>
        <button className="btn action" onClick={() => setCreating(c => !c)}>{creating ? 'Cancel' : '+ New channel'}</button>
      </header>
      <div className="dash-collection-shell">
        {creating && <NewChannel onCancel={() => setCreating(false)} onCreated={c => navigate(`/channels/${c.id}`)} />}
        {(channels?.length ?? 0) > 0 && (
          <div className="coll-tools dash-gallery-tools">
            <input type="search" className="dash-search" aria-label="Search channels" value={q}
              onChange={e => setQ(e.target.value)} placeholder="Search by name or what it is for…" />
            <label className="chl-show-archived">
              <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Show archived
            </label>
          </div>
        )}
        <GalleryResults loading={channels === null} error={err ? new Error(err) : null} count={rows.length}
          total={channels?.length ?? 0} label="channels" filtered={!!q} onReset={() => setQ('')} />
        {err && <div className="dash-load-error" role="alert"><span><b>Could not load channels.</b> {err}</span>
          <button className="tool" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>}
      </div>
      <div className="dash-gallery-scroll">
        <div className="dash-collection-shell">
          {channels === null ? <div className="empty">Loading…</div>
            : err ? null : rows.length === 0 ? (
              <div className="dash-gallery-empty">
                <h2>{q ? 'No channel matches' : 'No channels yet'}</h2>
                <p>{q ? 'Try another name.' : 'Start one for a team or a topic — people and agents can both be in it.'}</p>
                {!q && !creating && <button className="btn action" onClick={() => setCreating(true)}>+ New channel</button>}
                {q && <button className="tool" onClick={() => setQ('')}>Show all channels</button>}
              </div>
            ) : (
              <div className="chl-list" role="list">
                {rows.map(c => (
                  <div role="listitem" key={c.id}><Link to={`/channels/${c.id}`} className="chl-row" aria-label={`Open channel #${c.name}`}>
                    <span className="chl-hash" aria-hidden="true">{c.visibility === 'private' ? <Lock /> : '#'}</span>
                    <span className="chl-main">
                      <b>{c.name}{c.visibility === 'private' && <span className="chl-badge">Private</span>}
                        {c.archived && <span className="chl-badge">Archived</span>}</b>
                      {c.topic && <span className="chl-topic">{c.topic}</span>}
                      {c.last
                        ? <span className="chl-last"><Face who={c.last.author} size={16} /><b>{c.last.author.name}</b><span className="chl-snippet">{c.last.body}</span></span>
                        : <span className="chl-last quiet">Nothing said yet</span>}
                    </span>
                    <span className="chl-side">
                      <span>{c.messages} {c.messages === 1 ? 'message' : 'messages'}</span>
                      {c.last_at && <span>active {since(c.last_at)}</span>}
                      <span className="chl-open">Open channel <span aria-hidden="true">→</span></span>
                    </span>
                  </Link></div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  )
}

export function ChannelView() {
  const { id = '' } = useParams()
  const [channel, setChannel] = useState<WireChannel | null | undefined>(undefined)
  const [err, setErr] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [messageCount, setMessageCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    setChannel(undefined); setErr(false); setMessageCount(null)
    listChannelsLive({ archived: true })
      .then(r => { if (alive) setChannel(r.channels.find(c => c.id === id) ?? null) })
      .catch(() => { if (alive) setErr(true) })
    return () => { alive = false }
  }, [id, attempt])
  const [settings, setSettings] = useState(false)

  if (err) return <div className="detail"><div className="dash-load-error" role="alert">
    <span>Could not load this channel.</span><button className="tool" onClick={() => setAttempt(a => a + 1)}>Retry</button>
    <Link to="/channels">All channels</Link>
  </div></div>
  if (channel === undefined) return <div className="detail"><p role="status">Loading channel…</p></div>

  if (channel === null) {
    return <div className="detail"><div className="empty">No such channel. <Link to="/channels">All channels</Link></div></div>
  }
  return (
    <div className="channel-page">
      <header className="channel-header">
        <Link to="/channels" className="channel-back">← All channels</Link>
        <div className="channel-heading">
          <span className="channel-mark" aria-hidden="true">{channel.visibility === 'private' ? <Lock /> : '#'}</span>
          <div className="channel-identity">
            <h1 className="ch-name">{channel.name}</h1>
            <p className="ch-topic">{channel.topic || 'A shared conversation for your team and agents.'}</p>
          </div>
          <span className="channel-message-count">{messageCount ?? channel.messages} {(messageCount ?? channel.messages) === 1 ? 'message' : 'messages'}</span>
          <div className="channel-actions">
            <ShareButton id={channel.id} title={`#${channel.name}`}
              onVisibility={visibility => setChannel(c => (c ? { ...c, visibility } : c))} />
            <button type="button" className="btn" onClick={() => setSettings(true)}>Settings</button>
          </div>
        </div>
        {channel.archived && <p className="channel-archived" role="status">This channel is archived. Its messages stay here to read.</p>}
      </header>
      <Thread key={id} subjectId={id} variant="channel" onCount={setMessageCount}
        placeholder={`Message #${channel.name}`}
        closed={channel.archived ? 'Archived — unarchive it in Settings to post again.' : undefined} />
      {settings && <ChannelSettings channel={channel} onClose={() => setSettings(false)}
        onChanged={setChannel} />}
    </div>
  )
}

/** A channel's name, topic and whether it is archived. Who can see it is
 *  the Share button's, as for any shared item. */
function ChannelSettings({ channel, onClose, onChanged }: {
  channel: WireChannel; onClose: () => void; onChanged: (c: WireChannel) => void
}) {
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.topic ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const clean = name.replace(/-$/, '')
  const changed = clean !== channel.name || topic.trim() !== (channel.topic ?? '')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const run = async (work: () => Promise<{ channel: WireChannel }>, close = true) => {
    setBusy(true); setErr(null)
    try { onChanged((await work()).channel); if (close) onClose() }
    catch (x) { setErr(x instanceof GatewayError ? x.message : String(x)) }
    finally { setBusy(false) }
  }
  return (
    <div className="share-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="share-dialog" role="dialog" aria-modal="true" aria-label={`Settings for #${channel.name}`}
        onSubmit={e => {
          e.preventDefault()
          if (!changed || clean.length < 2) return
          run(() => updateChannel(channel.id, { name: clean, topic: topic.trim() }))
        }}>
        <div className="share-head"><h2>#{channel.name} settings</h2>
          <button type="button" className="tp-x" aria-label="Close" onClick={onClose}>×</button></div>
        <label className="invite-field">Name
          <span className="chl-name-field"><span aria-hidden="true">#</span>
            <input value={name} maxLength={40} onChange={e => setName(slug(e.target.value))} autoFocus />
          </span>
        </label>
        <label className="invite-field">What it is for
          <input value={topic} maxLength={200} onChange={e => setTopic(e.target.value)} placeholder="Optional" />
        </label>
        <p className="share-note">Who can see it — everyone, or only people you add — is under <b>Share</b>.</p>
        {err && <p className="share-err" role="alert">{err}</p>}
        <div className="channel-danger">
          <div>
            <b>{channel.archived ? 'Unarchive this channel' : 'Archive this channel'}</b>
            <span>{channel.archived ? 'People can post in it again.' : 'It stays readable, and no one can post in it.'}</span>
          </div>
          <button type="button" className="btn" disabled={busy}
            onClick={() => run(() => archiveChannel(channel.id, !channel.archived))}>
            {channel.archived ? 'Unarchive' : 'Archive'}</button>
        </div>
        <div className="share-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn action" disabled={busy || !changed || clean.length < 2}>
            {busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  )
}
