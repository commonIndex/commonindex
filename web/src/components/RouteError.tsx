import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom'

/** What a page shows when it fails to render, inside the app rather than in
 *  place of it: the sidebar stays, the message says what happened, and there
 *  is a way back. The stack is there for whoever needs it, folded. */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  return (
    <div className="detail route-error" role="alert">
      <h1 className="page-title">This page hit a problem</h1>
      <p className="page-sub">Something on it could not be drawn: <b>{message}</b>. Nothing was saved or lost —
        reloading usually gets past it, and the rest of the app still works.</p>
      <div className="tp-actions">
        <button className="btn primary" onClick={() => window.location.reload()}>Reload the page</button>
        <Link className="btn" to="/board">Go to the Board</Link>
      </div>
      {stack && (
        <details className="route-error-stack">
          <summary>Technical details</summary>
          <pre>{stack}</pre>
        </details>
      )}
    </div>
  )
}
