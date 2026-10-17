import type { Editor } from '@tiptap/core'
import type { IconName } from './Icons'
import { DIAGRAM_STARTER } from './DiagramBlock'

/** One insertable block. The slash menu, the toolbar's + menu and the tests all
 *  read this list, so "what can I add to a doc" has one answer. */
export interface Block {
  id: string
  label: string
  icon: IconName
  /** Extra words the slash filter matches, so `/todo` finds the checklist. */
  keywords: string[]
  run: (editor: Editor) => void
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Today as a person writes it in a doc — "26 Sep 2026" — rather than as an
 *  ISO string nobody would type. A date block is text: it does not tick. */
export function today(now = new Date()): string {
  // Spelled out rather than `toLocaleDateString`, whose short month depends on
  // the ICU build — the same call gives "Sep" in one browser and "Sept" in
  // another.
  return `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`
}

export const BLOCKS: Block[] = [
  { id: 'artifact', label: 'Artifact', icon: 'artifact', keywords: ['html', 'embed', 'interactive', 'widget', 'app', 'chart'],
    // An empty embed: its view asks for the HTML and makes the artifact, so
    // nothing is created until somebody writes one.
    run: e => e.chain().focus().insertContent({ type: 'embed', attrs: { ref: null } }).run() },
  { id: 'bullet', label: 'Bulleted list', icon: 'list', keywords: ['ul', 'bullets', 'unordered'],
    run: e => e.chain().focus().toggleBulletList().run() },
  { id: 'check', label: 'Checklist', icon: 'checklist', keywords: ['todo', 'task', 'checkbox'],
    run: e => e.chain().focus().toggleTaskList().run() },
  { id: 'code', label: 'Code block', icon: 'code', keywords: ['pre', 'snippet', 'fence'],
    run: e => e.chain().focus().toggleCodeBlock().run() },
  { id: 'date', label: 'Date', icon: 'calendar', keywords: ['today', 'now'],
    run: e => e.chain().focus().insertContent(today()).run() },
  { id: 'diagram', label: 'Diagram', icon: 'diagram', keywords: ['flow', 'flowchart', 'mermaid', 'chart', 'graph'],
    run: e => e.chain().focus().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' },
                                                content: [{ type: 'text', text: DIAGRAM_STARTER }] }).run() },
  { id: 'divider', label: 'Divider', icon: 'divider', keywords: ['hr', 'rule', 'line', 'separator'],
    run: e => e.chain().focus().setHorizontalRule().run() },
  { id: 'dropdown', label: 'Dropdown', icon: 'dropdown', keywords: ['toggle', 'details', 'collapse'],
    run: e => e.chain().focus().setDetails().run() },
  { id: 'h1', label: 'Heading 1', icon: 'h1', keywords: ['title', 'h1'],
    run: e => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', icon: 'h2', keywords: ['subtitle', 'h2'],
    run: e => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', icon: 'h3', keywords: ['h3'],
    run: e => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'numbered', label: 'Numbered list', icon: 'numbered', keywords: ['ol', 'ordered'],
    run: e => e.chain().focus().toggleOrderedList().run() },
  { id: 'quote', label: 'Quote', icon: 'quote', keywords: ['blockquote', 'callout'],
    run: e => e.chain().focus().toggleBlockquote().run() },
  { id: 'table', label: 'Table', icon: 'table', keywords: ['grid', 'rows', 'columns'],
    run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'text', label: 'Text', icon: 'text', keywords: ['paragraph', 'plain'],
    run: e => e.chain().focus().setParagraph().run() },
]

/** What the slash menu shows for `/query`: label prefix first, then any word of
 *  the label, then keywords — so `/h` lands on the headings, not on "Checklist". */
export function filterBlocks(query: string, blocks: Block[] = BLOCKS): Block[] {
  const q = query.trim().toLowerCase()
  if (!q) return blocks
  const rank = (b: Block) => {
    const label = b.label.toLowerCase()
    if (label.startsWith(q)) return 0
    if (label.split(/\s+/).some(w => w.startsWith(q))) return 1
    if (b.keywords.some(k => k.startsWith(q))) return 2
    return -1
  }
  return blocks
    .map(b => [b, rank(b)] as const)
    .filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([b]) => b)
}
