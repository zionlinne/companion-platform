import assert from 'node:assert/strict'
import test from 'node:test'
import { hashPassword } from '../src/password.ts'
import { api, sse, start } from './harness.ts'
import { initAdmin } from '../src/identity.ts'
import { newId, nowIso } from '../src/http.ts'

const adminEmail = 'admin@example.com'
const adminPassword = 'AdminPassw0rd!123'
const userPassword = 'UserPassw0rd!123'

async function boot(options?: Parameters<typeof start>[0]) {
  const app = await start(options)
  await initAdmin(app.db, app.config, adminEmail, adminPassword)
  const admin = await api(app.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
  assert.equal(admin.status, 200)
  return { app, adminCookie: admin.cookie! }
}

async function invite(baseUrl: string, adminCookie: string, body: Record<string, unknown> = { count: 1 }) {
  const created = await api(baseUrl, 'POST', '/api/admin/invitations', { cookie: adminCookie, body })
  assert.equal(created.status, 201)
  return created.json.invitations as Array<{ id: string; code: string }>
}

test('legacy scrypt password still logs in and new sessions are Better Auth', async () => {
  const { app } = await boot()
  try {
    const hash = await hashPassword(userPassword)
    const id = newId()
    const at = nowIso()
    app.db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, email_verified)
       VALUES (?, 'legacy@example.com', ?, 'Legacy', 'user', ?, ?, 1)`
    ).run(id, hash, at, at)
    app.db.prepare(
      `INSERT INTO auth_account (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES (?, ?, 'credential', ?, ?, ?, ?)`
    ).run(`${id}-credential`, id, id, hash, at, at)
    app.db.prepare(
      `INSERT INTO wallets (user_id, available_fen, frozen_fen, recharge_fen, spent_fen, refund_fen, created_at)
       VALUES (?, 0, 0, 0, 0, 0, ?)`
    ).run(id, at)
    const login = await api(app.baseUrl, 'POST', '/api/login', { body: { email: 'legacy@example.com', password: userPassword } })
    assert.equal(login.status, 200)
    assert.match(login.cookie ?? '', /^cp_session=/)
    const sessions = app.db.prepare(`SELECT count(*) AS n FROM sessions`).get() as { n: number }
    const authSessions = app.db.prepare(`SELECT count(*) AS n FROM auth_session WHERE userId = ?`).get(id) as { n: number }
    assert.equal(sessions.n, 0)
    assert.equal(authSessions.n, 1)
  } finally {
    await app.close()
  }
})

test('invite expiry, revoke, and concurrent use stay inside the cap', async () => {
  const { app, adminCookie } = await boot()
  try {
    const expired = await invite(app.baseUrl, adminCookie, { count: 1, expiresAt: '2020-01-01T00:00:00.000Z' })
    const expiredRegister = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'old@example.com', password: userPassword, invitationCode: expired[0]!.code },
    })
    assert.equal(expiredRegister.status, 400)
    const revoked = await invite(app.baseUrl, adminCookie, { count: 1, maxUses: 2 })
    const revoke = await api(app.baseUrl, 'POST', `/api/admin/invitations/${revoked[0]!.id}/revoke`, { cookie: adminCookie, body: {} })
    assert.equal(revoke.status, 200)
    const afterRevoke = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'revoked@example.com', password: userPassword, invitationCode: revoked[0]!.code },
    })
    assert.equal(afterRevoke.status, 400)
    const once = await invite(app.baseUrl, adminCookie, { count: 1, maxUses: 1 })
    const [first, second] = await Promise.all([
      api(app.baseUrl, 'POST', '/api/register', { body: { email: 'one@example.com', password: userPassword, invitationCode: once[0]!.code } }),
      api(app.baseUrl, 'POST', '/api/register', { body: { email: 'two@example.com', password: userPassword, invitationCode: once[0]!.code } }),
    ])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, [201, 400])
  } finally {
    await app.close()
  }
})

test('mail transport is blocked unless the fixture is explicit', async () => {
  const blocked = await boot()
  try {
    const codes = await invite(blocked.app.baseUrl, blocked.adminCookie)
    const user = await api(blocked.app.baseUrl, 'POST', '/api/register', {
      body: { email: 'mail@example.com', password: userPassword, invitationCode: codes[0]!.code },
    })
    assert.equal(user.status, 201)
    const forgot = await api(blocked.app.baseUrl, 'POST', '/api/account/password/forgot', { body: { email: 'mail@example.com' } })
    assert.equal(forgot.status, 503)
    assert.equal(forgot.json.error.code, 'mail_transport_unconfigured')
    const mailbox = await api(blocked.app.baseUrl, 'GET', '/api/test/mailbox?email=mail@example.com')
    assert.equal(mailbox.status, 404)
  } finally {
    await blocked.app.close()
  }

  const app = await start({ allowMailFixture: true, mailTransport: 'fixture' })
  try {
    await initAdmin(app.db, app.config, adminEmail, adminPassword)
    const admin = await api(app.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
    const codes = await invite(app.baseUrl, admin.cookie!)
    const registered = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'verify@example.com', password: userPassword, invitationCode: codes[0]!.code },
    })
    assert.equal(registered.status, 201)
    const before = await api(app.baseUrl, 'POST', '/api/login', { body: { email: 'verify@example.com', password: userPassword } })
    assert.notEqual(before.status, 200)
    const box = await api(app.baseUrl, 'GET', '/api/test/mailbox?email=verify@example.com')
    assert.equal(box.json.realDelivery, false)
    const verifyToken = box.json.messages.find((message: { kind: string }) => message.kind === 'verify').token as string
    const verified = await api(app.baseUrl, 'POST', '/api/account/email/verify', { body: { token: verifyToken } })
    assert.equal(verified.status, 200)
    const login = await api(app.baseUrl, 'POST', '/api/login', { body: { email: 'verify@example.com', password: userPassword } })
    assert.equal(login.status, 200)
    const forgot = await api(app.baseUrl, 'POST', '/api/account/password/forgot', { body: { email: 'verify@example.com' } })
    assert.equal(forgot.json.realDelivery, false)
    const resetBox = await api(app.baseUrl, 'GET', '/api/test/mailbox?email=verify@example.com')
    const resetToken = resetBox.json.messages.find((message: { kind: string }) => message.kind === 'reset').token as string
    const reset = await api(app.baseUrl, 'POST', '/api/account/password/reset', { body: { token: resetToken, newPassword: 'ResetPassw0rd!123' } })
    assert.equal(reset.status, 200)
    const again = await api(app.baseUrl, 'POST', '/api/login', { body: { email: 'verify@example.com', password: 'ResetPassw0rd!123' } })
    assert.equal(again.status, 200)
    const sessions = await api(app.baseUrl, 'GET', '/api/account/sessions', { cookie: again.cookie })
    assert.ok(sessions.json.sessions.length >= 1)
    const current = sessions.json.sessions.find((row: { current: boolean }) => row.current)
    const revoked = await api(app.baseUrl, 'POST', `/api/account/sessions/${current.id}/revoke`, { cookie: again.cookie, body: {} })
    assert.equal(revoked.status, 200)
    const gone = await api(app.baseUrl, 'GET', '/api/me', { cookie: again.cookie })
    assert.equal(gone.status, 401)
  } finally {
    await app.close()
  }
})

test('recharge stays uncredited until the explicit test adapter, then 5.00 spend becomes 4.00', async () => {
  const { app, adminCookie } = await boot({
    allowTestPayments: true,
    priceCurrency: 'CNY',
    prices: { 'deepseek-flash': { input_per_million: 70, output_per_million: 70 } },
    billingReserveFen: 200,
    fixturePromptTokens: 1_000_000,
    fixtureCompletionTokens: 0,
  })
  try {
    const codes = await invite(app.baseUrl, adminCookie)
    const user = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'pay@example.com', password: userPassword, invitationCode: codes[0]!.code },
    })
    const otherCodes = await invite(app.baseUrl, adminCookie)
    const other = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'other-pay@example.com', password: userPassword, invitationCode: otherCodes[0]!.code },
    })
    const pending = await api(app.baseUrl, 'POST', '/api/wallet/recharge', {
      cookie: user.cookie,
      body: { amountFen: 500, requestId: 'order-5' },
    })
    assert.equal(pending.status, 201)
    assert.equal(pending.json.credited, false)
    assert.equal(pending.json.realPayment, false)
    const before = await api(app.baseUrl, 'GET', '/api/wallet', { cookie: user.cookie })
    assert.equal(before.json.wallet.availableFen, 0)
    assert.equal(before.json.wallet.availableDisplay, '0.00')
    const hidden = await api(app.baseUrl, 'GET', '/api/admin/ledger?userId=' + user.json.user.id, { cookie: other.cookie })
    assert.equal(hidden.status, 403)
    const confirmed = await api(app.baseUrl, 'POST', `/api/wallet/recharge/${pending.json.order.id}/test-confirm`, { cookie: user.cookie, body: {} })
    assert.equal(confirmed.json.realCredit, false)
    assert.equal(confirmed.json.adapter, 'test')
    assert.equal(confirmed.json.wallet.availableDisplay, '5.00')
    const again = await api(app.baseUrl, 'POST', `/api/wallet/recharge/${pending.json.order.id}/test-confirm`, { cookie: user.cookie, body: {} })
    assert.equal(again.json.alreadyPosted, true)
    assert.equal(again.json.wallet.availableFen, 500)
    const image = await api(app.baseUrl, 'POST', '/api/images', { cookie: user.cookie, body: {} })
    assert.equal(image.status, 501)
    const conversation = await api(app.baseUrl, 'POST', '/api/conversations', {
      cookie: user.cookie,
      body: { space: 'workspace', model: 'deepseek-flash' },
    })
    const streamed = await sse(app.baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, { content: '扣费' }, user.cookie!)
    assert.equal(streamed.status, 200)
    const done = streamed.events.find((event) => event.event === 'done')
    assert.equal(done?.data.chargeFen, 100)
    assert.equal(done?.data.realUpstreamCharge, false)
    assert.equal(done?.data.providerCostStatus, 'fixture')
    assert.equal(done?.data.wallet.availableDisplay, '4.00')
    assert.equal(done?.data.wallet.availableFen, 400)
    const adminMoney = await api(app.baseUrl, 'GET', '/api/admin/money', { cookie: adminCookie })
    assert.equal(adminMoney.json.prepaidRechargeFen, 500)
    assert.equal(adminMoney.json.fixtureChargeFen, 100)
    assert.equal(adminMoney.json.estimatedServiceChargeFen, 0)
  } finally {
    await app.close()
  }
})

test('concurrent holds cannot drive the balance negative', async () => {
  const { app, adminCookie } = await boot({
    allowTestPayments: true,
    priceCurrency: 'CNY',
    prices: { 'deepseek-flash': { input_per_million: 70, output_per_million: 70 } },
    billingReserveFen: 400,
    fixturePromptTokens: 1_000_000,
    fixtureCompletionTokens: 0,
  })
  try {
    const codes = await invite(app.baseUrl, adminCookie)
    const user = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'race@example.com', password: userPassword, invitationCode: codes[0]!.code },
    })
    const pending = await api(app.baseUrl, 'POST', '/api/wallet/recharge', {
      cookie: user.cookie,
      body: { amountFen: 500, requestId: 'order-race' },
    })
    await api(app.baseUrl, 'POST', `/api/wallet/recharge/${pending.json.order.id}/test-confirm`, { cookie: user.cookie, body: {} })
    const first = await api(app.baseUrl, 'POST', '/api/conversations', { cookie: user.cookie, body: { space: 'workspace' } })
    const second = await api(app.baseUrl, 'POST', '/api/conversations', { cookie: user.cookie, body: { space: 'workspace' } })
    const [a, b] = await Promise.all([
      sse(app.baseUrl, `/api/conversations/${first.json.conversation.id}/messages`, { content: 'a' }, user.cookie!),
      sse(app.baseUrl, `/api/conversations/${second.json.conversation.id}/messages`, { content: 'b' }, user.cookie!),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [200, 402])
    const wallet = await api(app.baseUrl, 'GET', '/api/wallet', { cookie: user.cookie })
    assert.ok(wallet.json.wallet.availableFen >= 0)
    assert.ok(wallet.json.wallet.frozenFen >= 0)
    assert.ok(wallet.json.wallet.availableFen + wallet.json.wallet.frozenFen <= 500)
  } finally {
    await app.close()
  }
})

test('ordinary user cannot open admin wallet tools', async () => {
  const { app, adminCookie } = await boot({ allowTestPayments: true })
  try {
    const codes = await invite(app.baseUrl, adminCookie)
    const user = await api(app.baseUrl, 'POST', '/api/register', {
      body: { email: 'member@example.com', password: userPassword, invitationCode: codes[0]!.code },
    })
    const denied = await api(app.baseUrl, 'POST', '/api/admin/wallet/adjust', {
      cookie: user.cookie,
      body: { userId: user.json.user.id, amountFen: 100, direction: 'credit', reason: 'no', requestId: 'x' },
    })
    assert.equal(denied.status, 403)
    const adjusted = await api(app.baseUrl, 'POST', '/api/admin/wallet/adjust', {
      cookie: adminCookie,
      body: { userId: user.json.user.id, amountFen: 100, direction: 'credit', reason: 'manual', requestId: 'adj-1' },
    })
    assert.equal(adjusted.status, 200)
    const repeat = await api(app.baseUrl, 'POST', '/api/admin/wallet/adjust', {
      cookie: adminCookie,
      body: { userId: user.json.user.id, amountFen: 100, direction: 'credit', reason: 'manual', requestId: 'adj-1' },
    })
    assert.equal(repeat.json.idempotent, true)
    const wallet = await api(app.baseUrl, 'GET', '/api/wallet', { cookie: user.cookie })
    assert.equal(wallet.json.wallet.availableFen, 100)
  } finally {
    await app.close()
  }
})
