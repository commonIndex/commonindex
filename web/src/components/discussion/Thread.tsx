import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  deleteMessage, editMessage, listThread, markRead, postMessage, threadCounts,
  type SubjectDeclaration, type WireMessage, type WireTaskActor, type WireThread,
} from '../../data/gateway'
import { CHANGED, isLive, LIVE } from '../../data/live'
import { useToast } from '../Shell'
import { ago, Face } from '../TaskCard'
import { MENTION } from './mentions'
import { MentionComposer } from './MentionComposer'
import { notificationsChanged, onCommentsAsk, takeCommentsAsk } from './signals'
import { MakeTaskDialog } from '../TaskLinks'
import { LinkPreviewProvider, MessageLinkPreviews } from './LinkPreviews'
import { messageLinks } from './messageLinks'

const since = (at: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000)
  return s < 60 ? 'just now' : `${ago(s)} ago`
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const names = (who: WireTaskActor[]) => who.map(w => w.name).join(', ')

/** Replies shown under a message; earlier ones fold behind Show more. The
 *  latest are the ones kept, so what was said last — an agent's answer, your
 *  own reply — is never the one hidden. */
const REPLIES_SHOWN = 5

/** A message's text, with each mention it resolved shown as the person or
 *  agent it names. An `@word` the gateway did not resolve stays plain text. */
export function MessageBody({ text, mentions }: { text: string; mentions: WireTaskActor[] }) {
  const byId = new Map(mentions.map(m => [m.id, m]))
  const parts: React.ReactNode[] = []
  const plain = (value: string, offset: number) => {
    let last = 0
    for (const m of value.matchAll(MENTION)) {
      const who = byId.get(m[1])
      if (!who) continue
      parts.push(value.slice(last, m.index), (
        <span key={`mention-${offset + m.index!}`} className={`mention${who.kind === 'agent' ? ' agent' : ''}`}
          title={who.kind === 'agent' ? `${who.name} · agent` : who.name}>@{who.name}</span>
      ))
      last = m.index! + m[0].length
    }
    parts.push(value.slice(last))
  }
  let cursor = 0
  for (const link of messageLinks(text)) {
    plain(text.slice(cursor, link.start), cursor)
    parts.push(<a key={`link-${link.start}`} href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>)
    cursor = link.end
  }
  plain(text.slice(cursor), cursor)
  return <><p className="tmsg-text">{parts}</p><MessageLinkPreviews text={text} /></>
}

