import type { DesignElement, DesignScreen, DesignTokens } from '../data/gateway'
import type { Path } from '../data/spec'
import { resolves } from './DesignCanvas'

export function citationIssues(screens: DesignScreen[], tokens: DesignTokens | undefined) {
  const issues: { screen: string; screenName: string; path: Path; element: DesignElement }[] = []
  for (const screen of screens) {
    const visit = (elements: DesignElement[], parent: Path = []) => elements.forEach((element, index) => {
      const path = [...parent, index]
      if (!resolves(element.cites, tokens)) issues.push({ screen: screen.id, screenName: screen.name, path, element })
      if (element.children) visit(element.children, path)
    })
    visit(screen.elements ?? [])
  }
  return issues
}

export function DesignChecks({ screens, tokens, ready, disabled, onSelect }: {
  screens: DesignScreen[]
  tokens?: DesignTokens
  ready: boolean
  disabled: boolean
  onSelect: (selection: { screen: string; path: Path }) => void
}) {
  const issues = ready ? citationIssues(screens, tokens) : []
  return <details className="ddesign-checks">
    <summary>Design checks <span>{!ready ? 'Checking…' : `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}</span></summary>
    <p>Checks token citations, not visual or accessibility compliance. Select an issue to locate the element.</p>
    {ready && !issues.length && <p>No unresolved or missing token citations.</p>}
    <ul>{issues.map(issue => <li key={`${issue.screen}:${issue.path.join('.')}`}>
      <button disabled={disabled} onClick={() => onSelect({ screen: issue.screen, path: issue.path })}
        aria-label={`Inspect ${issue.element.text || issue.element.id} on ${issue.screenName}`}>
        <strong>{issue.element.text || issue.element.id}</strong>
        <span>{issue.screenName} · {issue.element.cites ? `Unverified citation: ${issue.element.cites}` : 'Missing citation'}</span>
      </button>
    </li>)}</ul>
  </details>
}

/** Scroll only the canvas, not the whole page or inspector. IDs are data, not CSS selectors. */
export function revealCanvasElement(viewport: HTMLElement, selection: { screen: string; path: Path }) {
  const frame = [...viewport.querySelectorAll<HTMLElement>('.dscreen')]
    .find(node => node.dataset.screenId === selection.screen)
  const element = frame?.querySelector<HTMLElement>(`[data-path="${selection.path.join('.')}"]`)
  if (!element) return
  const box = element.getBoundingClientRect(), view = viewport.getBoundingClientRect()
  const margin = 24
  const outsideX = box.left < view.left + margin || box.right > view.right - margin
  const outsideY = box.top < view.top + margin || box.bottom > view.bottom - margin
  if (!outsideX && !outsideY) return
  const left = outsideX ? Math.max(0, viewport.scrollLeft + box.left - view.left - Math.max(margin, (view.width - box.width) / 2)) : viewport.scrollLeft
  const top = outsideY ? Math.max(0, viewport.scrollTop + box.top - view.top - Math.max(margin, (view.height - box.height) / 2)) : viewport.scrollTop
  viewport.scrollTo?.({ left, top, behavior: 'smooth' })
}
