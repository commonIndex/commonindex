/** Small signals between the conversation pieces, kept apart from both so the
 *  thread and the bell do not import each other. */

/** Anything that changes what is read says so, and the bell re-counts. */
export const NOTIFICATIONS_CHANGED = 'notifications:changed'
export const notificationsChanged = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

/** A request to open a page's comments — a link carrying `#comments`, or a
 *  notification. Held here rather than read from the URL when the button
 *  mounts, because pages rewrite their URL first (a dashboard adds its range)
 *  and take the hash with them. Captured when the app loads, for links. */
let commentsFor: string | null =
  typeof window !== 'undefined' && window.location.hash === '#comments' ? window.location.pathname : null

const COMMENTS_ASKED = 'comments:asked'

/** Ask the page at `path` to open its comments: the page if it is the one
 *  showing, or else when it mounts. */
export function openCommentsOn(path: string) {
  commentsFor = path
  window.dispatchEvent(new Event(COMMENTS_ASKED))
}

/** Whether this page was asked to open its comments; asking is used up. */
export function takeCommentsAsk(): boolean {
  if (typeof window === 'undefined') return false
  if (commentsFor && commentsFor === window.location.pathname) { commentsFor = null; return true }
  return window.location.hash === '#comments'
}

/** Hear an ask made while this page is already showing — a notification about
 *  the page you are on. Returns the unsubscribe, for an effect. */
export function onCommentsAsk(open: () => void): () => void {
  const hear = () => {
    if (commentsFor && commentsFor === window.location.pathname) { commentsFor = null; open() }
  }
  window.addEventListener(COMMENTS_ASKED, hear)
  return () => window.removeEventListener(COMMENTS_ASKED, hear)
}

/** Drop an ask nobody took. For tests, which share this module. */
export function forgetCommentsAsk() { commentsFor = null }
