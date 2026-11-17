import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.ts'
import { migrate, one, openDatabase } from '../src/db.ts'
import { activeEmbedder, cosine, setTestEmbedder } from '../src/embedding.ts'
import { createLogger } from '../src/log.ts'
import { applyMemoryDecision, type MemoryDecision } from '../src/memory-engine.ts'
import { selectPromptMemories } from '../src/memory-retrieval.ts'
import { assembleCompanionPrompt } from '../src/prompt.ts'

const TEA = '用户长期偏好绿茶'
const JUICE = '冰箱里有一瓶橙汁'
const SAME_SHAPE = '用户长期偏好橙汁'
const COFFEE = '用户不喝咖啡'
const MEETING = '明天上午要开项目会'
const SWIM = '每周三晚固定去游泳，已经坚持两年'
const DRINK = '给我推荐一种适合我口味的饮品'
const TEA_NOW = '我现在喝什么茶'
const BLACK = '用户现在改喝红茶'

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

test('real bge-small-zh embedding recalls a Chinese paraphrase and rejects distractors', { timeout: 120_000 }, async () => {
  setTestEmbedder(null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-live-'))
  const databasePath = path.join(dir, 'app.sqlite')
  const db = openDatabase({ databaseUrl: null, databasePath })
  const config = loadConfig(
    { NODE_ENV: 'test' },
    {
      nodeEnv: 'test',
      gatewayMode: 'live',
      deepseekApiKey: null,
      databaseUrl: null,
      databasePath,
      dataDir: dir,
      initiativePollMs: 0,
      embeddingMode: 'local',
      embeddingTimeoutMs: 60_000,
      embeddingMinCosine: 0.44,
    }
  )
  const log = createLogger(() => {})
  const rssBefore = process.memoryUsage().rss
  try {
    await migrate(db)
    const at = '2024-01-01T00:00:00.000Z'
    await db.run(
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES ('user-a', 'a@example.com', 'hash', 'user', 'user', ?, ?)`,
      [at, at]
    )
    await db.run(
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES ('user-b', 'b@example.com', 'hash', 'user', 'user', ?, ?)`,
      [at, at]
    )
    await db.run(
      `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
       VALUES ('char-a', 'user-a', '林', '', '研究员', '', '', '短句', '', '', '不编造', 'deepseek-flash', 0, ?, ?)`,
      [at, at]
    )
    await db.run(
      `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
       VALUES ('char-b', 'user-a', '乙', '', '研究员', '', '', '短句', '', '', '不编造', 'deepseek-flash', 0, ?, ?)`,
      [at, at]
    )
    await db.run(
      `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
       VALUES ('char-c', 'user-b', '丙', '', '研究员', '', '', '短句', '', '', '不编造', 'deepseek-flash', 0, ?, ?)`,
      [at, at]
    )
    const rows = [
      ['tea', 'user-a', 'char-a', TEA],
      ['juice', 'user-a', 'char-a', JUICE],
      ['coffee', 'user-a', 'char-a', COFFEE],
      ['meeting', 'user-a', 'char-a', MEETING],
      ['swim', 'user-a', 'char-a', SWIM],
      ['other-character', 'user-a', 'char-b', '角色乙长期偏好绿茶'],
      ['other-user', 'user-b', 'char-c', '其他用户长期偏好绿茶'],
    ]
    for (const [id, userId, characterId, content] of rows) {
      await db.run(
        `INSERT INTO memories (
          id, user_id, character_id, category, content, source, explicit, note, status,
          created_at, updated_at, last_confirmed_at, confidence, supersedes_id, superseded_by, space
        ) VALUES (?, ?, ?, 'preference', ?, 'user_stated', 1, '', 'active', ?, ?, ?, 1, NULL, NULL, 'companion')`,
        [id, userId, characterId, content, at, at, at]
      )
    }
    const embedder = activeEmbedder(config)
    assert.ok(embedder)
    assert.equal(embedder.model, 'Xenova/bge-small-zh-v1.5')
    const started = Date.now()
    const query = await embedder.embed(DRINK, 'query', AbortSignal.timeout(60_000))
    const loadMs = Date.now() - started
    const passages = [TEA, JUICE, SAME_SHAPE, COFFEE, MEETING, SWIM, BLACK]
    const scores: Record<string, number> = {}
    for (const text of passages) {
      const vector = await embedder.embed(text, 'passage', AbortSignal.timeout(60_000))
      scores[text] = Number(cosine(query, vector).toFixed(3))
    }
    const evidence = {
      event: 'embedding_live_scores',
      model: embedder.model,
      dimensions: query.length,
      version: embedder.version,
      loadMs,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      scores,
    }
    console.log(JSON.stringify(evidence))
    assert.equal(query.length, 512)
    assert.ok(scores[TEA] >= 0.44, JSON.stringify(evidence))
    assert.ok(scores[TEA] > scores[JUICE], JSON.stringify(evidence))
    assert.ok(scores[JUICE] < 0.44, JSON.stringify(evidence))
    assert.ok(scores[COFFEE] < 0.44, JSON.stringify(evidence))
    assert.ok(scores[MEETING] < 0.44, JSON.stringify(evidence))
    assert.ok(scores[SWIM] < 0.44, JSON.stringify(evidence))

    const empty = await selectPromptMemories(db, config, log, { userId: 'nobody', space: 'companion', characterId: 'missing', topic: DRINK })
    assert.equal(empty.mode, 'lexical')
    assert.deepEqual(empty.memories, [])

    const found = await selectPromptMemories(db, config, log, { userId: 'user-a', space: 'companion', characterId: 'char-a', topic: DRINK })
    const contents = found.memories.map((memory) => memory.content)
    assert.equal(found.mode, 'hybrid', JSON.stringify(found))
    assert.equal(found.model, 'Xenova/bge-small-zh-v1.5')
    assert.equal(found.dimensions, 512)
    assert.equal(contents.includes(TEA), true, JSON.stringify(contents))
    for (const distractor of [JUICE, COFFEE, MEETING, SWIM, '角色乙长期偏好绿茶', '其他用户长期偏好绿茶']) {
      assert.equal(contents.includes(distractor), false, distractor)
    }
    const again = await selectPromptMemories(db, config, log, { userId: 'user-a', space: 'companion', characterId: 'char-a', topic: DRINK })
    assert.equal(again.memories.some((memory) => memory.content === TEA), true)
    const stored = await one<{ model: string; dimensions: number; version: string }>(db, `SELECT model, dimensions, version FROM memory_embeddings WHERE memory_id = 'tea'`)
    assert.equal(stored?.model, 'Xenova/bge-small-zh-v1.5')
    assert.equal(Number(stored?.dimensions), 512)
    assert.equal(stored?.version, embedder.version)

    const printer = await selectPromptMemories(db, config, log, { userId: 'user-a', space: 'companion', characterId: 'char-a', topic: '打印机缺纸了怎么处理' })
    assert.equal(printer.memories.some((memory) => memory.content === TEA), false)
    const rain = await selectPromptMemories(db, config, log, { userId: 'user-a', space: 'companion', characterId: 'char-a', topic: '今天上海下雨了' })
    assert.equal(rain.memories.some((memory) => memory.content === TEA || memory.content === SWIM), false)
    const otherUser = await selectPromptMemories(db, config, log, { userId: 'user-b', space: 'companion', characterId: 'char-c', topic: DRINK })
    assert.deepEqual(otherUser.memories.map((memory) => memory.content), ['其他用户长期偏好绿茶'])

    const prompt = assembleCompanionPrompt({
      persona: { name: '林', identity: '研究员', background: '', traits: '', style: '短句', habits: '', relationship: '', rules: '不编造' },
      memories: found.memories,
      history: [{ role: 'user', content: DRINK }],
      topic: DRINK,
      ranked: true,
    })
    const [persona, memories] = prompt.messages[0].content.split('[Memories]')
    assert.match(persona, /研究员/)
    assert.equal(persona.includes(TEA), false)
    assert.match(memories, /绿茶/)
    assert.equal(log.lines.join('\n').includes(TEA), false)
    assert.equal(log.lines.join('\n').includes(DRINK), false)

    const scope = { userId: 'user-a', space: 'companion' as const, characterId: 'char-a' }
    const teaQuestion = await embedder.embed(TEA_NOW, 'query', AbortSignal.timeout(60_000))
    const correctionScores = {
      [BLACK]: Number(cosine(teaQuestion, await embedder.embed(BLACK, 'passage', AbortSignal.timeout(60_000))).toFixed(3)),
      [TEA]: Number(cosine(teaQuestion, await embedder.embed(TEA, 'passage', AbortSignal.timeout(60_000))).toFixed(3)),
      [JUICE]: Number(cosine(teaQuestion, await embedder.embed(JUICE, 'passage', AbortSignal.timeout(60_000))).toFixed(3)),
    }
    console.log(JSON.stringify({ event: 'embedding_live_correction_scores', query: TEA_NOW, scores: correctionScores }))
    assert.ok(correctionScores[BLACK] >= 0.44, JSON.stringify(correctionScores))
    const corrected = await applyMemoryDecision(db, scope, decision({ action: 'expire', content: BLACK, target: '绿茶', change: 'fact_changed' }), 'live-correct')
    assert.equal(corrected.result, 'expired')
    const oldVector = await one(db, `SELECT memory_id FROM memory_embeddings WHERE memory_id = ?`, corrected.previousId)
    assert.equal(oldVector, undefined)
    const drinkAfter = await selectPromptMemories(db, config, log, { ...scope, topic: DRINK })
    assert.equal(drinkAfter.memories.some((memory) => memory.content === TEA), false)
    const teaNow = await selectPromptMemories(db, config, log, { ...scope, topic: TEA_NOW })
    assert.equal(teaNow.memories.some((memory) => memory.content === BLACK), true, JSON.stringify(teaNow.memories))
    assert.equal(teaNow.memories.some((memory) => memory.content === TEA), false)
  } finally {
    setTestEmbedder(null)
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
