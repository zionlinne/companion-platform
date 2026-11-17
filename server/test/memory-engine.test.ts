import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.ts'
import { migrate, migrationSql, openDatabase, type SqlDb } from '../src/db.ts'
import { createLogger } from '../src/log.ts'
import {
  applyMemoryDecision,
  flushObservations,
  loadActiveMemories,
  observeChatTurn,
  parseExplicit,
  parseModelMemoryOutput,
  setMemoryCompleterForTests,
  type MemoryCompleter,
  type MemoryDecision,
} from '../src/memory-engine.ts'
import { assembleCompanionPrompt, assembleInitiativePrompt, assembleWorkspacePrompt } from '../src/prompt.ts'
import { api, sse, start } from './harness.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const emptyModel: MemoryCompleter = async () => '{"memories":[]}'

function configFor(dir: string) {
  return loadConfig(
    { NODE_ENV: 'test' },
    {
      nodeEnv: 'test',
      gatewayMode: 'live',
      deepseekApiKey: null,
      databaseUrl: null,
      databasePath: path.join(dir, 'app.sqlite'),
      dataDir: dir,
      initiativePollMs: 0,
    }
  )
}

async function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-engine-'))
  const db = openDatabase({ databaseUrl: null, databasePath: path.join(dir, 'app.sqlite') })
  await migrate(db)
  return {
    dir,
    db,
    config: configFor(dir),
    log: createLogger(() => {}),
    close: async () => {
      await db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function seed(db: SqlDb, userId: string, characterId: string, style = '短句') {
  const at = '2024-01-01T00:00:00.000Z'
  await db.run(
    `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, 'hash', 'user', 'user', ?, ?)`,
    [userId, `${userId}@example.com`, at, at]
  )
  await db.run(
    `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
     VALUES (?, ?, '林', '', '研究员', '', '', ?, '', '', '不编造', 'deepseek-flash', 0, ?, ?)`,
    [characterId, userId, style, at, at]
  )
}

function decision(partial: Partial<MemoryDecision> & Pick<MemoryDecision, 'action' | 'content'>): MemoryDecision {
  return {
    category: 'fact',
    target: '',
    change: null,
    confidence: 0.9,
    uncertain: false,
    source: 'model_inferred',
    explicit: false,
    ...partial,
  }
}

test('sqlite migration keeps an existing memory and accepts history statuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migrate-'))
  const databasePath = path.join(dir, 'app.sqlite')
  const db = openDatabase({ databaseUrl: null, databasePath })
  const migrationsDir = path.join(root, 'server/migrations')
  await db.exec(fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8'))
  await db.exec(fs.readFileSync(path.join(migrationsDir, '002_memory_note.sql'), 'utf8'))
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const stamped = '2024-01-01T00:00:00.000Z'
  await db.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, ['001_init.sql', stamped])
  await db.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, ['002_memory_note.sql', stamped])
  await seed(db, 'legacy-user', 'legacy-char')
  await db.run(
    `INSERT INTO memories (id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at)
     VALUES ('legacy-memory', 'legacy-user', 'legacy-char', 'fact', '旧记忆不能丢', 'user', 1, '原备注', 'active', ?, ?)`,
    [stamped, '2024-02-01T00:00:00.000Z']
  )
  assert.deepEqual(await migrate(db), ['003_memory_engine.sql', '004_wallet.sql'])
  const kept = await db.get<{ content: string; note: string; space: string; status: string; confidence: number; created_at: string }>(
    `SELECT content, note, space, status, confidence, created_at FROM memories WHERE id = 'legacy-memory'`
  )
  assert.equal(kept?.content, '旧记忆不能丢')
  assert.equal(kept?.note, '原备注')
  assert.equal(kept?.space, 'companion')
  assert.equal(Number(kept?.confidence), 1)
  assert.equal(kept?.created_at, stamped)
  const legacyWallet = await db.get<{ available_fen: number }>(`SELECT available_fen FROM wallets WHERE user_id = 'legacy-user'`)
  assert.equal(legacyWallet?.available_fen, 0)
  await db.run(`UPDATE memories SET status = 'superseded' WHERE id = 'legacy-memory'`)
  const status = await db.get<{ status: string }>(`SELECT status FROM memories WHERE id = 'legacy-memory'`)
  assert.equal(status?.status, 'superseded')
  await db.close()
  const fresh = openDatabase({ databaseUrl: null, databasePath: path.join(dir, 'fresh.sqlite') })
  assert.deepEqual(await migrate(fresh), ['001_init.sql', '002_memory_note.sql', '003_memory_engine.sql', '004_wallet.sql'])
  await fresh.close()
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(migrationSql('PRAGMA foreign_keys = OFF;\nSELECT 1;', 'postgres').includes('PRAGMA'), false)
})

