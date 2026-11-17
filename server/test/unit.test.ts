import assert from 'node:assert/strict'
import test from 'node:test'
import { inQuietHours } from '../src/initiative.ts'
import { createLogger } from '../src/log.ts'
import { dedupeImports, memoryPackage, parseMemoryImport } from '../src/memory-import.ts'
import { loadConfig } from '../src/config.ts'
import { migrationSql, splitSql, toPostgresPlaceholders } from '../src/db.ts'
import { redact } from '../src/log.ts'
import { hashPassword, verifyPassword } from '../src/password.ts'
import { assembleCompanionPrompt, assembleWorkspacePrompt, costMicroUsd, PROMPT_LIMITS } from '../src/prompt.ts'

test('password hash verifies and does not store the raw password', async () => {
  const hash = await hashPassword('correct horse battery')
  assert.equal(await verifyPassword('correct horse battery', hash), true)
  assert.equal(await verifyPassword('wrong horse battery!', hash), false)
  assert.equal(hash.includes('correct horse'), false)
})

test('prompt keeps persona separate from a bounded memory list and drops old history', () => {
  const memories = Array.from({ length: 30 }, (_, index) => ({
    category: 'fact',
    content: index === 0 ? 'MEMORY_SHOULD_DROP' : `kept-${index}`,
    source: 'user',
    updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    explicit: true,
  }))
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: index === 0 ? 'OLD_MARKER_SHOULD_DROP' : `turn-${index}`,
  }))
  const assembled = assembleCompanionPrompt({
    persona: {
      name: 'Aya',
      identity: 'PERSONA_IDENTITY',
      background: '',
      traits: '',
      style: '',
      habits: '',
      relationship: '',
      rules: '',
    },
    memories,
    history,
  })
  const system = assembled.messages[0].content
  assert.match(system, /\[Persona\]/)
  assert.match(system, /PERSONA_IDENTITY/)
  assert.match(system, /\[Memories\]/)
  assert.equal(system.includes('MEMORY_SHOULD_DROP'), false)
  assert.equal(system.includes('OLD_MARKER_SHOULD_DROP'), false)
  assert.equal(assembled.messages.some((message) => message.content.includes('OLD_MARKER_SHOULD_DROP')), false)
  assert.equal(assembled.stats.memoriesIncluded, PROMPT_LIMITS.memoryCount)
  assert.equal(assembled.stats.historyIncluded, PROMPT_LIMITS.historyMessages)
  const workspace = assembleWorkspacePrompt({ history })
  assert.equal(workspace.messages.some((message) => message.content.includes('kept-')), false)
  assert.equal(workspace.messages[0].content.includes('[Memories]'), false)
})

test('cost is unknown without a configured price and fixture is not a bill', () => {
  assert.deepEqual(costMicroUsd('deepseek-flash', 1000, 1000, {}, 'live'), { cost: null, status: 'unknown' })
  assert.equal(costMicroUsd('deepseek-flash', 1_000_000, 0, { 'deepseek-flash': { input_per_million: 2, output_per_million: 4 } }, 'live').status, 'calculated')
  assert.equal(costMicroUsd('deepseek-flash', 11, 7, { 'deepseek-flash': { input_per_million: 2, output_per_million: 4 } }, 'fixture').status, 'fixture')
})

