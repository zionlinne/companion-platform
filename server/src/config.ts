import path from 'node:path'
import { readUpstreamSettings } from './upstream-request.ts'

export const MODELS = [
  { id: 'deepseek-flash', label: 'deepseek-flash' },
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
] as const

export const DEFAULT_MODEL = 'deepseek-flash'

export type ModelPrice = { input_per_million: number; output_per_million: number }

export type GatewayMode = 'live' | 'fixture'

export type AppConfig = {
  nodeEnv: string
  host: string
  port: number
  databasePath: string
  dataDir: string
  staticDir: string | null
  sessionTtlHours: number
  cookieSecure: boolean
  gatewayMode: GatewayMode
  allowGatewayFixture: boolean
  deepseekBaseUrl: string
  deepseekApiKey: string | null
  fixtureBaseUrl: string | null
  prices: Record<string, ModelPrice>
  initiativePollMs: number
  allowTestClock: boolean
  loginLimit: number
  defaultDailyRequests: number
  defaultDailyTokens: number
  betterAuthSecret: string
  priceCurrency: 'CNY' | 'USD' | 'unset'
  marginBps: number
  billingReserveFen: number
  fxCnyFenPerUsd: number | null
  fxSource: string | null
  fxQuotedAt: string | null
  mailTransport: 'unconfigured' | 'fixture'
  allowMailFixture: boolean
  allowTestPayments: boolean
  fixturePromptTokens: number | null
  fixtureCompletionTokens: number | null
  deepseekModel: string | null
  reasoningEffort: 'low' | 'high' | 'max' | 'none'
  temperature: number
}

const bool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value === '') return fallback
  return value === '1' || value === 'true'
}

export function parsePrices(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('MODEL_PRICE_JSON is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_PRICE_JSON must be an object')
  }
  const prices: Record<string, ModelPrice> = {}
  for (const [model, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') throw new Error(`Invalid price for ${model}`)
    const row = value as Record<string, unknown>
    const input = row.input_per_million
    const output = row.output_per_million
    if (typeof input !== 'number' || typeof output !== 'number' || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      throw new Error(`Invalid price numbers for ${model}`)
    }
    prices[model] = { input_per_million: input, output_per_million: output }
  }
  return prices
}

