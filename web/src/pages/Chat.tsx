import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '../api.ts'
import { MessageMarkdown } from '../markdown.tsx'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  status: string
  siblingIndex: number
  siblingCount: number
  siblingIds: string[]
}

export function ChatPage() {
  const { conversationId = '', characterId } = useParams()
  const space = characterId ? 'companion' : 'workspace'
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('deepseek-flash')
  const [models, setModels] = useState<string[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [error, setError] = useState('')
  const [banner, setBanner] = useState('')
  const [attachmentId, setAttachmentId] = useState<string | null>(null)
  const [attachmentName, setAttachmentName] = useState('')

  async function load() {
    const data = await api<{ conversation: { title: string; model: string }; messages: ChatMessage[] }>(`/api/conversations/${conversationId}`)
    setTitle(data.conversation.title)
    setModel(data.conversation.model)
    setMessages(data.messages)
  }

  useEffect(() => {
    void load()
    void api<{ models: Array<{ id: string }> }>('/api/models').then((data) => setModels(data.models.map((item) => item.id)))
    void api<{ mode: string; configured: boolean; note: string }>('/api/gateway').then((data) => {
      setBanner(data.mode === 'fixture' ? '当前是本地协议夹具，回复不是 DeepSeek，也不能当作真实模型验收。' : data.configured ? '模型请求由服务端网关发出。页面不保存供应商 Key。' : '服务端还没有配置供应商 Key，发送会失败，不会伪造回复。')
    })
  }, [conversationId])

  async function send() {
    setError('')
    setStreaming('')
    setReasoning('')
    const response = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Companion-Request': '1' },
      body: JSON.stringify({ content: draft, model, thinking, attachmentIds: attachmentId ? [attachmentId] : [] }),
    })
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await response.json() as { error?: { message?: string } }
      setError(data.error?.message ?? '发送失败')
      return
    }
    setDraft('')
    setAttachmentId(null)
    await readStream(response)
  }

  async function readStream(response: Response) {
    const reader = response.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ''
    let acc = ''
    let thought = ''
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const event = /event: (\S+)/.exec(part)?.[1]
        const dataLine = part.split('\n').find((line) => line.startsWith('data:'))
        if (!event || !dataLine) continue
        const data = JSON.parse(dataLine.slice(5).trim()) as { content?: string; reasoning?: string; message?: string }
        if (event === 'delta') {
          acc += data.content ?? ''
          thought += data.reasoning ?? ''
          setStreaming(acc)
          setReasoning(thought)
        }
        if (event === 'error') setError(data.message ?? '模型调用失败')
      }
    }
    await load()
    setStreaming('')
    setReasoning('')
  }

  async function upload(file: File) {
    const body = new FormData()
    body.append('file', file)
    const response = await fetch(`/api/attachments?space=${space}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Companion-Request': '1' },
      body,
    })
    const data = await response.json() as { attachment?: { id: string; filename: string }; error?: { message?: string } }
    if (!response.ok || !data.attachment) {
      setError(data.error?.message ?? '上传失败')
      return
    }
    setAttachmentId(data.attachment.id)
    setAttachmentName(data.attachment.filename)
  }

  return (
    <main className="page page-wide">
      <div className="row">
        <h1>{title || '对话'}</h1>
        {characterId ? <Link to={`/companion/${characterId}`}>人格</Link> : <Link to="/workspace">工作区</Link>}
        {characterId ? <Link to={`/companion/${characterId}/memories`}>记忆</Link> : null}
      </div>
      {banner ? <p className="banner" data-testid="gateway-banner">{banner}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="chat-log" data-testid="chat-log">
        {messages.map((message) => (
          <article className={`bubble ${message.role}`} key={message.id} data-testid="message">
            <div className="row">
              <strong>{message.role === 'user' ? '你' : '回复'}</strong>
              {message.siblingCount > 1 ? (
                <span>
                  <button className="ghost" type="button" disabled={message.siblingIndex === 0} onClick={() => void api(`/api/conversations/${conversationId}/active`, { body: { messageId: message.siblingIds[message.siblingIndex - 1] } }).then(load)}>上一条分支</button>
                  {message.siblingIndex + 1}/{message.siblingCount}
                  <button className="ghost" type="button" disabled={message.siblingIndex === message.siblingCount - 1} onClick={() => void api(`/api/conversations/${conversationId}/active`, { body: { messageId: message.siblingIds[message.siblingIndex + 1] } }).then(load)}>下一条分支</button>
                </span>
              ) : null}
            </div>
            {message.reasoning ? <details><summary>深度思考</summary><MessageMarkdown id={`${message.id}-reason`} content={message.reasoning} /></details> : null}
            <MessageMarkdown id={message.id} content={message.content} />
            {message.role === 'user' ? <button className="ghost" type="button" onClick={async () => {
              const next = window.prompt('编辑这条消息', message.content)
              if (!next) return
              const response = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/edit`, {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Companion-Request': '1' }, body: JSON.stringify({ content: next, thinking }),
              })
              if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) await readStream(response)
            }}>编辑并分支</button> : null}
            {message.role === 'assistant' ? <button className="ghost" type="button" onClick={async () => {
              const response = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/regenerate`, {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Companion-Request': '1' }, body: JSON.stringify({ thinking }),
              })
              if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) await readStream(response)
            }}>重新生成</button> : null}
          </article>
        ))}
        {streaming || reasoning ? (
          <article className="bubble">
            {reasoning ? <details open><summary>深度思考</summary><p>{reasoning}</p></details> : null}
            <MessageMarkdown id="streaming" content={streaming || '…'} loading />
          </article>
        ) : null}
      </div>
      <div className="composer">
        <label>模型
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            {models.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={thinking} onChange={(event) => setThinking(event.target.checked)} />深度思考</label>
        <textarea data-testid="composer" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="写一条消息" />
        <div className="row">
          <label className="file-input">选择文件
            <input data-testid="attachment-file" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />
          </label>
          {attachmentName ? <span>{attachmentName}</span> : null}
          <button className="primary" type="button" data-testid="send" onClick={() => void send().catch((caught) => setError(caught instanceof ApiError ? caught.message : '发送失败'))}>发送</button>
        </div>
      </div>
    </main>
  )
}
