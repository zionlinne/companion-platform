import { create } from 'zustand'
import { api } from '../../../../../api.ts'
import { getVisibleMessages } from './branches.js'
import { clearSentDraft, getDraft, prepareDraftMessage } from './drafts.js'
import { getChatHost } from './host.js'
import { useSettings } from '../settings.js'
import { useUploads } from '../attachments.js'
import type { AssistantMessage, Message, Session, UserMessage } from './types.js'

type ServerMessage = {
  id: string
  parentId: string | null
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  status: string
  createdAt: string
  siblingIds: string[]
}

type State = {
  session: Session
  streaming: Record<string, true>
  importingHistory: false
  error: string
}

const emptySession = (id: string): Session => ({
  id,
  title: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  rootMessageId: null,
  messages: [],
})

export const useChatStore = create<State>(() => ({
  session: emptySession(''),
  streaming: {},
  importingHistory: false,
  error: '',
}))

let currentAbort: AbortController | null = null

function stamp(value: string) {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function assistantFrom(row: ServerMessage, selectedChildId?: string): AssistantMessage {
  const status =
    row.status === 'streaming' ? 'streaming' : row.status === 'aborted' ? 'stopped' : row.status === 'error' ? 'error' : 'done'
  const blocks: AssistantMessage['blocks'] = []
  if (row.reasoning) blocks.push({ type: 'thinking', thinking: row.reasoning })
  if (row.content) blocks.push({ type: 'text', text: row.content })
  return {
    id: row.id,
    role: 'assistant',
    createdAt: stamp(row.createdAt),
    model: null,
    thinking: Boolean(row.reasoning),
    search: false,
    prefix: false,
    status,
    blocks,
    parentId: row.parentId,
    selectedChildId,
    error: status === 'error' ? { kind: 'http', message: '模型调用失败，没有伪造回复。' } : undefined,
  }
}

function userFrom(row: ServerMessage, selectedChildId?: string): UserMessage {
  return {
    id: row.id,
    role: 'user',
    content: row.content,
    files: [],
    createdAt: stamp(row.createdAt),
    parentId: row.parentId,
    selectedChildId,
  }
}

function stub(id: string, row: ServerMessage): Message {
  return row.role === 'user'
    ? { id, role: 'user', content: '', files: [], createdAt: stamp(row.createdAt), parentId: row.parentId }
    : {
        id,
        role: 'assistant',
        createdAt: stamp(row.createdAt),
        model: null,
        thinking: false,
        search: false,
        prefix: false,
        status: 'done',
        blocks: [],
        parentId: row.parentId,
      }
}

export function sessionFromServer(id: string, title: string, rows: ServerMessage[]): Session {
  const messages: Message[] = []
  rows.forEach((row, index) => {
    const nextId = rows[index + 1]?.id
    const ids = row.siblingIds.length > 0 ? row.siblingIds : [row.id]
    for (const siblingId of ids) {
      messages.push(siblingId === row.id ? (row.role === 'user' ? userFrom(row, nextId) : assistantFrom(row, nextId)) : stub(siblingId, row))
    }
  })
  return {
    id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rootMessageId: rows[0]?.id ?? null,
    messages,
  }
}

export function resetConversation(id: string) {
  if (useChatStore.getState().streaming[id]) return
  useChatStore.setState({ session: emptySession(id), error: '' })
}

export async function loadConversation(id: string) {
  if (useChatStore.getState().streaming[id]) return null
  const data = await api<{ conversation: { title: string; model: string }; messages: ServerMessage[] }>(`/api/conversations/${id}`)
  if (useChatStore.getState().streaming[id]) return null
  useChatStore.setState({ session: sessionFromServer(id, data.conversation.title, data.messages), error: '' })
  return { model: data.conversation.model, title: data.conversation.title }
}

function setStreaming(id: string, active: boolean) {
  const streaming = { ...useChatStore.getState().streaming }
  if (active) streaming[id] = true
  else delete streaming[id]
  useChatStore.setState({ streaming })
}

function appendOptimistic(session: Session, content: string, thinking: boolean) {
  const visible = getVisibleMessages(session)
  const parentId = visible.at(-1)?.id ?? null
  const userId = `local-user-${Date.now()}`
  const assistantId = `local-assistant-${Date.now()}`
  const user: UserMessage = {
    id: userId,
    role: 'user',
    content,
    files: [],
    createdAt: Date.now(),
    parentId,
    selectedChildId: assistantId,
  }
  const assistant: AssistantMessage = {
    id: assistantId,
    role: 'assistant',
    createdAt: Date.now(),
    model: null,
    thinking,
    search: false,
    prefix: false,
    status: 'streaming',
    blocks: [],
    parentId: userId,
  }
  const messages = session.messages.map((message) => (message.id === parentId ? { ...message, selectedChildId: userId } : message))
  return {
    assistantId,
    session: {
      ...session,
      rootMessageId: session.rootMessageId ?? userId,
      messages: [...messages, user, assistant],
    },
  }
}

function patchAssistant(assistantId: string, content: string, reasoning: string) {
  useChatStore.setState((state) => ({
    session: {
      ...state.session,
      messages: state.session.messages.map((message) => {
        if (message.id !== assistantId || message.role !== 'assistant') return message
        const blocks: AssistantMessage['blocks'] = []
        if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning })
        blocks.push({ type: 'text', text: content || '…' })
        return { ...message, status: 'streaming', blocks }
      }),
    },
  }))
}

