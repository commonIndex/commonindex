import { DetailHead } from '../components/DetailHead'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getSkill, listSkills, type SkillFilter } from '../data/api'
import { skillZip } from '../data/gateway'
import { useDebounced, usePagedList } from '../hooks'
import { VirtualList } from '../components/VirtualList'
import { Avatar, Oid, Pill, Stat } from '../components/ui'
import { CardSkeletons, GalleryOptions, GalleryResults, GalleryError, ViewToggle, type GalleryView } from '../components/Gallery'
import { SkillCard, skillTone, slugOf } from '../components/SkillCard'
import { useToast } from '../components/Shell'
import { AuthoredFlow } from '../components/AuthoredFlow'
import { CommentsButton } from '../components/discussion/Thread'
import { SkillFlow } from '../components/SkillFlow'
import type { Skill } from '../data/types'


export function SkillsView() {
  // One status for now: the generated skill. Status filters return with skills that have one.
  const filter: SkillFilter = 'all'
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [view, setView] = useState<GalleryView>('grid')
  const navigate = useNavigate()
  const reset = () => setQ('')

  const fetcher = useCallback(
    (cursor?: number) => listSkills({ cursor, filter, q: dq }),
    [filter, dq],
  )
  const { items, total, loading, error, loadMore, hasMore, retry } = usePagedList(`${filter}:${dq}`, fetcher)

  return (
    <div className="collection dashboard-collection workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Skills <span className="total">{loading ? 'Loading…' : error ? 'Unavailable' : `${total} in this view`}</span></h1>
          <p className="coll-sub">
            Discover reusable capabilities, review their permissions, and see which agents use them.
          </p>
          <details className="dash-help"><summary>What is a generated skill?</summary>
            <p>Generated skills are not installed at all: they are context, read from the registry by anything
              that asks, so they have no revision and nothing to grant.</p>
          </details>
        </div>
      </header>
      <div className="dash-collection-shell">
        <div className="coll-tools dash-gallery-tools">
          <input type="search" className="dash-search" aria-label="Search skills"
            placeholder="Search by name, scope or agent…" value={q} onChange={e => setQ(e.target.value)} />
          <ViewToggle view={view} onChange={setView} label="Skill" />
        </div>
        <GalleryResults loading={loading} error={error} count={items.length} total={total} label="skills"
          filtered={!!q || filter !== 'all'} onReset={reset} />
        {error && <GalleryError label="skills" retry={retry} />}
      </div>

      {loading ? <CardSkeletons /> : error && !items.length ? null : !items.length ? (
        <div className="dash-gallery-scroll"><div className="dash-collection-shell dash-gallery-empty">
          <h2>{q || filter !== 'all' ? 'No skills match' : 'No skills yet'}</h2>
          <p>{q || filter !== 'all' ? 'Try a different search, or clear the filters.'
            : 'Skills arrive from the registry, from agents proposing them, or written here.'}</p>
          {(q || filter !== 'all') && <button className="tool" onClick={reset}>Show all skills</button>}
        </div></div>
      ) : view === 'grid' ? (
        <div className="dash-gallery-scroll">
          <div className="dash-collection-shell dash-gallery-grid" role="list" aria-label="Skills">
            {items.map(s => <div role="listitem" key={s.id}><SkillCard skill={s} /></div>)}
          </div>
          {hasMore && !error && <div className="dash-gallery-more"><button className="tool" onClick={loadMore}>Load more skills</button></div>}
        </div>
      ) : (
        <VirtualList<Skill>
          items={items}
          rowHeight={62}
          loading={loading}
          error={error}
          hasMore={hasMore}
          onEndReached={loadMore}
          listClass="list-skill"
          columns={['', 'skill', '', 'installed on',
                    { label: 'accepted', className: 'r' },
                    { label: 'updated', className: 'r' }]}
          emptyText="No skills match this view."
          onRowClick={s => navigate(`/skills/${s.id}`)}
          byAgent={s => s.agentAuthor || s.status === 'proposed'}
          render={s => (
            <>
              <span className="cell"><Oid id={s.key} /></span>
              <span className="cell stack">
                <span className="title">
                  <span className="mono">{s.name}</span>
                  {slugOf(s.title) !== s.name && <span className="sub"> · {s.title}</span>}
                </span>
                <span className="prev">{s.summary}</span>
              </span>
              <span className="cell sig">
                {s.blocked && <Pill tone="warn">blocked</Pill>}
                {s.generated && <Pill tone="blue">generated</Pill>}
                {!s.generated && s.source !== 'workspace' && <Pill tone="gray">{s.source}</Pill>}
              </span>
              <span className="cell">
                {s.generated
                  ? <Stat tone="blue">any agent</Stat>
                  : s.status === 'installed'
                  ? <Stat tone="green">on {s.installedOn.join(', ') || '—'}</Stat>
                  : <Pill tone={skillTone(s.status)}>{s.status}</Pill>}
              </span>
              <span className="cell r num">{s.acceptance === null ? '—' : `${s.acceptance}%`}</span>
              <span className="cell r meta upd">{s.updated === 0 ? 'today' : `${s.updated}d ago`}</span>
            </>
          )}
        />
      )}
    </div>
  )
}

