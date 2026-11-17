import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInvitations, initAdmin } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { migrate, openDatabase } from '../src/db.ts'
import { startFixture } from '../src/fixture-provider.ts'
import { api, sse } from './harness.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const adminUrl = 'postgresql://ubuntu@/postgres?host=/var/run/postgresql'

function psql(sql: string) {
  execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' })
}

async function listen(child: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('postgres server did not listen')), 20000)
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /"port":([1-9]\d*)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited ${code}: ${buffer}`))
    })
  })
}

function startServer(databaseUrl: string, dataDir: string, fixtureUrl: string) {
  const logs: Buffer[] = []
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_URL: databaseUrl,
      DATA_DIR: dataDir,
      STATIC_DIR: '',
      MODEL_GATEWAY_MODE: 'fixture',
      ALLOW_GATEWAY_FIXTURE: '1',
      FIXTURE_BASE_URL: fixtureUrl,
      DEEPSEEK_API_KEY: 'sk-test-should-not-leak-9f3a',
      INITIATIVE_POLL_MS: '0',
      COOKIE_SECURE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk))
  return { child, logs }
}

test('postgres schema, isolation, limits, disabled uploads, and restart persistence', async (t) => {
  const name = `cp_${process.pid}_${Date.now().toString(36)}`
  const databaseUrl = `postgresql://ubuntu@/${name}?host=/var/run/postgresql`
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pg-'))
  psql(`CREATE DATABASE ${name}`)
  const fixture = await startFixture()
  let child: ChildProcess | null = null
  const captured: Buffer[][] = []
  t.after(async () => {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    await fixture.close()
    psql(`DROP DATABASE ${name} WITH (FORCE)`)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const config = loadConfig(
    { NODE_ENV: 'test' },
    {
      nodeEnv: 'test',
      databaseUrl,
      databasePath: path.join(dataDir, 'must-not-exist.sqlite'),
      dataDir,
      gatewayMode: 'fixture',
      allowGatewayFixture: true,
      fixtureBaseUrl: fixture.url,
      deepseekApiKey: 'sk-test-should-not-leak-9f3a',
      initiativePollMs: 0,
      host: '127.0.0.1',
      port: 0,
    }
  )
  const db = openDatabase(config)
  const applied = await migrate(db)
  assert.deepEqual(applied, ['001_init.sql', '002_memory_note.sql'])
  assert.deepEqual(await migrate(db), [])
  const tables = await db.all<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )
  for (const required of ['users', 'characters', 'memories', 'conversations', 'timeline_grants', 'schema_migrations']) {
    assert.equal(tables.some((row) => row.table_name === required), true, required)
  }
  const note = await db.get<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'note'`
  )
  assert.equal(note?.data_type, 'text')
  const admin = await initAdmin(db, config, 'admin@example.com', 'AdminPassw0rd!123')
  const invites = await createInvitations(db, admin.id, 3, 1, 'pg')
  await db.close()

  const first = startServer(databaseUrl, dataDir, fixture.url)
  child = first.child
  captured.push(first.logs)
  let baseUrl = await listen(child)
  const health = await api(baseUrl, 'GET', '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  const foreign = await api(baseUrl, 'POST', '/api/login', {
    body: { email: 'admin@example.com', password: 'AdminPassw0rd!123' },
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(foreign.status, 403)
  const unauthTick = await api(baseUrl, 'POST', '/api/initiative/tick', { body: {} })
  assert.equal(unauthTick.status, 401)

  const race = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      api(baseUrl, 'POST', '/api/register', {
        body: { email: `race${index}@example.com`, password: 'UserPassw0rd!123', invitationCode: invites[0].code },
      })
    )
  )
  assert.equal(race.filter((item) => item.status === 201).length, 1)

  const userA = await api(baseUrl, 'POST', '/api/register', {
    body: { email: 'a@example.com', password: 'UserPassw0rd!123', invitationCode: invites[1].code },
  })
  const userB = await api(baseUrl, 'POST', '/api/register', {
    body: { email: 'b@example.com', password: 'UserPassw0rd!123', invitationCode: invites[2].code },
  })
  assert.equal(userA.status, 201)
  assert.equal(userB.status, 201)
  const gateway = await api(baseUrl, 'GET', '/api/gateway', { cookie: userA.cookie })
  assert.equal(gateway.json.uploads, 'disabled')
  assert.equal(gateway.json.scheduler, 'manual')
  assert.equal(gateway.json.mode, 'fixture')
  assert.equal(JSON.stringify(gateway.json).includes('sk-'), false)

  const created = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      api(baseUrl, 'POST', '/api/characters', { cookie: userA.cookie, body: { name: `角色${index}` } })
    )
  )
  assert.equal(created.filter((item) => item.status === 201).length, 5)
  const listed = await api(baseUrl, 'GET', '/api/characters', { cookie: userA.cookie })
  assert.equal(listed.json.used, 5)
  assert.equal(listed.json.characters.length, 5)
  const characterId = listed.json.characters[0].id as string
  const hidden = await api(baseUrl, 'GET', `/api/characters/${characterId}`, { cookie: userB.cookie })
  assert.equal(hidden.status, 404)
  const memory = await api(baseUrl, 'POST', `/api/characters/${characterId}/memories`, {
    cookie: userA.cookie,
    body: { category: 'fact', content: 'PG_MEMORY', source: 'test', explicit: true },
  })
  assert.equal(memory.status, 201)
  const stolenMemory = await api(baseUrl, 'GET', `/api/characters/${characterId}/memories`, { cookie: userB.cookie })
  assert.equal(stolenMemory.status, 404)
  const others = await api(baseUrl, 'GET', '/api/characters', { cookie: userB.cookie })
  assert.equal(others.json.characters.length, 0)

  const boundary = '----companion'
  const raw = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nSHOULD_NOT_TOUCH_DISK\r\n--${boundary}--\r\n`
  )
  const uploaded = await api(baseUrl, 'POST', '/api/attachments?space=companion', {
    cookie: userA.cookie,
    raw,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  })
  assert.equal(uploaded.status, 503)
  assert.equal(uploaded.json.error.code, 'uploads_disabled')
  assert.equal(fs.existsSync(path.join(dataDir, 'blobs')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'must-not-exist.sqlite')), false)

  const conversation = await api(baseUrl, 'POST', '/api/conversations', {
    cookie: userA.cookie,
    body: { space: 'companion', characterId },
  })
  assert.equal(conversation.status, 201)
  const streamed = await sse(baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, { content: '持久你好' }, userA.cookie!)
  assert.equal(streamed.status, 200)
  assert.equal(streamed.text.includes('"gatewayMode":"fixture"'), true)
  assert.equal(streamed.text.includes('"costStatus":"fixture"'), true)
  assert.equal(streamed.text.includes('"realProvider":true'), false)
  assert.equal(streamed.text.includes('sk-'), false)

  child.kill('SIGTERM')
  await new Promise((resolve) => child?.once('exit', resolve))
  const second = startServer(databaseUrl, dataDir, fixture.url)
  child = second.child
  captured.push(second.logs)
  baseUrl = await listen(child)
  const again = await api(baseUrl, 'GET', `/api/conversations/${conversation.json.conversation.id}`, { cookie: userA.cookie })
  assert.equal(again.status, 200)
  assert.equal(JSON.stringify(again.json).includes('持久你好'), true)
  assert.equal(JSON.stringify(again.json).includes('fixture-reply:'), true)
  const flags = await api(baseUrl, 'GET', `/api/characters/${characterId}`, { cookie: userA.cookie })
  assert.equal(flags.json.character.initiativeEnabled, false)

  const output = Buffer.concat(captured.flat()).toString()
  assert.equal(output.includes(databaseUrl), false)
  assert.equal(output.includes('postgresql://'), false)
  assert.equal(output.includes('sk-test-should-not-leak-9f3a'), false)
})
