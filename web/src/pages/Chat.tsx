import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../api.ts'
import { SessionView } from '../vendor/deepseek-chat-demo/src/components/session/SessionView.tsx'
import { bindChatHost } from '../vendor/deepseek-chat-demo/src/services/chat/host.ts'
import { loadConversation, resetConversation, useChatStore } from '../vendor/deepseek-chat-demo/src/services/chat/store.ts'
import { setUploadsMode } from '../vendor/deepseek-chat-demo/src/services/attachments.ts'
import '../vendor/deepseek-chat-demo/src/app/theme.css'

export function ChatPage() {
  const navigate = useNavigate()
  const { conversationId = '', characterId } = useParams()
  const space = characterId ? 'companion' : 'workspace'
  const modelRef = useRef('deepseek-flash')
  const session = useChatStore((state) => state.session)
  const streaming = useChatStore((state) => Boolean(state.streaming[conversationId]))
  const streamError = useChatStore((state) => state.error)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    bindChatHost({
      space,
      characterId: characterId ?? null,
      getModel: () => modelRef.current,
      navigate,
    })
    return () => bindChatHost(null)
  }, [space, characterId, navigate])

  useEffect(() => {
    let cancel = false
    resetConversation(conversationId)
    void loadConversation(conversationId)
      .then((info) => {
        if (!cancel && info) modelRef.current = info.model
      })
      .catch((caught: unknown) => {
        if (!cancel) setError(caught instanceof ApiError ? caught.message : '对话没有读出来')
      })
    return () => {
      cancel = true
    }
  }, [conversationId])

  useEffect(() => {
    void api<{ mode: string; configured: boolean; uploads?: 'local' | 'disabled' }>('/api/gateway')
      .then((data) => {
        setUploadsMode(data.uploads === 'disabled' ? 'disabled' : 'local')
        setBanner(
          data.mode === 'fixture'
            ? '当前是本地协议夹具，回复不是 DeepSeek，也不能当作真实模型验收。'
            : data.configured
              ? '模型请求由服务端网关发出。页面不保存供应商 Key。'
              : '服务端还没有配置供应商 Key，发送会失败，不会伪造回复。'
        )
      })
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : '网关状态没有读出来'))
  }, [conversationId])

  const visible = session.id === conversationId ? session : { ...session, id: conversationId, messages: [], rootMessageId: null }

  return (
    <main className="chat-page">
      <div className="chat-toolbar">
        {characterId ? <Link to={`/companion/${characterId}`}>人格</Link> : <Link to="/workspace">工作区</Link>}
        {characterId ? <Link to={`/companion/${characterId}/memories`}>记忆</Link> : null}
      </div>
      {banner ? <p className="banner" data-testid="gateway-banner">{banner}</p> : null}
      {error || streamError ? <p className="error">{error || streamError}</p> : null}
      <div className="ds-chat" data-testid="chat-log">
        <SessionView session={visible} streaming={streaming} siderCollapsed={false} />
      </div>
    </main>
  )
}
