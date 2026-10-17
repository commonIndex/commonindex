import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** The head of every item's page, one shape for all of them: where it sits
 *  ("Dashboards / DASH-659"), its name with the things to do on the right,
 *  then one line saying where it stands. The experiment page set the pattern;
 *  a dashboard, a skill, an agent and a project each had their own — a back
 *  arrow here, a kicker above the title there, a key-value table under it. */
export function DetailHead({ back, keyId, title, actions, status, dot, lede, className = '' }: {
  back: { to: string; label: string }
  /** The item's key or handle, after the collection in the breadcrumb. */
  keyId?: ReactNode
  title: ReactNode
  actions?: ReactNode
  /** Facts for the status line, joined with dots; falsy entries are skipped. */
  status?: ReactNode[]
  /** The dot before the status line, coloured by state. */
  dot?: 'blue' | 'green' | 'red' | 'warn' | 'gray'
  lede?: ReactNode
  className?: string
}) {
  const facts = (status ?? []).filter(Boolean)
  return <>
    <div className="crumb xcrumb"><Link to={back.to}>{back.label}</Link>
      {keyId && <> / <span className="mono">{keyId}</span></>}</div>
    <header className={`xhead ${className}`.trim()}>
      <div className="xhead-row">
        <h1 className="xhead-title">{title}</h1>
        {actions && <div className="xhead-actions">{actions}</div>}
      </div>
      {facts.length > 0 && <div className="xhead-status">
        {dot && <span className={`xdot tone-${dot}`} aria-hidden="true" />}
        {facts.map((f, i) => <Fragment key={i}>{i > 0 && <span className="sep">·</span>}{f}</Fragment>)}
      </div>}
      {lede}
    </header>
  </>
}
