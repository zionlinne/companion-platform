import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { AppConfig } from './config.ts'
import type { Logger } from './log.ts'
import type { UserRow } from './types.ts'

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type Ctx = {
  db: DatabaseSync
  config: AppConfig
  log: Logger
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  user: UserRow | null
  body?: unknown
}

export const nowIso = () => new Date().toISOString()

export const newId = () => randomBytes(16).toString('hex')

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  })
  res.end(payload)
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Payload too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit)
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid_json', 'JSON object required')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'invalid_json', 'Invalid JSON')
  }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export function setSessionCookie(res: ServerResponse, token: string, config: AppConfig): void {
  const maxAge = Math.floor(config.sessionTtlHours * 3600)
  const parts = [`cp_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (config.cookieSecure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function clearSessionCookie(res: ServerResponse, config: AppConfig): void {
  const parts = ['cp_session=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (config.cookieSecure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function requireUser(ctx: Ctx): UserRow {
  if (!ctx.user) throw new HttpError(401, 'unauthenticated', 'Login required')
  return ctx.user
}

export function requireAdmin(ctx: Ctx): UserRow {
  const user = requireUser(ctx)
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Admin only')
  return user
}

export function asString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_field', `${field} must be a string`)
  const text = value.trim()
  if (text.length < min || text.length > max) {
    throw new HttpError(400, 'invalid_field', `${field} length must be ${min}-${max}`)
  }
  return text
}

export function asOptionalString(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_field', `${field} must be a string`)
  if (value.length > max) throw new HttpError(400, 'invalid_field', `${field} is too long`)
  return value
}

export function asBool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_field', 'Boolean required')
  return value
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.socket.remoteAddress ?? 'unknown'
  return forwarded
}

export function assertCsrf(req: IncomingMessage): void {
  if (req.method === 'GET' || req.method === 'HEAD') return
  if (req.headers['x-companion-request'] !== '1') {
    throw new HttpError(403, 'csrf', 'Missing X-Companion-Request header')
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      throw new HttpError(403, 'origin', 'Bad Origin header')
    }
    const host = req.headers.host
    const local = (value: string) => value.startsWith('localhost:') || value.startsWith('127.0.0.1:') || value === 'localhost' || value === '127.0.0.1'
    if (host && originHost !== host && !(local(originHost) && local(host))) {
      throw new HttpError(403, 'origin', 'Cross-origin request rejected')
    }
  }
}

export type Route = {
  method: string
  regex: RegExp
  keys: string[]
  handler: (ctx: Ctx) => Promise<void> | void
}

export function route(method: string, pathname: string, handler: Route['handler']): Route {
  const keys: string[] = []
  const pattern = pathname.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    keys.push(key)
    return '([^/]+)'
  })
  return { method, regex: new RegExp(`^${pattern}$`), keys, handler }
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastSeenAt: user.last_seen_at,
  }
}
