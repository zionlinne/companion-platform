import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { initAdmin } from '../src/auth.ts'
import { api, sse, start, type Running } from './harness.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const adminEmail = 'admin@example.com'
const adminPassword = 'AdminPassw0rd!123'
const userPassword = 'UserPassw0rd!123'

async function boot(options?: Parameters<typeof start>[0]) {
  const app = await start(options)
  await initAdmin(app.db, app.config, adminEmail, adminPassword)
  const admin = await api(app.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
  assert.equal(admin.status, 200)
  assert.match(admin.cookie ?? '', /^cp_session=/)
  return { app, adminCookie: admin.cookie! }
}

async function invite(app: Running, adminCookie: string) {
  const created = await api(app.baseUrl, 'POST', '/api/admin/invitations', { cookie: adminCookie, body: { count: 1 } })
  assert.equal(created.status, 201)
  return created.json.invitations[0].code as string
}

async function register(app: Running, code: string, email: string) {
  return api(app.baseUrl, 'POST', '/api/register', {
    body: { email, password: userPassword, invitationCode: code, displayName: email.split('@')[0] },
  })
}

test('cli creates one administrator and does not print the password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-cli-'))
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_PATH: path.join(dir, 'app.sqlite'),
    DATA_DIR: path.join(dir, 'data'),
    ADMIN_EMAIL: 'cli-admin@example.com',
    ADMIN_PASSWORD: 'CliAdminPassw0rd!123',
    MODEL_GATEWAY_MODE: 'live',
  }
  const args = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/src/cli.ts', 'init-admin']
  const first = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout.includes('CliAdminPassw0rd!123'), false)
  const second = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  assert.notEqual(second.status, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('invitation registration, session, and profile survive logout', async () => {
  const { app, adminCookie } = await boot()
  try {
    const denied = await api(app.baseUrl, 'POST', '/api/admin/init', { body: {} })
    assert.equal(denied.status, 404)
    const code = await invite(app, adminCookie)
    const listed = await api(app.baseUrl, 'GET', '/api/admin/invitations', { cookie: adminCookie })
    assert.equal(JSON.stringify(listed.json).includes(code), false)
    const [first, second] = await Promise.all([
      register(app, code, 'a@example.com'),
      register(app, code, 'b@example.com'),
    ])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, [201, 400])
    const winner = first.status === 201 ? first : second
    const me = await api(app.baseUrl, 'GET', '/api/me', { cookie: winner.cookie })
    assert.equal(me.status, 200)
    const renamed = await api(app.baseUrl, 'PATCH', '/api/me', { cookie: winner.cookie, body: { displayName: 'Aya' } })
    assert.equal(renamed.json.user.displayName, 'Aya')
    const out = await api(app.baseUrl, 'POST', '/api/logout', { cookie: winner.cookie })
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/)
    const gone = await api(app.baseUrl, 'GET', '/api/me', { cookie: winner.cookie })
    assert.equal(gone.status, 401)
    const again = await api(app.baseUrl, 'POST', '/api/login', { body: { email: winner.json.user.email, password: userPassword } })
    assert.equal(again.status, 200)
    assert.equal(again.json.user.displayName, 'Aya')
    const bad = await api(app.baseUrl, 'POST', '/api/login', { body: { email: winner.json.user.email, password: 'UniquePassword123!' } })
    assert.equal(bad.status, 401)
    assert.equal(app.log.lines.join('\n').includes('UniquePassword123!'), false)
    assert.equal(app.log.lines.join('\n').includes('sk-test-should-not-leak-9f3a'), false)
  } finally {
    await app.close()
  }
})