export function isKnownModel(model: string): boolean {
  return MODELS.some((item) => item.id === model)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = overrides.nodeEnv ?? env.NODE_ENV ?? 'development'
  const gatewayMode = (overrides.gatewayMode ?? env.MODEL_GATEWAY_MODE ?? 'live') as GatewayMode
  if (gatewayMode !== 'live' && gatewayMode !== 'fixture') {
    throw new Error('MODEL_GATEWAY_MODE must be live or fixture')
  }
  const allowGatewayFixture = overrides.allowGatewayFixture ?? bool(env.ALLOW_GATEWAY_FIXTURE, false)
  if (nodeEnv === 'production' && gatewayMode === 'fixture') {
    throw new Error('Refusing to start: fixture gateway mode is not allowed when NODE_ENV=production')
  }
  if (gatewayMode === 'fixture' && !allowGatewayFixture) {
    throw new Error('Refusing to start: fixture gateway mode requires ALLOW_GATEWAY_FIXTURE=1')
  }
  const allowMailFixture = overrides.allowMailFixture ?? bool(env.ALLOW_MAIL_FIXTURE, false)
  const allowTestPayments = overrides.allowTestPayments ?? bool(env.ALLOW_TEST_PAYMENTS, false)
  if (nodeEnv === 'production' && (allowMailFixture || allowTestPayments || gatewayMode === 'fixture')) {
    throw new Error('Refusing to start: mail fixture, payment fixture, and gateway fixture are not allowed when NODE_ENV=production')
  }
  const mailTransport = (overrides.mailTransport ?? env.MAIL_TRANSPORT ?? 'unconfigured') as AppConfig['mailTransport']
  if (mailTransport !== 'unconfigured' && mailTransport !== 'fixture') {
    throw new Error('MAIL_TRANSPORT must be unconfigured or fixture. Real SMTP is not connected.')
  }
  if (mailTransport === 'fixture' && !allowMailFixture) {
    throw new Error('Refusing to start: MAIL_TRANSPORT=fixture requires ALLOW_MAIL_FIXTURE=1')
  }
  const priceCurrency = (overrides.priceCurrency ?? env.MODEL_PRICE_CURRENCY ?? 'unset') as AppConfig['priceCurrency']
  if (priceCurrency !== 'CNY' && priceCurrency !== 'USD' && priceCurrency !== 'unset') {
    throw new Error('MODEL_PRICE_CURRENCY must be CNY, USD, or unset')
  }
  const marginBps = overrides.marginBps ?? Number(env.MARGIN_BPS ?? 3000)
  if (!Number.isSafeInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    throw new Error('MARGIN_BPS must be an integer from 0 up to but not including 10000')
  }
  const billingReserveFen = overrides.billingReserveFen ?? Number(env.BILLING_RESERVE_FEN ?? 0)
  if (!Number.isSafeInteger(billingReserveFen) || billingReserveFen < 0) {
    throw new Error('BILLING_RESERVE_FEN must be a non-negative integer')
  }
  const betterAuthSecret = overrides.betterAuthSecret ?? env.BETTER_AUTH_SECRET ?? ''
  if (betterAuthSecret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  const fxRaw = overrides.fxCnyFenPerUsd ?? (env.FX_CNY_FEN_PER_USD ? Number(env.FX_CNY_FEN_PER_USD) : null)
  const fxSource = overrides.fxSource ?? (env.FX_SOURCE?.trim() || null)
  const fxQuotedAt = overrides.fxQuotedAt ?? (env.FX_QUOTED_AT?.trim() || null)
  const fxSet = [fxRaw !== null, Boolean(fxSource), Boolean(fxQuotedAt)].filter(Boolean).length
  if (fxSet !== 0 && fxSet !== 3) throw new Error('FX_CNY_FEN_PER_USD, FX_SOURCE, and FX_QUOTED_AT must be set together')
  if (fxRaw !== null && (!Number.isSafeInteger(fxRaw) || fxRaw < 0)) throw new Error('FX_CNY_FEN_PER_USD must be an integer')
  const fixturePromptTokens = overrides.fixturePromptTokens ?? (env.FIXTURE_PROMPT_TOKENS ? Number(env.FIXTURE_PROMPT_TOKENS) : null)
  const fixtureCompletionTokens = overrides.fixtureCompletionTokens ?? (env.FIXTURE_COMPLETION_TOKENS ? Number(env.FIXTURE_COMPLETION_TOKENS) : null)
  const databasePath = overrides.databasePath ?? env.DATABASE_PATH ?? path.resolve('data/app.sqlite')
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? path.resolve('data')
  const key = overrides.deepseekApiKey !== undefined ? overrides.deepseekApiKey : env.DEEPSEEK_API_KEY?.trim() || null
  const upstream = readUpstreamSettings(env, {
    baseUrl: overrides.deepseekBaseUrl,
    model: overrides.deepseekModel,
    reasoningEffort: overrides.reasoningEffort,
    temperature: overrides.temperature,
  })
  const config: AppConfig = {
    nodeEnv,
    host: overrides.host ?? env.HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(env.PORT ?? 8787),
    databasePath,
    dataDir,
    staticDir: overrides.staticDir ?? (env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null),
    sessionTtlHours: overrides.sessionTtlHours ?? Number(env.SESSION_TTL_HOURS ?? 336),
    cookieSecure: overrides.cookieSecure ?? bool(env.COOKIE_SECURE, false),
    gatewayMode,
    allowGatewayFixture,
    deepseekBaseUrl: upstream.baseUrl,
    deepseekApiKey: key,
    fixtureBaseUrl: overrides.fixtureBaseUrl ?? env.FIXTURE_BASE_URL ?? null,
    prices: overrides.prices ?? parsePrices(env.MODEL_PRICE_JSON),
    initiativePollMs: overrides.initiativePollMs ?? Number(env.INITIATIVE_POLL_MS ?? 0),
    allowTestClock: overrides.allowTestClock ?? (nodeEnv === 'test' && bool(env.ALLOW_TEST_CLOCK, true)),
    loginLimit: overrides.loginLimit ?? Number(env.LOGIN_LIMIT ?? 30),
    defaultDailyRequests: overrides.defaultDailyRequests ?? Number(env.DEFAULT_DAILY_REQUESTS ?? 200),
    defaultDailyTokens: overrides.defaultDailyTokens ?? Number(env.DEFAULT_DAILY_TOKENS ?? 200_000),
    betterAuthSecret,
    priceCurrency,
    marginBps,
    billingReserveFen,
    fxCnyFenPerUsd: fxRaw,
    fxSource,
    fxQuotedAt,
    mailTransport,
    allowMailFixture,
    allowTestPayments,
    fixturePromptTokens,
    fixtureCompletionTokens,
    deepseekModel: upstream.model,
    reasoningEffort: upstream.reasoningEffort,
    temperature: upstream.temperature,
  }
  if (config.priceCurrency === 'CNY') {
    for (const [model, price] of Object.entries(config.prices)) {
      if (!Number.isSafeInteger(price.input_per_million) || !Number.isSafeInteger(price.output_per_million)) {
        throw new Error(`CNY price for ${model} must be integer fen per million tokens`)
      }
    }
  }
  if (config.gatewayMode === 'fixture' && !config.fixtureBaseUrl) {
    throw new Error('Fixture gateway mode requires FIXTURE_BASE_URL')
  }
  return config
}

export function gatewayConfigured(config: AppConfig): boolean {
  if (config.gatewayMode === 'fixture') return Boolean(config.fixtureBaseUrl)
  return Boolean(config.deepseekApiKey)
}
