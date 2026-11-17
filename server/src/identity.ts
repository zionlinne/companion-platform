import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { hashPassword as hashWithBetterAuth, verifyPassword as verifyWithBetterAuth } from 'better-auth/crypto'
import { admin } from 'better-auth/plugins'
import { consumeInvitation, insertQuota, normalizeEmail } from './auth.ts'
import type { AppConfig } from './config.ts'
import { one, run, withTx } from './db.ts'
import { HttpError, newId, nowIso } from './http.ts'
import { verifyPassword as verifyLegacyPassword } from './password.ts'
import type { UserRow } from './types.ts'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type Identity = ReturnType<typeof betterAuth>

export function createIdentity(db: DatabaseSync, config: AppConfig): Identity {
  const mailOn = config.mailTransport === 'fixture'
  return betterAuth({
    database: db,
    secret: config.betterAuthSecret,
    baseURL: `http://127.0.0.1:${config.port || 8787}`,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      requireEmailVerification: mailOn,
      autoSignIn: true,
      password: {
        hash: (password) => hashWithBetterAuth(password),
        verify: async ({ hash, password }) => {
          if (hash.startsWith('scrypt$')) return verifyLegacyPassword(password, hash)
          return verifyWithBetterAuth({ hash, password })
        },
      },
      sendResetPassword: async ({ user, url, token }) => {
        if (!mailOn) throw new HttpError(503, 'mail_transport_unconfigured', '没有配置真实邮件传输。重置邮件没有发出。')
        storeMail(db, user.email, 'reset', token, url, user.id)
      },
    },
    emailVerification: {
      sendOnSignUp: mailOn,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        if (!mailOn) throw new HttpError(503, 'mail_transport_unconfigured', '没有配置真实邮件传输。验证邮件没有发出。')
        storeMail(db, user.email, 'verify', token, url, user.id)
      },
    },
    user: {
      modelName: 'users',
      fields: {
        name: 'display_name',
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      modelName: 'auth_session',
      expiresIn: Math.floor(config.sessionTtlHours * 3600),
    },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] })],
    advanced: {
      cookies: { session_token: { name: 'cp_session' } },
      useSecureCookies: config.cookieSecure,
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const at = nowIso()
            db.prepare(
              `INSERT OR IGNORE INTO user_profiles (user_id, username, avatar_text, status, level, entitlements, registered_at, last_login_at)
               VALUES (?, NULL, NULL, 'active', 'member', '{}', ?, NULL)`
            ).run(user.id, at)
            db.prepare(
              `INSERT OR IGNORE INTO wallets (user_id, available_fen, frozen_fen, recharge_fen, spent_fen, refund_fen, created_at)
               VALUES (?, 0, 0, 0, 0, 0, ?)`
            ).run(user.id, at)
            const quota = db.prepare(`SELECT user_id FROM quotas WHERE user_id = ?`).get(user.id)
            if (!quota) insertQuota(db, user.id, config, at)
            db.prepare(
              `INSERT OR IGNORE INTO initiative_settings (user_id, enabled, quiet_start_minute, quiet_end_minute, daily_limit, max_model_calls_per_tick, trigger_authorized_timeline, updated_at)
               VALUES (?, 0, NULL, NULL, 3, 1, 1, ?)`
            ).run(user.id, at)
          },
        },
      },
    },
  })
}

