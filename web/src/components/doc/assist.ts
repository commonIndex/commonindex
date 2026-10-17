import type { Editor, JSONContent } from '@tiptap/core'

/** Where the cursor is, in the markdown the model reads. Must match
 *  `HERE` in commonindex/gateway/docs.py — the gateway explains it to the model and
 *  strips it from the answer. */
export const HERE = '⟦here⟧'

/** What an AI request is about, fixed at the moment it is sent. The editor can
 *  change while the model thinks; the answer still belongs to this range. */
export interface AssistTarget {
  scope: 'document' | 'selection'
  from: number
  to: number
  /** The whole doc as markdown, with HERE at the cursor when there is no
   *  selection. */
  markdown: string
  /** The selected passage as markdown, when there is one. */
  selection?: string
  /** The doc as it was, so an answer that arrives after somebody kept typing
   *  can be refused instead of overwriting what they typed. */
  before: JSONContent
  /** Where the cursor was, for an answer that turns out to be only the new
   *  part rather than the whole doc. */
  cursor: number
}

function toMarkdown(editor: Editor, json: JSONContent): string {
  return editor.markdown ? editor.markdown.serialize(json) : ''
}

export function assistTarget(editor: Editor): AssistTarget {
  const { state } = editor
  const { from, to, empty } = state.selection
  const before = state.doc.toJSON() as JSONContent
  if (!empty) {
    return {
      scope: 'selection', from, to, before, cursor: from,
      markdown: toMarkdown(editor, before),
      selection: toMarkdown(editor, state.doc.cut(from, to).toJSON() as JSONContent),
    }
  }
  // The marker goes into a copy of the doc — a transaction that is built and
  // never dispatched — so the author's doc never contains it.
  const marked = state.tr.insertText(HERE, from).doc.toJSON() as JSONContent
  return { scope: 'document', from: 0, to: state.doc.content.size, before, cursor: from,
           markdown: toMarkdown(editor, marked) }
}

/** A bare textblock with nothing but inline content: the shape of "one
 *  paragraph", which is what a rewrite of a sentence usually comes back as. */
function onlyParagraph(doc: JSONContent): JSONContent[] | null {
  const blocks = doc.content ?? []
  if (blocks.length === 1 && blocks[0].type === 'paragraph') return blocks[0].content ?? []
  return null
}

function textOf(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(textOf).join('\n')
}

/** The doc's lines that the answer still contains, as a fraction.
 *
 *  Asked for "the complete revised document", a small model often returns
 *  only what it added: told to draw a flow in a doc with a heading and a
 *  paragraph, qwen2.5-coder 1.5B answered with the diagram alone. Replacing
 *  the doc with that would delete the author's text. */
export function kept(before: JSONContent, answer: JSONContent): number {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()
  const lines = textOf(before).split('\n').map(norm).filter(l => l.length > 3)
  // Too little to lose: rewriting a one-word note into a plan legitimately
  // drops the word, and ⌘Z brings back anything this short anyway.
  if (lines.join(' ').length < 40) return 1
  const after = norm(textOf(answer))
  return lines.filter(l => after.includes(l)).length / lines.length
}

export type Applied = false | 'replaced' | 'inserted' | 'selection'

/** Put the model's answer into the doc as ONE transaction, so a single ⌘Z
 *  takes it back out.
 *
 *  Refuses — returns false — when the doc changed while the model was
 *  thinking. The answer was written against the old text; applying it now would
 *  quietly revert whatever the author typed meanwhile.
 *
 *  A whole-doc answer that has dropped most of the doc is taken to be the new
 *  part only, and goes in at the cursor instead of over everything. */
export function applyAssist(editor: Editor, target: AssistTarget, markdown: string): Applied {
  if (!editor.markdown) return false
  const now = JSON.stringify(editor.state.doc.toJSON())
  if (now !== JSON.stringify(target.before)) return false

  const parsed = editor.markdown.parse(markdown)
  if (target.scope === 'selection') {
    const $from = editor.state.doc.resolve(target.from)
    const $to = editor.state.doc.resolve(target.to)
    const inline = onlyParagraph(parsed)
    // A sentence rewritten inside one paragraph goes back in as inline text.
    // Inserted as a paragraph it would split the one it came from in two.
    const content = inline && $from.sameParent($to) && $from.parent.isTextblock
      ? inline : parsed.content ?? []
    return editor.chain().focus()
      .insertContentAt({ from: target.from, to: target.to }, content)
      .run() && 'selection'
  }
  if (kept(target.before, parsed) < 0.5) {
    return editor.chain().focus().insertContentAt(target.cursor, parsed.content ?? []).run() && 'inserted'
  }
  return editor.chain().focus()
    .insertContentAt({ from: 0, to: editor.state.doc.content.size }, parsed.content ?? [])
    .run() && 'replaced'
}
