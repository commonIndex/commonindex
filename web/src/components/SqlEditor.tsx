/**
 * Writing a query.
 *
 * Two copies of this existed, both a bare `<textarea rows={5}>` — about a
 * hundred and thirty pixels, which is four lines of a query and a scrollbar.
 * A saved query joining two tables does not fit in it, and the thing you are
 * editing is the thing you cannot see.
 *
 * Not a code editor: no dependency, no syntax highlighting, no autocomplete.
 * What it has is the part that actually costs you time — room, line numbers,
 * and a parse error pointing at the line it is about rather than making you
 * re-read your own query to find the typo the parser already located.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

export interface SqlError {
  message: string
  /** Where the parser stopped, when it knows. */
  at?: { line: number; col: number; token?: string } | null
}

export function SqlEditor({
  value, onChange, onRun, running, error, label, placeholder, minRows = 9,
}: {
  value: string
  onChange: (v: string) => void
  /** ⌘↵ runs it, because the loop here is type-run-look and a mouse trip to a
   *  button in the middle of that is the friction. */
  onRun?: () => void
  running?: boolean
  error?: SqlError | null
  label: string
  placeholder?: string
  minRows?: number
}) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const [escaped, setEscaped] = useState(false)

  const lines = useMemo(() => value.split('\n').length, [value])
  const rows = Math.max(minRows, Math.min(lines + 1, 30))

  // The gutter does not scroll itself: it follows the textarea, which is the
  // only way the numbers stay next to their lines once the query is longer
  // than the box.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    const sync = () => { if (gutter.current) gutter.current.scrollTop = el.scrollTop }
    el.addEventListener('scroll', sync)
    return () => el.removeEventListener('scroll', sync)
  }, [])

  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onRun?.()
      return
    }
    // Escape first, then Tab, moves focus onward. Without an escape hatch a
    // textarea that swallows Tab is a keyboard trap — you can get into it and
    // not out — so the indent only applies while Tab has not been released to
    // navigation.
    if (e.key === 'Escape') { setEscaped(true); return }
    if (e.key !== 'Tab' || escaped || e.shiftKey) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: a, selectionEnd: b } = el
    onChange(`${value.slice(0, a)}  ${value.slice(b)}`)
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 2 })
  }

  return (
    <div className="sqlw">
      <div className="sqlw-head">
        <label className="eyebrow" htmlFor="sqled">{label}</label>
        <span className="sqlw-meta">
          {lines} {lines === 1 ? 'line' : 'lines'}
          {onRun && <> · <kbd>⌘↵</kbd> to run</>}
          {/* Said once, quietly, because a keyboard trap you cannot see your
              way out of is worse than a tip nobody needed. */}
          {' · '}<span className="sqlw-tip">Tab indents · Esc then Tab leaves</span>
        </span>
      </div>

      <div className={`sqlw-box${error ? ' has-error' : ''}`}>
        <div className="sqlw-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className={error?.at?.line === i + 1 ? 'on' : undefined}>
              {i < lines ? i + 1 : ''}
            </div>
          ))}
        </div>
        <textarea
          id="sqled" ref={ta} className="sqled mono" spellCheck={false}
          rows={rows} value={value} placeholder={placeholder}
          aria-label={label}
          aria-invalid={!!error}
          onChange={e => { onChange(e.target.value); setEscaped(false) }}
          onKeyDown={key}
        />
      </div>

      {error && (
        <div className="sqlw-err" role="alert">
          {error.at
            // The parser knows exactly where it stopped. Repeating "could not
            // parse that SQL" and leaving somebody to find it is throwing away
            // the one thing it was certain about.
            ? <>Line {error.at.line}, column {error.at.col}
              {error.at.token && <> — near <span className="mono">{error.at.token}</span></>}
              {': '}{error.message}</>
            : error.message}
        </div>
      )}
    </div>
  )
}
