import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { ApiError, api } from '../api.ts'
import { useSession } from '../session.tsx'

type Settings = {
  enabled: boolean
  quietStartMinute: number | null
  quietEndMinute: number | null
  dailyLimit: number
  maxModelCallsPerTick: number
  triggers: Record<string, { enabled: boolean; implemented: boolean }>
}

export function AccountPages({ mode }: { mode: 'settings' | 'privacy' | 'notifications' | 'admin' }) {
  if (mode === 'privacy') return <PrivacyPage />
  if (mode === 'notifications') return <NotificationsPage />
  if (mode === 'admin') return <AdminPage />
  return <SettingsPage />
}

function SettingsPage() {
  const { user, refresh } = useSession()
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [feedback, setFeedback] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    void api<{ settings: Settings }>('/api/initiative').then((data) => setSettings(data.settings))
  }, [])
  return (
    <main className="page">
      <p className="eyebrow">偏好</p>
      <h1>设置</h1>
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        await api('/api/me', { method: 'PATCH', body: { displayName } })
        await refresh()
        setMessage('资料已保存')
      }}>
        <label>显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <button className="primary" type="submit">保存资料</button>
      </form>
      {settings ? (
        <form className="panel" onSubmit={async (event: FormEvent) => {
          event.preventDefault()
          const data = await api<{ settings: Settings }>('/api/initiative', { method: 'PATCH', body: {
            enabled: settings.enabled,
            dailyLimit: Number(settings.dailyLimit),
            maxModelCallsPerTick: Number(settings.maxModelCallsPerTick),
            quietStartMinute: settings.quietStartMinute,
            quietEndMinute: settings.quietEndMinute,
          } })
          setSettings(data.settings)
          setMessage('主动消息设置已保存。定时、工作事件、历史跟进和日期提醒还没有实现。')
        }}>
          <h2>主动消息</h2>
          <p className="muted" data-testid="scheduler-limit">免费托管会休眠，后台定时主动消息保持关闭，不能当成已经可用。下面的按钮只给当前登录用户手动检查已授权的时间线，权限没有放宽。定时、工作事件、历史跟进和日期提醒仍未实现。</p>
          <label className="check"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />开启</label>
          <label>每日上限<input type="number" value={settings.dailyLimit} onChange={(event) => setSettings({ ...settings, dailyLimit: Number(event.target.value) })} /></label>
          <label>每次调度最多模型调用（1–3）<input type="number" value={settings.maxModelCallsPerTick} onChange={(event) => setSettings({ ...settings, maxModelCallsPerTick: Number(event.target.value) })} /></label>
          <label>免打扰开始（UTC 分钟，可空）<input value={settings.quietStartMinute ?? ''} onChange={(event) => setSettings({ ...settings, quietStartMinute: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <label>免打扰结束<input value={settings.quietEndMinute ?? ''} onChange={(event) => setSettings({ ...settings, quietEndMinute: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <button className="primary" type="submit">保存主动消息</button>
          <button className="ghost" type="button" data-testid="initiative-tick" onClick={async () => {
            const result = await api<{ status: string; reason?: string }>('/api/initiative/tick', { body: {} })
            setMessage(result.status === 'ok'
              ? '已按已授权时间线检查主动消息。没有供应商 Key 时不会生成假回复。'
              : `这次没有发出主动消息：${result.reason ?? result.status}`)
          }}>立即检查主动消息</button>
        </form>
      ) : null}
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        await api('/api/feedback', { body: { body: feedback } })
        setFeedback('')
        setMessage('反馈已提交')
      }}>
        <label>反馈<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
        <button className="ghost" type="submit">提交反馈</button>
      </form>
      <div className="row">
        <button className="ghost" type="button" onClick={async () => {
          const data = await api<unknown>('/api/me/export')
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'companion-export.json'
          link.click()
          URL.revokeObjectURL(url)
        }}>导出我的数据</button>
        <Link to="/notifications">通知</Link>
        <Link to="/privacy">隐私说明</Link>
        <Link to="/recharge">充值</Link>
        {user?.role === 'admin' ? <Link to="/admin">管理</Link> : null}
      </div>
      {user?.role === 'user' ? (
        <form className="panel" onSubmit={async (event: FormEvent) => {
          event.preventDefault()
          await api('/api/me/delete', { body: { password } })
          location.assign('/login')
        }}>
          <h2>删除账号</h2>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="ghost" type="submit">删除我的账号和数据</button>
        </form>
      ) : null}
      {message ? <p>{message}</p> : null}
    </main>
  )
}

function NotificationsPage() {
  const [items, setItems] = useState<Array<{ id: string; title: string; body: string; read_at: string | null; conversation_id: string | null }>>([])
  async function load() {
    const data = await api<{ notifications: typeof items }>('/api/notifications')
    setItems(data.notifications)
  }
  useEffect(() => { void load() }, [])
  return (
    <main className="page">
      <p className="eyebrow">应用内</p>
      <h1>通知</h1>
      <p className="muted">目前只有应用内通知。没有手机推送。</p>
      {items.map((item) => (
        <article className="panel" key={item.id} data-testid="notification">
          <strong>{item.title}</strong>
          <p>{item.body}</p>
          {item.read_at ? null : <button className="ghost" type="button" onClick={async () => { await api(`/api/notifications/${item.id}/read`, { body: {} }); await load() }}>标为已读</button>}
        </article>
      ))}
      {items.length === 0 ? <p>还没有通知。</p> : null}
    </main>
  )
}

function PrivacyPage() {
  return (
    <main className="page">
      <p className="eyebrow">D/</p>
      <h1>隐私说明</h1>
      <div className="panel stack">
        <p>Deep Companion 把账号、角色、记忆、工作区和对话存在本服务的数据库里。会话使用 HttpOnly Cookie，不把登录态放在浏览器本地变量里冒充账号。D/ 是本产品的文字标识，不是 DeepSeek 官方标志。</p>
        <p>供应商 API Key 只应由管理员配置在服务端环境中。浏览器页面、前端包和普通日志不应出现这把 Key。没有 Key 时聊天会明确失败，不会用假回复顶上。</p>
        <p>人格卡和记忆是两套数据。工作区记录默认不进入陪伴上下文；只有你授权的字段可以被只读读取，每次读取会记审计，授权可以撤销。</p>
        <p>你可以导出自己的数据，或删除自己的账号。删除不会影响其他用户。私人聊天不会提供给其他用户。</p>
        <p>费用数字如果出现，来自模型返回的 usage 和可选的配置单价，并会标明是估算还是未知。它不是供应商账单。</p>
        <p><Link to="/settings">返回设置</Link></p>
      </div>
    </main>
  )
}

function AdminPage() {
  const { user } = useSession()
  const [count, setCount] = useState(1)
  const [codes, setCodes] = useState<string[]>([])
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')
  async function load() {
    setStats(await api<Record<string, unknown>>('/api/admin/stats'))
  }
  useEffect(() => { if (user?.role === 'admin') void load() }, [user])
  if (user && user.role !== 'admin') return <Navigate to="/" replace />
  return (
    <main className="page">
      <p className="eyebrow">管理员</p>
      <h1>管理</h1>
      <p className="muted">首批建议发放 10–20 个邀请码。验证码明文只在创建时出现一次。</p>
      {error ? <p className="error">{error}</p> : null}
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        try {
          const data = await api<{ invitations: Array<{ code: string }> }>('/api/admin/invitations', { body: { count } })
          setCodes(data.invitations.map((item) => item.code))
          await load()
        } catch (caught) {
          setError(caught instanceof ApiError ? caught.message : '创建失败')
        }
      }}>
        <label>数量<input data-testid="invite-count" type="number" min={1} max={50} value={count} onChange={(event) => setCount(Number(event.target.value))} /></label>
        <button className="primary" type="submit" data-testid="create-invites">生成邀请码</button>
      </form>
      {codes.map((code) => <p key={code}><code data-testid="invite-code">{code}</code></p>)}
      {stats ? (
        <div className="panel">
          <p>用户 {String(stats.users)} · 近 7 天活跃 {String(stats.active7d)}</p>
          <p>prompt tokens {String(stats.promptTokens)} · completion tokens {String(stats.completionTokens)}</p>
          <p>按配置单价计算的 micro-USD：{String(stats.calculatedCostMicroUsd)}。未知成本行 {String(stats.unknownCostRows)}。夹具行 {String(stats.fixtureRows)}。</p>
          <p>{String(stats.costNote)}</p>
        </div>
      ) : null}
    </main>
  )
}