function storeMail(db: DatabaseSync, email: string, kind: string, token: string, url: string, userId: string | null) {
  db.prepare(`INSERT INTO mail_outbox (id, user_id, email, kind, token, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    newId(),
    userId,
    email,
    kind,
    token,
    url,
    nowIso()
  )
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  if (req.headers.cookie) headers.set('cookie', req.headers.cookie)
  const agent = req.headers['user-agent']
  if (typeof agent === 'string') headers.set('user-agent', agent)
  return headers
}

function raiseAuth(error: unknown): never {
  if (error instanceof HttpError) throw error
  const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode: number }).statusCode) : 400
  const body = error && typeof error === 'object' && 'body' in error ? (error as { body?: { code?: string; message?: string } }).body : undefined
  const code = (body?.code ?? 'auth_failed').toLowerCase()
  if (code.includes('user_already_exists')) throw new HttpError(409, 'email_taken', 'Email is already registered')
  if (code.includes('invalid_email_or_password') || code.includes('invalid_password')) {
    throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect')
  }
  throw new HttpError(statusCode >= 400 && statusCode < 500 ? statusCode : 400, code, body?.message ?? 'Auth failed')
}

async function loadUser(db: DatabaseSync, id: string): Promise<UserRow | null> {
  return one<UserRow>(db, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, id) ?? null
}

export async function userFromRequest(identity: Identity, db: DatabaseSync, req: IncomingMessage): Promise<UserRow | null> {
  if (!req.headers.cookie?.includes('cp_session=')) return null
  try {
    const session = await identity.api.getSession({ headers: requestHeaders(req) })
    if (!session?.user?.id) return null
    const user = await loadUser(db, session.user.id)
    if (!user || user.banned) return null
    return user
  } catch {
    return null
  }
}

export async function registerAccount(
  identity: Identity,
  db: DatabaseSync,
  input: { email: string; password: string; invitationCode: string; displayName?: string; username?: string }
) {
  const email = normalizeEmail(input.email)
  if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Invalid email')
  if (input.password.length < 12 || input.password.length > 200) {
    throw new HttpError(400, 'password_policy', 'Password must be 12-200 characters')
  }
  const displayName = (input.displayName?.trim() || email.split('@')[0] || 'user').slice(0, 80)
  const username = input.username?.trim() || null
  if (username && !/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new HttpError(400, 'invalid_username', 'Username must be 3-32 letters, numbers, or underscore')
  }
  let created: { headers: Headers; response: { user: { id: string } } }
  try {
    created = await identity.api.signUpEmail({
      body: { name: displayName, email, password: input.password },
      returnHeaders: true,
    })
  } catch (error) {
    raiseAuth(error)
  }
  try {
    withTx(db, () => {
      consumeInvitation(db, input.invitationCode, created.response.user.id)
      if (username) {
        const taken = one<{ user_id: string }>(db, `SELECT user_id FROM user_profiles WHERE username = ? AND user_id != ?`, username, created.response.user.id)
        if (taken) throw new HttpError(409, 'username_taken', 'Username is already used')
        run(db, `UPDATE user_profiles SET username = ? WHERE user_id = ?`, username, created.response.user.id)
      }
    })
  } catch (error) {
    deleteIdentityRows(db, created.response.user.id)
    throw error
  }
  const user = await loadUser(db, created.response.user.id)
  if (!user) throw new HttpError(500, 'register_failed', 'User was not stored')
  return { user, headers: created.headers }
}

export async function loginAccount(identity: Identity, db: DatabaseSync, email: string, password: string) {
  let result: { headers: Headers; response: { user: { id: string } } }
  try {
    result = await identity.api.signInEmail({
      body: { email: normalizeEmail(email), password },
      returnHeaders: true,
    })
  } catch (error) {
    raiseAuth(error)
  }
  const user = await loadUser(db, result.response.user.id)
  if (!user || user.banned) {
    await identity.api.signOut({ headers: result.headers }).catch(() => undefined)
    throw new HttpError(403, 'account_disabled', '账号已停用')
  }
  run(db, `UPDATE user_profiles SET last_login_at = ? WHERE user_id = ?`, nowIso(), user.id)
  return { user, headers: result.headers }
}

export async function signOutAccount(identity: Identity, req: IncomingMessage): Promise<Headers> {
  const result = await identity.api.signOut({ headers: requestHeaders(req), returnHeaders: true })
  return result.headers
}

export async function passwordMatches(db: DatabaseSync, userId: string, password: string): Promise<boolean> {
  const row = one<{ password: string | null }>(db, `SELECT password FROM auth_account WHERE userId = ? AND providerId = 'credential'`, userId)
  if (!row?.password) return false
  if (row.password.startsWith('scrypt$')) return verifyLegacyPassword(password, row.password)
  return verifyWithBetterAuth({ hash: row.password, password })
}

export async function changeAccountPassword(identity: Identity, req: IncomingMessage, currentPassword: string, newPassword: string) {
  if (newPassword.length < 12 || newPassword.length > 200) throw new HttpError(400, 'password_policy', 'Password must be 12-200 characters')
  try {
    await identity.api.changePassword({
      headers: requestHeaders(req),
      body: { currentPassword, newPassword },
    })
  } catch (error) {
    raiseAuth(error)
  }
}

export async function requestReset(identity: Identity, config: AppConfig, email: string) {
  if (config.mailTransport !== 'fixture') {
    throw new HttpError(503, 'mail_transport_unconfigured', '没有配置真实邮件传输。重置邮件没有发出。')
  }
  try {
    await identity.api.requestPasswordReset({ body: { email: normalizeEmail(email), redirectTo: '/login' } })
  } catch (error) {
    if (error instanceof HttpError) throw error
  }
  return { accepted: true, transport: 'fixture' as const, realDelivery: false }
}

export async function resetAccountPassword(identity: Identity, token: string, newPassword: string) {
  if (newPassword.length < 12 || newPassword.length > 200) throw new HttpError(400, 'password_policy', 'Password must be 12-200 characters')
  try {
    await identity.api.resetPassword({ body: { token, newPassword } })
  } catch (error) {
    raiseAuth(error)
  }
}

export async function verifyAccountEmail(identity: Identity, config: AppConfig, token: string) {
  if (config.mailTransport !== 'fixture') {
    throw new HttpError(503, 'mail_transport_unconfigured', '没有配置真实邮件传输。验证邮件没有发出。')
  }
  try {
    await identity.api.verifyEmail({ query: { token } })
  } catch (error) {
    raiseAuth(error)
  }
}

export async function listDeviceSessions(identity: Identity, req: IncomingMessage) {
  const rows = await identity.api.listSessions({ headers: requestHeaders(req) })
  const current = await identity.api.getSession({ headers: requestHeaders(req) })
  return rows.map((row) => ({
    id: row.id,
    userAgent: row.userAgent ?? null,
    ipAddress: row.ipAddress ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    current: row.id === current?.session?.id,
  }))
}

export async function revokeDeviceSession(identity: Identity, db: DatabaseSync, req: IncomingMessage, userId: string, sessionId: string) {
  const row = one<{ token: string }>(db, `SELECT token FROM auth_session WHERE id = ? AND userId = ?`, sessionId, userId)
  if (!row) throw new HttpError(404, 'not_found', 'Not found')
  await identity.api.revokeSession({ headers: requestHeaders(req), body: { token: row.token } })
}

export function listMailbox(db: DatabaseSync, email: string) {
  return db
    .prepare(`SELECT id, email, kind, token, url, created_at FROM mail_outbox WHERE email = ? ORDER BY created_at`)
    .all(normalizeEmail(email)) as Array<{ id: string; email: string; kind: string; token: string; url: string; created_at: string }>
}

export function deleteIdentityRows(db: DatabaseSync, userId: string) {
  for (const sql of [
    `DELETE FROM mail_outbox WHERE user_id = ?`,
    `DELETE FROM auth_session WHERE userId = ?`,
    `DELETE FROM auth_account WHERE userId = ?`,
    `DELETE FROM user_profiles WHERE user_id = ?`,
    `DELETE FROM wallet_transactions WHERE user_id = ?`,
    `DELETE FROM recharge_orders WHERE user_id = ?`,
    `DELETE FROM model_usage_records WHERE user_id = ?`,
    `DELETE FROM user_model_permissions WHERE user_id = ?`,
    `DELETE FROM wallets WHERE user_id = ?`,
    `DELETE FROM quotas WHERE user_id = ?`,
    `DELETE FROM initiative_settings WHERE user_id = ?`,
    `DELETE FROM users WHERE id = ?`,
  ]) {
    db.prepare(sql).run(userId)
  }
}

export async function initAdmin(db: DatabaseSync, config: AppConfig, email: string, password: string): Promise<UserRow> {
  const normalized = normalizeEmail(email)
  if (!EMAIL.test(normalized)) throw new HttpError(400, 'invalid_email', 'Invalid email')
  if (password.length < 12 || password.length > 200) throw new HttpError(400, 'password_policy', 'Password must be 12-200 characters')
  const existing = one<UserRow>(db, `SELECT * FROM users WHERE role = 'admin' AND deleted_at IS NULL`)
  if (existing) throw new HttpError(409, 'admin_exists', 'An administrator already exists')
  const identity = createIdentity(db, config)
  let createdId = ''
  try {
    const created = await identity.api.signUpEmail({
      body: { name: 'Administrator', email: normalized, password },
    })
    createdId = created.user.id
  } catch (error) {
    raiseAuth(error)
  }
  run(db, `UPDATE users SET role = 'admin', email_verified = 1 WHERE id = ?`, createdId)
  run(db, `UPDATE user_profiles SET level = 'admin' WHERE user_id = ?`, createdId)
  const user = await loadUser(db, createdId)
  if (!user) throw new HttpError(500, 'admin_init_failed', 'Administrator was not stored')
  return user
}
