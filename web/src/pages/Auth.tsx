import { useEffect, useState, type FormEvent } from 'react'
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
  const [registration, setRegistration] = useState<'unknown' | 'unavailable' | 'needs_invite'>('unknown')

  useEffect(() => {
    void api<{ registration?: string }>('/api/health')
      .then((data) => setRegistration(data.registration === 'needs_invite' ? 'needs_invite' : 'unavailable'))
      .catch(() => setRegistration('unknown'))
  }, [])

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
      <p className="brand"><span className="mark">D/</span> Deep Companion</p>
      <h1>{mode === 'login' ? '登录' : '邀请注册'}</h1>
      <section className="panel" data-testid="first-run">
        <h2>第一次使用</h2>
        <ol>
          <li>向管理员要邀请码，在这里注册。这一页没有服务器地址，也没有供应商 Key。</li>
          <li>登录后从 Workspace 或 Companion 进入。两个入口的会话和记忆是分开的。</li>
          <li>可以套用示例人格，再查看、增删和导入记忆。导入要先预览再确认。对话存在服务端。</li>
        </ol>
        <p className="muted" data-testid="sleep-note">如果一直停在读取会话，或提示连不上服务，免费托管可能正在醒来，等一会儿再刷新。附件上传和定时主动消息在免费托管上不可用，页面不会假装已经打开。</p>
        <p data-testid="registration-state">
          {registration === 'unavailable'
            ? '管理员还没有初始化，注册现在不可用。'
            : '没有邀请码时不能完成注册。邀请码由已登录的管理员生成，不会出现在日志里。'}
        </p>
      </section>
      <form className="panel" onSubmit={(event) => void submit(event)}>
        {error ? <p className="error" data-testid="auth-error">{error}</p> : null}
        <label>邮箱<input data-testid="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
        <label>密码<input data-testid="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {mode === 'register' ? (
          <>
            <label>邀请码<input data-testid="invitation" value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} /></label>
            <label>显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          </>
        ) : null}
        <button className="primary" type="submit" disabled={mode === 'register' && registration !== 'needs_invite'}>{mode === 'login' ? '登录' : '注册'}</button>
      </form>
      <p>{mode === 'login' ? <Link to="/register">使用邀请码注册</Link> : <Link to="/login">已有账号，去登录</Link>}</p>
    </main>
  )
}
