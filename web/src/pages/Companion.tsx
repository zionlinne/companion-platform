import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../api.ts'

type Character = {
  id: string
  name: string
  avatarText: string
  identity: string
  background: string
  traits: string
  style: string
  habits: string
  relationship: string
  rules: string
  defaultModel: string
  initiativeEnabled: boolean
}

type Memory = {
  id: string
  category: string
  content: string
  source: string
  explicit: boolean
  status: string
  createdAt: string
  updatedAt: string
}

const empty = {
  name: '',
  avatarText: '',
  identity: '',
  background: '',
  traits: '',
  style: '',
  habits: '',
  relationship: '',
  rules: '',
  defaultModel: 'deepseek-flash',
  initiativeEnabled: false,
}

export function CompanionPages({ mode }: { mode: 'list' | 'edit' | 'memories' }) {
  if (mode === 'list') return <CharacterList />
  if (mode === 'memories') return <MemoriesPage />
  return <PersonaPage />
}

function CharacterList() {
  const navigate = useNavigate()
  const [characters, setCharacters] = useState<Character[]>([])
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; characterId: string | null }>>([])
  useEffect(() => {
    void api<{ characters: Character[] }>('/api/characters').then((data) => setCharacters(data.characters))
    void api<{ conversations: Array<{ id: string; title: string; characterId: string | null }> }>('/api/conversations?space=companion').then((data) => setConversations(data.conversations))
  }, [])
  return (
    <main className="page">
      <div className="row">
        <h1>陪伴</h1>
        <Link className="primary" to="/companion/new">新建角色</Link>
      </div>
      <p className="muted">每个人格单独保存。人格卡不是长期记忆。</p>
      <div className="stack">
        {characters.map((character) => (
          <div className="panel" key={character.id}>
            <strong>{character.avatarText ? `${character.avatarText} ` : ''}{character.name}</strong>
            <p className="muted">{character.identity || '还没有身份描述'}</p>
            <div className="row">
              <Link to={`/companion/${character.id}`}>人格</Link>
              <Link to={`/companion/${character.id}/memories`}>记忆</Link>
              <button className="ghost" type="button" onClick={async () => {
                const created = await api<{ conversation: { id: string } }>('/api/conversations', { body: { space: 'companion', characterId: character.id } })
                navigate(`/companion/${character.id}/chat/${created.conversation.id}`)
              }}>新对话</button>
              {conversations.filter((conversation) => conversation.characterId === character.id).map((conversation) => (
                <Link key={conversation.id} to={`/companion/${character.id}/chat/${conversation.id}`}>{conversation.title}</Link>
              ))}
            </div>
          </div>
        ))}
        {characters.length === 0 ? <p>还没有角色。</p> : null}
      </div>
    </main>
  )
}

