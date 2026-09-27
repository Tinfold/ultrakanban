/** A GitHub-style task list item (`- [ ] text` / `- [x] text`) in a ticket description. */
export interface ChecklistItem {
  /** 0-based position among the description's checklist items. */
  index: number
  text: string
  checked: boolean
}

const TASK_PATTERN = /^(\s*[-*+]\s+\[)( |x|X)(\]\s.*)$/
const FENCE_PATTERN = /^\s*(```|~~~)/

/** Splits markdown into lines and finds the checklist items among them, skipping fenced code blocks. */
function scan(markdown: string) {
  const lines = markdown.split('\n')
  const items: (ChecklistItem & { line: number })[] = []
  let fence: string | null = null
  lines.forEach((text, line) => {
    const marker = FENCE_PATTERN.exec(text)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      return
    }
    const match = fence ? null : TASK_PATTERN.exec(text)
    if (match) items.push({ index: items.length, text: match[3].slice(2).trim(), checked: match[2] !== ' ', line })
  })
  return { lines, items }
}

export function parseChecklist(markdown: string): ChecklistItem[] {
  return scan(markdown).items.map(({ line: _line, ...item }) => item)
}

/** Returns the markdown with the checklist item at `index` checked or unchecked, or null if there is no such item. */
export function setChecklistItem(markdown: string, index: number, checked: boolean): string | null {
  const { lines, items } = scan(markdown)
  const item = items[index]
  if (!item) return null
  lines[item.line] = lines[item.line].replace(
    TASK_PATTERN,
    (_, start, _mark, end) => `${start}${checked ? 'x' : ' '}${end}`,
  )
  return lines.join('\n')
}
