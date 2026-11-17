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
  databaseUrl: string | null
  uploads: 'local' | 'disabled'
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
  deepseekModel: string | null
  reasoningEffort: 'low' | 'high' | 'max' | 'none'
  temperature: number
  billingEnabled: boolean
  priceCurrency: 'unset' | 'CNY' | 'USD'
  marginBps: number
  billingReserveFen: number
  fxCnyFenPerUsd: number | null
  fxSource: string | null
  fxQuotedAt: string | null
  embeddingMode: 'off' | 'local' | 'http'
  embeddingBaseUrl: string | null
  embeddingApiKey: string | null
  embeddingModel: string | null
  embeddingTimeoutMs: number
  embeddingMinCosine: number
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

function priceCurrencyOf(value: string | undefined): 'unset' | 'CNY' | 'USD' {
  if (!value || value === 'unset') return 'unset'
  if (value === 'CNY' || value === 'USD') return value
  throw new Error('MODEL_PRICE_CURRENCY must be CNY, USD, or unset')
}

function embeddingModeOf(value: string | undefined): 'off' | 'local' | 'http' {
  if (value === 'off') return 'off'
  if (!value || value === 'local') return 'local'
  if (value === 'http') return 'http'
  throw new Error('EMBEDDING_MODE must be off, local, or http')
}

function unitInterval(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`)
  return parsed
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
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
  const databaseUrl = overrides.databaseUrl !== undefined ? overrides.databaseUrl : env.DATABASE_URL?.trim() || null
  if (databaseUrl && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a postgres connection string')
  }
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
    host: overrides.host ?? env.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: overrides.port ?? Number(env.PORT ?? 8787),
    databasePath,
    databaseUrl,
    uploads: databaseUrl ? 'disabled' : 'local',
    dataDir,
    staticDir: overrides.staticDir ?? (env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null),
    sessionTtlHours: overrides.sessionTtlHours ?? Number(env.SESSION_TTL_HOURS ?? 336),
    cookieSecure: overrides.cookieSecure ?? bool(env.COOKIE_SECURE, nodeEnv === 'production'),
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
    deepseekModel: upstream.model,
    reasoningEffort: upstream.reasoningEffort,
    temperature: upstream.temperature,
    billingEnabled: overrides.billingEnabled ?? bool(env.BILLING_ENABLED, false),
    priceCurrency: overrides.priceCurrency ?? priceCurrencyOf(env.MODEL_PRICE_CURRENCY),
    marginBps: overrides.marginBps ?? nonNegativeInt(env.MARGIN_BPS, 3000, 'MARGIN_BPS'),
    billingReserveFen: overrides.billingReserveFen ?? nonNegativeInt(env.BILLING_RESERVE_FEN, 0, 'BILLING_RESERVE_FEN'),
    fxCnyFenPerUsd:
      overrides.fxCnyFenPerUsd !== undefined
        ? overrides.fxCnyFenPerUsd
        : env.FX_CNY_FEN_PER_USD
          ? nonNegativeInt(env.FX_CNY_FEN_PER_USD, 0, 'FX_CNY_FEN_PER_USD')
          : null,
    fxSource: overrides.fxSource !== undefined ? overrides.fxSource : env.FX_SOURCE?.trim() || null,
    fxQuotedAt: overrides.fxQuotedAt !== undefined ? overrides.fxQuotedAt : env.FX_QUOTED_AT?.trim() || null,
    embeddingMode: overrides.embeddingMode ?? embeddingModeOf(env.EMBEDDING_MODE),
    embeddingBaseUrl: overrides.embeddingBaseUrl !== undefined ? overrides.embeddingBaseUrl : env.EMBEDDING_BASE_URL?.trim() || null,
    embeddingApiKey: overrides.embeddingApiKey !== undefined ? overrides.embeddingApiKey : env.EMBEDDING_API_KEY?.trim() || null,
    embeddingModel: overrides.embeddingModel !== undefined ? overrides.embeddingModel : env.EMBEDDING_MODEL?.trim() || null,
    embeddingTimeoutMs: overrides.embeddingTimeoutMs ?? nonNegativeInt(env.EMBEDDING_TIMEOUT_MS, 2500, 'EMBEDDING_TIMEOUT_MS'),
    embeddingMinCosine: overrides.embeddingMinCosine ?? unitInterval(env.EMBEDDING_MIN_COSINE, 0.44, 'EMBEDDING_MIN_COSINE'),
  }
  if (config.marginBps >= 10_000) throw new Error('MARGIN_BPS must be below 10000')
  if (config.gatewayMode === 'fixture' && !config.fixtureBaseUrl) {
    throw new Error('Fixture gateway mode requires FIXTURE_BASE_URL')
  }
  if (nodeEnv === 'production' && !config.databaseUrl) {
    throw new Error('Refusing to start: production requires DATABASE_URL so user data is not stored on ephemeral disk')
  }
  if (nodeEnv === 'production' && config.initiativePollMs > 0) {
    throw new Error('Refusing to start: INITIATIVE_POLL_MS must stay 0 in production because a free host sleeps and cannot promise scheduled messages')
  }
  return config
}

export function gatewayConfigured(config: AppConfig): boolean {
  if (config.gatewayMode === 'fixture') return Boolean(config.fixtureBaseUrl)
  return Boolean(config.deepseekApiKey)
}
