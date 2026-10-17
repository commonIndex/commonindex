import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { itemPreviews, type ItemPreview, type ItemReference } from '../../data/gateway'
import { NavIcon } from '../NavIcon'
import { previewLinks, referenceKey, type MessageLink } from './messageLinks'
import { DocumentBackdrop } from './DocumentBackdrop'

type Result = { item?: ItemPreview; error?: boolean }
type Listener = (value: Result) => void
const labels: Record<string, [string, string]> = {
  doc: ['Document', 'docs'], dashboard: ['Dashboard', 'dashboards'], experiment: ['Experiment', 'experiments'],
  design: ['Design', 'designs'], video: ['Video', 'videos'], task: ['Task', 'board'], channel: ['Channel', 'channel'],
  agent: ['Agent', 'agents'], skill: ['Skill', 'skills'], artifact: ['Artifact', 'code'], code_file: ['Code file', 'code'],
}

/** A cache lives only for this conversation. Multiple messages/draft/replies
 * subscribe to one batched read, and each conversation refresh rechecks ACLs.
 * Nothing is kept in localStorage or shared across sessions/workspaces. */
function previewStore() {
  const entries = new Map<string, { ref: ItemReference; value: Result; listeners: Set<Listener> }>()
  const pending = new Set<string>()
  const inflight = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  const notify = (key: string, value: Result) => {
    const entry = entries.get(key)
    if (entry) { entry.value = value; entry.listeners.forEach(fn => fn(value)) }
  }
  const queue = (key: string) => {
    pending.add(key)
    if (timer !== undefined) return
    timer = setTimeout(async () => {
      timer = undefined
      const keys = [...pending].filter(k => entries.get(k)?.listeners.size && inflight.get(k) !== generation)
      pending.clear()
      const gen = generation
      for (let i = 0; i < keys.length; i += 24) {
        if (gen !== generation) return
        const batch = keys.slice(i, i + 24)
        batch.forEach(k => inflight.set(k, gen))
        try {
          const out = await itemPreviews(batch.map(k => entries.get(k)!.ref))
          if (!Array.isArray(out?.items)) throw new Error('Invalid preview response')
          if (gen !== generation) return
          const found = new Map(out.items.map(item => [referenceKey(item), item]))
          batch.forEach(k => notify(k, { item: found.get(k) ?? { ...entries.get(k)!.ref, available: false } }))
        } catch {
          if (gen === generation) batch.forEach(k => notify(k, { error: true }))
        } finally {
          batch.forEach(k => { if (inflight.get(k) === gen) inflight.delete(k) })
        }
      }
    }, 0)
  }
  return {
    subscribe(ref: ItemReference, listener: Listener) {
      const key = referenceKey(ref)
      let entry = entries.get(key)
      if (!entry) { entry = { ref, value: {}, listeners: new Set() }; entries.set(key, entry) }
      entry.listeners.add(listener); listener(entry.value)
      if (!entry.value.item && !entry.value.error) queue(key)
      return () => { entry.listeners.delete(listener) }
    },
    retry(ref: ItemReference) { notify(referenceKey(ref), {}); queue(referenceKey(ref)) },
    refresh() {
      generation++
      entries.forEach((entry, key) => { if (entry.listeners.size) queue(key); else entries.delete(key) })
    },
    dispose() { generation++; if (timer !== undefined) clearTimeout(timer); timer = undefined; pending.clear() },
  }
}
const Previews = createContext<ReturnType<typeof previewStore> | null>(null)

export function LinkPreviewProvider({ children, refreshKey }: { children: ReactNode; refreshKey?: unknown }) {
  const [store] = useState(previewStore)
  useEffect(() => { store.refresh() }, [store, refreshKey])
  useEffect(() => {
    const refresh = () => store.refresh()
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh); store.dispose() }
  }, [store])
  return <Previews.Provider value={store}>{children}</Previews.Provider>
}

function PreviewCard({ link }: { link: MessageLink }) {
  const store = useContext(Previews)!
  const [result, setResult] = useState<Result>({})
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const host = useRef<HTMLDivElement>(null)
  const { type, id } = link.item!
  useEffect(() => {
    if (visible || !host.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '160px' })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    if (visible) return store.subscribe({ type, id }, setResult)
  }, [store, type, id, visible])
  const [label, icon] = labels[type] ?? ['Workspace item', 'docs']
  const item = result.item
  const ready = item?.available
  const document = ready && type === 'doc' ? item.document : undefined
  const hasDocument = !!document?.blocks.length
  return <div ref={host} className={`message-preview${ready ? '' : ' is-placeholder'}${hasDocument ? ' has-document' : ''}`}>
    {hasDocument && <DocumentBackdrop blocks={document!.blocks} />}
    <a className="message-preview-link" href={link.href} target="_blank" rel="noopener noreferrer"
      aria-label={ready ? `Open ${label.toLowerCase()}: ${item.title} (new tab)` : `Open shared ${label.toLowerCase()} link (new tab)`}>
      <span className={`message-preview-icon kind-${type}`}><NavIcon name={icon} /></span>
      <span className="message-preview-content">
        <span className="message-preview-meta"><span>{label}</span>{ready && item.key && <span>{item.key}</span>}
          {ready && item.status && <span className="message-preview-status">{item.status.replaceAll('-', ' ')}</span>}</span>
        <strong>{ready ? item.title : result.error ? 'Preview could not load' : item ? 'Preview unavailable' : 'Loading preview…'}</strong>
        <span className="message-preview-summary">{ready ? item.summary || (hasDocument ? 'Open document to explore the full content.'
          : document ? 'This document has no content yet.' : 'Open this item in your workspace.')
          : result.error ? 'The link still works. Try loading its preview again.'
            : item ? 'This item may be private, removed, or unavailable in this workspace.' : 'Workspace link'}</span>
        {ready && item.detail && <span className="message-preview-detail">{item.detail}</span>}
      </span>
      <span className="message-preview-arrow" aria-hidden="true">↗</span>
    </a>
    {result.error && <button type="button" className="message-preview-retry" onClick={() => store.retry({ type, id })}>Retry preview</button>}
  </div>
}

export function MessageLinkPreviews({ text }: { text: string }) {
  const store = useContext(Previews)
  const links = previewLinks(text)
  if (!links.length) return null
  const cards = <div className="message-previews" aria-label="Shared workspace links">
    {links.map(link => <PreviewCard key={referenceKey(link.item!)} link={link} />)}
  </div>
  return store ? cards : <LinkPreviewProvider>{cards}</LinkPreviewProvider>
}