async function readStream(response: Response, assistantId: string | null) {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
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
        content += data.content ?? ''
        reasoning += data.reasoning ?? ''
        if (assistantId) patchAssistant(assistantId, content, reasoning)
      }
      if (event === 'error') throw new Error(data.message ?? '模型调用失败')
    }
  }
}

async function runStream(sessionId: string, path: string, body: unknown, optimistic: string | null) {
  const controller = new AbortController()
  currentAbort = controller
  setStreaming(sessionId, true)
  let assistantId: string | null = null
  if (optimistic) {
    const next = appendOptimistic(useChatStore.getState().session, optimistic, useSettings.getState().thinking)
    assistantId = next.assistantId
    useChatStore.setState({ session: next.session, error: '' })
  }
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Companion-Request': '1' },
      body: JSON.stringify(body),
    })
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = (await response.json()) as { error?: { message?: string } }
      throw new Error(data.error?.message ?? '发送失败')
    }
    await readStream(response, assistantId)
  } catch (error) {
    if (!controller.signal.aborted) {
      useChatStore.setState({ error: error instanceof Error ? error.message : '发送失败' })
    }
  } finally {
    if (currentAbort === controller) currentAbort = null
    setStreaming(sessionId, false)
    await loadConversation(sessionId).catch((error: unknown) => {
      useChatStore.setState({ error: error instanceof Error ? error.message : '对话没有读出来' })
    })
  }
}

export function sendMessage(sessionId: string | null) {
  if (!sessionId || useChatStore.getState().streaming[sessionId]) return false
  const host = getChatHost()
  const prepared = prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
  if (!host || !prepared) return false
  clearSentDraft(sessionId)
  void runStream(
    sessionId,
    `/api/conversations/${sessionId}/messages`,
    {
      content: prepared.text,
      model: host.getModel(),
      thinking: useSettings.getState().thinking,
      attachmentIds: prepared.attachmentIds,
    },
    prepared.text
  )
  return true
}

export function stopReply(sessionId: string) {
  if (useChatStore.getState().streaming[sessionId]) currentAbort?.abort()
}

export function selectMessageVersion(sessionId: string, messageId: string) {
  if (useChatStore.getState().streaming[sessionId]) return
  void api(`/api/conversations/${sessionId}/active`, { body: { messageId } })
    .then(() => loadConversation(sessionId))
    .catch((error: unknown) => {
      useChatStore.setState({ error: error instanceof Error ? error.message : '没有切换分支' })
    })
}

export function editMessage(sessionId: string, messageId: string, content: string) {
  const text = content.trim()
  if (!text || useChatStore.getState().streaming[sessionId]) return false
  void runStream(
    sessionId,
    `/api/conversations/${sessionId}/messages/${messageId}/edit`,
    { content: text, thinking: useSettings.getState().thinking },
    text
  )
  return true
}

export function regenerateReply(sessionId: string, messageId: string) {
  if (useChatStore.getState().streaming[sessionId]) return
  void runStream(
    sessionId,
    `/api/conversations/${sessionId}/messages/${messageId}/regenerate`,
    { thinking: useSettings.getState().thinking },
    null
  )
}

export function continueReply(_sessionId: string, _messageId: string) {
  return false
}

export async function retryUpload(_sessionId: string, _messageId: string) {
  useChatStore.setState({ error: '这条历史附件不能从浏览器补传。' })
}

export function newChat() {
  const host = getChatHost()
  if (!host) return
  void api<{ conversation: { id: string } }>('/api/conversations', {
    body: {
      space: host.space,
      characterId: host.characterId ?? undefined,
      model: host.getModel(),
    },
  })
    .then((data) => {
      const path =
        host.space === 'companion' && host.characterId
          ? `/companion/${host.characterId}/chat/${data.conversation.id}`
          : `/workspace/chat/${data.conversation.id}`
      host.navigate(path)
    })
    .catch((error: unknown) => {
      useChatStore.setState({ error: error instanceof Error ? error.message : '没有打开新对话' })
    })
}
