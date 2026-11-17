import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet, Route, BrowserRouter, Routes, useMatch, useNavigate } from 'react-router-dom'
import { api } from './api.ts'
import { AccountPages } from './pages/Account.tsx'
import { AuthPages } from './pages/Auth.tsx'
import { CompanionPages } from './pages/Companion.tsx'
import { ChatPage } from './pages/Chat.tsx'
import { HomePage } from './pages/Home.tsx'
import { WorkspacePages } from './pages/Workspace.tsx'
import { SessionProvider, useSession } from './session.tsx'
import { useVisibleViewport } from './viewport.ts'

function Layout() {
  const { user, ready, setUser } = useSession()
  const navigate = useNavigate()
  const companionChat = useMatch('/companion/:characterId/chat/:conversationId')
  const workspaceChat = useMatch('/workspace/chat/:conversationId')
  const chatting = Boolean(companionChat || workspaceChat)
  const [fixture, setFixture] = useState(false)
  useVisibleViewport()
  useEffect(() => {
    document.documentElement.classList.toggle('chat-lock', chatting)
    return () => document.documentElement.classList.remove('chat-lock')
  }, [chatting])
  useEffect(() => {
    if (!user) return
    void api<{ mode: string }>('/api/gateway')
      .then((data) => setFixture(data.mode === 'fixture'))
      .catch(() => setFixture(false))
  }, [user])
  if (!ready) return <p className="boot">正在读取会话…</p>
  if (!user) return <Navigate to="/login" replace />

  async function logout() {
    await api('/api/logout', { method: 'POST', body: {} })
    setUser(null)
    navigate('/login')
  }

  return (
    <div className={chatting ? 'shell is-chat' : 'shell'}>
      <aside className="rail">
        <NavLink to="/" className="brand" end>
          <span className="mark">D/</span>
          <small>Deep Companion</small>
        </NavLink>
        <nav className="rail-nav">
          <NavLink to="/" end>首页</NavLink>
          <NavLink to="/companion">陪伴</NavLink>
          <NavLink to="/workspace">工作区</NavLink>
          <NavLink to="/notifications">通知</NavLink>
          <NavLink to="/settings">设置</NavLink>
          {user.role === 'admin' ? <NavLink to="/admin">管理</NavLink> : null}
        </nav>
        <div className="rail-foot">
          <span className="who">{user.displayName}</span>
          <button className="linkish" type="button" onClick={() => void logout()}>退出</button>
        </div>
      </aside>
      <div className="stage">
        {fixture ? <p className="fixture-ribbon">本地协议夹具 · 这里的模型回复不是真实模型</p> : null}
        <Outlet />
      </div>
      <nav className="dock" aria-label="主导航">
        <NavLink to="/" end>首页</NavLink>
        <NavLink to="/companion">陪伴</NavLink>
        <NavLink to="/workspace">工作区</NavLink>
        <NavLink to="/settings">设置</NavLink>
        <button type="button" onClick={() => void logout()}>退出</button>
      </nav>
    </div>
  )
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<AuthPages mode="login" />} />
          <Route path="/register" element={<AuthPages mode="register" />} />
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/companion" element={<CompanionPages mode="list" />} />
            <Route path="/companion/new" element={<CompanionPages mode="edit" />} />
            <Route path="/companion/:characterId" element={<CompanionPages mode="edit" />} />
            <Route path="/companion/:characterId/memories" element={<CompanionPages mode="memories" />} />
            <Route path="/companion/:characterId/chat/:conversationId" element={<ChatPage />} />
            <Route path="/workspace" element={<WorkspacePages mode="home" />} />
            <Route path="/workspace/timeline" element={<WorkspacePages mode="timeline" />} />
            <Route path="/workspace/projects" element={<WorkspacePages mode="projects" />} />
            <Route path="/workspace/grants" element={<WorkspacePages mode="grants" />} />
            <Route path="/workspace/chat/:conversationId" element={<ChatPage />} />
            <Route path="/notifications" element={<AccountPages mode="notifications" />} />
            <Route path="/settings" element={<AccountPages mode="settings" />} />
            <Route path="/privacy" element={<AccountPages mode="privacy" />} />
            <Route path="/admin" element={<AccountPages mode="admin" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  )
}