function Row({ m, reply, channel, compact, editing, onEdit, onEditDone, onDelete, onMakeTask }: {
  m: WireMessage
  reply?: boolean
  channel?: boolean
  compact?: boolean
  editing: boolean
  onEdit: () => void
  onEditDone: (body: string | null) => Promise<void>
  onDelete: () => Promise<void>
  /** Turn what was said into work, where it was said. */
  onMakeTask?: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className={`trow${reply ? ' reply' : ''}${compact ? ' continuation' : ''}${m.author.kind === 'agent' ? ' by-agent' : ''}`} data-message={m.id}>
      {compact ? <time className="trow-gutter-time" dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()}>
        {new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
      </time> : <Face who={m.author} size={channel ? 32 : reply ? 22 : 26} />}
      <div className="trow-main">
        <div className="trow-head">
          <b>{m.author.name}</b>
          {m.author.kind === 'agent' && <span className="trow-tag">agent</span>}
          <time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()}>{channel
            ? new Date(m.created_at).toLocaleString(undefined, { ...(reply ? { month: 'short', day: 'numeric' } as const : {}),
              hour: 'numeric', minute: '2-digit' }) : since(m.created_at)}</time>
          {m.edited_at && !m.deleted && <span className="trow-edited" title={`edited ${new Date(m.edited_at).toLocaleString()}`}>edited</span>}
          {!m.deleted && !editing && (m.you.may_edit || m.you.may_delete || onMakeTask) && (
            <span className="trow-acts">
              {onMakeTask && <button type="button" onClick={onMakeTask}>Make a task</button>}
              {m.you.may_edit && <button type="button" onClick={onEdit}>Edit</button>}
              {m.you.may_delete && <button type="button" onClick={() => setConfirm(true)}>Delete</button>}
            </span>
          )}
        </div>
        {m.deleted ? <p className="tmsg-gone">This message was deleted.</p>
          : editing ? (
            <MentionComposer compact autoFocus initial={m.body ?? ''} sendLabel="Save" placeholder="Edit message"
              onSend={body => onEditDone(body)} onCancel={() => onEditDone(null)} />
          ) : <MessageBody text={m.body ?? ''} mentions={m.mentions} />}
        {confirm && (
          <div className="trow-confirm">
            <span>Delete this message?</span>
            <button type="button" className="btn" onClick={async () => { await onDelete(); setConfirm(false) }}>Delete</button>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Keep it</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** A task made from a message: its first line as the title — mentions read as
 *  the names they are — and the message quoted, with who said it and where. */
export function taskPrefill(m: WireMessage, subject: { type: string; title: string }) {
  const named = new Map(m.mentions.map(x => [x.id, x.name]))
  const text = (m.body ?? '').replace(MENTION, (all, id) => (named.has(id) ? `@${named.get(id)}` : all)).trim()
  const first = text.split('\n')[0].replace(/^@\S+\s*/, '').trim()
  const title = first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first
  const where = subject.type === 'channel' ? `#${subject.title}` : `the comments on ${subject.title}`
  return { title, detail: `“${text}”\n— ${m.author.name}, in ${where}` }
}

/** A conversation about one thing — an object's comments, or a channel.
 *
 *  Messages come in threads one level deep: a message, and the replies to it.
 *  Mentioning an agent asks it, in its inbox, and the thread says so until the
 *  agent answers — the platform does not run agents, so "asked, waiting" is the
 *  honest state between the two. */
/** What changed, folded into what is on screen: a message by id replaced, a
 *  new one added, a deleted one kept only while replies hang from it. Kept in
 *  the order a thread is read. */
export function mergeThread(had: WireThread, changed: WireThread): WireThread {
  const byId = new Map(had.messages.map(m => [m.id, m]))
  for (const m of changed.messages) byId.set(m.id, m)
  const all = [...byId.values()]
  const anchors = new Set(all.filter(m => m.parent_id && !m.deleted).map(m => m.parent_id))
  const messages = all.filter(m => !m.deleted || anchors.has(m.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  return { ...had, messages, waiting: { ...had.waiting, ...changed.waiting }, now: changed.now ?? had.now }
}

export function Thread({ subjectId, about, variant = 'comments', embedded, placeholder, onCount, closed, active = true, kind }: {
  subjectId: string
  /** What the subject is, for one the gateway cannot look up — a skill. */
  about?: SubjectDeclaration
  variant?: 'comments' | 'channel'
  /** Inside another scrolling panel: no scroll box of its own. */
  embedded?: boolean
  placeholder?: string
  onCount?: (n: number) => void
  /** Why no one can post here now — an archived channel — said where the box would be. */
  closed?: string
  /** A hidden tab stays mounted to retain drafts, but must not mark messages read. */
  active?: boolean
  /** `update`: a task's Updates — dated notes, each its own entry, grouped by day. */
  kind?: 'update'
}) {
  const updates = kind === 'update'
  const activeRef = useRef(active)
  activeRef.current = active
  const wasActive = useRef(active)
  const [thread, setThread] = useState<WireThread | null>(null)
  /** The thread as last read, for the next read to ask what changed since. */
  const threadRef = useRef<WireThread | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [postingReplies, setPostingReplies] = useState<ReadonlySet<string>>(() => new Set())
  const replyTrigger = useRef<HTMLButtonElement | null>(null)
  const replyScroll = useRef<HTMLDivElement>(null)
  const replyNearBottom = useRef(true)
  const replyPanelId = useId()
  const [editing, setEditing] = useState<string | null>(null)
  const toast = useToast()
  const scroll = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const generation = useRef(0)
  const request = useRef(0)
  const previousTotal = useRef(0)
  const [newMessages, setNewMessages] = useState(false)
  const count = useRef(onCount)
  count.current = onCount
  // Held, not a dependency: a page passes a fresh object each render, and the
  // name only matters until the first comment records it.
  const declared = useRef(about)
  declared.current = about
  /** The newest message this reader has been shown, so a conversation is
   *  marked read when something new is on screen — not on every poll. */
  const seen = useRef<string | null>(null)
  /** The message a task is being made from, while its dialog is open. */
  const [taskFrom, setTaskFrom] = useState<WireMessage | null>(null)
  /** Messages whose replies are shown in full. */
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set())
  const acknowledge = useCallback((newest: string | null) => {
    if (!activeRef.current || !newest || newest === seen.current) return
    seen.current = newest
    markRead({ subject_id: subjectId }).then(notificationsChanged).catch(() => {})
  }, [subjectId])

  // A thread that answers in any other shape is an error to show, not a page
  // to crash: the comments sit inside panels that must keep working without them.
  // The first read is the newest page; every one after asks only for what
  // changed since the last answer and folds it in — a thread used to be read
  // whole on every poll, so a busy channel cost more the longer it ran.
  const load = useCallback(() => {
    if (!activeRef.current) return Promise.resolve()
    const gen = generation.current
    const req = ++request.current
    const had = threadRef.current
    const since = had?.now
    return listThread(subjectId, declared.current, kind, since ? { since } : {})
    .then(answer => {
      if (gen !== generation.current || req !== request.current) return
      if (!Array.isArray(answer?.messages)) throw new Error('the conversation could not be read')
      const t = since && had && answer.since ? mergeThread(had, answer) : answer
      threadRef.current = t
      setThread(t); setErr(null)
      count.current?.(t.messages.filter(m => !m.deleted).length)
      const newest = t.messages.at(-1)?.id ?? null
      if (embedded || nearBottom.current) acknowledge(newest)
    })
    .catch(e => { if (gen === generation.current && req === request.current) setErr(message(e)) })
  }, [subjectId, embedded, acknowledge])

  // Agents answer on their own clock, so the thread checks back quietly.
  useEffect(() => {
    setThread(null); setErr(null); setReplyTo(null); setReplyDrafts({}); setPostingReplies(new Set()); setEditing(null); setWhole(new Set())
    threadRef.current = null
    seen.current = null; nearBottom.current = true; previousTotal.current = 0; setNewMessages(false)
    load()
    // A change to this conversation is pushed; polling stays as the fallback,
    // and slows right down while pushes are arriving.
    const heard = (e: Event) => {
      if ((e as CustomEvent<{ subject_id?: string }>).detail?.subject_id === subjectId) load()
    }
    window.addEventListener(CHANGED, heard)
    let tick = 0
    const pace = () => {
      window.clearInterval(tick)
      tick = window.setInterval(() => { if (!document.hidden) load() }, isLive() ? 120_000 : 15_000)
    }
    pace()
    window.addEventListener(LIVE, pace)
    return () => {
      window.clearInterval(tick); window.removeEventListener(CHANGED, heard); window.removeEventListener(LIVE, pace)
      generation.current++
    }
  }, [load, subjectId])

  /** The page of conversations before the oldest one on screen. */
  const [earlier, setEarlier] = useState(false)
  const loadEarlier = useCallback(async () => {
    const had = threadRef.current
    const oldest = had?.messages.find(m => !m.parent_id)
    if (!had || !oldest) return
    setEarlier(true)
    try {
      const page = await listThread(subjectId, declared.current, kind, { before: oldest.id })
      const t = { ...mergeThread(had, page), now: had.now, more_before: page.more_before }
      threadRef.current = t
      nearBottom.current = false
      setThread(t)
    } catch (e) { setErr(message(e)) } finally { setEarlier(false) }
  }, [subjectId, kind])

  useEffect(() => {
    if (active && !wasActive.current) load()
    wasActive.current = active
  }, [active, load])

  const total = thread?.messages.length ?? 0
  useLayoutEffect(() => {
    if (!embedded && scroll.current) {
      if (nearBottom.current) { scroll.current.scrollTop = scroll.current.scrollHeight; setNewMessages(false) }
      else if (total > previousTotal.current) setNewMessages(true)
    }
    previousTotal.current = total
  }, [total, embedded])

  useLayoutEffect(() => {
    if (replyScroll.current && replyNearBottom.current) replyScroll.current.scrollTop = replyScroll.current.scrollHeight
  }, [replyTo, total])

  // Cards arrive after messages. Keep a reader at the end pinned as previews
  // and the composer grow, without pulling someone out of older history.
  useEffect(() => {
    if (embedded || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (scroll.current && nearBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight
      if (replyScroll.current && replyNearBottom.current) replyScroll.current.scrollTop = replyScroll.current.scrollHeight
    })
    if (scroll.current) observer.observe(scroll.current)
    const messages = scroll.current?.querySelector('.thread-messages')
    if (messages) observer.observe(messages)
    if (replyScroll.current) {
      observer.observe(replyScroll.current)
      for (const child of replyScroll.current.children) observer.observe(child)
    }
    return () => observer.disconnect()
  }, [embedded, replyTo, total])

  const closeReply = () => {
    setReplyTo(null)
    requestAnimationFrame(() => replyTrigger.current?.focus())
  }

  const post = async (body: string, parent?: string) => {
    const gen = generation.current
    if (parent) setPostingReplies(p => new Set(p).add(parent))
    try {
      const r = await postMessage(subjectId, body, parent, declared.current, kind)
      if (gen !== generation.current) return
      if (r.asked.length) toast(`Asked ${r.asked.join(', ')} — it answers here when it next reads its inbox`)
      for (const n of r.not_asked) toast(`${n.id} was mentioned but not asked: ${n.why}`)
      if (variant !== 'channel') setReplyTo(null)
      if (parent && variant === 'channel') replyNearBottom.current = true
      else nearBottom.current = true
      await load()
    } catch (e) { toast(message(e)); throw e }
    finally {
      if (parent && gen === generation.current) setPostingReplies(p => { const next = new Set(p); next.delete(parent); return next })
    }
  }

  const rows = thread?.messages ?? []
  const roots = rows.filter(m => !m.parent_id)
  const repliesTo = (id: string) => rows.filter(m => m.parent_id === id)
  const waiting = thread?.waiting ?? {}
  const selected = variant === 'channel' ? roots.find(m => m.id === replyTo) : undefined
  const selectedReplies = selected ? repliesTo(selected.id) : []

  const row = (m: WireMessage, reply = false, compact = false) => (
    <div key={m.id}>
      <Row m={m} reply={reply} channel={variant === 'channel'} compact={compact && editing !== m.id} editing={editing === m.id}
        onEdit={() => setEditing(m.id)}
        onEditDone={async body => {
          if (body === null) { setEditing(null); return }
          try { await editMessage(m.id, body); setEditing(null); await load() } catch (e) { toast(message(e)); throw e }
        }}
        onDelete={async () => {
          try { await deleteMessage(m.id); await load() } catch (e) { toast(message(e)) }
        }}
        onMakeTask={thread ? () => setTaskFrom(m) : undefined} />
      {(waiting[m.id]?.length ?? 0) > 0 && (
        <p className={`twait${reply ? ' reply' : ''}`}>
          <i />Asked {names(waiting[m.id])} — waiting for a reply. Agents answer here when they next read their inbox.
        </p>
      )}
    </div>
  )

  return (
    <LinkPreviewProvider key={subjectId} refreshKey={thread}>
    <div className={`thread thread-${variant}${embedded ? ' embedded' : ''}${selected ? ' has-open-thread' : ''}`}>
      <div className="thread-layout">
      <div className="thread-main">
      <div className="thread-scroll" ref={scroll} onScroll={e => {
        const el = e.currentTarget
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        if (nearBottom.current) { setNewMessages(false); acknowledge(thread?.messages.at(-1)?.id ?? null) }
      }}>
        <div className="thread-messages">
        {thread?.more_before && <button type="button" className="linkbtn thread-earlier" disabled={earlier}
          onClick={() => void loadEarlier()}>{earlier ? 'Loading earlier messages…' : 'Show earlier messages'}</button>}
        {err && !selected && <div className="thread-error" role="alert"><span>{thread ? 'Could not refresh messages.' : 'Could not load this conversation.'} {err}</span>
          <button className="tool" onClick={load}>Retry</button></div>}
        {err && !thread ? null
          : !thread ? <p className="thread-empty">Loading…</p>
          : roots.length === 0 ? (
            <div className="thread-empty">
              <b>{updates ? 'No updates yet.' : variant === 'channel' ? 'Nothing said here yet.' : 'No comments yet.'}</b>
              <span>{updates ? 'Post how the work is going — tag a person or an agent with @ to bring them in.'
                : 'Start the discussion — mention a person or an agent with @, and they will see it here.'}</span>
            </div>
          ) : roots.map((m, index) => {
            const replies = repliesTo(m.id)
            const folded = whole.has(m.id) ? 0 : Math.max(0, replies.length - REPLIES_SHOWN)
            const previous = roots[index - 1]
            const compact = variant === 'channel' && !!previous && !m.deleted && !previous.deleted
              && previous.author.id === m.author.id && previous.author.kind === m.author.kind
              && new Date(previous.created_at).toDateString() === new Date(m.created_at).toDateString()
              && Date.parse(m.created_at) - Date.parse(previous.created_at) <= 5 * 60_000
            return (
              <Fragment key={m.id}>
                {(variant === 'channel' || updates) && (index === 0 || new Date(m.created_at).toDateString() !== new Date(roots[index - 1].created_at).toDateString()) &&
                  <div className="thread-day"><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></div>}
              <article className={`tmsg${compact ? ' tmsg-continuation' : ''}${selected?.id === m.id ? ' thread-selected' : ''}`}>
                {row(m, false, compact)}
                {variant !== 'channel' && replies.length > 0 && (
                  <div className="treplies">
                    {folded > 0 && (
                      <button type="button" className="tmore" onClick={() => setWhole(w => new Set(w).add(m.id))}>
                        Show more{' '}<span>· {folded} earlier {folded === 1 ? 'reply' : 'replies'}</span>
                      </button>
                    )}
                    {replies.slice(folded).map(r => row(r, true))}
                  </div>
                )}
                {variant === 'channel' ? ((!m.deleted || replies.length > 0) && (
                  <button type="button" className={`channel-replies${replies.length ? ' has-replies' : ''}`}
                    aria-label={replies.length ? `View ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'} to ${m.author.name}` : 'Reply in thread'}
                    aria-expanded={selected?.id === m.id} aria-controls={selected?.id === m.id ? replyPanelId : undefined}
                    onClick={e => { replyTrigger.current = e.currentTarget; replyNearBottom.current = true; setReplyTo(m.id) }}>
                    {replies.length > 0 ? <>
                      <span className="channel-reply-faces" aria-hidden="true">{[...new Map(replies.map(r => [r.author.id, r.author])).values()].slice(0, 3)
                        .map(author => <Face key={author.id} who={author} size={20} />)}</span>
                      <b>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</b>
                      <span className="channel-reply-last">Last reply {since(replies.at(-1)!.created_at)}</span>
                    </> : <><span aria-hidden="true">↳</span> Reply in thread</>}
                    <span className="channel-reply-arrow" aria-hidden="true">→</span>
                  </button>
                )) : replyTo === m.id ? (
                  <div className="treply-box">
                    <MentionComposer compact autoFocus placeholder={`Reply to ${m.author.name}`}
                      onSend={body => post(body, m.id)} onCancel={() => setReplyTo(null)} />
                  </div>
                ) : !m.deleted && !updates && (
                  <button type="button" className="treply" onClick={() => setReplyTo(m.id)}>
                    {/* spaces outside the span, so it is read as "Reply · 1 reply" */}
                    Reply{replies.length > 0 && <>{' '}<span>· {replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span></>}
                  </button>
                )}
              </article>
              </Fragment>
            )
          })}
        </div>
      </div>
      {newMessages && <div className="thread-jump" role="status"><button className="tool" onClick={() => {
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
        nearBottom.current = true; setNewMessages(false)
        acknowledge(thread?.messages.at(-1)?.id ?? null)
      }}>New messages · Jump to latest ↓</button></div>}
      <div className="thread-compose">
        {closed ? <p className="thread-closed" role="status">{closed}</p> : <MentionComposer key={subjectId} disabled={!thread}
          placeholder={placeholder ?? (variant === 'channel' ? 'Message the channel'
            : 'Add a comment — @ to mention a person or an agent')}
          onSend={body => post(body)} />}
      </div>
      </div>
      {selected && (
        <aside className="channel-thread-panel" id={replyPanelId} aria-label={`Thread with ${selected.author.name}`}
          onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) { e.preventDefault(); closeReply() } }}>
          <header className="channel-thread-head">
            <div><h2>Thread <span className="channel-thread-count">{selectedReplies.length}</span></h2><span>Replies stay with this conversation</span></div>
            <button type="button" className="channel-thread-close" aria-label="Close thread" onClick={closeReply}>×</button>
          </header>
          <div className="channel-thread-scroll" ref={replyScroll} onScroll={e => {
            const el = e.currentTarget
            replyNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}>
            {err && <div className="thread-error" role="alert"><span>Could not refresh messages. {err}</span>
              <button className="tool" onClick={load}>Retry</button></div>}
            <div className="channel-thread-context">
              <Face who={selected.author} size={28} />
              <div><b>{selected.author.name}</b>
                <time dateTime={selected.created_at}>{new Date(selected.created_at).toLocaleString(undefined,
                  { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                {selected.deleted ? <p className="tmsg-gone">This message was deleted.</p>
                  : <MessageBody text={selected.body ?? ''} mentions={selected.mentions} />}
              </div>
            </div>
            <div className="channel-thread-divider">{selectedReplies.length} {selectedReplies.length === 1 ? 'reply' : 'replies'}</div>
            {selectedReplies.map(r => row(r, true))}
            {!selectedReplies.length && <p className="thread-empty">No replies yet. Keep the follow-up here so the channel stays easy to scan.</p>}
            {(waiting[selected.id]?.length ?? 0) > 0 && <p className="twait"><i />Waiting for {names(waiting[selected.id])} to reply.</p>}
          </div>
          <div className="thread-compose">
            {selected.deleted ? <p className="thread-empty">This conversation is read-only because its original message was deleted.</p>
              : <MentionComposer key={selected.id} autoFocus compact disabled={postingReplies.has(selected.id)}
                placeholder={`Reply to ${selected.author.name}`} sendLabel={postingReplies.has(selected.id) ? 'Sending…' : 'Reply'}
                draft={replyDrafts[selected.id] ?? ''} onDraftChange={value => setReplyDrafts(d => ({ ...d, [selected.id]: value }))}
                onSend={body => post(body, selected.id)} />}
          </div>
        </aside>
      )}
      </div>
      {taskFrom && thread && (
        <MakeTaskDialog about={thread.subject} rel="caused" onClose={() => setTaskFrom(null)}
          prefill={taskPrefill(taskFrom, thread.subject)}
          onMade={async t => {
            // Said in the thread, so everyone in it sees the work exists.
            await postMessage(subjectId, `Made a task from this: ${t.key} — ${t.title}`,
              taskFrom.parent_id ?? taskFrom.id, declared.current).catch(() => {})
            await load()
          }} />
      )}
    </div>
    </LinkPreviewProvider>
  )
}

/** The Comments button an object's header carries, and the panel it opens.
 *  The count is read without loading the thread, so a header can show it. */
export function CommentsButton({ subjectId, title, about }: {
  subjectId: string; title: string; about?: SubjectDeclaration
}) {
  // A notification, or a link with #comments, lands on the thread — on arrival,
  // or here and now when it is about the page already open.
  const [open, setOpen] = useState(takeCommentsAsk)
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => onCommentsAsk(() => setOpen(true)), [])

  useEffect(() => {
    let alive = true
    threadCounts([subjectId]).then(r => { if (alive) setCount(r.counts[subjectId] ?? 0) }).catch(() => {})
    return () => { alive = false }
  }, [subjectId])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button type="button" className={`btn comments-btn${open ? ' on' : ''}`} aria-expanded={open}
        onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        Comments{count ? <>{' '}<span className="comments-n">{count}</span></> : null}
      </button>
      {open && createPortal(
        <aside className="cdrawer" role="dialog" aria-label={`Comments on ${title}`}>
          <div className="cdrawer-bar">
            <div><b>Comments</b><span>on {title}</span></div>
            <button type="button" className="tp-x" aria-label="Close comments" onClick={() => setOpen(false)}>×</button>
          </div>
          <Thread key={subjectId} subjectId={subjectId} about={about} onCount={setCount} />
        </aside>,
        document.body)}
    </>
  )
}