function PersonaPage() {
  const { characterId } = useParams()
  const navigate = useNavigate()
  const [form, setForm] = useState(empty)
  const [models, setModels] = useState<Array<{ id: string }>>([])
  const [error, setError] = useState('')
  useEffect(() => {
    void api<{ models: Array<{ id: string }> }>('/api/models').then((data) => setModels(data.models))
    if (!characterId) return
    void api<{ character: Character }>(`/api/characters/${characterId}`).then((data) => setForm({
      name: data.character.name,
      avatarText: data.character.avatarText,
      identity: data.character.identity,
      background: data.character.background,
      traits: data.character.traits,
      style: data.character.style,
      habits: data.character.habits,
      relationship: data.character.relationship,
      rules: data.character.rules,
      defaultModel: data.character.defaultModel,
      initiativeEnabled: data.character.initiativeEnabled,
    }))
  }, [characterId])

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      if (characterId) {
        await api(`/api/characters/${characterId}`, { method: 'PATCH', body: form })
      } else {
        const created = await api<{ character: Character }>('/api/characters', { body: form })
        navigate(`/companion/${created.character.id}`)
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存失败')
    }
  }

  return (
    <main className="page">
      <h1>{characterId ? '编辑人格' : '新建角色'}</h1>
      <p className="muted">这些字段是人格卡。长期事实、事件和关系请写在记忆页，不要堆进这里。</p>
      {error ? <p className="error">{error}</p> : null}
      <form className="panel" onSubmit={(event) => void save(event)}>
        <label>名称<input data-testid="character-name" value={form.name} onChange={(event) => set('name', event.target.value)} /></label>
        <label>文字头像<input value={form.avatarText} maxLength={8} onChange={(event) => set('avatarText', event.target.value)} /></label>
        <label>身份<textarea data-testid="character-identity" value={form.identity} onChange={(event) => set('identity', event.target.value)} /></label>
        <label>背景<textarea value={form.background} onChange={(event) => set('background', event.target.value)} /></label>
        <label>特征<textarea value={form.traits} onChange={(event) => set('traits', event.target.value)} /></label>
        <label>表达风格<textarea data-testid="character-style" value={form.style} onChange={(event) => set('style', event.target.value)} /></label>
        <label>习惯<textarea value={form.habits} onChange={(event) => set('habits', event.target.value)} /></label>
        <label>关系<textarea value={form.relationship} onChange={(event) => set('relationship', event.target.value)} /></label>
        <label>规则<textarea value={form.rules} onChange={(event) => set('rules', event.target.value)} /></label>
        <label>默认模型
          <select value={form.defaultModel} onChange={(event) => set('defaultModel', event.target.value)}>
            {models.map((model) => <option key={model.id}>{model.id}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={form.initiativeEnabled} onChange={(event) => set('initiativeEnabled', event.target.checked)} />允许主动消息</label>
        <div className="row">
          <button className="primary" type="submit">保存人格</button>
          {characterId ? <Link to={`/companion/${characterId}/memories`}>记忆</Link> : null}
          {characterId ? <button className="ghost" type="button" onClick={async () => {
            await api(`/api/characters/${characterId}/copy`, { body: { copyMemories: true } })
            navigate('/companion')
          }}>复制</button> : null}
          {characterId ? <button className="ghost" type="button" onClick={async () => {
            await api(`/api/characters/${characterId}`, { method: 'DELETE', body: {} })
            navigate('/companion')
          }}>删除</button> : null}
        </div>
      </form>
    </main>
  )
}

function MemoriesPage() {
  const { characterId = '' } = useParams()
  const [memories, setMemories] = useState<Memory[]>([])
  const [suggested, setSuggested] = useState<Memory[]>([])
  const [content, setContent] = useState('')
  const [source, setSource] = useState('手动')
  const [category, setCategory] = useState('fact')
  const [explicit, setExplicit] = useState(true)
  const [format, setFormat] = useState('json')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<{ previewId: string; items: Array<{ tempId: string; content: string; explicit: boolean; note: string }> } | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState('')

  async function load() {
    const active = await api<{ memories: Memory[] }>(`/api/characters/${characterId}/memories`)
    const pending = await api<{ memories: Memory[] }>(`/api/characters/${characterId}/memories?status=suggested`)
    setMemories(active.memories)
    setSuggested(pending.memories)
  }
  useEffect(() => { void load() }, [characterId])

  return (
    <main className="page">
      <h1>角色记忆</h1>
      <p className="muted">记忆和人格分开存放。模型建议要你确认后才写入。未标记为明确事实的内容不会被当成已核实事实。</p>
      {error ? <p className="error">{error}</p> : null}
      <form className="panel" onSubmit={async (event) => {
        event.preventDefault()
        await api(`/api/characters/${characterId}/memories`, { body: { category, content, source, explicit } })
        setContent('')
        await load()
      }}>
        <label>分类
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="persona">人格</option>
            <option value="fact">事实</option>
            <option value="event">事件</option>
            <option value="relationship">关系</option>
          </select>
        </label>
        <label>内容<textarea data-testid="memory-content" value={content} onChange={(event) => setContent(event.target.value)} /></label>
        <label>来源<input data-testid="memory-source" value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={explicit} onChange={(event) => setExplicit(event.target.checked)} />这是明确事实</label>
        <button className="primary" type="submit">保存记忆</button>
      </form>
      <div className="stack">
        {memories.map((memory) => (
          <article className="panel" key={memory.id} data-testid="memory-item">
            <strong>{memory.category}</strong> {memory.explicit ? '明确' : '未标为明确事实'}
            <p>{memory.content}</p>
            <p className="muted">来源 {memory.source} · 创建 {memory.createdAt} · 更新 {memory.updatedAt}</p>
            <button className="ghost" type="button" onClick={async () => { await api(`/api/memories/${memory.id}`, { method: 'DELETE', body: {} }); await load() }}>删除</button>
          </article>
        ))}
      </div>
      <h2>建议</h2>
      {suggested.map((memory) => (
        <article className="panel" key={memory.id}>
          <p>{memory.content}</p>
          <button className="primary" type="button" onClick={async () => { await api(`/api/memories/${memory.id}/confirm`, { body: { explicit: false } }); await load() }}>确认写入，仍不标为明确事实</button>
        </article>
      ))}
      <h2>导入预览</h2>
      <div className="panel">
        <label>格式
          <select value={format} onChange={(event) => setFormat(event.target.value)}>
            <option value="json">JSON</option>
            <option value="jsonl">JSONL</option>
            <option value="md">Markdown</option>
            <option value="txt">TXT</option>
            <option value="chatgpt">ChatGPT 适配</option>
            <option value="gemini">Gemini 适配</option>
            <option value="deepseek">DeepSeek 会话 JSON</option>
          </select>
        </label>
        <label>文本<textarea value={text} onChange={(event) => setText(event.target.value)} /></label>
        <button className="ghost" type="button" onClick={async () => {
          try {
            const result = await api<{ previewId: string; items: Array<{ tempId: string; content: string; explicit: boolean; note: string }> }>(`/api/characters/${characterId}/memories/import/preview`, { body: { format, text } })
            setPreview(result)
            setPicked(result.items.map((item) => item.tempId))
            setError('')
          } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : '无法解析')
          }
        }}>预览，先不写入</button>
        {preview ? (
          <>
            {preview.items.map((item) => (
              <label className="check" key={item.tempId}>
                <input type="checkbox" checked={picked.includes(item.tempId)} onChange={(event) => setPicked((current) => event.target.checked ? [...current, item.tempId] : current.filter((id) => id !== item.tempId))} />
                {item.content} {item.explicit ? '' : '（未标为明确事实）'}
              </label>
            ))}
            <button className="primary" type="button" onClick={async () => {
              await api(`/api/characters/${characterId}/memories/import/commit`, { body: { previewId: preview.previewId, tempIds: picked } })
              setPreview(null)
              await load()
            }}>确认写入所选</button>
          </>
        ) : null}
      </div>
    </main>
  )
}
