import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  QuoteIcon,
  SquareCodeIcon,
  StrikethroughIcon,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ToolbarAction {
  icon: LucideIcon
  label: string
  shortcut?: string
  isActive: (editor: Editor) => boolean
  run: (editor: Editor) => void
}

const GROUPS: ToolbarAction[][] = [
  [
    {
      icon: Heading2Icon,
      label: 'Heading',
      isActive: (e) => e.isActive('heading'),
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      icon: BoldIcon,
      label: 'Bold',
      shortcut: '⌘B',
      isActive: (e) => e.isActive('bold'),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      icon: ItalicIcon,
      label: 'Italic',
      shortcut: '⌘I',
      isActive: (e) => e.isActive('italic'),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      icon: StrikethroughIcon,
      label: 'Strikethrough',
      isActive: (e) => e.isActive('strike'),
      run: (e) => e.chain().focus().toggleStrike().run(),
    },
    {
      icon: CodeIcon,
      label: 'Inline code',
      shortcut: '⌘E',
      isActive: (e) => e.isActive('code'),
      run: (e) => e.chain().focus().toggleCode().run(),
    },
  ],
  [
    {
      icon: ListIcon,
      label: 'Bullet list',
      isActive: (e) => e.isActive('bulletList'),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      icon: ListOrderedIcon,
      label: 'Numbered list',
      isActive: (e) => e.isActive('orderedList'),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      icon: ListChecksIcon,
      label: 'Checklist',
      isActive: (e) => e.isActive('taskList'),
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
  ],
  [
    {
      icon: QuoteIcon,
      label: 'Quote',
      isActive: (e) => e.isActive('blockquote'),
      run: (e) => e.chain().focus().toggleBlockquote().run(),
    },
    {
      icon: SquareCodeIcon,
      label: 'Code block',
      isActive: (e) => e.isActive('codeBlock'),
      run: (e) => e.chain().focus().toggleCodeBlock().run(),
    },
  ],
]

const ACTIONS = GROUPS.flat()

export function EditorToolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      Object.fromEntries(ACTIONS.map((action) => [action.label, action.isActive(current)])),
    equalityFn: (a, b) => !!b && ACTIONS.every(({ label }) => a[label] === b[label]),
  })

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b border-transparent px-1.5 py-1 text-muted-foreground group-focus-within/editor:border-border"
    >
      {GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} className="flex items-center gap-0.5">
          {groupIndex > 0 && <Separator orientation="vertical" className="mx-1 h-4!" />}
          {group.map((action) => (
            <ToolbarButton
              key={action.label}
              label={action.label}
              shortcut={action.shortcut}
              active={active[action.label]}
              onClick={() => action.run(editor)}
            >
              <action.icon />
            </ToolbarButton>
          ))}
          {groupIndex === 0 && <LinkButton editor={editor} />}
        </div>
      ))}
    </div>
  )
}

interface ToolbarButtonProps extends React.ComponentProps<typeof Button> {
  label: string
  shortcut?: string
  active: boolean
}

function ToolbarButton({ label, shortcut, active, className, ...props }: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          aria-pressed={active}
          className={cn(active && 'bg-muted text-foreground', className)}
          onMouseDown={(event) => event.preventDefault()}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-1.5 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const href = useEditorState({
    editor,
    selector: ({ editor: current }) => current.getAttributes('link').href as string | undefined,
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = String(new FormData(event.currentTarget).get('url') ?? '').trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (url) chain.setLink({ href: url }).run()
    else chain.unsetLink().run()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolbarButton label="Link" active={!!href}>
          <LinkIcon />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" onOpenAutoFocus={(event) => event.preventDefault()}>
        <form onSubmit={submit} className="flex gap-1.5">
          <Input name="url" autoFocus defaultValue={href} placeholder="https://…" className="h-7" />
          <Button type="submit" size="sm">
            {href ? 'Update' : 'Add'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
