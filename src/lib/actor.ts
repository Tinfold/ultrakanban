import { readStored, storageKeys } from './storage'

export const DEFAULT_ACTOR = 'me'

/** Name used for "assign to me" and the activity log. */
export const readActor = () => readStored(storageKeys.actor, DEFAULT_ACTOR)
