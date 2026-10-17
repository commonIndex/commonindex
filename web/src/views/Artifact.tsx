import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { GatewayError, getArtifact, saveArtifact, type WireArtifact } from '../data/gateway'
import { HtmlFrame, HtmlFullscreen, HtmlPage, isPage } from '../components/HtmlFrame'
import { ShareButton } from '../components/ShareButton'
import { ArtifactEditor } from '../components/doc/EmbedBlock'
import { ago } from '../components/TaskCard'

const since = (at: string) => {
  const a = ago(Math.max(0, (Date.now() - Date.parse(at)) / 1000))
  return a === 'now' ? 'just now' : `${a} ago`
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** One artifact on its own page: where "Open" in a doc and on a shared page
 *  goes, where its access is managed, and where it is edited at full width. */
export function ArtifactDetail() {
  const { id = '' } = useParams()
  const [artifact, setArtifact] = useState<WireArtifact | null>(null)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getArtifact(id)
      .then(r => { if (alive) setArtifact(r.artifact) })
      .catch(e => { if (alive) { if (e instanceof GatewayError && e.code !== 'no_credentials') setMissing(true); else setErr(message(e)) } })
    return () => { alive = false }
  }, [id])

  if (missing) {
    return <div className="art-page"><p className="art-missing">This artifact isn’t shared with you, or no longer exists.</p></div>
  }
  if (!artifact) return <div className="art-page">{err ? <p className="share-err" role="alert">{err}</p> : <p>Loading…</p>}</div>

  async function save(v: { title: string; html: string; height: number }) {
    setBusy(true); setErr(null)
    try {
      await saveArtifact(artifact!.id, v)
      setArtifact({ ...artifact!, ...v })
      setEditing(false)
    } catch (e) {
      setErr(e instanceof GatewayError && e.code === 'not_allowed'
        ? 'You can view this artifact but not edit it — ask its owner to share it with you to edit.' : message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="art-page">
      <header className="art-head">
        <div>
          <Link to="/docs" className="channel-back">← Docs</Link>
          <h1>{artifact.title}</h1>
          <span className="art-meta">{artifact.key ?? artifact.id}{artifact.updated_at && ` · updated ${since(artifact.updated_at)}`}</span>
        </div>
        <div className="art-actions">
          <ShareButton id={artifact.id} title={artifact.title} />
          {!editing && <button type="button" className="btn" onClick={() => setFull(true)}>Full screen</button>}
          {!editing && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>}
        </div>
      </header>
      {err && <p className="share-err" role="alert">{err}</p>}
      {editing
        ? <ArtifactEditor initial={{ title: artifact.title, html: artifact.html ?? '', height: artifact.height ?? 420 }}
            busy={busy} onSave={v => void save(v)} onCancel={() => { setEditing(false); setErr(null) }} />
        : isPage(artifact.html ?? '')
          ? <HtmlPage html={artifact.html ?? ''} title={artifact.title} />
          : <div className="art-stage"><HtmlFrame html={artifact.html ?? ''} height={artifact.height ?? 420} title={artifact.title} fit /></div>}
      {full && <HtmlFullscreen html={artifact.html ?? ''} title={artifact.title} onClose={() => setFull(false)} />}
      <p className="art-hint">To put it in another doc: / → Artifact, then paste this page’s link under “Embed an existing
        one”. Sharing a doc doesn’t share this artifact — share it here.</p>
    </div>
  )
}
