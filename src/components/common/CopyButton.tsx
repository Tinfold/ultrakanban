import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Copies the text `getText` returns, showing a check mark for a moment after. */
export function CopyButton({
  getText,
  label = 'Copy',
  className,
}: {
  getText: () => string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(getText())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? 'Copied' : label}
      title={label}
      className={cn('bg-background/80 backdrop-blur-sm', className)}
      onClick={copy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

/** Puts a copy button in the top right corner of a code block, shown on hover and keyboard focus. */
export function CodeBlockCopyButton({ getText }: { getText: () => string }) {
  return (
    <CopyButton
      getText={getText}
      label="Copy code"
      className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    />
  )
}
