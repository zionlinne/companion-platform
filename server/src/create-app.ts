import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { authenticate, createInvitations, createSession, listInvitations, registerUser, revokeToken, userFromToken } from './auth.ts'
import {
  assertQuota,
  attachmentExcerpt,
  blobPath,
  decorateMessages,
  messagePath,
  ownConversation,
  streamAssistant,
} from './chat-service.ts'
import { gatewayConfigured, isKnownModel, MODELS, type AppConfig, DEFAULT_MODEL } from './config.ts'
import { many, one, run, withTx } from './db.ts'
import { streamCompletion } from './gateway.ts'
import {
  asBool,
  asOptionalString,
  asString,
  assertCsrf,
  clearSessionCookie,
  clientIp,
  cookies,
  HttpError,
  json,
  newId,
  nowIso,
  publicUser,
  readBody,
  readJson,
  requireAdmin,
  requireUser,
  route,
  setSessionCookie,
  type Route,
} from './http.ts'
import type { Ctx } from './http.ts'
import { defaultInitiative, publicSettings, tickInitiative } from './initiative.ts'
import type { Logger } from './log.ts'
import { dedupeImports, memoryPackage, parseMemoryImport, type ImportItem } from './memory-import.ts'
import { PERSONA_TEMPLATES } from './persona-templates.ts'
import { verifyPassword } from './password.ts'
import { costMicroUsd } from './prompt.ts'
import type {
  AttachmentRow,
  CharacterRow,
  ConversationRow,
  MemoryCategory,
  MemoryRow,
  MessageRow,
} from './types.ts'

const CATEGORIES = new Set<MemoryCategory>(['persona', 'fact', 'event', 'relationship'])
const COMPANION_LIMIT = 5

