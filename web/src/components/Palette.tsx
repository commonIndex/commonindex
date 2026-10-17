import { useEffect, useRef, useState } from 'react'
import { search } from '../data/api'
import { askWorkspace, type WorkspaceAnswer } from '../data/gateway'
import { pageFor } from '../data/links'
import { useDebounced } from '../hooks'
import { Markdown } from './Markdown'
import { Glass } from './ui'
import type { SearchHit } from '../data/types'

/** Worded like a question: asking goes first, ahead of the matches. */
const QUESTION = /\?\s*$|^(who|what|when|where|why|how|which|is|are|does|do|did|can|should|has|have)\b/i

type Row = { kind: 'hit'; hit: SearchHit } | { kind: 'ask' }
type Asked = { q: string; answer?: WorkspaceAnswer; error?: string }

/** A snippet with its matched words highlighted: the gateway marks them «so». */
export function Marked({ text }: { text: string }) {
  const parts = text.split(/«([^»]*)»/g)
  return <>{parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

// ⌘K — the front door: at hundreds of objects nobody browses, everybody types.
// The same search.query an agent calls, over every collection, the agents and
// what was said; samples only while they are showing, and marked. And a
// question can be asked: the gateway's model searches, reads, searches again
// with the words it found, and answers with what it relied on.
export function Palette({ onClose, onGo }: { onClose: () => void; onGo: (href: string) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 120)
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; error: string | null } | null>(null)
  const [sel, setSel] = useState(0)
  const [asked, setAsked] = useState<Asked | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hits = found?.hits ?? []
  const typed = q.trim()
  const asks = typed.length >= 3
  const rows: Row[] = hits.map(hit => ({ kind: 'hit' as const, hit }))
  if (asks) {
    if (QUESTION.test(typed)) rows.unshift({ kind: 'ask' })
    else rows.push({ kind: 'ask' })
  }

  const ask = async () => {
    if (!asks) return
    setAsked({ q: typed })
    try {
      setAsked({ q: typed, answer: await askWorkspace(typed) })
    } catch (e) {
      setAsked({ q: typed, error: e instanceof Error ? e.message : String(e) })
    }
  }

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    let live = true
    search(dq)
      .then(h => { if (live) { setFound({ q: dq, hits: h, error: null }); setSel(0) } })
      .catch(e => { if (live) setFound({ q: dq, hits: [], error: e instanceof Error ? e.message : String(e) }) })
    return () => { live = false }
  }, [dq])

  const onKey = (e: React.KeyboardEvent) => {
    const row = rows[sel]
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask() }
    else if (e.key === 'Enter' && row) {
      e.preventDefault()
      if (row.kind === 'ask') ask()
      else onGo(row.hit.href)
    }
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="p-input">
          <Glass />
          <input
            ref={inputRef}
            value={q}
            aria-label="Search the workspace"
            placeholder="Search dashboards, docs, tasks, comments — or go to a screen"
            onChange={e => { setQ(e.target.value); setAsked(null) }}
            onKeyDown={onKey}
          />
        </div>
        {asked ? <Answer asked={asked} onGo={onGo} onBack={() => setAsked(null)} /> : (
        <div className="p-results" role="listbox" aria-label="Results">
          {rows.map((row, i) => row.kind === 'ask' ? (
            <div key="ask" role="option" aria-selected={i === sel} className={`p-item ask${i === sel ? ' sel' : ''}`}
              onMouseEnter={() => setSel(i)} onClick={ask}>
              <span className="tt">ask</span>
              <span className="grow">
                <span className="p-title">Ask the workspace: “{typed}”</span>
                <span className="p-snip">searches, reads what it finds, and answers with its sources</span>
              </span>
              <span className="sub">⌘⏎</span>
            </div>
          ) : (
            <div key={`${row.hit.href}-${i}`} role="option" aria-selected={i === sel}
              className={`p-item${i === sel ? ' sel' : ''}${row.hit.earlier ? ' earlier' : ''}`}
              onMouseEnter={() => setSel(i)} onClick={() => onGo(row.hit.href)}>
              <span className="tt">{row.hit.type}</span>
              <span className="grow">
                <span className="p-title">{row.hit.title}</span>
                {row.hit.snippet && <span className="p-snip"><Marked text={row.hit.snippet} /></span>}
              </span>
              <span className="sub">{row.hit.sub}</span>
            </div>
          ))}
          {found && !hits.length && (found.error
            ? <div className="empty" role="alert">Search could not reach the gateway: {found.error}</div>
            : <div className="empty">No matches for “{found.q}”. Search finds titles, keys like DASH-6, what docs
                say, what dashboards chart, readouts, tasks, code, definitions, agents' runs and comments.</div>)}
        </div>)}
        <div className="p-foot">
          <span><kbd>↑↓</kbd>move</span>
          <span><kbd>⏎</kbd>open</span>
          <span><kbd>⌘⏎</kbd>ask</span>
          <span><kbd>esc</kbd>close</span>
        </div>
      </div>
    </div>
  )
}

/** The answer to a question, what it rests on, and how it was found. */
function Answer({ asked, onGo, onBack }: { asked: Asked; onGo: (href: string) => void; onBack: () => void }) {
  const a = asked.answer
  return (
    <div className="p-answer" aria-live="polite">
      <div className="p-answer-q">{asked.q}</div>
      {!a && !asked.error && <p className="p-answer-wait" role="status">Searching the workspace and reading what it finds…</p>}
      {asked.error && <p className="p-answer-err" role="alert">{asked.error}</p>}
      {a && <>
        <Markdown source={a.answer || 'No answer came back.'} className="p-answer-text" />
        {a.citations.length > 0 && (
          <div className="p-sources" aria-label="Sources">
            <span>Sources</span>
            {a.citations.map(c => (
              <button key={c.id} type="button" onClick={() => onGo(pageFor(c))}>
                {c.key ?? c.type} {c.title}
              </button>
            ))}
          </div>
        )}
        {a.steps.length > 0 && (
          <p className="p-steps">
            {a.steps.map(s => (s.kind === 'search' ? `searched “${s.detail}” (${s.found})` : `read ${s.label ?? s.detail}`)).join(' · ')}
          </p>
        )}
      </>}
      <button type="button" className="linkbtn" onClick={onBack}>Back to results</button>
    </div>
  )
}
