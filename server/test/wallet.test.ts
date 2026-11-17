import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { initAdmin } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { many, migrate, migrationSql, one, openDatabase, run } from '../src/db.ts'
import { userChargeFen } from '../src/money.ts'
import { flushObservations } from '../src/memory-engine.ts'
import { abortBill, closeBill, confirmRecharge, createRechargeOrder, openBill, readWallet, saveQr } from '../src/wallet.ts'
import { api, sse, start, type Running } from './harness.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const migrations = path.join(root, 'server/migrations')
const adminEmail = 'admin@example.com'
const adminPassword = 'AdminPassw0rd!123'
const userPassword = 'UserPassw0rd!123'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

async function boot(options?: Parameters<typeof start>[0]) {
  const app = await start(options)
  await initAdmin(app.db, app.config, adminEmail, adminPassword)
  const admin = await api(app.baseUrl, 'POST', '/api/login', { body: { email: adminEmail, password: adminPassword } })
  assert.equal(admin.status, 200)
  return { app, adminCookie: admin.cookie! }
}

async function userPair(app: Running, adminCookie: string, email: string) {
  const invited = await api(app.baseUrl, 'POST', '/api/admin/invitations', { cookie: adminCookie, body: { count: 1 } })
  assert.equal(invited.status, 201)
  const registered = await api(app.baseUrl, 'POST', '/api/register', {
    body: { email, password: userPassword, invitationCode: invited.json.invitations[0].code, displayName: 'User' },
  })
  assert.equal(registered.status, 201)
  return registered.cookie!
}

test('margin formula is C/(1-M), not a flat 1.3 multiple', () => {
  assert.equal(userChargeFen(100, 3000), 143)
  assert.notEqual(userChargeFen(100, 3000), 130)
  assert.equal(userChargeFen(70, 3000), 100)
  assert.equal(userChargeFen(0, 3000), 0)
})

test('sqlite migration keeps the old account, session, and memory at a zero balance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-old-'))
  const db = openDatabase({ databaseUrl: null, databasePath: path.join(dir, 'app.sqlite') })
  await applyThrough(db, 'sqlite', '003_memory_engine.sql')
  await run(
    db,
    `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at)
     VALUES ('old-user', 'old@example.com', 'scrypt-keep', 'Old', 'user', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, NULL)`
  )
  await run(
    db,
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
     VALUES ('old-session', 'old-user', 'hash-keep', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL)`
  )
  await run(
    db,
    `INSERT INTO memories (
       id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at, confidence, space
     ) VALUES ('mem-old', 'old-user', NULL, 'fact', 'OLD_MEMORY_KEEP', 'user-note', 1, '', 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 1, 'workspace')`
  )
  const ran = await migrate(db)
  assert.deepEqual(ran, ['004_wallet.sql'])
  const user = await one<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE id = 'old-user'`)
  assert.equal(user?.password_hash, 'scrypt-keep')
  const session = await one<{ id: string }>(db, `SELECT id FROM sessions WHERE id = 'old-session'`)
  assert.equal(session?.id, 'old-session')
  const memory = await one<{ content: string }>(db, `SELECT content FROM memories WHERE id = 'mem-old'`)
  assert.equal(memory?.content, 'OLD_MEMORY_KEEP')
  const wallet = await one<{ available_fen: number }>(db, `SELECT available_fen FROM wallets WHERE user_id = 'old-user'`)
  assert.equal(wallet?.available_fen, 0)
  await db.close()
})

