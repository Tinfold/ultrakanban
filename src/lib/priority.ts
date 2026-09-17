import { PRIORITIES, type Priority } from '@shared/domain'

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

/** Most important first, as shown in menus. */
export const PRIORITIES_DESC = [...PRIORITIES].reverse()

export const priorityRank = (priority: Priority) => PRIORITIES.indexOf(priority)
