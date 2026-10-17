import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Face } from '../TaskCard'
import { mentionAt, useMentionables, type Mentionable } from './mentions'
import { useDebounced } from '../../hooks'
import { MessageLinkPreviews } from './LinkPreviews'

/** A message box that knows about people and agents. Typing `@` offers the
 *  people and agents in the space; picking one writes `@id`, which the gateway
 *  resolves — and for an agent, turns into an ask in its inbox.
 *
 *  Enter sends and Shift+Enter breaks the line, except while the picker is open,
 *  when Enter and Tab choose. */
export function MentionComposer({ placeholder, onSend, onCancel, initial = '', sendLabel = 'Send',
  autoFocus, compact, disabled, draft, onDraftChange }: {
  placeholder: string
  onSend: (body: string) => Promise<unknown> | void
  onCancel?: () => void
  initial?: string
  sendLabel?: string
  autoFocus?: boolean
  compact?: boolean
  disabled?: boolean
  /** A caller-owned draft survives closing or switching a channel thread. */
  draft?: string
  onDraftChange?: (value: string) => void
}) {
  const people = useMentionables()
  const [localValue, setLocalValue] = useState(initial)
  const value = draft ?? localValue
  const previewText = useDebounced(value, 400)
  const setValue = (next: string) => { setLocalValue(next); onDraftChange?.(next) }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const [at, setAt] = useState<{ query: string; start: number } | null>(null)
  const [pick, setPick] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  /** Where the caret goes after the render that inserts a mention. Set in the
   *  same render rather than a frame later — a frame later, anything typed in
   *  between landed after it, and the message came out scrambled. */
  const caretTo = useRef<number | null>(null)
  const listId = useId()

  const grow = () => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }
  useEffect(grow, [value])
  useLayoutEffect(() => {
    if (caretTo.current === null || !box.current) return
    box.current.setSelectionRange(caretTo.current, caretTo.current)
    caretTo.current = null
  }, [value])
  // preventScroll: a composer that opens in a side panel is already in view, and
  // letting focus scroll it there slid the whole app sideways by the sidebar's width.
  useEffect(() => { if (autoFocus) box.current?.focus({ preventScroll: true }) }, [autoFocus])

  const matches: Mentionable[] = at
    ? people.filter(p => `${p.id} ${p.name}`.toLowerCase().includes(at.query.toLowerCase())).slice(0, 6)
    : []
  const open = !busy && !!at && matches.length > 0

  const track = (el: HTMLTextAreaElement) => { setAt(mentionAt(el.value, el.selectionStart ?? el.value.length)); setPick(0) }

  const choose = (m: Mentionable) => {
    const el = box.current
    if (!el || !at) return
    const caret = el.selectionStart ?? value.length
    caretTo.current = at.start + m.id.length + 2
    setValue(`${value.slice(0, at.start)}@${m.id} ${value.slice(caret)}`)
    setAt(null)
    el.focus()
  }

  const insertMention = () => {
    const el = box.current
    if (!el || busy || disabled) return
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    const prefix = start > 0 && !/\s/.test(value[start - 1]) ? ' @' : '@'
    const next = `${value.slice(0, start)}${prefix}${value.slice(end)}`
    caretTo.current = start + prefix.length
    setValue(next)
    setAt(mentionAt(next, caretTo.current)); setPick(0)
    el.focus()
  }

  const send = async () => {
    const body = value.trim()
    if (!body || sending.current || disabled) return
    sending.current = true
    setBusy(true); setError(null)
    try {
      await onSend(body)
      setValue(draft === undefined && initial ? body : '')
      setAt(null)
    } catch (cause) {
      setError(`Not sent. ${cause instanceof Error ? cause.message : 'Please try again.'} Your draft is still here.`)
    } finally { sending.current = false; setBusy(false); box.current?.focus({ preventScroll: true }) }
  }

  return (
    <div className={`mcomp${compact ? ' compact' : ''}`}>
      <div className="mcomp-box">
        <textarea ref={box} rows={1} value={value} placeholder={placeholder} aria-label={placeholder}
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${pick}` : undefined} aria-describedby={`${listId}-hint`}
          disabled={disabled} readOnly={busy}
          onChange={e => { setValue(e.target.value); track(e.target) }}
          onClick={e => track(e.currentTarget)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || busy) return
            if (open) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setPick(i => (i + 1) % matches.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setPick(i => (i - 1 + matches.length) % matches.length); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[pick]); return }
              if (e.key === 'Escape') { e.preventDefault(); setAt(null); return }
            }
            if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); return }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }} />
        {!!value.trim() && previewText === value && <div className="mcomp-link-previews"><MessageLinkPreviews text={previewText} /></div>}
        <div className="mcomp-acts">
          <button type="button" className="mcomp-mention" aria-label="Mention a person or agent" title="Mention a person or agent"
            disabled={busy || disabled} onMouseDown={e => e.preventDefault()} onClick={insertMention}>@</button>
          <span id={`${listId}-hint`} className={compact ? 'dash-sr-only' : 'mcomp-hint'}>
            <span>Paste a workspace link for a preview</span><span>Enter to send · Shift+Enter for a new line</span>
          </span>
          {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
          <button type="button" className="btn primary mcomp-send" disabled={!value.trim() || busy || disabled}
            onClick={send}>{busy ? 'Sending…' : sendLabel}</button>
        </div>
      </div>
      {error && <p className="mcomp-error" role="alert">{error}</p>}
      {open && (
        <ul className="mcomp-pick" id={listId} role="listbox" aria-label="Mention someone">
          {matches.map((m, i) => (
            <li key={m.id} id={`${listId}-${i}`} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''}
              onMouseDown={e => { e.preventDefault(); choose(m) }} onMouseEnter={() => setPick(i)}>
              <Face who={m} size={20} />
              <span className="mcomp-name">{m.name}</span>
              <span className="mcomp-id">@{m.id}</span>
              {m.kind === 'agent' && <span className={`mcomp-kind${m.canAct ? '' : ' off'}`}>
                {m.canAct ? 'agent' : 'agent · no grant here'}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
