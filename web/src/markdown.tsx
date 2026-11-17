import { Markdown } from './vendor/deepseek-chat-demo/src/components/markdown/Markdown.tsx'

export function MessageMarkdown({ id, content, loading }: { id: string; content: string; loading?: boolean }) {
  if (!content) return null
  return <Markdown content={content} loading={Boolean(loading)} cacheKey={id} className="message-markdown" disableLink={false} />
}
