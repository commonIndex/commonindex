import { Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion'
import { filterBlocks, type Block } from './blocks'

/** The React side of the slash menu. The editor's extensions are built once,
 *  so they hold this object and the component swaps its methods in — the menu
 *  is ordinary React state rather than a second renderer mounted by hand. */
export interface SlashBridge {
  open: (p: SuggestionProps<Block, Block>) => void
  update: (p: SuggestionProps<Block, Block>) => void
  keydown: (p: SuggestionKeyDownProps) => boolean
  close: () => void
}

export const Slash = Extension.create<{ bridge: SlashBridge | null }>({
  name: 'slash',
  addOptions() {
    return { bridge: null }
  },
  addProseMirrorPlugins() {
    const bridge = () => this.options.bridge
    return [Suggestion<Block, Block>({
      editor: this.editor,
      pluginKey: new PluginKey('slash'),
      char: '/',
      // Not inside code: a path like /usr/bin is not a request for a block.
      allow: ({ editor }) => !editor.isActive('codeBlock') && !editor.isActive('code'),
      items: ({ query }) => filterBlocks(query),
      command: ({ editor, range, props }) => {
        editor.chain().focus().deleteRange(range).run()
        props.run(editor)
      },
      render: () => ({
        onStart: p => bridge()?.open(p),
        onUpdate: p => bridge()?.update(p),
        onKeyDown: p => bridge()?.keydown(p) ?? false,
        onExit: () => bridge()?.close(),
      }),
    })]
  },
})

/** Typing `@ai` opens the AI prompt at the cursor. The three characters are removed, so the doc never holds the
 *  trigger — and Backspace straight after puts them back, because an input rule
 *  is undoable that way, which is the escape hatch for somebody who really did
 *  mean to type "@ai". */
export const AiTrigger = Extension.create<{ onTrigger: () => void }>({
  name: 'aiTrigger',
  addOptions() {
    return { onTrigger: () => {} }
  },
  addInputRules() {
    const fire = () => this.options.onTrigger()
    return [new InputRule({
      // At the start of a line or after whitespace, so an email address
      // like maya@example.test does not open anything.
      find: /(?<=^|\s)@ai$/i,
      handler: ({ state, range }) => {
        state.tr.delete(range.from, range.to)
        // After this transaction lands, not inside it: the prompt moves focus,
        // and moving focus mid-dispatch leaves the editor half-updated.
        queueMicrotask(fire)
      },
    })]
  },
})