test('memory import parses formats, keeps uncertainty, and dedupes', () => {
  const json = parseMemoryImport('json', JSON.stringify([{ category: 'fact', content: '喜欢茶', source: 'note' }]))
  assert.equal(json[0].category, 'fact')
  assert.equal(json[0].explicit, true)
  const text = parseMemoryImport('txt', 'fact: 明确事实\n也许是猜测')
  assert.equal(text[0].explicit, true)
  assert.equal(text[1].explicit, false)
  const markdown = parseMemoryImport('md', '## relationship\n- 朋友')
  assert.equal(markdown[0].category, 'relationship')
  const packed = memoryPackage([{
    category: 'event',
    content: '见面',
    source: '旧日记',
    explicit: false,
    note: '年份不确定',
    createdAt: '2024-05-01T00:00:00.000Z',
    updatedAt: '2024-05-02T00:00:00.000Z',
  }])
  const roundTrip = parseMemoryImport('package', JSON.stringify(packed))
  assert.equal(roundTrip[0].explicit, false)
  assert.equal(roundTrip[0].source, '旧日记')
  assert.equal(roundTrip[0].note, '年份不确定')
  assert.equal(roundTrip[0].createdAt, '2024-05-01T00:00:00.000Z')
  assert.equal(roundTrip[0].updatedAt, '2024-05-02T00:00:00.000Z')
  assert.throws(() => parseMemoryImport('package', JSON.stringify({ kind: 'companion-platform-character', character: { name: 'A' } })), /character_card_not_memory/)
  assert.throws(() => parseMemoryImport('chatgpt', '{"mapping":{}}'), /adapter_not_implemented/)
  assert.throws(() => parseMemoryImport('gemini', '{}'), /adapter_not_implemented/)
  assert.throws(() => parseMemoryImport('deepseek', '{"messages":[]}'), /adapter_not_implemented/)
  assert.throws(() => parseMemoryImport('deepseek', '{"export_format_version":3}'), /deepseek_zip_not_supported/)
  const split = dedupeImports(
    [
      { tempId: 'a', category: 'fact', content: '喜欢茶', source: 'x', explicit: true, note: '', createdAt: null, updatedAt: null },
      { tempId: 'b', category: 'fact', content: '新的', source: 'x', explicit: true, note: '', createdAt: null, updatedAt: null },
    ],
    [{ category: 'fact', content: '喜欢茶' }]
  )
  assert.equal(split.duplicates.length, 1)
  assert.equal(split.accepted.length, 1)
})

test('logs redact passwords, message text, and provider keys', () => {
  const log = createLogger(() => {})
  log.info('example', { password: 'UniquePassword123!', content: 'private diary', apiKey: 'sk-test-should-not-leak-9f3a', userId: 'u1' })
  const line = log.lines[0]
  assert.equal(line.includes('UniquePassword123!'), false)
  assert.equal(line.includes('private diary'), false)
  assert.equal(line.includes('sk-test-should-not-leak-9f3a'), false)
  assert.match(line, /u1/)
})

test('production and unflagged fixture mode are refused', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MODEL_GATEWAY_MODE: 'fixture', ALLOW_GATEWAY_FIXTURE: '1', FIXTURE_BASE_URL: 'http://127.0.0.1:9' }))
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MODEL_GATEWAY_MODE: 'fixture' }))
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MODEL_GATEWAY_MODE: 'live' }))
  assert.throws(() =>
    loadConfig({
      NODE_ENV: 'production',
      MODEL_GATEWAY_MODE: 'live',
      DATABASE_URL: 'postgres://example.invalid/db',
      INITIATIVE_POLL_MS: '1000',
    })
  )
})

test('production postgres config stays off ephemeral disk and does not connect', () => {
  const config = loadConfig(
    { NODE_ENV: 'production', MODEL_GATEWAY_MODE: 'live', DATABASE_URL: 'postgres://example.invalid/db', INITIATIVE_POLL_MS: '0' },
    {}
  )
  assert.equal(config.databaseUrl, 'postgres://example.invalid/db')
  assert.equal(config.uploads, 'disabled')
  assert.equal(config.cookieSecure, true)
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.initiativePollMs, 0)
})

test('postgres placeholders and migration text ignore string contents and pragmas', () => {
  assert.equal(toPostgresPlaceholders("SELECT ? , '?' , ?"), "SELECT $1 , '?' , $2")
  assert.deepEqual(splitSql("CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);"), ['CREATE TABLE a (id TEXT)', 'CREATE TABLE b (id TEXT)'])
  assert.equal(migrationSql('PRAGMA foreign_keys = ON;\nCREATE TABLE a (id TEXT);', 'postgres').includes('PRAGMA'), false)
})

test('redact hides postgres connection strings', () => {
  assert.equal(redact('postgresql://ubuntu:secret@localhost/db'), '[redacted]')
  assert.equal(String(redact('postgresql://ubuntu:secret@localhost/db')).includes('secret'), false)
})

test('quiet hours use UTC minutes and wrap past midnight', () => {
  const noon = new Date('2026-11-17T12:00:00.000Z')
  assert.equal(inQuietHours(noon, 0, 900), true)
  assert.equal(inQuietHours(noon, 13 * 60, 14 * 60), false)
  assert.equal(inQuietHours(new Date('2026-11-17T23:30:00.000Z'), 22 * 60, 60), true)
  assert.equal(inQuietHours(noon, null, null), false)
})
