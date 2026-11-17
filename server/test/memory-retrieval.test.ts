import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig, type AppConfig } from '../src/config.ts'
import { migrate, migrationSql, one, openDatabase, run, type SqlDb } from '../src/db.ts'
import {
  contentHash,
  cosine,
  embeddingPlan,
  encodeVector,
  normalizeVector,
  setTestEmbedder,
  type Embedder,
} from '../src/embedding.ts'
import { createLogger } from '../src/log.ts'
import { applyMemoryDecision, type MemoryDecision } from '../src/memory-engine.ts'
import { selectPromptMemories } from '../src/memory-retrieval.ts'
import { assembleCompanionPrompt } from '../src/prompt.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const migrations = path.join(root, 'server/migrations')
const tea = normalizeVector(Float32Array.from([1, 0, 0, 0]))
const other = normalizeVector(Float32Array.from([0, 1, 0, 0]))

function decision(partial: Partial<MemoryDecision> & Pick<MemoryDecision, 'action' | 'content'>): MemoryDecision {
  return {
    category: 'preference',
    target: '',
    change: null,
    confidence: 0.95,
    uncertain: false,
    source: 'user_stated',
    explicit: true,
    ...partial,
  }
}

function configFor(databasePath: string, extra: Partial<AppConfig> = {}): AppConfig {
  return loadConfig(
    { NODE_ENV: 'test' },
    {
      nodeEnv: 'test',
      gatewayMode: 'live',
      deepseekApiKey: null,
      databaseUrl: null,
      databasePath,
      dataDir: path.dirname(databasePath),
      initiativePollMs: 0,
      embeddingMode: 'off',
      embeddingTimeoutMs: 2000,
      ...extra,
    }
  )
}

async function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-retrieval-'))
  const db = openDatabase({ databaseUrl: null, databasePath: path.join(dir, 'app.sqlite') })
  await migrate(db)
  return { dir, db, config: configFor(path.join(dir, 'app.sqlite')), close: async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

async function seed(db: SqlDb, userId: string, characterId: string) {
  const at = '2024-01-01T00:00:00.000Z'
  await db.run(
    `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, 'hash', 'user', 'user', ?, ?)`,
    [userId, `${userId}@example.com`, at, at]
  )
  await db.run(
    `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
     VALUES (?, ?, '林', '', '研究员', '', '', '短句', '', '', '不编造', 'deepseek-flash', 0, ?, ?)`,
    [characterId, userId, at, at]
  )
}

async function remember(db: SqlDb, row: { id: string; userId: string; characterId: string | null; content: string; space?: 'companion' | 'workspace'; status?: string; explicit?: number; updatedAt?: string }) {
  const at = row.updatedAt ?? '2024-06-01T00:00:00.000Z'
  const space = row.space ?? 'companion'
  await run(
    db,
    `INSERT INTO memories (
      id, user_id, character_id, category, content, source, explicit, note, status,
      created_at, updated_at, last_confirmed_at, confidence, supersedes_id, superseded_by, space
    ) VALUES (?, ?, ?, 'preference', ?, 'user_stated', ?, '', ?, ?, ?, ?, 1, NULL, NULL, ?)`,
    row.id,
    row.userId,
    row.characterId,
    row.content,
    row.explicit ?? 1,
    row.status ?? 'active',
    at,
    at,
    at,
    space
  )
}

function stubEmbedder(options?: { hang?: boolean; fail?: boolean }): Embedder & { calls: string[] } {
  const calls: string[] = []
  return {
    model: 'stub-model',
    dimensions: 4,
    version: 'stub-v1',
    calls,
    async embed(text, kind, signal) {
      calls.push(`${kind}:${text}`)
      if (signal.aborted) throw Object.assign(new Error('timeout'), { code: 'timeout' })
      if (options?.fail) throw Object.assign(new Error('embed failed'), { code: 'error' })
      if (options?.hang) {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(tea), 30_000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('timeout'), { code: 'timeout' }))
          })
        })
      }
      if (text.includes('绿茶') || text.includes('适合我口味')) return tea
      return other
    },
  }
}

