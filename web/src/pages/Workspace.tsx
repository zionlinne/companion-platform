import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api.ts'

type Conversation = { id: string; title: string; updatedAt: string }
type Project = { id: string; name: string; summary: string }
type TimelineEvent = { id: string; title: string; summary: string; event_type: string; occurred_at: string; due_at: string | null }
type Character = { id: string; name: string }
type Grant = { id: string; event_id: string; character_id: string; revoked_at: string | null; allow_summary: number; allow_title: number }

export function WorkspacePages({ mode }: { mode: 'home' | 'timeline' | 'projects' | 'grants' }) {
  if (mode === 'timeline') return <TimelinePage />
  if (mode === 'projects') return <ProjectsPage />
  if (mode === 'grants') return <GrantsPage />
  return <WorkspaceHome />
}

function WorkspaceHome() {
  const navigate = useNavigate()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  useEffect(() => {
    void api<{ conversations: Conversation[] }>('/api/conversations?space=workspace').then((data) => {
      setConversations(data.conversations)
      setStatus('ready')
    }).catch((caught: unknown) => {
      setStatus('error')
      setError(caught instanceof ApiError ? caught.message : '工作区没有读出来')
    })
  }, [])
  return (
    <main className="page">
      <h1>工作区</h1>
      <p className="muted">这里的对话、项目和文件不会自动进入陪伴角色的上下文。</p>
      <div className="row">
        <button className="primary" type="button" onClick={async () => {
          const created = await api<{ conversation: Conversation }>('/api/conversations', { body: { space: 'workspace' } })
          navigate(`/workspace/chat/${created.conversation.id}`)
        }}>新的工作对话</button>
        <Link to="/workspace/timeline">时间线</Link>
        <Link to="/workspace/projects">项目</Link>
        <Link to="/workspace/grants">授权</Link>
      </div>
      {status === 'loading' ? <p>正在读取工作对话…</p> : null}
      {status === 'error' ? <p className="error">{error}</p> : null}
      <div className="stack">
        {conversations.map((conversation) => (
          <Link key={conversation.id} className="panel" to={`/workspace/chat/${conversation.id}`}>{conversation.title}</Link>
        ))}
        {status === 'ready' && conversations.length === 0 ? <p data-testid="empty-workspace">还没有工作对话。这里的内容不会自动进入 Companion。</p> : null}
      </div>
    </main>
  )
}

function TimelinePage() {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [occurredAt, setOccurredAt] = useState('2026-11-17T09:00')
  async function load() {
    const data = await api<{ events: TimelineEvent[] }>('/api/workspace/timeline')
    setEvents(data.events)
  }
  useEffect(() => { void load() }, [])
  return (
    <main className="page">
      <h1>时间线</h1>
      <p className="muted">陪伴角色默认不能读取这些记录。需要到授权页勾选具体字段。</p>
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        await api('/api/workspace/timeline', { body: { title, summary, eventType: 'note', occurredAt: new Date(occurredAt).toISOString() } })
        setTitle('')
        setSummary('')
        await load()
      }}>
        <label>标题<input data-testid="timeline-title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>摘要<textarea data-testid="timeline-summary" value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <label>发生时间<input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <button className="primary" type="submit">添加事件</button>
      </form>
      {events.map((item) => (
        <article className="panel" key={item.id}>
          <strong>{item.title}</strong>
          <p>{item.summary}</p>
          <p className="muted">{item.occurred_at}</p>
          <button className="ghost" type="button" onClick={async () => { await api(`/api/workspace/timeline/${item.id}`, { method: 'DELETE', body: {} }); await load() }}>删除</button>
        </article>
      ))}
    </main>
  )
}

function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  async function load() {
    const data = await api<{ projects: Project[] }>('/api/workspace/projects')
    setProjects(data.projects)
    if (!projectId && data.projects[0]) setProjectId(data.projects[0].id)
  }
  useEffect(() => { void load() }, [])
  return (
    <main className="page">
      <h1>项目和任务</h1>
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        await api('/api/workspace/projects', { body: { name, summary: '' } })
        setName('')
        await load()
      }}>
        <label>项目名<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="primary" type="submit">创建项目</button>
      </form>
      {projects.map((project) => <p key={project.id}>{project.name}</p>)}
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        if (!projectId) return
        await api(`/api/workspace/projects/${projectId}/tasks`, { body: { title: taskTitle } })
        setTaskTitle('')
      }}>
        <label>项目
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label>任务<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
        <button className="ghost" type="submit">添加任务</button>
      </form>
    </main>
  )
}

function GrantsPage() {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [grants, setGrants] = useState<Grant[]>([])
  const [eventId, setEventId] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [allowSummary, setAllowSummary] = useState(true)
  const [allowTitle, setAllowTitle] = useState(false)
  async function load() {
    const [eventData, characterData, grantData] = await Promise.all([
      api<{ events: TimelineEvent[] }>('/api/workspace/timeline'),
      api<{ characters: Character[] }>('/api/characters'),
      api<{ grants: Grant[] }>('/api/workspace/grants'),
    ])
    setEvents(eventData.events)
    setCharacters(characterData.characters)
    setGrants(grantData.grants)
    if (!eventId && eventData.events[0]) setEventId(eventData.events[0].id)
    if (!characterId && characterData.characters[0]) setCharacterId(characterData.characters[0].id)
  }
  useEffect(() => { void load() }, [])
  return (
    <main className="page">
      <h1>时间线授权</h1>
      <p className="muted">只读、可撤销。每次读取都会留下审计。陪伴角色不能修改工作区。</p>
      <form className="panel" onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        await api(`/api/workspace/timeline/${eventId}/grants`, { body: { characterId, allowSummary, allowTitle, allowOccurredAt: false, allowDueAt: false } })
        await load()
      }}>
        <label>事件
          <select data-testid="grant-event" value={eventId} onChange={(event) => setEventId(event.target.value)}>
            {events.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
        <label>角色
          <select data-testid="grant-character" value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
            {characters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="check"><input data-testid="grant-title" type="checkbox" checked={allowTitle} onChange={(event) => setAllowTitle(event.target.checked)} />标题</label>
        <label className="check"><input type="checkbox" checked={allowSummary} onChange={(event) => setAllowSummary(event.target.checked)} />摘要</label>
        <button className="primary" type="submit">授权所选字段</button>
      </form>
      {grants.map((grant) => (
        <article className="panel" key={grant.id}>
          <p>角色 {grant.character_id} · 事件 {grant.event_id} · {grant.revoked_at ? '已撤销' : '有效'}</p>
          {grant.revoked_at ? null : <button className="ghost" type="button" onClick={async () => { await api(`/api/workspace/grants/${grant.id}/revoke`, { body: {} }); await load() }}>撤销</button>}
        </article>
      ))}
    </main>
  )
}
