import { useRef, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { CodeBlockCopyButton } from './CopyButton'

function CodeBlock({ node: _node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="group/code relative">
      <pre ref={ref} {...props} />
      <CodeBlockCopyButton getText={() => ref.current?.textContent?.replace(/\n$/, '') ?? ''} />
    </div>
  )
}

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: CodeBlock,
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-ticket', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
