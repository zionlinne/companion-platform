import path from 'node:path'

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
  const databasePath = overrides.databasePath ?? env.DATABASE_PATH ?? path.resolve('data/app.sqlite')
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? path.resolve('data')
  const key = overrides.deepseekApiKey !== undefined ? overrides.deepseekApiKey : env.DEEPSEEK_API_KEY?.trim() || null
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
    deepseekBaseUrl: (overrides.deepseekBaseUrl ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, ''),
    deepseekApiKey: key,
    fixtureBaseUrl: overrides.fixtureBaseUrl ?? env.FIXTURE_BASE_URL ?? null,
    prices: overrides.prices ?? parsePrices(env.MODEL_PRICE_JSON),
    initiativePollMs: overrides.initiativePollMs ?? Number(env.INITIATIVE_POLL_MS ?? 0),
    allowTestClock: overrides.allowTestClock ?? (nodeEnv === 'test' && bool(env.ALLOW_TEST_CLOCK, true)),
    loginLimit: overrides.loginLimit ?? Number(env.LOGIN_LIMIT ?? 30),
    defaultDailyRequests: overrides.defaultDailyRequests ?? Number(env.DEFAULT_DAILY_REQUESTS ?? 200),
    defaultDailyTokens: overrides.defaultDailyTokens ?? Number(env.DEFAULT_DAILY_TOKENS ?? 200_000),
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
