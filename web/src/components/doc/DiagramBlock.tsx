import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import CodeBlock from '@tiptap/extension-code-block'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState,
         type NodeViewProps } from '@tiptap/react'
import { parseFlowchart, type MermaidFlow as Flow } from '../../data/mermaid'
import { MermaidFlow } from '../MermaidFlow'

/** The starting point a new diagram block gets — small enough to read at a
 *  glance and edit into the real thing. */
export const DIAGRAM_STARTER = 'flowchart LR\n  A[Start] --> B[Finish]'

/** The whole diagram, scaled to the window — for a flow too wide or too
 *  tall to read in the doc's column. Escape, the button or a click outside
 *  the sheet closes it. */
export function DiagramExpanded({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="diagram-expanded" role="dialog" aria-modal="true" aria-label={flow.title || 'Diagram'}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="diagram-expanded-sheet">
        <header>
          <span className="eyebrow">{flow.title || 'Diagram'}</span>
          <button type="button" className="btn" onClick={onClose} autoFocus>Close</button>
        </header>
        <div className="diagram-expanded-body"><MermaidFlow flow={flow} fit /></div>
      </div>
    </div>, document.body)
}

/** A code block whose language is `mermaid` is drawn as a diagram.
 *
 *  It stays a `codeBlock` node: the doc stores mermaid TEXT, the type's
 *  allow-list does not change, the markdown a model reads and writes is an
 *  ordinary ```mermaid fence, and the shared page draws the same text on the
 *  server. Nothing renders markup — `MermaidFlow` draws labels as SVG text,
 *  which is why this is the parser Code Query already uses rather than the
 *  mermaid library, whose renderer turns labels into HTML.
 *
 *  The source shows while the cursor is inside the block and the drawing
 *  otherwise, so typing never goes into something hidden. */
function CodeBlockView({ node, editor, getPos }: NodeViewProps) {
  const isDiagram = String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  const flow = useMemo(() => isDiagram ? parseFlowchart(node.textContent) : null,
                       [isDiagram, node.textContent])
  const inside = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const pos = typeof getPos === 'function' ? getPos() : undefined
      if (typeof pos !== 'number') return false
      const { from, to } = e.state.selection
      return from > pos && to < pos + node.nodeSize
    },
  })
  const drawn = isDiagram && flow && !inside
  const [expanded, setExpanded] = useState(false)

  function editSource() {
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (typeof pos === 'number') editor.chain().focus().setTextSelection(pos + node.nodeSize - 1).run()
  }

  return (
    <NodeViewWrapper className={`doc-code${isDiagram ? ' is-diagram' : ''}`}>
      {isDiagram && (
        <div className="doc-diagram-bar" contentEditable={false}>
          <span className="eyebrow">Diagram</span>
          {!flow && <span className="doc-diagram-warn">Not drawable yet — mermaid flowcharts only</span>}
          {drawn && <button type="button" className="doc-link" onClick={() => setExpanded(true)}>Expand</button>}
          {drawn && editor.isEditable && <button type="button" className="doc-link" onClick={editSource}>Edit source</button>}
          {inside && flow && <span className="doc-diagram-hint">Drawn when your cursor leaves</span>}
        </div>
      )}
      {drawn && (
        <div className="doc-diagram" contentEditable={false} onDoubleClick={editSource}>
          <MermaidFlow flow={flow} />
        </div>
      )}
      {expanded && flow && <DiagramExpanded flow={flow} onClose={() => setExpanded(false)} />}
      <pre hidden={!!drawn}><NodeViewContent<'code'> as="code" /></pre>
    </NodeViewWrapper>
  )
}

export const DiagramCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView)
  },
})
