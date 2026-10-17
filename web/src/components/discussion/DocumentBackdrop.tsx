import { useEffect, useState } from 'react'
import { artifactSnapshot, type DocumentPreviewBlock } from '../../data/gateway'

/** Existing stills are permission-checked by artifacts.snapshot as well as
 * items.previews. Object URLs stay in memory and are released on change. */
function SavedPage({ id, version }: { id: string; version: string }) {
  const [source, setSource] = useState<{ key: string; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const key = `${id}:${version}`
  useEffect(() => {
    let url: string | undefined
    const controller = new AbortController()
    setFailed(false)
    artifactSnapshot(id, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      setSource({ key, url })
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [id, key])
  return source?.key === key ? <img className="message-doc-snapshot" src={source.url} alt=""
    onError={() => { setSource(null); setFailed(true) }} />
    : <p className="message-doc-notice">{failed ? 'Embedded preview unavailable' : 'Loading saved preview…'}</p>
}

function Block({ block }: { block: DocumentPreviewBlock }) {
  switch (block.kind) {
    case 'heading': return <h4>{block.text}</h4>
    case 'paragraph': return <p>{block.text}</p>
    case 'quote': return <blockquote>{block.text}</blockquote>
    case 'code': return <pre>{block.text}</pre>
    case 'list': return block.ordered
      ? <ol>{block.items.map((text, i) => <li key={i}>{text}</li>)}</ol>
      : <ul>{block.items.map((text, i) => <li key={i}>{text}</li>)}</ul>
    case 'table': return <table><tbody>{block.rows.map((row, i) => <tr key={i}>
      {row.map((text, j) => <td key={j}>{text}</td>)}</tr>)}</tbody></table>
    case 'divider': return <hr />
    case 'snapshot': return <SavedPage id={block.artifact_id} version={block.version} />
    case 'notice': return <p className="message-doc-notice">{block.text}</p>
    default: return null
  }
}

/** Decorative, non-interactive content behind the readable link details.
 * No editor, iframe, HTML injection, remote images or linked-item traversal. */
export function DocumentBackdrop({ blocks }: { blocks: DocumentPreviewBlock[] }) {
  const page = blocks.length === 1 && blocks[0].kind === 'snapshot'
  return <div className={`message-doc-backdrop${page ? ' is-page' : ''}`} aria-hidden="true">
    <div className="message-doc-paper">{blocks.map((block, i) => <Block key={i} block={block} />)}</div>
  </div>
}
