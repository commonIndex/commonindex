import { useEffect, useState } from 'react'
import { listAgentsLive, listPeople } from '../../data/gateway'

/** Someone who can be @-mentioned: a person, or an agent. */
export interface Mentionable {
  id: string
  name: string
  kind: 'human' | 'agent'
  /** An agent with no grant in this space would be told about a thread it
   *  could do nothing about — so it is offered, but marked. */
  canAct: boolean
}

let loaded: Promise<Mentionable[]> | null = null

/** People and agents in the space, fetched once per page load. */
export function loadMentionables(): Promise<Mentionable[]> {
  loaded ??= Promise.all([
    listPeople().catch(() => ({ people: [] })),
    listAgentsLive().catch(() => ({ agents: [] })),
  ]).then(([p, a]) => [
    ...(p?.people ?? []).map(x => ({ id: x.id, name: x.display, kind: 'human' as const, canAct: true })),
    ...(a?.agents ?? []).map(x => ({ id: x.id, name: x.display, kind: 'agent' as const,
                                      canAct: (x.may ?? []).length > 0 })),
  ]).catch(() => {
    loaded = null   // try again next time rather than remembering a failure
    return []
  })
  return loaded
}

/** For tests, and after someone new is added. */
export function forgetMentionables() { loaded = null }

export function useMentionables(): Mentionable[] {
  const [all, setAll] = useState<Mentionable[]>([])
  useEffect(() => {
    let alive = true
    loadMentionables().then(m => { if (alive) setAll(m) })
    return () => { alive = false }
  }, [])
  return all
}

/** The `@handle` being typed at the caret, if any. */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const m = /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret))
  return m ? { query: m[2], start: caret - m[2].length - 1 } : null
}

export const MENTION = /@([A-Za-z0-9][\w.-]*)/g
