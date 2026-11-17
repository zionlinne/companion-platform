import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { loadConfig } from '../src/config.ts'
import { GatewayError, streamCompletion } from '../src/gateway.ts'
import { buildLiveChatBody, chatCompletionsUrl, readUpstreamSettings } from '../src/upstream-request.ts'

const secret = '0123456789abcdef0123456789abcdef'

test('88API live body uses reasoning_effort low and omits temperature', () => {
  const settings = readUpstreamSettings({
    DEEPSEEK_BASE_URL: 'https://api.88api.ai/v1/',
    DEEPSEEK_MODEL: 'deepseek-v4.1-flash',
    REASONING_EFFORT: 'low',
    TEMPERATURE: '2',
  })
  const built = buildLiveChatBody(settings, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.equal(built.url, 'https://api.88api.ai/v1/chat/completions')
  assert.equal(built.url.includes('/v1/v1'), false)
  assert.equal(built.body.model, 'deepseek-v4.1-flash')
  assert.equal(built.body.reasoning_effort, 'low')
  assert.equal(built.body.stream, true)
  assert.equal(Object.hasOwn(built.body, 'temperature'), false)
  assert.equal(Object.hasOwn(built.body, 'thinking'), false)
  assert.equal(built.temperatureSent, false)
  assert.equal(built.sampling, 'thinking-temperature-omitted')
})

test('temperature is sent only when reasoning_effort is none', () => {
  const settings = readUpstreamSettings({
    DEEPSEEK_BASE_URL: 'https://api.88api.ai/v1',
    REASONING_EFFORT: 'none',
    TEMPERATURE: '2',
  })
  const built = buildLiveChatBody(settings, { model: 'deepseek-v4.1-flash', messages: [] })
  assert.equal(built.body.reasoning_effort, 'none')
  assert.equal(built.body.temperature, 2)
  assert.equal(built.temperatureSent, true)
  assert.equal(built.sampling, 'non-thinking-temperature-sent')
})

test('base URL rejects a second /v1 and a bare 88API host', () => {
  assert.throws(() => chatCompletionsUrl('https://api.88api.ai/v1/v1'), /v1\/v1/)
  assert.throws(() => chatCompletionsUrl('https://api.88api.ai'), /must be https:\/\/api\.88api\.ai\/v1/)
  assert.equal(chatCompletionsUrl('https://api.88api.ai/v1/chat/completions'), 'https://api.88api.ai/v1/chat/completions')
  assert.throws(() => readUpstreamSettings({ REASONING_EFFORT: 'medium' }), /medium/)
  assert.throws(() => readUpstreamSettings({ TEMPERATURE: '3' }), /TEMPERATURE/)
  assert.throws(() => readUpstreamSettings({ DEEPSEEK_MODEL: 'bad model' }), /DEEPSEEK_MODEL/)
})

test('live stream posts the 88API body and does not label the recorder as a fixture', async () => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined; body: unknown }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    seen.push({
      url: req.url,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"local"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('recorder failed')
  const key = 'sk-local-recorder-not-a-provider'
  try {
    const config = loadConfig(
      { NODE_ENV: 'test' },
      {
        nodeEnv: 'test',
        betterAuthSecret: secret,
        gatewayMode: 'live',
        deepseekApiKey: key,
        deepseekBaseUrl: `http://127.0.0.1:${address.port}`,
        deepseekModel: 'deepseek-v4.1-flash',
        reasoningEffort: 'low',
        temperature: 2,
      }
    )
    let text = ''
    const result = await streamCompletion(config, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好' }],
      thinking: true,
      onDelta: (delta) => {
        text += delta.content ?? ''
      },
    })
    assert.equal(result.source, 'live')
    assert.equal(text, 'local')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.url, '/chat/completions')
    assert.equal(seen[0]?.authorization, `Bearer ${key}`)
    const body = seen[0]?.body as Record<string, unknown>
    assert.equal(body.model, 'deepseek-v4.1-flash')
    assert.equal(body.reasoning_effort, 'low')
    assert.equal(Object.hasOwn(body, 'temperature'), false)
    assert.equal(JSON.stringify(seen).includes('fixture-reply'), false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('live mode without a key fails before any provider request', async () => {
  let calls = 0
  const server = createServer((_req, res) => {
    calls += 1
    res.writeHead(200)
    res.end('fixture-reply:should-not-be-read')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('recorder failed')
  try {
    const config = loadConfig(
      { NODE_ENV: 'test', DEEPSEEK_API_KEY: '' },
      {
        nodeEnv: 'test',
        betterAuthSecret: secret,
        gatewayMode: 'live',
        deepseekApiKey: null,
        deepseekBaseUrl: `http://127.0.0.1:${address.port}`,
      }
    )
    await assert.rejects(
      () =>
        streamCompletion(config, {
          model: 'deepseek-flash',
          messages: [{ role: 'user', content: '你好' }],
          thinking: false,
          onDelta: () => undefined,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError)
        assert.equal(error.code, 'model_gateway_unconfigured')
        assert.equal(error.message.includes('fixture-reply'), false)
        assert.equal(error.message.includes('sk-'), false)
        return true
      }
    )
    assert.equal(calls, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
