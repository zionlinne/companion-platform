import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet, Route, BrowserRouter, Routes, useNavigate } from 'react-router-dom'
import { api } from './api.ts'
import { AccountPages } from './pages/Account.tsx'
import { AuthPages } from './pages/Auth.tsx'
import { CompanionPages } from './pages/Companion.tsx'
import { ChatPage } from './pages/Chat.tsx'
import { HomePage } from './pages/Home.tsx'
import { WorkspacePages } from './pages/Workspace.tsx'
import { SessionProvider, useSession } from './session.tsx'

function Layout() {
  const { user, ready, setUser } = useSession()
  const navigate = useNavigate()
  const [theme, setTheme] = useState(() => (localStorage.getItem('dc-theme') === 'dark' ? 'dark' : 'light'))
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dc-theme', theme)
  }, [theme])
  if (!ready) return <p className="page">正在读取会话…</p>
  if (!user) return <Navigate to="/login" replace />
  return (
    <div className="shell">
      <nav className="nav">
        <NavLink to="/" className="brand" end><span className="mark">D/</span> Deep Companion</NavLink>
        <NavLink to="/companion">陪伴</NavLink>
        <NavLink to="/workspace">工作区</NavLink>
        <NavLink to="/notifications">通知</NavLink>
        <NavLink to="/account">个人中心</NavLink>
        <NavLink to="/settings">设置</NavLink>
        {user.role === 'admin' ? <NavLink to="/admin">管理</NavLink> : null}
        <button className="linkish" type="button" data-testid="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
        <span className="spacer" />
        <span className="muted">{user.displayName}</span>
        <button
          className="linkish"
          type="button"
          onClick={async () => {
            await api('/api/logout', { method: 'POST', body: {} })
            setUser(null)
            navigate('/login')
          }}
        >
          退出
        </button>
      </nav>
      <Outlet />
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
            <Route path="/account" element={<AccountPages mode="account" />} />
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
