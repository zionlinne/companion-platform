import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bootstrapAdmin } from '../src/auth.ts'
import { loadConfig, type AppConfig } from '../src/config.ts'
import { createApp } from '../src/create-app.ts'
import { migrate, openDatabase, type SqlDb } from '../src/db.ts'
import { createLogger } from '../src/log.ts'
import { verifyPassword } from '../src/password.ts'

const secretPassword = 'BootstrapSecretValue99'
const secretEmail = 'bootstrap-secret-name@example.com'

function configFor(options: { dir: string; databaseUrl?: string }): AppConfig {
  return loadConfig(
    { NODE_ENV: 'test' },
    {
      nodeEnv: 'test',
      databaseUrl: options.databaseUrl ?? null,
      databasePath: path.join(options.dir, 'app.sqlite'),
      dataDir: options.dir,
      gatewayMode: 'live',
      deepseekApiKey: null,
      host: '127.0.0.1',
      port: 0,
      initiativePollMs: 0,
    }
  )
}

async function openTemp(databaseUrl?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'))
  const config = configFor({ dir, databaseUrl })
  const db = openDatabase(config)
  await migrate(db)
  return { dir, config, db }
}

test('startup bootstrap creates one admin and does not log the credentials', async () => {
  const { dir, config, db } = await openTemp()
  try {
    const idle = createLogger(() => {})
    assert.equal(await bootstrapAdmin(db, config, undefined, undefined, idle), 'skipped')
    assert.equal(await bootstrapAdmin(db, config, secretEmail, 'short', idle), 'rejected')
    const users = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)
    assert.equal(Number(users?.n ?? 0), 0)
    const log = createLogger(() => {})
    assert.equal(await bootstrapAdmin(db, config, secretEmail, secretPassword, log), 'created')
    const text = log.lines.join('\n')
    assert.equal(text.includes(secretPassword), false)
    assert.equal(text.includes(secretEmail), false)
    assert.match(text, /"result":"created"/)
    const row = await db.get<{ password_hash: string; email: string }>(`SELECT email, password_hash FROM users WHERE role = 'admin'`)
    assert.equal(row?.email, secretEmail)
    assert.equal(await verifyPassword(secretPassword, row?.password_hash ?? ''), true)
    const again = createLogger(() => {})
    assert.equal(await bootstrapAdmin(db, config, 'other-admin@example.com', 'AnotherSecretValue99', again), 'exists')
    const after = await db.get<{ n: number; password_hash: string }>(
      `SELECT COUNT(*) AS n, MIN(password_hash) AS password_hash FROM users WHERE role = 'admin' AND deleted_at IS NULL`
    )
    assert.equal(Number(after?.n ?? 0), 1)
    assert.equal(after?.password_hash, row?.password_hash)
    assert.equal(again.lines.join('\n').includes('AnotherSecretValue99'), false)
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent bootstrap creates one admin', async () => {
  const { dir, config, db } = await openTemp()
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => bootstrapAdmin(db, config, secretEmail, secretPassword, createLogger(() => {})))
    )
    assert.equal(results.filter((item) => item === 'created').length, 1)
    assert.equal(results.filter((item) => item === 'exists').length, 5)
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`)
    assert.equal(Number(row?.n ?? 0), 1)
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('health says registration is unavailable until an admin exists and init stays off HTTP', async () => {
  const { dir, config, db } = await openTemp()
  const log = createLogger(() => {})
  const app = createApp({ db, config, log })
  const server = http.createServer((req, res) => {
    void app.listener(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  try {
    const before = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    assert.equal((await before.json()).registration, 'unavailable')
    const denied = await fetch(`http://127.0.0.1:${address.port}/api/admin/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Companion-Request': '1' },
      body: '{}',
    })
    assert.equal(denied.status, 404)
    assert.equal(await bootstrapAdmin(db, config, secretEmail, secretPassword, log), 'created')
    const after = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    const body = await after.json()
    assert.equal(body.ok, true)
    assert.equal(body.registration, 'needs_invite')
    assert.equal(JSON.stringify(body).includes(secretEmail), false)
    assert.equal(log.lines.join('\n').includes(secretPassword), false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('postgres bootstrap stays one admin under concurrency', async () => {
  const name = `boot_${process.pid}_${Date.now().toString(36)}`
  const adminUrl = 'postgresql://ubuntu@/postgres?host=/var/run/postgresql'
  execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`], { stdio: 'pipe' })
  const databaseUrl = `postgresql://ubuntu@/${name}?host=/var/run/postgresql`
  let db: SqlDb | null = null
  try {
    const opened = await openTemp(databaseUrl)
    db = opened.db
    const results = await Promise.all(
      Array.from({ length: 6 }, () => bootstrapAdmin(opened.db, opened.config, secretEmail, secretPassword, createLogger(() => {})))
    )
    assert.equal(results.filter((item) => item === 'created').length, 1)
    const row = await opened.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`)
    assert.equal(Number(row?.n ?? 0), 1)
    const output = results.join(',')
    assert.equal(output.includes(secretPassword), false)
  } finally {
    if (db) await db.close()
    execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${name} WITH (FORCE)`], { stdio: 'pipe' })
  }
})
