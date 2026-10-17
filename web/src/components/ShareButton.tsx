import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  itemAccess, listPeople, setVisibility, shareItem, unshareItem, whoAmI,
  type ItemAccess, type ShareRole, type WirePerson,
} from '../data/gateway'

const ROLE: Record<ShareRole, string> = { view: 'Can view', edit: 'Can edit', owner: 'Owner' }
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Who can see and change this dashboard, doc or design — and, for its owners,
 *  a way to change that. Shared by email, with members of the workspace only. */
export function ShareButton({ id, title, onVisibility }: {
  id: string; title: string
  /** Told when who can see it changes, for a page that shows it — a channel's lock. */
  onVisibility?: (visibility: ItemAccess['visibility']) => void
}) {
  const [open, setOpen] = useState(false)
  const [access, setAccessState] = useState<ItemAccess | null>(null)
  const seen = useRef<ItemAccess['visibility'] | null>(null)
  // Held in a ref so setAccess stays one function: the dialog fetches again
  // whenever it changes, and a page passes a new callback every render.
  const told = useRef(onVisibility)
  useEffect(() => { told.current = onVisibility }, [onVisibility])
  const setAccess = useCallback((a: ItemAccess) => {
    if (seen.current && seen.current !== a.visibility) told.current?.(a.visibility)
    seen.current = a.visibility
    setAccessState(a)
  }, [])
  useEffect(() => {
    let alive = true
    itemAccess(id).then(a => { if (alive) setAccess(a) }).catch(() => {})
    return () => { alive = false }
  }, [id])
  const isPrivate = access?.visibility === 'private'
  return (
    <>
      <button type="button" className={`btn share-btn${open ? ' on' : ''}`} aria-expanded={open}
        title={access ? (isPrivate ? 'Only the people it is shared with can see this' : 'Everyone in the workspace can see this') : undefined}
        onClick={() => setOpen(true)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
          {isPrivate
            ? <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>
            : <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.8 1.6 1.8 9.4 0 11M8 2.5c-1.8 1.6-1.8 9.4 0 11" /></>}
        </svg>
        Share
      </button>
      {open && createPortal(
        <ShareDialog id={id} title={title} access={access} onAccess={setAccess} onClose={() => setOpen(false)} />,
        document.body)}
    </>
  )
}

const PALETTE = ['#4f46e5', '#0e7490', '#b45309', '#be185d', '#15803d', '#6d28d9']
const hue = (id: string) => PALETTE[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]
const initials = (name: string) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()

export function Avatar({ id, name }: { id: string; name: string }) {
  return <span className="share-avatar" style={{ background: hue(id) }} aria-hidden="true">{initials(name)}</span>
}

/** A select drawn like the rest of the product, not the browser's. */
export function Pick<T extends string>({ value, options, onChange, label, disabled, quiet }: {
  value: T; options: [T, string][]; onChange: (v: T) => void; label: string; disabled?: boolean; quiet?: boolean
}) {
  return (
    <span className={`share-pick${quiet ? ' quiet' : ''}`}>
      <select value={value} aria-label={label} disabled={disabled} onChange={e => onChange(e.target.value as T)}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  )
}

function ShareDialog({ id, title, access, onAccess, onClose }: {
  id: string; title: string; access: ItemAccess | null
  onAccess: (a: ItemAccess) => void; onClose: () => void
}) {
  const [members, setMembers] = useState<WirePerson[]>([])
  const [me, setMe] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<ShareRole>('view')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const listId = useId()
  const box = useRef<HTMLInputElement>(null)
  const manage = access?.you === 'manage'

  useEffect(() => {
    itemAccess(id).then(onAccess).catch(e => setErr(message(e)))
    listPeople().then(r => setMembers(r.people ?? [])).catch(() => {})
    whoAmI().then(w => setMe(w?.id ?? null)).catch(() => {})
    box.current?.focus()
  }, [id, onAccess])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setErr(null)
    try { await work(); onAccess(await itemAccess(id)) } catch (e) { setErr(message(e)) } finally { setBusy(false) }
  }
  const owners = access?.people.filter(p => p.role === 'owner').length ?? 0
  const suggestions = members.filter(m => m.email && !access?.people.some(p => p.id === m.id))
  const open = access?.visibility === 'workspace'
  const general = access?.general === 'edit' ? 'edit' : 'view'

  return (
    <div className="share-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="share-dialog" role="dialog" aria-modal="true" aria-label={`Share ${title}`}>
        <div className="share-head">
          <h2>Share “{title}”</h2>
          <button type="button" className="tp-x" aria-label="Close" onClick={onClose}>×</button>
        </div>

        {manage && (
          <form className="share-add" onSubmit={e => {
            e.preventDefault()
            if (!email.trim()) return
            run(async () => { await shareItem(id, email.trim(), role); setEmail('') })
          }}>
            <div className="share-field">
              <input ref={box} type="email" list={listId} value={email} placeholder="Add people by email"
                aria-label="Email of a workspace member" onChange={e => setEmail(e.target.value)} />
              <datalist id={listId}>
                {suggestions.map(m => <option key={m.id} value={m.email ?? ''}>{m.display}</option>)}
              </datalist>
              <Pick quiet value={role} label="Access to give" onChange={setRole}
                options={(Object.keys(ROLE) as ShareRole[]).map(r => [r, ROLE[r]])} />
            </div>
            <button type="submit" className="btn action share-send" disabled={busy || !email.trim()}>Share</button>
          </form>
        )}
        {err && <p className="share-err" role="alert">{err}</p>}

        <section aria-label="People with access">
          <div className="share-section">People with access</div>
          {!access ? <p className="share-note">Loading…</p> : (
            <ul className="share-people">
              {access.people.map(p => (
                <li key={p.id}>
                  <Avatar id={p.id} name={p.name} />
                  <span className="share-who"><b>{p.name}{p.id === me && <span className="share-you"> (you)</span>}</b>
                    {p.email && <span>{p.email}</span>}</span>
                  {manage && !(p.role === 'owner' && owners === 1) && p.email ? (
                    <Pick quiet value={p.role as string} label={`Access for ${p.name}`} disabled={busy}
                      options={[...(Object.keys(ROLE) as ShareRole[]).map(r => [r, ROLE[r]] as [string, string]), ['remove', 'Remove access']]}
                      onChange={v => run(() => v === 'remove' ? unshareItem(id, p.id) : shareItem(id, p.email!, v as ShareRole))} />
                  ) : <span className="share-role">{ROLE[p.role]}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {access && (
          <section aria-label="General access">
            <div className="share-section">General access</div>
            <div className="share-general">
              <span className={`share-globe${open ? ' open' : ''}`} aria-hidden="true">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  {open
                    ? <><path d="M2.5 13.5v-7l5.5-4 5.5 4v7" /><path d="M6 13.5v-4h4v4" /></>
                    : <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>}
                </svg>
              </span>
              <span className="share-who">
                {manage
                  ? <Pick quiet value={open ? 'workspace' : 'private'} label="Who can open this" disabled={busy}
                      options={[['private', 'Only people with access'], ['workspace', 'Everyone in the workspace']]}
                      onChange={v => run(() => setVisibility(id, v, general))} />
                  : <b>{open ? 'Everyone in the workspace' : 'Only people with access'}</b>}
                <span>{open
                  ? (access.general === 'role' ? 'Each member can do what their workspace role allows.'
                    : `Anyone in the workspace can ${general === 'edit' ? 'open and edit' : 'open'} this.`)
                  : 'Only the people added above can open this.'}</span>
              </span>
              {open && (manage
                ? <Pick quiet value={access.general === 'role' ? 'view' : general} label="What everyone can do" disabled={busy}
                    options={[['view', 'Can view'], ['edit', 'Can edit']]}
                    onChange={v => run(() => setVisibility(id, 'workspace', v))} />
                : <span className="share-role">{access.general === 'edit' ? 'Can edit' : access.general === 'view' ? 'Can view' : 'By role'}</span>)}
            </div>
          </section>
        )}
        {access && !manage && <p className="share-note">Only its owners can change who has access.</p>}

        <div className="share-foot"><button type="button" className="btn action" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
