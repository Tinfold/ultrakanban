/** Opens the browser's file picker. Resolves with no files if the user cancels. */
export function pickFiles(accept: string, { multiple = false } = {}) {
  return new Promise<File[]>((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept, multiple })
    input.onchange = () => resolve([...(input.files ?? [])])
    input.oncancel = () => resolve([])
    input.click()
  })
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
