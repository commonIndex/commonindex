import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Avatar, Pick } from '../components/ShareButton'
import {
  GatewayError, inviteMember, listMembers, newMemberToken, removeMember, setMemberRole,
  type Member, type MemberRole,
} from '../data/gateway'
import { useToast } from '../components/Shell'
import { ago } from '../components/TaskCard'

const ROLES: { id: MemberRole; label: string; says: string }[] = [
  { id: 'viewer', label: 'Viewer', says: 'Views content they have access to.' },
  { id: 'contributor', label: 'Contributor', says: 'Creates and edits work; proposes changes.' },
  { id: 'reviewer', label: 'Reviewer', says: 'Also approves and merges proposed changes.' },
  { id: 'admin', label: 'Admin', says: 'Also manages workspace access and members.' },
]
const LABEL = Object.fromEntries(ROLES.map(r => [r.id, r.label])) as Record<MemberRole, string>
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const signInLink = (token: string) => `${window.location.origin}/signin#token=${encodeURIComponent(token)}`
const validEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
type Receipt = { who: string; email: string | null; role: MemberRole; token: string | null; fresh: boolean }

function seen(at: string) {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000)
  return s < 120 ? 'Just now' : `${ago(s)} ago`
}

export function MembersView() {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [me, setMe] = useState<{ id: string; role: MemberRole | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [managing, setManaging] = useState<Member | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<MemberRole | 'all'>('all')
  const [activity, setActivity] = useState<'all' | 'never'>('all')
  const request = useRef(0)
  const inviteTrigger = useRef<HTMLButtonElement>(null)
  const toast = useToast()
  const admin = me?.role === 'admin'

  const load = useCallback(async () => {
    const req = ++request.current
    try {
      const r = await listMembers()
      if (req !== request.current) return
      setMembers(r.members); setMe(r.you); setErr(null); setDenied(false)
    } catch (e) {
      if (req !== request.current) return
      if (e instanceof GatewayError && e.code === 'denied') {
        setDenied(true); setMembers(null); setMe(null)
      } else setErr(message(e))
    }
  }, [])
  useEffect(() => { load(); return () => { request.current++ } }, [load])

  const needle = query.trim().toLowerCase()
  const rows = (members ?? []).filter(m => (!needle || `${m.name} ${m.email ?? ''}`.toLowerCase().includes(needle))
    && (role === 'all' || m.role === role) && (activity === 'all' || !m.last_seen))
  const filtered = !!needle || role !== 'all' || activity !== 'all'
  const reset = () => { setQuery(''); setRole('all'); setActivity('all') }
  const admins = members?.filter(m => m.role === 'admin').length ?? 0
  const never = members?.filter(m => !m.last_seen).length ?? 0
  const updated = (next: Member[]) => {
    // An older list response must not undo a completed role change or removal.
    request.current++
    setMembers(next); setManaging(null)
    const you = next.find(m => m.id === me?.id)
    setMe(current => current ? { ...current, role: you?.role ?? null } : current)
    if (you?.role !== 'admin') { setDenied(true); setMembers(null) }
  }

  return <div className="collection members-page workspace-collection">
    <header className="dash-collection-header dash-collection-shell">
      <div>
        <h1 className="coll-title">Members {!denied && <span className="total">{members?.length ?? '—'}</span>}</h1>
        <p className="coll-sub">{denied ? 'Only workspace admins can see and manage members. Ask an admin to add someone.'
          : 'Manage your team, workspace roles, and sign-in access.'}</p>
      </div>
      {admin && !denied && <button ref={inviteTrigger} className="btn action" onClick={() => setInviting(true)}>+ Invite people</button>}
    </header>
    {!denied && <>
      <div className="dash-collection-shell">
        {members && <div className="members-tools">
          <div className="members-activity" role="group" aria-label="Member activity">
            <button className={`chip${activity === 'all' ? ' on' : ''}`} aria-pressed={activity === 'all'} onClick={() => setActivity('all')}>All members</button>
            <button className={`chip${activity === 'never' ? ' on' : ''}`} aria-pressed={activity === 'never'} onClick={() => setActivity('never')}>
              Not signed in <span>{never}</span></button>
          </div>
          <input className="dash-search" type="search" aria-label="Search members" placeholder="Search by name or email…"
            value={query} onChange={e => setQuery(e.target.value)} />
          <Pick<MemberRole | 'all'> label="Filter by role" value={role} onChange={setRole}
            options={[["all", 'All roles'], ...ROLES.map(r => [r.id, r.label] as [MemberRole, string])]} />
        </div>}
        {err && <div className="dash-load-error" role="alert"><span><b>Could not {members ? 'refresh' : 'load'} members.</b> {err}</span>
          <button className="tool" onClick={load}>Retry</button></div>}
        {members && <div className="members-results"><span role="status">{filtered ? `${rows.length} of ${members.length} members` : `${members.length} ${members.length === 1 ? 'member' : 'members'} · ${admins} ${admins === 1 ? 'admin' : 'admins'}`}</span>
          {filtered && <button className="linkbtn" onClick={reset}>Clear filters</button>}</div>}
      </div>
      <div className="dash-gallery-scroll"><div className="dash-collection-shell">
        {!members ? !err && <p className="members-loading" role="status">Loading members…</p> : rows.length ? <>
          <div className="members-table-wrap"><table className="members-table" aria-label="Members">
            <thead><tr><th scope="col">Member</th><th scope="col">Last activity</th><th scope="col">Workspace role</th><th scope="col"><span className="dash-sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.map(m => <tr key={m.id}>
              <td><div className="member-person"><Avatar id={m.id} name={m.name} /><span className="share-who">
                <b>{m.name} {m.id === me?.id && <span className="member-you">You</span>}</b><span>{m.email ?? 'No email on file'}</span>
              </span></div></td>
              <td className="member-activity-cell">{m.last_seen ? <time dateTime={m.last_seen} title={new Date(m.last_seen).toLocaleString()}>{seen(m.last_seen)}</time>
                : <span className="member-not-seen" title="Access is granted, but no sign-in activity has been recorded.">Not signed in</span>}</td>
              <td><span className={`member-role role-${m.role}`}>{LABEL[m.role]}</span></td>
              <td>{admin && <button className="member-manage" aria-label={`Manage ${m.name}`} onClick={() => setManaging(m)}>Manage <span aria-hidden="true">→</span></button>}</td>
            </tr>)}</tbody>
          </table></div>
          <details className="members-role-guide"><summary>Understand workspace roles</summary>
            <div>{ROLES.map(r => <section key={r.id}><b>{r.label}</b><p>{r.says}</p></section>)}</div>
            <p>Item-specific sharing is managed on each doc, dashboard, or design. A workspace must keep at least one admin.</p>
          </details>
        </> : <div className="dash-gallery-empty"><h2>{filtered ? 'No matching members' : 'No members to show'}</h2>
          <p>{filtered ? 'Try a different name, email, role, or activity filter.' : 'Invite someone to start working together.'}</p>
          {filtered ? <button className="btn" onClick={reset}>Show all members</button>
            : admin && <button className="btn action" onClick={() => setInviting(true)}>+ Invite people</button>}</div>}
      </div></div>
    </>}
    {!denied && inviting && <InviteDialog members={members ?? []} onClose={() => setInviting(false)} onInvited={r => {
      setInviting(false); setReceipt(r); load()
    }} />}
    {!denied && managing && <ManageMemberDialog member={managing} self={managing.id === me?.id}
      lastAdmin={managing.role === 'admin' && admins === 1} onClose={() => setManaging(null)} onUpdated={updated}
      onLink={r => { setManaging(null); setReceipt(r) }} onNotice={toast} />}
    {receipt && <LinkDialog {...receipt} onClose={() => { setReceipt(null); requestAnimationFrame(() => inviteTrigger.current?.focus()) }} />}
  </div>
}