test('explicit save is a user channel and ordinary text is not keyword-extracted', async () => {
  assert.equal(parseExplicit('我每周三晚固定去游泳，已经坚持两年'), null)
  assert.equal(parseExplicit('今天天气不错，我们随便聊聊'), null)
  const requested = parseExplicit('请记住我长期只喝绿茶')
  assert.equal(requested?.source, 'user_requested')
  assert.equal(requested?.content, '我长期只喝绿茶')
  assert.equal(requested?.explicit, true)
  const stated = parseExplicit('长期偏好：清晨喝绿茶')
  assert.equal(stated?.source, 'user_stated')
  assert.equal(stated?.category, 'preference')
  const changed = parseExplicit('更正：我不再用 Cursor，改用 Vim')
  assert.equal(changed?.change, 'fact_changed')
  assert.equal(changed?.source, 'user_stated')
  assert.match(changed?.target ?? '', /Cursor/)
  const wrong = parseExplicit('记错了：不是长期使用 Cursor，是长期使用 Vim')
  assert.equal(wrong?.change, 'correction')
  assert.equal(wrong?.content, '长期使用 Vim')
  const ambiguous = parseExplicit('更正：好像不是那样')
  assert.equal(ambiguous?.uncertain, true)
})

test('model JSON is parsed as inference and cannot impersonate the user or edit persona', () => {
  const parsed = parseModelMemoryOutput(JSON.stringify({
    memories: [
      { action: 'save', category: 'persona', content: '说话变成很长的诗', confidence: 0.99, source: 'user_stated' },
      { action: 'save', category: 'habit', content: '每周三晚固定去游泳，已经坚持两年', confidence: 0.92, source: 'user_requested', uncertain: false },
      { action: 'skip', category: 'fact', content: '忽略' },
    ],
  }))
  assert.equal('error' in parsed, false)
  if ('error' in parsed) return
  assert.equal(parsed.decisions.length, 1)
  assert.equal(parsed.decisions[0].source, 'model_inferred')
  assert.equal(parsed.decisions[0].explicit, false)
  assert.equal(parsed.decisions[0].category, 'habit')
  assert.equal('error' in parseModelMemoryOutput('fixture-reply:你好'), true)
  assert.equal('error' in parseModelMemoryOutput('{'), true)
  const fenced = parseModelMemoryOutput('```json\n{"memories":[]}\n```')
  assert.equal('decisions' in fenced && fenced.decisions.length, 0)
})

