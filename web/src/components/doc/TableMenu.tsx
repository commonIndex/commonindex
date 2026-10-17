import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'

/** The table the cursor is in, as the element the menu sits on. */
function tableElement(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d -= 1) {
    if ($from.node(d).type.name === 'table') {
      const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null
      return dom?.querySelector?.('table') ?? (dom instanceof HTMLTableElement ? dom : dom ?? null)
    }
  }
  return null
}

function Btn({ label, title, onClick, on, danger }: {
  label: string; title?: string; onClick: () => void; on?: boolean; danger?: boolean
}) {
  return (
    <button type="button" className={`doc-tm-btn${on ? ' on' : ''}${danger ? ' danger' : ''}`} title={title ?? label}
      aria-pressed={on === undefined ? undefined : on}
      // Keep the cursor in its cell: the command acts on where it is.
      onMouseDown={e => e.preventDefault()} onClick={onClick}>{label}</button>
  )
}

/** Rows, columns and headers, on the table being edited — above it, where
 *  the eye already is, rather than in a toolbar scrolled out of view. Cells
 *  are edited by typing in them; Tab moves to the next and adds a row at the
 *  end. */
export function TableMenu({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      headerRow: e.isActive('tableHeader') && !!e.state.selection.$from.node(-2)?.firstChild
        && (() => { const row = e.state.selection.$from.node(-2); let all = true
          row?.forEach(c => { if (c.type.name !== 'tableHeader') all = false }); return all })(),
      headerCell: e.isActive('tableHeader'),
    }),
  })
  const run = (f: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => f(editor.chain().focus()).run()
  // The table being edited makes room above itself for this menu: floating
  // over the table's top edge it covered the line of text just above it.
  useEffect(() => {
    let marked: HTMLElement | null = null
    const mark = () => {
      // Focused, as the menu is: it hides when the editor loses focus, and so does its room.
      const el = editor.isEditable && editor.isFocused && editor.isActive('table') ? tableElement(editor) : null
      if (el === marked) return
      marked?.classList.remove('doc-table-editing')
      el?.classList.add('doc-table-editing')
      marked = el
      // The table moved down to make room; the menu is placed again against
      // where it is now, not where it was.
      if (el) requestAnimationFrame(() => { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('tableMenu', 'moved')) })
    }
    mark()
    editor.on('selectionUpdate', mark)
    editor.on('transaction', mark)
    editor.on('blur', mark)
    editor.on('focus', mark)
    return () => {
      editor.off('selectionUpdate', mark); editor.off('transaction', mark); editor.off('blur', mark); editor.off('focus', mark)
      marked?.classList.remove('doc-table-editing')
    }
  }, [editor])
  return (
    <BubbleMenu editor={editor} pluginKey="tableMenu" className="doc-table-menu"
      shouldShow={({ editor: e }) => e.isEditable && e.isActive('table')}
      getReferencedVirtualElement={() => {
        const el = tableElement(editor)
        return el ? { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects() } : null
      }}
      options={{ placement: 'top-start', offset: 8, flip: false }}>
      <div role="toolbar" aria-label="Table" className="doc-tm">
        <span className="doc-tm-group" aria-label="Rows">
          <span className="doc-tm-k">Row</span>
          <Btn label="↑ Above" title="Add a row above" onClick={() => run(c => c.addRowBefore())} />
          <Btn label="↓ Below" title="Add a row below" onClick={() => run(c => c.addRowAfter())} />
          <Btn label="Delete" title="Delete this row" danger onClick={() => run(c => c.deleteRow())} />
        </span>
        <span className="doc-tm-group" aria-label="Columns">
          <span className="doc-tm-k">Column</span>
          <Btn label="← Left" title="Add a column to the left" onClick={() => run(c => c.addColumnBefore())} />
          <Btn label="Right →" title="Add a column to the right" onClick={() => run(c => c.addColumnAfter())} />
          <Btn label="Delete" title="Delete this column" danger onClick={() => run(c => c.deleteColumn())} />
        </span>
        <span className="doc-tm-group" aria-label="Headers">
          <Btn label="Header row" title="Make the first row a header (or not)" on={s?.headerRow}
            onClick={() => run(c => c.toggleHeaderRow())} />
          <Btn label="Header column" title="Make the first column a header (or not)"
            onClick={() => run(c => c.toggleHeaderColumn())} />
        </span>
        <Btn label="Delete table" danger onClick={() => run(c => c.deleteTable())} />
      </div>
    </BubbleMenu>
  )
}
