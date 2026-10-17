import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page } from './data/types'

// Infinite cursor-paged list. Refetches from zero when `key` changes
// (filter or search), appends on loadMore. This is the pattern a real
// GraphQL cursor connection would use — the component code stays the same.
export function usePagedList<T>(
  key: string,
  fetcher: (cursor?: number) => Promise<Page<T>>,
) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  const cursorRef = useRef<number | null>(0)
  const inflight = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    const gen = ++generation.current
    cursorRef.current = 0
    inflight.current = true
    setLoading(true)
    setError(null)
    setItems([])
    fetcher(0).then(p => {
      if (generation.current !== gen) return
      setItems(p.items)
      setTotal(p.total)
      cursorRef.current = p.nextCursor
      inflight.current = false
      setLoading(false)
      setError(null)
    }).catch(e => {
      // There was no catch at all, so a rejected fetch left `loading` true
      // forever and `inflight` true with it — a spinner that never resolves,
      // on every collection in the product, with no message and no retry. The
      // flags are cleared even on failure for exactly that reason.
      if (generation.current !== gen) return
      inflight.current = false
      setLoading(false)
      setError(e instanceof Error ? e : new Error(String(e)))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++ }
  }, [key, attempt])

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current
    if (cursor === null || inflight.current) return
    const gen = generation.current
    inflight.current = true
    fetcher(cursor).then(p => {
      if (generation.current !== gen) return
      setItems(prev => [...prev, ...p.items])
      cursorRef.current = p.nextCursor
      inflight.current = false
      setError(null)
    }).catch(e => {
      // Same reason, and worse here: `inflight` staying true blocks every
      // later `loadMore`, so one failed page ends the list permanently while
      // the rows already fetched sit there looking complete.
      if (generation.current !== gen) return
      inflight.current = false
      setError(e instanceof Error ? e : new Error(String(e)))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const retry = useCallback(() => setAttempt(value => value + 1), [])
  return { items, total, loading, error, loadMore, retry,
           hasMore: cursorRef.current !== null }
}

export function useDebounced(value: string, ms = 200): string {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
