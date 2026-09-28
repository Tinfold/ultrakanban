/** Name of the tag that marks a ticket as blocked, whatever else it says (case-insensitive). */
export const BLOCKED_TAG = 'blocked'

const BLOCKER_PATTERN =
  /\b(?:blocked\s+(?:by|on)|depends\s+on|waiting\s+(?:on|for))\s*:?\s*((?:#\d+(?:\s*(?:,|and|&|or)\s*)?)+)/gi
const FENCE_PATTERN = /^\s*(```|~~~)/

/**
 * Numbers of the tickets a ticket description says it waits for: `blocked by #12`, `depends on #3 and #4`,
 * `waiting on #7`… (case-insensitive, outside fenced code blocks).
 */
export function parseBlockers(markdown: string): number[] {
  const numbers = new Set<number>()
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const marker = FENCE_PATTERN.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence) continue
    for (const match of line.matchAll(BLOCKER_PATTERN)) {
      for (const ref of match[1].matchAll(/#(\d+)/g)) numbers.add(Number(ref[1]))
    }
  }
  return [...numbers]
}

/**
 * Numbers of the tickets a ticket waits for (`blocked by #12`) that aren't finished yet: still on the board, not in
 * its done column and without a merged pull request. Tickets that don't exist on the board aren't counted.
 */
export function openBlockers(
  ticket: { number: number; description: string },
  tickets: { number: number; columnId: string; pullRequest: { state: string } | null }[],
  doneColumnId: string | undefined,
): number[] {
  const numbers = parseBlockers(ticket.description).filter((number) => number !== ticket.number)
  if (!numbers.length) return []
  return numbers.filter((number) => {
    const blocker = tickets.find((other) => other.number === number)
    return blocker && blocker.columnId !== doneColumnId && blocker.pullRequest?.state !== 'merged'
  })
}
