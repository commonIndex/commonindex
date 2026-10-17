/**
 * Changes pushed by the gateway: one stream per tab, announced to the page.
 *
 * The gateway says which conversation changed — never what was said — and only
 * to someone who may read it (commonindex/gateway/events.py). A thread that hears
 * its own id asks for just what changed; unread counts and notifications
 * refresh. Read with fetch rather than EventSource, so a signed-in browser's
 * cookie and a token sign-in both work.
 *
 * Without a stream — an old proxy, a gateway that does not push — nothing here
 * fires, and the pages go on polling, as often as they did before.
 */
import { GATEWAY, sessionToken } from './gateway'

/** Fired on window with `{ subject_id }` when a conversation changed. */
export const CHANGED = 'commonindex:changed'
/** Fired on window when the stream connects or drops. */
export const LIVE = 'commonindex:live'

let live = false
let started = false

export function isLive(): boolean { return live }

function setLive(next: boolean) {
  if (next === live) return
  live = next
  window.dispatchEvent(new Event(LIVE))
}

async function readStream(signal: AbortSignal) {
  const token = sessionToken()
  const r = await fetch(`${GATEWAY}/events`, {
    credentials: 'include', signal, cache: 'no-store',
    headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  if (!r.ok || !r.body) throw new Error(`events ${r.status}`)
  const reader = r.body.getReader()
  const decode = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('events ended')
    buffer += decode.decode(value, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      let event = 'message'; let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (event === 'ready') setLive(true)
      else if (event === 'message' && data) {
        try {
          const { subject_id } = JSON.parse(data) as { subject_id?: string }
          if (subject_id) window.dispatchEvent(new CustomEvent(CHANGED, { detail: { subject_id } }))
        } catch { /* a line that is not ours */ }
      }
    }
  }
}

/** Open the stream once for this tab and keep it open, reconnecting with a
 *  growing wait. Safe to call more than once. */
export function startLive() {
  if (started || typeof window === 'undefined' || typeof fetch === 'undefined') return
  started = true
  let wait = 1000
  const run = async () => {
    for (;;) {
      const controller = new AbortController()
      try {
        await readStream(controller.signal)
      } catch {
        setLive(false)
      }
      await new Promise(r => setTimeout(r, wait))
      wait = Math.min(wait * 2, 60_000)
      if (live) wait = 1000
    }
  }
  void run()
}

/** Keep something current: `load` runs when a conversation changes (gathered
 *  over a moment, so a burst is one read) and on a timer — `every` ms while
 *  nothing is pushed, `whileLive` ms while it is. Returns the cleanup. */
export function keepCurrent(load: () => void, every: number, whileLive = every * 4): () => void {
  let tick = 0
  let soon = 0
  const pace = () => {
    window.clearInterval(tick)
    tick = window.setInterval(() => { if (!document.hidden) load() }, isLive() ? whileLive : every)
  }
  const heard = () => { window.clearTimeout(soon); soon = window.setTimeout(load, 400) }
  pace()
  window.addEventListener(LIVE, pace)
  window.addEventListener(CHANGED, heard)
  return () => {
    window.clearInterval(tick); window.clearTimeout(soon)
    window.removeEventListener(LIVE, pace); window.removeEventListener(CHANGED, heard)
  }
}