/** Keyboard-contained and height-bounded. Pending requests cannot lose the
 *  only copy of a new sign-in link to an accidental Escape or backdrop click. */
function MembersDialog({ title, subtitle, children, footer, onClose, onSubmit, busy = false, dismissible = true }: {
  title: string; subtitle?: string; children: ReactNode; footer: ReactNode; onClose: () => void
  onSubmit?: () => void; busy?: boolean; dismissible?: boolean
}) {
  const id = useId()
  const dialog = useRef<HTMLFormElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const previousTitle = useRef(title)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const background = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== overlay.current)
      .map(node => ({ node, inert: node.inert, hidden: node.getAttribute('aria-hidden') }))
    const first = dialog.current?.querySelector<HTMLElement>('[data-initial-focus]')
      ?? dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')
    ;(first ?? dialog.current)?.focus()
    background.forEach(({ node }) => { node.inert = true; node.setAttribute('aria-hidden', 'true') })
    return () => {
      background.forEach(({ node, inert, hidden }) => {
        node.inert = inert
        if (hidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', hidden)
      })
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useLayoutEffect(() => {
    if (previousTitle.current !== title) dialog.current?.focus()
    previousTitle.current = title
  }, [title])
  return createPortal(<div className="share-overlay members-overlay" ref={overlay}
    onClick={e => { if (dismissible && !busy && e.target === e.currentTarget) onClose() }}>
    <form ref={dialog} noValidate className="members-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      aria-describedby={subtitle ? `${id}-description` : undefined} aria-busy={busy} tabIndex={-1}
      onSubmit={e => { e.preventDefault(); if (!busy) onSubmit?.() }} onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy && dismissible) onClose() }
        if (e.key !== 'Tab') return
        // Keep DOM order even in selector engines that group comma-separated matches.
        const fields = [...(dialog.current?.querySelectorAll<HTMLElement>('*') ?? [])]
          .filter(el => el.matches('button, input, select, [tabindex="0"]') && !el.matches(':disabled')
            && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked))
        const first = fields[0], last = fields.at(-1)
        if (!first) { e.preventDefault(); return }
        if (!dialog.current?.contains(document.activeElement) || document.activeElement === dialog.current) { e.preventDefault(); (e.shiftKey ? last : first)?.focus() }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }}>
      <header className="members-dialog-head"><div><span className="members-kicker">Workspace access</span>
        <h2 id={`${id}-title`}>{title}</h2>{subtitle && <p id={`${id}-description`}>{subtitle}</p>}</div>
        {dismissible && <button type="button" className="tp-x" aria-label="Close" disabled={busy} onClick={onClose}>×</button>}
      </header>
      <div className="members-dialog-body">{children}</div>
      <footer className="members-dialog-foot">{footer}</footer>
    </form>
  </div>, document.body)
}

