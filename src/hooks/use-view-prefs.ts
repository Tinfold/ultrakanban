import { DEFAULT_VIEW, type ViewPrefs } from '@/lib/board-view'
import { storageKeys } from '@/lib/storage'
import { useStoredState } from './use-stored-state'

export const useViewPrefs = (boardId: string) => useStoredState<ViewPrefs>(storageKeys.view(boardId), DEFAULT_VIEW)
