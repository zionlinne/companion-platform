import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { type AppConfig, loadConfig, type ModelPrice } from '../src/config.ts'
import { createApp } from '../src/create-app.ts'
import { migrate, openDatabase } from '../src/db.ts'
import { startFixture, type FixtureState } from '../src/fixture-provider.ts'
import { createLogger, type Logger } from '../src/log.ts'
import { resetLoginFailures } from '../src/create-app.ts'
import type { DatabaseSync } from 'node:sqlite'

export type Running = {
  baseUrl: string
  db: DatabaseSync
  config: AppConfig
  log: Logger
  fixture: { url: string; state: FixtureState; close: () => Promise<void> } | null
  dir: string
  close: (options?: { keepDir?: boolean }) => Promise<void>
}

export async function start(options?: {
  mode?: 'live' | 'fixture'
  apiKey?: string | null
  prices?: Record<string, ModelPrice>
  priceCurrency?: 'CNY' | 'USD' | 'unset'
  marginBps?: number
  billingReserveFen?: number
  allowMailFixture?: boolean
  mailTransport?: 'unconfigured' | 'fixture'
  allowTestPayments?: boolean
  fixturePromptTokens?: number | null
  fixtureCompletionTokens?: number | null
  fxCnyFenPerUsd?: number | null
  fxSource?: string | null
  fxQuotedAt?: string | null
  baseUrl?: string
  databasePath?: string
  dataDir?: string
  dir?: string
}): Promise<Running> {
  resetLoginFailures()
  const mode = options?.mode ?? 'fixture'
  const dir = options?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'))
  const fixture = mode === 'fixture' ? await startFixture() : null
  const config = loadConfig(
    { NODE_ENV: 'test' },
    {
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 0,
      databasePath: options?.databasePath ?? path.join(dir, 'app.sqlite'),
      dataDir: options?.dataDir ?? path.join(dir, 'data'),
      staticDir: null,
      gatewayMode: mode,
      allowGatewayFixture: mode === 'fixture',
      fixtureBaseUrl: fixture?.url ?? null,
      deepseekApiKey: options?.apiKey === undefined ? 'sk-test-should-not-leak-9f3a' : options.apiKey,
      deepseekBaseUrl: options?.baseUrl ?? 'https://api.deepseek.com',
      prices: options?.prices ?? {},
      allowTestClock: true,
      loginLimit: 100,
      initiativePollMs: 0,
      betterAuthSecret: '0123456789abcdef0123456789abcdef',
      priceCurrency: options?.priceCurrency,
      marginBps: options?.marginBps,
      billingReserveFen: options?.billingReserveFen,
      allowMailFixture: options?.allowMailFixture,
      mailTransport: options?.mailTransport,
      allowTestPayments: options?.allowTestPayments,
      fixturePromptTokens: options?.fixturePromptTokens,
      fixtureCompletionTokens: options?.fixtureCompletionTokens,
      fxCnyFenPerUsd: options?.fxCnyFenPerUsd,
      fxSource: options?.fxSource,
      fxQuotedAt: options?.fxQuotedAt,
    }
  )
  const db = openDatabase(config.databasePath)
  migrate(db)
  const log = createLogger(() => {})
  const app = createApp({ db, config, log })
  const server = http.createServer((req, res) => {
    void app.listener(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    config,
    log,
    fixture,
    dir,
    close: async ({ keepDir } = {}) => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
      if (fixture) await fixture.close()
      if (!keepDir) fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function sessionCookie(response: Response): string | undefined {
  const rows = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const raw = rows.find((row) => row.startsWith('cp_session='))
  return raw ? raw.split(';')[0] : undefined
}

export async function api(
  baseUrl: string,
  method: string,
  pathname: string,
  options?: { cookie?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> }
) {
  const headers: Record<string, string> = { 'X-Companion-Request': '1', ...(options?.headers ?? {}) }
  if (options?.cookie) headers.Cookie = options.cookie
  let body: string | Buffer | undefined
  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  } else if (options?.raw) body = options.raw
  const response = await fetch(baseUrl + pathname, { method, headers, body })
  const text = await response.text()
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: response.status, json: parsed, text, cookie: sessionCookie(response), headers: response.headers }
}

export async function sse(baseUrl: string, pathname: string, body: unknown, cookie: string) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Companion-Request': '1', Cookie: cookie },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const events: Array<{ event: string; data: any }> = []
  for (const block of text.split('\n\n')) {
    const event = /event: (.+)/.exec(block)?.[1]
    const data = /data: (.*)/.exec(block)?.[1]
    if (event && data) events.push({ event, data: JSON.parse(data) })
  }
  return { status: response.status, events, text }
}
