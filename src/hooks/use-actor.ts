import { DEFAULT_ACTOR } from '@/lib/actor'
import { storageKeys } from '@/lib/storage'
import { useStoredState } from './use-stored-state'

export const useActor = () => useStoredState(storageKeys.actor, DEFAULT_ACTOR)
