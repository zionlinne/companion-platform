export const REASONING_EFFORTS = ['low', 'high', 'max', 'none'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export type UpstreamSettings = {
  baseUrl: string
  model: string | null
  reasoningEffort: ReasoningEffort
  temperature: number
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function readUpstreamSettings(
  env: NodeJS.ProcessEnv,
  overrides: {
    baseUrl?: string
    model?: string | null
    reasoningEffort?: ReasoningEffort
    temperature?: number
  } = {}
): UpstreamSettings {
  const baseUrl = normalizeBaseUrl(overrides.baseUrl ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
  const model = normalizeModel(overrides.model === undefined ? env.DEEPSEEK_MODEL : overrides.model ?? undefined)
  const reasoningEffort = normalizeReasoning(overrides.reasoningEffort ?? env.REASONING_EFFORT)
  const temperature = normalizeTemperature(overrides.temperature ?? env.TEMPERATURE)
  return { baseUrl, model, reasoningEffort, temperature }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('DEEPSEEK_BASE_URL is empty')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('DEEPSEEK_BASE_URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DEEPSEEK_BASE_URL must use http or https')
  }
  if (url.username || url.password) throw new Error('DEEPSEEK_BASE_URL must not contain credentials')
  if (url.search || url.hash) throw new Error('DEEPSEEK_BASE_URL must not contain a query or hash')
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/v1\/v1(\/|$)/i.test(path)) {
    throw new Error('DEEPSEEK_BASE_URL contains /v1/v1. For 88API use https://api.88api.ai/v1 and do not append /chat/completions yourself.')
  }
  if (url.hostname === 'api.88api.ai' && path !== '/v1' && path !== '/v1/chat/completions') {
    throw new Error('88API DEEPSEEK_BASE_URL must be https://api.88api.ai/v1. Omitting /v1 or adding another /v1 is rejected.')
  }
  return `${url.origin}${path}`
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/chat/completions')) return normalized
  return `${normalized}/chat/completions`
}

export function buildLiveChatBody(
  settings: UpstreamSettings,
  input: { model: string; messages: unknown[] }
): { url: string; body: Record<string, unknown>; temperatureSent: boolean; sampling: 'thinking-temperature-omitted' | 'non-thinking-temperature-sent' } {
  const model = settings.model ?? input.model
  if (!MODEL_ID.test(model)) throw new Error('Upstream model id is not a single token of letters, numbers, dots, or hyphens')
  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: settings.reasoningEffort,
  }
  const thinking = settings.reasoningEffort !== 'none'
  if (!thinking) body.temperature = settings.temperature
  return {
    url: chatCompletionsUrl(settings.baseUrl),
    body,
    temperatureSent: !thinking,
    sampling: thinking ? 'thinking-temperature-omitted' : 'non-thinking-temperature-sent',
  }
}

export function describeUpstream(settings: UpstreamSettings) {
  const built = buildLiveChatBody(settings, { model: settings.model ?? 'deepseek-flash', messages: [] })
  return {
    chatCompletionsUrl: built.url,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    temperatureConfigured: settings.temperature,
    temperatureSent: built.temperatureSent,
    sampling: built.sampling,
    note:
      built.sampling === 'thinking-temperature-omitted'
        ? 'reasoning_effort low、high、max 按 DeepSeek 官方说明属于思考模式。这次 live 请求不发送 temperature，不能把温度和思考档说成同时生效。88API 令牌是否允许 deepseek-v4.1-flash 尚未验证。'
        : 'reasoning_effort=none 才发送 temperature。这是非思考请求的采样参数，不是和思考档一起生效。',
  }
}

function normalizeModel(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const model = raw.trim()
  if (!model) return null
  if (!MODEL_ID.test(model)) throw new Error('DEEPSEEK_MODEL must be one token of letters, numbers, dots, or hyphens')
  return model
}

function normalizeReasoning(raw: string | ReasoningEffort | undefined): ReasoningEffort {
  const value = (raw ?? 'low').trim()
  if (value === 'medium') {
    throw new Error('REASONING_EFFORT=medium is only the generic 88API o-series example. DeepSeek uses none, low, high, or max. medium is rejected so it is not silently mapped.')
  }
  if (!REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    throw new Error('REASONING_EFFORT must be low, high, max, or none')
  }
  return value as ReasoningEffort
}

function normalizeTemperature(raw: number | string | undefined): number {
  if (raw === undefined || raw === '') return 2
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error('TEMPERATURE must be a number from 0 to 2')
  }
  return value
}