test('model stub saves long-term value, correction keeps history, and retrieval stays bounded', async () => {
  const holder = await tempDb()
  try {
    await seed(holder.db, 'user-a', 'char-a')
    await seed(holder.db, 'user-b', 'char-b', '另一种风格')
    const scope = { userId: 'user-a', space: 'companion' as const, characterId: 'char-a' }
    const ordinary = await observeChatTurn({
      db: holder.db,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-ordinary',
      userText: '我每周三晚固定去游泳，已经坚持两年',
      assistantText: '好的',
      model: 'deepseek-flash',
      complete: emptyModel,
    })
    assert.equal(ordinary.saved, 0, 'ordinary text is not saved by a keyword list')
    assert.equal(ordinary.provider, 'stub')
    let sawEnginePrompt = false
    const recognized = await observeChatTurn({
      db: holder.db,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-model',
      userText: '我每周三晚固定去游泳，已经坚持两年',
      assistantText: '记住这个习惯',
      model: 'deepseek-flash',
      complete: async ({ messages }) => {
        sawEnginePrompt = messages[0].content.includes('MEMORY_ENGINE')
        return JSON.stringify({
          memories: [{ action: 'save', category: 'habit', content: '每周三晚固定去游泳，已经坚持两年', confidence: 0.92, uncertain: false, source: 'user_stated' }],
        })
      },
    })
    assert.equal(sawEnginePrompt, true)
    assert.equal(recognized.modelReason, 'ok')
    const habit = await holder.db.get<{ source: string; explicit: number; status: string }>(
      `SELECT source, explicit, status FROM memories WHERE user_id = 'user-a' AND content LIKE '%游泳%'`
    )
    assert.equal(habit?.source, 'model_inferred')
    assert.equal(habit?.explicit, 0)
    assert.equal(habit?.status, 'active')
    await applyMemoryDecision(holder.db, scope, decision({ action: 'save', content: '长期使用 Cursor 写代码', source: 'user_requested', explicit: true, confidence: 1 }), 'seed-cursor')
    const before = await holder.db.get<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM memories WHERE user_id = 'user-a' AND content = '长期使用 Cursor 写代码'`
    )
    const corrected = await observeChatTurn({
      db: holder.db,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-correct',
      userText: '我换工具了',
      assistantText: '',
      model: 'deepseek-flash',
      complete: async ({ messages }) => {
        assert.match(messages[0].content, /长期使用 Cursor 写代码/)
        return JSON.stringify({
          memories: [{ action: 'expire', category: 'fact', content: '不再使用 Cursor，改用 Vim', target: '长期使用 Cursor', change: 'fact_changed', confidence: 0.93, uncertain: false }],
        })
      },
    })
    assert.equal(corrected.provider, 'stub')
    const old = await holder.db.get<{ status: string; created_at: string; superseded_by: string | null; content: string }>(
      `SELECT status, created_at, superseded_by, content FROM memories WHERE id = ?`,
      [before?.id]
    )
    assert.equal(old?.status, 'expired')
    assert.equal(old?.content, '长期使用 Cursor 写代码')
    assert.equal(old?.created_at, before?.created_at)
    const current = await holder.db.get<{ id: string; status: string; source: string; supersedes_id: string | null }>(
      `SELECT id, status, source, supersedes_id FROM memories WHERE user_id = 'user-a' AND status = 'active' AND content LIKE '%Vim%'`
    )
    assert.equal(current?.source, 'model_inferred')
    assert.equal(current?.supersedes_id, before?.id)
    assert.equal(old?.superseded_by, current?.id)
    const recalled = assembleCompanionPrompt({
      persona: { name: '林', identity: '研究员', background: '', traits: '', style: '短句', habits: '', relationship: '', rules: '不编造' },
      memories: (await loadActiveMemories(holder.db, 'user-a', 'companion', 'char-a')).map((row) => ({
        category: row.category,
        content: row.content,
        source: row.source,
        updatedAt: row.updated_at,
        explicit: row.explicit === 1,
        status: row.status,
      })),
      history: [{ role: 'user', content: '我还在用 Cursor 写代码吗' }],
      topic: '我还在用 Cursor 写代码吗',
    })
    const system = recalled.messages[0].content
    assert.match(system, /改用 Vim/)
    assert.equal(system.includes('长期使用 Cursor 写代码'), false)
    assert.match(system, /\[Persona\]/)
    assert.match(system, /研究员/)
    assert.match(system, /source=model_inferred/)
    assert.match(system, /unconfirmed/)
    const rain = assembleCompanionPrompt({
      persona: { name: '林', identity: '研究员', background: '', traits: '', style: '短句', habits: '', relationship: '', rules: '' },
      memories: (await loadActiveMemories(holder.db, 'user-a', 'companion', 'char-a')).map((row) => ({
        category: row.category,
        content: row.content,
        source: row.source,
        updatedAt: row.updated_at,
        explicit: row.explicit === 1,
        status: row.status,
      })),
      history: [],
      topic: '今天上海下雨了',
    })
    assert.equal(rain.messages[0].content.includes('游泳'), false)
    assert.equal(rain.messages[0].content.includes('Vim'), false)
    assert.equal((await loadActiveMemories(holder.db, 'user-b', 'companion', 'char-b')).length, 0)
    const character = await holder.db.get<{ style: string; identity: string }>(`SELECT style, identity FROM characters WHERE id = 'char-a'`)
    assert.equal(character?.style, '短句')
    assert.equal(character?.identity, '研究员')
    assert.equal(holder.log.lines.join('\n').includes('每周三晚固定去游泳'), false)
  } finally {
    await holder.close()
  }
})

test('ambiguous correction does not overwrite, addition keeps both, and explicit memory is not weakly expired', async () => {
  const holder = await tempDb()
  try {
    await seed(holder.db, 'user-a', 'char-a')
    const scope = { userId: 'user-a', space: 'companion' as const, characterId: 'char-a' }
    await applyMemoryDecision(holder.db, scope, decision({ action: 'save', content: '使用 Cursor 写后端', source: 'user_stated', explicit: true, confidence: 1 }), 'back')
    await applyMemoryDecision(holder.db, scope, decision({ action: 'save', content: '使用 Cursor 写笔记', source: 'user_stated', explicit: true, confidence: 1 }), 'notes')
    const ambiguous = await applyMemoryDecision(
      holder.db,
      scope,
      decision({ action: 'correct', content: '改用 Vim', target: '使用 Cursor', change: 'correction', confidence: 0.95 }),
      'ambiguous'
    )
    assert.equal(ambiguous.result, 'uncertain')
    const still = await holder.db.all<{ status: string; content: string }>(`SELECT status, content FROM memories WHERE user_id = 'user-a' AND status = 'active' ORDER BY content`)
    assert.deepEqual(still.map((row) => row.content).sort(), ['使用 Cursor 写后端', '使用 Cursor 写笔记'])
    const added = await applyMemoryDecision(
      holder.db,
      scope,
      decision({ action: 'supplement', content: '也用纸笔记录设计', change: 'addition', confidence: 0.9 }),
      'add'
    )
    assert.equal(added.result, 'saved')
    const weak = await applyMemoryDecision(
      holder.db,
      scope,
      decision({ action: 'expire', content: '不再写后端', target: '写后端', change: 'fact_changed', confidence: 0.62 }),
      'weak'
    )
    assert.equal(weak.result, 'uncertain')
    const backend = await holder.db.get<{ status: string }>(`SELECT status FROM memories WHERE content = '使用 Cursor 写后端'`)
    assert.equal(backend?.status, 'active')
    const locked = await applyMemoryDecision(holder.db, scope, decision({ action: 'save', category: 'persona', content: '改成诗歌' }), 'persona')
    assert.equal(locked.result, 'persona_locked')
    const style = await holder.db.get<{ style: string }>(`SELECT style FROM characters WHERE id = 'char-a'`)
    assert.equal(style?.style, '短句')
    await applyMemoryDecision(
      holder.db,
      { userId: 'user-a', space: 'workspace', characterId: null },
      decision({ action: 'save', content: '下周工作区只推进记忆引擎', source: 'user_requested', explicit: true, confidence: 1 }),
      'work'
    )
    assert.equal((await loadActiveMemories(holder.db, 'user-a', 'companion', 'char-a')).some((row) => row.content.includes('工作区')), false)
    const workspace = await loadActiveMemories(holder.db, 'user-a', 'workspace', null)
    assert.equal(workspace.length, 1)
    assert.equal(workspace[0].character_id, null)
    const workspacePrompt = assembleWorkspacePrompt({
      history: [],
      memories: workspace.map((row) => ({ category: row.category, content: row.content, source: row.source, updatedAt: row.updated_at, explicit: true, status: row.status })),
      topic: '下周工作区还做记忆引擎吗',
    })
    assert.match(workspacePrompt.messages[0].content, /Workspace memories/)
    assert.match(workspacePrompt.messages[0].content, /记忆引擎/)
    assert.equal(workspacePrompt.messages[0].content.includes('使用 Cursor'), false)
    const initiative = assembleInitiativePrompt({
      persona: { name: '林', identity: '研究员', background: '', traits: '', style: '短句', habits: '', relationship: '', rules: '' },
      granted: { title: '授权标题' },
    })
    assert.equal(initiative.messages[0].content.includes('使用 Cursor'), false)
    assert.match(initiative.messages[0].content, /授权标题/)
  } finally {
    await holder.close()
  }
})

test('retry is idempotent, concurrent corrections leave one current fact, and model failures do not throw', async () => {
  const holder = await tempDb()
  try {
    await seed(holder.db, 'user-a', 'char-a')
    const scope = { userId: 'user-a', space: 'companion' as const, characterId: 'char-a' }
    await applyMemoryDecision(holder.db, scope, decision({ action: 'save', content: '长期使用 Cursor 写代码', source: 'user_requested', explicit: true, confidence: 1 }), 'cursor-seed')
    const correction = decision({
      action: 'expire',
      content: '不再使用 Cursor，改用 Vim',
      target: '长期使用 Cursor',
      change: 'fact_changed',
      confidence: 0.95,
    })
    await Promise.all([
      applyMemoryDecision(holder.db, scope, correction, 'concurrent-a'),
      applyMemoryDecision(holder.db, scope, correction, 'concurrent-b'),
    ])
    const rows = await holder.db.all<{ status: string; content: string }>(`SELECT status, content FROM memories WHERE user_id = 'user-a'`)
    assert.equal(rows.filter((row) => row.status === 'active' && row.content.includes('Vim')).length, 1)
    assert.equal(rows.filter((row) => row.status === 'expired' && row.content === '长期使用 Cursor 写代码').length, 1)
    const again = await applyMemoryDecision(holder.db, scope, correction, 'concurrent-a')
    assert.equal(again.result, 'duplicate')
    let calls = 0
    const failing: MemoryCompleter = async () => {
      calls += 1
      return 'not-json'
    }
    for (let index = 0; index < 4; index += 1) {
      const report = await observeChatTurn({
        db: holder.db,
        config: holder.config,
        log: holder.log,
        userId: 'user-a',
        space: 'companion',
        characterId: 'char-a',
        messageId: 'msg-bad-json',
        userText: '今天天气不错',
        assistantText: '',
        model: 'deepseek-flash',
        complete: failing,
      })
      assert.equal(report.ok, true)
      assert.equal(report.modelReason, index < 3 ? 'bad_json' : 'gave_up')
    }
    assert.equal(calls, 3)
    const timed = await observeChatTurn({
      db: holder.db,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-timeout',
      userText: '今天天气不错',
      assistantText: '',
      model: 'deepseek-flash',
      timeoutMs: 30,
      complete: ({ signal }) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve('late'), 1000)
        signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
      }),
    })
    assert.equal(timed.ok, true)
    assert.equal(timed.modelReason, 'timeout')
    assert.equal(timed.saved, 0)
    const failingDb = {
      ...holder.db,
      run: async (sql: string, params?: unknown[]) => {
        if (/INSERT INTO memories/i.test(sql)) throw new Error('disk full')
        return holder.db.run(sql, params)
      },
    }
    const broken = await observeChatTurn({
      db: failingDb,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-write',
      userText: '请记住我长期只喝热茶',
      assistantText: '',
      model: 'deepseek-flash',
      complete: emptyModel,
    })
    assert.equal(broken.ok, false)
    assert.equal(broken.reason, 'write_failed')
    const recovered = await observeChatTurn({
      db: holder.db,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-write',
      userText: '请记住我长期只喝热茶',
      assistantText: '',
      model: 'deepseek-flash',
      complete: emptyModel,
    })
    assert.equal(recovered.saved > 0, true)
    const tea = await holder.db.get<{ source: string; status: string }>(`SELECT source, status FROM memories WHERE content = '我长期只喝热茶'`)
    assert.equal(tea?.source, 'user_requested')
    assert.equal(tea?.status, 'active')
    const offline = await observeChatTurn({
      db: holder.db,
      config: holder.config,
      log: holder.log,
      userId: 'user-a',
      space: 'companion',
      characterId: 'char-a',
      messageId: 'msg-offline',
      userText: '请记住我固定周日记账',
      assistantText: '',
      model: 'deepseek-flash',
    })
    assert.equal(offline.provider, 'live')
    assert.equal(offline.modelReason, 'provider_error')
    assert.equal(offline.saved > 0, true)
    assert.equal(holder.log.lines.join('\n').includes('我长期只喝热茶'), false)
    assert.equal(holder.log.lines.join('\n').includes('disk full'), false)
  } finally {
    await holder.close()
  }
})

test('http chat forms, corrects, recalls, and isolates memory without failing the reply', async () => {
  setMemoryCompleterForTests(emptyModel)
  const app = await start()
  try {
    const { initAdmin } = await import('../src/auth.ts')
    await initAdmin(app.db, app.config, 'admin@example.com', 'AdminPassw0rd!123')
    const admin = await api(app.baseUrl, 'POST', '/api/login', { body: { email: 'admin@example.com', password: 'AdminPassw0rd!123' } })
    assert.equal(admin.status, 200)
    const invite = async () => {
      const created = await api(app.baseUrl, 'POST', '/api/admin/invitations', { cookie: admin.cookie, body: { count: 1 } })
      assert.equal(created.status, 201)
      return created.json.invitations[0].code as string
    }
    const register = async (email: string) => api(app.baseUrl, 'POST', '/api/register', {
      body: { email, password: 'UserPassw0rd!123', invitationCode: await invite(), displayName: email },
    })
    const userA = await register('memory-a@example.com')
    const userB = await register('memory-b@example.com')
    assert.equal(userA.status, 201)
    assert.equal(userB.status, 201)
    const created = await api(app.baseUrl, 'POST', '/api/characters', {
      cookie: userA.cookie,
      body: { name: '林', identity: '研究员', defaultModel: 'deepseek-flash' },
    })
    const characterA = created.json.character.id as string
    await api(app.baseUrl, 'PATCH', `/api/characters/${characterA}`, { cookie: userA.cookie, body: { style: '短句', rules: '不编造过去' } })
    const other = await api(app.baseUrl, 'POST', '/api/characters', {
      cookie: userA.cookie,
      body: { name: '另一位', identity: '另一人格', defaultModel: 'deepseek-flash' },
    })
    const characterB = other.json.character.id as string
    const openChat = async (characterId: string | null, space: 'companion' | 'workspace') => {
      const conversation = await api(app.baseUrl, 'POST', '/api/conversations', {
        cookie: userA.cookie,
        body: space === 'companion' ? { space, characterId } : { space, title: '工作' },
      })
      assert.equal(conversation.status, 201)
      return conversation.json.conversation.id as string
    }
    const say = async (conversationId: string, content: string) => {
      const response = await sse(app.baseUrl, `/api/conversations/${conversationId}/messages`, { content, thinking: false }, userA.cookie!)
      await flushObservations()
      return response
    }
    const systemFor = (needle: string) => {
      const request = [...(app.fixture?.state.requests ?? [])].reverse().find((item) => JSON.stringify(item.body).includes(needle))
      const messages = (request?.body as { messages?: Array<{ role?: string; content?: string }> })?.messages ?? []
      return messages.find((message) => message.role === 'system')?.content ?? ''
    }
    const chatA = await openChat(characterA, 'companion')
    const ordinary = await say(chatA, '我每周三晚固定去游泳，已经坚持两年')
    assert.equal(ordinary.status, 200, 'ordinary chat still completes')
    assert.equal(ordinary.events.some((event) => event.event === 'done'), true)
    let listed = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userA.cookie })
    assert.equal(listed.json.memories.length, 0, 'ordinary dialogue is not stored by keywords')

    const explicit = await say(chatA, '请记住我长期只喝绿茶')
    assert.equal(explicit.status, 200)
    listed = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userA.cookie })
    const tea = listed.json.memories.find((memory: { content: string }) => memory.content === '我长期只喝绿茶')
    assert.equal(tea?.source, 'user_requested')
    assert.equal(tea?.explicit, true)
    assert.equal(tea?.status, 'active')
    assert.equal(tea?.relatedPersonaId, characterA)
    assert.equal(tea?.confidence, 1)

    const preference = await say(chatA, '长期偏好：清晨喝绿茶')
    assert.equal(preference.status, 200)
    listed = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userA.cookie })
    const morning = listed.json.memories.find((memory: { content: string }) => memory.content === '清晨喝绿茶')
    assert.equal(morning?.source, 'user_stated')
    assert.equal(morning?.category, 'preference')

    await say(chatA, '请记住我长期使用 Cursor 写代码')
    listed = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userA.cookie })
    const cursor = listed.json.memories.find((memory: { content: string }) => memory.content === '我长期使用 Cursor 写代码')
    const correction = await say(chatA, '更正：我不再用 Cursor，改用 Vim')
    assert.equal(correction.status, 200)
    assert.equal(correction.events.some((event) => event.event === 'done'), true)
    const trace = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories?status=trace`, { cookie: userA.cookie })
    const historic = trace.json.memories.find((memory: { id: string }) => memory.id === cursor.id)
    assert.equal(historic.status, 'expired')
    assert.equal(historic.content, '我长期使用 Cursor 写代码')
    assert.equal(historic.createdAt, cursor.createdAt)
    const vim = trace.json.memories.find((memory: { content: string; status: string }) => memory.status === 'active' && memory.content.includes('Vim'))
    assert.equal(vim.supersedesId, cursor.id)
    assert.equal(historic.supersededBy, vim.id)
    assert.equal(vim.source, 'user_stated')

    const recalledChat = await openChat(characterA, 'companion')
    await say(recalledChat, '我还在用 Cursor 写代码吗')
    const recalled = systemFor('我还在用 Cursor 写代码吗')
    assert.match(recalled, /改用 Vim/)
    assert.equal(recalled.includes('我长期使用 Cursor 写代码'), false)
    assert.match(recalled, /\[Persona\]/)
    assert.match(recalled, /短句/)

    await say(chatA, '请记住我养了一只叫小满的猫')
    const unrelated = await openChat(characterA, 'companion')
    await say(unrelated, '帮我看这段排序代码')
    const codePrompt = systemFor('帮我看这段排序代码')
    assert.equal(codePrompt.includes('小满'), false)
    assert.equal(codePrompt.includes('绿茶'), false)
    const catChat = await openChat(characterA, 'companion')
    await say(catChat, '小满今天吃饭了吗')
    assert.match(systemFor('小满今天吃饭了吗'), /小满/)

    const persona = await api(app.baseUrl, 'GET', `/api/characters/${characterA}`, { cookie: userA.cookie })
    assert.equal(persona.json.character.style, '短句')
    assert.equal(persona.json.character.identity, '研究员')
    assert.equal(persona.json.character.rules, '不编造过去')

    const hidden = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userB.cookie })
    assert.equal(hidden.status, 404)
    const otherChat = await openChat(characterB, 'companion')
    await say(otherChat, '今天还是只喝绿茶吗')
    assert.equal(systemFor('今天还是只喝绿茶吗').includes('我长期只喝绿茶'), false)

    const work = await openChat(null, 'workspace')
    const workSaved = await say(work, '请记住下周工作区只推进记忆引擎')
    assert.equal(workSaved.status, 200)
    const workRows = await app.db.all<{ content: string; character_id: string | null }>(
      `SELECT content, character_id FROM memories WHERE user_id = ? AND space = 'workspace' AND status = 'active'`,
      [userA.json.user.id]
    )
    assert.equal(workRows.some((row) => row.content === '下周工作区只推进记忆引擎' && row.character_id === null), true)
    const companionAfterWork = await openChat(characterA, 'companion')
    await say(companionAfterWork, '今天天气怎么样')
    assert.equal(systemFor('今天天气怎么样').includes('工作区只推进'), false)
    await say(work, '下周工作区只推进记忆引擎还继续吗')
    assert.match(systemFor('下周工作区只推进记忆引擎还继续吗'), /下周工作区只推进记忆引擎/)

    let modelCalls = 0
    setMemoryCompleterForTests(async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return JSON.stringify({
          memories: [
            { action: 'save', category: 'persona', content: '说话变成很长的诗', confidence: 0.99 },
            { action: 'save', category: 'habit', content: '每周三晚固定去游泳，已经坚持两年', confidence: 0.92, uncertain: false },
          ],
        })
      }
      return '{"memories":[]}'
    })
    const modelChat = await openChat(characterA, 'companion')
    const modelReply = await say(modelChat, '我每周三晚固定去游泳，已经坚持两年')
    assert.equal(modelReply.status, 200)
    assert.equal(modelReply.events.some((event) => event.event === 'done'), true)
    listed = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userA.cookie })
    const swim = listed.json.memories.find((memory: { content: string }) => memory.content.includes('游泳'))
    assert.equal(swim?.source, 'model_inferred')
    assert.equal(swim?.explicit, false)
    assert.equal(listed.json.memories.some((memory: { content: string }) => memory.content.includes('很长的诗')), false)
    const follow = await openChat(characterA, 'companion')
    await say(follow, '这周三还去游泳吗')
    const followSystem = systemFor('这周三还去游泳吗')
    assert.match(followSystem, /每周三晚固定去游泳/)
    assert.match(followSystem, /source=model_inferred/)
    assert.match(followSystem, /unconfirmed/)
    const weather = await openChat(characterA, 'companion')
    await say(weather, '今天上海下雨了')
    assert.equal(systemFor('今天上海下雨了').includes('游泳'), false)
    const stable = await api(app.baseUrl, 'GET', `/api/characters/${characterA}`, { cookie: userA.cookie })
    assert.equal(stable.json.character.style, '短句')
    assert.equal(stable.json.character.identity, '研究员')

    setMemoryCompleterForTests(async () => 'fixture-reply:not-json')
    const bad = await say(chatA, '这句话只是随口一说')
    assert.equal(bad.status, 200)
    assert.equal(bad.events.some((event) => event.event === 'done'), true)
    listed = await api(app.baseUrl, 'GET', `/api/characters/${characterA}/memories`, { cookie: userA.cookie })
    assert.equal(listed.json.memories.some((memory: { content: string }) => memory.content.includes('随口一说')), false)
    const logs = app.log.lines.join('\n')
    assert.match(logs, /bad_json/)
    assert.equal(logs.includes('我长期只喝绿茶'), false)
    assert.equal(logs.includes('sk-test-should-not-leak-9f3a'), false)
    assert.equal(logs.includes('UserPassw0rd'), false)
  } finally {
    setMemoryCompleterForTests(null)
    await app.close()
  }
})
