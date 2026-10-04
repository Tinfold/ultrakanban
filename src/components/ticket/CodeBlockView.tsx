import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { CodeBlockCopyButton } from '@/components/common/CopyButton'

export function CodeBlockView({ node }: ReactNodeViewProps) {
  const language = node.attrs.language as string | null
  return (
    <NodeViewWrapper className="group/code relative">
      <pre>
        <NodeViewContent<'code'> as="code" className={language ? `language-${language}` : undefined} />
      </pre>
      <div contentEditable={false}>
        <CodeBlockCopyButton getText={() => node.textContent} />
      </div>
    </NodeViewWrapper>
  )
}