test('postgres migration keeps the old account at a zero balance', async () => {
  const name = `wallet_${process.pid}_${Date.now().toString(36)}`
  const adminUrl = 'postgresql://ubuntu@/postgres?host=/var/run/postgresql'
  execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`], { stdio: 'pipe' })
  const db = openDatabase({ databaseUrl: `postgresql://ubuntu@/${name}?host=/var/run/postgresql`, databasePath: '' })
  try {
    await applyThrough(db, 'postgres', '003_memory_engine.sql')
    await run(
      db,
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at)
       VALUES ('old-user', 'old@example.com', 'scrypt-keep', 'Old', 'user', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, NULL)`
    )
    await run(
      db,
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
       VALUES ('old-session', 'old-user', 'hash-keep', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL)`
    )
    const ran = await migrate(db)
    assert.deepEqual(ran, ['004_wallet.sql'])
    const user = await one<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE id = 'old-user'`)
    assert.equal(user?.password_hash, 'scrypt-keep')
    const session = await one<{ id: string }>(db, `SELECT id FROM sessions WHERE id = 'old-session'`)
    assert.equal(session?.id, 'old-session')
    const wallet = await one<{ available_fen: number }>(db, `SELECT available_fen FROM wallets WHERE user_id = 'old-user'`)
    assert.equal(Number(wallet?.available_fen), 0)
  } finally {
    await db.close()
    execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${name} WITH (FORCE)`], { stdio: 'pipe' })
  }
})

