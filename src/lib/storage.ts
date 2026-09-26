const listeners = new Set<() => void>()

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function parseStored<T>(raw: string | null, fallback: T): T {
  try {
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export const readStored = <T>(key: string, fallback: T) => parseStored(readRaw(key), fallback)

export function writeStored<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable (private mode, quota): keep working in-memory only.
  }
  listeners.forEach((listener) => listener())
}

export function subscribeStorage(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

export const storageKeys = {
  actor: 'ultrakanban:actor',
  lastBoard: 'ultrakanban:last-board',
  mergeMethod: 'ultrakanban:merge-method',
  overviewRange: 'ultrakanban:overview-range',
  theme: 'ultrakanban:theme',
  view: (boardId: string) => `ultrakanban:view:${boardId}`,
}