function companionCount(db: Ctx['db'], userId: string): number {
  const row = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM characters WHERE user_id = ?`, userId)
  return Number(row?.n ?? 0)
}

function reserveCompanionSlot(db: Ctx['db'], userId: string): void {
  if (companionCount(db, userId) >= COMPANION_LIMIT) {
    throw new HttpError(409, 'companion_limit', '每个账号最多 5 个 Companion。删除一个后才能再创建、复制或导入。')
  }
}

const loginFailures = new Map<string, number[]>()

function tooManyLogins(ip: string, limit: number): boolean {
  const now = Date.now()
  const recent = (loginFailures.get(ip) ?? []).filter((stamp) => now - stamp < 10 * 60 * 1000)
  loginFailures.set(ip, recent)
  return recent.length >= limit
}

function markLoginFailure(ip: string) {
  const recent = loginFailures.get(ip) ?? []
  recent.push(Date.now())
  loginFailures.set(ip, recent)
}

function ownCharacter(ctx: Ctx, id: string): CharacterRow {
  const row = one<CharacterRow>(ctx.db, `SELECT * FROM characters WHERE id = ? AND user_id = ?`, id, ctx.user!.id)
  if (!row) throw new HttpError(404, 'not_found', 'Not found')
  return row
}

function characterJson(row: CharacterRow) {
  return {
    id: row.id,
    name: row.name,
    avatarText: row.avatar_text,
    identity: row.identity,
    background: row.background,
    traits: row.traits,
    style: row.style,
    habits: row.habits,
    relationship: row.relationship,
    rules: row.rules,
    defaultModel: row.default_model,
    initiativeEnabled: row.initiative_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function memoryJson(row: MemoryRow) {
  return {
    id: row.id,
    characterId: row.character_id,
    category: row.category,
    content: row.content,
    source: row.source,
    explicit: row.explicit === 1,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assertModel(model: string) {
  if (!isKnownModel(model)) throw new HttpError(400, 'unknown_model', 'Unknown model')
}

function categoryOf(value: unknown): MemoryCategory {
  if (typeof value !== 'string' || !CATEGORIES.has(value as MemoryCategory)) {
    throw new HttpError(400, 'invalid_field', 'Invalid memory category')
  }
  return value as MemoryCategory
}

function deleteConversation(ctx: Ctx, conversation: ConversationRow) {
  const attachments = many<AttachmentRow>(
    ctx.db,
    `SELECT * FROM attachments WHERE conversation_id = ? AND user_id = ?`,
    conversation.id,
    ctx.user!.id
  )
  for (const attachment of attachments) {
    fs.rmSync(blobPath(ctx, attachment.storage_name), { force: true })
  }
  run(ctx.db, `DELETE FROM attachments WHERE conversation_id = ? AND user_id = ?`, conversation.id, ctx.user!.id)
  run(ctx.db, `DELETE FROM messages WHERE conversation_id = ? AND user_id = ?`, conversation.id, ctx.user!.id)
  run(ctx.db, `DELETE FROM conversations WHERE id = ? AND user_id = ?`, conversation.id, ctx.user!.id)
}

function assertParent(ctx: Ctx, conversationId: string, parentId: string | null) {
  if (!parentId) return
  const parent = one<MessageRow>(
    ctx.db,
    `SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?`,
    parentId,
    conversationId,
    ctx.user!.id
  )
  if (!parent) throw new HttpError(400, 'invalid_parent', 'Parent message was not found')
}

function historyFrom(pathMessages: MessageRow[]) {
  return pathMessages
    .filter((message) => message.role === 'user' || message.status === 'complete')
    .map((message) => ({ role: message.role, content: message.content }))
}

async function beginReply(
  ctx: Ctx,
  conversation: ConversationRow,
  input: { content: string; parentId: string | null; model?: string; thinking: boolean; attachmentIds: string[] }
) {
  if (!gatewayConfigured(ctx.config)) {
    throw new HttpError(
      503,
      'model_gateway_unconfigured',
      'Server model provider key is not configured. Chat is unavailable until an administrator sets DEEPSEEK_API_KEY. This server does not invent model replies.'
    )
  }
  assertQuota(ctx)
  const model = input.model || conversation.model
  assertModel(model)
  assertParent(ctx, conversation.id, input.parentId)
  const attachments: AttachmentRow[] = []
  for (const attachmentId of input.attachmentIds) {
    const row = one<AttachmentRow>(ctx.db, `SELECT * FROM attachments WHERE id = ? AND user_id = ?`, attachmentId, ctx.user!.id)
    if (!row) throw new HttpError(404, 'not_found', 'Not found')
    if (row.space !== conversation.space) {
      throw new HttpError(403, 'attachment_space_mismatch', 'Attachment belongs to a different space')
    }
    if (row.message_id) throw new HttpError(409, 'attachment_used', 'Attachment is already linked')
    attachments.push(row)
  }
  const at = nowIso()
  const messageId = newId()
  run(
    ctx.db,
    `INSERT INTO messages (id, user_id, conversation_id, parent_id, role, content, reasoning, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, NULL, 'complete', ?, ?)`,
    messageId,
    ctx.user!.id,
    conversation.id,
    input.parentId,
    input.content,
    at,
    at
  )
  for (const attachment of attachments) {
    run(
      ctx.db,
      `UPDATE attachments SET message_id = ?, conversation_id = ? WHERE id = ? AND user_id = ?`,
      messageId,
      conversation.id,
      attachment.id,
      ctx.user!.id
    )
  }
  if (conversation.title === '新对话' || conversation.title === '新的工作记录') {
    run(
      ctx.db,
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
      input.content.slice(0, 40) || conversation.title,
      at,
      conversation.id
    )
  }
  const history = historyFrom(messagePath(ctx, conversation.id, messageId))
  await streamAssistant(ctx, conversation, {
    parentId: messageId,
    history,
    model,
    thinking: input.thinking,
    attachmentExcerpt: attachmentExcerpt(ctx, attachments),
  })
}

function parseSingleFile(body: Buffer, contentType: string) {
  const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!matched) throw new HttpError(400, 'invalid_multipart', 'Missing multipart boundary')
  const boundary = Buffer.from(`--${(matched[1] || matched[2]).trim()}`)
  let start = body.indexOf(boundary)
  if (start < 0) throw new HttpError(400, 'invalid_multipart', 'Malformed multipart body')
  start += boundary.length
  while (start < body.length) {
    if (body.subarray(start, start + 2).toString() === '--') break
    if (body.subarray(start, start + 2).toString() === '\r\n') start += 2
    const next = body.indexOf(boundary, start)
    if (next < 0) break
    let chunk = body.subarray(start, next)
    if (chunk.subarray(-2).toString() === '\r\n') chunk = chunk.subarray(0, -2)
    const sep = chunk.indexOf('\r\n\r\n')
    if (sep >= 0) {
      const header = chunk.subarray(0, sep).toString('utf8')
      if (/name="file"/i.test(header)) {
        const filename = path.basename(/filename="([^"]*)"/i.exec(header)?.[1] ?? 'upload').slice(0, 180) || 'upload'
        const mime = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || 'application/octet-stream'
        return { filename, mime: mime.slice(0, 200), data: chunk.subarray(sep + 4) }
      }
    }
    start = next + boundary.length
  }
  throw new HttpError(400, 'invalid_multipart', 'File field is required')
}

function deleteUserData(ctx: Ctx, userId: string) {
  const attachments = many<AttachmentRow>(ctx.db, `SELECT * FROM attachments WHERE user_id = ?`, userId)
  for (const attachment of attachments) fs.rmSync(blobPath(ctx, attachment.storage_name), { force: true })
  run(ctx.db, `DELETE FROM access_audits WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM timeline_grants WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM notifications WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM initiative_runs WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM initiative_settings WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM usage_ledger WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM feedback WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM memory_previews WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM attachments WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM messages WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM conversations WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM memories WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM tasks WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM projects WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM timeline_events WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM characters WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM invitation_redemptions WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM sessions WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM quotas WHERE user_id = ?`, userId)
  run(ctx.db, `DELETE FROM users WHERE id = ?`, userId)
}

function serveStatic(config: AppConfig, res: ServerResponse, pathname: string): boolean {
  if (!config.staticDir || !fs.existsSync(config.staticDir)) return false
  const root = path.resolve(config.staticDir)
  const requested = pathname === '/' ? '/index.html' : pathname
  const full = path.resolve(root, `.${requested}`)
  const allowed = full === root || full.startsWith(root + path.sep)
  let file = allowed && fs.existsSync(full) && fs.statSync(full).isFile() ? full : path.join(root, 'index.html')
  if (!file.startsWith(root)) return false
  if (!fs.existsSync(file)) return false
  const ext = path.extname(file)
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
  }
  res.writeHead(200, {
    'Content-Type': types[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  })
  fs.createReadStream(file).pipe(res)
  return true
}

export function createApp(deps: { db: DatabaseSync; config: AppConfig; log: Logger }) {
  const routes: Route[] = []
  const add = (method: string, pathname: string, handler: Route['handler']) => routes.push(route(method, pathname, handler))

  add('GET', '/api/health', async (ctx) => {
    json(ctx.res, 200, { ok: true })
  })

  add('GET', '/api/gateway', async (ctx) => {
    requireUser(ctx)
    json(ctx.res, 200, {
      mode: ctx.config.gatewayMode,
      configured: gatewayConfigured(ctx.config),
      provider: 'deepseek-compatible',
      realProvider: ctx.config.gatewayMode === 'live' && gatewayConfigured(ctx.config),
      note:
        ctx.config.gatewayMode === 'fixture'
          ? 'Local protocol fixture. Responses are not DeepSeek output.'
          : gatewayConfigured(ctx.config)
            ? 'Server gateway is configured. The browser does not receive the provider key.'
            : 'Server provider key is not configured. Chat will fail closed.',
    })
  })

  add('GET', '/api/models', async (ctx) => {
    requireUser(ctx)
    json(ctx.res, 200, { models: MODELS, defaultModel: DEFAULT_MODEL })
  })

  add('POST', '/api/admin/init', async () => {
    throw new HttpError(404, 'not_found', 'Create the first administrator with the local CLI, not over HTTP')
  })

  add('POST', '/api/register', async (ctx) => {
    const body = await readJson(ctx.req)
    const user = await registerUser(ctx.db, ctx.config, {
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      invitationCode: String(body.invitationCode ?? ''),
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    })
    const token = createSession(ctx.db, ctx.config, user.id)
    setSessionCookie(ctx.res, token, ctx.config)
    ctx.log.info('registered', { userId: user.id })
    json(ctx.res, 201, { user: publicUser(user) })
  })

  add('POST', '/api/login', async (ctx) => {
    const ip = clientIp(ctx.req)
    if (tooManyLogins(ip, ctx.config.loginLimit)) throw new HttpError(429, 'rate_limited', 'Too many login attempts')
    const body = await readJson(ctx.req)
    const email = String(body.email ?? '')
    const password = String(body.password ?? '')
    const user = await authenticate(ctx.db, email, password)
    if (!user) {
      markLoginFailure(ip)
      ctx.log.info('login_failed', { email })
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect')
    }
    const token = createSession(ctx.db, ctx.config, user.id)
    setSessionCookie(ctx.res, token, ctx.config)
    ctx.log.info('login', { userId: user.id })
    json(ctx.res, 200, { user: publicUser(user) })
  })

  add('POST', '/api/logout', async (ctx) => {
    revokeToken(ctx.db, cookies(ctx.req).cp_session)
    clearSessionCookie(ctx.res, ctx.config)
    json(ctx.res, 200, { ok: true })
  })

  add('GET', '/api/me', async (ctx) => {
    json(ctx.res, 200, { user: publicUser(requireUser(ctx)) })
  })

  add('PATCH', '/api/me', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const displayName = asString(body.displayName, 'displayName', 1, 80)
    const at = nowIso()
    run(ctx.db, `UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`, displayName, at, user.id)
    const next = one<typeof user>(ctx.db, `SELECT * FROM users WHERE id = ?`, user.id)!
    json(ctx.res, 200, { user: publicUser(next) })
  })

  add('POST', '/api/admin/invitations', async (ctx) => {
    const admin = requireAdmin(ctx)
    const body = await readJson(ctx.req)
    const count = Number(body.count ?? 1)
    const maxUses = Number(body.maxUses ?? 1)
    const created = createInvitations(ctx.db, admin.id, count, maxUses, typeof body.note === 'string' ? body.note.slice(0, 200) : null)
    ctx.log.info('invitations_created', { adminId: admin.id, count: created.length })
    json(ctx.res, 201, {
      invitations: created,
      guidance: 'The first batch is intended to be 10-20 invitations. Codes are shown once.',
    })
  })

  add('GET', '/api/admin/invitations', async (ctx) => {
    const admin = requireAdmin(ctx)
    json(ctx.res, 200, { invitations: listInvitations(ctx.db, admin.id) })
  })

  add('POST', '/api/admin/invitations/:id/revoke', async (ctx) => {
    const admin = requireAdmin(ctx)
    const changed = run(
      ctx.db,
      `UPDATE invitations SET revoked_at = ? WHERE id = ? AND created_by = ? AND revoked_at IS NULL`,
      nowIso(),
      ctx.params.id,
      admin.id
    )
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('GET', '/api/admin/stats', async (ctx) => {
    requireAdmin(ctx)
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const users = one<{ count: number }>(ctx.db, `SELECT count(*) AS count FROM users WHERE deleted_at IS NULL`)
    const active = one<{ count: number }>(ctx.db, `SELECT count(*) AS count FROM users WHERE last_seen_at >= ?`, week)
    const usage = one<{
      prompt: number | null
      completion: number | null
      calculated: number | null
      unknown_rows: number
      fixture_rows: number
      calculated_rows: number
    }>(
      ctx.db,
      `SELECT coalesce(sum(prompt_tokens), 0) AS prompt,
              coalesce(sum(completion_tokens), 0) AS completion,
              coalesce(sum(CASE WHEN cost_status = 'calculated' THEN cost_micro_usd ELSE 0 END), 0) AS calculated,
              coalesce(sum(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_rows,
              coalesce(sum(CASE WHEN cost_status = 'fixture' THEN 1 ELSE 0 END), 0) AS fixture_rows,
              coalesce(sum(CASE WHEN cost_status = 'calculated' THEN 1 ELSE 0 END), 0) AS calculated_rows
       FROM usage_ledger`
    )
    const byUser = many<{ user_id: string; email: string; prompt: number; completion: number }>(
      ctx.db,
      `SELECT u.id AS user_id, u.email AS email,
              coalesce(sum(l.prompt_tokens), 0) AS prompt,
              coalesce(sum(l.completion_tokens), 0) AS completion
       FROM users u LEFT JOIN usage_ledger l ON l.user_id = u.id
       WHERE u.deleted_at IS NULL
       GROUP BY u.id ORDER BY u.created_at`
    )
    json(ctx.res, 200, {
      users: users?.count ?? 0,
      active7d: active?.count ?? 0,
      promptTokens: usage?.prompt ?? 0,
      completionTokens: usage?.completion ?? 0,
      calculatedCostMicroUsd: usage?.calculated ?? 0,
      unknownCostRows: usage?.unknown_rows ?? 0,
      fixtureRows: usage?.fixture_rows ?? 0,
      calculatedRows: usage?.calculated_rows ?? 0,
      costNote: 'Calculated rows use configured unit prices and reported usage. They are not a provider invoice. Unknown means no configured price. Fixture rows are not DeepSeek bills.',
      byUser,
    })
  })

  add('GET', '/api/admin/users', async (ctx) => {
    requireAdmin(ctx)
    const rows = many<{ id: string; email: string; display_name: string; role: string; created_at: string; last_seen_at: string | null }>(
      ctx.db,
      `SELECT id, email, display_name, role, created_at, last_seen_at FROM users WHERE deleted_at IS NULL ORDER BY created_at`
    )
    json(ctx.res, 200, {
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
      })),
    })
  })

  add('PATCH', '/api/admin/users/:id/quota', async (ctx) => {
    requireAdmin(ctx)
    const body = await readJson(ctx.req)
    const requests = Number(body.dailyRequestLimit)
    const tokens = Number(body.dailyTokenLimit)
    if (!Number.isInteger(requests) || requests < 1 || requests > 100_000) {
      throw new HttpError(400, 'invalid_field', 'dailyRequestLimit is invalid')
    }
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 100_000_000) {
      throw new HttpError(400, 'invalid_field', 'dailyTokenLimit is invalid')
    }
    const changed = run(
      ctx.db,
      `UPDATE quotas SET daily_request_limit = ?, daily_token_limit = ?, updated_at = ? WHERE user_id = ?`,
      requests,
      tokens,
      nowIso(),
      ctx.params.id
    )
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('GET', '/api/characters', async (ctx) => {
    const user = requireUser(ctx)
    const rows = many<CharacterRow>(ctx.db, `SELECT * FROM characters WHERE user_id = ? ORDER BY updated_at DESC`, user.id)
    json(ctx.res, 200, { characters: rows.map(characterJson), used: rows.length, limit: COMPANION_LIMIT })
  })

  add('POST', '/api/characters', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const model = typeof body.defaultModel === 'string' ? body.defaultModel : DEFAULT_MODEL
    assertModel(model)
    const at = nowIso()
    const row: CharacterRow = {
      id: newId(),
      user_id: user.id,
      name: asString(body.name, 'name', 1, 80),
      avatar_text: asOptionalString(body.avatarText, 'avatarText', 8),
      identity: asOptionalString(body.identity, 'identity', 4000),
      background: asOptionalString(body.background, 'background', 4000),
      traits: asOptionalString(body.traits, 'traits', 4000),
      style: asOptionalString(body.style, 'style', 4000),
      habits: asOptionalString(body.habits, 'habits', 4000),
      relationship: asOptionalString(body.relationship, 'relationship', 4000),
      rules: asOptionalString(body.rules, 'rules', 4000),
      default_model: model,
      initiative_enabled: asBool(body.initiativeEnabled, false) ? 1 : 0,
      created_at: at,
      updated_at: at,
    }
    withTx(ctx.db, () => {
      reserveCompanionSlot(ctx.db, user.id)
      run(
        ctx.db,
        `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.user_id,
        row.name,
        row.avatar_text,
        row.identity,
        row.background,
        row.traits,
        row.style,
        row.habits,
        row.relationship,
        row.rules,
        row.default_model,
        row.initiative_enabled,
        at,
        at
      )
    })
    json(ctx.res, 201, { character: characterJson(row) })
  })

  add('GET', '/api/characters/:id', async (ctx) => {
    requireUser(ctx)
    json(ctx.res, 200, { character: characterJson(ownCharacter(ctx, ctx.params.id)) })
  })

  add('PATCH', '/api/characters/:id', async (ctx) => {
    const user = requireUser(ctx)
    const current = ownCharacter(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const model = typeof body.defaultModel === 'string' ? body.defaultModel : current.default_model
    assertModel(model)
    const at = nowIso()
    const next = {
      name: body.name === undefined ? current.name : asString(body.name, 'name', 1, 80),
      avatar_text: body.avatarText === undefined ? current.avatar_text : asOptionalString(body.avatarText, 'avatarText', 8),
      identity: body.identity === undefined ? current.identity : asOptionalString(body.identity, 'identity', 4000),
      background: body.background === undefined ? current.background : asOptionalString(body.background, 'background', 4000),
      traits: body.traits === undefined ? current.traits : asOptionalString(body.traits, 'traits', 4000),
      style: body.style === undefined ? current.style : asOptionalString(body.style, 'style', 4000),
      habits: body.habits === undefined ? current.habits : asOptionalString(body.habits, 'habits', 4000),
      relationship: body.relationship === undefined ? current.relationship : asOptionalString(body.relationship, 'relationship', 4000),
      rules: body.rules === undefined ? current.rules : asOptionalString(body.rules, 'rules', 4000),
      initiative_enabled: body.initiativeEnabled === undefined ? current.initiative_enabled : asBool(body.initiativeEnabled) ? 1 : 0,
    }
    run(
      ctx.db,
      `UPDATE characters SET name=?, avatar_text=?, identity=?, background=?, traits=?, style=?, habits=?, relationship=?, rules=?, default_model=?, initiative_enabled=?, updated_at=?
       WHERE id=? AND user_id=?`,
      next.name,
      next.avatar_text,
      next.identity,
      next.background,
      next.traits,
      next.style,
      next.habits,
      next.relationship,
      next.rules,
      model,
      next.initiative_enabled,
      at,
      current.id,
      user.id
    )
    json(ctx.res, 200, { character: characterJson(ownCharacter(ctx, current.id)) })
  })

  add('DELETE', '/api/characters/:id', async (ctx) => {
    const user = requireUser(ctx)
    const character = ownCharacter(ctx, ctx.params.id)
    const conversations = many<ConversationRow>(
      ctx.db,
      `SELECT * FROM conversations WHERE character_id = ? AND user_id = ?`,
      character.id,
      user.id
    )
    for (const conversation of conversations) deleteConversation(ctx, conversation)
    run(ctx.db, `DELETE FROM timeline_grants WHERE character_id = ? AND user_id = ?`, character.id, user.id)
    run(ctx.db, `DELETE FROM memories WHERE character_id = ? AND user_id = ?`, character.id, user.id)
    run(ctx.db, `DELETE FROM characters WHERE id = ? AND user_id = ?`, character.id, user.id)
    json(ctx.res, 200, { ok: true })
  })

  add('POST', '/api/characters/:id/copy', async (ctx) => {
    const user = requireUser(ctx)
    const source = ownCharacter(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const at = nowIso()
    const copy: CharacterRow = { ...source, id: newId(), name: `${source.name} 副本`.slice(0, 80), created_at: at, updated_at: at }
    withTx(ctx.db, () => {
      reserveCompanionSlot(ctx.db, user.id)
      run(
        ctx.db,
        `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        copy.id,
        user.id,
        copy.name,
        copy.avatar_text,
        copy.identity,
        copy.background,
        copy.traits,
        copy.style,
        copy.habits,
        copy.relationship,
        copy.rules,
        copy.default_model,
        copy.initiative_enabled,
        at,
        at
      )
      if (asBool(body.copyMemories, false)) {
        const memories = many<MemoryRow>(
          ctx.db,
          `SELECT * FROM memories WHERE character_id = ? AND user_id = ? AND status = 'active'`,
          source.id,
          user.id
        )
        for (const memory of memories) {
          run(
            ctx.db,
            `INSERT INTO memories (id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            newId(),
            user.id,
            copy.id,
            memory.category,
            memory.content,
            `copy:${memory.id}`,
            memory.explicit,
            memory.note,
            at,
            at
          )
        }
      }
    })
    json(ctx.res, 201, { character: characterJson(copy) })
  })

  add('GET', '/api/persona-templates', async (ctx) => {
    requireUser(ctx)
    json(ctx.res, 200, {
      templates: PERSONA_TEMPLATES,
      note: '内置示例只有这两张。没有模板市场。选择模板只是填进你自己的角色，不会和记忆写在一起。',
    })
  })

  add('GET', '/api/characters/:id/export', async (ctx) => {
    requireUser(ctx)
    const character = ownCharacter(ctx, ctx.params.id)
    const card = characterJson(character)
    json(ctx.res, 200, {
      kind: 'companion-platform-character',
      version: 1,
      character: {
        name: card.name,
        avatarText: card.avatarText,
        identity: card.identity,
        background: card.background,
        traits: card.traits,
        style: card.style,
        habits: card.habits,
        relationship: card.relationship,
        rules: card.rules,
        defaultModel: card.defaultModel,
        initiativeEnabled: card.initiativeEnabled,
      },
    })
  })

  add('POST', '/api/characters/import', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    if (body.kind === 'companion-platform-memory-package' || body.memories || (body.character as { memories?: unknown } | undefined)?.memories) {
      throw new HttpError(400, 'memory_mixed_into_persona', '记忆包不能导入成人格卡。请到该角色的记忆页导入。')
    }
    const card = (body.character ?? body) as Record<string, unknown>
    if (body.kind && body.kind !== 'companion-platform-character') {
      throw new HttpError(400, 'unsupported_card', '只能导入 Companion Platform 人格卡')
    }
    const model = typeof card.defaultModel === 'string' ? card.defaultModel : DEFAULT_MODEL
    assertModel(model)
    const at = nowIso()
    const row: CharacterRow = {
      id: newId(),
      user_id: user.id,
      name: asString(card.name, 'name', 1, 80),
      avatar_text: asOptionalString(card.avatarText, 'avatarText', 8),
      identity: asOptionalString(card.identity, 'identity', 4000),
      background: asOptionalString(card.background, 'background', 4000),
      traits: asOptionalString(card.traits, 'traits', 4000),
      style: asOptionalString(card.style, 'style', 4000),
      habits: asOptionalString(card.habits, 'habits', 4000),
      relationship: asOptionalString(card.relationship, 'relationship', 4000),
      rules: asOptionalString(card.rules, 'rules', 4000),
      default_model: model,
      initiative_enabled: asBool(card.initiativeEnabled, false) ? 1 : 0,
      created_at: at,
      updated_at: at,
    }
    withTx(ctx.db, () => {
      reserveCompanionSlot(ctx.db, user.id)
      run(
        ctx.db,
        `INSERT INTO characters (id, user_id, name, avatar_text, identity, background, traits, style, habits, relationship, rules, default_model, initiative_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.user_id,
        row.name,
        row.avatar_text,
        row.identity,
        row.background,
        row.traits,
        row.style,
        row.habits,
        row.relationship,
        row.rules,
        row.default_model,
        row.initiative_enabled,
        at,
        at
      )
    })
    json(ctx.res, 201, { character: characterJson(row) })
  })

  add('GET', '/api/characters/:id/memories', async (ctx) => {
    const user = requireUser(ctx)
    ownCharacter(ctx, ctx.params.id)
    const status = ctx.url.searchParams.get('status') ?? 'active'
    if (!['active', 'suggested', 'rejected'].includes(status)) throw new HttpError(400, 'invalid_field', 'Invalid status')
    const rows = many<MemoryRow>(
      ctx.db,
      `SELECT * FROM memories WHERE character_id = ? AND user_id = ? AND status = ? ORDER BY updated_at DESC`,
      ctx.params.id,
      user.id,
      status
    )
    json(ctx.res, 200, { memories: rows.map(memoryJson) })
  })

  add('GET', '/api/characters/:id/memories/export', async (ctx) => {
    const user = requireUser(ctx)
    ownCharacter(ctx, ctx.params.id)
    const rows = many<MemoryRow>(
      ctx.db,
      `SELECT * FROM memories WHERE character_id = ? AND user_id = ? AND status = 'active' ORDER BY created_at ASC`,
      ctx.params.id,
      user.id
    )
    json(ctx.res, 200, memoryPackage(rows.map((row) => ({
      category: row.category,
      content: row.content,
      source: row.source,
      explicit: row.explicit === 1,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))))
  })

  add('POST', '/api/characters/:id/memories', async (ctx) => {
    const user = requireUser(ctx)
    ownCharacter(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const at = nowIso()
    const row: MemoryRow = {
      id: newId(),
      user_id: user.id,
      character_id: ctx.params.id,
      category: categoryOf(body.category),
      content: asString(body.content, 'content', 1, 4000),
      source: asString(body.source, 'source', 1, 200),
      explicit: body.explicit === false ? 0 : 1,
      note: '',
      status: 'active',
      created_at: at,
      updated_at: at,
    }
    run(
      ctx.db,
      `INSERT INTO memories (id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 'active', ?, ?)`,
      row.id,
      row.user_id,
      row.character_id,
      row.category,
      row.content,
      row.source,
      row.explicit,
      at,
      at
    )
    json(ctx.res, 201, { memory: memoryJson(row) })
  })

  add('PATCH', '/api/memories/:id', async (ctx) => {
    const user = requireUser(ctx)
    const current = one<MemoryRow>(ctx.db, `SELECT * FROM memories WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!current) throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    const at = nowIso()
    const content = body.content === undefined ? current.content : asString(body.content, 'content', 1, 4000)
    const category = body.category === undefined ? current.category : categoryOf(body.category)
    const explicit = body.explicit === undefined ? current.explicit : asBool(body.explicit) ? 1 : 0
    run(
      ctx.db,
      `UPDATE memories SET content=?, category=?, explicit=?, updated_at=? WHERE id=? AND user_id=?`,
      content,
      category,
      explicit,
      at,
      current.id,
      user.id
    )
    json(ctx.res, 200, { memory: memoryJson(one<MemoryRow>(ctx.db, `SELECT * FROM memories WHERE id = ?`, current.id)!) })
  })

  add('DELETE', '/api/memories/:id', async (ctx) => {
    const user = requireUser(ctx)
    const changed = run(ctx.db, `DELETE FROM memories WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('POST', '/api/memories/:id/confirm', async (ctx) => {
    const user = requireUser(ctx)
    const current = one<MemoryRow>(ctx.db, `SELECT * FROM memories WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!current || current.status !== 'suggested') throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    const explicit = body.explicit === undefined ? 0 : asBool(body.explicit) ? 1 : 0
    const at = nowIso()
    run(ctx.db, `UPDATE memories SET status='active', explicit=?, updated_at=? WHERE id=?`, explicit, at, current.id)
    json(ctx.res, 200, { memory: memoryJson(one<MemoryRow>(ctx.db, `SELECT * FROM memories WHERE id = ?`, current.id)!) })
  })

  add('POST', '/api/characters/:id/memories/suggest', async (ctx) => {
    const user = requireUser(ctx)
    ownCharacter(ctx, ctx.params.id)
    if (!gatewayConfigured(ctx.config)) {
      throw new HttpError(503, 'model_gateway_unconfigured', 'Server model provider key is not configured. No memory was guessed.')
    }
    assertQuota(ctx)
    const body = await readJson(ctx.req)
    let history: Array<{ role: 'user' | 'assistant'; content: string }> = []
    if (typeof body.conversationId === 'string') {
      const conversation = ownConversation(ctx, body.conversationId)
      if (conversation.character_id !== ctx.params.id || conversation.space !== 'companion') {
        throw new HttpError(403, 'forbidden', 'Conversation is not this companion')
      }
      history = historyFrom(messagePath(ctx, conversation.id, conversation.active_message_id)).slice(-8)
    }
    let content = ''
    const result = await streamCompletion(ctx.config, {
      model: DEFAULT_MODEL,
      thinking: false,
      messages: [
        {
          role: 'system',
          content:
            'MEMORY_SUGGESTION_REQUEST\nReturn only JSON {"memories":[{"category":"fact","content":"...","explicit":false}]}. Categories: persona, fact, event, relationship. Do not invent facts. Uncertain items must set explicit to false.',
        },
        ...history,
        { role: 'user', content: 'Suggest memories from the conversation. Return JSON only.' },
      ],
      onDelta: (delta) => {
        if (delta.content) content += delta.content
      },
    })
    let parsed: { memories?: Array<{ category?: string; content?: string }> }
    try {
      parsed = JSON.parse(content) as { memories?: Array<{ category?: string; content?: string }> }
    } catch {
      throw new HttpError(422, 'model_output_unusable', 'Model output was not saved because it was not valid JSON')
    }
    const at = nowIso()
    const created: MemoryRow[] = []
    for (const suggestion of parsed.memories ?? []) {
      if (!suggestion || typeof suggestion.content !== 'string' || !suggestion.content.trim()) continue
      if (!CATEGORIES.has(suggestion.category as MemoryCategory)) continue
      const row: MemoryRow = {
        id: newId(),
        user_id: user.id,
        character_id: ctx.params.id,
        category: suggestion.category as MemoryCategory,
        content: suggestion.content.trim().slice(0, 4000),
        source: 'model-suggestion',
        explicit: 0,
        note: '模型建议，尚未确认，不当作明确事实。',
        status: 'suggested',
        created_at: at,
        updated_at: at,
      }
      run(
        ctx.db,
        `INSERT INTO memories (id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'model-suggestion', 0, ?, 'suggested', ?, ?)`,
        row.id,
        row.user_id,
        row.character_id,
        row.category,
        row.content,
        row.note,
        at,
        at
      )
      created.push(row)
    }
    const priced = costMicroUsd(
      DEFAULT_MODEL,
      result.promptTokens,
      result.completionTokens,
      ctx.config.prices,
      result.source
    )
    run(
      ctx.db,
      `INSERT INTO usage_ledger (id, user_id, conversation_id, model, prompt_tokens, completion_tokens, cost_micro_usd, cost_status, source, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      user.id,
      DEFAULT_MODEL,
      result.promptTokens,
      result.completionTokens,
      priced.cost,
      priced.status,
      result.source,
      at
    )
    json(ctx.res, 200, {
      memories: created.map(memoryJson),
      note: 'Suggestions stay unconfirmed until you explicitly save them. They are not treated as facts.',
    })
  })

  add('POST', '/api/characters/:id/memories/import/preview', async (ctx) => {
    const user = requireUser(ctx)
    ownCharacter(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const format = asString(body.format, 'format', 2, 20)
    const text = asString(body.text, 'text', 1, 200_000)
    let items: ImportItem[]
    try {
      items = parseMemoryImport(format, text)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unrecognized_export'
      const messages: Record<string, string> = {
        adapter_not_implemented: 'ChatGPT、Gemini 和 DeepSeek 历史适配器尚未实现，没有写入任何记忆。',
        deepseek_zip_not_supported: 'DeepSeek 历史 ZIP 尚未支持，没有写入任何记忆。',
        character_card_not_memory: '人格卡不能导入成记忆。',
        persona_mixed_into_memory: '这份文件把人格和记忆写在一起，已拒绝。',
        not_memory_package: '这不是 Companion Platform 记忆包。',
        unsupported_package_version: '不支持的记忆包版本。',
        unrecognized_export: '无法识别这份记忆文件，没有写入。',
        unsupported_format: '不支持的格式，没有写入。',
      }
      const known = messages[code] ? code : 'unrecognized_export'
      throw new HttpError(422, known, messages[known])
    }
    const existing = many<{ category: string; content: string }>(
      ctx.db,
      `SELECT category, content FROM memories WHERE character_id = ? AND user_id = ? AND status = 'active'`,
      ctx.params.id,
      user.id
    )
    const split = dedupeImports(items, existing)
    const previewId = newId()
    run(
      ctx.db,
      `INSERT INTO memory_previews (id, user_id, character_id, items_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      previewId,
      user.id,
      ctx.params.id,
      JSON.stringify(split.accepted),
      nowIso()
    )
    json(ctx.res, 200, { previewId, items: split.accepted, duplicates: split.duplicates, written: false })
  })

  add('POST', '/api/characters/:id/memories/import/commit', async (ctx) => {
    const user = requireUser(ctx)
    ownCharacter(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const preview = one<{ items_json: string; character_id: string }>(
      ctx.db,
      `SELECT items_json, character_id FROM memory_previews WHERE id = ? AND user_id = ?`,
      asString(body.previewId, 'previewId', 8, 80),
      user.id
    )
    if (!preview || preview.character_id !== ctx.params.id) throw new HttpError(404, 'not_found', 'Not found')
    const selected = new Set(Array.isArray(body.tempIds) ? body.tempIds.filter((id) => typeof id === 'string') : [])
    const chosen = (JSON.parse(preview.items_json) as ImportItem[]).filter((item) => selected.has(item.tempId))
    const existing = many<{ category: string; content: string }>(
      ctx.db,
      `SELECT category, content FROM memories WHERE character_id = ? AND user_id = ? AND status = 'active'`,
      ctx.params.id,
      user.id
    )
    const items = dedupeImports(chosen, existing).accepted
    const at = nowIso()
    const created: MemoryRow[] = []
    for (const item of items) {
      const createdAt = item.createdAt ?? at
      const updatedAt = item.updatedAt ?? at
      const row: MemoryRow = {
        id: newId(),
        user_id: user.id,
        character_id: ctx.params.id,
        category: item.category,
        content: item.content,
        source: item.source,
        explicit: item.explicit ? 1 : 0,
        note: item.note,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
      }
      run(
        ctx.db,
        `INSERT INTO memories (id, user_id, character_id, category, content, source, explicit, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        row.id,
        row.user_id,
        row.character_id,
        row.category,
        row.content,
        row.source,
        row.explicit,
        row.note,
        createdAt,
        updatedAt
      )
      created.push(row)
    }
    run(ctx.db, `DELETE FROM memory_previews WHERE id = ?`, body.previewId)
    json(ctx.res, 201, { memories: created.map(memoryJson) })
  })

  add('GET', '/api/conversations', async (ctx) => {
    const user = requireUser(ctx)
    const space = ctx.url.searchParams.get('space')
    if (space !== 'workspace' && space !== 'companion') throw new HttpError(400, 'invalid_field', 'space is required')
    const rows = many<ConversationRow>(
      ctx.db,
      `SELECT * FROM conversations WHERE user_id = ? AND space = ? ORDER BY updated_at DESC`,
      user.id,
      space
    )
    json(ctx.res, 200, { conversations: rows.map(conversationJson) })
  })

  add('POST', '/api/conversations', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const space = body.space === 'workspace' || body.space === 'companion' ? body.space : null
    if (!space) throw new HttpError(400, 'invalid_field', 'space must be workspace or companion')
    let characterId: string | null = null
    let model = typeof body.model === 'string' ? body.model : DEFAULT_MODEL
    if (space === 'companion') {
      if (typeof body.characterId !== 'string') throw new HttpError(400, 'invalid_field', 'characterId is required')
      const character = ownCharacter(ctx, body.characterId)
      characterId = character.id
      model = typeof body.model === 'string' ? body.model : character.default_model
    }
    assertModel(model)
    const at = nowIso()
    const row: ConversationRow = {
      id: newId(),
      user_id: user.id,
      space,
      character_id: characterId,
      title: typeof body.title === 'string' && body.title.trim() ? asString(body.title, 'title', 1, 80) : space === 'workspace' ? '新的工作记录' : '新对话',
      model,
      active_message_id: null,
      created_at: at,
      updated_at: at,
    }
    run(
      ctx.db,
      `INSERT INTO conversations (id, user_id, space, character_id, title, model, active_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      row.id,
      row.user_id,
      row.space,
      row.character_id,
      row.title,
      row.model,
      at,
      at
    )
    json(ctx.res, 201, { conversation: conversationJson(row) })
  })

  add('GET', '/api/conversations/:id', async (ctx) => {
    requireUser(ctx)
    const conversation = ownConversation(ctx, ctx.params.id)
    json(ctx.res, 200, { conversation: conversationJson(conversation), messages: decorateMessages(ctx, conversation) })
  })

  add('PATCH', '/api/conversations/:id', async (ctx) => {
    const user = requireUser(ctx)
    const conversation = ownConversation(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const title = body.title === undefined ? conversation.title : asString(body.title, 'title', 1, 80)
    const model = body.model === undefined ? conversation.model : asString(body.model, 'model', 1, 80)
    assertModel(model)
    run(ctx.db, `UPDATE conversations SET title=?, model=?, updated_at=? WHERE id=? AND user_id=?`, title, model, nowIso(), conversation.id, user.id)
    json(ctx.res, 200, { conversation: conversationJson(ownConversation(ctx, conversation.id)) })
  })

  add('DELETE', '/api/conversations/:id', async (ctx) => {
    requireUser(ctx)
    deleteConversation(ctx, ownConversation(ctx, ctx.params.id))
    json(ctx.res, 200, { ok: true })
  })

  add('POST', '/api/conversations/:id/active', async (ctx) => {
    const user = requireUser(ctx)
    const conversation = ownConversation(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const messageId = asString(body.messageId, 'messageId', 8, 80)
    const message = one<MessageRow>(
      ctx.db,
      `SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?`,
      messageId,
      conversation.id,
      user.id
    )
    if (!message) throw new HttpError(404, 'not_found', 'Not found')
    run(ctx.db, `UPDATE conversations SET active_message_id=?, updated_at=? WHERE id=?`, messageId, nowIso(), conversation.id)
    json(ctx.res, 200, { conversation: conversationJson(ownConversation(ctx, conversation.id)), messages: decorateMessages(ctx, ownConversation(ctx, conversation.id)) })
  })

  add('POST', '/api/conversations/:id/messages', async (ctx) => {
    requireUser(ctx)
    const conversation = ownConversation(ctx, ctx.params.id)
    const body = await readJson(ctx.req)
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((id): id is string => typeof id === 'string') : []
    await beginReply(ctx, conversation, {
      content: asString(body.content, 'content', 1, 20_000),
      parentId: body.parentId === undefined || body.parentId === null ? conversation.active_message_id : asString(body.parentId, 'parentId', 8, 80),
      model: typeof body.model === 'string' ? body.model : undefined,
      thinking: asBool(body.thinking, false),
      attachmentIds,
    })
  })

  add('POST', '/api/conversations/:id/messages/:messageId/edit', async (ctx) => {
    const user = requireUser(ctx)
    const conversation = ownConversation(ctx, ctx.params.id)
    const original = one<MessageRow>(
      ctx.db,
      `SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?`,
      ctx.params.messageId,
      conversation.id,
      user.id
    )
    if (!original || original.role !== 'user') throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    await beginReply(ctx, conversation, {
      content: asString(body.content, 'content', 1, 20_000),
      parentId: original.parent_id,
      model: conversation.model,
      thinking: asBool(body.thinking, false),
      attachmentIds: [],
    })
  })

  add('POST', '/api/conversations/:id/messages/:messageId/regenerate', async (ctx) => {
    const user = requireUser(ctx)
    const conversation = ownConversation(ctx, ctx.params.id)
    const original = one<MessageRow>(
      ctx.db,
      `SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?`,
      ctx.params.messageId,
      conversation.id,
      user.id
    )
    if (!original || original.role !== 'assistant' || !original.parent_id) throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    if (!gatewayConfigured(ctx.config)) {
      throw new HttpError(503, 'model_gateway_unconfigured', 'Server model provider key is not configured. No fallback reply was generated.')
    }
    assertQuota(ctx)
    const history = historyFrom(messagePath(ctx, conversation.id, original.parent_id))
    await streamAssistant(ctx, conversation, {
      parentId: original.parent_id,
      history,
      model: conversation.model,
      thinking: asBool(body.thinking, false),
    })
  })

  add('POST', '/api/attachments', async (ctx) => {
    const user = requireUser(ctx)
    const space = ctx.url.searchParams.get('space')
    if (space !== 'workspace' && space !== 'companion') throw new HttpError(400, 'invalid_field', 'space is required')
    const type = ctx.req.headers['content-type'] ?? ''
    const file = parseSingleFile(await readBody(ctx.req, 5_000_000), type)
    const id = newId()
    const storageName = `${user.id}/${id}`
    const full = blobPath(ctx, storageName)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, file.data)
    const at = nowIso()
    run(
      ctx.db,
      `INSERT INTO attachments (id, user_id, space, conversation_id, message_id, filename, media_type, byte_size, storage_name, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      space,
      file.filename,
      file.mime,
      file.data.length,
      storageName,
      at
    )
    json(ctx.res, 201, { attachment: { id, space, filename: file.filename, mediaType: file.mime, byteSize: file.data.length, createdAt: at } })
  })

  add('GET', '/api/attachments/:id', async (ctx) => {
    const user = requireUser(ctx)
    const row = one<AttachmentRow>(ctx.db, `SELECT * FROM attachments WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!row) throw new HttpError(404, 'not_found', 'Not found')
    const full = blobPath(ctx, row.storage_name)
    ctx.res.writeHead(200, {
      'Content-Type': row.media_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
    fs.createReadStream(full).pipe(ctx.res)
  })

  add('POST', '/api/workspace/projects', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const at = nowIso()
    const id = newId()
    run(
      ctx.db,
      `INSERT INTO projects (id, user_id, name, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      asString(body.name, 'name', 1, 120),
      asOptionalString(body.summary, 'summary', 4000),
      at,
      at
    )
    json(ctx.res, 201, { project: { id, name: body.name, summary: body.summary ?? '', createdAt: at, updatedAt: at } })
  })

  add('GET', '/api/workspace/projects', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, { projects: many(ctx.db, `SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC`, user.id) })
  })

  add('POST', '/api/workspace/projects/:id/tasks', async (ctx) => {
    const user = requireUser(ctx)
    const project = one<{ id: string }>(ctx.db, `SELECT id FROM projects WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!project) throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    const at = nowIso()
    const id = newId()
    const due = typeof body.dueAt === 'string' ? body.dueAt : null
    run(
      ctx.db,
      `INSERT INTO tasks (id, user_id, project_id, title, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      user.id,
      project.id,
      asString(body.title, 'title', 1, 200),
      due,
      at,
      at
    )
    json(ctx.res, 201, { task: { id, title: body.title, status: 'open', dueAt: due } })
  })

  add('PATCH', '/api/workspace/tasks/:id', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const status = body.status === 'done' || body.status === 'open' ? body.status : null
    if (!status) throw new HttpError(400, 'invalid_field', 'status must be open or done')
    const changed = run(ctx.db, `UPDATE tasks SET status=?, updated_at=? WHERE id=? AND user_id=?`, status, nowIso(), ctx.params.id, user.id)
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('POST', '/api/workspace/timeline', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const at = nowIso()
    const id = newId()
    const projectId = typeof body.projectId === 'string' ? body.projectId : null
    if (projectId) {
      const project = one(ctx.db, `SELECT id FROM projects WHERE id = ? AND user_id = ?`, projectId, user.id)
      if (!project) throw new HttpError(404, 'not_found', 'Not found')
    }
    run(
      ctx.db,
      `INSERT INTO timeline_events (id, user_id, project_id, title, summary, event_type, occurred_at, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      projectId,
      asString(body.title, 'title', 1, 200),
      asString(body.summary, 'summary', 1, 4000),
      asString(body.eventType, 'eventType', 1, 40),
      asString(body.occurredAt, 'occurredAt', 4, 40),
      typeof body.dueAt === 'string' ? body.dueAt : null,
      at,
      at
    )
    json(ctx.res, 201, { event: { id } })
  })

  add('GET', '/api/workspace/timeline', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, {
      events: many(ctx.db, `SELECT * FROM timeline_events WHERE user_id = ? ORDER BY occurred_at DESC`, user.id),
    })
  })

  add('PATCH', '/api/workspace/timeline/:id', async (ctx) => {
    const user = requireUser(ctx)
    const current = one<{ id: string }>(ctx.db, `SELECT id FROM timeline_events WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!current) throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    run(
      ctx.db,
      `UPDATE timeline_events SET title=?, summary=?, updated_at=? WHERE id=? AND user_id=?`,
      asString(body.title, 'title', 1, 200),
      asString(body.summary, 'summary', 1, 4000),
      nowIso(),
      current.id,
      user.id
    )
    json(ctx.res, 200, { ok: true })
  })

  add('DELETE', '/api/workspace/timeline/:id', async (ctx) => {
    const user = requireUser(ctx)
    run(ctx.db, `DELETE FROM timeline_grants WHERE event_id = ? AND user_id = ?`, ctx.params.id, user.id)
    const changed = run(ctx.db, `DELETE FROM timeline_events WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('POST', '/api/workspace/timeline/:id/grants', async (ctx) => {
    const user = requireUser(ctx)
    const event = one(ctx.db, `SELECT id FROM timeline_events WHERE id = ? AND user_id = ?`, ctx.params.id, user.id)
    if (!event) throw new HttpError(404, 'not_found', 'Not found')
    const body = await readJson(ctx.req)
    const character = ownCharacter(ctx, asString(body.characterId, 'characterId', 8, 80))
    const allowTitle = asBool(body.allowTitle, false)
    const allowSummary = asBool(body.allowSummary, false)
    const allowOccurred = asBool(body.allowOccurredAt, false)
    const allowDue = asBool(body.allowDueAt, false)
    if (!allowTitle && !allowSummary && !allowOccurred && !allowDue) {
      throw new HttpError(400, 'invalid_field', 'Choose at least one field')
    }
    const id = newId()
    run(
      ctx.db,
      `INSERT INTO timeline_grants (id, user_id, event_id, character_id, allow_title, allow_summary, allow_occurred_at, allow_due_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id,
      user.id,
      ctx.params.id,
      character.id,
      allowTitle ? 1 : 0,
      allowSummary ? 1 : 0,
      allowOccurred ? 1 : 0,
      allowDue ? 1 : 0,
      nowIso()
    )
    json(ctx.res, 201, { grantId: id })
  })

  add('POST', '/api/workspace/grants/:id/revoke', async (ctx) => {
    const user = requireUser(ctx)
    const changed = run(
      ctx.db,
      `UPDATE timeline_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      nowIso(),
      ctx.params.id,
      user.id
    )
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('GET', '/api/workspace/grants', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, { grants: many(ctx.db, `SELECT * FROM timeline_grants WHERE user_id = ? ORDER BY created_at DESC`, user.id) })
  })

  add('GET', '/api/workspace/audits', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, { audits: many(ctx.db, `SELECT * FROM access_audits WHERE user_id = ? ORDER BY created_at DESC`, user.id) })
  })

  add('POST', '/api/companion/timeline-reads', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const character = ownCharacter(ctx, asString(body.characterId, 'characterId', 8, 80))
    const eventId = asString(body.eventId, 'eventId', 8, 80)
    const before = one<{ updated_at: string }>(ctx.db, `SELECT updated_at FROM timeline_events WHERE id = ? AND user_id = ?`, eventId, user.id)
    if (!before) throw new HttpError(404, 'not_found', 'Not found')
    const grant = one<{
      id: string
      allow_title: number
      allow_summary: number
      allow_occurred_at: number
      allow_due_at: number
    }>(
      ctx.db,
      `SELECT * FROM timeline_grants WHERE user_id = ? AND event_id = ? AND character_id = ? AND revoked_at IS NULL`,
      user.id,
      eventId,
      character.id
    )
    if (!grant) throw new HttpError(403, 'timeline_not_authorized', 'Companion cannot read this workspace event')
    const event = one<{ title: string; summary: string; occurred_at: string; due_at: string | null }>(
      ctx.db,
      `SELECT title, summary, occurred_at, due_at FROM timeline_events WHERE id = ? AND user_id = ?`,
      eventId,
      user.id
    )!
    const fields: Record<string, string | null> = {}
    const names: string[] = []
    if (grant.allow_title) {
      fields.title = event.title
      names.push('title')
    }
    if (grant.allow_summary) {
      fields.summary = event.summary
      names.push('summary')
    }
    if (grant.allow_occurred_at) {
      fields.occurredAt = event.occurred_at
      names.push('occurredAt')
    }
    if (grant.allow_due_at) {
      fields.dueAt = event.due_at
      names.push('dueAt')
    }
    run(
      ctx.db,
      `INSERT INTO access_audits (id, user_id, actor, grant_id, event_id, character_id, fields_json, created_at)
       VALUES (?, ?, 'companion_read', ?, ?, ?, ?, ?)`,
      newId(),
      user.id,
      grant.id,
      eventId,
      character.id,
      JSON.stringify(names),
      nowIso()
    )
    const after = one<{ updated_at: string }>(ctx.db, `SELECT updated_at FROM timeline_events WHERE id = ?`, eventId)
    json(ctx.res, 200, { fields, readOnly: true, eventUnchanged: before.updated_at === after?.updated_at })
  })

  add('POST', '/api/companion/timeline/:id', async () => {
    throw new HttpError(405, 'method_not_allowed', 'Companion cannot modify Workspace records')
  })

  add('GET', '/api/initiative', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, { settings: publicSettings(defaultInitiative(ctx.db, user.id)) })
  })

  add('PATCH', '/api/initiative', async (ctx) => {
    const user = requireUser(ctx)
    const current = defaultInitiative(ctx.db, user.id)
    const body = await readJson(ctx.req)
    const triggers = body.triggers as Record<string, { enabled?: boolean }> | undefined
    for (const name of ['schedule', 'work_event', 'history_followup', 'date_reminder']) {
      if (triggers?.[name]?.enabled) throw new HttpError(400, 'trigger_not_implemented', `${name} is not implemented`)
    }
    const enabled = body.enabled === undefined ? current.enabled : asBool(body.enabled) ? 1 : 0
    const daily = body.dailyLimit === undefined ? current.daily_limit : Number(body.dailyLimit)
    const perTick = body.maxModelCallsPerTick === undefined ? current.max_model_calls_per_tick : Number(body.maxModelCallsPerTick)
    if (!Number.isInteger(daily) || daily < 1 || daily > 50) throw new HttpError(400, 'invalid_field', 'dailyLimit must be 1-50')
    if (!Number.isInteger(perTick) || perTick < 1 || perTick > 3) throw new HttpError(400, 'invalid_field', 'maxModelCallsPerTick must be 1-3')
    const quietStart = minuteField(body.quietStartMinute, current.quiet_start_minute)
    const quietEnd = minuteField(body.quietEndMinute, current.quiet_end_minute)
    const trigger = triggers?.authorized_timeline?.enabled === undefined ? current.trigger_authorized_timeline : triggers.authorized_timeline.enabled ? 1 : 0
    run(
      ctx.db,
      `UPDATE initiative_settings SET enabled=?, quiet_start_minute=?, quiet_end_minute=?, daily_limit=?, max_model_calls_per_tick=?, trigger_authorized_timeline=?, updated_at=? WHERE user_id=?`,
      enabled,
      quietStart,
      quietEnd,
      daily,
      perTick,
      trigger,
      nowIso(),
      user.id
    )
    json(ctx.res, 200, { settings: publicSettings(defaultInitiative(ctx.db, user.id)) })
  })

  add('POST', '/api/initiative/tick', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    let now = new Date()
    if (typeof body.now === 'string') {
      if (!ctx.config.allowTestClock) throw new HttpError(400, 'clock_disabled', 'Test clock is disabled')
      const parsed = new Date(body.now)
      if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'invalid_field', 'Bad timestamp')
      now = parsed
    }
    const result = await tickInitiative({ db: ctx.db, config: ctx.config, log: ctx.log }, user.id, now)
    json(ctx.res, 200, result)
  })

  add('GET', '/api/notifications', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, { notifications: many(ctx.db, `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC`, user.id) })
  })

  add('POST', '/api/notifications/:id/read', async (ctx) => {
    const user = requireUser(ctx)
    const changed = run(ctx.db, `UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?`, nowIso(), ctx.params.id, user.id)
    if (!changed) throw new HttpError(404, 'not_found', 'Not found')
    json(ctx.res, 200, { ok: true })
  })

  add('POST', '/api/feedback', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const id = newId()
    run(ctx.db, `INSERT INTO feedback (id, user_id, body, created_at) VALUES (?, ?, ?, ?)`, id, user.id, asString(body.body, 'body', 1, 4000), nowIso())
    json(ctx.res, 201, { id })
  })

  add('GET', '/api/admin/feedback', async (ctx) => {
    requireAdmin(ctx)
    json(ctx.res, 200, { feedback: many(ctx.db, `SELECT id, user_id, body, created_at FROM feedback ORDER BY created_at DESC`) })
  })

  add('GET', '/api/me/export', async (ctx) => {
    const user = requireUser(ctx)
    json(ctx.res, 200, {
      exportedAt: nowIso(),
      user: publicUser(user),
      characters: many(ctx.db, `SELECT * FROM characters WHERE user_id = ?`, user.id).map((row) => characterJson(row as CharacterRow)),
      memories: many<MemoryRow>(ctx.db, `SELECT * FROM memories WHERE user_id = ?`, user.id).map(memoryJson),
      conversations: many<ConversationRow>(ctx.db, `SELECT * FROM conversations WHERE user_id = ?`, user.id).map(conversationJson),
      messages: many(ctx.db, `SELECT id, conversation_id, parent_id, role, content, reasoning, status, created_at, updated_at FROM messages WHERE user_id = ?`, user.id),
      timeline: many(ctx.db, `SELECT * FROM timeline_events WHERE user_id = ?`, user.id),
      grants: many(ctx.db, `SELECT * FROM timeline_grants WHERE user_id = ?`, user.id),
      notifications: many(ctx.db, `SELECT * FROM notifications WHERE user_id = ?`, user.id),
      projects: many(ctx.db, `SELECT * FROM projects WHERE user_id = ?`, user.id),
      tasks: many(ctx.db, `SELECT * FROM tasks WHERE user_id = ?`, user.id),
    })
  })

  add('POST', '/api/me/delete', async (ctx) => {
    const user = requireUser(ctx)
    if (user.role === 'admin') throw new HttpError(400, 'admin_delete_disabled', 'The administrator account cannot be deleted here')
    const body = await readJson(ctx.req)
    const ok = await verifyPassword(String(body.password ?? ''), user.password_hash)
    if (!ok) throw new HttpError(401, 'invalid_credentials', 'Password is incorrect')
    deleteUserData(ctx, user.id)
    clearSessionCookie(ctx.res, ctx.config)
    ctx.log.info('account_deleted', { userId: user.id })
    json(ctx.res, 200, { ok: true })
  })

  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? '127.0.0.1'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const ctx: Ctx = {
      db: deps.db,
      config: deps.config,
      log: deps.log,
      req,
      res,
      url,
      params: {},
      user: userFromToken(deps.db, cookies(req).cp_session),
    }
    try {
      if (url.pathname.startsWith('/api/')) assertCsrf(req)
      const match = routes.find((item) => item.method === req.method && item.regex.test(url.pathname))
      if (!match) {
        if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Not found')
        if (!serveStatic(deps.config, res, decodeURIComponent(url.pathname))) {
          json(res, 404, { error: { code: 'not_found', message: 'Not found' } })
        }
        return
      }
      const found = url.pathname.match(match.regex)
      ctx.params = Object.fromEntries(match.keys.map((key, index) => [key, decodeURIComponent(found?.[index + 1] ?? '')]))
      if (ctx.user) run(deps.db, `UPDATE users SET last_seen_at = ? WHERE id = ?`, nowIso(), ctx.user.id)
      await match.handler(ctx)
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      if (error instanceof HttpError) {
        json(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      deps.log.error('unhandled', { name: error instanceof Error ? error.name : 'Error' })
      json(res, 500, { error: { code: 'internal', message: 'Internal error' } })
    }
  }

  return { listener, db: deps.db, config: deps.config, log: deps.log }
}

function conversationJson(row: ConversationRow) {
  return {
    id: row.id,
    space: row.space,
    characterId: row.character_id,
    title: row.title,
    model: row.model,
    activeMessageId: row.active_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function minuteField(value: unknown, current: number | null): number | null {
  if (value === undefined) return current
  if (value === null) return null
  const minute = Number(value)
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439) {
    throw new HttpError(400, 'invalid_field', 'Quiet-hour minute must be 0-1439 or null')
  }
  return minute
}

export function resetLoginFailures(): void {
  loginFailures.clear()
}
