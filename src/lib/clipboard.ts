/**
 * Copies text to the clipboard. The async clipboard API only exists in secure contexts (HTTPS or localhost), so over
 * plain HTTP this falls back to `execCommand('copy')` on a hidden textarea. Throws if neither works.
 */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fall through to the legacy copy.
  }

  const textarea = Object.assign(document.createElement('textarea'), { value: text, readOnly: true })
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy failed')
  } finally {
    textarea.remove()
  }
}