test('characters, memories, chat branches, isolation, and no key leakage', async () => {
  const { app, adminCookie } = await boot()
  try {
    const codeA = await invite(app, adminCookie)
    const codeB = await invite(app, adminCookie)
    const userA = await register(app, codeA, 'owner@example.com')
    const userB = await register(app, codeB, 'other@example.com')
    assert.equal(userA.status, 201)
    assert.equal(userB.status, 201)
    const created = await api(app.baseUrl, 'POST', '/api/characters', {
      cookie: userA.cookie,
      body: { name: '林', identity: '研究员', defaultModel: 'deepseek-flash' },
    })
    assert.equal(created.status, 201)
    const characterId = created.json.character.id as string
    const edited = await api(app.baseUrl, 'PATCH', `/api/characters/${characterId}`, {
      cookie: userA.cookie,
      body: { style: '短句', rules: '不编造工作区事实' },
    })
    assert.equal(edited.json.character.style, '短句')
    assert.notEqual(edited.json.character.updatedAt, '')
    const memory = await api(app.baseUrl, 'POST', `/api/characters/${characterId}/memories`, {
      cookie: userA.cookie,
      body: { category: 'fact', content: 'COMPANION_MEMORY_PHRASE', source: 'user-note', explicit: true },
    })
    assert.equal(memory.status, 201)
    assert.ok(memory.json.memory.createdAt)
    assert.ok(memory.json.memory.updatedAt)
    const copied = await api(app.baseUrl, 'POST', `/api/characters/${characterId}/copy`, {
      cookie: userA.cookie,
      body: { copyMemories: true },
    })
    assert.equal(copied.status, 201)
    const hidden = await api(app.baseUrl, 'GET', `/api/characters/${characterId}`, { cookie: userB.cookie })
    assert.equal(hidden.status, 404)
    const hiddenMemory = await api(app.baseUrl, 'DELETE', `/api/memories/${memory.json.memory.id}`, { cookie: userB.cookie })
    assert.equal(hiddenMemory.status, 404)

    const workspace = await api(app.baseUrl, 'POST', '/api/conversations', {
      cookie: userA.cookie,
      body: { space: 'workspace', title: '项目记录' },
    })
    const workChat = await sse(app.baseUrl, `/api/conversations/${workspace.json.conversation.id}/messages`, {
      content: 'WORKSPACE_SECRET_PHRASE',
      thinking: true,
    }, userA.cookie!)
    assert.equal(workChat.status, 200)
    assert.equal(workChat.events.some((event) => event.event === 'delta' && String(event.data.content).length > 0), true)
    assert.equal(workChat.events.find((event) => event.event === 'done')?.data.costStatus, 'fixture')
    assert.equal(workChat.text.includes('sk-test-should-not-leak-9f3a'), false)
    assert.equal(workChat.events.find((event) => event.event === 'meta')?.data.realProvider, false)

    const companion = await api(app.baseUrl, 'POST', '/api/conversations', {
      cookie: userA.cookie,
      body: { space: 'companion', characterId },
    })
    const chat = await sse(app.baseUrl, `/api/conversations/${companion.json.conversation.id}/messages`, {
      content: '你好',
      thinking: true,
    }, userA.cookie!)
    assert.match(chat.events.filter((event) => event.event === 'delta').map((event) => event.data.content).join(''), /fixture-reply:你好/)
    assert.match(chat.events.filter((event) => event.event === 'delta').map((event) => event.data.reasoning).join(''), /fixture-reasoning/)
    const saved = await api(app.baseUrl, 'GET', `/api/conversations/${companion.json.conversation.id}`, { cookie: userA.cookie })
    assert.equal(saved.json.messages.length, 2)
    const otherView = await api(app.baseUrl, 'GET', `/api/conversations/${companion.json.conversation.id}`, { cookie: userB.cookie })
    assert.equal(otherView.status, 404)

    const editedMessage = saved.json.messages.find((message: { role: string }) => message.role === 'user')
    const revision = await sse(
      app.baseUrl,
      `/api/conversations/${companion.json.conversation.id}/messages/${editedMessage.id}/edit`,
      { content: '改写后的话' },
      userA.cookie!
    )
    assert.equal(revision.status, 200)
    const branched = await api(app.baseUrl, 'GET', `/api/conversations/${companion.json.conversation.id}`, { cookie: userA.cookie })
    const userLeaf = branched.json.messages.find((message: { role: string }) => message.role === 'user')
    assert.equal(userLeaf.content, '改写后的话')
    assert.equal(userLeaf.siblingCount, 2)
    const assistant = branched.json.messages.find((message: { role: string }) => message.role === 'assistant')
    const regenerated = await sse(
      app.baseUrl,
      `/api/conversations/${companion.json.conversation.id}/messages/${assistant.id}/regenerate`,
      { thinking: false },
      userA.cookie!
    )
    assert.equal(regenerated.status, 200)

    const companionRequest = app.fixture!.state.requests.find((request) =>
      JSON.stringify(request.body).includes('你好') || JSON.stringify(request.body).includes('改写后的话')
    )
    const workspaceRequest = app.fixture!.state.requests.find((request) => JSON.stringify(request.body).includes('WORKSPACE_SECRET_PHRASE'))
    assert.ok(workspaceRequest)
    assert.equal(JSON.stringify(workspaceRequest?.body).includes('COMPANION_MEMORY_PHRASE'), false)
    assert.ok(companionRequest)
    assert.equal(JSON.stringify(companionRequest?.body).includes('WORKSPACE_SECRET_PHRASE'), false)
    assert.match(JSON.stringify(companionRequest?.body), /PERSONA|研究员|短句/)
    assert.match(String(companionRequest?.authorization), /Bearer sk-test-should-not-leak-9f3a/)
    assert.equal(JSON.stringify(app.fixture!.state.requests).includes('sk-test'), true)

    const boundary = '----companion'
    const raw = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nWORKSPACE_FILE_SECRET\r\n--${boundary}--\r\n`
    )
    const uploaded = await api(app.baseUrl, 'POST', '/api/attachments?space=workspace', {
      cookie: userA.cookie,
      raw,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    })
    assert.equal(uploaded.status, 201)
    const rejected = await api(app.baseUrl, 'POST', `/api/conversations/${companion.json.conversation.id}/messages`, {
      cookie: userA.cookie,
      body: { content: '带错附件', attachmentIds: [uploaded.json.attachment.id] },
    })
    assert.equal(rejected.status, 403)
    const stolen = await api(app.baseUrl, 'GET', `/api/attachments/${uploaded.json.attachment.id}`, { cookie: userB.cookie })
    assert.equal(stolen.status, 404)

    await api(app.baseUrl, 'POST', '/api/logout', { cookie: userA.cookie })
    const returned = await api(app.baseUrl, 'POST', '/api/login', { body: { email: 'owner@example.com', password: userPassword } })
    const still = await api(app.baseUrl, 'GET', `/api/characters/${characterId}/memories`, { cookie: returned.cookie })
    assert.equal(still.json.memories[0].content, 'COMPANION_MEMORY_PHRASE')
    const stillChat = await api(app.baseUrl, 'GET', `/api/conversations/${companion.json.conversation.id}`, { cookie: returned.cookie })
    assert.ok(stillChat.json.messages.length >= 2)

    const gateway = await api(app.baseUrl, 'GET', '/api/gateway', { cookie: returned.cookie })
    assert.equal(gateway.text.includes('sk-test-should-not-leak-9f3a'), false)
    assert.equal(gateway.json.realProvider, false)
    assert.equal(app.log.lines.join('\n').includes('sk-test-should-not-leak-9f3a'), false)
    assert.equal(app.log.lines.join('\n').includes('WORKSPACE_SECRET_PHRASE'), false)
  } finally {
    await app.close()
  }
})

test('timeline grants, initiative dedupe, quota, and closed gateway', async () => {
  const { app, adminCookie } = await boot()
  try {
    const user = await register(app, await invite(app, adminCookie), 'loop@example.com')
    const character = await api(app.baseUrl, 'POST', '/api/characters', {
      cookie: user.cookie,
      body: { name: '提醒', identity: '助手', initiativeEnabled: true },
    })
    const characterId = character.json.character.id as string
    const event = await api(app.baseUrl, 'POST', '/api/workspace/timeline', {
      cookie: user.cookie,
      body: { title: 'SECRET_TITLE', summary: 'AUTHORIZED_SUMMARY', eventType: 'note', occurredAt: '2026-11-17T09:00:00.000Z' },
    })
    const eventId = event.json.event.id as string
    const blocked = await api(app.baseUrl, 'POST', '/api/companion/timeline-reads', {
      cookie: user.cookie,
      body: { characterId, eventId },
    })
    assert.equal(blocked.status, 403)
    const grant = await api(app.baseUrl, 'POST', `/api/workspace/timeline/${eventId}/grants`, {
      cookie: user.cookie,
      body: { characterId, allowSummary: true },
    })
    assert.equal(grant.status, 201)
    const read = await api(app.baseUrl, 'POST', '/api/companion/timeline-reads', {
      cookie: user.cookie,
      body: { characterId, eventId },
    })
    assert.equal(read.json.fields.summary, 'AUTHORIZED_SUMMARY')
    assert.equal(read.json.fields.title, undefined)
    assert.equal(read.json.eventUnchanged, true)
    const audits = await api(app.baseUrl, 'GET', '/api/workspace/audits', { cookie: user.cookie })
    assert.equal(audits.json.audits.length, 1)
    const revoked = await api(app.baseUrl, 'POST', `/api/workspace/grants/${grant.json.grantId}/revoke`, { cookie: user.cookie })
    assert.equal(revoked.status, 200)
    const after = await api(app.baseUrl, 'POST', '/api/companion/timeline-reads', {
      cookie: user.cookie,
      body: { characterId, eventId },
    })
    assert.equal(after.status, 403)
    const mutate = await api(app.baseUrl, 'POST', `/api/companion/timeline/${eventId}`, { cookie: user.cookie, body: { title: 'nope' } })
    assert.equal(mutate.status, 405)

    const grantAgain = await api(app.baseUrl, 'POST', `/api/workspace/timeline/${eventId}/grants`, {
      cookie: user.cookie,
      body: { characterId, allowTitle: true },
    })
    assert.equal(grantAgain.status, 201)
    await api(app.baseUrl, 'PATCH', '/api/initiative', {
      cookie: user.cookie,
      body: { enabled: true, dailyLimit: 1, maxModelCallsPerTick: 1, quietStartMinute: null, quietEndMinute: null },
    })
    const beforeCount = app.fixture!.state.requests.length
    const [tickA, tickB] = await Promise.all([
      api(app.baseUrl, 'POST', '/api/initiative/tick', { cookie: user.cookie, body: { now: '2026-11-17T12:00:00.000Z' } }),
      api(app.baseUrl, 'POST', '/api/initiative/tick', { cookie: user.cookie, body: { now: '2026-11-17T12:00:00.000Z' } }),
    ])
    const sent = [tickA, tickB].filter((item) => item.json.status === 'ok')
    assert.equal(sent.length, 1)
    assert.equal(app.fixture!.state.requests.length - beforeCount, 1)
    const notes = await api(app.baseUrl, 'GET', '/api/notifications', { cookie: user.cookie })
    assert.match(notes.json.notifications[0].body, /主动提醒：SECRET_TITLE/)
    const limited = await api(app.baseUrl, 'POST', '/api/initiative/tick', { cookie: user.cookie, body: { now: '2026-11-17T12:05:00.000Z' } })
    assert.equal(limited.json.reason, 'daily_limit')
    await api(app.baseUrl, 'PATCH', '/api/initiative', {
      cookie: user.cookie,
      body: { quietStartMinute: 0, quietEndMinute: 900 },
    })
    const quiet = await api(app.baseUrl, 'POST', '/api/initiative/tick', { cookie: user.cookie, body: { now: '2026-11-18T12:00:00.000Z' } })
    assert.equal(quiet.json.reason, 'quiet_hours')
    const unimplemented = await api(app.baseUrl, 'PATCH', '/api/initiative', {
      cookie: user.cookie,
      body: { triggers: { schedule: { enabled: true } } },
    })
    assert.equal(unimplemented.status, 400)

    const conversation = await api(app.baseUrl, 'POST', '/api/conversations', {
      cookie: user.cookie,
      body: { space: 'companion', characterId },
    })
    const preview = await api(app.baseUrl, 'POST', `/api/characters/${characterId}/memories/import/preview`, {
      cookie: user.cookie,
      body: { format: 'jsonl', text: '{"category":"event","content":"见面","source":"note"}\n' },
    })
    assert.equal(preview.json.written, false)
    const beforeCommit = await api(app.baseUrl, 'GET', `/api/characters/${characterId}/memories`, { cookie: user.cookie })
    assert.equal(beforeCommit.json.memories.some((row: { content: string }) => row.content === '见面'), false)
    const committed = await api(app.baseUrl, 'POST', `/api/characters/${characterId}/memories/import/commit`, {
      cookie: user.cookie,
      body: { previewId: preview.json.previewId, tempIds: [preview.json.items[0].tempId] },
    })
    assert.equal(committed.status, 201)
    const seeded = await sse(app.baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, { content: '我喜欢喝茶' }, user.cookie!)
    assert.equal(seeded.status, 200)
    const suggestion = await api(app.baseUrl, 'POST', `/api/characters/${characterId}/memories/suggest`, {
      cookie: user.cookie,
      body: { conversationId: conversation.json.conversation.id },
    })
    assert.equal(suggestion.status, 200)
    assert.equal(suggestion.json.memories[0].status, 'suggested')
    assert.equal(suggestion.json.memories[0].explicit, false)
    const active = await api(app.baseUrl, 'GET', `/api/characters/${characterId}/memories`, { cookie: user.cookie })
    assert.equal(active.json.memories.some((row: { content: string }) => row.content === '用户说过喜欢喝茶'), false)

    const quotaUser = await register(app, await invite(app, adminCookie), 'quota@example.com')
    const quotaCharacter = await api(app.baseUrl, 'POST', '/api/characters', { cookie: quotaUser.cookie, body: { name: '额度' } })
    const users = await api(app.baseUrl, 'GET', '/api/admin/users', { cookie: adminCookie })
    const target = users.json.users.find((row: { email: string }) => row.email === 'quota@example.com')
    const quota = await api(app.baseUrl, 'PATCH', `/api/admin/users/${target.id}/quota`, {
      cookie: adminCookie,
      body: { dailyRequestLimit: 1, dailyTokenLimit: 100000 },
    })
    assert.equal(quota.status, 200)
    const quotaConversation = await api(app.baseUrl, 'POST', '/api/conversations', {
      cookie: quotaUser.cookie,
      body: { space: 'companion', characterId: quotaCharacter.json.character.id },
    })
    const first = await sse(app.baseUrl, `/api/conversations/${quotaConversation.json.conversation.id}/messages`, { content: 'quota' }, quotaUser.cookie!)
    assert.equal(first.status, 200)
    const second = await api(app.baseUrl, 'POST', `/api/conversations/${quotaConversation.json.conversation.id}/messages`, {
      cookie: quotaUser.cookie,
      body: { content: 'over' },
    })
    assert.equal(second.status, 429)
  } finally {
    await app.close()
  }
})

test('missing provider key fails closed and data survives a process restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-restart-'))
  const databasePath = path.join(dir, 'app.sqlite')
  const dataDir = path.join(dir, 'data')
  const first = await start({ mode: 'fixture', dir, databasePath, dataDir, apiKey: 'sk-test-should-not-leak-9f3a' })
  try {
    await initAdmin(first.db, first.config, adminEmail, adminPassword)
    const admin = await api(first.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
    const user = await register(first, await invite(first, admin.cookie!), 'keep@example.com')
    const character = await api(first.baseUrl, 'POST', '/api/characters', { cookie: user.cookie, body: { name: '保留' } })
    const conversation = await api(first.baseUrl, 'POST', '/api/conversations', {
      cookie: user.cookie,
      body: { space: 'companion', characterId: character.json.character.id },
    })
    await sse(first.baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, { content: '记住这句' }, user.cookie!)
    await first.close({ keepDir: true })
    const second = await start({ mode: 'fixture', dir, databasePath, dataDir, apiKey: 'sk-test-should-not-leak-9f3a' })
    try {
      const login = await api(second.baseUrl, 'POST', '/api/login', { body: { email: 'keep@example.com', password: userPassword } })
      const characters = await api(second.baseUrl, 'GET', '/api/characters', { cookie: login.cookie })
      assert.equal(characters.json.characters[0].name, '保留')
      const messages = await api(second.baseUrl, 'GET', `/api/conversations/${conversation.json.conversation.id}`, { cookie: login.cookie })
      assert.match(JSON.stringify(messages.json.messages), /记住这句/)
    } finally {
      await second.close({ keepDir: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const closed = await start({ mode: 'live', apiKey: null })
  try {
    await initAdmin(closed.db, closed.config, adminEmail, adminPassword)
    const admin = await api(closed.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
    const user = await register(closed, await invite(closed, admin.cookie!), 'nokey@example.com')
    const character = await api(closed.baseUrl, 'POST', '/api/characters', { cookie: user.cookie, body: { name: '无钥匙' } })
    const conversation = await api(closed.baseUrl, 'POST', '/api/conversations', {
      cookie: user.cookie,
      body: { space: 'companion', characterId: character.json.character.id },
    })
    const blocked = await api(closed.baseUrl, 'POST', `/api/conversations/${conversation.json.conversation.id}/messages`, {
      cookie: user.cookie,
      body: { content: '你好' },
    })
    assert.equal(blocked.status, 503)
    assert.equal(blocked.json.error.code, 'model_gateway_unconfigured')
    assert.match(blocked.text, /does not invent/)
    assert.equal(blocked.text.includes('fixture-reply'), false)
    const stored = await api(closed.baseUrl, 'GET', `/api/conversations/${conversation.json.conversation.id}`, { cookie: user.cookie })
    assert.equal(stored.json.messages.length, 0)
    const unreachable = await start({ mode: 'live', apiKey: 'sk-test-should-not-leak-9f3a', baseUrl: 'http://127.0.0.1:9' })
    try {
      await initAdmin(unreachable.db, unreachable.config, adminEmail, adminPassword)
      const admin2 = await api(unreachable.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
      const user2 = await register(unreachable, await invite(unreachable, admin2.cookie!), 'down@example.com')
      const character2 = await api(unreachable.baseUrl, 'POST', '/api/characters', { cookie: user2.cookie, body: { name: '离线' } })
      const conversation2 = await api(unreachable.baseUrl, 'POST', '/api/conversations', {
        cookie: user2.cookie,
        body: { space: 'companion', characterId: character2.json.character.id },
      })
      const failed = await sse(unreachable.baseUrl, `/api/conversations/${conversation2.json.conversation.id}/messages`, { content: 'ping' }, user2.cookie!)
      assert.equal(failed.events.find((event) => event.event === 'error')?.data.code, 'provider_unreachable')
      assert.equal(failed.text.includes('fixture-reply'), false)
      assert.equal(failed.text.includes('sk-test-should-not-leak-9f3a'), false)
    } finally {
      await unreachable.close()
    }
  } finally {
    await closed.close()
  }
})
