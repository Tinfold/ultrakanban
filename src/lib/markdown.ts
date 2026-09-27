import { parseChecklist } from '@shared/checklist'

/** Counts GitHub-style task list items (`- [ ]` / `- [x]`) in markdown. */
export function checklistProgress(markdown: string) {
  const items = parseChecklist(markdown)
  return { done: items.filter((item) => item.checked).length, total: items.length }
}