test('manual alipay review never credits before an explicit admin confirm', async () => {
  const { app, adminCookie } = await boot()
  try {
    const cookie = await userPair(app, adminCookie, 'payer@example.com')
    const other = await userPair(app, adminCookie, 'other@example.com')
    const opened = await api(app.baseUrl, 'GET', '/api/wallet', { cookie })
    assert.equal(opened.status, 200)
    assert.equal(opened.json.wallet.availableFen, 0)
    assert.equal(opened.json.qr.enabled, false)
    assert.equal(opened.json.billing.state, 'off')
    assert.match(opened.json.billing.note, /不扣余额/)
    assert.equal(opened.json.boundaries.automaticAlipay, false)
    assert.equal(opened.json.boundaries.emailRecovery, false)

    const blocked = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie,
      body: { amountFen: 500, requestId: 'request-blocked-500' },
    })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.error.code, 'qr_not_configured')

    const tamper = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie,
      body: { amountFen: 100, amountYuan: 5, requestId: 'request-tamper' },
    })
    assert.equal(tamper.status, 400)

    const outsider = await api(app.baseUrl, 'POST', '/api/admin/recharge/qr', {
      cookie,
      body: { imageBase64: png },
    })
    assert.equal(outsider.status, 403)
    const badImage = await api(app.baseUrl, 'POST', '/api/admin/recharge/qr', {
      cookie: adminCookie,
      body: { imageBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64') },
    })
    assert.equal(badImage.status, 400)
    const saved = await api(app.baseUrl, 'POST', '/api/admin/recharge/qr', {
      cookie: adminCookie,
      body: { imageBase64: png },
    })
    assert.equal(saved.status, 200)
    const image = await fetch(app.baseUrl + '/api/recharge/qr', { headers: { Cookie: cookie, 'X-Companion-Request': '1' } })
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await image.arrayBuffer())
    assert.equal(bytes[0], 0x89)

    const created = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie,
      body: { amountFen: 500, requestId: 'request-sim-500' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.credited, false)
    assert.equal(created.json.wallet.availableFen, 0)
    assert.equal(created.json.order.status, 'pending')
    const orderId = created.json.order.id as string
    const again = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie,
      body: { amountFen: 500, requestId: 'request-sim-500' },
    })
    assert.equal(again.json.order.id, orderId)

    const claimed = await api(app.baseUrl, 'POST', `/api/recharge/orders/${orderId}/reference`, {
      cookie,
      body: { reference: 'USERCLAIM1' },
    })
    assert.equal(claimed.status, 200)
    assert.equal(claimed.json.credited, false)
    assert.equal(claimed.json.wallet.availableFen, 0)
    assert.equal(claimed.json.order.status, 'submitted')

    const cross = await api(app.baseUrl, 'POST', `/api/recharge/orders/${orderId}/reference`, {
      cookie: other,
      body: { reference: 'OTHERCLAIM' },
    })
    assert.equal(cross.status, 404)
    const notAdmin = await api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${orderId}/confirm`, {
      cookie,
      body: { paymentReference: 'SIMALIPAY500', note: '模拟账单核对，不是自动到账', acknowledged: true, amountFen: 1 },
    })
    assert.equal(notAdmin.status, 403)
    const missingAck = await api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${orderId}/confirm`, {
      cookie: adminCookie,
      body: { paymentReference: 'SIMALIPAY500', note: '模拟账单核对，不是自动到账', acknowledged: false },
    })
    assert.equal(missingAck.status, 400)
    const stillZero = await api(app.baseUrl, 'GET', '/api/wallet', { cookie })
    assert.equal(stillZero.json.wallet.availableFen, 0)

    const [first, second] = await Promise.all([
      api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${orderId}/confirm`, {
        cookie: adminCookie,
        body: { paymentReference: 'SIMALIPAY500', note: '模拟账单核对，不是自动到账', acknowledged: true, amountFen: 1 },
      }),
      api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${orderId}/confirm`, {
        cookie: adminCookie,
        body: { paymentReference: 'SIMALIPAY500', note: '模拟账单核对，不是自动到账', acknowledged: true, amountFen: 999999 },
      }),
    ])
    const credited = [first, second].filter((item) => item.json?.credited === true)
    assert.equal(credited.length, 1)
    const paid = await api(app.baseUrl, 'GET', '/api/wallet', { cookie })
    assert.equal(paid.json.wallet.availableFen, 500)
    assert.equal(JSON.stringify(paid.json).includes('secret-chat-should-not-appear'), false)

    const otherOrder = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie: other,
      body: { amountFen: 1000, requestId: 'request-other-1000' },
    })
    const duplicate = await api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${otherOrder.json.order.id}/confirm`, {
      cookie: adminCookie,
      body: { paymentReference: 'SIMALIPAY500', note: '同一流水不能再次入账', acknowledged: true },
    })
    assert.equal(duplicate.status, 409)
    const otherWallet = await api(app.baseUrl, 'GET', '/api/wallet', { cookie: other })
    assert.equal(otherWallet.json.wallet.availableFen, 0)

    const rejectedOrder = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie,
      body: { amountFen: 2000, requestId: 'request-reject-2000' },
    })
    const rejected = await api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${rejectedOrder.json.order.id}/reject`, {
      cookie: adminCookie,
      body: { note: '模拟账单里没有这笔', acknowledged: true },
    })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.json.credited, false)
    const afterReject = await api(app.baseUrl, 'GET', '/api/wallet', { cookie })
    assert.equal(afterReject.json.wallet.availableFen, 500)
    const confirmRejected = await api(app.baseUrl, 'POST', `/api/admin/recharge/orders/${rejectedOrder.json.order.id}/confirm`, {
      cookie: adminCookie,
      body: { paymentReference: 'SIMALIPAYREJECT', note: '不应该入账', acknowledged: true },
    })
    assert.equal(confirmRejected.status, 409)

    const cancelledOrder = await api(app.baseUrl, 'POST', '/api/recharge/orders', {
      cookie,
      body: { amountFen: 5000, requestId: 'request-cancel-5000' },
    })
    const cancelled = await api(app.baseUrl, 'POST', `/api/recharge/orders/${cancelledOrder.json.order.id}/cancel`, { cookie, body: {} })
    assert.equal(cancelled.json.order.status, 'cancelled')
    assert.equal(cancelled.json.wallet.availableFen, 500)

    const audits = await api(app.baseUrl, 'GET', '/api/admin/audit', { cookie: adminCookie })
    assert.equal(audits.status, 200)
    const auditText = JSON.stringify(audits.json)
    assert.match(auditText, /recharge_confirm/)
    assert.equal(auditText.includes('SIMALIPAY500'), false)
    assert.equal(auditText.includes('secret-chat-should-not-appear'), false)
    const userAudit = await api(app.baseUrl, 'GET', '/api/admin/audit', { cookie })
    assert.equal(userAudit.status, 403)
  } finally {
    await app.close()
  }
})

