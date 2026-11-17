import type { AppConfig } from './config.ts'
import { gatewayConfigured } from './config.ts'
import type { PromptMessage } from './prompt.ts'
import { buildLiveChatBody } from './upstream-request.ts'

export class GatewayError extends Error {
  code: 'model_gateway_unconfigured' | 'provider_error' | 'provider_unreachable'
  constructor(message: string, code: 'model_gateway_unconfigured' | 'provider_error' | 'provider_unreachable') {
    super(message)
    this.code = code
  }
}

export type StreamDelta = { content?: string; reasoning?: string }

export type StreamResult = {
  promptTokens: number | null
  completionTokens: number | null
  source: 'live' | 'fixture'
}

const redactSecrets = (text: string, secret: string | null) => {
  let out = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
  if (secret && secret.length > 4) out = out.split(secret).join('[redacted]')
  return out.slice(0, 300)
}

export async function streamCompletion(
  config: AppConfig,
  input: {
    model: string
    messages: PromptMessage[]
    thinking: boolean
    signal?: AbortSignal
    onDelta: (delta: StreamDelta) => void
  }
): Promise<StreamResult> {
  if (!gatewayConfigured(config)) {
    throw new GatewayError(
      'Server model provider key is not configured. Chat is unavailable until an administrator sets DEEPSEEK_API_KEY. This server does not invent model replies.',
      'model_gateway_unconfigured'
    )
  }
  const source = config.gatewayMode === 'fixture' ? 'fixture' : 'live'
  const apiKey = config.deepseekApiKey ?? (source === 'fixture' ? 'fixture-local' : '')
  const live = source === 'live'
    ? buildLiveChatBody(
        {
          baseUrl: config.deepseekBaseUrl,
          model: config.deepseekModel,
          reasoningEffort: config.reasoningEffort,
          temperature: config.temperature,
        },
        { model: input.model, messages: input.messages }
      )
    : null
  const body: Record<string, unknown> = live
    ? live.body
    : {
        model: input.model,
        messages: input.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(input.thinking ? { thinking: { type: 'enabled' } } : {}),
      }
  const url = live ? live.url : `${config.fixtureBaseUrl}/chat/completions`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted) throw error
    throw new GatewayError(
      'Model provider is unreachable. No fallback reply was generated.',
      'provider_unreachable'
    )
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new GatewayError(
      `Model provider request failed (HTTP ${response.status}). No fallback reply was generated. ${redactSecrets(text, apiKey)}`.trim(),
      'provider_error'
    )
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let promptTokens: number | null = null
  let completionTokens: number | null = null
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      const row = parsed as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const delta = row.choices?.[0]?.delta
      if (delta?.content || delta?.reasoning_content) {
        input.onDelta({ content: delta.content, reasoning: delta.reasoning_content })
      }
      if (typeof row.usage?.prompt_tokens === 'number') promptTokens = row.usage.prompt_tokens
      if (typeof row.usage?.completion_tokens === 'number') completionTokens = row.usage.completion_tokens
    }
  }
  return { promptTokens, completionTokens, source }
}
