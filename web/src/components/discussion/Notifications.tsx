import { useCallback, useEffect, useRef, useState } from 'react'
import { keepCurrent } from '../../data/live'
import { useNavigate } from 'react-router-dom'
import { listNotifications, markRead, type WireNotification } from '../../data/gateway'
import { conversationFor } from '../../data/links'
import { ago, Face } from '../TaskCard'

import { NOTIFICATIONS_CHANGED, openCommentsOn } from './signals'

export { NOTIFICATIONS_CHANGED, notificationsChanged } from './signals'

/** Where a conversation lives: kept under its old name for the callers that
 *  know it, and answered by the one place that knows where things are. */
export { conversationFor as hrefFor } from '../../data/links'

const since = (at: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000)
  return s < 60 ? 'just now' : `${ago(s)} ago`
}
/** A notification's text in one line: mentions shown as the names they are. */
function snippet(n: WireNotification): string {
  const byId = new Map(n.message.mentions.map(m => [m.id, m.name]))
  return (n.message.body ?? '').replace(/@([A-Za-z0-9][\w.-]*)/g, (all, id) => (byId.has(id) ? `@${byId.get(id)}` : all))
}

/** The bell: mentions of you, and replies in threads you are in — an agent
 *  answering your comment included. Unread until you open the conversation. */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ unread: number; notifications: WireNotification[] } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // Any other shape is nothing to show, not a top bar that crashes every page.
  const load = useCallback(() => listNotifications()
    .then(d => setData(Array.isArray(d?.notifications) ? d : { unread: 0, notifications: [] }))
    .catch(() => {}), [])

  useEffect(() => {
    load()
    // Read again when a conversation changes; the timer is the fallback.
    const stop = keepCurrent(load, 30_000, 120_000)
    window.addEventListener(NOTIFICATIONS_CHANGED, load)
    return () => { stop(); window.removeEventListener(NOTIFICATIONS_CHANGED, load) }
  }, [load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const unread = data?.unread ?? 0
  const go = async (n: WireNotification) => {
    if (!n.subject) return
    setOpen(false)
    const href = conversationFor(n.subject)
    // Only a page whose comments sit behind a button needs asking; a channel
    // or a task shows its conversation already.
    if (href.endsWith('#comments')) openCommentsOn(href.split(/[?#]/)[0])
    navigate(href)
    if (n.unread) { await markRead({ subject_id: n.subject.id }).catch(() => {}); load() }
  }

  return (
    <div className="nbell" ref={box}>
      <button type="button" className={`nbell-btn${open ? ' on' : ''}`} aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => { setOpen(o => !o); if (!open) load() }}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M10 2.8a4.7 4.7 0 0 0-4.7 4.7v2.9L4 13.2h12l-1.3-2.8V7.5A4.7 4.7 0 0 0 10 2.8zM8.2 15.6a1.9 1.9 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {unread > 0 && <span className="nbell-n">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="nbell-pop" role="dialog" aria-label="Notifications">
          <div className="nbell-head">
            <b>Notifications</b>
            {unread > 0 && <button type="button" className="linkbtn"
              onClick={async () => { await markRead({ all: true }).catch(() => {}); load() }}>Mark all read</button>}
          </div>
          {!data ? <p className="nbell-empty">Loading…</p>
            : data.notifications.length === 0 ? (
              <p className="nbell-empty">Nothing yet. When someone mentions you, or answers in a thread you are in,
                it shows up here.</p>
            ) : (
              <ul className="nbell-list">
                {data.notifications.map(n => (
                  <li key={n.message.id}>
                    <button type="button" className={n.unread ? 'unread' : ''} onClick={() => go(n)}>
                      <Face who={n.message.author} size={24} />
                      <span className="nbell-main">
                        <span className="nbell-line">
                          <b>{n.message.author.name}</b> {n.kind === 'mention' ? 'mentioned you' : 'replied'}
                          {n.subject && <> {n.kind === 'mention' ? 'on' : 'in'} <b>{n.subject.type === 'channel' ? `#${n.subject.title}` : n.subject.title}</b></>}
                        </span>
                        <span className="nbell-snip">{snippet(n)}</span>
                        <time dateTime={n.message.created_at}>{since(n.message.created_at)}</time>
                      </span>
                      {n.unread && <i className="nbell-dot" aria-label="unread" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  )
}