test('billing stays off for a zero balance and only settles a configured live quote once', async () => {
  const { app, adminCookie } = await boot()
  try {
    const conversation = await api(app.baseUrl, 'POST', '/api/conversations', {
      cookie: adminCookie,
      body: { space: 'workspace', title: 'trial' },
    })
    const chat = await sse(app.baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, {
      content: 'secret-chat-should-not-appear',
    }, adminCookie)
    assert.equal(chat.status, 200)
    const wallet = await api(app.baseUrl, 'GET', '/api/wallet', { cookie: adminCookie })
    assert.equal(wallet.json.wallet.availableFen, 0)
    assert.equal(wallet.json.billing.state, 'off')
    assert.equal(JSON.stringify(wallet.json).includes('secret-chat-should-not-appear'), false)
  } finally {
    await app.close()
  }

  const priced = await boot({
    billingEnabled: true,
    priceCurrency: 'CNY',
    prices: { 'deepseek-flash': { input_per_million: 70, output_per_million: 70 } },
    billingReserveFen: 80,
  })
  try {
    const admin = await one<{ id: string }>(priced.app.db, `SELECT id FROM users WHERE email = ?`, adminEmail)
    assert.ok(admin)
    await run(
      priced.app.db,
      `UPDATE wallets SET available_fen = 1000, recharge_fen = 1000 WHERE user_id = ?`,
      admin.id
    )
    const conversation = await api(priced.app.baseUrl, 'POST', '/api/conversations', {
      cookie: priced.adminCookie,
      body: { space: 'workspace', title: 'fixture bill' },
    })
    const chat = await sse(priced.app.baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, {
      content: 'fixture should not bill',
    }, priced.adminCookie)
    assert.equal(chat.status, 200)
    await flushObservations()
    const afterFixture = await readWallet(priced.app.db, admin.id)
    assert.equal(afterFixture.available_fen, 1000)
    assert.equal(afterFixture.frozen_fen, 0)
    const usageRows = await many<{ kind: string; status: string; charge_fen: number | null; request_id: string }>(
      priced.app.db,
      `SELECT kind, status, charge_fen, request_id FROM model_usage_records WHERE user_id = ?`,
      admin.id
    )
    assert.equal(usageRows.filter((row) => row.kind === 'chat').length, 1)
    assert.equal(usageRows.filter((row) => row.kind === 'memory').length, 1)
    assert.equal(new Set(usageRows.map((row) => row.request_id)).size, usageRows.length)
    assert.equal(usageRows.every((row) => row.charge_fen === null), true)

    const config = loadConfig({ NODE_ENV: 'test' }, {
      ...priced.app.config,
      billingEnabled: true,
      priceCurrency: 'CNY',
      prices: { 'deepseek-flash': { input_per_million: 70, output_per_million: 70 } },
    })
    const first = await closeBill(priced.app.db, config, {
      userId: admin.id,
      requestId: 'live-sim-1',
      kind: 'chat',
      model: 'deepseek-flash',
      promptTokens: 1_000_000,
      completionTokens: 0,
      source: 'live',
    })
    assert.equal(first.status, 'settled')
    const spent = await readWallet(priced.app.db, admin.id)
    assert.equal(spent.available_fen, 900)
    assert.equal(spent.spent_fen, 100)
    const second = await closeBill(priced.app.db, config, {
      userId: admin.id,
      requestId: 'live-sim-1',
      kind: 'chat',
      model: 'deepseek-flash',
      promptTokens: 1_000_000,
      completionTokens: 0,
      source: 'live',
    })
    assert.equal(second.idempotent, true)
    const still = await readWallet(priced.app.db, admin.id)
    assert.equal(still.available_fen, 900)

    const unknown = await closeBill(priced.app.db, config, {
      userId: admin.id,
      requestId: 'live-unknown',
      kind: 'memory',
      model: 'deepseek-flash',
      promptTokens: null,
      completionTokens: null,
      source: 'live',
    })
    assert.equal(unknown.status, 'unknown')
    assert.equal((await readWallet(priced.app.db, admin.id)).available_fen, 900)

    await openBill(priced.app.db, config, admin.id, 'hold-fail')
    await abortBill(priced.app.db, admin.id, 'hold-fail')
    const released = await readWallet(priced.app.db, admin.id)
    assert.equal(released.available_fen, 900)
    assert.equal(released.frozen_fen, 0)

    await assert.rejects(
      openBill(priced.app.db, { ...config, billingReserveFen: 50_000 }, admin.id, 'too-big'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'insufficient_balance'
    )
    assert.equal((await readWallet(priced.app.db, admin.id)).available_fen, 900)
  } finally {
    await priced.app.close()
  }

  const broke = await boot({
    billingEnabled: true,
    priceCurrency: 'CNY',
    prices: { 'deepseek-flash': { input_per_million: 70, output_per_million: 70 } },
  })
  try {
    const conversation = await api(broke.app.baseUrl, 'POST', '/api/conversations', {
      cookie: broke.adminCookie,
      body: { space: 'workspace', title: 'broke' },
    })
    const denied = await api(broke.app.baseUrl, 'POST', `/api/conversations/${conversation.json.conversation.id}/messages`, {
      cookie: broke.adminCookie,
      body: { content: 'do not call' },
    })
    assert.equal(denied.status, 402)
    const wallet = await api(broke.app.baseUrl, 'GET', '/api/wallet', { cookie: broke.adminCookie })
    assert.equal(wallet.json.wallet.availableFen, 0)
    assert.match(wallet.json.billing.note, /UserCharge/)
  } finally {
    await broke.app.close()
  }

  const unpriced = await boot({ billingEnabled: true })
  try {
    const wallet = await api(unpriced.app.baseUrl, 'GET', '/api/wallet', { cookie: unpriced.adminCookie })
    assert.equal(wallet.json.billing.state, 'unpriced')
    assert.match(wallet.json.billing.note, /不会猜测/)
    const conversation = await api(unpriced.app.baseUrl, 'POST', '/api/conversations', {
      cookie: unpriced.adminCookie,
      body: { space: 'workspace', title: 'unpriced' },
    })
    const chat = await sse(unpriced.app.baseUrl, `/api/conversations/${conversation.json.conversation.id}/messages`, {
      content: 'still free',
    }, unpriced.adminCookie)
    assert.equal(chat.status, 200)
  } finally {
    await unpriced.app.close()
  }
})

test('postgres manual confirm is idempotent and does not credit a duplicate reference', async () => {
  const name = `wallet_pay_${process.pid}_${Date.now().toString(36)}`
  const adminUrl = 'postgresql://ubuntu@/postgres?host=/var/run/postgresql'
  execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`], { stdio: 'pipe' })
  const databaseUrl = `postgresql://ubuntu@/${name}?host=/var/run/postgresql`
  const config = loadConfig({ NODE_ENV: 'test' }, {
    nodeEnv: 'test',
    databaseUrl,
    databasePath: path.join(os.tmpdir(), 'unused-wallet.sqlite'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-pg-')),
    gatewayMode: 'live',
    deepseekApiKey: null,
    billingEnabled: false,
  })
  const db = openDatabase(config)
  try {
    await migrate(db)
    const admin = await initAdmin(db, config, 'pg-admin@example.com', 'AdminPassw0rd!123')
    await saveQr(db, admin.id, png)
    const order = await createRechargeOrder(db, admin.id, 500, 'pg-request-500')
    const first = await confirmRecharge(db, admin.id, order.id, {
      paymentReference: 'SIMPG500',
      note: '模拟账单核对，不是自动到账',
      acknowledged: true,
    })
    assert.equal(first.credited, true)
    const second = await confirmRecharge(db, admin.id, order.id, {
      paymentReference: 'SIMPG500',
      note: '模拟账单核对，不是自动到账',
      acknowledged: true,
    })
    assert.equal(second.credited, false)
    assert.equal((await readWallet(db, admin.id)).available_fen, 500)
    const other = await createRechargeOrder(db, admin.id, 1000, 'pg-request-1000')
    await assert.rejects(
      confirmRecharge(db, admin.id, other.id, {
        paymentReference: 'SIMPG500',
        note: '同一流水不能再次入账',
        acknowledged: true,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'duplicate_payment_reference'
    )
    assert.equal((await readWallet(db, admin.id)).available_fen, 500)
  } finally {
    await db.close()
    execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${name} WITH (FORCE)`], { stdio: 'pipe' })
  }
})

async function applyThrough(db: ReturnType<typeof openDatabase>, kind: 'sqlite' | 'postgres', last: string) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const files = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()
  for (const file of files) {
    if (file > last) break
    await db.exec(migrationSql(fs.readFileSync(path.join(migrations, file), 'utf8'), kind))
    await db.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, [file, '2020-01-01T00:00:00.000Z'])
  }
}