function scope(userId: string, characterId: string | null, space: 'companion' | 'workspace' = 'companion') {
  return { userId, space, characterId }
}

test('local embedding is the default and an explicit off stays lexical', () => {
  const local = loadConfig({ NODE_ENV: 'test' })
  assert.equal(local.embeddingMode, 'local')
  assert.deepEqual(embeddingPlan(local), { kind: 'local' })
  const off = loadConfig({ EMBEDDING_MODE: 'off' })
  assert.equal(off.embeddingMode, 'off')
  assert.deepEqual(embeddingPlan(off), { kind: 'off', reason: 'unconfigured' })
  assert.throws(() => loadConfig({ EMBEDDING_MODE: 'deepseek' }), /EMBEDDING_MODE/)
  const deepseek = loadConfig({
    EMBEDDING_MODE: 'http',
    EMBEDDING_BASE_URL: 'https://api.deepseek.com/v1',
    EMBEDDING_API_KEY: 'sk-test-not-sent',
    EMBEDDING_MODEL: 'text-embedding-v3',
  })
  assert.deepEqual(embeddingPlan(deepseek), { kind: 'off', reason: 'deepseek_has_no_embeddings' })
  const missing = loadConfig({ EMBEDDING_MODE: 'http', EMBEDDING_BASE_URL: 'https://embed.example.test' })
  assert.deepEqual(embeddingPlan(missing), { kind: 'off', reason: 'unconfigured' })
})

