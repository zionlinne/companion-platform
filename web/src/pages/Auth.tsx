import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, api, type User } from '../api.ts'
import { useSession } from '../session.tsx'

export function AuthPages({ mode }: { mode: 'login' | 'register' }) {
  const navigate = useNavigate()
  const { setUser } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const path = mode === 'login' ? '/api/login' : '/api/register'
      const body = mode === 'login' ? { email, password } : { email, password, invitationCode, displayName }
      const data = await api<{ user: User }>(path, { body })
      setUser(data.user)
      navigate('/')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '请求失败')
    }
  }

  return (
    <main className="page">
      <p className="brand">Companion Platform</p>
      <h1>{mode === 'login' ? '登录' : '邀请注册'}</h1>
      <p className="muted">普通用户不填写模型供应商 Key。模型调用只经过服务端网关。</p>
      <form className="panel" onSubmit={(event) => void submit(event)}>
        {error ? <p className="error">{error}</p> : null}
        <label>邮箱<input data-testid="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
        <label>密码<input data-testid="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {mode === 'register' ? (
          <>
            <label>邀请码<input data-testid="invitation" value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} /></label>
            <label>显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          </>
        ) : null}
        <button className="primary" type="submit">{mode === 'login' ? '登录' : '注册'}</button>
      </form>
      <p>{mode === 'login' ? <Link to="/register">使用邀请码注册</Link> : <Link to="/login">已有账号，去登录</Link>}</p>
    </main>
  )
}
