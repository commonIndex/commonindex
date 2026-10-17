import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { getCounts } from '../data/api'
import { keepCurrent, startLive } from '../data/live'
import {
  listAgentsLive, listChannelsLive, listMembers, signOut, SIGNED_OUT, unreadCounts, whoAmI,
  type WireAgent, type WireChannel, type WireMe,
} from '../data/gateway'
import { NotificationBell, NOTIFICATIONS_CHANGED } from './discussion/Notifications'
import { openCommentsOn } from './discussion/signals'
import type { Counts } from '../data/types'
import { Glass } from './ui'
import { Palette } from './Palette'
import { NavIcon } from './NavIcon'
import { LogoMark } from './LogoMark'

const ToastCtx = createContext<(msg: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

/** What sits at the end of a row: a number, never a phrase. The phrase is in
 *  the tooltip. Blue means it is waiting on you; a dot marks something that
 *  needs a look (amber) or an agent's proposal (violet); plain is ambient. */
type Tone = 'you' | 'attn' | 'agent' | 'plain'
function Badge({ n, tone, title }: { n: number | string; tone: Tone; title?: string }) {
  return <span className={`nav-badge nb-${tone}`} title={title} aria-label={title}>
    {(tone === 'attn' || tone === 'agent') && <i />}{n}</span>
}

// One trailing mark per row: the badge when something is waiting on you,
// the ambient count otherwise — never both fighting for the same corner.
function SideLink({ to, label, icon, count, badge, end }: {
  to: string; label: string; icon: string; count?: string; badge?: React.ReactNode; end?: boolean
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
      <NavIcon name={icon} />
      <span className="label">{label}</span>
      {badge ?? (count ? <span className="nav-count">{count}</span> : null)}
    </NavLink>
  )
}

/** A sidebar group that folds. Folded or not is remembered per browser — a
 *  convenience, so a blocked storage just means everything starts open. */
function NavGroup({ id, label, extra, children }: { id: string; label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  const key = `nav.folded.${id}`
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  const toggle = () => setFolded(f => {
    try { localStorage.setItem(key, f ? '0' : '1') } catch { /* private window */ }
    return !f
  })
  return (
    <div className="nav-group">
      <button className="nav-label" aria-expanded={!folded} onClick={toggle}>
        <span>{label}</span>{extra}<span className={`nav-chev${folded ? '' : ' open'}`}><NavIcon name="chevron" /></span>
      </button>
      {!folded && children}
    </div>
  )
}

const CHANNEL_ROWS = 6 // the rest are on the Channels page — the sidebar is not a directory

/** Which edges of a scrolling box have more beyond them — so the sidebar can
 *  fade there instead of showing a scrollbar. Re-measured on scroll, on
 *  resize, and when its contents change (a group folding changes the height). */
function useOverflowEdges<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [edges, setEdges] = useState({ above: false, below: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const above = el.scrollTop > 1
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      setEdges(e => (e.above === above && e.below === below ? e : { above, below }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resized?.observe(el)
    const changed = new MutationObserver(measure)
    changed.observe(el, { childList: true, subtree: true })
    return () => { el.removeEventListener('scroll', measure); resized?.disconnect(); changed.disconnect() }
  }, [])
  return [ref, edges] as const
}

export function Shell() {
  const [navRef, navEdges] = useOverflowEdges<HTMLElement>()
  const [counts, setCounts] = useState<Counts | null>(null)
  const [channels, setChannels] = useState<WireChannel[] | null>(null)
  const [unread, setUnread] = useState<Record<string, number>>({})
  // The real actors. This showed a fabricated acceptance percentage beside
  // every agent on every page of the product — the most-seen number in the
  // workspace, and it came from `seed.ts`.
  const [agents, setAgents] = useState<WireAgent[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** The sidebar as a drawer, on a screen too narrow to keep it open. */
  const [navOpen, setNavOpen] = useState(false)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // Picking a page is what the drawer was opened for, so it closes.
  useEffect(() => { setNavOpen(false) }, [pathname])
  const [me, setMe] = useState<WireMe | null>(null)
  const [menu, setMenu] = useState(false)
  /** Managing who is in the workspace is an admin's: nobody else is shown the way to it. */
  const [admin, setAdmin] = useState(false)
  // No sign-in, or one the gateway no longer accepts: to the sign-in page,
  // rather than every panel failing on its own.
  useEffect(() => {
    // One stream of pushed changes for this tab (data/live.ts).
    startLive()
    whoAmI().then(setMe).catch(() => {})
    listMembers().then(r => setAdmin(r.you.role === 'admin')).catch(() => setAdmin(false))
    const out = () => navigate('/signin', { replace: true })
    window.addEventListener(SIGNED_OUT, out)
    return () => window.removeEventListener(SIGNED_OUT, out)
  }, [navigate])
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([])

  // The counts follow the work: re-read on every page change and whenever
  // tasks move, not once at load — an experiment registered or a doc written
  // in this session was missing from them until a full reload.
  useEffect(() => {
    let alive = true
    const read = () => getCounts().then(c => { if (alive) setCounts(c) }).catch(() => {})
    read()
    window.addEventListener('tasks:changed', read)
    return () => { alive = false; window.removeEventListener('tasks:changed', read) }
  }, [pathname])

  useEffect(() => {
    // Most recently active first; the rest are a click away.
    listChannelsLive().then(r => setChannels([...r.channels].sort((a, b) =>
      (b.last_at ?? '').localeCompare(a.last_at ?? '') || a.name.localeCompare(b.name))))
      .catch(() => setChannels([]))
    // The shell must not break when the gateway is down: an empty list is
    // the right degradation for a sidebar panel.
    listAgentsLive().then(r => setAgents(Array.isArray(r?.agents) ? r.agents : [])).catch(() => setAgents([]))
  }, [])

  // Unread per channel, re-read when something is read elsewhere and now and
  // then, since messages arrive from people and agents on their own clock.
  const channelIds = (channels ?? []).map(c => c.id).join(',')
  useEffect(() => {
    if (!channelIds) return
    const load = () => unreadCounts(channelIds.split(',')).then(r => setUnread(r?.unread ?? {})).catch(() => {})
    load()
    // Read again when a conversation changes; the timer is the fallback.
    const stop = keepCurrent(load, 30_000, 120_000)
    window.addEventListener(NOTIFICATIONS_CHANGED, load)
    return () => { stop(); window.removeEventListener(NOTIFICATIONS_CHANGED, load) }
  }, [channelIds])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
      if (e.key === 'Escape') { setPaletteOpen(false); setNavOpen(false) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t.slice(-2), { id, msg }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3400)
  }, [])

  return (
    <ToastCtx.Provider value={toast}>
      <div className="topbar">
        {/* Below 700px the sidebar is hidden, and this was the only way back
            to it — so a phone could reach another page only through search. */}
        <button type="button" className="nav-toggle" aria-label="Menu" aria-expanded={navOpen}
          aria-controls="sidebar" onClick={() => setNavOpen(o => !o)}>
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
        <div className="logo"><LogoMark /><span className="logo-name">CommonIndex</span></div>
        <div className="cmdbar" tabIndex={0} role="button" onClick={() => setPaletteOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter') setPaletteOpen(true) }}>
          <Glass />
          <span>Ask anything or jump to…</span>
          <kbd>⌘K</kbd>
        </div>
        <NotificationBell />
        <div className="me-menu">
          <button type="button" className="avatar av-h" aria-label="Your account" aria-expanded={menu}
            onClick={() => setMenu(o => !o)}>{(me?.display ?? '?').slice(0, 1).toUpperCase()}</button>
          {menu && <div className="me-pop" role="menu" onMouseLeave={() => setMenu(false)}>
            <div className="me-who"><b>{me?.display ?? 'Signed in'}</b>
              <span>{me?.via === 'local' ? 'Signed in automatically on this computer' : me?.id}</span></div>
            {admin && <NavLink role="menuitem" to="/members" onClick={() => setMenu(false)}>Members</NavLink>}
            {admin && <NavLink role="menuitem" to="/settings/sign-in" onClick={() => setMenu(false)}>Sign-in settings</NavLink>}
            <NavLink role="menuitem" to="/tokens" onClick={() => setMenu(false)}>Tokens for CLI &amp; MCP</NavLink>
            <button role="menuitem" type="button" onClick={async () => { await signOut(); navigate('/signin', { replace: true }) }}>Sign out</button>
          </div>}
        </div>
      </div>
      <div className="app">
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
        <nav ref={navRef} id="sidebar" aria-label="Workspace"
          className={`sidebar${navOpen ? ' open' : ''}${navEdges.above ? ' more-above' : ''}${navEdges.below ? ' more-below' : ''}`}>
          <NavGroup id="collections" label="Collections">
            <SideLink to="/board" label="Board" icon="board"
              count={counts ? String(counts.tasks.total) : ''}
              badge={counts && counts.tasks.review > 0 ? <Badge n={counts.tasks.review} tone="attn" title={`${counts.tasks.review} in review`} /> : undefined} />
            <SideLink to="/projects" label="Projects" icon="projects" />
            <SideLink to="/experiments" label="Experiments" icon="experiments"
              count={counts ? String(counts.experiments.total) : ''}
              badge={counts && counts.experiments.readout > 0 ? <Badge n={counts.experiments.readout} tone="attn" title={`${counts.experiments.readout} to decide`} /> : undefined} />
            <SideLink to="/code" label="Code query" icon="code" />
            <SideLink to="/docs" label="Docs" icon="docs"
              count={counts ? String(counts.docs.total) : ''}
              badge={counts && counts.docs.stale > 0 ? <Badge n={counts.docs.stale} tone="attn" title={`${counts.docs.stale} stale`} /> : undefined} />
            <SideLink to="/dashboards" label="Dashboards" icon="dashboards"
              count={counts ? String(counts.dashboards.total) : ''}
              badge={counts && counts.dashboards.proposals > 0 ? <Badge n={counts.dashboards.proposals} tone="agent" title={`${counts.dashboards.proposals} agent proposals`} /> : undefined} />
            <SideLink to="/designs" label="Designs" icon="designs" />
            <SideLink to="/videos" label="Videos" icon="videos" />
            <SideLink to="/skills" label="Skills" icon="skills"
              count={counts ? String(counts.skills.installed) : ''}
              badge={counts && counts.skills.proposed > 0 ? <Badge n={counts.skills.proposed} tone="agent" title={`${counts.skills.proposed} proposed by agents`} /> : undefined} />
            <SideLink to="/agents" label="Agents" icon="agents" count={String(agents.length || '')} />
          </NavGroup>
          {admin && <NavGroup id="workspace" label="Workspace">
            <SideLink to="/members" label="Members" icon="members" />
            <SideLink to="/settings/sign-in" label="Sign-in" icon="signin" />
          </NavGroup>}
          <NavGroup id="channels" label="Channels">
            {(channels ?? []).slice(0, CHANNEL_ROWS).map(c => (
              <SideLink key={c.id} to={`/channels/${c.id}`} label={c.name} icon={c.visibility === 'private' ? 'channel-private' : 'channel'}
                badge={unread[c.id] ? <Badge n={unread[c.id]} tone="you" title={`${unread[c.id]} unread`} /> : undefined} />
            ))}
            <SideLink to="/channels" label={channels && channels.length ? 'All channels' : 'Start a channel'}
              icon="more" end count={channels && channels.length > CHANNEL_ROWS ? String(channels.length) : ''} />
          </NavGroup>
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} onGo={href => {
        setPaletteOpen(false)
        // A comment found by search opens where it was said, drawer open.
        if (href.endsWith('#comments')) openCommentsOn(href.split(/[?#]/)[0])
        navigate(href)
      }} />}
      <div className="toasts">
        {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  )
}