function RoleChoices({ role, onChange, disabled }: { role: MemberRole; onChange: (role: MemberRole) => void; disabled?: boolean }) {
  const id = useId()
  return <fieldset className="invite-roles" disabled={disabled}><legend>Workspace role</legend>
    <div className="invite-role-grid">{ROLES.map(r => <label key={r.id} className={role === r.id ? 'on' : ''}>
      <input type="radio" name={`${id}-role`} aria-label={r.label} aria-describedby={`${id}-${r.id}-description`}
        value={r.id} checked={role === r.id} onChange={() => onChange(r.id)} />
      <span><b>{r.label}</b><span id={`${id}-${r.id}-description`}>{r.says}</span></span>
    </label>)}</div>
    <p className="invite-role-help">Item-specific sharing settings still apply.</p>
  </fieldset>
}

function InviteDialog({ members, onClose, onInvited }: { members: Member[]; onClose: () => void; onInvited: (r: Receipt) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('contributor')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({})
  const nameBox = useRef<HTMLInputElement>(null)
  const emailBox = useRef<HTMLInputElement>(null)
  const id = useId()
  const emailError = () => !validEmail(email) ? 'Enter a valid email address, such as name@example.com.'
    : members.some(m => m.email?.toLowerCase() === email.trim().toLowerCase()) ? 'This person is already a workspace member.' : undefined
  const submit = async () => {
    if (sending.current) return
    const next = { name: name.trim() ? undefined : 'Enter their name.', email: emailError() }
    setErrors(next); setErr(null)
    if (next.name || next.email) { (next.name ? nameBox : emailBox).current?.focus(); return }
    sending.current = true; setBusy(true)
    try {
      const r = await inviteMember(name.trim(), email.trim(), role)
      onInvited({ who: r.name, email: r.email, role: r.role, token: r.token, fresh: true })
    } catch (cause) {
      if (cause instanceof GatewayError && (cause.field === 'email' || cause.field === 'name')) {
        setErrors({ [cause.field]: message(cause) })
        requestAnimationFrame(() => (cause.field === 'email' ? emailBox : nameBox).current?.focus())
      } else setErr(message(cause))
    } finally { sending.current = false; setBusy(false) }
  }
  return <MembersDialog title="Invite people" subtitle="Bring a teammate into this workspace." onClose={onClose} onSubmit={submit} busy={busy}
    footer={<><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="submit" className="btn action" disabled={busy}>{busy ? 'Adding member…' : 'Add member'}</button></>}>
    <div className="invite-fields">
      <label className="invite-field"><span>Name</span><input ref={nameBox} data-initial-focus aria-label="Name" value={name} disabled={busy}
        onChange={e => { setName(e.target.value); setErrors(x => ({ ...x, name: undefined })) }} placeholder="Rhea Kapoor" maxLength={120}
        aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-error` : undefined} />
        {errors.name && <span className="member-field-error" id={`${id}-name-error`} role="alert">{errors.name}</span>}</label>
      <label className="invite-field"><span>Email</span><input ref={emailBox} type="email" aria-label="Email" inputMode="email" autoCapitalize="none" autoCorrect="off"
        value={email} disabled={busy} onChange={e => { setEmail(e.target.value); setErrors(x => ({ ...x, email: undefined })) }}
        onBlur={() => { if (email.trim()) setErrors(x => ({ ...x, email: emailError() })) }} placeholder="rhea@example.com" maxLength={254}
        aria-invalid={!!errors.email} aria-describedby={errors.email ? `${id}-email-error` : undefined} />
        {errors.email && <span className="member-field-error" id={`${id}-email-error`} role="alert">{errors.email}</span>}</label>
    </div>
    <RoleChoices role={role} onChange={setRole} disabled={busy} />
    {role === 'admin' && <p className="member-notice caution">Admins can grant or remove other people’s workspace access. Choose this only if they should manage the team.</p>}
    <div className="member-notice"><b>No invitation email is sent.</b><p>Access is granted immediately. You’ll get a private sign-in link to share with a new member; existing users keep their sign-in.</p></div>
    {err && <p className="member-field-error" role="alert">{err}</p>}
  </MembersDialog>
}

function ManageMemberDialog({ member, self, lastAdmin, onClose, onUpdated, onLink, onNotice }: {
  member: Member; self: boolean; lastAdmin: boolean; onClose: () => void
  onUpdated: (members: Member[]) => void; onLink: (r: Receipt) => void; onNotice: (text: string) => void
}) {
  const [role, setRole] = useState(member.role)
  const [action, setAction] = useState<'role' | 'token' | 'remove'>('role')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    if (running.current || (action === 'role' && (role === member.role || lastAdmin))) return
    running.current = true; setBusy(true); setErr(null)
    try {
      if (action === 'token') {
        const r = await newMemberToken(member.id)
        // No link where people sign in with their company account: signing
        // them out everywhere is the whole of it.
        if (r.token) onLink({ who: member.name, email: member.email, role: member.role, token: r.token, fresh: false })
        else onNotice(`${member.name} was signed out everywhere — they sign in again with their company account`)
      } else if (action === 'remove') {
        if (self || lastAdmin) return
        const r = await removeMember(member.id)
        onUpdated(r.members); onNotice(`${member.name} was removed. Their work has been kept.`)
      } else {
        const r = await setMemberRole(member.id, role)
        onUpdated(r.members); onNotice(`${member.name} is now ${LABEL[role]}`)
      }
    } catch (cause) { setErr(message(cause)) }
    finally { running.current = false; setBusy(false) }
  }
  return <MembersDialog title={action === 'token' ? 'Replace sign-in link?' : action === 'remove' ? 'Remove workspace access?' : `Manage ${member.name}`}
    subtitle={action === 'role' ? 'Review their role and sign-in access.' : `For ${member.name}${member.email ? ` · ${member.email}` : ''}`}
    busy={busy} onClose={onClose} onSubmit={run}
    footer={<><button type="button" className="btn" disabled={busy} onClick={action === 'role' ? onClose : () => { setAction('role'); setErr(null) }}>{action === 'role' ? 'Cancel' : 'Back'}</button>
      <button type="submit" className={`btn ${action === 'remove' ? 'member-danger' : 'action'}`}
        disabled={busy || (action === 'role' && (role === member.role || lastAdmin))}>
        {busy ? 'Saving…' : action === 'token' ? 'Replace sign-in link' : action === 'remove' ? 'Remove member' : 'Save role'}</button></>}>
    {action === 'role' ? <>
      <div className="member-profile"><Avatar id={member.id} name={member.name} /><div><b>{member.name}{self ? ' (you)' : ''}</b><span>{member.email ?? 'No email on file'}</span></div>
        <span className={`member-role role-${member.role}`}>{LABEL[member.role]}</span></div>
      <RoleChoices role={role} onChange={setRole} disabled={busy || lastAdmin} />
      {lastAdmin && <p className="member-notice">This is the workspace’s only admin. Make someone else an admin before changing this role.</p>}
      {self && role !== 'admin' && <p className="member-notice caution">You’ll lose access to member management after saving this role.</p>}
      {!self && role === 'admin' && member.role !== 'admin' && <p className="member-notice caution">This gives {member.name} permission to manage workspace access for other people.</p>}
      <section className="member-access-actions" aria-label="Sign-in and access"><h3>Sign-in & access</h3>
        <button type="button" disabled={busy} onClick={() => { setAction('token'); setErr(null) }}><span><b>Replace sign-in link</b>{' '}<small>For a lost link. Previous sign-in tokens stop working.</small></span><span aria-hidden="true">→</span></button>
        {!self && !lastAdmin && <button type="button" className="danger" disabled={busy} onClick={() => { setAction('remove'); setErr(null) }}><span><b>Remove from workspace</b>{' '}<small>Revoke their access and keep their work.</small></span><span aria-hidden="true">→</span></button>}
      </section>
    </> : <div className={`member-notice${action === 'remove' ? ' caution' : ''}`}>
      {action === 'token' ? <><b>The previous sign-in will stop working immediately.</b><p>You’ll receive a new private link to share with {member.name}. No email is sent.</p>
        {self && <p><b>This also ends your current sign-in.</b> Save the new link and use it to sign in again.</p>}</>
        : <><b>{member.name} will lose access to this workspace.</b><p>Their work stays. Items only they owned will pass to you. You can add them again later if needed.</p></>}
    </div>}
    {err && <p className="member-field-error" role="alert">{err}</p>}
  </MembersDialog>
}

/** Tokens are kept only in component memory, never in browser storage. */
function LinkDialog({ who, email, role, token, fresh, onClose }: Receipt & { onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const url = token ? signInLink(token) : null
  return <MembersDialog title={fresh ? `${who} has access` : `New sign-in link for ${who}`}
    subtitle={fresh ? 'The workspace membership is ready.' : 'Their previous sign-in tokens no longer work.'}
    onClose={onClose} dismissible={false} footer={<button type="button" className="btn action" onClick={onClose}>Done</button>}>
    <div className="member-profile"><span className="member-success" aria-hidden="true">✓</span><div><b>{who}</b><span>{email ?? 'Workspace member'}</span></div>
      <span className={`member-role role-${role}`}>{LABEL[role]}</span></div>
    {url ? <>
      <div className="member-notice"><b>Copy this link before closing.</b><p>It’s shown only once. Anyone with this link can sign in as {who}, so share it privately with them.</p></div>
      <label className="invite-field"><span>Private sign-in link</span><div className="invite-link">
        <input ref={field} type="text" value={url} readOnly onFocus={e => e.target.select()} aria-label="Private sign-in link" />
        <button type="button" className="btn action" data-initial-focus onClick={async () => {
          try { await navigator.clipboard.writeText(url); setCopied(true); setCopyError(false) }
          catch { setCopyError(true); field.current?.focus(); field.current?.select() }
        }}>{copied ? 'Copied ✓' : 'Copy link'}</button></div></label>
      {copied && <p className="member-copy-status" role="status">Link copied. Share it privately with {who}.</p>}
      {copyError && <p className="member-field-error" role="alert">Couldn’t copy automatically. The link is selected — press ⌘/Ctrl+C to copy it.</p>}
      <p className="share-note">No email was sent. If the link is lost, an admin can replace it from Members.</p>
    </> : <div className="member-notice"><b>They can use their existing sign-in.</b><p>No new link was created and no email was sent. Let {who} know they now have access to this workspace.</p></div>}
  </MembersDialog>
}
