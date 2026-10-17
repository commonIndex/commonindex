import { useEffect, useState } from 'react'
import {
  approveDesign, designReview, requestDesignChanges, requestDesignReview,
  type DesignReview, type WireDesign,
} from '../data/gateway'
import { EditorPopover } from './DesignEditorControls'

function ago(at?: string | null): string {
  if (!at) return ''
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000)
  if (s < 90) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m ago`
  const h = m / 60
  return h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`
}

/** A note field and a send button, inside a popover. `required` is for the
 *  two that record a reason: sending changes back, and approving your own. */
function NoteForm({ label, placeholder, required, busy, onSubmit, close }: {
  label: string; placeholder: string; required?: boolean; busy: boolean
  onSubmit: (note: string) => Promise<boolean>; close: () => void
}) {
  const [note, setNote] = useState('')
  const send = async () => {
    if (busy || (required && !note.trim())) return
    if (await onSubmit(note.trim())) close()
  }
  return <div className="dreview-form">
    <textarea rows={3} autoFocus value={note} placeholder={placeholder}
      aria-label={required ? `${label} — reason` : `${label} — note`}
      onChange={event => setNote(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() }
      }} />
    <div className="dreview-form-actions">
      <span className="hint">{required ? 'Required — it is recorded on the design' : 'Optional'}</span>
      <button className="btn action" disabled={busy || (required && !note.trim())} onClick={send}>{label}</button>
    </div>
  </div>
}

/** Where the design stands in review, and the one or two things the viewer can
 *  do about it. The gateway decides who may approve; this only asks it. */
export function DesignReviewBar({ design, blocked, onChanged }: {
  design: WireDesign
  /** Why review actions must wait — unsaved edits, a save in flight, an AI
   *  preview awaiting a decision. An approval is for what is saved. */
  blocked: string | null
  onChanged: () => Promise<void>
}) {
  const [status, setStatus] = useState<DesignReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const rev = design.current_rev

  useEffect(() => {
    let live = true
    designReview(design.id).then(r => { if (live) setStatus(r) }).catch(() => { if (live) setStatus(null) })
    return () => { live = false }
  }, [design.id, rev, design.state])

  // Nothing until the gateway has said — a bar guessing the viewer's rights
  // would offer buttons that then fail.
  if (!status?.you) return null
  const { you, review } = status
  const name = (id?: string | null) => (id && (status.names[id] ?? id)) || 'someone'

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true); setErr(null)
    try { await run(); await onChanged(); return true }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false }
    finally { setBusy(false) }
  }
  const locked = busy || !!blocked

  let tone: 'draft' | 'review' | 'approved' | 'changes' = 'draft'
  let line: React.ReactNode
  if (status.state === 'review') {
    tone = 'review'
    line = <>In review · asked by {name(review?.requested_by)} {ago(review?.requested_at)}
      {review?.note && <q>{review.note}</q>}</>
  } else if (status.state === 'approved') {
    tone = 'approved'
    line = <>{review?.self_approved ? 'Self-approved' : 'Approved'} by {name(review?.decided_by)} {ago(review?.decided_at)}
      {review?.decision_note && <q>{review.decision_note}</q>}
      <span className="hint"> · Editing it returns it to draft</span></>
  } else if (review?.decision === 'changes_requested') {
    tone = 'changes'
    line = <>Changes requested by {name(review.decided_by)} {ago(review.decided_at)}
      {review.decision_note && <q>{review.decision_note}</q>}</>
  } else if (review?.reopened_from) {
    line = <>Edited after it was {review.reopened_from === 'approved' ? 'approved' : 'sent for review'} — it needs review again</>
  } else {
    line = <>Draft · ask for review when it is ready to become something others build on</>
  }

  const waiting = status.state === 'review' && !you.may_approve && (you.made_this
    ? 'You made or changed this, so someone else with approve access reviews it.'
    : you.may_request_changes ? null : 'Waiting for someone with approve access.')

  const shownBlock = blocked && (you.may_request || you.may_approve || you.may_self_approve || you.may_request_changes)
    ? blocked : null

  return <section className={`dreview-bar ${tone}`} aria-label="Review">
    <span className="dreview-dot" aria-hidden="true" />
    {/* One line, whatever is said on it. The reason the buttons are off used
        to be a row of its own, so every unsaved edit added a line here and
        every save took it away again — and the sticky header moved the whole
        canvas up and down under the pointer with it. */}
    <p className="dreview-line" title={[typeof line === 'string' ? line : null, waiting, shownBlock].filter(Boolean).join(' · ') || undefined}>
      {line}{waiting && <span className="hint dreview-wait"> · {waiting}</span>}
      {shownBlock && <span className="hint dreview-blocked"> · {shownBlock}</span>}
    </p>
    <div className="dreview-actions">
      {you.may_request && <EditorPopover label="Request review" className="dreview-pop"
        disabled={locked} title={blocked ?? undefined}>
        {close => <NoteForm label="Send for review" busy={busy} close={close}
          placeholder="What should the reviewer look at? (optional)"
          onSubmit={note => act(() => requestDesignReview({ design_id: design.id, if_rev: rev, note: note || undefined }))} />}
      </EditorPopover>}
      {/* For the author it is the same move — back to draft, with a reason —
          but it is taking it back, not reviewing it, so it says so. */}
      {you.may_request_changes && <EditorPopover label={you.made_this ? 'Withdraw' : 'Request changes'}
        className="dreview-pop" disabled={locked} title={blocked ?? undefined}>
        {close => <NoteForm label={you.made_this ? 'Back to draft' : 'Send back'} required busy={busy} close={close}
          placeholder={you.made_this ? 'Why are you taking it back?' : 'What should change?'}
          onSubmit={note => act(() => requestDesignChanges({ design_id: design.id, if_rev: rev, note }))} />}
      </EditorPopover>}
      {you.may_approve && <EditorPopover label="Approve" className="dreview-pop dreview-approve"
        disabled={locked} title={blocked ?? undefined}>
        {close => <NoteForm label={`Approve rev ${rev}`} busy={busy} close={close}
          placeholder="Anything to note with the approval? (optional)"
          onSubmit={note => act(() => approveDesign({ design_id: design.id, if_rev: rev ?? 0, note: note || undefined }))} />}
      </EditorPopover>}
      {you.may_self_approve && <EditorPopover label="Approve my own…" className="dreview-pop"
        disabled={locked} title={blocked ?? 'Admins may approve their own work, with a reason everyone can see'}>
        {close => <NoteForm label="Self-approve" required busy={busy} close={close}
          placeholder="Why is nobody else approving this?"
          onSubmit={note => act(() => approveDesign({ design_id: design.id, if_rev: rev ?? 0, note, self_approve: true }))} />}
      </EditorPopover>}
    </div>
    {err && <p className="p-warn dreview-err" role="alert">{err}</p>}
  </section>
}