test('unconfigured retrieval does not treat a paraphrase as a keyword hit', async () => {
  const holder = await tempDb()
  setTestEmbedder(null)
  try {
    await seed(holder.db, 'user-a', 'char-a')
    await remember(holder.db, { id: 'tea', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好绿茶' })
    const log = createLogger(() => {})
    const found = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.equal(found.mode, 'lexical')
    assert.equal(found.memories.some((memory) => memory.content.includes('绿茶')), false)
    assert.equal(log.lines.join('\n').includes('绿茶'), false)
  } finally {
    setTestEmbedder(null)
    await holder.close()
  }
})

test('stubbed hybrid retrieval isolates scope, drops stale rows, and degrades without failing', async () => {
  const holder = await tempDb()
  const embedder = stubEmbedder()
  setTestEmbedder(embedder)
  const log = createLogger(() => {})
  try {
    await seed(holder.db, 'user-a', 'char-a')
    await seed(holder.db, 'user-b', 'char-b')
    await holder.db.run(
      `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
       VALUES ('char-b2', 'user-a', '乙', '', '研究员', '', '', '短句', '', '', '', 'deepseek-flash', 0, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
    )
    await remember(holder.db, { id: 'tea', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好绿茶', updatedAt: '2024-06-02T00:00:00.000Z' })
    await remember(holder.db, { id: 'other-character', userId: 'user-a', characterId: 'char-b2', content: '角色乙长期偏好绿茶' })
    await remember(holder.db, { id: 'other-user', userId: 'user-b', characterId: 'char-b', content: '其他用户长期偏好绿茶' })
    await remember(holder.db, { id: 'workspace-tea', userId: 'user-a', characterId: null, content: '工作区长期偏好绿茶', space: 'workspace' })
    await remember(holder.db, { id: 'expired', userId: 'user-a', characterId: 'char-a', content: '过期的绿茶偏好', status: 'expired' })
    await remember(holder.db, { id: 'uncertain', userId: 'user-a', characterId: 'char-a', content: '不确定的绿茶偏好', status: 'uncertain' })
    await remember(holder.db, { id: 'suggested', userId: 'user-a', characterId: 'char-a', content: '建议中的绿茶偏好', status: 'suggested' })
    await remember(holder.db, { id: 'meeting', userId: 'user-a', characterId: 'char-a', content: '周三有项目会', explicit: 0 })
    const empty = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-c', 'missing'), topic: '给我推荐一种适合我口味的饮品' })
    assert.deepEqual(empty.memories, [])
    assert.equal(empty.mode, 'lexical')
    assert.equal(embedder.calls.length, 0)

    const found = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.equal(found.mode, 'hybrid')
    assert.equal(found.model, 'stub-model')
    assert.equal(found.dimensions, 4)
    assert.equal(found.version, 'stub-v1')
    const contents = found.memories.map((memory) => memory.content)
    assert.deepEqual(contents, ['用户长期偏好绿茶'])
    assert.equal(log.lines.join('\n').includes('绿茶'), false)
    assert.equal(log.lines.join('\n').includes('适合我口味'), false)

    const again = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.deepEqual(again.memories.map((memory) => memory.content), ['用户长期偏好绿茶'])
    const stored = await one<{ version: string; dimensions: number; content_hash: string }>(holder.db, `SELECT version, dimensions, content_hash FROM memory_embeddings WHERE memory_id = 'tea'`)
    assert.equal(stored?.version, 'stub-v1')
    assert.equal(stored?.dimensions, 4)
    assert.equal(stored?.content_hash, contentHash('stub-v1', '用户长期偏好绿茶'))

    const workspace = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', null, 'workspace'), topic: '给我推荐一种适合我口味的饮品' })
    assert.deepEqual(workspace.memories.map((memory) => memory.content), ['工作区长期偏好绿茶'])
    const isolated = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-b', 'char-b'), topic: '给我推荐一种适合我口味的饮品' })
    assert.deepEqual(isolated.memories.map((memory) => memory.content), ['其他用户长期偏好绿茶'])

    await run(holder.db, `UPDATE memories SET content = ?, updated_at = ? WHERE id = 'tea'`, '用户喜欢开车去远方', '2024-07-01T00:00:00.000Z')
    const stale = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.equal(stale.memories.some((memory) => memory.content.includes('开车')), false)
    assert.equal(stale.memories.some((memory) => memory.content.includes('绿茶')), false)
    const rewritten = await one<{ content_hash: string }>(holder.db, `SELECT content_hash FROM memory_embeddings WHERE memory_id = 'tea'`)
    assert.equal(rewritten?.content_hash, contentHash('stub-v1', '用户喜欢开车去远方'))

    await run(holder.db, `UPDATE memories SET content = ? WHERE id = 'tea'`, '用户长期偏好绿茶')
    await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    await run(holder.db, `DELETE FROM memories WHERE id = 'tea'`)
    const gone = await one(holder.db, `SELECT memory_id FROM memory_embeddings WHERE memory_id = 'tea'`)
    assert.equal(gone, undefined)

    const beforeBlank = embedder.calls.length
    const blank = await selectPromptMemories(holder.db, holder.config, log, scope('user-a', 'char-a'))
    assert.equal(blank.mode, 'lexical')
    assert.equal(embedder.calls.length, beforeBlank)
  } finally {
    setTestEmbedder(null)
    await holder.close()
  }
})

test('backfill is bounded and a repeated upsert stays one row', async () => {
  const holder = await tempDb()
  const embedder = stubEmbedder()
  setTestEmbedder(embedder)
  try {
    await seed(holder.db, 'user-a', 'char-a')
    await remember(holder.db, { id: 'tea', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好绿茶', updatedAt: '2024-08-01T00:00:00.000Z' })
    for (let index = 0; index < 10; index += 1) {
      await remember(holder.db, {
        id: `fill-${index}`,
        userId: 'user-a',
        characterId: 'char-a',
        content: `填充记录甲${index}`,
        updatedAt: `2024-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
    }
    const log = createLogger(() => {})
    await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    const first = await one<{ count: number }>(holder.db, `SELECT count(*) AS count FROM memory_embeddings`)
    assert.equal(Number(first?.count), 8)
    await Promise.all([
      selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' }),
      selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' }),
    ])
    const teaRows = await one<{ count: number }>(holder.db, `SELECT count(*) AS count FROM memory_embeddings WHERE memory_id = 'tea'`)
    assert.equal(Number(teaRows?.count), 1)
    await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    const done = await one<{ count: number }>(holder.db, `SELECT count(*) AS count FROM memory_embeddings`)
    assert.equal(Number(done?.count), 11)
  } finally {
    setTestEmbedder(null)
    await holder.close()
  }
})

test('embedding timeout or failure falls back to lexical search and does not throw', async () => {
  const holder = await tempDb()
  const log = createLogger(() => {})
  try {
    await seed(holder.db, 'user-a', 'char-a')
    await remember(holder.db, { id: 'tea', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好绿茶' })
    await remember(holder.db, { id: 'vim', userId: 'user-a', characterId: 'char-a', content: '改用 Vim 写代码' })
    setTestEmbedder(stubEmbedder({ hang: true }))
    const slow = configFor(path.join(holder.dir, 'app.sqlite'), { embeddingTimeoutMs: 40 })
    const timed = await selectPromptMemories(holder.db, slow, log, { ...scope('user-a', 'char-a'), topic: '我还在用 Vim 写代码吗' })
    assert.equal(timed.degraded, 'timeout')
    assert.equal(timed.mode, 'lexical')
    assert.equal(timed.memories.some((memory) => memory.content.includes('Vim')), true)
    assert.equal(log.lines.join('\n').includes('绿茶'), false)
    assert.equal(log.lines.join('\n').includes('Vim'), false)

    setTestEmbedder(stubEmbedder({ fail: true }))
    const failed = await selectPromptMemories(holder.db, holder.config, log, { ...scope('user-a', 'char-a'), topic: '我还在用 Vim 写代码吗' })
    assert.equal(failed.degraded, 'error')
    assert.equal(failed.memories.some((memory) => memory.content.includes('Vim')), true)
  } finally {
    setTestEmbedder(null)
    await holder.close()
  }
})

test('correction deletes the old vector, and a ranked prompt keeps persona separate', async () => {
  const holder = await tempDb()
  setTestEmbedder(stubEmbedder())
  try {
    await seed(holder.db, 'user-a', 'char-a')
    const scopeA = { userId: 'user-a', space: 'companion' as const, characterId: 'char-a' }
    const saved = await applyMemoryDecision(holder.db, scopeA, decision({ action: 'save', content: '用户长期偏好绿茶' }), 'save-tea')
    assert.equal(saved.result, 'saved')
    const log = createLogger(() => {})
    await selectPromptMemories(holder.db, holder.config, log, { ...scopeA, topic: '给我推荐一种适合我口味的饮品' })
    const corrected = await applyMemoryDecision(
      holder.db,
      scopeA,
      decision({ action: 'expire', content: '用户现在改喝红茶', target: '绿茶', change: 'fact_changed' }),
      'correct-tea'
    )
    assert.equal(corrected.result, 'expired')
    const oldVector = await one(holder.db, `SELECT memory_id FROM memory_embeddings WHERE memory_id = ?`, corrected.previousId)
    assert.equal(oldVector, undefined)
    const current = await selectPromptMemories(holder.db, holder.config, log, { ...scopeA, topic: '给我推荐一种适合我口味的饮品' })
    assert.equal(current.memories.some((memory) => memory.content.includes('绿茶')), false)
    assert.equal(current.memories.some((memory) => memory.content.includes('红茶')), true)
    const active = await one<{ content: string; updated_at: string }>(holder.db, `SELECT content, updated_at FROM memories WHERE user_id = 'user-a' AND status = 'active'`)
    const prompt = assembleCompanionPrompt({
      persona: { name: '林', identity: '研究员', background: '', traits: '', style: '短句', habits: '', relationship: '', rules: '不编造' },
      memories: [{ category: 'preference', content: active!.content, source: 'user_stated', updatedAt: active!.updated_at, explicit: true, status: 'active' }],
      history: [{ role: 'user', content: '给我推荐一种适合我口味的饮品' }],
      topic: '给我推荐一种适合我口味的饮品',
      ranked: true,
    })
    const [persona, memories] = prompt.messages[0].content.split('[Memories]')
    assert.match(persona, /\[Persona\]/)
    assert.match(persona, /研究员/)
    assert.equal(persona.includes('红茶'), false)
    assert.match(memories, /红茶/)
  } finally {
    setTestEmbedder(null)
    await holder.close()
  }
})

test('sqlite migration adds embedding storage without rewriting memories or wallets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-embed-migrate-'))
  const db = openDatabase({ databaseUrl: null, databasePath: path.join(dir, 'app.sqlite') })
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
    for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql') && name <= '003_memory_engine.sql').sort()) {
      await db.exec(migrationSql(fs.readFileSync(path.join(migrations, file), 'utf8'), 'sqlite'))
      await db.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, [file, '2020-01-01T00:00:00.000Z'])
    }
    await run(
      db,
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at)
       VALUES ('old-user', 'old@example.com', 'scrypt-keep', 'Old', 'user', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, NULL)`
    )
    await run(
      db,
      `INSERT INTO memories (
        id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at, confidence, space
      ) VALUES ('mem-old', 'old-user', NULL, 'fact', 'OLD_MEMORY_KEEP', 'user-note', 1, '', 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 1, 'workspace')`
    )
    const ran = await migrate(db)
    assert.deepEqual(ran, ['004_wallet.sql', '005_memory_embeddings.sql'])
    const memory = await one<{ content: string }>(db, `SELECT content FROM memories WHERE id = 'mem-old'`)
    assert.equal(memory?.content, 'OLD_MEMORY_KEEP')
    const wallet = await one<{ available_fen: number }>(db, `SELECT available_fen FROM wallets WHERE user_id = 'old-user'`)
    assert.equal(wallet?.available_fen, 0)
    const table = await one<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE name = 'memory_embeddings'`)
    assert.equal(table?.name, 'memory_embeddings')
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('postgres keeps the old memory and stores one vector per memory', async () => {
  const name = `embed_${process.pid}_${Date.now().toString(36)}`
  const adminUrl = 'postgresql://ubuntu@/postgres?host=/var/run/postgresql'
  execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`], { stdio: 'pipe' })
  const db = openDatabase({ databaseUrl: `postgresql://ubuntu@/${name}?host=/var/run/postgresql`, databasePath: '' })
  setTestEmbedder(stubEmbedder())
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
    for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql') && name <= '003_memory_engine.sql').sort()) {
      await db.exec(migrationSql(fs.readFileSync(path.join(migrations, file), 'utf8'), 'postgres'))
      await db.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, [file, '2020-01-01T00:00:00.000Z'])
    }
    await run(
      db,
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at)
       VALUES ('old-user', 'old@example.com', 'scrypt-keep', 'Old', 'user', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, NULL)`
    )
    await run(
      db,
      `INSERT INTO memories (
        id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at, confidence, space
      ) VALUES ('mem-old', 'old-user', NULL, 'fact', 'OLD_MEMORY_KEEP', 'user-note', 1, '', 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 1, 'workspace')`
    )
    const ran = await migrate(db)
    assert.deepEqual(ran, ['004_wallet.sql', '005_memory_embeddings.sql'])
    await seed(db, 'user-a', 'char-a')
    await remember(db, { id: 'tea', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好绿茶' })
    const config = loadConfig({ NODE_ENV: 'test' }, { nodeEnv: 'test', databaseUrl: `postgresql://ubuntu@/${name}?host=/var/run/postgresql`, databasePath: '', embeddingMode: 'off', initiativePollMs: 0 })
    const log = createLogger(() => {})
    await Promise.all([
      selectPromptMemories(db, config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' }),
      selectPromptMemories(db, config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' }),
    ])
    const found = await selectPromptMemories(db, config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.deepEqual(found.memories.map((memory) => memory.content), ['用户长期偏好绿茶'])
    const count = await one<{ count: number }>(db, `SELECT count(*) AS count FROM memory_embeddings WHERE memory_id = 'tea'`)
    assert.equal(Number(count?.count), 1)
    const kept = await one<{ content: string; password_hash: string }>(
      db,
      `SELECT memories.content, users.password_hash FROM memories JOIN users ON users.id = memories.user_id WHERE memories.id = 'mem-old'`
    )
    assert.equal(kept?.content, 'OLD_MEMORY_KEEP')
    assert.equal(kept?.password_hash, 'scrypt-keep')
    const roundTrip = cosine(tea, normalizeVector(Float32Array.from(tea)))
    assert.ok(roundTrip > 0.99)
    assert.equal(encodeVector(tea).length > 0, true)
  } finally {
    setTestEmbedder(null)
    await db.close()
    execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${name} WITH (FORCE)`], { stdio: 'pipe' })
  }
})

test('http embeddings are optional and a DeepSeek URL is never called', async () => {
  const holder = await tempDb()
  setTestEmbedder(null)
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push(`${req.url} ${body}`)
      const input = JSON.parse(body).input as string
      const embedding = input.includes('绿茶') || input.includes('适合我口味') ? [1, 0, 0, 0] : [0, 1, 0, 0]
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ embedding }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  const original = globalThis.fetch
  let remoteCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('api.deepseek.com')) remoteCalls += 1
    return original(input, init)
  }
  try {
    await seed(holder.db, 'user-a', 'char-a')
    await remember(holder.db, { id: 'tea', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好绿茶' })
    await remember(holder.db, { id: 'juice', userId: 'user-a', characterId: 'char-a', content: '用户长期偏好橙汁' })
    const config = configFor(path.join(holder.dir, 'app.sqlite'), {
      embeddingMode: 'http',
      embeddingBaseUrl: `http://127.0.0.1:${address.port}`,
      embeddingApiKey: 'sk-test-embed-key',
      embeddingModel: 'test-embed',
    })
    const log = createLogger(() => {})
    const found = await selectPromptMemories(holder.db, config, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.equal(found.mode, 'hybrid')
    assert.equal(found.model, 'test-embed')
    assert.deepEqual(found.memories.map((memory) => memory.content), ['用户长期偏好绿茶'])
    assert.equal(seen.some((line) => line.includes('/embeddings')), true)
    assert.equal(log.lines.join('\n').includes('sk-test-embed-key'), false)
    assert.equal(log.lines.join('\n').includes('绿茶'), false)

    const blocked = configFor(path.join(holder.dir, 'app.sqlite'), {
      embeddingMode: 'http',
      embeddingBaseUrl: 'https://api.deepseek.com/v1',
      embeddingApiKey: 'sk-test-not-sent',
      embeddingModel: 'text-embedding-v3',
      embeddingTimeoutMs: 200,
    })
    const started = Date.now()
    const lexical = await selectPromptMemories(holder.db, blocked, log, { ...scope('user-a', 'char-a'), topic: '给我推荐一种适合我口味的饮品' })
    assert.equal(lexical.mode, 'lexical')
    assert.equal(remoteCalls, 0)
    assert.ok(Date.now() - started < 500)
    assert.equal(log.lines.join('\n').includes('sk-test-not-sent'), false)
  } finally {
    globalThis.fetch = original
    setTestEmbedder(null)
    server.close()
    await holder.close()
  }
})
