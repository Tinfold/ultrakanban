const TASK_PATTERN = /^\s*[-*+]\s+\[( |x|X)\]\s/gm

/** Counts GitHub-style task list items (`- [ ]` / `- [x]`) in markdown. */
export function checklistProgress(markdown: string) {
  let total = 0
  let done = 0
  for (const [, mark] of markdown.matchAll(TASK_PATTERN)) {
    total++
    if (mark !== ' ') done++
  }
  return { done, total }
}
