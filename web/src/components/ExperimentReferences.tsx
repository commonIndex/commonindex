import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { experimentReferences, type WireReference } from '../data/gateway'

type Refs = Awaited<ReturnType<typeof experimentReferences>>

/** Where an object of this type is opened, when it has a page of its own. */
const ROUTES: Record<string, string> = {
  design: '/designs/', dashboard: '/dashboards/', doc: '/docs/', experiment: '/experiments/',
}

const when = (at: string) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

function Row({ r }: { r: WireReference }) {
  const route = ROUTES[r.type]
  const label = <>{r.key && <span className="mono">{r.key} </span>}{r.title}</>
  return <li>
    <span className="xref-type">{r.type}</span>
    {route ? <Link to={`${route}${encodeURIComponent(r.id)}`}>{label}</Link> : <span>{label}</span>}
    <span className="hint">{r.by} · {when(r.at)}</span>
  </li>
}

/** What points at this experiment: the decisions made on it, the readouts
 *  recorded for it, and whatever lists it as a source — a design drawn from its
 *  result. "What did we build on this?" used to mean searching for its id. */
export function ExperimentReferences({ id, refresh }: { id: string; refresh: number }) {
  const [refs, setRefs] = useState<Refs | null>(null)
  useEffect(() => {
    let alive = true
    experimentReferences(id).then(r => { if (alive) setRefs(r) }).catch(() => { if (alive) setRefs(null) })
    return () => { alive = false }
  }, [id, refresh])

  // A section of the page, so an answer of the wrong shape empties it rather
  // than taking the readout above it down.
  const cited = Array.isArray(refs?.cited_by) ? refs!.cited_by : []
  const decisions = Array.isArray(refs?.decisions) ? refs!.decisions : []
  const readouts = Array.isArray(refs?.readouts) ? refs!.readouts : []
  const total = cited.length + decisions.length + readouts.length
  if (total === 0) return null
  return <section className="xrefs" aria-label="Referenced by">
    <div className="ro-sub">Referenced by <span className="hint">{total}</span></div>
    {cited.length > 0 && <>
      <div className="xrefs-group">Built on it</div>
      <ul>{cited.map(r => <Row key={r.id} r={r} />)}</ul>
    </>}
    {decisions.length > 0 && <>
      <div className="xrefs-group">Decisions</div>
      <ul>{decisions.map(r => <Row key={r.id} r={r} />)}</ul>
    </>}
    {readouts.length > 0 && <div className="xrefs-group">
      {readouts.length} recorded readout{readouts.length === 1 ? '' : 's'}
      <span className="hint"> · latest {when(readouts[0].at)} by {readouts[0].by}</span>
    </div>}
  </section>
}
