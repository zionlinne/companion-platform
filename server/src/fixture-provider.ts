import { createServer, type Server } from 'node:http'

export type FixtureState = {
  requests: Array<{ authorization: string | null; body: unknown }>
}

const readJson = async (req: import('node:http').IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    messages?: Array<{ role?: string; content?: string }>
    thinking?: { type?: string }
  }
}

function replyFor(body: { messages?: Array<{ role?: string; content?: string }>; thinking?: { type?: string } }): {
  content: string
  reasoning: string
} {
  const messages = body.messages ?? []
  const system = messages.find((message) => message.role === 'system')?.content ?? ''
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  if (system.includes('MEMORY_SUGGESTION_REQUEST')) {
    return {
      reasoning: '',
      content: JSON.stringify({
        memories: [{ category: 'fact', content: '用户说过喜欢喝茶', explicit: false, source: 'model-suggestion' }],
      }),
    }
  }
  if (system.includes('[Authorized timeline fields]')) {
    const title = /title:\s*(.+)/.exec(system)?.[1]?.trim() ?? '已授权事件'
    return { reasoning: body.thinking ? 'fixture-reasoning' : '', content: `主动提醒：${title}` }
  }
  return {
    reasoning: body.thinking ? 'fixture-reasoning' : '',
    content: `fixture-reply:${lastUser.slice(0, 120)}`,
  }
}

export function startFixture(): Promise<{ url: string; state: FixtureState; close: () => Promise<void> }> {
  const state: FixtureState = { requests: [] }
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/__last') {
        const last = state.requests[state.requests.length - 1] ?? null
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(last))
        return
      }
      if (req.method === 'GET' && url.pathname === '/__count') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ count: state.requests.length }))
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/chat/completions') {
        res.writeHead(404)
        res.end()
        return
      }
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
      const promptHeader = Number(req.headers['x-fixture-prompt-tokens'])
      const completionHeader = Number(req.headers['x-fixture-completion-tokens'])
      const body = await readJson(req)
      state.requests.push({ authorization, body })
      if (!authorization?.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'missing authorization' } }))
        return
      }
      const reply = replyFor(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      if (reply.reasoning) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reply.reasoning } }] })}\n\n`)
      }
      const pieces = reply.content.match(/.{1,8}/g) ?? ['']
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: Number.isSafeInteger(promptHeader) && promptHeader >= 0 ? promptHeader : 11,
            completion_tokens: Number.isSafeInteger(completionHeader) && completionHeader >= 0 ? completionHeader : reply.content.length,
          },
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture listen failed')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
