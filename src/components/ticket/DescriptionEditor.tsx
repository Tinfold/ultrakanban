import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, Extension, InputRule, useEditor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { CodeBlockWithCopy } from './code-block'
import { EditorToolbar } from './EditorToolbar'

/** Typing `[ ] ` or `[x] ` at the start of a bullet item (or paragraph) turns it into a checklist item. */
const ChecklistShortcut = Extension.create({
  name: 'checklistShortcut',
  addInputRules() {
    return [
      new InputRule({
        find: /^\[([ xX]?)\]\s$/,
        handler: ({ range, match, chain }) => {
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .updateAttributes('taskItem', { checked: match[1].toLowerCase() === 'x' })
            .run()
        },
      }),
    ]
  },
})

interface DescriptionEditorProps {
  /** Markdown. */
  value: string
  onChange: (markdown: string) => void
  onBlur?: () => void
  /** Called whenever the editor shows `value`, rather than unsaved edits. */
  onSync?: (markdown: string) => void
  /** Whether the editor's text has edits that aren't saved yet: changes to `value` don't replace them meanwhile. */
  hasUnsavedEdits?: () => boolean
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

/** WYSIWYG markdown editor: supports markdown shortcuts (`# `, `- [ ] `, `**bold**`, ```) and pasting markdown. */
export function DescriptionEditor({
  value,
  onChange,
  onBlur,
  onSync,
  hasUnsavedEdits,
  placeholder = 'Add a description…',
  autoFocus,
  className,
}: DescriptionEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
        codeBlock: false,
      }),
      CodeBlockWithCopy,
      TaskList,
      TaskItem.configure({ nested: true }),
      ChecklistShortcut,
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    content: value,
    contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'prose-ticket min-h-28 px-3 py-2.5 text-base outline-none md:text-sm' } },
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
    onBlur: () => onBlur?.(),
  })

  // Apply changes made elsewhere (other tabs, agents) unless the user is editing or has edits that aren't saved.
  const onSyncRef = useRef(onSync)
  const hasUnsavedEditsRef = useRef(hasUnsavedEdits)
  useEffect(() => {
    onSyncRef.current = onSync
    hasUnsavedEditsRef.current = hasUnsavedEdits
  })
  useEffect(() => {
    if (hasUnsavedEditsRef.current?.()) return
    if (editor.getMarkdown() !== value) {
      if (editor.isFocused) return
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
    }
    onSyncRef.current?.(value)
  }, [editor, value])

  return (
    <div
      className={cn(
        'group/editor rounded-lg border border-transparent transition-colors focus-within:border-border hover:border-border/70',
        className,
      )}
    >
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  )
}
