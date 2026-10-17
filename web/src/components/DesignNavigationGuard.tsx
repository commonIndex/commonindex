import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBlocker } from 'react-router-dom'

/** Protects links, command-palette navigation and browser Back/Forward alike. */
export function DesignNavigationGuard({ pending, busy, reviewRequired = false, onSave, error }: {
  pending: boolean
  busy: boolean
  reviewRequired?: boolean
  onSave: () => Promise<boolean>
  error: string | null
}) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    (pending || busy) && currentLocation.pathname !== nextLocation.pathname)
  const latestBlocker = useRef(blocker)
  latestBlocker.current = blocker
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const blocked = blocker.state === 'blocked'
  useLayoutEffect(() => {
    if (!blocked) return
    const previous = document.activeElement as HTMLElement | null
    // The portal is a body sibling, so the rest of the application can be
    // made inert without hiding the confirmation itself from assistive tech.
    const background = [...document.body.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node !== overlay.current).map(node => ({
        node, inert: node.inert, hidden: node.getAttribute('aria-hidden'),
      }))
    keep.current?.focus()
    background.forEach(({ node }) => { node.inert = true; node.setAttribute('aria-hidden', 'true') })
    return () => {
      background.forEach(({ node, inert, hidden }) => {
        node.inert = inert
        if (hidden === null) node.removeAttribute('aria-hidden')
        else node.setAttribute('aria-hidden', hidden)
      })
      if (previous?.isConnected) previous.focus()
    }
  }, [blocked])
  useLayoutEffect(() => {
    if (blocked) (saving ? dialog.current : keep.current)?.focus()
  }, [blocked, saving])
  if (blocker.state !== 'blocked') return null

  const saveAndLeave = async () => {
    if (busy || saving || reviewRequired) return
    setSaving(true)
    try {
      if (await onSave()) {
        const latest = latestBlocker.current
        if (latest.state === 'blocked') latest.proceed()
      }
    } finally { setSaving(false) }
  }
  return createPortal(<div ref={overlay} className="overlay dleave-overlay">
    <div ref={dialog} tabIndex={-1} className="dleave-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onKeyDown={event => {
        // The canvas must not receive Delete/Backspace or its undo shortcut
        // while the user is answering this dialog.
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); if (!saving) blocker.reset() }
        if (event.key === 'Tab') {
          const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const first = buttons[0], last = buttons[buttons.length - 1]
          if (!buttons.length) event.preventDefault()
          else if (document.activeElement === dialog.current) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      <h2 id={`${id}-title`}>Leave this design?</h2>
      <p id={`${id}-description`}>{busy
        ? 'A design update is still in progress. Wait for it to finish before leaving.'
        : reviewRequired ? 'You have unaccepted AI changes. Return to review them, or discard the preview before leaving.'
        : pending ? 'You have unsaved changes. Save them before leaving, or discard them for this design.'
        : 'Your changes have finished saving. You can now leave safely.'}</p>
      {error && <p role="alert" className="p-warn">{error}</p>}
      <div className="dleave-actions">
        <button ref={keep} className="tool" disabled={saving} onClick={() => blocker.reset()}>{reviewRequired ? 'Review AI changes' : 'Keep editing'}</button>
        {pending && <button className="tool" disabled={busy || saving} onClick={() => blocker.proceed()}>Discard and leave</button>}
        {!reviewRequired && <button className="btn action" disabled={busy || saving} onClick={pending ? saveAndLeave : blocker.proceed}>
          {saving ? 'Saving…' : pending ? 'Save and leave' : 'Leave design'}
        </button>}
      </div>
    </div>
  </div>, document.body)
}