export function SkillDetail() {
  const { id } = useParams()
  const [skill, setSkill] = useState<Skill | null | undefined>(undefined)
  const [granted, setGranted] = useState(false)
  const toast = useToast()

  useEffect(() => { setGranted(false); getSkill(id ?? '').then(s => setSkill(s ?? null)) }, [id])

  if (skill === undefined) return <div className="detail"><div className="empty">Loading…</div></div>
  if (skill === null) return <div className="detail"><div className="empty">Skill not found. <Link to="/skills">Back to the collection.</Link></div></div>

  const live = skill.status === 'installed'
  return (
    <div className="detail">
      <DetailHead back={{ to: '/skills', label: 'Skills' }} keyId={skill.key}
        title={<span className="mono">{skill.name}</span>}
        dot={skill.blocked ? 'warn' : skill.generated || live ? 'blue' : 'gray'}
        status={[
          <span>{skill.generated ? 'Generated' : skill.status[0].toUpperCase() + skill.status.slice(1)}</span>,
          <span>{skill.source}</span>,
          skill.blocked && <span className="warn">blocked</span>,
        ]}
        actions={<>
          {skill.generated && <DownloadSkill name={skill.name} />}
          <CommentsButton subjectId={skill.id} title={skill.name}
            about={{ type: 'skill', title: skill.name, key: skill.key }} />
        </>}
        lede={<p className="xhead-lede">{skill.summary}</p>} />

      <dl className="kv">
        {/* A generated skill has no author to ask, no revision to diff and no
            model of its own — it is a read of the registry, and every agent
            reads the same one. Showing "rev 0" and a model claim would be
            filling those fields in rather than answering them. */}
        {skill.generated ? (
          <>
            <dt>Authored by</dt>
            <dd>nobody — derived from the registry on every read</dd>
            <dt>Version</dt>
            <dd>
              <span style={{ color: 'var(--muted)' }}>none.</span> No stored copy, so nothing
              to diff — and nothing to go out of date either.
            </dd>
          </>
        ) : (
          <>
            <dt>Author</dt><dd>{skill.author}{skill.agentAuthor && ' · agent'}</dd>
            <dt>Revision</dt><dd>rev {skill.rev} · updated {skill.updated === 0 ? 'today' : `${skill.updated}d ago`}</dd>
            <dt>Runs on</dt><dd><span className="mono">{skill.model}</span> · chosen from replayed history, not from the vendor’s benchmark</dd>
          </>
        )}
        <dt>Installed on</dt>
        <dd>
          {skill.generated
            ? <span style={{ color: 'var(--muted)' }}>every agent — it is context, not a capability</span>
            : skill.installedOn.length === 0
            ? <span style={{ color: 'var(--muted)' }}>no agent — nothing is running it</span>
            : (
              <span className="skill-agents">
                {skill.installedOn.map(a => (
                  <span className="skill-agent" key={a}><Avatar name={a} agent />{a}</span>
                ))}
              </span>
            )}
        </dd>
        <dt>Triggers</dt><dd>{skill.triggers.join(' · ')}</dd>
      </dl>

      {skill.blocked && (
        <div className="notice">
          <b>Blocked.</b> {skill.blocked}
        </div>
      )}

      <div className="section-label">Scopes <span className="hint">installing is a grant, not a toggle</span></div>
      <div className="card">
        <div className="irow" style={{ background: 'var(--panel2)', flexWrap: 'wrap' }}>
          <div className="body">
            {skill.scopes.length === 0
              ? <span style={{ color: 'var(--text2)' }}>None. It reads what it was handed and answers — the safest possible install.</span>
              : <span className="scopes">{skill.scopes.map(s => <code key={s}>{s}</code>)}</span>}
          </div>
          {!live && !granted && (
            <button
              className="btn action"
              onClick={() => {
                setGranted(true)
                toast(skill.scopes.length === 0
                  ? `${skill.name} installed — no scopes to grant, so nothing to ratify`
                  : `Grant filed: ${skill.scopes.join(', ')} for ${skill.name}. It lands in the approver's inbox like any access change.`)
              }}
            >
              {skill.scopes.length === 0 ? 'Install' : 'Request grant & install'}
            </button>
          )}
          {granted && <Pill tone="agent">grant filed</Pill>}
        </div>
        <div className="irow">
          <div className="body prose" style={{ color: 'var(--text2)', fontSize: 12 }}>
            {skill.generated
              ? <>These are reads, and this skill performs none of them — it describes
                 what is there. An agent acting on it uses its OWN grants, so a definition
                 named here is still only resolvable by someone already allowed to resolve
                 it. Naming a dataset is not access to it.</>
              : <>A skill can only ever use scopes its host agent already holds. Granting is a
                 decision with an owner and an expiry, recorded as an event — which is why a
                 community skill cannot quietly acquire write access by shipping a new
                 revision.</>}
          </div>
        </div>
      </div>

      <div className="section-label">Instructions <span className="hint">SKILL.md{skill.generated ? ' · generated' : ` · rev ${skill.rev}`}</span></div>
      <div className="card prose" style={{ padding: '14px 17px', color: 'var(--text2)', lineHeight: 1.7 }}>
        {skill.body.map((p, i) => <p key={i} style={{ marginBottom: i === skill.body.length - 1 ? 0 : 10 }}>{p}</p>)}
      </div>

      {/* A file list that cannot be opened is a manifest, not a skill. What an
          agent will read is the one thing a reviewer needs to see, and it was
          the one thing this page withheld. */}
      {/* Every SKILL.md is written for the agent that runs it, so a reviewer
          reads instructions addressed to somebody else. Both diagrams answer the
          question that leaves. */}
      {!skill.generated && (
        <>
          <div className="section-label">What it does
            <span className="hint">agents draft, people merge — this skill in that loop</span>
          </div>
          <div className="card" style={{ padding: '14px 17px 10px' }}>
            <div className="skillflow-wrap"><AuthoredFlow skill={skill} /></div>
          </div>
        </>
      )}

      {skill.generated && (
        <>
          {/* Everything else on this page is written for a model. This is for
              whoever has to decide whether to trust it. */}
          <div className="section-label">What it does
            <span className="hint">the files are written for an agent — this is the decision they encode</span>
          </div>
          <div className="card" style={{ padding: '14px 17px 10px' }}>
            <div className="skillflow-wrap">
              <SkillFlow datasets={skill.generated.from.datasets} />
            </div>
          </div>

          <div className="section-label">Where this comes from
            <span className="hint">nobody wrote it — it is a read of the registry</span>
          </div>
          <div className="card derive">
            <div className="derive-row">
              <div className="derive-cell">
                <b>{skill.generated.from.datasets}</b><span>{skill.generated.from.datasets === 1 ? 'dataset' : 'datasets'}</span>
                <i>tables and saved queries</i>
              </div>
              <span className="derive-arrow" aria-hidden="true">→</span>
              <div className="derive-cell">
                <b>{skill.generated.from.definitions}</b><span>{skill.generated.from.definitions === 1 ? 'definition' : 'definitions'}</span>
                <i>{skill.generated.unratified > 0
                  ? `${skill.generated.unratified} not ratified, and named as unusable`
                  : 'all ratified'}</i>
              </div>
              <span className="derive-arrow" aria-hidden="true">→</span>
              <Link className="derive-cell" to="/dashboards">
                <b>{skill.generated.from.dashboards}</b><span>{skill.generated.from.dashboards === 1 ? 'dashboard' : 'dashboards'}</span>
                <i>every panel is a worked example</i>
              </Link>
            </div>
            <p className="derive-note">
              The dashboards are the part worth understanding. Each panel cites a definition
              with a grain, a split and its filters — a question somebody asked, reviewed and
              kept. Those become the <b>“asked this way in practice”</b> examples below, so
              building a dashboard is how this skill gets better. There is no authoring step
              and no sync: change a definition and the next read of this page differs.
            </p>
          </div>
        </>
      )}

      <div className="section-label">Files
        <span className="hint">{skill.generated
          ? 'generated from the registry on every read — this is exactly what an agent receives'
          : 'what the agent is given when this skill fires'}</span>
      </div>
      <div className="card sk-files">
        {skill.files.map((f, i) => (
          <details key={f.path} open={i === 0 && !!f.body}>
            <summary>
              <span className="mono">{f.path}</span>
              <span className="meta">{f.lines} lines</span>
            </summary>
            {f.body
              ? <pre className="sk-body mono">{f.body}</pre>
              : <div className="sk-none">Contents are not stored in this prototype.</div>}
          </details>
        ))}
      </div>

      {!skill.generated && <>
      <div className="section-label">
        In production <span className="hint">{live ? 'measured on this workspace’s own history' : 'nothing to measure yet'}</span>
      </div>
      <div className="card">
        <div className="irow">
          <div className="agent-stats" style={{ marginTop: 0, flex: 1 }}>
            <div><span className="v">{live ? skill.runs7d.toLocaleString() : '—'}</span><span className="k">runs 7d</span></div>
            <div><span className="v">{skill.acceptance === null ? '—' : `${skill.acceptance}%`}</span><span className="k">accepted</span></div>
            <div><span className="v">{skill.p50}</span><span className="k">p50</span></div>
            <div><span className="v">{skill.cost}</span><span className="k">cost</span></div>
            <div><span className="v">{skill.tools.length}</span><span className="k">tools</span></div>
          </div>
        </div>
        {skill.acceptance !== null && (
          <div className="irow">
            <div className="body">
              <div className="meter" title={`${skill.acceptance}% of what it filed was accepted`}><i style={{ width: `${skill.acceptance}%` }} /></div>
              <div className="sub" style={{ marginTop: 6 }}>
                Acceptance is not a benchmark score — it is what your team did with the work this skill filed.
              </div>
            </div>
          </div>
        )}
        {skill.tools.length > 0 && (
          <div className="irow">
            <div className="body"><span className="scopes">{skill.tools.map(t => <code key={t}>{t}</code>)}</span></div>
          </div>
        )}
      </div>

      <div className="section-label">Why skills are objects <span className="hint">not prompts pasted into a config</span></div>
      <div className="card prose" style={{ padding: '13px 16px', color: 'var(--text2)', lineHeight: 1.65 }}>
        A skill has a revision, an author, and a diff, so improving one is a proposal somebody reviews and a regression
        is something you can roll back. Because the same event log records what it filed and what humans did with it,
        every skill accumulates its own evidence — that is where the acceptance number above comes from.
      </div>
      </>}
    </div>
  )
}

/** The skill folder as a .zip: unzip it where your agent reads skills from. */
function DownloadSkill({ name }: { name: string }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const url = URL.createObjectURL(await skillZip())
      const a = document.createElement('a')
      a.href = url; a.download = `${name}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      toast('The skill could not be downloaded. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return <button className="btn" disabled={busy} onClick={download}
    title="The files an agent receives, as a skill folder">{busy ? 'Preparing…' : 'Download skill'}</button>
}
